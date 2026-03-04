/**
 * Slideshow controller module.
 * Auto-advance with pause/resume support for continuous animations.
 *
 * Pause captures camera position and remaining timer so resume can
 * glide back and continue where it left off without skipping assets.
 */

import { useStore } from "./store.js";
import { loadNextAsset, buildContinuousHandoff, getBaseAssetId } from "./fileLoader.js";
import {
  hasMultipleAssets,
  getCurrentAssetIndex,
  getAssetByIndex,
  getAssetCount,
  setCurrentAssetIndex as setCurrentAssetIndexManager,
} from "./assetManager.js";
import { cancelLoadZoomAnimation } from "./customAnimations.js";
import {
  cancelContinuousZoomAnimation,
  cancelContinuousDollyZoomAnimation,
  cancelContinuousOrbitAnimation,
  cancelContinuousVerticalOrbitAnimation,
  pauseContinuousAnimations,
  resumeContinuousAnimations,
  getActiveContinuousTween,
} from "./cameraAnimations.js";
import {
  continuousZoomSlideIn,
  continuousDollyZoomSlideIn,
  continuousOrbitSlideIn,
  continuousVerticalOrbitSlideIn,
  queueContinuousHandoff,
  clearContinuousHandoff,
} from "./continuousAnimations.js";
import { resolveSlideInOptions, computeSlideshowTimingExtension } from "./slideConfig.js";
import { camera, controls, requestRender, THREE } from "./viewer.js";
import gsap from "gsap";

const getStoreState = () => useStore.getState();

// ============================================================================
// Internal state
// ============================================================================

let isPlaying = false;
let holdTimeoutId = null;
let holdDeadline = 0;

/** Saved state captured on pause so we can resume seamlessly. */
let pauseSnapshot = null;

/** GSAP tween used for the glide-to-position on resume / fresh start. */
let glideTween = null;

// ============================================================================
// Store subscription – react to setting changes during playback
// ============================================================================

/** Cached previous values so we only react on actual changes. */
let _prevContinuousMode = getStoreState().slideshowContinuousMode;
let _prevSlideMode = getStoreState().slideMode;

useStore.subscribe((state) => {
  const nextContinuous = state.slideshowContinuousMode;
  const nextSlideMode = state.slideMode;
  const changed = nextContinuous !== _prevContinuousMode || nextSlideMode !== _prevSlideMode;
  _prevContinuousMode = nextContinuous;
  _prevSlideMode = nextSlideMode;

  if (!changed || !isPlaying) return;

  // Mode changed while slideshow is playing – reschedule and restart animation
  handleModeChangeWhilePlaying();
});

const GLIDE_DURATION = 0.5; // seconds for camera glide on resume

// ============================================================================
// Public API
// ============================================================================

/**
 * Starts or resumes slideshow playback.
 * - Fresh start (no pauseSnapshot): glide to animation start then begin.
 * - Resume (has pauseSnapshot): glide back to saved camera, resume tween + timer.
 */
export const startSlideshow = () => {
  if (isPlaying) return;
  if (!hasMultipleAssets()) return;

  isPlaying = true;
  getStoreState().setSlideshowPlaying(true);

  if (pauseSnapshot) {
    resumeFromPause();
  } else {
    beginFreshPlayback();
  }
};

/**
 * Pauses slideshow playback.
 * Captures camera position, pauses continuous tween, and freezes the hold timer
 * so we can resume exactly where we left off.
 */
export const stopSlideshow = () => {
  if (!isPlaying) {
    // Already stopped  just make sure state is clean
    getStoreState().setSlideshowPlaying(false);
    return;
  }

  isPlaying = false;
  getStoreState().setSlideshowPlaying(false);

  // Kill any in-flight glide
  if (glideTween) {
    glideTween.kill();
    glideTween = null;
  }

  // Clear any queued same-base handoff
  clearContinuousHandoff();

  // Capture remaining hold time
  let remainingHoldMs = 0;
  if (holdTimeoutId != null) {
    if (holdDeadline) {
      remainingHoldMs = Math.max(0, holdDeadline - Date.now());
    }
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
    holdDeadline = 0;
  }

  // Capture camera position before we pause the tween
  const savedPosition = camera?.position?.clone() ?? null;
  const savedTarget = controls?.target?.clone() ?? null;

  // Pause (not kill) the continuous animation so we can resume it
  pauseContinuousAnimations();

  // Save snapshot for resume (include asset index so we can detect stale snapshots)
  pauseSnapshot = {
    position: savedPosition,
    target: savedTarget,
    remainingHoldMs,
    hadActiveTween: !!getActiveContinuousTween(),
    assetIndex: getStoreState().currentAssetIndex,
  };

};

/**
 * Toggles slideshow playback on/off.
 */
 const toggleSlideshow = () => {
  if (isPlaying) {
    stopSlideshow();
  } else {
    startSlideshow();
  }
};

/**
 * Returns whether slideshow is currently playing.
 */
 const isSlideshowPlaying = () => isPlaying;

/**
 * Returns whether the slideshow is paused with a saved snapshot
 * (i.e. it was playing, user interacted, and we captured state for resume).
 */
