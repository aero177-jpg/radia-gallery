/**
 * App Storage Source Adapter
 *
 * Stores collections inside the app's private filesystem in native builds.
 * Not available in the web-only build.
 */

import { AssetSource } from './AssetSource.js';
import { createSourceId, MANIFEST_VERSION } from './types.js';
import { saveSource } from './sourceManager.js';
import {
  loadCollectionManifest,
  saveCollectionManifest,
  loadCachedAssetBlob,
  saveCachedAssetBlob,
  deleteCachedAssetBlob,
  getRemovedAssetNames,
} from './assetCache.js';

const stripLeadingSlash = (value) => (value || '').replace(/^\/+/, '');

const getFilename = (path) => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

const isIndexedDbSupported = () => typeof indexedDB !== 'undefined';

export class AppStorageSource extends AssetSource {
  constructor(config) {
    super(config);
    this._manifest = null;
  }

  getCapabilities() {
    return {
      canList: true,
      canStream: false,
      canReadMetadata: false,
      canReadPreviews: false,
      persistent: true,
      writable: true,
    };
  }

  async connect() {
    if (!isIndexedDbSupported()) {
      this._connected = false;
      return { success: false, error: 'IndexedDB is not available in this browser' };
    }

    await this._ensureManifestLoaded();
    this._connected = true;
    return { success: true };
  }

  async _loadManifest() {
    const manifest = await loadCollectionManifest(this.id);
    if (!manifest) {
      this._manifest = null;
      return null;
    }
    this._manifest = manifest;
    return manifest;
  }

  async _saveManifest(manifest) {
    this._manifest = manifest;
    await saveCollectionManifest(manifest);
    await saveSource(this.toJSON());
  }

  async _ensureManifestLoaded() {
    if (this._manifest) return this._manifest;

    const existing = await this._loadManifest();
    if (existing) return existing;

    const manifest = {
      version: MANIFEST_VERSION,
      sourceId: this.id,
      sourceName: this.name,
      sourceType: this.type,
      name: this.config.config.collectionName || this.config.name,
      assets: [],
      removed: [],
    };
    await this._saveManifest(manifest);
    return manifest;
  }

  async listAssets() {
    const manifest = await this._ensureManifestLoaded();
    const removedNames = new Set(await getRemovedAssetNames(this.id));
    const assets = (manifest?.assets || [])
      .filter((asset) => asset?.name && !removedNames.has(asset.name))
      .map((asset) => ({
        id: `${this.id}/${asset.name}`,
        name: asset.name,
        path: asset.path || asset.name,
        sourceId: this.id,
        sourceType: this.type,
        preview: null,
        previewSource: null,
        loaded: false,
        size: asset.size ?? null,
      }));

    this._assets = assets;
    return assets;
  }

  async fetchAssetData(asset) {
    const fileName = asset?.name || getFilename(asset?.path || '');
    if (!fileName) {
      throw new Error('Missing asset name');
    }

    const record = await loadCachedAssetBlob(fileName);
    if (!record?.blob) {
      throw new Error(`Cached asset not found: ${fileName}`);
    }

    return record.blob.arrayBuffer();
  }

  async fetchAssetFile(asset) {
    const data = await this.fetchAssetData(asset);
    const name = asset.name || getFilename(asset.path);
    return new File([data], name, { type: 'application/octet-stream' });
  }

  /**
   * Delete assets from app storage and update manifest.
   * Previews and metadata are stored separately and preserved.
   * @param {Array|string} items
   * @returns {Promise<{success: boolean, removed?: string[], failed?: Array}>}
   */
  async deleteAssets(items) {
    const toDelete = (Array.isArray(items) ? items : [items])
      .map(item => typeof item === 'string' ? item : item?.path)
      .filter(Boolean)
      .map(p => stripLeadingSlash(p));
    if (!toDelete.length) return { success: true, removed: [] };

    const manifest = await this._ensureManifestLoaded();
    const removed = [];
    const failed = [];

    for (const path of toDelete) {
      const fileName = getFilename(path);
      try {
        const removedOk = await deleteCachedAssetBlob(fileName);
        if (!removedOk) {
          failed.push({ path, error: 'Failed to remove cached asset' });
          continue;
        }
        removed.push(path);
      } catch (err) {
        failed.push({ path, error: err?.message || 'Failed to remove cached asset' });
      }
    }

    if (manifest) {
      const removedSet = new Set(removed.map((path) => getFilename(path)));
      manifest.assets = (manifest.assets || []).filter((asset) => !removedSet.has(asset?.name));
      await this._saveManifest(manifest);
    }

    return { success: failed.length === 0, removed, failed };
  }

  /**
   * Import files into app storage and update manifest.
   * @param {File[]} files
   * @returns {Promise<{success: boolean, error?: string, imported?: number}>}
   */
  async importFiles(files) {
    if (!isIndexedDbSupported()) {
      return { success: false, error: 'IndexedDB is not available in this browser' };
    }

    if (!files?.length) return { success: true, imported: 0 };

    const manifest = await this._ensureManifestLoaded();
    let imported = 0;

    for (const file of files) {
      if (!file?.name) continue;
      const ok = await saveCachedAssetBlob(file.name, file, { size: file.size, type: file.type });
      if (ok) {
        imported += 1;
        const existing = (manifest.assets || []).find((asset) => asset?.name === file.name);
        if (existing) {
          existing.size = file.size ?? existing.size ?? null;
          existing.path = existing.path || file.name;
        } else {
          manifest.assets.push({
            name: file.name,
            path: file.name,
            size: file.size ?? null,
          });
        }
      }
    }

    await this._saveManifest(manifest);
    return { success: true, imported };
  }
}

/**
 * Create a new AppStorageSource with a fresh ID.
 * @param {{ id?: string, name?: string, collectionId?: string, collectionName?: string }} options
 * @returns {AppStorageSource}
 */
export const createAppStorageSource = (options = {}) => {
  const sourceId = options.id || createSourceId('app-storage');
  const collectionId = options.collectionId || sourceId;
  const name = options.name || options.collectionName || 'App Storage';

  const config = {
    id: sourceId,
    type: 'app-storage',
    name,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: {
      collectionId,
      collectionName: options.collectionName || name,
    },
  };

  return new AppStorageSource(config);
};

/**
 * Restore an AppStorageSource from persisted config.
 * @param {Object} config
 * @returns {AppStorageSource}
 */
export const restoreAppStorageSource = (config) => {
  return new AppStorageSource(config);
};

