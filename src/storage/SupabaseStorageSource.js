/**
 * Supabase Storage Source Adapter
 *
 * Manifest-first storage for public Supabase buckets.
 * Layout (required):
 * {bucket}/collections/{collectionId}/manifest.json
 * {bucket}/collections/{collectionId}/assets/*
 *
 * - manifest.json is the source of truth
 * - Rescans are explicit (no implicit crawling)
 * - Uploads update manifest deterministically
 */

import { AssetSource } from './AssetSource.js';
import { createSourceId, MANIFEST_VERSION, SUPPORTED_MANIFEST_VERSIONS } from './types.js';
import { saveSource } from './sourceManager.js';
import { getSupportedExtensions } from '../formats/index.js';
import { loadSupabaseManifestCache, saveSupabaseManifestCache } from './supabaseSettings.js';
import { getSupabaseClient } from './supabaseClient.js';

const PREVIEW_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const METADATA_SUFFIXES = ['.meta.json', '.metadata.json'];

const getExtension = (filename) => {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

const getFilename = (path) => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

const getBaseName = (filename) => {
  const name = getFilename(filename);
  const lastDot = name.lastIndexOf('.');
  return lastDot > 0 ? name.slice(0, lastDot) : name;
};

const stripLeadingSlash = (value) => value.replace(/^\/+/, '');

const toRelativeFromBase = (fullPath, basePrefix) => {
  const normalized = stripLeadingSlash(fullPath);
  const base = stripLeadingSlash(basePrefix);
  if (normalized.startsWith(`${base}/`)) {
    return normalized.slice(base.length + 1);
  }
  return normalized;
};


export class SupabaseStorageSource extends AssetSource {
  constructor(config) {
    super(config);
    this._manifest = null;
  }

  _ensureClient() {
    return getSupabaseClient(this.config.config.supabaseUrl, this.config.config.anonKey);
  }

  _storage() {
    const client = this._ensureClient();
    return client.storage.from(this.config.config.bucket);
  }

  _basePrefix() {
    return `collections/${this.config.config.collectionId}`;
  }

  _assetPrefix() {
    return `${this._basePrefix()}/assets`;
  }

  _toStoragePath(relative) {
    return `${this._basePrefix()}/${stripLeadingSlash(relative)}`;
  }

  _publicUrlFor(relativePath) {
    const { data } = this._storage().getPublicUrl(this._toStoragePath(relativePath));
    return data?.publicUrl || '';
  }

  getCapabilities() {
    return {
      canList: true,
      canStream: true,
      canReadMetadata: true,
      canReadPreviews: true,
      persistent: true,
      writable: true,
    };
  }

  async connect(options = {}) {
    const normalized = typeof options === 'boolean'
      ? { refreshManifest: options }
      : options;

    const { refreshManifest = true, verifyUpload = false } = normalized;
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

    // Always try to load cached manifest first (cache-first strategy)
    if (refreshManifest || !this._manifest) {
      await this._loadManifest({ allowStale: true });
    }

    // If offline or we already have a manifest, skip network check
    if (isOffline) {
      if (this._manifest) {
        this._connected = true;
        await saveSource(this.toJSON());
        return { success: true, offline: true };
      }
      return { success: false, error: 'Offline and no cached manifest available', offline: true };
    }

    // Try network connectivity check, but fall back to cache on failure
    try {
      const storage = this._storage();
      const { error: listError } = await storage.list(this._basePrefix(), { limit: 1 });
      
      if (listError) {
        // Network error - if we have cached manifest, use it
        if (this._manifest) {
          console.log('[Supabase] Bucket check failed, using cached manifest');
          this._connected = true;
          await saveSource(this.toJSON());
          return { success: true, offline: true };
        }
        return { success: false, error: `Bucket access failed: ${listError.message}` };
      }

      // Online and connected - refresh manifest if needed
      if (refreshManifest) {
        await this._loadManifest({ bypassCache: false });
      }

      // Ensure manifest exists for this collection
      await this._ensureManifestLoaded();

      // Optionally verify upload permission early to avoid first-attempt failures
      if (verifyUpload) {
        const uploadCheck = await this.verifyUploadPermission();
        if (!uploadCheck.success) {
          return uploadCheck;
        }
      }

      this._connected = true;
      await saveSource(this.toJSON());
      return { success: true };
    } catch (error) {
      // Network error (e.g., ERR_NAME_NOT_RESOLVED) - fall back to cache
      if (this._manifest) {
        console.log('[Supabase] Network error, using cached manifest:', error.message);
        this._connected = true;
        await saveSource(this.toJSON());
        return { success: true, offline: true };
      }
      return { success: false, error: error.message };
    }
  }

  async _loadManifest({ bypassCache = false, allowStale = false } = {}) {
    const cacheKey = {
      supabaseUrl: this.config.config.supabaseUrl,
      bucket: this.config.config.bucket,
      collectionId: this.config.config.collectionId,
    };
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

    // Try cache first
    if (!bypassCache) {
      const cachedManifest = isOffline || allowStale
        ? loadSupabaseManifestCache(cacheKey, { maxAgeMs: -1 })
        : loadSupabaseManifestCache(cacheKey);
      if (cachedManifest) {
        this._manifest = cachedManifest;
        this.config.config.hasManifest = true;
        if (cachedManifest.name) {
          this.name = cachedManifest.name;
          this.config.name = cachedManifest.name;
        }
        return cachedManifest;
      }
    }

    // If offline and no cache, we can't fetch
    if (isOffline) {
      return null;
    }

    // Try to fetch from network
    try {
      const manifestPath = this._toStoragePath('manifest.json');
      const { data, error } = await this._storage().download(manifestPath);
      if (error) {
        if (this._manifest) {
          console.warn('[Supabase] Manifest fetch failed, using cached manifest:', error.message);
          return this._manifest;
        }
        this.config.config.hasManifest = false;
        this._manifest = null;
        return null;
      }

      const text = await data.text();
      const manifest = JSON.parse(text);

      if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
        throw new Error(`Unsupported manifest version: ${manifest.version}`);
      }

      this._manifest = manifest;
      this.config.config.hasManifest = true;
      saveSupabaseManifestCache(cacheKey, manifest);

      if (manifest.name) {
        this.name = manifest.name;
        this.config.name = manifest.name;
      }

      return manifest;
    } catch (error) {
      // Network error - keep any existing manifest
      console.warn('[Supabase] Failed to load manifest from network:', error.message);
      return this._manifest || null;
    }
  }

  async _saveManifest(manifest) {
    const payload = JSON.stringify(manifest, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const manifestPath = this._toStoragePath('manifest.json');
    const { error } = await this._storage().upload(manifestPath, blob, { upsert: true, contentType: 'application/json' });
    if (error) {
      throw new Error(`Failed to write manifest: ${error.message}`);
    }
    this._manifest = manifest;
    this.config.config.hasManifest = true;
    saveSupabaseManifestCache({
      supabaseUrl: this.config.config.supabaseUrl,
      bucket: this.config.config.bucket,
      collectionId: this.config.config.collectionId,
    }, manifest);
    await saveSource(this.toJSON());
  }

  async _ensureManifestLoaded() {
    if (!this._manifest && this.config.config.hasManifest !== false) {
      await this._loadManifest({ allowStale: true });
    }
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    // If still missing, create a minimal manifest for this collection (online only)
    if (!this._manifest && !isOffline) {
      const manifest = {
        version: MANIFEST_VERSION,
        name: this.config.config.collectionName || this.config.config.collectionId,
        assets: [],
      };
      await this._saveManifest(manifest);
    }
    return this._manifest;
  }

  async listAssets() {
    if (!this._connected) {
      throw new Error('Not connected');
    }

    await this._ensureManifestLoaded();
    const supportedExtensions = getSupportedExtensions();
    const assets = [];

    if (!this._manifest) {
      this._assets = [];
      return [];
    }

    for (const item of this._manifest.assets || []) {
      const ext = getExtension(item.path);
      if (!supportedExtensions.includes(ext)) continue;

      const asset = {
        id: `${this.id}/${item.path}`,
        name: item.name || getFilename(item.path),
        path: item.path,
        sourceId: this.id,
        sourceType: this.type,
        size: item.size,
        preview: item.preview ? this._publicUrlFor(item.preview) : null,
        previewSource: item.preview ? 'remote' : null,
        _metadataPath: typeof item.metadata === 'string' ? item.metadata : null,
        _inlineMetadata: typeof item.metadata === 'object' ? item.metadata : null,
        loaded: false,
      };
      assets.push(asset);
    }

    this._assets = assets;
    return assets;
  }

  async fetchAssetData(asset) {
    const url = this._publicUrlFor(asset.path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  }

  async fetchAssetStream(asset) {
    const url = this._publicUrlFor(asset.path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    }
    return response.body;
  }

  async fetchPreview(asset) {
    if (asset.preview) return asset.preview;
    return null;
  }

  async fetchMetadata(asset) {
    if (asset._inlineMetadata) {
      return asset._inlineMetadata;
    }

    if (asset._metadataPath) {
      const url = this._publicUrlFor(asset._metadataPath);
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    }

    return null;
  }

  async _walkFiles(prefix) {
    const storage = this._storage();
    const files = [];
    const pageSize = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await storage.list(prefix, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) {
        throw new Error(`List failed at ${prefix}: ${error.message}`);
      }
      if (!data || data.length === 0) {
        break;
      }

      for (const entry of data) {
        const fullPath = `${stripLeadingSlash(prefix)}/${entry.name}`;
        if (entry.metadata && typeof entry.metadata.size === 'number') {
          files.push(fullPath);
        } else {
          const nested = await this._walkFiles(fullPath);
          files.push(...nested);
        }
      }

      hasMore = data.length === pageSize;
      offset += pageSize;
    }

    return files;
  }

  _buildPreviewAndMetadataMaps(filePaths) {
    const previewByBase = new Map();
    const metadataByBase = new Map();

    for (const path of filePaths) {
      const relative = toRelativeFromBase(path, this._basePrefix());
      const ext = getExtension(relative);
      const base = getBaseName(relative);

      if (PREVIEW_EXTENSIONS.includes(ext)) {
        previewByBase.set(base.toLowerCase(), relative);
      }

      for (const suffix of METADATA_SUFFIXES) {
        if (relative.toLowerCase().endsWith(suffix)) {
          const baseKey = relative
            .toLowerCase()
            .replace(new RegExp(`${suffix.replace(/\./g, '\\.')}$`, 'i'), '')
            .split('/')
            .pop();
          metadataByBase.set(baseKey, relative);
        }
      }
    }

    return { previewByBase, metadataByBase };
  }

  async rescan({ applyChanges = false } = {}) {
    if (!this._connected) {
      const result = await this.connect({ refreshManifest: true });
      if (!result.success) return { success: false, error: result.error };
    }

    const storageFiles = await this._walkFiles(this._assetPrefix());
    const relativeFiles = storageFiles.map((path) => toRelativeFromBase(path, this._basePrefix()));
    const supportedExtensions = getSupportedExtensions();

    const assetPaths = relativeFiles.filter((path) => supportedExtensions.includes(getExtension(path)));
    const { previewByBase, metadataByBase } = this._buildPreviewAndMetadataMaps(storageFiles);

    const manifestAssets = this._manifest?.assets || [];
    const manifestPaths = new Set(manifestAssets.map((a) => a.path));

    const newPaths = assetPaths.filter((path) => !manifestPaths.has(path));
    const missingPaths = Array.from(manifestPaths).filter((path) => !assetPaths.includes(path));

    const additions = newPaths.map((path) => {
      const base = getBaseName(path).toLowerCase();
      const addition = {
        path,
        name: getFilename(path),
        preview: previewByBase.get(base) || null,
        metadata: metadataByBase.get(base) || null,
      };
      return addition;
    });

    if (applyChanges) {
      const nextManifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };
      const existingByPath = new Map(nextManifest.assets.map((a) => [a.path, a]));

      additions.forEach((item) => {
        if (!existingByPath.has(item.path)) {
          nextManifest.assets.push(item);
        }
      });

      await this._saveManifest(nextManifest);
      await this.listAssets();
    }

    return {
      success: true,
      added: additions,
      missing: missingPaths,
      hasManifest: !!this._manifest,
      totalFiles: assetPaths.length,
      applied: !!applyChanges,
    };
  }

  async uploadAssets(files) {
    if (!this._connected) {
      const result = await this.connect({ refreshManifest: true });
      if (!result.success) return { success: false, error: result.error };
    }

    await this._ensureManifestLoaded();
    const manifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };
    const supportedExtensions = getSupportedExtensions();
    const storage = this._storage();
    const results = { uploaded: [], failed: [] };
    const existingByPath = new Map(manifest.assets.map((a) => [a.path, a]));

    for (const file of files) {
      const ext = getExtension(file.name);
      const base = getBaseName(file.name).toLowerCase();

      if (!supportedExtensions.includes(ext) && !PREVIEW_EXTENSIONS.includes(ext) && !METADATA_SUFFIXES.some((suffix) => file.name.toLowerCase().endsWith(suffix))) {
        results.failed.push({ name: file.name, error: 'Unsupported file type' });
        continue;
      }

      const targetPath = `${this._assetPrefix()}/${file.name}`;
      const relative = toRelativeFromBase(targetPath, this._basePrefix());
      const { error } = await storage.upload(targetPath, file, {
        upsert: false,
        contentType: file.type || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      if (error) {
        results.failed.push({ name: file.name, error: error.message });
        continue;
      }

      if (supportedExtensions.includes(ext)) {
        if (!existingByPath.has(relative)) {
          manifest.assets.push({
            path: relative,
            name: file.name,
            size: file.size,
          });
          existingByPath.set(relative, manifest.assets[manifest.assets.length - 1]);
        }
      } else if (PREVIEW_EXTENSIONS.includes(ext)) {
        // Attach preview to matching asset if present
        for (const asset of manifest.assets) {
          if (getBaseName(asset.path).toLowerCase() === base) {
            asset.preview = relative;
          }
        }
      } else if (METADATA_SUFFIXES.some((suffix) => file.name.toLowerCase().endsWith(suffix))) {
        for (const asset of manifest.assets) {
          if (getBaseName(asset.path).toLowerCase() === base) {
            asset.metadata = relative;
          }
        }
      }

      results.uploaded.push({ name: file.name, path: relative });
    }

    await this._saveManifest(manifest);
    await this.listAssets();
    return { success: results.failed.length === 0, ...results };
  }

  async deleteAssets(items) {
    if (!this._connected) {
      const result = await this.connect({ refreshManifest: true });
      if (!result.success) return { success: false, error: result.error };
    }

    await this._ensureManifestLoaded();
    const manifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };

    const normalized = Array.isArray(items) ? items : [items];
    const targetPaths = new Set();
    const removedPaths = new Set();
    const failures = [];

    for (const item of normalized) {
      const rawPath = typeof item === 'string'
        ? item
        : item?.path || item?._remoteAsset?.path;

      if (!rawPath) {
        failures.push({ path: null, error: 'Missing path' });
        continue;
      }

      const relativePath = toRelativeFromBase(stripLeadingSlash(rawPath), this._basePrefix());
      removedPaths.add(relativePath);

      const manifestEntry = manifest.assets.find((a) => a.path === relativePath);
      if (manifestEntry?.preview) {
        targetPaths.add(this._toStoragePath(manifestEntry.preview));
      }
      if (manifestEntry?.metadata) {
        targetPaths.add(this._toStoragePath(manifestEntry.metadata));
      }

      targetPaths.add(this._toStoragePath(relativePath));
    }

    if (targetPaths.size === 0) {
      return { success: false, error: 'No valid paths to delete', failed: failures };
    }

    const { error } = await this._storage().remove(Array.from(targetPaths));
    if (error) {
      return { success: false, error: error.message, failed: failures };
    }

    if (removedPaths.size > 0) {
      manifest.assets = manifest.assets.filter((a) => !removedPaths.has(a.path));
      await this._saveManifest(manifest);
      await this.listAssets();
    }

    return { success: failures.length === 0, removed: Array.from(removedPaths), failed: failures };
  }

  /**
   * Probes the bucket for upload permission by writing and deleting a tiny temp object.
   * Avoids user-visible failures on first real upload.
   */
  async verifyUploadPermission() {
    const storage = this._storage();
    const probeName = `${this._basePrefix()}/__upload_probe_${Date.now()}.txt`;
    const blob = new Blob(['ok'], { type: 'text/plain' });

    try {
      const { error: uploadError } = await storage.upload(probeName, blob, {
        upsert: false,
        contentType: 'text/plain',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      if (uploadError) {
        return { success: false, error: `Upload permission failed: ${uploadError.message}` };
      }

      const { error: deleteError } = await storage.remove([probeName]);
      if (deleteError) {
        // Non-fatal; just warn
        console.warn('Upload probe cleanup failed:', deleteError);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

export const createSupabaseStorageSource = ({ supabaseUrl, anonKey, bucket, collectionId, name, collectionName }) => {
  const id = createSourceId('supabase-storage');

  const displayName = name || collectionName || `Supabase: ${bucket}/${collectionId}`;

  const config = {
    id,
    type: 'supabase-storage',
    name: displayName,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: {
      supabaseUrl: supabaseUrl.trim(),
      anonKey: anonKey.trim(),
      bucket: bucket.trim(),
      collectionId: collectionId.trim(),
      collectionName: collectionName || displayName,
      hasManifest: false,
    },
  };

  return new SupabaseStorageSource(config);
};

export const restoreSupabaseStorageSource = (config) => {
  return new SupabaseStorageSource(config);
};


