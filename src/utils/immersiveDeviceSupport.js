const MOBILE_DEVICE_REGEX = /android|iphone|ipad|ipod|mobile|windows phone|blackberry|opera mini/i;

const isLikelyIpadOs = () => {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
};

const hasCoarsePointer = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches;
};

const hasTouchSupport = () => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return Number(navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window || hasCoarsePointer();
};

const supportsDeviceOrientationApi = () => {
  if (typeof window === 'undefined') return false;
  return 'DeviceOrientationEvent' in window || 'ondeviceorientation' in window;
};

const isLikelyMobileUserAgent = () => {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
    return navigator.userAgentData.mobile;
  }

  const userAgent = String(navigator.userAgent || '');
  return MOBILE_DEVICE_REGEX.test(userAgent) || isLikelyIpadOs();
};

export const supportsImmersiveControls = () => {
  return supportsDeviceOrientationApi() && hasTouchSupport() && isLikelyMobileUserAgent();
};