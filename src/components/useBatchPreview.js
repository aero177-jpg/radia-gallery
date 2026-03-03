/**
 * Shared hook for batch preview generation logic.
 * Used by both DebugSettings and AssetSidebar.
 */

import { useCallback, useMemo, useState } from 'preact/hooks';
import { useStore } from '../store';
import { generateAllPreviews, abortBatchPreview } from '../batchPreview';
import { getAssetList, getCurrentAssetIndex } from '../assetManager';

/**
 * @param {object} [options]
 * @param {boolean} [options.skipExisting] - When true, only process assets without a preview.
 * @returns Batch preview state & handlers.
 */
export function useBatchPreview(options = {}) {
  const { skipExisting = false } = options;

  const assets = useStore((state) => state.assets);
  const addLog = useStore((state) => state.addLog);
  const setAssets = useStore((state) => state.setAssets);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);

  const [batchProgress, setBatchProgress] = useState(null); // { current, total, name }
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [batchPreviewModalOpen, setBatchPreviewModalOpen] = useState(false);
  const [batchResult, setBatchResult] = useState(null); // { success, failed, skipped }

  const nonProxyAssetCount = useMemo(
    () => assets.filter((asset) => !asset?.isProxyView).length,
    [assets],
  );

  const missingPreviewCount = useMemo(
    () => assets.filter((asset) => !asset?.isProxyView && !asset?.preview).length,
    [assets],
  );

  const canBatchGeneratePreviews = nonProxyAssetCount > 1;

  const refreshAssets = useCallback(() => {
    const freshAssets = getAssetList();
    const idx = getCurrentAssetIndex();
    setAssets([...freshAssets]);
    setCurrentAssetIndex(idx);
  }, [setAssets, setCurrentAssetIndex]);

  /** Kick off the actual generation run */
  const startGenerateAllPreviews = useCallback(async () => {
    if (!canBatchGeneratePreviews) {
      addLog('[BatchPreview] Needs at least 2 non-proxy assets');
      return;
    }

    const assetList = getAssetList();
    if (assetList.length === 0) {
      addLog('[BatchPreview] No assets loaded');
      return;
    }

    setGeneratingBatch(true);
    setBatchResult(null);
    setBatchProgress({ current: 0, total: assetList.length, name: '' });

    try {
      await generateAllPreviews({
        skipExisting,
        onProgress: (current, total, name) => {
          setBatchProgress({ current, total, name });
        },
        onComplete: (success, failed, skipped) => {
          addLog(`[BatchPreview] Done: ${success} succeeded, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
          setBatchResult({ success, failed, skipped: skipped || 0 });
        },
      });
    } catch (err) {
      console.error('[BatchPreview] Error:', err);
      addLog(`[BatchPreview] Error: ${err.message}`);
    } finally {
      setBatchProgress(null);
      refreshAssets();
      setGeneratingBatch(false);
    }
  }, [addLog, refreshAssets, canBatchGeneratePreviews, skipExisting]);

  const handleOpenBatchPreviewModal = useCallback(() => {
    if (!canBatchGeneratePreviews) {
      addLog('[BatchPreview] Needs at least 2 non-proxy assets');
      return;
    }
    setBatchResult(null);
    setBatchPreviewModalOpen(true);
  }, [canBatchGeneratePreviews, addLog]);

  const handleConfirmBatchPreview = useCallback(() => {
    // Don't close modal — keep it open to show progress
    startGenerateAllPreviews();
  }, [startGenerateAllPreviews]);

  const handleAbortBatchPreview = useCallback(() => {
    abortBatchPreview();
    addLog('[BatchPreview] Abort requested');
  }, [addLog]);

  const handleCloseBatchPreviewModal = useCallback(() => {
    if (generatingBatch) return; // prevent closing while generating
    setBatchPreviewModalOpen(false);
    setBatchResult(null);
  }, [generatingBatch]);

  return {
    batchProgress,
    generatingBatch,
    batchPreviewModalOpen,
    batchResult,
    canBatchGeneratePreviews,
    missingPreviewCount,
    nonProxyAssetCount,
    handleOpenBatchPreviewModal,
    handleConfirmBatchPreview,
    handleAbortBatchPreview,
    handleCloseBatchPreviewModal,
    setBatchPreviewModalOpen,
  };
}
