/**
 * Idle auto-orbit controller for custom models.
 */
import { camera, controls, requestRender, THREE } from './viewer.js';
import { useStore } from './store.js';
import {
  AUTO_ORBIT_MOTION_BY_SPEED,
  normalizeAutoOrbitSettings,
} from './autoOrbitConfig.js';

let idleTimerId = null;
let frameId = null;
let startTime = 0;
let startOffset = null;
let startTarget = null;
let transitionActive = false;
let manuallyPaused = false;

const cancelIdleTimer = () => {
  if (idleTimerId != null) {
    clearTimeout(idleTimerId);
    idleTimerId = null;
  }
};

const canAutoOrbit = () => {
  const state = useStore.getState();
  const settings = normalizeAutoOrbitSettings(state.fileCustomAnimation?.autoOrbit);
  return Boolean(
    settings.enabled
    && state.isCustomModel
    && !state.isLoading
    && !state.slideshowPlaying
    && !state.immersiveMode
    && !state.vrSessionActive
    && !state.focusSettingActive
    && !transitionActive
    && !manuallyPaused
    && camera
    && controls
    && controls.enabled,
  );
};

const getSettings = () => normalizeAutoOrbitSettings(
  useStore.getState().fileCustomAnimation?.autoOrbit,
);

const getSmoothStartupAngle = (elapsedSeconds, durationSeconds, startupDuration) => {
  if (startupDuration <= 0 || elapsedSeconds >= startupDuration) {
    return elapsedSeconds / durationSeconds - startupDuration / durationSeconds * (1 - 2 / Math.PI);
  }

  const progress = elapsedSeconds / startupDuration;
  return (startupDuration / durationSeconds) * (1 - Math.cos(progress * Math.PI / 2)) * 2 / Math.PI;
};

const stepAutoOrbit = (timestamp) => {
  frameId = null;
  if (!canAutoOrbit() || !startOffset || !startTarget) {
    cancelAutoOrbit();
    return;
  }

  const settings = getSettings();
  const profile = AUTO_ORBIT_MOTION_BY_SPEED[settings.speed];
  const elapsedSeconds = Math.max(0, (timestamp - startTime) / 1000);
  const direction = settings.path === '360-counterclockwise' ? -1 : 1;
  let angle;

  if (settings.path === '180') {
    // A sine arc reaches zero velocity at each endpoint before reversing.
    const halfSweep = Math.PI / 2;
    const cycle = (elapsedSeconds / profile.fullRotationDuration) * Math.PI * 2;
    angle = Math.sin(cycle) * halfSweep;
  } else {
    angle = getSmoothStartupAngle(
      elapsedSeconds,
      profile.fullRotationDuration / (Math.PI * 2),
      profile.startupDuration,
    ) * direction;
  }

  const up = camera.up.clone().normalize();
  if (up.lengthSq() < 1e-6) {
    up.set(0, 1, 0);
  }

  const orbitOffset = startOffset.clone().applyAxisAngle(up, angle);
  if (settings.mode === 'rotate') {
    controls.target.copy(camera.position).sub(orbitOffset);
  } else {
    controls.target.copy(startTarget);
    camera.position.copy(startTarget).add(orbitOffset);
  }
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  controls.update();
  requestRender();
  frameId = requestAnimationFrame(stepAutoOrbit);
};

export const cancelAutoOrbit = () => {
  cancelIdleTimer();
  if (frameId != null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }
  startTime = 0;
  startOffset = null;
  startTarget = null;
  useStore.getState().setAutoOrbitPlaying(false);
};

export const beginAutoOrbitTransition = () => {
  transitionActive = true;
  cancelAutoOrbit();
};

export const startAutoOrbit = () => {
  cancelIdleTimer();
  if (!canAutoOrbit()) return;

  const offset = camera.position.clone().sub(controls.target);
  if (offset.lengthSq() < 1e-6) return;

  if (frameId != null) {
    cancelAnimationFrame(frameId);
  }
  startOffset = offset;
  startTarget = controls.target.clone();
  startTime = performance.now();
  useStore.getState().setAutoOrbitPlaying(true);
  frameId = requestAnimationFrame(stepAutoOrbit);
};

export const toggleAutoOrbit = () => {
  const state = useStore.getState();
  if (frameId != null || idleTimerId != null || state.autoOrbitPlaying) {
    manuallyPaused = true;
    cancelAutoOrbit();
    return false;
  }
  manuallyPaused = false;
  startAutoOrbit();
  return frameId != null;
};

export const scheduleAutoOrbit = () => {
  startAutoOrbit();
};

export const endAutoOrbitTransition = () => {
  transitionActive = false;
  scheduleAutoOrbit();
};

export const handleAutoOrbitInputStart = () => {
  cancelAutoOrbit();
};

export const handleAutoOrbitInputEnd = () => {
  scheduleAutoOrbit();
};

export const refreshAutoOrbit = () => {
  if (!getSettings().enabled) {
    manuallyPaused = false;
  }
  scheduleAutoOrbit();
};