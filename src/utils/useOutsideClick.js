/**
 * Custom hook to detect clicks outside specified elements.
 * Distinguishes single clicks from drags/swipes by tracking pointer movement.
 * 
 * @param {Function} onOutsideClick - Callback to run when click detected outside
 * @param {Array<string>} excludeSelectors - CSS selectors of elements to exclude from outside click detection
 * @param {boolean} enabled - Whether the hook is active (default: true)
 */

import { useEffect, useRef } from 'preact/hooks';

const DRAG_THRESHOLD = 10; // pixels
const MAX_CLICK_DURATION = 500; // ms

export default function useOutsideClick(onOutsideClick, excludeSelectors = [], enabled = true) {
  const pointerDownRef = useRef(null);
  const lastTouchTime = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (e) => {
      // Track touch events to ignore synthetic mouse events on mobile
      if (e.type === 'touchstart') {
        lastTouchTime.current = Date.now();
      } else if (e.type === 'mousedown' && Date.now() - lastTouchTime.current < 500) {
        // Ignore synthetic mousedown after touch
        return;
      }

      pointerDownRef.current = {
        x: e.clientX || e.touches?.[0]?.clientX || 0,
        y: e.clientY || e.touches?.[0]?.clientY || 0,
        time: Date.now(),
      };
    };

    const handlePointerUp = (e) => {
      // Track touch events to ignore synthetic mouse events on mobile
      if (e.type === 'touchend') {
        lastTouchTime.current = Date.now();
      } else if (e.type === 'mouseup' && Date.now() - lastTouchTime.current < 500) {
        // Ignore synthetic mouseup after touch
        return;
      }

      if (!pointerDownRef.current) return;

      const upX = e.clientX || e.changedTouches?.[0]?.clientX || 0;
      const upY = e.clientY || e.changedTouches?.[0]?.clientY || 0;
      const duration = Date.now() - pointerDownRef.current.time;

      const deltaX = Math.abs(upX - pointerDownRef.current.x);
      const deltaY = Math.abs(upY - pointerDownRef.current.y);
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Check if this was a valid single click (not a drag)
      if (distance < DRAG_THRESHOLD && duration < MAX_CLICK_DURATION) {
        // Check if click was outside all excluded elements
        const target = e.target;
        const clickedOutside = excludeSelectors.every((selector) => {
          const element = document.querySelector(selector);
          return !element?.contains(target);
        });

        if (clickedOutside) {
          onOutsideClick();
        }
      }

      pointerDownRef.current = null;
    };

    // Listen for both mouse and touch events
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('touchend', handlePointerUp);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('mouseup', handlePointerUp);
      document.removeEventListener('touchend', handlePointerUp);
    };
  }, [enabled, onOutsideClick, excludeSelectors]);
}
