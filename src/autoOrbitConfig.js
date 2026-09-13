/**
 * Shared settings and motion profiles for custom-model auto orbit.
 */

export const AUTO_ORBIT_MODES = new Set(['rotate', 'orbit']);
export const AUTO_ORBIT_SPEEDS = new Set(['slow', 'medium', 'fast']);
export const AUTO_ORBIT_PATHS = new Set(['360-clockwise', '360-counterclockwise', '180']);

export const DEFAULT_AUTO_ORBIT_SETTINGS = {
  enabled: false,
  mode: 'orbit',
  speed: 'medium',
  path: '360-clockwise',
};

export const AUTO_ORBIT_MODE_OPTIONS = [
  { value: 'rotate', label: 'Rotate' },
  { value: 'orbit', label: 'Orbit' },
];

export const AUTO_ORBIT_SPEED_OPTIONS = [
  { value: 'slow', label: 'Slow' },
  { value: 'medium', label: 'Medium' },
  { value: 'fast', label: 'Fast' },
];

export const AUTO_ORBIT_PATH_OPTIONS = [
  { value: '360-clockwise', label: '360 clockwise' },
  { value: '360-counterclockwise', label: '360 counterclockwise' },
  { value: '180', label: '180' },
];

export const getAutoOrbitParameters = (settings) => {
  const normalized = normalizeAutoOrbitSettings(settings);
  return {
    mode: normalized.mode,
    speed: normalized.speed,
    path: normalized.path,
  };
};

// Longer rotations keep the camera movement subtle during viewing.
export const AUTO_ORBIT_MOTION_BY_SPEED = {
  slow: { fullRotationDuration: 72, startupDuration: 0.5 },
  medium: { fullRotationDuration: 45, startupDuration: 0.5 },
  fast: { fullRotationDuration: 15, startupDuration: 0.5 },
};

export const normalizeAutoOrbitSettings = (settings) => {
  const legacyMode = settings?.mode === 'always'
    ? 'rotate'
    : settings?.mode === 'anchor-only'
      ? 'orbit'
      : settings?.mode;
  return {
    enabled: settings?.enabled === true,
    mode: AUTO_ORBIT_MODES.has(legacyMode)
      ? legacyMode
      : DEFAULT_AUTO_ORBIT_SETTINGS.mode,
    speed: AUTO_ORBIT_SPEEDS.has(settings?.speed)
      ? settings.speed
      : DEFAULT_AUTO_ORBIT_SETTINGS.speed,
    path: AUTO_ORBIT_PATHS.has(settings?.path)
      ? settings.path
      : DEFAULT_AUTO_ORBIT_SETTINGS.path,
  };
};