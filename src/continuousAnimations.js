/**
 * Continuous slideshow animations: zoom, orbit, and vertical-orbit.
 * These run as long-lived GSAP tweens during slideshow "continuous" mode.
 */
import { camera, controls, requestRender, forceRenderNow, THREE, updateDollyZoomBaselineFromCamera } from "./viewer.js";
import { useStore } from "./store.js";
import gsap from "gsap";

// ============================================================================
// Configuration
// ============================================================================

const CONTINUOUS_ZOOM_DURATION = 5; // seconds
const CONTINUOUS_ZOOM_START_RATIO_BY_SIZE = {
  small: 0.04,
  medium: 0.08,
  large: 0.12,
};
const CONTINUOUS_ZOOM_END_RATIO_BY_SIZE = {
  small: 0.22,
  medium: 0.30,
  large: 0.36,
};

const CONTINUOUS_DOLLY_ZOOM_DEGREES_BY_SIZE = {
  small: { startDelta: 10, endDelta: 0 },
  medium: { startDelta: 20, endDelta: -10 },
  large: { startDelta: 30, endDelta: -20 },
};

const CONTINUOUS_ORBIT_DURATION = 10;
const CONTINUOUS_ORBIT_ANGLE_DEG = 12;
const CONTINUOUS_ORBIT_PAN_SCALE = 0.4;

const CONTINUOUS_VERTICAL_ORBIT_DURATION = 10;
const CONTINUOUS_VERTICAL_ORBIT_ANGLE_DEG = 12;
const CONTINUOUS_VERTICAL_ORBIT_PAN_SCALE = 0.4;

const CONTINUOUS_SIZE_SCALE = {
  small: 0.45,
  medium: 0.65,
  large: 0.85,
};

// ============================================================================
// Internal state
// ============================================================================

let continuousZoomTween = null;
let continuousDollyZoomTween = null;
let continuousOrbitTween = null;
let continuousOrbitState = null;
let continuousVerticalOrbitTween = null;
let continuousVerticalOrbitState = null;

// ============================================================================
// Helpers
// ============================================================================

const getStoreState = () => useStore.getState();

const getEffectiveSlideType = () => {
  const { slideMode, fileCustomAnimation } = getStoreState();
  const fileSlideType = fileCustomAnimation?.slideType;
  if (fileSlideType && fileSlideType !== 'default') {
    return fileSlideType;
  }
  return slideMode ?? 'horizontal';
};

const getEffectiveContinuousRangeKey = () => {
  const { continuousMotionSize, fileCustomAnimation } = getStoreState();
  const transitionRange = fileCustomAnimation?.transitionRange;
  if (transitionRange && transitionRange !== 'default') {
    return transitionRange;
  }
  return continuousMotionSize ?? 'large';
};

const getContinuousSizeScale = () => {
  const rangeKey = getEffectiveContinuousRangeKey();
  return CONTINUOUS_SIZE_SCALE[rangeKey] ?? CONTINUOUS_SIZE_SCALE.large;
};

const getContinuousZoomRatios = () => {
  const { fileCustomAnimation } = getStoreState();
  const sizeKey = getEffectiveContinuousRangeKey();
  const zoomProfile = getEffectiveSlideType() === 'zoom' ? fileCustomAnimation?.zoomProfile : null;

  if (zoomProfile === 'near') {
    return {
      start: CONTINUOUS_ZOOM_START_RATIO_BY_SIZE.small,
      end: CONTINUOUS_ZOOM_END_RATIO_BY_SIZE.small,
    };
  }

  if (zoomProfile === 'medium') {
    return {
      start: CONTINUOUS_ZOOM_START_RATIO_BY_SIZE.small,
      end: 0.5,
    };
  }

  if (zoomProfile === 'far') {
    const deepEnd = 0.9;
    return {
      start: 0,
      end: deepEnd,
    };
  }

  return {
    start: CONTINUOUS_ZOOM_START_RATIO_BY_SIZE[sizeKey] ?? CONTINUOUS_ZOOM_START_RATIO_BY_SIZE.large,
    end: CONTINUOUS_ZOOM_END_RATIO_BY_SIZE[sizeKey] ?? CONTINUOUS_ZOOM_END_RATIO_BY_SIZE.large,
  };
};

