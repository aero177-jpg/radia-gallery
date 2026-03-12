/**
 * Error modal shown when automatic ?import= processing fails.
 */

import { useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDownload,
  faExclamationTriangle,
} from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';

function ImportFromUrlModal({ isOpen, importUrl, error, onClose }) {
  const truncatedUrl = importUrl && importUrl.length > 80
    ? importUrl.slice(0, 77) + '...'
    : importUrl;

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  if (!isOpen || !importUrl) return null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} maxWidth={440}>
      <h2>Import failed</h2>
      <p class="dialog-subtitle">
        The shared configuration link could not be imported.
      </p>

      <div class="form-notice" style={{ marginTop: '16px', wordBreak: 'break-all' }}>
        <FontAwesomeIcon icon={faDownload} style={{ marginTop: '2px', flexShrink: 0 }} />
        {' '}{truncatedUrl}
      </div>

      <div class="form-error" style={{ marginTop: '16px' }}>
        <FontAwesomeIcon icon={faExclamationTriangle} />
        {' '}{error || 'Import failed'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
        <button
          class="secondary-button"
          onClick={handleClose}
          style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: 0 }}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}

export default ImportFromUrlModal;
