/**
 * Background manager centralizes preview/blur application and animation hand-off.
 * Keeps background updates in one place so loaders only request set/clear/capture.
 */
import { bgImageUrl, bgImageContainer, setBgImageUrl, updateBackgroundImage, requestRender, renderer, scene, THREE, originalImageAspect } from './viewer.js';
import { getAssetList } from './assetManager.js';

const isObjectUrl = (value) => typeof value === 'string' && value.startsWith('blob:');
let lastBgObjectUrl = null;

const isUrlInAssetPreviews = (url) => {
  if (!url) return false;
  try {
    return getAssetList().some((asset) => asset?.preview === url);
  } catch {
    return false;
  }
};

// Revoke the given blob URL after a short delay to avoid breaking in-flight loads
const scheduleRevoke = (url) => {
  if (!url || !isObjectUrl(url)) return;
  // Give the browser time to fetch/use the URL before revoking
  setTimeout(() => {
    // Only revoke if it is no longer the active one
    if (url !== lastBgObjectUrl && !isUrlInAssetPreviews(url)) {
      URL.revokeObjectURL(url);
    }
  }, 1200);
};

// Fade-through-dark transition state (declared early so applyBackground can clean up)
let bgFadeTimer = null;

const hasLockedBackgroundAspect = () => Number.isFinite(originalImageAspect) && originalImageAspect > 0;

/** Cancel any in-progress fade-through-dark transition and restore visibility. */
const cleanupBgFade = () => {
  if (bgFadeTimer) {
    clearTimeout(bgFadeTimer);
    bgFadeTimer = null;
  }
  // Restore normal transition and remove inline opacity override so CSS classes
  // (e.g. .active) can control opacity again.  Without this, the inline
  // style.opacity = '0' set during a fade-out would stick permanently.
  if (bgImageContainer) {
    bgImageContainer.style.transition = '';
    bgImageContainer.style.opacity = '';
  }
};

/** Apply (or clear) the viewer background image. */
export const applyBackground = (url) => {
  // Clean up any in-progress fade transition so it doesn't conflict
  cleanupBgFade();

  const prev = lastBgObjectUrl;
  const blockBackground = !hasLockedBackgroundAspect();
  if (!url || blockBackground) {
    lastBgObjectUrl = null;
    setBgImageUrl(null);
    updateBackgroundImage(null);
    if (scene && renderer) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    requestRender();
    // Revoke the previous URL after a delay (avoid killing pending loads)
    scheduleRevoke(prev);
    if (blockBackground && url && url !== prev) {
      scheduleRevoke(url);
    }
    return null;
  }

  if (isObjectUrl(url)) {
    lastBgObjectUrl = url;
  } else {
    lastBgObjectUrl = null;
  }

  setBgImageUrl(url);
  updateBackgroundImage(url);
  if (scene && renderer) {
    // Keep the Three.js canvas transparent so the CSS background shows through
    scene.background = null;
    renderer.setClearColor(new THREE.Color(0x000000), 0);
  }
  requestRender();

  // Revoke the previous URL after a delay (do not revoke the active one)
  if (prev && prev !== url) {
    scheduleRevoke(prev);
  }

  return url;
};

/** Convenience to clear background explicitly. */
export const clearBackground = () => applyBackground(null);

/** Apply a preview image as the background. */
export const applyPreviewBackground = (previewUrl) => applyBackground(previewUrl);

/** Returns true if a background image is currently applied. */
const hasBackgroundImage = () => Boolean(bgImageUrl);

/** Returns true if the current background matches the given preview URL. */
export const hasBackgroundForPreview = (previewUrl) => {
  if (!previewUrl) return false;
  return bgImageUrl === previewUrl;
};

// ============================================================================
// Fade-through-dark for proxy-view transitions
// ============================================================================

/** Default fade-out / fade-in durations (ms) */
const BG_FADE_OUT_MS = 500;
const BG_FADE_IN_MS = 300;

/**
 * Fade the background out to dark, swap the image, then fade back in at the
 * very end of the overall transition so the new preview appears as the camera
 * reaches its destination.
 *
 * Timeline:  [fadeOut] ── dark / camera moving ── [fadeIn]
 *                                                 ^ starts at durationMs - fadeInMs
 *
 * Falls back to an instant swap when the container isn't available.
 *
 * @param {string|null} newUrl      - Object-URL for the next preview (or null to clear)
 * @param {number}      durationMs  - Total transition window (usually the camera glide time)
 * @param {Object}      [opts]
 * @param {number}      [opts.fadeOutMs=500]  - Fade-out duration
 * @param {number}      [opts.fadeInMs=300]   - Fade-in duration
 */
