# Auto Orbit Audit Notes

## Purpose

Auto orbit is a custom-model-only camera behavior. It continuously moves the camera around the current view while preserving the existing viewer, slideshow, keyframe, anchor, and persistence architecture.

This document is a handoff note for future agents. Read it before changing auto orbit, same-base keyframe navigation, slideshow handoffs, or camera input handling.

## Current behavior

- Auto orbit is available only when `isCustomModel` is true.
- The whole custom splat owns the enabled state. The persisted flag is `storedSettings.autoOrbit.enabled`.
- A view may override only orbit parameters: `mode`, `speed`, and `path`.
- The effective view settings are resolved as base settings plus an optional per-view parameter override. A view must not override the group-wide enabled flag.
- `controls.target` is the orbit anchor.
- `rotate` moves the camera target with the camera so the model appears to rotate in place.
- `orbit` keeps the target fixed and moves the camera around it.
- Supported paths are `360-clockwise`, `360-counterclockwise`, and `180`.
- Supported speed labels are `slow`, `medium`, and `fast`.
- Current full-rotation durations are 72 seconds for slow, 45 seconds for medium, and 15 seconds for fast. The default speed remains medium.
- `scheduleAutoOrbit()` starts immediately. There is no general idle-start delay.

## Runtime state and ownership

The controller is `src/autoOrbit.js`.

Important private state:

- `frameId`: the active requestAnimationFrame loop.
- `transitionActive`: prevents orbit from starting while a keyframe transition owns the camera.
- `manuallyPaused`: an explicit user pause latch.

Do not use `cancelAutoOrbit()` to represent a manual pause. It only stops the current animation and clears the store's `autoOrbitPlaying` flag. Camera input, loading, slideshow startup, and transitions call it as a temporary cancellation.

The explicit pause path is `toggleAutoOrbit()`:

1. If orbit is active, set `manuallyPaused = true` and cancel the loop.
2. If orbit is not active, clear `manuallyPaused` and start orbit.
3. Automatic restart paths go through `canAutoOrbit()`, which rejects starts while `manuallyPaused` is true.
4. Disabling auto orbit through `refreshAutoOrbit()` clears the latch so a future enable starts normally.

The `O` button in `AssetNavigation.jsx` and the Spacebar path in `Viewer.jsx` both call this same toggle function. Keep them unified.

## Input workarounds

Three.js `OrbitControls` emits `start` and `end` for drag interactions, but wheel zoom does not reliably emit an `end` event.

`src/components/Viewer.jsx` therefore has two input paths:

- Drag/touch/pointer/keyboard camera movement: cancel on input start and restart on the controls end or key release.
- Mouse-wheel and touchpad zoom: cancel on every wheel event, then use a short 120 ms debounce to detect the end of the wheel stream and restart orbit once.

Do not remove the wheel debounce unless the replacement can detect the end of a touchpad wheel gesture. Restarting directly on every wheel event makes auto orbit fight the remaining zoom gesture.

The old one-second startup delay was removed. The 120 ms wheel debounce is only gesture settling, not a general orbit startup delay.

## Keyframe and slideshow handoff

Same-base views share one loaded mesh/cache entry, so navigation must animate the camera instead of fully reloading the splat.

`src/fileLoader.js` uses this ownership sequence in `navigateWithinLoadedBaseAsset()`:

1. Call `beginAutoOrbitTransition()` before resolving view metadata.
2. This sets `transitionActive` and cancels any active orbit.
3. Resolve and apply the next view, including the camera glide and post-pose reflow.
4. In `finally`, call `endAutoOrbitTransition()`.
5. The end call clears the lock and schedules orbit from the completed destination pose.

The `finally` block is important. It must remain around the complete async transition so an early return or thrown error cannot leave the controller locked forever.

Slideshow startup and advance also cancel orbit. Continuous slideshow handoffs use the existing `continuousAnimations.js` machinery. Do not add a second camera owner or independently restart orbit during a continuous handoff. If slideshow playback is active, its transition/handoff should own the camera.

Known race history: cancellation alone was insufficient because stale input, idle, or transition callbacks could restart orbit while a keyframe glide was in progress. The transition lock was added specifically to prevent that regression.

## Persistence contract

Settings are stored in IndexedDB by base file name.

Base settings:

```js
storedSettings.autoOrbit = {
  enabled: Boolean,
  mode: 'rotate' | 'orbit',
  speed: 'slow' | 'medium' | 'fast',
  path: '360-clockwise' | '360-counterclockwise' | '180',
}
```

Per-view settings:

```js
storedSettings.viewCustomAnimations[viewId].autoOrbit = {
  mode,
  speed,
  path,
}
```

