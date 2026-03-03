/**
 * Collection upload flow hook
 *
 * Provides a unified file picker + modal flow for assets and image conversion,
 * and routes actions based on the active collection type.
 */

import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getFormatAccept, getSupportedExtensions } from '../formats/index.js';
import { isAndroidUserAgent, testSharpCloud } from '../testSharpCloud.js';
import { handleAddFiles, handleMultipleFiles, loadFromStorageSource } from '../fileLoader.js';
import { useStore } from '../store.js';
import { getSource } from '../storage/index.js';
import { loadCloudGpuSettings } from '../storage/cloudGpuSettings.js';
import UploadChoiceModal from './UploadChoiceModal.jsx';

// Constants moved outside hook to avoid recreating each render
export const DEFAULT_IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.heic',
];

export const SUPPORTED_EXTENSIONS = getSupportedExtensions();
const FORMAT_ACCEPT = getFormatAccept();
const IMAGE_ACCEPT = `${DEFAULT_IMAGE_EXTENSIONS.join(',')},image/*`;
const IS_ANDROID = isAndroidUserAgent();
const AUTO_RELOAD_DELAY_MS = 500;
const SUPABASE_RESCAN_INTERVAL_MS = 500;
const SUPABASE_RESCAN_ATTEMPTS = 6;
const R2_RESCAN_INTERVAL_MS = 500;
const R2_RESCAN_ATTEMPTS = 6;

const generateJobId = () => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const rand = Math.random().toString(16).slice(2);
  return `job-${Date.now()}-${rand}`;
};

const generateUploadSessionId = () => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj?.randomUUID) return `cloud-gpu-${cryptoObj.randomUUID()}`;
  const rand = Math.random().toString(16).slice(2);
  return `cloud-gpu-${Date.now()}-${rand}`;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getLocalFileKey = (file) => {
  if (!file) return '';
  const name = String(file.name || '');
  const size = Number(file.size) || 0;
  const modified = Number(file.lastModified) || 0;
  return `${name}|${size}|${modified}`;
};

const waitForRemoteRescan = async (source, { expectedMin = 1 } = {}) => {
  if (!source || !['supabase-storage', 'r2-bucket'].includes(source?.type) || typeof source?.rescan !== 'function') {
    return false;
  }

  const attempts = source?.type === 'r2-bucket' ? R2_RESCAN_ATTEMPTS : SUPABASE_RESCAN_ATTEMPTS;
  const interval = source?.type === 'r2-bucket' ? R2_RESCAN_INTERVAL_MS : SUPABASE_RESCAN_INTERVAL_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await source.rescan({ applyChanges: true });
      const addedCount = result?.added?.length || 0;
      if (addedCount >= expectedMin || addedCount > 0) {
        return true;
      }
    } catch (err) {
      console.warn('[UploadFlow] Remote rescan failed', err);
    }
    await delay(interval);
  }

  return false;
};

// Helper functions moved outside hook - no dependencies on hook state
export const isSupportedFile = (file) => {
  if (!file?.name) return false;
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return SUPPORTED_EXTENSIONS.includes(ext);
};

export const isImageFile = (file) => {
  if (!file) return false;
  const type = file.type || '';
  const name = (file.name || '').toLowerCase();
  return type.startsWith('image/') || DEFAULT_IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
};

