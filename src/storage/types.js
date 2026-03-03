/**
 * Storage Source Types & Interfaces
 * 
 * Defines the unified abstraction for all asset sources (local folders, URLs, Supabase).
 * Each adapter must implement the AssetSource interface to work with the render pipeline.
 */

/**
 * @typedef {'local-folder' | 'public-url' | 'supabase-storage' | 'app-storage' | 'r2-bucket'} SourceType
 */

/**
 * @typedef {Object} SourceCapabilities
 * @property {boolean} canList - Can enumerate available assets
 * @property {boolean} canStream - Supports streaming/range requests
 * @property {boolean} canReadMetadata - Can read colocated metadata files
 * @property {boolean} canReadPreviews - Can read colocated preview images
 * @property {boolean} persistent - Connection persists across sessions
 * @property {boolean} writable - Can write metadata back to source (future)
 */

/**
 * @typedef {Object} SourceConfig
 * @property {string} id - Unique identifier for this source
 * @property {SourceType} type - Type of storage source
 * @property {string} name - User-friendly display name
 * @property {number} createdAt - Timestamp when connection was created
 * @property {number} lastAccessed - Timestamp of last access
 * @property {boolean} [isDefault] - Marks the default collection to auto-load
 * @property {Object} config - Type-specific configuration
 */

/**
 * @typedef {Object} LocalFolderConfig
 * @property {FileSystemDirectoryHandle} [handle] - Persisted directory handle
 * @property {string} path - Display path (folder name)
 */

/**
 * @typedef {Object} PublicUrlConfig
 * @property {string} baseUrl - Base URL for assets
 * @property {string} [manifestUrl] - Optional manifest.json URL
 * @property {string[]} [assetPaths] - Direct list of asset paths (if no manifest)
 */

/**
 * @typedef {Object} SupabaseStorageConfig
 * @property {string} supabaseUrl - Supabase project URL
 * @property {string} anonKey - Supabase anon/public key
 * @property {string} bucket - Supabase Storage bucket name
 * @property {string} collectionId - Collection identifier under collections/{collectionId}
 * @property {string} [collectionName] - Display name for the collection
 * @property {boolean} hasManifest - Whether manifest.json exists
 */

/**
 * @typedef {Object} R2StorageConfig
 * @property {string} accountId - Cloudflare account ID
 * @property {string} accessKeyId - R2 access key ID
 * @property {string} secretAccessKey - R2 secret access key
 * @property {string} endpoint - Account endpoint for R2 API (not public URL)
 * @property {string} bucket - R2 bucket name
 * @property {string} collectionId - Collection identifier under collections/{collectionId}
 * @property {string} [collectionName] - Display name for the collection
 * @property {boolean} hasManifest - Whether manifest.json exists
 * @property {{ canRead: boolean, canWrite: boolean, canDelete: boolean }} [permissions] - Capability flags detected from bucket policy/CORS
 */

/**
 * @typedef {Object} AppStorageConfig
 * @property {string} collectionId - Collection identifier stored in app storage
 * @property {string} [collectionName] - Display name for the collection
 */

/**
 * @typedef {Object} RemoteAssetDescriptor
 * @property {string} id - Unique identifier
 * @property {string} name - Display name (filename)
 * @property {string} path - Path relative to source root
 * @property {string} sourceId - ID of the parent source
 * @property {SourceType} sourceType - Type of the parent source
 * @property {number} [size] - File size in bytes (if known)
 * @property {string} [preview] - Preview image URL or data URL
 * @property {string} [previewSource] - 'remote' | 'indexeddb' | 'generated'
 * @property {Object} [metadata] - Colocated metadata (camera data, etc.)
 * @property {boolean} loaded - Whether asset has been loaded
 */

/**
 * @typedef {Object} AssetManifest
 * @property {number} version - Manifest schema version
 * @property {string} [name] - Collection name
 * @property {ManifestAsset[]} assets - List of assets
 */

