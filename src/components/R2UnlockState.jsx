import { useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faSpinner, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';

function R2UnlockState({ sourceName, onUnlock, onBack }) {
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState('');

  const handleUnlock = async () => {
    const value = password.trim();
    if (!value) {
      setError('Enter vault password.');
      return;
    }

    setUnlocking(true);
    setError('');
    const result = await onUnlock?.(value);
    setUnlocking(false);

    if (!result?.success) {
      setError(result?.error || 'Unable to unlock this collection.');
      return;
    }

    setPassword('');
  };

  return (
    <div class="viewer-empty-state">
      <div class="viewer-empty-card" style={{ position: 'relative' }}>
        <button class="back-button viewer-empty-back" onClick={onBack}>
          Back
        </button>

        <h3>{sourceName || 'R2 collection'} is locked</h3>
        <p>
          This collection uses encrypted R2 credentials. Enter your vault password once per browser session.
        </p>

        <div class="form-field" style={{ marginTop: '10px' }}>
          <label>
            <FontAwesomeIcon icon={faLock} style={{ marginRight: '6px' }} />
            Vault password
          </label>
          <input
            type="password"
            placeholder="Enter password"
            value={password}
            onInput={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <div class="form-error" style={{ marginTop: '10px' }}>
            <FontAwesomeIcon icon={faExclamationTriangle} />
            {' '}{error}
          </div>
        )}

        <button class="viewer-empty-action" onClick={handleUnlock} disabled={unlocking || !password.trim()}>
          {unlocking ? (
            <>
              <FontAwesomeIcon icon={faSpinner} spin />
              {' '}Unlocking...
            </>
          ) : (
            'Unlock collection'
          )}
        </button>
      </div>
    </div>
  );
}

export default R2UnlockState;
