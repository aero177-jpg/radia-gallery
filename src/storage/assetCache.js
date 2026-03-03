/**
 * Asset Cache Module
 *
 * Persists cached asset blobs in IndexedDB and tracks per-collection cache manifests.
 * This cache is name-based (file name only) and independent from preview storage.
 */

import { loadFileSettings, saveFileSettings } from '../fileStorage.js';

const DB_NAME = 'radia-gallery-asset-cache';
const DB_VERSION = 1;

const ASSET_STORE = 'asset-blobs';
const MANIFEST_STORE = 'collection-manifests';

let dbInstance = null;

const openDatabase = () => {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open asset cache database'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const store = db.createObjectStore(ASSET_STORE, { keyPath: 'fileName' });
        store.createIndex('updated', 'updated', { unique: false });
        store.createIndex('size', 'size', { unique: false });
      }

      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        const store = db.createObjectStore(MANIFEST_STORE, { keyPath: 'sourceId' });
        store.createIndex('updated', 'updated', { unique: false });
      }
    };
  });
};

const normalizeRemovedList = (removed) => {
  if (!Array.isArray(removed)) return [];
  const cleaned = removed
    .map((name) => (name == null ? '' : String(name)))
    .map((name) => name.trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

const normalizeManifest = (manifest) => {
  if (!manifest || !manifest.sourceId) return null;
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  return {
    ...manifest,
    assets,
    removed: normalizeRemovedList(manifest.removed),
  };
};

const buildEmptyManifest = (sourceId, sourceName = '', sourceType = '') => {
  return {
    sourceId,
    sourceName,
    sourceType,
    assets: [],
    removed: [],
  };
};

export const loadCachedAssetBlob = async (fileName) => {
  if (!fileName) return null;
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSET_STORE], 'readonly');
      const store = tx.objectStore(ASSET_STORE);
      const request = store.get(fileName);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error(`Failed to load cached asset: ${fileName}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to load cached asset', err);
    return null;
  }
};

const hasCachedAsset = async (fileName) => {
  const record = await loadCachedAssetBlob(fileName);
  return !!record?.blob;
};

export const loadCachedAssetFile = async (fileName) => {
  const record = await loadCachedAssetBlob(fileName);
  if (!record?.blob) return null;
  const type = record.blob.type || 'application/octet-stream';
  return new File([record.blob], fileName, { type });
};

export const saveCachedAssetBlob = async (fileName, blob, metadata = {}) => {
  if (!fileName || !blob) return false;
  try {
    const db = await openDatabase();
    const record = {
      fileName,
      blob,
      size: metadata.size ?? blob.size ?? null,
      type: metadata.type ?? blob.type ?? null,
      updated: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSET_STORE], 'readwrite');
      const store = tx.objectStore(ASSET_STORE);
      const request = store.put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to save cached asset: ${fileName}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to save cached asset', err);
    return false;
  }
};

export const deleteCachedAssetBlob = async (fileName) => {
  if (!fileName) return false;
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSET_STORE], 'readwrite');
      const store = tx.objectStore(ASSET_STORE);
      const request = store.delete(fileName);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to delete cached asset: ${fileName}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to delete cached asset', err);
    return false;
  }
};

export const loadCollectionManifest = async (sourceId) => {
  if (!sourceId) return null;
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MANIFEST_STORE], 'readonly');
      const store = tx.objectStore(MANIFEST_STORE);
      const request = store.get(sourceId);
      request.onsuccess = () => resolve(normalizeManifest(request.result));
      request.onerror = () => reject(new Error(`Failed to load cache manifest: ${sourceId}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to load cache manifest', err);
    return null;
  }
};

export const saveCollectionManifest = async (manifest) => {
  const normalized = normalizeManifest(manifest);
  if (!normalized) return false;
  try {
    const db = await openDatabase();
    const record = {
      ...normalized,
      updated: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MANIFEST_STORE], 'readwrite');
      const store = tx.objectStore(MANIFEST_STORE);
      const request = store.put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to save cache manifest: ${normalized.sourceId}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to save cache manifest', err);
    return false;
  }
};

