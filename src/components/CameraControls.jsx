/**
 * Camera controls component for adjusting FOV, orbit range, and view positioning.
 * Provides sliders for camera parameters and buttons for view manipulation.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { useStore } from '../store';
import { camera, controls, defaultCamera, defaultControls, dollyZoomBaseDistance, dollyZoomBaseFov, requestRender, THREE, setStereoEyeSeparation, setStereoAspect as setStereoAspectRatio, setStereoScale as setStereoRenderScale, setStereoOverlap as setViewerStereoOverlap, setStereoEffectEnabled, getFocusDistance, calculateOptimalEyeSeparation, setOriginalImageAspect } from '../viewer';
import { FocusIcon, KeyboardIcon } from '../icons/customIcons';
import { applyCameraRangeDegrees, restoreHomeView, resetViewWithImmersive } from '../cameraUtils';
import { currentMesh, raycaster, SplatMesh, scene } from '../viewer';
import { updateDollyZoomBaselineFromCamera } from '../viewer';
import { startAnchorTransition } from '../cameraAnimations';
import { enableImmersiveMode, disableImmersiveMode, recenterInImmersiveMode, isImmersiveModeActive, pauseImmersiveMode, resumeImmersiveMode, setImmersiveSensitivityMultiplier, setTouchPanEnabled, syncImmersiveBaseline } from '../immersiveMode';
import { saveFocusDistance, clearFocusDistance } from '../fileStorage';
import { updateFocusDistanceInCache, clearFocusDistanceInCache } from '../splatManager';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faEye, faEyeSlash, faSpinner, faCompressAlt, faCheck, faTimes, faPlus, faFloppyDisk } from '@fortawesome/free-solid-svg-icons';
import { loadSplatFile, loadAssetByIndex } from '../fileLoader';
import { captureCurrentAssetPreview, getAssetList } from '../assetManager';
import { savePreviewBlob } from '../fileStorage';
import {
  applyCustomModelTransform,
  captureCustomMetadataPayload,
  saveCustomMetadataViewForAsset,
  addCustomMetadataViewForAsset,
  clearCustomMetadataViewForAsset,
  applyFullOrbitConstraints,
  restoreOrbitConstraints,
} from "../customMetadata.js";
import { enterVrSession } from '../vrMode';
import { updateViewerAspectRatio, resize } from '../layout.js';

/** Default orbit range in degrees */
const DEFAULT_CAMERA_RANGE_DEGREES = 26;
const MIN_IMMERSIVE_RANGE_DEGREES = 10;
const MAX_IMMERSIVE_RANGE_DEGREES = 90;
const IMMERSIVE_RANGE_PER_SENSITIVITY = 18.75; // extra degrees per +1 sensitivity (hits 90° at max sens)

const ASPECT_OPTIONS = [
  { value: 'full', label: 'Full', ratio: null },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '3:4', label: '3:4', ratio: 3 / 4 },
];

const aspectKeyToRatio = (key) => {
  const option = ASPECT_OPTIONS.find((opt) => opt.value === key);
  return option ? option.ratio : null;
};

const getBaseAssetId = (asset) => asset?.baseAssetId || asset?.id;
const getBaseAssetName = (asset) => asset?.baseAssetName || asset?.name;
const makePreviewStorageKey = (assetName, viewId) => `${assetName}::${viewId}`;
const makeProxyAssetId = (baseAssetId, viewId) => `${baseAssetId}::view::${viewId}`;
const viewDisplayName = (assetName, order) => `${assetName} · View ${order + 1}`;

/** Focus mode states */
const FOCUS_MODE = {
  IDLE: 'idle',
  SETTING: 'setting',
  SET: 'set',
  CUSTOM: 'custom',
};

/**
 * Clamps a value between min and max bounds.
 * @param {number} value - The value to clamp
 * @param {number} min - Minimum bound
 * @param {number} max - Maximum bound
 * @returns {number} Clamped value
 */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Converts a linear slider value (0-180) to non-linear degrees.
 * Uses piecewise linear mapping for finer control at lower values:
 * - 0-50% slider → 0-10° (fine control)
 * - 50-85% slider → 10-30° (medium control)
 * - 85-100% slider → 30-180° (coarse control)
 * @param {number} sliderValue - Slider value between 0 and 180
 * @returns {number} Degrees between 0 and 180
 */
const sliderValueToDegrees = (sliderValue) => {
  const t = clamp(sliderValue / 180, 0, 1);
  if (t <= 0.5) {
    return 20 * t;
  }
  if (t <= 0.85) {
    const localT = (t - 0.5) / 0.35;
    return 10 + 20 * localT;
  }
  const localT = (t - 0.85) / 0.15;
  return 30 + 150 * localT;
};

/**
 * Converts degrees to a linear slider value (0-180).
 * Inverse of sliderValueToDegrees for initializing slider position.
 * @param {number} degrees - Degrees between 0 and 180
 * @returns {number} Slider value between 0 and 180
 */
const degreesToSliderValue = (degrees) => {
  const clamped = clamp(degrees, 0, 180);
  if (clamped <= 10) {
    return (clamped / 20) * 180;
  }
  if (clamped <= 30) {
    const localT = (clamped - 10) / 20;
    return (0.5 + 0.35 * localT) * 180;
  }
  const localT = (clamped - 30) / 150;
  return (0.85 + 0.15 * localT) * 180;
};

/**
 * Formats degrees for display, using 1 decimal place for small values.
 * @param {number} degrees - Angle in degrees
 * @returns {string} Formatted string
 */
const formatDegrees = (degrees) => (degrees < 10 ? degrees.toFixed(1) : degrees.toFixed(0));

const computeImmersiveRangeFloor = (sensitivity) => {
  const extra = Math.max(0, sensitivity - 1) * IMMERSIVE_RANGE_PER_SENSITIVITY;
  return Math.min(MAX_IMMERSIVE_RANGE_DEGREES, MIN_IMMERSIVE_RANGE_DEGREES + extra);
};

const enforceImmersiveRange = (rangeDeg, sensitivity) => {
  const floor = computeImmersiveRangeFloor(sensitivity);
  return Math.max(rangeDeg, floor);
};

/**
 * Updates orbit controls speed based on current FOV.
 * Slower controls at narrower FOV for precision, faster at wider FOV.
 * @param {number} fov - Current field of view in degrees
 */
const updateControlSpeedsForFov = (fov) => {
  if (!controls) return;
  const fovScale = THREE.MathUtils.clamp(fov / defaultCamera.fov, 0.05, 2.0);
  controls.rotateSpeed = Math.max(0.02, defaultControls.rotateSpeed * fovScale * 0.45);
  controls.zoomSpeed = Math.max(0.05, defaultControls.zoomSpeed * fovScale * 0.8);
  controls.panSpeed = Math.max(0.05, defaultControls.panSpeed * fovScale * 0.8);
};

