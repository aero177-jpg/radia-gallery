import { render } from 'preact';

import EmbedApp from './components/EmbedApp.jsx';
import './style.css';

render(<EmbedApp />, document.getElementById('app'));

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason, event);
  if (event.reason && event.reason.stack) console.error(event.reason.stack);
});

window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.message, 'at', event.filename + ':' + event.lineno + ':' + event.colno);
  if (event.error && event.error.stack) console.error(event.error.stack);
});