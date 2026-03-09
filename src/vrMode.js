import { VRButton, XrHands } from "@sparkjsdev/spark";
import {
  renderer,
  camera,
  controls,
  scene,
  currentMesh,
  defaultCamera,
  requestRender,
  suspendRenderLoop,
  resumeRenderLoop,
  THREE,
} from "./viewer.js";
import { useStore } from "./store.js";
import { restoreHomeView } from "./cameraUtils.js";
import {
  loadNextAsset,
  loadPrevAsset,
  getBaseAssetId,
  resolveEffectiveCustomVrView,
  setVrViewInstanceCallback,
} from "./fileLoader.js";
import { getSplatCache } from "./splatManager.js";

let vrButton = null;
let xrHands = null;
let xrHandMesh = null;
let initialModelScale = null;
let initialModelPosition = null;
let initialModelQuaternion = null; // Store initial rotation
let trueOriginalScale = null; // scale before VR baseline applied, for restoring on exit
let keyListenerAttached = false;
let controller1 = null;
let controller2 = null;
let grabRaycaster = null;
let grabTempMatrix = null;
let grabTempMatrix2 = null;
let grabTargetPos = null;
let grabTargetQuat = null;
let grabTargetScale = null;

// Quest controller button indices (xr-standard mapping, per controller)
const BTN_TRIGGER = 0;
const BTN_GRIP = 1;
const BTN_TOUCHPAD = 2; // placeholder on Quest
const BTN_THUMBSTICK = 3;
const BTN_A_OR_X = 4; // A on right, X on left
const BTN_B_OR_Y = 5; // B on right, Y on left

// Axes indices
const AXIS_THUMBSTICK_X = 2;
const AXIS_THUMBSTICK_Y = 3;

// Tuning constants
const VR_BASELINE_SCALE = 0.25; // initial model size in VR relative to default
const SCALE_STEP = 1.5; // for button presses
const MIN_SCALE = 0.02;
const MAX_SCALE = 20.0;
const STICK_DEADZONE = 0.15;
const TRANSLATE_SPEED = 1.0; // units per second for panning (base speed)
const DEPTH_SPEED = 1.5; // units per second for push/pull
const ROTATION_SPEED = 0.6; // radians per second for model rotation
const AXIS_LOCK_THRESHOLD = 0.25; // minimum deflection to lock axis
const MIN_VR_SCREEN_WIDTH = 768;
const MIN_VR_SCREEN_HEIGHT = 480;
const GRAB_SMOOTH_POSITION = 0.25; // 0..1 lerp per frame
const GRAB_SMOOTH_ROTATION = 0.2; // 0..1 slerp per frame
const STICK_EXPONENT = 2.0; // power curve exponent for stick response
const SMOOTH_SCALE_SPEED = 1.8; // exponential scale rate per second when stick is fully deflected

// Apply a non-linear response curve to stick input.
// After deadzone, normalizes to 0..1 and raises to STICK_EXPONENT.
// Small deflections yield very little output; full deflection yields 1.
const applyStickCurve = (value, deadzone = STICK_DEADZONE) => {
  const abs = Math.abs(value);
  if (abs < deadzone) return 0;
  const normalized = (abs - deadzone) / (1 - deadzone);
  const curved = Math.pow(normalized, STICK_EXPONENT);
  return Math.sign(value) * curved;
};

// Axis locking state for rotation
let lockedRotationAxis = null; // 'x', 'y', or null

// Debounce tracking for button presses
const BUTTON_COOLDOWN_MS = 300;
let lastResetMs = 0;
let lastRotResetMs = 0;
let lastNextMs = 0;
let lastPrevMs = 0;
let lastScaleUpMs = 0;
let lastScaleDownMs = 0;

let vrSupportCheckPromise = null;
let preVrCameraNear = null;
let preVrCameraFar = null;
let activeVrBaseAssetId = null;
let activeVrSceneMode = null;

const MIN_VR_NEAR_CLIP = 0.001;
const MAX_VR_NEAR_CLIP = 1;
const DEFAULT_VR_NEAR_CLIP = 0.01;
const MIN_VR_FAR_CLIP = 0.5;
const MAX_VR_FAR_CLIP = 200;
const DEFAULT_VR_FAR_CLIP = 200;
const MIN_VR_CLIP_GAP = 0.001;

const clampVrNearClip = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return THREE.MathUtils.clamp(defaultCamera?.near ?? DEFAULT_VR_NEAR_CLIP, MIN_VR_NEAR_CLIP, MAX_VR_NEAR_CLIP);
  }
  return THREE.MathUtils.clamp(numeric, MIN_VR_NEAR_CLIP, MAX_VR_NEAR_CLIP);
};