function CameraControls() {
  // Store state and actions
  const fov = useStore((state) => state.fov);
  const setFov = useStore((state) => state.setFov);
  const viewerFovSlider = useStore((state) => state.viewerFovSlider);
  const toggleViewerFovSlider = useStore((state) => state.toggleViewerFovSlider);
  const cameraRange = useStore((state) => state.cameraRange);
  const setCameraRange = useStore((state) => state.setCameraRange);
  const addLog = useStore((state) => state.addLog);
  const cameraSettingsExpanded = useStore((state) => state.cameraSettingsExpanded);
  const toggleCameraSettingsExpanded = useStore((state) => state.toggleCameraSettingsExpanded);
  const isMobile = useStore((state) => state.isMobile);
  const immersiveMode = useStore((state) => state.immersiveMode);
  const setImmersiveMode = useStore((state) => state.setImmersiveMode);
  const immersiveSensitivity = useStore((state) => state.immersiveSensitivity);
  const setImmersiveSensitivity = useStore((state) => state.setImmersiveSensitivity);
  const currentFileName = useStore((state) => state.fileInfo?.name);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const hasCustomFocus = useStore((state) => state.hasCustomFocus);
  const setHasCustomFocus = useStore((state) => state.setHasCustomFocus);
  const setFocusSettingActive = useStore((state) => state.setFocusSettingActive);
  const anchorActive = useStore((state) => state.anchorActive);
  const anchorDistance = useStore((state) => state.anchorDistance);
  const setAnchorState = useStore((state) => state.setAnchorState);
  const updateAssetPreview = useStore((state) => state.updateAssetPreview);
  const stereoEnabled = useStore((state) => state.stereoEnabled);
  const setStereoEnabled = useStore((state) => state.setStereoEnabled);
  const stereoEyeSep = useStore((state) => state.stereoEyeSep);
  const setStereoEyeSep = useStore((state) => state.setStereoEyeSep);
  const stereoAspect = useStore((state) => state.stereoAspect);
  const setStereoAspect = useStore((state) => state.setStereoAspect);
  const stereoScale = useStore((state) => state.stereoScale);
  const setStereoScale = useStore((state) => state.setStereoScale);
  const stereoOverlap = useStore((state) => state.stereoOverlap);
  const setStereoOverlap = useStore((state) => state.setStereoOverlap);
  const vrSupported = useStore((state) => state.vrSupported);
  const vrSessionActive = useStore((state) => state.vrSessionActive);
  const hasAssetLoaded = useStore((state) => state.fileInfo?.name && state.fileInfo.name !== '-');
  const customMetadataControlsVisible = useStore((state) => state.customMetadataControlsVisible);
  const customMetadataAvailable = useStore((state) => state.customMetadataAvailable);
  const metadataMissing = useStore((state) => state.metadataMissing);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const customModelScale = useStore((state) => state.customModelScale);
  const setCustomModelScale = useStore((state) => state.setCustomModelScale);
  const customAspectRatio = useStore((state) => state.customAspectRatio);
  const setCustomAspectRatio = useStore((state) => state.setCustomAspectRatio);
  const setCustomMetadataAvailable = useStore((state) => state.setCustomMetadataAvailable);
  const setMetadataMissing = useStore((state) => state.setMetadataMissing);
  const setCustomMetadataControlsVisible = useStore((state) => state.setCustomMetadataControlsVisible);
  const setCameraSettingsExpanded = useStore((state) => state.setCameraSettingsExpanded);
  const qualityPreset = useStore((state) => state.qualityPreset);
  const setQualityPreset = useStore((state) => state.setQualityPreset);
  const controlsModalOpen = useStore((state) => state.controlsModalOpen);
  const openControlsModalWithSections = useStore((state) => state.openControlsModalWithSections);

  // Ref for camera range slider to avoid DOM queries
  const rangeSliderRef = useRef(null);
  const lastSensitivityRef = useRef(immersiveSensitivity);

  useEffect(() => {
    lastSensitivityRef.current = immersiveSensitivity;
  }, [immersiveSensitivity]);
  
  // Focus depth mode state
  const [focusMode, setFocusMode] = useState(FOCUS_MODE.IDLE);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const [isClearingCustomMetadata, setIsClearingCustomMetadata] = useState(false);
  const [isSavingNewView, setIsSavingNewView] = useState(false);

  // Sync focus mode with custom focus state from store
  useEffect(() => {
    if (hasCustomFocus && focusMode === FOCUS_MODE.IDLE) {
      setFocusMode(FOCUS_MODE.CUSTOM);
    } else if (!hasCustomFocus && focusMode === FOCUS_MODE.CUSTOM) {
      setFocusMode(FOCUS_MODE.IDLE);
    }
  }, [hasCustomFocus, focusMode]);

  // Keep store flag in sync so outside-click handler can pause
  useEffect(() => {
    if (focusMode !== FOCUS_MODE.SETTING) {
      setFocusSettingActive(false);
    }
  }, [focusMode, setFocusSettingActive]);

  /**
   * Handles click during focus-setting mode.
   * Raycasts to get hit distance, then sets the orbit target along the
   * camera's forward direction to that distance without moving the camera.
   */
  const handleFocusClick = useCallback((e) => {
    if (focusModeRef.current !== FOCUS_MODE.SETTING) return;
    if (!currentMesh || !camera || !raycaster || !controls) return;

    // Get canvas-relative coordinates
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;
    
    const rect = viewerEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast from click position
    const clickRay = new THREE.Vector2(x, y);
    raycaster.setFromCamera(clickRay, camera);
    const intersects = [];
    raycaster.intersectObjects(scene.children, true, intersects);
    const splatHit = intersects.find((hit) => hit.object instanceof SplatMesh) ?? null;

    if (!splatHit) {
      addLog('No surface hit - click on the model');
      return;
    }

    // Get the hit distance
    const hitDistance = splatHit.distance;
    
    // Calculate new target position along camera's forward direction at hit distance
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    const newTarget = camera.position.clone().addScaledVector(cameraDirection, hitDistance);

    // Pause immersive mode briefly to prevent interference
    const wasImmersive = isImmersiveModeActive();
    if (wasImmersive) {
      pauseImmersiveMode();
    }

    // Directly set the target without animating camera position
    controls.target.copy(newTarget);
    controls.update();
    updateDollyZoomBaselineFromCamera();
    requestRender();

    // Resume immersive mode after a brief delay
    if (wasImmersive) {
      setTimeout(() => {
        resumeImmersiveMode();
      }, 100);
    }

    addLog(`Focus depth set: ${hitDistance.toFixed(2)} units`);

    // Auto-update stereo eye separation if stereo mode is active
    if (stereoEnabled) {
      const optimal = calculateOptimalEyeSeparation(hitDistance);
      setStereoEyeSep(optimal);
      setStereoEyeSeparation(optimal);
      addLog(`Auto eye separation: ${(optimal * 1000).toFixed(0)}mm`);
    }

    // Persist focus distance for this file
    if (currentFileName && currentFileName !== '-') {
      saveFocusDistance(currentFileName, hitDistance).catch(err => {
        console.warn('Failed to save focus distance:', err);
      });
      const asset = assets[currentAssetIndex];
      if (asset?.id) {
        updateFocusDistanceInCache(asset.cacheKey || asset.baseAssetId || asset.id, hitDistance);
      }
      setHasCustomFocus(true);
    }
    
    // Transition to "set" state briefly
    setFocusMode(FOCUS_MODE.SET);
    setFocusSettingActive(false);
    setTimeout(() => {
      setFocusMode(hasCustomFocus ? FOCUS_MODE.CUSTOM : FOCUS_MODE.IDLE);
    }, 1500);
  }, [addLog, currentFileName, hasCustomFocus, assets, currentAssetIndex, stereoEnabled, setStereoEyeSep, setFocusSettingActive]);

  /**
   * Activates focus-setting mode.
   * User can then click anywhere on the model to set focus depth.
   */
  const handleStartFocusMode = () => {
    if (!currentMesh) {
      addLog('No model loaded');
      return;
    }
    setFocusMode(FOCUS_MODE.SETTING);
    setFocusSettingActive(true);
    addLog('Click on the model to set focus depth');
  };

  /**
   * Cancels focus-setting mode (e.g., pressing Escape).
   */
  const handleCancelFocusMode = useCallback(() => {
    if (focusModeRef.current === FOCUS_MODE.SETTING) {
      setFocusMode(hasCustomFocus ? FOCUS_MODE.CUSTOM : FOCUS_MODE.IDLE);
      setFocusSettingActive(false);
      addLog('Focus mode cancelled');
    }
  }, [addLog, hasCustomFocus, setFocusSettingActive]);

  /**
   * Uses the temporary anchor depth to set and save a custom focus distance.
   */
  const handleSetFocusFromAnchor = useCallback(() => {
    if (!anchorActive) return;
    if (!Number.isFinite(anchorDistance)) {
      addLog('No anchor depth available');
      return;
    }

    const hitDistance = anchorDistance;
    addLog(`Focus depth set: ${hitDistance.toFixed(2)} units (from anchor)`);

    if (stereoEnabled) {
      const optimal = calculateOptimalEyeSeparation(hitDistance);
      setStereoEyeSep(optimal);
      setStereoEyeSeparation(optimal);
      addLog(`Auto eye separation: ${(optimal * 1000).toFixed(0)}mm`);
    }

    if (currentFileName && currentFileName !== '-') {
      saveFocusDistance(currentFileName, hitDistance).catch(err => {
        console.warn('Failed to save focus distance:', err);
      });
      const asset = assets[currentAssetIndex];
      if (asset?.id) {
        updateFocusDistanceInCache(asset.cacheKey || asset.baseAssetId || asset.id, hitDistance);
      }
      setHasCustomFocus(true);
    }

    setAnchorState({ active: false, distance: null });
    setFocusMode(FOCUS_MODE.SET);
    setFocusSettingActive(false);
    setTimeout(() => {
      setFocusMode(hasCustomFocus ? FOCUS_MODE.CUSTOM : FOCUS_MODE.IDLE);
    }, 1500);
  }, [anchorActive, anchorDistance, addLog, stereoEnabled, setStereoEyeSep, currentFileName, assets, currentAssetIndex, setHasCustomFocus, setAnchorState, setFocusSettingActive, hasCustomFocus]);

  /**
   * Clears custom focus distance override.
   * Removes stored focus distance and reloads the file to apply default focus.
   */
  const handleClearCustomFocus = useCallback(async () => {
    if (currentFileName && currentFileName !== '-') {
      const success = await clearFocusDistance(currentFileName);
      if (success) {
        const asset = assets[currentAssetIndex];
        if (asset?.id) {
          clearFocusDistanceInCache(asset.cacheKey || asset.baseAssetId || asset.id);
          // Reload the current asset to immediately restore default focus
          loadSplatFile(asset, { slideDirection: null }).catch(err => {
            console.warn('Failed to reload asset after clearing focus:', err);
          });
        }
        setHasCustomFocus(false);
        setFocusMode(FOCUS_MODE.IDLE);
        addLog('Custom focus cleared');
      }
    }
  }, [currentFileName, addLog, assets, currentAssetIndex]);

  // Set up click listener and cursor when in focus-setting mode
  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    if (focusMode === FOCUS_MODE.SETTING) {
      viewerEl.style.cursor = 'crosshair';
      viewerEl.addEventListener('click', handleFocusClick);
      
      // Cancel on Escape key
      const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
          handleCancelFocusMode();
        }
      };
      document.addEventListener('keydown', handleKeyDown);

      return () => {
        viewerEl.style.cursor = '';
        viewerEl.removeEventListener('click', handleFocusClick);
        document.removeEventListener('keydown', handleKeyDown);
      };
    } else {
      viewerEl.style.cursor = '';
    }
  }, [focusMode, handleFocusClick, handleCancelFocusMode]);

  /**
   * Handles FOV slider changes with dolly-zoom compensation.
   * Maintains the apparent size of objects at the focus point by
   * adjusting camera distance inversely with FOV changes.
   */
  const handleFovChange = (e) => {
    const newFov = Number(e.target.value);
    if (!Number.isFinite(newFov) || !camera || !controls) return;

    setFov(newFov);

    // Apply dolly-zoom effect to maintain object size at focus point
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
    if (isImmersiveModeActive()) {
      syncImmersiveBaseline();
    }
    requestRender();
  };

  // Track if we're actively adjusting camera range to pause immersive mode
  const rangeAdjustTimeoutRef = useRef(null);

  // Hold-to-refresh state for recenter button
  const [isHoldingRecenter, setIsHoldingRecenter] = useState(false);
  const recenterHoldTimeoutRef = useRef(null);

  /**
   * Handles orbit range slider changes.
   * Converts linear slider value to non-linear degrees for intuitive control.
   */
  const handleCameraRangeChange = (e) => {
    const val = Number.parseFloat(e.target.value);
    if (!Number.isFinite(val) || !controls) return;

    // Pause immersive mode during adjustment to prevent judder
    if (isImmersiveModeActive()) {
      pauseImmersiveMode();
      if (rangeAdjustTimeoutRef.current) {
        clearTimeout(rangeAdjustTimeoutRef.current);
      }
      rangeAdjustTimeoutRef.current = setTimeout(() => {
        resumeImmersiveMode();
        rangeAdjustTimeoutRef.current = null;
      }, 300);
    }

    const degrees = sliderValueToDegrees(val);
    setCameraRange(degrees);
    applyCameraRangeDegrees(degrees);
  };

  /**
   * Resets camera to the stored home view position.
   */
  const handleRecenter = () => {
    if (!camera || !controls) return;
    restoreHomeView();
  };

  /**
   * Returns the appropriate button text based on focus mode state.
   */
  const getFocusButtonText = () => {
    if (anchorActive && focusMode !== FOCUS_MODE.SETTING && focusMode !== FOCUS_MODE.SET) {
      return 'Set anchor as focus';
    }
    switch (focusMode) {
      case FOCUS_MODE.SETTING:
        return 'Click model...';
      case FOCUS_MODE.SET:
        return 'Focus set';
      case FOCUS_MODE.CUSTOM:
        return 'Custom focus';
      default:
        return 'Set focus depth';
    }
  };

  const handleFocusButtonClick = () => {
    if (focusMode === FOCUS_MODE.SETTING) {
      handleCancelFocusMode();
      return;
    }
    if (anchorActive) {
      handleSetFocusFromAnchor();
      return;
    }
    handleStartFocusMode();
  };

  const focusButtonLabel = anchorActive && focusMode !== FOCUS_MODE.SETTING && focusMode !== FOCUS_MODE.SET
    ? 'Set anchor as focus depth'
    : (focusMode === FOCUS_MODE.CUSTOM ? 'Custom focus - click to set a new focus' : 'Set focus depth');


  // Initialize camera range on mount
  useEffect(() => {
    if (!controls || !rangeSliderRef.current) return;

    // Set slider to match the default degrees
    const initialSliderValue = degreesToSliderValue(DEFAULT_CAMERA_RANGE_DEGREES);
    rangeSliderRef.current.value = String(initialSliderValue.toFixed(1));

    // Use the constant directly instead of converting back
    setCameraRange(DEFAULT_CAMERA_RANGE_DEGREES);
    applyCameraRangeDegrees(DEFAULT_CAMERA_RANGE_DEGREES);
  }, [setCameraRange]);

  // Pause immersive mode during pinch-zoom gestures on viewer
  useEffect(() => {
    if (!isMobile) return;
    
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;
    
    let pinchResumeTimeout = null;
    let activeTouches = 0;
    
    const handleTouchStart = (e) => {
      activeTouches = e.touches.length;
      // Pause when 2+ fingers touch (pinch gesture starting)
      if (activeTouches >= 2 && isImmersiveModeActive()) {
        pauseImmersiveMode();
        if (pinchResumeTimeout) {
          clearTimeout(pinchResumeTimeout);
          pinchResumeTimeout = null;
        }
      }
    };
    
    const handleTouchEnd = (e) => {
      activeTouches = e.touches.length;
      // Resume shortly after all fingers lifted
      if (activeTouches === 0 && isImmersiveModeActive()) {
        pinchResumeTimeout = setTimeout(() => {
          resumeImmersiveMode();
          pinchResumeTimeout = null;
        }, 200);
      }
    };
    
    viewerEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    viewerEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    viewerEl.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    
    return () => {
      viewerEl.removeEventListener('touchstart', handleTouchStart);
      viewerEl.removeEventListener('touchend', handleTouchEnd);
      viewerEl.removeEventListener('touchcancel', handleTouchEnd);
      if (pinchResumeTimeout) clearTimeout(pinchResumeTimeout);
    };
  }, [isMobile]);

  const activeAsset = assets[currentAssetIndex] || null;
  const isFirstUnsavedCustomView = Boolean(
    metadataMissing
    && !customMetadataAvailable
    && !activeAsset?.viewId
  );

  const orbitLimitsDisabled = customMetadataAvailable || metadataMissing || slideshowPlaying;

  // Enable full orbit whenever orbit limits are disabled
  useEffect(() => {
    if (orbitLimitsDisabled || customMetadataControlsVisible) {
      applyFullOrbitConstraints();
    } else {
      restoreOrbitConstraints(cameraRange);
    }
  }, [orbitLimitsDisabled, customMetadataControlsVisible, cameraRange]);

  /**
   * Handles toggling immersive mode.
   * Enables device orientation camera control.
   */
  const handleImmersiveToggle = useCallback(async (e) => {
    const enabled = e.target.checked;
    if (enabled) {
      // Touch pan is always on now
      setTouchPanEnabled(true);
      // Sync touch pan scaling with current sensitivity
      setImmersiveSensitivityMultiplier(immersiveSensitivity);
      
      const success = await enableImmersiveMode();
      if (success) {
        setImmersiveMode(true);
        // Keep current range as-is; floor is applied only on sensitivity changes
        addLog('Immersive mode enabled - tilt device to orbit');
      } else {
        e.target.checked = false;
        addLog('Could not enable immersive mode');
      }
    } else {
      disableImmersiveMode();
      setImmersiveMode(false);
      addLog('Immersive mode disabled');
    }
  }, [setImmersiveMode, addLog, cameraRange, immersiveSensitivity, setCameraRange]);

  /**
   * Handles immersive sensitivity slider changes.
   */
  const handleImmersiveSensitivityChange = useCallback((e) => {
    const value = Number.parseFloat(e.target.value);
    if (!Number.isFinite(value)) return;
    const prevSensitivity = Number.isFinite(lastSensitivityRef.current)
      ? lastSensitivityRef.current
      : value;
    const prevFloor = computeImmersiveRangeFloor(prevSensitivity);
    const nextFloor = computeImmersiveRangeFloor(value);
    lastSensitivityRef.current = value;
    setImmersiveSensitivity(value);
    setImmersiveSensitivityMultiplier(value);
    if (isImmersiveModeActive()) {
      const delta = nextFloor - prevFloor;
      const nextRange = clamp(cameraRange + delta, MIN_IMMERSIVE_RANGE_DEGREES, MAX_IMMERSIVE_RANGE_DEGREES);
      const enforcedRange = enforceImmersiveRange(nextRange, value);
      if (enforcedRange !== cameraRange) {
        setCameraRange(enforcedRange);
        applyCameraRangeDegrees(enforcedRange);
      }
    }
  }, [setImmersiveSensitivity, cameraRange, setCameraRange]);

  const handleCustomModelScaleChange = useCallback((e) => {
    const value = Number.parseFloat(e.target.value);
    if (!Number.isFinite(value)) return;
    setCustomModelScale(value);
    // Apply scale with CV→GL flip always enabled for non-ML Sharp splats
    applyCustomModelTransform(currentMesh, {
      applyCoordinateFlip: true,
      modelScale: value,
    });
  }, [setCustomModelScale]);

  const handleCustomAspectRatioChange = useCallback((e) => {
    const value = e.target.value;
    setCustomAspectRatio(value);
    const ratio = aspectKeyToRatio(value);
    const viewerEl = document.getElementById('viewer');
    if (viewerEl && !new URLSearchParams(window.location.search).has('nofade')) {
      viewerEl.classList.add('slide-out-fast');
      viewerEl.classList.remove('slide-in');
    }
    setOriginalImageAspect(ratio);
    updateViewerAspectRatio();
    setTimeout(() => {
      resize();
      requestRender();
      if (viewerEl) {
        viewerEl.classList.remove('slide-out-fast');
        if (!new URLSearchParams(window.location.search).has('nofade')) viewerEl.classList.add('slide-in');
        setTimeout(() => {
          viewerEl.classList.remove('slide-in');
        }, 550);
      }
    }, 500);
  }, [setCustomAspectRatio]);

  const handleSaveCustomMetadata = useCallback(async () => {
    if (!currentFileName || currentFileName === '-') {
      addLog('No active file to save metadata');
      return;
    }

    const currentAsset = assets[currentAssetIndex];
    if (!currentAsset) {
      addLog('No active asset to save metadata');
      return;
    }

    const payload = captureCustomMetadataPayload({
      modelScale: customModelScale,
      aspectRatio: aspectKeyToRatio(customAspectRatio),
    });

    const result = await saveCustomMetadataViewForAsset(currentFileName, payload, {
      viewId: currentAsset.viewId || null,
    });
    if (!result?.saved) {
      addLog('Failed to save custom metadata');
      return;
    }

    const nextViewId = result.viewId || currentAsset.viewId;
    if (nextViewId) {
      currentAsset.viewId = nextViewId;
      currentAsset.baseAssetId = getBaseAssetId(currentAsset);
      currentAsset.baseAssetName = getBaseAssetName(currentAsset);
      currentAsset.cacheKey = currentAsset.baseAssetId;
      currentAsset.isProxyView = Boolean(currentAsset.isProxyView);
      currentAsset.previewStorageKey = makePreviewStorageKey(currentAsset.baseAssetName, nextViewId);
    }

    const previewResult = await captureCurrentAssetPreview();
    if (previewResult?.blob) {
      if (currentAsset?.name) {
        await savePreviewBlob(currentAsset.name, previewResult.blob, {
          width: previewResult.width,
          height: previewResult.height,
          format: previewResult.format,
        }, currentAsset.previewStorageKey || currentAsset.name);
      }
      if (currentAssetIndex >= 0) {
        updateAssetPreview(currentAssetIndex, currentAsset.preview);
      }
    }

    setAssets([...getAssetList()]);
    setCustomMetadataAvailable(true);
    setMetadataMissing(false);
    setCustomMetadataControlsVisible(false);
    addLog('Custom metadata saved');
  }, [currentFileName, customModelScale, customAspectRatio, addLog, assets, currentAssetIndex, updateAssetPreview, setCustomMetadataAvailable, setMetadataMissing, setCustomMetadataControlsVisible, setAssets]);

  /**
   * Saves the initial view when no metadata exists, but keeps the editor
   * open so the user can continue saving additional views in the same session.
   * After save, `isFirstUnsavedCustomView` becomes false and the button layout
   * transitions to "Update and close" + "Save as new view".
   */
  const handleSaveInitialView = useCallback(async () => {
    if (!currentFileName || currentFileName === '-') {
      addLog('No active file to save metadata');
      return;
    }

    const currentAsset = assets[currentAssetIndex];
    if (!currentAsset) {
      addLog('No active asset to save metadata');
      return;
    }

    const payload = captureCustomMetadataPayload({
      modelScale: customModelScale,
      aspectRatio: aspectKeyToRatio(customAspectRatio),
    });

    const result = await saveCustomMetadataViewForAsset(currentFileName, payload, {
      viewId: currentAsset.viewId || null,
    });
    if (!result?.saved) {
      addLog('Failed to save custom metadata');
      return;
    }

    const nextViewId = result.viewId || currentAsset.viewId;
    if (nextViewId) {
      currentAsset.viewId = nextViewId;
      currentAsset.baseAssetId = getBaseAssetId(currentAsset);
      currentAsset.baseAssetName = getBaseAssetName(currentAsset);
      currentAsset.cacheKey = currentAsset.baseAssetId;
      currentAsset.isProxyView = Boolean(currentAsset.isProxyView);
      currentAsset.previewStorageKey = makePreviewStorageKey(currentAsset.baseAssetName, nextViewId);
    }

    const previewResult = await captureCurrentAssetPreview();
    if (previewResult?.blob) {
      if (currentAsset?.name) {
        await savePreviewBlob(currentAsset.name, previewResult.blob, {
          width: previewResult.width,
          height: previewResult.height,
          format: previewResult.format,
        }, currentAsset.previewStorageKey || currentAsset.name);
      }
      if (currentAssetIndex >= 0) {
        updateAssetPreview(currentAssetIndex, currentAsset.preview);
      }
    }

    setAssets([...getAssetList()]);
    setCustomMetadataAvailable(true);
    setMetadataMissing(false);
    // Keep editor open so user can continue saving new views
    setCustomMetadataControlsVisible(true);
    setCameraSettingsExpanded(true);
    addLog('Initial view saved — reposition camera and save more views');
  }, [currentFileName, customModelScale, customAspectRatio, addLog, assets, currentAssetIndex, updateAssetPreview, setCustomMetadataAvailable, setMetadataMissing, setCustomMetadataControlsVisible, setAssets, setCameraSettingsExpanded]);

  const handleSaveAndAddNewView = useCallback(async () => {
    if (!currentFileName || currentFileName === '-') {
      addLog('No active file to save metadata');
      return;
    }

    const currentAsset = assets[currentAssetIndex];
    if (!currentAsset) {
      addLog('No active asset to duplicate view from');
      return;
    }

    const payload = captureCustomMetadataPayload({
      modelScale: customModelScale,
      aspectRatio: aspectKeyToRatio(customAspectRatio),
    });

    const result = await addCustomMetadataViewForAsset(currentFileName, payload, {
      insertAfterViewId: currentAsset.viewId || null,
    });
    if (!result?.saved || !result?.viewId) {
      addLog('Failed to add a new custom view');
      return;
    }

    const list = getAssetList();
    const baseAssetId = getBaseAssetId(currentAsset);
    const insertAfterIndex = Math.max(0, currentAssetIndex);
    const baseAssetName = getBaseAssetName(currentAsset);
    const groupOrder = (currentAsset.groupOrder ?? 0) + 1;

    // Reindex following views in this group to keep contiguous ordering
    for (let i = insertAfterIndex + 1; i < list.length; i++) {
      const candidate = list[i];
      if (getBaseAssetId(candidate) !== baseAssetId) break;
      candidate.groupOrder = (candidate.groupOrder ?? i - insertAfterIndex) + 1;
      candidate.displayName = viewDisplayName(baseAssetName, candidate.groupOrder);
    }

    const proxyAsset = {
      ...currentAsset,
      id: makeProxyAssetId(baseAssetId, result.viewId),
      isProxyView: true,
      baseAssetId,
      baseAssetName,
      viewId: result.viewId,
      groupOrder,
      displayName: viewDisplayName(baseAssetName, groupOrder),
      previewStorageKey: makePreviewStorageKey(baseAssetName, result.viewId),
      cacheKey: baseAssetId,
      loaded: false,
    };

    list.splice(insertAfterIndex + 1, 0, proxyAsset);
    setAssets([...list]);

    setCustomMetadataAvailable(true);
    setMetadataMissing(false);
    // Keep editor open — don't set customMetadataControlsVisible to false

    const nextIndex = insertAfterIndex + 1;
    setCurrentAssetIndex(nextIndex);
    addLog('Custom view added');
    setIsSavingNewView(true);
    try {
      await loadAssetByIndex(nextIndex);

      const refreshedAssets = getAssetList();
      const selectedAsset = refreshedAssets[nextIndex] || proxyAsset;
      const previewResult = await captureCurrentAssetPreview();
      if (previewResult?.blob && selectedAsset?.name) {
        await savePreviewBlob(selectedAsset.name, previewResult.blob, {
          width: previewResult.width,
          height: previewResult.height,
          format: previewResult.format,
        }, selectedAsset.previewStorageKey || selectedAsset.name);

        if (selectedAsset.preview) {
          updateAssetPreview(nextIndex, selectedAsset.preview);
        }
        setAssets([...refreshedAssets]);
      }
    } finally {
      setIsSavingNewView(false);
    }

    // Ensure editor stays open after proxy view load (which resets to false)
    setCustomMetadataControlsVisible(true);
    setCameraSettingsExpanded(true);
  }, [currentFileName, assets, currentAssetIndex, customModelScale, customAspectRatio, setAssets, setCurrentAssetIndex, addLog, setCustomMetadataAvailable, setMetadataMissing, setCustomMetadataControlsVisible, updateAssetPreview, setCameraSettingsExpanded]);

  const handleClearCustomMetadata = useCallback(async () => {
    if (!currentFileName || currentFileName === '-' || isClearingCustomMetadata) return;

    setIsClearingCustomMetadata(true);
    try {
      const currentAsset = assets[currentAssetIndex];
      if (!currentAsset) return;

      const result = await clearCustomMetadataViewForAsset(currentFileName, currentAsset.viewId || null);
      if (!result?.cleared) {
        addLog('Failed to clear custom metadata');
        return;
      }

      const list = getAssetList();
      const removedIndex = currentAssetIndex;
      list.splice(removedIndex, 1);

      const sameBaseAssets = list.filter((item) => getBaseAssetId(item) === getBaseAssetId(currentAsset));
      if (sameBaseAssets.length > 0) {
        sameBaseAssets.forEach((item, idx) => {
          item.groupOrder = idx;
          item.displayName = viewDisplayName(getBaseAssetName(currentAsset), idx);
          item.isProxyView = idx > 0;
        });
      }

      const nextIndex = Math.min(removedIndex, Math.max(0, list.length - 1));
      setAssets([...list]);
      if (list.length > 0) {
        setCurrentAssetIndex(nextIndex);
        await loadAssetByIndex(nextIndex);
      } else {
        setCurrentAssetIndex(-1);
      }

      const hasRemainingViews = sameBaseAssets.length > 0;
      setCustomMetadataAvailable(hasRemainingViews);
      // When no views remain, fully clear metadata-missing state so the
      // notification banner disappears and the landing screen can show.
      setMetadataMissing(false);
      setCustomMetadataControlsVisible(false);
      setCustomModelScale(1);
      setCustomAspectRatio('full');
      setOriginalImageAspect(null);
      updateViewerAspectRatio();
      resize();
      addLog(hasRemainingViews ? 'Custom view reset' : 'Custom view cancelled');

      if (!hasRemainingViews && currentFileName && currentFileName !== '-') {
        const focusCleared = await clearFocusDistance(currentFileName);
        if (focusCleared && currentAsset?.id) {
          clearFocusDistanceInCache(currentAsset.cacheKey || currentAsset.baseAssetId || currentAsset.id);
        }
        setHasCustomFocus(false);
        setFocusMode(FOCUS_MODE.IDLE);
      }
    } finally {
      setIsClearingCustomMetadata(false);
    }
  }, [currentFileName, isClearingCustomMetadata, addLog, assets, currentAssetIndex, setCustomMetadataAvailable, setMetadataMissing, setCustomMetadataControlsVisible, setCustomModelScale, setCustomAspectRatio, setAssets, setCurrentAssetIndex, setHasCustomFocus]);

  /**
   * Closes edit mode and reloads current asset to restore its saved camera pose.
   */
  const handleCloseEditMode = useCallback(async () => {
    setCustomMetadataControlsVisible(false);
    if (currentAssetIndex >= 0) {
      await loadAssetByIndex(currentAssetIndex);
    }
  }, [setCustomMetadataControlsVisible, currentAssetIndex]);

  /**
   * Resets view with immersive mode support.
   * Uses the shared function that pauses orientation input during animation.
   */
  const handleRecenterWithImmersive = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  /**
   * Handles hold-to-refresh: starts a 1s timer on press.
   * If held long enough, triggers a full viewer refresh.
   */
  const handleRecenterPointerDown = useCallback(() => {
    setIsHoldingRecenter(true);
    recenterHoldTimeoutRef.current = setTimeout(() => {
      // Held for 1 second - recenter then trigger refresh
      handleRecenterWithImmersive();
      resize();
      requestRender();
      addLog('Forced viewer refresh (recenter + resize + render)');
      setIsHoldingRecenter(false);
    }, 1000);
  }, [addLog, handleRecenterWithImmersive]);

  /**
   * Cancels hold timer and triggers normal recenter if released early.
   */
  const handleRecenterPointerUp = useCallback(() => {
    if (recenterHoldTimeoutRef.current) {
      clearTimeout(recenterHoldTimeoutRef.current);
      recenterHoldTimeoutRef.current = null;
      // Only recenter if we were holding (not already triggered refresh)
      if (isHoldingRecenter) {
        handleRecenterWithImmersive();
      }
    }
    setIsHoldingRecenter(false);
  }, [isHoldingRecenter, handleRecenterWithImmersive]);

  /**
   * Cancels hold timer if pointer leaves button.
   */
  const handleRecenterPointerLeave = useCallback(() => {
    if (recenterHoldTimeoutRef.current) {
      clearTimeout(recenterHoldTimeoutRef.current);
      recenterHoldTimeoutRef.current = null;
    }
    setIsHoldingRecenter(false);
  }, []);

  const handleExitSbsMode = useCallback(async () => {
    const fullscreenRoot = document.getElementById('app');

    try {
      const bgContainers = document.querySelectorAll('.bg-image-container');
      bgContainers.forEach((el) => el.classList.remove('stereo-hidden'));

      setStereoEffectEnabled(false);
      setStereoEnabled(false);
      requestRender();

      if (document.fullscreenElement === fullscreenRoot) {
        await document.exitFullscreen();
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      resize();
      addLog('Stereo mode disabled');
    } catch (err) {
      const bgContainers = document.querySelectorAll('.bg-image-container');
      bgContainers.forEach((el) => el.classList.remove('stereo-hidden'));
      setStereoEffectEnabled(false);
      setStereoEnabled(false);
      addLog('Stereo toggle failed');
      console.warn('Stereo exit failed:', err);
    }
  }, [setStereoEnabled, addLog]);

  return (
    <div class="settings-group">
      {/* Collapsible header */}
      <div
        class="group-toggle"
        aria-expanded={cameraSettingsExpanded}
        onClick={toggleCameraSettingsExpanded}
      >
        <span class="settings-eyebrow">Camera Settings</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginRight: '-8px' }}>
          <button
            class="add-source-btn"
            type="button"
            title="Controls"
            onClick={(e) => {
              e.stopPropagation();
              const controlsKey = isMobile ? 'controls.mobile' : 'controls.desktop';
              openControlsModalWithSections(['settings.main-settings', controlsKey]);
            }}
            style={{ width: '28px', height: '22px', fontSize: '11px' }}
          >
            <KeyboardIcon size={14} />
          </button>
          <FontAwesomeIcon icon={faChevronDown} className="chevron" />
        </div>
      </div>
      
      {/* Settings content */}
      <div 
        class="group-content" 
        style={{ display: cameraSettingsExpanded ? 'flex' : 'none' }}
      >
        {/* Immersive mode toggle - mobile only */}
        {isMobile && (
          <>
            {/* Immersive sensitivity slider - shown when immersive mode is active */}
            {immersiveMode && (
              <>
                <div class="control-row">
                  <span class="control-label">Tilt sensitivity</span>
                  <div class="control-track">
                    <input
                      type="range"
                      min="1.0"
                      max="5.0"
                      step="0.1"
                      value={immersiveSensitivity}
                      onInput={handleImmersiveSensitivityChange}
                    />
                    <span class="control-value">
                      {immersiveSensitivity.toFixed(1)}×
                    </span>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* VR button - shown when VR is supported and an asset is loaded */}
        {vrSupported && hasAssetLoaded && (
          <div class="control-row">
            <button
              class={`secondary enter-vr-btn ${vrSessionActive ? 'vr-active' : ''}`}
              onClick={() => {
                enterVrSession();
              }}
            >
              {vrSessionActive ? 'Exit VR' : 'Enter VR'}
            </button>
          </div>
        )}

        {/* Quality preset */}
        <div class="control-row">
          <span class="control-label">Quality</span>
          <div class="control-track">
            <select
              class="quality-select"
              value={qualityPreset}
              onChange={(e) => setQualityPreset(e.target.value)}
            >
              <option value="high">High</option>
              <option value="default">Default</option>
              <option value="performance">Performance</option>
              <option value="experimental">Experimental</option>
              {qualityPreset === 'debug-custom' && (
                <option value="debug-custom">Debug custom</option>
              )}
            </select>
          </div>
        </div>

        {/* Eye separation slider - shown when stereo is enabled */}
        {stereoEnabled && (
          <>
            <div class="control-row">
              <span class="control-label" style="display: flex; align-items: center; gap: 6px;">
                <span>Separation</span>
                <button
                  type="button"
                  class="fov-toggle-btn"
                  title="Calculate optimal separation from focus distance"
                  onClick={() => {
                    const focusDist = getFocusDistance();
                    if (focusDist) {
                      const optimal = calculateOptimalEyeSeparation(focusDist);
                      setStereoEyeSep(optimal);
                      setStereoEyeSeparation(optimal);
                      addLog(`Auto eye separation: ${(optimal * 1000).toFixed(0)}mm (from ${focusDist.toFixed(2)} units)`);
                    }
                  }}
                  aria-label="Auto calculate eye separation"
                >
                  <FocusIcon />
                </button>
              </span>
              <div class="control-track">
                <input
                  type="range"
                  min="0.01"
                  max="0.60"
                  step="0.005"
                  value={stereoEyeSep}
                  onInput={(e) => {
                    const value = parseFloat(e.target.value);
                    setStereoEyeSep(value);
                    setStereoEyeSeparation(value);
                  }}
                />
                <span class="control-value">
                  {(stereoEyeSep * 1000).toFixed(0)}mm
                </span>
              
              </div>
            </div>
            
            <div class="control-row">
              <span class="control-label" style="display: flex; align-items: center; gap: 6px;">
                <span>Stereo aspect</span>
                <button
                  type="button"
                  class="fov-toggle-btn"
                  title="Set squeezed display aspect"
                  onClick={() => {
                    setStereoAspect(1);
                    setStereoAspectRatio(1);
                    addLog('Stereo aspect set to squeezed display (1.00)');
                  }}
                  aria-label="Set stereo aspect to squeezed display"
                >
                  <FontAwesomeIcon icon={faCompressAlt} />
                </button>
              </span>
              <div class="control-track">
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={stereoAspect}
                  onInput={(e) => {
                    const value = parseFloat(e.target.value);
                    setStereoAspect(value);
                    setStereoAspectRatio(value);
                  }}
                />
                <span class="control-value">
                  {stereoAspect.toFixed(2)}
                </span>
              </div>
            </div>

            <div class="control-row">
              <span class="control-label">Scale</span>
              <div class="control-track">
                <input
                  type="range"
                  min="0.50"
                  max="1.00"
                  step="0.01"
                  value={stereoScale}
                  onInput={(e) => {
                    const value = parseFloat(e.target.value);
                    setStereoScale(value);
                    setStereoRenderScale(value);
                  }}
                />
                <span class="control-value">
                  {(stereoScale * 100).toFixed(0)}%
                </span>
              </div>
            </div>

            <div class="control-row">
              <span class="control-label">Overlap override</span>
              <div class="control-track" style="justify-content: flex-end;">
                <select
                  class="quality-select"
                  value={stereoOverlap}
                  onChange={(e) => {
                    const value = parseFloat(e.target.value);
                    setStereoOverlap(value);
                    setViewerStereoOverlap(value);
                    addLog(`SBS width: ${(value * 100).toFixed(0)}%`);
                  }}
                >
                  <option value={1.2}>120%</option>
                  <option value={1.0}>100%</option>
                  <option value={0.9}>90%</option>
                  <option value={0.8}>80%</option>
                  <option value={0.7}>70%</option>
                  <option value={0.6}>60%</option>
                </select>
              </div>
            </div>
          </>
        )}

        {/* Orbit range control */}
        <div class={`control-row camera-range-controls ${orbitLimitsDisabled ? 'is-disabled' : ''}`}>
          <span class="control-label">Orbit range</span>
          <div class="control-track">
            <input
              ref={rangeSliderRef}
              type="range"
              min="0"
              max="180"
              step="0.1"
              value={degreesToSliderValue(cameraRange)}
              onInput={handleCameraRangeChange}
              disabled={orbitLimitsDisabled}
            />
            <span class="control-value">
              {formatDegrees(cameraRange)}°
            </span>
          </div>
        </div>

        {/* FOV control */}
        <div class="control-row">
          <span class="control-label fov-label">
            FOV
            <button
              type="button"
              class={`fov-toggle-btn ${viewerFovSlider ? 'is-on' : 'is-off'}`}
              onClick={toggleViewerFovSlider}
              title={viewerFovSlider ? 'Hide viewer FOV slider' : 'Show viewer FOV slider'}
              aria-pressed={viewerFovSlider}
              aria-label={viewerFovSlider ? 'Hide viewer FOV slider' : 'Show viewer FOV slider'}
            >
              <FontAwesomeIcon icon={viewerFovSlider ? faEye : faEyeSlash} />
            </button>
          </span>
          <div class="control-track">
            <input
              type="range"
              min="20"
              max="120"
              step="1"
              value={fov}
              onInput={handleFovChange}
            />
            <span class="control-value">
              {Math.round(fov)}°
            </span>
          </div>
        </div>

        {/* Custom metadata controls - shown when metadata is missing */}
        {customMetadataControlsVisible && (
          <div class="custom-metadata-section">
            <div class="section-header">
              <span class="section-title">Custom View Settings</span>
              <span class="section-hint">Position camera, then save</span>
            </div>
            
            {isFirstUnsavedCustomView && (
              <div class="control-row">
                <span class="control-label">Model scale</span>
                <div class="control-track">
                  <input
                    type="range"
                    min="0.1"
                    max="10"
                    step="0.1"
                    value={customModelScale}
                    onInput={handleCustomModelScaleChange}
                  />
                  <span class="control-value">
                    {customModelScale.toFixed(1)}×
                  </span>
                </div>
              </div>
            )}

            <div class="control-row">
              <span class="control-label">Aspect ratio</span>
              <div class="control-track">
                <select
                  class="quality-select"
                  value={customAspectRatio}
                  onChange={handleCustomAspectRatioChange}
                >
                  {ASPECT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {isFirstUnsavedCustomView ? (
              <>
                <div class="control-row clear-custom-row clear-custom-row--top">
                  <button
                    type="button"
                    class="clear-custom-btn is-reset"
                    onClick={handleClearCustomMetadata}
                    disabled={isClearingCustomMetadata}
                  >
                    {isClearingCustomMetadata ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>

                <button
                  class="primary-button"
                  onClick={handleSaveInitialView}
                  disabled={isSavingNewView}
                >
                  <FontAwesomeIcon icon={faFloppyDisk} />
                  Save View
                </button>
              </>
            ) : (
              <>
                <div class="control-row clear-custom-row clear-custom-row--top">
                  <button
                    type="button"
                    class="clear-custom-btn is-reset"
                    onClick={handleCloseEditMode}
                    disabled={isSavingNewView}
                  >
                    Close
                  </button>
                </div>

                <button 
                  class="primary-button"
                  onClick={handleSaveCustomMetadata}
                  disabled={isSavingNewView}
                >
                  <FontAwesomeIcon icon={faFloppyDisk} />
                  Update and close
                </button>

                <button
                  class="primary-button success"
                  onClick={handleSaveAndAddNewView}
                  disabled={isSavingNewView}
                  style={{ marginTop: '8px' }}
                >
                  <FontAwesomeIcon icon={isSavingNewView ? faSpinner : faPlus} spin={isSavingNewView} />
                  {isSavingNewView ? 'Save as new view' : 'Save as new view'}
                </button>
              </>
            )}
          </div>
        )}

        {customMetadataAvailable && !customMetadataControlsVisible && (
          <div class="control-row clear-custom-row">
            <button
              type="button"
              class="clear-custom-btn"
              onClick={() => {
                setCustomMetadataControlsVisible(true);
                setCameraSettingsExpanded(true);
              }}
            >
              Edit custom camera
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div class="settings-footer">
          <span class="recenter-hint">hold to refresh</span>
          <button
            class="secondary recenter-btn"
            onPointerDown={handleRecenterPointerDown}
            onPointerUp={handleRecenterPointerUp}
            onPointerLeave={handleRecenterPointerLeave}
            onPointerCancel={handleRecenterPointerLeave}
            style={{ position: 'relative' }}
          >
            Recenter view
            {isHoldingRecenter && (
              <FontAwesomeIcon
                icon={faSpinner}
                spin
                style={{
                   position: 'absolute',
                  right: '10px',
                  top: '10px',
                  transform: 'translateY(-50%)',
                  fontSize: '12px',
                  opacity: 0.7,
                }}
              />
            )}
          </button>
          
          <div class="focus-control">
            <button 
              class={`secondary focus-main-btn ${
                focusMode === FOCUS_MODE.SETTING ? 'is-setting' : 
                focusMode === FOCUS_MODE.SET ? 'is-set' : 
                focusMode === FOCUS_MODE.CUSTOM ? 'is-custom' : ''
              }`}
              onClick={handleFocusButtonClick}
              disabled={focusMode === FOCUS_MODE.SET}
              aria-label={focusButtonLabel}
            >
              {getFocusButtonText()}
            </button>
            
            {focusMode === FOCUS_MODE.CUSTOM && (
              <button
                class="focus-clear-btn"
                onClick={handleClearCustomFocus}
                title="Clear custom focus"
                aria-label="Clear custom focus"
              >
                ✕
              </button>
            )}
          </div>

          {stereoEnabled && (
            <button
              class="secondary focus-main-btn"
              onClick={handleExitSbsMode}
              aria-label="Exit side-by-side mode"
              title="Exit side-by-side mode"
            >
              Exit SBS mode
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CameraControls;