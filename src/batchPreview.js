/**
 * Batch preview generation utilities.
 */
import { useStore } from './store.js';
import { clearBackground } from './backgroundManager.js';
import { savePreviewBlob } from './fileStorage.js';
import { ensureSplatEntry, getSplatCache } from './splatManager.js';
import { isImmersiveModeActive, pauseImmersiveMode, resumeImmersiveMode } from './immersiveMode.js';
import {
  getAssetList,
  setCurrentAssetIndex as setCurrentAssetIndexManager,
  captureCurrentAssetPreview,
} from './assetManager.js';
import {
  applyMetadataCamera,
  fitViewToMesh,
  applyFocusDistanceOverride,
  saveHomeView,
  clearMetadataCamera,
} from './cameraUtils.js';
import { updateViewerAspectRatio, resize, isNavigationLockedRef, setNavigationLocked } from './fileLoader.js';
import { setCurrentMesh, setOriginalImageAspect, requestRender, spark, scene } from './viewer.js';

const getStoreState = () => useStore.getState();

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
};

let batchPreviewAborted = false;

const resolveAssetIndexForUpdate = (asset, fallbackIndex) => {
  const assets = getAssetList();
  if (Number.isInteger(fallbackIndex) && assets[fallbackIndex]?.id === asset?.id) {
    return fallbackIndex;
  }
  return assets.findIndex((candidate) => candidate?.id === asset?.id);
};

const loadSplatFileFast = async (asset) => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl || !asset) return;

  const store = getStoreState();

  try {
    clearBackground();

    const entry = await ensureSplatEntry(asset);
    if (!entry) throw new Error('Unable to activate splat entry');

    const cache = getSplatCache();
    cache.forEach((cached, id) => {
      cached.mesh.visible = id === asset.id;
    });

    setCurrentMesh(entry.mesh);
    viewerEl.classList.add('has-mesh');
    spark.update({ scene });

    const { cameraMetadata, focusDistanceOverride } = entry;

    if (cameraMetadata?.intrinsics) {
      setOriginalImageAspect(
        cameraMetadata.intrinsics.imageWidth / cameraMetadata.intrinsics.imageHeight
      );
    } else {
      setOriginalImageAspect(null);
    }

    updateViewerAspectRatio();
    resize();
    clearMetadataCamera(resize);

    if (cameraMetadata) {
      applyMetadataCamera(entry.mesh, cameraMetadata, resize);
    } else {
      fitViewToMesh(entry.mesh);
    }

    if (focusDistanceOverride !== undefined) {
      applyFocusDistanceOverride(focusDistanceOverride);
    }

    saveHomeView();

    // Wait for resize/layout to settle before warmup (DOM needs 1-2 frames)
    requestRender();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Warmup frames for splat rendering to stabilize at correct size
    const FAST_WARMUP_FRAMES = 12;
    for (let i = 0; i < FAST_WARMUP_FRAMES; i++) {
      requestRender();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    store.setFileInfo({
      name: asset.name,
      size: formatBytes(asset.file?.size ?? asset.size),
      splatCount: entry.mesh?.packedSplats?.numSplats ?? '-',
    });
  } catch (error) {
    console.error('Fast load failed:', error);
    throw error;
  }
};

