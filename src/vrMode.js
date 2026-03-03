import { VRButton, XrHands } from "@sparkjsdev/spark";
import {
  renderer,
  camera,
  controls,
  scene,
  currentMesh,
  requestRender,
  suspendRenderLoop,
  resumeRenderLoop,
  THREE,
} from "./viewer.js";
import { useStore } from "./store.js";
import { restoreHomeView } from "./cameraUtils.js";
import { loadNextAsset, loadPrevAsset } from "./fileLoader.js";

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
      // Scale pan speed based on model scale - smaller models need slower panning
      const currentScale = useStore.getState().vrModelScale || 1;
      const scaledTranslateSpeed = TRANSLATE_SPEED * currentScale;

      // Right thumbstick: pan model (inverted for intuitive "drag" feel)
      if (currentMesh) {
        const delta = new THREE.Vector3();
        let moved = false;

        if (Math.abs(stickX) > STICK_DEADZONE) {
          // Invert: stick right moves model left for intuitive feel
          delta.addScaledVector(right, -stickX * scaledTranslateSpeed * dt);
          moved = true;
        }
        if (Math.abs(stickY) > STICK_DEADZONE) {
          // Invert: stick up moves model down for intuitive feel
          delta.addScaledVector(up, stickY * scaledTranslateSpeed * dt);
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
          setTimeout(() => loadNextAsset(), 0);
          lastNextMs = now;
        }
      }

      // A button: previous image
      if (isPressed(BTN_A_OR_X)) {
        if (now - lastPrevMs > BUTTON_COOLDOWN_MS) {
          setTimeout(() => loadPrevAsset(), 0);
          lastPrevMs = now;
        }
      }
    }

    // ===== LEFT CONTROLLER =====
    if (hand === "left") {
      if (currentMesh) {
        const triggerValue = buttons[BTN_TRIGGER]?.value ?? 0;
        const triggerPressed = triggerValue > 0.1;
        const stickYDepth = Math.abs(stickY) > STICK_DEADZONE ? stickY : 0;
        const depthInput = triggerPressed ? stickYDepth : 0;
        if (Math.abs(depthInput) > 0.01) {
          const currentScale = useStore.getState().vrModelScale || 1;
          const scaledDepthSpeed = DEPTH_SPEED * currentScale;
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
        if (lockedRotationAxis === 'x' && absX > STICK_DEADZONE) {
          const rotationAmount = stickX * ROTATION_SPEED * dt; // flipped direction
          
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
        if (lockedRotationAxis === 'y' && absY > STICK_DEADZONE) {
          const rotationAmount = -stickY * ROTATION_SPEED * dt; // flipped direction

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
  const target = controls?.target?.clone?.() ?? new THREE.Vector3();
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const baseDist = offset.length() || 1;
  const dir = offset.normalize();
  const startDist = baseDist * 1.2 + 0.5;
  camera.position.copy(target).addScaledVector(dir, startDist);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
};

const handleSessionStart = () => {
  const store = useStore.getState();
  store.setVrSessionActive(true);

  suspendRenderLoop();
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType?.("local-floor");
  if (controls) controls.enabled = false;

  prepareVrCameraStart();
  trueOriginalScale = currentMesh?.scale?.clone() ?? null;
  // Apply baseline scale and store as the VR "home" transform
  if (currentMesh && trueOriginalScale) {
    currentMesh.scale.copy(trueOriginalScale).multiplyScalar(VR_BASELINE_SCALE);
  }
  initialModelScale = currentMesh?.scale?.clone() ?? null;
  initialModelPosition = currentMesh?.position?.clone() ?? null;
  initialModelQuaternion = currentMesh?.quaternion?.clone() ?? null; // Store initial rotation
  store.setVrModelScale(1);
  ensureHands();
  ensureGrabControllers();
  setupVrAnimationLoop();

  if (!keyListenerAttached) {
    window.addEventListener("keydown", handleScaleKeydown);
    keyListenerAttached = true;
  }
};

const handleSessionEnd = () => {
  const store = useStore.getState();

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