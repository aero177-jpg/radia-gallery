# VR Live Test Playbook

## Start Here

Prepared 2026-09-14 from application source, Spark v2.2.0 source, Three.js r180 source, and renderer documentation. No headset was available during this investigation. The user previously observed approximately 30 FPS in heavy scenes and 50 FPS in lighter scenes using **headset performance tools, not the app FPS counter**. These observations are valid starting evidence, but their exact metric/runtime configuration has not been recorded.

Use alongside the acceptance criteria in [the original handoff](VR_OVERVIEW_HANDOFF.md). Corrections here supersede that document's historical implementation descriptions. This is a plain Markdown handoff: explicitly attach it to the chat. It is not an automatically loaded Copilot instruction.

Keep three separate passes/chats:
1. **Control and lifecycle:** validate the existing Part 1 changes; fix only a reproduced local failure.
2. **Initial viewpoint:** capture startup evidence, then test one placement correction.
3. **Performance:** establish comparable measurements, then change one variable at a time.

Read Start Here, Corrections, and only the selected pass. Search named symbols, then read their nearby implementation; line numbers drift. Do not dump whole files, dependencies, or all three investigations into each chat.

Application investigation stays under `src/`. These handoff files and package scripts needed for checks are explicit exceptions. Do not inspect assets, generated output, storage internals, or slideshow implementations unless an observed failure requires that dependency. Discuss scope before installing dependencies, converting assets, or broadening loading behavior for a benchmark.

Preserve UI, desktop behavior, saved asset settings, and physical tracking. Instrumentation can precede proof; a behavioral fix needs a local hypothesis and a check that can disprove it. Never label a mocked test as a Quest test. No performance improvement has been established by this investigation.

At each pass boundary record files changed, exact checks/results, unknowns, and the next single action in Results. Start a fresh chat for the next pass.

## Corrections

| Earlier assumption | Source-backed correction |
| --- | --- |
| The app calls `xr.enter()` / uses `sessionMode` | Current `enterVrSession` calls a detached button's `click()`. Spark 2.2 uses `mode: "vr"` and `toggleXr()`. Do not invent an `enter()` API. |
| Modern SparkRenderer means LoD is active | Both [PLY](../src/formats/ply.js) and [SOG](../src/formats/sog.js) `loadData` constructors omit `lod: true`. No tree creation was found in these paths. Verify loaded data before assuming LoD controls work. |
| VR always gets a smaller automatic LoD budget | Spark `defaultSplatTarget()` uses device heuristics. `isOculus()` requires `navigator.xr` AND an `Oculus` user-agent substring. A Windows browser streaming to Quest can get the 2.5M desktop target, IF LoD is active. |
| No explicit resolution/foveation options means full resolution/no foveation | SparkXr defaults `frameBufferScaleFactor` to **0.5**. Three.js r180 defaults requested foveation to **1.0**. Effective dimensions/support still need measurement. |
| Need to lower the initial splat extent for VR | [Viewer](../src/viewer.js) constructs Spark with `Math.sqrt(5)` already, then applies store quality. Log the actual value; the constructor value can be overridden. |
| Need to force `preUpdate = false` for XR | Spark computes `spark.preUpdate && !renderer.xr.isPresenting`; XR updates are already deferred. A property value of `true` does not prove pre-render work in XR. |
| Every VR entry resets the camera to origin/Y=0 | `prepareVrCameraStart` has two branches. Only metadata-present/non-custom flattens Y; both move the camera backward and orient it. Three.js then replaces the unparented camera's pose. |
| App FPS might explain the reported 30/50 | User explicitly ruled this out: those numbers come from headset tools. Do not pursue stale app FPS as their explanation. Supplement headset telemetry with XR callback/draw timing and identify what each metric counts. |
| A scheduled desktop RAF proves duplicate draws | Desktop RAF still reschedules but normally returns before controls/draw while suspended. Count draws before alleging duplicate rendering. |

These are source facts, not a measured explanation of the symptoms. Package declarations previously read were Spark `^2.2.0` and Three `^0.180.0`; confirm resolved versions in the live environment before relying on private fields or exact defaults. Do not upgrade packages as part of testing.

## Part 1: Control And Lifecycle

### Implemented, Not Hardware-Verified

