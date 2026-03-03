import { useState, useCallback, useMemo } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faTimes,
  faCheck,
  faSpinner,
  faExclamationTriangle,
  faFolderOpen,
} from '@fortawesome/free-solid-svg-icons';
import {
  createSupabaseStorageSource,
  registerSource,
  saveSource,
} from '../../storage/index.js';
import { loadSupabaseSettings, saveSupabaseSettings } from '../../storage/supabaseSettings.js';
import { listExistingCollections, testBucketConnection } from '../../storage/supabaseApi.js';
import { getAssetList } from '../../assetManager.js';
import { getSupportedExtensions } from '../../formats/index.js';
import { ExistingCollectionItem, FaqItem } from './SharedSections.jsx';

function SupabaseForm({ onConnect, onBack, onClose }) {
  const supportedExtensions = useMemo(() => getSupportedExtensions(), []);
  const queuedAssets = useMemo(() => getAssetList(), []);
  const queueFiles = useMemo(() => {
    return queuedAssets
      .filter((asset) => asset?.file && asset?.file?.name)
      .filter((asset) => {
        const ext = asset.file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        return supportedExtensions.includes(ext);
      })
      .map((asset) => asset.file);
  }, [queuedAssets, supportedExtensions]);
  const hasQueueFiles = queueFiles.length > 0;

  const initialSettings = useMemo(
    () => loadSupabaseSettings() || { supabaseUrl: '', anonKey: '', bucket: '' },
    []
  );
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [supabaseUrl, setSupabaseUrl] = useState(initialSettings.supabaseUrl);
  const [anonKey, setAnonKey] = useState(initialSettings.anonKey);
  const [bucket, setBucket] = useState(initialSettings.bucket);
  const [collectionName, setCollectionName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [hasManifest, setHasManifest] = useState(null);
  const [uploadExisting, setUploadExisting] = useState(false);

  const [existingCollections, setExistingCollections] = useState([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [showSupabaseConfig, setShowSupabaseConfig] = useState(false);
  const [selectedExisting, setSelectedExisting] = useState(null);

  const supabaseConfigured = Boolean(
    savedSettings.supabaseUrl && savedSettings.anonKey && savedSettings.bucket
  );
  const trimmedSettings = useMemo(() => ({
    supabaseUrl: supabaseUrl.trim(),
    anonKey: anonKey.trim(),
    bucket: bucket.trim(),
  }), [supabaseUrl, anonKey, bucket]);
  const trimmedSaved = useMemo(() => ({
    supabaseUrl: savedSettings.supabaseUrl?.trim?.() || '',
    anonKey: savedSettings.anonKey?.trim?.() || '',
    bucket: savedSettings.bucket?.trim?.() || '',
  }), [savedSettings]);
  const isSettingsReady = Boolean(
    trimmedSettings.supabaseUrl && trimmedSettings.anonKey && trimmedSettings.bucket
  );
  const settingsChanged =
    trimmedSettings.supabaseUrl !== trimmedSaved.supabaseUrl ||
    trimmedSettings.anonKey !== trimmedSaved.anonKey ||
    trimmedSettings.bucket !== trimmedSaved.bucket;

  const slugify = useCallback((value) => {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'collection';
  }, []);

  const loadExistingCollections = useCallback(async () => {
    if (!supabaseConfigured) return;

    setLoadingCollections(true);
    setError(null);

    const result = await listExistingCollections({
      supabaseUrl: supabaseUrl.trim(),
      anonKey: anonKey.trim(),
      bucket: bucket.trim(),
    });

    setLoadingCollections(false);

    if (result.success) {
      setExistingCollections(result.collections);
    } else {
      setError(result.error);
    }
  }, [supabaseConfigured, supabaseUrl, anonKey, bucket]);

  const handleSaveSettings = useCallback(async () => {
    if (!supabaseUrl.trim() || !anonKey.trim() || !bucket.trim()) {
      setError('Fill Supabase URL, anon key, and bucket.');
      return;
    }

    setStatus('testing');
    setError(null);

    const testResult = await testBucketConnection({
      supabaseUrl: trimmedSettings.supabaseUrl,
      anonKey: trimmedSettings.anonKey,
      bucket: trimmedSettings.bucket,
    });

    if (!testResult.success) {
      setError(`Connection failed: ${testResult.error}`);
      setStatus('idle');
      return;
    }

    saveSupabaseSettings({
      supabaseUrl: trimmedSettings.supabaseUrl,
      anonKey: trimmedSettings.anonKey,
      bucket: trimmedSettings.bucket,
    });
    setSavedSettings({
      supabaseUrl: trimmedSettings.supabaseUrl,
      anonKey: trimmedSettings.anonKey,
      bucket: trimmedSettings.bucket,
    });

    setStatus('idle');
    setError(null);
    await loadExistingCollections();
  }, [supabaseUrl, anonKey, bucket, loadExistingCollections, trimmedSettings]);

  const handleChooseExisting = useCallback((collection) => {
    setSelectedExisting(collection);
    setHasManifest(null);
    setStatus('idle');
    setError(null);
  }, []);

  const handleConnectSelected = useCallback(async () => {
    if (!selectedExisting) return;

    setStatus('connecting');
    setError(null);

    try {
      const source = createSupabaseStorageSource({
        supabaseUrl: supabaseUrl.trim(),
        anonKey: anonKey.trim(),
        bucket: bucket.trim(),
        collectionId: selectedExisting.id,
        collectionName: selectedExisting.name,
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
        registerSource(source);
        await saveSource(source.toJSON());
        setStatus('success');
        setTimeout(() => onClose?.(), 500);
      } else {
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [supabaseUrl, anonKey, bucket, onClose, selectedExisting]);

  const handleConnectAndSwitch = useCallback(async () => {
    if (!selectedExisting) return;

    setStatus('connecting');
    setError(null);

    try {
      const source = createSupabaseStorageSource({
        supabaseUrl: supabaseUrl.trim(),
        anonKey: anonKey.trim(),
        bucket: bucket.trim(),
        collectionId: selectedExisting.id,
        collectionName: selectedExisting.name,
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
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
  }, [supabaseUrl, anonKey, bucket, onConnect, selectedExisting]);

  const handleCreateNew = useCallback(async () => {
    if (!supabaseConfigured) {
      setError('Configure Supabase first.');
      return;
    }

    const collectionId = slugify(collectionName.trim()) || `collection-${Date.now()}`;

    setStatus('connecting');
    setError(null);

    try {
      const source = createSupabaseStorageSource({
        supabaseUrl: supabaseUrl.trim(),
        anonKey: anonKey.trim(),
        bucket: bucket.trim(),
        collectionId,
        collectionName: collectionName.trim() || undefined,
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
        registerSource(source);
        await saveSource(source.toJSON());

        if (uploadExisting && queueFiles.length > 0) {
          setStatus('uploading');
          const uploadResult = await source.uploadAssets(queueFiles);
          if (!uploadResult.success) {
            const firstError = uploadResult.failed?.[0]?.error;
            setError(firstError ? `Some uploads failed: ${firstError}` : 'Some uploads failed.');
          }
        }

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
  }, [supabaseConfigured, supabaseUrl, anonKey, bucket, collectionName, slugify, onConnect, uploadExisting, queueFiles]);

  if (!supabaseConfigured) {
    return (
      <div class="storage-form">
        <button class="back-button" onClick={onBack}>
          {'Back'}
        </button>

        <h3>Connect to Supabase</h3>
        <p class="dialog-subtitle">Enter your Supabase credentials to get started.</p>

        <div class="config-grid" style={{ marginTop: '16px' }}>
          <div class="form-field">
            <label>Supabase project URL</label>
            <input
              type="url"
              placeholder="https://abc.supabase.co"
              value={supabaseUrl}
              onInput={(e) => setSupabaseUrl(e.target.value)}
            />
          </div>

          <div class="form-field">
            <label>Anon/public key</label>
            <input
              type="text"
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              value={anonKey}
              onInput={(e) => setAnonKey(e.target.value)}
            />
          </div>

          <div class="form-field">
            <label>Bucket name</label>
            <input
              type="text"
              placeholder="3dgs-files"
              value={bucket}
              onInput={(e) => setBucket(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div class="form-error">
            <FontAwesomeIcon icon={faExclamationTriangle} />
            {' '}{error}
          </div>
        )}

        <button
          class="primary-button"
          onClick={handleSaveSettings}
          disabled={status === 'testing' || !isSettingsReady}
          style={{ marginTop: '16px' }}
        >
          {status === 'testing' ? (
            <>
              <FontAwesomeIcon icon={faSpinner} spin />
              {' '}Testing connection...
            </>
          ) : (
            'Connect to Supabase'
          )}
        </button>

        <div class="faq-section" style={{ marginTop: '24px' }}>
          <FaqItem question="Where do I find these keys?">
            <ol class="faq-steps">
              <li>Go to your <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer noopener">Supabase Dashboard</a></li>
              <li>Select your project (or create one)</li>
              <li>Click <strong>Project Settings</strong> → <strong>API</strong></li>
              <li>Copy the <strong>Project URL</strong> and <strong>anon/public</strong> key</li>
              <li>Go to <strong>Storage</strong> to create a bucket if needed</li>
            </ol>
          </FaqItem>

          <FaqItem question="How do I set up a free Supabase store?">
            <ol class="faq-steps">
              <li>Sign up at <a href="https://supabase.com" target="_blank" rel="noreferrer noopener">supabase.com</a> (free tier available)</li>
              <li>Create a new project</li>
              <li>Go to <strong>Storage</strong> in the sidebar</li>
              <li>Click <strong>New Bucket</strong>, name it (e.g., "3dgs-files")</li>
              <li>Toggle <strong>Public bucket</strong> on for easy access</li>
              <li>Copy credentials from <strong>Project Settings</strong> → <strong>API</strong></li>
            </ol>
          </FaqItem>
        </div>
      </div>
    );
  }

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        {'Back'}
      </button>

      <h3>Supabase Collection</h3>
      <div class="form-section">
        <div class="form-row">
          <div>
            <strong>Supabase settings</strong>
            <div class="field-hint">
              {supabaseConfigured
                ? <>Using bucket <em>{bucket}</em></>
                : 'Not configured yet.'}
            </div>
          </div>
          <button class="link-button" onClick={() => setShowSupabaseConfig(!showSupabaseConfig)}>
            {showSupabaseConfig ? 'Hide config' : (supabaseConfigured ? 'Edit config' : 'Configure Supabase')}
          </button>
        </div>

        {showSupabaseConfig && (
          <div class="config-grid">
            <div class="form-field">
              <label>Supabase project URL</label>
              <input
                type="url"
                placeholder="https://abc.supabase.co"
                value={supabaseUrl}
                onInput={(e) => setSupabaseUrl(e.target.value)}
              />
            </div>

            <div class="form-field">
              <label>Anon/public key</label>
              <input
                type="text"
                placeholder="supabase anon key"
                value={anonKey}
                onInput={(e) => setAnonKey(e.target.value)}
              />
            </div>

            <div class="form-field">
              <label>Bucket name</label>
              <input
                type="text"
                placeholder="3dgs-files"
                value={bucket}
                onInput={(e) => setBucket(e.target.value)}
              />
            </div>

            <button
              class="secondary-button"
              onClick={handleSaveSettings}
              disabled={
                status === 'testing' ||
                !isSettingsReady ||
                (supabaseConfigured && !settingsChanged)
              }
            >
              Save Supabase settings
            </button>
          </div>
        )}
      </div>

      <div class="form-section" style={{ marginTop: '16px' }}>
        <div class="form-row">
          <div>
            <strong>
              <FontAwesomeIcon icon={faFolderOpen} style={{ marginRight: '8px' }} />
              Add Existing Folder
            </strong>
          </div>
          <button
            class="link-button"
            onClick={() => {
              setShowExisting(!showExisting);
              if (!showExisting && existingCollections.length === 0) {
                loadExistingCollections();
              }
            }}
          >
            {showExisting ? 'Hide' : 'Browse'}
          </button>
        </div>

        {showExisting && (
          <div class="existing-collections-list">
            {loadingCollections ? (
              <div class="collections-loading">
                <FontAwesomeIcon icon={faSpinner} spin />
                {' '}Scanning bucket...
              </div>
            ) : existingCollections.length === 0 ? (
              <div class="collections-empty">
                No existing collections found in this bucket.
              </div>
            ) : (
              existingCollections.map((col) => (
                <ExistingCollectionItem
                  key={col.id}
                  collection={col}
                  onSelect={handleChooseExisting}
                  isLoading={status === 'connecting'}
                  selected={selectedExisting?.id === col.id}
                />
              ))
            )}
          </div>
        )}
      </div>

      {selectedExisting && (
        <div class="form-section existing-selection-review" style={{ position: 'relative' }}>
          <button
            class="modal-close selection-close"
            title="Clear selected collection"
            onClick={() => setSelectedExisting(null)}
            disabled={status === 'connecting'}
            style={{ position: 'absolute', top: '8px', right: '8px' }}
          >
            <FontAwesomeIcon icon={faTimes} />
          </button>

          <div class="form-row">
            <div>
              <strong>Selected collection</strong>
              <div class="field-hint">
                {selectedExisting.name} ({selectedExisting.id}) · {selectedExisting.assetCount} asset{selectedExisting.assetCount !== 1 ? 's' : ''}
                {selectedExisting.hasManifest && ' · manifest detected'}
              </div>
            </div>
          </div>

          <div class="form-actions" style={{ marginTop: '16px', gap: '8px', display: 'flex' }}>
            <button
              class="secondary-button"
              style={{ marginTop: '0px' }}
              onClick={handleConnectAndSwitch}
              disabled={status === 'connecting'}
            >
              Switch to new collection
            </button>
            <button
              class="primary-button"
              onClick={handleConnectSelected}
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? (
                <>
                  <FontAwesomeIcon icon={faSpinner} spin />
                  {' '}Connecting...
                </>
              ) : (
                'Done'
              )}
            </button>
          </div>
        </div>
      )}

      <div class="form-divider">
        <span>or create new</span>
      </div>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="My splat gallery"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
        <span class="field-hint">
          Will be stored under collections/{slugify(collectionName) || 'collection-xxx'}/
        </span>
      </div>

      {hasQueueFiles && (
        <div class="form-field">
          <label class="checkbox-inline">
            <input
              type="checkbox"
              checked={uploadExisting}
              onChange={(e) => setUploadExisting(e.target.checked)}
            />
            Upload current images ({queueFiles.length})
          </label>
          <span class="field-hint">Uploads start right after the collection is created.</span>
        </div>
      )}

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      {status === 'success' && hasManifest !== null && (
        <div class={`form-success ${hasManifest ? '' : 'warning'}`}>
          <FontAwesomeIcon icon={hasManifest ? faCheck : faExclamationTriangle} />
          {' '}
          {hasManifest
            ? 'Found manifest.json - loading is manifest-first'
            : 'Manifest was created for you'}
        </div>
      )}

      <button
        class="primary-button"
        onClick={handleCreateNew}
        disabled={status === 'connecting' || status === 'uploading'}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Creating collection...
          </>
        ) : status === 'uploading' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Uploading...
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            {' '}Connected!
          </>
        ) : (
          'Create New Collection'
        )}
      </button>

      <p class="form-note" style={{ marginTop: '16px' }}>
        <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer noopener">Dashboard</a>
        {' · '}
        <a href="https://supabase.com/docs/guides/storage" target="_blank" rel="noreferrer noopener">Storage docs</a>
      </p>
    </div>
  );
}

export default SupabaseForm;
