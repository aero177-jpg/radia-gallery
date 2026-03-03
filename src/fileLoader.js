/**
  * File loader module.
 * Handles file loading, drag/drop, format detection, and asset management.
 * Works with Zustand store for state updates and Preact components for UI.
 */

import { getSupportedExtensions } from "./formats/index.js";
import { useStore } from "./store.js";
import {
  scene,
  renderer,
  composer,
  camera,
  controls,
  spark,
  currentMesh,
  setCurrentMesh,
  setOriginalImageAspect,
  requestRender,
  updateDollyZoomBaselineFromCamera,
  THREE,
} from "./viewer.js";
import { applyPreviewBackground, crossFadePreviewBackground, fadeOutBackground, captureAndApplyBackground, clearBackground, hasBackgroundForPreview } from "./backgroundManager.js";
import { savePreviewBlob, listCachedFileNames } from "./fileStorage.js";
import {
  fitViewToMesh,
  applyMetadataCamera,
  clearMetadataCamera,
  saveHomeView,
  applyFocusDistanceOverride,
  animateCameraMutation,
} from "./cameraUtils.js";
import {
  loadCustomMetadataForAsset,
  applyCustomModelTransform,
  applyCameraPose,
  applyFullOrbitConstraints,
  restoreOrbitConstraints,
} from "./customMetadata.js";
import {
  slideOutAnimation,
  slideInAnimation,
  cancelContinuousZoomAnimation,
  cancelContinuousDollyZoomAnimation,
  cancelContinuousOrbitAnimation,
  cancelContinuousVerticalOrbitAnimation,
  clearContinuousHandoff,
} from "./cameraAnimations.js";
import { resolveSlideInOptions, resolveSlideOutOptions } from "./slideConfig.js";
import { resetSlideshowTimer, restartContinuousIfPlaying } from "./slideshowController.js";
import { isImmersiveModeActive, pauseImmersiveMode, resumeImmersiveMode } from "./immersiveMode.js";
import { applyIntrinsicsAspect, updateViewerAspectRatio, resize } from "./layout.js";
import { cleanupSlideTransitionState } from "./transitionUtils.js";
import { hydrateAssetPreviewFromStorage, replacePreviewUrl, formatBytes } from "./previewManager.js";

// Re-export layout helpers for existing callers
export { updateViewerAspectRatio, resize } from "./layout.js";

/** Navigation lock to prevent concurrent asset loads */
let isNavigationLocked = false;

export const isNavigationLockedRef = () => isNavigationLocked;
export const setNavigationLocked = (locked) => {
  isNavigationLocked = locked;
};

/** Track if this is the very first asset load (no previous mesh) */
let hasLoadedFirstAsset = false;

import {
  setAssetList as setAssetListManager,
  getAssetList,
  getCurrentAssetIndex,
  setCurrentAssetIndex as setCurrentAssetIndexManager,
  getAssetByIndex,
  onPreviewGenerated,
  hasMultipleAssets,
  getAssetCount,
  nextAsset,
  prevAsset,
  captureCurrentAssetPreview,
  addAssets,
} from "./assetManager.js";
import {
  activateSplatEntry,
  ensureSplatEntry,
  retainOnlySplats,
  resetSplatManager,
  isSplatCached,
  getSplatCache,
} from "./splatManager.js";

/** Debug: ?nofade disables the opacity fade between slides */
const noFade = new URLSearchParams(window.location.search).has('nofade');

/** Warmup frames for renderer stabilization (fresh load) */
const WARMUP_FRAMES = 120;

/** Reduced warmup frames for preloaded/cached splats */
const WARMUP_FRAMES_CACHED = 15;

/** Frame at which to capture background */
const BG_CAPTURE_FRAME = 90;

/** Frame at which to capture preview thumbnail */
const PREVIEW_CAPTURE_FRAME = 60;

/** Frame at which to capture for cached splats */
const PREVIEW_CAPTURE_FRAME_CACHED = 10;

/** Debug helper: force camera far out to inspect backgrounds */
let debugForceZoomOut = false; // toggled via DebugSettings
const DEBUG_ZOOM_MULTIPLIER = 6; // how much farther to push camera back

/** Accesses Zustand store state */
const getStoreState = () => useStore.getState();

/** Supported file extensions for display */
const supportedExtensions = getSupportedExtensions();
const supportedExtensionsText = supportedExtensions.join(", ");

const VALID_FILE_SLIDE_TYPES = new Set(['horizontal', 'vertical', 'zoom', 'fade', 'default']);
const VALID_TRANSITION_RANGE_KEYS = new Set(['small', 'medium', 'large', 'default']);
const NON_CONTINUOUS_RANGE_MULTIPLIER_BY_KEY = {
  small: 0.75,
  medium: 1,
  large: 1.25,
};
const DEFAULT_FILE_CUSTOM_ANIMATION = {
  slideType: 'default',
  transitionRange: 'default',
  zoomProfile: 'default',
  dollyZoom: false,
};
const DEFAULT_FILE_ANNOTATION = '';

export const normalizeFileCustomAnimationSettings = (customAnimationSettings) => {
  const slideType = VALID_FILE_SLIDE_TYPES.has(customAnimationSettings?.slideType)
    ? customAnimationSettings.slideType
    : 'default';
  const transitionRange = VALID_TRANSITION_RANGE_KEYS.has(customAnimationSettings?.transitionRange)
    ? customAnimationSettings.transitionRange
    : 'default';
  const zoomProfile = typeof customAnimationSettings?.zoomProfile === 'string'
    ? customAnimationSettings.zoomProfile
    : 'default';
  const dollyZoom = customAnimationSettings?.dollyZoom === true;

  return {
    slideType,
    transitionRange,
    zoomProfile,
    dollyZoom,
  };
};

export const normalizeFileAnnotation = (annotation) => {
  return typeof annotation === 'string' ? annotation : '';
};

const resolvePerFileSlideType = (store, customAnimationSettings) => {
  const normalized = normalizeFileCustomAnimationSettings(customAnimationSettings);
  if (normalized.slideType !== 'default') {
    return normalized.slideType;
  }
  return store.slideMode ?? 'horizontal';
};

const applyTransitionRangeToAmount = (mode, amount, transitionRangeKey) => {
  if (!Number.isFinite(amount)) return amount;
  if (mode === 'fade' || mode?.startsWith('continuous-')) return amount;
  const multiplier = NON_CONTINUOUS_RANGE_MULTIPLIER_BY_KEY[transitionRangeKey];
  if (!Number.isFinite(multiplier)) return amount;
  return amount * multiplier;
};

const resolveSlideAmountWithPerFileRange = (mode, preset, transitionRangeKey, phase = 'in') => {
  if (transitionRangeKey === 'default') return undefined;
  const options = phase === 'out'
    ? resolveSlideOutOptions(mode, { preset })
    : resolveSlideInOptions(mode, { preset });
  const amount = applyTransitionRangeToAmount(mode, options.amount, transitionRangeKey);
  return Number.isFinite(amount) ? amount : undefined;
};

const isFile = (value) => typeof File !== "undefined" && value instanceof File;

