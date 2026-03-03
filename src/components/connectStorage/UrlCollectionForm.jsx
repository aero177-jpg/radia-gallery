import { useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faSpinner,
  faExclamationTriangle,
} from '@fortawesome/free-solid-svg-icons';
import {
  createPublicUrlSource,
  registerSource,
  saveSource,
} from '../../storage/index.js';

function UrlCollectionForm({ onConnect, onBack, initialSource, editMode = false, onSaveEdit }) {
  const initialUrlText = useMemo(() => {
    if (editMode && initialSource?.config?.config?.assetPaths?.length) {
      return initialSource.config.config.assetPaths.join('\n');
    }
    return '';
  }, [editMode, initialSource]);
  const [urlText, setUrlText] = useState(initialUrlText);
  const [collectionName, setCollectionName] = useState(
    editMode ? (initialSource?.name || initialSource?.config?.name || '') : ''
  );
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (editMode && initialSource) {
      setUrlText(initialSource?.config?.config?.assetPaths?.length ? initialSource.config.config.assetPaths.join('\n') : '');
      setCollectionName(initialSource?.name || initialSource?.config?.name || '');
      setStatus('idle');
      setError(null);
    }
  }, [editMode, initialSource]);

  const isValidUrl = useCallback((url) => {
    if (!url.trim()) return false;
    try {
      const parsed = new URL(url.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }, []);

  const allUrlsValid = useMemo(() => {
    const nonEmpty = urlText.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
    return nonEmpty.length > 0 && nonEmpty.every(u => isValidUrl(u));
  }, [urlText, isValidUrl]);

  const handleConnect = useCallback(async () => {
    const cleaned = urlText.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      setError('Add at least one URL');
      return;
    }

    for (const u of cleaned) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('URL must be http/https');
        }
      } catch (err) {
        setError(`Invalid URL: ${u}`);
        return;
      }
    }

    setStatus('connecting');
    setError(null);

    try {
      if (editMode && initialSource) {
        const updatedName = collectionName.trim() || initialSource.name;
        initialSource.name = updatedName;
        initialSource.config.name = updatedName;
        initialSource.config.config.assetPaths = cleaned;
        initialSource.config.config.customName = Boolean(collectionName.trim());

        await saveSource(initialSource.toJSON());
        registerSource(initialSource);
        await initialSource.listAssets();

        setStatus('success');
        const finish = onSaveEdit || onConnect;
        if (finish) {
          setTimeout(() => finish(initialSource), 300);
        }
        return;
      }

      const source = createPublicUrlSource({
        assetPaths: cleaned,
        name: collectionName.trim() || 'URL collection',
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });

      if (result.success) {
        registerSource(source);
        await saveSource(source.toJSON());
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
  }, [urlText, collectionName, onConnect, editMode, initialSource, onSaveEdit]);

  return (
    <div class="storage-form">
      {!editMode && (
        <button class="back-button" onClick={onBack}>
          {'Back'}
        </button>
      )}

      <h3>{editMode ? 'Edit URL collection' : 'Create URL collection'}</h3>

      <div class="form-info">
        <ul class="feature-list bullet-list">
          <>
            <li>No setup or credentials required</li>
            <li>Direct HTTP/HTTPS links only, read-only</li>
            <li>Best for quick demos or hosted files</li>
          </>
        </ul>
      </div>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="Public URLs"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
      </div>

      <div class="form-field">
        <label>Asset URLs</label>
        <textarea
          rows={8}
          placeholder={'https://example.com/scene-1.sog\nhttps://example.com/scene-2.ply'}
          value={urlText}
          onInput={(e) => setUrlText(e.target.value)}
        />
        <span class="field-hint">
          One URL per line. Only direct http/https links to .sog/.ply files are accepted.
        </span>
      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="primary-button"
        onClick={handleConnect}
        disabled={status === 'connecting' || !allUrlsValid}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>{editMode ? 'Saving changes...' : 'Saving collection...'}</span>
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            <span>{editMode ? 'Updated!' : 'Connected!'}</span>
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faCheck} />
            <span>{editMode ? 'Save changes' : 'Save URL collection'}</span>
          </>
        )}
      </button>
    </div>
  );
}

export default UrlCollectionForm;
