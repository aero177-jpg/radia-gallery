import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faSpinner } from '@fortawesome/free-solid-svg-icons';
import Viewer from './Viewer.jsx';
import EmbedAssetSidebar from './EmbedAssetSidebar.jsx';
import EmbedBottomControls from './EmbedBottomControls.jsx';
import SlideshowOptionsModal from './SlideshowOptionsModal.jsx';
import useMobileState from '../utils/useMobileState.js';
import useHasMesh from '../utils/useHasMesh.js';
import { useStore } from '../store.js';
import { initViewer, startRenderLoop } from '../viewer.js';
import { resize } from '../fileLoader.js';
import { createTransientPublicUrlSource } from '../embed/TransientPublicUrlSource.js';
import { resolveEmbedPayloadFromUrl } from '../embed/embedPayload.js';
import { loadEmbedAssetByIndex, loadEmbedSource } from '../embed/embedLoader.js';

const parseEmbedUrl = () => {
  const params = new URLSearchParams(window.location.search || '');
  return {
    payload: params.get('payload') || '',
    src: params.get('src') || params.get('manifest') || '',
    autoplay: ['1', 'true', 'yes', 'on'].includes(String(params.get('autoplay') || '').toLowerCase()),
  };
};

function EmbedApp() {
  const setMobileState = useStore((state) => state.setMobileState);
  const setStatus = useStore((state) => state.setStatus);
  const setAppBgColor = useStore((state) => state.setAppBgColor);
  const setDisableTransparentUi = useStore((state) => state.setDisableTransparentUi);
  const setCameraRange = useStore((state) => state.setCameraRange);
  const setQualityPreset = useStore((state) => state.setQualityPreset);
  const setSlideshowDuration = useStore((state) => state.setSlideshowDuration);
  const setTransitionSpeed = useStore((state) => state.setTransitionSpeed);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);

  const [viewerReady, setViewerReady] = useState(false);
  const [collectionName, setCollectionName] = useState('Embedded collection');
  const [loadError, setLoadError] = useState('');
  const [posterDismissed, setPosterDismissed] = useState(false);
  const [loadingPosterPlayback, setLoadingPosterPlayback] = useState(false);
  const [payloadPosterUrl, setPayloadPosterUrl] = useState('');
  const [slideshowOptionsOpen, setSlideshowOptionsOpen] = useState(false);

  const hasMesh = useHasMesh();
  const embedParams = useMemo(() => {
    if (typeof window === 'undefined') {
      return { src: '', autoplay: false };
    }
    return parseEmbedUrl();
  }, []);

  useMobileState({ setMobileState });

  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    initViewer(viewerEl);
    startRenderLoop();
    setViewerReady(true);

    window.addEventListener('resize', resize);
    resize();
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    if (!viewerReady) return;
    if (!embedParams.src && !embedParams.payload) {
      setLoadError('Missing embed source. Pass ?src=<manifest-url> or ?payload=<config-url>.');
      return;
    }

    let cancelled = false;
    let cleanupPayloadResources = null;

    const bootstrap = async () => {
      try {
        setLoadError('');
        let manifestUrl = embedParams.src;
        let manifest = null;
        let manifestBaseUrl = '';
        let initialCollectionName = 'Embedded collection';
        let initialPosterUrl = '';

        if (embedParams.payload) {
          const payload = await resolveEmbedPayloadFromUrl(embedParams.payload);
          manifestUrl = payload.manifestUrl;
          manifest = payload.manifest || null;
          manifestBaseUrl = payload.manifestBaseUrl || '';
          initialCollectionName = payload.collectionName || initialCollectionName;
          initialPosterUrl = payload.posterUrl || '';
          cleanupPayloadResources = typeof payload.cleanup === 'function' ? payload.cleanup : null;

          const uiPreferences = payload.uiPreferences || {};
          const viewerSettings = payload.viewerSettings || {};
          if (typeof viewerSettings.qualityPreset === 'string' && viewerSettings.qualityPreset) {
            setQualityPreset(viewerSettings.qualityPreset);
          }
          if (Number.isFinite(viewerSettings.cameraRange)) {
            setCameraRange(viewerSettings.cameraRange);
          }
          if (typeof uiPreferences.appBgColor === 'string' && uiPreferences.appBgColor) {
            setAppBgColor(uiPreferences.appBgColor);
          }
          if (typeof uiPreferences.disableTransparentUi === 'boolean') {
            setDisableTransparentUi(uiPreferences.disableTransparentUi);
          }
          if (Number.isFinite(uiPreferences?.animation?.slideshowDuration)) {
            setSlideshowDuration(uiPreferences.animation.slideshowDuration);
          }
          if (typeof uiPreferences?.animation?.transitionSpeed === 'string') {
            setTransitionSpeed(uiPreferences.animation.transitionSpeed);
          }
        }

        if (!manifestUrl && !manifest) {
          throw new Error('Embed payload did not provide a usable manifest.');
        }

        setCollectionName(initialCollectionName);
        setPayloadPosterUrl(initialPosterUrl);

        const source = createTransientPublicUrlSource({
          manifestUrl,
          manifest,
          baseUrl: manifestBaseUrl,
          name: initialCollectionName,
        });
        const result = await loadEmbedSource(source, { autoload: false, preferredIndex: 0 });
        if (cancelled) return;

        setCollectionName(source.name || 'Embedded collection');
        document.title = source.name ? `${source.name} | Radia Embed` : 'Radia Embed';

        if (!result.assets.length) {
          setLoadError('This collection does not contain any supported assets.');
          return;
        }

        if (embedParams.autoplay) {
          setLoadingPosterPlayback(true);
          try {
            await loadEmbedAssetByIndex(result.preferredIndex);
            setPosterDismissed(true);
          } finally {
            if (!cancelled) {
              setLoadingPosterPlayback(false);
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = error?.message || 'Failed to load embedded collection.';
          setLoadError(message);
          setStatus(message);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      cleanupPayloadResources?.();
    };
  }, [
    embedParams.autoplay,
    embedParams.payload,
    embedParams.src,
    setAppBgColor,
    setCameraRange,
    setDisableTransparentUi,
    setQualityPreset,
    setSlideshowDuration,
    setStatus,
    setTransitionSpeed,
    viewerReady,
  ]);

  useEffect(() => {
    if (hasMesh) {
      setPosterDismissed(true);
      setLoadingPosterPlayback(false);
    }
  }, [hasMesh]);

  const currentAsset = currentAssetIndex >= 0 ? assets[currentAssetIndex] : assets[0] || null;
  const posterUrl = currentAsset?.preview || payloadPosterUrl || '';
  const showPoster = !loadError && !posterDismissed && !hasMesh && assets.length > 0;

  const handlePlay = useCallback(async () => {
    if (!assets.length || loadingPosterPlayback) return;
    setLoadingPosterPlayback(true);
    setLoadError('');

    try {
      const index = currentAssetIndex >= 0 ? currentAssetIndex : 0;
      await loadEmbedAssetByIndex(index);
      setPosterDismissed(true);
    } catch (error) {
      setLoadError(error?.message || 'Failed to load the selected scene.');
    } finally {
      setLoadingPosterPlayback(false);
    }
  }, [assets.length, currentAssetIndex, loadingPosterPlayback]);

  return (
    <div class="page embed-page">
      <EmbedAssetSidebar />
      <Viewer viewerReady={viewerReady} dropOverlay={null} />

      {showPoster && (
        <div class="embed-poster-overlay">
          {posterUrl ? (
            <img class="embed-poster-image" src={posterUrl} alt={collectionName} />
          ) : (
            <div class="embed-poster-fallback" aria-hidden="true" />
          )}
          <div class="embed-poster-scrim" />
          <div class="embed-poster-content">
            {/* <div class="embed-poster-kicker">Gallery</div> */}
            <h2 class="embed-poster-title">{collectionName}</h2>
            <button
              type="button"
              style={{marginTop: "10px"}}
              class="embed-poster-play"
              onClick={() => void handlePlay()}
              disabled={loadingPosterPlayback}
            >
              <span class="embed-poster-play-icon">
                <FontAwesomeIcon icon={loadingPosterPlayback ? faSpinner : faPlay} spin={loadingPosterPlayback} />
              </span>
              <span>{loadingPosterPlayback ? 'Loading scene...' : 'Start gallery'}</span>
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div class="embed-status-overlay embed-status-overlay-error">
          <div class="embed-status-card">
            <div class="embed-status-title">Embed unavailable</div>
            <div class="embed-status-text">{loadError}</div>
          </div>
        </div>
      )}

      <EmbedBottomControls onOpenSlideshowOptions={() => setSlideshowOptionsOpen(true)} />
      <SlideshowOptionsModal
        isOpen={slideshowOptionsOpen}
        onClose={() => setSlideshowOptionsOpen(false)}
      />
    </div>
  );
}

export default EmbedApp;