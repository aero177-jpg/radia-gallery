/**
 * Camera utilities - projection, metadata camera, home view, orbit limits
 */

import {
  camera,
  controls,
  defaultCamera,
  defaultControls,
  activeCamera,
  setActiveCamera,
  updateDollyZoomBaselineFromCamera,
  requestRender,
  dollyZoomEnabled,
  setDollyZoomEnabled,
  THREE,
} from "./viewer.js";
import { useStore } from "./store.js";
import { startSmoothResetAnimation, cancelResetAnimation } from "./cameraAnimations.js";
import { resize } from "./layout.js";

// Helper to access store
const getStoreState = () => useStore.getState();

// Helper to format vec3
const formatVec3 = (vec) => `${vec.x.toFixed(2)}, ${vec.y.toFixed(2)}, ${vec.z.toFixed(2)}`;

const focusDirection = new THREE.Vector3();

// Home view state
let homeView = null;

export const saveHomeView = () => {
  homeView = {
    cameraPosition: camera.position.clone(),
    cameraQuaternion: camera.quaternion.clone(),
    cameraFov: camera.fov,
    cameraNear: camera.near,
    cameraFar: camera.far,
    cameraZoom: camera.zoom,
    controlsTarget: controls.target.clone(),
    controlsDampingFactor: controls.dampingFactor,
    controlsRotateSpeed: controls.rotateSpeed,
    controlsZoomSpeed: controls.zoomSpeed,
    controlsPanSpeed: controls.panSpeed,
    activeCamera: activeCamera ? JSON.parse(JSON.stringify(activeCamera)) : null,
  };
};

export const restoreHomeView = () => {
  if (!homeView) return;

  const store = getStoreState();
  store.setAnchorState({ active: false, distance: null });
  const targetState = {
    position: homeView.cameraPosition.clone(),
    quaternion: homeView.cameraQuaternion.clone(),
    fov: homeView.cameraFov,
    near: homeView.cameraNear,
    far: homeView.cameraFar,
    zoom: homeView.cameraZoom,
    target: homeView.controlsTarget.clone(),
  };

  // Check if in fullscreen portrait mode or immersive fullscreen - skip animation to avoid zoom/stutter issues
  const fullscreenRoot = document.getElementById('app');
  const isFullscreen = document.fullscreenElement === fullscreenRoot;
  const isFullscreenPortrait = isFullscreen && window.innerHeight > window.innerWidth;
  const isImmersiveFullscreen = isFullscreen && immersiveModeModule?.isImmersiveModeActive?.();

  if (isFullscreenPortrait || isImmersiveFullscreen) {
    // Apply reset instantly without animation
    camera.position.copy(targetState.position);
    camera.quaternion.copy(targetState.quaternion);
    camera.fov = targetState.fov;
    camera.near = targetState.near;
    camera.far = targetState.far;
    camera.zoom = targetState.zoom;
    camera.updateProjectionMatrix();
    
    controls.target.copy(targetState.target);
    controls.dampingFactor = homeView.controlsDampingFactor;
    controls.rotateSpeed = homeView.controlsRotateSpeed;
    controls.zoomSpeed = homeView.controlsZoomSpeed;
    controls.panSpeed = homeView.controlsPanSpeed;
    controls.update();

    setActiveCamera(homeView.activeCamera ? { ...homeView.activeCamera } : null);
    store.setFov(Math.round(homeView.cameraFov));
    
    setDollyZoomEnabled(true);
    updateDollyZoomBaselineFromCamera();
    requestRender();
    
    if (resize) resize();
    return;
  }

  // Animate FOV update in store during transition
  const animateFov = () => {
    store.setFov(Math.round(camera.fov));
  };

  // Update store during animation
  const fovInterval = setInterval(animateFov, 16);

  startSmoothResetAnimation(targetState, {
    duration: 600,
    onComplete: () => {
      clearInterval(fovInterval);

      // Apply final control settings
      controls.dampingFactor = homeView.controlsDampingFactor;
      controls.rotateSpeed = homeView.controlsRotateSpeed;
      controls.zoomSpeed = homeView.controlsZoomSpeed;
      controls.panSpeed = homeView.controlsPanSpeed;

      setActiveCamera(homeView.activeCamera ? { ...homeView.activeCamera } : null);

      // Sync store with restored camera fov
      store.setFov(Math.round(homeView.cameraFov));

      // Reset dolly zoom to its default enabled state and baseline
      setDollyZoomEnabled(true);
      updateDollyZoomBaselineFromCamera();

      controls.update();
      requestRender();
      
      // Trigger resize
      if (resize) resize();
    },
  });
};

