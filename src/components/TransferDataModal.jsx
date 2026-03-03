/**
 * Transfer data modal for exporting/importing settings and previews.
 * Multi-page flow: Landing → Export or Import
 */

import { useCallback, useMemo, useState } from 'preact/hooks';
import { useStore } from '../store';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faChevronRight,
  faCloud,
  faCog,
  faCopy,
  faDownload,
  faExclamationTriangle,
  faFolder,
  faImage,
  faLink,
  faServer,
  faSpinner,
  faUpload,
} from '@fortawesome/free-solid-svg-icons';
import { validateImportUrl, buildShareLink } from '../utils/importFromUrl.js';
import { getSource } from '../storage/index.js';
import { buildTransferBundle, buildTransferJson } from '../utils/debugTransfer.js';
import { loadR2Settings } from '../storage/r2Settings.js';
import { loadCloudGpuSettings } from '../storage/cloudGpuSettings.js';
import Modal from './Modal';
import SelectableOptionItem from './SelectableOptionItem';
import ImportZipForm from './ImportZipForm.jsx';

/**
 * Tier-style card for landing page options (Import / Export)
 */
function TransferTierCard({ type, icon, title, description, onSelect, disabled = false }) {
  return (
    <button
      class={`storage-tier-card${disabled ? ' disabled' : ''}`}
      onClick={() => {
        if (disabled) return;
        onSelect(type);
      }}
      disabled={disabled}
      style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
    >
      <div class="tier-icon">
        <FontAwesomeIcon icon={icon} />
      </div>
      <div class="tier-content">
        <div class="tier-header">
          <h4>{title}</h4>
        </div>
        <p class="tier-description">{description}</p>
      </div>
      <FontAwesomeIcon icon={faChevronRight} class="tier-arrow" />
    </button>
  );
}

/**
 * Export page with data selection options
 */
