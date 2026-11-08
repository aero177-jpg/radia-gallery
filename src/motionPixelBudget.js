import * as THREE from 'three';

// While the camera moves, render at most this many pixels and let the browser upscale.
// Wide images cover over twice the pixels of vertical ones, so they run far slower in motion.
const RESTORE_AFTER_MS = 200;
const MOVE_EPSILON = 1e-5;

let enabled = false;
let budgetPixels = 1_000_000;
let lastMotionAt = -Infinity;
let tracked = null;
const logicalSize = new THREE.Vector2();

export const setMotionPixelBudget = (isEnabled, megapixels) => {
  enabled = Boolean(isEnabled);
  budgetPixels = megapixels * 1_000_000;
};

const trackMotion = (camera, now) => {
  if (!tracked) {
    tracked = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov };
    return;
  }
  const moved = tracked.position.distanceToSquared(camera.position) > MOVE_EPSILON * MOVE_EPSILON
    || 1 - Math.abs(tracked.quaternion.dot(camera.quaternion)) > MOVE_EPSILON * MOVE_EPSILON
    || Math.abs(tracked.fov - camera.fov) > MOVE_EPSILON;
  if (!moved) return;
  lastMotionAt = now;
  tracked.position.copy(camera.position);
  tracked.quaternion.copy(camera.quaternion);
  tracked.fov = camera.fov;
};

const getTargetPixelRatio = (renderer, now, stereo) => {
  const full = window.devicePixelRatio;
  if (!enabled || stereo || now - lastMotionAt > RESTORE_AFTER_MS) return full;
  renderer.getSize(logicalSize);
  const fullPixels = logicalSize.x * logicalSize.y * full * full;
  return fullPixels > budgetPixels ? full * Math.sqrt(budgetPixels / fullPixels) : full;
};

/**
 * Returns the pixel ratio the next frame should use, or null if it is already right.
 * Apply it only immediately before drawing: resizing a canvas clears it.
 */
export const getPendingPixelRatio = (renderer, camera, now, stereo) => {
  trackMotion(camera, now);
  const target = getTargetPixelRatio(renderer, now, stereo);
  return Math.abs(target - renderer.getPixelRatio()) > 0.005 ? target : null;
};
