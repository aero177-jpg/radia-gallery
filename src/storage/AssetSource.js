/**
 * Asset Source Interface
 * 
 * Abstract base class that all storage adapters must implement.
 * Provides a unified interface for the render queue and asset manager.
 */

/**
 * @typedef {import('./types.js').SourceConfig} SourceConfig
 * @typedef {import('./types.js').SourceCapabilities} SourceCapabilities
 * @typedef {import('./types.js').RemoteAssetDescriptor} RemoteAssetDescriptor
 */

/**
 * Abstract base class for asset sources.
 * Each storage adapter (local folder, URL, Supabase) extends this class.
 */
export class AssetSource {
  /**
   * @param {SourceConfig} config
   */
  constructor(config) {
    if (new.target === AssetSource) {
      throw new Error('AssetSource is abstract and cannot be instantiated directly');
    }
    this.config = config;
    this.id = config.id;
    this.type = config.type;
    this.name = config.name;
    this._connected = false;
    this._assets = [];
  }

  /**
   * Get capabilities of this source
   * @returns {SourceCapabilities}
   */
  getCapabilities() {
    throw new Error('getCapabilities() must be implemented by subclass');
  }

  /**
   * Validate and establish connection to the source.
   * For local folders, this verifies the handle is still valid.
   * For remote sources, this performs a HEAD/fetch test.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Check if the source is currently connected/accessible
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * List all available assets from this source.
   * @returns {Promise<RemoteAssetDescriptor[]>}
   */
  async listAssets() {
    throw new Error('listAssets() must be implemented by subclass');
  }

  /**
   * Get the cached asset list (without re-fetching)
   * @returns {RemoteAssetDescriptor[]}
   */
  getAssets() {
    return this._assets;
  }

  /**
   * Fetch asset data as ArrayBuffer or ReadableStream.
   * @param {RemoteAssetDescriptor} asset
   * @returns {Promise<ArrayBuffer | ReadableStream>}
   */
  async fetchAssetData(asset) {
    throw new Error('fetchAssetData() must be implemented by subclass');
  }

  /**
   * Fetch asset data as a Blob (for File-like usage).
   * Default implementation uses fetchAssetData().
   * @param {RemoteAssetDescriptor} asset
   * @returns {Promise<Blob>}
   */
  async fetchAssetBlob(asset) {
    const data = await this.fetchAssetData(asset);
    if (data instanceof ReadableStream) {
      const response = new Response(data);
      return response.blob();
    }
    return new Blob([data]);
  }

  /**
   * Fetch a File-like object for compatibility with existing loaders.
   * @param {RemoteAssetDescriptor} asset
   * @returns {Promise<File>}
   */
  async fetchAssetFile(asset) {
    const blob = await this.fetchAssetBlob(asset);
    return new File([blob], asset.name, { type: blob.type });
  }

  /**
   * Fetch preview image for an asset (if available).
   * Returns null if no preview is available.
   * @param {RemoteAssetDescriptor} asset
   * @returns {Promise<string | null>} Data URL or remote URL
   */
  async fetchPreview(asset) {
    // Default: no preview available from source
    return null;
  }

  /**
   * Fetch metadata for an asset (if available).
   * Returns null if no metadata is available.
   * @param {RemoteAssetDescriptor} asset
   * @returns {Promise<Object | null>}
   */
  async fetchMetadata(asset) {
    // Default: no metadata available from source
    return null;
  }

  /**
   * Get serializable config for persistence.
   * Subclasses should override to exclude non-serializable data.
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.config.id,
      type: this.config.type,
      name: this.config.name,
      createdAt: this.config.createdAt,
      lastAccessed: this.config.lastAccessed,
      isDefault: !!this.config.isDefault,
      config: this.config.config,
    };
  }

  /**
   * Disconnect and cleanup resources.
   */
  disconnect() {
    this._connected = false;
    this._assets = [];
  }
}


