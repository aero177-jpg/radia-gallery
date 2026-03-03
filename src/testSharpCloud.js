import { loadCloudGpuSettings } from './storage/cloudGpuSettings.js';
import {
  buildApiUrlFromModalUsername,
  ensureModalProcessApiUrl,
  extractModalUsernameFromApiUrl,
} from './utils/modalEndpoints.js';

const PHASE_TO_STAGE = {
  queued: 'warmup',
  starting_worker: 'warmup',
  dispatching_inference: 'warmup',
  preparing_gpu: 'warmup',
  checking_model_cache: 'warmup',
  downloading_model: 'warmup',
  loading_model: 'warmup',
  model_ready: 'warmup',
  processing_images: 'processing',
  serializing_outputs: 'processing',
  inference_complete: 'processing',
  uploading_or_staging_results: 'transferring',
  completed: 'done',
  complete: 'done',
  validation_failed: 'error',
  failed: 'error',
};

const DONE_STATUSES = new Set(['done', 'complete', 'completed']);
const ERROR_STATUSES = new Set(['error', 'failed', 'validation_failed']);
const ALLOWED_RESULTS_KEYS = ['files', 'result_files', 'results', 'items', 'outputs', 'output_files'];
const INITIAL_POLL_INTERVAL_MS = 1500;
const DEFAULT_PHASE_POLL_INTERVAL_MS = 5000;
const FAST_PHASE_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 15000;
const FORCE_ASYNC_TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const ETA_WARMUP_MS = 40000;
const ETA_PER_IMAGE_MS = 15000;
const ETA_PENALTY_MS = 15000;
const ETA_PENALTY_COOLDOWN_MS = 8000;
const FAST_POLL_PHASES = new Set(['loading_model', 'model_ready', 'processing_images']);

// Temporary UX gate: keep background IO active but hide noisy status transitions.
const SILENCE_BACKGROUND_DOWNLOAD_STATUS = true;
const SILENCE_BACKGROUND_TRANSFER_STATUS = true;

// Debug: when true, always send forceAsync=true regardless of caller input.
const DEBUG_FORCE_FORCE_ASYNC = false;

const MOCK_PARAM_ENABLE = 'debugCloudMock';
const MOCK_PARAM_FAIL_COUNT = 'debugCloudFailCount';
const MOCK_PARAM_POLL_MS = 'debugCloudPollMs';
const MOCK_PARAM_WARMUP_MS = 'debugCloudWarmupMs';

const parseIntegerParam = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const parseBooleanParam = (value) => {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const readCloudMockConfig = (fileCount = 1) => {
  if (typeof window === 'undefined') {
    return { enabled: false };
  }

  const params = new URLSearchParams(window.location.search);
  const enabled = parseBooleanParam(params.get(MOCK_PARAM_ENABLE));
  if (!enabled) {
    return { enabled: false };
  }

  const boundedFileCount = Math.max(1, Number(fileCount) || 1);
  return {
    enabled: true,
    failCount: parseIntegerParam(params.get(MOCK_PARAM_FAIL_COUNT), 1, 0, boundedFileCount),
    pollMs: parseIntegerParam(params.get(MOCK_PARAM_POLL_MS), 800, 150, 10000),
    warmupMs: parseIntegerParam(params.get(MOCK_PARAM_WARMUP_MS), 1200, 0, 60000),
  };
};

export const isAndroidUserAgent = (ua) => {
  const userAgent = ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Android/i.test(userAgent || '');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'output.bin';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const parseErrorDetail = (raw) => {
  if (!raw) return '';

  if (typeof raw === 'object') {
    const directDetail = raw?.detail ?? raw?.error?.detail;
    if (directDetail != null) {
      return typeof directDetail === 'string' ? directDetail : JSON.stringify(directDetail);
    }
  }

  const rawText = String(raw).trim();

  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === 'string') return parsed;
    if (parsed?.detail != null) {
      return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
    }
    if (parsed?.error?.detail != null) {
      return typeof parsed.error.detail === 'string' ? parsed.error.detail : JSON.stringify(parsed.error.detail);
    }
  } catch {
    // ignore JSON parse failure
  }

  const detailMatch = rawText.match(/"?detail"?\s*[:=]\s*"?([^"\n]+)"?/i);
  if (detailMatch?.[1]) return detailMatch[1].trim();

  return rawText;
};

const emitErrorProgress = ({ onProgress, progressBase, message, detail }) => {
  if (typeof onProgress !== 'function') return;
  onProgress({
    ...(progressBase || {}),
    source: 'error',
    stage: 'error',
    error: {
      message: message || 'Processing failed',
      detail: parseErrorDetail(detail),
    },
  });
};

const fetchWithApiKey = async (url, apiKey, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set('X-API-KEY', apiKey);
  return fetch(url, { ...init, headers });
};

const parseJsonSafe = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const text = await response.text();
    try {
      return JSON.parse(text || '{}');
    } catch {
      return { raw: text };
    }
  }
  return response.json();
};

const clampPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
};

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const extractBackendMessage = (payload) => {
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  return '';
};

const extractBackendErrorPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.error != null) return payload.error;
  if (payload.detail != null) return payload.detail;
  if (payload.message != null && ERROR_STATUSES.has(String(payload.status || '').toLowerCase())) {
    return payload.message;
  }
  return null;
};

