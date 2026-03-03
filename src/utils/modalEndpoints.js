const MODAL_APP_NAME = 'ml-sharp-optimized';
const DEFAULT_PROCESS = 'process-image';

export const normalizeModalUsername = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

const normalizeProcessName = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || DEFAULT_PROCESS;
};

export const buildApiUrlFromModalUsername = (username, processName = DEFAULT_PROCESS) => {
  const normalizedUsername = normalizeModalUsername(username);
  if (!normalizedUsername) return '';
  const process = normalizeProcessName(processName);
  return `https://${normalizedUsername}--${MODAL_APP_NAME}-${process}.modal.run`;
};

export const extractModalUsernameFromApiUrl = (apiUrl) => {
  const raw = String(apiUrl || '').trim();
  if (!raw) return '';

  const withoutProtocol = raw.replace(/^https?:\/\//i, '');
  const host = withoutProtocol.split('/')[0] || '';
  const loweredHost = host.toLowerCase();

  const appHostMatch = loweredHost.match(new RegExp(`^([a-z0-9-]+)--${MODAL_APP_NAME}(?:-[a-z0-9-]+)?\\.modal\\.run$`, 'i'));
  if (appHostMatch?.[1]) return normalizeModalUsername(appHostMatch[1]);

  const modalRunMatch = loweredHost.match(/^([a-z0-9-]+)\.modal\.run$/i);
  if (modalRunMatch?.[1]) return normalizeModalUsername(modalRunMatch[1]);

  return '';
};

export const ensureModalProcessApiUrl = (value, processName = DEFAULT_PROCESS) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const usernameFromUrl = extractModalUsernameFromApiUrl(raw);
  if (usernameFromUrl) {
    return buildApiUrlFromModalUsername(usernameFromUrl, processName);
  }

  const maybeUsername = normalizeModalUsername(raw);
  if (maybeUsername && maybeUsername === raw.toLowerCase()) {
    return buildApiUrlFromModalUsername(maybeUsername, processName);
  }

  return raw;
};
