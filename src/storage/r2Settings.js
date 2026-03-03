import { getUnlockedSecret, getVaultSecretIds, isEncryptedCredentialPayload } from './credentialVault.js';

const STORAGE_KEY = 'r2-settings';
const MANIFEST_CACHE_PREFIX = 'r2-manifest-cache:';
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_PERMISSIONS = {
  canRead: true,
  canWrite: true,
  canDelete: true,
};

const normalizePermissions = (value) => {
  const next = {
    ...DEFAULT_PERMISSIONS,
    ...(value || {}),
  };

  next.canRead = next.canRead !== false;
  next.canWrite = !!next.canWrite;
  next.canDelete = !!next.canDelete;
  next.canRead = true;
  return next;
};

const buildManifestCacheKey = ({ accountId, bucket, collectionId }) =>
  `${MANIFEST_CACHE_PREFIX}${accountId}::${bucket}::${collectionId}`;

export const loadR2Settings = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const permissions = normalizePermissions(parsed.permissions);
    if (!permissions.canRead) {
      return null;
    }

    const hasEncryptedSecret = isEncryptedCredentialPayload(parsed.secretAccessKeyEncrypted);
    const resolvedSecret = hasEncryptedSecret
      ? (getUnlockedSecret(getVaultSecretIds().r2) || '')
      : String(parsed.secretAccessKey || '').trim();

    if (!parsed.accountId || !parsed.accessKeyId || (!resolvedSecret && !hasEncryptedSecret) || !parsed.bucket) {
      return null;
    }

    return {
      ...parsed,
      secretAccessKey: resolvedSecret,
      requiresPassword: Boolean(hasEncryptedSecret && !resolvedSecret),
      isEncrypted: hasEncryptedSecret,
      permissions,
    };
  } catch {
    return null;
  }
};

export const saveR2Settings = (settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};

export const clearR2Settings = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const loadR2ManifestCache = (params, { maxAgeMs = MANIFEST_CACHE_TTL_MS } = {}) => {
  try {
    if (!params?.accountId || !params?.bucket || !params?.collectionId) return null;
    const raw = localStorage.getItem(buildManifestCacheKey(params));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.manifest || !parsed?.updatedAt) return null;
    if (typeof maxAgeMs === 'number' && maxAgeMs >= 0) {
      if (Date.now() - parsed.updatedAt > maxAgeMs) return null;
    }
    return parsed.manifest;
  } catch {
    return null;
  }
};

export const saveR2ManifestCache = (params, manifest) => {
  try {
    if (!params?.accountId || !params?.bucket || !params?.collectionId) return false;
    if (!manifest) return false;
    const payload = JSON.stringify({
      updatedAt: Date.now(),
      manifest,
    });
    localStorage.setItem(buildManifestCacheKey(params), payload);
    return true;
  } catch {
    return false;
  }
};

export const clearR2ManifestCache = (params) => {
  try {
    if (params?.accountId && params?.bucket && params?.collectionId) {
      localStorage.removeItem(buildManifestCacheKey(params));
      return;
    }

    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(MANIFEST_CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
};