export const applyFocusDistanceOverride = (distance) => {
  if (distance === undefined || distance === null) return;
  if (!camera || !controls) return;
  camera.getWorldDirection(focusDirection);
  const target = camera.position.clone().addScaledVector(focusDirection, distance);
  controls.target.copy(target);
  controls.update();
  updateDollyZoomBaselineFromCamera();
  requestRender();
};

// Camera pose helpers -------------------------------------------------------
export const captureCameraPose = () => ({
  position: camera.position.clone(),
  quaternion: camera.quaternion.clone(),
  fov: camera.fov,
  near: camera.near,
  far: camera.far,
  zoom: camera.zoom,
  target: controls.target.clone(),
});

export const applyCameraPose = (pose) => {
  if (!pose) return;
  camera.position.copy(pose.position);
  camera.quaternion.copy(pose.quaternion);
  camera.fov = pose.fov;
  camera.near = pose.near;
  camera.far = pose.far;
  camera.zoom = pose.zoom;
  camera.updateProjectionMatrix();
  controls.target.copy(pose.target);
  controls.update();
  updateDollyZoomBaselineFromCamera();
};

const hasPoseDelta = (from, to) => {
  if (!from || !to) return false;
  if (from.position.distanceToSquared(to.position) > 1e-6) return true;
  if (Math.abs(from.fov - to.fov) > 1e-3) return true;
  if (Math.abs(from.near - to.near) > 1e-4) return true;
  if (Math.abs(from.far - to.far) > 1e-3) return true;
  if (Math.abs(from.zoom - to.zoom) > 1e-4) return true;
  if (from.target.distanceToSquared(to.target) > 1e-6) return true;
  const dot = from.quaternion.dot(to.quaternion);
  return 1 - Math.abs(dot) > 1e-4;
};

const getTransitionDurationMs = (options) => {
  if (options?.duration != null) return options.duration;
  const state = getStoreState();
  const { animationIntensity, customAnimation } = state;
  switch (animationIntensity) {
    case "subtle":
      return 550;
    case "dramatic":
      return 1200;
    case "custom": {
      const customMs = Math.max(300, (customAnimation?.duration ?? 1.5) * 1000);
      return Math.min(4000, customMs);
    }
    default:
      return 850;
  }
};

const runCameraPoseTransition = (targetPose, options = {}) => new Promise((resolve) => {
  if (!targetPose) {
    resolve();
    return;
  }

  const animate = options.animate ?? getStoreState().animationEnabled;
  const duration = getTransitionDurationMs(options);

  const finalize = () => {
    updateDollyZoomBaselineFromCamera();
    requestRender();
    if (typeof options.onComplete === "function") {
      options.onComplete();
    }
    resolve();
  };

  if (!animate || duration <= 0) {
    applyCameraPose(targetPose);
    finalize();
    return;
  }

  startSmoothResetAnimation(targetPose, {
    duration,
    onComplete: finalize,
  });
});

export const animateCameraMutation = async (mutateFn, options = {}) => {
  if (typeof mutateFn !== "function" || !camera || !controls) return;
  const startPose = captureCameraPose();
  mutateFn();
  const targetPose = captureCameraPose();
  if (!hasPoseDelta(startPose, targetPose)) {
    if (typeof options.onComplete === "function") {
      options.onComplete();
    }
    return;
  }
  applyCameraPose(startPose);
  await runCameraPoseTransition(targetPose, options);
};

// Lazy import to avoid circular dependency
let immersiveModeModule = null;
const getImmersiveModule = async () => {
  if (!immersiveModeModule) {
    immersiveModeModule = await import('./immersiveMode.js');
  }
  return immersiveModeModule;
};

/**
 * Resets the camera view with immersive mode support.
 * Pauses device orientation input during the reset animation when in immersive mode,
 * then resumes with a fresh baseline. This prevents judder/stutter.
 * 
 * This is the canonical reset function - use this instead of restoreHomeView directly
 * when immersive mode may be active.
 */
export const resetViewWithImmersive = async () => {
  if (!camera || !controls) return;
  
  const immersive = await getImmersiveModule();
  
  if (immersive.isImmersiveModeActive()) {
    // Use special recenter that pauses orientation input during animation
    immersive.recenterInImmersiveMode(restoreHomeView, 600);
  } else {
    restoreHomeView();
  }
};

