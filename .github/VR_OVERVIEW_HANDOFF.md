> Start with [VR Live Test Playbook](VR_LIVE_TEST_PLAYBOOK.md). It records the 2026-09-14 source investigation, corrections to assumptions below, Part 1 changes, and separate instructions for each pass. Read only the selected pass to limit context. Apply the evidence gate separately to each pass; diagnostic-only instrumentation may precede a diagnosis. The user measures VR FPS with headset tools, NOT the app's built-in FPS display.

You are investigating and fixing the WebXR/VR migration in radia-gallery, a Vite React app using Three.js and SparkJS 2.2 for Gaussian splats.

Stay tightly scoped to src during the investigation. Do not inspect generated output, assets, dependencies, storage implementations, slideshow code, or unrelated application surfaces unless a concrete dependency requires it.

The VR work has three goals:

Remove the redundant Spark-generated “Open in VR” button while preserving the app’s existing VR control.
Fix the Quest 3 startup viewpoint, which currently begins several feet above the intended scene viewpoint.
Improve and correctly measure VR performance. Heavy scenes run around 30 FPS and lighter scenes around 50 FPS, while reported GPU utilization is approximately 50%. Desktop-oriented culling and splat-size controls have little visible effect in VR.
Primary file index

vrMode.js:1: Owns SparkXr initialization, immersive session entry/exit, XR reference-space configuration, session callbacks, and the XR animation loop. Important symbols include initVrSupport, enterVrSession, exitVrSession, and getVrState.
viewer.js:90: Creates the Three.js renderer, camera, scene, and SparkRenderer. Inspect renderer options, renderer.setPixelRatio, camera origin/orientation, preUpdate, maxStdDev, sorting, and LoD configuration.
App.jsx:56: Initializes the viewer and calls VR support initialization.
CameraControls.jsx:9: Contains the app-owned VR action and the quality controls exposed to users.
BottomControls.jsx:72: Contains another app-owned bottom-control path that may render or trigger the VR action.
VrOverlay.jsx:1: VR-related overlay/UI state. Confirm whether it participates in the redundant-button behavior.
splatManager.js:170: Applies splat quality, culling, and rendering overrides. Verify whether these settings affect the active SparkRenderer and whether they are meaningful for LoD-enabled SplatMeshes in XR.
store.js: Check only the VR and quality state symbols needed to understand control flow.
Viewer.jsx: Check only the viewer lifecycle and canvas/container ownership relevant to XR DOM placement.
Verified current behavior

vrMode.js constructs SparkXr with sessionMode: "immersive-vr" and referenceSpaceType: "local-floor".
The code currently hides xr.element with style.display = "none". Do not assume this is sufficient. Verify what SparkXr creates, when it attaches its element, and whether it later changes the element’s visibility or inserts another control.
The app calls xr.enter() from its own VR button and then installs a direct renderer.setAnimationLoop that renders the main scene and camera.
Session-end cleanup restores the renderer loop and exits XR. Check for race conditions, duplicate loops, stale sessions, and repeated initialization.
The desktop camera is initialized around the world origin and is reset to a zero-height origin in the VR path. This is a strong candidate for the elevated-start problem, but prove it before changing behavior.
The app already uses Spark’s modern renderer and LoD path. Its visible quality control primarily changes SparkRenderer.maxStdDev; it does not currently expose a dedicated XR framebuffer scale, compositor foveation, or XR-specific render-resolution control.
Issue 1: redundant VR button

Determine whether the visible button is:

SparkXr.element;
a second element created by SparkXr during support detection or session entry;
a Three.js VRButton/XRButton path;
a button rendered by one of the app’s React controls; or
a CSS/layout artifact caused by the hidden element remaining positioned over the canvas.
Inspect the Spark 2.2 SparkXr implementation and its basic XR example before deciding on a fix. Prefer an official SparkXr option or lifecycle-safe DOM removal/disabling mechanism. Avoid a broad global CSS selector unless the element identity and lifecycle make that the only reliable solution.

Acceptance criteria:

Only the app-owned VR control is visible.
The app-owned control still enters and exits immersive VR.
SparkXr support detection still works.
There are no duplicate controls in the main app or embed path.
The fix survives session start, session end, component remount, and repeated initialization.
Issue 2: elevated initial viewpoint

First instrument the first XR frame and record:

renderer.xr.getReferenceSpace() and the effective reference-space type;
renderer.xr.getCamera() position and matrix;
the viewer pose/head position from the first active XR frame;
the app camera position/orientation before and after xr.enter();
the scene/splat world transform and its bounds;
whether the observed offset is a constant Y translation, a full pose offset, or a scene-scale mismatch.
Important WebXR facts:

local-floor has Y=0 at the estimated physical floor. The headset’s eye position is therefore expected to be above Y=0.
A desktop camera at Y=0 is not automatically equivalent to a user’s eye-level camera in a floor-relative XR space.
Do not “fix” this by blindly switching to local, because that changes physical floor semantics.
Consider whether the correct solution is a scene-root/world offset, an XR origin offset using getOffsetReferenceSpace, or a deliberate initial-placement transform that preserves headset tracking.
Do not overwrite the XR-managed camera pose every frame. Three.js must continue applying the per-eye XR camera transforms.
Preserve the application’s intended model scale. A one-meter physical movement should correspond to one world unit if that is the app’s current convention.
The desired behavior is: after pressing the existing VR control, the current desktop viewpoint should become the intended initial virtual viewpoint, with the splat scene centered directly in front of the user’s face at the correct height. Physical head movement must remain natural after entry.

