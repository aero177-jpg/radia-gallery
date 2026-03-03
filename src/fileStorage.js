/**
 * File-based persistent storage module using IndexedDB.
 * Stores per-file settings (animation, focus distance) and binary preview blobs.
 * Preview images are persisted as Blobs (WebP preferred) to avoid base64 bloat.
 */

/** Database name */
const DB_NAME = 'radia-gallery-storage';

/** Database version */
const DB_VERSION = 2;

/** Object store name for settings */
const STORE_NAME = 'file-settings';

/** Object store name for preview blobs */
const PREVIEW_STORE_NAME = 'file-previews';

/** Preview schema version to force regeneration when encoding changes */
const PREVIEW_VERSION = 1;

/**
 * File settings schema.
 * @typedef {Object} FileSettings
 * @property {string} fileName - Original file name (used as key)
 * @property {number} version - Schema version for migration
 * @property {number} lastModified - Timestamp of last update
 * @property {AnimationSettings} [animation] - Load animation preferences
 * @property {Object} [customAnimation] - Per-file custom animation overrides
 * @property {string} [annotation] - Per-file annotation text
 * @property {number} [focusDistance] - Optional user-set focus distance override
 * @property {CustomCameraMetadata} [customMetadata] - Optional user-set camera metadata override
 * @property {boolean} [isCached] - Whether this file is cached in IndexedDB
 */

/**
 * Animation settings schema (extensible for future additions).
 * @typedef {Object} AnimationSettings
 * @property {boolean} enabled - Whether animation is enabled
 * @property {string} intensity - 'subtle' | 'medium' | 'dramatic'
 * @property {string} direction - 'left' | 'right' | 'up' | 'down' | 'none'
 * @property {number} [duration] - Animation duration override in ms
 * @property {string} [easing] - Easing function override
 */

/**
 * Custom camera metadata schema (stored when no camera metadata exists in file).
 * @typedef {Object} CustomCameraMetadata
 * @property {number} version - Schema version for this custom metadata
 * @property {Object} cameraPose - Camera pose info
 * @property {number[]} cameraPose.position - [x, y, z]
 * @property {number[]} cameraPose.quaternion - [x, y, z, w]
 * @property {number} cameraPose.fov - Field of view in degrees
 * @property {number} cameraPose.near - Near clip
 * @property {number} cameraPose.far - Far clip
 * @property {number} cameraPose.zoom - Camera zoom
 * @property {number[]} cameraPose.target - Orbit target [x, y, z]
 * @property {Object} [model] - Model overrides
 * @property {boolean} [model.flipX] - Rotate 180° around X axis
 * @property {boolean} [model.flipY] - Rotate 180° around Y axis
 * @property {number} [model.modelScale] - Scalar scale multiplier
 * @property {Object} [orbit] - Orbit control overrides
 * @property {boolean} [orbit.fullOrbit] - Allow full 360° azimuth with 180° polar
 */

/** Current schema version */
const SCHEMA_VERSION = 1;

/** Database instance cache */
let dbInstance = null;

/**
 * Opens or creates the IndexedDB database.
 * @returns {Promise<IDBDatabase>} Database instance
 */
const openDatabase = () => {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create object store with fileName as key
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'fileName' });
        objectStore.createIndex('lastModified', 'lastModified', { unique: false });
      }

      // Store preview blobs separately to avoid embedding base64 in settings
      if (!db.objectStoreNames.contains(PREVIEW_STORE_NAME)) {
        const previewStore = db.createObjectStore(PREVIEW_STORE_NAME, { keyPath: 'fileName' });
        previewStore.createIndex('updated', 'updated', { unique: false });
        previewStore.createIndex('version', 'version', { unique: false });
      }
    };
  });
};

/**
 * Loads settings for a file from IndexedDB.
 * @param {string} fileName - File name to load settings for
 * @returns {Promise<FileSettings|null>} Settings object or null if not found
 */
export const loadFileSettings = async (fileName) => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(fileName);

      request.onsuccess = () => {
        const settings = request.result;
        
        if (!settings) {
          resolve(null);
          return;
        }

        // Validate schema version
        if (settings.version !== SCHEMA_VERSION) {
          console.warn(`Settings for ${fileName} have outdated schema version ${settings.version}, ignoring`);
          resolve(null);
          return;
        }

        resolve(settings);
      };

      request.onerror = () => {
        reject(new Error(`Failed to load settings for ${fileName}`));
      };
    });
  } catch (error) {
    console.error(`Failed to load settings for ${fileName}:`, error);
    return null;
  }
};

/**
 * Saves settings for a file to IndexedDB.
 * @param {string} fileName - File name to save settings for
 * @param {Partial<FileSettings>} settings - Settings to save (merged with existing)
 * @returns {Promise<boolean>} Success status
 */
