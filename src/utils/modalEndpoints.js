// The ml-sharp-optimized backend serves every route from one Modal web app:
//   https://<username>--ml-sharp-optimized-api.modal.run/<route>
const MODAL_APP_NAME = 'ml-sharp-optimized';
const MODAL_API_FUNCTION = 'api';
const DEFAULT_ROUTE = 'process';

const ROUTES = new Set(['process', 'progress', 'cancel', 'results', 'download', 'health']);

// Endpoint names from the old one-function-per-endpoint backend, mapped to routes.
const LEGACY_ROUTE_NAMES = {
  'process-image': 'process',
  'get-progress': 'progress',
  'get-status': 'progress',
  'cancel-job': 'cancel',
  'get-results': 'results',
  'download-result': 'download',
};

export const normalizeModalUsername = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

const normalizeRoute = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (ROUTES.has(normalized)) return normalized;
  return LEGACY_ROUTE_NAMES[normalized] || DEFAULT_ROUTE;
};

export const buildApiBaseUrlFromModalUsername = (username) => {
  const normalizedUsername = normalizeModalUsername(username);
  if (!normalizedUsername) return '';
  return `https://${normalizedUsername}--${MODAL_APP_NAME}-${MODAL_API_FUNCTION}.modal.run`;
};

export const buildApiUrlFromModalUsername = (username, route = DEFAULT_ROUTE) => {
  const base = buildApiBaseUrlFromModalUsername(username);
  if (!base) return '';
  return `${base}/${normalizeRoute(route)}`;
};

export const extractModalUsernameFromApiUrl = (apiUrl) => {
  const raw = String(apiUrl || '').trim();
  if (!raw) return '';

  const withoutProtocol = raw.replace(/^https?:\/\//i, '');
  const host = withoutProtocol.split('/')[0] || '';
  const loweredHost = host.toLowerCase();

  // Matches both the current host (…-api.modal.run) and old per-endpoint hosts.
  const appHostMatch = loweredHost.match(new RegExp(`^([a-z0-9-]+)--${MODAL_APP_NAME}(?:-[a-z0-9-]+)?\\.modal\\.run$`, 'i'));
  if (appHostMatch?.[1]) return normalizeModalUsername(appHostMatch[1]);

  const modalRunMatch = loweredHost.match(/^([a-z0-9-]+)\.modal\.run$/i);
  if (modalRunMatch?.[1]) return normalizeModalUsername(modalRunMatch[1]);

  return '';
};

// Turns a username, or any Modal URL for this app (including saved URLs from the
// old backend), into the URL for `route`. Non-Modal URLs are returned unchanged.
export const ensureModalProcessApiUrl = (value, route = DEFAULT_ROUTE) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const usernameFromUrl = extractModalUsernameFromApiUrl(raw);
  if (usernameFromUrl) {
    return buildApiUrlFromModalUsername(usernameFromUrl, route);
  }

  const maybeUsername = normalizeModalUsername(raw);
  if (maybeUsername && maybeUsername === raw.toLowerCase()) {
    return buildApiUrlFromModalUsername(maybeUsername, route);
  }

  return raw;
};