const normalizeStatus = (statusPayload) => String(statusPayload?.status || '').trim().toLowerCase();
const normalizePhase = (statusPayload) => String(statusPayload?.phase || statusPayload?.status || '').trim().toLowerCase() || 'queued';
const normalizeDone = (payload) => Boolean(payload?.done) || DONE_STATUSES.has(normalizeStatus(payload));

const normalizeProgressFiles = (payload) => {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.files)) return payload.files;
  if (Array.isArray(payload.result_files)) return payload.result_files;
  return [];
};

const normalizeFileErrors = (payload) => Array.isArray(payload?.file_errors) ? payload.file_errors : [];

const toFileCount = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric));
};

const resolveFilesExpected = ({ payload, fallbackTotal, filesReady }) => {
  const fallbackExpected = toFileCount(fallbackTotal) ?? 0;
  const explicitExpected = toFileCount(payload?.files_expected)
    ?? toFileCount(payload?.total_files)
    ?? toFileCount(payload?.total_steps);
  if (explicitExpected == null) return Math.max(1, filesReady, fallbackExpected);
  return Math.max(explicitExpected, filesReady, fallbackExpected, 1);
};

const resolveFilesReady = ({ payload, fileListLength }) => {
  const explicitReady = toFileCount(payload?.files_ready)
    ?? toFileCount(payload?.step)
    ?? toFileCount(payload?.current_file);
  if (explicitReady == null) return Math.max(0, fileListLength);
  return Math.max(explicitReady, fileListLength, 0);
};

const extractJobLinks = (payload) => {
  const statusUrl = payload?.status_url || payload?.status_path || null;
  const resultsUrl = payload?.results_url || payload?.results_path || null;
  return {
    jobId: payload?.job_id || null,
    statusUrl,
    resultsUrl,
    submitUrl: payload?.submit_url || null,
    callId: payload?.call_id || null,
  };
};

const resolveCancelUrl = ({ submitUrl, statusUrl, payload }) => {
  const explicitCancelUrl = payload?.cancel_url || payload?.cancel_path || null;
  if (explicitCancelUrl) return explicitCancelUrl;

  const candidateUrl = statusUrl || submitUrl || payload?.submit_url || '';
  const username = extractModalUsernameFromApiUrl(candidateUrl);
  if (username) {
    return buildApiUrlFromModalUsername(username, 'cancel-job');
  }

  if (candidateUrl.includes('-process-image')) {
    return candidateUrl.replace('-process-image', '-cancel-job');
  }
  if (candidateUrl.includes('-get-progress')) {
    return candidateUrl.replace('-get-progress', '-cancel-job');
  }
  if (candidateUrl.includes('-get-status')) {
    return candidateUrl.replace('-get-status', '-cancel-job');
  }

  return null;
};

const withJobIdQuery = (rawUrl, jobId) => {
  if (!rawUrl || !jobId) return rawUrl;
  try {
    const baseOrigin = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
    const parsed = new URL(rawUrl, baseOrigin);
    if (!parsed.searchParams.has('job_id')) {
      parsed.searchParams.set('job_id', jobId);
    }
    if (/^https?:\/\//i.test(rawUrl)) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${separator}job_id=${encodeURIComponent(jobId)}`;
  }
};

const extractFilenameFromDisposition = (disposition, fallback) => {
  if (!disposition) return fallback;
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (!match?.[1]) return fallback;
  const clean = decodeURIComponent(match[1].replace(/"/g, '').trim());
  return clean || fallback;
};

const extractResultsList = (payload) => {
  for (const key of ALLOWED_RESULTS_KEYS) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
};

const normalizeResultItem = (item, index = 0) => {
  const objectLike = item && typeof item === 'object' ? item : {};
  const fallbackUrl = typeof item === 'string' ? item : null;
  const downloadUrl = item?.download_url || item?.downloadUrl || item?.url || null;
  const filename = item?.filename || item?.name || `output-${index + 1}.bin`;
  const stableId = objectLike?.id || objectLike?.key || objectLike?.file_id || objectLike?.path || null;
  return {
    ...objectLike,
    id: stableId,
    key: objectLike?.key || stableId,
    downloadUrl: downloadUrl || fallbackUrl,
    filename,
  };
};

const buildProgressFileKey = (item, index = 0) => {
  const id = item?.id || item?.key || item?.file_id || item?.path;
  if (id) return `id:${id}`;
  const url = item?.downloadUrl || item?.download_url || item?.url || '';
  const name = item?.filename || item?.name || `output-${index + 1}.bin`;
  return `url:${url}|name:${name}`;
};

const withConsumeFalse = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const baseOrigin = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
    const parsed = new URL(rawUrl, baseOrigin);
    if (!parsed.searchParams.has('consume')) {
      parsed.searchParams.set('consume', 'false');
    }
    if (/^https?:\/\//i.test(rawUrl)) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${separator}consume=false`;
  }
};

const normalizeForceAsync = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return FORCE_ASYNC_TRUE_VALUES.has(normalized) ? 'true' : 'false';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return value ? 'true' : 'false';
  return null;
};

const postFormData = (url, apiKey, formData, { onUploadProgress } = {}) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();

  xhr.open('POST', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 0;
  xhr.setRequestHeader('X-API-KEY', apiKey);

  xhr.upload.onprogress = (event) => {
    const loaded = Number.isFinite(event?.loaded) ? event.loaded : 0;
    const total = Number.isFinite(event?.total) ? event.total : 0;
    onUploadProgress?.({ loaded, total, done: false });
  };

  xhr.upload.onloadend = () => {
    onUploadProgress?.({ loaded: 0, total: 0, done: true });
  };

  xhr.onload = () => {
    resolve({
      status: xhr.status,
      statusText: xhr.statusText,
      headers: new Headers(xhr.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const idx = line.indexOf(':');
        return idx > -1 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : null;
      }).filter(Boolean)),
      body: xhr.response,
    });
  };

  xhr.onerror = () => reject(new Error('Upload failed.'));
  xhr.onabort = () => reject(new Error('Upload was interrupted.'));
  xhr.ontimeout = () => reject(new Error('Upload request timed out.'));
  xhr.send(formData);
});