export const isSlideshowPaused = () => !isPlaying && pauseSnapshot != null;

/**
 * Restarts the hold timer (call after manual navigation during slideshow).
 */
export const resetSlideshowTimer = () => {
  if (isPlaying) {
    scheduleNextAdvance();
  }
};

/**
 * Restart continuous animations if the slideshow is actively playing in
 * continuous mode.  Call this after manual proxy-view navigation so the
 * motion resumes from the newly-glided camera pose.
 */
export const restartContinuousIfPlaying = () => {
  if (!isPlaying) return;
  startContinuousForCurrentMode();
};

/**
 * Hard-stops the slideshow and clears all saved state.
 * Call this when slideshow mode is turned off entirely (not just paused).
 */
export const resetSlideshow = () => {
  isPlaying = false;
  pauseSnapshot = null;

  cancelLoadZoomAnimation();
  cancelContinuousZoomAnimation();
  cancelContinuousDollyZoomAnimation();
  cancelContinuousOrbitAnimation();
  cancelContinuousVerticalOrbitAnimation();
  clearContinuousHandoff();

  if (glideTween) {
    glideTween.kill();
    glideTween = null;
  }

  if (holdTimeoutId != null) {
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
    holdDeadline = 0;
  }

  getStoreState().setSlideshowPlaying(false);
};

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Glides the camera from its current position to a target position/target
 * over GLIDE_DURATION seconds, then calls onComplete.
 */
const glideCamera = (toPosition, toTarget, onComplete) => {
  if (!camera || !controls) {
    onComplete?.();
    return;
  }

  const startPos = camera.position.clone();
  const startTgt = controls.target.clone();
  const proxy = { t: 0 };

  glideTween = gsap.to(proxy, {
    t: 1,
    duration: GLIDE_DURATION,
    ease: "power2.inOut",
    onUpdate: () => {
      camera.position.lerpVectors(startPos, toPosition, proxy.t);
      controls.target.lerpVectors(startTgt, toTarget, proxy.t);
      controls.update();
      requestRender();
    },
    onComplete: () => {
      glideTween = null;
      onComplete?.();
    },
  });
};

/**
 * Resumes playback from a pause snapshot.
 * Glides back to saved camera position, then re-evaluates the current
 * continuous mode (which may have been changed while paused).
 */
const resumeFromPause = () => {
  const snap = pauseSnapshot;
  pauseSnapshot = null;

  if (!snap?.position || !snap?.target) {
    // No valid snapshot — fall through to fresh playback
    beginFreshPlayback();
    return;
  }
  // If the user navigated to a different asset while paused, snapshot is stale
  const currentIndex = getStoreState().currentAssetIndex;
  if (snap.assetIndex !== undefined && snap.assetIndex !== currentIndex) {
    beginFreshPlayback();
    return;
  }

  // Check if the continuous mode setting matches what the snapshot had.
  // If the user changed modes while paused, discard the snapshot and start fresh.
  const currentMode = resolveContinuousSlideMode(getStoreState());
  const modeChanged = snap.hadActiveTween !== !!currentMode;

  if (modeChanged) {
    // Kill any paused continuous tweens from the old mode
    cancelContinuousZoomAnimation();
    cancelContinuousDollyZoomAnimation();
    cancelContinuousOrbitAnimation();
    cancelContinuousVerticalOrbitAnimation();
    // Fresh start with current mode
    beginFreshPlayback();
    return;
  }

  glideCamera(snap.position, snap.target, () => {
    if (!isPlaying) return;

    // Resume the continuous tween from where it was paused
    if (snap.hadActiveTween) {
      resumeContinuousAnimations();
    }

    // Resume the hold timer with remaining time
    if (snap.remainingHoldMs > 0) {
      scheduleNextAdvanceMs(snap.remainingHoldMs);
    } else {
      // Timer already expired while paused — advance now
      advanceAndSchedule();
    }
  });
};

/**
 * Begins playback from scratch on the current asset.
 * If in continuous mode, starts the continuous animation then schedules the timer.
 * Otherwise just schedules the hold timer.
 */
const beginFreshPlayback = () => {
  startContinuousForCurrentMode();
  scheduleNextAdvance();
};

/**
 * Reacts to slideshowContinuousMode or slideMode changes while playing.
 * Cancels / starts the correct continuous animation and reschedules the timer.
 */
const handleModeChangeWhilePlaying = () => {
  // Kill any in-flight glide
  if (glideTween) {
    glideTween.kill();
    glideTween = null;
  }

  // Kill any queued same-base handoff
  clearContinuousHandoff();

  // Cancel all current continuous animations
  cancelContinuousZoomAnimation();
  cancelContinuousDollyZoomAnimation();
  cancelContinuousOrbitAnimation();
  cancelContinuousVerticalOrbitAnimation();

  // Clear existing timer
  if (holdTimeoutId != null) {
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
    holdDeadline = 0;
  }

  // Start the right animation for the new mode and reschedule
  startContinuousForCurrentMode();
  scheduleNextAdvance();
};

/**
 * Resolves the continuous slide mode from current store state.
 * Returns null if continuous mode isn't applicable.
 */
