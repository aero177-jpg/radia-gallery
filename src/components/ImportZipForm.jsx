import { useCallback, useRef, useState } from 'preact/hooks';
import { useStore } from '../store';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faChevronRight,
  faDownload,
  faExclamationTriangle,
  faSpinner,
  faUpload,
} from '@fortawesome/free-solid-svg-icons';
import { importTransferBundle, importTransferManifest, validateTransferManifest } from '../utils/debugTransfer.js';
import { importBundleFromUrl, validateImportUrl, extractTransferManifestFromPayload } from '../utils/importFromUrl.js';
import { loadFromStorageSource } from '../fileLoader';

const DEFAULT_FEATURES = [
  'Merges data by file name',
  'Overwrites matching previews and settings',
  'Preserves existing data not in the bundle',
];

function ImportZipForm({
  onBack,
  onClose,
  addLog,
  title = 'Import data',
  subtitle = 'Import settings, collections, and previews from a transfer bundle.',
  featureItems = DEFAULT_FEATURES,
}) {
  const isMobile = useStore((state) => state.isMobile);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Inline import (URL or JSON paste) state
  const [inlineInput, setInlineInput] = useState('');
  const [inlineBusy, setInlineBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [inlineSuccess, setInlineSuccess] = useState('');

  const autoLoadSingleSource = useCallback((summary) => {
    if (summary?.importedSources?.length === 1) {
      const source = summary.importedSources[0];
      setTimeout(async () => {
        try {
          await loadFromStorageSource(source);
        } catch (err) {
          addLog?.(`[Debug] Auto-load after import failed: ${err?.message || err}`);
        }
        onClose?.();
      }, 800);
    }
  }, [addLog, onClose]);

  const processFile = useCallback(
    async (file) => {
      if (!file) return;
      setImportBusy(true);
      setImportError(null);
      setImportSuccess(null);
      try {
        const { summary } = await importTransferBundle(file);
        const message =
          `Import complete: ${summary.sourcesImported} sources, ` +
          `${summary.fileSettingsImported} settings, ${summary.previewsImported} previews`;
        addLog?.(`[Debug] ${message}`);
        if (summary.warnings?.length) {
          addLog?.(`[Debug] Transfer import warnings: ${summary.warnings.join(' | ')}`);
        }
        setImportSuccess(message);

        // Auto-load if exactly one collection was imported
        autoLoadSingleSource(summary);
      } catch (err) {
        const message = err?.message || 'Import failed';
        setImportError(message);
        addLog?.(`[Debug] Transfer import failed: ${message}`);
      } finally {
        setImportBusy(false);
      }
    },
    [addLog, autoLoadSingleSource]
  );

  const handleFileChange = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      processFile(file);
    },
    [processFile]
  );

  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleInlineImport = useCallback(async () => {
    const trimmed = inlineInput.trim();
    if (!trimmed || inlineBusy) return;

    setInlineBusy(true);
    setInlineError('');
    setInlineSuccess('');
    setImportError(null);
    setImportSuccess(null);

    // Detect: URL if starts with http(s):// , otherwise try JSON
    const looksLikeUrl = /^https?:\/\//i.test(trimmed);

    if (looksLikeUrl) {
      const check = validateImportUrl(trimmed);
      if (!check.valid) {
        setInlineError(check.error);
        setInlineBusy(false);
        return;
      }
      try {
        const result = await importBundleFromUrl(trimmed);
        const { summary } = result;
        const msg = `Import complete: ${summary.sourcesImported} sources, ${summary.fileSettingsImported} settings, ${summary.previewsImported} previews`;
        setInlineSuccess(msg);
        addLog?.(`[Debug] URL import: ${msg}`);
        autoLoadSingleSource(summary);
      } catch (err) {
        setInlineError(err?.message || 'Import from URL failed');
        addLog?.(`[Debug] URL import failed: ${err?.message || err}`);
      } finally {
        setInlineBusy(false);
      }
      return;
    }

    // Try JSON parse
    let manifest;
    try {
      manifest = JSON.parse(trimmed);
    } catch {
      setInlineError('Input is not a valid URL or JSON. URLs must start with https://.');
      setInlineBusy(false);
      return;
    }

    const extractedManifest = extractTransferManifestFromPayload(manifest);
    const check = validateTransferManifest(extractedManifest);
    if (!check.valid) {
      setInlineError(check.error || 'Not a valid Radia transfer manifest.');
      setInlineBusy(false);
      return;
    }

    try {
      const { summary } = await importTransferManifest(extractedManifest);
      const msg = `Import complete: ${summary.sourcesImported} sources, ${summary.fileSettingsImported} settings, ${summary.previewsImported} previews`;
      setInlineSuccess(msg);
      addLog?.(`[Debug] JSON paste import: ${msg}`);
      autoLoadSingleSource(summary);
    } catch (err) {
      setInlineError(err?.message || 'JSON import failed');
      addLog?.(`[Debug] JSON paste import failed: ${err?.message || err}`);
    } finally {
      setInlineBusy(false);
    }
  }, [addLog, autoLoadSingleSource, inlineBusy, inlineInput]);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.name.endsWith('.zip') || file.type === 'application/zip' || file.name.endsWith('.json') || file.type === 'application/json')) {
        processFile(file);
      } else {
        setImportError('Please drop a .zip or .json file');
      }
    },
    [processFile]
  );

  const dropZoneStyle = {
    border: `2px dashed ${isDragging ? 'rgba(110, 231, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)'}`,
    borderRadius: '12px',
    padding: '32px 24px',
    textAlign: 'center',
    background: isDragging ? 'rgba(110, 231, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
    transition: 'all 0.2s ease',
    marginTop: '20px',
  };

  return (
    <div class="storage-form">
      {typeof onBack === 'function' && (
        <button class="back-button" onClick={onBack}>
          Back
        </button>
      )}

      <h3>{title}</h3>
      <p class="dialog-subtitle" style={{ marginBottom: '12px' }}>
        {subtitle}
      </p>

      <ul class="feature-list bullet-list">
        {featureItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

        {/* Import from URL or JSON collapsible section */}
      <details class="controls-section" style={{ marginTop: '20px' }}>
        <summary class="controls-section__summary">
          <FontAwesomeIcon icon={faChevronRight} className="controls-section__chevron" />
          <span class="controls-section__title"style={{fontSize: "14px"}}>Import from URL or JSON</span>
        </summary>
        <div class="controls-section__content">
          <div class="controls-section__content-inner" style={{ paddingLeft: 0 }}>
            <p class="dialog-subtitle" style={{ marginTop: '8px', marginBottom: '12px' }}>
              Paste a direct download link to a remote .zip or .json bundle,
              or paste raw JSON manifest text directly.
            </p>

            <div class="form-field" style={{ marginBottom: 0 }}>
              <textarea
                placeholder={'https://example.com/my-export.zip\n\nor paste JSON manifest text...'}
                value={inlineInput}
                onInput={(e) => {
                  setInlineInput(e.target.value);
                  setInlineError('');
                  setInlineSuccess('');
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button
                class="primary-button"
                disabled={!inlineInput.trim() || inlineBusy}
                onClick={handleInlineImport}
                style={{ height: '36px', padding: '0 14px', marginTop: 0, whiteSpace: 'nowrap' }}
              >
                {inlineBusy ? (
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
            </div>

            {inlineError && (
              <div class="form-error" style={{ marginTop: '10px' }}>
                <FontAwesomeIcon icon={faExclamationTriangle} />
                {' '}{inlineError}
              </div>
            )}

            {inlineSuccess && (
              <div class="form-success" style={{ marginTop: '10px' }}>
                <FontAwesomeIcon icon={faCheck} />
                {' '}{inlineSuccess}
              </div>
            )}
          </div>
        </div>
      </details>

      {!isMobile && (
        <div
          style={dropZoneStyle}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {importBusy ? (
            <>
              <FontAwesomeIcon
                icon={faSpinner}
                spin
                style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.6 }}
              />
              <p style={{ margin: 0, opacity: 0.8 }}>Importing...</p>
            </>
          ) : (
            <>
              <FontAwesomeIcon
                icon={faUpload}
                style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.5 }}
              />
              <p style={{ margin: '0 0 12px 0', opacity: 0.8 }}>
                Drag and drop a .zip or .json file here
              </p>
              <button
                class="secondary-button"
                onClick={handleBrowseClick}
                style={{ height: '36px', padding: '0 20px' }}
              >
                Browse files
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {importError && (
        <div class="form-error" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{importError}
        </div>
      )}

      {importSuccess && (
        <div class="form-success" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faCheck} />
          {' '}{importSuccess}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          marginTop: '24px',
        }}
      >
        <button
          class="secondary-button"
          onClick={onClose}
          style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: 0 }}
        >
          {importSuccess ? 'Done' : 'Cancel'}
        </button>
        {isMobile && (
          <button
            class="primary-button"
            onClick={handleBrowseClick}
            disabled={importBusy}
            style={{ height: '36px', padding: '0 16px', minWidth: '120px' }}
          >
            {importBusy ? (
              <>
                <FontAwesomeIcon icon={faSpinner} spin />
                {' '}Importing...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faUpload} />
                {' '}Browse files
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export default ImportZipForm;