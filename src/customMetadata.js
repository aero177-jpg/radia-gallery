/**
 * Custom metadata module for non-ML Sharp splats.
 * Handles coordinate system conversion and camera pose persistence.
 */

import {
  camera,
  controls,
  requestRender,
  updateDollyZoomBaselineFromCamera,
} from "./viewer.js";
import { makeAxisFlipCvToGl } from "./cameraUtils.js";
import {
  saveCustomMetadata,
  loadCustomMetadata,
  clearCustomMetadata,
} from "./fileStorage.js";
import { useStore } from "./store.js";

const CUSTOM_METADATA_VERSION = 3;
const MIN_MODEL_SCALE = 0.1;
const MAX_MODEL_SCALE = 10.0;
const DEFAULT_MODEL_SCALE = 1.0;
const DEFAULT_ASPECT_RATIO = null;
const DEFAULT_VIEW_ID = 'view-1';
const CUSTOM_METADATA_SCHEMA_VERSION = 3;

/**
 * Clamp scale to valid range
 */
const clampScale = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MODEL_SCALE;
  return Math.max(MIN_MODEL_SCALE, Math.min(MAX_MODEL_SCALE, num));
};

const normalizeAspectRatio = (value) => {
  if (value === null) return DEFAULT_ASPECT_RATIO;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_ASPECT_RATIO;
};

/**
 * Store original mesh matrix before any custom transforms
 */
const ensureBaseMatrix = (mesh) => {
  if (!mesh || mesh.userData?.__customBaseMatrix) return;
  mesh.updateMatrix();
  mesh.userData.__customBaseMatrix = mesh.matrix.clone();
};

/**
 * Apply CV→GL coordinate flip to mesh (same as ML Sharp files).
 * This is the key transform that makes custom splats behave like ML Sharp.
 *
 * @param {THREE.Object3D} mesh - The splat mesh
 * @param {boolean} shouldFlip - Whether to apply the flip
 */
const applyCoordinateSystemFlip = (mesh, shouldFlip) => {
  if (!mesh) return;

  ensureBaseMatrix(mesh);
  const baseMatrix = mesh.userData.__customBaseMatrix;
  if (!baseMatrix) return;

  // Reset to base
  mesh.matrix.copy(baseMatrix);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);

  if (shouldFlip) {
    // Apply the exact CV→GL transform used by ML Sharp
    const cvToGl = makeAxisFlipCvToGl();
    mesh.applyMatrix4(cvToGl);
    mesh.userData.__cvToThreeApplied = true;
  } else {
    mesh.userData.__cvToThreeApplied = false;
  }

  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  requestRender();
};

/**
 * Apply model scale transform
 *
 * @param {THREE.Object3D} mesh - The splat mesh
 * @param {number} scale - Scale factor (0.1 to 10.0)
 */
const applyModelScale = (mesh, scale) => {
  if (!mesh) return;

  const clampedScale = clampScale(scale);
  mesh.scale.setScalar(clampedScale);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  requestRender();
};

/**
 * Apply full custom transform: flip + scale
 */
export const applyCustomModelTransform = (mesh, overrides = {}) => {
  if (!mesh) return;

  ensureBaseMatrix(mesh);
  const baseMatrix = mesh.userData.__customBaseMatrix;
  if (!baseMatrix) return;

  // Reset to base
  mesh.matrix.copy(baseMatrix);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);

  // Apply CV→GL flip if requested
  if (overrides.applyCoordinateFlip) {
    const cvToGl = makeAxisFlipCvToGl();
    mesh.applyMatrix4(cvToGl);
    mesh.userData.__cvToThreeApplied = true;
  } else {
    mesh.userData.__cvToThreeApplied = false;
  }

  // Apply scale
  const scale = clampScale(overrides.modelScale ?? DEFAULT_MODEL_SCALE);
  mesh.scale.setScalar(scale);

  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  requestRender();
};

/**
 * Capture current camera pose for saving
 * 
 * OrbitControls doesn't use quaternion - it keeps camera looking at target.
 * So we save position, target, and the distance/up vector to reconstruct.
 */
export const captureCameraPose = () => {
  if (!camera || !controls) return null;

  // Calculate distance from camera to target (for zoom)
  const distance = camera.position.distanceTo(controls.target);

  return {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
    distance: distance,
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    zoom: camera.zoom,
  };
};

/**
 * Apply saved camera pose
 * 
 * Sets position and target, then lets OrbitControls handle the orientation.
 */
export const applyCameraPose = (pose) => {
  if (!pose || !camera || !controls) return;

  // Restore camera up vector first
  if (pose.up) {
    camera.up.fromArray(pose.up);
  }

  // Set target first
  controls.target.fromArray(pose.target);

  // Set camera position
  camera.position.fromArray(pose.position);

  // Restore camera parameters
  camera.fov = pose.fov;
  camera.near = pose.near;
  camera.far = pose.far;
  camera.zoom = pose.zoom;
  camera.updateProjectionMatrix();

  // Let OrbitControls sync its internal spherical state
  controls.update();

  // Now make the camera look at the target (this is what OrbitControls does)
  camera.lookAt(controls.target);
  
  // Update again to ensure everything is in sync
  controls.update();
  
  updateDollyZoomBaselineFromCamera();
  requestRender();

  // Sync store FOV
  useStore.getState().setFov(Math.round(pose.fov));
};

