/**
 * Side panel component for desktop and landscape modes.
 * Contains file upload controls, debug info display, and settings panels.
 * Collapsible via toggle button.
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { useStore } from '../store';
import CameraControls from './CameraControls';
import AnimationSettings from './AnimationSettings';
import DebugSettings from './DebugSettings';
import StorageSourceList from './StorageSourceList';
import ConnectStorageDialog from './ConnectStorageDialog';
import { loadFromStorageSource, resize } from '../fileLoader';
import { requestRender } from '../viewer';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faHouse } from '@fortawesome/free-solid-svg-icons';
import { resetLandingView } from '../utils/resetLandingView';
import { HomeIcon } from '../icons/customIcons';

const DEFAULT_BG = '#0c0d10';
const FADE_IN_MS = 250;

function SidePanel() {
  // Store state
  const status = useStore((state) => state.status);
  const fileInfo = useStore((state) => state.fileInfo);
  const isMobile = useStore((state) => state.isMobile);
  const panelOpen = useStore((state) => state.panelOpen); // assumes this exists
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const viewerControlsDimmed = useStore((state) => state.viewerControlsDimmed);
  // Store actions
  const togglePanel = useStore((state) => state.togglePanel);

  const hoverOpenTimeoutRef = useRef(null);
  const hideTimeoutRef = useRef(null);
  const suppressTimeoutRef = useRef(null);

  // Whether the panel was revealed via the hover target (overrides slideshow-hide)
  const [hoverRevealed, setHoverRevealed] = useState(false);
  // Block interactions briefly after panel slides in to prevent tap-through
  const [suppressInteractions, setSuppressInteractions] = useState(false);

  const isUiHidden = slideshowPlaying || viewerControlsDimmed;

  // Open the panel if it is currently closed (used for hover target)
  const openPanel = useCallback(() => {
    if (!panelOpen) {
      togglePanel();
    }
  }, [panelOpen, togglePanel]);

  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback((delay = 400) => {
    clearHideTimeout();
    hideTimeoutRef.current = setTimeout(() => {
      setHoverRevealed(false);
      hideTimeoutRef.current = null;
    }, delay);
  }, [clearHideTimeout]);

  const beginSuppressInteractions = useCallback(() => {
    setSuppressInteractions(true);
    if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current);
    suppressTimeoutRef.current = setTimeout(() => {
      setSuppressInteractions(false);
      suppressTimeoutRef.current = null;
    }, 500);
  }, []);

  const handleHoverEnter = useCallback(() => {
    clearHideTimeout();
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
    }
    hoverOpenTimeoutRef.current = setTimeout(() => {
      openPanel();
      if (isUiHidden) setHoverRevealed(true);
      beginSuppressInteractions();
      hoverOpenTimeoutRef.current = null;
    }, 500);
  }, [openPanel, isUiHidden, clearHideTimeout, beginSuppressInteractions]);

  const handleHoverLeave = useCallback(() => {
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
    if (hoverRevealed) scheduleHide();
  }, [hoverRevealed, scheduleHide]);

  const handleTapOpen = useCallback(() => {
    openPanel();
    if (isUiHidden) setHoverRevealed(true);
    beginSuppressInteractions();
  }, [openPanel, isUiHidden, beginSuppressInteractions]);

  // Keep side panel open while mouse is over it
  const handleSideEnter = useCallback(() => {
    if (hoverRevealed) clearHideTimeout();
  }, [hoverRevealed, clearHideTimeout]);

  const handleSideLeave = useCallback(() => {
    if (hoverRevealed) scheduleHide();
  }, [hoverRevealed, scheduleHide]);

  // Reset hoverRevealed when UI becomes visible again (no longer hidden)
  useEffect(() => {
    if (!isUiHidden) setHoverRevealed(false);
  }, [isUiHidden]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hoverOpenTimeoutRef.current) clearTimeout(hoverOpenTimeoutRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current);
    };
  }, []);
  
  // Storage dialog state
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);
  const [storageDialogInitialTier, setStorageDialogInitialTier] = useState(null);
  
  const handleOpenStorageDialog = useCallback(() => {
    setStorageDialogInitialTier(null);
    setStorageDialogOpen(true);
  }, []);

  const handleOpenCloudGpuDialog = useCallback(() => {
    setStorageDialogInitialTier('cloud-gpu');
    setStorageDialogOpen(true);
  }, []);
  
  const handleCloseStorageDialog = useCallback(() => {
    setStorageDialogOpen(false);
    setStorageDialogInitialTier(null);
  }, []);
  
  const handleSourceConnect = useCallback((source) => {
    // Load assets from the newly connected source
    loadFromStorageSource(source);
  }, []);
  
  const handleSelectSource = useCallback((source) => {
    // Load assets from selected source
    loadFromStorageSource(source);
  }, []);

  /** Navigate back to landing page (hard cut, then smooth fade-in) */
  const handleGoHome = useCallback(() => {
    const pageEl = document.querySelector('.page');
    const viewerEl = document.querySelector('.viewer');

    // 1. Instant hard cut — hide before viewer unmounts
    if (pageEl) {
      pageEl.style.transition = 'none';
      pageEl.style.opacity = '0';
    }

    // 2. Snap background to charcoal while invisible
    document.documentElement.style.background = DEFAULT_BG;
    document.body.style.background = DEFAULT_BG;

    // 3. Reset viewer shift & close panel
    if (viewerEl) viewerEl.style.setProperty('--viewer-shift-y', '0px');
    useStore.getState().setPanelOpen(false);

    // 4. Perform reset while page is hidden
    const base = String(import.meta.env.BASE_URL || '/').replace(/\/*$/, '/');
    window.history.pushState({}, '', base);
    resetLandingView();
    resize();
    requestRender();

    // 5. Let React settle, then smooth fade-in
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (pageEl) {
          pageEl.style.transition = `opacity ${FADE_IN_MS}ms ease-in`;
          pageEl.style.opacity = '1';
          setTimeout(() => {
            if (pageEl) pageEl.style.transition = '';
          }, FADE_IN_MS);
        }
      });
    }, 60);
  }, []);

  return (
    <>
      {/* Panel toggle button */}
      <button
        class={`panel-toggle${panelOpen ? ' open' : ''}${isUiHidden && !hoverRevealed ? ' slideshow-hide' : ''}`}
        aria-label="Toggle info panel"
        type="button"
        onClick={togglePanel}
      >
        <FontAwesomeIcon icon={faChevronLeft} />
      </button>
      {/* Right-edge hover target to open the side panel */}
        <div
            class="sidepanel-hover-target"
            onMouseEnter={handleHoverEnter}
            onMouseLeave={handleHoverLeave}
            onPointerDown={handleTapOpen}
          />
      {/* Side panel content */}
      <div
        class={`side${isUiHidden && !hoverRevealed ? ' slideshow-hide' : ''}`}
        style={suppressInteractions ? { pointerEvents: 'none' } : undefined}
        onMouseEnter={handleSideEnter}
        onMouseLeave={handleSideLeave}
      >
        {/* File info display - hidden on mobile */}
        {!isMobile && (
          <div class="debug" style={{ position: 'relative' }}>
            <div class="row">
              <span>Status</span>
              <span>{status}</span>
            </div>
            <div class="row">
              <span>File</span>
              <span>{fileInfo.name}</span>
            </div>
            <div class="row">
              <span>Size</span>
              <span>{fileInfo.size}</span>
            </div>
            <div class="row">
              <span>Splats</span>
              <span>{fileInfo.splatCount}</span>
            </div>
            <div class="row">
              <span>Time</span>
              <span>{fileInfo.loadTime}</span>
            </div>
            <button
              class="home-btn debug-home"
              aria-label="Back to home"
              type="button"
              onClick={handleGoHome}
            >
              <HomeIcon />
            </button>
          </div>
        )}
        {/* Home button when debug info is hidden (mobile) */}
        {isMobile && (
          <button
            class="home-btn sidepanel-home"
            aria-label="Back to home"
            type="button"
            onClick={handleGoHome}
          >
            <HomeIcon />
          </button>
        )}
        {/* Settings panels */}
        <CameraControls />
        <AnimationSettings />
        {/* Storage sources */}
        <StorageSourceList 
          onAddSource={handleOpenStorageDialog}
          onSelectSource={handleSelectSource}
          onOpenCloudGpu={handleOpenCloudGpuDialog}
        />
        <DebugSettings />
      </div>
      
      {/* Connect to Storage dialog */}
      <ConnectStorageDialog
        isOpen={storageDialogOpen}
        onClose={handleCloseStorageDialog}
        onConnect={handleSourceConnect}
        initialTier={storageDialogInitialTier}
      />
    </>
  );
}

export default SidePanel;
