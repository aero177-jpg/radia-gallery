import { useCallback } from 'preact/hooks';
import { useStore } from '../store.js';
import { loadEmbedAssetByIndex } from '../embed/embedLoader.js';

function EmbedAssetSidebar() {
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const isMobile = useStore((state) => state.isMobile);
  const assetSidebarOpen = useStore((state) => state.assetSidebarOpen);
  const slideshowPlaying = useStore((state) => state.slideshowPlaying);
  const viewerControlsDimmed = useStore((state) => state.viewerControlsDimmed);
  const setAssetSidebarOpen = useStore((state) => state.setAssetSidebarOpen);

  const handleSelect = useCallback(async (index) => {
    await loadEmbedAssetByIndex(index);
    if (isMobile) {
      setAssetSidebarOpen(false);
    }
  }, [isMobile, setAssetSidebarOpen]);

  if (assets.length <= 1) {
    return null;
  }

  const visible = assetSidebarOpen;

  return (
    <div class={`asset-sidebar embed-asset-sidebar ${visible ? 'visible' : ''}${slideshowPlaying || viewerControlsDimmed ? ' slideshow-hide' : ''}`}>
      <div class="asset-list-vertical">
        {assets.map((asset, index) => (
          <button
            key={asset.id || index}
            class={`asset-item-vertical ${index === currentAssetIndex ? 'active' : ''}`}
            title={asset.displayName || asset.name}
            onClick={() => void handleSelect(index)}
          >
            <div class={`asset-preview ${asset.preview ? '' : 'loading'}`}>
              {asset.preview ? (
                <img src={asset.preview} alt={asset.displayName || asset.name} loading="lazy" />
              ) : (
                <div class="preview-spinner" />
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default EmbedAssetSidebar;