export const fitViewToMesh = (mesh) => {
  if (!mesh.getBoundingBox) return;
  const box = mesh.getBoundingBox();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Use a tighter fit based on the visible plane (X/Y) to avoid zooming out too far
  const visibleRadius = Math.max(size.x, size.y) * 0.5;
  const radius = Math.max(visibleRadius, 0.5);
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360);

  // Align camera straight down the forward axis for consistency with ML-Sharp views
  camera.up.set(0, 1, 0);
  camera.position.copy(center).add(new THREE.Vector3(0, 0, dist));
  camera.near = Math.max(0.01, radius * 0.01);
  camera.far = Math.max(dist * 4, Math.max(size.z, radius) * 8);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
  updateDollyZoomBaselineFromCamera();
  requestRender();

  // Update bounds in store
  const store = getStoreState();
  store.setFileInfo({
    bounds: `${formatVec3(center)} | size ${formatVec3(size)}`,
  });
};

// CV to GL axis flip matrix
export const makeAxisFlipCvToGl = () =>
  new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);

// Compute depth focus from splat distribution
const quantileSorted = (sorted, q) => {
  if (!sorted.length) return null;
  const clampedQ = Math.max(0, Math.min(1, q));
  const pos = (sorted.length - 1) * clampedQ;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

/**
 * Find the densest depth cluster using histogram binning.
 * This helps identify where the "main subject" is located.
 */
const findDenseDepthCluster = (depths, numBins = 20) => {
  if (!depths.length) return null;
  
  const minDepth = depths[0];
  const maxDepth = depths[depths.length - 1];
  const range = maxDepth - minDepth;
  if (range < 0.01) return minDepth; // All at same depth
  
  const binSize = range / numBins;
  const bins = new Array(numBins).fill(0);
  
  // Count splats in each depth bin
  for (const d of depths) {
    const binIdx = Math.min(numBins - 1, Math.floor((d - minDepth) / binSize));
    bins[binIdx]++;
  }
  
  // Find the densest bin (mode)
  let maxCount = 0;
  let densestBin = 0;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > maxCount) {
      maxCount = bins[i];
      densestBin = i;
    }
  }
  
  // Return center of densest bin
  return minDepth + (densestBin + 0.5) * binSize;
};

/**
 * Compute depth focus with subject detection.
 * Uses multiple strategies to find optimal anchor point:
 * 1. Center-weighted sampling (subjects are usually centered)
 * 2. Depth clustering to find main subject mass
 * 3. Adaptive minimum based on actual depth distribution
 */
export const computeMlSharpDepthFocus = (
  mesh,
  { qFocus = 0.1, minDepthFocus = 0.1, maxSamples = 50_000 } = {},
) => {
  const numSplats = mesh?.packedSplats?.numSplats ?? 0;
  if (!numSplats) return 2.0; // Fallback for empty mesh

  const step = Math.max(1, Math.floor(numSplats / maxSamples));
  const allDepths = [];
  const centerWeightedDepths = [];
  
  for (let i = 0; i < numSplats; i += step) {
    const { center } = mesh.packedSplats.getSplat(i);
    const z = center.z;
    if (!Number.isFinite(z) || z <= 0) continue;
    
    allDepths.push(z);
    
    // Weight splats near image center more heavily
    // Splats at x,y near 0 are likely the subject
    const distFromCenter = Math.sqrt(center.x * center.x + center.y * center.y);
    // Normalize by depth to get angular distance from center
    const angularDist = distFromCenter / z;
    
    // Include in center-weighted if within ~30° of center (tan(30°) ≈ 0.577)
    if (angularDist < 0.6) {
      centerWeightedDepths.push(z);
    }
  }

  if (!allDepths.length) return 2.0;
  allDepths.sort((a, b) => a - b);
  
  // Strategy 1: Simple quantile of all depths
  const quantileDepth = quantileSorted(allDepths, qFocus);
  
  // Strategy 2: Dense cluster detection (finds main subject mass)
  const clusterDepth = findDenseDepthCluster(allDepths);
  
  // Strategy 3: Center-weighted depth (prioritizes centered splats)
  let centerDepth = null;
  if (centerWeightedDepths.length > allDepths.length * 0.05) {
    // Only use if we have enough center samples (>5% of total)
    centerWeightedDepths.sort((a, b) => a - b);
    centerDepth = quantileSorted(centerWeightedDepths, 0.15);
  }
  
  // Combine strategies: prefer center-weighted if available, 
  // otherwise use minimum of quantile and cluster
  let focusDepth;
  if (centerDepth !== null) {
    // Use center depth but don't go further than cluster
    focusDepth = Math.min(centerDepth, clusterDepth ?? Infinity);
  } else {
    // Fall back to quantile, bounded by cluster depth
    focusDepth = Math.min(quantileDepth, clusterDepth ?? Infinity);
  }
  
  // Adaptive minimum: use 1% of median depth, minimum 0.1
  const medianDepth = quantileSorted(allDepths, 0.5);
  const adaptiveMin = Math.max(minDepthFocus, medianDepth * 0.01);
  
  if (!Number.isFinite(focusDepth)) return Math.max(adaptiveMin, 2.0);
  return Math.max(adaptiveMin, focusDepth);
};


