import { unzipSync, strFromU8 } from 'fflate';
import { extractTransferManifestFromPayload, fetchRemoteBundle, resolveImportPayloadUrl } from '../utils/importFromUrl.js';
import { validatePublicUrlManifest } from './TransientPublicUrlSource.js';

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getFilename = (path) => {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(path || '');
};

const resolveUrl = (value, baseUrl) => {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return String(value);
  }
};

const decodeJsonBuffer = (buffer) => {
  const text = new TextDecoder().decode(buffer).replace(/^\uFEFF/, '');
  return JSON.parse(text);
};

const readTextPrefix = (buffer, length = 160) => {
  try {
    return new TextDecoder().decode(buffer.slice(0, length)).trim();
  } catch {
    return '';
  }
};

const looksLikeHtmlDocument = (buffer) => {
  const prefix = readTextPrefix(buffer).toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<!doctype');
};

const isZipBuffer = (buffer) => {
  const bytes = new Uint8Array(buffer);
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
};

const createZipObjectUrl = (entry, entryName, objectUrls) => {
  const lowerName = String(entryName || '').toLowerCase();
  let type = 'application/octet-stream';

  if (lowerName.endsWith('.json')) type = 'application/json';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) type = 'image/jpeg';
  if (lowerName.endsWith('.png')) type = 'image/png';
  if (lowerName.endsWith('.webp')) type = 'image/webp';
  if (lowerName.endsWith('.gif')) type = 'image/gif';
  if (lowerName.endsWith('.svg')) type = 'image/svg+xml';

  const objectUrl = URL.createObjectURL(new Blob([entry], { type }));
  objectUrls.push(objectUrl);
  return objectUrl;
};

const buildPreviewUrlMap = (transferManifest, entries, objectUrls) => {
  const previewUrlMap = new Map();
  const previews = Array.isArray(transferManifest?.data?.previews) ? transferManifest.data.previews : [];

  previews.forEach((preview) => {
    if (!preview?.fileName || !preview?.blobPath) return;
    const entry = entries[preview.blobPath];
    if (!entry) return;
    previewUrlMap.set(
      preview.fileName,
      createZipObjectUrl(entry, preview.blobPath, objectUrls),
    );
  });

  return previewUrlMap;
};

const buildCollectionDescriptor = ({ manifest, manifestBaseUrl = '', collectionName, posterUrl, cleanup }) => ({
  manifest,
  manifestUrl: '',
  manifestBaseUrl,
  collectionName: collectionName || manifest?.name || 'Embedded collection',
  posterUrl: posterUrl || null,
  uiPreferences: null,
  viewerSettings: null,
  cleanup,
});

const getEmbedManifestBaseUrl = (payload, sourceUrl = '') => {
  const explicitBaseUrl = String(payload?.source?.config?.baseUrl || '').trim();
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const manifestUrl = String(payload?.source?.config?.manifestUrl || '').trim();
  if (manifestUrl) {
    return resolveUrl('./', manifestUrl);
  }

  return sourceUrl ? resolveUrl('./', sourceUrl) : '';
};

const buildManifestDescriptor = (manifest, sourceUrl) => {
  const validation = validatePublicUrlManifest(manifest);
  if (!validation.success) {
    throw new Error(validation.error);
  }

  const manifestBaseUrl = resolveUrl('./', sourceUrl);
  const firstPreview = manifest.assets.find((asset) => asset?.preview)?.preview || '';
  return buildCollectionDescriptor({
    manifest,
    manifestBaseUrl,
    collectionName: manifest?.name || 'Embedded collection',
    posterUrl: firstPreview ? resolveUrl(firstPreview, manifestBaseUrl) : null,
  });
};

const buildSourceConfigDescriptor = (source, transferManifest, options = {}) => {
  const baseUrl = String(source?.config?.baseUrl || '').trim();
  const assetPaths = Array.isArray(source?.config?.assetPaths)
    ? source.config.assetPaths.filter((path) => typeof path === 'string' && path.trim())
    : [];
  const previewUrlMap = options.previewUrlMap instanceof Map ? options.previewUrlMap : null;
  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : null;

  if (!assetPaths.length) {
    throw new Error('Embed payload does not contain a usable readonly public-url collection.');
  }

  const manifest = {
    version: 1,
    name: source?.name || transferManifest?.scope?.collectionName || 'Embedded collection',
    assets: assetPaths.map((path) => ({
      path,
      name: getFilename(path),
      preview: previewUrlMap?.get(getFilename(path)) || null,
    })),
  };

  const firstPreview = manifest.assets.find((asset) => asset?.preview)?.preview || null;

  return buildCollectionDescriptor({
    manifest,
    manifestBaseUrl: baseUrl,
    collectionName: manifest.name,
    posterUrl: firstPreview,
    cleanup,
  });
};

