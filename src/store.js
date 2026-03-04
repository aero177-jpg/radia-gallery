/**
 * Zustand store - centralized application state.
 * 
 * Contains all UI state, camera settings, file info, and assets.
 * Components should use `useStore` hook to subscribe to state slices.
 * 
 * @example
 * // Subscribe to a single value
 * const fov = useStore((state) => state.fov);
 * 
 * @example
 * // Subscribe to an action
 * const setFov = useStore((state) => state.setFov);
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** Safely load a persisted boolean flag from localStorage */
const getPersistedBoolean = (key, fallback = false) => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored === 'true';
  } catch (err) {
    console.warn(`[Store] Failed to read ${key} from localStorage`, err);
    return fallback;
  }
};

/** Safely load a persisted string from localStorage */
const getPersistedString = (key, fallback = '') => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored;
  } catch (err) {
    console.warn(`[Store] Failed to read ${key} from localStorage`, err);
    return fallback;
  }
};

/** Safely load a persisted number from localStorage */
const getPersistedNumber = (key, fallback = 0) => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch (err) {
    console.warn(`[Store] Failed to read ${key} from localStorage`, err);
    return fallback;
  }
};

/** Safely load a persisted JSON object from localStorage */
const getPersistedJson = (key, fallback = null) => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    console.warn(`[Store] Failed to read ${key} from localStorage`, err);
    return fallback;
  }
};


const QUALITY_PRESET_KEY = 'qualityPreset';
const DEBUG_STOCHASTIC_KEY = 'debugStochasticRendering';
const DEBUG_SPARK_STDDEV_KEY = 'debugSparkMaxStdDev';
const DEBUG_FPS_LIMIT_KEY = 'debugFpsLimitEnabled';

const UI_PREFERENCES_KEY = 'ui-preferences';

const DEFAULT_UI_PREFS = {
  appBgColor: '#0c0d10',
  bgBlur: 40,
  disableTransparentUi: false,
  animation: {
    intensity: 'medium',
    direction: 'left',
    slideMode: 'horizontal',
    transitionSpeed: 'default',
    continuousMotionSize: 'small',
    continuousMotionDuration: 5,
    slideshowContinuousMode: true,
    continuousDollyZoom: false,
    slideshowDuration: 3,
    custom: {
      duration: 2.5,
      rotation: 30,
      rotationType: 'left',
      zoom: 1.0,
      zoomType: 'out',
      easing: 'ease-in-out',
    },
  },
};

const normalizeUiPrefs = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  const prefs = {};

  if (typeof raw.appBgColor === 'string' && raw.appBgColor) {
    prefs.appBgColor = raw.appBgColor;
  }

  if (Number.isFinite(raw.bgBlur)) {
    prefs.bgBlur = raw.bgBlur;
  }

  if (typeof raw.disableTransparentUi === 'boolean') {
    prefs.disableTransparentUi = raw.disableTransparentUi;
  }

  if (raw.animation && typeof raw.animation === 'object') {
    const anim = {};

    if (typeof raw.animation.intensity === 'string') anim.intensity = raw.animation.intensity;
    if (typeof raw.animation.direction === 'string') anim.direction = raw.animation.direction;
    if (typeof raw.animation.slideMode === 'string') anim.slideMode = raw.animation.slideMode;
    if (typeof raw.animation.transitionSpeed === 'string') anim.transitionSpeed = raw.animation.transitionSpeed;
    if (typeof raw.animation.continuousMotionSize === 'string') anim.continuousMotionSize = raw.animation.continuousMotionSize;
    if (typeof raw.animation.slideshowContinuousMode === 'boolean') {
      anim.slideshowContinuousMode = raw.animation.slideshowContinuousMode;
    }
    if (typeof raw.animation.continuousDollyZoom === 'boolean') {
      anim.continuousDollyZoom = raw.animation.continuousDollyZoom;
    }

    if (Number.isFinite(raw.animation.continuousMotionDuration)) {
      anim.continuousMotionDuration = raw.animation.continuousMotionDuration;
    }
    if (Number.isFinite(raw.animation.slideshowDuration)) {
      anim.slideshowDuration = raw.animation.slideshowDuration;
    }

    if (raw.animation.custom && typeof raw.animation.custom === 'object') {
      const custom = {};
      if (Number.isFinite(raw.animation.custom.duration)) custom.duration = raw.animation.custom.duration;
      if (Number.isFinite(raw.animation.custom.rotation)) custom.rotation = raw.animation.custom.rotation;
      if (typeof raw.animation.custom.rotationType === 'string') custom.rotationType = raw.animation.custom.rotationType;
      if (Number.isFinite(raw.animation.custom.zoom)) custom.zoom = raw.animation.custom.zoom;
      if (typeof raw.animation.custom.zoomType === 'string') custom.zoomType = raw.animation.custom.zoomType;
      if (typeof raw.animation.custom.easing === 'string') custom.easing = raw.animation.custom.easing;
      if (Object.keys(custom).length > 0) anim.custom = custom;
    }

    if (Object.keys(anim).length > 0) prefs.animation = anim;
  }

  return prefs;
};

