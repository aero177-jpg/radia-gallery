import { useState, useCallback, useMemo } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faTimes,
  faCheck,
  faSpinner,
  faExclamationTriangle,
  faInfoCircle,
  faFolderOpen,
  faLock,
} from '@fortawesome/free-solid-svg-icons';
import {
  createR2BucketSource,
  registerSource,
  saveSource,
  getSourcesArray,
} from '../../storage/index.js';
import { loadR2Settings, saveR2Settings } from '../../storage/r2Settings.js';
import { listExistingCollections as listR2Collections, testR2Connection } from '../../storage/r2Api.js';
import {
  encryptCredentialValue,
  getVaultSecretIds,
  hasVaultPassword,
  isVaultUnlocked,
  unlockCredentialVault,
} from '../../storage/credentialVault.js';
import { getAssetList } from '../../assetManager.js';
import { getSupportedExtensions } from '../../formats/index.js';
import { ExistingCollectionItem, FaqItem } from './SharedSections.jsx';

const VAULT_PASSWORD_MISMATCH_ERROR = 'Password does not match the existing vault password.';

function R2Form({ onConnect, onBack, onClose }) {
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
    () => loadR2Settings() || {
      accountId: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: '',
      permissions: { canRead: true, canWrite: false, canDelete: false },
    },
    []
  );
  const hasInitialDetectedPermissions = Boolean(
    initialSettings.accountId &&
    initialSettings.accessKeyId &&
    initialSettings.secretAccessKey &&
    initialSettings.bucket &&
    initialSettings.permissions
  );
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [accountId, setAccountId] = useState(initialSettings.accountId);
  const [accessKeyId, setAccessKeyId] = useState(initialSettings.accessKeyId);
  const [secretAccessKey, setSecretAccessKey] = useState(initialSettings.secretAccessKey);
  const [bucket, setBucket] = useState(initialSettings.bucket);
  const [permissions, setPermissions] = useState({ canRead: true, ...(initialSettings.permissions || { canWrite: false, canDelete: false }) });
  const [hasDetectedPermissions, setHasDetectedPermissions] = useState(hasInitialDetectedPermissions);
  const [collectionName, setCollectionName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [messageType, setMessageType] = useState('error'); // 'error' | 'info'
  const [hasManifest, setHasManifest] = useState(null);
  const [uploadExisting, setUploadExisting] = useState(false);
  const [encryptSecretKey, setEncryptSecretKey] = useState(Boolean(initialSettings.secretAccessKeyEncrypted));
  const [unlockPasswordInput, setUnlockPasswordInput] = useState('');
  const [unlockingVault, setUnlockingVault] = useState(false);
  const [vaultPasswordExists, setVaultPasswordExists] = useState(() => hasVaultPassword());

  const [existingCollections, setExistingCollections] = useState([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [showR2Config, setShowR2Config] = useState(false);
  const [selectedExisting, setSelectedExisting] = useState(null);

  const persistSourceConfig = useCallback(async (source) => {
    const payload = source.toJSON();
    if (encryptSecretKey && payload?.config) {
      payload.config.secretAccessKey = '';
      payload.config.secretAccessKeyEncrypted = savedSettings.secretAccessKeyEncrypted || null;
    }
    await saveSource(payload);
  }, [encryptSecretKey, savedSettings.secretAccessKeyEncrypted]);

  const hasWritePermission = permissions.canWrite;
  const hasEncryptedStoredKey = Boolean(savedSettings?.secretAccessKeyEncrypted || savedSettings?.isEncrypted);
  const r2PasswordLocked = Boolean(savedSettings?.requiresPassword && !secretAccessKey.trim());
  const vaultLockedForConfigChanges = Boolean(hasEncryptedStoredKey && vaultPasswordExists && !isVaultUnlocked());
  const showVaultPasswordInput = Boolean(
    !isVaultUnlocked() && (
      r2PasswordLocked ||
      encryptSecretKey ||
      Boolean(savedSettings?.secretAccessKeyEncrypted)
    )
  );

  const r2Configured = Boolean(
    savedSettings?.permissions?.canRead &&
    (savedSettings.accountId && savedSettings.accessKeyId && savedSettings.secretAccessKey && savedSettings.bucket)
  );
  const trimmedSettings = useMemo(() => ({
    accountId: accountId.trim(),
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    bucket: bucket.trim(),
    permissions: { ...permissions, canRead: true },
  }), [accountId, accessKeyId, secretAccessKey, bucket, permissions]);
  const trimmedSaved = useMemo(() => ({
    accountId: savedSettings.accountId?.trim?.() || '',
    accessKeyId: savedSettings.accessKeyId?.trim?.() || '',
    secretAccessKey: savedSettings.secretAccessKey?.trim?.() || '',
    bucket: savedSettings.bucket?.trim?.() || '',
    permissions: savedSettings.permissions || { canRead: true, canWrite: false, canDelete: false },
  }), [savedSettings]);
  const isSettingsReady = Boolean(
    trimmedSettings.permissions.canRead &&
    trimmedSettings.accountId && trimmedSettings.accessKeyId && trimmedSettings.secretAccessKey && trimmedSettings.bucket
  );
  const canTestConnection = Boolean(
    trimmedSettings.accountId &&
    trimmedSettings.accessKeyId &&
    trimmedSettings.secretAccessKey &&
    trimmedSettings.bucket
  );
  const settingsChanged =
    trimmedSettings.accountId !== trimmedSaved.accountId ||
    trimmedSettings.accessKeyId !== trimmedSaved.accessKeyId ||
    trimmedSettings.secretAccessKey !== trimmedSaved.secretAccessKey ||
    trimmedSettings.bucket !== trimmedSaved.bucket ||
    trimmedSettings.permissions.canRead !== trimmedSaved.permissions.canRead ||
    trimmedSettings.permissions.canWrite !== trimmedSaved.permissions.canWrite ||
    trimmedSettings.permissions.canDelete !== trimmedSaved.permissions.canDelete ||
    Boolean(encryptSecretKey) !== Boolean(savedSettings.secretAccessKeyEncrypted);

  const slugify = useCallback((value) => {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'collection';
  }, []);

  const loadExistingCollections = useCallback(async () => {
    if (!r2Configured) return;

    setLoadingCollections(true);
    setMessageType('error');
    setError(null);

    const result = await listR2Collections({
      accountId: accountId.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      bucket: bucket.trim(),
    });

    setLoadingCollections(false);

    if (result.success) {
      setExistingCollections(result.collections);
    } else {
      setMessageType('error');
      setError(result.error);
    }
  }, [r2Configured, accountId, accessKeyId, secretAccessKey, bucket]);

  const handleTestConnection = useCallback(async () => {
    if (!trimmedSettings.permissions.canRead) {
      setMessageType('error');
      setError('Read permission is required.');
      return;
    }
    if (!trimmedSettings.accountId || !trimmedSettings.accessKeyId || !trimmedSettings.secretAccessKey || !trimmedSettings.bucket) {
      setMessageType('error');
      setError('Fill Account ID, access key, secret, and bucket.');
      return;
    }

    setStatus('testing');
    setMessageType('error');
    setError(null);

    const testResult = await testR2Connection({
      accountId: trimmedSettings.accountId,
      accessKeyId: trimmedSettings.accessKeyId,
      secretAccessKey: trimmedSettings.secretAccessKey,
      bucket: trimmedSettings.bucket,
      permissions: trimmedSettings.permissions,
    });

    const probeErrorText = testResult.probeErrors?.length
      ? ` ${testResult.probeErrors.join(' · ')}`
      : '';

    if (testResult.permissions) {
      setPermissions({ canRead: true, ...testResult.permissions });
      setHasDetectedPermissions(true);
    } else {
      setPermissions({ canRead: true, canWrite: false, canDelete: false });
      setHasDetectedPermissions(false);
    }

    if (!testResult.success) {
      setMessageType('error');
      setError(`Connection failed: ${testResult.error}${probeErrorText}`);
    } else if (!testResult.permissions?.canWrite) {
      setMessageType('info');
      setError('Read-only connection. API credentials are still needed to read collection manifests. For public assets you can use a URL List connection instead and enter asset addresses directly.');
    } else {
      if (!testResult.permissions?.canDelete) {
        setMessageType('error');
        setError(`Connected, but delete permission is missing.${probeErrorText}`);
      } else if (probeErrorText) {
        setMessageType('error');
        setError(`Connection test completed with warnings.${probeErrorText}`);
      }
    }
    setStatus('idle');
  }, [trimmedSettings]);

  const handleSaveSettings = useCallback(async () => {
    if (!isSettingsReady) {
      setMessageType('error');
      setError('Read + account/key/bucket are required.');
      return;
    }

    let nextSecretAccessKey = trimmedSettings.secretAccessKey;
    let nextEncryptedSecret = null;
    const providedPassword = unlockPasswordInput.trim();

    if (encryptSecretKey) {
      if (!providedPassword && !isVaultUnlocked()) {
        setMessageType('error');
        setError(vaultPasswordExists
          ? 'Vault key already set. Enter vault password above.'
          : 'Create a vault password to encrypt the key.');
        return;
      }

      if (vaultPasswordExists && !isVaultUnlocked()) {
        const unlockResult = await unlockCredentialVault(providedPassword);
        if (!unlockResult.success) {
          setMessageType('error');
          setError(unlockResult.error || (vaultPasswordExists ? VAULT_PASSWORD_MISMATCH_ERROR : 'Unable to unlock encrypted keys.'));
          return;
        }
      }

      try {
        nextEncryptedSecret = await encryptCredentialValue(
          getVaultSecretIds().r2,
          trimmedSettings.secretAccessKey,
          providedPassword || undefined
        );
        setVaultPasswordExists(hasVaultPassword());
      } catch (err) {
        setMessageType('error');
        setError(err?.message || 'Failed to encrypt the R2 key.');
        return;
      }
    } else if (savedSettings?.secretAccessKeyEncrypted && !isVaultUnlocked()) {
      if (!providedPassword) {
        setMessageType('error');
        setError('Enter vault password above to disable encryption.');
        return;
      }

      const unlockResult = await unlockCredentialVault(providedPassword);
      if (!unlockResult.success) {
        setMessageType('error');
        setError(unlockResult.error || (vaultPasswordExists ? VAULT_PASSWORD_MISMATCH_ERROR : 'Unable to unlock encrypted keys.'));
        return;
      }

      const unlockedSettings = loadR2Settings();
      nextSecretAccessKey = trimmedSettings.secretAccessKey || unlockedSettings?.secretAccessKey || '';
      if (!nextSecretAccessKey) {
        setMessageType('error');
        setError('Unable to decrypt secret key.');
        return;
      }

      setSecretAccessKey(nextSecretAccessKey);
    }

    const payload = {
      accountId: trimmedSettings.accountId,
      accessKeyId: trimmedSettings.accessKeyId,
      secretAccessKey: encryptSecretKey ? '' : nextSecretAccessKey,
      secretAccessKeyEncrypted: nextEncryptedSecret || null,
      bucket: trimmedSettings.bucket,
      permissions: trimmedSettings.permissions,
    };

    if (!payload.secretAccessKeyEncrypted) {
      delete payload.secretAccessKeyEncrypted;
    }

    saveR2Settings(payload);
    setSavedSettings({
      ...payload,
      secretAccessKey: nextSecretAccessKey,
      requiresPassword: false,
      isEncrypted: Boolean(payload.secretAccessKeyEncrypted),
    });

    // Update permissions on any already-registered R2 sources matching this account/bucket
    const activeSources = getSourcesArray();
    for (const src of activeSources) {
      if (
        src.type === 'r2-bucket' &&
        src.config?.config?.accountId === trimmedSettings.accountId &&
        src.config?.config?.bucket === trimmedSettings.bucket
      ) {
        src.config.config.permissions = { ...trimmedSettings.permissions };
        src.config.config.accessKeyId = trimmedSettings.accessKeyId;
        src.config.config.secretAccessKey = nextSecretAccessKey;
        try { await persistSourceConfig(src); } catch (e) { console.warn('[R2Form] Failed to persist source update', e); }
      }
    }

    setUnlockPasswordInput('');

    setHasDetectedPermissions(true);
    setStatus('idle');
    setMessageType('error');
    setError(null);
    await loadExistingCollections();
  }, [encryptSecretKey, isSettingsReady, loadExistingCollections, persistSourceConfig, savedSettings?.secretAccessKeyEncrypted, trimmedSettings, unlockPasswordInput, vaultPasswordExists]);

  const handleUnlockVault = useCallback(async () => {
    const password = unlockPasswordInput.trim();
    if (!password) {
      setMessageType('error');
      setError('Enter vault password to unlock encrypted keys.');
      return;
    }

    setUnlockingVault(true);
    setMessageType('error');
    setError(null);
    const result = await unlockCredentialVault(password);
    setUnlockingVault(false);

    if (!result.success) {
      setMessageType('error');
      setError(result.error || (vaultPasswordExists ? VAULT_PASSWORD_MISMATCH_ERROR : 'Unable to unlock encrypted keys.'));
      return;
    }

    const unlocked = loadR2Settings();
    if (unlocked) {
      setSavedSettings(unlocked);
      setAccountId(unlocked.accountId || '');
      setAccessKeyId(unlocked.accessKeyId || '');
      setSecretAccessKey(unlocked.secretAccessKey || '');
      setBucket(unlocked.bucket || '');
      setPermissions({ canRead: true, ...(unlocked.permissions || { canWrite: false, canDelete: false }) });
      setEncryptSecretKey(Boolean(unlocked.secretAccessKeyEncrypted));
    }

    setUnlockPasswordInput('');
    setVaultPasswordExists(hasVaultPassword());
  }, [unlockPasswordInput]);

  const handleChooseExisting = useCallback((collection) => {
    setSelectedExisting(collection);
    setHasManifest(null);
    setStatus('idle');
    setMessageType('error');
    setError(null);
  }, []);

  const handleConnectSelected = useCallback(async () => {
    if (!selectedExisting) return;

    setStatus('connecting');
    setMessageType('error');
    setError(null);

    try {
      const source = createR2BucketSource({
        accountId: accountId.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        bucket: bucket.trim(),
        collectionId: selectedExisting.id,
        collectionName: selectedExisting.name,
        permissions: trimmedSettings.permissions,
      });

      const result = await source.connect({ refreshManifest: false, verifyUpload: false });

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
        registerSource(source);
        await persistSourceConfig(source);
        setStatus('success');
        setTimeout(() => onClose?.(), 500);
      } else {
        setMessageType('error');
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setMessageType('error');
      setError(err.message);
      setStatus('error');
    }
  }, [accountId, accessKeyId, secretAccessKey, bucket, onClose, persistSourceConfig, selectedExisting, trimmedSettings]);

  const handleConnectAndSwitch = useCallback(async () => {
    if (!selectedExisting) return;

    setStatus('connecting');
    setMessageType('error');
    setError(null);

    try {
      const source = createR2BucketSource({
        accountId: accountId.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        bucket: bucket.trim(),
        collectionId: selectedExisting.id,
        collectionName: selectedExisting.name,
        permissions: trimmedSettings.permissions,
      });

      const result = await source.connect();

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
        registerSource(source);
        await persistSourceConfig(source);
        setStatus('success');
        setTimeout(() => onConnect(source), 500);
      } else {
        setMessageType('error');
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setMessageType('error');
      setError(err.message);
      setStatus('error');
    }
  }, [accountId, accessKeyId, secretAccessKey, bucket, onConnect, persistSourceConfig, selectedExisting, trimmedSettings]);

  const handleCreateNew = useCallback(async () => {
    if (!r2Configured) {
      setMessageType('error');
      setError('Configure R2 first.');
      return;
    }

    const collectionId = slugify(collectionName.trim()) || `collection-${Date.now()}`;
    setStatus('connecting');
    setMessageType('error');
    setError(null);

    try {
      const source = createR2BucketSource({
        accountId: accountId.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        bucket: bucket.trim(),
        collectionId,
        collectionName: collectionName.trim() || undefined,
        permissions: trimmedSettings.permissions,
      });

      const result = await source.connect();

      if (result.success) {
        setHasManifest(source.config.config.hasManifest);
        registerSource(source);
        await persistSourceConfig(source);

        if (hasWritePermission && uploadExisting && queueFiles.length > 0) {
          setStatus('uploading');
          const uploadResult = await source.uploadAssets(queueFiles);
          if (!uploadResult.success) {
            const firstError = uploadResult.failed?.[0]?.error;
            setMessageType('error');
            setError(firstError ? `Some uploads failed: ${firstError}` : 'Some uploads failed.');
          }
        }

        setStatus('success');
        setTimeout(() => onConnect(source), 500);
      } else {
        setMessageType('error');
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setMessageType('error');
      setError(err.message);
      setStatus('error');
    }
  }, [r2Configured, accountId, accessKeyId, secretAccessKey, bucket, collectionName, slugify, onConnect, hasWritePermission, persistSourceConfig, uploadExisting, queueFiles, trimmedSettings]);

  if (!r2Configured) {
    return (
      <div class="storage-form">
        <button class="back-button" onClick={onBack}>
          {'Back'}
        </button>

        <h3>Connect to Cloudflare R2</h3>
        <p class="dialog-subtitle">Enter your R2 settings, then test to discover read/write/delete permissions automatically.</p>

        {r2PasswordLocked && (
          <div class="form-notice" style={{ marginTop: '12px' }}>
            <FontAwesomeIcon icon={faLock} style={{ marginTop: '2px', flexShrink: 0 }} />
            {' '}This R2 secret is encrypted. Unlock once per browser session.
          </div>
        )}

        {showVaultPasswordInput && (
          <div class="form-field" style={{ marginTop: '12px' }}>
            <label>Vault password</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="password"
                placeholder="Vault password"
                value={unlockPasswordInput}
                onInput={(e) => setUnlockPasswordInput(e.target.value)}
                style={{ flex: '2 1 0' }}
              />
              <button
                class="secondary-button"
                onClick={handleUnlockVault}
                disabled={unlockingVault || !unlockPasswordInput.trim()}
                style={{ marginTop: 0, flex: '1 1 0' }}
              >
                {unlockingVault ? (
                  <>
                    <FontAwesomeIcon icon={faSpinner} spin />
                    {' '}Unlocking
                  </>
                ) : (
                  'Unlock'
                )}
              </button>
            </div>
            <span class="field-hint" style={{ marginTop: '6px', display: 'block' }}>
              Shared with Cloud GPU encryption.
            </span>
          </div>
        )}

        <div class="form-field" style={{ marginTop: '12px' }}>
          <label>Detected permissions</label>
          {hasDetectedPermissions ? (
            <div class="permissions-inline">
              <span class={`permission-pill ${permissions.canRead ? 'is-allowed' : 'is-denied'}`}>
                <FontAwesomeIcon icon={permissions.canRead ? faCheck : faTimes} />
                {' '}Read
              </span>
              <span class={`permission-pill ${permissions.canWrite ? 'is-allowed' : 'is-denied'}`}>
                <FontAwesomeIcon icon={permissions.canWrite ? faCheck : faTimes} />
                {' '}Write
              </span>
              <span class={`permission-pill ${permissions.canDelete ? 'is-allowed' : 'is-denied'}`}>
                <FontAwesomeIcon icon={permissions.canDelete ? faCheck : faTimes} />
                {' '}Delete
              </span>
            </div>
          ) : (
            <span class="field-hint" style={{ fontStyle: 'italic' }}>
              Read-only option: If you prefer read-only access, make the bucket public in your R2 dashboard, then use the URL List connection and enter asset URLs there.
            </span>
          )}
        </div>

        <div class="config-grid" style={{ marginTop: '16px' }}>
          <div class="form-field">
            <label>Account ID</label>
            <input
              type="text"
              placeholder="abcdef1234567890"
              value={accountId}
              onInput={(e) => setAccountId(e.target.value)}
            />
          </div>

          <div class="form-field">
            <label>Access key ID</label>
            <input
              type="text"
              placeholder="R2 access key ID"
              value={accessKeyId}
              onInput={(e) => setAccessKeyId(e.target.value)}
            />
          </div>

          <div class="form-field">
            <label>Secret access key</label>
            <input
              type="password"
              placeholder="R2 secret access key"
              value={secretAccessKey}
              onInput={(e) => setSecretAccessKey(e.target.value)}
            />
          </div>

          <div class="form-field">
            <label class="checkbox-inline" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={encryptSecretKey}
                disabled={vaultLockedForConfigChanges}
                onChange={(e) => setEncryptSecretKey(e.target.checked)}
              />
              <span>
                Encrypt key
              </span>
            </label>
            <span class="field-hint">
              {vaultLockedForConfigChanges ? 'Vault key already set. Unlock above to change encryption.' : (vaultPasswordExists ? 'Vault key already set.' : 'No vault key set yet.')}
            </span>
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
          <div class={messageType === 'info' ? 'form-notice' : 'form-error'}>
            <FontAwesomeIcon icon={messageType === 'info' ? faInfoCircle : faExclamationTriangle} style={{ marginTop: '2px', flexShrink: 0 }} />
            {' '}{error}
          </div>
        )}

        <div class="form-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
          <button
            class="secondary-button"
            onClick={handleTestConnection}
            disabled={status === 'testing' || !canTestConnection}
            style={{ marginTop: '0px' }}
          >
            {status === 'testing' ? (
              <>
                <FontAwesomeIcon icon={faSpinner} spin />
                {' '}Testing...
              </>
            ) : (
              'Test Connection'
            )}
          </button>

          <button
            class="primary-button"
            onClick={handleSaveSettings}
            disabled={status === 'testing' || !isSettingsReady}
            style={{ marginTop: '0px' }}
          >
            Save R2 settings
          </button>
        </div>

        <div class="faq-section" style={{ marginTop: '24px' }}>
          <FaqItem question="Where do I find these keys?">
            <ol class="faq-steps">
              <li>Open the <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer noopener">Cloudflare Dashboard</a></li>
              <li>Select your account → <strong>R2</strong></li>
              <li>Create an <strong>API token</strong> or access key pair</li>
              <li>Copy the Account ID and key pair</li>
              <li>Grant read/list permissions, plus write/delete if you want uploads/removal</li>
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

      <h3>R2 Collection</h3>

      {showVaultPasswordInput && (
        <div class="form-field" style={{ marginTop: '12px' }}>
          <label>Vault password</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="password"
              placeholder="Enter password"
              value={unlockPasswordInput}
              onInput={(e) => setUnlockPasswordInput(e.target.value)}
              style={{ flex: '2 1 0' }}
            />
            <button
              class="secondary-button"
              onClick={handleUnlockVault}
              disabled={unlockingVault || !unlockPasswordInput.trim()}
              style={{ marginTop: 0, flex: '1 1 0' }}
            >
              {unlockingVault ? (
                <>
                  <FontAwesomeIcon icon={faSpinner} spin />
                  {' '}Unlocking
                </>
              ) : (
                'Unlock'
              )}
            </button>
          </div>
        </div>
      )}

      <div class="form-section">
        <div class="form-row">
          <div>
            <strong>R2 settings</strong>
            <div class="field-hint">
              {r2Configured
                ? <>Using bucket <em>{bucket}</em></>
                : 'Not configured yet.'}
            </div>
          </div>
          <button class="link-button" onClick={() => setShowR2Config(!showR2Config)}>
            {showR2Config ? 'Hide config' : (r2Configured ? 'Edit config' : 'Configure R2')}
          </button>
        </div>

        {showR2Config && (
          <div class="config-grid">
            <div class="form-field">
              <label>Detected permissions</label>
              {hasDetectedPermissions ? (
                <div class="permissions-inline">
                  <span class={`permission-pill ${permissions.canRead ? 'is-allowed' : 'is-denied'}`}>
                    <FontAwesomeIcon icon={permissions.canRead ? faCheck : faTimes} />
                    {' '}Read
                  </span>
                  <span class={`permission-pill ${permissions.canWrite ? 'is-allowed' : 'is-denied'}`}>
                    <FontAwesomeIcon icon={permissions.canWrite ? faCheck : faTimes} />
                    {' '}Write
                  </span>
                  <span class={`permission-pill ${permissions.canDelete ? 'is-allowed' : 'is-denied'}`}>
                    <FontAwesomeIcon icon={permissions.canDelete ? faCheck : faTimes} />
                    {' '}Delete
                  </span>
                </div>
              ) : (
                <span class="field-hint" style={{ fontStyle: 'italic' }}>
                  Read-only option: If you prefer read-only access, make the bucket public in your R2 dashboard, then use the URL List connection and enter asset URLs there.
                </span>
              )}
            </div>

            <div class="form-field">
              <label>Account ID</label>
              <input
                type="text"
                placeholder="abcdef1234567890"
                value={accountId}
                onInput={(e) => setAccountId(e.target.value)}
              />
            </div>

            <div class="form-field">
              <label>Access key ID</label>
              <input
                type="text"
                placeholder="R2 access key ID"
                value={accessKeyId}
                onInput={(e) => setAccessKeyId(e.target.value)}
              />
            </div>

            <div class="form-field">
              <label>Secret access key</label>
              <input
                type="password"
                placeholder="R2 secret access key"
                value={secretAccessKey}
                onInput={(e) => setSecretAccessKey(e.target.value)}
              />
            </div>

            <div class="form-field">
              <label class="checkbox-inline" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={encryptSecretKey}
                  disabled={vaultLockedForConfigChanges}
                  onChange={(e) => setEncryptSecretKey(e.target.checked)}
                />
                <span>
                  Encrypt key
                  {' '}
                  <FontAwesomeIcon
                    icon={faInfoCircle}
                    title="Encrypted at rest in local storage; details coming soon."
                    style={{ opacity: 0.8 }}
                  />
                </span>
              </label>
              <span class="field-hint">
                {vaultLockedForConfigChanges ? 'Vault key already set. Unlock above to change encryption.' : (vaultPasswordExists ? 'Vault key already set.' : 'No vault key set yet.')}
              </span>
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
              onClick={handleTestConnection}
              disabled={status === 'testing' || !canTestConnection}
            >
              {status === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>

            <button
              class="secondary-button"
              onClick={handleSaveSettings}
              disabled={
                status === 'testing' ||
                !isSettingsReady ||
                (r2Configured && !settingsChanged)
              }
            >
              Save R2 settings
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
              if (!showExisting) loadExistingCollections();
              setShowExisting(!showExisting);
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

      {hasWritePermission && hasQueueFiles && (
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
        <div class={messageType === 'info' ? 'form-notice' : 'form-error'}>
          <FontAwesomeIcon icon={messageType === 'info' ? faInfoCircle : faExclamationTriangle} style={{ marginTop: '2px', flexShrink: 0 }} />
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
        <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer noopener">Dashboard</a>
        {' · '}
        <a href="https://developers.cloudflare.com/r2/" target="_blank" rel="noreferrer noopener">R2 docs</a>
      </p>
    </div>
  );
}

export default R2Form;
