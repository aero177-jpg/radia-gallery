import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { camera, controls, requestRender, THREE, updateDollyZoomBaselineFromCamera } from '../viewer';
import { handleAutoOrbitInputEnd, handleAutoOrbitInputStart } from '../autoOrbit';
import { isImmersiveModeActive, pauseImmersiveMode, resumeImmersiveMode } from '../immersiveMode';

const DEAD_ZONE = 0.08;
const MAX_TRAVEL_RATIO = 0.36;
const LOOK_SPEED = 1.8;
const MIN_POLAR_ANGLE = Math.PI * 0.05;
const MAX_POLAR_ANGLE = Math.PI * 0.95;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const EMPTY_INPUT = { x: 0, y: 0 };

function MobileJoystick() {
  const movePadRef = useRef(null);
  const lookPadRef = useRef(null);
  const movePointerIdRef = useRef(null);
  const lookPointerIdRef = useRef(null);
  const elevationPointerIdRef = useRef(null);
  const elevationDirectionRef = useRef(0);
  const moveInputRef = useRef(EMPTY_INPUT);
  const lookInputRef = useRef(EMPTY_INPUT);
  const frameRef = useRef(null);
  const lastTimeRef = useRef(0);
  const [moveKnobOffset, setMoveKnobOffset] = useState(EMPTY_INPUT);
  const [lookKnobOffset, setLookKnobOffset] = useState(EMPTY_INPUT);

  const hasActiveInput = useCallback(() => (
    movePointerIdRef.current != null
    || lookPointerIdRef.current != null
    || elevationPointerIdRef.current != null
  ), []);

  const finishInput = useCallback(() => {
    if (hasActiveInput()) return;
    lastTimeRef.current = 0;
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    handleAutoOrbitInputEnd();
    resumeImmersiveMode();
  }, [hasActiveInput]);

  const stepMovement = useCallback((timestamp) => {
    frameRef.current = null;
    if (!camera || !controls || !hasActiveInput()) return;

    const previousTime = lastTimeRef.current || timestamp;
    const deltaTime = Math.min(0.05, Math.max(0, (timestamp - previousTime) / 1000));
    lastTimeRef.current = timestamp;

    const movement = new THREE.Vector3();
    const moveInput = moveInputRef.current;
    if (movePointerIdRef.current != null && Math.hypot(moveInput.x, moveInput.y) > DEAD_ZONE) {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() > 1e-6) forward.normalize();

      const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();
      movement.addScaledVector(forward, -moveInput.y).addScaledVector(right, moveInput.x);
    }
    movement.addScaledVector(WORLD_UP, elevationDirectionRef.current);
    if (movement.lengthSq() > 0) {
      if (movement.lengthSq() > 1) movement.normalize();
      const focusDistance = camera.position.distanceTo(controls.target);
      movement.multiplyScalar(Math.max(0.1, focusDistance * 0.9) * deltaTime);
      camera.position.add(movement);
      controls.target.add(movement);
    }

    const lookInput = lookInputRef.current;
    if (lookPointerIdRef.current != null && Math.hypot(lookInput.x, lookInput.y) > DEAD_ZONE) {
      const focusDistance = camera.position.distanceTo(controls.target);
      if (focusDistance > 1e-6) {
        const direction = controls.target.clone().sub(camera.position).normalize();
        const look = new THREE.Spherical().setFromVector3(direction);
        look.theta -= lookInput.x * LOOK_SPEED * deltaTime;
        look.phi = THREE.MathUtils.clamp(
          look.phi + lookInput.y * LOOK_SPEED * deltaTime,
          MIN_POLAR_ANGLE,
          MAX_POLAR_ANGLE,
        );
        controls.target.copy(camera.position).addScaledVector(
          new THREE.Vector3().setFromSpherical(look),
          focusDistance,
        );
      }
    }

    controls.update();
    updateDollyZoomBaselineFromCamera();
    requestRender();
    frameRef.current = requestAnimationFrame(stepMovement);
  }, [hasActiveInput]);

  const updateInput = useCallback((pad, event, inputRef, setKnobOffset) => {
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const maxTravel = rect.width * MAX_TRAVEL_RATIO;
    const rawX = event.clientX - (rect.left + rect.width / 2);
    const rawY = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(rawX, rawY);
    const scale = distance > maxTravel ? maxTravel / distance : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    inputRef.current = { x: x / maxTravel, y: y / maxTravel };
    setKnobOffset({ x, y });
  }, []);

  const startInput = useCallback((event, pointerIdRef, padRef, inputRef, setKnobOffset) => {
    if (pointerIdRef.current != null) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    handleAutoOrbitInputStart();
    if (isImmersiveModeActive()) pauseImmersiveMode();
    updateInput(padRef.current, event, inputRef, setKnobOffset);
    lastTimeRef.current = 0;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(stepMovement);
  }, [stepMovement, updateInput]);

  const moveInput = useCallback((event, pointerIdRef, padRef, inputRef, setKnobOffset) => {
    if (event.pointerId !== pointerIdRef.current) return;
    event.preventDefault();
    updateInput(padRef.current, event, inputRef, setKnobOffset);
  }, [updateInput]);

  const endInput = useCallback((event, pointerIdRef, inputRef, setKnobOffset) => {
    if (event.pointerId !== pointerIdRef.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    pointerIdRef.current = null;
    inputRef.current = EMPTY_INPUT;
    setKnobOffset(EMPTY_INPUT);
    finishInput();
  }, [finishInput]);

  const startElevationInput = useCallback((direction, event) => {
    if (elevationPointerIdRef.current != null) return;
    event.preventDefault();
    elevationPointerIdRef.current = event.pointerId;
    elevationDirectionRef.current = direction;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    handleAutoOrbitInputStart();
    if (isImmersiveModeActive()) pauseImmersiveMode();
    lastTimeRef.current = 0;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(stepMovement);
  }, [stepMovement]);

  const endElevationInput = useCallback((event) => {
    if (event.pointerId !== elevationPointerIdRef.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    elevationPointerIdRef.current = null;
    elevationDirectionRef.current = 0;
    finishInput();
  }, [finishInput]);

  useEffect(() => () => {
    movePointerIdRef.current = null;
    lookPointerIdRef.current = null;
    elevationPointerIdRef.current = null;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    handleAutoOrbitInputEnd();
    resumeImmersiveMode();
  }, []);

  return (
    <>
      <div class="mobile-elevation-controls" aria-label="Camera elevation controls">
        <div
          class="mobile-elevation-hit-zone"
          onPointerDown={(event) => startElevationInput(1, event)}
          onPointerUp={endElevationInput}
          onPointerCancel={endElevationInput}
        >
          <button
            type="button"
            class="mobile-elevation-button is-up"
            aria-label="Move camera up"
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div
          class="mobile-elevation-hit-zone"
          onPointerDown={(event) => startElevationInput(-1, event)}
          onPointerUp={endElevationInput}
          onPointerCancel={endElevationInput}
        >
          <button
            type="button"
            class="mobile-elevation-button is-down"
            aria-label="Move camera down"
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={movePadRef}
        class="mobile-joystick mobile-move-joystick"
        role="application"
        aria-label="Camera movement joystick"
        onPointerDown={(event) => startInput(event, movePointerIdRef, movePadRef, moveInputRef, setMoveKnobOffset)}
        onPointerMove={(event) => moveInput(event, movePointerIdRef, movePadRef, moveInputRef, setMoveKnobOffset)}
        onPointerUp={(event) => endInput(event, movePointerIdRef, moveInputRef, setMoveKnobOffset)}
        onPointerCancel={(event) => endInput(event, movePointerIdRef, moveInputRef, setMoveKnobOffset)}
      >
        <span class="mobile-joystick-knob" style={{ transform: `translate(${moveKnobOffset.x}px, ${moveKnobOffset.y}px)` }} />
      </div>
      <div
        ref={lookPadRef}
        class="mobile-joystick mobile-look-joystick"
        role="application"
        aria-label="Camera look joystick"
        onPointerDown={(event) => startInput(event, lookPointerIdRef, lookPadRef, lookInputRef, setLookKnobOffset)}
        onPointerMove={(event) => moveInput(event, lookPointerIdRef, lookPadRef, lookInputRef, setLookKnobOffset)}
        onPointerUp={(event) => endInput(event, lookPointerIdRef, lookInputRef, setLookKnobOffset)}
        onPointerCancel={(event) => endInput(event, lookPointerIdRef, lookInputRef, setLookKnobOffset)}
      >
        <span class="mobile-joystick-knob" style={{ transform: `translate(${lookKnobOffset.x}px, ${lookKnobOffset.y}px)` }} />
      </div>
    </>
  );
}

export default MobileJoystick;
