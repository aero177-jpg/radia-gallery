/**
 * VR Overlay — full-screen modal shown on the desktop monitor while a VR session
 * is active.  Provides large prev/next navigation arrows, a "Save VR View"
 * button, an "Open Gallery" sidebar toggle, and an "Exit VR" button.
 */

import { useCallback, useState, useEffect, useRef } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronLeft,
  faChevronRight,
  faCog,
  faSave,
  faSignOutAlt,
  faTh,
} from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store';
import { KeyboardIcon } from '../icons/customIcons';
import {
  hasSavedVrPivotOverrideForAsset,
  hasSavedVrFarClipOverrideForAsset,
  hasSavedVrNearClipOverrideForAsset,
  hasSavedVrViewForAsset,
  loadNextAsset,
  loadPrevAsset,
} from '../fileLoader';
import {
  exitVrSessionAndRefresh,
  getDefaultCurrentVrFarClip,
  getDefaultCurrentVrNearClip,
  getCurrentVrFarClip,
  getCurrentVrModelTransform,
  getCurrentVrNearClip,
  setCurrentVrFarClip,
  setCurrentVrNearClip,
} from '../vrMode';
import { saveCustomVrView, saveViewCustomVrView, saveVrFarClip, saveVrNearClip } from '../fileStorage';
import {
  updateCustomVrViewInCache,
  clearCustomVrViewInCache,
  updateViewCustomVrViewInCache,
  clearViewCustomVrViewInCache,
  updateVrFarClipInCache,
  updateVrNearClipInCache,
} from '../splatManager';

const MIN_VR_NEAR_CLIP = 0.001;
const MAX_VR_NEAR_CLIP = 1;
const DEFAULT_VR_NEAR_CLIP = 0.01;
const MIN_VR_FAR_CLIP = 0.1;
const MAX_VR_FAR_CLIP = 200;
const DEFAULT_VR_FAR_CLIP = 200;

const clampVrNearClip = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VR_NEAR_CLIP;
  return Math.min(Math.max(numeric, MIN_VR_NEAR_CLIP), MAX_VR_NEAR_CLIP);
};

const sliderValueToVrNearClip = (sliderValue) => {
  const t = Math.min(Math.max(Number(sliderValue) / 100, 0), 1);
  const logMin = Math.log10(MIN_VR_NEAR_CLIP);
  const logMax = Math.log10(MAX_VR_NEAR_CLIP);
  return 10 ** (logMin + (logMax - logMin) * t);
};

const vrNearClipToSliderValue = (nearClip) => {
  const clipped = clampVrNearClip(nearClip);
  const logMin = Math.log10(MIN_VR_NEAR_CLIP);
  const logMax = Math.log10(MAX_VR_NEAR_CLIP);
  return ((Math.log10(clipped) - logMin) / (logMax - logMin)) * 100;
};

const formatVrNearClip = (nearClip) => {
  const clipped = clampVrNearClip(nearClip);
  if (clipped < 0.01) return clipped.toFixed(3);
  if (clipped < 0.1) return clipped.toFixed(2);
  return clipped.toFixed(1);
};

const clampVrFarClip = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VR_FAR_CLIP;
  return Math.min(Math.max(numeric, MIN_VR_FAR_CLIP), MAX_VR_FAR_CLIP);
};

const sliderValueToVrFarClip = (sliderValue) => {
  const t = Math.min(Math.max(Number(sliderValue) / 100, 0), 1);
  const logMin = Math.log10(MIN_VR_FAR_CLIP);
  const logMax = Math.log10(MAX_VR_FAR_CLIP);
  return 10 ** (logMin + (logMax - logMin) * t);
};

const vrFarClipToSliderValue = (farClip) => {
  const clipped = clampVrFarClip(farClip);
  const logMin = Math.log10(MIN_VR_FAR_CLIP);
  const logMax = Math.log10(MAX_VR_FAR_CLIP);
  return ((Math.log10(clipped) - logMin) / (logMax - logMin)) * 100;
};