const getCollectionUploadCopy = (source) => {
  const collectionName = source?.name || 'this collection';
  const type = source?.type || 'none';

  if (type === 'supabase-storage') {
    return {
      title: 'Upload to Supabase',
      subtitle: `Choose what you want to upload to "${collectionName}".`,
      assetTitle: '3dgs scene upload',
      assetSubtitle: 'Uploads supported 3DGS scenes to Supabase storage.',
      imageTitle: 'Images to convert',
      imageSubtitle: 'Sends images to cloud GPU and uploads the results to Supabase.',
      note: '',
    };
  }

  if (type === 'r2-bucket') {
    return {
      title: 'Upload to R2',
      subtitle: `Choose what you want to upload to "${collectionName}".`,
      assetTitle: '3dgs scene upload',
      assetSubtitle: 'Uploads supported 3DGS scenes to R2 storage.',
      imageTitle: 'Images to convert',
      imageSubtitle: 'Sends images to cloud GPU and uploads the results to R2.',
      note: '',
    };
  }

  if (type === 'app-storage') {
    return {
      title: 'Add to app storage',
      subtitle: `Choose what you want to add to "${collectionName}".`,
      assetTitle: '3dgs scene import',
      assetSubtitle: 'Saves supported 3DGS scenes into app storage.',
      imageTitle: 'Images to convert',
      imageSubtitle: 'Sends images to cloud GPU and saves results into app storage.',
      note: '',
    };
  }

  if (type === 'local-folder') {
    return {
      title: 'Add files',
      subtitle: 'Local folders are read-only. Converted images will download.',
      assetTitle: '3dgs scenes',
      assetSubtitle: 'Adds supported 3DGS scenes to the temporary queue.',
      imageTitle: 'Images to convert',
      imageSubtitle: 'Sends images to cloud GPU and downloads the results.',
      note: 'Files added here are temporary unless saved to a storage collection.',
    };
  }

  return {
    title: 'Add files',
    subtitle: 'Choose what to add to the local queue.',
    assetTitle: '3dgs scenes',
    assetSubtitle: 'Adds supported 3DGS scenes to the temporary queue.',
    imageTitle: 'Images to convert',
    imageSubtitle: 'Sends images to cloud GPU and adds converted assets to the queue.',
    note: 'Files added here are temporary unless saved to a storage collection.',
  };
};

const getCollectionPrefix = (source) => {
  if (!source) return undefined;
  const collectionId = source?.config?.collectionId || source?.config?.config?.collectionId;
  return collectionId ? `collections/${collectionId}/assets` : 'collections/default/assets';
};

const sourceCanWrite = (source) => {
  if (!source) return true;
  if (source.type !== 'r2-bucket') return true;
  const permissions = source?.config?.config?.permissions || {};
  return permissions.canWrite === true;
};

