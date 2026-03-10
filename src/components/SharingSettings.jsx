import { useCallback, useMemo, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store.js';
import { formatBytes } from '../previewManager.js';
import { getSource, isSourceAsset, loadAssetFile } from '../storage/index.js';
import { zipSync } from 'fflate';
import TransferDataModal from './TransferDataModal.jsx';
import ExportChoiceModal from './ExportChoiceModal.jsx';
import CreateEmbedUrlModal from './CreateEmbedUrlModal.jsx';

function SharingSettings() {
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const activeSourceId = useStore((state) => state.activeSourceId);
  const addLog = useStore((state) => state.addLog);
  const setUploadState = useStore((state) => state.setUploadState);

  const [expanded, setExpanded] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [embedModalOpen, setEmbedModalOpen] = useState(false);

  const currentAsset = assets[currentAssetIndex] || null;
  const currentAssetSize = currentAsset?.file?.size ?? currentAsset?.size ?? null;

  const collectionInfo = useMemo(() => {
    const source = activeSourceId ? getSource(activeSourceId) : null;
    const collectionName = source?.name || source?.config?.collectionName || 'Current collection';
    const totalAssets = assets.length;
    const sizeValues = assets.map((asset) => asset?.file?.size ?? asset?.size).filter((size) => Number.isFinite(size));
    const allSizesKnown = totalAssets > 0 && sizeValues.length === totalAssets;
    const totalSize = sizeValues.reduce((sum, size) => sum + size, 0);
    const sogCount = assets.filter((asset) => {
      const name = (asset?.name || asset?.path || '').toLowerCase();
      return name.endsWith('.sog');
    }).length;
    const estimatedBytes = sogCount > 0 ? sogCount * 11 * 1024 * 1024 : null;

    return {
      collectionName,
      totalAssets,
      allSizesKnown,
      totalSize,
      estimatedBytes,
      sogCount,
    };
  }, [activeSourceId, assets]);

  const sanitizeFileName = useCallback((name, fallback = 'untitled') => {
    if (!name) return fallback;
    return String(name)
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || fallback;
  }, []);

  const downloadBlob = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleExportCurrentAsset = useCallback(async () => {
    if (!currentAsset) throw new Error('No current asset available');
    const file = currentAsset.file
      ? currentAsset.file
      : (isSourceAsset(currentAsset) ? await loadAssetFile(currentAsset) : null);

    if (!file) throw new Error('Unable to load current asset file');
    downloadBlob(file, file.name || sanitizeFileName(currentAsset.name || 'asset'));
    addLog(`[Export] Downloaded ${file.name || currentAsset.name || 'asset'}`);
  }, [addLog, currentAsset, downloadBlob, sanitizeFileName]);

  const handleExportCollection = useCallback(async () => {
    if (!assets.length) throw new Error('No assets to export');

    const totalAssets = assets.length;
    const emitDownloadProgress = (current) => {
      const normalizedCurrent = Math.max(1, Math.min(totalAssets, Number(current) || 1));
      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'downloading',
          download: {
            current: normalizedCurrent,
            total: totalAssets,
          },
          total: totalAssets,
        },
      });
    };

    let exportSucceeded = false;
    const files = {};
    try {
      emitDownloadProgress(1);
      for (let i = 0; i < totalAssets; i += 1) {
        const asset = assets[i];
        emitDownloadProgress(i + 1);
        const assetFile = asset?.file
          ? asset.file
          : (isSourceAsset(asset) ? await loadAssetFile(asset) : null);

        if (!assetFile) {
          throw new Error(`Unable to load asset: ${asset?.name || `#${i + 1}`}`);
        }

        const safeName = sanitizeFileName(assetFile.name || asset?.name || `asset-${i + 1}`);
        const buffer = await assetFile.arrayBuffer();
        files[`assets/${safeName}`] = new Uint8Array(buffer);
      }

      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'packaging',
          message: 'Packaging ZIP',
          total: totalAssets,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const zipData = zipSync(files, { level: 6 });
      const blob = new Blob([zipData], { type: 'application/zip' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeCollectionName = sanitizeFileName(collectionInfo.collectionName, 'collection');
      const filename = `${safeCollectionName}-${stamp}.zip`;
      downloadBlob(blob, filename);
      addLog(`[Export] Downloaded collection ZIP (${totalAssets} assets)`);
      exportSucceeded = true;
    } catch (err) {
      setUploadState({
        isUploading: true,
        uploadProgress: {
          stage: 'error',
          error: {
            message: err?.message || 'Collection export failed',
            detail: err?.message || 'Collection export failed',
          },
        },
      });
      throw err;
    } finally {
      if (exportSucceeded) {
        setUploadState({ isUploading: false, uploadProgress: null });
      }
    }
  }, [addLog, assets, collectionInfo.collectionName, downloadBlob, sanitizeFileName, setUploadState]);

  return (
    <>
      <div class="settings-group">
        <button
          class="group-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="settings-eyebrow">Sharing</span>
          <FontAwesomeIcon icon={faChevronDown} className="chevron" />
        </button>

        <div class="group-content" style={{ display: expanded ? 'flex' : 'none' }}>
          <div class="control-row">
            <span class="control-label">Export scenes</span>
            <button
              type="button"
              class="secondary"
              onClick={() => setExportModalOpen(true)}
            >
              Export...
            </button>
          </div>

          <div class="control-row">
            <span class="control-label">Transfer bundle</span>
            <button
              type="button"
              class="secondary"
              onClick={() => setTransferModalOpen(true)}
            >
              Open...
            </button>
          </div>

          <div class="control-row">
            <span class="control-label">Generate embed-URL</span>
            <button
              type="button"
              class="secondary"
              onClick={() => setEmbedModalOpen(true)}
            >
              Open...
            </button>
          </div>
        </div>
      </div>

      <TransferDataModal
        isOpen={transferModalOpen}
        onClose={() => setTransferModalOpen(false)}
        addLog={addLog}
      />
      <CreateEmbedUrlModal
        isOpen={embedModalOpen}
        onClose={() => setEmbedModalOpen(false)}
        addLog={addLog}
      />
      <ExportChoiceModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onExportAsset={handleExportCurrentAsset}
        onExportCollection={handleExportCollection}
        assetTitle={currentAsset?.name || 'Current image'}
        assetSubtitle={`Size: ${formatBytes(currentAssetSize)}`}
        collectionTitle={collectionInfo.collectionName}
        collectionSubtitle={
          collectionInfo.allSizesKnown
            ? `${collectionInfo.totalAssets} assets · ${formatBytes(collectionInfo.totalSize)}`
            : `${collectionInfo.totalAssets} assets · ${collectionInfo.estimatedBytes ? `~${formatBytes(collectionInfo.estimatedBytes)} est.` : 'Size unknown'}`
        }
        assetDisabled={!currentAsset}
        collectionDisabled={collectionInfo.totalAssets === 0}
        note={
          collectionInfo.allSizesKnown
            ? ''
            : (collectionInfo.estimatedBytes
              ? `Estimate based on ${collectionInfo.sogCount} .sog file${collectionInfo.sogCount === 1 ? '' : 's'} × 11MB.`
              : '')
        }
      />
    </>
  );
}

export default SharingSettings;