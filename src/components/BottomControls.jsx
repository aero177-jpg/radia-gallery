/**
 * Bottom controls container for navigation, fullscreen, and camera actions.
 */

import { useCallback, useRef } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpandAlt, faCompressAlt } from '@fortawesome/free-solid-svg-icons';
import { FocusIcon, Rotate3DIcon } from '../icons/customIcons';
import { useStore } from '../store';
import { camera, controls, defaultCamera, defaultControls, dollyZoomBaseDistance, dollyZoomBaseFov, requestRender, THREE, resetViewer } from '../viewer';
import { resize, reloadCurrentAsset } from '../fileLoader';
import { resetViewWithImmersive } from '../cameraUtils';
import { enableImmersiveMode, disableImmersiveMode, setImmersiveSensitivityMultiplier, setTouchPanEnabled, syncImmersiveBaseline } from '../immersiveMode';
import { resetSplatManager, updateAnnotationInCache } from '../splatManager';
import { saveAnnotation } from '../fileStorage';
import { initVrSupport } from '../vrMode';
import useHasMesh from '../utils/useHasMesh';
import useControlsReveal from '../utils/useControlsReveal';
import AssetNavigation from './AssetNavigation';

const updateControlSpeedsForFov = (fov) => {
  if (!controls) return;
  const fovScale = THREE.MathUtils.clamp(fov / defaultCamera.fov, 0.05, 2.0);
  controls.rotateSpeed = Math.max(0.02, defaultControls.rotateSpeed * fovScale * 0.45);
  controls.zoomSpeed = Math.max(0.05, defaultControls.zoomSpeed * fovScale * 0.8);
  controls.panSpeed = Math.max(0.05, defaultControls.panSpeed * fovScale * 0.8);
};

