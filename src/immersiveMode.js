/**
 * Immersive Mode - Device orientation and touch-based camera control
 * 
 * Maps device rotation to camera orbit for a parallax effect.
 * Tilting the device orbits the camera around the target.
 * Single finger drag pans the camera for a parallax pan effect.
 * 
 * Uses a unified update loop to combine both inputs smoothly without jitter.
 */

import { camera, controls, requestRender, THREE } from './viewer.js';
import { useStore } from './store.js';
import { setLoadAnimationEnabled } from './customAnimations.js';

// State
let isActive = false;
let isPaused = false;
let baseQuaternion = null;
let baseSpherical = null;
let lastBeta = null;
let lastGamma = null;
let screenOrientation = 'portrait-primary';

// Quaternion-based orientation (avoids gimbal lock)
let baseDeviceQuaternion = null;

// Unified update loop
let updateLoopId = null;

// Rotation (orientation) state
let rotationEnabled = true;

// Touch pan state
let touchPanEnabled = true;
let panOffset = { x: 0, y: 0 }; // Current pan offset applied to camera
let baseCameraTarget = null; // Original target before any pan offset
let touchStartPos = null; // Starting touch position
let touchPanSensitivity = 0.003; // How much touch movement translates to pan

// Raw input values (updated by event handlers, consumed by update loop)
let rawOrientation = { alpha: null, beta: null, gamma: null };

// Sensitivity settings
const BASE_SENSITIVITY = {
  tilt: 0.006,      // Base tilt sensitivity
  maxAngle: 25,     // Maximum degrees of camera orbit from center
  smoothing: 0.18,  // Smoothing factor (0-1, lower = smoother)
};

// Touch pan sensitivity settings
const TOUCH_PAN_SENSITIVITY = {
  scale: 0.003,     // How much touch movement translates to pan
  maxPanOffset: 2.0, // Maximum pan offset from center (world units, scaled by distance)
};

// Current sensitivity (can be scaled by multiplier)
let currentSensitivity = { ...BASE_SENSITIVITY };

// Touch pan scale multiplier (derived from immersive sensitivity)
let touchPanScaleMultiplier = 1;
let wasBlockedBySlideshowPlayback = false;
let wasBlockedBySlideTransition = false;

/**
 * Computes touch pan scaling based on immersive sensitivity multiplier.
 * @param {number} multiplier - Multiplier between 1.0 and 5.0
 * @returns {number} Scale multiplier for touch panning
 */
const getTouchPanScaleForMultiplier = (multiplier) => {
  const t = (multiplier - 1.0) / 4.0; // 0..1
  return 0.25 + 0.75 * Math.max(0, Math.min(1, t));
};

/**
 * Sets the sensitivity multiplier for immersive mode tilt.
 * @param {number} multiplier - Multiplier between 1.0 and 5.0
 */
export const setImmersiveSensitivityMultiplier = (multiplier) => {
  const clamped = Math.max(1.0, Math.min(5.0, multiplier));
  currentSensitivity.tilt = BASE_SENSITIVITY.tilt * clamped;
  touchPanScaleMultiplier = getTouchPanScaleForMultiplier(clamped);
};

/**
 * Enables or disables rotation (orientation-based orbit).
 * @param {boolean} enabled - Whether rotation is enabled
 */
const setRotationEnabled = (enabled) => {
  rotationEnabled = enabled;
  if (!enabled) {
    // Reset orientation state when disabled
    smoothedBeta = 0;
    smoothedGamma = 0;
    targetBeta = 0;
    targetGamma = 0;
  }
};

/**
 * Enables or disables touch-based panning.
 * @param {boolean} enabled - Whether touch panning is enabled
 */
export const setTouchPanEnabled = (enabled) => {
  touchPanEnabled = enabled;
  if (!enabled) {
    // Reset pan state when disabled
    panOffset = { x: 0, y: 0 };
    touchStartPos = null;
  }
};

// Smoothed values
let smoothedBeta = 0;
let smoothedGamma = 0;
let targetBeta = 0;
let targetGamma = 0;

/**
 * Gets the current screen orientation.
 */
