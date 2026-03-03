import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

let lastHiddenState = null;

const isNative = () => Capacitor.isNativePlatform();

export const configureNativeStatusBarOverlay = async () => {
  if (!isNative()) return;

  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#00000000' });
  } catch (err) {
    console.warn('[Native UI] Failed to configure status bar overlay:', err);
  }
};

export const setNativeSystemUiHidden = async (hidden) => {
  if (!isNative()) return;

  const nextHidden = Boolean(hidden);
  if (lastHiddenState === nextHidden) return;

  try {
    if (nextHidden) {
      await StatusBar.hide();
    } else {
      await StatusBar.show();
      await configureNativeStatusBarOverlay();
    }

    lastHiddenState = nextHidden;
  } catch (err) {
    console.warn('[Native UI] Failed to toggle native system UI:', err);
  }
};
