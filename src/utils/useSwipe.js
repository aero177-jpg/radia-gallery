import { useEffect } from 'preact/hooks';

export default function useSwipe(ref, options = {}) {
  const {
    direction = 'horizontal',
    threshold = 50,
    allowCross = 80,
    minVelocity = 0,
    onSwipe,
    onSwipeStart,
    onSwipeEnd,
  } = options;

  useEffect(() => {
    const el = ref?.current;
    if (!el) return;

    let start = null;

    const startHandler = (e) => {
      const t = e.touches ? e.touches[0] : e;
      start = { x: t.clientX, y: t.clientY, time: Date.now() };
      if (onSwipeStart) onSwipeStart(e);
    };

    const endHandler = (e) => {
      if (!start) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const dt = Math.max(1, Date.now() - start.time);
      const vx = Math.abs(dx) / dt;
      const vy = Math.abs(dy) / dt;

      let passed = false;
      let dir = null;

      if (direction === 'horizontal') {
        if (Math.abs(dx) > threshold && Math.abs(dy) < allowCross) {
          passed = true;
          dir = dx > 0 ? 'right' : 'left';
        } else if (Math.max(vx, vy) > minVelocity && Math.abs(dy) < allowCross) {
          passed = true;
          dir = dx > 0 ? 'right' : 'left';
        }
      } else {
        if (Math.abs(dy) > threshold && Math.abs(dx) < allowCross) {
          passed = true;
          dir = dy > 0 ? 'down' : 'up';
        } else if (Math.max(vx, vy) > minVelocity && Math.abs(dx) < allowCross) {
          passed = true;
          dir = dy > 0 ? 'down' : 'up';
        }
      }

      if (passed && onSwipe) onSwipe({ dir, dx, dy, vx, vy, event: e });
      start = null;
      if (onSwipeEnd) onSwipeEnd(e);
    };

    el.addEventListener('touchstart', startHandler);
    el.addEventListener('touchend', endHandler);
    el.addEventListener('pointerdown', startHandler);
    el.addEventListener('pointerup', endHandler);

    return () => {
      el.removeEventListener('touchstart', startHandler);
      el.removeEventListener('touchend', endHandler);
      el.removeEventListener('pointerdown', startHandler);
      el.removeEventListener('pointerup', endHandler);
    };
  }, [ref, direction, threshold, allowCross, minVelocity, onSwipe, onSwipeStart, onSwipeEnd]);
}