const resolveDollyZoomProfileKey = () => {
  const { fileCustomAnimation } = getStoreState();
  const sizeKey = getEffectiveContinuousRangeKey();
  const zoomProfile = getEffectiveSlideType() === 'zoom' ? fileCustomAnimation?.zoomProfile : null;
  if (zoomProfile && zoomProfile !== 'default') {
    return zoomProfile;
  }
  if (sizeKey === 'small') return 'near';
  if (sizeKey === 'medium') return 'medium';
  return 'far';
};

const getContinuousDollyZoomDeltas = () => {
  const profileKey = resolveDollyZoomProfileKey();
  if (profileKey === 'near') return CONTINUOUS_DOLLY_ZOOM_DEGREES_BY_SIZE.small;
  if (profileKey === 'medium') return CONTINUOUS_DOLLY_ZOOM_DEGREES_BY_SIZE.medium;
  if (profileKey === 'far') return CONTINUOUS_DOLLY_ZOOM_DEGREES_BY_SIZE.large;
  return CONTINUOUS_DOLLY_ZOOM_DEGREES_BY_SIZE.large;
};

const getDurationScale = (durationSec, baseDurationSec) => {
  if (!Number.isFinite(durationSec) || !Number.isFinite(baseDurationSec) || baseDurationSec <= 0) {
    return 1;
  }
  return durationSec / baseDurationSec;
};

const getContinuousDurationSeconds = (mode, baseDurationSec) => {
  const { continuousMotionDuration } = getStoreState();
  const duration = Number.isFinite(continuousMotionDuration) ? continuousMotionDuration : baseDurationSec;
  return duration > 0 ? duration : baseDurationSec;
};

const applyOrbitLimitOverride = (stateRef) => {
  if (!stateRef) return;
  stateRef.savedLimits = {
    minAzimuthAngle: controls.minAzimuthAngle,
    maxAzimuthAngle: controls.maxAzimuthAngle,
    minPolarAngle: controls.minPolarAngle,
    maxPolarAngle: controls.maxPolarAngle,
  };
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
};

const restoreOrbitLimitOverride = (stateRef) => {
  if (!stateRef?.savedLimits) return;
  controls.minAzimuthAngle = stateRef.savedLimits.minAzimuthAngle;
  controls.maxAzimuthAngle = stateRef.savedLimits.maxAzimuthAngle;
  controls.minPolarAngle = stateRef.savedLimits.minPolarAngle;
  controls.maxPolarAngle = stateRef.savedLimits.maxPolarAngle;
  controls.update();
};

/** Debug: ?nofade disables the opacity fade between slides */
const noFade = new URLSearchParams(window.location.search).has('nofade');

/** Shared setup for continuous slide-in: toggle CSS classes, guard camera. */
const beginContinuousSlideIn = (durationMs) => {
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) {
    // Ensure slide-out is present (cancelSlideAnimation in the caller may have
    // stripped it). Use the .slide-out.slide-in combined rule to hold opacity: 0,
    // then remove slide-out so the slide-in transition fires from 0 → 1.
    viewerEl.classList.add('slide-out');
    if (!noFade) viewerEl.classList.add('slide-in');
    forceRenderNow();
    void viewerEl.offsetHeight;
    viewerEl.classList.remove('slide-out');
  }

  if (!camera || !controls) {
    return { viewerEl, fadeDurationSec: null, canAnimate: false };
  }

  const fadeDurationSec = Math.max(0.1, durationMs / 1000);
  return { viewerEl, fadeDurationSec, canAnimate: true };
};

/** Schedules CSS cleanup after the fade duration. */
const scheduleSlideInCleanup = (viewerEl, fadeDurationSec, resolve) => {
  if (!viewerEl || !Number.isFinite(fadeDurationSec)) {
    resolve();
    return;
  }

  setTimeout(() => {
    viewerEl.classList.remove('slide-out', 'slide-in');
    resolve();
  }, fadeDurationSec * 1000);
};

// ============================================================================
// Cancel helpers
// ============================================================================

export const cancelContinuousZoomAnimation = () => {
  if (continuousZoomTween) {
    continuousZoomTween.kill();
    continuousZoomTween = null;
  }
};

