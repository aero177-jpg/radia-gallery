/**
 * Storage Sources Manager
 * 
 * Manages multiple storage source connections using IndexedDB for persistence.
 * Provides a unified interface for the app to work with all connected sources.
 */

import { createSourceId } from './types.js';

/** Database name for storage sources */
const DB_NAME = 'radia-gallery-sources';
const DB_VERSION = 1;
const SOURCES_STORE = 'sources';
const HANDLES_STORE = 'handles';

/** Database instance cache */
let dbInstance = null;

/** Active source instances (runtime only) */
const activeSources = new Map();

/** Event listeners for source changes */
const listeners = new Set();

/**
 * Opens or creates the IndexedDB database for storage sources.
 * @returns {Promise<IDBDatabase>}
 */
const openDatabase = () => {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open storage sources database'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Store for serializable source configs
      if (!db.objectStoreNames.contains(SOURCES_STORE)) {
        const store = db.createObjectStore(SOURCES_STORE, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
      }

      // Store for FileSystemDirectoryHandle objects (local folders)
      if (!db.objectStoreNames.contains(HANDLES_STORE)) {
        db.createObjectStore(HANDLES_STORE, { keyPath: 'id' });
      }
    };
  });
};

/**
 * Notify all listeners of source changes
 * @param {'added' | 'removed' | 'updated' | 'connected' | 'disconnected'} event
 * @param {string} sourceId
 */
const notifyListeners = (event, sourceId) => {
  listeners.forEach(listener => {
    try {
      listener(event, sourceId);
    } catch (err) {
      console.warn('Source change listener error:', err);
    }
  });
};

/**
 * Subscribe to source changes
 * @param {Function} listener - Callback receiving (event, sourceId)
 * @returns {Function} Unsubscribe function
 */
export const onSourceChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Save a source configuration to IndexedDB.
 * @param {Object} sourceConfig - Source configuration to save
 * @returns {Promise<boolean>}
 */
export const saveSource = async (sourceConfig) => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([SOURCES_STORE], 'readwrite');
      const store = transaction.objectStore(SOURCES_STORE);
      
      // Update lastAccessed timestamp
      const config = {
        ...sourceConfig,
        lastAccessed: Date.now(),
      };
      
      const request = store.put(config);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error('Failed to save source'));
    });
  } catch (error) {
    console.error('Failed to save source:', error);
    return false;
  }
};

/**
 * Save a FileSystemDirectoryHandle for a local folder source.
 * @param {string} sourceId
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export const saveDirectoryHandle = async (sourceId, handle) => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([HANDLES_STORE], 'readwrite');
      const store = transaction.objectStore(HANDLES_STORE);
      
      const request = store.put({ id: sourceId, handle });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error('Failed to save directory handle'));
    });
  } catch (error) {
    console.error('Failed to save directory handle:', error);
    return false;
  }
};

/**
 * Load a FileSystemDirectoryHandle for a local folder source.
 * @param {string} sourceId
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export const loadDirectoryHandle = async (sourceId) => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([HANDLES_STORE], 'readonly');
      const store = transaction.objectStore(HANDLES_STORE);
      
      const request = store.get(sourceId);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result?.handle ?? null);
      };
      request.onerror = () => reject(new Error('Failed to load directory handle'));
    });
  } catch (error) {
    console.error('Failed to load directory handle:', error);
    return null;
  }
};

/**
 * Delete a FileSystemDirectoryHandle for a local folder source.
 * @param {string} sourceId
 * @returns {Promise<boolean>}
 */
export const deleteDirectoryHandle = async (sourceId) => {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([HANDLES_STORE], 'readwrite');
      const store = transaction.objectStore(HANDLES_STORE);

      const request = store.delete(sourceId);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error('Failed to delete directory handle'));
    });
  } catch (error) {
    console.error('Failed to delete directory handle:', error);
    return false;
  }
};

/**
 * Load all saved source configurations.
 * @returns {Promise<Object[]>}
 */
export const loadAllSources = async () => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([SOURCES_STORE], 'readonly');
      const store = transaction.objectStore(SOURCES_STORE);
      
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error('Failed to load sources'));
    });
  } catch (error) {
    console.error('Failed to load sources:', error);
    return [];
  }
};

/**
 * Load a single source configuration by ID.
 * @param {string} sourceId
 * @returns {Promise<Object | null>}
 */
export const loadSource = async (sourceId) => {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([SOURCES_STORE], 'readonly');
      const store = transaction.objectStore(SOURCES_STORE);
      
      const request = store.get(sourceId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(new Error('Failed to load source'));
    });
  } catch (error) {
    console.error('Failed to load source:', error);
    return null;
  }
};

/**
 * Delete a source and its associated data.
 * @param {string} sourceId
 * @returns {Promise<boolean>}
 */