const rewriteManifestForZip = (manifest, entries, options = {}) => {
  const objectUrls = [];
  const nextManifest = {
    ...manifest,
    assets: Array.isArray(manifest.assets)
      ? manifest.assets.map((asset) => {
        if (!isPlainObject(asset)) return asset;
        const nextAsset = { ...asset };

        ['path', 'preview', 'metadata'].forEach((field) => {
          if (typeof nextAsset[field] !== 'string') return;
          const entry = entries[nextAsset[field]];
          if (!entry) return;
          nextAsset[field] = createZipObjectUrl(entry, nextAsset[field], objectUrls);
        });

        return nextAsset;
      })
      : manifest.assets,
  };

  const firstPreview = nextManifest.assets.find((asset) => asset?.preview)?.preview || null;
  return {
    descriptor: buildCollectionDescriptor({
      manifest: nextManifest,
      manifestBaseUrl: options.manifestBaseUrl || '',
      collectionName: options.collectionName || nextManifest?.name || 'Embedded collection',
      posterUrl: firstPreview,
      cleanup: () => {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
      },
    }),
  };
};

const buildEmbedPayloadDescriptor = (payload, sourceUrl) => {
  const inlineManifest = isPlainObject(payload?.manifest) ? payload.manifest : null;
  const uiPreferences = isPlainObject(payload?.uiPreferences) ? payload.uiPreferences : null;
  const viewerSettings = isPlainObject(payload?.viewerSettings) ? payload.viewerSettings : null;

  if (inlineManifest) {
    const validation = validatePublicUrlManifest(inlineManifest);
    if (!validation.success) {
      throw new Error(validation.error);
    }

    const manifestBaseUrl = getEmbedManifestBaseUrl(payload, sourceUrl);
    const firstPreview = inlineManifest.assets.find((asset) => asset?.preview)?.preview || '';
    return {
      manifest: inlineManifest,
      manifestUrl: '',
      manifestBaseUrl,
      collectionName: payload?.collection?.name || payload?.source?.name || inlineManifest?.name || 'Embedded collection',
      posterUrl: payload?.poster?.previewUrl || (firstPreview ? resolveUrl(firstPreview, manifestBaseUrl) : null),
      uiPreferences,
      viewerSettings,
      cleanup: null,
    };
  }

  return {
    manifestUrl: String(payload?.source?.config?.manifestUrl || '').trim(),
    manifest: null,
    manifestBaseUrl: '',
    collectionName: payload?.collection?.name || payload?.source?.name || 'Embedded collection',
    posterUrl: payload?.poster?.previewUrl || null,
    uiPreferences,
    viewerSettings,
    cleanup: null,
  };
};

const rewriteEmbedPayloadForZip = (payload, entries, sourceUrl) => {
  const inlineManifest = isPlainObject(payload?.manifest) ? payload.manifest : null;
  if (!inlineManifest) {
    return buildEmbedPayloadDescriptor(payload, sourceUrl);
  }

  const rewritten = rewriteManifestForZip(inlineManifest, entries, {
    manifestBaseUrl: getEmbedManifestBaseUrl(payload, sourceUrl),
    collectionName: payload?.collection?.name || payload?.source?.name || inlineManifest?.name || 'Embedded collection',
  }).descriptor;

  return {
    ...rewritten,
    uiPreferences: isPlainObject(payload?.uiPreferences) ? payload.uiPreferences : null,
    viewerSettings: isPlainObject(payload?.viewerSettings) ? payload.viewerSettings : null,
  };
};

