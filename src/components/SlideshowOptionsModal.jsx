/**
 * Slideshow options modal.
 * Provides quick access to slideshow-related settings.
 */

import { useCallback } from 'preact/hooks';
import { useStore } from '../store';
import { saveCustomAnimationSettings, saveViewCustomAnimationSettings } from '../fileStorage';
import { updateCustomAnimationInCache, clearCustomAnimationInCache, updateViewCustomAnimationInCache, clearViewCustomAnimationInCache } from '../splatManager';
import Modal from './Modal';

const SLIDE_MODE_OPTIONS = [
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'fade', label: 'Fade' },
];

const CONTINUOUS_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const ZOOM_PROFILE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'near', label: 'Near' },
  { value: 'medium', label: 'Medium' },
  { value: 'far', label: 'Far' },
];

const FILE_SLIDE_TYPE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'fade', label: 'Fade' },
];

const FILE_TRANSITION_RANGE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const DEFAULT_FILE_CUSTOM_ANIMATION = {
  slideType: 'default',
  transitionRange: 'default',
  zoomProfile: 'default',
  dollyZoom: false,
};

const buildCustomAnimationPayload = (settings) => {
  const payload = {};
  if (settings.slideType && settings.slideType !== 'default') {
    payload.slideType = settings.slideType;
  }
  if (settings.transitionRange && settings.transitionRange !== 'default') {
    payload.transitionRange = settings.transitionRange;
  }
  if (settings.zoomProfile && settings.zoomProfile !== 'default') {
    payload.zoomProfile = settings.zoomProfile;
  }
  if (settings.dollyZoom) {
    payload.dollyZoom = true;
  }
  return payload;
};