export const deleteCollectionManifest = async (sourceId) => {
  if (!sourceId) return false;
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MANIFEST_STORE], 'readwrite');
      const store = tx.objectStore(MANIFEST_STORE);
      const request = store.delete(sourceId);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(new Error(`Failed to delete cache manifest: ${sourceId}`));
    });
  } catch (err) {
    console.warn('[AssetCache] Failed to delete cache manifest', err);
    return false;
  }
};

const buildManifest = (source, assets) => {
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    assets: assets.map((asset) => ({
      name: asset.name,
      path: asset.path,
      size: asset.size ?? null,
    })),
  };
};

export const getRemovedAssetNames = async (sourceId) => {
  if (!sourceId) return [];
  const manifest = await loadCollectionManifest(sourceId);
  return normalizeRemovedList(manifest?.removed);
};

export const addRemovedAssetNames = async (source, names) => {
  const sourceId = typeof source === 'string' ? source : source?.id;
  if (!sourceId) return false;
  const list = Array.isArray(names) ? names : [names];
  const nextNames = normalizeRemovedList(list);
  if (nextNames.length === 0) return false;

  const existing = await loadCollectionManifest(sourceId);
  const base = existing || buildEmptyManifest(sourceId, source?.name, source?.type);
  base.removed = normalizeRemovedList([...(base.removed || []), ...nextNames]);
  return saveCollectionManifest(base);
};

export const clearRemovedAssets = async (source) => {
  const sourceId = typeof source === 'string' ? source : source?.id;
  if (!sourceId) return false;

  const existing = await loadCollectionManifest(sourceId);
  const base = existing || buildEmptyManifest(sourceId, source?.name, source?.type);
  if (!base.removed || base.removed.length === 0) return true;
  base.removed = [];
  return saveCollectionManifest(base);
};

const filterRemovedAssets = async (sourceId, assets, options = {}) => {
  if (!Array.isArray(assets) || !sourceId) return assets || [];
  const removed = await getRemovedAssetNames(sourceId);
  if (!removed.length) return assets;
  const removedSet = new Set(removed);
  const getName = options.getName || ((asset) => asset?.name);
  return assets.filter((asset) => !removedSet.has(getName(asset)));
};

export const cacheCollectionAssets = async (source, assets, options = {}) => {
  if (!source || !Array.isArray(assets)) return { cached: 0, skipped: 0, failed: 0, total: 0 };
  const { onProgress } = options;
  const removed = await getRemovedAssetNames(source.id);
  const removedSet = new Set(removed);
  const filteredAssets = assets.filter((asset) => !removedSet.has(asset?.name));
  let cached = 0;
  let skipped = 0;
  let failed = 0;
  const total = filteredAssets.length;

  for (let i = 0; i < filteredAssets.length; i++) {
    const asset = filteredAssets[i];
    const fileName = asset?.name;
    if (!fileName) {
      failed += 1;
      if (onProgress) onProgress({ cached, skipped, failed, total });
      continue;
    }

    try {
      const existing = await loadCachedAssetBlob(fileName);
      if (existing?.blob) {
        skipped += 1;
        await saveFileSettings(fileName, { isCached: true });
        if (onProgress) onProgress({ cached, skipped, failed, total });
        continue;
      }

      const file = await source.fetchAssetFile(asset);
      if (!file) {
        failed += 1;
        if (onProgress) onProgress({ cached, skipped, failed, total });
        continue;
      }

      await saveCachedAssetBlob(fileName, file, { size: file.size, type: file.type });
      await saveFileSettings(fileName, { isCached: true });
      cached += 1;
    } catch (err) {
      console.warn('[AssetCache] Failed to cache asset', fileName, err);
      failed += 1;
    }

    if (onProgress) onProgress({ cached, skipped, failed, total });
  }

  const existingManifest = await loadCollectionManifest(source.id);
  const nextManifest = buildManifest(source, filteredAssets);
  if (existingManifest?.removed?.length) {
    nextManifest.removed = existingManifest.removed;
  }
  await saveCollectionManifest(nextManifest);
  return { cached, skipped, failed, total };
};

