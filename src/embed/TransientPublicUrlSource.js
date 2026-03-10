import { AssetSource } from '../storage/AssetSource.js';
import { createSourceId, SUPPORTED_MANIFEST_VERSIONS } from '../storage/types.js';
import { getSupportedExtensions } from '../formats/index.js';

const getExtension = (filename) => {
  const parts = String(filename || '').split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

const getFilename = (path) => {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || path;
};

const resolveUrl = (value, baseUrl) => {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return String(value);
  }
};

export const validatePublicUrlManifest = (manifest) => {
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest?.version)) {
    return {
      success: false,
      error: `Unsupported manifest version: ${manifest?.version}`,
    };
  }

  if (!Array.isArray(manifest?.assets)) {
    return { success: false, error: 'Manifest missing assets array.' };
  }

  return { success: true };
};

export class TransientPublicUrlSource extends AssetSource {
  constructor(config) {
    super(config);
    this._manifest = null;
    this._manifestBaseUrl = config.config.baseUrl || '';
  }

  getCapabilities() {
    return {
      canList: true,
      canStream: true,
      canReadMetadata: true,
      canReadPreviews: true,
      persistent: false,
      writable: false,
    };
  }

  async connect() {
    const { manifestUrl, manifest, baseUrl } = this.config.config;
    if (manifest) {
      const validation = validatePublicUrlManifest(manifest);
      if (!validation.success) {
        return validation;
      }

      this._manifest = manifest;
      this._manifestBaseUrl = baseUrl || '';
      if (manifest.name && !this.config.name) {
        this.name = manifest.name;
        this.config.name = manifest.name;
      }

      this._connected = true;
      return { success: true };
    }

    if (!manifestUrl) {
      return { success: false, error: 'No manifest URL configured.' };
    }

    const result = await this._fetchManifest(manifestUrl);
    if (!result.success) {
      return result;
    }

    this._connected = true;
    return { success: true };
  }

  async _fetchManifest(url) {
    try {
      const response = await fetch(url, { mode: 'cors', redirect: 'follow' });
      if (!response.ok) {
        return {
          success: false,
          error: `Manifest fetch failed: ${response.status} ${response.statusText}`,
        };
      }

      const manifest = await response.json();
      const validation = validatePublicUrlManifest(manifest);
      if (!validation.success) {
        return validation;
      }

      this._manifest = manifest;
      this._manifestBaseUrl = resolveUrl('./', url);
      if (manifest.name && !this.config.name) {
        this.name = manifest.name;
        this.config.name = manifest.name;
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || 'Failed to read manifest.' };
    }
  }

  async listAssets() {
    if (!this._connected || !this._manifest) {
      throw new Error('Source is not connected.');
    }

    const supportedExtensions = getSupportedExtensions();
    const assets = this._manifest.assets
      .filter((item) => supportedExtensions.includes(getExtension(item?.path || item?.name || '')))
      .map((item) => ({
        id: `${this.id}/${item.path}`,
        name: item.name || getFilename(item.path),
        path: item.path,
        sourceId: this.id,
        sourceType: this.type,
        size: item.size,
        preview: item.preview ? resolveUrl(item.preview, this._manifestBaseUrl) : null,
        previewSource: item.preview ? 'remote' : null,
        metadata: item.metadata ?? null,
        embedFileSettings: item.embedFileSettings ?? null,
        loaded: false,
      }));

    this._assets = assets;
    return assets;
  }

  getAssetUrl(path) {
    return resolveUrl(path, this._manifestBaseUrl);
  }

  async fetchAssetData(asset) {
    const response = await fetch(this.getAssetUrl(asset?.path));
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  }

  async fetchAssetStream(asset) {
    const response = await fetch(this.getAssetUrl(asset?.path));
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }
    return response.body;
  }

  async fetchPreview(asset) {
    if (asset?.preview && asset.previewSource === 'remote') {
      return asset.preview;
    }
    return null;
  }

  async fetchMetadata(asset) {
    if (!asset?.metadata) return null;
    if (typeof asset.metadata === 'string') {
      try {
        const response = await fetch(resolveUrl(asset.metadata, this._manifestBaseUrl));
        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    }
    return asset.metadata;
  }
}

export const createTransientPublicUrlSource = ({ manifestUrl, manifest, baseUrl, name, id } = {}) => {
  const config = {
    id: id || createSourceId('public-url'),
    type: 'public-url',
    name: name || '',
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: {
      manifestUrl: manifestUrl || '',
      manifest: manifest || null,
      baseUrl: baseUrl || '',
      assetPaths: [],
      customName: Boolean(name),
    },
  };

  return new TransientPublicUrlSource(config);
};