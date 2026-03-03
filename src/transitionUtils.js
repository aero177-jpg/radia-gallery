/**
 * Transition utilities for viewer slide/fade handling.
 */
import { cancelSlideAnimation } from "./cameraAnimations.js";

/** Cleanup function for any in-flight animation state */
export const cleanupSlideTransitionState = () => {
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) {
    viewerEl.classList.remove('slide-out', 'slide-in');
  }
  cancelSlideAnimation();
};

export const waitForViewerResizeTransition = () => new Promise((resolve) => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl) {
    resolve();
    return;
  }

  let timeoutId = null;
  const done = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    viewerEl.removeEventListener('transitionend', onEnd);
    resolve();
  };

  const onEnd = (event) => {
    if (event.propertyName === 'width' || event.propertyName === 'height') {
      done();
    }
  };

  timeoutId = setTimeout(done, 180); // Fallback in case transitionend doesn't fire
  viewerEl.addEventListener('transitionend', onEnd);
});
