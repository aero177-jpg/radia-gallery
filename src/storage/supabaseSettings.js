const STORAGE_KEY = 'supabase-settings';
const MANIFEST_CACHE_PREFIX = 'supabase-manifest-cache:';
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;

const buildManifestCacheKey = ({ supabaseUrl, bucket, collectionId }) =>
  `${MANIFEST_CACHE_PREFIX}${supabaseUrl}::${bucket}::${collectionId}`;

export const loadSupabaseSettings = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.supabaseUrl || !parsed.anonKey || !parsed.bucket) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveSupabaseSettings = (settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};

export const clearSupabaseSettings = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const loadSupabaseManifestCache = (params, { maxAgeMs = MANIFEST_CACHE_TTL_MS } = {}) => {
  try {
    if (!params?.supabaseUrl || !params?.bucket || !params?.collectionId) return null;
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

export const saveSupabaseManifestCache = (params, manifest) => {
  try {
    if (!params?.supabaseUrl || !params?.bucket || !params?.collectionId) return false;
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

export const clearSupabaseManifestCache = (params) => {
  try {
    if (params?.supabaseUrl && params?.bucket && params?.collectionId) {
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