export const cancelContinuousDollyZoomAnimation = () => {
  if (continuousDollyZoomTween) {
    continuousDollyZoomTween.kill();
    continuousDollyZoomTween = null;
  }
};

export const cancelContinuousOrbitAnimation = () => {
  if (continuousOrbitTween) {
    continuousOrbitTween.kill();
    continuousOrbitTween = null;
  }
  if (continuousOrbitState) {
    restoreOrbitLimitOverride(continuousOrbitState);
    continuousOrbitState = null;
  }
};

export const cancelContinuousVerticalOrbitAnimation = () => {
  if (continuousVerticalOrbitTween) {
    continuousVerticalOrbitTween.kill();
    continuousVerticalOrbitTween = null;
  }
  if (continuousVerticalOrbitState) {
    restoreOrbitLimitOverride(continuousVerticalOrbitState);
    continuousVerticalOrbitState = null;
  }
};

// ============================================================================
// Same-base continuous handoff queue
// ============================================================================

/**
 * Queued handoff for seamless same-base view transitions.
 * When the current continuous animation completes, it picks this up
 * instead of stopping — glides to the next view and starts a new animation.
 */
let pendingHandoff = null;

/**
 * Queue a seamless handoff to the next view's continuous animation.
 * Call this while a continuous tween is still running; the tween's onComplete
 * will pick it up and chain directly.
 *
 * @param {Object} handoff
 * @param {string} handoff.slideMode - e.g. 'continuous-orbit'
 * @param {number} handoff.duration - slide-in duration (ms)
 * @param {number} handoff.amount - motion amount
 * @param {number} handoff.glideDuration - seconds for the glide to the new start offset
 * @param {Function} handoff.onApply - synchronous callback that applies model/aspect/camera/store
 * @param {Function} [handoff.onStarted] - called after the new animation begins
 */
export const queueContinuousHandoff = (handoff) => {
  pendingHandoff = handoff;
};

export const clearContinuousHandoff = () => {
  pendingHandoff = null;
};

/**
 * Process a queued handoff: capture current camera, apply next view state,
 * then start the next continuous animation with a glide from the old position.
 */
const processPendingHandoff = () => {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  if (!handoff) return false;

  // Snapshot where camera is NOW (end of previous animation)
  const glideFrom = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
  };

  // Apply all state changes (model, aspect, camera pose, store) — synchronous, no render
  handoff.onApply();

  // Look up the correct continuous function
  const fnMap = {
    'continuous-zoom': continuousZoomSlideIn,
    'continuous-dolly-zoom': continuousDollyZoomSlideIn,
    'continuous-orbit': continuousOrbitSlideIn,
    'continuous-orbit-vertical': continuousVerticalOrbitSlideIn,
  };
  const fn = fnMap[handoff.slideMode];

  if (fn) {
    fn(handoff.duration, handoff.amount, {
      glideDuration: handoff.glideDuration,
      glideFrom,
      skipFade: true,
      onMotionStart: () => {
        handoff.onStarted?.();
      },
    });
  } else {
    handoff.onStarted?.();
  }
  return true;
};

// ============================================================================
// Continuous slide-in animations
// ============================================================================

/**
 * Continuous-zoom slide-in: gentle dolly along the forward axis.
 * @returns {Promise} Resolves when CSS fade completes (tween continues in background).
 */
