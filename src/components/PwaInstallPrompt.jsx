import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

const isStandaloneMode = () => {
  if (typeof window === 'undefined') return false;
  const byStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const byFullscreen = window.matchMedia?.('(display-mode: fullscreen)')?.matches;
  const byNavigator = typeof window.navigator?.standalone === 'boolean' && window.navigator.standalone;
  return Boolean(byStandalone || byFullscreen || byNavigator);
};

const detectIosSafari = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  return isIOS && isSafari;
};

function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const installed = useMemo(() => isStandaloneMode(), []);
  const showAndroidInstall = Boolean(!installed && !dismissed && deferredPrompt);
  const showIosHint = Boolean(!installed && !dismissed && !deferredPrompt && detectIosSafari());

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch (err) {
      console.warn('Install prompt failed:', err);
    } finally {
      setDeferredPrompt(null);
      setDismissed(true);
    }
  }, [deferredPrompt]);

  if (!showAndroidInstall && !showIosHint) return null;

  return (
    <div class="pwa-toast" role="status" aria-live="polite">
      <div class="pwa-toast__content">
        <span class="pwa-toast__message">
          {showAndroidInstall
            ? 'Install Radia for a standalone app experience.'
            : 'On iPhone/iPad: tap Share, then Add to Home Screen.'}
        </span>
        <div class="pwa-toast__actions">
          {showAndroidInstall && (
            <button class="pwa-toast__button" onClick={handleInstall}>
              Install
            </button>
          )}
          <button class="pwa-toast__button pwa-toast__button--secondary" onClick={() => setDismissed(true)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default PwaInstallPrompt;
