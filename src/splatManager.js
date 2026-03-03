/**
 * Splat Manager
 * Maintains a persistent THREE.Group of splats and handles preload/activation.
 * Supports both local files and storage source assets.
 */

import { scene, THREE } from "./viewer.js";
import { getFormatHandler } from "./formats/index.js";
import { loadFileSettings } from "./fileStorage.js";

let splatGroup = null;
const cache = new Map();
const loading = new Map();

const getCacheKey = (asset) => asset?.cacheKey || asset?.baseAssetId || asset?.id;

// Export cache for direct access (used during preloaded transitions)
export const getSplatCache = () => cache;

const ensureGroup = () => {
  if (!splatGroup) {
    splatGroup = new THREE.Group();
    splatGroup.name = "SplatManagerGroup";
    scene.add(splatGroup);
  }
  return splatGroup;
};

const disposeMesh = (mesh) => {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  if (typeof mesh.dispose === "function") {
    try {
      mesh.dispose();
    } catch (err) {
      console.warn("[SplatManager] Mesh dispose failed", err);
    }
  }
  if (mesh.geometry?.dispose) {
    mesh.geometry.dispose();
  }
  if (mesh.material?.dispose) {
    mesh.material.dispose();
  }
};

const disposeEntry = (entry) => {
  if (!entry) return;
  disposeMesh(entry.mesh);
};

/**
 * Ensure asset has a File object.
 * For storage source assets, loads the file lazily.
 */
const ensureAssetFile = async (asset) => {
  if (asset.file) return asset.file;
  
  // Check if this is a storage source asset
  if (asset.sourceId && asset._remoteAsset) {
    const { loadAssetFile } = await import("./storage/sourceAssetAdapter.js");
    return loadAssetFile(asset);
  }
  
  throw new Error("Asset has no file and no source");
};

const createEntry = async (asset) => {
  // Get file - may need to load from storage source
  const file = await ensureAssetFile(asset);
  if (!file) {
    const err = new Error("Missing file reference for asset");
    err.code = "MISSING_FILE";
    throw err;
  }
  
  // Update asset's file reference
  asset.file = file;

  const formatHandler = getFormatHandler(file);
  if (!formatHandler) {
    const err = new Error(`Unsupported file: ${asset.name}`);
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let cameraMetadata = null;
  try {
    cameraMetadata = await formatHandler.loadMetadata({ file, bytes });
  } catch (err) {
    console.warn(`[SplatManager] Failed to parse metadata for ${asset.name}:`, err);
  }

  // Try to load metadata from storage source
  let sourceMetadata = null;
  if (asset.sourceId && asset._remoteAsset) {
    try {
      const { loadAssetMetadata } = await import("./storage/sourceAssetAdapter.js");
      sourceMetadata = await loadAssetMetadata(asset);
    } catch (err) {
      console.warn(`[SplatManager] Failed to load source metadata for ${asset.name}:`, err);
    }
  }

  const mesh = await formatHandler.loadData({ file, bytes });
  mesh.visible = false;
  mesh.userData.assetId = getCacheKey(asset);
  ensureGroup().add(mesh);

  let storedSettings = null;
  try {
    storedSettings = await loadFileSettings(asset.name);
  } catch (err) {
    console.warn(`[SplatManager] Failed to read stored settings for ${asset.name}:`, err);
  }

  // Merge source metadata with stored settings (source takes precedence for camera)
  if (sourceMetadata) {
    if (sourceMetadata.camera && !cameraMetadata) {
      cameraMetadata = sourceMetadata.camera;
    }
    if (!storedSettings) {
      storedSettings = {};
    }
    if (sourceMetadata.animation && !storedSettings.animation) {
      storedSettings.animation = sourceMetadata.animation;
    }
    if (sourceMetadata.customAnimation && !storedSettings.customAnimation) {
      storedSettings.customAnimation = sourceMetadata.customAnimation;
    }
    if (typeof sourceMetadata.annotation === 'string' && storedSettings.annotation === undefined) {
      storedSettings.annotation = sourceMetadata.annotation;
    }
    if (sourceMetadata.focusDistance !== undefined && storedSettings.focusDistance === undefined) {
      storedSettings.focusDistance = sourceMetadata.focusDistance;
    }
  }

  return {
    id: getCacheKey(asset),
    asset,
    mesh,
    cameraMetadata: cameraMetadata ?? null,
    formatLabel: formatHandler.label,
    storedSettings,
    focusDistanceOverride: storedSettings?.focusDistance,
  };
};

export const isSplatCached = (asset) => {
  const cacheKey = getCacheKey(asset);
  if (!cacheKey) return false;
  return cache.has(cacheKey);
};

export const ensureSplatEntry = async (asset) => {
  const cacheKey = getCacheKey(asset);
  if (!cacheKey) return null;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  if (loading.has(cacheKey)) return loading.get(cacheKey);

  const promise = createEntry(asset)
    .then((entry) => {
      cache.set(cacheKey, entry);
      loading.delete(cacheKey);
      return entry;
    })
    .catch((err) => {
      loading.delete(cacheKey);
      throw err;
    });

  loading.set(cacheKey, promise);
  return promise;
};

export const updateFocusDistanceInCache = (assetId, focusDistance) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (!entry.storedSettings) {
    entry.storedSettings = {};
  }
  entry.storedSettings.focusDistance = focusDistance;
  entry.focusDistanceOverride = focusDistance;
};

