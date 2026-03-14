/**
 * Debug transfer bundle utilities (export/import).
 * Uses ZIP with JSON manifest + binary preview blobs.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  loadAllSources,
  saveSource,
  registerSource,
  restoreSource,
  deleteSource,
  clearAllAssetCache,
  getRemovedAssetNames,
  addRemovedAssetNames,
} from '../storage/index.js';
import {
  loadSupabaseSettings,
  saveSupabaseSettings,
  clearSupabaseSettings,
  clearSupabaseManifestCache,
} from '../storage/supabaseSettings.js';
import {
  loadR2Settings,
  saveR2Settings,
  clearR2Settings,
  clearR2ManifestCache,
} from '../storage/r2Settings.js';
import {
  loadCloudGpuSettings,
  saveCloudGpuSettings,
  clearCloudGpuSettings,
} from '../storage/cloudGpuSettings.js';
import { getAssetCacheStats } from '../storage/assetCache.js';
import {
  listAllFileSettings,
  listPreviewRecords,
  deleteFileSettings,
  saveFileSettings,
  deletePreviewBlob,
  savePreviewBlob,
  clearAllFileSettings,
  clearAllPreviewBlobs,
} from '../fileStorage.js';

const EXPORT_SCHEMA_VERSION = 1;
const EMBED_SCHEMA_VERSION = 1;
const SUPPORTED_TRANSFER_APPS = new Set(['radia-gallery', 'radia-viewer']);

const isSupportedTransferApp = (value) =>
  SUPPORTED_TRANSFER_APPS.has(String(value || '').trim().toLowerCase());

const QUALITY_PRESET_KEY = 'qualityPreset';
const DEBUG_SPARK_STDDEV_KEY = 'debugSparkMaxStdDev';
const DEBUG_FPS_LIMIT_KEY = 'debugFpsLimitEnabled';
const UI_PREFERENCES_KEY = 'ui-preferences';

export const createOptionSelectionState = (options = [], defaultValue = false) => {
  return options.reduce((acc, option) => {
    acc[option.key] = defaultValue;
    return acc;
  }, {});
};

export const CLEAR_DATA_OPTIONS = [
  {
    key: 'clearUrlCollections',
    title: 'URL collections',
    subtitle: 'Saved URL source entries',
    scope: 'indexeddb',
  },
  {
    key: 'clearSupabaseCollections',
    title: 'Supabase collections',
    subtitle: 'Saved Supabase source entries',
    scope: 'indexeddb',
  },
  {
    key: 'clearR2Collections',
    title: 'R2 collections',
    subtitle: 'Saved Cloudflare R2 source entries',
    scope: 'indexeddb',
  },
  {
    key: 'clearLocalFolderCollections',
    title: 'Local folder collections',
    subtitle: 'Saved local-folder source metadata and handles',
    scope: 'indexeddb',
  },
  {
    key: 'clearAppStorageCollections',
    title: 'App storage collections',
    subtitle: 'Saved in-app storage source entries',
    scope: 'indexeddb',
  },
  {
    key: 'clearCloudGpuSettings',
    title: 'Cloud GPU settings',
    subtitle: 'Stored API URL/key settings',
    scope: 'localstorage',
  },
  {
    key: 'clearSupabaseSettings',
    title: 'Supabase settings',
    subtitle: 'Saved Supabase settings and manifest cache',
    scope: 'localstorage',
  },
  {
    key: 'clearR2Settings',
    title: 'R2 settings',
    subtitle: 'Saved R2 settings and manifest cache',
    scope: 'localstorage',
  },
  {
    key: 'clearViewerPrefs',
    title: 'Viewer/UI preferences',
    subtitle: 'Quality/debug/UI preference keys in localStorage',
    scope: 'localstorage',
  },
  {
    key: 'clearFileSettings',
    title: 'File settings',
    subtitle: 'Per-file camera/display settings',
    scope: 'indexeddb',
  },
  {
    key: 'clearFilePreviews',
    title: 'File previews',
    subtitle: 'Persisted thumbnail blobs',
    scope: 'indexeddb',
  },
  {
    key: 'clearAssetCache',
    title: 'Asset cache',
    subtitle: 'Cached source asset blobs and collection manifests',
    scope: 'indexeddb',
  },
];

export const createInitialClearDataOptions = () => createOptionSelectionState(CLEAR_DATA_OPTIONS, false);

const sanitizeFileName = (name) => {
  if (!name) return 'untitled';
  return name
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'untitled';
};

const normalizePreviewExtension = (format) => {
  if (!format) return 'webp';
  const normalized = String(format).toLowerCase();
  if (normalized === 'jpeg') return 'jpg';
  if (normalized === 'jpg' || normalized === 'png' || normalized === 'webp') return normalized;
  return 'webp';
};

const formatToMime = (format) => {
  if (!format) return 'application/octet-stream';
  const normalized = String(format).toLowerCase();
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'png') return 'image/png';
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg';
  return 'application/octet-stream';
};

const normalizeNameList = (values) => {
  if (!Array.isArray(values)) return [];
  const cleaned = values
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

const buildNameMatcher = (names) => {
  const set = new Set(normalizeNameList(names));
  return {
    hasNames: set.size > 0,
    has(name) {
      if (!set.size) return false;
      if (!name) return false;
      const s = String(name);
      if (set.has(s)) return true;
      // View-instance storage keys use "baseName::viewId" — match the base
      // portion so preview blobs and file settings for views are included.
      const sep = s.indexOf('::');
      if (sep > 0) return set.has(s.slice(0, sep));
      return false;
    },
  };
};

const getStorageBaseName = (value) => {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  const sep = text.indexOf('::');
  return sep > 0 ? text.slice(0, sep) : text;
};

const getPathFileName = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
};

const isRemovedAssetName = (removedNames, value) => {
  if (!removedNames?.size) return false;
  const baseName = getStorageBaseName(value);
  if (!baseName) return false;
  return removedNames.has(baseName);
};

const buildRemovedNameUnion = (removedEntries = []) => {
  const names = new Set();
  removedEntries.forEach((entry) => {
    normalizeNameList(entry?.assetNames || []).forEach((name) => names.add(name));
  });
  return names;
};

const sanitizeSourceConfigForExport = (config, removedNames = new Set()) => {
  if (!config || typeof config !== 'object') return config;
  if (!removedNames.size) return config;

  const nextConfig = {
    ...config,
    config: {
      ...(config.config || {}),
    },
  };

  if (Array.isArray(nextConfig.config.assetPaths)) {
    nextConfig.config.assetPaths = nextConfig.config.assetPaths.filter(
      (path) => !isRemovedAssetName(removedNames, getPathFileName(path)),
    );
  }

  return nextConfig;
};

const loadRemovedAssetsForSources = async (sources = []) => {
  const results = await Promise.all(
    (sources || [])
      .filter((config) => config?.id)
      .map(async (config) => ({
        sourceId: config.id,
        assetNames: normalizeNameList(await getRemovedAssetNames(config.id)),
      })),
  );

  return results.filter((entry) => entry.assetNames.length > 0);
};

const readLocalStorageJson = (key, fallback = null) => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const resolveScopedSourceConfig = async (exportScope, explicitSourceConfig = null) => {
  if (explicitSourceConfig?.id) return explicitSourceConfig;

  const scopedSourceId = exportScope?.activeSourceId || null;
  if (!scopedSourceId) return null;

  const allSources = await loadAllSources();
  return allSources.find((config) => config?.id === scopedSourceId) || null;
};

const deriveManifestBaseUrl = (sourceConfig) => {
  const configuredBaseUrl = String(sourceConfig?.config?.baseUrl || '').trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const manifestUrl = String(sourceConfig?.config?.manifestUrl || '').trim();
  if (manifestUrl) {
    try {
      return new URL('./', manifestUrl).href;
    } catch {
      return '';
    }
  }

  return '';
};

const sanitizeEmbedFileSettings = (record) => {
  if (!record || typeof record !== 'object') return null;

  const next = {
    fileName: record.fileName,
  };

  if (record.animation && typeof record.animation === 'object') {
    next.animation = record.animation;
  }
  if (record.customAnimation && typeof record.customAnimation === 'object') {
    next.customAnimation = record.customAnimation;
  }
  if (record.viewCustomAnimations && typeof record.viewCustomAnimations === 'object') {
    next.viewCustomAnimations = record.viewCustomAnimations;
  }
  if (typeof record.annotation === 'string' && record.annotation) {
    next.annotation = record.annotation;
  }
  if (record.focusDistance !== undefined) {
    next.focusDistance = record.focusDistance;
  }
  if (record.customMetadata && typeof record.customMetadata === 'object') {
    next.customMetadata = record.customMetadata;
  }

  return Object.keys(next).length > 1 ? next : null;
};

const buildEmbedAssetMetadata = (record) => {
  if (!record) return null;

  const metadata = {};
  if (record.animation) metadata.animation = record.animation;
  if (record.customAnimation) metadata.customAnimation = record.customAnimation;
  if (typeof record.annotation === 'string' && record.annotation) metadata.annotation = record.annotation;
  if (record.focusDistance !== undefined) metadata.focusDistance = record.focusDistance;

  return Object.keys(metadata).length > 0 ? metadata : null;
};

const buildEmbedAssetEntries = (exportScope, scopeNameMatcher) => {
  if (!Array.isArray(exportScope?.assetEntries)) return [];

  return exportScope.assetEntries
    .filter((asset) => {
      if (!scopeNameMatcher.hasNames) return true;
      return scopeNameMatcher.has(asset?.name);
    })
    .map((asset) => ({
      name: asset?.name || '',
      path: asset?.path || '',
      preview: asset?.preview || null,
      size: asset?.size ?? null,
    }))
    .filter((asset) => asset.name || asset.path);
};

const buildEmbedCollectionPayload = async (options = {}) => {
  const exportScope = options?.exportScope || {};
  if (exportScope?.mode !== 'current-collection') {
    throw new Error('Embed export only supports the current collection scope.');
  }

  const sourceConfig = await resolveScopedSourceConfig(exportScope, options?.sourceConfig || exportScope?.sourceConfig || null);
  if (!sourceConfig?.id) {
    throw new Error('Current collection source is unavailable.');
  }

  if (sourceConfig.type !== 'public-url') {
    throw new Error('Embed export only supports public URL collections.');
  }

  const assetNames = normalizeNameList(exportScope?.assetNames || []);
  const scopeNameMatcher = buildNameMatcher(assetNames);
  const assetEntries = buildEmbedAssetEntries(exportScope, scopeNameMatcher);

  if (!assetEntries.length) {
    throw new Error('Current collection does not contain any exportable assets.');
  }

  let fileSettings = [];
  if (options.includeFileSettings !== false) {
    const allFileSettings = await listAllFileSettings();
    fileSettings = scopeNameMatcher.hasNames
      ? allFileSettings.filter((record) => scopeNameMatcher.has(record?.fileName))
      : [];
  }

  const sanitizedFileSettings = fileSettings
    .map((record) => sanitizeEmbedFileSettings(record))
    .filter(Boolean);
  const fileSettingsByName = new Map(sanitizedFileSettings.map((record) => [record.fileName, record]));

  const manifestBaseUrl = deriveManifestBaseUrl(sourceConfig);
  const manifest = {
    version: 1,
    name: exportScope?.collectionName || sourceConfig?.name || 'Current collection',
    assets: assetEntries.map((asset) => {
      const embedFileSettings = fileSettingsByName.get(asset.name) || null;
      const nextAsset = {
        name: asset.name || '',
        path: asset.path || '',
        size: asset.size ?? null,
      };

      if (asset.preview) {
        nextAsset.preview = asset.preview;
      }

      const metadata = buildEmbedAssetMetadata(embedFileSettings);
      if (metadata) {
        nextAsset.metadata = metadata;
      }
      if (embedFileSettings) {
        nextAsset.embedFileSettings = embedFileSettings;
      }

      return nextAsset;
    }),
  };

  const uiPreferences = options.includeUiPreferences === false
    ? null
    : (options.uiPreferences || readLocalStorageJson(UI_PREFERENCES_KEY, null));

  const requestedCameraRange = Number(options?.viewerSettings?.cameraRange);
  const viewerSettings = {
    qualityPreset: 'performance',
    cameraRange: Number.isFinite(requestedCameraRange) ? requestedCameraRange : 8,
  };

  const sourceAssetPaths = Array.from(new Set(assetEntries.map((asset) => String(asset.path || '').trim()).filter(Boolean)));
  const source = {
    id: sourceConfig.id,
    type: 'public-url',
    name: sourceConfig.name || exportScope?.collectionName || 'Current collection',
    config: {
      manifestUrl: String(sourceConfig?.config?.manifestUrl || '').trim(),
      baseUrl: manifestBaseUrl,
      assetPaths: sourceAssetPaths,
    },
  };

  const posterAsset = manifest.assets.find((asset) => asset?.preview) || manifest.assets[0] || null;
  const notes = [];
  if (!posterAsset?.preview) {
    notes.push('No preview image is available for the default poster.');
  }

  return {
    schemaVersion: EMBED_SCHEMA_VERSION,
    app: 'radia-gallery-embed',
    exportedAt: new Date().toISOString(),
    collection: {
      mode: 'current-collection',
      name: exportScope?.collectionName || sourceConfig?.name || 'Current collection',
      assetCount: manifest.assets.length,
    },
    source,
    manifest,
    poster: posterAsset
      ? {
          fileName: posterAsset.name || null,
          path: posterAsset.path || null,
          previewUrl: posterAsset.preview || null,
        }
      : null,
    viewerSettings,
    uiPreferences,
    fileSettings: sanitizedFileSettings,
    notes,
  };
};

const buildZipFileMap = async ({
  includeUrlCollections,
  includeSupabaseCollections,
  includeSupabaseSettings,
  includeR2Collections,
  includeR2Settings,
  includeCloudGpuSettings,
  includeFileSettings,
  includeFilePreviews,
  includeCollectionData,
  includeConnectionData,
  exportScope,
}) => {
  const notes = [];
  const scopeMode = exportScope?.mode === 'current-collection' ? 'current-collection' : 'all-data';
  const isCurrentCollectionScope = scopeMode === 'current-collection';
  const scopedSourceId = exportScope?.activeSourceId || null;
  const scopedSourceType = exportScope?.activeSourceType || null;
  const scopedCollectionName = exportScope?.collectionName || null;
  const scopeNameMatcher = buildNameMatcher(exportScope?.assetNames || []);

  const data = {
    sources: [],
    supabaseSettings: null,
    r2Settings: null,
    cloudGpuSettings: null,
    fileSettings: [],
    previews: [],
    removedAssets: [],
  };

  if (isCurrentCollectionScope && includeCollectionData) {
    const allSources = await loadAllSources();
    data.sources = allSources.filter((config) => config?.id && config.id === scopedSourceId);
    if (!data.sources.length) {
      notes.push('Current collection source entry was not found in saved sources.');
    }
  } else if (includeUrlCollections || includeSupabaseCollections || includeR2Collections) {
    const allSources = await loadAllSources();
    data.sources = allSources.filter((config) => {
      if (config.type === 'public-url') return includeUrlCollections;
      if (config.type === 'supabase-storage') return includeSupabaseCollections;
      if (config.type === 'r2-bucket') return includeR2Collections;
      return false;
    });
    const skippedLocal = allSources.some((config) => config.type === 'local-folder');
    if (skippedLocal) {
      notes.push('Local folder sources were skipped (handles cannot be exported).');
    }
  }

  if (data.sources.length > 0) {
    data.removedAssets = await loadRemovedAssetsForSources(data.sources);
    if (data.removedAssets.length > 0) {
      const removedMap = new Map(data.removedAssets.map((entry) => [entry.sourceId, new Set(entry.assetNames)]));
      data.sources = data.sources.map((config) => sanitizeSourceConfigForExport(config, removedMap.get(config.id) || new Set()));
    }
  }

  const removedNameUnion = buildRemovedNameUnion(data.removedAssets);

  if (isCurrentCollectionScope) {
    if (includeConnectionData) {
      if (scopedSourceType === 'supabase-storage') {
        data.supabaseSettings = loadSupabaseSettings();
      }
      if (scopedSourceType === 'r2-bucket') {
        data.r2Settings = loadR2Settings();
      }
      if (scopedSourceType !== 'supabase-storage' && scopedSourceType !== 'r2-bucket') {
        notes.push('Connection data export is only available for Supabase and R2 collections.');
      }
    }
  } else {
    if (includeSupabaseSettings) {
      data.supabaseSettings = loadSupabaseSettings();
    }

    if (includeR2Settings) {
      data.r2Settings = loadR2Settings();
    }

    if (includeCloudGpuSettings) {
      data.cloudGpuSettings = loadCloudGpuSettings();
    }
  }

  if (includeFileSettings) {
    const fileSettings = await listAllFileSettings();
    if (isCurrentCollectionScope) {
      data.fileSettings = scopeNameMatcher.hasNames
        ? fileSettings.filter((record) => scopeNameMatcher.has(record?.fileName))
        : [];
    } else {
      data.fileSettings = removedNameUnion.size
        ? fileSettings.filter((record) => !isRemovedAssetName(removedNameUnion, record?.fileName))
        : fileSettings;
    }
  }

  const files = {};
  if (includeFilePreviews) {
    const previewRecords = await listPreviewRecords();
    const scopedPreviewRecords = isCurrentCollectionScope
      ? (scopeNameMatcher.hasNames
          ? previewRecords.filter((record) => scopeNameMatcher.has(record?.fileName))
          : [])
      : (removedNameUnion.size
        ? previewRecords.filter((record) => !isRemovedAssetName(removedNameUnion, record?.fileName))
        : previewRecords);

    for (let index = 0; index < scopedPreviewRecords.length; index += 1) {
      const record = scopedPreviewRecords[index];
      const safeName = sanitizeFileName(record.fileName).replace(/\.[a-z0-9]+$/i, '');
      const ext = normalizePreviewExtension(record.format);
      const previewPath = `previews/${index}-${safeName}.${ext}`;
      const buffer = await record.blob.arrayBuffer();
      files[previewPath] = new Uint8Array(buffer);
      data.previews.push({
        fileName: record.fileName,
        width: record.width,
        height: record.height,
        format: record.format,
        updated: record.updated,
        version: record.version,
        blobPath: previewPath,
      });
    }
  }

  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    app: 'radia-gallery',
    exportedAt: new Date().toISOString(),
    scope: {
      mode: scopeMode,
      activeSourceId: scopedSourceId,
      activeSourceType: scopedSourceType,
      collectionName: scopedCollectionName,
      scopedAssetCount: scopeNameMatcher.hasNames ? normalizeNameList(exportScope?.assetNames).length : 0,
    },
    selections: {
      includeUrlCollections,
      includeSupabaseCollections,
      includeSupabaseSettings,
      includeR2Collections,
      includeR2Settings,
      includeCloudGpuSettings,
      includeFileSettings,
      includeFilePreviews,
      includeCollectionData,
      includeConnectionData,
    },
    data,
    notes,
  };

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  return { files, manifest };
};

export const buildTransferBundle = async (options) => {
  const { files, manifest } = await buildZipFileMap(options);
  const zipData = zipSync(files, { level: 6 });
  const blob = new Blob([zipData], { type: 'application/zip' });
  return { blob, manifest };
};

/**
 * Build a JSON-only transfer manifest (no binary preview blobs).
 * Forces includeFilePreviews to false so no binary data is collected.
 * Returns { json, manifest } where json is a formatted JSON string.
 */
