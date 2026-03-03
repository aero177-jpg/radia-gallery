/**
 * Manage temporary reveal state for bottom controls.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export default function useControlsReveal({ slideshowPlaying, defaultTimeoutMs = 2000 } = {}) {
  const [controlsRevealed, setControlsRevealed] = useState(false);
  const timeoutRef = useRef(null);

  const clearRevealTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetControlsReveal = useCallback(() => {
    clearRevealTimeout();
    setControlsRevealed(false);
  }, [clearRevealTimeout]);

  const revealBottomControls = useCallback((temporary = true, timeoutMs = defaultTimeoutMs) => {
    clearRevealTimeout();
    setControlsRevealed(true);

    if (temporary) {
      timeoutRef.current = setTimeout(() => {
        setControlsRevealed(false);
        timeoutRef.current = null;
      }, timeoutMs);
    }
  }, [clearRevealTimeout, defaultTimeoutMs]);

  useEffect(() => {
    if (!slideshowPlaying) {
      resetControlsReveal();
    }
  }, [slideshowPlaying, resetControlsReveal]);

  useEffect(() => () => clearRevealTimeout(), [clearRevealTimeout]);

  return {
    controlsRevealed,
    revealBottomControls,
    resetControlsReveal,
  };
}