const buildTransferZipDescriptor = (transferManifest, entries) => {
  const objectUrls = [];
  const sources = Array.isArray(transferManifest?.data?.sources) ? transferManifest.data.sources : [];
  const source = sources.find((item) => item?.type === 'public-url' && (
    item?.config?.manifestUrl || (Array.isArray(item?.config?.assetPaths) && item.config.assetPaths.length > 0)
  )) || null;

  if (!source) {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    throw new Error('Embed payload does not contain a usable readonly public-url collection.');
  }

  const previewUrlMap = buildPreviewUrlMap(transferManifest, entries, objectUrls);
  const manifestUrl = String(source?.config?.manifestUrl || '').trim();

  if (manifestUrl) {
    const firstPreview = previewUrlMap.values().next().value || null;
    return {
      manifestUrl,
      manifest: null,
      manifestBaseUrl: '',
      collectionName: source?.name || transferManifest?.scope?.collectionName || 'Embedded collection',
      posterUrl: firstPreview,
      uiPreferences: null,
      cleanup: () => {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
      },
    };
  }

  return buildSourceConfigDescriptor(source, transferManifest, {
    previewUrlMap,
    cleanup: () => {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    },
  });
};

const normalizeEmbedDescriptor = (payload, sourceUrl, { allowPlainManifest = true } = {}) => {
  if (isPlainObject(payload)
    && payload.app === 'radia-gallery-embed'
    && payload.schemaVersion === 1
    && isPlainObject(payload.source)
    && payload.source.type === 'public-url') {
    return buildEmbedPayloadDescriptor(payload, sourceUrl);
  }

  const transferManifest = extractTransferManifestFromPayload(payload);
  if (transferManifest) {
    const sources = Array.isArray(transferManifest?.data?.sources) ? transferManifest.data.sources : [];
    const source = sources.find((item) => item?.type === 'public-url' && (
      item?.config?.manifestUrl || (Array.isArray(item?.config?.assetPaths) && item.config.assetPaths.length > 0)
    )) || null;
    if (!source) {
      throw new Error('Embed payload does not contain a readonly manifest URL collection.');
    }

    const manifestUrl = String(source?.config?.manifestUrl || '').trim();
    if (!manifestUrl) {
      return buildSourceConfigDescriptor(source, transferManifest);
    }

    return {
      manifestUrl,
      manifest: null,
      manifestBaseUrl: '',
      collectionName: source?.name || transferManifest?.scope?.collectionName || 'Embedded collection',
      posterUrl: null,
      uiPreferences: null,
      cleanup: null,
    };
  }

  if (allowPlainManifest && isPlainObject(payload)) {
    return buildManifestDescriptor(payload, sourceUrl);
  }

  throw new Error('Unsupported embed payload format.');
};

const parsePayloadBuffer = (buffer, sourceUrl) => {
  try {
    const payload = decodeJsonBuffer(buffer);
    return normalizeEmbedDescriptor(payload, sourceUrl);
  } catch (error) {
    if (!isZipBuffer(buffer)) {
      if (looksLikeHtmlDocument(buffer)) {
        throw new Error('Embed URL resolved to an HTML page instead of a ZIP or JSON payload. If you pasted a share link, use the raw hosted ZIP/JSON URL or let embed unwrap the ?import= link.');
      }
      throw new Error(error?.message || 'Failed to parse embed payload JSON.');
    }
  }

  try {
    const entries = unzipSync(new Uint8Array(buffer));
    const manifestEntry = entries['manifest.json'];
    if (!manifestEntry) {
      throw new Error('Missing manifest.json in payload ZIP.');
    }
    const manifest = JSON.parse(strFromU8(manifestEntry));
    const transferManifest = extractTransferManifestFromPayload(manifest);
    if (transferManifest) {
      return buildTransferZipDescriptor(transferManifest, entries);
    }
    if (isPlainObject(manifest)
      && manifest.app === 'radia-gallery-embed'
      && manifest.schemaVersion === 1
      && isPlainObject(manifest.source)
      && manifest.source.type === 'public-url') {
      return rewriteEmbedPayloadForZip(manifest, entries, sourceUrl);
    }
    try {
      return normalizeEmbedDescriptor(manifest, sourceUrl, { allowPlainManifest: false });
    } catch (error) {
      const validation = validatePublicUrlManifest(manifest);
      if (!validation.success) {
        throw error;
      }
      return rewriteManifestForZip(manifest, entries).descriptor;
    }
  } catch (error) {
    throw new Error(error?.message || 'Failed to parse embed payload.');
  }
};

export const resolveEmbedPayloadFromUrl = async (url) => {
  const payloadUrl = resolveImportPayloadUrl(url);
  const buffer = await fetchRemoteBundle(payloadUrl, { maxBytes: MAX_PAYLOAD_BYTES });
  return parsePayloadBuffer(buffer, payloadUrl);
};