export const crossFadePreviewBackground = (newUrl, durationMs = 1000, opts = {}) => {
  const fadeOutMs = opts.fadeOutMs ?? BG_FADE_OUT_MS;
  const fadeInMs  = opts.fadeInMs  ?? BG_FADE_IN_MS;

  if (!hasLockedBackgroundAspect()) {
    applyPreviewBackground(null);
    if (newUrl) {
      scheduleRevoke(newUrl);
    }
    return;
  }

  // No container — fall back to instant swap
  if (!bgImageContainer) {
    applyPreviewBackground(newUrl);
    return;
  }

  // Already showing this URL — nothing to do
  if (newUrl && bgImageUrl === newUrl) return;

  // Abort any previous fade sequence
  cleanupBgFade();

  // --- Phase 1: fade out current background ---
  bgImageContainer.style.transition = `opacity ${fadeOutMs}ms ease-out`;
  void bgImageContainer.offsetHeight; // force reflow
  bgImageContainer.style.opacity = '0';

  bgFadeTimer = setTimeout(() => {
    // --- Phase 2: swap image while fully dark ---
    // Use low-level swap to avoid cleanupBgFade resetting transition mid-sequence
    if (newUrl) {
      bgImageContainer.style.backgroundImage = `url(${newUrl})`;
      bgImageContainer.classList.add('active');

      const prev = lastBgObjectUrl;
      if (isObjectUrl(newUrl)) lastBgObjectUrl = newUrl;
      else lastBgObjectUrl = null;
      setBgImageUrl(newUrl);
      if (prev && prev !== newUrl) scheduleRevoke(prev);
    } else {
      bgImageContainer.style.backgroundImage = 'none';
      bgImageContainer.classList.remove('active');
      const prev = lastBgObjectUrl;
      lastBgObjectUrl = null;
      setBgImageUrl(null);
      scheduleRevoke(prev);
    }

    // --- Phase 3: fade in at the end of the overall transition ---
    // Wait until (durationMs - fadeOutMs - fadeInMs) before starting fade-in
    const remainingMs = Math.max(0, durationMs - fadeOutMs - fadeInMs);

    bgFadeTimer = setTimeout(() => {
      bgImageContainer.style.transition = `opacity ${fadeInMs}ms ease-in`;
      void bgImageContainer.offsetHeight;
      bgImageContainer.style.opacity = bgImageContainer.style.getPropertyValue('--bg-opacity') || '1';

      bgFadeTimer = setTimeout(() => {
        // Restore default transition so normal behaviour isn't affected
        bgImageContainer.style.transition = '';
        bgFadeTimer = null;
      }, fadeInMs + 50);
    }, remainingMs);
  }, fadeOutMs + 30);
};

/**
 * Fade the background out to dark only — no fade-in is scheduled.
 * Use this when leaving a proxy view for an unknown / non-proxy asset so the
 * normal load path can apply the new background in its own time.
 *
 * Safe to call even if no background is active (no-op).
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.fadeOutMs=500] - Fade-out duration
 */
export const fadeOutBackground = (opts = {}) => {
  const fadeOutMs = opts.fadeOutMs ?? BG_FADE_OUT_MS;

  if (!bgImageContainer) {
    clearBackground();
    return;
  }

  // Abort any previous fade sequence
  cleanupBgFade();

  bgImageContainer.style.transition = `opacity ${fadeOutMs}ms ease-out`;
  void bgImageContainer.offsetHeight;
  bgImageContainer.style.opacity = '0';

  // After the fade-out completes, clear the image data so the container is
  // truly empty, and remove the inline opacity so the next applyBackground
  // call can show the new image normally via CSS.
  bgFadeTimer = setTimeout(() => {
    bgImageContainer.style.backgroundImage = 'none';
    bgImageContainer.classList.remove('active');
    bgImageContainer.style.transition = '';
    bgImageContainer.style.opacity = '';

    const prev = lastBgObjectUrl;
    lastBgObjectUrl = null;
    setBgImageUrl(null);
    scheduleRevoke(prev);
    bgFadeTimer = null;
  }, fadeOutMs + 30);
};

/**
 * Capture a blurred background from the renderer and apply it.
 * Returns the data URL used for the background (JPEG).
 */
export const captureAndApplyBackground = ({ renderer, composer, scene, THREE, backgroundColor = '#0c1018', quality = 0.9 }) => {
  if (!renderer || !composer || !scene || !THREE) return null;

  const originalBg = scene.background;
  const clearColor = new THREE.Color();
  renderer.getClearColor(clearColor);
  const clearAlpha = renderer.getClearAlpha();

  scene.background = new THREE.Color(backgroundColor);
  renderer.setClearColor(backgroundColor, 1);
  composer.render();

  const canvas = renderer.domElement;

  const finish = (blob, url) => {
    scene.background = originalBg;
    renderer.setClearColor(clearColor, clearAlpha);
    const appliedUrl = applyBackground(url);
    return { url: appliedUrl, blob };
  };

  return new Promise((resolve) => {
    const tryJpeg = () => {
      canvas.toBlob((jpegBlob) => {
        if (jpegBlob) {
          const objectUrl = URL.createObjectURL(jpegBlob);
          resolve(finish(jpegBlob, objectUrl));
        } else {
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(finish(null, dataUrl));
        }
      }, 'image/jpeg', quality);
    };

    canvas.toBlob((webpBlob) => {
      if (webpBlob) {
        const objectUrl = URL.createObjectURL(webpBlob);
        resolve(finish(webpBlob, objectUrl));
      } else {
        tryJpeg();
      }
    }, 'image/webp', quality * 0.6);
  });
};
