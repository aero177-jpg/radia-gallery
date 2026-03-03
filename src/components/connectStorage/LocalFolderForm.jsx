import { useState, useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faFolder,
  faCheck,
  faSpinner,
  faExclamationTriangle,
} from '@fortawesome/free-solid-svg-icons';
import { createLocalFolderSource, registerSource } from '../../storage/index.js';

function LocalFolderForm({ onConnect, onBack }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [collectionName, setCollectionName] = useState('');

  const handleSelect = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    try {
      const source = createLocalFolderSource();
      const result = await source.connect(true);

      if (result.success) {
        if (collectionName.trim()) {
          source.name = collectionName.trim();
          source.config.name = collectionName.trim();
        }
        registerSource(source);
        setStatus('success');
        setTimeout(() => onConnect(source), 500);
      } else {
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [onConnect, collectionName]);

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        {'Back'}
      </button>

      <h3>Create local collection</h3>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="My local splats"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
      </div>

      <div class="form-info">
        <p>Select a folder containing splat files (.ply, .sog).</p>
        <ul class="feature-list bullet-list">
          <li> Works offline after selection</li>
          <li> Fast loading from local disk</li>
          <li> Connection persists across sessions</li>
        </ul>
      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="primary-button"
        onClick={handleSelect}
        disabled={status === 'connecting'}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Selecting...
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            {' '}Connected!
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faFolder} />
            {' '}Select Folder
          </>
        )}
      </button>

      <p class="form-note">
        Your browser will ask for permission to access the folder.
        The app only reads files and never uploads data.
      </p>
    </div>
  );
}

export default LocalFolderForm;
