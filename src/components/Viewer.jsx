/**
 * Viewer component.
 * Three.js canvas wrapper that handles:
 * - Mouse/touch interactions (double-click to set anchor)
 * - Keyboard shortcuts for navigation and view control
 */

import { useEffect, useCallback, useRef, useState } from 'preact/hooks';
import { useStore } from '../store';
import { 
  camera, 
  controls, 
  renderer, 
  raycaster,
  scene,
  currentMesh, 
  setCurrentMesh,
  updateDollyZoomBaselineFromCamera,
  requestRender,
  THREE,
  SplatMesh,
} from '../viewer';
import { restoreHomeView, resetViewWithImmersive } from '../cameraUtils';
import { startAnchorTransition } from '../cameraAnimations';
import { cancelLoadZoomAnimation } from '../customAnimations';
import { cancelContinuousZoomAnimation, cancelContinuousOrbitAnimation, cancelContinuousVerticalOrbitAnimation } from '../cameraAnimations';
import { startSlideshow, stopSlideshow, isSlideshowPaused } from '../slideshowController';
import { loadFromStorageSource, loadNextAsset, loadPrevAsset, resize } from '../fileLoader';
import { resetSplatManager } from '../splatManager';
import { clearBackground } from '../backgroundManager';
import { getSource } from '../storage/index.js';
import { loadR2Settings } from '../storage/r2Settings.js';
import { unlockCredentialVault } from '../storage/credentialVault.js';
import { registerTapListener } from '../utils/tapDetector';
import ViewerEmptyState from './ViewerEmptyState.jsx';
import UploadStatusOverlay from './UploadStatusOverlay.jsx';
import R2UnlockState from './R2UnlockState.jsx';


/** Tags that should not trigger keyboard shortcuts */
const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

/**
 * Checks if an event target is an input element.
 * @param {EventTarget} target - Event target to check
 * @returns {boolean} True if target is an input element
 */
const isInputElement = (target) => {
  const tag = target?.tagName;
  return INPUT_TAGS.has(tag) || target?.isContentEditable;
};

/**
 * Formats a 3D point for logging.
 * @param {THREE.Vector3} point - Point to format
 * @returns {string} Formatted string
 */
const formatPoint = (point) => 
  `${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}`;