const clampVrFarClip = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return THREE.MathUtils.clamp(defaultCamera?.far ?? DEFAULT_VR_FAR_CLIP, MIN_VR_FAR_CLIP, MAX_VR_FAR_CLIP);
  }
  return THREE.MathUtils.clamp(numeric, MIN_VR_FAR_CLIP, MAX_VR_FAR_CLIP);
};

const getSavedVrNearClipForAsset = (asset) => {
  if (!asset) return null;
  const cacheKey = asset.cacheKey || getBaseAssetId(asset) || asset.id;
  const entry = getSplatCache()?.get(cacheKey);
  const vrNearClip = entry?.storedSettings?.vrNearClip;
  return Number.isFinite(vrNearClip) ? clampVrNearClip(vrNearClip) : null;
};

const getSavedVrFarClipForAsset = (asset) => {
  if (!asset) return null;
  const cacheKey = asset.cacheKey || getBaseAssetId(asset) || asset.id;
  const entry = getSplatCache()?.get(cacheKey);
  const vrFarClip = entry?.storedSettings?.vrFarClip;
  return Number.isFinite(vrFarClip) ? clampVrFarClip(vrFarClip) : null;
};

const getVrSceneMode = () => {
  const store = useStore.getState();
  if (store.customMetadataAvailable) return "custom-metadata";
  if (store.metadataMissing) return "metadata-missing";
  return "built-in-metadata";
};

const applyVrClipPlanes = ({ nearClip, farClip } = {}) => {
  if (!camera) return { near: null, far: null };

  const fallbackNear = DEFAULT_VR_NEAR_CLIP;
  const fallbackFar = DEFAULT_VR_FAR_CLIP;
  const resolvedNear = clampVrNearClip(
    nearClip ?? (Number.isFinite(camera.near) ? camera.near : fallbackNear),
  );
  const resolvedFarBase = clampVrFarClip(
    farClip ?? (Number.isFinite(camera.far) ? camera.far : fallbackFar),
  );
  const resolvedFar = Math.max(resolvedFarBase, resolvedNear + MIN_VR_CLIP_GAP);

  camera.near = resolvedNear;
  camera.far = resolvedFar;
  camera.updateProjectionMatrix();
  controls?.update?.();
  requestRender();
  return { near: resolvedNear, far: resolvedFar };
};

const applyVrNearClip = (nextNearClip) => {
  return applyVrClipPlanes({ nearClip: nextNearClip }).near;
};

const applyVrFarClip = (nextFarClip) => {
  return applyVrClipPlanes({ farClip: nextFarClip }).far;
};

const restoreNonVrClipPlanes = () => {
  if (!camera) return;
  applyVrClipPlanes({
    nearClip: Number.isFinite(preVrCameraNear) ? preVrCameraNear : (defaultCamera?.near ?? DEFAULT_VR_NEAR_CLIP),
    farClip: Number.isFinite(preVrCameraFar) ? preVrCameraFar : (defaultCamera?.far ?? DEFAULT_VR_FAR_CLIP),
  });
};

const applyDefaultVrClipPlanes = () => {
  applyVrClipPlanes({
    nearClip: getDefaultVrNearClip(),
    farClip: getDefaultVrFarClip(),
  });
};

const tryApplySavedVrClipPlanes = (assetOverride = null) => {
  const store = useStore.getState();
  const asset = assetOverride || (store.currentAssetIndex >= 0 ? store.assets[store.currentAssetIndex] : null);
  const savedNearClip = getSavedVrNearClipForAsset(asset);
  const savedFarClip = getSavedVrFarClipForAsset(asset);
  if (savedNearClip !== null || savedFarClip !== null) {
    applyVrClipPlanes({
      nearClip: savedNearClip ?? DEFAULT_VR_NEAR_CLIP,
      farClip: savedFarClip ?? DEFAULT_VR_FAR_CLIP,
    });
    return;
  }

  applyDefaultVrClipPlanes();
  controls?.update?.();
  requestRender();
};

const getDefaultVrNearClip = () => clampVrNearClip(MIN_VR_NEAR_CLIP);

const getDefaultVrFarClip = () => {
  const baseNear = getDefaultVrNearClip();
  const baseFar = clampVrFarClip(MAX_VR_FAR_CLIP);
  return Math.max(baseFar, baseNear + MIN_VR_CLIP_GAP);
};

const isSmallScreen = () => {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  return w < MIN_VR_SCREEN_WIDTH || h < MIN_VR_SCREEN_HEIGHT;
};