export const deleteSource = async (sourceId) => {
  try {
    const db = await openDatabase();
    
    // Delete from both stores
    await Promise.all([
      new Promise((resolve, reject) => {
        const transaction = db.transaction([SOURCES_STORE], 'readwrite');
        const store = transaction.objectStore(SOURCES_STORE);
        const request = store.delete(sourceId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to delete source config'));
      }),
      new Promise((resolve, reject) => {
        const transaction = db.transaction([HANDLES_STORE], 'readwrite');
        const store = transaction.objectStore(HANDLES_STORE);
        const request = store.delete(sourceId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to delete handle'));
      }),
    ]);
    
    // Remove from active sources
    activeSources.delete(sourceId);
    notifyListeners('removed', sourceId);
    
    return true;
  } catch (error) {
    console.error('Failed to delete source:', error);
    return false;
  }
};

/**
 * Register an active source instance.
 * @param {import('./AssetSource.js').AssetSource} source
 */
export const registerSource = (source) => {
  activeSources.set(source.id, source);
  notifyListeners('added', source.id);
};

/**
 * Unregister an active source instance.
 * @param {string} sourceId
 */
const unregisterSource = (sourceId) => {
  const source = activeSources.get(sourceId);
  if (source) {
    source.disconnect();
    activeSources.delete(sourceId);
    notifyListeners('disconnected', sourceId);
  }
};

/**
 * Get an active source instance by ID.
 * @param {string} sourceId
 * @returns {import('./AssetSource.js').AssetSource | undefined}
 */
export const getSource = (sourceId) => {
  return activeSources.get(sourceId);
};

/**
 * Get all active source instances.
 * @returns {Map<string, import('./AssetSource.js').AssetSource>}
 */
const getAllSources = () => {
  return new Map(activeSources);
};

/**
 * Get all active sources as an array.
 * @returns {import('./AssetSource.js').AssetSource[]}
 */
export const getSourcesArray = () => {
  return Array.from(activeSources.values());
};

/**
 * Clear all sources (for testing/reset).
 * @returns {Promise<void>}
 */
const clearAllSources = async () => {
  // Disconnect all active sources
  activeSources.forEach(source => source.disconnect());
  activeSources.clear();
  
  // Clear database
  try {
    const db = await openDatabase();
    
    await Promise.all([
      new Promise((resolve, reject) => {
        const transaction = db.transaction([SOURCES_STORE], 'readwrite');
        const store = transaction.objectStore(SOURCES_STORE);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject();
      }),
      new Promise((resolve, reject) => {
        const transaction = db.transaction([HANDLES_STORE], 'readwrite');
        const store = transaction.objectStore(HANDLES_STORE);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject();
      }),
    ]);
  } catch (error) {
    console.error('Failed to clear sources database:', error);
  }
};

/**
 * Update lastAccessed timestamp for a source.
 * @param {string} sourceId
 * @returns {Promise<void>}
 */
export const touchSource = async (sourceId) => {
  try {
    const config = await loadSource(sourceId);
    if (config) {
      await saveSource({ ...config, lastAccessed: Date.now() });
    }
  } catch (error) {
    console.warn('Failed to update source access time:', error);
  }
};

/**
 * Mark a single source as the default collection. Clears the flag on others.
 * Pass null to clear all defaults.
 * @param {string | null} sourceId
 * @returns {Promise<boolean>} True if the source exists (or null) and update succeeded
 */
export const setDefaultSource = async (sourceId) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([SOURCES_STORE], 'readwrite');
    const store = transaction.objectStore(SOURCES_STORE);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onerror = () => reject(new Error('Failed to load sources for default update'));

      request.onsuccess = () => {
        const configs = request.result || [];
        let found = sourceId === null; // null always succeeds (clear all)
        let previousDefaultId = null;
        let changed = false;

        configs.forEach((config) => {
          if (config.isDefault) {
            previousDefaultId = config.id;
          }

          const isDefault = sourceId !== null && config.id === sourceId;
          if (isDefault) {
            found = true;
          }

          if (!!config.isDefault !== isDefault) {
            changed = true;
            store.put({ ...config, isDefault });
          }
        });

        transaction.oncomplete = () => {
          // Keep in-memory instances in sync
          activeSources.forEach((source) => {
            source.config.isDefault = sourceId !== null && source.id === sourceId;
          });

          if (changed) {
            if (sourceId) {
              notifyListeners('updated', sourceId);
            }
            if (previousDefaultId && previousDefaultId !== sourceId) {
              notifyListeners('updated', previousDefaultId);
            }
          }

          resolve(found);
        };

        transaction.onerror = () => reject(new Error('Failed to set default source'));
      };
    });
  } catch (error) {
    console.error('Failed to set default source:', error);
    return false;
  }
};

/**
 * Read the default source ID from persistence.
 * @returns {Promise<string | null>}
 */
const getDefaultSourceId = async () => {
  try {
    const configs = await loadAllSources();
    const entry = configs.find((config) => config.isDefault);
    return entry?.id ?? null;
  } catch (error) {
    console.warn('Failed to read default source id:', error);
    return null;
  }
};
