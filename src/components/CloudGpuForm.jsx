/**
 * Cloud GPU Settings Form
 * Extracted from ConnectStorageDialog.
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faSpinner,
  faExclamationTriangle,
  faQuestion,
  faChevronRight,
  faChevronDown,
  faInfoCircle,
  faLock,
} from '@fortawesome/free-solid-svg-icons';
import { loadCloudGpuSettings, saveCloudGpuSettings } from '../storage/cloudGpuSettings.js';
import {
  encryptCredentialValue,
  getVaultSecretIds,
  hasVaultPassword,
  isVaultUnlocked,
  unlockCredentialVault,
} from '../storage/credentialVault.js';
import {
  buildApiUrlFromModalUsername,
  ensureModalProcessApiUrl,
  extractModalUsernameFromApiUrl,
  normalizeModalUsername,
} from '../utils/modalEndpoints.js';

/**
 * Expandable FAQ item
 */
const GPU_OPTIONS = [
  { value: 't4', label: 'T4 $0.59 Budget option' },
  { value: 'l4', label: 'L4 $0.80 Good value' },
  { value: 'a10', label: 'A10 $1.10 Default, balanced' },
  { value: 'a100', label: 'A100 $2.50 High performance' },
  { value: 'h100', label: 'H100 $3.95 Fastest' },
];

const VAULT_PASSWORD_MISMATCH_ERROR = 'Password does not match the existing vault password.';

function FaqItem({ question, children }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="faq-item">
      <button
        class="faq-question"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <FontAwesomeIcon icon={faQuestion} className="faq-icon" />
        <span>{question}</span>
        <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="faq-chevron" />
      </button>
      {expanded && (
        <div class="faq-answer">
          {children}
        </div>
      )}
    </div>
  );
}

