# Known issues and leads

Baseline: commit `7a7395b`, 2026-11-08.

## Confirmed directly

- `src/viewer.js` `initViewer`: `renderer.setPixelRatio(window.devicePixelRatio)` has no cap. Splat fill cost grows with the square of the ratio.

## Stutter investigation (Intel UHD 630, 2026-11-08)

- Controlled glides are not rendered slower than manual drags: both run about 16 fps. Glides look worse because they move further and less evenly per frame: median 2-3 degrees and p95 about 13 degrees per rendered frame, against about 0.34 and 0.45 for a test drag. `SAME_BASE_GLIDE_MS` is a fixed 2000 ms regardless of distance. Disabling the blurred background made no difference.
- Render cost has a floor near 48 ms (about 21 fps) on 991k splats at DPR 1. Dropping to 50% resolution or lowering `maxStdDev` from 2.5 to 1.5 each reach it from 64 ms (about 16 fps), and combining them gains nothing, so the floor is not pixel fill. Inference: it scales with splat count. Turning off `spark.autoUpdate` or the composer changed nothing.
- `computeMlSharpDepthFocus` costs about 250-290 ms on the main thread per activation (about 50k `getSplat`/`unpackSplat` calls). It is the 300-400 ms long task, but happens at opacity 0, so it adds blank time and not visible judder.
- Image-mode playback: `gl.getError` at a 500 ms interval cost about 1.8 s of visible main-thread time per 24 s. Raising it to 4000 ms took visible p95 from about 120 ms to about 72 ms. Kept at 4000 ms: it does not affect transition timing, though auto-recovery after 3 consecutive GL errors now takes about 12 s instead of about 1.5 s. A still-scene forced-render test does not show this, so measure playback (`ab test` in `profile.spec.mjs`).
- Tested and reverted (see "Opacity experiment" below in this item): one visible freeze over 200 ms per advance, 700-1900 ms after the swap (400-700 ms in continuous, about 250 ms in non-continuous). During these windows the main thread runs almost no JavaScript (1801 of 1856 ms idle or native), so the block is outside JS. A Chrome trace shows the GPU process inside `DXGISwapChainImageBacking::Present` for the whole freeze. Each freeze follows about 285 ms after a `texStorage3D`/`texSubImage3D` of a 2048x576 texture (exactly 1,179,648 texels, the splat count), which happens right after the swap. Neighbours finish loading about 5 s earlier, so preloading readies CPU data while the GPU upload stays lazy until the mesh is first drawn. That correlation was misleading: uploading explicitly and waiting on a GPU fence while hidden changed nothing (tested and reverted). **Opacity experiment:** each freeze began about 7 ms after the viewer's opacity left exactly 0. Changing the hidden state to opacity 0.01 in `style.css` took measured visible freezes over 200 ms from 4 per 24 s to 0, with a visible max of about 120-175 ms. **The user then tested by eye and found playback just as choppy through all of continuous mode, so the opacity change was reverted; `style.css` uses opacity 0 again.** The freeze metric did not capture the choppiness the user sees, so do not treat it as a proxy for perceived smoothness. The glow background is ruled out (same freezes with it off). Starting neighbour preloads after the slide-in did not help and caused missed preloads in non-continuous mode (tested and reverted). Spark readback (`getBufferSubData`) is the largest remaining visible main-thread cost. `minSortIntervalMs` of 250 had no effect.
- Spark readback (`getBufferSubData`) cost 76-394 ms per transition; the source is Spark, not `src/`. Not yet explained.
- The roughly 1-2 fps seen once in the first manual run did not reproduce under the harness (Chrome extension driving vs Playwright, first-load conditions).
- The production build emits a 4.16 MB main-dependency chunk (`style-*.js`; 1.35 MB gzip).

## Reported by agents, verify first

- `retainOnlySplats` iterates only `cache`. An in-flight load for a dropped neighbour can still `cache.set` when it resolves, and superseded loads keep running.
- `batchPreview.js` never calls retain or reset, so batch runs can accumulate splats in memory.
- `batchPreview.js` compares `id === asset.id` while the loader uses `activeCacheKey`, which differs for view instances.
- `assetCache.js` has no size budget or LRU.
- Warmup and capture timing is counted in frames, so it depends on refresh rate.
- Hard-coded timers: 500 ms metadata panel, 400 ms slide-in cleanup, 1200 ms object URL revoke.
- `refreshSparkForCurrentView` runs on each neighbour preload.
- The immersive rAF loop re-arms while idle and allocates `Vector3`s per frame; the keyboard movement loop also allocates per step.
- The 60 FPS cap is a custom rAF throttle.
- `composer.render()` adds RenderPass and OutputPass cost on top of the splat render.

## Gaussian-Splat-Lite comparison (v1.7.0, source read only, 2026-11-08)

Apache-2.0, Spark-derived, needs Three >=0.187 (we use 0.180). Not run or measured here. Differences from Spark 2.2 and our loop, from source:

- Frame gate (`examples/viewer/frameGate.js`, demo code, not the library): one GPU frame in flight via `fenceSync`, and only the latest waiting draw is kept. `startRenderLoop` has no equivalent. Inference: a GPU backlog on integrated graphics would explain similar fps with worse feel. Its `MessageChannel` poll spins while the GPU is busy, so check battery cost before copying it.
- Sort input: Spark's `driveSort` reads depth back from the GPU for every sort (4 bytes per splat, the `getBufferSubData` cost above). GSL's WebGL path sends centers to the sort worker once and passes only the camera, so there is no readback.
- Allocation: Spark allocates a new `Uint32Array(maxSplats)` per sort. GSL swaps two reused buffers.
- Instancing: Spark draws one quad per instance. GSL batches 128 splats per instance. Inference: possibly related to the render floor that tracks splat count.
- Batched drawing A/B (`batched splat drawing` in `profile.spec.mjs`, 1.18M splats, Intel UHD 630, 1280x800): still-camera draw 60 ms with one quad per instance, 50 ms with 128 per instance, and 512 is no better. At 25% resolution, 60 ms becomes 33 ms. Continuous playback with the frame gate on: 13.4-14.3 fps became 17.8-19.2 fps. Sampled pixels were identical. Implemented in `src/splatBatching.js`, on by default with a Debug Settings toggle (not yet tested in VR, stereo, or on phones); it relies on Spark 2.2 shader text and disables itself if that changes.
- Sort without GPU readback A/B (`cpu depth sort against gpu readback` in `profile.spec.mjs`, same setup, 22 s runs, batching and gate on): worker distances match Spark's GPU values on all 1.18M splats (max relative difference 1.2e-7, no infinity mismatches once inactive means all scales zero, not opacity zero). Main-thread cost 1.1-1.8 s of `getBufferSubData` became 0.19-0.28 s of copying. Continuous worst frame 92-151 ms became 62-88 ms. fps unchanged within noise (17.0-18.6 and 18.0-19.9). A main-thread JS version cost more than the readback (3.5 s), so it must stay in a worker. Implemented in `src/splatCpuSort.js` and `src/splatDepth.worker.js`; falls back to readback in VR, above 4M splats, with LOD, modifiers, several visible meshes, or a worker failure.
- Backend: the GSL demo starts on native WebGPU, which projects and sorts on the GPU before each draw. The user found its WebGL mode runs even better on integrated graphics, so WebGPU is not the source of the smoothness.
- Frame gate A/B in our app (`?frameGate`, `frame gate on and off during playback` in `profile.spec.mjs`, Intel UHD 630, 1280x800, demo image collection, 3 s, two rounds): submit-to-GPU-done p50 about 295 ms off and 60 ms on; continuous rendered-frame interval p99 400-460 ms off and 83 ms on, stdev 50-57 ms off and 11 ms on; camera step p95/p50 about 4 off and 1.9 on; fps 15.6-15.9 off and 15.1 on. Non-continuous fps dropped from about 17 to about 14.4. The user confirmed by eye that it is much more even and responsive (Debug Settings toggle, now on by default). Our version polls the fence once per rAF, unlike the demo's `MessageChannel` poll. Harness caveat: `measureForcedRender` reads about 144 fps with the gate on because it counts rAF ticks, not renders, so its numbers mean nothing there. Its `sceneForcedRender.maxMs` baseline also fails intermittently on unmodified code (178-230 ms against 126 ms).
- Integration blockers: `EffectComposer`, GL error and context-loss handling, and stereo all assume `WebGLRenderer`. `vrMode.js` depends on Spark. Quality defaults differ (`focalAdjustment`, `preBlurAmount`, `minPixelRadius`), so image look needs checking.

## Large files

See `docs/desktop-large-splat-investigation.md`. Files over about 1 GB failed in the desktop wrapper. Spark's documented route for huge scenes is prebuilt paged `.rad`.

## Stale docs

- `.github/copilot-instructions.md` says TypeScript; the code is JavaScript.
- `.github/VR_OVERVIEW_HANDOFF.md` says React; the app is Preact with `preact` directly.
- `docs/desktop-large-splat-investigation.md` assumes Tauri, removed in commit `544fd8a`. Despite its name, `src/desktopFileOpen.js` is not a Tauri leftover: it is the live PWA `launchQueue` file handler.
- `README.md` lists only `.ply` and `.sog`, and uses "keyframed" without defining it against custom views.

## Misleading names

- `isCustomModel` means full scene mode (no SHARP intrinsics). It has nothing to do with a user-customized model.
- `customViews` and `customMetadata` are keyframes. The word "keyframe" does not appear in the source.
- `slideMode`, "slideshow", and "slide" cover both per-splat transitions and keyframe glides.
- `fillMode` is a deprecated projection flag, unrelated to full scene mode.
- `src/testSharpCloud.js` is the production Cloud GPU client, not a test.