export function useCollectionUploadFlow({
  source,
  queueAction = 'replace',
  selectFirstAdded = false,
  allowAssets = true,
  allowImages = true,
  prepareOnly = false,
  onPreparedFiles,
  onOpenCloudGpu,
  onRefreshAssets,
  onAssetsUpdated,
  onLoadingChange,
  onUploadingChange,
  onUploadProgress,
  onUploadState,
  onStatus,
  onError,
}) {
  // Simple error reporter - inlined default behavior
  const reportError = (message) => {
    onError?.(message) ?? (message && alert(message));
  };

  const activeSourceId = useStore((state) => state.activeSourceId);
  const activeAssetsLength = useStore((state) => state.assets.length);
  const setUploadState = useStore((state) => state.setUploadState);
  const resolvedSource = useMemo(
    () => source || (activeSourceId ? getSource(activeSourceId) : null),
    [source, activeSourceId]
  );

  const [showUploadChoiceModal, setShowUploadChoiceModal] = useState(false);
  const [uploadAccept, setUploadAccept] = useState(undefined);
  const uploadModeRef = useRef(null);
  const uploadInputRef = useRef(null);
  const autoReloadTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (autoReloadTimeoutRef.current) {
        clearTimeout(autoReloadTimeoutRef.current);
        autoReloadTimeoutRef.current = null;
      }
    };
  }, []);

  const scheduleAutoReload = useCallback((sourceToReload, preferredIndex = null) => {
    if (!sourceToReload?.id) return;
    if (!activeSourceId || activeSourceId !== sourceToReload.id) return;

    if (autoReloadTimeoutRef.current) {
      clearTimeout(autoReloadTimeoutRef.current);
    }

    autoReloadTimeoutRef.current = setTimeout(async () => {
      autoReloadTimeoutRef.current = null;
      try {
        await loadFromStorageSource(sourceToReload, { preferredIndex });
      } catch (err) {
        console.warn('[UploadFlow] Auto reload failed', err);
      }
    }, AUTO_RELOAD_DELAY_MS);
  }, [activeSourceId]);

  const getPreferredIndex = useCallback((addedCount) => {
    if (!addedCount || addedCount <= 0) return null;
    const baseIndex = Number.isFinite(activeAssetsLength) ? activeAssetsLength : 0;
    return Math.max(0, baseIndex);
  }, [activeAssetsLength]);

  // Helper to compute accept string based on mode
  const computeAcceptForMode = (mode) => {
    // Keep asset selection unfiltered so platform pickers (especially Android)
    // can show generic file providers and specialized formats like .sog.
    if (mode === 'assets') return undefined;
    if (mode === 'images') return IMAGE_ACCEPT;
    // Default: combine both if allowed
    if (allowAssets && allowImages) return FORMAT_ACCEPT ? `${FORMAT_ACCEPT},${IMAGE_ACCEPT}` : IMAGE_ACCEPT;
    if (allowImages) return IMAGE_ACCEPT;
    return FORMAT_ACCEPT || undefined;
  };


  const handleQueueAssets = useCallback(async (files) => {
    if (queueAction === 'append') {
      await handleAddFiles(files, { selectFirstAdded });
    } else {
      await handleMultipleFiles(files);
    }
  }, [queueAction, selectFirstAdded]);

  const handleAssets = useCallback(async (files) => {
    const valid = files.filter(isSupportedFile);
    if (valid.length === 0) {
      onStatus?.('error');
      reportError(`No supported files. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      return;
    }

    if (prepareOnly) {
      onPreparedFiles?.(valid, 'assets');
      return;
    }

    const type = resolvedSource?.type;

    if (type === 'r2-bucket' && !sourceCanWrite(resolvedSource)) {
      onStatus?.('error');
      reportError('Upload is disabled for this R2 source (write permission is off).');
      return;
    }

    onLoadingChange?.(true);
    try {
      if ((type === 'supabase-storage' || type === 'r2-bucket') && typeof resolvedSource?.uploadAssets === 'function') {
        const result = await resolvedSource.uploadAssets(valid);
        if (!result?.success) {
          onStatus?.('error');
          reportError(result?.error || 'Upload failed');
          return;
        }
        await onRefreshAssets?.();
        await onAssetsUpdated?.({ mode: 'assets', source: resolvedSource, files: valid });
        const addedCount = result?.uploaded?.length ?? valid.length;
        scheduleAutoReload(resolvedSource, getPreferredIndex(addedCount));
        return;
      }

      if ((type === 'app-storage' || type === 'local-folder') && typeof resolvedSource?.importFiles === 'function') {
        const result = await resolvedSource.importFiles(valid);
        if (!result?.success) {
          onStatus?.('error');
          reportError(result?.error || 'Import failed');
          return;
        }
        await onRefreshAssets?.();
        await onAssetsUpdated?.({ mode: 'assets', source: resolvedSource, files: valid });
        const addedCount = result?.imported ?? valid.length;
        scheduleAutoReload(resolvedSource, getPreferredIndex(addedCount));
        return;
      }

      await handleQueueAssets(valid);
    } catch (err) {
      onStatus?.('error');
      reportError(err?.message || String(err));
    } finally {
      onLoadingChange?.(false);
    }
  }, [handleQueueAssets, onAssetsUpdated, onLoadingChange, onPreparedFiles, onRefreshAssets, onStatus, prepareOnly, resolvedSource, scheduleAutoReload, getPreferredIndex]);

  const handleImages = useCallback(async (files) => {
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) {
      onStatus?.('error');
      reportError('No image files selected.');
      return;
    }

    const type = resolvedSource?.type;
    const cloudGpuSettings = loadCloudGpuSettings();
    const cloudGpuShowDetailedStatus = cloudGpuSettings?.showDetailedStatus !== false;

    if (type === 'r2-bucket' && !sourceCanWrite(resolvedSource)) {
      onStatus?.('error');
      reportError('Upload is disabled for this R2 source (write permission is off).');
      return;
    }
    const prefix = type === 'supabase-storage' || type === 'r2-bucket' ? getCollectionPrefix(resolvedSource) : undefined;
    const returnMode = type === 'supabase-storage' || type === 'r2-bucket' ? undefined : 'direct';
    const downloadMode = type === 'app-storage' || (!resolvedSource && !prepareOnly) || prepareOnly ? 'store' : undefined;
    const imageBatches = [imageFiles];
    const totalBatches = imageBatches.length;

    // Build accessString + storageTarget for the backend
    let cloudStorageTarget;
    let cloudAccessString;
    if (type === 'r2-bucket') {
      const cfg = resolvedSource?.config?.config;
      cloudStorageTarget = 'r2';
      cloudAccessString = JSON.stringify({
        s3Endpoint: cfg?.endpoint,
        s3AccessKeyId: cfg?.accessKeyId,
        s3SecretAccessKey: cfg?.secretAccessKey,
        s3Bucket: cfg?.bucket,
      });
    } else if (type === 'supabase-storage') {
      const cfg = resolvedSource?.config?.config;
      cloudStorageTarget = 'supabase';
      cloudAccessString = JSON.stringify({
        supabaseUrl: cfg?.supabaseUrl,
        supabaseKey: cfg?.anonKey,
        ...(cfg?.bucket ? { supabaseBucket: cfg.bucket } : {}),
      });
    }

    onLoadingChange?.(true);
    onUploadingChange?.(true);
    const uploadSessionId = generateUploadSessionId();
    const reportUploadState = (state) => {
      onUploadState?.(state);
      setUploadState?.(state);
    };

    const allResults = [];
    const allStoredFiles = [];
    let totalSuccessCount = 0;
    let totalFailedCount = 0;
    let uploadError = null;
    let incrementalRefreshInFlight = false;
    let lastIncrementalRefreshAtMs = 0;
    let cancelledByUser = false;
    const initialProgress = {
      uploadKind: 'cloud-gpu',
      uploadSessionId,
      stage: 'upload',
      upload: { loaded: 0, total: 0, done: false },
      completed: 0,
      total: imageFiles.length,
      showDetailedStatus: cloudGpuShowDetailedStatus,
      batch: {
        index: totalBatches > 0 ? 1 : 0,
        total: totalBatches,
        size: imageBatches[0]?.length || 0,
        start: 1,
        end: imageBatches[0]?.length || 0,
      },
    };
    onUploadProgress?.(initialProgress);
    reportUploadState({ isUploading: true, uploadProgress: initialProgress });

    try {
      for (let batchIndex = 0; batchIndex < imageBatches.length; batchIndex += 1) {
        const batchFiles = imageBatches[batchIndex];
        const batchNumber = batchIndex + 1;
        const batchStart = 1;
        const batchEnd = batchFiles.length;
        const completedBeforeBatch = 0;
        const streamedFileKeys = new Set();
        let streamAppendQueue = Promise.resolve();
        let streamedFirstShown = false;

        const mapProgress = (progress) => {
          const rawCompleted = Number(progress?.completed);
          const localCompleted = Number.isFinite(rawCompleted)
            ? Math.max(0, Math.min(batchFiles.length, rawCompleted))
            : 0;
          const merged = {
            ...(progress || {}),
            uploadKind: 'cloud-gpu',
            uploadSessionId,
            completed: Math.max(0, Math.min(imageFiles.length, completedBeforeBatch + localCompleted)),
            total: imageFiles.length,
            showDetailedStatus: cloudGpuShowDetailedStatus,
            batch: {
              index: batchNumber,
              total: totalBatches,
              size: batchFiles.length,
              start: batchStart,
              end: batchEnd,
            },
          };
          return merged;
        };

        const batchResults = await testSharpCloud(batchFiles, {
          prefix,
          returnMode,
          downloadMode,
          storageTarget: cloudStorageTarget,
          accessString: cloudAccessString,
          getJobId: () => generateJobId(),
          pollIntervalMs: 5000,
          onProgress: (progress) => {
            if (progress?.stage === 'error' && progress?.error) {
              uploadError = progress.error;
            }

            if (!resolvedSource && Array.isArray(progress?.newStoredFiles) && progress.newStoredFiles.length > 0) {
              const incoming = progress.newStoredFiles.filter(Boolean);
              const uniqueIncoming = incoming.filter((file) => {
                const key = getLocalFileKey(file);
                if (!key || streamedFileKeys.has(key)) return false;
                streamedFileKeys.add(key);
                return true;
              });

              if (uniqueIncoming.length > 0) {
                streamAppendQueue = streamAppendQueue
                  .then(async () => {
                    if (!streamedFirstShown && batchIndex === 0 && queueAction !== 'append') {
                      const [first, ...rest] = uniqueIncoming;
                      if (first) {
                        await handleMultipleFiles([first]);
                        streamedFirstShown = true;
                      }
                      if (rest.length > 0) {
                        await handleAddFiles(rest, { selectFirstAdded: false });
                      }
                      return;
                    }

                    await handleAddFiles(uniqueIncoming, { selectFirstAdded: false });
                    streamedFirstShown = true;
                  })
                  .catch((err) => {
                    console.warn('[UploadFlow] Incremental local append failed', err);
                  });
              }
            }

            const hasIncrementalFiles = (type === 'supabase-storage' || type === 'r2-bucket')
              && Array.isArray(progress?.newFiles)
              && progress.newFiles.length > 0;
            if (hasIncrementalFiles && !incrementalRefreshInFlight) {
              const now = Date.now();
              const minRefreshGapMs = 1500;
              if (now - lastIncrementalRefreshAtMs >= minRefreshGapMs) {
                incrementalRefreshInFlight = true;
                lastIncrementalRefreshAtMs = now;
                Promise.resolve(onRefreshAssets?.())
                  .catch((err) => {
                    console.warn('[UploadFlow] Incremental remote refresh failed', err);
                  })
                  .finally(() => {
                    incrementalRefreshInFlight = false;
                  });
              }
            }

            const mergedProgress = mapProgress(progress);
            onUploadProgress?.(mergedProgress);
            // Skip overlay update for download-notification events — they carry
            // only sparse file-delivery data and would clobber the richer
            // get-progress polling state currently displayed in the overlay.
            if (progress?.source !== 'download-notification') {
              reportUploadState({ isUploading: true, uploadProgress: mergedProgress });
            }
          },
        });

        const batchCancelled = batchResults.some((result) => Boolean(result?.data?.cancelled));
        if (batchCancelled) {
          cancelledByUser = true;
          break;
        }

        allResults.push(...batchResults);
        await streamAppendQueue;
        const batchStoredFiles = batchResults
          .flatMap((result) => result?.data?.files || [])
          .filter((file) => {
            const key = getLocalFileKey(file);
            return key ? !streamedFileKeys.has(key) : true;
          });
        allStoredFiles.push(...batchStoredFiles);

        const batchSuccessCount = batchResults.reduce((sum, result) => {
          if (!result?.ok) return sum;
          const explicitSuccess = Number(result?.data?.successCount);
          if (Number.isFinite(explicitSuccess) && explicitSuccess >= 0) {
            return sum + explicitSuccess;
          }
          return sum + batchFiles.length;
        }, 0);
        const batchFailedCount = batchResults.reduce((sum, result) => {
          const explicitFailed = Number(result?.data?.failedCount);
          if (Number.isFinite(explicitFailed) && explicitFailed >= 0) {
            return sum + explicitFailed;
          }
          return sum;
        }, 0);
        totalSuccessCount += batchSuccessCount;
        totalFailedCount += batchFailedCount;

        if (prepareOnly) {
          continue;
        }

        if (type === 'app-storage' && batchStoredFiles.length > 0 && typeof resolvedSource?.importFiles === 'function') {
          const importResult = await resolvedSource.importFiles(batchStoredFiles);
          if (!importResult?.success) {
            onStatus?.('error');
            reportError(importResult?.error || 'Failed to import converted files');
          } else {
            await onRefreshAssets?.();
          }
          await onAssetsUpdated?.({ mode: 'images', source: resolvedSource, files: batchStoredFiles });
          const addedCount = importResult?.imported ?? batchStoredFiles.length;
          scheduleAutoReload(resolvedSource, getPreferredIndex(addedCount));
          continue;
        }

        if ((type === 'supabase-storage' || type === 'r2-bucket') && batchSuccessCount > 0) {
          await onRefreshAssets?.();
          await onAssetsUpdated?.({ mode: 'images', source: resolvedSource, files: batchFiles });
          const addedCount = batchSuccessCount || batchFiles.length;
          const didRescan = await waitForRemoteRescan(resolvedSource, { expectedMin: addedCount });
          if (!didRescan) {
            console.warn('[UploadFlow] Remote rescan timed out; falling back to delayed refresh');
          }
          scheduleAutoReload(resolvedSource, getPreferredIndex(addedCount));
          continue;
        }

        if (!resolvedSource && batchStoredFiles.length > 0) {
          const shouldAppendBatch = queueAction === 'append' || batchIndex > 0;
          if (shouldAppendBatch) {
            await handleAddFiles(batchStoredFiles, { selectFirstAdded: Boolean(selectFirstAdded && batchIndex === 0) });
          } else {
            await handleMultipleFiles(batchStoredFiles);
          }
        }
      }

      if (cancelledByUser) {
        return;
      }

      const anySuccess = totalSuccessCount > 0;
      const silentOnly = allResults.length > 0 && allResults.every((result) => result?.ok || result?.silentFailure);

      if (prepareOnly) {
        if (allStoredFiles.length > 0) {
          onPreparedFiles?.(allStoredFiles, 'images');
        } else if (!anySuccess) {
          onStatus?.('error');
          reportError('Image conversion failed.');
        }
        return;
      }

      if (anySuccess) {
        uploadError = null;
        if (totalFailedCount > 0) {
          onUploadProgress?.({
            uploadKind: 'cloud-gpu',
            uploadSessionId,
            stage: 'done',
            status: 'done',
            done: true,
            successCount: totalSuccessCount,
            failedCount: totalFailedCount,
            message: `${totalSuccessCount} succeeded, ${totalFailedCount} failed`,
          });
        }
      } else {
        onStatus?.('error');
        if (!silentOnly) {
          reportError('Image conversion failed.');
        }
      }
    } catch (err) {
      onStatus?.('error');
      reportError(err?.message || String(err));
      uploadError = uploadError || { message: 'Processing failed', detail: err?.message || String(err) };
    } finally {
      onLoadingChange?.(false);
      onUploadingChange?.(false);
      if (uploadError) {
        onUploadProgress?.({
          uploadKind: 'cloud-gpu',
          uploadSessionId,
          stage: 'error',
          error: uploadError,
        });
        reportUploadState({
          isUploading: true,
          uploadProgress: {
            uploadKind: 'cloud-gpu',
            uploadSessionId,
            stage: 'error',
            error: uploadError,
          },
        });
      } else {
        onUploadProgress?.(null);
        reportUploadState({ isUploading: false, uploadProgress: null });
      }
    }
  }, [handleQueueAssets, onAssetsUpdated, onLoadingChange, onPreparedFiles, onRefreshAssets, onStatus, onUploadProgress, onUploadState, onUploadingChange, prepareOnly, queueAction, resolvedSource, scheduleAutoReload, getPreferredIndex, selectFirstAdded, setUploadState]);

  const handleFilesForMode = useCallback(async (mode, files) => {
    if (!files?.length) return;

    if (mode === 'images') {
      if (!allowImages) return;
      await handleImages(files);
      return;
    }

    if (!allowAssets) return;
    await handleAssets(files);
  }, [allowAssets, allowImages, handleAssets, handleImages]);

  const openPickerForMode = useCallback(async (mode) => {
    uploadModeRef.current = mode;

    // Compute and set accept value based on mode - this triggers re-render
    const accept = computeAcceptForMode(mode);
    setUploadAccept(accept);

    const syncInputAccept = () => {
      const input = uploadInputRef.current;
      if (!input) return;
      if (accept) {
        input.setAttribute('accept', accept);
      } else {
        input.removeAttribute('accept');
      }
    };

    if (IS_ANDROID && mode === 'assets') {
      // Use setTimeout to ensure state update has flushed to DOM
      setTimeout(() => {
        syncInputAccept();
        uploadInputRef.current?.click();
      }, 0);
      return;
    }

    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const pickerOptions = {
          multiple: true,
          excludeAcceptAllOption: false,
        };

        if (mode === 'images') {
          pickerOptions.types = [{ description: 'Images', accept: { 'image/*': DEFAULT_IMAGE_EXTENSIONS } }];
        }

        const handles = await window.showOpenFilePicker(pickerOptions);

        const files = await Promise.all(handles.map((handle) => handle.getFile()));
        await handleFilesForMode(mode, files);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, falling back to input:', err);
      }
    }

    // For non-Android fallback, also wait for state to flush
    setTimeout(() => {
      syncInputAccept();
      uploadInputRef.current?.click();
    }, 0);
  }, [handleFilesForMode]);

  const openUploadPicker = useCallback(() => {
    if (allowAssets && allowImages) {
      setShowUploadChoiceModal(true);
      return;
    }

    if (allowImages) {
      openPickerForMode('images');
      return;
    }

    openPickerForMode('assets');
  }, [allowAssets, allowImages, openPickerForMode]);

  const handleUploadChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const mode = uploadModeRef.current || (allowAssets ? 'assets' : 'images');
    uploadModeRef.current = null;
    await handleFilesForMode(mode, files);
  }, [allowAssets, handleFilesForMode]);

  const uploadCopy = useMemo(() => getCollectionUploadCopy(resolvedSource), [resolvedSource]);

  const uploadModal = h(UploadChoiceModal, {
    isOpen: showUploadChoiceModal,
    onClose: () => setShowUploadChoiceModal(false),
    onPickAssets: () => {
      setShowUploadChoiceModal(false);
      openPickerForMode('assets');
    },
    onPickImages: () => {
      setShowUploadChoiceModal(false);
      openPickerForMode('images');
    },
    onOpenCloudGpu,
    supportedExtensions: SUPPORTED_EXTENSIONS,
    title: uploadCopy.title,
    subtitle: uploadCopy.subtitle,
    assetTitle: uploadCopy.assetTitle,
    assetSubtitle: uploadCopy.assetSubtitle,
    imageTitle: uploadCopy.imageTitle,
    imageSubtitle: uploadCopy.imageSubtitle,
    note: uploadCopy.note,
  });

  return {
    uploadInputRef,
    uploadAccept,
    openUploadPicker,
    openPickerForMode,
    handleUploadChange,
    handleAssets,
    handleImages,
    handleFilesForMode,
    uploadModal,
    supportedExtensions: SUPPORTED_EXTENSIONS,
  };
}
