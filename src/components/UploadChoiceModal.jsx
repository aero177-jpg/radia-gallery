/**
 * Upload Choice Modal
 * Lets the user pick between image conversion and asset upload.
 */

import { useEffect, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCloud,
  faCheck,
  faUpload,
  faLock,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { CubeIcon, ImageIcon } from '../icons/customIcons';
import { loadCloudGpuSettings } from '../storage/cloudGpuSettings.js';
import { unlockCredentialVault } from '../storage/credentialVault.js';
import Modal from './Modal';

function UploadOptionItem({ title, subtitle, icon: Icon, selected, onSelect, onConfirm, disabled }) {

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
        {/* Reusing collection-icon class but centering the custom icon */}
        <div class="collection-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={20} color={selected ? undefined : "#5e707cb2"} />
        </div>
        <div class="collection-details">
          <span class="collection-name" style={{marginBottom: "4px"}}>{title}</span>
          <span class="collection-meta">{subtitle}</span>
        </div>
      </div>
      <FontAwesomeIcon
        icon={faCheck}
        className="collection-arrow"
        style={{ opacity: selected ? 1 : 0 }}
      />
    </button>
  );
}

function UploadChoiceModal({
  isOpen,
  onClose,
  onPickAssets,
  onPickImages,
  onOpenCloudGpu,
  supportedExtensions = [],
  title = 'Upload files',
  subtitle = 'Choose what you want to upload.',
  assetTitle = '3dgs scene upload',
  assetSubtitle,
  imageTitle = 'Images to convert',
  imageSubtitle,
  note = '',
}) {
  const getDefaultMode = (settings) => {
    const hasStoredCloudGpuKey = Boolean(settings?.hasStoredApiKey || settings?.apiKeyEncrypted || settings?.apiKey);
    const isCloudGpuConfigured = Boolean(settings?.apiUrl && hasStoredCloudGpuKey);
    const cloudGpuNeedsUnlock = Boolean(settings?.requiresPassword && settings?.apiKeyEncrypted);
    return isCloudGpuConfigured && !cloudGpuNeedsUnlock ? 'images' : 'assets';
  };

  const [mode, setMode] = useState(() => getDefaultMode(loadCloudGpuSettings())); // 'assets' | 'images'
  const [cloudGpuSettings, setCloudGpuSettings] = useState(() => loadCloudGpuSettings());
  const [vaultPasswordInput, setVaultPasswordInput] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [hasAttemptedLockedGpuSelection, setHasAttemptedLockedGpuSelection] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const settings = loadCloudGpuSettings();
    setCloudGpuSettings(settings);
    setMode(getDefaultMode(settings));
    setVaultPasswordInput('');
    setUnlockError('');
    setHasAttemptedLockedGpuSelection(false);
  }, [isOpen]);

  const hasStoredCloudGpuKey = Boolean(cloudGpuSettings?.hasStoredApiKey || cloudGpuSettings?.apiKeyEncrypted || cloudGpuSettings?.apiKey);
  const isCloudGpuConfigured = Boolean(cloudGpuSettings?.apiUrl && hasStoredCloudGpuKey);
  const cloudGpuNeedsUnlock = Boolean(cloudGpuSettings?.requiresPassword && cloudGpuSettings?.apiKeyEncrypted);
  const shouldShowCloudGpuUnlockMessage = Boolean(isCloudGpuConfigured && cloudGpuNeedsUnlock && hasAttemptedLockedGpuSelection);
  const shouldDisableImageOption = Boolean(!isCloudGpuConfigured || shouldShowCloudGpuUnlockMessage);

  const handleUnlockVault = async () => {
    const password = vaultPasswordInput.trim();
    if (!password) {
      setUnlockError('Enter vault password.');
      return;
    }

    setUnlocking(true);
    setUnlockError('');
    const result = await unlockCredentialVault(password);
    setUnlocking(false);
    if (!result.success) {
      setUnlockError(result.error || 'Unable to unlock Cloud GPU key.');
      return;
    }

    setVaultPasswordInput('');
    setCloudGpuSettings(loadCloudGpuSettings());
    setHasAttemptedLockedGpuSelection(false);
  };

  useEffect(() => {
    if ((!isCloudGpuConfigured || cloudGpuNeedsUnlock) && mode === 'images') {
      setMode('assets');
    }
  }, [cloudGpuNeedsUnlock, isCloudGpuConfigured, mode]);

  if (!isOpen) return null;

  const handleUpload = () => {
    if (mode === 'images' && (!isCloudGpuConfigured || cloudGpuNeedsUnlock)) return;
    if (mode === 'assets') {
      onPickAssets();
    } else if (mode === 'images') {
      onPickImages();
    }
  };

  const handleOpenCloudGpu = () => {
    onClose?.();
    onOpenCloudGpu?.();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
    >
      <h2>{title}</h2>
      <p class="dialog-subtitle">{subtitle}</p>

      <div class="upload-options-list" style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <UploadOptionItem
          title={assetTitle}
          subtitle={assetSubtitle || `Supported files:${supportedExtensions.join(', ')}`}
          icon={CubeIcon}
          selected={mode === 'assets'}
          onSelect={() => setMode('assets')}
          onConfirm={handleUpload}
        />
        <UploadOptionItem
          title={imageTitle}
          subtitle={imageSubtitle || 'Image files: .jpg, .png, .webp, .heic, etc.'}
          icon={ImageIcon}
          selected={mode === 'images'}
          onSelect={() => {
            if (cloudGpuNeedsUnlock && !hasAttemptedLockedGpuSelection) {
              setHasAttemptedLockedGpuSelection(true);
              return;
            }
            setMode('images');
          }}
          onConfirm={handleUpload}
          disabled={shouldDisableImageOption}
        />
      </div>

      <div class="form-info" style={{ marginTop: '16px' }}>
         {!isCloudGpuConfigured &&
           <p style={{ fontSize: '0.9em', color: 'var(--text-muted, #888)' }}>
             <FontAwesomeIcon icon={faCloud} style={{ marginRight: '6px' }} />
             Cloud GPU is not configured.{' '}
             {onOpenCloudGpu && (
               <button class="link-button" style={{ marginTop: '12px' }} type="button" onClick={handleOpenCloudGpu}>
                 Configure Cloud GPU
               </button>
             )}
           </p>
         }

         {shouldShowCloudGpuUnlockMessage && (
           <div style={{ marginTop: '8px' }}>
             <p style={{ fontSize: '0.9em', color: 'var(--text-muted, #888)' }}>
               <FontAwesomeIcon icon={faLock} style={{ marginRight: '6px' }} />
               Cloud GPU key is encrypted. Enter vault password for this session.
             </p>
             <div className="form-field" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
               <input
                 type="password"
                 placeholder="Vault password"
                 value={vaultPasswordInput}
                 onInput={(e) => setVaultPasswordInput(e.target.value)}
                 style={{ flex: '2 1 0' }}
               />
               <button
                 class="secondary-button"
                 type="button"
                 onClick={handleUnlockVault}
                 disabled={unlocking || !vaultPasswordInput.trim()}
                 style={{ marginTop: 0, flex: '1 1 0' }}
               >
                 {unlocking ? (
                   <>
                     <FontAwesomeIcon icon={faSpinner} spin />
                     {' '}Unlocking
                   </>
                 ) : (
                   'Unlock'
                 )}
               </button>
             </div>
             {unlockError && (
               <div class="field-hint" style={{ color: '#fca5a5', marginTop: '6px' }}>
                 {unlockError}
               </div>
             )}
           </div>
         )}
      </div>

      {note && (
        <i class="dialog-subtitle" style={{ marginTop: '12px', color: '#8a9bb8' }}>
          {note}
        </i>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
        <button
          class="secondary-button"
          onClick={onClose}
          style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: '0' }}
        >
          Cancel
        </button>
        <button
          class="primary-button"
          onClick={handleUpload}
          disabled={mode === 'images' && (!isCloudGpuConfigured || cloudGpuNeedsUnlock)}
          style={{ height: '36px', padding: '0 16px' }}
        >
          <FontAwesomeIcon icon={faUpload} />
          {' '}browse files
        </button>
      </div>
    </Modal>
  );
}

export default UploadChoiceModal;