- [VR module](../src/vrMode.js): `initializeVrSupport` supplies `element: document.createElement("button")` and never attaches it. `vrInitializationPromise` shares initialization. `vrLifecycleVersion` rejects stale readiness/session callbacks. `disposeVrSupport` handles teardown.
- [App](../src/components/App.jsx): viewer effect cleanup disposes VR support and suspends desktop rendering.
- [Bottom controls](../src/components/BottomControls.jsx): `handleHardResetView` awaits VR disposal before replacing the renderer.
- [Embed app](../src/components/EmbedApp.jsx) did not call `initVrSupport` in the inspected lifecycle. Do not add VR to embed merely to test removal of a generated button.

Spark creates its default button asynchronously and appends it to `document.body`. `updateElement()` clears `display` and removes `hidden`, including on session end. In tagged 2.2.0, `button: false` still takes the create-button path. Supplying a detached `element` avoids that path while preserving support detection and its click listener.

Prior terminal-only mocked checks passed concurrent/delayed readiness, entry/exit/re-entry, active cleanup, stale callbacks, renderer replacement, and unsupported XR. The harness was not saved as a repository test and did not execute Three.js or a compositor. Editor diagnostics were clear. `npm run build` failed because `vite` was unavailable; another syntax check was skipped. Do not claim a successful build.

### Live Sequence

1. Use the existing dev setup in a secure context. Run `npm run build` when dependencies are available. The current `npm test` is a failure placeholder, not a test suite.
2. Verify only the intended app control appears. Enter, exit, and re-enter; check errors, actual session presence and store state each time.
3. Repeat after hard reset. Confirm one session, one XR callback stream, and no generated button. Test unmount/remount in development without changing architecture.
4. Check unsupported XR and embed: no generated control, and no new embed feature expected.

### Residual Risks

- `enterVrSession` returns `true` after `button.click()`, not after `requestSession` succeeds. Use `sessionstart`/`getSession()` to confirm entry. Test rapid double-clicks and denied/cancelled entry; if reproduced, serialize pending entry while preserving the user gesture. Do not request VR from a timer.
- `disposeVrSupport` clears app state/listeners before `session.end()` resolves. Test rejection and teardown during pending entry. A failed end must not leave an invisible active session. Mock checks do not establish real event ordering.
- `startRenderLoop` is not idempotent and keeps no cancellation handle. Remount/repeated starts can leave multiple desktop RAF chains, although suspension normally prevents their XR-time draws. Fix loop ownership only if counters confirm this path.
- Spark catches initialization errors internally; some failures may leave the app's `onReady` promise unresolved. Check real errors before treating this as unsupported XR.

Stop when the pass checks pass or a concrete hardware action is identified. Do not mix placement/quality changes into this pass.

## Part 2: Initial Viewpoint

### Confirmed Path

Read [VR module](../src/vrMode.js): `enterVrSession`, `handleSessionStart`, `establishVrAssetBaseline`, `prepareVrCameraStart`, `tryApplySavedVrView`, `applyVrView`, `setupVrAnimationLoop`, `handleSessionEnd`. Read only `initViewer`'s camera setup in [viewer](../src/viewer.js).

The app creates a camera without a parent rig. Three.js r180 gets headset views before invoking the app callback. At render time, `updateCamera` uses the app camera's **parent** transform, not its ordinary position as an XR origin; `updateUserCamera` copies the XR result back into the app camera. Changing this unparented camera in `prepareVrCameraStart` therefore cannot establish a persistent XR starting location. This is a confirmed mechanism mismatch, but the magnitude/cause of the reported height error remains unmeasured.

`local-floor` supplies physical eye height above the estimated floor. Without alignment, that tracked pose need not equal the desktop camera position OR heading. Investigate full pose mismatch, not only Y.

Confounders to isolate:
- `establishVrAssetBaseline` multiplies custom-metadata model scale by `VR_BASELINE_SCALE = 0.25`; others use 1. This changes model-relative center/distance. Do not remove it without considering saved VR views.
- `applyVrView` can change model position, quaternion and scale after the baseline. It overwrites some `initialModel*` fields, which therefore are not immutable pre-entry snapshots.
- Exit calls `restoreHomeView()`, not exact pre-entry camera restoration. Separate this legacy behavior from the desired new entry behavior.
- `setReferenceSpaceType("local-floor")` in `handleSessionStart` is too late to select that session's space. Spark already requests the type during initialization. Offsets use `setReferenceSpace`, not `setReferenceSpaceType`.

### First Edit: Diagnostics Only

Add a debug-gated one-shot capture, no pose changes or per-frame console output. Serialize scalar/array copies; live objects shown in DevTools can mutate after logging.