export const continuousZoomSlideIn = (duration, amount, options = {}) => {
  return new Promise((resolve) => {
    cancelContinuousZoomAnimation();

    const skipFade = options.skipFade ?? false;
    const glideFrom = options.glideFrom ?? null; // { position, target }

    if (!skipFade) {
      const { viewerEl, fadeDurationSec, canAnimate } = beginContinuousSlideIn(duration);
      if (!canAnimate) { resolve(); return; }
      scheduleSlideInCleanup(viewerEl, fadeDurationSec, resolve);
    } else {
      if (!camera || !controls) { resolve(); return; }
    }

    const currentPosition = camera.position.clone();
    const currentTarget = controls.target.clone();
    const distance = currentPosition.distanceTo(currentTarget);
    const forward = new THREE.Vector3().subVectors(currentTarget, currentPosition).normalize();

    const durationSec = getContinuousDurationSeconds('continuous-zoom', CONTINUOUS_ZOOM_DURATION);
    const { start: startRatio, end: endRatio } = getContinuousZoomRatios();

    const startOffset = forward.clone().multiplyScalar(-distance * startRatio);
    const endOffset = forward.clone().multiplyScalar(distance * endRatio);
    const startPosition = currentPosition.clone().add(startOffset);
    const endPosition = currentPosition.clone().add(endOffset);

    const glideDuration = options.glideDuration ?? 0;
    const onMotionStart = typeof options.onMotionStart === 'function'
      ? options.onMotionStart
      : null;

    const startMainAnimation = () => {
      onMotionStart?.();
      continuousZoomTween = gsap.to(camera.position, {
        x: endPosition.x,
        y: endPosition.y,
        z: endPosition.z,
        duration: durationSec,
        ease: "none",
        onUpdate: () => { controls.update(); requestRender(); },
        onComplete: () => {
          continuousZoomTween = null;
          if (pendingHandoff) { processPendingHandoff(); return; }
          if (skipFade) resolve();
        },
      });
    };

    if (glideDuration > 0) {
      const glideStartPos = glideFrom?.position ?? currentPosition;
      const glideStartTarget = glideFrom?.target ?? currentTarget;
      const glideStartFov = glideFrom?.fov ?? camera.fov;
      const glideEndFov = camera.fov;
      // Snap camera back to glideFrom immediately so there's no flash frame
      camera.position.copy(glideStartPos);
      controls.target.copy(glideStartTarget);
      camera.fov = glideStartFov;
      camera.updateProjectionMatrix();
      controls.update();
      const glideProxy = { t: 0 };
      continuousZoomTween = gsap.to(glideProxy, {
        t: 1,
        duration: glideDuration,
        ease: "power2.inOut",
        onUpdate: () => {
          camera.position.lerpVectors(glideStartPos, startPosition, glideProxy.t);
          controls.target.lerpVectors(glideStartTarget, currentTarget, glideProxy.t);
          if (glideStartFov !== glideEndFov) {
            camera.fov = THREE.MathUtils.lerp(glideStartFov, glideEndFov, glideProxy.t);
            camera.updateProjectionMatrix();
          }
          controls.update();
          requestRender();
        },
        onComplete: startMainAnimation,
      });
    } else {
      camera.position.copy(startPosition);
      controls.update();
      requestRender();
      startMainAnimation();
    }
  });
};

/**
 * Continuous dolly-zoom slide-in: animate FOV with dolly compensation.
 * @returns {Promise} Resolves when CSS fade completes (tween continues in background).
 */
