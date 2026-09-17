import { setAdaptedAssets, setCurrentAssetIndex as setCurrentAssetIndexManager, onPreviewGenerated } from '../assetManager.js';
import { loadSplatFile } from '../fileLoader.js';
import { useStore } from '../store.js';

const adaptRemoteAsset = (remoteAsset, source) => ({
  id: remoteAsset.id,
  name: remoteAsset.name,
  path: remoteAsset.path,
  sourceId: remoteAsset.sourceId,
  sourceType: remoteAsset.sourceType,
  file: null,
  _remoteAsset: remoteAsset,
  preview: remoteAsset.preview || null,
  previewSource: remoteAsset.previewSource || null,
  loaded: false,
  isCached: false,
  size: remoteAsset.size || null,
  _transientSource: source,
  _embedFileSettings: remoteAsset.embedFileSettings || null,
  skipStoredPreviewHydration: true,
  skipStoredSettingsHydration: true,
});

export const loadEmbedSource = async (source, { autoload = false, preferredIndex = 0 } = {}) => {
  const store = useStore.getState();

  store.setIsLoading(true);
  store.setStatus(`Connecting to ${source.name || 'collection'}...`);
  store.setPanelOpen(false);
  store.setAssetSidebarOpen(false);

  try {
    const connectResult = await source.connect(false);
    if (!connectResult?.success) {
      throw new Error(connectResult?.error || 'Failed to connect to source.');
    }

    const remoteAssets = await source.listAssets();
    const adaptedAssets = remoteAssets.map((asset) => adaptRemoteAsset(asset, source));
    const result = setAdaptedAssets(adaptedAssets);

    store.setActiveSourceId(source.id);
    store.setAssets(result.assets);

    onPreviewGenerated((asset, index) => {
      store.updateAssetPreview(index, asset.preview);
    });

    if (!result.assets.length) {
      store.setCurrentAssetIndex(-1);
      store.setStatus(`No supported assets found in ${source.name || 'collection'}.`);
      return { assets: result.assets, preferredIndex: -1 };
    }

    const safeIndex = preferredIndex >= 0 && preferredIndex < result.assets.length ? preferredIndex : 0;
    setCurrentAssetIndexManager(safeIndex);
    store.setCurrentAssetIndex(safeIndex);
    store.setStatus(`Ready: ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}.`);

    if (autoload) {
      await loadSplatFile(result.assets[safeIndex]);
    }

    return { assets: result.assets, preferredIndex: safeIndex };
  } finally {
    store.setIsLoading(false);
  }
};

export const loadEmbedAssetByIndex = async (index) => {
  const store = useStore.getState();
  const asset = store.assets?.[index] || null;
  if (!asset) return;
  setCurrentAssetIndexManager(index);
  store.setCurrentAssetIndex(index);
  await loadSplatFile(asset);
};