/**
 * Hook to choose a portal target that works in fullscreen.
 * Uses #app when it is the active fullscreen element, otherwise document.body.
 */

import { useEffect, useState } from 'preact/hooks';

export default function usePortalTarget() {
  const [portalTarget, setPortalTarget] = useState(() => {
    if (typeof document === 'undefined') return null;
    return document.body;
  });

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const getPortalTarget = () => {
      const fullscreenRoot = document.getElementById('app');
      return document.fullscreenElement === fullscreenRoot ? fullscreenRoot : document.body;
    };

    setPortalTarget(getPortalTarget());

    const handleFullscreenChange = () => {
      setPortalTarget(getPortalTarget());
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return portalTarget;
}