export const buildTransferJson = async (options) => {
  const jsonOptions = { ...options, includeFilePreviews: false };
  const { manifest } = await buildZipFileMap(jsonOptions);
  const json = JSON.stringify(manifest, null, 2);
  return { json, manifest };
};

export const buildEmbedManifest = async (options = {}) => {
  return buildEmbedCollectionPayload(options);
};

export const buildEmbedManifestJson = async (options = {}) => {
  const manifest = await buildEmbedManifest(options);
  return {
    manifest,
    json: JSON.stringify(manifest, null, 2),
  };
};

export const buildEmbedBundle = async (options = {}) => {
  const manifest = await buildEmbedCollectionPayload(options);
  const files = {};
  const includePreviews = options.includeFilePreviews !== false;

  if (includePreviews) {
    const assetNames = normalizeNameList(options?.exportScope?.assetNames || []);
    const scopeNameMatcher = buildNameMatcher(assetNames);
    const previewRecords = await listPreviewRecords();
    const scopedPreviewRecords = scopeNameMatcher.hasNames
      ? previewRecords.filter((record) => scopeNameMatcher.has(record?.fileName))
      : [];
    const previewPathByName = new Map();

    for (let index = 0; index < scopedPreviewRecords.length; index += 1) {
      const record = scopedPreviewRecords[index];
      const safeName = sanitizeFileName(record.fileName).replace(/\.[a-z0-9]+$/i, '');
      const ext = normalizePreviewExtension(record.format);
      const previewPath = `previews/${index}-${safeName}.${ext}`;
      const buffer = await record.blob.arrayBuffer();
      files[previewPath] = new Uint8Array(buffer);
      previewPathByName.set(record.fileName, previewPath);
    }

    manifest.manifest = {
      ...manifest.manifest,
      assets: manifest.manifest.assets.map((asset) => {
        const bundledPreviewPath = previewPathByName.get(asset.name);
        if (!bundledPreviewPath) {
          return asset;
        }
        return {
          ...asset,
          preview: bundledPreviewPath,
        };
      }),
    };

    const posterPreviewPath = manifest.poster?.fileName
      ? previewPathByName.get(manifest.poster.fileName)
      : null;
    if (posterPreviewPath && manifest.poster) {
      manifest.poster = {
        ...manifest.poster,
        previewUrl: posterPreviewPath,
      };
    }

    if (previewPathByName.size === 0) {
      manifest.notes = [
        ...(Array.isArray(manifest.notes) ? manifest.notes : []),
        'No stored preview images were available to bundle into the ZIP.',
      ];
    }
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  const zipData = zipSync(files, { level: 6 });
  const blob = new Blob([zipData], { type: 'application/zip' });
  return { blob, manifest };
};

const countLocalStorageKeysByPrefix = (prefix) => {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  let count = 0;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
};

const hasLocalStorageKey = (key) => {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  return window.localStorage.getItem(key) !== null;
};

const buildAvailabilityEntry = (count = 0) => ({
  available: count > 0,
  count,
});

const countSourcesByType = (sources = []) => {
  const counts = {
    publicUrl: 0,
    supabase: 0,
    r2: 0,
    localFolder: 0,
    appStorage: 0,
  };

  sources.forEach((config) => {
    if (config?.type === 'public-url') counts.publicUrl += 1;
    if (config?.type === 'supabase-storage') counts.supabase += 1;
    if (config?.type === 'r2-bucket') counts.r2 += 1;
    if (config?.type === 'local-folder') counts.localFolder += 1;
    if (config?.type === 'app-storage') counts.appStorage += 1;
  });

  return counts;
};

const countViewerPreferenceKeys = () => {
  return [
    QUALITY_PRESET_KEY,
    DEBUG_SPARK_STDDEV_KEY,
    DEBUG_FPS_LIMIT_KEY,
    UI_PREFERENCES_KEY,
  ].reduce((total, key) => total + (hasLocalStorageKey(key) ? 1 : 0), 0);
};

const clearLocalStorageKey = (key) => {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  const existed = window.localStorage.getItem(key) !== null;
  window.localStorage.removeItem(key);
  return existed ? 1 : 0;
};

const clearSourcesByType = async (type) => {
  const allSources = await loadAllSources();
  let removed = 0;
  for (const config of allSources) {
    if (config?.type !== type || !config?.id) continue;
    const ok = await deleteSource(config.id);
    if (ok) removed += 1;
  }
  return removed;
};

export const getLocalDataAvailability = async (options = {}) => {
  const exportScope = options?.exportScope || null;
  const scopeMode = exportScope?.mode === 'current-collection' ? 'current-collection' : 'all-data';
  const scopeNameMatcher = buildNameMatcher(exportScope?.assetNames || []);
  const scopedSourceId = exportScope?.activeSourceId || null;
  const scopedSourceType = exportScope?.activeSourceType || null;

  const [allSources, allFileSettings, previewRecords, assetCacheStats] = await Promise.all([
    loadAllSources(),
    listAllFileSettings(),
    listPreviewRecords(),
    getAssetCacheStats(),
  ]);

  const sourceCounts = countSourcesByType(allSources);
  const supabaseSettings = loadSupabaseSettings();
  const r2Settings = loadR2Settings();
  const cloudGpuSettings = loadCloudGpuSettings();
  const supabaseManifestCacheCount = countLocalStorageKeysByPrefix('supabase-manifest-cache:');
  const r2ManifestCacheCount = countLocalStorageKeysByPrefix('r2-manifest-cache:');
  const viewerPreferenceCount = countViewerPreferenceKeys();
  const scopedSourceCount = scopedSourceId
    ? allSources.filter((config) => config?.id === scopedSourceId).length
    : 0;
  const scopedFileSettingsCount = scopeMode === 'current-collection' && scopeNameMatcher.hasNames
    ? allFileSettings.filter((record) => scopeNameMatcher.has(record?.fileName)).length
    : 0;
  const scopedPreviewCount = scopeMode === 'current-collection' && scopeNameMatcher.hasNames
    ? previewRecords.filter((record) => scopeNameMatcher.has(record?.fileName)).length
    : 0;
  const scopedConnectionCount = scopedSourceType === 'supabase-storage'
    ? (supabaseSettings ? 1 : 0)
    : scopedSourceType === 'r2-bucket'
      ? (r2Settings ? 1 : 0)
      : 0;
  const assetCacheTotal = (assetCacheStats?.assetBlobCount || 0) + (assetCacheStats?.manifestCount || 0);

  return {
    clearData: {
      clearUrlCollections: buildAvailabilityEntry(sourceCounts.publicUrl),
      clearSupabaseCollections: buildAvailabilityEntry(sourceCounts.supabase),
      clearR2Collections: buildAvailabilityEntry(sourceCounts.r2),
      clearLocalFolderCollections: buildAvailabilityEntry(sourceCounts.localFolder),
      clearAppStorageCollections: buildAvailabilityEntry(sourceCounts.appStorage),
      clearCloudGpuSettings: buildAvailabilityEntry(cloudGpuSettings ? 1 : 0),
      clearSupabaseSettings: buildAvailabilityEntry((supabaseSettings ? 1 : 0) + supabaseManifestCacheCount),
      clearR2Settings: buildAvailabilityEntry((r2Settings ? 1 : 0) + r2ManifestCacheCount),
      clearViewerPrefs: buildAvailabilityEntry(viewerPreferenceCount),
      clearFileSettings: buildAvailabilityEntry(allFileSettings.length),
      clearFilePreviews: buildAvailabilityEntry(previewRecords.length),
      clearAssetCache: buildAvailabilityEntry(assetCacheTotal),
    },
    exportAllData: {
      includeUrlCollections: buildAvailabilityEntry(sourceCounts.publicUrl),
      includeCloudGpuSettings: buildAvailabilityEntry(cloudGpuSettings ? 1 : 0),
      includeSupabaseCollections: buildAvailabilityEntry(sourceCounts.supabase),
      includeSupabaseSettings: buildAvailabilityEntry(supabaseSettings ? 1 : 0),
      includeR2Collections: buildAvailabilityEntry(sourceCounts.r2),
      includeR2Settings: buildAvailabilityEntry(r2Settings ? 1 : 0),
      includeFilePreviews: buildAvailabilityEntry(previewRecords.length),
      includeFileSettings: buildAvailabilityEntry(allFileSettings.length),
    },
    exportCurrentCollection: {
      includeCollectionData: buildAvailabilityEntry(scopedSourceCount),
      includeConnectionData: buildAvailabilityEntry(scopedConnectionCount),
      includeFilePreviews: buildAvailabilityEntry(scopedPreviewCount),
      includeFileSettings: buildAvailabilityEntry(scopedFileSettingsCount),
    },
  };
};

export const clearSelectedLocalData = async (options = {}) => {
  const summary = {
    sourcesCleared: 0,
    localStorageEntriesCleared: 0,
    fileSettingsCleared: 0,
    previewsCleared: 0,
    assetCacheBlobsCleared: 0,
    assetCacheManifestsCleared: 0,
    warnings: [],
  };

  if (options.clearUrlCollections) {
    summary.sourcesCleared += await clearSourcesByType('public-url');
  }

  if (options.clearSupabaseCollections) {
    summary.sourcesCleared += await clearSourcesByType('supabase-storage');
  }

  if (options.clearR2Collections) {
    summary.sourcesCleared += await clearSourcesByType('r2-bucket');
  }

  if (options.clearLocalFolderCollections) {
    summary.sourcesCleared += await clearSourcesByType('local-folder');
  }

  if (options.clearAppStorageCollections) {
    summary.sourcesCleared += await clearSourcesByType('app-storage');
  }

  if (options.clearCloudGpuSettings) {
    summary.localStorageEntriesCleared += clearLocalStorageKey('cloud-gpu-settings');
    clearCloudGpuSettings();
  }

  if (options.clearSupabaseSettings) {
    summary.localStorageEntriesCleared += clearLocalStorageKey('supabase-settings');
    summary.localStorageEntriesCleared += countLocalStorageKeysByPrefix('supabase-manifest-cache:');
    clearSupabaseSettings();
    clearSupabaseManifestCache();
  }

  if (options.clearR2Settings) {
    summary.localStorageEntriesCleared += clearLocalStorageKey('r2-settings');
    summary.localStorageEntriesCleared += countLocalStorageKeysByPrefix('r2-manifest-cache:');
    clearR2Settings();
    clearR2ManifestCache();
  }

  if (options.clearCloudGpuSettings || options.clearR2Settings) {
    summary.localStorageEntriesCleared += clearLocalStorageKey('credential-vault-meta');
  }

  if (options.clearViewerPrefs) {
    summary.localStorageEntriesCleared += clearLocalStorageKey(QUALITY_PRESET_KEY);
    summary.localStorageEntriesCleared += clearLocalStorageKey(DEBUG_SPARK_STDDEV_KEY);
    summary.localStorageEntriesCleared += clearLocalStorageKey(DEBUG_FPS_LIMIT_KEY);
    summary.localStorageEntriesCleared += clearLocalStorageKey(UI_PREFERENCES_KEY);
  }

  if (options.clearFileSettings) {
    summary.fileSettingsCleared = await clearAllFileSettings();
  }

  if (options.clearFilePreviews) {
    const previewRecords = await listPreviewRecords();
    const cleared = await clearAllPreviewBlobs();
    summary.previewsCleared = cleared ? previewRecords.length : 0;
    if (!cleared && previewRecords.length > 0) {
      summary.warnings.push('Failed to clear one or more preview blobs');
    }
  }

  if (options.clearAssetCache) {
    const result = await clearAllAssetCache();
    summary.assetCacheBlobsCleared = result.assetBlobsCleared || 0;
    summary.assetCacheManifestsCleared = result.manifestsCleared || 0;
  }

  return summary;
};

/**
 * Validate a raw manifest object (from a JSON-only import).
 * Returns { valid, manifest, error }.
 */
export const validateTransferManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, manifest: null, error: 'Invalid manifest format' };
  }
  if (!isSupportedTransferApp(manifest.app)) {
    return { valid: false, manifest, error: 'Not a valid Radia transfer bundle' };
  }
  if (manifest.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return { valid: false, manifest, error: `Unsupported schema version: ${manifest.schemaVersion}` };
  }
  return { valid: true, manifest, error: null };
};