function BottomControls({ onOpenSlideshowOptions }) {
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const toggleAssetSidebar = useStore((state) => state.toggleAssetSidebar);
  const fov = useStore((state) => state.fov);
  const setFov = useStore((state) => state.setFov);
  const viewerFovSlider = useStore((state) => state.viewerFovSlider);
  const immersiveMode = useStore((state) => state.immersiveMode);
  const setImmersiveMode = useStore((state) => state.setImmersiveMode);
  const immersiveSensitivity = useStore((state) => state.immersiveSensitivity);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const viewerControlsDimmed = useStore((state) => state.viewerControlsDimmed);
  const expandedViewer = useStore((state) => state.expandedViewer);
  const toggleExpandedViewer = useStore((state) => state.toggleExpandedViewer);
  const isMobile = useStore((state) => state.isMobile);
  const addLog = useStore((state) => state.addLog);
  const disableTransparentUi = useStore((state) => state.disableTransparentUi);
  const annotation = useStore((state) => state.annotation);
  const setAnnotation = useStore((state) => state.setAnnotation);

  const hasMesh = useHasMesh();
  const resetHoldTimeout = useRef(null);
  const resetHoldTriggered = useRef(false);

  const { controlsRevealed, revealBottomControls } = useControlsReveal({ slideshowPlaying });

  const handleResetView = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  const handleHardResetView = useCallback(async () => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    resetViewer(viewerEl, { preserveBackground: true });
    resetSplatManager();
    void initVrSupport(viewerEl);

    await reloadCurrentAsset();
    resize();
    requestRender();
  }, []);

  const handleResetHoldStart = useCallback(() => {
    resetHoldTriggered.current = false;
    if (resetHoldTimeout.current) {
      clearTimeout(resetHoldTimeout.current);
    }
    resetHoldTimeout.current = setTimeout(() => {
      resetHoldTriggered.current = true;
      handleHardResetView();
      resetHoldTimeout.current = null;
    }, 2000);
  }, [handleHardResetView]);

  const handleResetHoldEnd = useCallback(() => {
    if (resetHoldTimeout.current) {
      clearTimeout(resetHoldTimeout.current);
      resetHoldTimeout.current = null;
    }
  }, []);

  const handleResetButtonClick = useCallback(() => {
    if (resetHoldTriggered.current) {
      resetHoldTriggered.current = false;
      return;
    }
    handleResetView();
  }, [handleResetView]);

  const handleOverlayFovChange = useCallback((event) => {
    const newFov = Number(event.target.value);
    if (!Number.isFinite(newFov) || !camera || !controls) return;

    setFov(newFov);

    if (dollyZoomBaseDistance && dollyZoomBaseFov) {
      const baseTan = Math.tan(THREE.MathUtils.degToRad(dollyZoomBaseFov / 2));
      const newTan = Math.tan(THREE.MathUtils.degToRad(newFov / 2));
      const newDistance = dollyZoomBaseDistance * (baseTan / newTan);

      const direction = new THREE.Vector3()
        .subVectors(camera.position, controls.target)
        .normalize();
      camera.position.copy(controls.target).addScaledVector(direction, newDistance);
    }

    camera.fov = newFov;
    camera.updateProjectionMatrix();
    updateControlSpeedsForFov(newFov);
    controls.update();
    if (immersiveMode) {
      syncImmersiveBaseline();
    }
    requestRender();
  }, [setFov, immersiveMode]);

  const handleImmersiveToggle = useCallback(async () => {
    if (immersiveMode) {
      disableImmersiveMode();
      setImmersiveMode(false);
      addLog('Immersive mode disabled');
      return;
    }

    setTouchPanEnabled(true);
    setImmersiveSensitivityMultiplier(immersiveSensitivity);
    const success = await enableImmersiveMode();
    if (success) {
      setImmersiveMode(true);
      addLog('Immersive mode enabled - tilt device to orbit');
    } else {
      setImmersiveMode(false);
      addLog('Could not enable immersive mode');
    }
  }, [immersiveMode, setImmersiveMode, addLog, immersiveSensitivity]);

  const handleToggleExpandedViewer = useCallback(() => {
    toggleExpandedViewer();

    requestAnimationFrame(() => {
      resize();
      requestRender();
    });
  }, [toggleExpandedViewer]);

  const currentAsset = currentAssetIndex >= 0 && currentAssetIndex < assets.length
    ? assets[currentAssetIndex]
    : null;
  const annotationText = typeof annotation === 'string' ? annotation : '';

  const handleAnnotationInput = useCallback((event) => {
    const nextAnnotation = event?.target?.value ?? '';
    setAnnotation(nextAnnotation);

    const fileName = currentAsset?.baseAssetName || currentAsset?.name;
    const assetId = currentAsset?.cacheKey || currentAsset?.baseAssetId || currentAsset?.id;
    if (!fileName) return;

    saveAnnotation(fileName, nextAnnotation).then((saved) => {
      if (!saved) return;
      if (assetId) {
        updateAnnotationInCache(assetId, nextAnnotation);
      }
    }).catch((err) => {
      console.warn('[BottomControls] Failed to save annotation', err);
    });
  }, [setAnnotation, currentAsset]);

  const assetsLength = assets.length;
  return (
    <>
      {assetsLength > 0 && (
        <div class={`page-annotation-overlay${slideshowPlaying || viewerControlsDimmed ? ' slideshow-hide' : ''}${controlsRevealed ? ' is-revealed' : ''}`}>
           {/* <input
            type="text"
            placeholder="annotation"
            size="18"
            value={annotationText}
            onInput={handleAnnotationInput}
          /> */}
          {annotationText && (
            <div class="bottom-page-label bottom-page-btn" title={annotationText}>
              {annotationText}
            </div>
          )}
        </div>
      )}

      <div
        class={`bottom-controls${slideshowPlaying || viewerControlsDimmed ? ' slideshow-hide' : ''}${controlsRevealed ? ' is-revealed' : ''}${disableTransparentUi ? ' no-transparent-ui' : ''}`}
        onPointerEnter={() => slideshowPlaying && revealBottomControls(false)}
        onPointerLeave={() => slideshowPlaying && revealBottomControls(true, 1000)}
        onPointerDown={() => slideshowPlaying && revealBottomControls(true, 1000)}
      >
        <div class="bottom-controls-left">
            {assetsLength > 0 && (
            <button
              class="bottom-page-btn"
              onClick={handleToggleExpandedViewer}
              aria-label={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
              title={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
            >
              <FontAwesomeIcon icon={expandedViewer ? faCompressAlt : faExpandAlt} />
            </button>
            )}
            {assetsLength > 0 && (
              <button
                class="bottom-page-btn"
                onClick={toggleAssetSidebar}
                title="Open asset browser"
              >
                {currentAssetIndex + 1} / {assetsLength}
              </button>
            )}
        </div>

      {hasMesh && assetsLength > 0 && (
        <>
          <div class="bottom-controls-center">
            <div class="bottom-controls-center-inner">
              <AssetNavigation onOpenSlideshowOptions={onOpenSlideshowOptions} />
              {viewerFovSlider && (
                <div class="fov-overlay" role="group" aria-label="Viewer FOV">
                  <input
                    class="fov-overlay-slider"
                    type="range"
                    min="20"
                    max="120"
                    step="1"
                    value={fov}
                    onInput={handleOverlayFovChange}
                  />
                </div>
              )}
            </div>
          </div>

          <div class="bottom-controls-right">
            <button
              class="bottom-page-btn"
              onClick={handleResetButtonClick}
              onPointerDown={handleResetHoldStart}
              onPointerUp={handleResetHoldEnd}
              onPointerLeave={handleResetHoldEnd}
              onPointerCancel={handleResetHoldEnd}
              aria-label="Reset camera view"
              title="Reset view (R)"
            >
              <FocusIcon size={18} />
            </button>

            {/* {isRegularFullscreen && (
              <button
                class="bottom-page-btn"
                onClick={handleToggleExpandedViewer}
                aria-label={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
                title={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
              >
                <FontAwesomeIcon icon={expandedViewer ? faCompressAlt : faExpandAlt} />
              </button>
            )} */}

            {isMobile && (
              <button
                class={`bottom-page-btn immersive-toggle ${immersiveMode ? 'is-active' : 'is-inactive'}`}
                onClick={handleImmersiveToggle}
                aria-pressed={immersiveMode}
                aria-label={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
                title={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
              >
                <Rotate3DIcon size={18} />
              </button>
            )}
          </div>
        </>
      )}
      </div>
    </>
  );
}

export default BottomControls;
