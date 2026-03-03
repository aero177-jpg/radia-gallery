/**
 * Main App component.
 * Root component that initializes the Three.js viewer and
 * orchestrates the main layout (viewer + side panel/mobile sheet).
 */

import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { useStore } from '../store';
import Viewer from './Viewer';
import TitleCard from './TitleCard';
import SidePanel from './SidePanel';
import MobileSheet from './MobileSheet';
import AssetSidebar from './AssetSidebar';
import { initViewer, startRenderLoop, requestRender } from '../viewer';
import { resize, loadFromStorageSource, loadNextAsset, loadPrevAsset } from '../fileLoader';
import { resetViewWithImmersive } from '../cameraUtils';
import useOutsideClick from '../utils/useOutsideClick';

import { initVrSupport } from '../vrMode';
import { loadR2Settings } from '../storage/r2Settings.js';
import ConnectStorageDialog from './ConnectStorageDialog';
import ControlsModal from './ControlsModal';
import { useCollectionUploadFlow } from './useCollectionUploadFlow.js';
import { useViewerDrop } from './useViewerDrop.jsx';
import PwaReloadPrompt from './PwaReloadPrompt';
import PwaInstallPrompt from './PwaInstallPrompt';
import SlideshowOptionsModal from './SlideshowOptionsModal';
import AddDemoCollectionsModal from './AddDemoCollectionsModal';
import { useCollectionRouting } from './useCollectionRouting.js';
import { getImportUrlFromLocation, clearImportUrlFromLocation } from '../utils/importFromUrl.js';
import ImportFromUrlModal from './ImportFromUrlModal';
import { resetLandingView } from '../utils/resetLandingView.js';
import BottomControls from './BottomControls';
import useMobileState from '../utils/useMobileState';
import { fadeInViewer, fadeOutViewer, restoreViewerVisibility } from '../utils/viewerFade';
import useDemoCollections from './useDemoCollections';

/** Delay before resize after panel toggle animation completes */
const PANEL_TRANSITION_MS = 350;

