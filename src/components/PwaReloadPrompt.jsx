import { useRegisterSW } from 'virtual:pwa-register/preact';

function PwaReloadPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegistered() {
      console.info('[PWA] Service worker registered.');
    },
    onRegisterError(error) {
      console.error('[PWA] Service worker registration error:', error);
    }
  });

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  if (!import.meta.env.PROD || (!offlineReady && !needRefresh)) return null;

  return (
    <div class="pwa-toast" role="status" aria-live="polite">
      <div class="pwa-toast__content">
        <span class="pwa-toast__message">
          {needRefresh ? 'New content available!' : 'App ready to work offline.'}
        </span>
        <div class="pwa-toast__actions">
          {needRefresh && (
            <button class="pwa-toast__button" onClick={() => updateServiceWorker(true)}>
              Reload
            </button>
          )}
          <button class="pwa-toast__button pwa-toast__button--secondary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default PwaReloadPrompt;