const getScreenOrientation = () => {
  if (window.screen?.orientation?.type) {
    return window.screen.orientation.type;
  }
  // Fallback for older browsers
  const angle = window.orientation;
  if (angle === 0) return 'portrait-primary';
  if (angle === 180) return 'portrait-secondary';
  if (angle === 90) return 'landscape-primary';
  if (angle === -90) return 'landscape-secondary';
  return 'portrait-primary';
};

/**
 * Transforms device orientation values based on screen rotation.
 * Returns { beta, gamma } adjusted for current screen orientation.
 */
const transformForOrientation = (beta, gamma, orientation) => {
  switch (orientation) {
    case 'portrait-primary':
      // Normal portrait - no transformation needed
      return { beta, gamma };
    
    case 'portrait-secondary':
      // Upside down portrait (rare)
      return { beta: -beta, gamma: -gamma };
    
    case 'landscape-primary':
      // Landscape with home button on right (or natural landscape for tablets)
      // Swap axes: device tilt left/right becomes front/back
      return { beta: -gamma, gamma: beta };
    
    case 'landscape-secondary':
      // Landscape with home button on left
      // Swap and invert: device tilt left/right becomes front/back (reversed)
      return { beta: gamma, gamma: -beta };
    
    default:
      return { beta, gamma };
  }
};

/**
 * Converts device orientation Euler angles (alpha, beta, gamma) to a quaternion.
 * Uses the ZXY rotation order as defined by the W3C Device Orientation spec:
 *   R = Rz(alpha) · Rx(beta) · Ry(gamma)
 * The quaternion is in the device's physical coordinate frame (no screen rotation).
 * This gives a continuous rotation representation free of gimbal lock.
 * @param {number} alpha - Z-axis rotation [0, 360)
 * @param {number} beta  - X-axis rotation [-180, 180)
 * @param {number} gamma - Y-axis rotation [-90, 90)
 * @returns {THREE.Quaternion}
 */
const deviceOrientationToQuaternion = (alpha, beta, gamma) => {
  const degToRad = THREE.MathUtils.degToRad;
  // W3C spec: R = Rz(alpha) · Rx(beta) · Ry(gamma)
  // THREE.js 'ZXY' order: Rz(z) · Rx(x) · Ry(y)  →  x=beta, y=gamma, z=alpha
  const euler = new THREE.Euler(
    degToRad(beta),
    degToRad(gamma),
    degToRad(alpha),
    'ZXY'
  );
  return new THREE.Quaternion().setFromEuler(euler);
};

/**
 * Extracts pitch (up/down tilt) and yaw (left/right tilt) deltas from the
 * relative quaternion between baseline and current device orientation.
 * Returns values in degrees in the device's physical frame, free of gimbal lock.
 *   pitchDeg ≈ beta change  (rotation around device X axis, forward/back tilt)
 *   yawDeg   ≈ gamma change (rotation around device Y axis, left/right tilt)
 */
const getOrientationDelta = (currentQ, baseQ) => {
  // Relative rotation: how has the device rotated since baseline?
  const relativeQ = baseQ.clone().conjugate().multiply(currentQ);

  // Project the device's forward (into-screen) vector through the relative rotation.
  // In device coords: X = right edge, Y = top edge, Z = out of screen.
  // forward = (0, 0, -1) = looking into the screen.
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(relativeQ);

  // forward.x = rightward deflection  → gamma-like (left/right tilt, Y-axis rotation)
  // forward.y = upward deflection     → beta-like  (forward/back tilt, X-axis rotation)
  const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z));
  const pitchDeg = THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1))
  );

  return { pitchDeg, yawDeg };
};

/**
 * Remaps pitch/yaw deltas (in device physical frame) to screen-relative axes.
 * Matches the same axis swapping as transformForOrientation did for raw Euler angles.
 *   pitchDeg = device beta-like,  yawDeg = device gamma-like
 * Returns { mappedPitch, mappedYaw } in screen-relative coordinates.
 */
