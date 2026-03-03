/**
 * Storage Sources List Component
 *
 * Displays connected storage sources with status indicators.
 * Allows reconnecting, refreshing, and removing sources.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faFolder,
  faCloud,
  faTrash,
  faSync,
  faCheck,
  faExclamationTriangle,
  faSpinner,
  faUnlock,
  faUpload,
  faLink,
  faPen,
  faEllipsisVertical,
  faDatabase,
} from '@fortawesome/free-solid-svg-icons';
import { SupabaseIcon, CloudFlareIcon } from '../icons/customIcons';
import {
  deleteSource,
  touchSource,
  setDefaultSource,
  cacheCollectionAssets,
  syncCollectionCache,
  clearCollectionCache,
  loadCollectionManifest,
  getRemovedAssetNames,
} from '../storage/index.js';
import { resetSplatManager } from '../splatManager';
import { clearBackground } from '../backgroundManager';
import { requestRender, setCurrentMesh } from '../viewer';
import { useStore } from '../store';
import { getAssetList } from '../assetManager.js';
import { listCachedFileNames } from '../fileStorage.js';
import { useCollectionUploadFlow } from './useCollectionUploadFlow.js';
import Modal from './Modal';

const TYPE_ICONS = {
  'local-folder': faFolder,
  'app-storage': faDatabase,
  'supabase-storage': 'supabase',
  'r2-bucket': 'cloudflare',
  'public-url': faLink,
};

const TYPE_LABELS = {
  'local-folder': 'Local',
  'app-storage': 'App',
  'supabase-storage': 'Supabase',
  'r2-bucket': 'R2',
  'public-url': 'URL',
};

const formatEta = (seconds) => {
  const remaining = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
};

/**
 * Individual source item with controls
 */
