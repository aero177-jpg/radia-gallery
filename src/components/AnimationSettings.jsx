/**
 * Animation settings component.
 * Controls for load animation behavior including enable/disable,
 * animation style (intensity), and sweep direction.
 */

import { useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faRotateRight, faPlay, faStop } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store';
import { setLoadAnimationEnabled, setLoadAnimationIntensity, setLoadAnimationDirection, startLoadZoomAnimation } from '../customAnimations';
import { saveAnimationSettings, savePreviewBlob, saveCustomAnimationSettings, saveViewCustomAnimationSettings } from '../fileStorage';
import { scene, renderer, composer, THREE, currentMesh } from '../viewer';
import { updateCustomAnimationInCache, clearCustomAnimationInCache, updateViewCustomAnimationInCache, clearViewCustomAnimationInCache } from '../splatManager';
import { startSlideshow, stopSlideshow, resetSlideshow } from '../slideshowController';

const PREVIEW_TARGET_HEIGHT = 128;
const PREVIEW_WEBP_QUALITY = 0.18;
const PREVIEW_JPEG_QUALITY = 0.35;

/** Animation style options with display labels */
const INTENSITY_OPTIONS = [
  { value: 'subtle', label: 'Subtle' },
  { value: 'medium', label: 'Medium' },
  { value: 'dramatic', label: 'Dramatic' },
  { value: 'custom', label: 'Custom' },
];

/** Animation direction options with display labels */
const DIRECTION_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'none', label: 'None' },
];

const ZOOM_TYPE_OPTIONS = [
  { value: 'in', label: 'In' },
  { value: 'out', label: 'Out' },
  { value: 'none', label: 'None' },
];

const EASING_OPTIONS = [
  { value: 'ease-in-out', label: 'Ease In Out' },
  { value: 'ease-in', label: 'Ease In' },
  { value: 'ease-out', label: 'Ease Out' },
  { value: 'linear', label: 'Linear' },
];

/** Slide transition mode options */
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