const submitJob = async ({ submitUrl, apiKey, formData, onProgress, progressBase }) => {
  const result = await postFormData(submitUrl, apiKey, formData, {
    onUploadProgress: ({ loaded, total, done }) => {
      onProgress?.({
        ...(progressBase || {}),
        source: 'upload',
        stage: 'upload',
        upload: { loaded, total, done },
      });
    },
  });

  const response = new Response(result.body ?? null, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });

  const returnedJobId = response.headers.get('X-Job-Id') || response.headers.get('x-job-id') || null;

  const submitPayload = await parseJsonSafe(response);
  if (response.status !== 202) {
    const detail = submitPayload?.detail || submitPayload?.error || `Server responded with ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const links = extractJobLinks(submitPayload);
  if (!links.statusUrl) {
    throw new Error('Missing status_url in async submit response.');
  }

  return { submitPayload, links, jobId: links.jobId || returnedJobId || null };
};

const isTerminalPayload = (payload) => {
  const status = normalizeStatus(payload);
  return normalizeDone(payload) || ERROR_STATUSES.has(status);
};

const isErrorPayload = (payload) => ERROR_STATUSES.has(normalizeStatus(payload));

const parseRemainingMs = (payload) => {
  const directMs = toFiniteNumber(payload?.remaining_ms)
    ?? toFiniteNumber(payload?.remainingMs)
    ?? toFiniteNumber(payload?.eta_ms)
    ?? toFiniteNumber(payload?.etaMs);
  if (directMs != null) return Math.max(0, Math.round(directMs));

  const seconds = toFiniteNumber(payload?.remaining_seconds)
    ?? toFiniteNumber(payload?.eta_seconds)
    ?? toFiniteNumber(payload?.etaSeconds);
  if (seconds != null) return Math.max(0, Math.round(seconds * 1000));

  return null;
};

const buildEtaTracker = ({ totalFiles }) => {
  const startedAtMs = Date.now();
  const estimatedTotalMs = ETA_WARMUP_MS + (Math.max(1, Number(totalFiles) || 1) * ETA_PER_IMAGE_MS);
  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + estimatedTotalMs,
    totalEstimateMs: estimatedTotalMs,
    lastPenaltyAtMs: 0,
    lastRemainingMs: estimatedTotalMs,
  };
};

const computeEta = ({ tracker, payload, percent, isTerminal }) => {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - tracker.startedAtMs);
  const backendRemainingMs = parseRemainingMs(payload);
  const shouldUseBackendRemaining = isTerminal || (backendRemainingMs != null && backendRemainingMs > 0);

  let remainingMs;
  let totalMs;

  if (shouldUseBackendRemaining) {
    remainingMs = backendRemainingMs;
    totalMs = Math.max(elapsedMs + remainingMs, tracker.totalEstimateMs || 0);
    tracker.totalEstimateMs = totalMs;
    tracker.deadlineAtMs = now + remainingMs;
  } else {
    if (!isTerminal && now >= tracker.deadlineAtMs && (now - tracker.lastPenaltyAtMs) >= ETA_PENALTY_COOLDOWN_MS) {
      tracker.deadlineAtMs += ETA_PENALTY_MS;
      tracker.totalEstimateMs = Math.max(tracker.totalEstimateMs, tracker.deadlineAtMs - tracker.startedAtMs);
      tracker.lastPenaltyAtMs = now;
    }

    remainingMs = Math.max(0, tracker.deadlineAtMs - now);
    totalMs = Math.max(elapsedMs + remainingMs, tracker.totalEstimateMs || 0);

    if (percent != null && percent > 0 && percent < 100) {
      const projectedTotalMs = elapsedMs / (percent / 100);
      const projectedRemainingMs = Math.max(0, projectedTotalMs - elapsedMs);
      if (projectedRemainingMs < remainingMs) {
        remainingMs = projectedRemainingMs;
        tracker.deadlineAtMs = now + projectedRemainingMs;
      }
      totalMs = Math.max(totalMs, projectedTotalMs);
      tracker.totalEstimateMs = Math.max(tracker.totalEstimateMs, projectedTotalMs);
    }
  }

  if (isTerminal) {
    remainingMs = 0;
    totalMs = Math.max(elapsedMs, tracker.totalEstimateMs || elapsedMs);
  }

  tracker.lastRemainingMs = remainingMs;

  return {
    remainingMs: Math.max(0, Math.round(remainingMs)),
    totalMs: Math.max(0, Math.round(totalMs)),
  };
};

const pollJobStatus = async ({
  statusUrl,
  apiKey,
  onProgress,
  progressBase,
  fileCount,
  pollIntervalMs,
  onNewFiles,
  cancelControl,
}) => {
  let networkErrorCount = 0;
  const etaTracker = buildEtaTracker({ totalFiles: fileCount });
  const seenFileKeys = new Set();
  const allFiles = [];
  let latestFileErrors = [];
  let latestFilesReady = 0;
  let latestFilesExpected = Math.max(1, Number(fileCount) || 1);

  const cancelledResult = () => ({
    cancelled: true,
    finalStatus: {
      status: 'cancelled',
      phase: 'cancelled',
      done: false,
      cancelled: true,
    },
    files: allFiles,
    filesReady: latestFilesReady,
    filesExpected: latestFilesExpected,
    fileErrors: latestFileErrors,
  });

  while (true) {
    if (cancelControl?.stopPolling) {
      return cancelledResult();
    }

    try {
      const response = await fetchWithApiKey(statusUrl, apiKey, { method: 'GET' });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Status polling failed (${response.status})`);
      }

      const payload = await parseJsonSafe(response);
      const phase = normalizePhase(payload);
      const displayPhase = SILENCE_BACKGROUND_TRANSFER_STATUS && phase === 'uploading_or_staging_results'
        ? 'processing_images'
        : phase;
      const status = normalizeStatus(payload);
      const done = normalizeDone(payload);
      const hasError = isErrorPayload(payload);
      const normalizedFiles = normalizeProgressFiles(payload).map((item, index) => normalizeResultItem(item, index));
      const newFiles = [];

      for (let index = 0; index < normalizedFiles.length; index += 1) {
        const fileItem = normalizedFiles[index];
        const fileKey = buildProgressFileKey(fileItem, index);
        if (seenFileKeys.has(fileKey)) continue;
        seenFileKeys.add(fileKey);
        const normalizedWithKey = {
          ...fileItem,
          fileKey,
        };
        newFiles.push(normalizedWithKey);
        allFiles.push(normalizedWithKey);
      }

      latestFileErrors = normalizeFileErrors(payload);
      latestFilesReady = resolveFilesReady({ payload, fileListLength: allFiles.length });
      latestFilesExpected = resolveFilesExpected({ payload, fallbackTotal: fileCount, filesReady: latestFilesReady });

      const percent = clampPercent(payload?.percent)
        ?? (done ? 100 : latestFilesExpected > 0 ? Math.round((latestFilesReady / latestFilesExpected) * 100) : null);
      let stage = PHASE_TO_STAGE[displayPhase] || 'processing';
      if (hasError) stage = 'error';
      else if (done) stage = 'done';
      else if (status === 'queued') stage = 'warmup';
      if (SILENCE_BACKGROUND_TRANSFER_STATUS && stage === 'transferring' && !done) {
        stage = 'processing';
      }
      const isTerminal = isTerminalPayload(payload);
      const { remainingMs, totalMs } = computeEta({
        tracker: etaTracker,
        payload,
        percent,
        isTerminal,
      });
      const backendMessage = extractBackendMessage(payload);
      const backendErrorRaw = extractBackendErrorPayload(payload);
      const backendErrorDetail = parseErrorDetail(backendErrorRaw);

      if (cancelControl?.stopPolling) {
        return cancelledResult();
      }

      onProgress?.({
        ...(progressBase || {}),
        source: 'poll',
        stage,
        phase: displayPhase,
        status: status || payload?.status || (done ? 'done' : phase),
        done,
        cancelPending: Boolean(cancelControl?.inFlight),
        cancelJob: (typeof cancelControl?.run === 'function' && !done && !hasError) ? cancelControl.run : undefined,
        message: backendMessage || undefined,
        files: allFiles,
        newFiles,
        filesReady: latestFilesReady,
        filesExpected: latestFilesExpected,
        fileErrors: latestFileErrors,
        failedCount: latestFileErrors.length,
        successCount: Math.max(0, latestFilesReady - latestFileErrors.length),
        ...(backendErrorDetail ? {
          error: {
            message: backendMessage || 'Processing failed',
            detail: backendErrorDetail,
          },
        } : {}),
        timer: {
          currentFile: Math.max(0, latestFilesReady),
          totalFiles: Math.max(1, latestFilesExpected),
          remainingMs,
          totalMs,
          percent,
          done,
        },
      });

      if (newFiles.length > 0) {
        onNewFiles?.(newFiles, payload);
      }

      if (hasError && !done) {
        const detail = backendErrorDetail || backendMessage || 'Processing failed.';
        const err = new Error(detail);
        err.isTerminalStatus = true;
        throw err;
      }

      if (done || isTerminal) {
        return {
          finalStatus: payload,
          files: allFiles,
          filesReady: latestFilesReady,
          filesExpected: latestFilesExpected,
          fileErrors: latestFileErrors,
        };
      }

      networkErrorCount = 0;
      const nextDelay = Number.isFinite(Number(pollIntervalMs))
        ? Math.max(500, Number(pollIntervalMs))
        : FAST_POLL_PHASES.has(displayPhase)
        ? FAST_PHASE_POLL_INTERVAL_MS
        : DEFAULT_PHASE_POLL_INTERVAL_MS;
      if (cancelControl?.stopPolling) {
        return cancelledResult();
      }
      await sleep(nextDelay);
    } catch (err) {
      if (cancelControl?.stopPolling) {
        return cancelledResult();
      }
      if (err?.isTerminalStatus) {
        throw err;
      }
      networkErrorCount += 1;
      const backoffMs = Math.min(MAX_POLL_INTERVAL_MS, INITIAL_POLL_INTERVAL_MS * (2 ** Math.max(0, networkErrorCount - 1)));
      console.warn('[CloudGPU] Status polling network error, retrying', err);
      await sleep(backoffMs);
    }
  }
};

