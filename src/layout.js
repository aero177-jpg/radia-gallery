/**
 * Viewer layout utilities: sizing, aspect handling, projection application.
 */
import { useStore } from "./store.js";
import {
  renderer,
  composer,
  camera,
  controls,
  defaultCamera,
  defaultControls,
  activeCamera,
  requestRender,
  setOriginalImageAspect,
  originalImageAspect,
  stereoEnabled,
  stereoOverlap,
  THREE,
} from "./viewer.js";

/** Page padding in pixels */
const PAGE_PADDING = 36;

/** Mobile sheet closed height (handle visible) */
const MOBILE_SHEET_CLOSED_HEIGHT = 50;

/** Mobile sheet open height as percentage of viewport (matches CSS max-height in portrait mode) */
const MOBILE_SHEET_OPEN_HEIGHT_VH = 40;

/** Accesses Zustand store state */
const getStoreState = () => useStore.getState();

const clampDimension = (value) => Math.max(2, Math.floor(value));

const resolveAvailableBounds = ({ fillViewport, isMobile, isPortrait }) => {
  let availableWidth = Math.max(0, window.innerWidth - (fillViewport ? 0 : PAGE_PADDING));
  let availableHeight = Math.max(0, window.innerHeight - (fillViewport ? 0 : PAGE_PADDING));

  if (!fillViewport && isMobile && isPortrait) {
    const sheetHeight = MOBILE_SHEET_CLOSED_HEIGHT;
    availableHeight = Math.max(0, window.innerHeight - sheetHeight - (PAGE_PADDING / 2));
  }

  return { availableWidth, availableHeight };
};

const resolveAspectFittedSize = (availableWidth, availableHeight, aspect) => {
  if (!(aspect > 0)) {
    return {
      width: clampDimension(availableWidth),
      height: clampDimension(availableHeight),
    };
  }

  const availableAspect = availableWidth / availableHeight;
  if (aspect > availableAspect) {
    const width = clampDimension(availableWidth);
    return {
      width,
      height: clampDimension(width / aspect),
    };
  }

  const height = clampDimension(availableHeight);
  return {
    width: clampDimension(height * aspect),
    height,
  };
};

const getVisualViewerSize = () => {
  const { isMobile, isPortrait, expandedViewer } = getStoreState();
  const fullscreenRoot = document.getElementById('app');
  const isFullscreen = document.fullscreenElement === fullscreenRoot;
  const fillViewport = isFullscreen || expandedViewer;
  const { availableWidth, availableHeight } = resolveAvailableBounds({
    fillViewport,
    isMobile,
    isPortrait,
  });

  // In stereo mode, use full viewport so each eye gets a proper half-width viewport
  if (stereoEnabled) {
    const widthFrac = (Number.isFinite(stereoOverlap) && stereoOverlap > 0) ? stereoOverlap : 1;
    return {
      width: clampDimension(availableWidth * widthFrac),
      height: clampDimension(availableHeight),
    };
  }

  return resolveAspectFittedSize(availableWidth, availableHeight, originalImageAspect);
};

const getProjectionViewportSize = () => {
  const { isMobile, isPortrait, expandedViewer } = getStoreState();
  const fullscreenRoot = document.getElementById('app');
  const isFullscreen = document.fullscreenElement === fullscreenRoot;
  const { availableWidth, availableHeight } = resolveAvailableBounds({
    fillViewport: isFullscreen || expandedViewer || stereoEnabled,
    isMobile,
    isPortrait,
  });

  // In stereo mode, use full viewport – skip aspect fitting
  if (stereoEnabled) {
    const widthFrac = (Number.isFinite(stereoOverlap) && stereoOverlap > 0) ? stereoOverlap : 1;
    return {
      width: clampDimension(availableWidth * widthFrac),
      height: clampDimension(availableHeight),
    };
  }

  return resolveAspectFittedSize(availableWidth, availableHeight, originalImageAspect);
};

// Build projection matrix from intrinsics
const makeProjectionFromIntrinsics = ({ fx, fy, cx, cy, width, height, near, far }) => {
  const left = (-cx * near) / fx;
  const right = ((width - cx) * near) / fx;
  const top = (cy * near) / fy;
  const bottom = (-(height - cy) * near) / fy;

  return new THREE.Matrix4().set(
    (2 * near) / (right - left),
    0,
    (right + left) / (right - left),
    0,
    0,
    (2 * near) / (top - bottom),
    (top + bottom) / (top - bottom),
    0,
    0,
    0,
    -(far + near) / (far - near),
    (-2 * far * near) / (far - near),
    0,
    0,
    -1,
    0,
  );
};

