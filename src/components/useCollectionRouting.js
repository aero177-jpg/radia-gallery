import { useCallback, useEffect, useRef } from 'preact/hooks';
import { useStore } from '../store';
import { loadFromStorageSource } from '../fileLoader';
import { getSource, getSourcesArray } from '../storage/index.js';
import { loadR2Settings } from '../storage/r2Settings.js';
import { resetLandingView } from '../utils/resetLandingView.js';

const normalizeBasePath = (value) => {
  const text = String(value || '/').trim();
  const withLeadingSlash = text.startsWith('/') ? text : `/${text}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
};

const APP_BASE = normalizeBasePath(import.meta.env.BASE_URL || '/');

const normalizePathname = (value) => {
  let path = String(value || '/');
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  return path;
};

const normalizeComparablePath = (value) => {
  const normalized = normalizePathname(value);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const buildAppPath = (segment = '') => {
  const trimmedSegment = String(segment || '').replace(/^\/+/, '');
  if (!trimmedSegment) return APP_BASE;
  return `${APP_BASE}${trimmedSegment}`;
};

const isWithinAppBase = (pathname) => {
  const path = normalizePathname(pathname);
  if (APP_BASE === '/') return true;
  const baseWithoutTrailingSlash = APP_BASE.slice(0, -1);
  return path === baseWithoutTrailingSlash || path.startsWith(APP_BASE);
};

const stripAppBase = (pathname) => {
  const path = normalizePathname(pathname);
  if (APP_BASE === '/') return path;

  const baseWithoutTrailingSlash = APP_BASE.slice(0, -1);
  if (path === baseWithoutTrailingSlash) return '/';
  if (path === APP_BASE) return '/';
  if (path.startsWith(APP_BASE)) {
    return `/${path.slice(APP_BASE.length).replace(/^\/+/, '')}`;
  }
  return null;
};

const normalizeRouteSegment = (value) => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return text.replace(/^-+|-+$/g, '');
};

const getCollectionPathFromSource = (source) => {
  const slug = normalizeRouteSegment(source?.name || source?.id || '');
  if (!slug) return buildAppPath();
  return buildAppPath(encodeURIComponent(slug));
};

const getSinglePathSegment = (pathname) => {
  const relativePath = stripAppBase(pathname);
  if (relativePath == null) return '__out_of_scope__';

  const trimmed = String(relativePath || '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  if (trimmed.includes('/')) return '__invalid__';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return '__invalid__';
  }
};

const findSourceByRouteSegment = (segment, sources) => {
  const normalizedSegment = normalizeRouteSegment(segment);
  if (!normalizedSegment) return null;

  return sources.find((source) => {
    const byName = normalizeRouteSegment(source?.name || '');
    const byId = normalizeRouteSegment(source?.id || '');
    return normalizedSegment === byName || normalizedSegment === byId;
  }) || null;
};

export const useCollectionRouting = ({
  viewerReady,
  activeSourceId,
  setHasDefaultSource,
  setLandingVisible,
  addLog,
  onInitialRouteResolved,
}) => {
  const routeReadyRef = useRef(false);
  const routeSyncInFlightRef = useRef(false);
  const initialRouteResolvedRef = useRef(false);
  const applyPathRouteRef = useRef(null);

  const markInitialRouteResolved = useCallback(() => {
    if (initialRouteResolvedRef.current) return;
    initialRouteResolvedRef.current = true;
    onInitialRouteResolved?.();
  }, [onInitialRouteResolved]);

  const navigateHome = useCallback((replace = false) => {
    const homePath = buildAppPath();

    // If somehow outside app base, do a hard redirect back into scope.
    if (!isWithinAppBase(window.location.pathname)) {
      window.location.replace(homePath);
      return;
    }

    // In-scope: avoid full document navigation (keeps PWA shell behavior stable).
    if (normalizeComparablePath(window.location.pathname) !== normalizeComparablePath(homePath)) {
      const state = { ...window.history.state };
      if (replace) {
        window.history.replaceState(state, '', homePath);
      } else {
        window.history.pushState(state, '', homePath);
      }
    }

    resetLandingView({
      setHasDefaultSource,
      setLandingVisible,
    });
  }, [setHasDefaultSource, setLandingVisible]);

  const syncPathToActiveSource = useCallback((source, replace = false) => {
    const targetPath = source ? getCollectionPathFromSource(source) : buildAppPath();
    if (normalizeComparablePath(window.location.pathname) === normalizeComparablePath(targetPath)) return;
    if (!isWithinAppBase(targetPath)) return;

    const state = { ...window.history.state };
    if (replace) {
      window.history.replaceState(state, '', targetPath);
    } else {
      window.history.pushState(state, '', targetPath);
    }
  }, []);

  const applyPathRoute = useCallback(async (replaceInvalid = true) => {
    const segment = getSinglePathSegment(window.location.pathname);
    const isHomeLikeRoute = segment === '__out_of_scope__' || segment === '__invalid__' || !segment;

    if (isHomeLikeRoute) {
      navigateHome(replaceInvalid);
      markInitialRouteResolved();
      return;
    }

    const sources = getSourcesArray();
    const matchedSource = findSourceByRouteSegment(segment, sources);
    if (!matchedSource) {
      navigateHome(replaceInvalid);
      markInitialRouteResolved();
      return;
    }

    const r2Settings = loadR2Settings();
    const isR2Locked = matchedSource?.type === 'r2-bucket'
      && Boolean(r2Settings?.requiresPassword)
      && r2Settings?.accountId === matchedSource?.config?.config?.accountId
      && r2Settings?.bucket === matchedSource?.config?.config?.bucket;

    try {
      routeSyncInFlightRef.current = true;
      setLandingVisible(false);

      if (isR2Locked) {
        const state = useStore.getState();
        state.setAssets([]);
        state.setCurrentAssetIndex(-1);
        state.setActiveSourceId(matchedSource.id);
        setHasDefaultSource(false);
        setLandingVisible(false);
        syncPathToActiveSource(matchedSource, true);
        return;
      }

      if (!matchedSource.isConnected()) {
        const result = await matchedSource.connect(false);
        if (!result?.success) {
          navigateHome(true);
          return;
        }
      }

      await loadFromStorageSource(matchedSource);
      syncPathToActiveSource(matchedSource, true);
    } catch (err) {
      addLog('Failed to load route collection: ' + (err?.message || err));
      navigateHome(true);
    } finally {
      routeSyncInFlightRef.current = false;
      markInitialRouteResolved();
    }
  }, [addLog, navigateHome, setLandingVisible, syncPathToActiveSource, markInitialRouteResolved]);

  useEffect(() => {
    applyPathRouteRef.current = applyPathRoute;
  }, [applyPathRoute]);

  useEffect(() => {
    if (!viewerReady || routeReadyRef.current) return;

    routeReadyRef.current = true;
    void applyPathRouteRef.current?.(true);

    const handlePopState = () => {
      void applyPathRouteRef.current?.(true);
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [viewerReady]);

  useEffect(() => {
    if (!routeReadyRef.current || routeSyncInFlightRef.current) return;

    if (!activeSourceId) {
      syncPathToActiveSource(null, false);
      return;
    }

    const source = getSource(activeSourceId);
    if (!source) return;
    syncPathToActiveSource(source, false);
  }, [activeSourceId, syncPathToActiveSource]);
};