const normalizeBasePath = (value) => {
  const text = String(value || '/').trim();
  const withLeadingSlash = text.startsWith('/') ? text : `/${text}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
};

const APP_BASE = normalizeBasePath(import.meta.env.BASE_URL || '/');

const isHomePath = (pathname) => {
  const path = String(pathname || '/');
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;

  if (APP_BASE === '/') {
    return withLeadingSlash === '/';
  }

  const baseWithoutTrailingSlash = APP_BASE.slice(0, -1);
  return withLeadingSlash === APP_BASE || withLeadingSlash === baseWithoutTrailingSlash;
};

const isForceTitleEnabled = () => {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  if (!params.has('forcetitle')) return false;

  const rawValue = params.get('forcetitle');
  if (rawValue == null || rawValue === '') return true;

  const normalized = String(rawValue).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
};

function App() {
  // Store state
  const panelOpen = useStore((state) => state.panelOpen);
  const isMobile = useStore((state) => state.isMobile);
  const isPortrait = useStore((state) => state.isPortrait);
  const setMobileState = useStore((state) => state.setMobileState);
  const togglePanel = useStore((state) => state.togglePanel);
  const assets = useStore((state) => state.assets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const setActiveSourceId = useStore((state) => state.setActiveSourceId);
  const setAssets = useStore((state) => state.setAssets);
  const setStatus = useStore((state) => state.setStatus);
  const addLog = useStore((state) => state.addLog);
  const activeSourceId = useStore((state) => state.activeSourceId);
  const focusSettingActive = useStore((state) => state.focusSettingActive);
  const customMetadataControlsVisible = useStore((state) => state.customMetadataControlsVisible);
  const controlsModalOpen = useStore((state) => state.controlsModalOpen);
  const setControlsModalOpen = useStore((state) => state.setControlsModalOpen);
  const controlsModalDefaultSubsections = useStore((state) => state.controlsModalDefaultSubsections);
  const metadataMissing = useStore((state) => state.metadataMissing);
  const appBgColor = useStore((state) => state.appBgColor);
  const expandedViewer = useStore((state) => state.expandedViewer);
  
  // Local state for viewer initialization
  const [viewerReady, setViewerReady] = useState(false);
  const [startedFromCollectionRoute] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !isHomePath(window.location.pathname);
  });
  // Landing screen visibility (controls TitleCard fade-in/out)
  const [landingVisible, setLandingVisible] = useState(() => assets.length === 0 && !activeSourceId);
  const [routingResolved, setRoutingResolved] = useState(() => {
    if (typeof window === 'undefined') return false;
    return isHomePath(window.location.pathname);
  });
  const [forceTitleEnabled, setForceTitleEnabled] = useState(() => isForceTitleEnabled());
  const handleInitialRouteResolved = useCallback(() => {
    setRoutingResolved(true);
  }, []);
  const [hasDefaultSource, setHasDefaultSource] = useState(false);
  const isLandingEmptyState = landingVisible && assets.length === 0 && !activeSourceId;
  const showLandingOverlay = routingResolved && isLandingEmptyState;
  const showViewerUi = routingResolved && !isLandingEmptyState;
  
  // File input + storage dialog state for title card actions
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);
  const [storageDialogInitialTier, setStorageDialogInitialTier] = useState(null);

  const [slideshowOptionsOpen, setSlideshowOptionsOpen] = useState(false);

  // Remote import via ?import= query param
  const [pendingImportUrl, setPendingImportUrl] = useState(null);

  // Outside click handler to close side panel
  // Disabled when focus-setting mode or custom view editor is active to prevent accidental closure
  useOutsideClick(
    togglePanel,
    ['.side', '.mobile-sheet', '.panel-toggle', '.bottom-page-btn', '.bottom-controls', '.modal-overlay', '.modal-content'],
    panelOpen && !focusSettingActive && !customMetadataControlsVisible
  );

  const {
    demoCollectionsModalOpen,
    setDemoCollectionsModalOpen,
    handleLoadDemo,
    handleInstallDemoCollections,
    demoCollectionOptions,
  } = useDemoCollections({
    addLog,
    setLandingVisible,
    panelTransitionMs: PANEL_TRANSITION_MS,
  });

  // Document-level horizontal swipe detection for asset navigation.
  // Listens on document so no z-index or pointer-events issues can block it.
  // Only triggers when the touch starts in the bottom 20% of the viewport.
  useEffect(() => {
    const BOTTOM_ZONE_FRACTION = 0.20;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;

    const isBlockedSwipeTarget = (eventTarget) => {
      if (!(eventTarget instanceof Element)) return false;
      return Boolean(eventTarget.closest('.fov-overlay, .fov-overlay-slider'));
    };

    const handleTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      if (isBlockedSwipeTarget(e.target)) return;
      const t = e.touches[0];
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (t.clientY < vh * (1 - BOTTOM_ZONE_FRACTION)) return;
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      tracking = true;
    };

    const handleTouchEnd = (e) => {
      if (!tracking) return;
      tracking = false;

      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Math.max(1, Date.now() - startTime);
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const velocity = absDx / dt; // px/ms

      // Horizontal swipe: distance threshold OR fast flick
      const isHorizontalSwipe =
        absDy < 80 &&
        (absDx > 30 || (velocity > 0.25 && absDx > 12));

      if (isHorizontalSwipe && assets.length > 1) {
        if (dx < 0) loadNextAsset();
        else loadPrevAsset();
      }
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [assets.length]);

  const handleDeviceRotate = useCallback(async () => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    try {
      await fadeOutViewer(viewerEl);
      fadeInViewer(viewerEl, { resize, requestRender, settleMs: 0 });
    } catch (err) {
      console.warn('Device rotation handling failed:', err);
      restoreViewerVisibility(viewerEl);
    }
  }, [resize, requestRender]);

  /**
   * Title card actions: file picker
   */
  const {
    uploadInputRef,
    uploadAccept,
    openUploadPicker,
    handleUploadChange,
    uploadModal,
    handleAssets,
    handleImages,
  } = useCollectionUploadFlow({
    queueAction: 'replace',
    allowAssets: true,
    allowImages: true,
    onError: (message) => setStatus(message),
  });

  const handlePickFile = useCallback(() => {
    (async () => {
      await new Promise((r) => setTimeout(r, PANEL_TRANSITION_MS));
      openUploadPicker();
    })();
  }, [openUploadPicker]);

  /**
   * Title card actions: storage dialog
   */
  const handleOpenStorage = useCallback(() => {
    (async () => {
      await new Promise((r) => setTimeout(r, PANEL_TRANSITION_MS));
      setStorageDialogInitialTier(null);
      setStorageDialogOpen(true);
    })();
  }, []);

  const handleCloseStorage = useCallback(() => {
    setStorageDialogOpen(false);
    setStorageDialogInitialTier(null);
  }, []);

  const handleSourceConnect = useCallback(async (source) => {
    setStorageDialogOpen(false);
    setStorageDialogInitialTier(null);
    try {
      await loadFromStorageSource(source);
    } catch (err) {
      addLog('Failed to load from storage: ' + (err?.message || err));
    }
  }, [addLog]);

  /**
   * Handle selecting a source from the collections modal.
   * Hard-cuts to invisible, awaits the full asset load (so the viewer's own
   * fade-in happens while the page is hidden), then smoothly fades the page
   * back in for a single clean reveal.
   */
  const handleSelectSource = useCallback(async (source) => {
    const FADE_IN_MS = 300;
    const pageEl = document.querySelector('.page');

    // 1. Instant hard cut — hide everything in one frame
    if (pageEl) {
      pageEl.style.transition = 'none';
      pageEl.style.opacity = '0';
    }

    // 2. Perform state changes while page is invisible
    try {
      setLandingVisible(false);

      const r2Settings = loadR2Settings();
      const isR2Locked = source?.type === 'r2-bucket'
        && Boolean(r2Settings?.requiresPassword)
        && r2Settings?.accountId === source?.config?.config?.accountId
        && r2Settings?.bucket === source?.config?.config?.bucket;

      if (isR2Locked) {
        setAssets([]);
        setCurrentAssetIndex(-1);
        setActiveSourceId(source.id);
      } else {
        // Await the full load so the viewer's slide-in completes while hidden
        await loadFromStorageSource(source);
      }
    } catch (err) {
      addLog('Failed to load from source: ' + (err?.message || err));
      console.warn('Failed to load from source:', err);
    }

    // 3. Extra settle time after first load so the splat renderer stabilises
    await new Promise((r) => setTimeout(r, 350));
    requestAnimationFrame(() => {
      if (pageEl) {
        pageEl.style.transition = `opacity ${FADE_IN_MS}ms ease-in`;
        pageEl.style.opacity = '1';
        setTimeout(() => {
          if (pageEl) pageEl.style.transition = '';
        }, FADE_IN_MS);
      }
    });
  }, [addLog, setActiveSourceId, setAssets, setCurrentAssetIndex]);

  /**
   * Handle opening cloud GPU dialog from collections modal
   */
  const handleOpenCloudGpu = useCallback(() => {
    setStorageDialogInitialTier('cloud-gpu');
    setStorageDialogOpen(true);
  }, []);

  useMobileState({
    setMobileState,
    onRotate: handleDeviceRotate,
  });

  const { dropOverlay, dropModal } = useViewerDrop({
    activeSourceId,
    setStatus,
    handleAssets,
    handleImages,
  });

  /**
   * Initialize Three.js viewer on mount.
   * Sets up renderer, camera, controls, and render loop.
   */
  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;
    
    initViewer(viewerEl);
    startRenderLoop();
    void initVrSupport(viewerEl);
    setViewerReady(true);
    
    // Handle window resize
    window.addEventListener('resize', resize);
    resize();
    
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);

  useCollectionRouting({
    viewerReady,
    activeSourceId,
    setHasDefaultSource,
    setLandingVisible,
    addLog,
    onInitialRouteResolved: handleInitialRouteResolved,
  });

  useEffect(() => {
    const syncForceTitleFromLocation = () => {
      setForceTitleEnabled(isForceTitleEnabled());
    };

    window.addEventListener('popstate', syncForceTitleFromLocation);
    window.addEventListener('hashchange', syncForceTitleFromLocation);
    return () => {
      window.removeEventListener('popstate', syncForceTitleFromLocation);
      window.removeEventListener('hashchange', syncForceTitleFromLocation);
    };
  }, []);

  // Detect ?import= query parameter once the viewer is ready
  useEffect(() => {
    if (!viewerReady) return;
    const url = getImportUrlFromLocation();
    if (url) {
      setPendingImportUrl(url);
    }
  }, [viewerReady]);

  // Keep landingVisible in sync: show when no assets, hide when assets present
  useEffect(() => {
    if (hasDefaultSource) {
      setLandingVisible(false);
      return;
    }
    if (assets.length === 0 && !activeSourceId) {
      setLandingVisible(true);
    } else if (activeSourceId) {
      setLandingVisible(false);
    }
  }, [assets.length, activeSourceId, hasDefaultSource]);

  useEffect(() => {
    if (!showLandingOverlay) return;

    resetLandingView();
    resetViewWithImmersive();
  }, [showLandingOverlay]);

  // Apply custom background color only on the collection page; revert to charcoal on landing.
  // Force black when expanded viewer is active so transitions don't flash the custom color.
  useEffect(() => {
    const DEFAULT_BG = '#0c0d10';
    const EXPANDED_BG = '#000000';
    const isCustom = appBgColor && appBgColor !== DEFAULT_BG;
    const color = expandedViewer
      ? EXPANDED_BG
      : (!isLandingEmptyState && isCustom) ? appBgColor : DEFAULT_BG;
    document.documentElement.style.background = color;
    document.body.style.background = color;
    document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
      el.setAttribute('content', color);
    });
    if (!expandedViewer && !isLandingEmptyState && isCustom) {
      document.documentElement.setAttribute('data-custom-bg', '');
    } else {
      document.documentElement.removeAttribute('data-custom-bg');
    }
  }, [isLandingEmptyState, appBgColor, expandedViewer]);

  return (
    <div class={`page ${panelOpen ? 'panel-open' : ''} ${showLandingOverlay ? 'landing-empty' : ''} ${metadataMissing ? 'metadata-missing-force-ui' : ''}`}>
      {showViewerUi && <AssetSidebar />}
      <input 
        ref={uploadInputRef}
        type="file" 
        {...(uploadAccept ? { accept: uploadAccept } : {})}
        multiple 
        hidden 
        onChange={handleUploadChange}
      />
      <TitleCard
        show={showLandingOverlay || forceTitleEnabled}
        forceFrostedTitleOnly={forceTitleEnabled}
        onPickFile={handlePickFile}
        onOpenStorage={handleOpenStorage}
        onLoadDemo={handleLoadDemo}
        onSelectSource={handleSelectSource}
        onOpenCloudGpu={handleOpenCloudGpu}
        onInstallDemoCollections={handleInstallDemoCollections}
        demoCollectionOptions={demoCollectionOptions}
      />
        <Viewer
          viewerReady={viewerReady}
          dropOverlay={dropOverlay}
          startEmptyOnInitialCollectionRoute={startedFromCollectionRoute}
        />

      {showViewerUi && (isMobile && isPortrait ? <MobileSheet /> : <SidePanel />)}
      {showViewerUi && <BottomControls onOpenSlideshowOptions={() => setSlideshowOptionsOpen(true)} />}

      <ConnectStorageDialog
        isOpen={storageDialogOpen}
        onClose={handleCloseStorage}
        onConnect={handleSourceConnect}
        initialTier={storageDialogInitialTier}
      />
      <ControlsModal
        isOpen={controlsModalOpen}
        onClose={() => setControlsModalOpen(false)}
        defaultOpenSubsections={controlsModalDefaultSubsections}
      />
      <SlideshowOptionsModal
        isOpen={slideshowOptionsOpen}
        onClose={() => setSlideshowOptionsOpen(false)}
      />
      <AddDemoCollectionsModal
        isOpen={demoCollectionsModalOpen}
        onClose={() => setDemoCollectionsModalOpen(false)}
        onInstall={handleInstallDemoCollections}
        options={demoCollectionOptions}
      />
      <PwaReloadPrompt />
      <PwaInstallPrompt />
      <ImportFromUrlModal
        isOpen={Boolean(pendingImportUrl)}
        importUrl={pendingImportUrl}
        onClose={() => {
          setPendingImportUrl(null);
          clearImportUrlFromLocation();
        }}
        addLog={addLog}
      />
      {dropModal}
      {uploadModal}
    </div>
  );
}

export default App;
