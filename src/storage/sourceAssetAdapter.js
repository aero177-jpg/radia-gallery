/**
 * Source Asset Adapter
 * 
 * Bridges storage sources with the existing asset pipeline.
 * Converts RemoteAssetDescriptor to the format expected by fileLoader/splatManager.
 */

import { getSource, touchSource } from './sourceManager.js';
import { loadFileSettings, saveCachedStatus } from '../fileStorage.js';
import { loadCachedAssetFile, loadCollectionManifest, getRemovedAssetNames } from './assetCache.js';

/**
 * Adapts a RemoteAssetDescriptor to the internal asset format.
 * Creates a File-like object that works with existing loaders.
 * 
 * @param {import('./types.js').RemoteAssetDescriptor} remoteAsset
 * @returns {Object} Internal asset descriptor
 */
export const adaptRemoteAsset = (remoteAsset) => {
  return {
    id: remoteAsset.id,
    name: remoteAsset.name,
    path: remoteAsset.path,
    sourceId: remoteAsset.sourceId,
    sourceType: remoteAsset.sourceType,
    // File will be loaded lazily
    file: null,
    _remoteAsset: remoteAsset,
    preview: remoteAsset.preview || null,
    previewSource: remoteAsset.previewSource || null,
    loaded: false,
    isCached: false,
    // Size from remote if known
    size: remoteAsset.size || null,
  };
};

/**
 * Lazily load the File object for an adapted asset.
 * This is called when the asset is about to be displayed.
 * 
 * @param {Object} asset - Internal asset descriptor
 * @returns {Promise<File>}
 */
export const loadAssetFile = async (asset) => {
  // Already loaded
  if (asset.file) {
    return asset.file;
  }

  // Cache-first by file name
  if (asset?.name) {
    try {
      const cachedFile = await loadCachedAssetFile(asset.name);
      if (cachedFile) {
        asset.file = cachedFile;
        asset.isCached = true;
        await saveCachedStatus(asset.name, true);
        return cachedFile;
      }
    } catch (err) {
      console.warn('[AssetCache] Failed to load cached file, falling back to source', err);
    }
  }

  // No remote info - can't load
  if (!asset._remoteAsset || !asset.sourceId) {
    throw new Error('Asset has no source information');
  }

  const source = getSource(asset.sourceId);
  if (!source) {
    throw new Error(`Source not found: ${asset.sourceId}`);
  }

  if (!source.isConnected()) {
    const result = await source.connect(false);
    if (!result.success) {
      throw new Error(result.error || 'Source not connected');
    }
  }

  // Fetch file from source
  const file = await source.fetchAssetFile(asset._remoteAsset);
  asset.file = file;

  // Update source access time
  await touchSource(asset.sourceId);

  return file;
};

/**
 * Load preview image for an asset.
 * Tries source preview first, falls back to IndexedDB.
 * 
 * @param {Object} asset
 * @returns {Promise<string | null>} Preview data URL or URL
 */
export const loadAssetPreview = async (asset) => {
  // Already have preview
  if (asset.preview) {
    return asset.preview;
  }

  const source = asset.sourceId ? getSource(asset.sourceId) : null;

  // Try source preview
  if (source && asset._remoteAsset) {
    try {
      const preview = await source.fetchPreview(asset._remoteAsset);
      if (preview) {
        asset.preview = preview;
        asset.previewSource = 'remote';
        return preview;
      }
    } catch (err) {
      console.warn('Failed to load remote preview:', err);
    }
  }

  // Fall back to IndexedDB
  try {
    const stored = await loadFileSettings(asset.name);
    if (stored?.preview) {
      asset.preview = stored.preview;
      asset.previewSource = 'indexeddb';
      return stored.preview;
    }
  } catch (err) {
    console.warn('Failed to load stored preview:', err);
  }

  return null;
};

/**
 * Load metadata for an asset.
 * Tries source metadata first, falls back to IndexedDB.
 * 
 * @param {Object} asset
 * @returns {Promise<Object | null>}
 */