function ExportPage({ onBack, onClose, addLog, exportMode = 'all-data', scopeContext = null }) {
  const isCurrentCollectionMode = exportMode === 'current-collection';
  const activeSourceType = scopeContext?.activeSourceType || null;
  const hasConnectionOption = activeSourceType === 'r2-bucket' || activeSourceType === 'supabase-storage';

  const buildExportFileName = useCallback(() => {
    const now = new Date();
    const shortDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');

    const sanitizeCollectionName = (value) => {
      const text = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return text || 'collection';
    };

    const baseName = isCurrentCollectionMode
      ? `radia-transfer-${sanitizeCollectionName(scopeContext?.collectionName)}`
      : 'radia-transfer-full';

    return `${baseName}-${shortDate}.zip`;
  }, [isCurrentCollectionMode, scopeContext?.collectionName]);

  const [transferOptions, setTransferOptions] = useState(() => {
    if (isCurrentCollectionMode) {
      return {
        includeCollectionData: true,
        includeConnectionData: hasConnectionOption,
        includeFilePreviews: true,
        includeFileSettings: true,
      };
    }

    return {
      includeUrlCollections: true,
      includeCloudGpuSettings: true,
      includeSupabaseCollections: true,
      includeSupabaseSettings: true,
      includeR2Collections: true,
      includeR2Settings: true,
      includeFilePreviews: true,
      includeFileSettings: true,
    };
  });
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState(null);
  const [exportSuccess, setExportSuccess] = useState(false);

  // Share via URL state
  const [shareUrl, setShareUrl] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  const isJsonExport = !transferOptions.includeFilePreviews;

  const hasTransferSelection = Object.values(transferOptions).some(Boolean);

  const credentialShareNote = useMemo(() => {
    const getExposureType = (settings, rawKeyField, encryptedKeyField) => {
      const hasRaw = Boolean(String(settings?.[rawKeyField] || '').trim());
      const hasEncrypted = Boolean(settings?.[encryptedKeyField]);
      if (hasRaw) return 'raw';
      if (hasEncrypted) return 'encrypted';
      return null;
    };

    const segments = [];
    const addSegment = (serviceLabel, exposureType) => {
      if (!exposureType) return;
      segments.push(`${exposureType} ${serviceLabel} key`);
    };

    if (isCurrentCollectionMode) {
      if (transferOptions.includeConnectionData && activeSourceType === 'r2-bucket') {
        const r2Settings = loadR2Settings();
        addSegment('R2', getExposureType(r2Settings, 'secretAccessKey', 'secretAccessKeyEncrypted'));
      }
    } else {
      if (transferOptions.includeR2Settings) {
        const r2Settings = loadR2Settings();
        addSegment('R2', getExposureType(r2Settings, 'secretAccessKey', 'secretAccessKeyEncrypted'));
      }

      if (transferOptions.includeCloudGpuSettings) {
        const cloudGpuSettings = loadCloudGpuSettings();
        addSegment('Cloud GPU', getExposureType(cloudGpuSettings, 'apiKey', 'apiKeyEncrypted'));
      }
    }

    if (!segments.length) return '';
    if (segments.length === 1) return `Includes ${segments[0]}.`;
    return `Includes ${segments.slice(0, -1).join(', ')} and ${segments[segments.length - 1]}.`;
  }, [activeSourceType, isCurrentCollectionMode, transferOptions]);

  const hasRawCredentialShare = useMemo(() => {
    const hasRawField = (settings, rawKeyField) => Boolean(String(settings?.[rawKeyField] || '').trim());

    if (isCurrentCollectionMode) {
      if (transferOptions.includeConnectionData && activeSourceType === 'r2-bucket') {
        return hasRawField(loadR2Settings(), 'secretAccessKey');
      }
      return false;
    }

    if (transferOptions.includeR2Settings && hasRawField(loadR2Settings(), 'secretAccessKey')) {
      return true;
    }

    if (transferOptions.includeCloudGpuSettings && hasRawField(loadCloudGpuSettings(), 'apiKey')) {
      return true;
    }

    return false;
  }, [activeSourceType, isCurrentCollectionMode, transferOptions]);

  const toggleOption = useCallback((key) => () => {
    setTransferOptions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

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

  const buildExportPayload = useCallback(() => {
    return isCurrentCollectionMode
      ? {
          ...transferOptions,
          exportScope: {
            mode: 'current-collection',
            activeSourceId: scopeContext?.activeSourceId || null,
            activeSourceType: scopeContext?.activeSourceType || null,
            assetNames: scopeContext?.assetNames || [],
            collectionName: scopeContext?.collectionName || 'Current collection',
          },
        }
      : transferOptions;
  }, [isCurrentCollectionMode, scopeContext, transferOptions]);

  const handleExportTransfer = useCallback(async () => {
    if (!hasTransferSelection || transferBusy) return;
    if (isCurrentCollectionMode && !scopeContext?.activeSourceId) {
      setTransferError('Current collection is unavailable. Select a collection and try again.');
      return;
    }
    setTransferBusy(true);
    setTransferError(null);
    setExportSuccess(false);
    setJsonCopied(false);
    try {
      const payload = buildExportPayload();
      if (isJsonExport) {
        const { json } = await buildTransferJson(payload);
        const blob = new Blob([json], { type: 'application/json' });
        const filename = buildExportFileName().replace(/\.zip$/, '.json');
        downloadBlob(blob, filename);
        const exportLabel = isCurrentCollectionMode ? 'current collection' : 'all data';
        addLog?.(`[Debug] Transfer JSON exported (${exportLabel})`);
      } else {
        const { blob, manifest } = await buildTransferBundle(payload);
        const filename = buildExportFileName();
        downloadBlob(blob, filename);
        const previewCount = manifest?.data?.previews?.length ?? 0;
        const exportLabel = isCurrentCollectionMode ? 'current collection' : 'all data';
        addLog?.(`[Debug] Transfer bundle exported (${exportLabel}, ${previewCount} previews)`);
      }
      setExportSuccess(true);
    } catch (err) {
      const message = err?.message || 'Export failed';
      setTransferError(message);
      addLog?.(`[Debug] Transfer export failed: ${message}`);
    } finally {
      setTransferBusy(false);
    }
  }, [
    addLog,
    buildExportFileName,
    buildExportPayload,
    downloadBlob,
    hasTransferSelection,
    isCurrentCollectionMode,
    isJsonExport,
    scopeContext,
    transferBusy,
    transferOptions,
  ]);

  const handleCopyJson = useCallback(async () => {
    if (!hasTransferSelection || transferBusy) return;
    setTransferBusy(true);
    setTransferError(null);
    setExportSuccess(false);
    setJsonCopied(false);
    try {
      const payload = buildExportPayload();
      const { json } = await buildTransferJson(payload);
      await navigator.clipboard.writeText(json);
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 3000);
      const exportLabel = isCurrentCollectionMode ? 'current collection' : 'all data';
      addLog?.(`[Debug] Transfer JSON copied to clipboard (${exportLabel})`);
      setExportSuccess(true);
    } catch (err) {
      const message = err?.message || 'Copy failed';
      setTransferError(message);
      addLog?.(`[Debug] Transfer JSON copy failed: ${message}`);
    } finally {
      setTransferBusy(false);
    }
  }, [
    addLog,
    buildExportPayload,
    hasTransferSelection,
    isCurrentCollectionMode,
    transferBusy,
  ]);

  const options = isCurrentCollectionMode
    ? [
        {
          key: 'includeCollectionData',
          title: 'Collection data',
          subtitle: 'Current collection/source entry and metadata',
          icon: faFolder,
        },
        ...(hasConnectionOption
          ? [
              {
                key: 'includeConnectionData',
                title: activeSourceType === 'r2-bucket' ? 'R2 connection data' : 'Supabase connection data',
                subtitle:
                  activeSourceType === 'r2-bucket'
                    ? 'Saved R2 credentials and endpoint settings'
                    : 'Saved Supabase URL/key and bucket settings',
                icon: faCog,
              },
            ]
          : []),
        {
          key: 'includeFilePreviews',
          title: 'File previews',
          subtitle: 'Preview thumbnails for assets in this collection',
          icon: faImage,
        },
        {
          key: 'includeFileSettings',
          title: 'File settings',
          subtitle: 'Per-file settings only for assets in this collection',
          icon: faFolder,
        },
      ]
    : [
        {
          key: 'includeUrlCollections',
          title: 'URL collections',
          subtitle: 'Saved URL sources and their metadata',
          icon: faLink,
        },
        {
          key: 'includeCloudGpuSettings',
          title: 'Cloud GPU settings',
          subtitle: 'API endpoint and key configuration',
          icon: faCloud,
        },
        {
          key: 'includeSupabaseCollections',
          title: 'Supabase collections',
          subtitle: 'Saved Supabase bucket connections',
          icon: faServer,
        },
        {
          key: 'includeSupabaseSettings',
          title: 'Supabase settings',
          subtitle: 'Per-file camera and display settings',
          icon: faCog,
        },
        {
          key: 'includeR2Collections',
          title: 'R2 collections',
          subtitle: 'Saved Cloudflare R2 bucket connections',
          icon: faServer,
        },
        {
          key: 'includeR2Settings',
          title: 'R2 settings',
          subtitle: 'Saved R2 credentials and public URL',
          icon: faCog,
        },
        {
          key: 'includeFilePreviews',
          title: 'File previews',
          subtitle: 'Thumbnail images for local files',
          icon: faImage,
        },
        {
          key: 'includeFileSettings',
          title: 'File settings',
          subtitle: 'Per-file camera and display settings',
          icon: faFolder,
        },
      ];

  const exportTitle = isCurrentCollectionMode ? 'Export current collection' : 'Export all data';
  const exportSubtitle = isCurrentCollectionMode
    ? 'Select data to include. File settings and previews are limited to this collection manifest.'
    : 'Select data to include in the export bundle.';
  const scopedCollectionName = scopeContext?.collectionName || 'Current collection';
  const scopedAssetCount = Array.isArray(scopeContext?.assetNames) ? scopeContext.assetNames.length : 0;
  const scopedAssetLabel = `${scopedAssetCount} asset${scopedAssetCount === 1 ? '' : 's'}`;

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        Back
      </button>

      <h3>{exportTitle}</h3>
      <p class="dialog-subtitle">{exportSubtitle}</p>
      {isCurrentCollectionMode && (
        <p class="dialog-subtitle" style={{ marginTop: '6px', opacity: 0.8 }}>
          Scope: {scopedCollectionName} ({scopedAssetLabel})
        </p>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          marginTop: '20px',
        }}
      >
        {options.map((opt) => (
          <SelectableOptionItem
            key={opt.key}
            title={opt.title}
            subtitle={opt.subtitle}
            icon={opt.icon}
            selected={transferOptions[opt.key]}
            onToggle={toggleOption(opt.key)}
          />
        ))}
      </div>

      {transferError && (
        <div class="form-error" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{transferError}
        </div>
      )}

      {exportSuccess && (
        <div class="form-success" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faCheck} />
          {' '}Export complete! Check your downloads folder.
        </div>
      )}

      {credentialShareNote && (
        <div class={hasRawCredentialShare ? 'form-error' : 'form-notice'} style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} style={{ marginTop: '2px', flexShrink: 0 }} />
          {' '}{credentialShareNote}
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
          Cancel
        </button>
        <button
          class="primary-button"
          onClick={handleExportTransfer}
          disabled={!hasTransferSelection || transferBusy}
          style={{ height: '36px', padding: '0 16px', minWidth: '120px', fontSize: '14px' }}
        >
          {transferBusy ? (
            <>
              <FontAwesomeIcon icon={faSpinner} spin />
              {' '}Exporting...
            </>
          ) : isJsonExport ? (
            <>
              <FontAwesomeIcon icon={faDownload} />
              {' '}Export JSON
            </>
          ) : (
            <>
              <FontAwesomeIcon icon={faDownload} />
              {' '}Export ZIP
            </>
          )}
        </button>
        {isJsonExport && (
          <button
            class="secondary-button"
            onClick={handleCopyJson}
            disabled={!hasTransferSelection || transferBusy}
            title="Copy JSON to clipboard"
            style={{ height: '36px', padding: '0 12px', marginTop: 0, width: '36px', minWidth: '36px' }}
          >
            <FontAwesomeIcon icon={jsonCopied ? faCheck : faCopy} />
          </button>
        )}
      </div>

      {/* Share via URL collapsible section */}
      <details class="controls-section" style={{ marginTop: '20px' }}>
        <summary class="controls-section__summary">
          <FontAwesomeIcon icon={faChevronRight} className="controls-section__chevron" />
          <span class="controls-section__title">Share via URL</span>
        </summary>
        <div class="controls-section__content">
          <div class="controls-section__content-inner" style={{ paddingLeft: 0 }}>
            <p style={{margin: "4px 0 14px 0"}}><i class="dialog-subtitle" style={{ margin: '0', padding: '0' }}>
              Upload your exported ZIP or JSON file to any publicly accessible location
              (cloud storage, static file host, CDN, etc.).
              Paste the direct download link below to generate a shareable viewer link.
            </i>
            </p>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div class="form-field" style={{ flex: 1, marginBottom: 0 }}>
                <input
                  type="url"
                  placeholder="https://example.com/my-export.zip"
                  value={shareUrl}
                  onInput={(e) => {
                    setShareUrl(e.target.value);
                    setShareError('');
                    setGeneratedLink('');
                    setShareCopied(false);
                  }}
                />
              </div>
              <button
                class="primary-button"
                disabled={!shareUrl.trim()}
                onClick={() => {
                  const check = validateImportUrl(shareUrl);
                  if (!check.valid) {
                    setShareError(check.error);
                    setGeneratedLink('');
                    return;
                  }
                  const link = buildShareLink(shareUrl);
                  setGeneratedLink(link);
                  setShareError('');
                  setShareCopied(false);
                  try {
                    navigator.clipboard.writeText(link);
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 3000);
                  } catch { /* clipboard may fail silently */ }
                }}
                style={{ height: '36px', width: '150px', marginTop: 0, whiteSpace: 'nowrap' }}
              >
                Generate link
              </button>
            </div>

            {shareError && (
              <div class="form-error" style={{ marginTop: '10px' }}>
                <FontAwesomeIcon icon={faExclamationTriangle} />
                {' '}{shareError}
              </div>
            )}

            {generatedLink && (
              <div style={{ marginTop: '12px' }}>
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
                        setShareCopied(true);
                        setTimeout(() => setShareCopied(false), 3000);
                      } catch { /* ignore */ }
                    }}
                    style={{ height: '36px', width: '50px', marginTop: 0, whiteSpace: 'nowrap' }}
                  >
                    <FontAwesomeIcon icon={faCopy} />
                  </button>
                </div>
                {shareCopied && (
                  <div class="form-success" style={{ marginTop: '8px' }}>
                    <FontAwesomeIcon icon={faCheck} />
                    {' '}Link copied to clipboard!
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * Export scope selection page (Current collection vs All data)
 */
function ExportScopePage({ onBack, onSelect, currentCollectionEnabled }) {
  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        Back
      </button>

      <h3>Export scope</h3>
      <p class="dialog-subtitle">Choose what you want to export.</p>

      <div class="storage-tiers" style={{ marginTop: '20px' }}>
        <TransferTierCard
          type="current-collection"
          icon={faFolder}
          title="Current collection"
          description={
            currentCollectionEnabled
              ? 'Export only this collection with scoped settings and previews'
              : 'Unavailable until a collection is selected'
          }
          onSelect={onSelect}
          disabled={!currentCollectionEnabled}
        />
        <TransferTierCard
          type="all-data"
          icon={faDownload}
          title="All data"
          description="Export from all available collections and settings"
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

/**
 * Main TransferDataModal component with multi-page flow
 */
function TransferDataModal({ isOpen, onClose, addLog }) {
  const activeSourceId = useStore((state) => state.activeSourceId);
  const assets = useStore((state) => state.assets);
  const [page, setPage] = useState(null); // null = landing, 'export-scope', 'export-all', 'export-current', 'import'

  const activeSource = activeSourceId ? getSource(activeSourceId) : null;
  const currentCollectionEnabled = Boolean(activeSourceId && activeSource);
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

  const currentCollectionScope = useMemo(() => {
    if (!currentCollectionEnabled) return null;
    return {
      mode: 'current-collection',
      activeSourceId,
      activeSourceType: activeSource?.type || null,
      collectionName: activeSource?.name || 'Current collection',
      assetNames: currentCollectionAssetNames,
    };
  }, [activeSource, activeSourceId, currentCollectionAssetNames, currentCollectionEnabled]);

  const handleClose = useCallback(() => {
    setPage(null);
    onClose();
  }, [onClose]);

  const handleBack = useCallback(() => {
    if (page === 'export-all' || page === 'export-current') {
      setPage('export-scope');
      return;
    }
    setPage(null);
  }, [page]);

  if (!isOpen) return null;

  let content;
  if (page === 'export-scope') {
    content = (
      <ExportScopePage
        onBack={handleBack}
        onSelect={(mode) => setPage(mode === 'current-collection' ? 'export-current' : 'export-all')}
        currentCollectionEnabled={currentCollectionEnabled}
      />
    );
  } else if (page === 'export-all') {
    content = (
      <ExportPage
        onBack={handleBack}
        onClose={handleClose}
        addLog={addLog}
        exportMode="all-data"
      />
    );
  } else if (page === 'export-current') {
    content = (
      <ExportPage
        onBack={handleBack}
        onClose={handleClose}
        addLog={addLog}
        exportMode="current-collection"
        scopeContext={currentCollectionScope}
      />
    );
  } else if (page === 'import') {
    content = <ImportZipForm onBack={handleBack} onClose={handleClose} addLog={addLog} />;
  } else {
    // Landing page
    content = (
      <>
        <h2>Transfer data</h2>
        <p class="dialog-subtitle">
          Export settings and previews to share or backup, or import from a previous export.
        </p>

        <div class="storage-tiers" style={{ marginTop: '20px' }}>
          <TransferTierCard
            type="export-scope"
            icon={faDownload}
            title="Export"
            description="Save collections, settings, and previews to a ZIP file"
            onSelect={setPage}
          />
          <TransferTierCard
            type="import"
            icon={faUpload}
            title="Import"
            description="Restore data from a previously exported ZIP bundle"
            onSelect={setPage}
          />
        </div>
      </>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      maxWidth={460}
    >
      {content}
    </Modal>
  );
}

export default TransferDataModal;
