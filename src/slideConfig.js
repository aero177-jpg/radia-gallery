/**
 * Slide animation configuration, presets, option resolvers, and speed-profile helpers.
 * Pure data / pure functions — no side effects, no viewer imports.
 */
import gsap from "gsap";

// ============================================================================
// SLIDESHOW TIMING CONFIGURATION (GSAP)
// ============================================================================
// These values control the "feel" of slideshow transitions.
// Adjust durations and easing to taste. GSAP supports:
//   - Standard eases: "power1", "power2", "power3", "power4" with .in, .out, .inOut
//   - Custom bezier: "cubic-bezier(0.17, 0.67, 0.83, 0.67)" via CustomEase plugin
//   - See: https://gsap.com/docs/v3/Eases/
//
// Current setup creates continuous motion feel:
//   - Slide-in: rushes in fast, decelerates to slow drift at end
//   - Slide-out: starts with slow drift, accelerates out fast
//   - Handoff between animations feels like one continuous motion
// ============================================================================

export const SLIDESHOW_CONFIG = {
  slideIn: {
    totalDuration: 5,
    speedMultiplier: 1.0,   // >1 = faster (shorter), <1 = slower (longer)
    decelTimeRatio: 0.45,
    fastSpeed: 1.0,
    slowSpeed: 0.25,
    decelEase: "power3.out",
    slowEase: "none",
  },
  slideOut: {
    totalDuration: 3,
    speedMultiplier: 1.0,   // >1 = faster (shorter), <1 = slower (longer)
    slowTimeRatio: 0.55,
    fastSpeed: 1.0,
    slowSpeed: 0.25,
    accelEase: "power3.in",
    fadeDelay: 0.7,
  },
};

// Non-slideshow defaults (original behavior)
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
// Speed-profile helpers (for custom slideshow easing)
// ============================================================================

export const computeSpeedScale = (speedAt, totalDuration, samples = 240) => {
  let total = 0;
  let prevTime = 0;
  let prevSpeed = speedAt(0);

  for (let i = 1; i <= samples; i++) {
    const time = (totalDuration * i) / samples;
    const speed = speedAt(time);
    const dt = time - prevTime;
    total += 0.5 * (prevSpeed + speed) * dt;
    prevTime = time;
    prevSpeed = speed;
  }

  return total > 0 ? 1 / total : 1;
};

export const createSlideInSpeedProfile = (config, totalDuration) => {
  const total = totalDuration;
  const decelDur = total * config.decelTimeRatio;
  const decelEase = gsap.parseEase(config.decelEase || "power3.out");
  const slowEase = gsap.parseEase(config.slowEase || "none");

  return (time) => {
    if (time <= decelDur) {
      const t = decelDur > 0 ? time / decelDur : 1;
      const eased = decelEase(t);
      return gsap.utils.interpolate(config.fastSpeed, config.slowSpeed, eased);
    }
    const remaining = total - decelDur;
    const t = remaining > 0 ? (time - decelDur) / remaining : 1;
    slowEase(t);
    return config.slowSpeed;
  };
};

export const createSlideOutSpeedProfile = (config, totalDuration) => {
  const total = totalDuration;
  const slowDur = total * config.slowTimeRatio;
  const accelDur = Math.max(0, total - slowDur);
  const accelEase = gsap.parseEase(config.accelEase || "power3.in");

  return (time) => {
    if (time <= slowDur) {
      return config.slowSpeed;
    }
    const t = accelDur > 0 ? (time - slowDur) / accelDur : 1;
    const eased = accelEase(t);
    return gsap.utils.interpolate(config.slowSpeed, config.fastSpeed, eased);
  };
};

// ============================================================================
// Continuous-mode helpers (shared by continuousAnimations.js)
// ============================================================================

export const isContinuousMode = (mode) => (
  mode === 'continuous-zoom' ||
  mode === 'continuous-dolly-zoom' ||
  mode === 'continuous-orbit' ||
  mode === 'continuous-orbit-vertical'
);