const checkVrSupport = async () => {
  const store = useStore.getState();

  if (isSmallScreen()) {
    store.setVrSupported(false);
    return { ok: false, reason: "small-screen" };
  }

  if (!navigator?.xr || typeof navigator.xr.isSessionSupported !== "function") {
    store.setVrSupported(false);
    return { ok: false, reason: "no-webxr" };
  }

  try {
    const supported = await navigator.xr.isSessionSupported("immersive-vr");
    store.setVrSupported(Boolean(supported));
    return { ok: Boolean(supported), reason: supported ? null : "unsupported" };
  } catch (err) {
    console.warn("WebXR support probe failed:", err);
    store.setVrSupported(false);
    return { ok: false, reason: "probe-error", error: err };
  }
};

const scaleModel = (multiplier) => {
  const store = useStore.getState();
  if (!currentMesh || !initialModelScale) return;

  const prevScale = store.vrModelScale || 1;
  const nextScale = THREE.MathUtils.clamp(prevScale * multiplier, MIN_SCALE, MAX_SCALE);
  if (nextScale === prevScale) return;

  const ratio = nextScale / prevScale;
  currentMesh.scale.multiplyScalar(ratio);
  store.setVrModelScale(nextScale);
  requestRender();
};

const scaleModelSmooth = (input, dt) => {
  const store = useStore.getState();
  if (!currentMesh || !initialModelScale) return;
  if (!Number.isFinite(input) || Math.abs(input) < 0.001) return;

  const prevScale = store.vrModelScale || 1;
  const ratio = Math.exp(input * SMOOTH_SCALE_SPEED * dt);
  const nextScale = THREE.MathUtils.clamp(prevScale * ratio, MIN_SCALE, MAX_SCALE);
  if (Math.abs(nextScale - prevScale) < 1e-5) return;

  currentMesh.scale.multiplyScalar(nextScale / prevScale);
  store.setVrModelScale(nextScale);
  requestRender();
};

const restoreModelTransform = () => {
  const store = useStore.getState();
  // Restore to the true original scale (before VR baseline was applied)
  if (currentMesh && trueOriginalScale) {
    currentMesh.scale.copy(trueOriginalScale);
  } else if (currentMesh && initialModelScale) {
    currentMesh.scale.copy(initialModelScale);
  }
  if (currentMesh && initialModelPosition) {
    currentMesh.position.copy(initialModelPosition);
  }
  if (currentMesh && initialModelQuaternion) {
    currentMesh.quaternion.copy(initialModelQuaternion);
  }
  store.setVrModelScale(1);
  initialModelScale = null;
  initialModelPosition = null;
  initialModelQuaternion = null;
  trueOriginalScale = null;
};

const clearControllerSelection = (controller) => {
  if (!controller?.userData) return;
  controller.userData.selected = undefined;
  controller.userData.selectedParent = undefined;
  controller.userData.grabOffset = undefined;
  controller.userData.filteredPos = null;
  controller.userData.filteredQuat = null;
  controller.userData.targetRayMode = undefined;
};

const resetVrInteractionState = () => {
  lockedRotationAxis = null;
  clearControllerSelection(controller1);
  clearControllerSelection(controller2);
};

const establishVrAssetBaseline = () => {
  const store = useStore.getState();

  resetVrInteractionState();
  prepareVrCameraStart();

  if (!currentMesh) {
    initialModelScale = null;
    initialModelPosition = null;
    initialModelQuaternion = null;
    trueOriginalScale = null;
    store.setVrModelScale(1);
    requestRender();
    return;
  }

  trueOriginalScale = currentMesh.scale.clone();
  currentMesh.scale.copy(trueOriginalScale).multiplyScalar(VR_BASELINE_SCALE);
  initialModelScale = currentMesh.scale.clone();
  initialModelPosition = currentMesh.position.clone();
  initialModelQuaternion = currentMesh.quaternion.clone();
  store.setVrModelScale(1);
  requestRender();
};

const resetRotationOnly = () => {
  if (currentMesh && initialModelQuaternion) {
    currentMesh.quaternion.copy(initialModelQuaternion);
    requestRender();
  }
};

const handleScaleKeydown = (event) => {
  if (!useStore.getState().vrSessionActive) return;
  if (event.key === "+" || event.key === "=") {
    scaleModel(SCALE_STEP);
  } else if (event.key === "-" || event.key === "_") {
    scaleModel(1 / SCALE_STEP);
  }
};

const ensureHands = () => {
  if (!xrHands) {
    xrHands = new XrHands();
    xrHandMesh = xrHands.makeGhostMesh();
    if (xrHandMesh) {
      xrHandMesh.editable = false;

      // Override ghost hand appearance: neutral color, lower opacity
      xrHandMesh.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) {
            mat.color?.set(0xaaaaaa);
            mat.emissive?.set(0x000000);
            mat.opacity = 0.15;
            mat.transparent = true;
            mat.depthWrite = false;
            if (mat.uniforms) {
              if (mat.uniforms.color) mat.uniforms.color.value?.set(0xaaaaaa);
              if (mat.uniforms.opacity) mat.uniforms.opacity.value = 0.15;
            }
          }
        }
      });
    }
  }

  if (xrHandMesh && !scene.children.includes(xrHandMesh)) {
    scene.add(xrHandMesh);
  }
};