const resolveContinuousSlideMode = (store) => {
  if (!store.slideshowContinuousMode) return null;
  const fileSlideType = store.fileCustomAnimation?.slideType;
  const baseSlideMode = fileSlideType && fileSlideType !== 'default'
    ? fileSlideType
    : (store.slideMode ?? 'horizontal');
  if (baseSlideMode === 'fade') return null;
  return baseSlideMode === 'horizontal' ? 'continuous-orbit'
    : baseSlideMode === 'vertical'   ? 'continuous-orbit-vertical'
    : baseSlideMode === 'zoom'
      ? (store.continuousDollyZoom ? 'continuous-dolly-zoom' : 'continuous-zoom')
      : null;
};

/**
 * Determines the current continuous mode (if any) and starts the
 * appropriate continuous animation on the current asset.
 */
const startContinuousForCurrentMode = () => {
  const store = getStoreState();
  const mode = resolveContinuousSlideMode(store);
  if (!mode) return;

  const { duration, amount } = resolveSlideInOptions(mode, { preset: 'transition' });
  const opts = { glideDuration: GLIDE_DURATION };
  if (mode === 'continuous-zoom')                continuousZoomSlideIn(duration, amount, opts);
  else if (mode === 'continuous-dolly-zoom')     continuousDollyZoomSlideIn(duration, amount, opts);
  else if (mode === 'continuous-orbit')          continuousOrbitSlideIn(duration, amount, opts);
  else if (mode === 'continuous-orbit-vertical') continuousVerticalOrbitSlideIn(duration, amount, opts);
};

/**
 * Schedules the next auto-advance after hold duration (reads from store).
 * For non-continuous mode, the hold time is reduced by the timing extension
 * that was stolen to stretch slide-in/slide-out animations in fileLoader.
 */
const scheduleNextAdvance = () => {
  if (!isPlaying) return;

  const store = getStoreState();
  const isContinuous = store.slideshowContinuousMode && store.slideMode !== 'fade';
  const continuousDuration = store.continuousMotionDuration ?? 10;
  const slideInOffsetSec = isContinuous ? 2.5 : 0;

  let holdMs;
  if (isContinuous) {
    holdMs = Math.max(0, continuousDuration - slideInOffsetSec) * 1000;
  } else {
    const rawHold = store.slideshowDuration ?? 3;
    const { adjustedHoldMs } = computeSlideshowTimingExtension(rawHold);
    holdMs = adjustedHoldMs;
  }

  scheduleNextAdvanceMs(holdMs);
};

/**
 * Schedules the next auto-advance after a specific number of milliseconds.
 * Stores the deadline on the timeout so pause can compute remaining time.
 */
const scheduleNextAdvanceMs = (ms) => {
  if (holdTimeoutId != null) {
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
  }

  holdDeadline = Date.now() + ms;
  holdTimeoutId = setTimeout(() => {
    if (!isPlaying) return;
    advanceAndSchedule();
  }, ms);
};

/**
 * Advances to the next asset then schedules another advance.
 * For same-base proxy views in continuous mode, queues a seamless handoff
 * instead of going through the full load path.
 */
const advanceAndSchedule = async () => {
  if (!isPlaying) return;

  // Clear snapshot — we're moving to a new asset
  pauseSnapshot = null;

  const store = getStoreState();
  const slideMode = resolveContinuousSlideMode(store);
  const activeTween = getActiveContinuousTween();

  // Peek ahead: is the next asset a same-base proxy view?
  if (slideMode && activeTween) {
    const currentIdx = getCurrentAssetIndex();
    const count = getAssetCount();
    const nextIdx = (currentIdx + 1) % count;
    const currentAssetObj = getAssetByIndex(currentIdx);
    const nextAssetObj = getAssetByIndex(nextIdx);

    const sameBase = currentAssetObj && nextAssetObj
      && getBaseAssetId(currentAssetObj) === getBaseAssetId(nextAssetObj)
      && currentAssetObj.id !== nextAssetObj.id;

    if (sameBase) {
      try {
        const handoff = await buildContinuousHandoff(nextAssetObj);

        if (handoff) {
          // Advance the asset index
          setCurrentAssetIndexManager(nextIdx);
          store.setCurrentAssetIndex(nextIdx);

          // Queue handoff — the current animation's onComplete will process it
          queueContinuousHandoff({
            ...handoff,
            onStarted: () => {
              // Schedule next advance AFTER the new animation begins
              if (isPlaying) scheduleNextAdvance();
            },
          });
          return; // Don't call loadNextAsset or schedule here
        }
      } catch (err) {
        console.warn('[Slideshow] Handoff build failed, falling back:', err);
      }
    }
  }

  // Normal path: full asset load with transitions
  // Skip the timer reset inside loadNextAsset — we manage our own scheduling
  // to prevent premature timers firing while a large file is still loading.
  try {
    await loadNextAsset({ skipTimerReset: true });

    if (isPlaying) {
      scheduleNextAdvance();
    }
  } catch (err) {
    console.warn('Slideshow advance failed:', err);
    if (isPlaying) {
      scheduleNextAdvance();
    }
  }
};
