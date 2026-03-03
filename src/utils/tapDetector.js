/**
 * Tap detector utility.
 * Normalizes pointer/touch/mouse taps with movement + duration thresholds.
 */

const getPointFromEvent = (event) =>
  event?.touches?.[0]
  || event?.changedTouches?.[0]
  || event;

export const registerTapListener = (target, {
  onTap,
  shouldIgnore,
  maxDurationMs = 250,
  maxMovePx = 12,
  ignoreMouseAfterTouchMs = 500,
  dedupeTapMs = 250,
  suppressDoubleTap = false,
  doubleTapWindowMs = 280,
  duplicateTapEventGapMs = 40,
} = {}) => {
  if (!target || typeof onTap !== 'function') return () => {};

  let tapStart = null;
  let lastTouchTime = 0;
  let lastTapEmitTime = 0;
  let pendingTapTimeout = null;
  let pendingTapStartedAt = 0;
  let lastPointerActivityTime = 0;
  const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;

  const isIgnored = (event) => Boolean(shouldIgnore?.(event));

  const emitTap = (event) => {
    const now = performance.now();
    if (now - lastTapEmitTime < dedupeTapMs) return;
    lastTapEmitTime = now;
    onTap(event);
  };

  const queueTap = (event) => {
    if (!suppressDoubleTap) {
      emitTap(event);
      return;
    }

    const now = performance.now();

    if (pendingTapTimeout) {
      if (now - pendingTapStartedAt <= duplicateTapEventGapMs) {
        return;
      }
      clearTimeout(pendingTapTimeout);
      pendingTapTimeout = null;
      pendingTapStartedAt = 0;
      return;
    }

    pendingTapStartedAt = now;
    pendingTapTimeout = setTimeout(() => {
      emitTap(event);
      pendingTapTimeout = null;
      pendingTapStartedAt = 0;
    }, doubleTapWindowMs);
  };

  const recordStart = (event) => {
    if (event?.button != null && event.button !== 0) return;
    if (isIgnored(event)) return;

    if (event?.type === 'pointerdown') {
      lastPointerActivityTime = performance.now();
    }

    const point = getPointFromEvent(event);
    tapStart = {
      time: performance.now(),
      x: point?.clientX ?? 0,
      y: point?.clientY ?? 0,
    };
  };

  const handleEnd = (event) => {
    if (event?.type === 'pointerup') {
      lastPointerActivityTime = performance.now();
    }

    if (!tapStart) return;
    if (isIgnored(event)) {
      tapStart = null;
      return;
    }

    const point = getPointFromEvent(event);
    const dt = performance.now() - tapStart.time;
    const dx = (point?.clientX ?? 0) - tapStart.x;
    const dy = (point?.clientY ?? 0) - tapStart.y;
    const dist = Math.hypot(dx, dy);
    tapStart = null;

    if (dt > maxDurationMs || dist > maxMovePx) return;
    queueTap(event);
  };

  const handleCancel = () => {
    tapStart = null;
    lastPointerActivityTime = performance.now();
  };

  const handleTouchStart = (event) => {
    lastTouchTime = Date.now();
    recordStart(event);
  };

  const handleTouchEnd = (event) => {
    lastTouchTime = Date.now();
    handleEnd(event);
  };

  const handleMouseDown = (event) => {
    if (Date.now() - lastTouchTime < ignoreMouseAfterTouchMs) return;
    recordStart(event);
  };

  const handleMouseUp = (event) => {
    if (Date.now() - lastTouchTime < ignoreMouseAfterTouchMs) return;
    handleEnd(event);
  };

  const handleClickFallback = (event) => {
    if (event?.button != null && event.button !== 0) return;
    if (Date.now() - lastTouchTime < ignoreMouseAfterTouchMs) return;
    if (supportsPointer && performance.now() - lastPointerActivityTime < 350) return;
    if (isIgnored(event)) return;
    queueTap(event);
  };

  if (supportsPointer) {
    target.addEventListener('pointerdown', recordStart);
    target.addEventListener('pointerup', handleEnd);
    target.addEventListener('pointercancel', handleCancel);
    target.addEventListener('click', handleClickFallback);
  } else {
    target.addEventListener('mousedown', handleMouseDown);
    target.addEventListener('mouseup', handleMouseUp);
    target.addEventListener('touchstart', handleTouchStart, { passive: true });
    target.addEventListener('touchend', handleTouchEnd);
  }

  return () => {
    if (pendingTapTimeout) {
      clearTimeout(pendingTapTimeout);
      pendingTapTimeout = null;
      pendingTapStartedAt = 0;
    }
    if (supportsPointer) {
      target.removeEventListener('pointerdown', recordStart);
      target.removeEventListener('pointerup', handleEnd);
      target.removeEventListener('pointercancel', handleCancel);
      target.removeEventListener('click', handleClickFallback);
    } else {
      target.removeEventListener('mousedown', handleMouseDown);
      target.removeEventListener('mouseup', handleMouseUp);
      target.removeEventListener('touchstart', handleTouchStart);
      target.removeEventListener('touchend', handleTouchEnd);
    }
  };
};
