/**
 * AssetNavigation component
 * Provides back/forward/play-pause buttons (as a single button group)
 * and swipe gestures for asset navigation.
 *
 * Hold the play/pause button for 500 ms to open slideshow options.
 */
import { useCallback, useEffect, useRef } from 'preact/hooks';
import useSwipe from '../utils/useSwipe';
import { useStore } from '../store';
import { loadNextAsset, loadPrevAsset } from '../fileLoader';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight, faPause, faPlay } from '@fortawesome/free-solid-svg-icons';
import { startSlideshow, stopSlideshow } from '../slideshowController';

function AssetNavigation({ onOpenSlideshowOptions }) {
  const assets = useStore((state) => state.assets);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const hasMultipleAssets = assets.length > 1;
  const swipeRef = useRef(null);

  // Hold-to-open-options state
  const holdTimeout = useRef(null);
  const holdTriggered = useRef(false);

  const handleSwipe = useCallback(({ dir }) => {
    if (dir === 'left') {
      loadNextAsset();
    } else if (dir === 'right') {
      loadPrevAsset();
    }
  }, []);

  // useSwipe hook for horizontal swipes
  useSwipe(swipeRef, {
    direction: 'horizontal',
    threshold: 40,
    onSwipe: handleSwipe,
  });

  /** Start a 500 ms hold timer — if it fires, open slideshow options. */
  const handlePlayHoldStart = useCallback(() => {
    holdTriggered.current = false;
    if (holdTimeout.current) clearTimeout(holdTimeout.current);
    holdTimeout.current = setTimeout(() => {
      holdTriggered.current = true;
      if (onOpenSlideshowOptions) onOpenSlideshowOptions();
      holdTimeout.current = null;
    }, 500);
  }, [onOpenSlideshowOptions]);

  /** Cancel hold timer on pointer release / leave / cancel. */
  const handlePlayHoldEnd = useCallback(() => {
    if (holdTimeout.current) {
      clearTimeout(holdTimeout.current);
      holdTimeout.current = null;
    }
  }, []);

  /** Toggle play/pause on click — unless the hold already triggered the options modal. */
  const handlePlayClick = useCallback(() => {
    if (holdTriggered.current) {
      holdTriggered.current = false;
      return;
    }
    if (slideshowPlaying) {
      stopSlideshow();
    } else {
      startSlideshow();
    }
  }, [slideshowPlaying]);

  // Cleanup hold timer on unmount
  useEffect(() => () => {
    if (holdTimeout.current) clearTimeout(holdTimeout.current);
  }, []);

  if (!hasMultipleAssets) {
    return null;
  }

  return (
    <div class="nav-button-group">
      <button
        class="bottom-page-btn"
        onClick={loadPrevAsset}
        aria-label="Previous asset"
        title="Previous asset"
      >
        <FontAwesomeIcon icon={faChevronLeft} />
      </button>
      <button
        class="bottom-page-btn"
        onClick={handlePlayClick}
        onPointerDown={handlePlayHoldStart}
        onPointerUp={handlePlayHoldEnd}
        onPointerLeave={handlePlayHoldEnd}
        onPointerCancel={handlePlayHoldEnd}
        aria-label={slideshowPlaying ? 'Pause slideshow' : 'Play slideshow'}
        title={slideshowPlaying ? 'Pause slideshow (hold for options)' : 'Play slideshow (hold for options)'}
      >
        <FontAwesomeIcon icon={slideshowPlaying ? faPause : faPlay} />
      </button>
      <button
        class="bottom-page-btn"
        onClick={loadNextAsset}
        aria-label="Next asset"
        title="Next asset"
      >
        <FontAwesomeIcon icon={faChevronRight} />
      </button>
    </div>
  );
}

export default AssetNavigation;