export const applyMetadataCamera = (mesh, cameraMetadata, resize) => {
  const store = getStoreState();
  const cvToThree = makeAxisFlipCvToGl();
  if (!mesh.userData.__cvToThreeApplied) {
    mesh.applyMatrix4(cvToThree);
    mesh.userData.__cvToThreeApplied = true;
  }
  mesh.updateMatrixWorld(true);

  const e = cameraMetadata.extrinsicCv;
  const extrinsicCv = new THREE.Matrix4().set(
    e[0], e[1], e[2], e[3],
    e[4], e[5], e[6], e[7],
    e[8], e[9], e[10], e[11],
    e[12], e[13], e[14], e[15],
  );

  const view = new THREE.Matrix4().multiplyMatrices(cvToThree, extrinsicCv).multiply(cvToThree);
  const cameraWorld = new THREE.Matrix4().copy(view).invert();

  camera.matrixAutoUpdate = true;
  camera.matrixWorld.copy(cameraWorld);
  camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
  camera.updateMatrix();
  camera.updateMatrixWorld(true);

  if (mesh?.getBoundingBox) {
    const box = mesh.getBoundingBox();
    const worldBox = box.clone().applyMatrix4(mesh.matrixWorld);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    worldBox.getSize(size);
    worldBox.getCenter(center);
    const radius = Math.max(size.length() * 0.5, 0.25);

    const camPos = camera.position.clone();
    const dist = camPos.distanceTo(center);

    const near = Math.max(0.01, dist - radius * 2.0);
    const far = Math.max(near + 1.0, dist + radius * 6.0);
    setActiveCamera({ ...cameraMetadata, near, far });

    store.setFileInfo({
      bounds: `${formatVec3(center)} | size ${formatVec3(size)}`,
    });
  } else {
    setActiveCamera({ ...cameraMetadata, near: 0.01, far: 1000 });
  }

  const depthFocusCv = computeMlSharpDepthFocus(mesh);
  const lookAtCv = new THREE.Vector3(0, 0, depthFocusCv);
  const lookAtThree = lookAtCv.applyMatrix4(mesh.matrixWorld);
  controls.target.copy(lookAtThree);
  store.addLog(`ml-sharp lookAt: depth_focus=${depthFocusCv.toFixed(3)} (center-weighted + clustering)`);

  controls.enabled = true;
  controls.update();
  updateDollyZoomBaselineFromCamera();
  requestRender();

  if (resize) resize();
};

export const clearMetadataCamera = (resize) => {
  setActiveCamera(null);
  camera.matrixAutoUpdate = true;
  controls.enabled = true;
  controls.dampingFactor = defaultControls.dampingFactor;
  controls.rotateSpeed = defaultControls.rotateSpeed;
  controls.zoomSpeed = defaultControls.zoomSpeed;
  controls.panSpeed = defaultControls.panSpeed;
  camera.fov = defaultCamera.fov;
  camera.near = defaultCamera.near;
  camera.far = defaultCamera.far;
  camera.updateProjectionMatrix();
  if (resize) resize();
};

// Orbit range control
export const applyCameraRangeDegrees = (degrees) => {
  if (!controls) return;
  
  // Convert degrees (0-180) to orbit limits
  // 0° = locked view, 180° = full hemisphere orbit
  const t = Math.max(0, Math.min(180, degrees)) / 180;
  
  // Azimuth: 0 to ±90° (π/2)
  const azimuthRange = t * (Math.PI / 2);
  controls.minAzimuthAngle = -azimuthRange;
  controls.maxAzimuthAngle = azimuthRange;
  
  // Polar: centered at π/2 (horizontal), expand outward
  // At 0°: very tight around horizontal (0.48π to 0.52π)
  // At 180°: full range (0.05π to 0.95π)
  const polarMin = 0.5 - (0.45 * t);
  const polarMax = 0.5 + (0.45 * t);
  controls.minPolarAngle = Math.PI * polarMin;
  controls.maxPolarAngle = Math.PI * polarMax;
};