const ensureGrabControllers = () => {
  if (!renderer || !scene) return;

  if (!grabRaycaster) {
    grabRaycaster = new THREE.Raycaster();
    grabTempMatrix = new THREE.Matrix4();
    grabTempMatrix2 = new THREE.Matrix4();
    grabTargetPos = new THREE.Vector3();
    grabTargetQuat = new THREE.Quaternion();
    grabTargetScale = new THREE.Vector3();
  }

  if (!controller1) {
    controller1 = renderer.xr.getController(0);
    controller1.addEventListener("selectstart", handleGrabSelectStart);
    controller1.addEventListener("selectend", handleGrabSelectEnd);
    scene.add(controller1);
  }

  if (!controller2) {
    controller2 = renderer.xr.getController(1);
    controller2.addEventListener("selectstart", handleGrabSelectStart);
    controller2.addEventListener("selectend", handleGrabSelectEnd);
    scene.add(controller2);
  }
};

const disposeGrabControllers = () => {
  if (controller1) {
    controller1.removeEventListener("selectstart", handleGrabSelectStart);
    controller1.removeEventListener("selectend", handleGrabSelectEnd);
    if (scene?.children?.includes(controller1)) scene.remove(controller1);
  }
  if (controller2) {
    controller2.removeEventListener("selectstart", handleGrabSelectStart);
    controller2.removeEventListener("selectend", handleGrabSelectEnd);
    if (scene?.children?.includes(controller2)) scene.remove(controller2);
  }
  controller1 = null;
  controller2 = null;
};

const getControllerIntersections = (controller) => {
  if (!currentMesh || !grabRaycaster || !grabTempMatrix) return [];

  controller.updateMatrixWorld();
  grabTempMatrix.identity().extractRotation(controller.matrixWorld);
  grabRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  grabRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(grabTempMatrix);

  return grabRaycaster.intersectObject(currentMesh, true);
};

const handleGrabSelectStart = (event) => {
  if (!currentMesh) return;

  const controller = event.target;
  if (controller?.userData?.handedness === "left") return;
  const intersections = getControllerIntersections(controller);
  if (!intersections.length) return;

  controller.userData.selected = currentMesh;
  controller.userData.selectedParent = currentMesh.parent || scene;
  controller.updateMatrixWorld();
  grabTempMatrix.copy(controller.matrixWorld).invert();
  controller.userData.grabOffset = grabTempMatrix.multiply(currentMesh.matrixWorld).clone();
  controller.userData.filteredPos = null;
  controller.userData.filteredQuat = null;
  controller.userData.targetRayMode = event?.data?.targetRayMode;
  requestRender();
};

const handleGrabSelectEnd = (event) => {
  const controller = event.target;
  const selected = controller.userData.selected;
  if (!selected) return;

  const parent = controller.userData.selectedParent || scene;
  if (selected.parent !== parent) {
    parent.attach(selected);
  }
  controller.userData.selected = undefined;
  controller.userData.selectedParent = undefined;
  controller.userData.grabOffset = undefined;
  controller.userData.filteredPos = null;
  controller.userData.filteredQuat = null;
  requestRender();
};

const updateGrabbedObjects = () => {
  if (!grabTempMatrix2 || !grabTargetPos || !grabTargetQuat || !grabTargetScale) return;

  const controllers = [controller1, controller2];
  for (const controller of controllers) {
    if (!controller?.userData?.selected || !controller.userData.grabOffset) continue;

    const selected = controller.userData.selected;
    controller.updateMatrixWorld();

    grabTempMatrix2.copy(controller.matrixWorld).multiply(controller.userData.grabOffset);
    grabTempMatrix2.decompose(grabTargetPos, grabTargetQuat, grabTargetScale);

    if (!controller.userData.filteredPos) {
      controller.userData.filteredPos = grabTargetPos.clone();
    } else {
      controller.userData.filteredPos.lerp(grabTargetPos, GRAB_SMOOTH_POSITION);
    }

    if (!controller.userData.filteredQuat) {
      controller.userData.filteredQuat = grabTargetQuat.clone();
    } else {
      controller.userData.filteredQuat.slerp(grabTargetQuat, GRAB_SMOOTH_ROTATION);
    }

    selected.position.copy(controller.userData.filteredPos);
    selected.quaternion.copy(controller.userData.filteredQuat);
    requestRender();
  }
};

