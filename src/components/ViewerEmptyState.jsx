/**
 * Viewer empty state for open collections with no assets.
 */

import { useCallback, useMemo } from 'preact/hooks';
import { useStore } from '../store';
import { clearBackground } from '../backgroundManager';
import { resetSplatManager } from '../splatManager';
import { requestRender, setCurrentMesh } from '../viewer';
import { useCollectionUploadFlow } from './useCollectionUploadFlow.js';

const getEmptyCopy = (source) => {
  const name = source?.name || 'Collection';
  switch (source?.type) {
    case 'local-folder':
      return {
        title: `${name} is empty`,
        description: 'This folder has no supported files yet. Add files to the folder and refresh the collection.',
        actionLabel: 'Add files',
      };
    case 'app-storage':
      return {
        title: `${name} is empty`,
        description: 'Add files to this offline collection to start viewing.',
        actionLabel: 'Add files',
      };
    case 'supabase-storage':
      return {
        title: `${name} is empty`,
        description: 'Upload files to this Supabase collection to start viewing.',
        actionLabel: 'Add files',
      };
    case 'public-url':
      return {
        title: `${name} is empty`,
        description: 'Add URLs to this collection to start viewing.',
        actionLabel: 'Add files',
      };
    default:
      return {
        title: source?.name ? `${source.name} is empty` : 'Collection is empty',
        description: 'Add files to this collection to start viewing.',
        actionLabel: 'Add files',
      };
  }
};

function ViewerEmptyState({ source }) {
  const copy = useMemo(() => getEmptyCopy(source), [source]);
  const clearActiveSource = useStore((state) => state.clearActiveSource);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);

  const {
    openUploadPicker,
    uploadModal,
  } = useCollectionUploadFlow({
    source,
    allowAssets: true,
    allowImages: true,
  });

  const handleAddFiles = useCallback(() => {
    openUploadPicker();
  }, [openUploadPicker]);

  const handleGoHome = useCallback(() => {
    if (window.location.pathname !== '/') {
      window.location.replace('/');
      return;
    }

    clearActiveSource();
    setAssets([]);
    setCurrentAssetIndex(-1);
    resetSplatManager();
    setCurrentMesh(null);
    clearBackground();
    const pageEl = document.querySelector('.page');
    if (pageEl) {
      pageEl.classList.remove('has-glow');
    }
    requestRender();
  }, [clearActiveSource, setAssets, setCurrentAssetIndex]);

  return (
    <div class="viewer-empty-state">
     
      <div class="viewer-empty-card" style={{position: 'relative'}}>
         <button class="back-button viewer-empty-back" onClick={handleGoHome}>
        Back
      </button>
        <h3>{copy.title}</h3>
        <p>{copy.description}</p>
        <button class="viewer-empty-action" onClick={handleAddFiles}>
          {copy.actionLabel}
        </button>
      </div>
      {uploadModal}
    </div>
  );
}

export default ViewerEmptyState;
