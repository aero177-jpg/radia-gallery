/**
 * Batch preview confirmation modal.
 * Shows confirmation, live progress during generation, and completion summary.
 */

import Modal from './Modal';

function BatchPreviewModal({
  isOpen,
  onClose,
  onConfirm,
  onAbort,
  assetCount,
  isBusy,
  batchProgress,
  batchResult,
}) {
  const safeCount = Number.isFinite(assetCount) ? assetCount : 0;
  const isComplete = !isBusy && batchResult != null;
  const isProcessing = isBusy && batchProgress != null;
  const progressPct = batchProgress
    ? Math.round((batchProgress.current / batchProgress.total) * 100)
    : 0;

  return (
    <Modal isOpen={isOpen} onClose={isBusy ? undefined : onClose}>
      {/* Blur overlay while processing */}
      {isProcessing && <div class="batch-preview-blur-overlay" />}

      <h3>
        {isComplete
          ? 'Batch preview complete'
          : isProcessing
            ? 'Generating previews…'
            : 'Generate batch previews'}
      </h3>

      {/* --- Idle / confirmation state --- */}
      {!isProcessing && !isComplete && (
        <p class="modal-note">
          This will rapidly load each file and capture a preview image.
          Click "Generate" to start the process for {safeCount} item{safeCount === 1 ? '' : 's'}.
        </p>
      )}

      {/* --- Progress state --- */}
      {isProcessing && batchProgress && (
        <div class="batch-preview-progress">
          <p class="modal-note" style={{ marginBottom: '8px' }}>
            {batchProgress.current} of {batchProgress.total}: <strong>{batchProgress.name}</strong>
          </p>
          <div class="batch-progress-bar-track">
            <div
              class="batch-progress-bar-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p class="batch-progress-pct">{progressPct}%</p>
        </div>
      )}

      {/* --- Complete state --- */}
      {isComplete && (
        <div class="batch-preview-result">
          <p class="modal-note">
            {batchResult.success} succeeded
            {batchResult.failed > 0 && <>, <span class="text-danger">{batchResult.failed} failed</span></>}
            {batchResult.skipped > 0 && <>, {batchResult.skipped} skipped</>}
          </p>
        </div>
      )}

      <div class="modal-actions">
        {isComplete ? (
          <button class="modal-confirm-btn" onClick={onClose}>Done</button>
        ) : isProcessing ? (
          <button class="danger" onClick={onAbort}>Abort</button>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button
              class="modal-confirm-btn"
              onClick={onConfirm}
              disabled={isBusy || safeCount === 0}
            >
              Generate
            </button>
          </>
        )}
        
      </div>
    </Modal>
  );
}

export default BatchPreviewModal;