const persistUiPrefs = (state) => {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const prefs = {};
  const anim = {};

  if (typeof state.appBgColor === 'string' && state.appBgColor
    && state.appBgColor !== DEFAULT_UI_PREFS.appBgColor) {
    prefs.appBgColor = state.appBgColor;
  }

  if (Number.isFinite(state.bgBlur) && state.bgBlur !== DEFAULT_UI_PREFS.bgBlur) {
    prefs.bgBlur = state.bgBlur;
  }

  if (typeof state.disableTransparentUi === 'boolean'
    && state.disableTransparentUi !== DEFAULT_UI_PREFS.disableTransparentUi) {
    prefs.disableTransparentUi = state.disableTransparentUi;
  }

  if (state.animationIntensity && state.animationIntensity !== DEFAULT_UI_PREFS.animation.intensity) {
    anim.intensity = state.animationIntensity;
  }
  if (state.animationDirection && state.animationDirection !== DEFAULT_UI_PREFS.animation.direction) {
    anim.direction = state.animationDirection;
  }
  if (state.slideMode && state.slideMode !== DEFAULT_UI_PREFS.animation.slideMode) {
    anim.slideMode = state.slideMode;
  }
  if (state.transitionSpeed && state.transitionSpeed !== DEFAULT_UI_PREFS.animation.transitionSpeed) {
    anim.transitionSpeed = state.transitionSpeed;
  }
  if (state.continuousMotionSize && state.continuousMotionSize !== DEFAULT_UI_PREFS.animation.continuousMotionSize) {
    anim.continuousMotionSize = state.continuousMotionSize;
  }
  if (Number.isFinite(state.continuousMotionDuration) && state.continuousMotionDuration !== DEFAULT_UI_PREFS.animation.continuousMotionDuration) {
    anim.continuousMotionDuration = state.continuousMotionDuration;
  }
  if (typeof state.slideshowContinuousMode === 'boolean' && state.slideshowContinuousMode !== DEFAULT_UI_PREFS.animation.slideshowContinuousMode) {
    anim.slideshowContinuousMode = state.slideshowContinuousMode;
  }
  if (typeof state.continuousDollyZoom === 'boolean' && state.continuousDollyZoom !== DEFAULT_UI_PREFS.animation.continuousDollyZoom) {
    anim.continuousDollyZoom = state.continuousDollyZoom;
  }
  if (Number.isFinite(state.slideshowDuration) && state.slideshowDuration !== DEFAULT_UI_PREFS.animation.slideshowDuration) {
    anim.slideshowDuration = state.slideshowDuration;
  }

  const custom = {};
  const ca = state.customAnimation || {};
  if (Number.isFinite(ca.duration) && ca.duration !== DEFAULT_UI_PREFS.animation.custom.duration) {
    custom.duration = ca.duration;
  }
  if (Number.isFinite(ca.rotation) && ca.rotation !== DEFAULT_UI_PREFS.animation.custom.rotation) {
    custom.rotation = ca.rotation;
  }
  if (ca.rotationType && ca.rotationType !== DEFAULT_UI_PREFS.animation.custom.rotationType) {
    custom.rotationType = ca.rotationType;
  }
  if (Number.isFinite(ca.zoom) && ca.zoom !== DEFAULT_UI_PREFS.animation.custom.zoom) {
    custom.zoom = ca.zoom;
  }
  if (ca.zoomType && ca.zoomType !== DEFAULT_UI_PREFS.animation.custom.zoomType) {
    custom.zoomType = ca.zoomType;
  }
  if (ca.easing && ca.easing !== DEFAULT_UI_PREFS.animation.custom.easing) {
    custom.easing = ca.easing;
  }

  if (Object.keys(custom).length > 0) {
    anim.custom = custom;
  }
  if (Object.keys(anim).length > 0) {
    prefs.animation = anim;
  }

  try {
    if (Object.keys(prefs).length === 0) {
      window.localStorage.removeItem(UI_PREFERENCES_KEY);
      return;
    }
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[Store] Failed to persist ui-preferences', err);
  }
};

