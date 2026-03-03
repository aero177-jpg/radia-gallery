const VAULT_META_KEY = 'credential-vault-meta';
const R2_SETTINGS_KEY = 'r2-settings';
const CLOUD_GPU_SETTINGS_KEY = 'cloud-gpu-settings';

const R2_SECRET_ID = 'r2-secret';
const CLOUD_GPU_KEY_ID = 'cloud-gpu-key';

const VAULT_VERSION = 1;
const DEFAULT_ITERATIONS = 250000;
const MAGIC_TEXT = 'browser-sharp-vault-check';

let sessionPassword = null;
const unlockedSecrets = new Map();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
};

const fromBase64 = (value) => {
  const binary = atob(value || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const getCrypto = () => {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Secure browser crypto is unavailable in this environment.');
  }
  return window.crypto;
};

const deriveAesKey = async (password, salt, iterations = DEFAULT_ITERATIONS) => {
  const crypto = getCrypto();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

const encryptValue = async (plaintext, password) => {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, DEFAULT_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(String(plaintext || ''))
  );

  return {
    version: VAULT_VERSION,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2',
    iterations: DEFAULT_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
};

const decryptValue = async (payload, password) => {
  const key = await deriveAesKey(
    password,
    fromBase64(payload.salt),
    Number(payload.iterations) || DEFAULT_ITERATIONS
  );

  const plaintext = await getCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ciphertext)
  );

  return textDecoder.decode(plaintext);
};

const parseJsonStorage = (key) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const saveVaultMeta = (meta) => {
  localStorage.setItem(VAULT_META_KEY, JSON.stringify(meta));
};

const getVaultMeta = () => parseJsonStorage(VAULT_META_KEY);

export const isEncryptedCredentialPayload = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Boolean(
    value.algorithm === 'AES-GCM' &&
    value.kdf === 'PBKDF2' &&
    value.salt &&
    value.iv &&
    value.ciphertext
  );
};

const verifyPasswordWithMeta = async (password, meta) => {
  if (!meta?.verifier || !isEncryptedCredentialPayload(meta.verifier)) return false;
  try {
    const resolved = await decryptValue(meta.verifier, password);
    return resolved === MAGIC_TEXT;
  } catch {
    return false;
  }
};

const ensureVaultPassword = async (password) => {
  const normalized = String(password || '').trim();
  if (!normalized) {
    return { success: false, error: 'Password is required.' };
  }

  const meta = getVaultMeta();
  if (!meta?.verifier) {
    const verifier = await encryptValue(MAGIC_TEXT, normalized);
    saveVaultMeta({ version: VAULT_VERSION, verifier, updatedAt: Date.now() });
    sessionPassword = normalized;
    return { success: true, created: true };
  }

  const ok = await verifyPasswordWithMeta(normalized, meta);
  if (!ok) {
    return { success: false, error: 'Password does not match the existing vault password.' };
  }

  sessionPassword = normalized;
  return { success: true, created: false };
};

export const hasVaultPassword = () => {
  const meta = getVaultMeta();
  return Boolean(meta?.verifier && isEncryptedCredentialPayload(meta.verifier));
};

export const isVaultUnlocked = () => Boolean(sessionPassword);

export const getUnlockedSecret = (secretId) => {
  const value = unlockedSecrets.get(secretId);
  return typeof value === 'string' ? value : null;
};

export const clearVaultSession = () => {
  sessionPassword = null;
  unlockedSecrets.clear();
};

const tryDecryptStoredSecret = async (parsedSettings, encryptedField, secretId, password) => {
  const payload = parsedSettings?.[encryptedField];
  if (!isEncryptedCredentialPayload(payload)) return;
  const decrypted = await decryptValue(payload, password);
  unlockedSecrets.set(secretId, decrypted);
};

export const unlockCredentialVault = async (password) => {
  const verified = await ensureVaultPassword(password);
  if (!verified.success) return verified;

  try {
    const r2Settings = parseJsonStorage(R2_SETTINGS_KEY);
    const cloudGpuSettings = parseJsonStorage(CLOUD_GPU_SETTINGS_KEY);

    await tryDecryptStoredSecret(r2Settings, 'secretAccessKeyEncrypted', R2_SECRET_ID, sessionPassword);
    await tryDecryptStoredSecret(cloudGpuSettings, 'apiKeyEncrypted', CLOUD_GPU_KEY_ID, sessionPassword);

    return { success: true, created: verified.created };
  } catch {
    clearVaultSession();
    return { success: false, error: 'Failed to decrypt encrypted credentials with this password.' };
  }
};

export const encryptCredentialValue = async (secretId, plaintext, password) => {
  const resolvedPassword = String(password || sessionPassword || '').trim();
  const verified = await ensureVaultPassword(resolvedPassword);
  if (!verified.success) {
    throw new Error(verified.error || 'Failed to verify vault password.');
  }

  const payload = await encryptValue(plaintext, resolvedPassword);
  unlockedSecrets.set(secretId, String(plaintext || ''));
  return payload;
};

export const getVaultSecretIds = () => ({
  r2: R2_SECRET_ID,
  cloudGpu: CLOUD_GPU_KEY_ID,
});