export const clearFocusDistanceInCache = (assetId) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (entry.storedSettings && entry.storedSettings.focusDistance !== undefined) {
    delete entry.storedSettings.focusDistance;
  }
  entry.focusDistanceOverride = undefined;
};

export const updateCustomAnimationInCache = (assetId, customAnimation) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (!entry.storedSettings) {
    entry.storedSettings = {};
  }
  entry.storedSettings.customAnimation = {
    ...(entry.storedSettings.customAnimation || {}),
    ...(customAnimation || {}),
  };
};

export const clearCustomAnimationInCache = (assetId) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (entry.storedSettings && entry.storedSettings.customAnimation !== undefined) {
    delete entry.storedSettings.customAnimation;
  }
};

export const updateViewCustomAnimationInCache = (assetId, viewId, customAnimation) => {
  if (!assetId || !viewId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (!entry.storedSettings) entry.storedSettings = {};
  if (!entry.storedSettings.viewCustomAnimations) entry.storedSettings.viewCustomAnimations = {};
  if (customAnimation && Object.keys(customAnimation).length > 0) {
    entry.storedSettings.viewCustomAnimations[viewId] = {
      ...(entry.storedSettings.viewCustomAnimations[viewId] || {}),
      ...customAnimation,
    };
  } else {
    delete entry.storedSettings.viewCustomAnimations[viewId];
  }
};

export const clearViewCustomAnimationInCache = (assetId, viewId) => {
  if (!assetId || !viewId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry?.storedSettings?.viewCustomAnimations) return;
  delete entry.storedSettings.viewCustomAnimations[viewId];
};

export const updateAnnotationInCache = (assetId, annotation) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (!entry.storedSettings) {
    entry.storedSettings = {};
  }
  entry.storedSettings.annotation = typeof annotation === 'string' ? annotation : '';
};

const clearAnnotationInCache = (assetId) => {
  if (!assetId || !cache.has(assetId)) return;
  const entry = cache.get(assetId);
  if (!entry) return;
  if (entry.storedSettings && entry.storedSettings.annotation !== undefined) {
    delete entry.storedSettings.annotation;
  }
};

export const activateSplatEntry = async (asset) => {
  const entry = await ensureSplatEntry(asset);
  if (!entry) return null;
  const cacheKey = getCacheKey(asset);

  // Only toggle visibility - DO NOT reset transforms!
  // The mesh has CV-to-Three axis flip applied via applyMatrix4()
  // which modifies position/rotation/scale. Resetting them corrupts the view.
  cache.forEach((cached, id) => {
    cached.mesh.visible = id === cacheKey;
  });

  return entry;
};

export const retainOnlySplats = (assetIds) => {
  if (!assetIds || assetIds.size === 0) {
    resetSplatManager();
    return;
  }

  cache.forEach((entry, id) => {
    if (!assetIds.has(id)) {
      disposeEntry(entry);
      cache.delete(id);
    }
  });
};

export const resetSplatManager = () => {
  cache.forEach(disposeEntry);
  cache.clear();
  loading.clear();
  if (splatGroup) {
    splatGroup.clear();
    if (!scene.children.includes(splatGroup)) {
      scene.add(splatGroup);
    }
  }
};