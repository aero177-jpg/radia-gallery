/**
 * Viewer module - Three.js scene, renderer, camera, controls, render loop
 */

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Scene
export const scene = new THREE.Scene();
scene.background = null;

// Renderer (initialized lazily)
export let renderer;
export let composer;
export let renderPass;
export let outputPass;
export let camera;
export let controls;
export let spark;
export let raycaster;
export let stereoCamera;

// Default settings (captured after initialization)
export let defaultCamera;
export let defaultControls;

// State
export let currentMesh = null;
export let activeCamera = null;
export let needsRender = true;
export let originalImageAspect = null;
export let stereoEnabled = false;
export let stereoScale = 1;
export let stereoOverlap = 1.0;
let renderSuspended = false;

// Dolly zoom state
export let dollyZoomEnabled = true;
export let dollyZoomBaseDistance = null;
export let dollyZoomBaseFov = null;

// Background capture state
export let bgImageUrl = null;
export let bgImageContainer = null;
let bgImageAspect = null;
let bgActivateRaf = null;
let pendingBg = null;
// FPS overlay element
export let fpsContainer = null;
let fpsLimitEnabled = true;
let viewerElementRef = null;
let visibilityChangeHandler = null;
let webglContextLostHandler = null;
let webglContextRestoredHandler = null;
let contextLossRecoveryTimer = null;
let glErrorStreak = 0;
let lastGlErrorCheckAt = 0;
let autoRecoveringFromGlError = false;
let glContextLost = false;

const GL_ERROR_CHECK_INTERVAL_MS = 500;
const GL_ERROR_STREAK_THRESHOLD = 3;
const CONTEXT_LOSS_RECOVERY_DELAY_MS = 1500;

export const setCurrentMesh = (mesh) => { currentMesh = mesh; };
export const setActiveCamera = (cam) => { activeCamera = cam; };
export const setOriginalImageAspect = (aspect) => { originalImageAspect = aspect; };
export const setDollyZoomEnabled = (enabled) => { dollyZoomEnabled = enabled; };
export const setBgImageUrl = (url) => { bgImageUrl = url; };

const clearContextLossRecoveryTimer = () => {
  if (contextLossRecoveryTimer) {
    clearTimeout(contextLossRecoveryTimer);
    contextLossRecoveryTimer = null;
  }
};

const reportRecoveryStatus = (message) => {
  import('./store.js').then(({ useStore }) => {
    useStore.getState().setStatus(message);
  }).catch(() => {});
};

const recoverViewerFromGlFault = async (reason = 'WebGL fault') => {
  if (autoRecoveringFromGlError) return;

  const viewerEl = viewerElementRef || renderer?.domElement?.parentElement;
  if (!viewerEl) return;

  autoRecoveringFromGlError = true;
  renderSuspended = true;
  clearContextLossRecoveryTimer();
  console.warn(`[viewer] Recovering from WebGL fault: ${reason}`);
  reportRecoveryStatus('WebGL issue detected. Recovering renderer...');

  try {
    resetViewer(viewerEl, { preserveBackground: true });

    const [{ resetSplatManager }, { reloadCurrentAsset, resize }] = await Promise.all([
      import('./splatManager.js'),
      import('./fileLoader.js'),
    ]);

    resetSplatManager();
    await reloadCurrentAsset();
    resize();
    requestRender();
    reportRecoveryStatus('Renderer recovered.');
  } catch (error) {
    console.error('[viewer] Failed to recover from WebGL fault', error);
    reportRecoveryStatus('Renderer recovery failed. Please reload the page.');
  } finally {
    glErrorStreak = 0;
    lastGlErrorCheckAt = 0;
    glContextLost = false;
    autoRecoveringFromGlError = false;
    renderSuspended = false;
  }
};