export const continuousDollyZoomSlideIn = (duration, amount, options = {}) => {
  return new Promise((resolve) => {
    cancelContinuousDollyZoomAnimation();
    cancelContinuousZoomAnimation();
    cancelContinuousOrbitAnimation();
    cancelContinuousVerticalOrbitAnimation();

    const skipFade = options.skipFade ?? false;
    const glideFrom = options.glideFrom ?? null;

    if (!skipFade) {
      const { viewerEl, fadeDurationSec, canAnimate } = beginContinuousSlideIn(duration);
      if (!canAnimate) { resolve(); return; }
      scheduleSlideInCleanup(viewerEl, fadeDurationSec, resolve);
    } else {
      if (!camera || !controls) { resolve(); return; }
    }

    const { startDelta, endDelta } = getContinuousDollyZoomDeltas();

    const baseFov = camera.fov;
    const baseDistance = camera.position.distanceTo(controls.target);
    const baseDirection = new THREE.Vector3()
      .subVectors(camera.position, controls.target)
      .normalize();
    const baseTan = Math.tan(THREE.MathUtils.degToRad(baseFov / 2));

    const startFov = THREE.MathUtils.clamp(baseFov + startDelta, 20, 120);
    const endFov = THREE.MathUtils.clamp(baseFov + endDelta, 20, 120);

    const durationSec = getContinuousDurationSeconds('continuous-dolly-zoom', CONTINUOUS_ZOOM_DURATION);
    const glideDuration = options.glideDuration ?? 0;
    const onMotionStart = typeof options.onMotionStart === 'function'
      ? options.onMotionStart
      : null;

    const startMainAnimation = () => {
      onMotionStart?.();
      const proxy = { t: 0 };
      continuousDollyZoomTween = gsap.to(proxy, {
        t: 1,
        duration: durationSec,
        ease: "none",
        onUpdate: () => {
          const newFov = THREE.MathUtils.lerp(startFov, endFov, proxy.t);
          const newTan = Math.tan(THREE.MathUtils.degToRad(newFov / 2));
          const newDistance = baseDistance * (baseTan / newTan);

          camera.position.copy(controls.target).addScaledVector(baseDirection, newDistance);
          camera.fov = newFov;
          camera.updateProjectionMatrix();
          controls.update();
          getStoreState().setFov(Math.round(newFov));
          requestRender();
        },
        onComplete: () => {
          continuousDollyZoomTween = null;
          updateDollyZoomBaselineFromCamera();
          if (pendingHandoff) { processPendingHandoff(); return; }
          if (skipFade) resolve();
        },
      });
    };

    if (glideDuration > 0 && glideFrom) {
      const glideStartPos = glideFrom.position;
      const glideStartTarget = glideFrom.target;
      const targetPos = camera.position.clone();
      const targetTarget = controls.target.clone();
      const startFovGlide = glideFrom.fov ?? camera.fov;
      // Snap camera back to glideFrom immediately so there's no flash frame
      camera.position.copy(glideStartPos);
      controls.target.copy(glideStartTarget);
      camera.fov = startFovGlide;
      camera.updateProjectionMatrix();
      controls.update();
      const glideProxy = { t: 0 };
      continuousDollyZoomTween = gsap.to(glideProxy, {
        t: 1,
        duration: glideDuration,
        ease: "power2.inOut",
        onUpdate: () => {
          camera.position.lerpVectors(glideStartPos, targetPos, glideProxy.t);
          controls.target.lerpVectors(glideStartTarget, targetTarget, glideProxy.t);
          camera.fov = THREE.MathUtils.lerp(startFovGlide, baseFov, glideProxy.t);
          camera.updateProjectionMatrix();
          controls.update();
          requestRender();
        },
        onComplete: startMainAnimation,
      });
    } else {
      startMainAnimation();
    }
  });
};

/**
 * Continuous-orbit slide-in: horizontal arc around the target.
 * @returns {Promise}
 */
