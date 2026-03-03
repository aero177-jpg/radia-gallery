/**
 * Connect to Storage Dialog
 *
 * Modal dialog for adding new collections backed by Local Folder, Supabase, or R2 storage.
 */

import { useState, useCallback, useEffect } from 'preact/hooks';
import { isFileSystemAccessSupported } from '../storage/index.js';
import CloudGpuForm from './CloudGpuForm.jsx';
import Modal from './Modal';
import TierCard from './connectStorage/TierCard.jsx';
import LocalFolderForm from './connectStorage/LocalFolderForm.jsx';
import AppStorageForm from './connectStorage/AppStorageForm.jsx';
import UrlCollectionForm from './connectStorage/UrlCollectionForm.jsx';
import SupabaseForm from './connectStorage/SupabaseForm.jsx';
import R2Form from './connectStorage/R2Form.jsx';
import ImportZipForm from './ImportZipForm.jsx';

const isMobileUserAgent = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
};

function ConnectStorageDialog({ isOpen, onClose, onConnect, editSource, onEditComplete, initialTier = null }) {
  const [selectedTier, setSelectedTier] = useState(editSource?.type || initialTier || null);
  const localSupported = isFileSystemAccessSupported() && !isMobileUserAgent();
  const appStorageSupported = typeof indexedDB !== 'undefined';

  useEffect(() => {
    if (editSource) {
      setSelectedTier(editSource.type);
    }
  }, [editSource]);

  useEffect(() => {
    if (!editSource && isOpen) {
      setSelectedTier(initialTier || null);
    }
  }, [editSource, initialTier, isOpen]);

  const handleConnect = useCallback((source) => {
    onConnect?.(source);
    onClose();
    setSelectedTier(editSource?.type || null);
  }, [onConnect, onClose, editSource?.type]);

  const handleBack = useCallback(() => {
    setSelectedTier(editSource?.type || null);
  }, [editSource?.type]);

  const handleClose = useCallback(() => {
    onClose();
    setSelectedTier(null);
  }, [onClose]);

  if (!isOpen) return null;

  const isEditMode = Boolean(editSource && editSource.type === 'public-url');

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      maxWidth={"500px"}
    >
      {selectedTier === null && !isEditMode ? (
        <>
          <h2>Create a collection</h2>
          <p class="dialog-subtitle">
            Pick where your collection is stored. 
          </p>

          <div class="storage-tiers">
            {localSupported && (
              <TierCard
                type="local-folder"
                selected={false}
                onSelect={setSelectedTier}
              />
            )}
            {appStorageSupported && (
              <TierCard
                type="app-storage"
                selected={false}
                onSelect={setSelectedTier}
              />
            )}
            <TierCard
              type="supabase-storage"
              selected={false}
              onSelect={setSelectedTier}
            />
            <TierCard
              type="r2-bucket"
              selected={false}
              onSelect={setSelectedTier}
            />
            <TierCard
              type="public-url"
              selected={false}
              onSelect={setSelectedTier}
            />
          </div>

            <div class="form-divider" style={{ marginTop: '20px' }}>
              <span>Add Cloud GPU</span>
            </div>

            <div class="storage-tiers">
              <TierCard
                type="cloud-gpu"
                selected={false}
                onSelect={setSelectedTier}
              />
            </div>

            <div class="form-divider" style={{ marginTop: '20px' }}>
              <span>Import collections</span>
            </div>

            <div class="storage-tiers">
              <TierCard
                type="import-collections"
                selected={false}
                onSelect={setSelectedTier}
              />
            </div>
        </>
      ) : selectedTier === 'local-folder' ? (
        <LocalFolderForm onConnect={handleConnect} onBack={handleBack} />
      ) : selectedTier === 'app-storage' ? (
        <AppStorageForm onConnect={handleConnect} onBack={handleBack} />
      ) : selectedTier === 'supabase-storage' ? (
        <SupabaseForm onConnect={handleConnect} onBack={handleBack} />
      ) : selectedTier === 'r2-bucket' ? (
        <R2Form onConnect={handleConnect} onBack={handleBack} />
      ) : selectedTier === 'public-url' ? (
 <UrlCollectionForm 
            onConnect={handleConnect} 
            onBack={handleBack}
            initialSource={isEditMode ? editSource : null}
            editMode={isEditMode}
            onSaveEdit={onEditComplete || onConnect}
          />      ) : selectedTier === 'cloud-gpu' ? (
        <CloudGpuForm onBack={handleBack} />
      ) : selectedTier === 'import-collections' ? (
        <ImportZipForm onBack={handleBack} onClose={handleClose} />
        ) : null}
    </Modal>
  );
}

export default ConnectStorageDialog;