const checkForGlErrors = (now = performance.now()) => {
  if (!renderer || glContextLost || autoRecoveringFromGlError) return;
  if (now - lastGlErrorCheckAt < GL_ERROR_CHECK_INTERVAL_MS) return;

  lastGlErrorCheckAt = now;
  const gl = renderer.getContext?.();
  if (!gl?.getError) return;

  const errorCode = gl.getError();
  if (errorCode !== gl.NO_ERROR) {
    glErrorStreak += 1;
    if (glErrorStreak >= GL_ERROR_STREAK_THRESHOLD) {
      void recoverViewerFromGlFault(`gl.getError=${errorCode}`);
    }
  } else {
    glErrorStreak = 0;
  }
};

const ensureStereoCamera = () => {
  if (stereoCamera) return;
  stereoCamera = new THREE.StereoCamera();
  stereoCamera.aspect = 0.5; // Default for side-by-side (each eye gets half width)
};

export const setStereoEffectEnabled = (enabled) => {
  stereoEnabled = enabled;
  if (enabled) {
    ensureStereoCamera();
  }
  // Re-layout so the canvas uses the full viewport in stereo mode
  // (lazy import to avoid circular dependency with layout.js)
  import('./layout.js').then(({ resize }) => {
    resize();
  }).catch(() => {});
  requestRender();
};

export const setStereoEyeSeparation = (eyeSep) => {
  if (stereoCamera) {
    stereoCamera.eyeSep = eyeSep;
    requestRender();
  }
};

export const setStereoAspect = (aspect) => {
  if (stereoCamera) {
    stereoCamera.aspect = aspect;
    requestRender();
  }
};

export const setStereoScale = (scale) => {
  const numericScale = Number(scale);
  stereoScale = THREE.MathUtils.clamp(Number.isFinite(numericScale) ? numericScale : 1, 0.5, 1.0);
  requestRender();
};

export const setStereoOverlap = (fraction) => {
  const num = Number(fraction);
  stereoOverlap = Number.isFinite(num) ? THREE.MathUtils.clamp(num, 0.5, 1.5) : 1.0;
  // Trigger a full layout resize so the canvas width changes
  import('./layout.js').then(({ resize }) => {
    resize();
  }).catch(() => {});
  requestRender();
};

const applyStochasticRendering = (enabled) => {
  if (!spark?.defaultView) return;
  spark.defaultView.stochastic = Boolean(enabled);
  requestRender();
};

const applySparkMaxStdDev = (value) => {
  if (!spark) return;
  const next = Math.max(0.5, Math.min(8, Number(value)));
  if (!Number.isFinite(next)) return;
  spark.maxStdDev = next;
  requestRender();
};

/**
 * Gets the current focus distance (camera to orbit target distance).
 * @returns {number|null} Distance in scene units, or null if not available
 */
export const getFocusDistance = () => {
  if (!camera || !controls) return null;
  return camera.position.distanceTo(controls.target);
};

/**
 * Calculates optimal stereo eye separation based on focus distance.
 * Uses a ratio of approximately 1/20 of the focus distance, which provides
 * noticeable stereo depth while remaining comfortable.
 * @param {number} focusDistance - The distance to the focal point
 * @param {number} [ratio=0.05] - Separation ratio (default ~1/20)
 * @returns {number} Optimal eye separation in scene units
 */
export const calculateOptimalEyeSeparation = (focusDistance, ratio = 0.05) => {
  // Clamp to reasonable bounds (10mm to 600mm in scene units where 1 unit ≈ 1m)
  const minSep = 0.01;
  const maxSep = 0.6;
  const calculated = focusDistance * ratio;
  return Math.max(minSep, Math.min(maxSep, calculated));
};

/** 
 * Renders scene in side-by-side stereo using StereoCamera directly.
 * This gives us access to the aspect property for VR compatibility.
 */
