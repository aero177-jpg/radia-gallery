# Generated icons

Tauri icon derivatives in `src-tauri/icons/` are intentionally ignored. Before the first desktop build on a fresh checkout, regenerate them from the tracked source image:

```powershell
npx tauri icon public/radiaIcon_512.png
```
# Radia Desktop

This directory contains the Tauri v2 desktop wrapper for Radia. It preserves the
existing Vite web app and opens Windows-associated `.ply` and `.sog` files in the
current Radia window.

## Prerequisites

- Node.js and npm
- Rust installed through [rustup](https://rustup.rs/)
- Microsoft Visual Studio C++ Build Tools with the Desktop development with C++ workload
- WebView2 Runtime (already available on most current Windows systems)

## Commands

```powershell
npm run desktop:dev
npm run desktop:build
```

`desktop:build` creates Windows installer bundles. Install one of those bundles
to register Radia as an editor for `.ply` and `.sog` files. Windows can still ask
the user to confirm Radia as the default application for an extension.