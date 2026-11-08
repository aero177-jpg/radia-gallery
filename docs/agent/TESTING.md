# Browser testing

## Regression harness

- `npm run test:regress` runs 5 checks in a visible Edge window (about 1.5 minutes). Leave the machine idle while it runs, and do not edit `src/` during a run because hot reload invalidates it.
- Set `REGRESS_CHANNEL=chrome` to use Chrome. `REGRESS_UPDATE_BASELINE=1` rewrites the per-GPU baseline in `.cache/regress/`. `latest.json` there holds the last run.
- Demo downloads are cached in `.cache/regress/assets` after the first run.
- `REGRESS_PROFILE=1 npx playwright test --config tests/regress/playwright.config.mjs profile` attributes stalls.
- Validated by injecting three bugs (swap while visible, cache retention removed, instant glide). All were caught.
- Run-to-run noise is up to about 20% on forced-render fps. Only trust larger changes or repeated runs.
- Reading the numbers: `p50Ms` and `fps` count every rAF, including ticks with no render, so they flatter the result. Use `p95Ms`, `maxMs`, `over100Ms`, and `over250Ms`. Counting actual rendered frames is a known harness improvement.

## Run a demo

1. `npx vite --port 5173 --strictPort`, then open http://localhost:5173/ in Chrome.
2. On the landing page choose **Demo**, select collections, then **Open selected**.
3. Once installed in that browser profile, open directly: `/demo-street-travel` (19 ML-Sharp slides, about 1.18M splats) or `/demo-multiview-model` (6 custom views of one model, about 991k splats).

The landing page fades in over a few seconds, so an immediate screenshot is black. `?import=<bundle URL>` is reported to import a bundle but has not been tested. Cloud GPU can be mocked with `?debugCloudMock=1`, also untested.

## Inspect live engine state (dev server only)

Vite modules can be imported from the page, and they are the running instances:

```js
const v = await import('/src/viewer.js');
const { useStore } = await import('/src/store.js');
const fl = await import('/src/fileLoader.js');
v.currentMesh.numSplats; v.camera.position; useStore.getState().currentAssetIndex;
await fl.loadNextAsset();
```

## Measuring

- rAF rate alone measures nothing while idle because rendering is on demand. To measure render cost, call `v.requestRender()` every frame and count rAF.
- Wait for load to settle. Neighbour decoding collapsed rAF to about 2 fps for several seconds after a slide change.
- CPU time around `composer.render()` reads as about 0 ms because GPU work is asynchronous. Use frame rate.
- Check `document.visibilityState` and `document.hasFocus()`, and record the GPU from `WEBGL_debug_renderer_info`.

## Baseline (2026-11-08, commit 7a7395b)

Chrome on Intel UHD Graphics 630 (D3D11), 1178x787 canvas, pixel ratio 1, `default` quality, Street & Travel slide 2 (1,179,648 splats):

| Condition | Result |
|---|---|
| Idle after settling | 144 fps rAF, p50 7 ms |
| Forced render every frame | 17.7 fps, p50 72 ms, max 147 ms |
| During a slide change (harness) | 5-9 frames over 100 ms, longest 300-540 ms |

An integrated GPU is the intended target class (phones and laptops), so this is the baseline that matters. Only compare numbers from the same GPU. Not tested here: real VR, gyro or touch on a device.

Cover both modes in any regression check: Street & Travel exercises image (SHARP) mode, and Multiview Model exercises full scene mode with keyframes.