const remapForScreenOrientation = (pitchDeg, yawDeg, orientation) => {
  switch (orientation) {
    case 'portrait-primary':
      return { mappedPitch: pitchDeg, mappedYaw: yawDeg };
    case 'portrait-secondary':
      return { mappedPitch: -pitchDeg, mappedYaw: -yawDeg };
    case 'landscape-primary':
      return { mappedPitch: yawDeg, mappedYaw: -pitchDeg };
    case 'landscape-secondary':
      return { mappedPitch: -yawDeg, mappedYaw: pitchDeg };
    default:
      return { mappedPitch: pitchDeg, mappedYaw: yawDeg };
  }
};

/**
 * Handles screen orientation change.
 */
const handleOrientationChange = () => {
  screenOrientation = getScreenOrientation();
  // Reset baseline when orientation changes
  resetImmersiveBaseline();
  console.log('Screen orientation changed to:', screenOrientation);
};

/**
 * Gets the current immersive mode state from store.
 */
const getImmersiveMode = () => useStore.getState().immersiveMode;

/**
 * Requests permission for device orientation on iOS 13+.
 * Returns true if permission granted or not needed.
 */
export const requestOrientationPermission = async () => {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        console.warn('Device orientation permission denied');
        return false;
      }
    } catch (err) {
      console.warn('Device orientation permission denied:', err);
      return false;
    }
  }
  // Permission not required on this device or granted
  return true;
};

/**
 * Requests permission for device motion (accelerometer) on iOS 13+.
 * Returns true if permission granted or not needed.
 */
const requestMotionPermission = async () => {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') {
        console.warn('Device motion permission denied');
        return false;
      }
    } catch (err) {
      console.warn('Device motion permission denied:', err);
      return false;
    }
  }
  // Permission not required on this device or granted
  return true;
};

/**
 * Checks if a slide transition is currently active.
 * Used to block camera input during transitions.
 */
const isSlideTransitionActive = () => {
  const viewerEl = document.getElementById('viewer');
  return viewerEl?.classList.contains('slide-out') || viewerEl?.classList.contains('slide-in');
};

/**
 * Checks if slideshow is actively auto-playing.
 * Used to block immersive input while slideshow is running (not paused).
 */
const isSlideshowPlaybackActive = () => {
  return Boolean(useStore.getState().slideshowPlaying);
};

/**
 * Handles device orientation event.
 * Stores raw alpha/beta/gamma - actual camera update happens in unified loop.
 * Screen orientation compensation is applied via quaternion in the update loop.
 */
const handleDeviceOrientation = (event) => {
  if (!isActive || isPaused) return;
  
  const { alpha, beta, gamma } = event;
  if (alpha === null || beta === null || gamma === null) return;
  
  rawOrientation.alpha = alpha;
  rawOrientation.beta = beta;
  rawOrientation.gamma = gamma;
};

/**
 * Handles touch start for panning.
 */
const handleTouchStart = (event) => {
  if (!isActive || isPaused || !touchPanEnabled) return;
  if (event.touches.length !== 1) return; // Only single finger
  
  const touch = event.touches[0];
  touchStartPos = { x: touch.clientX, y: touch.clientY };
};

/**
 * Handles touch move for panning.
 */
const handleTouchMove = (event) => {
  if (!isActive || isPaused || !touchPanEnabled || !touchStartPos) return;
  if (event.touches.length !== 1) return; // Only single finger
  
  const touch = event.touches[0];
  const deltaX = touch.clientX - touchStartPos.x;
  const deltaY = touch.clientY - touchStartPos.y;
  
  // Update start position for continuous drag
  touchStartPos = { x: touch.clientX, y: touch.clientY };
  
  // Get distance for scaling pan amount
  const distance = baseSpherical?.radius ?? camera.position.distanceTo(controls.target);
  
  // Apply pan (negative X because dragging right should move view left)
  const panScale = TOUCH_PAN_SENSITIVITY.scale * touchPanScaleMultiplier;
  panOffset.x -= deltaX * panScale * distance;
  panOffset.y += deltaY * panScale * distance; // Y is inverted in screen coords
  
  // Clamp pan offset
  const maxPan = TOUCH_PAN_SENSITIVITY.maxPanOffset * distance;
  panOffset.x = THREE.MathUtils.clamp(panOffset.x, -maxPan, maxPan);
  panOffset.y = THREE.MathUtils.clamp(panOffset.y, -maxPan, maxPan);
};

