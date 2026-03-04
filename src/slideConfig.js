/**
 * Slide animation configuration, presets, option resolvers, and easing helpers.
 * Pure data / pure functions — no side effects, no viewer imports.
 */

// ============================================================================
// Default slide animation config (non-slideshow transitions)
// ============================================================================
export const DEFAULT_CONFIG = {
  slideIn: {
    duration: 5.2,
    ease: "power2.out",
  },
  slideOut: {
    duration: 5.2,
    ease: "power2.in",
    fadeDelay: 0.7,
  },
};

// ============================================================================
// DEFAULT SLIDE PRESETS (non-slideshow transitions)
// ============================================================================
// Edit these to override global slide timing/amounts in one place.

export const SLIDE_PRESETS = {
  slideOut: {
    transition: {
      fade: { duration: 650, amount: 0.35, fadeDelay: 0.5 },
      default: { duration: 1400, amount: 0.5, fadeDelay: 0.7 },
    },
  },
  slideIn: {
    transition: {
      fade: { duration: 750, amount: 0.45 },
      default: { duration: 1000, amount: 0.45 },
    },
    cached: {
      fade: { duration: 1000, amount: 0.5 },
      default: { duration: 1000, amount: 0.5 },
    },
  },
};

// ============================================================================
// Option resolvers — merge preset / explicit overrides / base defaults
// ============================================================================

export const resolveSlideOutOptions = (mode, options = {}) => {
  const { preset, duration, amount, fadeDelay } = options;
  const isFadeMode = mode === 'fade';
  const presetDefaults = preset
    ? (isFadeMode ? SLIDE_PRESETS.slideOut[preset]?.fade : SLIDE_PRESETS.slideOut[preset]?.default)
    : null;

  const baseDefaults = { duration: 1200, amount: 0.45, fadeDelay: 0.7 };

  return {
    duration: duration ?? presetDefaults?.duration ?? baseDefaults.duration,
    amount: amount ?? presetDefaults?.amount ?? baseDefaults.amount,
    fadeDelay: fadeDelay ?? presetDefaults?.fadeDelay ?? baseDefaults.fadeDelay,
    mode,
  };
};

export const resolveSlideInOptions = (mode, options = {}) => {
  const { preset, duration, amount } = options;
  const isFadeMode = mode === 'fade';
  const presetDefaults = preset
    ? (isFadeMode ? SLIDE_PRESETS.slideIn[preset]?.fade : SLIDE_PRESETS.slideIn[preset]?.default)
    : null;

  const baseDefaults = { duration: 1200, amount: 0.45 };

  return {
    duration: duration ?? presetDefaults?.duration ?? baseDefaults.duration,
    amount: amount ?? presetDefaults?.amount ?? baseDefaults.amount,
    mode,
  };
};

// ============================================================================
// Easing helpers
// ============================================================================

export const easingFunctions = {
  'linear': (t) => t,
  'ease-in': (t) => t * t * t,
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

export const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ============================================================================
// Continuous-mode helpers (shared by continuousAnimations.js)
// ============================================================================

export const isContinuousMode = (mode) => (
  mode === 'continuous-zoom' ||
  mode === 'continuous-dolly-zoom' ||
  mode === 'continuous-orbit' ||
  mode === 'continuous-orbit-vertical'
);