const downloadResultItems = async ({
  list,
  apiKey,
  downloadMode,
  label,
  onProgress,
  progressBase,
  expectedCount,
  startedFileKeys,
  completedFileKeys,
}) => {
  const safeList = Array.isArray(list) ? list : [];
  if (!safeList.length) {
    return { downloaded: [], files: [], missingDownloads: [] };
  }

  const totalDownloads = Math.max(1, Number(expectedCount) || safeList.length || 1);
  const downloaded = [];
  const storedFiles = [];
  const missingDownloads = [];
  let completedDownloads = 0;

  for (let index = 0; index < safeList.length; index += 1) {
    const item = normalizeResultItem(safeList[index], index);
    const fileKey = buildProgressFileKey(item, index);
    if (completedFileKeys?.has(fileKey) || startedFileKeys?.has(fileKey)) {
      continue;
    }
    startedFileKeys?.add(fileKey);

    const currentDownload = Math.min(totalDownloads, completedDownloads + 1);

    if (!SILENCE_BACKGROUND_DOWNLOAD_STATUS) {
      onProgress?.({
        ...(progressBase || {}),
        source: 'download',
        stage: 'downloading',
        phase: 'downloading_results',
        status: 'running',
        download: {
          current: currentDownload,
          total: totalDownloads,
          filename: item.filename,
        },
        timer: {
          currentFile: currentDownload,
          totalFiles: totalDownloads,
          percent: Math.max(0, Math.min(100, Math.round(((currentDownload - 1) / totalDownloads) * 100))),
          done: false,
        },
      });
    }

    if (!item.downloadUrl) {
      missingDownloads.push(item.filename);
      continue;
    }

    const fileResponse = await fetchWithApiKey(withConsumeFalse(item.downloadUrl), apiKey, { method: 'GET' });
    if (fileResponse.status === 404 || fileResponse.status === 410) {
      missingDownloads.push(item.filename);
      continue;
    }
    if (!fileResponse.ok) {
      const detail = await fileResponse.text();
      throw new Error(detail || `Download failed (${fileResponse.status}).`);
    }

    const blob = await fileResponse.blob();
    const disposition = fileResponse.headers.get('content-disposition') || '';
    const filename = extractFilenameFromDisposition(disposition, item.filename || label || `output-${index + 1}.bin`);

    if (downloadMode === 'store') {
      storedFiles.push(new File([blob], filename, { type: blob.type || 'application/octet-stream' }));
    } else {
      downloadBlob(blob, filename);
    }

    completedFileKeys?.add(fileKey);

    downloaded.push(filename);
    completedDownloads += 1;

    if (!SILENCE_BACKGROUND_DOWNLOAD_STATUS) {
      onProgress?.({
        ...(progressBase || {}),
        source: 'download',
        stage: 'downloading',
        phase: 'downloading_results',
        status: 'running',
        download: {
          current: currentDownload,
          total: totalDownloads,
          filename,
        },
        timer: {
          currentFile: currentDownload,
          totalFiles: totalDownloads,
          percent: Math.max(0, Math.min(100, Math.round((currentDownload / totalDownloads) * 100))),
          done: currentDownload >= totalDownloads,
        },
      });
    }
  }

  return {
    downloaded,
    files: storedFiles,
    missingDownloads,
  };
};