Acceptance criteria:

Quest 3 through Virtual Desktop with SteamVR and VDXR starts at the intended eye-level viewpoint.
The scene is in front of the user rather than above, below, or behind them.
Head translation and rotation remain correctly tracked.
Desktop camera behavior, slideshow camera state, VR exit, and re-entry are not regressed.
Issue 3: VR performance

Do not infer the bottleneck from Windows GPU utilization alone. Measure the XR session and renderer directly.

Add temporary or debug-only instrumentation as needed for:

XR callback interval and effective application FPS;
XRSession.frameRate;
XRSession.supportedFrameRates;
XRSession.visibilityState;
renderer.xr.isPresenting;
XR base-layer framebuffer width and height;
framebuffer scale factor;
fixed foveation support/value;
active Spark LoD splat count, if available;
Spark update/sort time versus Three.js render time;
CPU frame time versus GPU draw time where a supported timer-query path exists.
Distinguish these cases:

The app is missing the headset’s target frame deadline.
The XR runtime is intentionally delivering 30/45/50 FPS with reprojection.
The app is rendering at an unnecessarily high XR framebuffer resolution.
Spark sorting, LoD traversal, worker synchronization, or uploads are CPU-bound.
Gaussian blending/fill is GPU-bound even though overall desktop GPU utilization appears low.
A desktop requestAnimationFrame loop is still doing work during immersive presentation.
The quality control is changing maxStdDev but the active scene is dominated by LoD count, framebuffer resolution, or another cost.
Check the following Spark 2.x controls and their actual applicability to this app:

maxStdDev, with Spark documentation specifically recommending approximately Math.sqrt(5) for VR.
lodSplatCount.
lodSplatScale.
lodRenderScale.
enableLod and enableDriveLod.
minPixelRadius and maxPixelRadius.
Spark’s XR defaults, which target substantially lower LoD budgets than desktop.
Spark’s XR-oriented cone and behind-viewer foveation settings.
Check the following Three.js/WebXR controls:

renderer.xr.setFramebufferScaleFactor(...), configured before session start.
renderer.xr.setFoveation(...), where supported.
renderer.xr.getSession().renderState.baseLayer.framebufferWidth/Height.
XRWebGLLayer.fixedFoveation, where available.
Whether the renderer context is made XR-compatible through the expected Three.js/Spark lifecycle.
Whether the app’s desktop renderer.setPixelRatio(...) is being incorrectly treated as the XR framebuffer-resolution control.
Do not add arbitrary frame throttling. First establish whether the observed 30/50 FPS is compositor scheduling, reprojection, CPU work, GPU fill, or resolution cost.

Build a small controlled comparison:

heavy scene versus light scene;
current settings versus lower maxStdDev;
current LoD budget versus reduced lodSplatScale or explicit XR lodSplatCount;
current framebuffer resolution versus reduced XR framebuffer scale;
foveation disabled versus a conservative XR foveation value;
desktop rendering versus immersive rendering.
Each comparison should report callback FPS, frame time, framebuffer dimensions, active splat/LoD count, and visible quality impact.

Animation-loop and lifecycle audit

Confirm whether SparkXr expects to own any part of the XR loop. Three.js’s renderer.setAnimationLoop is normally the correct application render path, but do not accidentally create competing loops between SparkXr, Three.js, and the app.

Verify that:

the desktop animation path pauses or avoids duplicate rendering during immersive VR;
the XR loop is driven by setAnimationLoop and not by window requestAnimationFrame;
the callback receives the XR frame timing supplied by Three.js;
Spark’s preUpdate setting remains appropriate for WebXR;
session end always restores the desktop loop and UI state;
React unmount/remount cannot leave an active XR session or loop behind.
Deliverable

Make the smallest architecture-consistent implementation changes required to solve all three issues. Keep desktop behavior unchanged unless the change is explicitly required for XR correctness.

Before editing, state:

the confirmed owner of the duplicate button;
the confirmed source of the vertical offset;
the measured performance bottleneck or frame-pacing explanation.
After editing, validate with the project’s existing build/check commands and document the manual Quest 3 test matrix. Do not claim a performance improvement without before/after measurements.

Reference material

Spark 0.1 to 2.x migration guide
Spark basic XR example
SparkXr 2.2 source
SparkRenderer documentation
Spark performance tuning
Spark LoD documentation
Spark 2.0 features, including SparkXr
Three.js WebXRManager
Three.js setAnimationLoop
MDN XRSession
MDN XRReferenceSpace
MDN XRWebGLLayer
WebXR Device API specification
WebXR reference spaces
WebXR animation frames
WebXR layers and framebuffer scaling
The most important leads are the SparkXr.element lifecycle, the local-floor reference-space semantics combined with the app’s zero-height camera reset, and the absence of explicit XR framebuffer/LoD budget measurements.