const QUALITY_PRESETS = {
  high: { stdDev: 5, stochastic: false, fpsLimit: true },
  default: { stdDev: 2.5, stochastic: false, fpsLimit: true },
  performance: { stdDev: 1.8, stochastic: false, fpsLimit: false },
  experimental: { stdDev: 1.8, stochastic: true, fpsLimit: false },
};

const isMobileInitial = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) <= 768;
const persistedQualityPreset = getPersistedString(
  QUALITY_PRESET_KEY,
  isMobileInitial ? 'performance' : 'default'
);
const persistedCustomStdDev = getPersistedNumber(DEBUG_SPARK_STDDEV_KEY, Math.sqrt(5));
const persistedCustomStochastic = getPersistedBoolean(DEBUG_STOCHASTIC_KEY, false);
const persistedCustomFpsLimit = getPersistedBoolean(DEBUG_FPS_LIMIT_KEY, true);

const persistedUiPrefs = normalizeUiPrefs(getPersistedJson(UI_PREFERENCES_KEY, null));

const resolveInitialQuality = (preset) => {
  if (QUALITY_PRESETS[preset]) return QUALITY_PRESETS[preset];
  if (preset === 'debug-custom') {
    return {
      stdDev: persistedCustomStdDev,
      stochastic: persistedCustomStochastic,
      fpsLimit: persistedCustomFpsLimit,
    };
  }
  return QUALITY_PRESETS.default;
};

const initialQuality = resolveInitialQuality(persistedQualityPreset);


/** Maximum number of log entries to keep */
const MAX_LOG_ENTRIES = 14;

/** Default file info values */
const DEFAULT_FILE_INFO = {
  name: '-',
  size: '-',
  splatCount: '-',
  loadTime: '-',
  bounds: '-',
};