const removeHands = () => {
  if (xrHandMesh && scene.children.includes(xrHandMesh)) {
    scene.remove(xrHandMesh);
  }
};

const setupVrAnimationLoop = () => {
  if (!renderer) return;
  let lastTime = performance.now();
  renderer.setAnimationLoop((time, xrFrame) => {
    const dt = Math.max(0.001, (time - lastTime) / 1000);
    lastTime = time;

    if (xrHands && xrHandMesh) {
      xrHands.update({ xr: renderer.xr, xrFrame });
    }

    handleVrGamepadInput(dt);
    updateGrabbedObjects();

    renderer.render(scene, camera);
  });
};

const stopVrAnimationLoop = () => {
  if (!renderer) return;
  renderer.setAnimationLoop(null);
};

const performVrReset = () => {
  restoreHomeView();
  prepareVrCameraStart();
  if (initialModelPosition && currentMesh) {
    currentMesh.position.copy(initialModelPosition);
  }
  if (initialModelScale && currentMesh) {
    currentMesh.scale.copy(initialModelScale);
    useStore.getState().setVrModelScale(1);
  }
  if (initialModelQuaternion && currentMesh) {
    currentMesh.quaternion.copy(initialModelQuaternion);
  }
  requestRender();
};

const handleVrGamepadInput = (dt) => {
  const session = renderer?.xr?.getSession?.();
  if (!session) return;

  const now = performance.now();

  // Get camera vectors for movement relative to view
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  camera.getWorldDirection(forward).normalize();
  right.crossVectors(forward, up).normalize();

  for (const [index, source] of session.inputSources.entries()) {
    const gp = source?.gamepad;
    const hand = source?.handedness || "unknown";
    if (!gp) continue;

    if (index === 0 && controller1) {
      controller1.userData.handedness = hand;
    } else if (index === 1 && controller2) {
      controller2.userData.handedness = hand;
    }

    const axes = gp.axes || [];
    const buttons = gp.buttons || [];

    // Get thumbstick values (axes 2 and 3 for xr-standard)
    const stickX = axes[AXIS_THUMBSTICK_X] ?? 0;
    const stickY = axes[AXIS_THUMBSTICK_Y] ?? 0;

    // Button helpers
    const isPressed = (idx) => buttons[idx]?.pressed ?? false;

    // ===== RIGHT CONTROLLER =====
    if (hand === "right") {
      const triggerValue = buttons[BTN_TRIGGER]?.value ?? 0;
      const triggerPressed = triggerValue > 0.1;
      const activeController = index === 0 ? controller1 : controller2;
      const isGrabbingMesh = Boolean(activeController?.userData?.selected);

      // Scale pan speed based on model scale (sqrt for gentler scaling)
      const currentScale = useStore.getState().vrModelScale || 1;
      const scaledTranslateSpeed = TRANSLATE_SPEED * Math.sqrt(currentScale);

      // Right thumbstick: pan model normally, but while actively grabbing with
      // the trigger, vertical stick motion becomes smooth scale control.
      if (currentMesh) {
        const delta = new THREE.Vector3();
        let moved = false;

        const curvedX = applyStickCurve(stickX);
        const curvedY = applyStickCurve(stickY);
        const useStickForScaling = triggerPressed && isGrabbingMesh;

        if (curvedX !== 0) {
          // Invert: stick right moves model left for intuitive feel
          delta.addScaledVector(right, -curvedX * scaledTranslateSpeed * dt);
          moved = true;
        }

        if (useStickForScaling && Math.abs(curvedY) > 0) {
          // Stick up enlarges, stick down shrinks.
          scaleModelSmooth(-curvedY, dt);
        } else if (curvedY !== 0) {
          // Invert: stick up moves model down for intuitive feel
          delta.addScaledVector(up, curvedY * scaledTranslateSpeed * dt);
          moved = true;
        }

        if (moved) {
          currentMesh.position.add(delta);
          requestRender();
        }
      }

      // Right thumbstick click: reset camera and model
      if (isPressed(BTN_THUMBSTICK)) {
        if (now - lastResetMs > BUTTON_COOLDOWN_MS) {
          performVrReset();
          lastResetMs = now;
        }
      }

      // B button: next image
      if (isPressed(BTN_B_OR_Y)) {
        if (now - lastNextMs > BUTTON_COOLDOWN_MS) {
          loadNextAsset();
          lastNextMs = now;
        }
      }

      // A button: previous image
      if (isPressed(BTN_A_OR_X)) {
        if (now - lastPrevMs > BUTTON_COOLDOWN_MS) {
          loadPrevAsset();
          lastPrevMs = now;
        }
      }
    }

    // ===== LEFT CONTROLLER =====
    if (hand === "left") {
      if (currentMesh) {
        const triggerValue = buttons[BTN_TRIGGER]?.value ?? 0;
        const triggerPressed = triggerValue > 0.1;
        const curvedDepthY = applyStickCurve(stickY);
        const depthInput = triggerPressed ? curvedDepthY : 0;
        if (Math.abs(depthInput) > 0.01) {
          // Use sqrt of scale so zoom stays usable at both small and large scales
          const currentScale = useStore.getState().vrModelScale || 1;
          const scaledDepthSpeed = DEPTH_SPEED * Math.sqrt(currentScale);
          const depthDelta = depthInput * scaledDepthSpeed * dt;
          currentMesh.position.addScaledVector(forward, depthDelta);
          requestRender();
        }
      }

      const triggerValue = buttons[BTN_TRIGGER]?.value ?? 0;
      const triggerPressed = triggerValue > 0.1;

      if (currentMesh && !triggerPressed) {
        // Get rotation pivot point (use model center or controls target)
        const pivot = controls?.target?.clone() ?? currentMesh.position.clone();

        const absX = Math.abs(stickX);
        const absY = Math.abs(stickY);
        const stickMagnitude = Math.sqrt(stickX * stickX + stickY * stickY);

        if (stickMagnitude < STICK_DEADZONE) {
          lockedRotationAxis = null;
        } else if (lockedRotationAxis === null && stickMagnitude > AXIS_LOCK_THRESHOLD) {
          lockedRotationAxis = absX > absY ? 'x' : 'y';
        }

        // Left thumbstick X: rotate model around world Y axis (horizontal spin)
        // Flipped: Stick right = rotate counter-clockwise, stick left = clockwise
        // Power curve: small stick deflection = slow rotation, full = fast
        const curvedRotX = applyStickCurve(stickX);
        const curvedRotY = applyStickCurve(stickY);
        if (lockedRotationAxis === 'x' && Math.abs(curvedRotX) > 0) {
          const rotationAmount = curvedRotX * ROTATION_SPEED * dt; // flipped direction
          
          // Rotate model around the pivot on world Y axis
          const offset = currentMesh.position.clone().sub(pivot);
          offset.applyAxisAngle(up, rotationAmount);
          currentMesh.position.copy(pivot).add(offset);
          
          // Also rotate the model itself so it spins in place relative to pivot
          currentMesh.rotateOnWorldAxis(up, rotationAmount);
          
          requestRender();
        }

        // Left thumbstick Y: rotate model around right axis (vertical tilt/pitch)
        // Flipped: Stick forward = tilt backward, stick back = tilt forward
        if (lockedRotationAxis === 'y' && Math.abs(curvedRotY) > 0) {
          const rotationAmount = -curvedRotY * ROTATION_SPEED * dt; // flipped direction

          // Rotate model around the pivot on the right axis (pitch)
          const offset = currentMesh.position.clone().sub(pivot);
          offset.applyAxisAngle(right, rotationAmount);
          currentMesh.position.copy(pivot).add(offset);

          // Also rotate the model itself
          currentMesh.rotateOnWorldAxis(right, rotationAmount);

          requestRender();
        }
      }

      // Left thumbstick click: reset rotation only
      if (isPressed(BTN_THUMBSTICK)) {
        if (now - lastRotResetMs > BUTTON_COOLDOWN_MS) {
          resetRotationOnly();
          lastRotResetMs = now;
        }
      }

      // Y button (BTN_B_OR_Y on left = Y): scale up
      if (isPressed(BTN_B_OR_Y)) {
        if (now - lastScaleUpMs > BUTTON_COOLDOWN_MS) {
          scaleModel(SCALE_STEP);
          lastScaleUpMs = now;
        }
      }

      // X button (BTN_A_OR_X on left = X): scale down
      if (isPressed(BTN_A_OR_X)) {
        if (now - lastScaleDownMs > BUTTON_COOLDOWN_MS) {
          scaleModel(1 / SCALE_STEP);
          lastScaleDownMs = now;
        }
      }
    }
  }
};