function Viewer({ viewerReady, dropOverlay, startEmptyOnInitialCollectionRoute = false }) {
  // Store state
  const debugLoadingMode = useStore((state) => state.debugLoadingMode);
  const metadataMissing = useStore((state) => state.metadataMissing);
  const isUploading = useStore((state) => state.isUploading);
  const uploadProgress = useStore((state) => state.uploadProgress);
  const setUploadState = useStore((state) => state.setUploadState);
  const isLoading = useStore((state) => state.isLoading);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const activeSourceId = useStore((state) => state.activeSourceId);
  const panelOpen = useStore((state) => state.panelOpen);
  const assetSidebarOpen = useStore((state) => state.assetSidebarOpen);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const isMobile = useStore((state) => state.isMobile);
  const isPortrait = useStore((state) => state.isPortrait);
  const expandedViewer = useStore((state) => state.expandedViewer);
  const transitionSpeed = useStore((state) => state.transitionSpeed);
  const setAnchorState = useStore((state) => state.setAnchorState);
  const setCustomMetadataControlsVisible = useStore((state) => state.setCustomMetadataControlsVisible);
  const setCameraSettingsExpanded = useStore((state) => state.setCameraSettingsExpanded);
  const setViewerControlsDimmed = useStore((state) => state.setViewerControlsDimmed);
  const setPanelOpen = useStore((state) => state.setPanelOpen);
  const setStatus = useStore((state) => state.setStatus);
  const clearActiveSource = useStore((state) => state.clearActiveSource);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const toggleViewerControlsDimmed = useStore((state) => state.toggleViewerControlsDimmed);
  
  // Store actions
  const addLog = useStore((state) => state.addLog);
  const togglePanel = useStore((state) => state.togglePanel);

  const showEmptyState = Boolean(activeSourceId) && assets.length === 0 && !isLoading;
  const activeSource = activeSourceId ? getSource(activeSourceId) : null;
  const r2BaseSettings = activeSource?.type === 'r2-bucket' ? loadR2Settings() : null;
  const requiresR2Unlock = Boolean(
    showEmptyState
    && activeSource?.type === 'r2-bucket'
    && r2BaseSettings?.requiresPassword
    && r2BaseSettings?.accountId === activeSource?.config?.config?.accountId
    && r2BaseSettings?.bucket === activeSource?.config?.config?.bucket
  );

  const handleDismissUploadError = useCallback(() => {
    setUploadState({ isUploading: false, uploadProgress: null });
  }, [setUploadState]);

  const handleOpenCustomMetadataEditor = useCallback(() => {
    setCustomMetadataControlsVisible(true);
    setCameraSettingsExpanded(true);
    setPanelOpen(true);
  }, [setCustomMetadataControlsVisible, setCameraSettingsExpanded, setPanelOpen]);

  const handleUnlockR2Collection = useCallback(async (password) => {
    const vault = await unlockCredentialVault(password);
    if (!vault.success) {
      return { success: false, error: vault.error || 'Vault unlock failed.' };
    }

    if (!activeSource) {
      return { success: false, error: 'Collection source is unavailable.' };
    }

    const connectResult = await activeSource.connect(false);
    if (!connectResult?.success) {
      return { success: false, error: connectResult?.error || 'Failed to reconnect source.' };
    }

    try {
      await loadFromStorageSource(activeSource);
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  }, [activeSource]);

  const handleGoHomeFromR2Lock = useCallback(() => {
    if (window.location.pathname !== '/') {
      window.location.replace('/');
      return;
    }

    clearActiveSource();
    setAssets([]);
    setCurrentAssetIndex(-1);
    resetSplatManager();
    setCurrentMesh(null);
    clearBackground();
    const pageEl = document.querySelector('.page');
    if (pageEl) {
      pageEl.classList.remove('has-glow');
    }
    requestRender();
    setStatus('Returned to home.');
  }, [clearActiveSource, setAssets, setCurrentAssetIndex, setStatus]);
  
  // Ref for viewer container
  const viewerRef = useRef(null);

  const [hasMesh, setHasMesh] = useState(false);
  const hasMeshRef = useRef(false);
  const [hideForInitialCollectionLoad, setHideForInitialCollectionLoad] = useState(startEmptyOnInitialCollectionRoute);
  const [showLargeFileNotice, setShowLargeFileNotice] = useState(false);
  const largeFileTimeoutRef = useRef(null);
  const [currentMeshAssetId, setCurrentMeshAssetId] = useState(null);
  const lastTapTimeRef = useRef(0);
  const cursorIdleTimeoutRef = useRef(null);

  const { hasOriginalMetadata, customMetadataMode } = useStore();

  /**
   * Smoothly shift viewer up when the mobile bottom sheet overlaps it.
   * Only shifts if the overlap is real (viewer bottom > sheet top), and
   * clamps so the viewer top edge never leaves the viewport.
   */
  useEffect(() => {
    const viewerEl = viewerRef.current;
    if (!viewerEl) return;

    // Only relevant in mobile portrait mode
    if (!isMobile || !isPortrait) {
      viewerEl.style.setProperty('--viewer-shift-y', '0px');
      return;
    }

    const SHEET_OPEN_VH = 40; // matches CSS max-height: 40dvh
    const PAGE_PADDING_BOTTOM = 50; // px reserved for closed sheet handle
    const SAFETY_MARGIN = 12; // px gap between viewer bottom and sheet top

    const SKIP_THRESHOLD = 0.8; // don't bother shifting if viewer fills >80% of height
    const EXTRA_CLEARANCE = 100; // extra px to push smaller viewers fully clear

    const computeShift = () => {
      const vh = window.innerHeight;
      const viewerHeight = viewerEl.offsetHeight;

      if (!panelOpen) {
        viewerEl.style.setProperty('--viewer-shift-y', '0px');
        return;
      }

      // Skip shift for near-fullscreen viewers — moving won't help
      if (viewerHeight / vh >= SKIP_THRESHOLD) {
        viewerEl.style.setProperty('--viewer-shift-y', '0px');
        return;
      }

      // The viewer is flex-centered in (vh - PAGE_PADDING_BOTTOM)
      const contentHeight = vh - PAGE_PADDING_BOTTOM;
      const viewerTop = (contentHeight - viewerHeight) / 2;
      const viewerBottom = viewerTop + viewerHeight;

      const sheetHeight = vh * (SHEET_OPEN_VH / 100);
      const sheetTop = vh - sheetHeight;
      const overlap = viewerBottom - sheetTop + SAFETY_MARGIN;

      if (overlap <= 0) {
        viewerEl.style.setProperty('--viewer-shift-y', '0px');
        return;
      }

      // For shorter viewers, add extra clearance so they clear the sheet entirely
      const desiredShift = overlap + EXTRA_CLEARANCE;
      // Cap so viewer top stays at least 4px inside the viewport
      const maxShift = Math.max(0, viewerTop - 4);
      const shift = Math.min(desiredShift, maxShift);

      viewerEl.style.setProperty('--viewer-shift-y', `${-shift}px`);
    };

    computeShift();

    // Recompute on resize (orientation changes, keyboard, etc.)
    window.addEventListener('resize', computeShift);
    return () => {
      window.removeEventListener('resize', computeShift);
    };
  }, [panelOpen, isMobile, isPortrait]);

  const showEmptyUploadStatus = showEmptyState
    && isUploading
    && (uploadProgress?.total || uploadProgress?.upload?.total || uploadProgress?.estimate);

  useEffect(() => {
    if (!metadataMissing) return;
    setViewerControlsDimmed(false);
  }, [metadataMissing, setViewerControlsDimmed]);

  const currentAsset = currentAssetIndex >= 0 ? assets[currentAssetIndex] : null;
  const currentAssetSize = currentAsset?.file?.size ?? currentAsset?.size ?? 0;

  useEffect(() => {
    if (!hideForInitialCollectionLoad) return;
    // Reveal when: empty state (error/no assets), or loading finishes with assets
    const shouldRevealViewer = showEmptyState || (!isLoading && hasMesh);
    if (shouldRevealViewer) {
      // Delay reveal so the viewer's slide-in CSS transition (0.6s + 0.2s delay)
      // and renderer warmup complete while the wrapper is still invisible —
      // avoids a flash of partially-rendered content on direct /collection URL loads.
      const timer = setTimeout(() => setHideForInitialCollectionLoad(false), 650);
      return () => clearTimeout(timer);
    }
  }, [hideForInitialCollectionLoad, showEmptyState, hasMesh, isLoading, assets.length]);

  useEffect(() => {
    if (!showEmptyState) return;
    if (!currentMesh) return;

    resetSplatManager();
    setCurrentMesh(null);
    clearBackground();
    const pageEl = document.querySelector('.page');
    if (pageEl) {
      pageEl.classList.remove('has-glow');
    }
    requestRender();
  }, [showEmptyState]);

  /**
   * Track mesh loading state - only update state when value changes
   * to avoid unnecessary re-renders during animations
   */
  useEffect(() => {
    const checkMesh = () => {
      const meshPresent = !!currentMesh;
      const meshAssetId = currentMesh?.userData?.assetId || null;
      if (meshPresent !== hasMeshRef.current) {
        hasMeshRef.current = meshPresent;
        setHasMesh(meshPresent);
      }
      setCurrentMeshAssetId((prev) => (prev === meshAssetId ? prev : meshAssetId));
    };
    
    // Check immediately and set up interval to poll
    checkMesh();
    const interval = setInterval(checkMesh, 100);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (largeFileTimeoutRef.current) {
      clearTimeout(largeFileTimeoutRef.current);
      largeFileTimeoutRef.current = null;
    }

    setShowLargeFileNotice(false);

    const isLarge = Number.isFinite(currentAssetSize) && currentAssetSize >= 100 * 1024 * 1024;
    // The mesh's userData.assetId is the cache key (baseAssetId), so for
    // proxy views we must also compare against cacheKey/baseAssetId — not
    // just the proxy's unique id — to avoid a false "Loading..." notice
    // when switching between views of an already-loaded splat.
    const meshId = currentMeshAssetId;
    const assetId = currentAsset?.id;
    const baseMeshId = currentAsset?.cacheKey || currentAsset?.baseAssetId;
    const isCurrentMeshActive = assetId && (meshId === assetId || meshId === baseMeshId);
    if (!isLarge || isCurrentMeshActive) return;

    largeFileTimeoutRef.current = setTimeout(() => {
      // Re-read current values from the asset at timeout time
      const stillActive = assetId && meshId !== assetId && meshId !== baseMeshId;
      if (stillActive) {
        setShowLargeFileNotice(true);
      }
    }, 2000);

    return () => {
      if (largeFileTimeoutRef.current) {
        clearTimeout(largeFileTimeoutRef.current);
        largeFileTimeoutRef.current = null;
      }
    };
  }, [currentAssetSize, currentAsset?.id, currentMeshAssetId]);


  /**
   * Handles reset view - uses shared function that handles immersive mode.
   */
  const handleResetView = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  /**
   * Sets up event listeners for viewer interactions.
   * Runs after viewer is initialized.
   */
  useEffect(() => {
    // Wait for viewer to be initialized
    if (!viewerReady || !controls || !renderer) {
      return;
    }

    const shouldIgnoreViewerInput = () => panelOpen || assetSidebarOpen;

    const handleTap = () => {
      const now = Date.now();
      if (now - lastTapTimeRef.current < 300) return;
      lastTapTimeRef.current = now;

      if (slideshowPlaying) {
        stopSlideshow();
        return;
      }

      if (metadataMissing || useStore.getState().customMetadataControlsVisible) {
        return;
      }
      toggleViewerControlsDimmed();
    };

    const unregisterTapListener = registerTapListener(renderer.domElement, {
      onTap: handleTap,
      shouldIgnore: shouldIgnoreViewerInput,
      maxDurationMs: 500,
      maxMovePx: 10,
    });

    const LONG_PRESS_MS = 400;
    const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
    const longPressState = {
      pointerId: null,
      startX: 0,
      startY: 0,
      moved: false,
      triggered: false,
      timeoutId: null,
    };

    const clearLongPressTimer = () => {
      if (longPressState.timeoutId) {
        clearTimeout(longPressState.timeoutId);
        longPressState.timeoutId = null;
      }
    };

    const cancelLongPress = () => {
      clearLongPressTimer();
      longPressState.pointerId = null;
      longPressState.moved = false;
      longPressState.triggered = false;
    };

    const handleLongPressPointerDown = (event) => {
      if (shouldIgnoreViewerInput()) return;
      if (event.button != null && event.button !== 0) return;
      if (longPressState.pointerId != null) return;

      longPressState.pointerId = event.pointerId;
      longPressState.startX = event.clientX;
      longPressState.startY = event.clientY;
      longPressState.moved = false;
      longPressState.triggered = false;

      clearLongPressTimer();
      longPressState.timeoutId = setTimeout(() => {
        if (longPressState.pointerId == null || longPressState.moved) return;
        longPressState.triggered = true;
        handleResetView();
      }, LONG_PRESS_MS);
    };

    const handleLongPressPointerMove = (event) => {
      if (longPressState.pointerId == null) return;
      if (event.pointerId !== longPressState.pointerId) return;
      if (longPressState.moved) return;

      const dx = event.clientX - longPressState.startX;
      const dy = event.clientY - longPressState.startY;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) {
        longPressState.moved = true;
        clearLongPressTimer();
      }
    };

    const handleLongPressPointerUp = (event) => {
      if (longPressState.pointerId == null) return;
      if (event.pointerId !== longPressState.pointerId) return;
      cancelLongPress();
    };

    const handleLongPressPointerCancel = (event) => {
      if (longPressState.pointerId == null) return;
      if (event.pointerId !== longPressState.pointerId) return;
      cancelLongPress();
    };

    /**
     * Cancels any running load zoom animation.
     * Called on user interaction to allow manual control.
     */
    const cancelLoadZoomOnUserInput = () => {
      if (shouldIgnoreViewerInput()) return;
      cancelLoadZoomAnimation();
      const st = useStore.getState();
      if (st.slideshowPlaying) {
        // Auto-pause — preserves tweens + timer for glide-back resume
        stopSlideshow();
      } else if (!isSlideshowPaused()) {
        // Not in a slideshow session — kill continuous tweens normally.
        // Guard: if we're paused (snapshot exists), leave tweens alone
        // so resume can glide back and continue from where it left off.
        cancelContinuousZoomAnimation();
        cancelContinuousOrbitAnimation();
        cancelContinuousVerticalOrbitAnimation();
      }
    };

    // Cancel animation on any user input
    controls.addEventListener('start', cancelLoadZoomOnUserInput);
    renderer.domElement.addEventListener('pointerdown', cancelLoadZoomOnUserInput);
    renderer.domElement.addEventListener('wheel', cancelLoadZoomOnUserInput, { passive: true });
    renderer.domElement.addEventListener('touchstart', cancelLoadZoomOnUserInput);
    renderer.domElement.addEventListener('pointerdown', handleLongPressPointerDown, { passive: true });
    renderer.domElement.addEventListener('pointermove', handleLongPressPointerMove, { passive: true });
    renderer.domElement.addEventListener('pointerup', handleLongPressPointerUp, { passive: true });
    renderer.domElement.addEventListener('pointercancel', handleLongPressPointerCancel, { passive: true });

    /**
     * Handles double-click to set new orbit anchor point.
     * Raycasts to find splat under cursor and animates to that point.
     * @param {MouseEvent} event - Double-click event
     */
    const handleDoubleClick = (event) => {
      if (!currentMesh) return;

      // Convert screen coordinates to normalized device coordinates
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      // Raycast to find splat intersection
      raycaster.setFromCamera(mouse, camera);
      const intersects = [];
      raycaster.intersectObjects(scene.children, true, intersects);
      const splatHit = intersects.find((i) => i.object instanceof SplatMesh) ?? null;

      if (splatHit) {
        // Animate to hit point
        startAnchorTransition(splatHit.point, {
          duration: 700,
          onComplete: () => {
            updateDollyZoomBaselineFromCamera();
            requestRender();
          },
        });
        setAnchorState({
          active: true,
          distance: typeof splatHit.distance === 'number' ? splatHit.distance : null,
        });
        const distanceText = splatHit.distance != null 
          ? ` (distance: ${splatHit.distance.toFixed(2)})` 
          : '';
        addLog(`Anchor set: ${formatPoint(splatHit.point)}${distanceText}`);
      } else {
        addLog('No splat found under cursor for anchor');
      }
    };

    renderer.domElement.addEventListener('dblclick', handleDoubleClick);

    /**
     * Global keyboard shortcuts handler.
     * - T: Toggle side panel
     * - Space: Reset to home view
     * - Arrow keys: Navigate between assets
     * @param {KeyboardEvent} event - Keyboard event
     */
    const handleKeydown = (event) => {
      // Ignore when typing in input fields
      if (isInputElement(event.target)) {
        return;
      }

      if (document.querySelector('.modal-overlay')) {
        return;
      }

      cancelLoadZoomAnimation();


      if (event.code === 'KeyR' || event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        restoreHomeView();
        return;
      }

      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        if (slideshowPlaying) {
          stopSlideshow();
        } else {
          startSlideshow();
        }
        return;
      }

      // Arrow key navigation
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        loadNextAsset();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        loadPrevAsset();
        return;
      }
    };

    document.addEventListener('keydown', handleKeydown);

    return () => {
      if (controls) {
        controls.removeEventListener('start', cancelLoadZoomOnUserInput);
      }
      if (renderer?.domElement) {
        renderer.domElement.removeEventListener('pointerdown', cancelLoadZoomOnUserInput);
        renderer.domElement.removeEventListener('wheel', cancelLoadZoomOnUserInput);
        renderer.domElement.removeEventListener('touchstart', cancelLoadZoomOnUserInput);
        renderer.domElement.removeEventListener('pointerdown', handleLongPressPointerDown);
        renderer.domElement.removeEventListener('pointermove', handleLongPressPointerMove);
        renderer.domElement.removeEventListener('pointerup', handleLongPressPointerUp);
        renderer.domElement.removeEventListener('pointercancel', handleLongPressPointerCancel);
        renderer.domElement.removeEventListener('dblclick', handleDoubleClick);
      }
      clearLongPressTimer();
      document.removeEventListener('keydown', handleKeydown);
      unregisterTapListener();
    };
  }, [viewerReady, addLog, togglePanel, setAnchorState, panelOpen, assetSidebarOpen, slideshowPlaying, metadataMissing, toggleViewerControlsDimmed, handleResetView]);

  useEffect(() => {
    const viewerEl = viewerRef.current;
    if (!viewerEl) return;

    const CURSOR_IDLE_MS = 500;

    const clearCursorTimeout = () => {
      if (cursorIdleTimeoutRef.current) {
        clearTimeout(cursorIdleTimeoutRef.current);
        cursorIdleTimeoutRef.current = null;
      }
    };

    const showCursor = () => {
      viewerEl.classList.remove('cursor-hidden');
    };

    const hideCursor = () => {
      viewerEl.classList.add('cursor-hidden');
    };

    const scheduleCursorHide = () => {
      if (!slideshowPlaying) return;
      clearCursorTimeout();
      showCursor();
      cursorIdleTimeoutRef.current = setTimeout(() => {
        if (slideshowPlaying) {
          hideCursor();
        }
      }, CURSOR_IDLE_MS);
    };

    const handleActivity = () => {
      if (!slideshowPlaying) return;
      scheduleCursorHide();
    };

    if (slideshowPlaying) {
      scheduleCursorHide();
    } else {
      clearCursorTimeout();
      showCursor();
    }

    viewerEl.addEventListener('pointermove', handleActivity);
    viewerEl.addEventListener('pointerdown', handleActivity);
    viewerEl.addEventListener('wheel', handleActivity, { passive: true });
    viewerEl.addEventListener('touchstart', handleActivity, { passive: true });
    document.addEventListener('keydown', handleActivity);

    return () => {
      clearCursorTimeout();
      viewerEl.classList.remove('cursor-hidden');
      viewerEl.removeEventListener('pointermove', handleActivity);
      viewerEl.removeEventListener('pointerdown', handleActivity);
      viewerEl.removeEventListener('wheel', handleActivity);
      viewerEl.removeEventListener('touchstart', handleActivity);
      document.removeEventListener('keydown', handleActivity);
    };
  }, [slideshowPlaying]);

  return (
    <div class={`viewer-shell ${expandedViewer ? 'is-expanded' : ''}`} ref={viewerRef}>
      <div id="viewer" class={`viewer ${debugLoadingMode ? 'loading' : ''} ${showEmptyState ? 'is-empty' : ''} ${hideForInitialCollectionLoad && !showEmptyState ? 'initial-collection-empty' : ''} ${expandedViewer ? 'is-expanded' : ''} ${transitionSpeed === 'snappy' ? 'speed-snappy' : ''}`}>
        <div class="loading-overlay">
        </div>
      </div>
      <div class="viewer-overlays">
        {dropOverlay}
        {requiresR2Unlock && (
          <R2UnlockState
            sourceName={activeSource?.name}
            onUnlock={handleUnlockR2Collection}
            onBack={handleGoHomeFromR2Lock}
          />
        )}
        {showEmptyState && !showEmptyUploadStatus && !requiresR2Unlock && (
          <ViewerEmptyState source={activeSource} />
        )}
        {showEmptyUploadStatus && (
          <div class="viewer-empty-state">
            <UploadStatusOverlay
              isUploading={isUploading}
              uploadProgress={uploadProgress}
              variant="first-load"
              onDismiss={handleDismissUploadError}
            />
          </div>
        )}
        {!showEmptyState && (
          <UploadStatusOverlay
            isUploading={isUploading}
            uploadProgress={uploadProgress}
            onDismiss={handleDismissUploadError}
          />
        )}
        {metadataMissing && (
          <div class="metadata-warning">
            <span>No metadata detected.</span>
            <button
              type="button"
              class="metadata-action-btn"
              onClick={handleOpenCustomMetadataEditor}
            >
              Adjust custom camera
            </button>
          </div>
        )}
        {!hasOriginalMetadata && customMetadataMode && (
          <div className="metadata-missing-overlay" >
            <div className="metadata-missing-badge">
              <span className="metadata-missing-icon">⚠️</span>
              <span className="metadata-missing-text">
                No metadata detected
              </span>
            </div>
            <div className="metadata-missing-hint">
              Adjust custom camera to save a new view
            </div>
            <button
              type="button"
              className="metadata-action-btn"
              onClick={handleOpenCustomMetadataEditor}
            >
              Adjust custom camera
            </button>
          </div>
        )}
        {showLargeFileNotice && (
            <div className="metadata-warning" style={{height: "40px", padding: "8px 14px"}}>
              <span className="large-file-spinner" aria-hidden="true" />
              <span>Loading file...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default Viewer;