const renderStereo = () => {
  if (!renderer || !camera || !stereoCamera) return;

  // Update scene matrices
  if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
  if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();

  // Update stereo camera from main camera
  stereoCamera.update(camera);

  const size = renderer.getSize(new THREE.Vector2());
  const scale = THREE.MathUtils.clamp(stereoScale || 1, 0.5, 1.0);
  const renderWidth = Math.max(2, Math.floor(size.width * scale));
  const renderHeight = Math.max(2, Math.floor(size.height * scale));
  const offsetX = Math.floor((size.width - renderWidth) * 0.5);
  const offsetY = Math.floor((size.height - renderHeight) * 0.5);
  const halfWidth = Math.max(1, Math.floor(renderWidth * 0.5));
  const rightWidth = Math.max(1, renderWidth - halfWidth);
  const currentAutoClear = renderer.autoClear;

  renderer.autoClear = false;
  renderer.clear();
  renderer.setScissorTest(true);

  // Render left eye
  renderer.setScissor(offsetX, offsetY, halfWidth, renderHeight);
  renderer.setViewport(offsetX, offsetY, halfWidth, renderHeight);
  renderer.render(scene, stereoCamera.cameraL);

  // Render right eye
  renderer.setScissor(offsetX + halfWidth, offsetY, rightWidth, renderHeight);
  renderer.setViewport(offsetX + halfWidth, offsetY, rightWidth, renderHeight);
  renderer.render(scene, stereoCamera.cameraR);

  renderer.setScissorTest(false);
  renderer.autoClear = currentAutoClear;
};

export const requestRender = () => {
  needsRender = true;
};

/**
 * Force an immediate render, bypassing frame rate limiting.
 * Useful for batch operations where timing is critical.
 */
export const forceRenderNow = () => {
  if (!renderer || !composer || !camera) return;
  try {
    if (stereoEnabled && stereoCamera) {
      // For stereo, call the stereo render path
      if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
      stereoCamera.update(camera);
      const size = renderer.getSize(new THREE.Vector2());
      const scale = THREE.MathUtils.clamp(stereoScale || 1, 0.5, 1.0);
      const renderWidth = Math.max(2, Math.floor(size.width * scale));
      const renderHeight = Math.max(2, Math.floor(size.height * scale));
      const offsetX = Math.floor((size.width - renderWidth) * 0.5);
      const offsetY = Math.floor((size.height - renderHeight) * 0.5);
      const halfWidth = Math.max(1, Math.floor(renderWidth * 0.5));
      const rightWidth = Math.max(1, renderWidth - halfWidth);
      renderer.autoClear = false;
      renderer.clear();
      renderer.setScissorTest(true);
      renderer.setScissor(offsetX, offsetY, halfWidth, renderHeight);
      renderer.setViewport(offsetX, offsetY, halfWidth, renderHeight);
      renderer.render(scene, stereoCamera.cameraL);
      renderer.setScissor(offsetX + halfWidth, offsetY, rightWidth, renderHeight);
      renderer.setViewport(offsetX + halfWidth, offsetY, rightWidth, renderHeight);
      renderer.render(scene, stereoCamera.cameraR);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
    } else {
      composer.render();
    }
    checkForGlErrors();
  } catch (error) {
    void recoverViewerFromGlFault(error?.message || 'forceRenderNow exception');
    return;
  }
  needsRender = false;
};

export const suspendRenderLoop = () => {
  renderSuspended = true;
};

export const resumeRenderLoop = () => {
  renderSuspended = false;
  needsRender = true;
};

export const updateDollyZoomBaselineFromCamera = () => {
  if (!dollyZoomEnabled) return;
  dollyZoomBaseDistance = camera.position.distanceTo(controls.target);
  dollyZoomBaseFov = camera.fov;
};

