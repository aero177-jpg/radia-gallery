/**
 * Main entry point - Preact app initialization
 */

import { render } from 'preact';

import App from './components/App';
import './style.css';

// Initialize storage sources from IndexedDB on startup
import { initializeSources } from './storage/index.js';

// Initialize storage sources first, then render the app
const startApp = async () => {
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
