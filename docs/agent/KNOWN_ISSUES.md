# Known issues and leads

Baseline: commit `7a7395b`, 2026-11-08.

## Confirmed directly

- `src/viewer.js` `initViewer`: `renderer.setPixelRatio(window.devicePixelRatio)` has no cap. Splat fill cost grows with the square of the ratio.
- `native-file` code is unreachable since Tauri was removed: nothing defines `openStream`, so `isNativeDesktopFile` and `useNativeStream` are always false. Left in place pending a decision on desktop builds.

## Stutter investigation (Intel UHD 630, 2026-11-08)

- Slow frames are GPU-bound. Render cycles run about 58 ms and sometimes double to about 116 ms. Turning off `spark.autoUpdate` or the composer changed nothing. Inference: fill cost dominates, so the lever is pixels and overdraw (render scale, `maxStdDev`).
- `computeMlSharpDepthFocus` costs about 250-290 ms on the main thread per activation (about 50k `getSplat`/`unpackSplat` calls). It is the 300-400 ms long task, but happens at opacity 0, so it adds blank time and not visible judder.
- Raising the `gl.getError` interval from 500 to 4000 ms did not change p95 (tested and reverted).
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