1. Immediately before `button.click()`, snapshot camera world/local position/quaternion, parent world matrix, controls target, and mesh world matrix/scale. Keep this snapshot immutable.
2. After baseline/saved-view application, capture mesh transform, `metadataMissing`, `customMetadataAvailable`, asset identifier, and whether a saved VR view applied. Do not export credentials or asset URLs.
3. In the first callback with a non-null `xrFrame.getViewerPose(renderer.xr.getReferenceSpace())`, copy head position/orientation/matrix and `emulatedPosition`. Record reference-space identity and configured type; there is no standard reference-space `.type` getter.
4. Capture `renderer.xr.getCamera()` position/matrix and per-eye matrices/viewports before AND after the existing render. Three.js updates world/union-camera state during rendering. The ArrayCamera can represent an eye/union projection, not exactly the center head pose.
5. Compute local splat bounds once after loading with `getBoundingBox()`, then clone/apply `mesh.matrixWorld` for world bounds. Do not scan millions of splats in the XR callback. Default bounds use centers only; label that limitation and handle empty/unavailable bounds.

**Discriminating check:** compare desired desktop pose to raw tracked pose and compare mesh transforms before/after baseline. If only Y differs, translation is enough. If heading or X/Z differs, test rigid alignment. If only custom-metadata/saved-view scenes fail, isolate their model transforms before adjusting the global origin.

### Candidate: One-Time Offset Reference Space

Use after diagnosis. It preserves current scene/controller/hand ownership. A camera/controller rig is a valid alternative but requires consistent parenting of tracked objects; do not apply both approaches.

Let `headStart` be the first head-to-base-reference transform and `desiredStart` the intended head-to-world transform. For column-vector matrix composition:

```text
worldFromBase = desiredStart * inverse(headStart)
offsetOrigin  = inverse(worldFromBase) = headStart * inverse(desiredStart)
newSpace     = baseSpace.getOffsetReferenceSpace(XRRigidTransform(offsetOrigin))
poseInWorld  = inverse(offsetOrigin) * rawHeadPose
```

Convert the rigid matrix to position and normalized quaternion with Three.js, then pass those to `new XRRigidTransform(position, quaternion)`. Never include model scale.

**Sign test:** raw head `(0, 1.6, 0)`, desired `(0, 0, 0)`, identity rotations: offset origin is `(0, +1.6, 0)`. New head pose is zero; physical height 1.7 then becomes virtual Y=0.1. A -1.6 offset doubles the error. Also test nonzero X/Z and 90-degree heading to catch multiplication-order mistakes.

Implementation constraints:
- Capture base reference space once per session, wait for a valid pose, calculate once, and call `renderer.xr.setReferenceSpace(newSpace)`. Never accumulate offsets each frame or recenter automatically on every asset change.
- Three.js has already consumed the old pose before the app callback. After setting the offset, skip that callback's draw/input processing; let the NEXT frame update eyes/controllers together. Do not manually overwrite XR camera matrices to conceal that transition.
- Keep automatic XR camera updates enabled. No second loop, per-frame model repositioning, or per-frame `lookAt`.
- Rigid mapping preserves movement lengths: 1 physical meter remains 1 world unit. It does not fix independently incorrect model scale.
- Retain the original `local-floor` tracking space, but document where its physical floor maps in virtual coordinates. An offset space need not retain physical floor at virtual Y=0.
- **Orientation decision:** full rigid alignment matches desktop orientation but can tilt the virtual floor when pitch/roll differ. Yaw-only alignment plus initial eye translation preserves gravity alignment but cannot exactly reproduce an arbitrarily pitched desktop view. Ask which behavior is wanted if this conflict occurs; favor gravity alignment for comfort rather than silently tilting the world.
- Clear base/offset/snapshot state on exit, failed entry and disposal; re-entry takes a fresh snapshot. Handle a runtime reference-space `reset` as a distinct observed case, not a reason for continuous recentering.
- Exact desktop restoration, if required, needs separate camera/controls/model snapshots; saved VR views mutate `initialModel*`. Do not persist diagnostic origin offsets into model settings.

### Acceptance

Test ordinary metadata, custom metadata, missing metadata, and saved VR views. Enter from a recognizable desktop view; turn left/right and translate sideways/up/down; exit and re-enter with a different physical heading. Confirm intended height/direction, no unexpected roll/scale, aligned hands/controllers, working grab/reset, and expected desktop restoration. Test SteamVR and VDXR as separate active-runtime configurations, not as though both are simultaneously active.

## Part 3: Performance

### Establish The Environment