Per-view auto-orbit persistence deliberately excludes `enabled`. Generic slideshow/custom-animation saves preserve existing orbit data instead of erasing it.

Legacy compatibility:

- Older nested `customAnimation.autoOrbit` values are read and migrated into top-level `autoOrbit` cache state when encountered.
- View-specific legacy values are preserved while generic view settings are written.
- `normalizeAutoOrbitSettings()` maps legacy modes `always` to `rotate` and `anchor-only` to `orbit`.

## UI behavior

- `AssetNavigation.jsx` displays `O` instead of the slideshow icon when auto orbit is enabled.
- Clicking `O` toggles the explicit pause latch. Holding the button opens slideshow/orbit options through the existing modal callback.
- `CameraControls.jsx` owns the whole-splat enabled checkbox and saves per-view parameters when the current asset is a view instance.
- `SlideshowOptionsModal.jsx` exposes orbit parameters for custom models without making the enabled state per-view.
- Manual previous/next navigation remains available while auto orbit is enabled.
- Enabling auto orbit stops slideshow playback.

## Audit checklist

When changing this feature, verify all of the following:

- `canAutoOrbit()` still gates custom-model-only behavior, loading, slideshow, immersive/VR state, disabled controls, transition ownership, and manual pause.
- Every camera-writing transition cancels orbit before mutating the camera.
- Every same-base async transition releases its orbit lock in `finally`.
- No automatic path clears `manuallyPaused`.
- Only an explicit toggle clears `manuallyPaused`.
- Wheel zoom has a completion path despite OrbitControls lacking a reliable wheel `end` event.
- The whole-splat enabled flag cannot be replaced by a view override.
- Generic settings writes do not erase top-level or per-view orbit settings.
- Continuous slideshow handoffs do not compete with auto orbit for camera ownership.
- The O button and Spacebar continue to call the same toggle function.

## Validation status

Static diagnostics have passed for the touched controller/config/Viewer files during implementation. The feature has not had a full browser interaction test in this handoff. The highest-value manual checks are:

1. Enable auto orbit on a custom splat with multiple saved views.
2. Pause with O, drag/zoom/move the camera, and verify orbit stays paused.
3. Press Space or O again and verify orbit resumes from the current pose.
4. Zoom with both a mouse wheel and a touchpad gesture and verify orbit resumes after the gesture.
5. Navigate between same-base views manually and through slideshow playback.
6. Verify continuous slideshow transitions complete without orbit taking over mid-glide.
7. Verify base enabled state is shared by all views while mode/speed/path overrides remain view-specific.

## Affected files

### New core modules

- `src/autoOrbit.js`: requestAnimationFrame orbit loop, eligibility gates, transition lock, explicit pause latch, input cancellation, and restart API.
- `src/autoOrbitConfig.js`: defaults, supported modes/speeds/paths, normalization, parameter extraction, and motion durations.

### Runtime and transition integration

- `src/fileLoader.js`: resolves effective base/view orbit settings, synchronizes them into Zustand, cancels orbit for loads, and owns the same-base transition lock.
- `src/cameraUtils.js`: cancels orbit around camera reset/view tweens and schedules it after completed camera mutations.
- `src/customMetadata.js`: coordinates anchor/camera transitions with orbit cancellation and restart.
- `src/components/Viewer.jsx`: hooks orbit into controls, pointer, wheel, touch, keyboard, anchor, and camera movement lifecycles.
- `src/slideshowController.js`: cancels orbit when slideshow playback starts or advances.
- `src/store.js`: exposes `autoOrbitPlaying` and its setter for UI state.

### UI

- `src/components/AssetNavigation.jsx`: O control, pause/start state, and long-press options behavior.
- `src/components/CameraControls.jsx`: whole-splat enable toggle and per-view mode/speed/path persistence.
- `src/components/SlideshowOptionsModal.jsx`: orbit parameter controls for custom models.
- `src/components/ControlsModal.jsx`: user-facing control/help text.
- `src/style.css`: related control styling.

### Persistence, cache, and transfer support

- `src/fileStorage.js`: base and per-view save helpers plus preservation of orbit settings during generic writes.
- `src/splatManager.js`: cache updates, legacy migration, and preservation of orbit parameters.
- `src/storage/sourceAssetAdapter.js`: includes top-level orbit metadata in source fallback data.
- `src/utils/debugTransfer.js`: includes top-level orbit metadata in sanitized transfer/embed settings.

### Adjacent handoff dependency

- `src/continuousAnimations.js`: existing continuous slideshow animation/handoff owner. It is not the auto-orbit controller, but changes to camera ownership or same-base slideshow transitions should be audited against it.
