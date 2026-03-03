/**
 * Confirmation modal shown when the app detects a ?import= URL parameter.
 * Lets the user review the source URL and confirm or cancel the import.
 */

import { useCallback, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faDownload,
  faExclamationTriangle,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { importBundleFromUrl } from '../utils/importFromUrl.js';
import { loadFromStorageSource } from '../fileLoader';
import Modal from './Modal';

function ImportFromUrlModal({ isOpen, importUrl, onClose, addLog }) {
  const [status, setStatus] = useState('idle'); // idle | importing | success | error
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);

  const truncatedUrl = importUrl && importUrl.length > 80
    ? importUrl.slice(0, 77) + '...'
    : importUrl;

  const handleImport = useCallback(async () => {
    if (!importUrl || status === 'importing') return;
    setStatus('importing');
    setError('');
    setSummary(null);

    try {
      const result = await importBundleFromUrl(importUrl);
      setSummary(result.summary);
      setStatus('success');
      addLog?.(`[Import] Remote bundle imported: ${result.summary.sourcesImported} sources, ${result.summary.fileSettingsImported} file settings, ${result.summary.previewsImported} previews`);

      // Auto-load if exactly one collection was imported
      if (result.summary.importedSources?.length === 1) {
        const source = result.summary.importedSources[0];
        setTimeout(async () => {
          try {
            await loadFromStorageSource(source);
          } catch (err) {
            addLog?.(`[Import] Auto-load after import failed: ${err?.message || err}`);
          }
          onClose?.();
        }, 800);
      }
    } catch (err) {
      setError(err?.message || 'Import failed');
      setStatus('error');
      addLog?.(`[Import] Remote import failed: ${err?.message || 'Unknown error'}`);
    }
  }, [addLog, importUrl, onClose, status]);

  const handleClose = useCallback(() => {
    setStatus('idle');
    setError('');
    setSummary(null);
    onClose?.();
  }, [onClose]);

  if (!isOpen || !importUrl) return null;

  const buildSummaryText = () => {
    if (!summary) return null;
    const parts = [];
    if (summary.sourcesImported > 0) parts.push(`${summary.sourcesImported} collection${summary.sourcesImported === 1 ? '' : 's'}`);
    if (summary.supabaseSettingsImported) parts.push('Supabase settings');
    if (summary.r2SettingsImported) parts.push('R2 settings');
    if (summary.cloudGpuSettingsImported) parts.push('Cloud GPU settings');
    if (summary.fileSettingsImported > 0) parts.push(`${summary.fileSettingsImported} file setting${summary.fileSettingsImported === 1 ? '' : 's'}`);
    if (summary.previewsImported > 0) parts.push(`${summary.previewsImported} preview${summary.previewsImported === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(', ') : 'No data imported';
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} maxWidth={440}>
      <h2>Import shared data</h2>
      <p class="dialog-subtitle">
        A shared configuration bundle was detected in the URL.
      </p>

      <div class="form-notice" style={{ marginTop: '16px', wordBreak: 'break-all' }}>
        <FontAwesomeIcon icon={faDownload} style={{ marginTop: '2px', flexShrink: 0 }} />
        {' '}{truncatedUrl}
      </div>

      {status === 'idle' && (
        <p class="dialog-subtitle" style={{ marginTop: '12px' }}>
          This will download and import collections, settings, and previews from the remote file.
          Only import bundles from sources you trust.
        </p>
      )}

      {status === 'importing' && (
        <div class="form-notice" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faSpinner} spin style={{ marginRight: '8px' }} />
          Downloading and importing...
        </div>
      )}

      {status === 'error' && (
        <div class="form-error" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      {status === 'success' && (
        <div class="form-success" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faCheck} />
          {' '}Import complete! {buildSummaryText()}
          {summary?.warnings?.length > 0 && (
            <div style={{ marginTop: '8px', opacity: 0.85, fontSize: '13px' }}>
              {summary.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
        <button
          class="secondary-button"
          onClick={handleClose}
          style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: 0 }}
        >
          {status === 'success' ? 'Done' : 'Cancel'}
        </button>
        {status !== 'success' && (
          <button
            class="primary-button"
            onClick={handleImport}
            disabled={status === 'importing'}
            style={{ height: '36px', padding: '0 16px' }}
          >
            {status === 'importing' ? (
              <>
                <FontAwesomeIcon icon={faSpinner} spin />
                {' '}Importing...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faDownload} />
                {' '}Import
              </>
            )}
          </button>
        )}
      </div>
    </Modal>
  );
}

export default ImportFromUrlModal;
