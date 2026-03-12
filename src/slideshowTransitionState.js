/**
 * Tracks slideshow-owned transitions that may need to land without animation
 * if playback is paused after the next asset/view has already committed.
 */

let nextTransitionId = 1;
const transitionState = new Map();

const getEntry = (transitionId) => {
  if (transitionId == null) return null;
  return transitionState.get(transitionId) ?? null;
};

export const startSlideshowTransition = (options = {}) => {
  const transitionId = `slideshow-transition-${nextTransitionId++}`;
  transitionState.set(transitionId, {
    pauseOnCommit: options.pauseOnCommit === true,
    committed: false,
    phase: null,
  });
  return transitionId;
};

export const setSlideshowTransitionPauseOnCommit = (transitionId, pauseOnCommit) => {
  const entry = getEntry(transitionId);
  if (!entry) return false;
  entry.pauseOnCommit = pauseOnCommit === true;
  return true;
};

export const commitSlideshowTransition = (transitionId, options = {}) => {
  const entry = getEntry(transitionId);
  if (!entry) return false;
  entry.committed = true;
  if (typeof options.phase === 'string' && options.phase) {
    entry.phase = options.phase;
  }
  return true;
};

export const shouldPauseSlideshowTransitionOnCommit = (transitionId) => {
  const entry = getEntry(transitionId);
  return Boolean(entry?.committed && entry?.pauseOnCommit);
};

export const getSlideshowTransitionInfo = (transitionId) => {
  const entry = getEntry(transitionId);
  if (!entry) return null;
  return {
    pauseOnCommit: entry.pauseOnCommit === true,
    committed: entry.committed === true,
    phase: entry.phase ?? null,
  };
};

export const cancelSlideshowTransition = (transitionId) => {
  if (transitionId == null) return false;
  return transitionState.delete(transitionId);
};

export const clearSlideshowTransitions = () => {
  transitionState.clear();
};