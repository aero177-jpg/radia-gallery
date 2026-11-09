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