export const useStore = create(
  subscribeWithSelector((set, get) => ({
  // Camera settings
  fov: 60,
  cameraRange: 8,
  dollyZoomEnabled: true,
  viewerFovSlider: false,
  stereoEnabled: false,
  stereoEyeSep: 0.064,
  stereoAspect: 1.0,
  stereoScale: 1.0,
  stereoOverlap: 1.0,
  vrSupported: false,
  vrSessionActive: false,
  vrModelScale: 1,

  // Animation settings
  animationEnabled: true,
  animationIntensity: persistedUiPrefs.animation?.intensity ?? DEFAULT_UI_PREFS.animation.intensity,
  animationDirection: persistedUiPrefs.animation?.direction ?? DEFAULT_UI_PREFS.animation.direction,
  slideMode: persistedUiPrefs.animation?.slideMode ?? DEFAULT_UI_PREFS.animation.slideMode,
  transitionSpeed: persistedUiPrefs.animation?.transitionSpeed ?? DEFAULT_UI_PREFS.animation.transitionSpeed,
  continuousMotionSize: persistedUiPrefs.animation?.continuousMotionSize ?? DEFAULT_UI_PREFS.animation.continuousMotionSize,
  continuousMotionDuration: persistedUiPrefs.animation?.continuousMotionDuration ?? DEFAULT_UI_PREFS.animation.continuousMotionDuration,
  slideshowContinuousMode: persistedUiPrefs.animation?.slideshowContinuousMode ?? DEFAULT_UI_PREFS.animation.slideshowContinuousMode,
  continuousDollyZoom: persistedUiPrefs.animation?.continuousDollyZoom ?? DEFAULT_UI_PREFS.animation.continuousDollyZoom,
  slideshowDuration: persistedUiPrefs.animation?.slideshowDuration ?? DEFAULT_UI_PREFS.animation.slideshowDuration,
  slideshowPlaying: false,
  viewerControlsDimmed: false,
  
  // Custom animation settings (used when intensity is 'custom')
  customAnimation: {
    duration: persistedUiPrefs.animation?.custom?.duration ?? 2.5,
    rotation: persistedUiPrefs.animation?.custom?.rotation ?? 30,
    rotationType: persistedUiPrefs.animation?.custom?.rotationType ?? 'left',
    zoom: persistedUiPrefs.animation?.custom?.zoom ?? 1.0,
    zoomType: persistedUiPrefs.animation?.custom?.zoomType ?? 'out',
    easing: persistedUiPrefs.animation?.custom?.easing ?? 'ease-in-out',
    dollyZoom: false,
  },
  // Per-file custom animation overrides (stored in IndexedDB file-settings)
  fileCustomAnimation: {
    slideType: 'default',
    transitionRange: 'default',
    zoomProfile: 'default',
    dollyZoom: false,
  },
  // Per-file annotation text (stored in IndexedDB file-settings)
  annotation: '',

  // Custom focus state
  hasCustomFocus: false,
  focusDistanceOverride: null,
  focusSettingActive: false,
  // Temporary anchor state (set via double-click)
  anchorActive: false,
  anchorDistance: null,
  // Custom camera metadata state
  metadataMissing: false,
  customMetadataAvailable: false,
  customMetadataControlsVisible: false,
  customModelScale: 1,
  customAspectRatio: 'full',
  // Show FPS counter overlay
  showFps: false,

  // File info
  fileInfo: DEFAULT_FILE_INFO,

  // Status
  status: 'Waiting for file...',
  isLoading: false,

  // Upload progress (global overlay)
  isUploading: false,
  uploadProgress: null,

  // Assets
  assets: [],
  currentAssetIndex: -1,

  // Active storage collection
  activeSourceId: null,

  // Logs
  logs: [],

  // UI state
  panelOpen: false,
  assetSidebarOpen: false,
  expandedViewer: false,
  suppressSizeTransition: false,
  logExpanded: false,
  animSettingsExpanded: false,
  cameraSettingsExpanded: true,
  galleryExpanded: true,
  controlsModalOpen: false,
  controlsModalDefaultSubsections: [],
  
  // Mobile state - initialize with actual values to prevent flash on load
  isMobile: typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) <= 768,
  isPortrait: typeof window !== 'undefined' && window.innerHeight > window.innerWidth,
  immersiveMode: false,
  immersiveSensitivity: 1.0,
  appBgColor: persistedUiPrefs.appBgColor ?? '#0c0d10',
  bgBlur: persistedUiPrefs.bgBlur ?? 40,
  disableTransparentUi: persistedUiPrefs.disableTransparentUi ?? false,
  fillMode: false,
  
  // Debug
  debugLoadingMode: false,
  debugSettingsExpanded: false,
  debugStochasticRendering: initialQuality.stochastic,
  debugFpsLimitEnabled: initialQuality.fpsLimit,
  debugSparkMaxStdDev: initialQuality.stdDev,
  qualityPreset: (QUALITY_PRESETS[persistedQualityPreset] || persistedQualityPreset === 'debug-custom')
    ? persistedQualityPreset
    : 'default',

  // ============ Actions ============
  
  /** Sets camera field of view */
  setFov: (fov) => set({ fov }),

  /** Shows/hides the viewer FOV slider overlay */
  setViewerFovSlider: (visible) => set({ viewerFovSlider: visible }),

  /** Toggles the viewer FOV slider overlay */
  toggleViewerFovSlider: () => set((state) => ({ viewerFovSlider: !state.viewerFovSlider })),
  
  /** Sets camera orbit range in degrees */
  setCameraRange: (range) => set({ cameraRange: range }),

  /** Opens/closes the controls modal */
  setControlsModalOpen: (controlsModalOpen) => set({ controlsModalOpen }),

  /** Sets default open subsections for the controls modal */
  setControlsModalDefaultSubsections: (controlsModalDefaultSubsections) => set({ controlsModalDefaultSubsections }),

  /** Opens the controls modal with specific subsections expanded */
  openControlsModalWithSections: (controlsModalDefaultSubsections) => set({
    controlsModalOpen: true,
    controlsModalDefaultSubsections,
  }),

  /** Toggles the controls modal */
  toggleControlsModal: () => set((state) => ({ controlsModalOpen: !state.controlsModalOpen })),
  
  /** Enables/disables dolly zoom compensation */
  setDollyZoomEnabled: (enabled) => set({ dollyZoomEnabled: enabled }),

  /** Enables/disables side-by-side stereo rendering */
  setStereoEnabled: (enabled) => set({ stereoEnabled: enabled }),

  /** Sets stereo eye separation distance */
  setStereoEyeSep: (eyeSep) => set({ stereoEyeSep: eyeSep }),

  /** Sets stereo aspect ratio */
  setStereoAspect: (aspect) => set({ stereoAspect: aspect }),

  /** Sets stereo render scale */
  setStereoScale: (scale) => set({ stereoScale: scale }),

  /** Sets stereo overlap width fraction (1.0 = full width, lower = narrower) */
  setStereoOverlap: (overlap) => set({ stereoOverlap: overlap }),

  /** Marks whether WebXR/VR is available */
  setVrSupported: (vrSupported) => set({ vrSupported }),

  /** Tracks if a VR session is active */
  setVrSessionActive: (vrSessionActive) => set({ vrSessionActive }),

  /** Tracks model scale while in VR */
  setVrModelScale: (vrModelScale) => set({ vrModelScale }),

  /** Deprecated: toggles legacy fill-to-screen projection vs fit-to-bounds */
  toggleFillMode: () => set((state) => ({ fillMode: !state.fillMode })),

  /** Deprecated: sets legacy fill-to-screen projection mode */
  setFillMode: (fillMode) => set({ fillMode }),
  
  /** Enables/disables load animation */
  setAnimationEnabled: (enabled) => set({ animationEnabled: enabled }),
  
  /** Sets animation intensity preset */
  setAnimationIntensity: (intensity) => {
    set({ animationIntensity: intensity });
    persistUiPrefs({ ...get(), animationIntensity: intensity });
  },
  
  /** Sets animation sweep direction */
  setAnimationDirection: (direction) => {
    set({ animationDirection: direction });
    persistUiPrefs({ ...get(), animationDirection: direction });
  },
  
  /** Sets slide transition mode */
  setSlideMode: (mode) => {
    set({ slideMode: mode });
    persistUiPrefs({ ...get(), slideMode: mode });
  },

  /** Sets transition speed preset (snappy / default / vibe) */
  setTransitionSpeed: (speed) => {
    set({ transitionSpeed: speed });
    persistUiPrefs({ ...get(), transitionSpeed: speed });
  },

  /** Sets continuous motion size preset */
  setContinuousMotionSize: (size) => {
    set({ continuousMotionSize: size });
    persistUiPrefs({ ...get(), continuousMotionSize: size });
  },

  /** Sets continuous motion duration in seconds */
  setContinuousMotionDuration: (duration) => {
    set({ continuousMotionDuration: duration });
    persistUiPrefs({ ...get(), continuousMotionDuration: duration });
  },

  /** Sets continuous mode for slideshow */
  setSlideshowContinuousMode: (enabled) => {
    set({ slideshowContinuousMode: enabled });
    persistUiPrefs({ ...get(), slideshowContinuousMode: enabled });
  },

  /** Enables/disables continuous dolly-zoom (zoom + continuous) */
  setContinuousDollyZoom: (enabled) => {
    set({ continuousDollyZoom: enabled });
    persistUiPrefs({ ...get(), continuousDollyZoom: enabled });
  },
  


  /** Sets slideshow hold duration in seconds */
  setSlideshowDuration: (duration) => {
    set({ slideshowDuration: duration });
    persistUiPrefs({ ...get(), slideshowDuration: duration });
  },

  /** Sets global upload state for viewer overlay */
  setUploadState: ({ isUploading, uploadProgress }) => set({
    isUploading: Boolean(isUploading),
    uploadProgress: uploadProgress || null,
  }),
  
  /** Sets slideshow playing state */
  setSlideshowPlaying: (playing) => set({ slideshowPlaying: playing }),

  /** Sets whether viewer-adjacent controls are dimmed */
  setViewerControlsDimmed: (dimmed) => set({ viewerControlsDimmed: Boolean(dimmed) }),

  /** Toggles viewer-adjacent controls dimmed state */
  toggleViewerControlsDimmed: () => set((state) => ({ viewerControlsDimmed: !state.viewerControlsDimmed })),
  
  /** Updates custom animation settings (merges with existing) */
  setCustomAnimation: (settings) => set((state) => {
    const nextCustomAnimation = { ...state.customAnimation, ...settings };
    const nextState = { ...state, customAnimation: nextCustomAnimation };
    persistUiPrefs(nextState);
    return { customAnimation: nextCustomAnimation };
  }),

  /** Updates per-file custom animation settings (merges with existing) */
  setFileCustomAnimation: (settings) => set((state) => ({
    fileCustomAnimation: { ...state.fileCustomAnimation, ...settings },
  })),

  /** Sets per-file annotation text */
  setAnnotation: (annotation) => set({ annotation: typeof annotation === 'string' ? annotation : '' }),

  /** Sets custom focus state */
  setHasCustomFocus: (hasCustomFocus) => set({ hasCustomFocus }),
  setFocusDistanceOverride: (focusDistanceOverride) => set({ focusDistanceOverride }),
  setFocusSettingActive: (focusSettingActive) => set({ focusSettingActive }),

  /** Sets temporary anchor state */
  setAnchorState: ({ active, distance }) => set({
    anchorActive: Boolean(active),
    anchorDistance: distance ?? null,
  }),

  /** Custom metadata flags */
  setMetadataMissing: (metadataMissing) => set({ metadataMissing }),
  setCustomMetadataAvailable: (customMetadataAvailable) => set({ customMetadataAvailable }),
  setCustomMetadataControlsVisible: (customMetadataControlsVisible) => set({ customMetadataControlsVisible }),
  setCustomModelScale: (customModelScale) => set({ customModelScale }),
  setCustomAspectRatio: (customAspectRatio) => set({ customAspectRatio }),
  
  /** Updates file info (merges with existing) */
  setFileInfo: (info) => set((state) => ({ 
    fileInfo: { ...state.fileInfo, ...info } 
  })),
  
  /** Resets file info to defaults */
  resetFileInfo: () => set({ fileInfo: DEFAULT_FILE_INFO }),
  
  /** Sets status message and logs it */
  setStatus: (status) => {
    set({ status });
    get().addLog(status);
  },
  
  /** Sets loading state */
  setIsLoading: (isLoading) => set({ isLoading }),
  
  /** Adds a timestamped log entry */
  addLog: (message) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
    set((state) => ({
      logs: [entry, ...state.logs.slice(0, MAX_LOG_ENTRIES - 1)]
    }));
    console.info(message);
  },
  
  /** Sets the loaded assets array */
  setAssets: (assets) => set({ assets }),
  
  /** Sets current asset index */
  setCurrentAssetIndex: (index) => set({ currentAssetIndex: index }),
  
  /** Updates preview thumbnail for an asset */
  updateAssetPreview: (index, preview) => set((state) => ({
    assets: state.assets.map((asset, i) => 
      i === index ? { ...asset, preview } : asset
    )
  })),
  
  /** Sets panel open state */
  setPanelOpen: (open) => set({ panelOpen: open }),

  /** Sets asset sidebar open state */
  setAssetSidebarOpen: (open) => set({ assetSidebarOpen: open }),

  /** Toggles asset sidebar open/closed */
  toggleAssetSidebar: () => set((state) => ({ assetSidebarOpen: !state.assetSidebarOpen })),

  /** Sets expanded viewer mode */
  setExpandedViewer: (expanded) => set({ expandedViewer: Boolean(expanded) }),

  /** Toggles expanded viewer mode */
  toggleExpandedViewer: () => set((state) => ({ expandedViewer: !state.expandedViewer })),

  /** Sets whether viewer size transitions are suppressed */
  setSuppressSizeTransition: (value) => set({ suppressSizeTransition: Boolean(value) }),
  
  /** Toggles panel open/closed */
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  
  /** Sets log panel expanded state */
  setLogExpanded: (expanded) => set({ logExpanded: expanded }),
  
  /** Toggles log panel expanded */
  toggleLogExpanded: () => set((state) => ({ logExpanded: !state.logExpanded })),
  
  /** Sets animation settings expanded state */
  setAnimSettingsExpanded: (expanded) => set({ animSettingsExpanded: expanded }),
  
  /** Toggles animation settings expanded */
  toggleAnimSettingsExpanded: () => set((state) => ({ 
    animSettingsExpanded: !state.animSettingsExpanded 
  })),
  
  /** Toggles camera settings expanded */
  toggleCameraSettingsExpanded: () => set((state) => ({ 
    cameraSettingsExpanded: !state.cameraSettingsExpanded 
  })),

  /** Sets camera settings expanded state */
  setCameraSettingsExpanded: (expanded) => set({ cameraSettingsExpanded: expanded }),
  
  /** Toggles gallery expanded */
  toggleGalleryExpanded: () => set((state) => ({ 
    galleryExpanded: !state.galleryExpanded 
  })),

  /** Marks which storage source is currently in use */
  setActiveSourceId: (sourceId) => set({ activeSourceId: sourceId }),

  /** Clears active storage source (used for ad-hoc file loads) */
  clearActiveSource: () => set({ activeSourceId: null }),
  
  /** Sets mobile state */
  setMobileState: (isMobile, isPortrait) => set({ isMobile, isPortrait }),
  
  /** Sets immersive mode */
  setImmersiveMode: (enabled) => set({ immersiveMode: enabled }),
  
  /** Toggles immersive mode */
  toggleImmersiveMode: () => set((state) => ({ immersiveMode: !state.immersiveMode })),
  
  /** Sets immersive mode sensitivity multiplier */
  setImmersiveSensitivity: (sensitivity) => set({ immersiveSensitivity: sensitivity }),

  /** Sets visibility of FPS counter overlay */
  setShowFps: (show) => set({ showFps: show }),

  /** Sets app background color and updates theme-color meta tags */
  setAppBgColor: (appBgColor) => {
    set({ appBgColor });
    persistUiPrefs({ ...get(), appBgColor });
    // Apply to DOM — skip when expanded viewer is active (forced black)
    if (typeof document !== 'undefined') {
      const effectiveColor = get().expandedViewer ? '#000000' : appBgColor;
      document.documentElement.style.background = effectiveColor;
      document.body.style.background = effectiveColor;
      document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
        el.setAttribute('content', effectiveColor);
      });
      // Toggle custom-bg flag so CSS can hide viewer border
      if (!get().expandedViewer && appBgColor && appBgColor !== '#0c0d10') {
        document.documentElement.setAttribute('data-custom-bg', '');
      } else {
        document.documentElement.removeAttribute('data-custom-bg');
      }
    }
  },

  /** Sets blur amount for background container */
  setBgBlur: (bgBlur) => {
    set({ bgBlur });
    persistUiPrefs({ ...get(), bgBlur });
  },

  /** Enables/disables transparent UI for modals */
  setDisableTransparentUi: (disableTransparentUi) => {
    set({ disableTransparentUi: Boolean(disableTransparentUi) });
    persistUiPrefs({ ...get(), disableTransparentUi: Boolean(disableTransparentUi) });
  },

  /** Enables/disables stochastic rendering in Spark */
  setDebugStochasticRendering: (enabled) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(DEBUG_STOCHASTIC_KEY, String(enabled));
      } catch (err) {
        console.warn('[Store] Failed to persist debugStochasticRendering', err);
      }
    }
    set({ debugStochasticRendering: enabled });
  },

  /** Enables/disables FPS limiting in the render loop */
  setDebugFpsLimitEnabled: (enabled) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(DEBUG_FPS_LIMIT_KEY, String(enabled));
      } catch (err) {
        console.warn('[Store] Failed to persist debugFpsLimitEnabled', err);
      }
    }
    set({ debugFpsLimitEnabled: enabled });
  },

  /** Sets Spark splat maxStdDev (rendering width) */
  setDebugSparkMaxStdDev: (value) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(DEBUG_SPARK_STDDEV_KEY, String(value));
      } catch (err) {
        console.warn('[Store] Failed to persist debugSparkMaxStdDev', err);
      }
    }
    set({ debugSparkMaxStdDev: value });
  },

  /** Sets rendering quality preset and persists it */
  setQualityPreset: (preset) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(QUALITY_PRESET_KEY, String(preset));
      } catch (err) {
        console.warn('[Store] Failed to persist qualityPreset', err);
      }
    }
    if (QUALITY_PRESETS[preset]) {
      const { stdDev, stochastic, fpsLimit } = QUALITY_PRESETS[preset];
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(DEBUG_SPARK_STDDEV_KEY, String(stdDev));
          window.localStorage.setItem(DEBUG_STOCHASTIC_KEY, String(stochastic));
          window.localStorage.setItem(DEBUG_FPS_LIMIT_KEY, String(fpsLimit));
        } catch (err) {
          console.warn('[Store] Failed to persist quality preset values', err);
        }
      }
      set({
        qualityPreset: preset,
        debugSparkMaxStdDev: stdDev,
        debugStochasticRendering: stochastic,
        debugFpsLimitEnabled: fpsLimit,
      });
      return;
    }
    set({ qualityPreset: preset });
  },
  
  /** Toggles debug loading mode */
  toggleDebugLoadingMode: () => set((state) => ({ 
    debugLoadingMode: !state.debugLoadingMode 
  })),

  /** Toggles debug settings accordion */
  toggleDebugSettingsExpanded: () => set((state) => ({ 
    debugSettingsExpanded: !state.debugSettingsExpanded 
  })),
}))
);