/**
 * Handles touch end for panning.
 */
const handleTouchEnd = (event) => {
  if (event.touches.length === 0) {
    touchStartPos = null;
  }
};

/**
 * Unified update loop - combines orientation and touch pan inputs.
 * Runs on requestAnimationFrame to ensure smooth, jitter-free updates.
 */
const immersiveUpdateLoop = () => {
  if (!isActive || isPaused || !camera || !controls) {
    updateLoopId = requestAnimationFrame(immersiveUpdateLoop);
    return;
  }

  // Block input while slideshow is actively playing.
  if (isSlideshowPlaybackActive()) {
    wasBlockedBySlideshowPlayback = true;
    touchStartPos = null;
    updateLoopId = requestAnimationFrame(immersiveUpdateLoop);
    return;
  }

  // Slideshow unblocked; re-baseline to avoid camera jumps from accumulated device movement.
  if (wasBlockedBySlideshowPlayback) {
    resetImmersiveBaseline();
    wasBlockedBySlideshowPlayback = false;
  }
  
  // Block input during slide transitions
  if (isSlideTransitionActive()) {
    wasBlockedBySlideTransition = true;
    touchStartPos = null;
    updateLoopId = requestAnimationFrame(immersiveUpdateLoop);
    return;
  }

  // Slide transition ended; re-baseline to avoid camera jumps.
  if (wasBlockedBySlideTransition) {
    resetImmersiveBaseline();
    wasBlockedBySlideTransition = false;
  }
  
  let needsRender = false;
  
  // === Process Orientation (Orbit) via Quaternion (gimbal-lock free) ===
  if (rotationEnabled && rawOrientation.alpha !== null && rawOrientation.beta !== null && rawOrientation.gamma !== null) {
    const currentQ = deviceOrientationToQuaternion(
      rawOrientation.alpha, rawOrientation.beta, rawOrientation.gamma
    );

    // Initialize base values on first reading
    if (baseDeviceQuaternion === null) {
      baseDeviceQuaternion = currentQ.clone();
      smoothedBeta = 0;
      smoothedGamma = 0;
      targetBeta = 0;
      targetGamma = 0;
      
      // Capture current camera position as baseline
      const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
      baseSpherical = new THREE.Spherical().setFromVector3(offset);
    } else {
      // Get gimbal-lock-free pitch/yaw deltas in device physical frame
      const { pitchDeg, yawDeg } = getOrientationDelta(currentQ, baseDeviceQuaternion);
      
      // Remap axes for current screen orientation (landscape swaps axes, etc.)
      const { mappedPitch, mappedYaw } = remapForScreenOrientation(
        pitchDeg, yawDeg, screenOrientation
      );
      
      // Soft clamping using tanh for smooth boundaries
      const softClamp = (value, limit) => {
        const normalized = value / limit;
        return limit * Math.tanh(normalized);
      };
      
      // Apply soft clamping for smooth boundary behavior
      targetBeta = softClamp(mappedPitch, currentSensitivity.maxAngle);
      targetGamma = softClamp(-mappedYaw, currentSensitivity.maxAngle);
      
      // Apply smoothing (interpolate towards target)
      smoothedBeta += (targetBeta - smoothedBeta) * currentSensitivity.smoothing;
      smoothedGamma += (targetGamma - smoothedGamma) * currentSensitivity.smoothing;
    }
  }
  
  // === Pan is handled directly in touch handlers (panOffset is updated there) ===
  
  // === Apply Combined Camera Transform ===
  if (baseSpherical) {
    const newSpherical = baseSpherical.clone();
    
    // Apply orientation-based orbit
    newSpherical.theta = baseSpherical.theta + smoothedGamma * currentSensitivity.tilt;
    newSpherical.phi = baseSpherical.phi + smoothedBeta * currentSensitivity.tilt;
    
    // Clamp phi
    const minPhi = 0.02;
    const maxPhi = Math.PI - 0.02;
    newSpherical.phi = THREE.MathUtils.clamp(newSpherical.phi, minPhi, maxPhi);
    
    // Calculate base position from orbit (relative to base target)
    const orbitOffset = new THREE.Vector3().setFromSpherical(newSpherical);
    
    // Calculate pan displacement in camera space (true pan = move camera + target together)
    let panDisplacement = new THREE.Vector3();
    if (touchPanEnabled && (Math.abs(panOffset.x) > 0.0001 || Math.abs(panOffset.y) > 0.0001)) {
      // Get camera's right and up vectors from the orbit position
      // We need to compute these based on the spherical coordinates
      const tempCamPos = new THREE.Vector3().copy(baseCameraTarget ?? controls.target).add(orbitOffset);
      const forward = new THREE.Vector3().subVectors(baseCameraTarget ?? controls.target, tempCamPos).normalize();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const cameraRight = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
      const cameraUp = new THREE.Vector3().crossVectors(cameraRight, forward).normalize();
      
      // Pan displacement moves both camera and target
      panDisplacement.addScaledVector(cameraRight, panOffset.x);
      panDisplacement.addScaledVector(cameraUp, panOffset.y);
    }
    
    // Apply pan offset to target (true panning)
    const pannedTarget = (baseCameraTarget ?? controls.target).clone().add(panDisplacement);
    
    // Position camera relative to panned target
    camera.position.copy(pannedTarget).add(orbitOffset);
    camera.lookAt(pannedTarget);
    
    // Update controls target to match (so manual controls work correctly after)
    controls.target.copy(pannedTarget);
    
    needsRender = true;
  }
  
  if (needsRender) {
    requestRender();
  }
  
  updateLoopId = requestAnimationFrame(immersiveUpdateLoop);
};