/**
 * @typedef {Object} ManifestAsset
 * @property {string} path - Asset path relative to manifest
 * @property {string} [name] - Display name (defaults to filename)
 * @property {number} [size] - File size in bytes
 * @property {string} [preview] - Preview image path relative to manifest
 * @property {Object} [metadata] - Inline metadata or path to metadata file
 */

/**
 * Required Supabase layout (manifest-first):
 * {bucket}/
 * └── collections/{collectionId}/
 *     ├── manifest.json          // source of truth
 *     └── assets/
 *         ├── scene1.ply
 *         ├── scene1.preview.jpg // optional
 *         ├── scene1.meta.json   // optional
 *         └── ...
 *
 * manifest.json schema:
 * {
 *   "version": 1,
 *   "name": "My Collection",
 *   "assets": [
 *     {
 *       "path": "assets/scene1.ply",
 *       "name": "Scene 1",
 *       "size": 15000000,
 *       "preview": "assets/scene1.preview.jpg",
 *       "metadata": { ... } // or "metadata": "assets/scene1.meta.json"
 *     }
 *   ]
 * }
 */

// Validation constants
export const MANIFEST_VERSION = 1;
export const SUPPORTED_MANIFEST_VERSIONS = [1];

// Storage source tier labels for UI
export const SOURCE_TIERS = {
  'local-folder': {
    tier: 1,
    label: 'Local Folder',
    description: 'Select a folder from your device',
    benefits: ['Works offline', 'Fast loading', 'No setup required'],
    requirements: ['Browser must support File System Access API'],
    icon: 'folder',
  },
  'app-storage': {
    tier: 1,
    label: 'App Storage',
    description: 'Store inside app or browser for offline use',
    benefits: ['Runs fully offline', 'No re-authorization required', 'Private to the app'],
    requirements: [],
    icon: 'database',
  },
  'supabase-storage': {
    tier: 2,
    label: 'Supabase Storage',
    description: 'Cloud-hosted storage. User-friendly setup.',
    benefits: ['Cross-device via manifest.json', 'Uploads stay in your bucket', 'Free-tier friendly'],
    requirements: ['Supabase project URL', 'Anon/public key', 'Public bucket access'],
    icon: 'supabase',
  },
  'r2-bucket': {
    tier: 2,
    label: 'Cloudflare R2',
    description: 'Cloud-hosted storage. Heigher free tier limits.',
    benefits: ['Zero egress for reads', 'S3-compatible access'],
    requirements: ['Account ID', 'Access key ID/secret', 'Bucket name'],
    icon: 'cloudflare',
  },
  'public-url': {
    tier: 3,
    label: 'URL list',
    description: 'List of public asset URLs (read-only)',
    benefits: ['No setup', 'Works with any public file URL'],
    requirements: ['Direct HTTP/HTTPS links to .sog/.ply assets'],
    icon: 'link',
  },
  'cloud-gpu': {
    tier: 4,
    label: 'Cloud GPU',
    description: 'Configure a custom GPU conversion endpoint',
    benefits: ['Bring your own GPU endpoint', 'Convert images to splats'],
    requirements: ['API URL and API key'],
    icon: 'cloud-gpu',
  },
  'import-collections': {
    tier: 5,
    label: 'Import configs',
    description: 'Import collections, settings, and previews from a transfer bundle',
    benefits: ['Restore prior exports', 'Merge data into this browser'],
    requirements: ['A .zip bundle or JSON file exported from Transfer Data'],
    icon: 'upload',
  },
};

/**
 * Checks if File System Access API is supported
 * @returns {boolean}
 */
export const isFileSystemAccessSupported = () => {
  return 'showDirectoryPicker' in window;
};

/**
 * Creates a unique source ID
 * @param {SourceType} type
 * @returns {string}
 */
export const createSourceId = (type) => {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};
