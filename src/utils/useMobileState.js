/**
 * Detect mobile state and orientation changes.
 */

import { useEffect } from 'preact/hooks';

export default function useMobileState({ setMobileState, onRotate } = {}) {
  useEffect(() => {
    if (!setMobileState) return;

    const updateMobileState = () => {
      const mobile = Math.min(window.innerWidth, window.innerHeight) <= 768;
      const portraitQuery = window.matchMedia?.('(orientation: portrait)');
      const portrait = portraitQuery ? portraitQuery.matches : window.innerHeight > window.innerWidth;
      setMobileState(mobile, portrait);
    };

    updateMobileState();

    window.addEventListener('resize', updateMobileState);
    window.addEventListener('orientationchange', updateMobileState);

    const portraitQuery = window.matchMedia?.('(orientation: portrait)');
    portraitQuery?.addEventListener?.('change', updateMobileState);

    const handleOrientationChange = () => {
      if (onRotate) onRotate();
    };

    window.addEventListener('orientationchange', handleOrientationChange);
    portraitQuery?.addEventListener?.('change', handleOrientationChange);

    return () => {
      window.removeEventListener('resize', updateMobileState);
      window.removeEventListener('orientationchange', updateMobileState);
      portraitQuery?.removeEventListener?.('change', updateMobileState);
      window.removeEventListener('orientationchange', handleOrientationChange);
      portraitQuery?.removeEventListener?.('change', handleOrientationChange);
    };
  }, [setMobileState, onRotate]);
}
