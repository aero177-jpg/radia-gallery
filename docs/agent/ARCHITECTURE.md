# Architecture notes

Baseline: commit `7a7395b`, 2026-11-08. Line numbers drift, so search by symbol. Mostly from code-reading agents; items checked directly are in KNOWN_ISSUES.md. Re-verify before relying on a detail.

## Module map

| Area | Files |
|---|---|
| Renderer, loop, singletons | `src/viewer.js` |
| Viewer UI, input, keyboard movement | `src/components/Viewer.jsx`, `CameraControls.jsx` |
| Load and transition orchestration | `src/fileLoader.js` (largest logic file) |
| Splat cache and mesh creation | `src/splatManager.js`, `src/formats/` |
| Slideshow timing | `src/slideshowController.js`, `slideshowTransitionState.js`, `slideConfig.js` |
| Camera animation | `cameraAnimations.js`, `continuousAnimations.js`, `customAnimations.js`, `autoOrbit.js`, `cameraUtils.js` |
| Immersive (gyro) and VR | `immersiveMode.js`, `vrMode.js`, `components/VrOverlay.jsx` |
| State | `store.js` (Zustand, about 196 keys), `fileStorage.js`, `customMetadata.js` |
| Storage | `src/storage/` (`AssetSource` base; LocalFolder, PublicUrl, Supabase, R2, AppStorage) |
| Cloud GPU | `testSharpCloud.js`, `utils/modalEndpoints.js`, `components/CloudGpuForm.jsx`, `components/useCollectionUploadFlow.js` |
| Embed | `embed.html`, `main-embed.jsx`, `src/embed/`, `components/EmbedApp.jsx` |

## Render loop (`viewer.js`)

Module singletons: `scene`, `renderer`, `composer`, `camera`, `controls`, `spark`, `stereoCamera`, `currentMesh`, exported as live bindings and imported widely.

`startRenderLoop` is a self-rescheduling rAF and is render-on-demand through `requestRender()`. Per frame: re-arm, return if `document.hidden`, optional 60 FPS cap, return if `renderSuspended`, `controls.update()`, render if needed (`renderStereo()` or `composer.render()`, with GL fault recovery), `checkForGlErrors` (throttled).

Other rAF loops: keyboard movement in `Viewer.jsx`, immersive, auto orbit, reset/anchor/load animations, and GSAP's ticker.

## Slide sequence (uncached, non-continuous)

1. `slideshowController.advanceAndSchedule`, after the hold timer. A continuous same-base case may queue a handoff instead.
2. `fileLoader.loadNextAsset` sets `isNavigationLocked`. Same base goes to `navigateWithinLoadedBaseAsset` (camera glide, no reload).
3. `loadSplatFile` bumps `loadGeneration` and starts `ensureSplatEntry` without awaiting it.
4. `await Promise.all([slideOutAnimation, prepPromise])`. Out is 1400 ms (fade 650 ms); `.slide-out` is added at 70% of the duration.
5. Swap visibility, `setCurrentMesh`, `commitSlideshowTransition`.
6. `retainOnlySplats` keeps {current, prev, next}. The outgoing splat survives as prev and is disposed one advance later.
7. Neighbours load unawaited. Resolve view, apply custom transform.
8. Uncached path: `animateCameraMutation`, `refreshSparkForCurrentView({waitForIdle})`, then slide-in. Slide-in is 1000 ms (fade 750 ms).
9. Warmup rAF: 120 frames uncached, 15 cached; background and preview captures happen at fixed frame numbers.
10. The lock clears, and only then does the next hold timer start, so slow loads extend the cycle.

CSS opacity fades (`.viewer.slide-out` 0.3 s; `.slide-in` 0.6 s with 0.2 s delay) run alongside the JS tweens and are not synchronized with them.

## Image tradeoff: design intent (from the user)

The tradeoff is the handoff between two images. Fade-out and fade-in are timed against each other to minimize dead time between splats.

- The incoming splat loads, then fades in **mid-transition**, so the orbit hides splat edge artifacts.
- The glow background is the original image, blurred, behind the splat. It hides cracks in the splat.
- The glow is static while the splat rotates, so it has a deliberate timing offset: it should fade in when the frame is mostly filled by the final image, because orbiting reveals edges and empty space.
- Most problems appear in the ramped (non-continuous) transition, where much of the work is squeezed into a short window.

How that maps to code today:

- Regular slide tweens are eased: `power2.in` out, `power2.out` in. Continuous tweens use `ease: "none"` (constant speed); `power2.inOut` is only on their glide variants.
- Canvas fade-in is 0.6 s with 0.2 s delay; glow fade-in is 0.6 s with 0.3 s delay (`style.css`). The camera tween has its own 0.12 s delay in JS. These are separate clocks and are not synchronized.
- Neighbours: `collectNeighborAssets` picks prev and next (wrapping), and the cache keeps exactly {current, prev, next}. Preloading the newly needed neighbour starts unawaited right at the swap, just before slide-in, so it overlaps the visible fade-in.

## Camera ownership

No arbiter. Convention only: module handles, `cancelX()` calls, and `controls.enabled` toggles.

- Slide in/out (GSAP): `cameraAnimations.js`
- Reset and anchor (rAF): `cameraAnimations.js`
- Continuous zoom, dolly, orbit, vertical orbit (GSAP, with handoff queue): `continuousAnimations.js`
- Load zoom (rAF): `customAnimations.js`
- Auto orbit (rAF, `transitionActive` lock, `manuallyPaused` latch): `autoOrbit.js`
- Slideshow glide (GSAP): `slideshowController.js`
- Immersive: writes camera directly
- VR: moves `currentMesh`, not the camera

## Modes and terms

- Full glossary is in `CLAUDE.md`. The two modes are confirmed by the user: image (SHARP) mode loads a new splat per slide; scene mode (`isCustomModel`) loads camera poses within one scene.
- Keyframes are custom views: assets with `isViewInstance`, `baseAssetId`, `viewId`, sharing one mesh. Per-view settings are stored as `viewCustomAnimations[viewId]`.
- Mobile: `min(innerWidth, innerHeight) <= 768`; defaults to the performance preset; portrait uses `MobileSheet`.
- VR: `handleSessionStart` suspends the normal loop and uses `renderer.setAnimationLoop`, calling `renderer.render` directly and bypassing the composer.
- Stereo: two scissored viewports.

## Storage and persistence

- IndexedDB: `radia-gallery-sources`, `radia-gallery-storage`, `radia-gallery-asset-cache`.
- localStorage: UI prefs, R2/Supabase/Cloud GPU settings, vault metadata.
- Collections are manifest-first on Supabase/R2. `/<slug>` routes only match sources already registered in that browser.
- Vault: PBKDF2 with AES-GCM, optional. Without it R2 secrets are plaintext in source config.
- Cloud GPU: `https://<username>--ml-sharp-optimized-api.modal.run/<route>`, with `X-API-KEY`. `accessString` sends storage credentials to the GPU endpoint.

## Rewrite hazards

- Live-binding singletons imported by many modules; cycles patched with dynamic imports.
- Implicit camera ownership (above).
- `slideIn`/`slideOut` promises are awaited by the loader and slideshow, and CSS classes are tied to their timing.
- 2D and VR differ in pipeline (composer vs direct) and transform target (camera vs mesh).
- Engine hot paths call `useStore.getState()`.
- Per-file settings have legacy migration paths; generic writes must not erase orbit data.
