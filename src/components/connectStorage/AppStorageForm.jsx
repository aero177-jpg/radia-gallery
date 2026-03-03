import { useState, useCallback, useMemo } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faSpinner,
  faExclamationTriangle,
  faDatabase,
} from '@fortawesome/free-solid-svg-icons';
import {
  createAppStorageSource,
  registerSource,
  saveSource,
} from '../../storage/index.js';
import { getSupportedExtensions } from '../../formats/index.js';
import { useCollectionUploadFlow } from '../useCollectionUploadFlow.js';

function AppStorageForm({ onConnect, onBack }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [collectionName, setCollectionName] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const supportedExtensions = useMemo(() => getSupportedExtensions(), []);

  const {
    uploadInputRef,
    uploadAccept,
    openUploadPicker,
    handleUploadChange,
    uploadModal,
  } = useCollectionUploadFlow({
    prepareOnly: true,
    allowAssets: true,
    allowImages: true,
    onPreparedFiles: (files) => setSelectedFiles(files),
    onError: (message) => setError(message),
  });

  const handlePickFiles = useCallback(() => {
    openUploadPicker();
  }, [openUploadPicker]);

  const handleCreate = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    try {
      const source = createAppStorageSource({
        name: collectionName.trim() || 'App collection',
        collectionName: collectionName.trim() || 'App collection',
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });
      if (!result.success) {
        setError(result.error || 'Failed to connect');
        setStatus('error');
        return;
      }

      if (selectedFiles.length > 0) {
        const validFiles = selectedFiles.filter((file) => {
          const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          return supportedExtensions.includes(ext);
        });

        if (validFiles.length === 0) {
          setError('No supported files selected.');
          setStatus('error');
          return;
        }

        const importResult = await source.importFiles(validFiles);
        if (!importResult.success) {
          setError(importResult.error || 'Failed to import files');
          setStatus('error');
          return;
        }
      }

      registerSource(source);
      await saveSource(source.toJSON());
      await source.listAssets();

      setStatus('success');
      setTimeout(() => onConnect(source), 500);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [collectionName, selectedFiles, supportedExtensions, onConnect]);

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        {'Back'}
      </button>

      <h3>Create app storage collection</h3>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="Offline collection"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
      </div>

      <div class="form-info">
        <ul class="feature-list bullet-list">
          <li> Stored inside the app</li>
          <li> Works fully offline</li>
          <li> Optimal for standalone use via PWA install</li>

        </ul>
      </div>

      <div class="form-field">
        <label>Import files (optional)</label>
        <input
          ref={uploadInputRef}
          type="file"
          {...(uploadAccept ? { accept: uploadAccept } : {})}
          multiple
          style={{ display: 'none' }}
          onChange={handleUploadChange}
        />
        <button class="secondary-button" onClick={handlePickFiles} type="button" style={{ marginTop: '8px' }}>
          {selectedFiles.length > 0 ? `Selected ${selectedFiles.length} file(s)` : 'Choose files'}
        </button>
        <span class="field-hint">Supported: {supportedExtensions.join(', ')}</span>
      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="primary-button"
        onClick={handleCreate}
        disabled={status === 'connecting'}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Creating...
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            {' '}Created!
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faDatabase} />
            {' '}Create Collection
          </>
        )}
      </button>

      <p class="form-note">
        Collections are stored in the app’s private storage and remain available offline.
      </p>
      {uploadModal}
    </div>
  );
}

export default AppStorageForm;