export const continuousOrbitSlideIn = (duration, amount, options = {}) => {
  return new Promise((resolve) => {
    cancelContinuousOrbitAnimation();

    const skipFade = options.skipFade ?? false;
    const glideFrom = options.glideFrom ?? null;

    if (!skipFade) {
      const { viewerEl, fadeDurationSec, canAnimate } = beginContinuousSlideIn(duration);
      if (!canAnimate) { resolve(); return; }
      scheduleSlideInCleanup(viewerEl, fadeDurationSec, resolve);
    } else {
      if (!camera || !controls) { resolve(); return; }
    }

    const currentPosition = camera.position.clone();
    const currentTarget = controls.target.clone();
    const distance = currentPosition.distanceTo(currentTarget);
    const up = camera.up.clone().normalize();
    const forward = new THREE.Vector3().subVectors(currentTarget, currentPosition).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();

    const durationSec = getContinuousDurationSeconds('continuous-orbit', CONTINUOUS_ORBIT_DURATION);
    const motionScale = getContinuousSizeScale();

    const orbitAngle = (Math.PI / 180) * CONTINUOUS_ORBIT_ANGLE_DEG * motionScale;
    const panAmount = distance * amount * CONTINUOUS_ORBIT_PAN_SCALE * motionScale;

    const startTarget = currentTarget.clone().add(right.clone().multiplyScalar(-panAmount));
    const endTarget = currentTarget.clone().add(right.clone().multiplyScalar(panAmount));

    const orbitOffset = new THREE.Vector3().subVectors(currentPosition, currentTarget);
    const startOrbitOffset = orbitOffset.clone().applyAxisAngle(up, -orbitAngle);
    const endOrbitOffset = orbitOffset.clone().applyAxisAngle(up, orbitAngle);
    const startPosition = startTarget.clone().add(startOrbitOffset);
    const endPosition = endTarget.clone().add(endOrbitOffset);

    continuousOrbitState = {};
    applyOrbitLimitOverride(continuousOrbitState);

    const glideDuration = options.glideDuration ?? 0;
    const onMotionStart = typeof options.onMotionStart === 'function'
      ? options.onMotionStart
      : null;

    const startMainAnimation = () => {
      onMotionStart?.();
      const proxy = { t: 0 };
      continuousOrbitTween = gsap.to(proxy, {
        t: 1,
        duration: durationSec,
        ease: "none",
        onUpdate: () => {
          camera.position.lerpVectors(startPosition, endPosition, proxy.t);
          controls.target.lerpVectors(startTarget, endTarget, proxy.t);
          controls.update();
          requestRender();
        },
        onComplete: () => {
          continuousOrbitTween = null;
          if (continuousOrbitState) {
            restoreOrbitLimitOverride(continuousOrbitState);
            continuousOrbitState = null;
          }
          if (pendingHandoff) { processPendingHandoff(); return; }
          if (skipFade) resolve();
        },
      });
    };

    if (glideDuration > 0) {
      const glideStartPos = glideFrom?.position ?? currentPosition;
      const glideStartTarget = glideFrom?.target ?? currentTarget;
      const glideStartFov = glideFrom?.fov ?? camera.fov;
      const glideEndFov = camera.fov;
      // Snap camera back to glideFrom immediately so there's no flash frame
      camera.position.copy(glideStartPos);
      controls.target.copy(glideStartTarget);
      camera.fov = glideStartFov;
      camera.updateProjectionMatrix();
      controls.update();
      const glideProxy = { t: 0 };
      continuousOrbitTween = gsap.to(glideProxy, {
        t: 1,
        duration: glideDuration,
        ease: "power2.inOut",
        onUpdate: () => {
          camera.position.lerpVectors(glideStartPos, startPosition, glideProxy.t);
          controls.target.lerpVectors(glideStartTarget, startTarget, glideProxy.t);
          if (glideStartFov !== glideEndFov) {
            camera.fov = THREE.MathUtils.lerp(glideStartFov, glideEndFov, glideProxy.t);
            camera.updateProjectionMatrix();
          }
          controls.update();
          requestRender();
        },
        onComplete: startMainAnimation,
      });
    } else {
      camera.position.copy(startPosition);
      controls.target.copy(startTarget);
      controls.update();
      requestRender();
      startMainAnimation();
    }
  });
};

/**
 * Continuous-vertical-orbit slide-in: vertical arc around the target.
 * @returns {Promise}
 */