export const initViewer = (viewerEl) => {
  viewerElementRef = viewerEl;

  // Renderer
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0); // Transparent clear color
  viewerEl.appendChild(renderer.domElement);

  webglContextLostHandler = (event) => {
    event.preventDefault();
    glContextLost = true;
    renderSuspended = true;
    glErrorStreak = 0;
    clearContextLossRecoveryTimer();
    contextLossRecoveryTimer = setTimeout(() => {
      if (glContextLost) {
        void recoverViewerFromGlFault('webglcontextlost');
      }
    }, CONTEXT_LOSS_RECOVERY_DELAY_MS);
  };

  webglContextRestoredHandler = () => {
    glContextLost = false;
    clearContextLossRecoveryTimer();
    renderSuspended = false;
    requestRender();
  };

  renderer.domElement.addEventListener('webglcontextlost', webglContextLostHandler, false);
  renderer.domElement.addEventListener('webglcontextrestored', webglContextRestoredHandler, false);

  // Camera
  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 500);
  camera.position.set(0.5, 0.5, 2.5);
  defaultCamera = {
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };

  // Post-processing
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  outputPass = new OutputPass();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.6;
  controls.panSpeed = 0.6;
  controls.target.set(0, 0, 0);
  defaultControls = {
    dampingFactor: controls.dampingFactor,
    rotateSpeed: controls.rotateSpeed,
    zoomSpeed: controls.zoomSpeed,
    panSpeed: controls.panSpeed,
    minDistance: controls.minDistance,
    maxDistance: controls.maxDistance,
    minPolarAngle: controls.minPolarAngle,
    maxPolarAngle: controls.maxPolarAngle,
    minAzimuthAngle: controls.minAzimuthAngle,
    maxAzimuthAngle: controls.maxAzimuthAngle,
    enablePan: controls.enablePan,
  };

  // Spark renderer (lower maxStdDev for better performance)
  spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) });
  scene.add(spark);

  // Raycaster for double-click
  raycaster = new THREE.Raycaster();

  // Background image container
  bgImageContainer = document.createElement("div");
  bgImageContainer.className = "bg-image-container";
  viewerEl.insertBefore(bgImageContainer, viewerEl.firstChild);

  // Subscribe to bgBlur from store to keep CSS filter in sync
  import('./store.js').then(({ useStore }) => {
    const applyBlur = (value) => {
      if (!bgImageContainer) return;
      const clamped = Math.max(0, Math.min(40, Number(value) || 0));
      const opacity = Math.max(0, Math.min(1, (clamped - 8) / 2));
      bgImageContainer.style.setProperty('--bg-blur', `${clamped}px`);
      bgImageContainer.style.setProperty('--bg-opacity', `${opacity}`);
      // Also set explicit filter for browsers that ignore custom property here
      bgImageContainer.style.filter = `blur(${clamped}px)`;
    };

    applyBlur(useStore.getState().bgBlur);
    useStore.subscribe((s) => s.bgBlur, applyBlur);
  }).catch(() => {});

  // Subscribe to stochastic rendering debug toggle
  import('./store.js').then(({ useStore }) => {
    applyStochasticRendering(useStore.getState().debugStochasticRendering);
    useStore.subscribe((s) => s.debugStochasticRendering, applyStochasticRendering);
  }).catch(() => {});

  // Subscribe to Spark maxStdDev slider
  import('./store.js').then(({ useStore }) => {
    applySparkMaxStdDev(useStore.getState().debugSparkMaxStdDev);
    useStore.subscribe((s) => s.debugSparkMaxStdDev, applySparkMaxStdDev);
  }).catch(() => {});

  // Subscribe to FPS limit toggle
  import('./store.js').then(({ useStore }) => {
    fpsLimitEnabled = useStore.getState().debugFpsLimitEnabled;
    useStore.subscribe((s) => s.debugFpsLimitEnabled, (enabled) => {
      fpsLimitEnabled = Boolean(enabled);
      requestRender();
    });
  }).catch(() => {});

  // FPS overlay
  fpsContainer = document.createElement('div');
  fpsContainer.id = 'fps-counter';
  fpsContainer.textContent = '';
  fpsContainer.style.display = 'none';
  viewerEl.appendChild(fpsContainer);

  // Subscribe to store for showFps flag (lazy import to avoid circular deps)
  import('./store.js').then(({ useStore }) => {
    // Initialize visibility
    const initial = useStore.getState().showFps;
    fpsContainer.style.display = initial ? 'block' : 'none';
    // Subscribe to changes
    useStore.subscribe((s) => s.showFps, (show) => {
      if (fpsContainer) fpsContainer.style.display = show ? 'block' : 'none';
    });
  }).catch(() => {});

  // Initialize dolly zoom baseline
  updateDollyZoomBaselineFromCamera();

  // Apply default camera range (imported after initialization to avoid circular dependency)
  setTimeout(() => {
    import('./cameraUtils.js').then(({ applyCameraRangeDegrees }) => {
      import('./store.js').then(({ useStore }) => {
        const defaultRange = useStore.getState().cameraRange;
        applyCameraRangeDegrees(defaultRange);
      });
    });
  }, 0);

  // On-demand rendering
  controls.addEventListener("change", requestRender);
  if (visibilityChangeHandler) {
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
  }
  visibilityChangeHandler = () => {
    if (!document.hidden) requestRender();
  };
  document.addEventListener('visibilitychange', visibilityChangeHandler);

  return { renderer, camera, controls, composer, spark };
};