function CloudGpuForm({ onBack }) {
  const initialSettings = useMemo(
    () => {
      const saved = loadCloudGpuSettings();
      const savedModalUsername = normalizeModalUsername(
        saved?.modalUsername || extractModalUsernameFromApiUrl(saved?.apiUrl)
      );
      return {
        apiUrl: ensureModalProcessApiUrl(saved?.apiUrl || buildApiUrlFromModalUsername(savedModalUsername)),
        modalUsername: savedModalUsername,
        apiKey: saved?.apiKey || '',
        apiKeyEncrypted: saved?.apiKeyEncrypted || null,
        hasStoredApiKey: Boolean(saved?.hasStoredApiKey || saved?.apiKeyEncrypted || saved?.apiKey),
        requiresPassword: Boolean(saved?.requiresPassword),
        isEncrypted: Boolean(saved?.isEncrypted || saved?.apiKeyEncrypted),
        gpuType: saved?.gpuType || 'a10',
      };
    },
    []
  );
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [modalUsername, setModalUsername] = useState(initialSettings.modalUsername);
  const [apiKey, setApiKey] = useState(initialSettings.apiKey);
  const [gpuType, setGpuType] = useState(initialSettings.gpuType);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [encryptApiKey, setEncryptApiKey] = useState(Boolean(initialSettings.apiKeyEncrypted));
  const [unlockPasswordInput, setUnlockPasswordInput] = useState('');
  const [unlockingVault, setUnlockingVault] = useState(false);
  const [vaultPasswordExists, setVaultPasswordExists] = useState(() => hasVaultPassword());

  const hasEncryptedStoredKey = Boolean(savedSettings?.apiKeyEncrypted || savedSettings?.isEncrypted);
  const cloudPasswordLocked = Boolean(hasEncryptedStoredKey && !apiKey.trim());
  const vaultLockedForConfigChanges = Boolean(hasEncryptedStoredKey && vaultPasswordExists && !isVaultUnlocked());
  const showVaultPasswordInput = Boolean(
    !isVaultUnlocked() && (
      cloudPasswordLocked ||
      encryptApiKey ||
      Boolean(savedSettings?.apiKeyEncrypted)
    )
  );
  const hasStoredApiKey = Boolean(savedSettings?.hasStoredApiKey || savedSettings?.apiKeyEncrypted || savedSettings?.apiKey || apiKey.trim());
  const resolvedApiUrl = useMemo(() => buildApiUrlFromModalUsername(modalUsername), [modalUsername]);

  const trimmedSettings = useMemo(() => ({
    modalUsername: normalizeModalUsername(modalUsername),
    apiUrl: resolvedApiUrl,
    apiKey: apiKey.trim(),
    gpuType: (gpuType || 'a10').trim().toLowerCase(),
  }), [modalUsername, resolvedApiUrl, apiKey, gpuType]);
  const trimmedSaved = useMemo(() => ({
    apiUrl: ensureModalProcessApiUrl(savedSettings.apiUrl?.trim?.() || ''),
    modalUsername: normalizeModalUsername(savedSettings.modalUsername || extractModalUsernameFromApiUrl(savedSettings.apiUrl)),
    apiKey: savedSettings.apiKey?.trim?.() || '',
    gpuType: savedSettings.gpuType?.trim?.().toLowerCase?.() || 'a10',
  }), [savedSettings]);
  const isSettingsReady = Boolean(trimmedSettings.modalUsername && (trimmedSettings.apiKey || hasStoredApiKey));
  const settingsChanged =
    trimmedSettings.modalUsername !== trimmedSaved.modalUsername ||
    trimmedSettings.apiUrl !== trimmedSaved.apiUrl ||
    trimmedSettings.apiKey !== trimmedSaved.apiKey ||
    trimmedSettings.gpuType !== trimmedSaved.gpuType ||
    Boolean(encryptApiKey) !== Boolean(savedSettings.apiKeyEncrypted);

  const handleSave = useCallback(async () => {
    const typedApiKey = trimmedSettings.apiKey;
    const canReuseEncrypted = Boolean(!typedApiKey && savedSettings?.apiKeyEncrypted);
    const providedPassword = unlockPasswordInput.trim();

    if (!trimmedSettings.modalUsername || !trimmedSettings.apiUrl || (!typedApiKey && !hasStoredApiKey)) {
      setError('Enter Modal username and API key.');
      return;
    }

    let nextEncryptedApiKey = null;
    if (encryptApiKey) {
      if (canReuseEncrypted) {
        nextEncryptedApiKey = savedSettings.apiKeyEncrypted;
      }

      if (!nextEncryptedApiKey && !typedApiKey) {
        setError('Enter API key before enabling encryption.');
        return;
      }

      if (!nextEncryptedApiKey && !providedPassword && !isVaultUnlocked()) {
        setError(vaultPasswordExists
          ? 'Vault key already set. Enter vault password above.'
          : 'Create a vault password to encrypt this key.');
        return;
      }

      if (!nextEncryptedApiKey) {
        try {
        nextEncryptedApiKey = await encryptCredentialValue(
          getVaultSecretIds().cloudGpu,
          typedApiKey,
          providedPassword || undefined
        );
        setVaultPasswordExists(hasVaultPassword());
        } catch (err) {
          setError(err?.message || 'Failed to encrypt Cloud GPU API key.');
          return;
        }
      }
    } else if (savedSettings?.apiKeyEncrypted) {
      if (!isVaultUnlocked()) {
        if (!providedPassword) {
          setError('Enter vault password above to disable encryption.');
          return;
        }
        const unlockResult = await unlockCredentialVault(providedPassword);
        if (!unlockResult.success) {
          setError(unlockResult.error || (vaultPasswordExists ? VAULT_PASSWORD_MISMATCH_ERROR : 'Unable to unlock encrypted keys.'));
          return;
        }
      }

      if (!typedApiKey) {
        const unlocked = loadCloudGpuSettings();
        const decryptedKey = unlocked?.apiKey || '';
        if (!decryptedKey) {
          setError('Unable to decrypt Cloud GPU API key.');
          return;
        }
        setApiKey(decryptedKey);
      }
    }

    setStatus('saving');
    setError(null);

    const payload = {
      apiUrl: trimmedSettings.apiUrl,
      modalUsername: trimmedSettings.modalUsername,
      apiKey: encryptApiKey ? '' : (typedApiKey || savedSettings.apiKey || ''),
      apiKeyEncrypted: nextEncryptedApiKey || null,
      gpuType: trimmedSettings.gpuType,
      batchUploads: true,
      batchSize: 100,
    };

    if (!payload.apiKeyEncrypted) {
      delete payload.apiKeyEncrypted;
    }

    const ok = saveCloudGpuSettings(payload);

    if (!ok) {
      setStatus('idle');
      setError('Failed to save Cloud GPU settings.');
      return;
    }

    setSavedSettings({
      ...payload,
      apiKey: typedApiKey || savedSettings.apiKey || '',
      hasStoredApiKey: Boolean(payload.apiKeyEncrypted || payload.apiKey),
      requiresPassword: false,
      isEncrypted: Boolean(payload.apiKeyEncrypted),
    });
    setUnlockPasswordInput('');
    setStatus('success');
    setTimeout(() => setStatus('idle'), 800);
  }, [encryptApiKey, hasStoredApiKey, savedSettings, trimmedSettings, unlockPasswordInput, vaultPasswordExists]);

  const handleUnlockVault = useCallback(async () => {
    const password = unlockPasswordInput.trim();
    if (!password) {
      setError('Enter vault password to unlock encrypted keys.');
      return;
    }

    setUnlockingVault(true);
    setError(null);
    const result = await unlockCredentialVault(password);
    setUnlockingVault(false);

    if (!result.success) {
      setError(result.error || (vaultPasswordExists ? VAULT_PASSWORD_MISMATCH_ERROR : 'Unable to unlock encrypted keys.'));
      return;
    }

    const unlocked = loadCloudGpuSettings();
    if (unlocked) {
      const unlockedModalUsername = normalizeModalUsername(
        unlocked.modalUsername || extractModalUsernameFromApiUrl(unlocked.apiUrl)
      );
      setSavedSettings(unlocked);
      setModalUsername(unlockedModalUsername);
      setApiKey(unlocked.apiKey || '');
      setGpuType(unlocked.gpuType || 'a10');
      setEncryptApiKey(Boolean(unlocked.apiKeyEncrypted));
    }

    setUnlockPasswordInput('');
    setVaultPasswordExists(hasVaultPassword());
  }, [unlockPasswordInput]);

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        {'Back'}
      </button>

      <h3>Cloud GPU Configuration</h3>

      {cloudPasswordLocked && (
        <div class="form-notice" style={{ marginTop: '12px' }}>
          <FontAwesomeIcon icon={faLock} style={{ marginTop: '2px', flexShrink: 0 }} />
          {' '}Cloud GPU API key is encrypted. Unlock once per browser session.
        </div>
      )}

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

      <div style={{ 
        background: 'rgba(255, 255, 255, 0.03)', 
        border: '1px solid rgba(255, 255, 255, 0.08)', 
        borderRadius: '8px', 
        padding: '16px', 
        fontSize: '0.9em',
        lineHeight: '1.5',
        marginTop: '16px',
        color: 'var(--text-secondary, #bbb)' 
      }}>
        <p style={{ margin: '0 0 10px 0' }}>
         This feature connects to your personal instance of the companion container running on  <a
              href="https://modal.com"
              target="_blank"
              rel="noreferrer"
            >
              modal.com
            </a>
        </p>
        <ul style={{ margin: '0', paddingLeft: '18px', listStyleType: 'disc' }}>
          <li style={{ marginBottom: '6px' }}>Modal provides a generous free tier for GPU compute.</li>
          <li>
             Use our <a
              href="https://github.com/aero177-jpg/ml-sharp-optimized"
              target="_blank"
              rel="noreferrer"
            >optimized container template</a> to deploy the backend in minutes.
          </li>
        </ul>
      </div>

      <div class="config-grid" style={{ marginTop: '20px' }}>
        <div class="form-field">
          <label>Modal username</label>
          <input
            placeholder="your-modal-username"
            type='text'
            value={modalUsername}
            onInput={(e) => setModalUsername(normalizeModalUsername(e.target.value))}
          />
          <div class="field-hint" style={{ marginTop: '6px' }}>
  Used to auto-generate your Modal endpoint URL.
        </div>
        </div>

        <div class="form-field">
          <label>API key</label>
          <input
            placeholder={hasEncryptedStoredKey ? '••••••••' : 'cloud gpu api key'}
            type='password'
            value={apiKey}
            onInput={(e) => setApiKey(e.target.value)}
          />
        </div>

        <div class="form-field">
          <label class="checkbox-inline" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              checked={encryptApiKey}
              disabled={vaultLockedForConfigChanges}
              onChange={(e) => setEncryptApiKey(e.target.checked)}
            />
            <span>
              Encrypt key
            </span>
          </label>
          <span class="field-hint">
            {vaultLockedForConfigChanges ? 'Vault key already set. Apply password above to change encryption.' : (vaultPasswordExists ? 'Vault key already set.' : 'No vault key set yet.')}
          </span>
        </div>

        <div class="form-field">
          <label>GPU type</label>
          <select value={gpuType} onChange={(e) => setGpuType(e.target.value)}>
            {GPU_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="secondary-button"
        onClick={handleSave}
        disabled={status === 'saving' || !isSettingsReady || !settingsChanged}
        style={{ marginTop: '16px' }}
      >
        {status === 'saving' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Saving...
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            {' '}Saved
          </>
        ) : (
          'Save Cloud GPU settings'
        )}
      </button>

      <div class="faq-section" style={{ marginTop: '24px' }}>
        <FaqItem question="What does this do?">
          <p>It enables "Image to 3DGS" uploads. Raw images are sent to your cloud endpoint, converted to splats, and saved directly to your Supabase or R2 storage.</p>
        </FaqItem>

        <FaqItem question="Where do I find my API Key?">
          <p>The API Key is defined by you in the container's secrets.</p>
        </FaqItem>

        <FaqItem question="Is this required?">
          <p>No. You only need Cloud GPU settings if you plan to convert images before upload.</p>
        </FaqItem>
      </div>

      <p class="form-note" style={{ marginTop: '16px' }}>
        <a href="https://modal.com" target="_blank" rel="noreferrer noopener">Modal dashboard</a>
        {' · ' }
        <a href="https://modal.com/docs" target="_blank" rel="noreferrer noopener">Modal docs</a>
        {' · ' }
        <a href="https://github.com/your-org/your-modal-container" target="_blank" rel="noreferrer noopener">
          Container repo
        </a>
      </p>
    </div>
  );
}

export default CloudGpuForm;