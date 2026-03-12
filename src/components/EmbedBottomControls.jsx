import { useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpandAlt, faCompressAlt } from '@fortawesome/free-solid-svg-icons';
import { FocusIcon, Rotate3DIcon, MaximizeIcon, MinimizeIcon } from '../icons/customIcons.jsx';
import { useStore } from '../store.js';
import { requestRender } from '../viewer.js';
import { resize } from '../fileLoader.js';
import { resetViewWithImmersive } from '../cameraUtils.js';
import { enableImmersiveMode, disableImmersiveMode, setImmersiveSensitivityMultiplier, setTouchPanEnabled, syncImmersiveBaseline } from '../immersiveMode.js';
import useFullscreenControls from '../utils/useFullscreenControls.js';
import useControlsReveal from '../utils/useControlsReveal.js';
import { supportsImmersiveControls } from '../utils/immersiveDeviceSupport.js';
import AssetNavigation from './AssetNavigation.jsx';

function EmbedBottomControls({ onOpenSlideshowOptions }) {
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const assetSidebarOpen = useStore((state) => state.assetSidebarOpen);
  const setAssetSidebarOpen = useStore((state) => state.setAssetSidebarOpen);
  const immersiveMode = useStore((state) => state.immersiveMode);
  const setImmersiveMode = useStore((state) => state.setImmersiveMode);
  const immersiveSensitivity = useStore((state) => state.immersiveSensitivity);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const viewerControlsDimmed = useStore((state) => state.viewerControlsDimmed);
  const expandedViewer = useStore((state) => state.expandedViewer);
  const toggleExpandedViewer = useStore((state) => state.toggleExpandedViewer);
  const isMobile = useStore((state) => state.isMobile);
  const disableTransparentUi = useStore((state) => state.disableTransparentUi);
  const canUseImmersiveControls = supportsImmersiveControls();

  const { controlsRevealed, revealBottomControls } = useControlsReveal({ slideshowPlaying });

  const { isRegularFullscreen, handleToggleRegularFullscreen } = useFullscreenControls({
    resize,
    requestRender,
  });

  const handleResetView = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  const handleImmersiveToggle = useCallback(async () => {
    if (immersiveMode) {
      disableImmersiveMode();
      setImmersiveMode(false);
      return;
    }

    setTouchPanEnabled(true);
    setImmersiveSensitivityMultiplier(immersiveSensitivity);
    const success = await enableImmersiveMode();
    if (success) {
      syncImmersiveBaseline();
      setImmersiveMode(true);
    } else {
      setImmersiveMode(false);
    }
  }, [immersiveMode, immersiveSensitivity, setImmersiveMode]);

  const handleToggleExpandedViewer = useCallback(() => {
    toggleExpandedViewer();
    requestAnimationFrame(() => {
      resize();
      requestRender();
    });
  }, [toggleExpandedViewer]);

  if (assets.length === 0) {
    return null;
  }

  return (
    <div
      class={`bottom-controls embed-bottom-controls${slideshowPlaying || viewerControlsDimmed ? ' slideshow-hide' : ''}${controlsRevealed ? ' is-revealed' : ''}${disableTransparentUi ? ' no-transparent-ui' : ''}`}
      onPointerEnter={() => slideshowPlaying && revealBottomControls(false)}
      onPointerLeave={() => slideshowPlaying && revealBottomControls(true, 1000)}
      onPointerDown={() => slideshowPlaying && revealBottomControls(true, 1000)}
    >
      <div class="bottom-controls-left">
        {isMobile && (
          <button
            class="bottom-page-btn"
            onClick={handleToggleRegularFullscreen}
            aria-label={isRegularFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isRegularFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isRegularFullscreen ? <MinimizeIcon size={18} /> : <MaximizeIcon size={18} />}
          </button>
        )}

        {assets.length > 1 && (
          <button
            class={`bottom-page-btn ${assetSidebarOpen ? 'is-active' : ''}`}
            onClick={() => setAssetSidebarOpen(!assetSidebarOpen)}
            title="Toggle gallery"
          >
            {currentAssetIndex + 1} / {assets.length}
          </button>
        )}
      </div>

      <div class="bottom-controls-center">
        <div class="bottom-controls-center-inner">
          <AssetNavigation onOpenSlideshowOptions={onOpenSlideshowOptions} />
        </div>
      </div>

      <div class="bottom-controls-right">
        <button
          class="bottom-page-btn"
          onClick={handleResetView}
          aria-label="Reset camera view"
          title="Reset view"
        >
          <FocusIcon size={18} />
        </button>

        {isRegularFullscreen && (
          <button
            class="bottom-page-btn"
            onClick={handleToggleExpandedViewer}
            aria-label={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
            title={expandedViewer ? 'Collapse viewer' : 'Expand viewer'}
          >
            <FontAwesomeIcon icon={expandedViewer ? faCompressAlt : faExpandAlt} />
          </button>
        )}

        {!isMobile && (
          <button
            class="bottom-page-btn"
            onClick={handleToggleRegularFullscreen}
            aria-label={isRegularFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isRegularFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isRegularFullscreen ? <MinimizeIcon size={18} /> : <MaximizeIcon size={18} />}
          </button>
        )}

        {canUseImmersiveControls && (
          <button
            class={`bottom-page-btn immersive-toggle ${immersiveMode ? 'is-active' : 'is-inactive'}`}
            onClick={() => void handleImmersiveToggle()}
            aria-pressed={immersiveMode}
            aria-label={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
            title={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
          >
            <Rotate3DIcon size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

export default EmbedBottomControls;