const prepareVrCameraStart = () => {
  if (!camera) return;
  const store = useStore.getState();
  const shouldUseGridEyeLevelStart = !store.metadataMissing && !store.customMetadataAvailable;

  if (shouldUseGridEyeLevelStart) {
    const target = controls?.target?.clone?.() ?? new THREE.Vector3();
    const flatTarget = new THREE.Vector3(target.x, 0, target.z);
    const offset = new THREE.Vector3().subVectors(camera.position, target);
    const flatOffset = new THREE.Vector3(offset.x, 0, offset.z);

    if (flatOffset.lengthSq() < 1e-6) {
      camera.getWorldDirection(flatOffset);
      flatOffset.y = 0;
      flatOffset.multiplyScalar(-1);
    }

    const baseDist = flatOffset.length() || offset.length() || 1;
    const dir = flatOffset.lengthSq() > 1e-6
      ? flatOffset.normalize()
      : new THREE.Vector3(0, 0, 1);
    const startDist = baseDist * 1.2 + 0.5;

    camera.position.copy(flatTarget).addScaledVector(dir, startDist);
    camera.position.y = 0;
    camera.lookAt(flatTarget);
    camera.updateProjectionMatrix();
    return;
  }

  const target = controls?.target?.clone?.() ?? new THREE.Vector3();
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const baseDist = offset.length() || 1;
  const dir = offset.normalize();
  const startDist = baseDist * 1.2 + 0.5;
  camera.position.copy(target).addScaledVector(dir, startDist);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
};