export const startRenderLoop = () => {
  // Simple FPS measurement
  let lastTime = performance.now();
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  const targetFrameMs = 1000 / 60; // cap at 60 FPS
  let lastRenderTime = performance.now();

  const animate = () => {
    requestAnimationFrame(animate);

    // Skip rendering if tab is hidden
    if (document.hidden) return;

    const now = performance.now();
    if (fpsLimitEnabled) {
      const elapsedSinceRender = now - lastRenderTime;
      if (elapsedSinceRender < targetFrameMs) {
        return;
      }
      // Align to the frame boundary to reduce drift on high-refresh monitors
      lastRenderTime = now - (elapsedSinceRender % targetFrameMs);
    } else {
      lastRenderTime = now;
    }

    if (renderSuspended || !renderer || !controls || !composer || !camera) {
      return;
    }

    // Always update controls for damping, but only render if needed
    const controlsNeedUpdate = controls.update();

    if (needsRender || controlsNeedUpdate) {
      try {
        if (stereoEnabled && stereoCamera) {
          renderStereo();
        } else {
          composer.render();
        }
      } catch (error) {
        void recoverViewerFromGlFault(error?.message || 'render exception');
        return;
      }
      checkForGlErrors(now);
      needsRender = false;
      frameCount++;
    }

    // Update FPS display once per 250ms if present
    if (fpsContainer && fpsContainer.style.display === 'block') {
      const now = performance.now();
      const dt = now - lastFpsUpdate;
      if (dt >= 250) {
        const fps = Math.round((frameCount * 1000) / dt);
        fpsContainer.textContent = `${fps} FPS`;
        frameCount = 0;
        lastFpsUpdate = now;
      }
    }
  };
  animate();
};

const removeCurrentMesh = () => {
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh = null;
  }
};

const cancelPendingBgActivation = () => {
  if (bgActivateRaf) {
    cancelAnimationFrame(bgActivateRaf);
    bgActivateRaf = null;
  }
  pendingBg = null;
};

export const updateBackgroundImage = (url) => {
  if (!bgImageContainer) return;
  cancelPendingBgActivation();

  if (url) {
    const viewerEl = bgImageContainer.parentElement;
    const isSlidingOut = viewerEl?.classList.contains("slide-out");
    const isSlidingIn = viewerEl?.classList.contains("slide-in");

    if (isSlidingOut) {
      // During slide-out, defer swap until slide-out completes (old bg stays visible)
      pendingBg = { url };
      bgActivateRaf = requestAnimationFrame(function waitUntilSlideOutEnds() {
        bgActivateRaf = null;
        if (viewerEl?.classList.contains("slide-out")) {
          bgActivateRaf = requestAnimationFrame(waitUntilSlideOutEnds);
          return;
        }
        // slide-out done, apply the new background (slide-in may now be active)
        if (pendingBg) {
          bgImageContainer.style.backgroundImage = `url(${pendingBg.url})`;
          bgImageUrl = pendingBg.url;
          pendingBg = null;
        }
        bgImageContainer.classList.add("active");
        requestRender();
      });
    } else if (isSlidingIn) {
      // During slide-in, apply immediately so it fades in with canvas
      bgImageContainer.style.backgroundImage = `url(${url})`;
      bgImageUrl = url;
      bgImageContainer.classList.add("active");
    } else {
      bgImageContainer.style.backgroundImage = `url(${url})`;
      bgImageUrl = url;
      bgImageContainer.classList.add("active");
    }
  } else {
    pendingBg = null;
    bgImageContainer.style.backgroundImage = "none";
    bgImageContainer.classList.remove("active");
  }

  requestRender();
};

