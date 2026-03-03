/**
 * Public URL Source Adapter
 * 
 * Loads assets from any public HTTP endpoint.
 * Supports manifest.json for asset discovery or direct URL lists.
 */

import { AssetSource } from './AssetSource.js';
import { createSourceId, MANIFEST_VERSION, SUPPORTED_MANIFEST_VERSIONS } from './types.js';
import { saveSource } from './sourceManager.js';
import { getSupportedExtensions } from '../formats/index.js';

/**
 * Get file extension in lowercase with dot
 * @param {string} filename
 * @returns {string}
 */
const getExtension = (filename) => {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

/**
 * Get filename from path
 * @param {string} path
 * @returns {string}
 */
const getFilename = (path) => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

/**
 * Normalize URL by ensuring it has a trailing slash
 * @param {string} url
 * @returns {string}
 */
const normalizeBaseUrl = (url) => {
  return url.endsWith('/') ? url : `${url}/`;
};

/**
 * Join base URL with path
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
const joinUrl = (base, path) => {
  const normalizedBase = normalizeBaseUrl(base);
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return normalizedBase + normalizedPath;
};

/**
 * Public URL asset source.
 * Loads assets via HTTP fetch from any public endpoint.
 */
export class PublicUrlSource extends AssetSource {
  constructor(config) {
    super(config);
    this._manifest = null;
  }

  getCapabilities() {
    return {
      canList: !!this.config.config.manifestUrl || !!this.config.config.assetPaths?.length,
      canStream: true, // HTTP supports range requests
      canReadMetadata: false, // Simple URL source doesn't parse metadata
      canReadPreviews: !!this._manifest, // Only if manifest provides preview URLs
      persistent: true,
      writable: false,
    };
  }

  /**
   * Connect by validating the base URL is accessible.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async connect() {
    const { baseUrl, manifestUrl, assetPaths } = this.config.config;

    if (!baseUrl && !manifestUrl && (!assetPaths || assetPaths.length === 0)) {
      return { success: false, error: 'No URL configured' };
    }

    try {
      // If manifest URL is provided, try to fetch it
      if (manifestUrl) {
        const manifestResult = await this._fetchManifest(manifestUrl);
        if (!manifestResult.success) {
          return manifestResult;
        }
      } else if (baseUrl) {
        // Just validate base URL is accessible
        const response = await fetch(baseUrl, { method: 'HEAD' });
        if (!response.ok && response.status !== 405) {
          // 405 = Method Not Allowed (HEAD not supported, but URL exists)
          return { 
            success: false, 
            error: `URL not accessible: ${response.status} ${response.statusText}` 
          };
        }
      }

      // Validate we have some way to list assets
      if (!this._manifest && (!assetPaths || assetPaths.length === 0)) {
        return { 
          success: false, 
          error: 'No manifest or asset paths provided' 
        };
      }

      this._connected = true;
      await saveSource(this.toJSON());
      return { success: true };
    } catch (error) {
      if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
        return { 
          success: false, 
          error: 'Network error or CORS blocked. Ensure the URL allows cross-origin requests.' 
        };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetch and parse manifest.json
   * @param {string} url
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async _fetchManifest(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return { 
          success: false, 
          error: `Manifest fetch failed: ${response.status} ${response.statusText}` 
        };
      }

      const manifest = await response.json();

      // Validate manifest version
      if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
        return { 
          success: false, 
          error: `Unsupported manifest version: ${manifest.version}` 
        };
      }

      if (!manifest.assets || !Array.isArray(manifest.assets)) {
        return { success: false, error: 'Manifest missing assets array' };
      }

      this._manifest = manifest;
      
      // Update source name if manifest provides one
      if (manifest.name && !this.config.config.customName) {
        this.name = manifest.name;
        this.config.name = manifest.name;
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: `Manifest parse error: ${error.message}` };
    }
  }

  /**
   * List all available assets.
   * @returns {Promise<import('./types.js').RemoteAssetDescriptor[]>}
   */
  async listAssets() {
    if (!this._connected) {
      throw new Error('Not connected');
    }

    const supportedExtensions = getSupportedExtensions();
    const { baseUrl, assetPaths } = this.config.config;
    const assets = [];

    if (this._manifest) {
      // Use manifest assets
      for (const item of this._manifest.assets) {
        const ext = getExtension(item.path);
        if (!supportedExtensions.includes(ext)) continue;

        const asset = {
          id: `${this.id}/${item.path}`,
          name: item.name || getFilename(item.path),
          path: item.path,
          sourceId: this.id,
          sourceType: this.type,
          size: item.size,
          preview: item.preview ? joinUrl(baseUrl || '', item.preview) : null,
          previewSource: item.preview ? 'remote' : null,
          metadata: item.metadata,
          loaded: false,
        };
        assets.push(asset);
      }
    } else if (assetPaths && assetPaths.length > 0) {
      // Use direct asset paths
      for (const path of assetPaths) {
        const ext = getExtension(path);
        if (!supportedExtensions.includes(ext)) continue;

        const asset = {
          id: `${this.id}/${path}`,
          name: getFilename(path),
          path,
          sourceId: this.id,
          sourceType: this.type,
          preview: null,
          previewSource: null,
          loaded: false,
        };
        assets.push(asset);
      }
    }

    this._assets = assets;
    return assets;
  }

  /**
   * Get full URL for an asset path
   * @param {string} path
   * @returns {string}
   */
  getAssetUrl(path) {
    const { baseUrl } = this.config.config;
    if (!baseUrl) return path;
    return joinUrl(baseUrl, path);
  }

  /**
   * Fetch asset data as ArrayBuffer.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchAssetData(asset) {
    const url = this.getAssetUrl(asset.path);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  /**
   * Fetch asset as a streaming response (for large files).
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<ReadableStream>}
   */
  async fetchAssetStream(asset) {
    const url = this.getAssetUrl(asset.path);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }

    return response.body;
  }

  /**
   * Fetch preview image URL.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<string | null>}
   */
  async fetchPreview(asset) {
    // If asset has a remote preview URL, return it directly
    if (asset.preview && asset.previewSource === 'remote') {
      return asset.preview;
    }
    return null;
  }

  /**
   * Fetch metadata if provided in manifest.
   * @param {import('./types.js').RemoteAssetDescriptor} asset
   * @returns {Promise<Object | null>}
   */
  async fetchMetadata(asset) {
    if (asset.metadata) {
      // If metadata is a string, treat it as a URL
      if (typeof asset.metadata === 'string') {
        try {
          const url = this.getAssetUrl(asset.metadata);
          const response = await fetch(url);
          if (response.ok) {
            return response.json();
          }
        } catch (error) {
          console.warn(`Failed to fetch metadata for ${asset.name}:`, error);
        }
        return null;
      }
      // Otherwise return inline metadata
      return asset.metadata;
    }
    return null;
  }
}