export const generateAllPreviews = async (options = {}) => {
  const { onProgress, onComplete, skipExisting = false } = options;
  const store = getStoreState();
  const assetList = getAssetList();

  if (assetList.length === 0) {
    store.addLog('[BatchPreview] No assets to process');
    return { success: 0, failed: 0 };
  }

  if (isNavigationLockedRef()) {
    store.addLog('[BatchPreview] Navigation locked, cannot start batch');
    return { success: 0, failed: 0 };
  }
  setNavigationLocked(true);
  batchPreviewAborted = false;

  const originalAnimationEnabled = store.animationEnabled;
  const wasImmersive = isImmersiveModeActive();
  if (wasImmersive) {
    pauseImmersiveMode();
  }

  store.setAnimationEnabled(false);
  try {
    const { setLoadAnimationEnabled } = await import('./customAnimations.js');
    setLoadAnimationEnabled(false);
  } catch (err) {
    console.warn('Failed to disable load animation:', err);
  }

  const viewerEl = document.getElementById('viewer');
  const sidePanelEl = document.querySelector('.side-panel');
  const mobileBtnContainer = document.querySelector('.mobile-btn-container');
  const bgContainer = document.querySelector('.bg-image-container');

  const hiddenElements = [];
  if (sidePanelEl) {
    sidePanelEl.style.display = 'none';
    hiddenElements.push(sidePanelEl);
  }
  if (mobileBtnContainer) {
    mobileBtnContainer.style.display = 'none';
    hiddenElements.push(mobileBtnContainer);
  }
  if (bgContainer) {
    bgContainer.style.opacity = '0';
  }

  viewerEl?.classList.add('batch-preview-mode');

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  store.addLog(`[BatchPreview] Starting batch for ${assetList.length} assets${skipExisting ? ' (skipping existing)' : ''}`);

  try {
    for (let i = 0; i < assetList.length; i++) {
      if (batchPreviewAborted) {
        store.addLog('[BatchPreview] Aborted by user');
        break;
      }

      const asset = assetList[i];

      // Skip assets that already have a preview if requested
      if (skipExisting && asset.preview) {
        skippedCount++;
        onProgress?.(i + 1, assetList.length, asset.name, true);
        store.addLog(`[BatchPreview] ⊘ ${asset.name} (already has preview)`);
        continue;
      }

      onProgress?.(i + 1, assetList.length, asset.name, false);
      store.setStatus(`Generating preview ${i + 1}/${assetList.length}: ${asset.name}`);

      try {
        setCurrentAssetIndexManager(i);

        await loadSplatFileFast(asset);

        // Ensure viewer resizes correctly when aspect ratio changes between assets
        updateViewerAspectRatio();
        resize();
        requestRender();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const result = await captureCurrentAssetPreview();
        if (result?.blob) {
          await savePreviewBlob(asset.name, result.blob, {
            width: result.width,
            height: result.height,
            format: result.format,
          }, asset.previewStorageKey || asset.name);
          const updateIndex = resolveAssetIndexForUpdate(asset, i);
          if (updateIndex >= 0) {
            store.updateAssetPreview(updateIndex, asset.preview);
            if (updateIndex !== i) {
              store.addLog(`[BatchPreview] Index drift guard: ${asset.name} resolved ${i} → ${updateIndex}`);
            }
          } else {
            store.addLog(`[BatchPreview] Skipped sidebar update for ${asset.name} (asset not found)`);
          }
          successCount++;
          store.addLog(`[BatchPreview] ✓ ${asset.name}`);
        } else {
          failCount++;
          store.addLog(`[BatchPreview] ✗ ${asset.name} - no preview captured`);
        }
      } catch (err) {
        failCount++;
        store.addLog(`[BatchPreview] ✗ ${asset.name} - ${err.message}`);
        console.warn(`[BatchPreview] Failed to process ${asset.name}:`, err);
      }
    }
  } finally {
    hiddenElements.forEach((el) => {
      el.style.display = '';
    });
    if (bgContainer) {
      bgContainer.style.opacity = '';
    }
    viewerEl?.classList.remove('batch-preview-mode');

    store.setAnimationEnabled(originalAnimationEnabled);
    try {
      const { setLoadAnimationEnabled } = await import('./customAnimations.js');
      setLoadAnimationEnabled(originalAnimationEnabled);
    } catch (err) {
      console.warn('Failed to restore load animation:', err);
    }

    setNavigationLocked(false);

    if (wasImmersive) {
      resumeImmersiveMode();
    }

    store.addLog(`[BatchPreview] Complete: ${successCount} succeeded, ${failCount} failed${skippedCount ? `, ${skippedCount} skipped` : ''}`);
    store.setStatus(`Batch preview complete: ${successCount}/${assetList.length}`);
    onComplete?.(successCount, failCount, skippedCount);
  }

  return { success: successCount, failed: failCount, skipped: skippedCount };
};

export const abortBatchPreview = () => {
  batchPreviewAborted = true;
};