/**
 * Look up the current asset's cached storedSettings and apply a saved VR view
 * (model transform) if one exists.  Called immediately after VR session setup.
 */
const tryApplySavedVrView = (assetOverride = null) => {
  const store = useStore.getState();
  const { assets, currentAssetIndex } = store;
  const asset = assetOverride || (currentAssetIndex >= 0 ? assets[currentAssetIndex] : null);
  if (!asset) return;

  const cacheKey = asset.cacheKey || getBaseAssetId(asset) || asset.id;
  const cache = getSplatCache();
  const entry = cache?.get(cacheKey);
  if (!entry?.storedSettings) return;

  const vrView = resolveEffectiveCustomVrView(entry.storedSettings, asset);
  if (!vrView) return;

  applyVrView(vrView);
};

const syncVrStateToCurrentAsset = (assetOverride = null, options = {}) => {
  const store = useStore.getState();
  if (!store.vrSessionActive) return;

  const asset = assetOverride || (store.currentAssetIndex >= 0 ? store.assets[store.currentAssetIndex] : null);
  const nextBaseAssetId = asset ? (asset.cacheKey || getBaseAssetId(asset) || asset.id) : null;
  const nextSceneMode = getVrSceneMode();
  const shouldRebaseline = Boolean(
    options.forceRebaseline
      || nextBaseAssetId !== activeVrBaseAssetId
      || nextSceneMode !== activeVrSceneMode,
  );

  if (shouldRebaseline) {
    establishVrAssetBaseline();
  }

  tryApplySavedVrView(asset);
  tryApplySavedVrClipPlanes(asset);

  activeVrBaseAssetId = nextBaseAssetId;
  activeVrSceneMode = nextSceneMode;
  requestRender();
};

const handleSessionStart = () => {
  const store = useStore.getState();
  store.setVrSessionActive(true);

  suspendRenderLoop();
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType?.("local-floor");
  if (controls) controls.enabled = false;
  preVrCameraNear = camera?.near ?? null;
  preVrCameraFar = camera?.far ?? null;
  ensureHands();
  ensureGrabControllers();
  setupVrAnimationLoop();

  syncVrStateToCurrentAsset(null, { forceRebaseline: true });

  // Register callback so asset or view changes rebuild VR state when needed.
  setVrViewInstanceCallback((asset) => {
    syncVrStateToCurrentAsset(asset);
  });

  if (!keyListenerAttached) {
    window.addEventListener("keydown", handleScaleKeydown);
    keyListenerAttached = true;
  }
};

const handleSessionEnd = () => {
  const store = useStore.getState();

  setVrViewInstanceCallback(null);
  stopVrAnimationLoop();
  renderer.xr.enabled = false;
  if (controls) controls.enabled = true;
  restoreModelTransform();
  disposeGrabControllers();
  removeHands();
  if (keyListenerAttached) {
    window.removeEventListener("keydown", handleScaleKeydown);
    keyListenerAttached = false;
  }
  restoreNonVrClipPlanes();
  preVrCameraNear = null;
  preVrCameraFar = null;
  activeVrBaseAssetId = null;
  activeVrSceneMode = null;
  
  // Restore camera to home view after VR session
  restoreHomeView();
  
  resumeRenderLoop();
  requestRender();
  store.setVrSessionActive(false);
};

const attachSessionListeners = () => {
  if (!renderer || !renderer.xr) return;
  renderer.xr.removeEventListener?.("sessionstart", handleSessionStart);
  renderer.xr.removeEventListener?.("sessionend", handleSessionEnd);
  renderer.xr.addEventListener?.("sessionstart", handleSessionStart);
  renderer.xr.addEventListener?.("sessionend", handleSessionEnd);
};