const makeAdHocAssetId = (file) =>
  `adhoc-${file?.name ?? "asset"}-${file?.size ?? 0}-${file?.lastModified ?? Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

const normalizeAssetCandidate = (candidate) => {
  if (!candidate) return null;
  if (candidate.file && isFile(candidate.file)) {
    if (!candidate.id) {
      candidate.id = makeAdHocAssetId(candidate.file);
    }
    if (!candidate.name) {
      candidate.name = candidate.file.name ?? "Untitled";
    }
    return candidate;
  }
  // Storage source asset - file will be loaded lazily
  if (candidate.sourceId && candidate._remoteAsset) {
    if (!candidate.id) {
      candidate.id = `source-${candidate.sourceId}-${Date.now()}`;
    }
    return candidate;
  }
  if (isFile(candidate)) {
    return {
      id: makeAdHocAssetId(candidate),
      file: candidate,
      name: candidate.name ?? "Untitled",
      preview: null,
      previewSource: null,
      loaded: false,
    };
  }
  return null;
};

const getBaseAssetId = (asset) => asset?.baseAssetId || asset?.id;
export { getBaseAssetId };
const getBaseAssetName = (asset) => asset?.baseAssetName || asset?.name;
const isProxyViewAsset = (asset) => Boolean(asset?.isProxyView && asset?.baseAssetId && asset?.viewId);
const makeProxyAssetId = (baseAssetId, viewId) => `${baseAssetId}::view::${viewId}`;
const makePreviewStorageKey = (assetName, viewId) => `${assetName}::${viewId}`;

const getViewDisplayName = (assetName, view, order) => {
  const viewName = typeof view?.name === 'string' && view.name.trim() ? view.name.trim() : `View ${order + 1}`;
  return `${assetName} · ${viewName}`;
};

const aspectRatioToKey = (ratio) => {
  if (!ratio || ratio === null) return 'full';
  const tolerance = 0.01;
  if (Math.abs(ratio - 1) < tolerance) return '1:1';
  if (Math.abs(ratio - 16 / 9) < tolerance) return '16:9';
  if (Math.abs(ratio - 9 / 16) < tolerance) return '9:16';
  if (Math.abs(ratio - 4 / 3) < tolerance) return '4:3';
  if (Math.abs(ratio - 3 / 4) < tolerance) return '3:4';
  return 'full';
};

const buildProxyViewAsset = (baseAsset, view, order) => {
  const baseId = getBaseAssetId(baseAsset);
  const baseName = getBaseAssetName(baseAsset);
  return {
    ...baseAsset,
    id: makeProxyAssetId(baseId, view.id),
    isProxyView: true,
    baseAssetId: baseId,
    baseAssetName: baseName,
    viewId: view.id,
    groupOrder: order,
    displayName: getViewDisplayName(baseName, view, order),
    previewStorageKey: makePreviewStorageKey(baseName, view.id),
    cacheKey: baseId,
    loaded: false,
    // Clear inherited preview so hydrateAssetPreviewFromStorage can load the
    // correct per-view preview from IndexedDB instead of reusing the base's.
    preview: null,
    previewSource: null,
    previewMeta: null,
  };
};

const ensureBaseAssetViewFields = (asset, view, order = 0) => {
  if (!asset) return;
  const baseName = getBaseAssetName(asset);
  asset.isProxyView = false;
  asset.baseAssetId = getBaseAssetId(asset);
  asset.baseAssetName = baseName;
  asset.viewId = view?.id || null;
  asset.groupOrder = order;
  asset.displayName = view
    ? getViewDisplayName(baseName, view, order)
    : baseName;
  asset.previewStorageKey = view?.id
    ? makePreviewStorageKey(baseName, view.id)
    : baseName;
  asset.cacheKey = asset.baseAssetId;
};

const findBaseAssetIndex = (assets, baseAssetId) => assets.findIndex(
  (item) => !item?.isProxyView && getBaseAssetId(item) === baseAssetId,
);

const removeProxyViewsForBase = (assets, baseAssetId) => {
  for (let i = assets.length - 1; i >= 0; i--) {
    const item = assets[i];
    if (item?.isProxyView && item.baseAssetId === baseAssetId) {
      assets.splice(i, 1);
    }
  }
};

const syncAssetProxyViews = async ({ store, currentAsset, views }) => {
  if (!store || !currentAsset) return;
  const assets = getAssetList();
  if (!assets?.length) return;

  const baseAssetId = getBaseAssetId(currentAsset);
  const baseIndex = findBaseAssetIndex(assets, baseAssetId);
  if (baseIndex < 0) return;

  const baseAsset = assets[baseIndex];
  const normalizedViews = Array.isArray(views) ? views : [];

  // Fast-path: if proxy views already match the expected view IDs, skip the
  // expensive destroy-and-rebuild cycle that re-fetches all previews from
  // IndexedDB on every view navigation.
  const existingProxies = assets.filter(
    (a) => a?.isProxyView && a.baseAssetId === baseAssetId,
  );
  const expectedProxyViewIds = normalizedViews.slice(1).map((v) => v.id);
  const proxiesMatch =
    existingProxies.length === expectedProxyViewIds.length &&
    existingProxies.every((p, i) => p.viewId === expectedProxyViewIds[i]);

  if (proxiesMatch) {
    // Ensure base asset view fields are up to date (cheap, no async)
    const firstView = normalizedViews[0] || null;
    ensureBaseAssetViewFields(baseAsset, firstView, 0);
    return;
  }

  removeProxyViewsForBase(assets, baseAssetId);

  const firstView = normalizedViews[0] || null;
  const prevKey = baseAsset.previewStorageKey;
  ensureBaseAssetViewFields(baseAsset, firstView, 0);

  // Re-hydrate base asset preview if the storage key changed (e.g. from raw
  // filename to a view-specific key after metadata was loaded).
  if (baseAsset.previewStorageKey && baseAsset.previewStorageKey !== prevKey) {
    const oldPreview = baseAsset.preview;
    baseAsset.preview = null; // clear so hydrateAssetPreviewFromStorage can run
    const hydrated = await hydrateAssetPreviewFromStorage(baseAsset);
    if (!hydrated && oldPreview) {
      baseAsset.preview = oldPreview; // keep fallback if nothing found
    }
  }

  const proxyAssets = normalizedViews
    .slice(1)
    .map((view, idx) => buildProxyViewAsset(baseAsset, view, idx + 1));

  for (const proxy of proxyAssets) {
    // eslint-disable-next-line no-await-in-loop
    await hydrateAssetPreviewFromStorage(proxy);
  }

  if (proxyAssets.length > 0) {
    assets.splice(baseIndex + 1, 0, ...proxyAssets);
  }

  store.setAssets([...assets]);
};

const syncProxyViewsForAssetList = async (store, { onlyBaseIds } = {}) => {
  if (!store) return;

  const baseIdFilter = Array.isArray(onlyBaseIds) && onlyBaseIds.length > 0
    ? new Set(onlyBaseIds)
    : null;

  const baseAssets = getAssetList().filter((asset) => !asset?.isProxyView);

  for (const asset of baseAssets) {
    const baseAssetId = getBaseAssetId(asset);
    if (baseIdFilter && !baseIdFilter.has(baseAssetId)) continue;

    const assetName = getBaseAssetName(asset);
    if (!assetName) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      const metadata = await loadCustomMetadataForAsset(assetName);
      const views = metadata?.views ?? [];
      if (!views.length) continue;
      // eslint-disable-next-line no-await-in-loop
      await syncAssetProxyViews({ store, currentAsset: asset, views });
    } catch (err) {
      console.warn(`[FileLoader] Failed to sync proxy views for ${assetName}:`, err);
    }
  }
};

const resolveAssetView = async (asset) => {
  const assetName = getBaseAssetName(asset);
  if (!assetName) return { metadata: null, views: [], selectedView: null };
  const metadata = await loadCustomMetadataForAsset(assetName);
  const views = metadata?.views ?? [];
  let selectedView = null;
  if (views.length > 0) {
    if (asset?.isProxyView && asset?.viewId) {
      selectedView = views.find((view) => view.id === asset.viewId) || null;
    } else {
      // Base asset should always represent the first saved custom view.
      selectedView = views[0] || null;
    }

    if (!selectedView) {
      selectedView = views.find((view) => view.id === metadata?.activeViewId) || views[0];
    }
  }

  return { metadata, views, selectedView };
};

const getSlideModeForStore = (store, { slideDirection, customAnimationSettings } = {}) => {
  const immersiveActive = isImmersiveModeActive();
  const forceFadeForNonSequential = !slideDirection;
  const normalizedCustomAnimation = normalizeFileCustomAnimationSettings(customAnimationSettings);
  const baseSlideMode = resolvePerFileSlideType(store, normalizedCustomAnimation);
  const perFileDollyZoom = normalizedCustomAnimation.dollyZoom;
  const shouldUseContinuous = store.slideshowPlaying && store.slideshowContinuousMode && baseSlideMode !== 'fade';
  const resolvedSlideMode = shouldUseContinuous
    ? (baseSlideMode === 'horizontal'
      ? 'continuous-orbit'
      : baseSlideMode === 'vertical'
        ? 'continuous-orbit-vertical'
        : baseSlideMode === 'zoom'
          ? (perFileDollyZoom ? 'continuous-dolly-zoom' : 'continuous-zoom')
          : baseSlideMode)
    : (baseSlideMode === 'zoom' && perFileDollyZoom)
      ? 'dolly-zoom'
      : baseSlideMode;

  return {
    immersiveActive,
    baseSlideMode,
    transitionRange: normalizedCustomAnimation.transitionRange,
    slideMode: forceFadeForNonSequential ? 'fade' : resolvedSlideMode,
  };
};

const collectNeighborAssets = (assets, centerIndex) => {
  if (!assets || assets.length === 0) return [];
  const n = assets.length;
  const indices = [];

  if (centerIndex >= 0 && centerIndex < n) {
    // Use circular indices so neighbors wrap around the list (important for seamless looping)
    const prev = (centerIndex - 1 + n) % n;
    const next = (centerIndex + 1) % n;
    indices.push(centerIndex, prev, next);
  } else {
    indices.push(0);
  }

  const seen = new Set();
  const results = [];
  for (const idx of indices) {
    const asset = assets[idx];
    const cacheKey = asset?.cacheKey || getBaseAssetId(asset) || asset?.id;
    if (!asset || seen.has(cacheKey)) continue;
    seen.add(cacheKey);
    results.push(asset);
  }
  return results;
};

const syncStoredAnimationSettings = async (animationSettings, wasImmersiveModeActive, store) => {
  if (!animationSettings) return;
  const { enabled, intensity, direction } = animationSettings;
  store.setAnimationEnabled(enabled);
  store.setAnimationIntensity(intensity);
  store.setAnimationDirection(direction);

  if (wasImmersiveModeActive) return;

  try {
    const {
      setLoadAnimationEnabled,
      setLoadAnimationIntensity,
      setLoadAnimationDirection,
    } = await import("./customAnimations.js");
    setLoadAnimationEnabled(enabled);
    setLoadAnimationIntensity(intensity);
    setLoadAnimationDirection(direction);
  } catch (err) {
    console.warn("Failed to sync animation module", err);
  }
};

/**
 * Resolves the effective custom animation for an asset, checking per-view
 * overrides first, then falling back to the base file's custom animation.
 * @param {Object} storedSettings - The file's storedSettings from the splat cache
 * @param {Object} asset - The current asset (may have a viewId for proxy views)
 * @returns {Object|null}
 */
const resolveEffectiveCustomAnimation = (storedSettings, asset) => {
  const viewId = asset?.viewId;
  if (viewId && storedSettings?.viewCustomAnimations?.[viewId]) {
    return storedSettings.viewCustomAnimations[viewId];
  }
  return storedSettings?.customAnimation ?? null;
};

const syncStoredCustomAnimationSettings = (customAnimationSettings, store) => {
  const normalized = normalizeFileCustomAnimationSettings(customAnimationSettings);
  store.setFileCustomAnimation({
    ...DEFAULT_FILE_CUSTOM_ANIMATION,
    ...normalized,
  });
};

const syncStoredAnnotation = (annotation, store) => {
  const normalized = normalizeFileAnnotation(annotation);
  store.setAnnotation(typeof normalized === 'string' ? normalized : DEFAULT_FILE_ANNOTATION);
};

const refreshSparkForCurrentView = (reason = 'unspecified') => {
  if (!spark?.update) return;

  const viewToWorld = camera?.matrixWorld?.clone?.();
  if (viewToWorld) {
    spark.update({ scene, viewToWorld });
  } else {
    spark.update({ scene });
  }
};


const applyDebugZoomOut = () => {
  if (!debugForceZoomOut) return;
  if (!camera || !controls) return;
  const dir = camera.position.clone().sub(controls.target);
  const dist = dir.length();
  if (dist <= 0) return;
  dir.normalize().multiplyScalar(dist * DEBUG_ZOOM_MULTIPLIER);
  camera.position.copy(controls.target.clone().add(dir));
  camera.updateProjectionMatrix();
  requestRender();
};

/** Enable or disable debug zoom-out mode */
const setDebugForceZoomOut = (enabled) => {
  debugForceZoomOut = Boolean(enabled);
};

/**
 * Loads and displays a 3DGS splat file.
 * Handles format detection, camera metadata parsing, mesh creation,
 * and post-load effects (animation, preview capture, background).
 * 
 * @param {Object|File} assetOrFile - Asset descriptor or File object to load
 * @param {Object} options - Load options
 * @param {string} options.slideDirection - 'next' or 'prev' for slide transition
 * @param {Object} [options.outgoingCustomAnimationSettings] - Optional per-file overrides for the outgoing/current slide
 */
export const loadSplatFile = async (assetOrFile, options = {}) => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl) return;

  const asset = normalizeAssetCandidate(assetOrFile);
  // Allow assets with file OR storage source (file loaded lazily)
  if (!asset) return;
  const hasFileOrSource = asset.file || (asset.sourceId && asset._remoteAsset);
  if (!hasFileOrSource) return;

  await hydrateAssetPreviewFromStorage(asset);

  // Cancel any in-flight slide transitions before starting a new load
  // This prevents race conditions where previous animation state corrupts the new load
  cleanupSlideTransitionState();

  const store = getStoreState();
  const { slideDirection, outgoingCustomAnimationSettings } = options;
  const forceFadeForNonSequential = !slideDirection;
  const isFirstLoad = !hasLoadedFirstAsset; // Detect first asset load before any mesh exists
  const wasAlreadyCached = isSplatCached(asset);
  const activeCacheKey = asset.cacheKey || getBaseAssetId(asset) || asset.id;
  const incomingCustomAnimation = resolveEffectiveCustomAnimation(
    getSplatCache().get(activeCacheKey)?.storedSettings,
    asset,
  );
  const outgoingCustomAnimation = outgoingCustomAnimationSettings ?? store.fileCustomAnimation;
  const {
    immersiveActive,
    slideMode: outgoingSlideMode,
    transitionRange: outgoingTransitionRange,
  } = getSlideModeForStore(store, { slideDirection, customAnimationSettings: outgoingCustomAnimation });

  // For first load, immediately hide content to prevent flash before fade-in
  // This must happen BEFORE any async work that might cause a render
  // Skip when initial-collection-empty is already keeping the viewer hidden
  // (that class removal will be the sole fade-in for direct URL loads)
  const initialCollectionHidden = viewerEl.classList.contains('initial-collection-empty');
  if (isFirstLoad && !noFade && !initialCollectionHidden) {
    viewerEl.classList.add('slide-out');
  }

  // Preload entry early (reused later to avoid duplicate loads)
  const entryPromise = ensureSplatEntry(asset);
  let aspectApplied = false;
  
  // For transitions (slides or random asset clicks), start fade/slide-out and entry prep in parallel
  const transitionDirection = slideDirection ?? 'next';
  const shouldRunTransition = currentMesh && (slideDirection || forceFadeForNonSequential);
  let preloadedEntry = null;
  if (shouldRunTransition) {
    const slideOutAmount = resolveSlideAmountWithPerFileRange(
      outgoingSlideMode,
      'transition',
      outgoingTransitionRange,
      'out',
    );
    const slideOutPromise = slideOutAnimation(transitionDirection, {
      mode: outgoingSlideMode,
      preset: 'transition',
      amount: slideOutAmount,
    });
    const prepPromise = entryPromise.catch((err) => {
      console.warn('Failed to preload during transition:', err);
      return null;
    });
    const [, entry] = await Promise.all([slideOutPromise, prepPromise]);
    if (entry) {
      applyIntrinsicsAspect(entry);
      aspectApplied = true;
    }
    preloadedEntry = entry;
  }
  
  store.setFileInfo({ name: asset.name });

  const wasImmersiveModeActive = immersiveActive;
  if (wasImmersiveModeActive) {
    pauseImmersiveMode();
  }

  const start = performance.now();

  try {
    // Only clear background if not cached (avoid flash)
    if (!wasAlreadyCached && !asset.preview) {
      clearBackground();
      const pageEl = document.querySelector(".page");
      if (pageEl) {
        pageEl.classList.remove("has-glow");
      }
    }

    // Only show loading overlay for non-cached loads
    if (!wasAlreadyCached) {
      viewerEl.classList.add("loading");
      store.setIsLoading(true);
      store.setStatus("Preparing splat...");
    }

    const assetList = getAssetList();
    const assetIndex = assetList.findIndex((a) => a.id === asset.id);
    const neighborAssets = assetIndex >= 0
      ? collectNeighborAssets(assetList, assetIndex)
      : [asset];

    let entry = preloadedEntry; // Use preloaded if available
    if (!entry) {
      try {
        entry = await entryPromise;
        // Toggle visibility now that the entry is loaded
        if (entry) {
          if (!aspectApplied) {
            applyIntrinsicsAspect(entry);
            aspectApplied = true;
          }
          const cache = getSplatCache();
          cache.forEach((cached, id) => {
            cached.mesh.visible = id === activeCacheKey;
          });
          requestRender();
        }
      } catch (error) {
        if (error?.code === "UNSUPPORTED_FORMAT") {
          store.setStatus(`Only ${supportedExtensionsText} 3DGS files are supported`);
          viewerEl.classList.remove("loading");
          store.setIsLoading(false);
          if (wasImmersiveModeActive) {
            resumeImmersiveMode();
          }
          return;
        }
        throw error;
      }
    } else {
      // Activate the preloaded entry
      const cache = getSplatCache();
      cache.forEach((cached, id) => {
        cached.mesh.visible = id === activeCacheKey;
      });
      requestRender(); // Immediately render the new mesh
    }

    if (!entry) {
      throw new Error("Unable to activate splat entry");
    }

    setCurrentMesh(entry.mesh);
    viewerEl.classList.add("has-mesh");
    spark?.update?.({ scene });

    // Fire-and-forget neighbor preloading (don't block current asset)
    const neighborIds = new Set(neighborAssets.map((neighbor) => neighbor.cacheKey || getBaseAssetId(neighbor) || neighbor.id));
    retainOnlySplats(neighborIds);
    
    // Preload neighbors in background without awaiting
    neighborAssets
      .filter((neighbor) => (neighbor.cacheKey || getBaseAssetId(neighbor) || neighbor.id) !== activeCacheKey)
      .forEach((neighbor) => {
        ensureSplatEntry(neighbor)
          .then(() => spark?.update?.({ scene }))
          .catch((err) => {
            console.warn(`[SplatManager] Failed to preload ${neighbor.name}:`, err);
          });
      });

    const { cameraMetadata, storedSettings, focusDistanceOverride, formatLabel } = entry;
    const { views: customViews, selectedView } = await resolveAssetView(asset);
    const hasCustomMetadata = Boolean(selectedView?.cameraPose);

    if (!cameraMetadata?.intrinsics) {
      await syncAssetProxyViews({
        store,
        currentAsset: asset,
        views: customViews,
      });
    }

    // For non-ML Sharp splats, always apply CV→GL coordinate flip
    // This is the same transform ML Sharp files get automatically
    const shouldApplyFlip = !cameraMetadata?.intrinsics;
    const modelOverrides = {
      applyCoordinateFlip: shouldApplyFlip,
      modelScale: selectedView?.model?.modelScale ?? 1,
    };

    if (shouldApplyFlip || hasCustomMetadata) {
      applyCustomModelTransform(entry.mesh, modelOverrides);
    }

    store.setCustomModelScale(modelOverrides.modelScale);

    const metadataMissing = !cameraMetadata?.intrinsics && customViews.length === 0;
    store.setMetadataMissing(metadataMissing);
    store.setCustomMetadataAvailable(customViews.length > 0);
    // Only change controls visibility when opening (metadata missing) or when
    // the editor isn't already open (avoids flash during save-as-new-view).
    if (metadataMissing || !store.customMetadataControlsVisible) {
      store.setCustomMetadataControlsVisible(metadataMissing);
    }

    // Auto-open side panel when metadata is missing so user sees the editor
    if (metadataMissing) {
      setTimeout(() => {
        const s = getStoreState();
        s.setCameraSettingsExpanded(true);
        s.setPanelOpen(true);
      }, 500);
    }

    const shouldDisableOrbitLimits = metadataMissing || hasCustomMetadata || store.slideshowPlaying;
    if (shouldDisableOrbitLimits) {
      applyFullOrbitConstraints();
    } else {
      restoreOrbitConstraints(store.cameraRange);
    }

    const applyCameraForAsset = () => {
      if (hasCustomMetadata && selectedView?.cameraPose) {
        applyCameraPose(selectedView.cameraPose);
      } else if (cameraMetadata) {
        applyMetadataCamera(entry.mesh, cameraMetadata, resize);
      } else {
        fitViewToMesh(entry.mesh);
      }
    };

    if (storedSettings) {
      store.addLog(`Found stored settings for ${asset.name}`);
    }

    const effectiveCustomAnimation = resolveEffectiveCustomAnimation(storedSettings, asset);

    await syncStoredAnimationSettings(
      storedSettings?.animation,
      wasImmersiveModeActive,
      store,
    );
    syncStoredCustomAnimationSettings(
      effectiveCustomAnimation,
      store,
    );
    syncStoredAnnotation(
      storedSettings?.annotation,
      store,
    );

    const {
      slideMode: resolvedSlideMode,
      transitionRange: resolvedTransitionRange,
    } = getSlideModeForStore(store, {
      slideDirection,
      customAnimationSettings: effectiveCustomAnimation,
    });

    if (focusDistanceOverride !== undefined) {
      store.setHasCustomFocus(true);
      store.setFocusDistanceOverride(focusDistanceOverride);
      store.addLog(`Found focus distance override: ${focusDistanceOverride.toFixed(2)} units`);
    } else {
      store.setHasCustomFocus(false);
      store.setFocusDistanceOverride(null);
    }

    // Extract custom aspect ratio from metadata (for non-ML Sharp assets)
    const customAspectRatio = selectedView?.view?.aspectRatio;
    const shouldHardCutCustomViewAspect = !isFirstLoad && !cameraMetadata?.intrinsics && Boolean(selectedView?.cameraPose);

    if (cameraMetadata?.intrinsics) {
      const { intrinsics } = cameraMetadata;
      const aspect = intrinsics.imageWidth / intrinsics.imageHeight;
      setOriginalImageAspect(aspect);
      // console.log(`[Aspect] ${asset.name}: ${aspect.toFixed(4)} (${intrinsics.imageWidth}x${intrinsics.imageHeight})`);
      store.addLog(
        `${formatLabel ?? "3DGS"} camera: fx=${intrinsics.fx.toFixed(1)}, fy=${intrinsics.fy.toFixed(1)}, ` +
          `cx=${intrinsics.cx.toFixed(1)}, cy=${intrinsics.cy.toFixed(1)}, ` +
          `img=${intrinsics.imageWidth}x${intrinsics.imageHeight}`,
      );
    } else if (customAspectRatio && customAspectRatio > 0) {
      // Apply custom aspect ratio from saved metadata
      setOriginalImageAspect(customAspectRatio);
      console.log(`[Aspect] ${asset.name}: custom override ${customAspectRatio.toFixed(4)}`);

      store.setCustomAspectRatio(aspectRatioToKey(customAspectRatio));
    } else {
      setOriginalImageAspect(null);
      store.setCustomAspectRatio('full');
    }

    // slide-out class was already added at the start of loadSplatFile for first load

    if (shouldHardCutCustomViewAspect) {
      applyInstantProxyAspectCutAndReset('load-custom-base-view');
    } else {
      // Resize immediately (viewer size transitions are disabled)
      updateViewerAspectRatio();
      resize();
      requestRender();
      if (isFirstLoad) hasLoadedFirstAsset = true;
    }

    clearMetadataCamera(resize);

    // Stop any in-progress continuous zoom before applying new camera settings
    cancelContinuousZoomAnimation();
    cancelContinuousDollyZoomAnimation();
    cancelContinuousOrbitAnimation();
    cancelContinuousVerticalOrbitAnimation();

    // For slide transitions on cached splats, apply camera instantly then slide in
    // Otherwise use the smooth camera mutation animation
    if (slideDirection && wasAlreadyCached) {
      // Apply camera settings instantly
      applyCameraForAsset();

      if (focusDistanceOverride !== undefined) {
        applyFocusDistanceOverride(focusDistanceOverride);
        store.addLog(`Applied focus distance override: ${focusDistanceOverride.toFixed(2)} units`);
      }

      try {
        store.setFov(camera.fov);
      } catch (err) {
        console.warn('Failed to set store FOV from camera:', err);
      }

      saveHomeView();
      applyDebugZoomOut();

      if (hasCustomMetadata && !cameraMetadata?.intrinsics) {
        refreshSparkForCurrentView('post-camera-cached-custom-view');
      }
      
      // Apply background BEFORE slideIn so it fades in sync with canvas
      if (asset.preview) {
        applyPreviewBackground(asset.preview);
      }
      
      // Slide in from the navigation direction (1s pan with quick fade-in)
      const cachedSlideInAmount = resolveSlideAmountWithPerFileRange(
        resolvedSlideMode,
        'cached',
        resolvedTransitionRange,
        'in',
      );
      await slideInAnimation(slideDirection, {
        mode: resolvedSlideMode,
        preset: 'cached',
        amount: cachedSlideInAmount,
      });
      
      // Safety cleanup in case slideInAnimation didn't fully clean up
      const viewerEl = document.getElementById('viewer');
      if (viewerEl && (viewerEl.classList.contains('slide-out') || viewerEl.classList.contains('slide-in'))) {
        viewerEl.classList.remove('slide-out', 'slide-in');
      }
    } else {
      // For first load, skip camera animation entirely - just fade in
      // For subsequent loads, use the configured animation
      const shouldAnimateCamera = !isFirstLoad && !wasImmersiveModeActive && store.animationEnabled;

      await animateCameraMutation(() => {
        applyCameraForAsset();

        if (focusDistanceOverride !== undefined) {
          applyFocusDistanceOverride(focusDistanceOverride);
          store.addLog(`Applied focus distance override: ${focusDistanceOverride.toFixed(2)} units`);
        }

        try {
          store.setFov(camera.fov);
        } catch (err) {
          console.warn('Failed to set store FOV from camera:', err);
        }

        saveHomeView();
        applyDebugZoomOut();
      }, { animate: shouldAnimateCamera });

      if (hasCustomMetadata && !cameraMetadata?.intrinsics) {
        refreshSparkForCurrentView('post-camera-custom-view');
      }
      
      // Apply background BEFORE slideIn so it fades in sync with canvas
      if (shouldRunTransition && asset.preview) {
        applyPreviewBackground(asset.preview);
      }
      
      if (shouldRunTransition) {
        const transitionSlideInAmount = resolveSlideAmountWithPerFileRange(
          resolvedSlideMode,
          'transition',
          resolvedTransitionRange,
          'in',
        );
        // Bring content back with fade/slide-in after camera is set
        await slideInAnimation(transitionDirection, {
          mode: resolvedSlideMode,
          preset: 'transition',
          amount: transitionSlideInAmount,
        });
        const viewerEl = document.getElementById('viewer');
        if (viewerEl) {
          viewerEl.classList.remove('slide-out');
          viewerEl.classList.remove('slide-in');
        }
      } else if (slideDirection) {
        // Legacy fade-in for slide transitions when slideOutAnimation was skipped
        const viewerEl = document.getElementById('viewer');
        if (viewerEl) {
          if (!noFade) {
            viewerEl.classList.add('slide-out');   // ensure hidden baseline
            viewerEl.classList.add('slide-in');    // combined rule → opacity: 0
            void viewerEl.offsetHeight;
            viewerEl.classList.remove('slide-out'); // transition fires 0 → 1
          } else {
            viewerEl.classList.remove('slide-out');
          }
          setTimeout(() => {
            viewerEl.classList.remove('slide-in');
          }, 400);
        }
      } else if (isFirstLoad) {
        // First load: fade-in after aspect ratio transition completed
        // Content was hidden with slide-out class during resize
        const viewerEl = document.getElementById('viewer');
        if (viewerEl) {
          if (initialCollectionHidden) {
            // initial-collection-empty is handling the reveal – just clean up
            viewerEl.classList.remove('slide-out');
          } else if (!noFade) {
            viewerEl.classList.add('slide-in');     // combined with slide-out → opacity: 0
            void viewerEl.offsetHeight;
            viewerEl.classList.remove('slide-out'); // transition fires 0 → 1
          } else {
            viewerEl.classList.remove('slide-out');
          }
          setTimeout(() => {
            viewerEl.classList.remove('slide-in');
          }, 400);
        }
      }
    }

    // Apply preview for non-transition cases (transitions handled above)
    // For slideDirection/shouldRunTransition cases, preview was already applied before slideInAnimation
    const alreadyAppliedPreview = slideDirection || shouldRunTransition;
    if (!alreadyAppliedPreview) {
      if (asset.preview) {
        if (wasAlreadyCached) {
          applyPreviewBackground(asset.preview);
        } else {
          setTimeout(() => {
            applyPreviewBackground(asset.preview);
          }, 50);
        }
      } else {
        applyPreviewBackground(null);
      }
    } else if (!asset.preview) {
      // Clear stale background for transitions without preview
      applyPreviewBackground(null);
    }

    // Use reduced warmup for cached splats
    let warmupFrames = wasAlreadyCached ? WARMUP_FRAMES_CACHED : WARMUP_FRAMES;
    let bgCaptured = wasAlreadyCached; // Skip bg capture for cached
    let previewCaptured = false;

    const skipBgGeneration = wasAlreadyCached || (asset.preview && asset.previewSource === "image");

    const warmup = () => {
      if (warmupFrames > 0) {
        warmupFrames--;
        requestRender();
        requestAnimationFrame(warmup);

        if (!bgCaptured && warmupFrames === BG_CAPTURE_FRAME && !skipBgGeneration) {
          // Also skip background capture in VR/stereo mode
          const bgStoreState = getStoreState();
          const isDistortedBg = bgStoreState.stereoEnabled || bgStoreState.vrSessionActive;
          const backgroundMatchesPreview = hasBackgroundForPreview(asset.preview);
          if (!isDistortedBg && !backgroundMatchesPreview) {
            bgCaptured = true;
            captureAndApplyBackground({ renderer, composer, scene, THREE });
          }
        }

        const previewFrame = wasAlreadyCached ? PREVIEW_CAPTURE_FRAME_CACHED : PREVIEW_CAPTURE_FRAME;
        if (!previewCaptured && warmupFrames === previewFrame) {
          previewCaptured = true;
          
          // Skip preview capture if VR or stereo mode is active (would produce distorted preview)
          const currentStoreState = getStoreState();
          const isDistortedMode = currentStoreState.stereoEnabled || currentStoreState.vrSessionActive;
          const shouldGeneratePreview = !isDistortedMode && (!asset.preview || asset.previewSource === 'image');

          if (shouldGeneratePreview) {
            const capturePromise = captureCurrentAssetPreview();
            if (capturePromise?.then) {
              capturePromise
                .then(async (previewResult) => {
                  if (!previewResult?.blob) return;
                  const sizeKB = (previewResult.blob.size / 1024).toFixed(1);
                  store.addLog(`Preview saved (${sizeKB} KB, ${previewResult.format ?? 'image/webp'})`);
                  
                  // Sync the captured preview to the store for gallery display
                  const assetIndex = getAssetList().findIndex((a) => a.id === asset.id);
                  if (assetIndex >= 0 && asset.preview) {
                    store.updateAssetPreview(assetIndex, asset.preview);
                    if (assetIndex === getCurrentAssetIndex()) {
                      applyPreviewBackground(asset.preview);
                    }
                  }
                  
                  await savePreviewBlob(asset.name, previewResult.blob, {
                    width: previewResult.width,
                    height: previewResult.height,
                    format: previewResult.format,
                  }, asset.previewStorageKey || asset.name).catch((err) => {
                    console.warn('Failed to save preview:', err);
                  });
                })
                .catch((err) => {
                  console.warn('Preview capture failed', err);
                });
            }
          } else {
            store.addLog('Using stored preview from IndexedDB');
          }
        }
      } else if (wasImmersiveModeActive) {
        resumeImmersiveMode();
      }
    };
    warmup();

    const loadMs = performance.now() - start;

    store.setFileInfo({
      name: asset.name,
      size: formatBytes(asset.file?.size ?? asset.size),
      splatCount: entry.mesh?.packedSplats?.numSplats ?? "-",
      loadTime: `${loadMs.toFixed(1)} ms`,
    });

    // Remove loading state immediately for cached, short delay for fresh loads
    if (wasAlreadyCached) {
      viewerEl.classList.remove("loading");
      store.setIsLoading(false);
    } else {
      requestAnimationFrame(() => {
        viewerEl.classList.remove("loading");
        store.setIsLoading(false);
      });
    }

    const formatName = formatLabel ?? asset.name ?? "asset";
    const loadedMessage = cameraMetadata
      ? `Loaded ${formatName}`
      : `Loaded ${formatName} (no camera data)`;
    store.setStatus(loadedMessage);
    store.addLog(
      `Debug: splats=${entry.mesh?.packedSplats?.numSplats ?? "-"}`,
    );
  } catch (error) {
    console.error(error);
    viewerEl.classList.remove("loading");
    store.setIsLoading(false);
    clearMetadataCamera(resize);
    store.setStatus("Load failed, please check the file or console log");
    
    // Clean up any slide transition state on error
    cleanupSlideTransitionState();

    if (wasImmersiveModeActive) {
      resumeImmersiveMode();
    }
  }
};

/**
 * Prevents default browser behavior for drag events.
 * @param {DragEvent} event - Drag event
 */
const preventDefaults = (event) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Collect files from a drag event, supporting folder drops.
 * @param {DragEvent} event
 * @returns {Promise<File[]>}
 */
export const collectDroppedFiles = async (event) => {
  const items = event.dataTransfer?.items;
  const files = [];

  if (items) {
    // Try to get folder contents using webkitGetAsEntry
    const entries = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }

    if (entries.length > 0) {
      const processedFiles = await processEntries(entries);
      files.push(...processedFiles);
    } else {
      const fileList = event.dataTransfer?.files;
      if (fileList) {
        files.push(...Array.from(fileList));
      }
    }
  } else {
    const fileList = event.dataTransfer?.files;
    if (fileList) {
      files.push(...Array.from(fileList));
    }
  }

  return files;
};

/**
 * Initializes drag-and-drop file loading on the viewer element.
 * Supports both individual files and folder drops.
 * Called from Viewer component after viewer is ready.
 */
const initDragDrop = () => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl) return;

  ["dragenter", "dragover"].forEach((eventName) => {
    viewerEl.addEventListener(eventName, (event) => {
      preventDefaults(event);
      viewerEl.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    viewerEl.addEventListener(eventName, (event) => {
      preventDefaults(event);
      if (eventName === "dragleave") {
        viewerEl.classList.remove("dragging");
      }
    });
  });

  viewerEl.addEventListener("drop", async (event) => {
    viewerEl.classList.remove("dragging");

    const files = await collectDroppedFiles(event);
    if (files.length > 0) {
      const hasExistingAssets = getAssetCount() > 0;
      if (hasExistingAssets) {
        await handleAddFiles(files, { selectFirstAdded: true });
      } else {
        await handleMultipleFiles(files);
      }
    }
  });
};

/**
 * Recursively processes FileSystemEntry objects from drag/drop.
 * Handles both files and directories.
 * @param {FileSystemEntry[]} entries - Array of file system entries
 * @returns {Promise<File[]>} Array of File objects
 */
const processEntries = async (entries) => {
  const files = [];
  
  /**
   * Reads a single entry (file or directory).
   * @param {FileSystemEntry} entry - Entry to read
   * @returns {Promise<File[]>} Array of files from this entry
   */
  const readEntry = async (entry) => {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => resolve([file]), () => resolve([]));
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const subEntries = await new Promise((resolve) => {
        const allEntries = [];
        const readEntries = () => {
          dirReader.readEntries((entries) => {
            if (entries.length === 0) {
              resolve(allEntries);
            } else {
              allEntries.push(...entries);
              readEntries();
            }
          }, () => resolve(allEntries));
        };
        readEntries();
      });
      const subFiles = await processEntries(subEntries);
      return subFiles;
    }
    return [];
  };
  
  for (const entry of entries) {
    const entryFiles = await readEntry(entry);
    files.push(...entryFiles);
  }
  
  return files;
};

/**
 * Processes multiple files from drag/drop or file picker.
 * Filters supported formats, updates asset gallery, and loads first file.
 * Called from SidePanel (file picker) and initDragDrop (drag/drop).
 * 
 * @param {File[]} files - Array of File objects to process
 */
export const handleMultipleFiles = async (files) => {
  if (!files || files.length === 0) return;
  const store = getStoreState();
  store.clearActiveSource();
  const result = await setAssetListManager(files);
  
  if (result.count === 0) {
    store.setStatus(`No supported files found. Supported: ${supportedExtensionsText}`);
    return;
  }
  
  resetSplatManager();
  setCurrentMesh(null);
  hasLoadedFirstAsset = false; // Reset first load flag for new asset list
  spark?.update?.({ scene });

  // Update store with assets
  store.setAssets(result.assets);
  
  if (result.count === 1) {
    // Single file - load directly
    // First, hydrate preview from storage (same as multi-file branch)
    const asset = result.assets[0];
    if (!asset.preview) {
      const storedPreview = await hydrateAssetPreviewFromStorage(asset);
      if (storedPreview?.blob) {
        store.updateAssetPreview(0, asset.preview);
      }
    }
    
    // Set up preview generation callback (same as multi-file branch)
    onPreviewGenerated((asset, index) => {
      store.updateAssetPreview(index, asset.preview);
    });
    
    setCurrentAssetIndexManager(0);
    store.setCurrentAssetIndex(0);
    await loadSplatFile(asset);
  } else {
    // Multiple files - show gallery and start loading
    store.addLog(`Found ${result.count} assets`);
    
    // Load stored previews from IndexedDB for all assets
    for (let i = 0; i < result.assets.length; i++) {
      const asset = result.assets[i];
      if (asset.preview) continue;
      const storedPreview = await hydrateAssetPreviewFromStorage(asset);
      if (storedPreview?.blob) {
        store.updateAssetPreview(i, asset.preview);
      }
    }
    
    // Set up preview generation callback
    onPreviewGenerated((asset, index) => {
      store.updateAssetPreview(index, asset.preview);
    });
    
    // Load first asset (preview will be captured automatically after warmup)
    setCurrentAssetIndexManager(0);
    store.setCurrentAssetIndex(0);
    await loadSplatFile(result.assets[0]);
  }

  void syncProxyViewsForAssetList(store).catch((err) => {
    console.warn('[FileLoader] Failed to pre-sync proxy views for list', err);
  });
};

/**
 * Adds files to the existing asset list.
 */
export const handleAddFiles = async (files, options = {}) => {
  if (!files || files.length === 0) return;
  const store = getStoreState();
  store.clearActiveSource();
  
  const result = await addAssets(files);
  
  if (result.added === 0) {
    store.setStatus(`No supported files found. Supported: ${supportedExtensionsText}`);
    return;
  }
  
  // Update store with new assets list
  const allAssets = getAssetList();
  store.setAssets([...allAssets]);
  
  store.addLog(`Added ${result.added} assets`);
  
  // Load stored previews for new assets
  const startIndex = allAssets.length - result.added;
  
  for (let i = 0; i < result.newAssets.length; i++) {
    const asset = result.newAssets[i];
    const globalIndex = startIndex + i;
    if (asset.preview) continue;
    const storedPreview = await hydrateAssetPreviewFromStorage(asset);
    if (storedPreview?.blob) {
      store.updateAssetPreview(globalIndex, asset.preview);
    }
  }

  if (options.selectFirstAdded && result.newAssets.length > 0) {
    const firstNewIndex = startIndex;
    setCurrentAssetIndexManager(firstNewIndex);
    store.setCurrentAssetIndex(firstNewIndex);
    await loadSplatFile(result.newAssets[0]);
  }

  const newBaseIds = result.newAssets.map((asset) => getBaseAssetId(asset));
  void syncProxyViewsForAssetList(store, { onlyBaseIds: newBaseIds }).catch((err) => {
    console.warn('[FileLoader] Failed to pre-sync proxy views for added assets', err);
  });
};

/** Duration (ms) for the smooth camera glide between views on the same splat */
const SAME_BASE_GLIDE_MS = 2000;

const applyInstantProxyAspectCutAndReset = (stage = 'proxy') => {
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) viewerEl.style.transition = 'none';

  updateViewerAspectRatio();
  clearMetadataCamera(resize);
  resize();
  refreshSparkForCurrentView(`aspect-cut-${stage}`);
  requestRender();

  requestAnimationFrame(() => {
    resize();
    refreshSparkForCurrentView(`aspect-cut-${stage}-raf`);
    requestRender();
  });

  if (viewerEl) {
    void viewerEl.offsetHeight;
    viewerEl.style.transition = '';
  }
};

const forceProxyPostPoseRenderReflow = (label = 'proxy') => {
  controls?.update?.();
  resize();
  refreshSparkForCurrentView(`reflow-${label}`);
  requestRender();

  requestAnimationFrame(() => {
    controls?.update?.();
    resize();
    refreshSparkForCurrentView(`reflow-${label}-raf1`);
    requestRender();

    requestAnimationFrame(() => {
      controls?.update?.();
      resize();
      refreshSparkForCurrentView(`reflow-${label}-raf2`);
      requestRender();
    });
  });
};

const navigateWithinLoadedBaseAsset = async (asset, options = {}) => {
  if (!asset || !currentMesh) return false;

  const store = getStoreState();
  const { selectedView, views } = await resolveAssetView(asset);
  if (!selectedView?.cameraPose) return false;

  await syncAssetProxyViews({ store, currentAsset: asset, views });

  // Cancel any in-flight slide / continuous animations and stale handoffs
  cleanupSlideTransitionState();
  cancelContinuousZoomAnimation();
  cancelContinuousDollyZoomAnimation();
  cancelContinuousOrbitAnimation();
  cancelContinuousVerticalOrbitAnimation();
  clearContinuousHandoff();

  // Apply model transform instantly
  applyCustomModelTransform(currentMesh, {
    applyCoordinateFlip: true,
    modelScale: selectedView?.model?.modelScale ?? 1,
  });
  store.setCustomModelScale(selectedView?.model?.modelScale ?? 1);

  // Apply aspect ratio instantly – bypass the CSS transition so the viewer
  // snaps to the new size rather than animating width/height.
  const customAspectRatio = selectedView?.view?.aspectRatio ?? null;
  setOriginalImageAspect(customAspectRatio);
  store.setCustomAspectRatio(aspectRatioToKey(customAspectRatio));

  // Preserve camera projection properties so the upcoming animation starts
  // from the *current* FOV / near / far rather than defaults.  Without this,
  // clearMetadataCamera inside applyInstantProxyAspectCutAndReset resets them
  // to defaultCamera values, causing an instant FOV jump before the glide.
  const preservedFov = camera.fov;
  const preservedNear = camera.near;
  const preservedFar = camera.far;
  applyInstantProxyAspectCutAndReset();
  camera.fov = preservedFov;
  camera.near = preservedNear;
  camera.far = preservedFar;
  camera.updateProjectionMatrix();

  // Start background cross-fade in parallel with the camera glide so the
  // blurred glow transitions smoothly instead of snapping.
  if (asset.preview) {
    crossFadePreviewBackground(asset.preview, SAME_BASE_GLIDE_MS);
  }

  // Smooth 2-second camera glide to the target pose (always animated)
  await animateCameraMutation(() => {
    applyCameraPose(selectedView.cameraPose);
    try { store.setFov(camera.fov); } catch (_) { /* noop */ }
    saveHomeView();
    applyDebugZoomOut();
  }, { animate: true, duration: SAME_BASE_GLIDE_MS });

  forceProxyPostPoseRenderReflow('after-proxy-glide');

  // If there was no preview to cross-fade, apply a fallback (or clear) now
  if (!asset.preview) {
    applyPreviewBackground(null);
  }

  // Sync per-view custom animation settings so the store reflects the new view
  const activeCacheKeyForView = asset.cacheKey || getBaseAssetId(asset);
  const cacheEntryForView = getSplatCache().get(activeCacheKeyForView);
  if (cacheEntryForView) {
    const viewCustomAnimation = resolveEffectiveCustomAnimation(cacheEntryForView.storedSettings, asset);
    syncStoredCustomAnimationSettings(viewCustomAnimation, store);
  }

  store.setMetadataMissing(false);
  store.setCustomMetadataAvailable(true);
  // Preserve editor visibility if user is actively editing custom views
  if (!store.customMetadataControlsVisible) {
    store.setCustomMetadataControlsVisible(false);
  }
  store.setFileInfo({
    name: getBaseAssetName(asset),
    size: formatBytes(asset.file?.size ?? asset.size),
  });
  store.setStatus(`Loaded ${getBaseAssetName(asset)} view`);
  requestRender();
  return true;
};

/**
 * Build a continuous-handoff payload for seamless same-base slideshow transitions.
 * Pre-resolves the view and returns a handoff object whose onApply callback
 * synchronously applies all state (model, aspect, camera, store).
 *
 * @param {Object} asset - The next proxy view asset
 * @param {Object} opts
 * @param {string} opts.slideMode - Continuous slide mode (e.g. 'continuous-orbit')
 * @returns {Promise<Object|null>} handoff payload or null if view can't be resolved
 */
export const buildContinuousHandoff = async (asset, { slideMode: _slideMode } = {}) => {
  const { selectedView, views } = await resolveAssetView(asset);
  if (!selectedView?.cameraPose) return null;

  const store = getStoreState();
  let nextAssetCustomAnimation = null;
  let nextAssetAnnotation = null;
  try {
    const entry = await ensureSplatEntry(asset);
    nextAssetCustomAnimation = resolveEffectiveCustomAnimation(entry?.storedSettings, asset);
    nextAssetAnnotation = entry?.storedSettings?.annotation ?? null;
  } catch (err) {
    console.warn('[FileLoader] Failed to pre-resolve custom animation for handoff', err);
  }

  const { slideMode: resolvedSlideMode } = getSlideModeForStore(store, {
    slideDirection: 'next',
    customAnimationSettings: nextAssetCustomAnimation,
  });

  if (!resolvedSlideMode?.startsWith('continuous-')) {
    return null;
  }

  // Pre-sync proxy views (async work done now, not during handoff)
  await syncAssetProxyViews({ store, currentAsset: asset, views });

  const { duration, amount } = resolveSlideInOptions(resolvedSlideMode, { preset: 'transition' });

  return {
    slideMode: resolvedSlideMode,
    duration,
    amount,
    glideDuration: SAME_BASE_GLIDE_MS / 1000,
    onApply: () => {
      const applyStore = getStoreState();

      syncStoredCustomAnimationSettings(nextAssetCustomAnimation, applyStore);
      syncStoredAnnotation(nextAssetAnnotation, applyStore);

      // Model transform
      if (currentMesh) {
        applyCustomModelTransform(currentMesh, {
          applyCoordinateFlip: true,
          modelScale: selectedView?.model?.modelScale ?? 1,
        });
      }
      applyStore.setCustomModelScale(selectedView?.model?.modelScale ?? 1);

      // Aspect ratio – instant, no CSS transition
      const customAspectRatio = selectedView?.view?.aspectRatio ?? null;
      setOriginalImageAspect(customAspectRatio);
      applyStore.setCustomAspectRatio(aspectRatioToKey(customAspectRatio));
      applyInstantProxyAspectCutAndReset();

      // Camera pose (so the continuous fn calculates offsets from the new view)
      applyCameraPose(selectedView.cameraPose);
      try { applyStore.setFov(camera.fov); } catch (_) { /* noop */ }
      saveHomeView();
      applyDebugZoomOut();
      updateDollyZoomBaselineFromCamera();
      forceProxyPostPoseRenderReflow('continuous-handoff');

      // Store state
      applyStore.setMetadataMissing(false);
      applyStore.setCustomMetadataAvailable(true);
      applyStore.setCustomMetadataControlsVisible(false);
      applyStore.setFileInfo({
        name: getBaseAssetName(asset),
        size: formatBytes(asset.file?.size ?? asset.size),
      });
      applyStore.setStatus(`Loaded ${getBaseAssetName(asset)} view`);

      // Cross-fade background to match the glide duration
      if (asset.preview) {
        crossFadePreviewBackground(asset.preview, SAME_BASE_GLIDE_MS);
      } else {
        applyPreviewBackground(null);
      }
    },
  };
};

/**
 * Loads a specific asset by index.
 * Called from AssetGallery component when user clicks a thumbnail.
 * @param {number} index - Asset index to load
 */
/**
 * Loads a specific asset by index.
 * Called from AssetGallery and AssetSidebar when user clicks a thumbnail.
 * @param {number} index - Asset index to load
 */
export const loadAssetByIndex = async (index) => {
  const prevIndex = getCurrentAssetIndex();
  const prevAsset = getAssetByIndex(prevIndex);
  const asset = getAssetByIndex(index);
  if (!asset) return;
  if (isNavigationLocked) return;
  
  isNavigationLocked = true;
  
  // Pause immersive mode immediately to prevent erratic camera during transition
  const wasImmersive = isImmersiveModeActive();
  if (wasImmersive) {
    pauseImmersiveMode();
  }
  
  try {
    const store = getStoreState();
    const outgoingCustomAnimationSettings = store.fileCustomAnimation;
    setCurrentAssetIndexManager(index);
    store.setCurrentAssetIndex(index);
    const sameBase = prevAsset
      && getBaseAssetId(prevAsset) === getBaseAssetId(asset)
      && prevAsset.id !== asset.id;

    if (sameBase) {
      const reused = await navigateWithinLoadedBaseAsset(asset, { slideDirection: null });
      if (reused) {
        restartContinuousIfPlaying();
      } else {
        await loadSplatFile(asset, { outgoingCustomAnimationSettings });
      }
    } else {
      // Gracefully fade out the background when leaving a proxy view so it
      // doesn't stay stuck at the old blur while the new asset loads.
      if (isProxyViewAsset(prevAsset)) fadeOutBackground();
      await loadSplatFile(asset, { outgoingCustomAnimationSettings });
    }
  } finally {
    isNavigationLocked = false;
    // Resume immersive mode after navigation completes
    if (wasImmersive) {
      resumeImmersiveMode();
    }
  }
};

/**
 * Loads assets from a connected storage source.
 * Replaces current asset list with assets from the source.
 * 
 * @param {import('./storage/AssetSource.js').AssetSource} source
 */
export const loadFromStorageSource = async (source, options = {}) => {
  const store = getStoreState();
  const { preferredIndex } = options || {};

  store.setIsLoading(true);

  try {
    store.setStatus(`Loading assets from ${source.name}...`);
    
    // Import storage adapter
    const { loadSourceAssets, loadAssetPreview } = await import('./storage/index.js');
    const { setAdaptedAssets } = await import('./assetManager.js');
    
    // Get assets from source
    const adaptedAssets = await loadSourceAssets(source);

    // Record the active collection for UI highlighting
    store.setActiveSourceId(source.id);
    
    if (adaptedAssets.length === 0) {
      store.setStatus(`No supported assets found in ${source.name}`);
      store.setAssets([]);
      store.setCurrentAssetIndex(-1);
      resetSplatManager();
      setCurrentMesh(null);
      hasLoadedFirstAsset = false;
      spark?.update?.({ scene });
      clearBackground();
      const pageEl = document.querySelector(".page");
      if (pageEl) {
        pageEl.classList.remove("has-glow");
      }
      return;
    }
    
    // Reset current state
    resetSplatManager();
    setCurrentMesh(null);
    hasLoadedFirstAsset = false; // Reset first load flag for new source
    spark?.update?.({ scene });
    
    // Clear background
    clearBackground();
    const pageEl = document.querySelector(".page");
    if (pageEl) {
      pageEl.classList.remove("has-glow");
    }
    
    // Set the adapted assets in the asset manager
    const result = setAdaptedAssets(adaptedAssets);

    // Hydrate cached flags from IndexedDB settings
    try {
      const cachedNames = await listCachedFileNames();
      const cachedSet = new Set(cachedNames);
      result.assets.forEach((asset) => {
        asset.isCached = cachedSet.has(asset.name);
      });
    } catch (err) {
      console.warn('[FileLoader] Failed to hydrate cache flags', err);
    }

    // Update store with assets
    store.setAssets(result.assets);
    
    store.addLog(`Found ${adaptedAssets.length} assets from ${source.name}`);
    
    // Set up preview generation callback
    onPreviewGenerated((asset, index) => {
      store.updateAssetPreview(index, asset.preview);
    });
    
    // Load previews from source for all assets (in background)
    const loadPreviews = async () => {
      for (let i = 0; i < result.assets.length; i++) {
        const asset = result.assets[i];
        if (asset.preview) continue;
        const storedPreview = await hydrateAssetPreviewFromStorage(asset);
        if (storedPreview?.blob) {
          store.updateAssetPreview(i, asset.preview);
          continue;
        }

        const preview = await loadAssetPreview(asset);
        if (preview) {
          replacePreviewUrl(asset, preview);
          store.updateAssetPreview(i, asset.preview);
        }
      }
    };
    loadPreviews(); // Don't await, run in background
    
    // Load preferred asset (fallback to first)
    if (result.assets.length > 0) {
      const fallbackIndex = 0;
      const candidate = Number.isInteger(preferredIndex) ? preferredIndex : fallbackIndex;
      const indexToLoad = candidate >= 0 && candidate < result.assets.length ? candidate : fallbackIndex;
      setCurrentAssetIndexManager(indexToLoad);
      store.setCurrentAssetIndex(indexToLoad);
      await loadSplatFile(result.assets[indexToLoad]);
    }

    void syncProxyViewsForAssetList(store).catch((err) => {
      console.warn('[FileLoader] Failed to pre-sync proxy views for source assets', err);
    });
    
  } catch (error) {
    console.error('Failed to load from storage source:', error);
    store.setStatus(`Failed to load from ${source.name}: ${error.message}`);
    store.clearActiveSource();
  } finally {
    store.setIsLoading(false);
  }
};

/**
 * Loads the next asset in the list.
 * Called from keyboard shortcut (arrow keys).
 * @param {Object} [options]
 * @param {boolean} [options.skipTimerReset] - When true, skip resetSlideshowTimer
 *   (used by slideshowController which manages its own scheduling).
 */
export const loadNextAsset = async (options = {}) => {
  if (!hasMultipleAssets()) return;
  if (isNavigationLocked) return;
  
  isNavigationLocked = true;
  if (!options.skipTimerReset) {
    resetSlideshowTimer();
  }
  
  // Pause immersive mode immediately to prevent erratic camera during transition
  const wasImmersive = isImmersiveModeActive();
  if (wasImmersive) {
    pauseImmersiveMode();
  }
  
  try {
    const store = getStoreState();
    const outgoingCustomAnimationSettings = store.fileCustomAnimation;
    const prevAsset = getAssetByIndex(getCurrentAssetIndex());
    const asset = nextAsset();
    if (asset) {
      const index = getCurrentAssetIndex();
      store.setCurrentAssetIndex(index);
      const sameBase = prevAsset
        && getBaseAssetId(prevAsset) === getBaseAssetId(asset)
        && prevAsset.id !== asset.id;

      if (sameBase) {
        const reused = await navigateWithinLoadedBaseAsset(asset, { slideDirection: 'next' });
        if (reused) {
          // Proxy-view glide finished — restart continuous motion if the
          // slideshow is actively playing in continuous mode so the camera
          // doesn't freeze after a manual advance.
          restartContinuousIfPlaying();
        } else {
          await loadSplatFile(asset, { slideDirection: 'next', outgoingCustomAnimationSettings });
        }
      } else {
        if (isProxyViewAsset(prevAsset)) fadeOutBackground();
        await loadSplatFile(asset, { slideDirection: 'next', outgoingCustomAnimationSettings });
      }
    }
  } finally {
    isNavigationLocked = false;
    // Resume immersive mode after navigation completes
    if (wasImmersive) {
      resumeImmersiveMode();
    }
  }
};

/**
 * Loads the previous asset in the list.
 * Called from keyboard shortcut (arrow keys).
 * @param {Object} [options]
 * @param {boolean} [options.skipTimerReset] - When true, skip resetSlideshowTimer
 *   (used by slideshowController which manages its own scheduling).
 */
export const loadPrevAsset = async (options = {}) => {
  if (!hasMultipleAssets()) return;
  if (isNavigationLocked) return;
  
  isNavigationLocked = true;
  if (!options.skipTimerReset) {
    resetSlideshowTimer();
  }
  
  // Pause immersive mode immediately to prevent erratic camera during transition
  const wasImmersive = isImmersiveModeActive();
  if (wasImmersive) {
    pauseImmersiveMode();
  }
  
  try {
    const store = getStoreState();
    const outgoingCustomAnimationSettings = store.fileCustomAnimation;
    const prevLoadedAsset = getAssetByIndex(getCurrentAssetIndex());
    const asset = prevAsset();
    if (asset) {
      const index = getCurrentAssetIndex();
      store.setCurrentAssetIndex(index);
      const sameBase = prevLoadedAsset
        && getBaseAssetId(prevLoadedAsset) === getBaseAssetId(asset)
        && prevLoadedAsset.id !== asset.id;

      if (sameBase) {
        const reused = await navigateWithinLoadedBaseAsset(asset, { slideDirection: 'prev' });
        if (reused) {
          restartContinuousIfPlaying();
        } else {
          await loadSplatFile(asset, { slideDirection: 'prev', outgoingCustomAnimationSettings });
        }
      } else {
        if (isProxyViewAsset(prevLoadedAsset)) fadeOutBackground();
        await loadSplatFile(asset, { slideDirection: 'prev', outgoingCustomAnimationSettings });
      }
    }
  } finally {
    isNavigationLocked = false;
    // Resume immersive mode after navigation completes
    if (wasImmersive) {
      resumeImmersiveMode();
    }
  }
};

/**
 * Reloads the current asset to force a clean render (e.g., after fullscreen).
 * Skips if navigation is already locked or no asset is selected.
 */
export const reloadCurrentAsset = async () => {
  if (isNavigationLocked) return;

  const index = getCurrentAssetIndex();
  if (index < 0) return;

  const asset = getAssetByIndex(index);
  if (!asset) return;

  isNavigationLocked = true;

  const wasImmersive = isImmersiveModeActive();
  if (wasImmersive) {
    pauseImmersiveMode();
  }

  try {
    await loadSplatFile(asset);
  } finally {
    isNavigationLocked = false;
    if (wasImmersive) {
      resumeImmersiveMode();
    }
  }
};

