/**
 * Local Folder Source Adapter
 * 
 * Uses the File System Access API to read assets from a user-selected folder.
 * Directory handle is persisted in IndexedDB for reconnection across sessions.
 */

import { AssetSource } from './AssetSource.js';
import { createSourceId, isFileSystemAccessSupported } from './types.js';
import {
  saveSource,
  saveDirectoryHandle,
  loadDirectoryHandle,
  deleteDirectoryHandle,
} from './sourceManager.js';
import { getSupportedExtensions } from '../formats/index.js';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

/**
 * Get file extension in lowercase with dot
 * @param {string} filename
 * @returns {string}
 */
const getExtension = (filename) => {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

/**
 * Get base filename without extension
 * @param {string} filename
 * @returns {string}
 */
const getBaseName = (filename) => {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
};

/**
 * Local folder asset source using File System Access API.
 */
export class LocalFolderSource extends AssetSource {
  /**
   * @param {Object} config - Source configuration
   * @param {FileSystemDirectoryHandle} [handle] - Directory handle (if already obtained)
   */
  constructor(config, handle = null) {
    super(config);
    this._handle = handle;
    this._fileHandles = new Map(); // Map of asset path to FileSystemFileHandle
    this._previewHandles = new Map(); // Map of asset base name to preview file handle
  }

  getCapabilities() {
    return {
      canList: true,
      canStream: false, // File API doesn't support streaming
      canReadMetadata: false, // Could be extended to read .meta.json files
      canReadPreviews: true, // Can read matching image files
      persistent: true,
      writable: true,
    };
  }

  /**
   * Validate that a handle is a proper FileSystemDirectoryHandle.
   * Corrupt handles from IndexedDB after browser restart can crash Chrome.
   * @param {any} handle
   * @returns {boolean}
   */
  _isValidHandle(handle) {
    try {
      return (
        handle &&
        typeof handle === 'object' &&
        handle.kind === 'directory' &&
        typeof handle.name === 'string' &&
        typeof handle.queryPermission === 'function' &&
        typeof handle.requestPermission === 'function'
      );
    } catch {
      return false;
    }
  }

  /**
   * Connect to the local folder.
   * Loads a persisted handle if available, but does not request permission.
   * Use requestPermission() to prompt the user for access.
   * @param {boolean} [promptIfNeeded=true] - If true and no handle exists, prompt user to select folder
   * @returns {Promise<{success: boolean, error?: string, needsPermission?: boolean}>}
   */
  async connect(promptIfNeeded = true) {
    if (!isFileSystemAccessSupported()) {
      return { 
        success: false, 
        error: 'File System Access API is not supported in this browser' 
      };
    }

    // If already connected with a valid handle, return success
    if (this._connected && this._handle) {
      return { success: true };
    }

    // If we have a handle in memory (from this session), try to use it
    if (this._handle) {
      try {
        const permission = await this._handle.queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          this._connected = true;
          return { success: true };
        }
        // Permission not granted, need user gesture
        return { success: false, needsPermission: true };
      } catch (err) {
        console.warn('Handle permission check failed:', err);
        // Handle is bad, clear it
        this._handle = null;
        return { success: false, needsPermission: true };
      }
    }

    // Try to hydrate handle from IndexedDB without prompting
    const hydratedHandle = await this.getHandle();
    if (hydratedHandle) {
      try {
        const permission = await hydratedHandle.queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          this._connected = true;
          return { success: true };
        }
        return { success: false, needsPermission: true };
      } catch (err) {
        console.warn('Stored handle permission check failed:', err);
        this._handle = null;
        return { success: false, needsPermission: true };
      }
    }

    // No handle available - prompt only if this is a user gesture
    if (promptIfNeeded) {
      // User initiated (e.g., creating new collection), safe to show picker
      return this.selectFolder();
    }

    // For auto-connect attempts, just say we need permission
    return { success: false, needsPermission: true };
  }

  /**
   * Show folder picker dialog and connect.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async selectFolder() {
    if (!isFileSystemAccessSupported()) {
      return { 
        success: false, 
        error: 'File System Access API is not supported' 
      };
    }

    try {
      // @ts-ignore - showDirectoryPicker is not in TS types yet
      this._handle = await window.showDirectoryPicker({
        mode: 'readwrite',
      });

      // Update config with folder name
      this.config.config.path = this._handle.name;
      this.name = this._handle.name;
      this.config.name = this._handle.name;

      // Persist config and handle in IndexedDB
      await saveSource(this.toJSON());
      await saveDirectoryHandle(this.id, this._handle);

      this._connected = true;
      return { success: true };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { success: false, error: 'Folder selection cancelled' };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Request permission on the stored handle (after user gesture).
   * This MUST be called from a user gesture handler (click, etc).
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async requestPermission() {
    // If already connected, return success
    if (this._connected && this._handle) {
      return { success: true };
    }

    // If we have a handle in memory, try to request permission
    if (this._handle) {
      try {
        const permission = await this._handle.requestPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          this._connected = true;
          return { success: true };
        }
        return { success: false, needsPermission: true };
      } catch (err) {
        console.warn('Permission request failed on in-memory handle:', err);
        this._handle = null;
      }
    }

    // Try to hydrate a stored handle and request permission
    const hydratedHandle = await this.getHandle();
    if (hydratedHandle) {
      try {
        const permission = await hydratedHandle.requestPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          this._connected = true;
          return { success: true };
        }
        return { success: false, needsPermission: true };
      } catch (err) {
        console.warn('Permission request failed on stored handle:', err);
        this._handle = null;
      }
    }

    // No stored handle available; prompt the user to pick the folder again.
    this._handle = null;
    return this.selectFolder();
  }

  /**
   * Get directory handle, hydrating from IndexedDB if needed.
   * @returns {Promise<FileSystemDirectoryHandle | null>}
   */
  async getHandle() {
    if (this._handle) return this._handle;

    try {
      const handle = await loadDirectoryHandle(this.id);
      if (!this._isValidHandle(handle)) {
        if (handle) {
          await deleteDirectoryHandle(this.id);
        }
        return null;
      }

      this._handle = handle;
      return handle;
    } catch (err) {
      console.error('Failed to restore directory handle:', err);
      await deleteDirectoryHandle(this.id);
      return null;
    }
  }

  /**
   * Validate that a handle is a proper FileSystemDirectoryHandle.
   * Note: Even valid-looking handles can crash Chrome if loaded from IndexedDB after restart.
   * @param {any} handle
   * @returns {boolean}
   */
  _isValidHandle(handle) {
    try {
      return (
        handle &&
        typeof handle === 'object' &&
        handle.kind === 'directory' &&
        typeof handle.name === 'string' &&
        typeof handle.queryPermission === 'function' &&
        typeof handle.requestPermission === 'function'
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if we have a potentially reconnectable stored handle.
   * Does NOT load the handle - just checks if one exists in the config.
   * @returns {boolean}
   */
  hasStoredHandle() {
    // We have config data that suggests a handle was stored
    return Boolean(this.config?.config?.path);
  }

  /**
   * List all supported assets in the folder.
   * @returns {Promise<import('./types.js').RemoteAssetDescriptor[]>}
   */
  async listAssets() {
    if (!this._connected || !this._handle) {
      throw new Error('Not connected to folder');
    }

    const supportedExtensions = getSupportedExtensions();
    const assets = [];
    const imageFiles = new Map(); // baseName -> file handle

    this._fileHandles.clear();
    this._previewHandles.clear();

    // First pass: collect all files
    for await (const entry of this._handle.values()) {
      if (entry.kind !== 'file') continue;

      const ext = getExtension(entry.name);
      const baseName = getBaseName(entry.name).toLowerCase();

      if (supportedExtensions.includes(ext)) {
        this._fileHandles.set(entry.name, entry);
      } else if (IMAGE_EXTENSIONS.includes(ext)) {
        imageFiles.set(baseName, entry);
      }
    }

    // Second pass: create asset descriptors with preview matching
    for (const [filename, fileHandle] of this._fileHandles) {
      const baseName = getBaseName(filename).toLowerCase();
      const previewHandle = imageFiles.get(baseName);

      if (previewHandle) {
        this._previewHandles.set(baseName, previewHandle);
      }

      const asset = {
        id: `${this.id}/${filename}`,
        name: filename,
        path: filename,
        sourceId: this.id,
        sourceType: this.type,
        preview: null,
        previewSource: previewHandle ? 'pending' : null,
        loaded: false,
      };

      assets.push(asset);
    }

    // Sort by name
    assets.sort((a, b) => a.name.localeCompare(b.name));
    this._assets = assets;

    return assets;
  }

  /**
   * Import files into the local folder (write to disk).
   * Requires readwrite permission on the directory handle.
   * @param {File[]} files
   * @returns {Promise<{success: boolean, imported?: number, error?: string}>}
   */
  async importFiles(files = []) {
    if (!isFileSystemAccessSupported()) {
      return { success: false, error: 'File System Access API is not supported in this browser' };
    }

    if (!files?.length) {
      return { success: true, imported: 0 };
    }

    const handle = await this.getHandle();
    if (!handle) {
      return { success: false, error: 'No folder access. Reconnect the folder to grant permission.' };
    }

    try {
      let permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        permission = await handle.requestPermission({ mode: 'readwrite' });
      }

      if (permission !== 'granted') {
        return { success: false, error: 'Write permission was not granted for this folder.' };
      }

      let imported = 0;
      for (const file of files) {
        if (!file?.name) continue;
        const fileHandle = await handle.getFileHandle(file.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(file);
        await writable.close();
        imported += 1;
      }

      this._connected = true;
      return { success: true, imported };
    } catch (err) {
      console.error('Local folder import failed:', err);
      return { success: false, error: err?.message || 'Failed to write files to folder' };
    }
  }

  /**
   * Fetch asset data as ArrayBuffer.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchAssetData(asset) {
    const fileHandle = this._fileHandles.get(asset.path);
    if (!fileHandle) {
      throw new Error(`File not found: ${asset.path}`);
    }

    const file = await fileHandle.getFile();
    return file.arrayBuffer();
  }

  /**
   * Fetch asset as File object.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<File>}
   */
  async fetchAssetFile(asset) {
    const fileHandle = this._fileHandles.get(asset.path);
    if (!fileHandle) {
      throw new Error(`File not found: ${asset.path}`);
    }

    return fileHandle.getFile();
  }

  /**
   * Fetch preview image for an asset.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<string | null>} Data URL
   */
  async fetchPreview(asset) {
    const baseName = getBaseName(asset.path).toLowerCase();
    const previewHandle = this._previewHandles.get(baseName);

    if (!previewHandle) {
      return null;
    }

    try {
      const file = await previewHandle.getFile();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    } catch (error) {
      console.warn(`Failed to load preview for ${asset.name}:`, error);
      return null;
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      config: {
        ...this.config.config,
        // Don't serialize the handle - it's stored separately
        handle: undefined,
      },
    };
  }

  disconnect() {
    super.disconnect();
    this._fileHandles.clear();
    this._previewHandles.clear();
    // Keep handle for potential reconnection
  }
}

/**
 * Create a new LocalFolderSource with a fresh ID.
 * @returns {LocalFolderSource}
 */
export const createLocalFolderSource = () => {
  const id = createSourceId('local-folder');
  const config = {
    id,
    type: 'local-folder',
    name: 'Local Folder',
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: {
      path: '',
    },
  };
  return new LocalFolderSource(config);
};

/**
 * Restore a LocalFolderSource from persisted config.
 * @param {Object} config - Persisted source config
 * @returns {LocalFolderSource}
 */
export const restoreLocalFolderSource = (config) => {
  return new LocalFolderSource(config);
};