const fetchAndHandleResults = async ({
  resultsUrl,
  apiKey,
  downloadMode,
  label,
  onProgress,
  progressBase,
  expectedCount,
  startedFileKeys,
  completedFileKeys,
}) => {
  if (!resultsUrl) {
    return { downloaded: [], files: [], missingResults: true };
  }

  const resultsResponse = await fetchWithApiKey(resultsUrl, apiKey, { method: 'GET' });
  if (resultsResponse.status === 404 || resultsResponse.status === 410) {
    return { downloaded: [], files: [], missingResults: true };
  }
  if (!resultsResponse.ok) {
    const detail = await resultsResponse.text();
    throw new Error(detail || `Failed to fetch results (${resultsResponse.status}).`);
  }

  const payload = await parseJsonSafe(resultsResponse);
  const list = extractResultsList(payload);
  if (!list.length) {
    return { downloaded: [], files: [], missingResults: true };
  }

  const downloadedData = await downloadResultItems({
    list,
    apiKey,
    downloadMode,
    label,
    onProgress,
    progressBase,
    expectedCount,
    startedFileKeys,
    completedFileKeys,
  });

  return {
    downloaded: downloadedData.downloaded,
    files: downloadedData.files,
    missingResults: downloadedData.downloaded.length === 0 && downloadedData.missingDownloads.length > 0,
    missingDownloads: downloadedData.missingDownloads,
  };
};

const isRemoteStorageTarget = (storageTarget) => ['r2', 'supabase'].includes((storageTarget || '').toLowerCase());

const generateJobId = () => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const rand = Math.random().toString(16).slice(2);
  return `job-${Date.now()}-${rand}`;
};

const buildFormData = ({ files, prefix, returnMode, jobId, gpu, storageTarget, accessString }) => {
  const formData = new FormData();
  for (const file of files) {
    formData.append('file', file, file.name || 'upload');
  }
  if (prefix) formData.append('prefix', prefix);
  if (returnMode) formData.append('return', returnMode);
  if (jobId) formData.append('jobId', jobId);
  if (gpu) formData.append('gpu', gpu);
  if (storageTarget) formData.append('storageTarget', storageTarget);
  if (accessString) {
    formData.append('accessString', typeof accessString === 'string' ? accessString : JSON.stringify(accessString));
  }
  return formData;
};

