import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faDownload,
  faExclamationTriangle,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';
import SelectableOptionItem from './SelectableOptionItem';

function createInitialSelectionMap(options) {
  return (Array.isArray(options) ? options : []).reduce((acc, option) => {
    if (option?.key) acc[option.key] = false;
    return acc;
  }, {});
}

export function DemoCollectionsPage({
  isActive = true,
  onBack,
  onClose,
  onInstall,
  options = [],
}) {
  const [selectionMap, setSelectionMap] = useState(() => createInitialSelectionMap(options));
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      setSelectionMap(createInitialSelectionMap(options));
      setInstalling(false);
      setInstallError('');
    }
    wasActiveRef.current = isActive;
  }, [isActive, options]);

  const normalizedOptions = useMemo(() => (Array.isArray(options) ? options : []), [options]);

  const selectedKeys = useMemo(
    () => normalizedOptions
      .filter((option) => Boolean(option?.url) && Boolean(selectionMap[option.key]))
      .map((option) => option.key),
    [normalizedOptions, selectionMap]
  );

  const hasSelectableSelection = selectedKeys.length > 0;

  const toggleOption = (key, disabled) => {
    if (disabled || !key) return;
    setSelectionMap((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleInstall = async () => {
    if (installing || !hasSelectableSelection) return;

    setInstalling(true);
    setInstallError('');
    try {
      await onInstall?.(selectedKeys);
      onClose?.();
    } catch (err) {
      setInstallError(err?.message || 'Failed to install selected demo collections.');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      {onBack && (
        <button class="back-button" onClick={onBack}>
          Back
        </button>
      )}
      <h2>Add demo collections</h2>
      <p class="dialog-subtitle">
        Choose demo collections to view.
      </p>

      <div
        style={{
          marginTop: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          maxHeight: '46vh',
          overflowY: 'auto',
          paddingRight: '2px',
        }}
      >
        {normalizedOptions.map((option) => {
          const disabled = !option?.url;
          const subtitleBase = option?.subtitle || '';
          const subtitle = disabled
            ? `${subtitleBase ? `${subtitleBase} • ` : ''}Coming soon`
            : subtitleBase;

          return (
            <SelectableOptionItem
              key={option.key}
              title={option.title}
              subtitle={subtitle}
              icon={option.icon}
              selected={disabled ? false : Boolean(selectionMap[option.key])}
              onToggle={() => toggleOption(option.key, disabled)}
              disabled={disabled}
              indicatorIcon={faCheck}
            />
          );
        })}
      </div>

      {installError && (
        <div class="form-error" style={{ marginTop: '16px' }}>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{installError}
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
          onClick={handleInstall}
          disabled={installing || !hasSelectableSelection}
          style={{ height: '36px', padding: '0 16px', minWidth: '140px', fontSize: '14px' }}
        >
          {installing ? (
            <>
              <FontAwesomeIcon icon={faSpinner} spin />
              {' '}Loading...
            </>
          ) : (
            <>
              {' '}Open selected
            </>
          )}
        </button>
      </div>
    </>
  );
}

function AddDemoCollectionsModal({
  isOpen,
  onClose,
  onInstall,
  options = [],
}) {
  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth={520}>
      <DemoCollectionsPage
        isActive={isOpen}
        onClose={onClose}
        onInstall={onInstall}
        options={options}
      />
    </Modal>
  );
}

export default AddDemoCollectionsModal;
