/**
 * Mobile sheet component for portrait orientation.
 * Swipeable bottom sheet drawer with drag handle interaction.
 */

import { useRef, useCallback, useState } from 'preact/hooks';
import useSwipe from '../utils/useSwipe';
import { useStore } from '../store';
import CameraControls from './CameraControls';
import DebugSettings from './DebugSettings';
import AnimationSettings from './AnimationSettings';
import StorageSourceList from './StorageSourceList';
import ConnectStorageDialog from './ConnectStorageDialog';
import { getFormatAccept } from '../formats/index';
import { handleMultipleFiles, loadFromStorageSource, resize } from '../fileLoader';
import { resetLandingView } from '../utils/resetLandingView';
import { requestRender } from '../viewer';
import { HomeIcon } from '../icons/customIcons';

const DEFAULT_BG = '#0c0d10';
const FADE_IN_MS = 220;

/** File input accept attribute value */
const formatAccept = getFormatAccept();

/** Minimum swipe distance to trigger open/close */
const SWIPE_THRESHOLD = 50;

function MobileSheet() {
  // Store state
  const panelOpen = useStore((state) => state.panelOpen);
  const togglePanel = useStore((state) => state.togglePanel);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const viewerControlsDimmed = useStore((state) => state.viewerControlsDimmed);
  const disableTransparentUi = useStore((state) => state.disableTransparentUi);

  // Refs
  const fileInputRef = useRef(null);
  const dragHandleRef = useRef(null);

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
    // Load assets from newly connected source
    loadFromStorageSource(source);
    setStorageDialogOpen(false);
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

    // 3. Reset viewer shift & close sheet
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

  /**
   * Handle drag handle click to toggle
   */
  const handleDragHandleClick = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  // useSwipe on the drag handle to detect vertical swipes
  useSwipe(dragHandleRef, {
    direction: 'vertical',
    threshold: SWIPE_THRESHOLD,
    allowCross: 50,
    onSwipe: ({ dir }) => {
      if (dir === 'up' && !panelOpen) togglePanel();
      if (dir === 'down' && panelOpen) togglePanel();
    }
  });

  /**
   * Triggers file picker dialog.
   */
  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Handles file selection from file picker.
   */
  const handleFileChange = useCallback(async (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      await handleMultipleFiles(Array.from(files));
      event.target.value = '';
    }
  }, []);

  return (
    <div class={`mobile-sheet ${panelOpen ? 'open' : 'closed'}${slideshowPlaying || viewerControlsDimmed ? ' slideshow-hide' : ''}${disableTransparentUi ? ' no-transparent-ui' : ''}`}>
      {/* Drag handle with enlarged touch target - outside scroll container */}
      <div class="drag-handle" ref={dragHandleRef}>
        {panelOpen && (
          <button
            class="home-btn mobile-sheet-home"
            aria-label="Back to home"
            type="button"
            onClick={handleGoHome}
          >
            <HomeIcon />
          </button>
        )}
        <div 
          class="drag-handle-touch-target"
          onClick={handleDragHandleClick}
        />
        <div class="drag-handle-bar" />
      </div>
      
      {/* Scrollable content container */}
      <div class="mobile-sheet-content">
        <CameraControls />
        <AnimationSettings />
        <StorageSourceList 
          onAddSource={handleOpenStorageDialog}
          onSelectSource={handleSelectSource}
          onOpenCloudGpu={handleOpenCloudGpuDialog}
        />
                <DebugSettings />

        {/* <AssetGallery /> */}
      </div>

      {/* Connect to Storage dialog */}
      <ConnectStorageDialog
        isOpen={storageDialogOpen}
        onClose={handleCloseStorageDialog}
        onConnect={handleSourceConnect}
        initialTier={storageDialogInitialTier}
      />
    </div>
  );
}

export default MobileSheet;
