/**
 * Preview management: hydration, encoding, capture registration.
 */
import { loadPreviewBlob } from "./fileStorage.js";
import { setCapturePreviewFn } from "./assetManager.js";
import { scene, renderer, composer, currentMesh, forceRenderNow, THREE, bgImageUrl } from "./viewer.js";

/** Target height for generated previews (width auto-calculated) */
const PREVIEW_TARGET_HEIGHT = 192;

/** Preferred WebP quality for compact previews */
const PREVIEW_WEBP_QUALITY = 0.65;

/** JPEG fallback quality when WebP is unavailable */
const PREVIEW_JPEG_QUALITY = 0.45;

const isObjectUrl = (value) => typeof value === 'string' && value.startsWith('blob:');

const scheduleRevokeObjectUrl = (url, asset) => {
  if (!url || !isObjectUrl(url)) return;
  setTimeout(() => {
    if (!asset || asset.preview === url) return;
    if (bgImageUrl === url) return;
    URL.revokeObjectURL(url);
  }, 1200);
};

export const replacePreviewUrl = (asset, url) => {
  if (!asset) return;
  const previous = asset.preview;
  if (previous && isObjectUrl(previous) && previous !== url) {
    scheduleRevokeObjectUrl(previous, asset);
  }
  asset.preview = url;
};

export const hydrateAssetPreviewFromStorage = async (asset) => {
  if (!asset || asset.preview) return null;
  const preferredKey = asset.previewStorageKey || asset.name;
  let storedPreview = await loadPreviewBlob(asset.name, preferredKey);
  if (!storedPreview && preferredKey !== asset.name) {
    storedPreview = await loadPreviewBlob(asset.name, asset.name);
  }
  if (storedPreview?.blob) {
    const objectUrl = URL.createObjectURL(storedPreview.blob);
    replacePreviewUrl(asset, objectUrl);
    asset.previewSource = 'indexeddb';
    asset.previewMeta = {
      width: storedPreview.width,
      height: storedPreview.height,
      format: storedPreview.format,
      updated: storedPreview.updated,
    };
    return storedPreview;
  }
  replacePreviewUrl(asset, null);
  return null;
};

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => {
  canvas.toBlob((blob) => resolve(blob || null), type, quality);
});

const encodePreviewCanvas = async (canvas) => {
  const webpBlob = await canvasToBlob(canvas, 'image/webp', PREVIEW_WEBP_QUALITY);
  if (webpBlob) return { blob: webpBlob, format: 'image/webp' };

  const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', PREVIEW_JPEG_QUALITY);
  if (jpegBlob) return { blob: jpegBlob, format: 'image/jpeg' };

  try {
    const dataUrl = canvas.toDataURL('image/jpeg', PREVIEW_JPEG_QUALITY);
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return { blob, format: blob.type || 'image/jpeg', fallback: true };
  } catch (err) {
    console.warn('Preview encoding fallback failed', err);
    return null;
  }
};

const capturePreviewBlob = async () => {
  if (!currentMesh) return null;

  const clearColor = new THREE.Color();
  renderer.getClearColor(clearColor);
  const clearAlpha = renderer.getClearAlpha();
  const originalBackground = scene.background;

  // Render with clear background for preview capture
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  
  // Force an immediate render to ensure we capture the current state
  // This bypasses frame rate limiting that could cause stale frames
  forceRenderNow();

  const sourceCanvas = renderer.domElement;
  const scale = PREVIEW_TARGET_HEIGHT / Math.max(1, sourceCanvas.height);
  const targetWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = PREVIEW_TARGET_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, targetWidth, PREVIEW_TARGET_HEIGHT);

  const encoded = await encodePreviewCanvas(canvas);

  // Restore original background/clear state after capture
  scene.background = originalBackground;
  renderer.setClearColor(clearColor, clearAlpha);

  if (!encoded) return null;

  return {
    ...encoded,
    width: targetWidth,
    height: PREVIEW_TARGET_HEIGHT,
  };
};

const createPreviewObjectUrl = (blob) => URL.createObjectURL(blob);

// Register capture function with asset manager (returns object URLs + blob)
setCapturePreviewFn(async () => {
  const payload = await capturePreviewBlob();
  if (!payload) return null;
  return {
    ...payload,
    url: createPreviewObjectUrl(payload.blob),
    source: 'renderer',
    updated: Date.now(),
  };
});

/**
 * Formats byte count into human-readable string.
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "1.5 MB")
 */
export const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
};
