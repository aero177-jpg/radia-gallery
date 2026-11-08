# Radia Gallery

Client-only Preact + Vite gaussian splat gallery. Three.js 0.180, `@sparkjsdev/spark` 2.2, GSAP, Zustand. JavaScript, not TypeScript.

The product is an illusion: camera tweens, CSS fades, and load ordering combine so that Apple SHARP splats read as a "living" photo slideshow. **Treat transition timing and order as behavior to preserve.** A correct-looking refactor that exposes a pop, a blank frame, or a loading gap is a regression.

**Performance target: low-power devices, meaning phones and laptops on integrated GPUs.** Optimize and measure for those first. Integrated-GPU numbers are the real baseline, not a limitation of the test machine.

## Terminology

Naming in the code is inconsistent because features were stacked over time. Do not infer behavior from a name alone; read the branch. Use the product term with the user.

| Product term | In code | Meaning |
|---|---|---|
| Image / SHARP mode | `isCustomModel === false` (camera intrinsics present) | Converted photos. The slideshow loads a new splat per slide. |
| Scene mode | `isCustomModel === true` (no `cameraMetadata.intrinsics`), set in `fileLoader.js` | Real scenes, non-SHARP splats. The camera is treated differently. |
| Keyframes | Custom views: `customViews`, `customMetadata`, view-instance assets (`isViewInstance`, `baseAssetId`, `viewId`) | Camera poses within one loaded scene. The "slideshow" moves between poses instead of loading splats. |
| Same-base navigation | `navigateWithinLoadedBaseAsset` | Moving between keyframes of one mesh. |
| Regular transition | `slideOutAnimation`, `slideInAnimation` (image mode, manual) | A new image transitions out and in, with ramped speed. |
| Slideshow | `slideshowController.js` | The same transition, triggered automatically. |
| Continuous mode | `slideshowContinuousMode`, `continuous-*` slide modes | Transition lasts the whole image session at constant speed, allowing larger movement. |
| Tradeoff | Slide-out into swap into slide-in, in `loadSplatFile` | The timed handoff between images. See "Image tradeoff" in ARCHITECTURE. Protect it. |
| Glow background | `.bg-image-container`, `backgroundManager.js` | The original image, blurred, behind the splat. |
| No setup yet | `metadataMissing` (no intrinsics and no custom views) | A full scene with no keyframes saved. |

When you find another misleading name or undocumented interaction, add it here or to `docs/agent/KNOWN_ISSUES.md`.

## Commands

- `npm ci`, then `npm run dev` (Vite, http://localhost:5173)
- `npm run build`, then `npm run test:regress` for transition regressions on the real GPU (see TESTING). No unit tests or linter.
- To check a build without touching the repo: `npx vite build --outDir <scratch dir> --emptyOutDir`

## Read before working

- [docs/agent/ARCHITECTURE.md](docs/agent/ARCHITECTURE.md): engine map, slide sequence, ownership, rewrite hazards
- [docs/agent/TESTING.md](docs/agent/TESTING.md): running demos and measuring in the browser
- [docs/agent/KNOWN_ISSUES.md](docs/agent/KNOWN_ISSUES.md): confirmed bugs, leads, stale docs
- [.github/AUTO_ORBIT_AUDIT.md](.github/AUTO_ORBIT_AUDIT.md): required before changing auto orbit, same-base navigation, or camera input
- [.github/VR_LIVE_TEST_PLAYBOOK.md](.github/VR_LIVE_TEST_PLAYBOOK.md): required before VR work. The user measures VR FPS with headset tools, not the in-app display.

## Working rules

- Measure before and after any performance change. Do not claim an improvement without numbers from the same scene, GPU, and viewport.
- After touching transitions, loading, or camera code, run a real slide advance in the browser. A passing build proves very little here.
- Every camera-writing path must cancel or respect the other camera owners (see ARCHITECTURE). There is no central arbiter.
- After every `await` in the load path, recheck `loadGeneration`.
- Durations are duplicated between `src/style.css` and `src/slideConfig.js`. Change both.
- Keep the embed build working (`embed.html`, `src/main-embed.jsx`, `src/components/EmbedApp.jsx`). It is a separate entry point.
- Never log, print, or commit credentials. R2 secrets can sit in plaintext in IndexedDB source configs.
- Large rewrites go in stages, on a branch, each stage verified in the browser. Commit or push only when asked.

## Delegation: use cheaper agents by default

The main session does design, integration, and final review. Hand off work whose result can be checked.

| Work | Agent and model |
|---|---|
| Locating code, listing call sites, summarizing one subsystem | `Explore`, `haiku` |
| Tracing behavior across modules, reviewing a diff, mapping coupling | `Explore`, `sonnet` |
| Mechanical edits with a precise spec (renames, moving code, UI wiring) | `general-purpose`, `sonnet` |
| Simple single-file changes with an exact spec | `general-purpose`, `haiku` |
| Engine design, timing-sensitive changes, race fixes, Spark/WebGL internals | Main session; `opus` only if a separate deep pass is needed |

- Give each agent the scope, expected output, a word limit, and "mark inference as inference".
- Run independent agents in parallel. Use `isolation: "worktree"` for parallel edits.
- Verify any agent claim yourself before basing a design or a bug fix on it, especially `haiku` claims about ordering or races.
- Do not delegate what one grep or one short read answers.