export const initVrSupport = async (containerEl) => {
  const store = useStore.getState();

  if (!renderer || vrButton) return vrButton;

  if (!vrSupportCheckPromise) {
    vrSupportCheckPromise = checkVrSupport();
  }

  const support = await vrSupportCheckPromise;
  if (!support?.ok) {
    return null;
  }

  try {
    vrButton = VRButton.createButton(renderer, {
      optionalFeatures: ["hand-tracking"],
    });
  } catch (err) {
    console.warn("VR button creation failed:", err);
    store.setVrSupported(false);
    return null;
  }

  if (!vrButton) {
    store.setVrSupported(false);
    return null;
  }

  // Do NOT append to DOM - the button auto-shows itself when VR is supported.
  // Keep it detached and just click it programmatically via enterVrSession().
  vrButton.style.display = "none";
  attachSessionListeners();
  store.setVrSupported(true);
  return vrButton;
};

export const enterVrSession = async () => {
  const store = useStore.getState();
  
  // If already in a VR session, exit it
  const currentSession = renderer?.xr?.getSession?.();
  if (currentSession) {
    try {
      await currentSession.end();
    } catch (err) {
      console.warn("Failed to end VR session:", err);
    }
    return true;
  }
  
  // Otherwise, start a new session
  const viewer = document.getElementById("viewer");
  const button = vrButton || await initVrSupport(viewer);
  if (!button) {
    store.addLog?.("VR not available on this device");
    return false;
  }

  try {
    button.click();
    return true;
  } catch (err) {
    store.addLog?.("Failed to start VR session");
    console.warn("VR start failed:", err);
    return false;
  }
};

export const exitVrSessionAndRefresh = async () => {
  const currentSession = renderer?.xr?.getSession?.();
  if (!currentSession) {
    window.location.reload();
    return true;
  }

  const handleEnd = () => {
    window.location.reload();
  };

  currentSession.addEventListener("end", handleEnd, { once: true });

  try {
    await currentSession.end();
    return true;
  } catch (err) {
    currentSession.removeEventListener("end", handleEnd);
    console.warn("Failed to end VR session:", err);
    return false;
  }
};

export const getCurrentVrNearClip = () => clampVrNearClip(camera?.near ?? defaultCamera?.near ?? DEFAULT_VR_NEAR_CLIP);

export const setCurrentVrNearClip = (nearClip) => applyVrNearClip(nearClip);

export const getDefaultCurrentVrNearClip = () => getDefaultVrNearClip();

export const getCurrentVrFarClip = () => clampVrFarClip(camera?.far ?? defaultCamera?.far ?? DEFAULT_VR_FAR_CLIP);

export const setCurrentVrFarClip = (farClip) => applyVrFarClip(farClip);

export const getDefaultCurrentVrFarClip = () => getDefaultVrFarClip();

/**
 * Returns the current VR model transform state for saving.
 * Captures position, quaternion, and scale relative to the VR baseline.
 * Returns null if not in a VR session or no mesh is loaded.
 */
export const getCurrentVrModelTransform = () => {
  if (!currentMesh || !useStore.getState().vrSessionActive) return null;

  const pos = currentMesh.position.toArray();
  const quat = [
    currentMesh.quaternion.x,
    currentMesh.quaternion.y,
    currentMesh.quaternion.z,
    currentMesh.quaternion.w,
  ];
  const scale = useStore.getState().vrModelScale || 1;

  return { position: pos, quaternion: quat, vrModelScale: scale };
};

/**
 * Applies a saved VR view transform to the current mesh.
 * Called after VR session starts when a saved VR view exists for the asset.
 * @param {Object} vrView - {position:[x,y,z], quaternion:[x,y,z,w], vrModelScale:number}
 */
export const applyVrView = (vrView) => {
  if (!currentMesh || !vrView) return;

  if (Array.isArray(vrView.position) && vrView.position.length === 3) {
    currentMesh.position.fromArray(vrView.position);
    // Update our stored initial so "reset" goes back to this saved pose
    if (initialModelPosition) initialModelPosition.copy(currentMesh.position);
  }

  if (Array.isArray(vrView.quaternion) && vrView.quaternion.length === 4) {
    currentMesh.quaternion.set(
      vrView.quaternion[0], vrView.quaternion[1],
      vrView.quaternion[2], vrView.quaternion[3],
    );
    if (initialModelQuaternion) initialModelQuaternion.copy(currentMesh.quaternion);
  }

  if (typeof vrView.vrModelScale === 'number' && vrView.vrModelScale > 0) {
    const store = useStore.getState();
    const currentScale = store.vrModelScale || 1;
    const ratio = vrView.vrModelScale / currentScale;
    currentMesh.scale.multiplyScalar(ratio);
    store.setVrModelScale(vrView.vrModelScale);
    if (initialModelScale) initialModelScale.copy(currentMesh.scale);
  }

  requestRender();
};