export const loadAssetMetadata = async (asset) => {
  const source = asset.sourceId ? getSource(asset.sourceId) : null;

  // Try source metadata
  if (source && asset._remoteAsset) {
    try {
      const metadata = await source.fetchMetadata(asset._remoteAsset);
      if (metadata) {
        return metadata;
      }
    } catch (err) {
      console.warn('Failed to load remote metadata:', err);
    }
  }

  // Fall back to IndexedDB
  try {
    const stored = await loadFileSettings(asset.name);
    if (stored) {
      return {
        animation: stored.animation,
        focusDistance: stored.focusDistance,
        customAnimation: stored.customAnimation,
      };
    }
  } catch (err) {
    console.warn('Failed to load stored metadata:', err);
  }

  return null;
};

/**
 * Check if an asset is from a storage source (vs local file)
 * @param {Object} asset
 * @returns {boolean}
 */
export const isSourceAsset = (asset) => {
  return !!asset?.sourceId;
};

/**
 * Load all assets from a storage source and adapt them.
 * Falls back to local cache manifest when offline or source unavailable.
 * 
 * @param {import('./AssetSource.js').AssetSource} source
 * @returns {Promise<Object[]>} Array of adapted assets
 */
export const loadSourceAssets = async (source) => {
  // Helper to build assets from cached manifest
  const buildAssetsFromCache = async () => {
    const cachedManifest = await loadCollectionManifest(source.id);
    if (cachedManifest?.assets?.length) {
      const removedSet = new Set(cachedManifest?.removed || []);
      const visibleAssets = cachedManifest.assets.filter((asset) => !removedSet.has(asset?.name));
      console.log(`[SourceAdapter] Using ${cachedManifest.assets.length} cached assets for ${source.id}`);
      return visibleAssets.map((asset) => adaptRemoteAsset({
        id: `${source.id}/${asset.path || asset.name}`,
        name: asset.name,
        path: asset.path || asset.name,
        sourceId: source.id,
        sourceType: source.type,
        size: asset.size,
        preview: null,
        previewSource: null,
        loaded: false,
      }));
    }
    return null;
  };

  // Try connecting to source
  try {
    if (!source.isConnected()) {
      const connectOptions = source.type === 'local-folder' ? false : { refreshManifest: true };
      const result = await source.connect(connectOptions);
      if (!result.success) {
        // Connection failed - try cache
        console.log('[SourceAdapter] Source connection failed, trying cache');
        const cached = await buildAssetsFromCache();
        if (cached) return cached;
        throw new Error(result.error || 'Failed to connect to source');
      }
    }

    // Source is connected, try to list assets
    const remoteAssets = await source.listAssets();
    const removedNames = await getRemovedAssetNames(source.id);
    const removedSet = new Set(removedNames);
    const visibleAssets = removedSet.size
      ? remoteAssets.filter((asset) => !removedSet.has(asset?.name))
      : remoteAssets;
    return visibleAssets.map(adaptRemoteAsset);
  } catch (err) {
    // Any error (network, etc.) - try cache as fallback
    console.log('[SourceAdapter] Error loading assets, trying cache:', err.message);
    const cached = await buildAssetsFromCache();
    if (cached) return cached;
    throw err;
  }
};

/**
 * Get all assets from all connected sources.
 * 
 * @param {Map<string, import('./AssetSource.js').AssetSource>} sources
 * @returns {Promise<Object[]>}
 */
const loadAllSourceAssets = async (sources) => {
  const allAssets = [];

  for (const [id, source] of sources) {
    try {
      if (!source.isConnected()) {
        continue; // Skip disconnected sources
      }
      const assets = await loadSourceAssets(source);
      allAssets.push(...assets);
    } catch (err) {
      console.warn(`Failed to load assets from source ${id}:`, err);
    }
  }

  return allAssets;
};