export const syncCollectionCache = async (source, remoteAssets) => {
  if (!source || !Array.isArray(remoteAssets) || remoteAssets.length === 0) return { cached: 0, skipped: 0, failed: 0, total: 0 };

  const manifest = await loadCollectionManifest(source.id);
  if (!manifest) return { cached: 0, skipped: 0, failed: 0, total: remoteAssets.length };

  const cachedNames = new Set((manifest.assets || []).map((asset) => asset.name));
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const asset of remoteAssets) {
    const fileName = asset?.name;
    if (!fileName) continue;

    const alreadyInManifest = cachedNames.has(fileName);
    const existing = await loadCachedAssetBlob(fileName);
    if (alreadyInManifest && existing?.blob) {
      skipped += 1;
      continue;
    }

    try {
      const file = await source.fetchAssetFile(asset);
      if (!file) {
        failed += 1;
        continue;
      }
      await saveCachedAssetBlob(fileName, file, { size: file.size, type: file.type });
      await saveFileSettings(fileName, { isCached: true });
      cached += 1;
      if (!alreadyInManifest) {
        cachedNames.add(fileName);
        manifest.assets.push({
          name: fileName,
          path: asset.path,
          size: asset.size ?? file.size ?? null,
        });
      }
    } catch (err) {
      console.warn('[AssetCache] Failed to sync cache asset', fileName, err);
      failed += 1;
    }
  }

  await saveCollectionManifest(manifest);
  return { cached, skipped, failed, total: remoteAssets.length };
};

export const clearCollectionCache = async (sourceId) => {
  const manifest = await loadCollectionManifest(sourceId);
  if (!manifest) return { removed: 0 };

  let removed = 0;
  for (const asset of manifest.assets || []) {
    const fileName = asset?.name;
    if (!fileName) continue;
    const removedOk = await deleteCachedAssetBlob(fileName);
    if (removedOk) removed += 1;
    await saveFileSettings(fileName, { isCached: false });
  }

  if (manifest?.removed?.length) {
    await saveCollectionManifest({
      ...manifest,
      assets: [],
    });
  } else {
    await deleteCollectionManifest(sourceId);
  }
  return { removed };
};

export const clearAllAssetCache = async () => {
  try {
    const db = await openDatabase();

    const cachedFileNames = await new Promise((resolve, reject) => {
      const tx = db.transaction([ASSET_STORE], 'readonly');
      const store = tx.objectStore(ASSET_STORE);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(new Error('Failed to list asset cache keys'));
    });

    const counts = await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction([ASSET_STORE], 'readonly');
        const store = tx.objectStore(ASSET_STORE);
        const request = store.count();
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => reject(new Error('Failed to count asset cache blobs'));
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction([MANIFEST_STORE], 'readonly');
        const store = tx.objectStore(MANIFEST_STORE);
        const request = store.count();
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => reject(new Error('Failed to count asset cache manifests'));
      }),
    ]);

    await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction([ASSET_STORE], 'readwrite');
        const store = tx.objectStore(ASSET_STORE);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to clear asset cache blobs'));
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction([MANIFEST_STORE], 'readwrite');
        const store = tx.objectStore(MANIFEST_STORE);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to clear asset cache manifests'));
      }),
    ]);

    for (const fileName of cachedFileNames) {
      if (!fileName) continue;
      const existingSettings = await loadFileSettings(fileName);
      if (!existingSettings) continue;
      await saveFileSettings(fileName, { isCached: false });
    }

    return {
      assetBlobsCleared: counts[0],
      manifestsCleared: counts[1],
    };
  } catch (err) {
    console.warn('[AssetCache] Failed to clear all cache data', err);
    return {
      assetBlobsCleared: 0,
      manifestsCleared: 0,
    };
  }
};