/**
 * Create a new PublicUrlSource.
 * @param {Object} options
 * @param {string} [options.baseUrl] - Base URL for assets
 * @param {string} [options.manifestUrl] - Manifest.json URL
 * @param {string[]} [options.assetPaths] - Direct list of asset paths
 * @param {string} [options.name] - Custom display name
 * @param {string} [options.id] - Optional custom id (for defaults)
 * @returns {PublicUrlSource}
 */
export const createPublicUrlSource = ({ baseUrl, manifestUrl, assetPaths, name, id }) => {
  const sourceId = id || createSourceId('public-url');
  
  // Derive display name from URL if not provided
  let displayName = name;
  if (!displayName) {
    try {
      const url = new URL(baseUrl || manifestUrl || '');
      displayName = url.hostname;
    } catch {
      displayName = 'Public URL';
    }
  }

  const config = {
    id: sourceId,
    type: 'public-url',
    name: displayName,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: {
      baseUrl: baseUrl || '',
      manifestUrl: manifestUrl || '',
      assetPaths: assetPaths || [],
      customName: !!name,
    },
  };

  return new PublicUrlSource(config);
};

/**
 * Restore a PublicUrlSource from persisted config.
 * @param {Object} config
 * @returns {PublicUrlSource}
 */
export const restorePublicUrlSource = (config) => {
  return new PublicUrlSource(config);
};