const formatVrFarClip = (farClip) => {
  const clipped = clampVrFarClip(farClip);
  return clipped >= 100 ? Math.round(clipped).toString() : clipped.toFixed(1);
};

function VrOverlay() {
  const vrSessionActive = useStore((state) => state.vrSessionActive);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const customMetadataAvailable = useStore((state) => state.customMetadataAvailable);
  const setAssetSidebarOpen = useStore((state) => state.setAssetSidebarOpen);
  const setPanelOpen = useStore((state) => state.setPanelOpen);
  const openControlsModalWithSections = useStore((state) => state.openControlsModalWithSections);
  const vrPivotStatusMessage = useStore((state) => state.vrPivotStatusMessage);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [vrNearClip, setVrNearClip] = useState(() => getCurrentVrNearClip());
  const [vrFarClip, setVrFarClip] = useState(() => getCurrentVrFarClip());
  const [vrNearClipEnabled, setVrNearClipEnabled] = useState(false);
  const [vrFarClipEnabled, setVrFarClipEnabled] = useState(false);
  const nearClipSaveTimeoutRef = useRef(null);
  const farClipSaveTimeoutRef = useRef(null);

  const currentAsset =
    currentAssetIndex >= 0 && currentAssetIndex < assets.length
      ? assets[currentAssetIndex]
      : null;

  const hasMultipleAssets = assets.length > 1;
  const displayName =
    currentAsset?.displayName || currentAsset?.name || 'Unknown asset';
  const hasSavedVrView = hasSavedVrViewForAsset(currentAsset);
  const hasSavedVrPivot = hasSavedVrPivotOverrideForAsset(currentAsset);
  const showCustomVrViewControls = customMetadataAvailable;

  // Reset save status when asset changes
  useEffect(() => {
    setSaveStatus(null);
  }, [currentAssetIndex]);

  useEffect(() => {
    if (!vrSessionActive) return;
    setVrNearClip(getCurrentVrNearClip());
    setVrFarClip(getCurrentVrFarClip());
    setVrNearClipEnabled(hasSavedVrNearClipOverrideForAsset(currentAsset));
    setVrFarClipEnabled(hasSavedVrFarClipOverrideForAsset(currentAsset));
  }, [vrSessionActive, currentAsset, currentAssetIndex]);

  useEffect(() => () => {
    if (nearClipSaveTimeoutRef.current) {
      clearTimeout(nearClipSaveTimeoutRef.current);
      nearClipSaveTimeoutRef.current = null;
    }
    if (farClipSaveTimeoutRef.current) {
      clearTimeout(farClipSaveTimeoutRef.current);
      farClipSaveTimeoutRef.current = null;
    }
  }, []);

  const handlePrev = useCallback(() => {
    loadPrevAsset();
  }, []);

  const handleNext = useCallback(() => {
    loadNextAsset();
  }, []);

  const handleExitVr = useCallback(() => {
    void exitVrSessionAndRefresh();
  }, []);

  const handleOpenGallery = useCallback(() => {
    setAssetSidebarOpen(true);
  }, [setAssetSidebarOpen]);

  const handleOpenSidebar = useCallback(() => {
    setPanelOpen(true);
  }, [setPanelOpen]);

  const handleOpenVrControls = useCallback(() => {
    openControlsModalWithSections([
      'controls.vr',
      'troubleshooting.vr',
    ]);
  }, [openControlsModalWithSections]);

  const persistVrNearClip = useCallback(async (nextNearClip) => {
    if (!currentAsset) return;

    const baseName = currentAsset.baseAssetName || currentAsset.name;
    const baseAssetId = currentAsset.cacheKey || currentAsset.baseAssetId || currentAsset.id;
    if (!baseName || baseName === '-') return;

    const normalizedNearClip = Number.isFinite(nextNearClip) ? clampVrNearClip(nextNearClip) : undefined;
    const saved = await saveVrNearClip(baseName, normalizedNearClip);
    if (!saved) return;

    if (baseAssetId) {
      updateVrNearClipInCache(baseAssetId, normalizedNearClip);
    }
  }, [currentAsset]);

  const persistVrFarClip = useCallback(async (nextFarClip) => {
    if (!currentAsset) return;

    const baseName = currentAsset.baseAssetName || currentAsset.name;
    const baseAssetId = currentAsset.cacheKey || currentAsset.baseAssetId || currentAsset.id;
    if (!baseName || baseName === '-') return;

    const normalizedFarClip = Number.isFinite(nextFarClip) ? clampVrFarClip(nextFarClip) : undefined;
    const saved = await saveVrFarClip(baseName, normalizedFarClip);
    if (!saved) return;

    if (baseAssetId) {
      updateVrFarClipInCache(baseAssetId, normalizedFarClip);
    }
  }, [currentAsset]);

  const handleVrNearClipChange = useCallback((event) => {
    if (!vrNearClipEnabled) return;
    const sliderValue = Number.parseFloat(event?.target?.value);
    if (!Number.isFinite(sliderValue)) return;

    const nextNearClip = clampVrNearClip(sliderValueToVrNearClip(sliderValue));
    const appliedNearClip = setCurrentVrNearClip(nextNearClip);
    if (!Number.isFinite(appliedNearClip)) return;

    setVrNearClip(appliedNearClip);

    if (nearClipSaveTimeoutRef.current) {
      clearTimeout(nearClipSaveTimeoutRef.current);
    }

    nearClipSaveTimeoutRef.current = setTimeout(() => {
      nearClipSaveTimeoutRef.current = null;
      void persistVrNearClip(appliedNearClip);
    }, 180);
  }, [persistVrNearClip, vrNearClipEnabled]);

  const handleVrFarClipChange = useCallback((event) => {
    if (!vrFarClipEnabled) return;
    const sliderValue = Number.parseFloat(event?.target?.value);
    if (!Number.isFinite(sliderValue)) return;

    const nextFarClip = clampVrFarClip(sliderValueToVrFarClip(sliderValue));
    const appliedFarClip = setCurrentVrFarClip(nextFarClip);
    if (!Number.isFinite(appliedFarClip)) return;

    setVrFarClip(appliedFarClip);

    if (farClipSaveTimeoutRef.current) {
      clearTimeout(farClipSaveTimeoutRef.current);
    }

    farClipSaveTimeoutRef.current = setTimeout(() => {
      farClipSaveTimeoutRef.current = null;
      void persistVrFarClip(appliedFarClip);
    }, 180);
  }, [persistVrFarClip, vrFarClipEnabled]);

  const handleVrNearClipToggle = useCallback(() => {
    const nextEnabled = !vrNearClipEnabled;
    setVrNearClipEnabled(nextEnabled);

    if (nearClipSaveTimeoutRef.current) {
      clearTimeout(nearClipSaveTimeoutRef.current);
      nearClipSaveTimeoutRef.current = null;
    }

    if (!nextEnabled) {
      const fallbackNearClip = getDefaultCurrentVrNearClip();
      const appliedNearClip = setCurrentVrNearClip(fallbackNearClip);
      if (Number.isFinite(appliedNearClip)) {
        setVrNearClip(appliedNearClip);
      }
      void persistVrNearClip(undefined);
      return;
    }

    const appliedNearClip = setCurrentVrNearClip(vrNearClip);
    if (Number.isFinite(appliedNearClip)) {
      setVrNearClip(appliedNearClip);
      void persistVrNearClip(appliedNearClip);
    }
  }, [persistVrNearClip, vrNearClip, vrNearClipEnabled]);

  const handleVrFarClipToggle = useCallback(() => {
    const nextEnabled = !vrFarClipEnabled;
    setVrFarClipEnabled(nextEnabled);

    if (farClipSaveTimeoutRef.current) {
      clearTimeout(farClipSaveTimeoutRef.current);
      farClipSaveTimeoutRef.current = null;
    }

    if (!nextEnabled) {
      const fallbackFarClip = getDefaultCurrentVrFarClip();
      const appliedFarClip = setCurrentVrFarClip(fallbackFarClip);
      if (Number.isFinite(appliedFarClip)) {
        setVrFarClip(appliedFarClip);
      }
      void persistVrFarClip(undefined);
      return;
    }

    const appliedFarClip = setCurrentVrFarClip(vrFarClip);
    if (Number.isFinite(appliedFarClip)) {
      setVrFarClip(appliedFarClip);
      void persistVrFarClip(appliedFarClip);
    }
  }, [persistVrFarClip, vrFarClip, vrFarClipEnabled]);

  const handleSaveVrView = useCallback(async () => {
    if (!currentAsset) return;

    const transform = getCurrentVrModelTransform();
    if (!transform) {
      setSaveStatus('error');
      return;
    }

    setSaveStatus('saving');

    const baseName = currentAsset.baseAssetName || currentAsset.name;
    const cacheKeyId =
      currentAsset.cacheKey || currentAsset.baseAssetId || currentAsset.id;
    const currentViewId = currentAsset.viewId;

    try {
      // 1. Persist to IndexedDB
      if (baseName && baseName !== '-') {
        if (currentViewId) {
          await saveViewCustomVrView(baseName, currentViewId, transform);
        } else {
          await saveCustomVrView(baseName, transform);
        }
      }

      // 2. Update in-memory cache
      if (cacheKeyId) {
        if (currentViewId) {
          clearViewCustomVrViewInCache(cacheKeyId, currentViewId);
          updateViewCustomVrViewInCache(cacheKeyId, currentViewId, transform);
        } else {
          clearCustomVrViewInCache(cacheKeyId);
          updateCustomVrViewInCache(cacheKeyId, transform);
        }
      }

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.warn('[VrOverlay] Failed to save VR view:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    }
  }, [currentAsset]);

  if (!vrSessionActive) return null;

  return (
    <div class="vr-overlay">
      <div class="vr-overlay__content">
        <div class="vr-overlay__header">
          <h2 class="vr-overlay__title">VR Session Active</h2>
          <div class="vr-overlay__asset-meta">
            <p class="vr-overlay__asset-name" title={displayName}>
              {currentAssetIndex + 1} / {assets.length} &mdash; {displayName}
            </p>
            {showCustomVrViewControls && (
              <span
                class={`vr-overlay__pose-indicator ${hasSavedVrView ? 'is-saved' : 'is-unsaved'}`}
                title={hasSavedVrView ? 'A VR view is saved for this camera pose' : 'No VR view is saved for this camera pose yet'}
              >
                {hasSavedVrView ? 'VR view saved' : 'No VR view saved'}
              </span>
            )}
          </div>
        </div>

        <div class="vr-overlay__nav">
          {hasMultipleAssets && (
            <button
              class="vr-overlay__nav-btn vr-overlay__nav-btn--prev"
              onClick={handlePrev}
              aria-label="Previous asset"
              title="Previous asset"
            >
              <FontAwesomeIcon icon={faChevronLeft} />
            </button>
          )}

          {showCustomVrViewControls ? (
            <button
              class={`vr-overlay__save-btn ${saveStatus === 'saved' ? 'is-saved' : ''} ${saveStatus === 'error' ? 'is-error' : ''}`}
              onClick={handleSaveVrView}
              disabled={saveStatus === 'saving'}
              aria-label="Save VR view"
              title="Save current VR model position, rotation and scale"
            >
              <FontAwesomeIcon icon={faSave} />
              <span>
                {saveStatus === 'saving'
                  ? 'Saving…'
                  : saveStatus === 'saved'
                    ? 'Saved!'
                    : saveStatus === 'error'
                      ? 'Error'
                      : 'Save VR View'}
              </span>
            </button>
          ) : hasMultipleAssets ? (
            <div class="vr-overlay__nav-spacer" aria-hidden="true" />
          ) : null}

          {hasMultipleAssets && (
            <button
              class="vr-overlay__nav-btn vr-overlay__nav-btn--next"
              onClick={handleNext}
              aria-label="Next asset"
              title="Next asset"
            >
              <FontAwesomeIcon icon={faChevronRight} />
            </button>
          )}
        </div>

        <div class="vr-overlay__slider-group">
          <div class="vr-overlay__slider-row">
            <div class="vr-overlay__slider-header">
              <div class="vr-overlay__slider-title-row">
                <span class="vr-overlay__slider-label">VR near clip</span>
                <button
                  class={`vr-overlay__toggle ${vrNearClipEnabled ? 'is-on' : 'is-off'}`}
                  type="button"
                  onClick={handleVrNearClipToggle}
                  aria-pressed={vrNearClipEnabled}
                  title={vrNearClipEnabled ? 'Disable near clip override' : 'Enable near clip override'}
                >
                  {vrNearClipEnabled ? 'On' : 'Off'}
                </button>
              </div>
              <span class="vr-overlay__slider-value">{formatVrNearClip(vrNearClip)}</span>
            </div>
            <input
              class="vr-overlay__slider"
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={vrNearClipToSliderValue(vrNearClip)}
              onInput={handleVrNearClipChange}
              disabled={!vrNearClipEnabled}
              aria-label="VR near clip"
              title="Adjust VR near clip for this base model"
            />
          </div>

          <div class="vr-overlay__slider-row">
            <div class="vr-overlay__slider-header">
              <div class="vr-overlay__slider-title-row">
                <span class="vr-overlay__slider-label">VR far clip</span>
                <button
                  class={`vr-overlay__toggle ${vrFarClipEnabled ? 'is-on' : 'is-off'}`}
                  type="button"
                  onClick={handleVrFarClipToggle}
                  aria-pressed={vrFarClipEnabled}
                  title={vrFarClipEnabled ? 'Disable far clip override' : 'Enable far clip override'}
                >
                  {vrFarClipEnabled ? 'On' : 'Off'}
                </button>
              </div>
              <span class="vr-overlay__slider-value">{formatVrFarClip(vrFarClip)}</span>
            </div>
            <input
              class="vr-overlay__slider"
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={vrFarClipToSliderValue(vrFarClip)}
              onInput={handleVrFarClipChange}
              disabled={!vrFarClipEnabled}
              aria-label="VR far clip"
              title="Adjust VR far clip for this base model"
            />
          </div>
        </div>

        <div class="vr-overlay__actions">
          {hasMultipleAssets && (
            <button
              class="vr-overlay__action-btn"
              onClick={handleOpenGallery}
              aria-label="Open gallery"
              title="Open asset gallery sidebar"
            >
              <FontAwesomeIcon icon={faTh} />
              <span>Open Gallery</span>
            </button>
          )}

          <button
            class="vr-overlay__action-btn vr-overlay__action-btn--exit"
            onClick={handleExitVr}
            aria-label="Exit VR"
            title="End VR session"
          >
            <FontAwesomeIcon icon={faSignOutAlt} />
            <span>Exit VR</span>
          </button>

          <button
            class="vr-overlay__action-btn"
            onClick={handleOpenSidebar}
            aria-label="Open sidebar"
            title="Open settings sidebar"
          >
            <FontAwesomeIcon icon={faCog} />
            <span>Open Sidebar</span>
          </button>
        </div>

        <div class="vr-overlay__controls-row">
          <button
            class="vr-overlay__controls-link"
            type="button"
            onClick={handleOpenVrControls}
            aria-label="Open VR controls help"
            title="Open VR controls help"
          >
            <KeyboardIcon size={20} />
            <span>VR Controls</span>
          </button>
        </div>

        <div class="vr-overlay__hint">
          <p>
            Pivot: {hasSavedVrPivot ? 'custom point' : 'default behavior'}.
          </p>
          <p>
            {vrPivotStatusMessage || 'To save a pivot, grab the model with the right hand and press the left trigger.'}
          </p>
        </div>

        {showCustomVrViewControls && (
          <div class="vr-overlay__hint">
            <p>
              Scenes with multiple custom camera poses do not align correctly in VR. As a workaround,
              save a VR view after you switch to the custom camera pose you want to use.
            </p>
            <p>
              You can recall that pose later from the gallery sidebar. You can only add a VR view to existing camera poses. 
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default VrOverlay;
