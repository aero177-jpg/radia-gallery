/**
 * Export Choice Modal
 * Lets the user pick between exporting current asset or the current collection.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faDownload } from '@fortawesome/free-solid-svg-icons';
import { CollectionIcon, ImageIcon } from '../icons/customIcons';
import Modal from './Modal';

function ExportOptionItem({ title, subtitle, icon: Icon, selected, onSelect, onConfirm, disabled }) {

  const handleClick = () => {
    if (disabled) return;
    if (selected) {
      onConfirm?.();
      return;
    }
    onSelect?.();
  };

  return (
    <button
      class={`storage-tier-card ${selected ? 'selected' : ''}`}
      onClick={handleClick}
      type="button"
      disabled={disabled}
    >
      <div class="collection-info">
        <div class="collection-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={20} color={selected ? undefined : "#5e707cb2"} />
        </div>
        <div class="collection-details">
          <span class="collection-name" style={{ marginBottom: '4px' }}>{title}</span>
          <span class="collection-meta">{subtitle}</span>
        </div>
      </div>
      {selected && <FontAwesomeIcon icon={faCheck} className="collection-arrow" />}
    </button>
  );
}

function ExportChoiceModal({
  isOpen,
  onClose,
  onExportAsset,
  onExportCollection,
  title = 'Export files',
  subtitle = 'Choose what you want to export.',
  assetTitle = 'Current image',
  assetSubtitle,
  collectionTitle = 'Current collection',
  collectionSubtitle,
  note = '',
  assetDisabled = false,
  collectionDisabled = false,
}) {
  const defaultMode = useMemo(() => {
    if (!assetDisabled) return 'asset';
    if (!collectionDisabled) return 'collection';
    return 'asset';
  }, [assetDisabled, collectionDisabled]);
  const [mode, setMode] = useState(defaultMode);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');

  const handleClose = () => {
    setExportBusy(false);
    setExportError('');
    onClose?.();
  };

  useEffect(() => {
    setMode(defaultMode);
    if (!isOpen) {
      setExportBusy(false);
      setExportError('');
    }
  }, [defaultMode, isOpen]);

  if (!isOpen) return null;

  const handleExport = () => {
    if (exportBusy) return;
    setExportError('');
    setExportBusy(true);

    const exportAction = mode === 'asset' ? onExportAsset : onExportCollection;
    try {
      const result = exportAction?.();
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.error('[ExportChoiceModal] Export failed after modal close', err);
        });
      }

      handleClose();
    } catch (err) {
      setExportError(err?.message || 'Export failed');
      setExportBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
    >
      <h2>{title}</h2>
      <p class="dialog-subtitle">{subtitle}</p>

      <div class="upload-options-list" style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <ExportOptionItem
          title={assetTitle}
          subtitle={assetSubtitle}
          icon={ImageIcon}
          selected={mode === 'asset'}
          onSelect={() => setMode('asset')}
          onConfirm={handleExport}
          disabled={assetDisabled}
        />
        <ExportOptionItem
          title={collectionTitle}
          subtitle={collectionSubtitle}
          icon={CollectionIcon}
          selected={mode === 'collection'}
          onSelect={() => setMode('collection')}
          onConfirm={handleExport}
          disabled={collectionDisabled}
        />
      </div>

      {note && (
        <p class="dialog-subtitle" style={{ marginTop: '12px', color: 'var(--text-muted, #888)' }}>
          {note}
        </p>
      )}

      {exportError && (
        <div class="form-error" style={{ marginTop: '16px' }}>
          {exportError}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
        <button
          class="secondary-button"
          onClick={handleClose}
          style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: '0' }}
        >
          Cancel
        </button>
        <button
          class="primary-button"
          onClick={handleExport}
          disabled={exportBusy || (mode === 'asset' ? assetDisabled : collectionDisabled)}
          style={{ height: '36px', padding: '0 16px' }}
        >
          <FontAwesomeIcon icon={faDownload} />
          {' '}{exportBusy ? 'Exporting...' : 'Export'}
        </button>
      </div>
    </Modal>
  );
}

export default ExportChoiceModal;