/**
 * Enables immersive mode.
 * Disables orbit controls and starts listening to device orientation and touch.
 */
export const enableImmersiveMode = async () => {
  if (isActive) return true;
  
  // Request orientation permission if needed (iOS)
  const hasOrientationPermission = await requestOrientationPermission();
  if (!hasOrientationPermission) {
    console.warn('Immersive mode requires device orientation permission');
    return false;
  }
  
  // Get initial screen orientation
  screenOrientation = getScreenOrientation();
  
  // Disable load animations
  setLoadAnimationEnabled(false);
  
  // Disable orbit controls drag (but keep zoom/pan)
  if (controls) {
    controls.enableRotate = false;
    controls.enablePan = false; // We handle pan ourselves
  }
  
  // Reset orientation state
  lastBeta = null;
  lastGamma = null;
  smoothedBeta = 0;
  smoothedGamma = 0;
  baseSpherical = null;
  baseDeviceQuaternion = null;
  rawOrientation = { alpha: null, beta: null, gamma: null };
  
  // Reset pan state
  panOffset = { x: 0, y: 0 };
  touchStartPos = null;
  baseCameraTarget = controls?.target?.clone() ?? null;
  wasBlockedBySlideshowPlayback = false;
  wasBlockedBySlideTransition = false;
  
  // Start listening to device orientation (just stores values)
  window.addEventListener('deviceorientation', handleDeviceOrientation, true);
  
  // Start listening to touch events for panning
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) {
    viewerEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    viewerEl.addEventListener('touchmove', handleTouchMove, { passive: true });
    viewerEl.addEventListener('touchend', handleTouchEnd, { passive: true });
  }
  
  // Listen for screen orientation changes
  if (window.screen?.orientation) {
    window.screen.orientation.addEventListener('change', handleOrientationChange);
  } else {
    // Fallback for older browsers
    window.addEventListener('orientationchange', handleOrientationChange);
  }
  
  // Start unified update loop
  if (updateLoopId) {
    cancelAnimationFrame(updateLoopId);
  }
  updateLoopId = requestAnimationFrame(immersiveUpdateLoop);
  
  isActive = true;
  console.log('Immersive mode enabled (touch pan:', touchPanEnabled ? 'on' : 'off', ')');
  return true;
};

/**
 * Disables immersive mode.
 * Re-enables orbit controls and stops listening to device orientation and touch.
 */