function SlideshowOptionsModal({ isOpen, onClose }) {
  const slideMode = useStore((state) => state.slideMode);
  const continuousMotionSize = useStore((state) => state.continuousMotionSize);
  const continuousMotionDuration = useStore((state) => state.continuousMotionDuration);
  const slideshowContinuousMode = useStore((state) => state.slideshowContinuousMode);
  const slideshowDuration = useStore((state) => state.slideshowDuration);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const fileCustomAnimation = useStore((state) => state.fileCustomAnimation);
  const currentFileName = useStore((state) => state.fileInfo?.name);

  const setSlideModeStore = useStore((state) => state.setSlideMode);
  const setContinuousMotionSizeStore = useStore((state) => state.setContinuousMotionSize);
  const setContinuousMotionDurationStore = useStore((state) => state.setContinuousMotionDuration);
  const setSlideshowContinuousModeStore = useStore((state) => state.setSlideshowContinuousMode);
  const setSlideshowDurationStore = useStore((state) => state.setSlideshowDuration);
  const setFileCustomAnimation = useStore((state) => state.setFileCustomAnimation);

  const handleContinuousDurationChange = useCallback((e) => {
    const value = Number(e.target.value);
    setContinuousMotionDurationStore(value);
  }, [setContinuousMotionDurationStore]);

  const persistFileCustomAnimation = useCallback((nextSettings) => {
    setFileCustomAnimation(nextSettings);
    const currentAsset = assets?.[currentAssetIndex];
    const currentAssetId = currentAsset?.id;
    const currentViewId = currentAsset?.viewId;
    const baseName = currentAsset?.baseAssetName || currentFileName;
    const cacheKeyId = currentAsset?.cacheKey || currentAsset?.baseAssetId || currentAssetId;
    const payload = buildCustomAnimationPayload(nextSettings);

    if (baseName && baseName !== '-') {
      if (currentViewId) {
        saveViewCustomAnimationSettings(baseName, currentViewId, payload)
          .catch(err => {
            console.warn('Failed to save view custom animation settings:', err);
          });
      } else {
        saveCustomAnimationSettings(baseName, payload)
          .catch(err => {
            console.warn('Failed to save custom animation settings:', err);
          });
      }
    }

    if (cacheKeyId) {
      if (currentViewId) {
        clearViewCustomAnimationInCache(cacheKeyId, currentViewId);
        if (Object.keys(payload).length > 0) {
          updateViewCustomAnimationInCache(cacheKeyId, currentViewId, payload);
        }
      } else {
        clearCustomAnimationInCache(cacheKeyId);
        if (Object.keys(payload).length > 0) {
          updateCustomAnimationInCache(cacheKeyId, payload);
        }
      }
    }
  }, [setFileCustomAnimation, currentFileName, assets, currentAssetIndex]);

  const handleZoomProfileChange = useCallback((e) => {
    const zoomProfile = e.target.value;
    const nextSettings = {
      ...DEFAULT_FILE_CUSTOM_ANIMATION,
      ...(fileCustomAnimation || {}),
      zoomProfile,
    };
    persistFileCustomAnimation(nextSettings);
  }, [fileCustomAnimation, persistFileCustomAnimation]);

  const handleFileSlideTypeChange = useCallback((e) => {
    const slideType = e.target.value;
    const nextSettings = {
      ...DEFAULT_FILE_CUSTOM_ANIMATION,
      ...(fileCustomAnimation || {}),
      slideType,
    };
    persistFileCustomAnimation(nextSettings);
  }, [fileCustomAnimation, persistFileCustomAnimation]);

  const handleFileTransitionRangeChange = useCallback((e) => {
    const transitionRange = e.target.value;
    const nextSettings = {
      ...DEFAULT_FILE_CUSTOM_ANIMATION,
      ...(fileCustomAnimation || {}),
      transitionRange,
    };
    persistFileCustomAnimation(nextSettings);
  }, [fileCustomAnimation, persistFileCustomAnimation]);

  const handleFileDollyZoomChange = useCallback((e) => {
    const dollyZoom = e.target.checked;
    const nextSettings = {
      ...DEFAULT_FILE_CUSTOM_ANIMATION,
      ...(fileCustomAnimation || {}),
      dollyZoom,
    };
    persistFileCustomAnimation(nextSettings);
  }, [fileCustomAnimation, persistFileCustomAnimation]);

  const effectiveFileSlideType =
    fileCustomAnimation?.slideType && fileCustomAnimation.slideType !== 'default'
      ? fileCustomAnimation.slideType
      : slideMode;
  const hasFileSlideshowOverride = Boolean(
    (fileCustomAnimation?.slideType && fileCustomAnimation.slideType !== 'default')
    || (fileCustomAnimation?.transitionRange && fileCustomAnimation.transitionRange !== 'default')
    || (fileCustomAnimation?.zoomProfile && fileCustomAnimation.zoomProfile !== 'default')
    || fileCustomAnimation?.dollyZoom
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth={380} >
       <h3 style={{marginBottom: "0px"}}>Slideshow Options</h3>
      <div class="settings-group" style={{ padding: '6px 2px' }}>
        <div class="group-content" style={{ display: 'flex', marginTop: '14px', flexDirection: 'column', gap: '12px' }}>
          {hasFileSlideshowOverride && (
            <div class="control-row" style={{ justifyContent: 'flex-end', paddingTop: '0', paddingBottom: '0' }}>
              <span class="tier-badge">Override Active</span>
            </div>
          )}

          <div class="control-row select-row">
            <span class="control-label">Slide</span>
            <select value={slideMode} onChange={(e) => setSlideModeStore(e.target.value)}>
              {SLIDE_MODE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>


          {slideshowContinuousMode && slideMode !== 'fade' && (
            <div class="control-row select-row">
              <span class="control-label">Transition range</span>
              <select value={continuousMotionSize} onChange={(e) => setContinuousMotionSizeStore(e.target.value)}>
                {CONTINUOUS_SIZE_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          )}

          {slideMode !== 'fade' && (
            <div class="control-row animate-toggle-row">
              <span class="control-label">Continuous Mode</span>
              <label class="switch">
                <input
                  type="checkbox"
                  checked={slideshowContinuousMode}
                  onChange={(e) => setSlideshowContinuousModeStore(e.target.checked)}
                />
                <span class="switch-track" aria-hidden="true" />
              </label>
            </div>
          )}

          {slideshowContinuousMode && slideMode !== 'fade' ? (
            <div class="control-row">
              <span class="control-label">Duration</span>
              <div class="control-track">
                <input
                  type="range"
                  min="3"
                  max="20"
                  step="1"
                  value={Math.max(1, (continuousMotionDuration ?? 2) - 1)}
                  onInput={handleContinuousDurationChange}
                />
                <span class="control-value">{Math.max(1, (continuousMotionDuration ?? 2) - 1)}s</span>
              </div>
            </div>
          ) : (
            <div class="control-row">
              <span class="control-label">Hold Time</span>
              <div class="control-track">
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={slideshowDuration}
                  onInput={(e) => setSlideshowDurationStore(Number(e.target.value))}
                />
                <span class="control-value">{slideshowDuration}s</span>
              </div>
            </div>
          )}
           <div class="settings-divider">
          <span>Custom transitions</span>
        </div>
          <div class="control-row select-row">
            <span class="control-label">Slide</span>
            <select value={fileCustomAnimation?.slideType ?? 'default'} onChange={handleFileSlideTypeChange}>
              {FILE_SLIDE_TYPE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {effectiveFileSlideType === 'zoom' ? (
            <>
              <div class="control-row select-row">
                <span class="control-label">Zoom target</span>
                <select
                  value={fileCustomAnimation?.zoomProfile ?? 'default'}
                  onChange={handleZoomProfileChange}
                >
                  {ZOOM_PROFILE_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div class="control-row animate-toggle-row">
                <span class="control-label">Dolly Zoom</span>
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={fileCustomAnimation?.dollyZoom ?? false}
                    onChange={handleFileDollyZoomChange}
                  />
                  <span class="switch-track" aria-hidden="true" />
                </label>
              </div>
            </>
          ) : (
            <div class="control-row select-row">
              <span class="control-label">Range</span>
              <select value={fileCustomAnimation?.transitionRange ?? 'default'} onChange={handleFileTransitionRangeChange}>
                {FILE_TRANSITION_RANGE_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default SlideshowOptionsModal;