const buildMockResultName = (inputName, index = 0) => {
  const base = String(inputName || '').trim();
  if (!base) return `mock-output-${index + 1}.sog`;
  const clean = base.replace(/\.[^.]+$/, '');
  return `${clean || `mock-output-${index + 1}`}.sog`;
};

const processMockJob = async ({
  files,
  onProgress,
  progressBase,
  downloadMode,
  storageTarget,
  mockConfig,
}) => {
  const totalFiles = Math.max(1, Number(files?.length) || 1);
  const failCount = Math.max(0, Math.min(totalFiles, Number(mockConfig?.failCount) || 0));
  const successTarget = Math.max(0, totalFiles - failCount);
  const isRemote = isRemoteStorageTarget(storageTarget);

  onProgress?.({
    ...(progressBase || {}),
    source: 'upload',
    stage: 'upload',
    upload: { loaded: totalFiles, total: totalFiles, done: true },
  });

  if (mockConfig?.warmupMs > 0) {
    onProgress?.({
      ...(progressBase || {}),
      source: 'poll',
      stage: 'warmup',
      phase: 'queued',
      status: 'queued',
      done: false,
      files: [],
      newFiles: [],
      filesReady: 0,
      filesExpected: totalFiles,
      fileErrors: [],
      successCount: 0,
      failedCount: 0,
      timer: {
        currentFile: 0,
        totalFiles,
        percent: 0,
        done: false,
      },
    });
    await sleep(mockConfig.warmupMs);
  }

  const progressFiles = [];
  const storedFiles = [];
  const downloaded = [];
  const fileErrors = [];

  for (let index = 0; index < totalFiles; index += 1) {
    await sleep(mockConfig.pollMs);

    const inputFile = files[index];
    const isFailure = index >= successTarget;
    const outputName = buildMockResultName(inputFile?.name, index);
    const fileKey = `mock:${index + 1}:${outputName}`;

    let newFiles = [];
    if (!isFailure) {
      const resultDescriptor = {
        id: `mock-${index + 1}`,
        key: `mock-${index + 1}`,
        filename: outputName,
        name: outputName,
        fileKey,
      };

      const filePayload = JSON.stringify({
        source: inputFile?.name || `input-${index + 1}`,
        generatedAt: new Date().toISOString(),
        mock: true,
      }, null, 2);
      const blob = new Blob([filePayload], { type: 'application/json' });

      if (isRemote) {
        resultDescriptor.downloadUrl = `https://mock.local/results/${encodeURIComponent(outputName)}`;
      } else if (downloadMode === 'store') {
        storedFiles.push(new File([blob], outputName, { type: 'application/json' }));
      } else {
        downloadBlob(blob, outputName);
        downloaded.push(outputName);
      }

      progressFiles.push(resultDescriptor);
      newFiles = [resultDescriptor];
    } else {
      fileErrors.push({
        file: inputFile?.name || `input-${index + 1}`,
        message: 'Mock failure: simulated per-file processing error.',
      });
    }

    const successCount = progressFiles.length;
    const failedCount = fileErrors.length;
    const filesReady = successCount + failedCount;

    onProgress?.({
      ...(progressBase || {}),
      source: 'poll',
      stage: 'processing',
      phase: 'processing_images',
      status: 'processing',
      done: false,
      files: progressFiles,
      newFiles,
      filesReady,
      filesExpected: totalFiles,
      fileErrors,
      successCount,
      failedCount,
      timer: {
        currentFile: filesReady,
        totalFiles,
        percent: Math.max(0, Math.min(99, Math.round((filesReady / totalFiles) * 100))),
        done: false,
      },
    });
  }

  const successCount = progressFiles.length;
  const failedCount = fileErrors.length;
  const warningMessage = failedCount > 0 ? `${successCount} succeeded, ${failedCount} failed` : undefined;

  onProgress?.({
    ...(progressBase || {}),
    source: 'poll',
    stage: 'done',
    phase: 'completed',
    status: 'done',
    done: true,
    files: progressFiles,
    newFiles: [],
    filesReady: totalFiles,
    filesExpected: totalFiles,
    fileErrors,
    successCount,
    failedCount,
    message: warningMessage,
    timer: {
      currentFile: totalFiles,
      totalFiles,
      percent: 100,
      done: true,
    },
  });

  if (isRemote) {
    return {
      downloaded: [],
      files: [],
      deferred: true,
      statusUrl: 'mock://status',
      resultsUrl: 'mock://results',
      callId: 'mock-call',
      progressFiles,
      filesReady: totalFiles,
      filesExpected: totalFiles,
      fileErrors,
      successCount,
      failedCount,
    };
  }

  return {
    downloaded,
    files: storedFiles,
    missingResults: false,
    missingDownloads: [],
    statusUrl: 'mock://status',
    resultsUrl: 'mock://results',
    callId: 'mock-call',
    progressFiles,
    filesReady: totalFiles,
    filesExpected: totalFiles,
    fileErrors,
    successCount,
    failedCount,
  };
};

