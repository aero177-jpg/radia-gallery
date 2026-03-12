import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faDownload, faExclamationTriangle, faLink, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store.js';
import { getSource } from '../storage/index.js';
import { buildEmbedLink, validateImportUrl } from '../utils/importFromUrl.js';
import { buildEmbedBundle, buildEmbedManifestJson } from '../utils/debugTransfer.js';
import Modal from './Modal.jsx';

function CreateEmbedUrlModal({ isOpen, onClose, addLog }) {
  const activeSourceId = useStore((state) => state.activeSourceId);
  const assets = useStore((state) => state.assets);
  const cameraRange = useStore((state) => state.cameraRange);
  const appBgColor = useStore((state) => state.appBgColor);
  const [payloadUrl, setPayloadUrl] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [iframeCopied, setIframeCopied] = useState(false);
  const [includePreviews, setIncludePreviews] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState('');
  const [jsonCopied, setJsonCopied] = useState(false);

  const activeSource = activeSourceId ? getSource(activeSourceId) : null;
  const embedGenerationUnavailable = Boolean(activeSource && activeSource.type !== 'public-url');

  const currentCollectionAssetNames = useMemo(() => {
    const sourceAssets = typeof activeSource?.getAssets === 'function' ? activeSource.getAssets() : [];
    const sourceNames = Array.isArray(sourceAssets)
      ? sourceAssets.map((asset) => asset?.name).filter(Boolean)
      : [];
    if (sourceNames.length > 0) {
      return Array.from(new Set(sourceNames));
    }

    const fallbackNames = (assets || [])
      .filter((asset) => asset?.sourceId === activeSourceId)
      .map((asset) => asset?.name)
      .filter(Boolean);
    return Array.from(new Set(fallbackNames));
  }, [activeSource, activeSourceId, assets]);

  const currentCollectionAssetEntries = useMemo(() => {
    const sourceAssets = typeof activeSource?.getAssets === 'function' ? activeSource.getAssets() : [];
    if (Array.isArray(sourceAssets) && sourceAssets.length > 0) {
      return sourceAssets
        .filter((asset) => asset?.name)
        .map((asset) => ({
          name: asset.name,
          path: asset.path || '',
          preview: asset.preview || null,
          size: asset.size ?? null,
        }));
    }

    return (assets || [])
      .filter((asset) => asset?.sourceId === activeSourceId && asset?.name)
      .map((asset) => ({
        name: asset.name,
        path: asset.path || '',
        preview: asset.preview || null,
        size: asset.size ?? null,
      }));
  }, [activeSource, activeSourceId, assets]);

  const exportScope = useMemo(() => {
    if (!activeSourceId || !activeSource) return null;
    return {
      mode: 'current-collection',
      activeSourceId,
      activeSourceType: activeSource?.type || null,
      collectionName: activeSource?.name || 'Current collection',
      assetNames: currentCollectionAssetNames,
      assetEntries: currentCollectionAssetEntries,
      sourceConfig: typeof activeSource?.toJSON === 'function' ? activeSource.toJSON() : null,
    };
  }, [activeSource, activeSourceId, currentCollectionAssetEntries, currentCollectionAssetNames]);

  const exportUnavailableReason = embedGenerationUnavailable
    ? 'Switch to a public URL collection to export an embed config from this modal.'
    : (!exportScope ? 'Select a collection before exporting an embed config.' : '');

  const guidance = useMemo(() => {
    if (embedGenerationUnavailable) {
      return {
        tone: 'warning',
        title: 'Embed URL generation is only available for public URL collections.',
        body: 'The export controls are below, but they stay disabled until a public-url collection is active.',
      };
    }

    return {
      tone: 'info',
      title: 'Create the embed config in this modal.',
      body: 'Use the export controls below to create either a JSON config or a ZIP with previews, host that file, then paste its public URL to generate the iframe link.',
    };
  }, [embedGenerationUnavailable]);

  const buildExportFileName = useCallback((extension) => {
    const now = new Date();
    const shortDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');

    const collectionSlug = String(activeSource?.name || 'collection')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'collection';

    return `radia-embed-${collectionSlug}-${shortDate}.${extension}`;
  }, [activeSource?.name]);

  const downloadBlob = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const buildExportOptions = useCallback(() => {
    if (!exportScope) {
      throw new Error('Current collection is unavailable.');
    }

    return {
      exportScope,
      includeFileSettings: true,
      includeUiPreferences: true,
      includeFilePreviews: includePreviews,
      viewerSettings: {
        qualityPreset: 'performance',
        cameraRange,
      },
      uiPreferences: {
        appBgColor,
      },
    };
  }, [appBgColor, cameraRange, exportScope, includePreviews]);

  const iframeSnippet = useMemo(() => {
    if (!generatedLink) return '';

    const escapedSrc = generatedLink
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');

    return `<iframe src="${escapedSrc}" title="Radia Gallery Embed" loading="lazy" allow="fullscreen; accelerometer; gyroscope; magnetometer; xr-spatial-tracking" allowfullscreen style="width:100%;height:100%;border:0;"></iframe>`;
  }, [generatedLink]);

  const handleClose = useCallback(() => {
    setPayloadUrl('');
    setGeneratedLink('');
    setError('');
    setCopied(false);
    setIframeCopied(false);
    setIncludePreviews(true);
    setExportBusy(false);
    setExportError('');
    setExportSuccess('');
    setJsonCopied(false);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      setPayloadUrl('');
      setGeneratedLink('');
      setError('');
      setCopied(false);
      setIframeCopied(false);
      setIncludePreviews(true);
      setExportBusy(false);
      setExportError('');
      setExportSuccess('');
      setJsonCopied(false);
    }
  }, [isOpen]);

  const handleExport = useCallback(async () => {
    if (embedGenerationUnavailable || exportBusy) return;

    setExportBusy(true);
    setExportError('');
    setExportSuccess('');
    setJsonCopied(false);

    try {
      const options = buildExportOptions();
      if (includePreviews) {
        const { blob } = await buildEmbedBundle(options);
        downloadBlob(blob, buildExportFileName('zip'));
        setExportSuccess('Embed ZIP exported. Host the ZIP, then paste its public URL below.');
        addLog?.('[Sharing] Exported embed ZIP with previews');
      } else {
        const { json } = await buildEmbedManifestJson(options);
        const blob = new Blob([json], { type: 'application/json' });
        downloadBlob(blob, buildExportFileName('json'));
        setExportSuccess('Embed JSON exported. Host the JSON, then paste its public URL below.');
        addLog?.('[Sharing] Exported embed JSON');
      }
    } catch (err) {
      const message = err?.message || 'Embed export failed';
      setExportError(message);
      addLog?.(`[Sharing] Embed export failed: ${message}`);
    } finally {
      setExportBusy(false);
    }
  }, [addLog, buildExportFileName, buildExportOptions, downloadBlob, embedGenerationUnavailable, exportBusy, includePreviews]);

  const handleCopyJson = useCallback(async () => {
    if (embedGenerationUnavailable || exportBusy || includePreviews) return;

    setExportBusy(true);
    setExportError('');
    setExportSuccess('');
    setJsonCopied(false);

    try {
      const options = buildExportOptions();
      const { json } = await buildEmbedManifestJson(options);
      await navigator.clipboard.writeText(json);
      setJsonCopied(true);
      setExportSuccess('Embed JSON copied to the clipboard.');
      setTimeout(() => setJsonCopied(false), 3000);
      addLog?.('[Sharing] Copied embed JSON to clipboard');
    } catch (err) {
      const message = err?.message || 'Embed JSON copy failed';
      setExportError(message);
      addLog?.(`[Sharing] Embed JSON copy failed: ${message}`);
    } finally {
      setExportBusy(false);
    }
  }, [addLog, buildExportOptions, embedGenerationUnavailable, exportBusy, includePreviews]);

  const handleGenerate = useCallback(() => {
    const check = validateImportUrl(payloadUrl);
    if (!check.valid) {
      setError(check.error);
      setGeneratedLink('');
      return;
    }

    const link = buildEmbedLink(payloadUrl);
    setGeneratedLink(link);
    setError('');
    setCopied(false);
    setIframeCopied(false);
    try {
      navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Ignore clipboard failures
    }
  }, [payloadUrl]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} maxWidth={520}>
      <h2>Embed URL generation</h2>
      <p class="dialog-subtitle">Generate an iframe-friendly embed link from a hosted transfer config.</p>

      <div class={guidance.tone === 'warning' ? 'form-notice warning' : 'form-notice'} style={{ marginTop: '18px' }}>
        <FontAwesomeIcon icon={guidance.tone === 'warning' ? faExclamationTriangle : faLink} style={{ marginTop: '2px', flexShrink: 0 }} />
        <div>
          <strong>{guidance.title}</strong>
          <div style={{ marginTop: '6px' }}>{guidance.body}</div>
        </div>
      </div>

      <div
        style={{
          marginTop: '18px',
          padding: '14px',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,255,255,0.04)',
          opacity: exportUnavailableReason ? 0.7 : 1,
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Export embed config</div>

        <div class="control-row" style={{ marginTop: 0 }}>
          <span class="control-label">Include previews (recommended)</span>
          <label class="switch">
            <input
              type="checkbox"
              checked={includePreviews}
              disabled={Boolean(exportUnavailableReason)}
              onChange={(e) => {
                setIncludePreviews(e.target.checked);
                setExportError('');
                setExportSuccess('');
                setJsonCopied(false);
              }}
            />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </div>

        <p class="dialog-subtitle" style={{ marginTop: '10px' }}>
          {includePreviews
            ? 'Exports a ZIP containing the embed config and bundled gallery previews.'
            : 'Exports a JSON config only. You can also copy the JSON directly.'}
        </p>

        {exportUnavailableReason && (
          <div class="form-notice warning" style={{ marginTop: '12px' }}>
            <FontAwesomeIcon icon={faExclamationTriangle} style={{ marginTop: '2px', flexShrink: 0 }} />
            <div>{exportUnavailableReason}</div>
          </div>
        )}

        {exportError && (
          <div class="form-error" style={{ marginTop: '12px' }}>
            <FontAwesomeIcon icon={faExclamationTriangle} />
            {' '}{exportError}
          </div>
        )}

        {exportSuccess && (
          <div class="form-success" style={{ marginTop: '12px' }}>
            <FontAwesomeIcon icon={jsonCopied ? faCheck : faDownload} />
            {' '}{exportSuccess}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <button
            class="primary-button"
            type="button"
            onClick={() => void handleExport()}
            disabled={exportBusy || Boolean(exportUnavailableReason)}
            style={{ height: '36px', minWidth: '140px', marginTop: 0 }}
          >
            {exportBusy ? (
              <>
                <FontAwesomeIcon icon={faSpinner} spin />
                {' '}Exporting...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faDownload} />
                {' '}{includePreviews ? 'Export ZIP' : 'Export JSON'}
              </>
            )}
          </button>
          {!includePreviews && (
            <button
              class="secondary-button"
              type="button"
              onClick={() => void handleCopyJson()}
              disabled={exportBusy || Boolean(exportUnavailableReason)}
              title="Copy embed JSON to clipboard"
              style={{ height: '36px', width: '42px', minWidth: '42px', marginTop: 0 }}
            >
              <FontAwesomeIcon icon={jsonCopied ? faCheck : faCopy} />
            </button>
          )}
        </div>
      </div>

      <p class="dialog-subtitle" style={{ marginTop: '16px' }}>
        After hosting that exported JSON or ZIP on a direct CORS-readable URL, paste it below to generate the iframe <code>src</code>.
      </p>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '16px' }}>
        <div class="form-field" style={{ flex: 1, marginBottom: 0 }}>
          <input
            type="url"
            placeholder="https://example.com/my-config.json"
            value={payloadUrl}
            onInput={(e) => {
              setPayloadUrl(e.target.value);
              setError('');
              setGeneratedLink('');
              setCopied(false);
              setIframeCopied(false);
            }}
          />
        </div>
        <button
          class="primary-button"
          disabled={!payloadUrl.trim() || embedGenerationUnavailable}
          onClick={handleGenerate}
          style={{ height: '36px', width: '160px', marginTop: 0, whiteSpace: 'nowrap' }}
        >
          Generate link
        </button>
      </div>

      {error && (
        <div class="form-error" style={{ marginTop: '12px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      {generatedLink && (
        <div style={{ marginTop: '14px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div class="form-field" style={{ flex: 1, marginBottom: 0 }}>
              <input
                type="text"
                value={generatedLink}
                readOnly
                onClick={(e) => e.target.select()}
              />
            </div>
            <button
              class="secondary-button"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(generatedLink);
                  setCopied(true);
                  setIframeCopied(false);
                  setTimeout(() => setCopied(false), 3000);
                } catch {
                  // Ignore clipboard failures
                }
              }}
              style={{ height: '36px', width: '50px', marginTop: 0, whiteSpace: 'nowrap' }}
            >
              <FontAwesomeIcon icon={faCopy} />
            </button>
          </div>
          {copied && (
            <div class="form-success" style={{ marginTop: '8px' }}>
              <FontAwesomeIcon icon={faCheck} />
              {' '}Embed URL copied to clipboard!
            </div>
          )}

          <p class="dialog-subtitle" style={{ marginTop: '14px' }}>
            Example iframe embed. The <code>allow</code> and <code>allowfullscreen</code> attributes help preserve fullscreen and motion/device sensor access when the browser permits those APIs inside iframes.
          </p>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '10px' }}>
            <div class="form-field" style={{ flex: 1, marginBottom: 0 }}>
              <textarea
                value={iframeSnippet}
                readOnly
                rows={4}
                onClick={(e) => e.target.select()}
                style={{ resize: 'vertical', minHeight: '104px' }}
              />
            </div>
            <button
              class="secondary-button"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(iframeSnippet);
                  setIframeCopied(true);
                  setCopied(false);
                  setTimeout(() => setIframeCopied(false), 3000);
                } catch {
                  // Ignore clipboard failures
                }
              }}
              style={{ height: '36px', width: '50px', marginTop: 0, whiteSpace: 'nowrap' }}
              title="Copy iframe example"
            >
              <FontAwesomeIcon icon={iframeCopied ? faCheck : faCopy} />
            </button>
          </div>

          {iframeCopied && (
            <div class="form-success" style={{ marginTop: '8px' }}>
              <FontAwesomeIcon icon={faCheck} />
              {' '}Iframe example copied to clipboard!
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default CreateEmbedUrlModal;