/**
 * Validate a transfer bundle ZIP buffer without importing.
 * Returns { valid, manifest, error } where manifest is the parsed manifest.json.
 */
export const validateTransferBundle = (arrayBuffer) => {
  try {
    const zipEntries = unzipSync(new Uint8Array(arrayBuffer));
    const manifestEntry = zipEntries['manifest.json'];
    if (!manifestEntry) {
      return { valid: false, manifest: null, error: 'Missing manifest.json in transfer bundle' };
    }
    const manifest = JSON.parse(strFromU8(manifestEntry));
    if (!isSupportedTransferApp(manifest?.app)) {
      return { valid: false, manifest, error: 'Not a valid Radia transfer bundle' };
    }
    if (manifest?.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      return { valid: false, manifest, error: `Unsupported schema version: ${manifest?.schemaVersion}` };
    }
    return { valid: true, manifest, error: null };
  } catch (err) {
    return { valid: false, manifest: null, error: err?.message || 'Failed to read transfer bundle' };
  }
};

/**
 * Import a transfer bundle from a raw ArrayBuffer.
 * The buffer must be a ZIP containing manifest.json + optional preview blobs.
 */
export const importTransferBundleFromBuffer = async (arrayBuffer) => {
  const zipEntries = unzipSync(new Uint8Array(arrayBuffer));
  const manifestEntry = zipEntries['manifest.json'];
  if (!manifestEntry) {
    throw new Error('Missing manifest.json in transfer bundle');
  }

  const manifest = JSON.parse(strFromU8(manifestEntry));

  if (!isSupportedTransferApp(manifest?.app)) {
    throw new Error('Not a valid Radia transfer bundle');
  }
  if (manifest?.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${manifest?.schemaVersion}`);
  }

  const data = manifest?.data || {};

  const summary = {
    sourcesImported: 0,
    importedSources: [],
    fileSettingsImported: 0,
    previewsImported: 0,
    supabaseSettingsImported: Boolean(data.supabaseSettings),
    r2SettingsImported: Boolean(data.r2Settings),
    cloudGpuSettingsImported: Boolean(data.cloudGpuSettings),
    warnings: [],
  };

  if (data.supabaseSettings) {
    saveSupabaseSettings(data.supabaseSettings);
  }

  if (data.r2Settings) {
    saveR2Settings(data.r2Settings);
  }

  if (data.cloudGpuSettings) {
    saveCloudGpuSettings(data.cloudGpuSettings);
  }

  if (Array.isArray(data.sources)) {
    for (const config of data.sources) {
      if (!config?.type) continue;
      if (config.type !== 'public-url' && config.type !== 'supabase-storage' && config.type !== 'r2-bucket') {
        summary.warnings.push(`Skipped unsupported source type: ${config.type}`);
        continue;
      }
      await saveSource(config);
      const source = restoreSource(config);
      if (source) {
        registerSource(source);
        summary.importedSources.push(source);
      }
      summary.sourcesImported += 1;
    }
  }

  if (Array.isArray(data.removedAssets)) {
    for (const entry of data.removedAssets) {
      const sourceId = entry?.sourceId;
      const assetNames = normalizeNameList(entry?.assetNames || []);
      if (!sourceId || assetNames.length === 0) continue;
      await addRemovedAssetNames(sourceId, assetNames);
    }
  }

  if (Array.isArray(data.fileSettings)) {
    for (const record of data.fileSettings) {
      if (!record?.fileName) continue;
      await deleteFileSettings(record.fileName);
      await saveFileSettings(record.fileName, record);
      summary.fileSettingsImported += 1;
    }
  }

  if (Array.isArray(data.previews)) {
    for (const preview of data.previews) {
      if (!preview?.fileName || !preview?.blobPath) continue;
      const entry = zipEntries[preview.blobPath];
      if (!entry) {
        summary.warnings.push(`Missing preview blob for ${preview.fileName}`);
        continue;
      }
      const blob = new Blob([entry], { type: formatToMime(preview.format) });
      await deletePreviewBlob(preview.fileName);
      await savePreviewBlob(preview.fileName, blob, {
        width: preview.width,
        height: preview.height,
        format: preview.format,
      });
      summary.previewsImported += 1;
    }
  }

  return { manifest, summary };
};

/**
 * Import from a parsed manifest object (JSON-only, no preview blobs).
 * Skips preview import entirely since there are no binary entries.
 */
export const importTransferManifest = async (manifest) => {
  const check = validateTransferManifest(manifest);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const data = manifest?.data || {};

  const summary = {
    sourcesImported: 0,
    importedSources: [],
    fileSettingsImported: 0,
    previewsImported: 0,
    supabaseSettingsImported: Boolean(data.supabaseSettings),
    r2SettingsImported: Boolean(data.r2Settings),
    cloudGpuSettingsImported: Boolean(data.cloudGpuSettings),
    warnings: [],
  };

  if (data.supabaseSettings) {
    saveSupabaseSettings(data.supabaseSettings);
  }

  if (data.r2Settings) {
    saveR2Settings(data.r2Settings);
  }

  if (data.cloudGpuSettings) {
    saveCloudGpuSettings(data.cloudGpuSettings);
  }

  if (Array.isArray(data.sources)) {
    for (const config of data.sources) {
      if (!config?.type) continue;
      if (config.type !== 'public-url' && config.type !== 'supabase-storage' && config.type !== 'r2-bucket') {
        summary.warnings.push(`Skipped unsupported source type: ${config.type}`);
        continue;
      }
      await saveSource(config);
      const source = restoreSource(config);
      if (source) {
        registerSource(source);
        summary.importedSources.push(source);
      }
      summary.sourcesImported += 1;
    }
  }

  if (Array.isArray(data.removedAssets)) {
    for (const entry of data.removedAssets) {
      const sourceId = entry?.sourceId;
      const assetNames = normalizeNameList(entry?.assetNames || []);
      if (!sourceId || assetNames.length === 0) continue;
      await addRemovedAssetNames(sourceId, assetNames);
    }
  }

  if (Array.isArray(data.fileSettings)) {
    for (const record of data.fileSettings) {
      if (!record?.fileName) continue;
      await deleteFileSettings(record.fileName);
      await saveFileSettings(record.fileName, record);
      summary.fileSettingsImported += 1;
    }
  }

  if (Array.isArray(data.previews) && data.previews.length > 0) {
    summary.warnings.push('Preview blobs are not included in JSON-only imports.');
  }

  return { manifest, summary };
};

export const importTransferBundle = async (file) => {
  const isJson = file.name?.toLowerCase().endsWith('.json') || file.type === 'application/json';

  if (isJson) {
    const text = await file.text();
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON file');
    }
    return importTransferManifest(manifest);
  }

  // Content-based JSON detection fallback (e.g. MIME not set correctly)
  const buffer = await file.arrayBuffer();
  const firstByte = new Uint8Array(buffer)[0];
  if (firstByte === 0x7B) { // '{'
    try {
      const text = new TextDecoder().decode(buffer);
      const manifest = JSON.parse(text);
      const check = validateTransferManifest(manifest);
      if (check.valid) {
        return importTransferManifest(manifest);
      }
    } catch {
      // Not valid JSON manifest — try ZIP
    }
  }

  return importTransferBundleFromBuffer(buffer);
};
