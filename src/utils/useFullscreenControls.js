/**
 * Fullscreen control hook using browser fullscreen only (F11-style).
 * This does NOT apply any layout/style changes – those are handled
 * separately by the expand/compress toggle (expandedViewer in store).
 */

import { useCallback, useEffect, useState } from 'preact/hooks';

const getFullscreenElement = () => {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
};

const isBrowserWindowFullscreen = () => {
  if (typeof window === 'undefined' || typeof window.screen === 'undefined') {
    return false;
  }

  const tolerancePx = 2;
  return (
    window.innerWidth >= window.screen.width - tolerancePx &&
    window.innerHeight >= window.screen.height - tolerancePx
  );
};

export default function useFullscreenControls({ resize, requestRender } = {}) {
  const [isRegularFullscreen, setIsRegularFullscreen] = useState(false);

  useEffect(() => {
    const syncRegularFullscreen = () => {
      setIsRegularFullscreen(Boolean(getFullscreenElement()) || isBrowserWindowFullscreen());
    };

    syncRegularFullscreen();
    document.addEventListener('fullscreenchange', syncRegularFullscreen);
    document.addEventListener('webkitfullscreenchange', syncRegularFullscreen);
    window.addEventListener('resize', syncRegularFullscreen);
    window.addEventListener('orientationchange', syncRegularFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', syncRegularFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncRegularFullscreen);
      window.removeEventListener('resize', syncRegularFullscreen);
      window.removeEventListener('orientationchange', syncRegularFullscreen);
    };
  }, []);

  const handleToggleRegularFullscreen = useCallback(async () => {
    const docEl = document.documentElement;

    const requestFullscreen = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;

    try {
      if (getFullscreenElement()) {
        if (exitFullscreen) {
          await Promise.resolve(exitFullscreen.call(document));
        }
      } else if (requestFullscreen) {
        await Promise.resolve(requestFullscreen.call(docEl));
      }

      requestAnimationFrame(() => {
        if (resize) resize();
        if (requestRender) requestRender();
      });
    } catch (err) {
      console.warn('Regular fullscreen toggle failed:', err);
    }
  }, [resize, requestRender]);

  return {
    isRegularFullscreen,
    handleToggleRegularFullscreen,
  };
}
