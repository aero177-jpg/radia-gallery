/**
 * Slideshow controls hook (toggle + hold-to-open options).
 */

import { useCallback, useEffect, useRef } from 'preact/hooks';
import { startSlideshow, resetSlideshow } from '../slideshowController';

export default function useSlideshowControls({
  slideshowMode,
  setSlideshowMode,
  onOpenOptions,
  optionsHoldMs = 500,
} = {}) {
  const holdTimeout = useRef(null);
  const holdTriggered = useRef(false);

  const handleSlideshowToggle = useCallback(() => {
    if (slideshowMode) {
      resetSlideshow();
      setSlideshowMode(false);
      return;
    }

    setSlideshowMode(true);
    startSlideshow();
  }, [slideshowMode, setSlideshowMode]);

  const handleSlideshowHoldStart = useCallback(() => {
    holdTriggered.current = false;
    if (holdTimeout.current) {
      clearTimeout(holdTimeout.current);
    }
    holdTimeout.current = setTimeout(() => {
      holdTriggered.current = true;
      if (onOpenOptions) onOpenOptions();
      holdTimeout.current = null;
    }, optionsHoldMs);
  }, [optionsHoldMs, onOpenOptions]);

  const handleSlideshowHoldEnd = useCallback(() => {
    if (holdTimeout.current) {
      clearTimeout(holdTimeout.current);
      holdTimeout.current = null;
    }
  }, []);

  const handleSlideshowButtonClick = useCallback(() => {
    if (holdTriggered.current) {
      holdTriggered.current = false;
      return;
    }
    handleSlideshowToggle();
  }, [handleSlideshowToggle]);

  useEffect(() => () => {
    if (holdTimeout.current) {
      clearTimeout(holdTimeout.current);
    }
  }, []);

  return {
    handleSlideshowButtonClick,
    handleSlideshowHoldStart,
    handleSlideshowHoldEnd,
  };
}