function StorageSourceItem({
  source,
  onSelect,
  onRemove,
  onEditSource,
  expanded,
  onToggleExpand,
  isActive,
  onOpenCloudGpu,
  listOnly,
}) {
  const [status, setStatus] = useState('checking');
  const [assetCount, setAssetCount] = useState(source.getAssets().length);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [cachedCount, setCachedCount] = useState(0);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [removeCache, setRemoveCache] = useState(false);
  const [removeRemote, setRemoveRemote] = useState(false);
  const [removeSource, setRemoveSource] = useState(true);

  const activeSourceId = useStore((state) => state.activeSourceId);
  const clearActiveSource = useStore((state) => state.clearActiveSource);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const setUploadState = useStore((state) => state.setUploadState);

  const allowAssets = true;
  const allowImages = true;
  const cacheEnabled = source.type !== 'app-storage' && source.type !== 'local-folder';
  const actionButtonStyle = { minWidth: listOnly ? '100px' : '80px' };
  const r2Permissions = source.type === 'r2-bucket'
    ? (source?.config?.config?.permissions || { canRead: true, canWrite: true, canDelete: true })
    : null;
  const canUploadForSource = source.type === 'r2-bucket'
    ? r2Permissions?.canWrite
    : true;
  const canDeleteForSource = source.type === 'r2-bucket'
    ? r2Permissions?.canDelete
    : true;
  const showRefreshAction = true;
  const showEditAction = source.type === 'public-url';

  const refreshCacheFlagsForSource = useCallback(async () => {
    if (!cacheEnabled) {
      setCachedCount(0);
      return;
    }
    try {
      const cachedNames = await listCachedFileNames();
      const cachedSet = new Set(cachedNames);
      const assetList = getAssetList();
      const removedNames = await getRemovedAssetNames(source.id);
      const removedSet = new Set(removedNames);
      let changed = false;
      let cachedForSource = 0;
      let totalForSource = 0;

      assetList.forEach((asset) => {
        if (asset?.sourceId !== source.id) return;
        if (removedSet.has(asset?.name)) return;
        totalForSource += 1;
        const next = cachedSet.has(asset.name);
        if (asset.isCached !== next) {
          asset.isCached = next;
          changed = true;
        }
        if (next) {
          cachedForSource += 1;
        }
      });

      if (totalForSource === 0) {
        const manifest = await loadCollectionManifest(source.id);
        if (manifest?.assets?.length) {
          const visibleAssets = manifest.assets.filter((asset) => !removedSet.has(asset?.name));
          totalForSource = visibleAssets.length;
          cachedForSource = cachedSet.size === 0
            ? visibleAssets.length
            : visibleAssets.filter((asset) => cachedSet.has(asset?.name)).length;
          if (!source.isConnected()) {
            setAssetCount(totalForSource);
          }
        }
      }

      if (changed && activeSourceId === source.id) {
        setAssets([...assetList]);
      }
      setCachedCount(cachedForSource);
    } catch (err) {
      console.warn('[Storage] Failed to refresh cache flags', err);
    }
  }, [activeSourceId, setAssets, source.id, cacheEnabled]);

  const updateCachedCount = useCallback(async () => {
    if (!cacheEnabled) {
      setCachedCount(0);
      return;
    }
    try {
      const cachedNames = await listCachedFileNames();
      const cachedSet = new Set(cachedNames);
      const assetList = getAssetList();
      const removedNames = await getRemovedAssetNames(source.id);
      const removedSet = new Set(removedNames);
      let cachedForSource = 0;
      let totalForSource = 0;

      assetList.forEach((asset) => {
        if (asset?.sourceId !== source.id) return;
        if (removedSet.has(asset?.name)) return;
        totalForSource += 1;
        if (cachedSet.has(asset.name)) cachedForSource += 1;
      });

      if (totalForSource === 0) {
        const manifest = await loadCollectionManifest(source.id);
        if (manifest?.assets?.length) {
          const visibleAssets = manifest.assets.filter((asset) => !removedSet.has(asset?.name));
          totalForSource = visibleAssets.length;
          cachedForSource = cachedSet.size === 0
            ? visibleAssets.length
            : visibleAssets.filter((asset) => cachedSet.has(asset?.name)).length;
          if (!source.isConnected()) {
            setAssetCount(totalForSource);
          }
        }
      }

      setCachedCount(cachedForSource);
    } catch (err) {
      console.warn('[Storage] Failed to update cached count', err);
    }
  }, [source.id, cacheEnabled]);

  const refreshAssets = useCallback(async () => {
    setIsLoading(true);
    try {
      if ((source.type === 'supabase-storage' || source.type === 'r2-bucket') && typeof source.rescan === 'function') {
        const applied = await source.rescan({ applyChanges: true });
        if (!applied?.success) {
          setStatus('error');
          return false;
        }
      }

      const assets = await source.listAssets();
      const removedNames = await getRemovedAssetNames(source.id);
      const removedSet = new Set(removedNames);
      const visibleAssets = removedSet.size
        ? assets.filter((asset) => !removedSet.has(asset?.name))
        : assets;
      setAssetCount(visibleAssets.length);
      setStatus('connected');

      // Best-effort: sync local cache manifest with remote assets
      syncCollectionCache(source, visibleAssets)
        .then(() => refreshCacheFlagsForSource())
        .catch((err) => console.warn('[Storage] Cache sync failed', err));
      return true;
    } catch (err) {
      console.error('Refresh failed:', err);
      setStatus('error');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [refreshCacheFlagsForSource, source]);

  const {
    uploadInputRef: flowInputRef,
    uploadAccept,
    openUploadPicker,
    handleUploadChange: handleFlowUploadChange,
    uploadModal,
  } = useCollectionUploadFlow({
    source,
    allowAssets,
    allowImages,
    onOpenCloudGpu,
    onRefreshAssets: refreshAssets,
    onLoadingChange: setIsLoading,
    onUploadingChange: setIsUploading,
    onUploadProgress: setUploadProgress,
    onUploadState: setUploadState,
    onStatus: setStatus,
  });

  const handleCacheAll = useCallback(async (e) => {
    if (!cacheEnabled) return;
    e.stopPropagation();
    setIsLoading(true);
    try {
      if (!source.isConnected()) {
        const connectOptions = source.type === 'local-folder' ? false : { refreshManifest: true };
        const result = await source.connect(connectOptions);
        if (!result.success) {
          setStatus('error');
          return;
        }
      }

      const assets = await source.listAssets();
      setAssetCount(assets.length);
      await cacheCollectionAssets(source, assets);
      await refreshCacheFlagsForSource();
    } catch (err) {
      console.error('Cache all failed:', err);
      setStatus('error');
    } finally {
      setIsLoading(false);
    }
  }, [refreshCacheFlagsForSource, source, cacheEnabled]);

  // Check connection status on mount
  useEffect(() => {
    let cancelled = false;

    const checkStatus = async () => {
      // For local folders, NEVER try to auto-connect after browser restart.
      // Loading handles from IndexedDB can crash Chrome.
      // Just show "needs permission" and let user click to reconnect.
      if (source.type === 'local-folder') {
        // Only check if we have an in-memory handle from this session
        if (source.isConnected()) {
          if (!cancelled) {
            setStatus('connected');
            setAssetCount(source.getAssets().length);
          }
        } else {
          // Don't call connect() - that's safe now but still unnecessary.
          // Just show needs-permission and let user click to reconnect.
          if (!cancelled) {
            setStatus('needs-permission');
          }
        }
        return;
      }

      // For other source types (Supabase, URL), use normal flow
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

      // Helper to set status from cache
      const setStatusFromCache = async () => {
        const manifest = await loadCollectionManifest(source.id);
        if (manifest?.assets?.length) {
          const removedSet = new Set(manifest?.removed || []);
          const visibleAssets = manifest.assets.filter((asset) => !removedSet.has(asset?.name));
          if (!cancelled) {
            setStatus('disconnected');
            setAssetCount(visibleAssets.length);
            setCachedCount(visibleAssets.length);
          }
          return true;
        }
        return false;
      };

      try {
        if (source.isConnected()) {
          if (!cancelled) {
            setStatus('connected');
            setAssetCount(source.getAssets().length);
          }
          return;
        }

        // When offline, skip connect attempt and check for cached assets
        if (isOffline) {
          await setStatusFromCache();
          if (!cancelled && !await setStatusFromCache()) {
            setStatus('disconnected');
          }
          return;
        }

        const result = await source.connect(false);
        if (cancelled) return;

        if (result.success) {
          setStatus(result.offline ? 'disconnected' : 'connected');
          try {
            const assets = await source.listAssets();
            if (!cancelled) {
              setAssetCount(assets.length);
              if (result.offline) {
                setCachedCount(assets.length);
              }
            }
          } catch (e) {
            console.warn('Failed to list assets:', e);
          }
        } else if (result.needsPermission) {
          setStatus('needs-permission');
        } else {
          // Connection failed - try cache
          const hasCache = await setStatusFromCache();
          if (!hasCache && !cancelled) {
            setStatus('disconnected');
          }
        }
      } catch (err) {
        console.warn('Source status check failed:', err);
        // Network error - try cache
        const hasCache = await setStatusFromCache();
        if (!hasCache && !cancelled) {
          setStatus('disconnected');
        }
      }
    };

    // Small delay to let component mount properly
    const timeoutId = setTimeout(checkStatus, 50);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [source]);

  useEffect(() => {
    updateCachedCount();
  }, [updateCachedCount, assetCount]);



  const handleReconnect = useCallback(async (e) => {
    e.stopPropagation();
    setIsLoading(true);
    setStatus('connecting');

    try {
      // For local folders, reconnect should request permission since this is a user gesture
      if (source.type === 'local-folder' && typeof source.requestPermission === 'function') {
        const result = await source.requestPermission();
        if (result.success) {
          setStatus('connected');
          const assets = await source.listAssets();
          setAssetCount(assets.length);
          await touchSource(source.id);
        } else if (result.needsPermission) {
          setStatus('needs-permission');
        } else {
          setStatus('error');
          if (result?.error) {
            alert(result.error);
          }
        }
      } else {
        // For other source types, use regular connect
        const result = await source.connect(false);
        if (result.success) {
          setStatus('connected');
          const assets = await source.listAssets();
          setAssetCount(assets.length);
          await touchSource(source.id);
        } else if (result.needsPermission) {
          setStatus('needs-permission');
        } else {
          setStatus('error');
        }
      }
    } catch (err) {
      console.error('Reconnect failed:', err);
      setStatus('error');
    } finally {
      setIsLoading(false);
    }
  }, [source]);

  const handleRequestPermission = useCallback(async (e) => {
    e.stopPropagation();
    setIsLoading(true);

    try {
      if (source.type === 'local-folder') {
        if (!('showDirectoryPicker' in window)) {
          alert('Local folder access is not supported in this browser. Try Chrome or Edge.');
          setStatus('error');
          return;
        }

        if (typeof source.requestPermission === 'function') {
          const result = await source.requestPermission();
          if (result.success) {
            setStatus('connected');
            const assets = await source.listAssets();
            setAssetCount(assets.length);
            await touchSource(source.id);
          } else {
            setStatus('error');
            if (result?.error) {
              alert(result.error);
            }
          }
        }
      }
    } catch (err) {
      console.error('Permission request failed:', err);
      alert('Could not grant access. Please try again or re-add the folder.');
      setStatus('error');
    } finally {
      setIsLoading(false);
    }
  }, [source]);

  const handleRefresh = useCallback(async (e) => {
    e.stopPropagation();
    if (!source.isConnected()) return;

    const refreshed = await refreshAssets();
    if (refreshed) {
      onSelect?.(source);
    }
  }, [refreshAssets, source, onSelect]);

  const handleUploadClick = useCallback((e) => {
    e.stopPropagation();
    openUploadPicker();
  }, [openUploadPicker]);

  const handleUploadChange = useCallback(async (e) => {
    e.stopPropagation();
    await handleFlowUploadChange(e);
  }, [handleFlowUploadChange]);

  const handleAppStoragePick = useCallback((e) => {
    e.stopPropagation();
    if (source.type !== 'app-storage') return;
    openUploadPicker();
  }, [openUploadPicker, source.type]);

  const handleRemove = useCallback((e) => {
    e.stopPropagation();
    if (!canDeleteForSource) return;
    const canRemoveCache = cacheEnabled && cachedCount > 0;
    setRemoveCache(canRemoveCache);
    setRemoveRemote(false);
    setRemoveSource(true);
    setShowRemoveModal(true);
  }, [cachedCount, cacheEnabled, canDeleteForSource]);

  const handleConfirmRemove = useCallback(async () => {
    const shouldRemoveCache = removeCache && cachedCount > 0;
    const canRemoveRemote = source.type === 'supabase-storage' || source.type === 'r2-bucket' || source.type === 'app-storage';
    const shouldRemoveRemote = removeRemote && canRemoveRemote;
    const shouldRemoveSource = removeSource;

    setIsLoading(true);
    try {
      if (shouldRemoveRemote && typeof source.deleteAssets === 'function') {
        const assets = await source.listAssets();
        if (assets?.length) {
          const paths = assets
            .map((asset) => asset.path || asset?._remoteAsset?.path)
            .filter(Boolean);
          if (paths.length > 0) {
            const result = await source.deleteAssets(paths);
            if (!result?.success) {
              throw new Error(result?.error || 'Failed to delete collection assets');
            }
          }
        }
      }

      if (shouldRemoveCache) {
        await clearCollectionCache(source.id);
        await refreshCacheFlagsForSource();
      }

      if (shouldRemoveSource) {
        await deleteSource(source.id);
        onRemove?.(source.id);
        if (activeSourceId === source.id) {
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

          // Force a full app refresh at home route to avoid stale Three.js frame.
          window.location.replace('/');
          return;
        }
      }
    } catch (err) {
      console.error('Remove failed:', err);
      alert(err?.message || 'Failed to remove collection data');
      setStatus('error');
    } finally {
      setIsLoading(false);
      setShowRemoveModal(false);
    }
  }, [cachedCount, onRemove, refreshCacheFlagsForSource, removeCache, removeRemote, removeSource, source]);

  const handleCancelRemove = useCallback(() => {
    setShowRemoveModal(false);
  }, []);

  const handleClick = useCallback(() => {
    if (source.isConnected() || (cacheEnabled && cachedCount > 0)) {
      onSelect?.(source);
    }
  }, [cachedCount, source, onSelect, cacheEnabled]);

  const isConnected = status === 'connected';
  const needsPermission = status === 'needs-permission';
  const isDefault = Boolean(source?.config?.isDefault);
  const showUploadProgress = isUploading && uploadProgress;

  // ETA countdown state: set when progress updates, tick down every second while uploading
  const [etaSeconds, setEtaSeconds] = useState(0);
  useEffect(() => {
    if (!showUploadProgress || !uploadProgress) {
      setEtaSeconds(0);
      return;
    }

    const remaining = Math.max(0, (uploadProgress.total - (uploadProgress.completed || 0)) * 40);
    setEtaSeconds(remaining);

    const intervalId = setInterval(() => {
      setEtaSeconds((s) => {
        if (s <= 1) {
          clearInterval(intervalId);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(intervalId);
  }, [showUploadProgress, uploadProgress?.completed, uploadProgress?.total]);

  const etaLabel = showUploadProgress ? formatEta(etaSeconds) : '';

  const handleSetDefault = useCallback(async (e) => {
    e.stopPropagation();

    setIsLoading(true);
    try {
      // Toggle: if already default, clear it; otherwise set it
      await setDefaultSource(isDefault ? null : source.id);
    } catch (err) {
      console.warn('Failed to set default source:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isDefault, source?.id]);

  const handleEditSourceClick = useCallback((e) => {
    e.stopPropagation();
    if (!showEditAction) return;
    onEditSource?.(source);
  }, [onEditSource, source, showEditAction]);

  return (
    <>
      <input
        ref={flowInputRef}
        type="file"
        multiple
        {...(uploadAccept ? { accept: uploadAccept } : {})}
        style={{ display: 'none' }}
        onChange={handleUploadChange}
      />
      <div
        class={`source-item ${isConnected ? 'connected' : ''} ${status} ${isActive ? 'active' : ''} ${listOnly ? 'list-only' : ''}`}
        onClick={handleClick}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: '32px' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0, paddingLeft: '4px', paddingRight: '0px' }}>
            <div class="source-info" style={{ flex: 1 }}>
              <div class="source-name">
                <span class="source-name-text">{source.name}</span>
              </div>
              <div class="source-meta">
                {TYPE_ICONS[source.type] === 'supabase' ? (
                  <SupabaseIcon size={10} className="source-type-icon" />
                ) : TYPE_ICONS[source.type] === 'cloudflare' ? (
                  <CloudFlareIcon size={12} className="source-type-icon" />
                ) : (
                  <FontAwesomeIcon icon={TYPE_ICONS[source.type] || faFolder} className="source-type-icon" />
                )}
                <span class="source-type">{TYPE_LABELS[source.type]}</span>
                {(isConnected || (cacheEnabled && cachedCount > 0)) && assetCount > 0 && (
                  <span
                    class="source-count"
                    style={assetCount > 0 ? { color: '#48bb78' } : undefined}
                  >
                    {assetCount}
                  </span>
                )}
              </div>
            </div>

            <div class="source-status">
              {isLoading ? (
                <div class="status-loading">
                  {showUploadProgress && (
                    <span class="upload-progress">
                      {uploadProgress?.completed}/{uploadProgress?.total}  {etaLabel}
                    </span>
                  )}
                  <FontAwesomeIcon icon={faSpinner} spin />
                </div>
              ) : isConnected || status === 'checking' || status === 'connecting' ? (
                <></>
              ) : needsPermission ? (
                <FontAwesomeIcon icon={faUnlock} className="status-warning" />
              ) : cacheEnabled && cachedCount > 0 ? (
                <FontAwesomeIcon icon={faDatabase} className="status-warning" />
              ) : (
                <FontAwesomeIcon icon={faExclamationTriangle} className="status-error" />
              )}
            </div>
          </div>

          <div class="expand-wrapper" style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: '2px', flexShrink: 0 }}>
            <div
              class="expand-hit-area"
              style={{ width: "40px", height: "40px", position: 'absolute', top: '50%', right: '-4px', transform: 'translateY(-50%)', background: 'transparent', zIndex: 1, cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
            />
            <button
              class="source-expand"
              onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
              style={{ position: 'relative', zIndex: 2 }}
            >
              <FontAwesomeIcon icon={faEllipsisVertical} />
            </button>
          </div>
        </div>

        {expanded && (
          <div class="source-actions" onClick={(e) => e.stopPropagation()}>
            {needsPermission ? (
              <button
                class="source-action-btn"
                onClick={handleRequestPermission}
                title="Grant permission"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faUnlock} />
                <span>Grant Access</span>
              </button>
            ) : !isConnected ? (
              <button
                class="source-action-btn"
                onClick={handleReconnect}
                title="Reconnect"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faSync} />
                <span>Reconnect</span>
              </button>
            ) : showRefreshAction ? (
              <button
                class="source-action-btn"
                onClick={handleRefresh}
                title="Refresh assets"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faSync} />
                <span>Refresh</span>
              </button>
            ) : null}
            <button
              class={`source-action-btn ${isDefault ? 'default' : ''}`}
              onClick={handleSetDefault}
              title={isDefault ? 'Clear default collection' : 'Set as default collection'}
              style={actionButtonStyle}
            >
              {isDefault && <FontAwesomeIcon icon={faCheck} />}
              <span>{isDefault ? 'Default' : 'Set Default'}</span>
            </button>
            {showEditAction && (
              <button
                class="source-action-btn"
                onClick={handleEditSourceClick}
                title="Edit URLs"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faPen} />
                <span>Edit</span>
              </button>
            )}
            {source.type === 'app-storage' && (
              <button
                class="source-action-btn"
                onClick={handleAppStoragePick}
                title="Add files to app storage"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faUpload} />
                <span>Add files</span>
              </button>
            )}
            {source.type !== 'public-url' && source.type !== 'app-storage' && canUploadForSource && (
              <button
                class="source-action-btn"
                onClick={handleUploadClick}
                title={source.type === 'supabase-storage' ? 'Upload files to Supabase' : source.type === 'r2-bucket' ? 'Upload files to R2' : 'Convert images with Cloud GPU'}
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faUpload} />
                <span>Upload</span>
              </button>
            )}
            {cacheEnabled && (
              <button
                class="source-action-btn"
                onClick={handleCacheAll}
                title="Cache all assets locally"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faDatabase} />
                <span>Cache</span>
                {cachedCount > 0 && (
                  <span style={{ marginLeft: 'auto', opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
                    {cachedCount}/{assetCount}
                  </span>
                )}
              </button>
            )}
            {canDeleteForSource && (
              <button
                class="source-action-btn danger"
                onClick={handleRemove}
                title="Remove collection"
                style={actionButtonStyle}
              >
                <FontAwesomeIcon icon={faTrash} />
                <span>Remove...</span>
              </button>
            )}
          </div>
        )}
      </div>

      <Modal
        isOpen={showRemoveModal}
        onClose={handleCancelRemove}
      >
        <h3>Remove Collection</h3>
        {(() => {
          const isLocalCollection = source.type === 'local-folder';
          const isAppStorage = source.type === 'app-storage';
          const isUrlCollection = source.type === 'public-url';
          const isSupabase = source.type === 'supabase-storage';
          const isR2 = source.type === 'r2-bucket';

          if (isLocalCollection) {
            return (
              <p class="modal-note">
                Removing here only disconnects the folder; files remain on your device.
              </p>
            );
          }

          if (isAppStorage && removeRemote) {
            return (
              <p class="modal-note">
                Selected items will be deleted from app storage and removed from the collection list.
              </p>
            );
          }

          if (isAppStorage) {
            return (
              <p class="modal-note">
                Removing here only disconnects the collection; files remain in app storage unless selected below.
              </p>
            );
          }

          if (isUrlCollection) {
            return (
              <p class="modal-note">
                This only removes the list; original URLs remain online.
              </p>
            );
          }

          if (isSupabase && removeRemote) {
            return (
              <p class="modal-note">
                Selected items will be deleted from the Supabase collection and removed from the list.
              </p>
            );
          }

          if (isR2 && removeRemote) {
            return (
              <p class="modal-note">
                Selected items will be deleted from the R2 collection and removed from the list.
              </p>
            );
          }

          if (isSupabase || isR2) {
            return (
              <p class="modal-note">
                Removing here only disconnects the collection; files remain in storage unless selected below.
              </p>
            );
          }

          return (
            <p class="modal-note">
              Removing here only disconnects the collection; the source is unchanged.
            </p>
          );
        })()}

        <div class="modal-checkbox">
          <label>
            <input
              type="checkbox"
              checked={removeSource}
              onChange={(e) => setRemoveSource(e.target.checked)}
            />
            Remove from collection list
          </label>
          <div class="modal-subnote">
            Disconnects this collection from the viewer.
          </div>
        </div>

        {cacheEnabled && cachedCount > 0 && (
          <div class="modal-checkbox">
            <label>
              <input
                type="checkbox"
                checked={removeCache}
                onChange={(e) => setRemoveCache(e.target.checked)}
              />
              Remove cached files
            </label>
            <div class="modal-subnote">
              Clears cached files stored on this device for this collection.
            </div>
          </div>
        )}

        {(source.type === 'supabase-storage' || (source.type === 'r2-bucket' && canDeleteForSource) || source.type === 'app-storage') && (
          <div class="modal-checkbox">
            <label>
              <input
                type="checkbox"
                checked={removeRemote}
                onChange={(e) => setRemoveRemote(e.target.checked)}
              />
              {source.type === 'supabase-storage'
                ? 'Delete from Supabase storage'
                : source.type === 'r2-bucket'
                  ? 'Delete from R2 storage'
                  : 'Delete from app storage'}
            </label>
            <div class="modal-subnote">
              {source.type === 'supabase-storage'
                ? 'Removes files and manifest entries from the linked Supabase collection.'
                : source.type === 'r2-bucket'
                  ? 'Removes files and manifest entries from the linked R2 collection.'
                  : 'Removes files stored inside the app for this collection.'}
            </div>
          </div>
        )}

        <div class="modal-actions">
          <button onClick={handleCancelRemove}>Cancel</button>
          <button
            class="danger"
            onClick={handleConfirmRemove}
            disabled={!removeCache && !removeRemote && !removeSource}
          >
            Remove
          </button>
        </div>
      </Modal>

      {uploadModal}
    </>
  );
}

export default StorageSourceItem;
