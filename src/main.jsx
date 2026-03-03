/**
 * Main entry point - Preact app initialization
 */

import { render } from 'preact';

import App from './components/App';
import './style.css';
import { useStore } from './store';
import {
  configureNativeStatusBarOverlay,
  setNativeSystemUiHidden,
} from './utils/nativeSystemUi';

// Initialize storage sources from IndexedDB on startup
import { initializeSources } from './storage/index.js';

const setupNativeSystemUi = async () => {
  await configureNativeStatusBarOverlay();
};

const bindNativeSystemUiToViewerState = () => {
  const applyNativeUiState = () => {
    const state = useStore.getState();
    const shouldHideSystemUi = Boolean(state.viewerControlsDimmed || state.slideshowPlaying);
    void setNativeSystemUiHidden(shouldHideSystemUi);
  };

  applyNativeUiState();

  useStore.subscribe((state) => state.viewerControlsDimmed, applyNativeUiState);
  useStore.subscribe((state) => state.slideshowPlaying, applyNativeUiState);
};

// Initialize storage sources first, then render the app
const startApp = async () => {
  await setupNativeSystemUi();

  try {
    const sources = await initializeSources();
    if (sources.length > 0) {
      console.log(`[Storage] Restored ${sources.length} storage source(s)`);
    }
  } catch (err) {
    console.warn('[Storage] Failed to restore sources:', err);
  }

  // Render the Preact app after sources are loaded
  render(<App />, document.getElementById('app'));

  bindNativeSystemUiToViewerState();
};

startApp();

// Global error handlers to capture unhandled rejections and errors
window.addEventListener('unhandledrejection', (event) => {
	console.error('Unhandled promise rejection:', event.reason, event);
	// Log stack if available
	if (event.reason && event.reason.stack) console.error(event.reason.stack);
});

window.addEventListener('error', (event) => {
	console.error('Uncaught error:', event.message, 'at', event.filename + ':' + event.lineno + ':' + event.colno);
	if (event.error && event.error.stack) console.error(event.error.stack);
});
