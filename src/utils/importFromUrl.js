/**
 * Remote import utilities.
 * Validates, fetches, and imports a transfer bundle from a public URL.
 */

import { validateTransferBundle, validateTransferManifest, importTransferBundleFromBuffer, importTransferManifest } from './debugTransfer.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export const extractTransferManifestFromPayload = (payload) => {
  const seen = new Set();
  const queue = [payload];
  let depth = 0;

  while (queue.length && depth < 5) {
    const levelSize = queue.length;
    for (let index = 0; index < levelSize; index += 1) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      if (seen.has(current)) continue;
      seen.add(current);

      const check = validateTransferManifest(current);
      if (check.valid) {
        return current;
      }

      if (Array.isArray(current)) {
        for (const item of current) {
          if (item && typeof item === 'object') {
            queue.push(item);
          }
        }
        continue;
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }
    depth += 1;
  }

  return null;
};

/**
 * Basic validation of an import URL.
 * Must be a well-formed HTTPS URL (localhost HTTP allowed for dev).
 */
export const validateImportUrl = (url) => {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required.' };
  }

  const trimmed = url.trim();
  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL is too long (max 2048 characters).' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }

  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    return { valid: false, error: 'URL must use HTTPS.' };
  }

  return { valid: true, error: null };
};

/**
 * Fetch a remote ZIP bundle with size-limit enforcement.
 * Returns an ArrayBuffer on success, throws on failure.
 */
export const fetchRemoteBundle = async (url, { maxBytes = DEFAULT_MAX_BYTES } = {}) => {
  const trimmed = url.trim();

  const response = await fetch(trimmed, { mode: 'cors', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  // Pre-check Content-Length header if available
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    // Abort body consumption
    response.body?.cancel?.();
    throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Maximum is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }

  // Stream-based size guard for servers that omit Content-Length
  if (response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`File too large (exceeded ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit).`);
      }
      chunks.push(value);
    }

    // Concatenate into single ArrayBuffer
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined.buffer;
  }

  // Fallback: use arrayBuffer() for environments without ReadableStream body
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  return buffer;
};

/**
 * Full pipeline: validate URL → fetch → validate ZIP → import.
 * Returns { manifest, summary } on success, throws on failure.
 */
export const importBundleFromUrl = async (url, { maxBytes = DEFAULT_MAX_BYTES } = {}) => {
  // 1. Validate URL
  const urlCheck = validateImportUrl(url);
  if (!urlCheck.valid) {
    throw new Error(urlCheck.error);
  }

  // 2. Fetch the bundle
  const buffer = await fetchRemoteBundle(url, { maxBytes });

  // 3. Try JSON-only import first (lightweight, no preview blobs)
  let parsedJson = null;
  try {
    const text = new TextDecoder().decode(buffer);
    parsedJson = JSON.parse(text);
  } catch {
    // Not valid JSON — fall through to ZIP handling
  }

  if (parsedJson !== null) {
    // Commit to JSON path — don't fall back to ZIP for valid JSON
    const manifest = extractTransferManifestFromPayload(parsedJson);
    if (!manifest) {
      throw new Error('Invalid JSON bundle: no Radia transfer manifest found');
    }
    return importTransferManifest(manifest);
  }

  // 4. Pre-validate as ZIP before committing to import
  const validation = validateTransferBundle(buffer);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // 5. Import as ZIP
  return importTransferBundleFromBuffer(buffer);
};

/**
 * Build a shareable import URL from a remote ZIP location.
 * Uses ?import= query parameter on the current origin.
 */
export const buildShareLink = (zipUrl) => {
  const base = window.location.origin;
  return `${base}?import=${encodeURIComponent(zipUrl.trim())}`;
};

/**
 * Read a pending ?import= URL from the current page URL.
 * Returns the decoded URL string, or null if not present.
 */
export const getImportUrlFromLocation = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('import');
    return value ? decodeURIComponent(value) : null;
  } catch {
    return null;
  }
};

/**
 * Strip the ?import= parameter from the browser URL without navigation.
 */
export const clearImportUrlFromLocation = () => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('import');
    const cleaned = url.pathname + (url.search || '') + url.hash;
    window.history.replaceState(null, '', cleaned);
  } catch {
    // Silently ignore
  }
};
