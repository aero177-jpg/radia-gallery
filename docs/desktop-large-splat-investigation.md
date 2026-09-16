# Desktop Large-Splat Crash Investigation

## Request

Find and fix the Windows Tauri desktop app crash when opening splat files larger than roughly 1 GB. The browser and installed PWA currently handle the same files correctly and must not regress.

## Confirmed behavior

- Windows file associations for `.ply` and `.sog` work.
- Explorer launch, single-instance forwarding, native drag/drop, and release console suppression work.
- Small splats open normally through the desktop app.
- Large splats crash during the UI status `Preparing splats...`.
- The same large files can also crash through the in-app picker, although it tolerates somewhat larger files than the Explorer/Tauri path.
- The crash occurs before the current asset finishes initialization. Neighbor preloads begin only afterward, so they are not the primary cause.

## Stack

- Frontend: Preact + Vite.
- Renderer: Three.js `0.180.0` and `@sparkjsdev/spark` `2.2.0`.
- Desktop wrapper: Tauri v2 on Windows/WebView2.
- Supported input formats: `.ply` and `.sog`.

## Relevant code

- `src/splatManager.js`: `createEntry()` controls file acquisition, metadata, and `SplatMesh` initialization.
- `src/formats/ply.js` and `src/formats/sog.js`: construct Spark `SplatMesh`.
- `src/desktopFileOpen.js`: converts native paths into lightweight File-like objects.
- `src/fileLoader.js`: activates assets and preloads neighbors only after a current entry succeeds.

## Current desktop-specific mitigation

Native Tauri files expose `openStream()`. In `createEntry()`, these files are supplied to Spark as:

```js
new SplatMesh({ stream, streamLength, fileType, fileName, lod, onProgress });
```

instead of Radia first performing:

```js
const bytes = new Uint8Array(await file.arrayBuffer());
new SplatMesh({ fileBytes: bytes, fileType, fileName, lod, onProgress });
```

For native files above 256 MiB, Radia also skips neighbor preloads. Browser/PWA `File` handling remains on the prior byte-buffer and metadata path.

## Result of mitigation

No observable improvement for the reported >1 GB failure. This rules out Radia's extra top-level `Uint8Array` as the sole or dominant source of the crash. It does not prove Spark streams all formats internally; Spark may still buffer/decode the entire stream.

## Evidence from Spark documentation

- `SplatMesh` supports `url`, `fileBytes`, and `stream` inputs.
- Runtime `lod: true` generates LoD in a background worker, potentially requiring substantial additional memory.
- Spark documents `.rad` as the recommended prebuilt LoD format for huge datasets.
- `new SplatMesh({ url: "scene-lod.rad", paged: true })` supports paged streaming. Chunked `.rad` files can be produced with `build-lod --rad-chunked`.
- Spark's desktop rendering guidance is roughly 1-5 million splats, with higher counts depending on hardware.

## Likely failure region

The crash is inside or below Spark's `await mesh.initialized` during parse/decode/packed-splat allocation and/or GPU upload. A 1 GB source PLY can expand to multiple large CPU buffers plus GPU textures. WebView2's renderer-process memory or GPU allocation limit may be reached even if system RAM is available.

## Investigation priorities

1. Inspect Spark 2.2.0 source for the `stream` constructor path for PLY and SOG. Determine whether it accumulates the whole stream before parse/decode and identify peak allocations.
2. Determine whether `.ply`/`.sog` can truly stream incrementally in Spark, or whether only paged `.rad` supports bounded memory.
3. Capture the actual desktop failure: WebView2 renderer crash/error, Windows Event Viewer entry, GPU/VRAM usage, source file size, and splat count. Distinguish renderer-process OOM from GPU device loss.
4. Verify whether runtime LoD is enabled in the failing session. It should be disabled for ML-Sharp splats, but standard splats may still enable it through debug settings.
5. Test a prebuilt `.rad`, then a chunked `.rad` with `paged: true`, from the same source dataset. This is Spark's documented large-scene path and may require adding `.rad`/`.radc` support to Radia and its Tauri file associations.
6. If full-file PLY/SOG loading is inherently required, provide a desktop conversion workflow to prebuild a paged RAD file rather than attempting to raise arbitrary process-memory limits.

## Constraints

- Keep browser and PWA behavior unchanged unless a separately tested, compatible improvement is proven.
- Do not revisit file association, drag/drop, or splash routing; each is confirmed working.
- Preserve the existing Preact/Three.js architecture.
- Avoid unsupported claims that `url` or `stream` loading is memory-bounded without source-level confirmation.

## Validation already completed

- `npm run build` passes.
- `npm run desktop:build` passes and produces the NSIS installer.
- Functional validation still needed: reproduce with the same >1 GB splat after each candidate renderer-path change.