export const continuousVerticalOrbitSlideIn = (duration, amount, options = {}) => {
  return new Promise((resolve) => {
    cancelContinuousVerticalOrbitAnimation();

    const skipFade = options.skipFade ?? false;
    const glideFrom = options.glideFrom ?? null;

    if (!skipFade) {
      const { viewerEl, fadeDurationSec, canAnimate } = beginContinuousSlideIn(duration);
      if (!canAnimate) { resolve(); return; }
      scheduleSlideInCleanup(viewerEl, fadeDurationSec, resolve);
    } else {
      if (!camera || !controls) { resolve(); return; }
    }

    const currentPosition = camera.position.clone();
    const currentTarget = controls.target.clone();
    const distance = currentPosition.distanceTo(currentTarget);
    const up = camera.up.clone().normalize();
    const forward = new THREE.Vector3().subVectors(currentTarget, currentPosition).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();

    const durationSec = getContinuousDurationSeconds('continuous-orbit-vertical', CONTINUOUS_VERTICAL_ORBIT_DURATION);
    const motionScale = getContinuousSizeScale();

    const orbitAngle = (Math.PI / 180) * CONTINUOUS_VERTICAL_ORBIT_ANGLE_DEG * motionScale;
    const panAmount = distance * amount * CONTINUOUS_VERTICAL_ORBIT_PAN_SCALE * motionScale;

    const startTarget = currentTarget.clone().add(up.clone().multiplyScalar(panAmount));
    const endTarget = currentTarget.clone().add(up.clone().multiplyScalar(-panAmount));

    const orbitOffset = new THREE.Vector3().subVectors(currentPosition, currentTarget);
    const startOrbitOffset = orbitOffset.clone().applyAxisAngle(right, -orbitAngle);
    const startPosition = startTarget.clone().add(startOrbitOffset);

    continuousVerticalOrbitState = {};
    applyOrbitLimitOverride(continuousVerticalOrbitState);

    const glideDuration = options.glideDuration ?? 0;
    const onMotionStart = typeof options.onMotionStart === 'function'
      ? options.onMotionStart
      : null;

    const startMainAnimation = () => {
      onMotionStart?.();
      const proxy = { t: 0 };
      continuousVerticalOrbitTween = gsap.to(proxy, {
        t: 1,
        duration: durationSec,
        ease: "none",
        onUpdate: () => {
          const currentTargetPos = startTarget.clone().lerp(endTarget, proxy.t);
          const currentAngle = gsap.utils.interpolate(-orbitAngle, orbitAngle, proxy.t);
          const currentOffset = orbitOffset.clone().applyAxisAngle(right, currentAngle);
          camera.position.copy(currentTargetPos).add(currentOffset);
          controls.target.copy(currentTargetPos);
          controls.update();
          requestRender();
        },
        onComplete: () => {
          continuousVerticalOrbitTween = null;
          if (continuousVerticalOrbitState) {
            restoreOrbitLimitOverride(continuousVerticalOrbitState);
            continuousVerticalOrbitState = null;
          }
          if (pendingHandoff) { processPendingHandoff(); return; }
          if (skipFade) resolve();
        },
      });
    };

    if (glideDuration > 0) {
      const glideStartPos = glideFrom?.position ?? currentPosition;
      const glideStartTarget = glideFrom?.target ?? currentTarget;
      const glideStartFov = glideFrom?.fov ?? camera.fov;
      const glideEndFov = camera.fov;
      // Snap camera back to glideFrom immediately so there's no flash frame
      camera.position.copy(glideStartPos);
      controls.target.copy(glideStartTarget);
      camera.fov = glideStartFov;
      camera.updateProjectionMatrix();
      controls.update();
      const glideProxy = { t: 0 };
      continuousVerticalOrbitTween = gsap.to(glideProxy, {
        t: 1,
        duration: glideDuration,
        ease: "power2.inOut",
        onUpdate: () => {
          camera.position.lerpVectors(glideStartPos, startPosition, glideProxy.t);
          controls.target.lerpVectors(glideStartTarget, startTarget, glideProxy.t);
          if (glideStartFov !== glideEndFov) {
            camera.fov = THREE.MathUtils.lerp(glideStartFov, glideEndFov, glideProxy.t);
            camera.updateProjectionMatrix();
          }
          controls.update();
          requestRender();
        },
        onComplete: startMainAnimation,
      });
    } else {
      camera.position.copy(startPosition);
      controls.target.copy(startTarget);
      controls.update();
      requestRender();
      startMainAnimation();
    }
  });
};

// ============================================================================
// Pause / resume helpers (used by slideshowController)
// ============================================================================

/** Returns the currently active continuous tween, or null. */
export const getActiveContinuousTween = () =>
  continuousDollyZoomTween ?? continuousZoomTween ?? continuousOrbitTween ?? continuousVerticalOrbitTween ?? null;

/** Pauses all active continuous tweens in place. */
export const pauseContinuousAnimations = () => {
  if (continuousDollyZoomTween) continuousDollyZoomTween.pause();
  if (continuousZoomTween) continuousZoomTween.pause();
  if (continuousOrbitTween) continuousOrbitTween.pause();
  if (continuousVerticalOrbitTween) continuousVerticalOrbitTween.pause();
};

/** Resumes all paused continuous tweens. */
export const resumeContinuousAnimations = () => {
  if (continuousDollyZoomTween) continuousDollyZoomTween.resume();
  if (continuousZoomTween) continuousZoomTween.resume();
  if (continuousOrbitTween) continuousOrbitTween.resume();
  if (continuousVerticalOrbitTween) continuousVerticalOrbitTween.resume();
};