export const disableImmersiveMode = () => {
  if (!isActive) return;
  
  // Stop unified update loop
  if (updateLoopId) {
    cancelAnimationFrame(updateLoopId);
    updateLoopId = null;
  }
  
  // Stop listening to device orientation
  window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
  
  // Stop listening to touch events
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) {
    viewerEl.removeEventListener('touchstart', handleTouchStart);
    viewerEl.removeEventListener('touchmove', handleTouchMove);
    viewerEl.removeEventListener('touchend', handleTouchEnd);
  }
  
  // Stop listening to screen orientation changes
  if (window.screen?.orientation) {
    window.screen.orientation.removeEventListener('change', handleOrientationChange);
  } else {
    window.removeEventListener('orientationchange', handleOrientationChange);
  }
  
  // Re-enable orbit controls
  if (controls) {
    controls.enableRotate = true;
    controls.enablePan = true;
  }
  
  // Re-enable load animations (restore from store)
  const storedAnimationEnabled = useStore.getState().animationEnabled;
  setLoadAnimationEnabled(storedAnimationEnabled);
  
  // Reset orientation state
  isActive = false;
  lastBeta = null;
  lastGamma = null;
  baseSpherical = null;
  baseDeviceQuaternion = null;
  
  // Reset pan state
  panOffset = { x: 0, y: 0 };
  touchStartPos = null;
  baseCameraTarget = null;
  wasBlockedBySlideshowPlayback = false;
  wasBlockedBySlideTransition = false;
  
  console.log('Immersive mode disabled');
};

/**
 * Toggles immersive mode.
 */
const toggleImmersiveMode = async () => {
  if (isActive) {
    disableImmersiveMode();
    return false;
  } else {
    return await enableImmersiveMode();
  }
};

/**
 * Resets the baseline orientation to current device position.
 * Call this to re-center the parallax effect.
 */
export const resetImmersiveBaseline = () => {
  // Reset orientation baseline
  lastBeta = null;
  lastGamma = null;
  smoothedBeta = 0;
  smoothedGamma = 0;
  targetBeta = 0;
  targetGamma = 0;
  baseSpherical = null;
  baseDeviceQuaternion = null;
  rawOrientation = { alpha: null, beta: null, gamma: null };
  
  // Reset pan state
  panOffset = { x: 0, y: 0 };
  touchStartPos = null;
  baseCameraTarget = controls?.target?.clone() ?? null;
};

/**
 * Pauses immersive mode temporarily (e.g., during camera reset animation).
 */
export const pauseImmersiveMode = () => {
  isPaused = true;
};

/**
 * Resumes immersive mode after pause, resetting baseline to current position.
 */
export const resumeImmersiveMode = () => {
  if (isActive) {
    // Reset baseline so camera starts fresh from new position
    resetImmersiveBaseline();
    isPaused = false;
  }
};

/**
 * Syncs the immersive baseline to the current camera state without pausing input.
 * Useful when external camera changes occur (e.g., FOV changes).
 */
export const syncImmersiveBaseline = () => {
  if (!isActive) return;
  resetImmersiveBaseline();
};

/**
 * Performs a camera recenter while in immersive mode.
 * Pauses orientation input, resets camera, then resumes with new baseline.
 */
export const recenterInImmersiveMode = (recenterCallback, duration = 600) => {
  if (!isActive) {
    // Not in immersive mode, just do normal recenter
    recenterCallback();
    return;
  }
  
  // Pause orientation input
  pauseImmersiveMode();
  
  // Perform recenter
  recenterCallback();
  
  // Resume after animation completes
  setTimeout(() => {
    resumeImmersiveMode();
  }, duration + 100); // Small buffer after animation
};

/**
 * Returns whether immersive mode is currently active.
 */
export const isImmersiveModeActive = () => isActive;

/**
 * Returns whether immersive mode is paused.
 */
const isImmersiveModePaused = () => isPaused;

/**
 * Returns whether rotation (orientation-based orbit) is currently enabled.
 */
const isRotationEnabled = () => rotationEnabled;

/**
 * Returns whether touch panning is currently enabled.
 */
const isTouchPanEnabled = () => touchPanEnabled;