The reported FPS comes from headset tools. Ask only for the tool/overlay name and displayed metric label: application FPS, compositor/display FPS, or another rate. Preserve those readings in every comparison. XR callback timing is complementary, not a replacement or a claim that the reported readings were wrong.

Record browser/version, resolved Spark/Three versions, PC GPU, headset refresh setting, active OpenXR runtime, and Virtual Desktop resolution/quality/reprojection settings. Native Quest Browser and Windows-browser PCVR use different rendering hardware and device detection. Generic native-Quest budgets are not automatically appropriate PCVR limits.

Start with [viewer](../src/viewer.js) `startRenderLoop`, `applySparkMaxStdDev`, Spark construction; [VR module](../src/vrMode.js) `setupVrAnimationLoop`; and the two format `loadData` functions above. The old handoff's claim that `splatManager` owns quality overrides is stale.

### Instrumentation Contract

Add a debug-only bounded collector to the EXISTING XR callback, publish once per second, reset on session/visibility changes. No additional loop, per-frame console spam, or serialization of entire meshes.

| Measurement | Source and interpretation |
| --- | --- |
| Headset telemetry | Preserve overlay name, exact metric, FPS, reprojection/dropped-frame indicators and CPU/GPU times if supplied. Unavailable fields stay unavailable. |
| Callback FPS | From callback `time`: `(sampleCount - 1) * 1000 / (lastTime - firstTime)` over a window. Report median/p95 successive intervals separately. |
| CPU callback/render time | `performance.now()` around input processing and the existing `renderer.render(scene, camera)`. Synchronous wall time, NOT GPU time or all deferred Spark work. |
| Refresh/visibility | `session.frameRate ?? null`, `Array.from(session.supportedFrameRates ?? [])`, `session.visibilityState`, `renderer.xr.isPresenting`. Missing is not zero FPS. |
| XR dimensions | `renderer.xr.getBaseLayer()` can return `XRWebGLLayer` OR `XRProjectionLayer`. Log `framebufferWidth/Height` or `textureWidth/Height/textureArrayLength`, plus per-eye viewports. `session.renderState.baseLayer` may be null with Layers API. |
| Resolution request | Log configured Spark `frameBufferScaleFactor` or Three `setFramebufferScaleFactor` value. Three r180 has no public scale getter. Keep requested and observed dimensions separate. |
| Foveation | Log `renderer.xr.getFoveation()` AND layer `fixedFoveation`. Requested value is not proof of effective support. Preserve unavailable/null. |
| Active splats | Version-check `spark.activeSplats` (latest completed sort result). Optionally log `spark.display.numSplats` (accumulated, not necessarily visible count). Original file count is not rendered count. |
| Per-mesh LoD | Inspect `mesh.packedSplats?.lodSplats`, `mesh.extSplats?.lodSplats`, `mesh.paged`, `mesh.enableLod`, and `spark.lodInstances.get(mesh)?.numSplats`. For this nonpaged path, `mesh.context.enableLod.value` indicates actual LoD-index use. Feature-check private fields. |
| LoD budget | Log `spark.lodSplatCount`, `lodSplatScale`, `lodRenderScale`, `enableLod`, `enableDriveLod`. Undefined explicit budget means platform fallback, not unlimited or disabled. |
| Deferred work | XR `onBeforeRender` schedules `updateInternal` through a timer. Use a short browser performance trace including workers for updates, traversal, sort/readback and uploads. `lastTraverseTime` is elapsed traversal round-trip, not CPU execution; `lastSortTime` is not sort duration. |

GPU timing: feature-detect WebGL2 `EXT_disjoint_timer_query_webgl2`. Enclose the intended draw region, allow at most one active query of that target, poll availability on later frames, and discard disjoint results. Never use `gl.finish()` or block for results. Draw-region timing excludes deferred Spark GPU passes and compositor/streaming work unless separately instrumented. If unsupported, report unavailable and use resolution sensitivity plus runtime telemetry, not Windows utilization as a substitute.

Count desktop draws during XR before changing loops. The main RAF remains scheduled but suspended; its FPS cap is not in the XR callback. Inspect other rendering entry points only if counters reveal unexpected work. The app's desktop FPS counter stops updating while suspended, but this is NOT the source of the user's readings.

### Highest-Value Experiment: LoD Availability

The PLY/SOG loaders omit the documented `lod: true` opt-in. Spark's nonpaged LoD path needs generated/prebuilt data AND selected indices. Enabling the renderer flag or lowering its budget cannot create a missing tree.