export const saveFileSettings = async (fileName, settings) => {
  try {
    const db = await openDatabase();

    // Load existing settings
    const existing = await loadFileSettings(fileName) || {
      fileName,
      version: SCHEMA_VERSION,
      lastModified: Date.now(),
    };

    // Preview images are stored separately as Blobs; ignore legacy inline previews
    const { preview: _ignoredPreview, ...rest } = settings || {};

    // Merge with existing
    const updated = {
      ...existing,
      ...rest,
      fileName, // Ensure key is present
      lastModified: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(updated);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to save settings for ${fileName}`));
    });
  } catch (error) {
    console.error(`Failed to save settings for ${fileName}:`, error);
    return false;
  }
};

/**
 * Saves animation preferences for a file.
 * @param {string} fileName - File name
 * @param {AnimationSettings} animation - Animation settings
 * @returns {Promise<boolean>} Success status
 */
export const saveAnimationSettings = async (fileName, animation) => {
  return await saveFileSettings(fileName, { animation });
};

/**
 * Saves per-file custom animation settings.
 * @param {string} fileName - File name
 * @param {Object} customAnimation - Custom animation settings
 * @returns {Promise<boolean>} Success status
 */
export const saveCustomAnimationSettings = async (fileName, customAnimation) => {
  return await saveFileSettings(fileName, { customAnimation });
};

/**
 * Saves per-view custom animation settings within a file's settings record.
 * Each view (camera pose) can have its own animation overrides stored in a
 * `viewCustomAnimations` map keyed by viewId.
 * @param {string} fileName - Base file name
 * @param {string} viewId - View identifier
 * @param {Object} customAnimation - Custom animation settings for this view
 * @returns {Promise<boolean>} Success status
 */
export const saveViewCustomAnimationSettings = async (fileName, viewId, customAnimation) => {
  if (!viewId) return false;
  const existing = await loadFileSettings(fileName);
  const viewCustomAnimations = { ...((existing || {}).viewCustomAnimations || {}) };
  if (customAnimation && Object.keys(customAnimation).length > 0) {
    viewCustomAnimations[viewId] = customAnimation;
  } else {
    delete viewCustomAnimations[viewId];
  }
  return await saveFileSettings(fileName, { viewCustomAnimations });
};

/**
 * Saves per-file annotation text.
 * @param {string} fileName - File name
 * @param {string} annotation - Annotation text
 * @returns {Promise<boolean>} Success status
 */
export const saveAnnotation = async (fileName, annotation) => {
  return await saveFileSettings(fileName, {
    annotation: typeof annotation === 'string' ? annotation : '',
  });
};

/**
 * Saves focus distance override for a file.
 * @param {string} fileName - File name
 * @param {number} focusDistance - Focus distance in units
 * @returns {Promise<boolean>} Success status
 */
export const saveFocusDistance = async (fileName, focusDistance) => {
  return await saveFileSettings(fileName, { focusDistance });
};

/**
 * Saves custom camera metadata for a file.
 * @param {string} fileName - File name
 * @param {CustomCameraMetadata} customMetadata - Custom metadata to store
 * @returns {Promise<boolean>} Success status
 */
export const saveCustomMetadata = async (fileName, customMetadata) => {
  return await saveFileSettings(fileName, { customMetadata });
};

/**
 * Saves cached status for a file.
 * @param {string} fileName - File name
 * @param {boolean} isCached - Cached flag
 * @returns {Promise<boolean>} Success status
 */
export const saveCachedStatus = async (fileName, isCached) => {
  return await saveFileSettings(fileName, { isCached: Boolean(isCached) });
};

/**
 * Loads cached status for a file.
 * @param {string} fileName - File name
 * @returns {Promise<boolean>}
 */
const loadCachedStatus = async (fileName) => {
  const settings = await loadFileSettings(fileName);
  return Boolean(settings?.isCached);
};

/**
 * Loads custom camera metadata for a file.
 * @param {string} fileName - File name
 * @returns {Promise<CustomCameraMetadata|null>} Custom metadata or null
 */
export const loadCustomMetadata = async (fileName) => {
  const settings = await loadFileSettings(fileName);
  return settings?.customMetadata ?? null;
};

/**
 * Clears custom camera metadata for a file.
 * @param {string} fileName - File name
 * @returns {Promise<boolean>} Success status
 */
export const clearCustomMetadata = async (fileName) => {
  try {
    const existing = await loadFileSettings(fileName);
    if (existing && existing.customMetadata !== undefined) {
      delete existing.customMetadata;
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(existing);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new Error(`Failed to clear custom metadata for ${fileName}`));
      });
    }
    return true;
  } catch (error) {
    console.error(`Failed to clear custom metadata for ${fileName}:`, error);
    return false;
  }
};

/**
 * Clears focus distance override for a file.
 * @param {string} fileName - File name
 * @returns {Promise<boolean>} Success status
 */
export const clearFocusDistance = async (fileName) => {
  try {
    const existing = await loadFileSettings(fileName);
    if (existing && existing.focusDistance !== undefined) {
      delete existing.focusDistance;
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(existing);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new Error(`Failed to clear focus distance for ${fileName}`));
      });
    }
    return true;
  } catch (error) {
    console.error(`Failed to clear focus distance for ${fileName}:`, error);
    return false;
  }
};

/**
 * Deletes all settings for a file.
 * @param {string} fileName - File name
 * @returns {Promise<boolean>} Success status
 */
export const deleteFileSettings = async (fileName) => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(fileName);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to delete settings for ${fileName}`));
    });
  } catch (error) {
    console.error(`Failed to delete settings for ${fileName}:`, error);
    return false;
  }
};

