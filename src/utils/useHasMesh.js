/**
 * Track mesh presence with a brief delay on disappear to reduce flicker.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { currentMesh } from '../viewer';

export default function useHasMesh({ pollInterval = 100, hideDelay = 300 } = {}) {
  const [hasMesh, setHasMesh] = useState(false);
  const hasMeshRef = useRef(false);

  useEffect(() => {
    let timeout = null;

    const checkMesh = () => {
      const meshPresent = Boolean(currentMesh);

      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      if (meshPresent !== hasMeshRef.current) {
        if (meshPresent) {
          hasMeshRef.current = true;
          setHasMesh(true);
        } else {
          timeout = setTimeout(() => {
            hasMeshRef.current = false;
            setHasMesh(false);
          }, hideDelay);
        }
      }
    };

    checkMesh();
    const interval = setInterval(checkMesh, pollInterval);

    return () => {
      clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, [pollInterval, hideDelay]);

  return hasMesh;
}