const TRANSITION_SPEED_OPTIONS = [
  { value: 'snappy', label: 'Snappy' },
  { value: 'default', label: 'Default' },
  { value: 'vibe', label: 'Vibe' },
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

function AnimationSettings() {
  // Store state
  const animationEnabled = useStore((state) => state.animationEnabled);
  const animationIntensity = useStore((state) => state.animationIntensity);
  const animationDirection = useStore((state) => state.animationDirection);
  const slideMode = useStore((state) => state.slideMode);
  const transitionSpeed = useStore((state) => state.transitionSpeed);
  const continuousMotionSize = useStore((state) => state.continuousMotionSize);
  const continuousMotionDuration = useStore((state) => state.continuousMotionDuration);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const slideshowContinuousMode = useStore((state) => state.slideshowContinuousMode);
  const continuousDollyZoom = useStore((state) => state.continuousDollyZoom);
  const slideshowDuration = useStore((state) => state.slideshowDuration);
  const animSettingsExpanded = useStore((state) => state.animSettingsExpanded);
  const customAnimation = useStore((state) => state.customAnimation);
  const fileCustomAnimation = useStore((state) => state.fileCustomAnimation);
  const currentFileName = useStore((state) => state.fileInfo?.name);

  // Store actions
  const setAnimationEnabledStore = useStore((state) => state.setAnimationEnabled);
  const setAnimationIntensityStore = useStore((state) => state.setAnimationIntensity);
  const setAnimationDirectionStore = useStore((state) => state.setAnimationDirection);
  const setSlideModeStore = useStore((state) => state.setSlideMode);
  const setTransitionSpeedStore = useStore((state) => state.setTransitionSpeed);
  const setContinuousMotionSizeStore = useStore((state) => state.setContinuousMotionSize);
  const setContinuousMotionDurationStore = useStore((state) => state.setContinuousMotionDuration);
  const setSlideshowContinuousModeStore = useStore((state) => state.setSlideshowContinuousMode);
  const setContinuousDollyZoomStore = useStore((state) => state.setContinuousDollyZoom);
  const setSlideshowDurationStore = useStore((state) => state.setSlideshowDuration);
  const setCustomAnimation = useStore((state) => state.setCustomAnimation);
  const setFileCustomAnimation = useStore((state) => state.setFileCustomAnimation);
  const toggleAnimSettingsExpanded = useStore((state) => state.toggleAnimSettingsExpanded);

  /**
   * Persists current animation settings to IndexedDB.
   */
  const persistAnimationSettings = useCallback((enabled, intensity, direction) => {
    if (currentFileName && currentFileName !== '-') {
      saveAnimationSettings(currentFileName, {
        enabled,
        intensity,
        direction,
      }).catch(err => {
        console.warn('Failed to save animation settings:', err);
      });
    }
  }, [currentFileName]);

  /**
   * Toggles load animation on/off.
   * Updates both Zustand store and animation module state.
   */
  const handleToggleAnimation = useCallback((e) => {
    const enabled = e.target.checked;
    setAnimationEnabledStore(enabled);
    setLoadAnimationEnabled(enabled);
    persistAnimationSettings(enabled, animationIntensity, animationDirection);
  }, [setAnimationEnabledStore, persistAnimationSettings, animationIntensity, animationDirection]);

  /**
   * Changes animation intensity/style.
   * @param {Event} e - Change event from select element
   */
  const handleIntensityChange = useCallback((e) => {
    const intensity = e.target.value;
    setAnimationIntensityStore(intensity);
    setLoadAnimationIntensity(intensity);
    persistAnimationSettings(animationEnabled, intensity, animationDirection);
  }, [setAnimationIntensityStore, persistAnimationSettings, animationEnabled, animationDirection]);

  /**
   * Changes animation sweep direction.
   * @param {Event} e - Change event from select element
   */
  const handleDirectionChange = useCallback((e) => {
    const direction = e.target.value;
    setAnimationDirectionStore(direction);
    setLoadAnimationDirection(direction);
    persistAnimationSettings(animationEnabled, animationIntensity, direction);
  }, [setAnimationDirectionStore, persistAnimationSettings, animationEnabled, animationIntensity]);

  /**
   * Changes slide transition mode.
   * @param {Event} e - Change event from select element
   */
  const handleSlideModeChange = useCallback((e) => {
    const mode = e.target.value;
    setSlideModeStore(mode);
  }, [setSlideModeStore]);

  const handleContinuousSizeChange = useCallback((e) => {
    const size = e.target.value;
    setContinuousMotionSizeStore(size);
  }, [setContinuousMotionSizeStore]);

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

  const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), type, quality);
  });

  const encodePreviewCanvas = async (canvas) => {
    const webpBlob = await canvasToBlob(canvas, 'image/webp', PREVIEW_WEBP_QUALITY);
    if (webpBlob) return { blob: webpBlob, format: 'image/webp' };

    const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', PREVIEW_JPEG_QUALITY);
    if (jpegBlob) return { blob: jpegBlob, format: 'image/jpeg' };

    try {
      const dataUrl = canvas.toDataURL('image/jpeg', PREVIEW_JPEG_QUALITY);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      return { blob, format: blob.type || 'image/jpeg', fallback: true };
    } catch (err) {
      console.warn('Preview encoding fallback failed', err);
      return null;
    }
  };

  /**
   * Captures a downscaled preview blob of the current render.
   */
  const capturePreviewBlob = async () => {
    if (!currentMesh) return null;

    const clearColor = new THREE.Color();
    renderer.getClearColor(clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const originalBackground = scene.background;

    scene.background = new THREE.Color('#0c1018');
    renderer.setClearColor(0x0c1018, 1);
    composer.render();

    const sourceCanvas = renderer.domElement;
    const scale = PREVIEW_TARGET_HEIGHT / Math.max(1, sourceCanvas.height);
    const targetWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = PREVIEW_TARGET_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, targetWidth, PREVIEW_TARGET_HEIGHT);

    const encoded = await encodePreviewCanvas(canvas);

    scene.background = originalBackground;
    renderer.setClearColor(clearColor, clearAlpha);

    if (!encoded) return null;

    return {
      ...encoded,
      width: targetWidth,
      height: PREVIEW_TARGET_HEIGHT,
    };
  };

  /**
   * Handles replay animation with preview capture.
   */
  const handleReplayAnimation = useCallback(() => {
    startLoadZoomAnimation({
      force: true,
      onComplete: () => {
        // Wait a few frames for render to stabilize, then capture preview
        let frameCount = 0;
        const waitAndCapture = () => {
          frameCount++;
          if (frameCount < 30) {
            requestAnimationFrame(waitAndCapture);
          } else {
            capturePreviewBlob()
              ?.then((preview) => {
                if (!preview || !currentFileName || currentFileName === '-') return;
                const currentAsset = assets?.[currentAssetIndex];
                const sizeKB = (preview.blob.size / 1024).toFixed(1);
                console.log(`Preview updated (${sizeKB} KB, ${preview.format ?? 'image/webp'})`);
                savePreviewBlob(currentFileName, preview.blob, {
                  width: preview.width,
                  height: preview.height,
                  format: preview.format,
                }, currentAsset?.previewStorageKey || currentFileName).catch(err => {
                  console.warn('Failed to save preview:', err);
                });
              })
              .catch(err => {
                console.warn('Failed to capture preview:', err);
              });
          }
        };
        requestAnimationFrame(waitAndCapture);
      }
    });
  }, [currentFileName, assets, currentAssetIndex]);

  return (
    <div class="settings-group">
      {/* Collapsible header */}
      <button
        class="group-toggle"
        aria-expanded={animSettingsExpanded}
        onClick={toggleAnimSettingsExpanded}
      >
        <span class="settings-eyebrow">Slideshow Settings</span>
        <FontAwesomeIcon icon={faChevronDown} className="chevron" />
      </button>

      {/* Settings content */}
      <div
        class="group-content"
        style={{ display: animSettingsExpanded ? 'flex' : 'none' }}
      >
        {/* Hidden settings group - not displayed but preserved for future use */}
        <div style={{ display: 'none' }}>
          {/* Enable/disable toggle */}
          <div class="control-row animate-toggle-row">
            <span class="control-label">Animate on load</span>
            <div style="display: flex; align-items: center; gap: 8px;">
              <label class="switch">
                <input
                  type="checkbox"
                  checked={animationEnabled}
                  onChange={handleToggleAnimation}
                />
                <span class="switch-track" aria-hidden="true" />
              </label>
              <button
                class="replay-btn"
                onClick={handleReplayAnimation}
                title="Replay animation"
                aria-label="Replay animation"
              >
                <FontAwesomeIcon icon={faRotateRight} style={{ fontSize: "12px" }} />
              </button>
            </div>
          </div>

          {/* Intensity selector */}
          <div class="control-row select-row">
            <span class="control-label">Style</span>
            <select value={animationIntensity} onChange={handleIntensityChange}>
              {INTENSITY_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {/* Direction selector - hidden in custom mode */}
          {animationIntensity !== 'custom' && (
            <div class="control-row select-row">
              <span class="control-label">Direction</span>
              <select value={animationDirection} onChange={handleDirectionChange}>
                {DIRECTION_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Slide mode selector */}
        <div class="control-row select-row">
          <span class="control-label">Slide</span>
          <select value={slideMode} onChange={handleSlideModeChange}>
            {SLIDE_MODE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {/* Transition speed selector */}
        {/* <div class="control-row select-row">
          <span class="control-label">Speed</span>
          <select value={transitionSpeed} onChange={(e) => setTransitionSpeedStore(e.target.value)}>
            {TRANSITION_SPEED_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div> */}

        {/* Slideshow play toggle */}
        {/* <div class="control-row animate-toggle-row">
          <span class="control-label">Slideshow Playing</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={slideshowPlaying}
              onChange={(e) => {
                if (e.target.checked) {
                  startSlideshow();
                } else {
                  resetSlideshow();
                }
              }}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div> */}
        {hasFileSlideshowOverride && (
          <div class="control-row" style={{ justifyContent: 'flex-end', paddingTop: '0', paddingBottom: '0' }}>
            <span class="tier-badge">Override Active</span>
          </div>
        )}
        <div class="settings-divider">
          <span>Custom transitions</span>
        </div>
        <div class="control-row select-row">
          <span class="control-label">Slide</span>
          <select
            value={fileCustomAnimation?.slideType ?? 'default'}
            onChange={handleFileSlideTypeChange}
          >
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
            <select
              value={fileCustomAnimation?.transitionRange ?? 'default'}
              onChange={handleFileTransitionRangeChange}
            >
              {FILE_TRANSITION_RANGE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        )}
        <div class="settings-divider">
          <span>Slideshow</span>
        </div>


        {/* Slideshow continuous mode toggle */}
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

        {slideshowContinuousMode && slideMode !== 'fade' && (
          <div class="control-row select-row">
            <span class="control-label">Transition range</span>
            <select value={continuousMotionSize} onChange={handleContinuousSizeChange}>
              {CONTINUOUS_SIZE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        )}

        {slideshowContinuousMode && slideMode !== 'fade' && (
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
        )}

        {/* Slideshow hold time (non-continuous) */}
        {(!slideshowContinuousMode || slideMode === 'fade') && (
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

        {/* Slideshow playback controls */}
        <div class="control-row slideshow-controls">
          <div style="width: 100%">
            {slideshowPlaying ? (
              <button
                class="slideshow-btn stop-btn"
                onClick={stopSlideshow}
                title="Stop slideshow"
                aria-label="Stop slideshow"
              >
                <FontAwesomeIcon icon={faStop} style={{ fontSize: "12px" }} />
                <span>Stop</span>
              </button>
            ) : (
              <button
                class="slideshow-btn play-btn"
                onClick={startSlideshow}
                title="Start slideshow"
                aria-label="Start slideshow"
              >
                <FontAwesomeIcon icon={faPlay} style={{ fontSize: "12px" }} />
                <span>Play</span>
              </button>
            )}
          </div>
        </div>

        {/* Custom settings - only shown when style is 'custom' */}
        {animationIntensity === 'custom' && (
          <>
            <div class="control-row">
              <span class="control-label">Duration</span>
              <div class="control-track">
                <input
                  type="range"
                  min="0"
                  max="5"
                  step="0.1"
                  value={customAnimation.duration}
                  onInput={(e) => setCustomAnimation({ duration: Number(e.target.value) })}
                />
                <span class="control-value">{customAnimation.duration}s</span>
              </div>
            </div>

            <div class="control-row select-row">
              <span class="control-label">Easing</span>
              <select value={customAnimation.easing} onChange={(e) => setCustomAnimation({ easing: e.target.value })}>
                {EASING_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div class="control-row select-row">
              <span class="control-label">Rotation</span>
              <select value={customAnimation.rotationType} onChange={(e) => setCustomAnimation({ rotationType: e.target.value })}>
                {DIRECTION_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {customAnimation.rotationType !== 'none' && (
              <div class="control-row">
                <span class="control-label">Degrees</span>
                <div class="control-track">
                  <input
                    type="range"
                    min="0"
                    max="60"
                    step="1"
                    value={customAnimation.rotation}
                    onInput={(e) => setCustomAnimation({ rotation: Number(e.target.value) })}
                  />
                  <span class="control-value">{customAnimation.rotation}°</span>
                </div>
              </div>
            )}

            <div class="control-row select-row">
              <span class="control-label">Zoom</span>
              <select value={customAnimation.zoomType} onChange={(e) => setCustomAnimation({ zoomType: e.target.value })}>
                {ZOOM_TYPE_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {customAnimation.zoomType !== 'none' && (
              <div class="control-row">
                <span class="control-label">Amount</span>
                <div class="control-track">
                  <input
                    type="range"
                    min="0"
                    max="4"
                    step="0.1"
                    value={customAnimation.zoom}
                    onInput={(e) => setCustomAnimation({ zoom: Number(e.target.value) })}
                  />
                  <span class="control-value">{customAnimation.zoom}x</span>
                </div>
              </div>
            )}

            <div class="control-row animate-toggle-row">
              <span class="control-label">Dolly Zoom</span>
              <label class="switch">
                <input
                  type="checkbox"
                  checked={customAnimation.dollyZoom}
                  onChange={(e) => setCustomAnimation({ dollyZoom: e.target.checked })}
                />
                <span class="switch-track" aria-hidden="true" />
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AnimationSettings;