/**
 * Lists all stored file names.
 * @returns {Promise<string[]>} Array of file names with stored settings
 */
const listStoredFiles = async () => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to list stored files'));
    });
  } catch (error) {
    console.error('Failed to list stored files:', error);
    return [];
  }
};

/**
 * Lists all stored file settings records.
 * @returns {Promise<FileSettings[]>}
 */
export const listAllFileSettings = async () => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error('Failed to list file settings'));
    });
  } catch (error) {
    console.error('Failed to list file settings:', error);
    return [];
  }
};

/**
 * Lists all file names marked as cached.
 * @returns {Promise<string[]>}
 */
export const listCachedFileNames = async () => {
  const settings = await listAllFileSettings();
  return settings.filter((item) => item?.isCached).map((item) => item.fileName);
};

/**
 * Clears all stored file settings.
 * @returns {Promise<number>} Number of entries deleted
 */
export const clearAllFileSettings = async () => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      // Get count before clearing
      const countRequest = store.count();
      
      countRequest.onsuccess = () => {
        const count = countRequest.result;
        const clearRequest = store.clear();
        
        clearRequest.onsuccess = () => resolve(count);
        clearRequest.onerror = () => reject(new Error('Failed to clear settings'));
      };
      
      countRequest.onerror = () => reject(new Error('Failed to count settings'));
    });
  } catch (error) {
    console.error('Failed to clear all settings:', error);
    return 0;
  }
};

/**
 * Validates preview record version/shape.
 * Returns null when regeneration is required.
 */
const normalizePreviewRecord = (record) => {
  if (!record || record.version !== PREVIEW_VERSION) return null;
  if (!record.blob || !record.blob.size) return null;
  return record;
};

/**
 * Lists all preview records (including blobs).
 * @returns {Promise<Array<{fileName:string, blob:Blob, width?:number, height?:number, format?:string, updated?:number, version:number}>>}
 */
export const listPreviewRecords = async () => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PREVIEW_STORE_NAME], 'readonly');
      const store = transaction.objectStore(PREVIEW_STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const records = (request.result || [])
          .map(normalizePreviewRecord)
          .filter(Boolean);
        resolve(records);
      };
      request.onerror = () => reject(new Error('Failed to list preview records'));
    });
  } catch (error) {
    console.error('Failed to list preview records:', error);
    return [];
  }
};

/**
 * Saves a preview Blob for a file.
 * We persist binary data in IndexedDB to avoid base64 size overhead.
 */
export const savePreviewBlob = async (fileName, blob, metadata = {}, storageKey = null) => {
  try {
    if (!blob) return false;
    const db = await openDatabase();
    const key = storageKey || metadata?.storageKey || fileName;

    const record = {
      fileName: key,
      blob,
      version: PREVIEW_VERSION,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      updated: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PREVIEW_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(PREVIEW_STORE_NAME);
      const request = store.put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to save preview for ${key}`));
    });
  } catch (error) {
    console.error(`Failed to save preview for ${storageKey || fileName}:`, error);
    return false;
  }
};

/**
 * Loads a preview Blob for a file.
 * @returns {Promise<{fileName:string, blob:Blob, width?:number, height?:number, format?:string, updated?:number, version:number}|null>}
 */
export const loadPreviewBlob = async (fileName, storageKey = null) => {
  try {
    const db = await openDatabase();
    const key = storageKey || fileName;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PREVIEW_STORE_NAME], 'readonly');
      const store = transaction.objectStore(PREVIEW_STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(normalizePreviewRecord(request.result));
      };

      request.onerror = () => reject(new Error(`Failed to load preview for ${key}`));
    });
  } catch (error) {
    console.error(`Failed to load preview for ${storageKey || fileName}:`, error);
    return null;
  }
};

/**
 * Deletes a stored preview Blob for a file.
 */
export const deletePreviewBlob = async (fileName, storageKey = null) => {
  try {
    const db = await openDatabase();
    const key = storageKey || fileName;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PREVIEW_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(PREVIEW_STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to delete preview for ${key}`));
    });
  } catch (error) {
    console.error(`Failed to delete preview for ${storageKey || fileName}:`, error);
    return false;
  }
};

/**
 * Clears all stored preview blobs.
 */
export const clearAllPreviewBlobs = async () => {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PREVIEW_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(PREVIEW_STORE_NAME);
      const clearRequest = store.clear();
      clearRequest.onsuccess = () => resolve(true);
      clearRequest.onerror = () => reject(new Error('Failed to clear preview blobs'));
    });
  } catch (error) {
    console.error('Failed to clear preview blobs:', error);
    return false;
  }
};