const processAsyncJob = async ({
  files,
  label,
  submitUrl,
  apiKey,
  onProgress,
  progressBase,
  prefix,
  returnMode,
  downloadMode,
  gpu,
  storageTarget,
  accessString,
  activeJobId,
  forceAsync,
  pollIntervalMs,
}) => {
  const formData = buildFormData({
    files,
    prefix,
    returnMode,
    jobId: activeJobId,
    gpu,
    storageTarget,
    accessString,
  });

  const effectiveForceAsync = DEBUG_FORCE_FORCE_ASYNC ? true : forceAsync;
  const forceAsyncValue = normalizeForceAsync(effectiveForceAsync);
  if (forceAsyncValue != null) {
    formData.append('forceAsync', forceAsyncValue);
    formData.append('force_async', forceAsyncValue);
  }

  const submitResult = await submitJob({
    submitUrl,
    apiKey,
    formData,
    onProgress,
    progressBase,
  });

  const { links } = submitResult;
  const resolvedJobId = links.jobId || activeJobId;
  const pollProgressBase = { ...(progressBase || {}), jobId: resolvedJobId };
  const cancelUrl = resolveCancelUrl({
    submitUrl,
    statusUrl: links.statusUrl,
    payload: submitResult.submitPayload,
  });
  const cancelControl = {
    inFlight: false,
    requested: false,
    completed: false,
    stopPolling: false,
    run: undefined,
  };

  cancelControl.run = async () => {
    if (cancelControl.inFlight || cancelControl.completed) {
      return { cancelled: cancelControl.completed, skipped: true };
    }
    cancelControl.stopPolling = true;
    cancelControl.requested = true;
    if (!cancelUrl || !resolvedJobId) {
      throw new Error('Cancel endpoint is unavailable for this job.');
    }

    cancelControl.inFlight = true;
    try {
      const cancelResponse = await fetchWithApiKey(withJobIdQuery(cancelUrl, resolvedJobId), apiKey, { method: 'POST' });
      const cancelPayload = await parseJsonSafe(cancelResponse);

      if (cancelResponse.status === 404) {
        cancelControl.completed = true;
        return {
          cancelled: true,
          status: 'cancelled',
          payload: cancelPayload,
        };
      }

      if (!cancelResponse.ok) {
        const detail = cancelPayload?.detail || cancelPayload?.error || cancelPayload?.message || `Cancel failed (${cancelResponse.status}).`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }

      const cancelled = Boolean(cancelPayload?.cancelled)
        || String(cancelPayload?.status || '').trim().toLowerCase() === 'cancelled';
      cancelControl.completed = cancelled;

      return {
        cancelled,
        status: cancelPayload?.status || (cancelled ? 'cancelled' : 'running'),
        payload: cancelPayload,
      };
    } finally {
      cancelControl.inFlight = false;
    }
  };

  const startedFileKeys = new Set();
  const completedFileKeys = new Set();
  const progressDownloads = {
    downloaded: [],
    files: [],
    missingDownloads: [],
  };

  let incrementalDownloadQueue = Promise.resolve();
  const enqueueIncrementalDownloads = (list) => {
    if (!Array.isArray(list) || list.length === 0) return;
    incrementalDownloadQueue = incrementalDownloadQueue
      .then(async () => {
        const data = await downloadResultItems({
          list,
          apiKey,
          downloadMode,
          label,
          onProgress,
          progressBase: pollProgressBase,
          expectedCount: files.length,
          startedFileKeys,
          completedFileKeys,
        });
        progressDownloads.downloaded.push(...(data.downloaded || []));
        progressDownloads.files.push(...(data.files || []));
        progressDownloads.missingDownloads.push(...(data.missingDownloads || []));

        if (data.files?.length || data.downloaded?.length) {
          onProgress?.({
            ...pollProgressBase,
            source: 'download-notification',
            ...(SILENCE_BACKGROUND_DOWNLOAD_STATUS ? {} : {
              stage: 'downloading',
              phase: 'downloading_results',
              status: 'running',
            }),
            newStoredFiles: data.files || [],
            newDownloadedFiles: data.downloaded || [],
          });
        }
      })
      .catch((err) => {
        console.warn('[CloudGPU] Incremental download error', err);
      });
  };

  const polled = await pollJobStatus({
    statusUrl: links.statusUrl,
    apiKey,
    onProgress,
    progressBase: pollProgressBase,
    fileCount: files.length,
    pollIntervalMs,
    onNewFiles: isRemoteStorageTarget(storageTarget) ? undefined : (newFiles) => enqueueIncrementalDownloads(newFiles),
    cancelControl,
  });

  await incrementalDownloadQueue;

  if (polled?.cancelled || cancelControl.stopPolling) {
    return {
      downloaded: [],
      files: [],
      missingResults: false,
      missingDownloads: [],
      statusUrl: links.statusUrl,
      resultsUrl: links.resultsUrl,
      callId: links.callId,
      progressFiles: polled?.files || [],
      filesReady: Math.max(0, Number(polled?.filesReady) || 0),
      filesExpected: Math.max(1, Number(polled?.filesExpected) || Number(files.length) || 1),
      fileErrors: polled?.fileErrors || [],
      successCount: 0,
      failedCount: 0,
      cancelled: true,
    };
  }

  const finalStatus = polled?.finalStatus || {};
  const finalDone = normalizeDone(finalStatus);
  if (!finalDone) {
    const detail = finalStatus?.detail || finalStatus?.error || finalStatus?.message || 'Processing failed.';
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const fileErrors = polled?.fileErrors || [];
  const filesReady = Math.max(0, Number(polled?.filesReady) || 0);
  const filesExpected = Math.max(1, Number(polled?.filesExpected) || Number(files.length) || 1);
  const successCount = Math.max(0, filesReady - fileErrors.length);
  const warningMessage = fileErrors.length > 0
    ? `${successCount} succeeded, ${fileErrors.length} failed`
    : undefined;

  if (isRemoteStorageTarget(storageTarget)) {
    onProgress?.({
      ...pollProgressBase,
      source: 'poll',
      stage: 'done',
      status: 'done',
      done: true,
      files: polled?.files || [],
      filesReady,
      filesExpected,
      fileErrors,
      successCount,
      failedCount: fileErrors.length,
      message: warningMessage,
    });
    return {
      downloaded: [],
      files: [],
      deferred: true,
      statusUrl: links.statusUrl,
      resultsUrl: links.resultsUrl,
      callId: links.callId,
      progressFiles: polled?.files || [],
      filesReady,
      filesExpected,
      fileErrors,
      successCount,
      failedCount: fileErrors.length,
    };
  }

  if (!isRemoteStorageTarget(storageTarget)) {
    enqueueIncrementalDownloads(polled?.files || []);
    await incrementalDownloadQueue;
  }

  const shouldUseResultsFallback = progressDownloads.downloaded.length === 0 && progressDownloads.files.length === 0;
  const resultData = shouldUseResultsFallback
    ? await fetchAndHandleResults({
      resultsUrl: links.resultsUrl,
      apiKey,
      downloadMode,
      label,
      onProgress,
      progressBase: pollProgressBase,
      expectedCount: filesExpected,
      startedFileKeys,
      completedFileKeys,
    })
    : { downloaded: [], files: [], missingResults: false, missingDownloads: [] };

  if (shouldUseResultsFallback && resultData.missingResults) {
    throw new Error('Results are no longer available (missing or expired).');
  }

  const combinedDownloaded = [...(progressDownloads.downloaded || []), ...(resultData.downloaded || [])];
  const combinedFiles = [...(progressDownloads.files || []), ...(resultData.files || [])];
  const combinedMissing = [...(progressDownloads.missingDownloads || []), ...(resultData.missingDownloads || [])];
  const effectiveSuccessCount = Math.max(successCount, combinedDownloaded.length || combinedFiles.length || 0);
  onProgress?.({
    ...pollProgressBase,
    source: 'poll',
    stage: 'done',
    status: 'done',
    done: true,
    files: polled?.files || [],
    filesReady,
    filesExpected,
    fileErrors,
    successCount: effectiveSuccessCount,
    failedCount: fileErrors.length,
    message: warningMessage,
  });
  return {
    downloaded: combinedDownloaded,
    files: combinedFiles,
    missingResults: shouldUseResultsFallback ? resultData.missingResults : false,
    missingDownloads: combinedMissing,
    statusUrl: links.statusUrl,
    resultsUrl: links.resultsUrl,
    callId: links.callId,
    progressFiles: polled?.files || [],
    filesReady,
    filesExpected,
    fileErrors,
    successCount: effectiveSuccessCount,
    failedCount: fileErrors.length,
  };
};

export async function testSharpCloud(files, {
  prefix,
  onProgress,
  apiUrl,
  apiKey,
  returnMode,
  gpuType,
  downloadMode,
  storageTarget,
  accessString,
  jobId,
  getJobId,
  forceAsync,
  pollIntervalMs,
} = {}) {
  const uploads = Array.from(files || []);
  const mockConfig = readCloudMockConfig(uploads.length);
  const saved = loadCloudGpuSettings();
  const resolvedUrl = ensureModalProcessApiUrl(apiUrl || saved?.apiUrl, 'process-image');
  const resolvedKey = apiKey || saved?.apiKey;
  const resolvedGpu = (gpuType || saved?.gpuType || 'a10').trim().toLowerCase();
  const resolvedStorageTarget = storageTarget || undefined;

  if (!mockConfig.enabled && (!resolvedUrl || !resolvedKey)) {
    console.error('❌ Missing Cloud GPU settings: configure API URL and API key in Add Cloud GPU.');
    return [];
  }

  if (!uploads || uploads.length === 0) {
    console.warn('No files selected for upload.');
    return [];
  }
  const total = uploads.length;
  const results = [];
  const activeJobId = jobId || getJobId?.(null) || generateJobId();
  const progressBase = { completed: 0, total, jobId: activeJobId };

  try {
    const data = mockConfig.enabled
      ? await processMockJob({
        files: uploads,
        onProgress,
        progressBase,
        downloadMode,
        storageTarget: resolvedStorageTarget,
        mockConfig,
      })
      : await processAsyncJob({
        files: uploads,
        label: `${uploads.length} files`,
        submitUrl: resolvedUrl,
        apiKey: resolvedKey,
        onProgress,
        progressBase,
        prefix,
        returnMode,
        downloadMode,
        gpu: resolvedGpu,
        storageTarget: resolvedStorageTarget,
        accessString,
        activeJobId,
        forceAsync,
        pollIntervalMs,
      });

    results.push({ file: 'batch', ok: true, data, jobId: activeJobId });
    if (!data?.cancelled) {
      onProgress?.({ completed: total, total, source: 'poll', stage: 'done', jobId: activeJobId });
    }
    return results;
  } catch (err) {
    const detail = err?.message || String(err);
    emitErrorProgress({
      onProgress,
      progressBase,
      message: 'Processing failed',
      detail,
    });
    results.push({ file: 'batch', ok: false, error: detail, silentFailure: true });
    return results;
  }
}
