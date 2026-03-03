import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { collectDroppedFiles, handleAddFiles, handleMultipleFiles } from '../fileLoader';
import { getSource } from '../storage/index.js';
import { loadCloudGpuSettings } from '../storage/cloudGpuSettings.js';
import { isImageFile, isSupportedFile, SUPPORTED_EXTENSIONS } from './useCollectionUploadFlow.js';
import { getAssetList } from '../assetManager.js';
import Modal from './Modal';

function ConfirmDropModal({
  isOpen,
  onClose,
  title,
  subtitle,
  detail,
  note,
  actions = [],
}) {
  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth={520}>
      <h2>{title}</h2>
      {subtitle && <p class="dialog-subtitle">{subtitle}</p>}
      {detail && <div class="drop-confirm-detail">{detail}</div>}
      {note && <div class="drop-confirm-note">{note}</div>}
      <div class="drop-confirm-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            class={action.variant === 'primary' ? 'primary-button' : 'secondary-button'}
            onClick={action.onClick}
            disabled={action.disabled}
            type="button"
          >
            {action.label}
          </button>
        ))}
        <button class="link-button" onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export function useViewerDrop({ activeSourceId, setStatus, handleAssets, handleImages }) {
  const [isViewerDragging, setIsViewerDragging] = useState(false);
  const [dropModalOpen, setDropModalOpen] = useState(false);
  const [pendingDrop, setPendingDrop] = useState(null);
  const dragDepthRef = useRef(0);

  const handleSessionOnlyDrop = useCallback(async (files) => {
    const hasAssets = getAssetList().length > 0;
    if (hasAssets) {
      await handleAddFiles(files, { selectFirstAdded: true });
      return;
    }
    await handleMultipleFiles(files);
  }, []);

  const handleConfirmDrop = useCallback(async (action) => {
    if (!pendingDrop) return;
    setDropModalOpen(false);
    setPendingDrop(null);

    if (action === 'upload-assets') {
      await handleAssets(pendingDrop.files);
      return;
    }

    if (action === 'process-images') {
      await handleImages(pendingDrop.files);
      return;
    }

    if (action === 'session-only') {
      await handleSessionOnlyDrop(pendingDrop.files);
    }
  }, [handleAssets, handleImages, handleSessionOnlyDrop, pendingDrop]);

  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    const preventDefaults = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const handleDragEnter = (event) => {
      preventDefaults(event);
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepthRef.current += 1;
      setIsViewerDragging(true);
    };

    const handleDragOver = (event) => {
      preventDefaults(event);
      if (!event.dataTransfer?.types?.includes('Files')) return;
      setIsViewerDragging(true);
    };

    const handleDragLeave = (event) => {
      preventDefaults(event);
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsViewerDragging(false);
      }
    };

    const handleDrop = async (event) => {
      preventDefaults(event);
      setIsViewerDragging(false);
      dragDepthRef.current = 0;

      const files = await collectDroppedFiles(event);
      if (!files.length) return;

      const splatFiles = files.filter(isSupportedFile);
      const imageFiles = files.filter(isImageFile);
      const unsupportedFiles = files.filter((file) => !isSupportedFile(file) && !isImageFile(file));

      if (unsupportedFiles.length > 0) {
        setStatus(`Unsupported files. Supported: ${SUPPORTED_EXTENSIONS.join(', ')} or common image formats.`);
        return;
      }

      if (splatFiles.length > 0 && imageFiles.length > 0) {
        setStatus('Drop either splat files (.ply/.sog) or images, not both.');
        return;
      }

      const cloudGpuSettings = loadCloudGpuSettings();
      const isCloudGpuConfigured = Boolean(cloudGpuSettings?.apiUrl && cloudGpuSettings?.apiKey);

      if (imageFiles.length > 0 && !isCloudGpuConfigured) {
        setStatus('Cloud GPU is not configured. Image drops are disabled.');
        return;
      }

      const activeSource = activeSourceId ? getSource(activeSourceId) : null;
      const fileList = splatFiles.length > 0 ? splatFiles : imageFiles;
      const mode = splatFiles.length > 0 ? 'splats' : 'images';

      const sourceType = activeSource?.type;
      const isLocalOnlySession = !activeSource || sourceType === 'local-folder';

      if (mode === 'splats' && isLocalOnlySession) {
        await handleSessionOnlyDrop(fileList);
        return;
      }

      setPendingDrop({
        files: fileList,
        mode,
        source: activeSource,
      });
      setDropModalOpen(true);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [activeSourceId, handleAssets, handleImages, setStatus]);

  const dropOverlay = (
    <div class={`viewer-drop-overlay ${isViewerDragging ? 'is-active' : ''}`} />
  );

  const dropModal = (
    <ConfirmDropModal
      isOpen={dropModalOpen}
      onClose={() => {
        setDropModalOpen(false);
        setPendingDrop(null);
      }}
      title={pendingDrop?.mode === 'images' ? 'Process dropped images' : 'Add dropped files'}
      subtitle={(() => {
        if (!pendingDrop) return '';
        const count = pendingDrop.files.length;
        const name = count === 1 ? pendingDrop.files[0].name : `${count} files`;
        if (pendingDrop.mode === 'images') {
          return `Convert ${name} with Cloud GPU.`;
        }
        if (pendingDrop.source?.type === 'public-url') {
          return `Add ${name} to this session only.`;
        }
        return `Add ${name} to the viewer.`;
      })()}
      detail={(() => {
        if (!pendingDrop) return null;
        const isCloud = ['supabase-storage', 'r2-bucket'].includes(pendingDrop.source?.type);
        if (pendingDrop.mode === 'images') {
          return isCloud
            ? 'Results will be uploaded to the active cloud collection.'
            : 'Results will be added locally for this session.';
        }
        return null;
      })()}
      actions={(() => {
        if (!pendingDrop) return [];
        const sourceType = pendingDrop.source?.type;
        const isCloud = ['supabase-storage', 'r2-bucket'].includes(sourceType);
        const isAppStorage = sourceType === 'app-storage';
        const isUrl = sourceType === 'public-url';

        if (pendingDrop.mode === 'images') {
          return [
            {
              label: isCloud ? 'Process and upload' : 'Process images',
              variant: 'primary',
              onClick: () => handleConfirmDrop('process-images'),
            },
          ];
        }

        if (isUrl) {
          return [
            {
              label: 'Add to session',
              variant: 'primary',
              onClick: () => handleConfirmDrop('session-only'),
            },
          ];
        }

        const actions = [];
        if (isCloud) {
          actions.push({
            label: 'Upload to storage',
            variant: 'primary',
            onClick: () => handleConfirmDrop('upload-assets'),
          });
        } else if (isAppStorage) {
          actions.push({
            label: 'Add to app storage',
            variant: 'primary',
            onClick: () => handleConfirmDrop('upload-assets'),
          });
        }

        actions.push({
          label: 'Session only',
          variant: isCloud || isAppStorage ? 'secondary' : 'primary',
          onClick: () => handleConfirmDrop('session-only'),
        });

        return actions;
      })()}
    />
  );

  return { dropOverlay, dropModal };
}
