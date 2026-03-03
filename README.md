# Radia Gallery

A browser-based viewer for 3D Gaussian Splat (3DGS) assets, focused on [ml-sharp](https://github.com/apple/ml-sharp) capture workflows. It reads ML-Sharp camera metadata to recreate the original photo perspective and provides tooling to tune camera and display settings for non-ML-Sharp assets.

## Use cases
- View ML-Sharp captures as photo-like scenes with depth and intended perspective
- Curate galleries of captures with smooth transitions and slideshows
- Manually tune camera, focus, and aspect for custom/non-ML-Sharp assets
- Access collections from local folders or cloud storage (Supabase/R2)
- Convert images to splats via an optional Cloud GPU endpoint 

## Key features
- ML-Sharp camera metadata parsing with accurate camera reconstruction
- Manual camera controls (FOV, focus distance, aspect ratio, and model scale)
- Preloaded asset navigation with transition animations and slideshow mode
- On-the-fly preview generation and caching
- Mobile-friendly with gesture support
- Immersive mode (device motion + touch pan) for parallax viewing
- WebXR VR mode and side-by-side stereo rendering
- Debug utilities: FPS overlay, performance, batch preview generation, and data bundle transfer (previews, storage connections, etc.)

## Supported formats
- .ply (3DGS)
- .sog (Web Optimized Gaussian)

## Storage sources
The viewer can load assets from multiple sources and keeps a unified gallery experience:

- Local Folder (File System Access API; Chromium-based browsers)
- App Storage (offline-first collections, available on mobile app builds)
- Public URL list (read-only)
- Supabase Storage (manifest-first collections)
- Cloudflare R2 (manifest-first collections)

### Supabase and R2 collection layout
Collections are manifest-first. A minimal layout looks like:

```
collections/{collectionId}/
    manifest.json
    assets/
        scene.sog
```

## Cloud GPU image conversion (optional)
The app can send image batches to a user-hosted GPU endpoint using our [preconfigured github action](https://github.com/aero177-jpg/ml-sharp-optimized) and write the resulting splats directly to Supabase or R2. This is optional and only required when using image-to-3DGS conversion from the UI.

## Development
Install dependencies and start the dev server:

1. npm install
2. npm run dev

Build and preview:

1. npm run build
2. npm run preview

## Storage Configuration

### Cloudflare R2
Retrieve the following from the [Cloudflare Dashboard](https://dash.cloudflare.com/):

* **Account ID**: Located on the **R2 > Overview** page in the right-hand sidebar.
* **Access Key ID & Secret Access Key**: 
    1. Navigate to **R2 > Overview > Manage R2 API Tokens**.
    2. Click **Create API Token** with **Admin Read & Write** permissions.
    3. Save the **Secret Access Key** immediately; it is not retrievable after closing the window.
* **Bucket Name**: The identifier of the target R2 bucket.
* **Public URL**: 
    1. Select the bucket and navigate to the **Settings** tab.
    2. Under **Public Access**, enable the **R2.dev Subdomain** or link a custom domain.
    3. Use the resulting URL (e.g., `https://pub-xxx.r2.dev`).

### Supabase
Retrieve the following from the [Supabase Dashboard](https://app.supabase.com/):

* **Project URL**: Located under **Project Settings > API**.
* **Anon/Public Key**: Located under **Project Settings > API > Project API keys**. 
* **Bucket Name**: The name of the bucket created in the **Storage** section. Ensure the bucket is set to "Public" if no custom authorization logic is implemented.

### Security Best Practices
* **Token Scoping**: Restrict R2 API tokens to specific buckets to limit exposure.
* **Key Restriction**: Use the Supabase `anon` key for client-side interactions. Never expose the `service_role` key in frontend configurations.
* **Logs**: Avoid logging raw credential strings to the console or cloud provider logs.