export const applyCameraProjection = (cameraMetadata, viewportWidth, viewportHeight) => {
  const { intrinsics, near, far } = cameraMetadata;
  const sx = viewportWidth / intrinsics.imageWidth;
  const sy = viewportHeight / intrinsics.imageHeight;

  const imageIsPortrait = intrinsics.imageHeight > intrinsics.imageWidth;
  const screenIsPortrait = viewportHeight > viewportWidth;
  const { fillMode = true } = getStoreState();
  // Deprecated legacy fill-mode branch retained for possible future reuse.
  const s = fillMode
    ? imageIsPortrait === screenIsPortrait
      ? imageIsPortrait
        ? sy
        : sx
      : Math.min(sx, sy)
    : Math.min(sx, sy);

  const scaledWidth = intrinsics.imageWidth * s;
  const scaledHeight = intrinsics.imageHeight * s;
  const offsetX = (viewportWidth - scaledWidth) * 0.5;
  const offsetY = (viewportHeight - scaledHeight) * 0.5;

  const fx = intrinsics.fx * s;
  const fy = intrinsics.fy * s;
  const cx = intrinsics.cx * s + offsetX;
  const cy = intrinsics.cy * s + offsetY;

  camera.aspect = viewportWidth / viewportHeight;
  camera.fov = THREE.MathUtils.radToDeg(
    2 * Math.atan(viewportHeight / (2 * Math.max(1e-6, fy))),
  );
  camera.near = near;
  camera.far = far;

  const fovScale = THREE.MathUtils.clamp(camera.fov / defaultCamera.fov, 0.05, 2.0);
  controls.rotateSpeed = Math.max(0.02, defaultControls.rotateSpeed * fovScale * 0.45);
  controls.zoomSpeed = Math.max(0.05, defaultControls.zoomSpeed * fovScale * 0.8);
  controls.panSpeed = Math.max(0.05, defaultControls.panSpeed * fovScale * 0.8);

  const projection = makeProjectionFromIntrinsics({
    fx,
    fy,
    cx,
    cy,
    width: viewportWidth,
    height: viewportHeight,
    near,
    far,
  });
  camera.projectionMatrix.copy(projection);
  camera.projectionMatrixInverse.copy(projection).invert();
};

export const applyIntrinsicsAspect = (entry) => {
  const intrinsics = entry?.cameraMetadata?.intrinsics;
  if (!intrinsics || !intrinsics.imageWidth || !intrinsics.imageHeight) return;
  const aspect = intrinsics.imageWidth / intrinsics.imageHeight;
  setOriginalImageAspect(aspect);
  updateViewerAspectRatio();
  requestRender();
};

/**
 * Updates viewer dimensions based on window size and panel state.
 * If camera metadata provides an aspect ratio, constrains viewer to match it.
 * Otherwise fills available space.
 * In mobile portrait mode, accounts for mobile sheet height.
 */
export const updateViewerAspectRatio = () => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl) return;

  const visualSize = getVisualViewerSize();
  viewerEl.style.width = `${visualSize.width}px`;
  viewerEl.style.height = `${visualSize.height}px`;

  // In stereo mode with overlap < 100%, the viewer is narrower than the
  // viewport. The fullscreen CSS sets justify-content to an invalid flex
  // value that falls back to flex-start, so we need margin auto to center.
  if (stereoEnabled && Number.isFinite(stereoOverlap) && stereoOverlap < 1) {
    viewerEl.style.margin = '0 auto';
  } else {
    viewerEl.style.margin = '';
  }
};

/**
 * Resizes renderer and updates camera projection.
 * Called on window resize and panel toggle.
 */
export const resize = () => {
  const viewerEl = document.getElementById('viewer');
  if (!viewerEl) return;
  if (!renderer) return;
  
  updateViewerAspectRatio();
  const { clientWidth, clientHeight } = viewerEl;
  const projectionSize = getProjectionViewportSize();
  renderer.setSize(projectionSize.width, projectionSize.height, false);

  // In stereo mode explicitly set canvas CSS dimensions so the fullscreen
  // CSS rule (width: 100%) doesn't stretch the drawing buffer.
  const canvasEl = renderer.domElement;
  if (stereoEnabled && canvasEl) {
    canvasEl.style.width = `${projectionSize.width}px`;
    canvasEl.style.height = `${projectionSize.height}px`;
  } else if (canvasEl) {
    canvasEl.style.width = '';
    canvasEl.style.height = '';
  }

  // Keep the EffectComposer's internal render targets in sync with the
  // renderer so splats render at the correct resolution/aspect ratio.
  // Without this, composer.render() writes to stale-sized targets and the
  // result gets stretched onto the new canvas size.
  if (composer) {
    composer.setSize(projectionSize.width, projectionSize.height);
  }
  
  if (activeCamera && activeCamera?.cameraMetadata) {
    applyCameraProjection(activeCamera.cameraMetadata, projectionSize.width, projectionSize.height);
  } else if (activeCamera) {
    applyCameraProjection(activeCamera, projectionSize.width, projectionSize.height);
  } else {
    camera.aspect = projectionSize.width / projectionSize.height;
    camera.updateProjectionMatrix();
  }

  // Debug: log resize dimensions so we can verify correct values
  console.debug('[resize]',
    'viewer:', `${clientWidth}×${clientHeight}`,
    'projection:', `${projectionSize.width}×${projectionSize.height}`,
    'aspect:', (projectionSize.width / projectionSize.height).toFixed(3),
    'camera.aspect:', camera.aspect.toFixed(3),
    'activeCamera:', !!activeCamera);

  requestRender();
};
