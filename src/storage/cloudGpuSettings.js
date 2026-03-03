/**
 * Cloud GPU settings persistence
 * Stores API URL and API Key for the image conversion service.
 */

import { getUnlockedSecret, getVaultSecretIds, isEncryptedCredentialPayload } from './credentialVault.js';

const STORAGE_KEY = 'cloud-gpu-settings';
const ALLOWED_BATCH_SIZES = [3, 5, 10, 15, 20];

const normalizeBatchSize = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return ALLOWED_BATCH_SIZES.includes(numeric) ? numeric : 10;
};

export const loadCloudGpuSettings = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const hasPlainApiKey = Boolean(String(parsed.apiKey || '').trim());
    const hasEncryptedApiKey = isEncryptedCredentialPayload(parsed.apiKeyEncrypted);
    const hasStoredApiKey = hasPlainApiKey || hasEncryptedApiKey;
    const resolvedApiKey = hasEncryptedApiKey
      ? (getUnlockedSecret(getVaultSecretIds().cloudGpu) || '')
      : String(parsed.apiKey || '').trim();

    if (!parsed.apiUrl || !hasStoredApiKey) return null;

    return {
      ...parsed,
      apiKey: resolvedApiKey,
      hasStoredApiKey,
      requiresPassword: Boolean(hasEncryptedApiKey && !resolvedApiKey),
      isEncrypted: hasEncryptedApiKey,
      batchUploads: Boolean(parsed.batchUploads),
      batchSize: normalizeBatchSize(parsed.batchSize),
    };
  } catch {
    return null;
  }
};

export const saveCloudGpuSettings = (settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};

export const clearCloudGpuSettings = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