/**
 * Capture complete custom metadata payload for persistence
 * Note: applyCoordinateFlip defaults to true since non-ML Sharp splats
 * always need the CV→GL transform applied.
 */
export const captureCustomMetadataPayload = (overrides = {}) => {
  const pose = captureCameraPose();
  if (!pose) return null;

  return {
    version: CUSTOM_METADATA_VERSION,
    cameraPose: pose,
    view: {
      aspectRatio: normalizeAspectRatio(overrides.aspectRatio),
    },
    model: {
      applyCoordinateFlip: true, // Always apply for non-ML Sharp splats
      modelScale: clampScale(overrides.modelScale ?? DEFAULT_MODEL_SCALE),
    },
    savedAt: Date.now(),
  };
};

const makeViewId = () => `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeViewRecord = (view, fallbackId) => {
  if (!view || !view.cameraPose) return null;
  return {
    id: view.id || fallbackId || makeViewId(),
    name: typeof view.name === 'string' && view.name.trim()
      ? view.name.trim()
      : null,
    cameraPose: view.cameraPose,
    view: {
      aspectRatio: normalizeAspectRatio(view?.view?.aspectRatio ?? null),
    },
    model: {
      applyCoordinateFlip: view?.model?.applyCoordinateFlip !== false,
      modelScale: clampScale(view?.model?.modelScale ?? DEFAULT_MODEL_SCALE),
    },
    savedAt: Number.isFinite(view.savedAt) ? view.savedAt : Date.now(),
  };
};

const normalizeLegacyMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return null;

  // New schema: { views: [...] }
  if (Array.isArray(metadata.views)) {
    const normalizedViews = metadata.views
      .map((view, idx) => normalizeViewRecord(view, `view-${idx + 1}`))
      .filter(Boolean);

    if (normalizedViews.length === 0) return null;

    const activeViewId = metadata.activeViewId
      && normalizedViews.some((view) => view.id === metadata.activeViewId)
      ? metadata.activeViewId
      : normalizedViews[0].id;

    return {
      version: CUSTOM_METADATA_SCHEMA_VERSION,
      activeViewId,
      views: normalizedViews,
      savedAt: Number.isFinite(metadata.savedAt) ? metadata.savedAt : Date.now(),
    };
  }

  // Legacy schema: single payload at top-level
  if (metadata.cameraPose) {
    const legacyView = normalizeViewRecord({
      id: DEFAULT_VIEW_ID,
      name: metadata.name || null,
      cameraPose: metadata.cameraPose,
      view: metadata.view,
      model: metadata.model,
      savedAt: metadata.savedAt,
    }, DEFAULT_VIEW_ID);

    if (!legacyView) return null;

    return {
      version: CUSTOM_METADATA_SCHEMA_VERSION,
      activeViewId: legacyView.id,
      views: [legacyView],
      savedAt: legacyView.savedAt,
    };
  }

  return null;
};

const writeNormalizedMetadata = async (assetName, metadata) => {
  if (!assetName) return false;
  if (!metadata) return clearCustomMetadata(assetName);
  return saveCustomMetadata(assetName, metadata);
};

const updateMetadataViews = (record, updater) => {
  const current = normalizeLegacyMetadata(record);
  const normalized = current || {
    version: CUSTOM_METADATA_SCHEMA_VERSION,
    activeViewId: DEFAULT_VIEW_ID,
    views: [],
    savedAt: Date.now(),
  };

  const next = updater({
    ...normalized,
    views: [...normalized.views],
  });

  if (!next || !Array.isArray(next.views) || next.views.length === 0) {
    return null;
  }

  const activeViewId = next.activeViewId
    && next.views.some((view) => view.id === next.activeViewId)
    ? next.activeViewId
    : next.views[0].id;

  return {
    version: CUSTOM_METADATA_SCHEMA_VERSION,
    activeViewId,
    views: next.views,
    savedAt: Date.now(),
  };
};

/**
 * Enable 360° orbit (no angle limits)
 */
export const applyFullOrbitConstraints = () => {
  if (!controls) return;

  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = 0.01; // Avoid gimbal lock at poles
  controls.maxPolarAngle = Math.PI - 0.01;
  controls.update();
};

/**
 * Restore normal orbit constraints
 */
export const restoreOrbitConstraints = (rangeDegrees = 26) => {
  if (!controls) return;

  // Import dynamically to avoid circular deps
  import("./cameraUtils.js").then(({ applyCameraRangeDegrees }) => {
    applyCameraRangeDegrees(rangeDegrees);
    controls.update();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load custom metadata for an asset by name
 */
export const loadCustomMetadataForAsset = async (assetName) => {
  if (!assetName) return null;
  const raw = await loadCustomMetadata(assetName);
  return normalizeLegacyMetadata(raw);
};

const listCustomViewsForAsset = async (assetName) => {
  const metadata = await loadCustomMetadataForAsset(assetName);
  return metadata?.views ?? [];
};

const getCustomViewForAsset = async (assetName, viewId = null) => {
  const metadata = await loadCustomMetadataForAsset(assetName);
  if (!metadata?.views?.length) return null;

  if (viewId) {
    const match = metadata.views.find((view) => view.id === viewId);
    if (match) return match;
  }

  const active = metadata.views.find((view) => view.id === metadata.activeViewId);
  return active || metadata.views[0] || null;
};

/**
 * Save custom metadata for an asset by name
 */
const saveCustomMetadataForAsset = async (assetName, payload) => {
  if (!assetName || !payload) return false;
  return saveCustomMetadataViewForAsset(assetName, payload, { viewId: null });
};

export const saveCustomMetadataViewForAsset = async (assetName, payload, options = {}) => {
  if (!assetName || !payload) return { saved: false, viewId: null, metadata: null };

  const record = await loadCustomMetadata(assetName);
  const requestedViewId = options?.viewId || null;

  const nextMetadata = updateMetadataViews(record, (normalized) => {
    const views = normalized.views;
    const existingIndex = requestedViewId
      ? views.findIndex((view) => view.id === requestedViewId)
      : (views.findIndex((view) => view.id === normalized.activeViewId));

    const targetId = existingIndex >= 0
      ? views[existingIndex].id
      : (requestedViewId || views[0]?.id || DEFAULT_VIEW_ID);

    const nextView = normalizeViewRecord({
      ...payload,
      id: targetId,
      name: options?.viewName ?? payload?.name ?? views[existingIndex]?.name ?? null,
      savedAt: Date.now(),
    }, targetId);

    if (!nextView) {
      return normalized;
    }

    if (existingIndex >= 0) {
      views.splice(existingIndex, 1, nextView);
    } else if (views.length > 0) {
      views.splice(0, 1, nextView);
    } else {
      views.push(nextView);
    }

    return {
      ...normalized,
      views,
      activeViewId: nextView.id,
    };
  });

  const saved = await writeNormalizedMetadata(assetName, nextMetadata);
  return {
    saved,
    viewId: nextMetadata?.activeViewId || null,
    metadata: nextMetadata,
  };
};

export const addCustomMetadataViewForAsset = async (assetName, payload, options = {}) => {
  if (!assetName || !payload) return { saved: false, viewId: null, metadata: null };

  const record = await loadCustomMetadata(assetName);
  const nextViewId = makeViewId();

  const nextMetadata = updateMetadataViews(record, (normalized) => {
    const views = normalized.views;
    const insertAfterViewId = options?.insertAfterViewId || normalized.activeViewId;
    const insertAfterIndex = views.findIndex((view) => view.id === insertAfterViewId);
    const insertIndex = insertAfterIndex >= 0 ? insertAfterIndex + 1 : views.length;
    const nextViewNumber = insertIndex + 1;

    const nextView = normalizeViewRecord({
      ...payload,
      id: nextViewId,
      name: options?.viewName || `View ${nextViewNumber}`,
      savedAt: Date.now(),
    }, nextViewId);

    if (!nextView) {
      return normalized;
    }

    views.splice(insertIndex, 0, nextView);

    return {
      ...normalized,
      views,
      activeViewId: nextView.id,
    };
  });

  const saved = await writeNormalizedMetadata(assetName, nextMetadata);
  return {
    saved,
    viewId: nextMetadata?.activeViewId || null,
    metadata: nextMetadata,
  };
};

/**
 * Clear custom metadata for an asset
 */
export const clearCustomMetadataForAsset = async (assetName) => {
  if (!assetName) return false;
  return clearCustomMetadata(assetName);
};

export const clearCustomMetadataViewForAsset = async (assetName, viewId) => {
  if (!assetName) return { cleared: false, removedViewId: null, metadata: null };
  if (!viewId) {
    const cleared = await clearCustomMetadataForAsset(assetName);
    return { cleared, removedViewId: null, metadata: null };
  }

  const record = await loadCustomMetadata(assetName);
  const nextMetadata = updateMetadataViews(record, (normalized) => {
    const views = normalized.views.filter((view) => view.id !== viewId);
    if (views.length === normalized.views.length) {
      return normalized;
    }
    return {
      ...normalized,
      views,
      activeViewId: views[0]?.id || null,
    };
  });

  if (!nextMetadata) {
    const cleared = await clearCustomMetadata(assetName);
    return { cleared, removedViewId: viewId, metadata: null };
  }

  const cleared = await writeNormalizedMetadata(assetName, nextMetadata);
  return {
    cleared,
    removedViewId: viewId,
    metadata: nextMetadata,
  };
};

/**
 * Check if asset has custom metadata
 */
const hasCustomMetadataForAsset = async (assetName) => {
  if (!assetName) return false;
  const data = await loadCustomMetadataForAsset(assetName);
  return Boolean(data?.views?.length);
};