1. Inspect LoD fields after `mesh.initialized` and several XR frames. Missing data/indices is the first explanation to test for ineffective LoD controls.
2. If absent, test one representative asset with `lod: true` in the existing format constructor. This is a controlled loading experiment, NOT permission to enable it globally. Reload the asset; a renderer flag alone is insufficient.
3. Record preprocessing duration, memory/loading impact, selected count and quality. The Spark guide estimates seconds per million splats; do not promise instant entry or generate trees inside an XR callback.
4. Production opt-in/lazy LoD requires a separate decision about desktop output, original data, preload/cache behavior and failure fallback. Do not introduce RAD conversion or storage changes during live testing.
5. If LoD is active on Windows, try a lower explicit XR budget or `lodSplatScale`. The Oculus user-agent heuristic may retain the desktop target. Restore exact prior values on exit/disposal, including undefined `lodSplatCount`.

### Controlled Comparison

Use the same view/runtime settings, no slideshow or loading during a sample. Warm up until loading/sorts settle, capture at least 10 seconds, compare baseline -> variant -> baseline for one heavy and one light scene. Match physical viewpoint; record pose differences if necessary.

| Variant | Single change | Caution |
| --- | --- | --- |
| Baseline | No changes | Record actual settings, headset telemetry and LoD availability. |
| Splat extent | Actual `maxStdDev` -> 2.0, then restore | `sqrt(5)` is already about 2.236; this is a modest change. |
| LoD budget | Halve current target with `lodSplatScale`, then restore | Needs trees/indices; wait for convergence and confirm count changes. |
| LoD screen size | `lodRenderScale` 1 -> 2 if baseline is 1 | Higher means coarser minimum screen detail, NOT lower framebuffer resolution. |
| Framebuffer | Configured 0.5 -> 0.35 for a new session | Exit and configure before entry. 0.75 would INCREASE resolution from Spark's 0.5 default. Verify dimensions changed. |
| Compositor foveation | 0 -> 0.5 -> restore actual baseline | Baseline may already request 1.0; lowering to 0.5 can increase cost. Unsupported is valid. |
| Desktop reference | Same scene/view with continuous motion | Desktop is demand-driven; idle FPS is not a throughput benchmark. Record differing dimensions. |

Every row needs headset-tool readings, callback FPS, interval median/p95, CPU callback/render median/p95, GPU draw time if available, refresh/visibility, layer dimensions, active/selected LoD counts, and user-reported quality impact. Never fill measurements with documented defaults.

### Decision Rules

- Budget changes but count does not: verify tree/indices, active driving renderer and asynchronous convergence. Stop lowering ineffective parameters.
- Smaller framebuffer reduces GPU time: resolution/fill is implicated. Unchanged FPS can still mean more headroom without crossing a compositor deadline.
- Reduced LoD count improves traversal/sort timings: update/sort work is implicated, possibly alongside draw cost. This alone does not prove CPU saturation.
- Stable intervals near integer multiples of the headset period suggest missed deadlines/reprojection, not proof. At 90 Hz the full deadline is about 11.1 ms; 45 Hz callbacks are about 22.2 ms. Correlate with the user's headset/runtime telemetry and visibility.
- Fast synchronous render does not exonerate Spark: deferred worker/readback/upload work, GPU cost and compositor scheduling are outside that measurement.
- Low Windows GPU utilization cannot select a bottleneck. Streaming/encoding/runtime pacing can limit delivery independently of app drawing.
- Tune Spark cone foveation only after LoD works. Defaults: `coneFov0=90`, `coneFov=120` degrees, `coneFoveate=0.4`, `behindFoveate=0.2`; mesh overrides can supersede them. These affect LoD selection, not compositor shading. Aggressive settings can cause delayed detail on head turns.
- `minPixelRadius`/`maxPixelRadius` control raster footprints, not total update/sort work. Do not disable `enableDriveLod` on the sole renderer as an optimization; it stops maintaining selection.

No arbitrary throttle, forced synchronous Spark update, XR camera rewrite, or global desktop downgrade. Keep `antialias: false`. Three.js handles `makeXRCompatible()` in `setSession` and manages XR layers/pixel ratio; desktop `setPixelRatio()` is not the XR resolution control.

## Results

