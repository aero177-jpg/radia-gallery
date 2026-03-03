/**
 * Debug settings dropdown for the side panel.
 * Hosts FPS overlay toggle and viewer debug controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store';
import { captureCurrentAssetPreview, getAssetList, getCurrentAssetIndex } from '../assetManager';
import { savePreviewBlob } from '../fileStorage';
import { loadFromStorageSource, resize } from '../fileLoader';
import { applyPreviewBackground } from '../backgroundManager.js';
import { clearCustomMetadataForAsset } from '../customMetadata.js';
import { requestRender, setStereoEffectEnabled } from '../viewer';
import { formatBytes } from '../previewManager.js';
import { clearRemovedAssets, getSource, isSourceAsset, loadAssetFile } from '../storage/index.js';
import { zipSync } from 'fflate';
import TransferDataModal from './TransferDataModal';
import ExportChoiceModal from './ExportChoiceModal';
import BatchPreviewModal from './BatchPreviewModal';
import ClearDataModal from './ClearDataModal';
import { useBatchPreview } from './useBatchPreview';


function DebugSettings() {
  const showFps = useStore((state) => state.showFps);
  const setShowFps = useStore((state) => state.setShowFps);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const activeSourceId = useStore((state) => state.activeSourceId);
  const debugSettingsExpanded = useStore((state) => state.debugSettingsExpanded);
  const toggleDebugSettingsExpanded = useStore((state) => state.toggleDebugSettingsExpanded);
  const updateAssetPreview = useStore((state) => state.updateAssetPreview);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const addLog = useStore((state) => state.addLog);
  const setUploadState = useStore((state) => state.setUploadState);
  const bgBlur = useStore((state) => state.bgBlur);
  const setBgBlur = useStore((state) => state.setBgBlur);
  const disableTransparentUi = useStore((state) => state.disableTransparentUi);
  const setDisableTransparentUi = useStore((state) => state.setDisableTransparentUi);
  const debugStochasticRendering = useStore((state) => state.debugStochasticRendering);
  const setDebugStochasticRendering = useStore((state) => state.setDebugStochasticRendering);
  const debugFpsLimitEnabled = useStore((state) => state.debugFpsLimitEnabled);
  const setDebugFpsLimitEnabled = useStore((state) => state.setDebugFpsLimitEnabled);
  const debugSparkMaxStdDev = useStore((state) => state.debugSparkMaxStdDev);
  const setDebugSparkMaxStdDev = useStore((state) => state.setDebugSparkMaxStdDev);
  const setQualityPreset = useStore((state) => state.setQualityPreset);
  const customMetadataAvailable = useStore((state) => state.customMetadataAvailable);
  const setCustomMetadataAvailable = useStore((state) => state.setCustomMetadataAvailable);
  const setCustomMetadataControlsVisible = useStore((state) => state.setCustomMetadataControlsVisible);
  const stereoEnabled = useStore((state) => state.stereoEnabled);
  const setStereoEnabled = useStore((state) => state.setStereoEnabled);
  const appBgColor = useStore((state) => state.appBgColor);
  const setAppBgColor = useStore((state) => state.setAppBgColor);

  const {
    currentAssetName,
    currentAssetHasCustomMetadata,
    setCurrentAssetHasCustomMetadata,
    resetCustomMetadataState,
  } = useStore();

  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isRestoringRemoved, setIsRestoringRemoved] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [clearDataModalOpen, setClearDataModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Debug upload overlay simulation
  const [debugOverlayStep, setDebugOverlayStep] = useState(0);
  const debugTimerRef = useRef(null);
  const debugStateRef = useRef(null);

  const currentAsset = assets[currentAssetIndex] || null;
  const currentAssetSize = currentAsset?.file?.size ?? currentAsset?.size ?? null;

  const {
    batchProgress,
    generatingBatch,
    batchPreviewModalOpen,
    batchResult,
    canBatchGeneratePreviews,
    handleOpenBatchPreviewModal,
    handleConfirmBatchPreview,
    handleAbortBatchPreview,
    handleCloseBatchPreviewModal,
  } = useBatchPreview();

  const collectionInfo = useMemo(() => {
    const source = activeSourceId ? getSource(activeSourceId) : null;
    const collectionName = source?.name || source?.config?.collectionName || 'Current collection';
    const totalAssets = assets.length;
    const sizeValues = assets.map((asset) => asset?.file?.size ?? asset?.size).filter((size) => Number.isFinite(size));
    const allSizesKnown = totalAssets > 0 && sizeValues.length === totalAssets;
    const totalSize = sizeValues.reduce((sum, size) => sum + size, 0);
    const sogCount = assets.filter((asset) => {
      const name = (asset?.name || asset?.path || '').toLowerCase();
      return name.endsWith('.sog');
    }).length;
    const estimatedBytes = sogCount > 0 ? sogCount * 11 * 1024 * 1024 : null;

    return {
      collectionName,
      totalAssets,
      allSizesKnown,
      totalSize,
      estimatedBytes,
      sogCount,
    };
  }, [activeSourceId, assets]);

  const refreshAssets = useCallback(() => {
    const freshAssets = getAssetList();
    const idx = getCurrentAssetIndex();
    setAssets([...freshAssets]);
    setCurrentAssetIndex(idx);
  }, [setAssets, setCurrentAssetIndex]);

  /** Toggle FPS overlay visibility */
  const handleFpsToggle = useCallback((e) => {
    const enabled = Boolean(e.target.checked);
    setShowFps(enabled);
    const el = document.getElementById('fps-counter');
    if (el) el.style.display = enabled ? 'block' : 'none';
  }, [setShowFps]);

  /** Toggle stochastic rendering */
  const handleStochasticToggle = useCallback((e) => {
    const enabled = Boolean(e.target.checked);
    setQualityPreset('debug-custom');
    setDebugStochasticRendering(enabled);
  }, [setDebugStochasticRendering, setQualityPreset]);

  /** Toggle FPS limiting */
  const handleFpsLimitToggle = useCallback((e) => {
    const enabled = Boolean(e.target.checked);
    setQualityPreset('debug-custom');
    setDebugFpsLimitEnabled(enabled);
  }, [setDebugFpsLimitEnabled, setQualityPreset]);

  /** Toggle side-by-side stereo effect; enter fullscreen when enabling */
  const handleStereoToggle = useCallback(async (e) => {
    const enabled = e.target.checked;
    const fullscreenRoot = document.getElementById('app');
    if (!fullscreenRoot) return;

    try {
      if (enabled) {
        // Hide background images when entering stereo mode
        const bgContainers = document.querySelectorAll('.bg-image-container');
        bgContainers.forEach(el => el.classList.add('stereo-hidden'));

        if (document.fullscreenElement !== fullscreenRoot) {
          await fullscreenRoot.requestFullscreen();
        }
        setStereoEffectEnabled(true);
        setStereoEnabled(true);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        resize();
        addLog('Side-by-side stereo enabled');
      } else {
        // Restore background images when exiting stereo mode
        const bgContainers = document.querySelectorAll('.bg-image-container');
        bgContainers.forEach(el => el.classList.remove('stereo-hidden'));

        setStereoEffectEnabled(false);
        setStereoEnabled(false);
        requestRender();
        if (document.fullscreenElement === fullscreenRoot) {
          await document.exitFullscreen();
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        console.log('Resizing after stereo disable');
        resize();
        addLog('Stereo mode disabled');
      }
    } catch (err) {
      // Restore background images on error
      const bgContainers = document.querySelectorAll('.bg-image-container');
      bgContainers.forEach(el => el.classList.remove('stereo-hidden'));

      setStereoEffectEnabled(false);
      setStereoEnabled(false);
      e.target.checked = false;
      addLog('Stereo toggle failed');
      console.warn('Stereo toggle failed:', err);
    }
  }, [setStereoEnabled, addLog]);

  const handleSparkStdDevChange = useCallback((e) => {
    const value = Number(e.target.value);
    setQualityPreset('debug-custom');
    setDebugSparkMaxStdDev(Number.isFinite(value) ? value : Math.sqrt(5));
  }, [setDebugSparkMaxStdDev, setQualityPreset]);

  const handleClearCustomMetadata = useCallback(async () => {
    if (!currentAssetName || isClearing) return;
    
    setIsClearing(true);
    try {
      await clearCustomMetadataForAsset(currentAssetName);
      setCurrentAssetHasCustomMetadata(false);
      resetCustomMetadataState();
      console.log(`Cleared custom metadata for ${currentAssetName}`);
    } catch (err) {
      console.error("Failed to clear custom metadata:", err);
    } finally {
      setIsClearing(false);
    }
  }, [currentAssetName, isClearing, setCurrentAssetHasCustomMetadata, resetCustomMetadataState]);

  const handleRestoreRemoved = useCallback(async () => {
    if (!activeSourceId || isRestoringRemoved) return;
    const source = getSource(activeSourceId);
    if (!source) return;

    setIsRestoringRemoved(true);
    try {
      await clearRemovedAssets(source);
      addLog('[Cache] Restored locally removed items');
      await loadFromStorageSource(source);
    } catch (err) {
      console.error('[Cache] Restore removed failed:', err);
      addLog(`[Cache] Restore failed: ${err.message}`);
    } finally {
      setIsRestoringRemoved(false);
    }
  }, [activeSourceId, addLog, isRestoringRemoved]);

  /** Debug: force regenerate preview for current asset */
  const handleRegeneratePreview = useCallback(async () => {
    setGeneratingPreview(true);
    try {
      const currentIndex = getCurrentAssetIndex();
      const assetList = getAssetList();
      const asset = assetList[currentIndex];
      
      if (!asset) {
        addLog('[Debug] No current asset to capture preview for');
        return;
      }
      
      addLog(`[Debug] Capturing preview for asset index ${currentIndex}: ${asset.name}`);
      console.log('[Debug] Asset before capture:', { 
        id: asset.id, 
        name: asset.name, 
        preview: asset.preview,
        previewSource: asset.previewSource 
      });
      
      const result = await captureCurrentAssetPreview();
      
      console.log('[Debug] Capture result:', result);
      console.log('[Debug] Asset after capture:', { 
        id: asset.id, 
        name: asset.name, 
        preview: asset.preview,
        previewSource: asset.previewSource 
      });
      
      if (result?.url) {
        addLog(`[Debug] Preview captured: ${result.url.substring(0, 50)}...`);

        const storeCurrentIndex = useStore.getState().currentAssetIndex;
        if (storeCurrentIndex === currentIndex) {
          applyPreviewBackground(result.url);
        }
        
        // Force update the store directly
        console.log('[Debug] Calling updateAssetPreview with index:', currentIndex, 'preview:', asset.preview);
        updateAssetPreview(currentIndex, asset.preview);
        refreshAssets();
        
        // Also save to IndexedDB
        if (result.blob) {
          await savePreviewBlob(asset.name, result.blob, {
            width: result.width,
            height: result.height,
            format: result.format,
          }, asset.previewStorageKey || asset.name);
          addLog(`[Debug] Preview saved to IndexedDB`);
        }
      } else {
        addLog('[Debug] Preview capture returned no result');
      }
    } catch (err) {
      console.error('[Debug] Preview regeneration failed:', err);
      addLog(`[Debug] Preview failed: ${err.message}`);
    } finally {
      setGeneratingPreview(false);
    }
  }, [addLog, updateAssetPreview]);



  // --- Debug upload overlay simulation ---
  const FAKE_FILE_COUNT = 3;
  const FAKE_WARMUP_MS = 10000;
  const FAKE_PER_FILE_MS = 10000;
  // Steps: 0=off, 1=upload, 2=timer running (warmup→processing), 3=checkpoint step1,
  //        4=checkpoint step2, 5=checkpoint step3 (done→transferring), 6=error, 7=off
  const DEBUG_ERROR_DETAIL = `Request URL\nhttps://aero177-jpg--ml-sharp-optimized-process-image.modal.run/\nRequest Method\nPOST\nStatus Code\n400 Bad Request detail\n: \"storageTarget=r2 requires: accessString with s3Endpoint, s3AccessKeyId, s3SecretAccessKey, s3Bucket\"`;
  const stopDebugTimer = useCallback(() => {
    if (debugTimerRef.current) {
      clearInterval(debugTimerRef.current);
      debugTimerRef.current = null;
    }
  }, []);

  const emitDebugProgress = useCallback(() => {
    const s = debugStateRef.current;
    if (!s) return;
    const now = Date.now();
    const dt = now - s.lastTick;
    s.lastTick = now;
    if (!s.remoteComplete) s.elapsed += dt;

    const clamped = Math.min(s.elapsed, s.totalMs);
    const remaining = Math.max(0, s.totalMs - clamped);
    const pct = s.totalMs > 0 ? Math.min(100, (clamped / s.totalMs) * 100) : 100;

    let stage = 'warmup';
    let currentFile = 0;
    if (s.remoteComplete) {
      stage = 'transferring';
      currentFile = FAKE_FILE_COUNT;
    } else if (clamped < FAKE_WARMUP_MS) {
      stage = 'warmup';
    } else {
      stage = 'processing';
      const procElapsed = clamped - FAKE_WARMUP_MS;
      currentFile = Math.min(FAKE_FILE_COUNT, Math.floor(procElapsed / FAKE_PER_FILE_MS) + 1);
    }

    setUploadState({
      isUploading: true,
      uploadProgress: {
        total: FAKE_FILE_COUNT,
        completed: 0,
        stage,
        timer: {
          currentFile,
          totalFiles: FAKE_FILE_COUNT,
          remainingMs: remaining,
          totalMs: s.totalMs,
          percent: pct,
          done: s.remoteComplete,
        },
      },
    });
  }, [setUploadState]);

  const handleDebugOverlayAdvance = useCallback(() => {
    const nextStep = debugOverlayStep + 1;

    if (nextStep === 1) {
      // Upload stage
      setUploadState({
        isUploading: true,
        uploadProgress: { stage: 'upload', upload: { loaded: 0, total: 1, done: false } },
      });
      setDebugOverlayStep(1);
      addLog('[DebugOverlay] → Upload');
      return;
    }

    if (nextStep === 2) {
      // Start timer (warmup → processing)
      const totalMs = FAKE_WARMUP_MS + FAKE_FILE_COUNT * FAKE_PER_FILE_MS;
      debugStateRef.current = {
        elapsed: 0,
        totalMs,
        lastTick: Date.now(),
        lastStep: 0,
        remoteComplete: false,
      };
      stopDebugTimer();
      debugTimerRef.current = setInterval(emitDebugProgress, 500);
      emitDebugProgress();
      setDebugOverlayStep(2);
      addLog('[DebugOverlay] → Timer started (warmup)');
      return;
    }

    // Steps 3-5: inject checkpoints for step 1, 2, 3
    if (nextStep >= 3 && nextStep <= 5) {
      const step = nextStep - 2; // 1, 2, 3
      const s = debugStateRef.current;
      if (s) {
        // step 1 = image 1 starts at warmup, step 2 = image 2 starts at warmup+perFile, etc.
        const expectedMs = FAKE_WARMUP_MS + (step - 1) * FAKE_PER_FILE_MS;
        if (s.elapsed < expectedMs) {
          // Early checkpoint: jump timer forward
          s.elapsed = expectedMs;
          addLog(`[DebugOverlay] → Checkpoint step ${step} (early jump)`);
        } else if (s.elapsed > expectedMs + FAKE_PER_FILE_MS) {
          // Late checkpoint: extend total by 5s
          s.totalMs += 5000;
          addLog(`[DebugOverlay] → Checkpoint step ${step} (late +5s)`);
        } else {
          addLog(`[DebugOverlay] → Checkpoint step ${step} (on time)`);
        }
        s.lastStep = step;
        s.lastTick = Date.now();
        if (step === FAKE_FILE_COUNT) {
          s.remoteComplete = true;
        }
        emitDebugProgress();
      }
      setDebugOverlayStep(nextStep);
      return;
    }

    if (nextStep === 6) {
      stopDebugTimer();
      debugStateRef.current = null;
      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'error',
          error: {
            message: 'Processed failed',
            detail: DEBUG_ERROR_DETAIL,
          },
        },
      });
      setDebugOverlayStep(6);
      addLog('[DebugOverlay] → Error');
      return;
    }

    // Step 7: off
    stopDebugTimer();
    debugStateRef.current = null;
    setUploadState({ isUploading: false, uploadProgress: null });
    setDebugOverlayStep(0);
    addLog('[DebugOverlay] → Off');
  }, [addLog, debugOverlayStep, emitDebugProgress, setUploadState, stopDebugTimer]);

  const debugOverlayLabels = ['Off', 'Upload', 'Timer', 'Step 1', 'Step 2', 'Step 3 → Transfer', 'Error', 'Off'];
  const debugOverlayButtonLabel = debugOverlayStep === 0
    ? 'Start'
    : `Next: ${debugOverlayLabels[debugOverlayStep + 1] || 'Off'}`;

  const sanitizeFileName = useCallback((name, fallback = 'untitled') => {
    if (!name) return fallback;
    return String(name)
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || fallback;
  }, []);

  const downloadBlob = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleExportCurrentAsset = useCallback(async () => {
    if (!currentAsset) throw new Error('No current asset available');
    const file = currentAsset.file
      ? currentAsset.file
      : (isSourceAsset(currentAsset) ? await loadAssetFile(currentAsset) : null);

    if (!file) throw new Error('Unable to load current asset file');
    downloadBlob(file, file.name || sanitizeFileName(currentAsset.name || 'asset'));
    addLog(`[Export] Downloaded ${file.name || currentAsset.name || 'asset'}`);
  }, [addLog, currentAsset, downloadBlob, sanitizeFileName]);

  const handleExportCollection = useCallback(async () => {
    if (!assets.length) throw new Error('No assets to export');

    const totalAssets = assets.length;
    const emitDownloadProgress = (current) => {
      const normalizedCurrent = Math.max(1, Math.min(totalAssets, Number(current) || 1));
      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'downloading',
          download: {
            current: normalizedCurrent,
            total: totalAssets,
          },
          total: totalAssets,
        },
      });
    };

    let exportSucceeded = false;
    const files = {};
    try {
      emitDownloadProgress(1);
      for (let i = 0; i < totalAssets; i += 1) {
        const asset = assets[i];
        emitDownloadProgress(i + 1);
        const assetFile = asset?.file
          ? asset.file
          : (isSourceAsset(asset) ? await loadAssetFile(asset) : null);

        if (!assetFile) {
          throw new Error(`Unable to load asset: ${asset?.name || `#${i + 1}`}`);
        }

        const safeName = sanitizeFileName(assetFile.name || asset?.name || `asset-${i + 1}`);
        const buffer = await assetFile.arrayBuffer();
        files[`assets/${safeName}`] = new Uint8Array(buffer);
      }

      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'packaging',
          message: 'Packaging ZIP',
          total: totalAssets,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const zipData = zipSync(files, { level: 6 });
      const blob = new Blob([zipData], { type: 'application/zip' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeCollectionName = sanitizeFileName(collectionInfo.collectionName, 'collection');
      const filename = `${safeCollectionName}-${stamp}.zip`;
      downloadBlob(blob, filename);
      addLog(`[Export] Downloaded collection ZIP (${totalAssets} assets)`);
      exportSucceeded = true;
    } catch (err) {
      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'error',
          error: {
            message: err?.message || 'Collection export failed',
            detail: err?.message || 'Collection export failed',
          },
        },
      });
      throw err;
    } finally {
      if (exportSucceeded) {
        setUploadState({ isUploading: false, uploadProgress: null });
      }
    }
  }, [addLog, assets, collectionInfo.collectionName, downloadBlob, sanitizeFileName, setUploadState]);


  // If fullscreen is exited while stereo is on, disable stereo to avoid misalignment
  useEffect(() => {
    const handleFsChange = () => {
      const fullscreenRoot = document.getElementById('app');
      const inFullscreen = document.fullscreenElement === fullscreenRoot;
      if (stereoEnabled && !inFullscreen) {
        // Restore background images on exit
        const bgContainers = document.querySelectorAll('.bg-image-container');
        bgContainers.forEach(el => el.classList.remove('stereo-hidden'));
        setStereoEffectEnabled(false);
        setStereoEnabled(false);
        requestRender();
        resize();
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, [stereoEnabled, setStereoEnabled]);

  // Cleanup debug timer on unmount
  useEffect(() => {
    return () => {
      if (debugTimerRef.current) clearInterval(debugTimerRef.current);
    };
  }, []);

  return (
    <>
      <div class="settings-group">
        <button
          class="group-toggle"
          aria-expanded={debugSettingsExpanded}
          onClick={toggleDebugSettingsExpanded}
        >
          <span class="settings-eyebrow">Advanced Settings</span>
          <FontAwesomeIcon icon={faChevronDown} className="chevron" />
        </button>

        <div
          class="group-content"
          style={{ display: debugSettingsExpanded ? 'flex' : 'none' }}
        >
        <div class="settings-divider">
          <span>Viewer</span>
        </div>

        <div class="control-row">
          <span class="control-label">Show FPS</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={showFps}
              onChange={handleFpsToggle}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div class="control-row">
          <span class="control-label">Side-by-side stereo</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={stereoEnabled}
              onChange={handleStereoToggle}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div class="control-row">
          <span class="control-label">Background</span>
          <div class="color-swatch-group">
            {[
              { label: 'Charcoal', value: '#0c0d10' },
              { label: 'Faded blue', value: '#4d5e70' },
              { label: 'Soft white', value: '#e0dbdb' },
              { label: 'Dark green', value: '#576350' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                class={`color-swatch${appBgColor === opt.value ? ' active' : ''}`}
                style={{ background: opt.value }}
                title={opt.label}
                onClick={() => setAppBgColor(opt.value)}
                aria-label={opt.label}
              />
            ))}
          </div>
        </div>

        <div class="control-row">
          <span class="control-label">Image glow</span>
          <div class="control-track">
            <input
              type="range"
              min="0"
              max="40"
              step="1"
              value={bgBlur}
              onInput={(e) => setBgBlur(Number(e.target.value) || 0)}
            />
            <span class="control-value">{bgBlur}px</span>
          </div>
        </div>

        <div class="control-row">
          <span class="control-label">Disable transparent UI</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={disableTransparentUi}
              onChange={(e) => setDisableTransparentUi(e.target.checked)}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div class="settings-divider">
          <span>Cache</span>
        </div>

        <div class="control-row">
          <span class="control-label">Export splats</span>
          <button
            type="button"
            class="secondary"
            onClick={() => setExportModalOpen(true)}
          >
            Export...
          </button>
        </div>

        <div class="control-row">
          <span class="control-label">Restore removed</span>
          <button
            type="button"
            class={`secondary ${isRestoringRemoved ? 'is-busy' : ''}`}
            onClick={handleRestoreRemoved}
            disabled={!activeSourceId || isRestoringRemoved}
          >
            {isRestoringRemoved ? 'Restoring...' : 'Restore'}
          </button>
        </div>

        <div class="control-row">
          <span class="control-label">Regen preview</span>
          <button
            type="button"
            class={`secondary ${generatingPreview ? 'is-busy' : ''}`}
            onClick={handleRegeneratePreview}
            disabled={generatingPreview}
          >
             Capture
          </button>
        </div>

        {currentAssetHasCustomMetadata && (
          <div class="control-row">
            <span class="control-label">Clear custom metadata</span>
            <button
              type="button"
              class="secondary danger"
              onClick={handleClearCustomMetadata}
              disabled={isClearing}
            >
              {isClearing ? 'Clearing...' : '🗑️ Clear Custom Metadata'}
            </button>
          </div>
        )}

        <div class="control-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span class="control-label">Batch previews</span>
            {generatingBatch ? (
              <button
                type="button"
                class="secondary danger"
                onClick={handleAbortBatchPreview}
              >
                Abort
              </button>
            ) : (
              <button
                type="button"
                class={`secondary ${!canBatchGeneratePreviews ? 'batch-preview-disabled' : ''}`}
                onClick={handleOpenBatchPreviewModal}
                disabled={!canBatchGeneratePreviews}
              >
                Generate All
              </button>
            )}
          </div>
          {batchProgress && (
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
              <div style={{ marginBottom: '4px' }}>
                {batchProgress.current}/{batchProgress.total}: {batchProgress.name}
              </div>
              <div
                style={{
                  height: '4px',
                  background: 'var(--color-bg-tertiary)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                    background: 'var(--color-accent)',
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div class="control-row">
          <span class="control-label">Transfer bundle</span>
          <button
            type="button"
            class="secondary"
            onClick={() => setTransferModalOpen(true)}
          >
            Open...
          </button>
        </div>

        <div class="control-row">
          <span class="control-label">Clear data</span>
          <button
            type="button"
            class="secondary danger"
            onClick={() => setClearDataModalOpen(true)}
          >
            Clear...
          </button>
        </div>

        <div class="settings-divider">
          <span>Performance </span>
        </div>

        {/* <div class="control-row">
          <span class="control-label">Upload overlay</span>
          <button
            type="button"
            class="secondary"
            onClick={handleDebugOverlayAdvance}
          >
            {debugOverlayButtonLabel}
          </button>
        </div> */}

        <div class="control-row">
          <span class="control-label">Stochastic rendering</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={debugStochasticRendering}
              onChange={handleStochasticToggle}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div class="control-row">
          <span class="control-label">Limit FPS (60)</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={debugFpsLimitEnabled}
              onChange={handleFpsLimitToggle}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div class="control-row">
          <span class="control-label">Splat width</span>
          <div class="control-track">
            <input
              type="range"
              min="0.5"
              max="8"
              step="0.1"
              value={debugSparkMaxStdDev}
              onInput={handleSparkStdDevChange}
            />
            <span class="control-value">{debugSparkMaxStdDev.toFixed(2)}</span>
          </div>
        </div>

        </div>
      </div>

      <TransferDataModal
        isOpen={transferModalOpen}
        onClose={() => setTransferModalOpen(false)}
        addLog={addLog}
      />
      <ClearDataModal
        isOpen={clearDataModalOpen}
        onClose={() => setClearDataModalOpen(false)}
        addLog={addLog}
      />
      <ExportChoiceModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onExportAsset={handleExportCurrentAsset}
        onExportCollection={handleExportCollection}
        assetTitle={currentAsset?.name || 'Current image'}
        assetSubtitle={`Size: ${formatBytes(currentAssetSize)}`}
        collectionTitle={collectionInfo.collectionName}
        collectionSubtitle={
          collectionInfo.allSizesKnown
            ? `${collectionInfo.totalAssets} assets · ${formatBytes(collectionInfo.totalSize)}`
            : `${collectionInfo.totalAssets} assets · ${collectionInfo.estimatedBytes ? `~${formatBytes(collectionInfo.estimatedBytes)} est.` : 'Size unknown'}`
        }
        assetDisabled={!currentAsset}
        collectionDisabled={collectionInfo.totalAssets === 0}
        note={
          collectionInfo.allSizesKnown
            ? ''
            : (collectionInfo.estimatedBytes
              ? `Estimate based on ${collectionInfo.sogCount} .sog file${collectionInfo.sogCount === 1 ? '' : 's'} × 11MB.`
              : '')
        }
      />
      <BatchPreviewModal
        isOpen={batchPreviewModalOpen}
        onClose={handleCloseBatchPreviewModal}
        onConfirm={handleConfirmBatchPreview}
        onAbort={handleAbortBatchPreview}
        assetCount={assets.length}
        isBusy={generatingBatch}
        batchProgress={batchProgress}
        batchResult={batchResult}
      />
    </>
  );
}
export default DebugSettings;
