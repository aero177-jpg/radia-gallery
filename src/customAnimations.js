import { camera, controls, requestRender, THREE } from "./viewer.js";
import { useStore } from "./store.js";

// Store accessor
const getStoreState = () => useStore.getState();

// Easing used for load animation
const easingFunctions = {
  linear: (t) => t,
  "ease-in": (t) => t * t * t,
  "ease-out": (t) => 1 - Math.pow(1 - t, 3),
  "ease-in-out": (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

// Sweep direction presets (startDeg is the offset from center)
const sweepPresets = {
  left: { axis: "up", direction: 1 },
  right: { axis: "up", direction: -1 },
  up: { axis: "right", direction: -1 },
  down: { axis: "right", direction: 1 },
};

// Intensity presets
const intensityPresets = {
  subtle: { zoomFactor: 0.05, duration: 1200, sweepDegrees: 4 },
  medium: { zoomFactor: 0.1, duration: 1800, sweepDegrees: 8 },
  dramatic: { zoomFactor: 0.15, duration: 2400, sweepDegrees: 12 },
};

const validDirections = ["left", "right", "up", "down", "none"];

// Get animation settings from store
const getAnimationEnabled = () => getStoreState().animationEnabled;

const isLoadAnimationEnabled = () => getAnimationEnabled();

export const setLoadAnimationEnabled = (enabled) => {
  getStoreState().setAnimationEnabled(enabled);
};

export const cancelLoadZoomAnimation = () => {
  if (animationState?.frameId) {
    cancelAnimationFrame(animationState.frameId);
  }
  if (animationState) {
    controls.enabled = animationState.wasEnabled;
    controls.update();
    requestRender();
  }
  animationState = null;
};

const getLoadAnimationIntensityKey = () => getStoreState().animationIntensity;

export const setLoadAnimationIntensity = (key) => {
  if (intensityPresets[key] || key === "custom") {
    getStoreState().setAnimationIntensity(key);
    return key;
  }
  return getStoreState().animationIntensity;
};

const getLoadAnimationDirection = () => getStoreState().animationDirection;

export const setLoadAnimationDirection = (direction) => {
  const normalized = direction?.toLowerCase?.();
  if (validDirections.includes(normalized)) {
    getStoreState().setAnimationDirection(normalized);
    return normalized;
  }
  return getStoreState().animationDirection;
};

/**
 * Builds animation parameters from either a preset or custom settings.
 */
const buildAnimationParams = (distance) => {
  const state = getStoreState();
  const intensityKey = state.animationIntensity;

  if (intensityKey === "custom") {
    const custom = state.customAnimation;
    const duration = custom.duration * 1000; // Convert to ms
    const easing = easingFunctions[custom.easing] ?? easingFunctions["ease-in-out"];

    // Rotation params
    const rotationType = custom.rotationType;
    const sweepDegrees = rotationType === "none" ? 0 : custom.rotation;
    const sweepPreset = sweepPresets[rotationType] ?? null;

    // Zoom params
    const zoomType = custom.zoomType;
    const zoomAmount = custom.zoom * 0.15;
    let startZoomOffset = 0;
    let endZoomOffset = 0;
    if (zoomType === "in") {
      startZoomOffset = zoomAmount * 0.2;
      endZoomOffset = -zoomAmount * 0.3;
    } else if (zoomType === "out") {
      startZoomOffset = -zoomAmount * 0.5;
      endZoomOffset = 0;
    }

    return { duration, easing, sweepDegrees, sweepPreset, startZoomOffset, endZoomOffset };
  }

  const preset = intensityPresets[intensityKey] ?? intensityPresets.medium;
  const direction = state.animationDirection;
  const sweepPreset = direction === "none" ? null : sweepPresets[direction] ?? sweepPresets.left;

  return {
    duration: preset.duration,
    easing: easingFunctions["ease-out"],
    sweepDegrees: preset.sweepDegrees,
    sweepPreset,
    startZoomOffset: preset.zoomFactor,
    endZoomOffset: 0,
  };
};

let animationState = null;

export const startLoadZoomAnimation = (options = {}) => {
  const normalizedOptions = typeof options === "string" ? { direction: options } : options ?? {};
  const forcePlayback = Boolean(normalizedOptions.force);
  const onComplete = normalizedOptions.onComplete;

  if (!camera || !controls || (!getAnimationEnabled() && !forcePlayback)) return;

  const baseOffset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const distance = baseOffset.length();
  if (!Number.isFinite(distance) || distance <= 0.01) return;

  const { duration, easing, sweepDegrees, sweepPreset, startZoomOffset, endZoomOffset } = buildAnimationParams(distance);
  if (duration <= 0 || (sweepDegrees === 0 && startZoomOffset === 0 && endZoomOffset === 0)) return;

  const upVector = (controls.object?.up ?? controls.up ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const rightVector = new THREE.Vector3().copy(baseOffset).cross(upVector);
  if (rightVector.lengthSq() < 1e-6) {
    rightVector.copy(upVector).cross(new THREE.Vector3(1, 0, 0));
    if (rightVector.lengthSq() < 1e-6) {
      rightVector.copy(upVector).cross(new THREE.Vector3(0, 0, 1));
    }
  }
  rightVector.normalize();

  const axisVector = sweepPreset ? (sweepPreset.axis === "right" ? rightVector : upVector).clone() : upVector.clone();
  const startAngle = sweepPreset ? THREE.MathUtils.degToRad(sweepDegrees * sweepPreset.direction) : 0;
  const endAngle = 0;

  const startRadius = distance * (1 + startZoomOffset);
  const endRadius = distance * (1 + endZoomOffset);

  const animTarget = controls.target.clone();
  const initialOffset = baseOffset.clone().applyAxisAngle(axisVector, startAngle).setLength(startRadius);
  camera.position.copy(animTarget).add(initialOffset);
  camera.lookAt(animTarget);

  const wasEnabled = controls.enabled;
  controls.enabled = false;

  const savedLimits = {
    minAzimuthAngle: controls.minAzimuthAngle,
    maxAzimuthAngle: controls.maxAzimuthAngle,
    minPolarAngle: controls.minPolarAngle,
    maxPolarAngle: controls.maxPolarAngle,
  };
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  requestRender();

  cancelLoadZoomAnimation();

  const animate = (timestamp) => {
    if (!animationState) return;

    if (animationState.startTime == null) {
      animationState.startTime = timestamp;
    }

    const elapsed = timestamp - animationState.startTime;
    const t = Math.min(elapsed / animationState.duration, 1);
    const eased = animationState.easing(t);

    const angle = THREE.MathUtils.lerp(animationState.startAngle, animationState.endAngle, eased);
    const radius = THREE.MathUtils.lerp(animationState.startRadius, animationState.endRadius, eased);
    const offset = animationState.baseOffset
      .clone()
      .applyAxisAngle(animationState.axisVector, angle)
      .setLength(radius);
    camera.position.copy(animationState.animTarget).add(offset);
    camera.lookAt(animationState.animTarget);
    requestRender();

    if (t < 1) {
      animationState.frameId = requestAnimationFrame(animate);
    } else {
      controls.minAzimuthAngle = animationState.savedLimits.minAzimuthAngle;
      controls.maxAzimuthAngle = animationState.savedLimits.maxAzimuthAngle;
      controls.minPolarAngle = animationState.savedLimits.minPolarAngle;
      controls.maxPolarAngle = animationState.savedLimits.maxPolarAngle;

      controls.enabled = animationState.wasEnabled;
      controls.update();
      requestRender();

      const callback = animationState.onComplete;
      animationState = null;
      if (callback) callback();
    }
  };

  animationState = {
    frameId: requestAnimationFrame(animate),
    startTime: null,
    baseOffset,
    axisVector,
    startAngle,
    endAngle,
    startRadius,
    endRadius,
    duration,
    easing,
    animTarget,
    wasEnabled,
    savedLimits,
    onComplete,
  };
};