const disposeMeshResources = (mesh) => {
  if (!mesh) return;
  if (typeof mesh.dispose === 'function') {
    try { mesh.dispose(); } catch {}
  }
  if (mesh.geometry?.dispose) {
    try { mesh.geometry.dispose(); } catch {}
  }
  const material = mesh.material;
  if (Array.isArray(material)) {
    material.forEach((mat) => {
      if (mat?.dispose) {
        try { mat.dispose(); } catch {}
      }
    });
  } else if (material?.dispose) {
    try { material.dispose(); } catch {}
  }
};

/**
 * Hard resets the Three.js viewer without touching app state.
 * Disposes renderer/resources, recreates canvas/controls, and optionally restores background.
 */
export const resetViewer = (viewerEl, { preserveBackground = true } = {}) => {
  if (!viewerEl) return;

  const preservedBackground = preserveBackground ? bgImageUrl : null;

  cancelPendingBgActivation();
  clearContextLossRecoveryTimer();
  glContextLost = false;
  glErrorStreak = 0;
  lastGlErrorCheckAt = 0;

  if (renderer?.domElement && webglContextLostHandler) {
    renderer.domElement.removeEventListener('webglcontextlost', webglContextLostHandler, false);
  }
  if (renderer?.domElement && webglContextRestoredHandler) {
    renderer.domElement.removeEventListener('webglcontextrestored', webglContextRestoredHandler, false);
  }
  webglContextLostHandler = null;
  webglContextRestoredHandler = null;

  if (controls) {
    controls.removeEventListener?.('change', requestRender);
    controls.dispose?.();
  }

  if (currentMesh) {
    scene.remove(currentMesh);
    disposeMeshResources(currentMesh);
    currentMesh = null;
  }

  if (spark) {
    scene.remove(spark);
    spark?.dispose?.();
    spark = null;
  }

  // Clear any remaining scene children (safety)
  scene.children.slice().forEach((child) => {
    scene.remove(child);
  });

  if (composer) {
    composer.passes?.forEach((pass) => pass?.dispose?.());
    composer.renderTarget1?.dispose?.();
    composer.renderTarget2?.dispose?.();
  }

  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement?.remove();
  }

  if (bgImageContainer) {
    bgImageContainer.remove();
  }

  if (fpsContainer) {
    fpsContainer.remove();
  }

  renderer = undefined;
  composer = undefined;
  renderPass = undefined;
  outputPass = undefined;
  camera = undefined;
  controls = undefined;
  raycaster = undefined;
  stereoCamera = undefined;
  defaultCamera = undefined;
  defaultControls = undefined;
  activeCamera = null;
  needsRender = true;
  renderSuspended = false;

  bgImageContainer = null;
  fpsContainer = null;

  initViewer(viewerEl);

  if (preservedBackground) {
    updateBackgroundImage(preservedBackground);
  }

  // Re-apply stereo settings from store if available
  import('./store.js').then(({ useStore }) => {
    const store = useStore.getState();
    setStereoEffectEnabled(Boolean(store.stereoEnabled));
    if (Number.isFinite(store.stereoEyeSep)) {
      setStereoEyeSeparation(store.stereoEyeSep);
    }
    if (Number.isFinite(store.stereoAspect)) {
      setStereoAspect(store.stereoAspect);
    }
    if (Number.isFinite(store.stereoScale)) {
      setStereoScale(store.stereoScale);
    }
    if (Number.isFinite(store.stereoOverlap)) {
      setStereoOverlap(store.stereoOverlap);
    }
  }).catch(() => {});

  requestRender();
};

// Export THREE and SplatMesh for use in other modules
export { THREE, SplatMesh };
