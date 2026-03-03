/**
 * Storage Module Index
 * 
 * Re-exports all storage-related functionality for convenient imports.
 */

// Types and constants
export {
  SOURCE_TIERS,
  MANIFEST_VERSION,
  SUPPORTED_MANIFEST_VERSIONS,
  isFileSystemAccessSupported,
  createSourceId,
} from './types.js';

// Base class
export { AssetSource } from './AssetSource.js';

// Source adapters
export { 
  LocalFolderSource, 
  createLocalFolderSource, 
  restoreLocalFolderSource,
} from './LocalFolderSource.js';

export {
  AppStorageSource,
  createAppStorageSource,
  restoreAppStorageSource,
} from './AppStorageSource.js';

export { 
  PublicUrlSource, 
  createPublicUrlSource, 
  restorePublicUrlSource,
} from './PublicUrlSource.js';

export {
  SupabaseStorageSource,
  createSupabaseStorageSource,
  restoreSupabaseStorageSource,
} from './SupabaseStorageSource.js';

export {
  R2BucketSource,
  createR2BucketSource,
  restoreR2BucketSource,
} from './R2BucketSource.js';

// Import restore functions for local use in restoreSource()
import { restoreLocalFolderSource as _restoreLocalFolderSource } from './LocalFolderSource.js';
import { restoreAppStorageSource as _restoreAppStorageSource } from './AppStorageSource.js';
import { restorePublicUrlSource as _restorePublicUrlSource } from './PublicUrlSource.js';
import { restoreSupabaseStorageSource as _restoreSupabaseStorageSource } from './SupabaseStorageSource.js';
import { restoreR2BucketSource as _restoreR2BucketSource } from './R2BucketSource.js';
import { createPublicUrlSource as _createPublicUrlSource } from './PublicUrlSource.js';

// Source manager - import for local use
import {
  loadAllSources as _loadAllSources,
  registerSource as _registerSource,
  saveSource as _saveSource,
} from './sourceManager.js';

// Source manager - re-export
export {
  saveSource,
  loadSource,
  loadAllSources,
  deleteSource,
  saveDirectoryHandle,
  loadDirectoryHandle,
  deleteDirectoryHandle,
  registerSource,
  getSource,
  getSourcesArray,
  onSourceChange,
  touchSource,
  setDefaultSource,
} from './sourceManager.js';

// Source asset adapter
export {
  adaptRemoteAsset,
  loadAssetFile,
  loadAssetPreview,
  loadAssetMetadata,
  isSourceAsset,
  loadSourceAssets,
} from './sourceAssetAdapter.js';

// Asset cache
export {
  loadCachedAssetBlob,
  loadCachedAssetFile,
  saveCachedAssetBlob,
  deleteCachedAssetBlob,
  loadCollectionManifest,
  saveCollectionManifest,
  deleteCollectionManifest,
  getRemovedAssetNames,
  addRemovedAssetNames,
  clearRemovedAssets,
  cacheCollectionAssets,
  syncCollectionCache,
  clearCollectionCache,
  clearAllAssetCache,
} from './assetCache.js';


/**
 * Restore a source from persisted config based on its type.
 * @param {Object} config - Persisted source configuration
 * @returns {import('./AssetSource.js').AssetSource | null}
 */
export const restoreSource = (config) => {
  if (!config || !config.type) return null;

  switch (config.type) {
    case 'local-folder':
      return _restoreLocalFolderSource(config);
    case 'app-storage':
      return _restoreAppStorageSource(config);
    case 'public-url':
      return _restorePublicUrlSource(config);
    case 'supabase-storage':
      return _restoreSupabaseStorageSource(config);
    case 'r2-bucket':
      return _restoreR2BucketSource(config);
    default:
      console.warn(`Unknown source type: ${config.type}`);
      return null;
  }
};

/**
 * Initialize all persisted sources on app startup.
 * Restores sources from IndexedDB and attempts to reconnect.
 * @returns {Promise<import('./AssetSource.js').AssetSource[]>}
 */
export const initializeSources = async () => {
  const configs = await _loadAllSources();
  console.log('[Storage] Found persisted configs:', configs);
  const sources = [];

  for (const config of configs) {
    const source = restoreSource(config);
    if (source) {
      _registerSource(source);
      sources.push(source);
    }
  }

  return sources;
};