Current status: Part 1 implementation remains present; `npm run build` now succeeds. Part 2 was hardware-tuned without diagnostic capture: a one-time offset reference space maps the first XR viewer pose to the desktop camera position/yaw, preserving `local-floor` tracking. The app now provides global persisted VR calibration controls for base height, horizontal offset, depth zoom, scale, and XR resolution. Calibration is applied before an incoming VR asset is revealed, so scene navigation no longer visibly snaps from its uncalibrated transform. Exact headset/runtime configuration and first-frame pose measurements are still unrecorded.

Part 3 live findings, reported from headset tools: increasing the XR resolution scale from the Spark default had little FPS impact; reducing splat size had some impact; looking away from the splat did not materially raise FPS; and the observed rate appears to track the total loaded splat count more than visible screen coverage. These findings make pure XR framebuffer fill-rate pressure unlikely as the dominant bottleneck, but do not distinguish Spark update/sort/accumulator work from runtime/compositor/streaming pacing. No application callback timing, layer dimensions, active-splat count, or GPU timing has yet been captured.

Tested and reverted: `SparkRenderer.clipXY` was set to `1.0` (from its documented `1.4` default) to aggressively reject splat centers outside the lateral frustum. The headset result showed no FPS change, so the application has returned to Spark's default `clipXY`. Near/far VR clip controls are ordinary camera depth planes and are unrelated to this Spark lateral clipping experiment.

Current production-affecting VR settings implementation: global calibration ranges are height/horizontal/depth `-3..+3` world units, logarithmic base scale `-6..+6` ($1/64x..64x$), and XR resolution `0.30x..1.00x`, applied on the next VR session. Scene-specific saved VR views remain separate from the global calibration. No performance improvement is claimed.

```text
Pass / date / revision:
Browser / resolved Spark / Three:
Native Quest Browser OR Windows-browser PCVR:
Headset tool / metric label / readings:
Active runtime / Virtual Desktop settings / refresh:
Asset type / metadata mode / saved VR view present:
Hypothesis / baseline evidence:
Single change / after evidence / visible result:
Passed / failed / unavailable checks:
Files changed / values restored:
Next one action:
```

Prompt for a fresh chat:

> Read Start Here and Corrections in `.github/VR_LIVE_TEST_PLAYBOOK.md`, then only Part [1, 2, or 3]. Check current code at its named symbols. Use my results below to choose one diagnostic or one fix with a discriminating check. Source facts are leads, not headset measurements. My VR FPS readings come from headset tools, not the app counter. Do not reopen the other parts. Ask only for missing information that changes the next action. End with an updated Results record.

## References

Prefer tagged source when docs and implementation differ; fetch only relevant symbols.

- [SparkXr v2.2.0](https://github.com/sparkjsdev/spark/blob/v2.2.0/src/SparkXr.ts): constructor, initializeXr, toggleXr, updateElement, createButton, implicit 0.5 scale.
- [Basic XR example v2.2.0](https://github.com/sparkjsdev/spark/blob/v2.2.0/examples/basic-xr/index.html): application-owned Three.js animation loop and camera parent frame. SparkXr itself does not install a competing render loop.
- [SparkRenderer v2.2.0](https://github.com/sparkjsdev/spark/blob/v2.2.0/src/SparkRenderer.ts): onBeforeRender, defaultSplatTarget, driveLod, activeSplats, lodInstances, lastTraverseTime.
- [Spark utilities v2.2.0](https://github.com/sparkjsdev/spark/blob/v2.2.0/src/utils.ts): isOculus, isVisionPro, isMobile.
- [SplatMesh v2.2.0](https://github.com/sparkjsdev/spark/blob/v2.2.0/src/SplatMesh.ts): constructor, data/indices selection, getBoundingBox.
- [Spark LoD guide](https://sparkjs.dev/docs/lod-getting-started/), [renderer controls](https://sparkjs.dev/docs/spark-renderer/), [performance guidance](https://sparkjs.dev/docs/performance/).
- [Three.js WebXRManager r180](https://github.com/mrdoob/three.js/blob/r180/src/renderers/webxr/WebXRManager.js): setSession, onAnimationFrame, updateCamera, updateUserCamera, setReferenceSpace, getBaseLayer, setFoveation.
- [MDN offset reference spaces](https://developer.mozilla.org/en-US/docs/Web/API/XRReferenceSpace/getOffsetReferenceSpace), [XRSession](https://developer.mozilla.org/en-US/docs/Web/API/XRSession), [XRWebGLLayer](https://developer.mozilla.org/en-US/docs/Web/API/XRWebGLLayer), [XRProjectionLayer](https://developer.mozilla.org/en-US/docs/Web/API/XRProjectionLayer).