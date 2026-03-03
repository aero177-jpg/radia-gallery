/**
 * Upload status overlay component.
 *
 * Stages:
 *   upload       → "Uploading" + spinner, no bar
 *   packaging    → "Packaging ZIP" + spinner, no bar
 *   warmup       → "GPU warm-up" + bar + countdown
 *   processing   → "Processing image X of Y" + bar + countdown
 *   transferring → "Transferring X files to storage" + spinner, no bar
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';

const ALLOW_UPLOAD_OVERLAY_DEBUG = true;

const PHASE_LABELS = {
  queued: 'Queued',
  starting_worker: 'Warming up GPU',
  dispatching_inference: 'Warming up GPU',
  preparing_gpu: 'Warming up GPU',
  checking_model_cache: 'Warming up GPU',
  downloading_model: 'Downloading model',
  loading_model: 'Warming up GPU',
  model_ready: 'Warming up GPU',
  processing_images: 'Processing image',
  serializing_outputs: 'Processing image',
  inference_complete: 'Processing image',
  uploading_or_staging_results: 'Sending results to storage',
  completed: 'Completed',
  failed: 'Failed',
  validation_failed: 'Validation failed',
};

const LOCAL_TICK_MS = 250;
const WARMUP_MS = 40000;
const IMAGE_STEP_MS = 15000;
const WARMUP_MISS_PENALTY_MS = 5000;
const IMAGE_STEP_MISS_PENALTY_MS = 2000;

const normalizeStep = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
};

const getElapsedMs = (timerState, nowMs) => {
  if (!timerState) return 0;
  if (timerState.terminal) return timerState.elapsedMs;
  return Math.max(0, timerState.elapsedMs + (nowMs - timerState.anchorMs));
};

const normalizePhase = (value) => String(value || '').trim().toLowerCase();
const normalizeStatus = (value) => String(value || '').trim().toLowerCase();

const resolveTotalFilesEstimate = (timer, uploadProgress) => {
  const fromTimer = normalizeStep(timer?.totalFiles);
  const fromExpected = normalizeStep(uploadProgress?.filesExpected);
  const fromTotal = normalizeStep(uploadProgress?.total);
  return Math.max(1, fromTimer, fromExpected, fromTotal);
};

const resolveStageLabel = ({ stage, phase, currentFile, totalFiles, batchPrefix }) => {
  if (phase === 'uploading_or_staging_results') {
    return `${batchPrefix}Sending results to storage`;
  }

  if (phase && PHASE_LABELS[phase]) {
    if ((phase === 'processing_images' || phase === 'serializing_outputs' || phase === 'inference_complete') && totalFiles > 1) {
      return `${batchPrefix}Processing ${Math.max(1, currentFile || 1)} of ${totalFiles}`;
    }
    return `${batchPrefix}${PHASE_LABELS[phase]}`;
  }

  if (stage === 'upload') return `${batchPrefix}Uploading`;
  if (stage === 'packaging') return `${batchPrefix}Packaging ZIP`;
  if (stage === 'transferring') return `${batchPrefix}Sending results to storage`;
  if (stage === 'warmup') return `${batchPrefix}Warming up GPU`;
  if (stage === 'processing' && totalFiles > 1) {
    return `${batchPrefix}Processing ${Math.max(1, currentFile || 1)} of ${totalFiles}`;
  }
  if (stage === 'processing') return `${batchPrefix}Processing image`;
  if (stage === 'done') return `${batchPrefix}Completed`;
  return `${batchPrefix}Processing…`;
};

const formatEta = (seconds) => {
  const remaining = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
};

const readDebugOverlayState = () => {
  if (typeof window === 'undefined') {
    return { enabled: false, isUploading: false, uploadProgress: null };
  }

  if (!ALLOW_UPLOAD_OVERLAY_DEBUG) {
    return { enabled: false, isUploading: false, uploadProgress: null };
  }

  const params = new URLSearchParams(window.location.search);
  const enabled = params.get('debugUploadOverlay') === '1';
  if (!enabled) {
    return { enabled: false, isUploading: false, uploadProgress: null };
  }

  const mode = String(params.get('debugUploadMode') || 'processing').trim().toLowerCase();

  if (mode === 'error' || mode === 'failed') {
    const errorMessage = String(params.get('debugUploadErrorMessage') || 'Simulated upload failure').trim();
    const errorDetail = String(
      params.get('debugUploadErrorDetail')
      || 'Simulated backend failure while processing image 5.\nGPU worker timed out and returned no output payload.'
    ).trim();

    return {
      enabled: true,
      isUploading: true,
      uploadProgress: {
        stage: 'error',
        phase: 'failed',
        status: 'failed',
        message: errorMessage,
        error: {
          message: errorMessage,
          detail: errorDetail,
        },
      },
    };
  }

  const totalFiles = Math.max(2, normalizeStep(params.get('debugUploadTotal') || 8));
  const currentFile = Math.max(1, Math.min(totalFiles, normalizeStep(params.get('debugUploadCurrent') || Math.ceil(totalFiles / 2))));
  const timerTotalMs = Math.max(1000, normalizeStep(params.get('debugUploadMsTotal') || 120000));
  const timerRemainingMs = Math.max(1000, Math.min(timerTotalMs - 1000, normalizeStep(params.get('debugUploadMsRemaining') || 52000)));

  return {
    enabled: true,
    isUploading: true,
    uploadProgress: {
      stage: 'processing',
      phase: 'processing_images',
      status: 'processing_images',
      timer: {
        currentFile,
        totalFiles,
        totalMs: timerTotalMs,
        remainingMs: timerRemainingMs,
      },
      total: totalFiles,
      message: 'Debug overlay mode (simulated mid-process)',
    },
  };
};

function UploadStatusOverlay({ isUploading, uploadProgress, variant = 'default', onDismiss }) {
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [showDetailMessage, setShowDetailMessage] = useState(false);
  const [liveTimer, setLiveTimer] = useState(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [cancelInFlight, setCancelInFlight] = useState(false);
  const [optimisticCancelling, setOptimisticCancelling] = useState(false);
  const [lockedCloudSessionId, setLockedCloudSessionId] = useState(null);
  const [lockedCloudProgress, setLockedCloudProgress] = useState(null);
  const [cloudReachedTimedStage, setCloudReachedTimedStage] = useState(false);
  const cancelCloseTimerRef = useRef(null);
  const debugState = useMemo(() => readDebugOverlayState(), []);

  const activeIsUploading = debugState.enabled ? debugState.isUploading : isUploading;
  const activeUploadProgress = debugState.enabled ? debugState.uploadProgress : uploadProgress;
  const effectiveUploadProgress = lockedCloudSessionId ? lockedCloudProgress : activeUploadProgress;

  useEffect(() => () => {
    if (cancelCloseTimerRef.current) {
      clearTimeout(cancelCloseTimerRef.current);
      cancelCloseTimerRef.current = null;
    }
  }, []);

  const scheduleOptimisticClose = () => {
    if (cancelCloseTimerRef.current) {
      clearTimeout(cancelCloseTimerRef.current);
    }
    cancelCloseTimerRef.current = setTimeout(() => {
      setOptimisticCancelling(false);
      setIsDismissed(true);
      onDismiss?.();
      cancelCloseTimerRef.current = null;
    }, 3000);
  };

  useEffect(() => {
    if (!activeIsUploading) {
      setLockedCloudSessionId(null);
      setLockedCloudProgress(null);
      setCloudReachedTimedStage(false);
      return;
    }

    const incoming = activeUploadProgress;
    if (!incoming) return;

    const isCloudGpu = incoming?.uploadKind === 'cloud-gpu';
    if (!isCloudGpu) {
      return;
    }

    const incomingSessionId = String(incoming?.uploadSessionId || 'cloud-gpu-session');
    if (!lockedCloudSessionId) {
      setLockedCloudSessionId(incomingSessionId);
      setLockedCloudProgress(incoming);
      return;
    }

    if (incomingSessionId === lockedCloudSessionId) {
      setLockedCloudProgress(incoming);
    }
  }, [activeIsUploading, activeUploadProgress, lockedCloudSessionId]);

  useEffect(() => {
    if (!lockedCloudSessionId || !effectiveUploadProgress) {
      setCloudReachedTimedStage(false);
      return;
    }

    const stage = String(effectiveUploadProgress?.stage || '').trim().toLowerCase();
    const phase = normalizePhase(effectiveUploadProgress?.phase);
    if (
      stage === 'warmup'
      || stage === 'processing'
      || stage === 'transferring'
      || stage === 'done'
      || stage === 'error'
      || phase === 'processing_images'
      || phase === 'serializing_outputs'
      || phase === 'inference_complete'
      || phase === 'uploading_or_staging_results'
      || Boolean(effectiveUploadProgress?.timer)
    ) {
      setCloudReachedTimedStage(true);
    }
  }, [lockedCloudSessionId, effectiveUploadProgress]);

  const showUploadProgress = activeIsUploading && (
    effectiveUploadProgress?.stage
    || effectiveUploadProgress?.upload?.total
    || effectiveUploadProgress?.timer
    || effectiveUploadProgress?.error
    || effectiveUploadProgress?.total
  );

  useEffect(() => {
    if (!showUploadProgress) {
      setIsDismissed(false);
      setCancelInFlight(false);
      setShowErrorDetails(false);
      setShowDetailMessage(false);
      if (!optimisticCancelling && cancelCloseTimerRef.current) {
        clearTimeout(cancelCloseTimerRef.current);
        cancelCloseTimerRef.current = null;
      }
    }
  }, [showUploadProgress, optimisticCancelling]);

  useEffect(() => {
    setIsDismissed(false);
  }, [effectiveUploadProgress?.error?.detail, effectiveUploadProgress?.error?.message, effectiveUploadProgress?.status, effectiveUploadProgress?.phase, effectiveUploadProgress?.stage]);

  useEffect(() => {
    if (!showUploadProgress) {
      setLiveTimer(null);
      return;
    }

    const rawStage = effectiveUploadProgress?.stage || 'upload';
    const stage = (lockedCloudSessionId && cloudReachedTimedStage && rawStage === 'upload')
      ? 'processing'
      : rawStage;
    const phase = normalizePhase(effectiveUploadProgress?.phase);
    const status = normalizeStatus(effectiveUploadProgress?.status);
    const isTerminalDone = status === 'done' || status === 'complete' || status === 'completed' || phase === 'completed' || Boolean(effectiveUploadProgress?.done);
    const timer = effectiveUploadProgress?.timer || null;
    const isTimedStage = stage === 'warmup' || stage === 'processing' || phase === 'processing_images';

    if (!isTimedStage) {
      setLiveTimer(null);
      return;
    }

    const totalFiles = resolveTotalFilesEstimate(timer, effectiveUploadProgress);
    const observedStep = Math.min(totalFiles, normalizeStep(timer?.currentFile));

    setLiveTimer((previous) => {
      const now = Date.now();
      const shouldReset = !previous || previous.totalFiles !== totalFiles;
      let base = shouldReset
        ? {
          totalMs: WARMUP_MS + (totalFiles * IMAGE_STEP_MS),
          elapsedMs: 0,
          anchorMs: now,
          terminal: false,
          confirmedStep: 0,
          totalFiles,
          nextDeadlineMs: WARMUP_MS,
        }
        : {
          ...previous,
          elapsedMs: getElapsedMs(previous, now),
          anchorMs: now,
        };

      if (isTerminalDone) {
        return {
          ...base,
          elapsedMs: Math.max(base.elapsedMs, base.totalMs),
          anchorMs: now,
          terminal: true,
        };
      }

      while (base.confirmedStep < observedStep) {
        base.elapsedMs = Math.max(base.elapsedMs, base.nextDeadlineMs);
        base.confirmedStep += 1;
        if (base.confirmedStep < base.totalFiles) {
          base.nextDeadlineMs = base.elapsedMs + IMAGE_STEP_MS;
        } else {
          base.nextDeadlineMs = base.totalMs;
        }
      }

      return {
        ...base,
        terminal: false,
      };
    });
  }, [showUploadProgress, effectiveUploadProgress, lockedCloudSessionId, cloudReachedTimedStage]);

  useEffect(() => {
    if (!showUploadProgress || !liveTimer || liveTimer.terminal) return undefined;

    const timerId = setInterval(() => {
      setLiveTimer((previous) => {
        if (!previous || previous.terminal) return previous;

        const now = Date.now();
        let elapsedMs = Math.max(0, previous.elapsedMs + (now - previous.anchorMs));
        let totalMs = previous.totalMs;
        let nextDeadlineMs = previous.nextDeadlineMs;

        while (previous.confirmedStep < previous.totalFiles && elapsedMs >= nextDeadlineMs) {
          const penaltyMs = previous.confirmedStep <= 0
            ? WARMUP_MISS_PENALTY_MS
            : IMAGE_STEP_MISS_PENALTY_MS;
          totalMs += penaltyMs;
          nextDeadlineMs += penaltyMs;
        }

        return {
          ...previous,
          elapsedMs,
          totalMs,
          nextDeadlineMs,
          anchorMs: now,
        };
      });
    }, LOCAL_TICK_MS);

    return () => clearInterval(timerId);
  }, [showUploadProgress, liveTimer?.terminal]);

  const viewModel = useMemo(() => {
    if (!showUploadProgress && !optimisticCancelling) return null;

    if (optimisticCancelling) {
      return {
        stageLabel: 'Cancelling',
        showSpinner: true,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 0,
        messageLabel: '',
        showCancel: false,
        cancelPending: true,
      };
    }

    const rawStage = effectiveUploadProgress?.stage || 'upload';
    const stage = (lockedCloudSessionId && cloudReachedTimedStage && rawStage === 'upload')
      ? 'processing'
      : rawStage;
    const phase = normalizePhase(effectiveUploadProgress?.phase);
    const status = normalizeStatus(effectiveUploadProgress?.status);
    const timer = effectiveUploadProgress?.timer || null;
    const download = effectiveUploadProgress?.download || null;
    const totalFiles = resolveTotalFilesEstimate(timer, effectiveUploadProgress);
    const currentFile = timer?.currentFile || 0;
    const error = effectiveUploadProgress?.error || null;
    const backendMessage = String(effectiveUploadProgress?.message || '').trim();
    const batch = effectiveUploadProgress?.batch || null;
    const batchPrefix = batch?.total > 1
      ? `Batch ${batch?.index || 1} of ${batch?.total} • `
      : '';
    const hasTerminalFailure = status === 'failed' || status === 'error' || phase === 'failed' || phase === 'validation_failed';
    const isTerminalDone = status === 'done' || status === 'complete' || status === 'completed' || phase === 'completed' || Boolean(effectiveUploadProgress?.done);
    const fileErrors = Array.isArray(effectiveUploadProgress?.fileErrors) ? effectiveUploadProgress.fileErrors : [];
    const failedCount = Math.max(0, Number(effectiveUploadProgress?.failedCount) || fileErrors.length);
    const successCount = Math.max(0, Number(effectiveUploadProgress?.successCount) || 0);
    const hasCancelAction = typeof effectiveUploadProgress?.cancelJob === 'function';
    const showCancel = hasCancelAction && !isTerminalDone && !hasTerminalFailure && stage !== 'error';
    const cancelPending = Boolean(effectiveUploadProgress?.cancelPending) || cancelInFlight;

    if (isTerminalDone && failedCount > 0) {
      return {
        stageLabel: `${batchPrefix}Completed with warnings (${successCount} succeeded, ${failedCount} failed)`,
        showSpinner: false,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 100,
        errorDetail: '',
        messageLabel: backendMessage || '',
        showCancel,
        cancelPending,
      };
    }

    if (stage === 'error' || error || hasTerminalFailure) {
      const errorMessage = error?.message || backendMessage || 'Process failed';
      return {
        stageLabel: `${batchPrefix}${errorMessage}`,
        showSpinner: false,
        showErrorIcon: true,
        showBar: false,
        etaLabel: '',
        progressPercent: 0,
        errorDetail: error?.detail || backendMessage || '',
        errorMessage,
        showCancel: false,
        cancelPending: false,
      };
    }

    // Upload stage: just "Uploading" + spinner, no bar or file count
    if (stage === 'upload') {
      return {
        stageLabel: `${batchPrefix}Uploading`,
        showSpinner: true,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 0,
        messageLabel: backendMessage || '',
        showCancel,
        cancelPending,
      };
    }

    if (stage === 'packaging') {
      return {
        stageLabel: `${batchPrefix}Packaging ZIP`,
        showSpinner: true,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 100,
        messageLabel: backendMessage || '',
        showCancel,
        cancelPending,
      };
    }

    // Transferring stage: files done processing, moving to storage
    if (stage === 'transferring' || phase === 'uploading_or_staging_results') {
      return {
        stageLabel: `${batchPrefix}Sending results to storage`,
        showSpinner: true,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 100,
        messageLabel: backendMessage || '',
        showCancel,
        cancelPending,
      };
    }

    if (stage === 'downloading' || phase === 'downloading_results') {
      const totalDownloads = Math.max(1, Number(download?.total) || Number(timer?.totalFiles) || Number(totalFiles) || 1);
      const currentDownload = Math.max(1, Math.min(totalDownloads, Number(download?.current) || Number(timer?.currentFile) || 1));
      return {
        stageLabel: `${batchPrefix}Downloading ${currentDownload} of ${totalDownloads}`,
        showSpinner: true,
        showErrorIcon: false,
        showBar: false,
        etaLabel: '',
        progressPercent: 0,
        messageLabel: backendMessage || '',
        showCancel,
        cancelPending,
      };
    }

    // Warmup / Processing: bar + countdown timer
    const now = Date.now();
    const liveElapsedMs = getElapsedMs(liveTimer, now);
    const directRemainingMs = Number.isFinite(timer?.remainingMs) ? Math.max(0, Math.round(timer.remainingMs)) : null;
    const directTotalMs = Number.isFinite(timer?.totalMs) ? Math.max(1000, Math.round(timer.totalMs)) : null;
    const totalMsSource = liveTimer?.totalMs ?? directTotalMs ?? (WARMUP_MS + (Math.max(1, Number(totalFiles) || 1) * IMAGE_STEP_MS));
    const totalMs = Math.max(1000, totalMsSource);
    const elapsedMs = liveTimer ? liveElapsedMs : Math.max(0, totalMs - (directRemainingMs ?? 0));
    const remainingMs = Math.max(0, totalMs - elapsedMs);
    const percentFromTime = Math.max(0, Math.min(100, Math.round((elapsedMs / totalMs) * 100)));
    const etaSeconds = Math.ceil(remainingMs / 1000);
    const etaLabel = etaSeconds > 0 ? formatEta(etaSeconds) : '';
    const stageLabel = resolveStageLabel({
      stage,
      phase,
      currentFile,
      totalFiles,
      batchPrefix,
    });
    const messageLabel = backendMessage && backendMessage.toLowerCase() !== stageLabel.toLowerCase()
      ? backendMessage
      : '';

    return {
      stageLabel,
      showSpinner: false,
      showErrorIcon: false,
      showBar: true,
      etaLabel,
      progressPercent: percentFromTime,
      messageLabel,
      showCancel,
      cancelPending,
    };
  }, [showUploadProgress, effectiveUploadProgress, liveTimer, cancelInFlight, lockedCloudSessionId, cloudReachedTimedStage, optimisticCancelling]);

  const showOverlay = showUploadProgress || optimisticCancelling;
  if (!showOverlay || isDismissed || !viewModel) return null;

  const variantClass = variant && variant !== 'default' ? ` ${variant}` : '';
  const titleClass = viewModel.showSpinner || viewModel.showErrorIcon
    ? 'viewer-upload-title has-spinner'
    : 'viewer-upload-title';
  const titleMainClass = viewModel.showCancel
    ? 'viewer-upload-title-main has-cancel'
    : 'viewer-upload-title-main';
  const handleDetailToggle = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setShowDetailMessage((value) => !value);
  };

  return (
    <div class={`viewer-upload-overlay${variantClass}`}>
      <div class={titleClass}>
        <div class={titleMainClass}>
          {viewModel.messageLabel && (
            <button
              type="button"
              class="viewer-upload-detail-toggle"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleDetailToggle}
              aria-label={showDetailMessage ? 'Hide detailed status' : 'Show detailed status'}
              aria-expanded={showDetailMessage}
            >
              <span class={`viewer-upload-error-caret${showDetailMessage ? ' is-open' : ''}`}>
                <FontAwesomeIcon icon={faChevronRight} />
              </span>
              <span>{viewModel.stageLabel}</span>
            </button>
          )}
          {!viewModel.messageLabel && <span>{viewModel.stageLabel}</span>}
          {viewModel.showCancel && (
            <button
              type="button"
              class="viewer-upload-cancel-button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (cancelInFlight || optimisticCancelling || typeof effectiveUploadProgress?.cancelJob !== 'function') return;
                setOptimisticCancelling(true);
                setCancelInFlight(true);
                scheduleOptimisticClose();
                try {
                  await effectiveUploadProgress.cancelJob();
                } catch {
                  // ignore inline cancel errors; polling updates will surface status
                } finally {
                  setCancelInFlight(false);
                }
              }}
              aria-label={viewModel.cancelPending ? 'Cancelling job' : 'Cancel job'}
              title={viewModel.cancelPending ? 'Cancelling…' : 'Cancel'}
              disabled={viewModel.cancelPending}
            >
              ✕
            </button>
          )}
        </div>
        {viewModel.showSpinner && <span class="viewer-upload-spinner" />}
        {viewModel.showErrorIcon && (
          <button
            type="button"
            class="viewer-upload-error-close"
            onClick={() => {
              setIsDismissed(true);
              onDismiss?.();
            }}
            aria-label="Close"
          >
            <span class="viewer-upload-error-icon">✕</span>
          </button>
        )}
      </div>
      {viewModel.etaLabel && (
        <div class="viewer-upload-meta">
          <span class="viewer-upload-eta">{viewModel.etaLabel}</span>
        </div>
      )}
      {viewModel.messageLabel && showDetailMessage && (
        <div class="viewer-upload-meta">
          <span class="viewer-upload-eta">{viewModel.messageLabel}</span>
        </div>
      )}
      {(viewModel.errorDetail || viewModel.showErrorIcon) && (
        <div class="viewer-upload-error">
          <button
            type="button"
            class="viewer-upload-error-toggle"
            onClick={() => setShowErrorDetails((value) => !value)}
          >
            <span class={`viewer-upload-error-caret${showErrorDetails ? ' is-open' : ''}`}>
              <FontAwesomeIcon icon={faChevronRight} />
            </span>
            Show error message
          </button>
          {showErrorDetails && (
            <div class="viewer-upload-error-detail">
              {viewModel.errorDetail || 'No error detail provided.'}
            </div>
          )}
        </div>
      )}
      {viewModel.showBar && (
        <div class="viewer-upload-bar">
          <div class="viewer-upload-bar-fill" style={{ width: `${viewModel.progressPercent}%` }} />
        </div>
      )}
    </div>
  );
}

export default UploadStatusOverlay;
