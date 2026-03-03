import { MessageType } from "../shared/messages.js";
import { defaultPlan, getPlan, setPlan } from "../shared/plans.js";

const JobStatus = {
  Queued: "queued",
  Downloading: "downloading",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled"
};

const CleanupMode = {
  Terminal: "terminal",
  Completed: "completed",
  FailedCancelled: "failed_cancelled"
};

const MAX_CONCURRENT_DOWNLOADS = 2;
const JOBS_STORAGE_KEY = "download_jobs";
const JOB_RETENTION_DAYS_KEY = "job_retention_days";
const MEDIA_CATALOG_STORAGE_KEY = "media_catalog";
const DEFAULT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 365;
const MAX_PERSISTED_JOBS = 300;
const MAX_MEDIA_CATALOG_ITEMS = 1000;
const RESTART_ERROR = "service_worker_restarted";
const BLOB_TRANSFER_PORT_NAME = "MEDIA_CAPTURE_BLOB_TRANSFER";

const jobs = new Map();
const queue = [];
const activeJobIds = new Set();
const downloadToJob = new Map();
const pendingPageJobs = new Map();
const pendingPageJobTimers = new Map();
const jobControllers = new Map();
const jobBlobUrls = new Map();
const mediaCatalog = new Map();

let initialized = false;
let persistTimer = null;
let retentionDays = DEFAULT_RETENTION_DAYS;
const initPromise = initializeState();

chrome.runtime.onInstalled.addListener(async () => {
  const plan = await getPlan();
  if (!plan) {
    await chrome.storage.local.set({ plan: defaultPlan });
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  const jobId = downloadToJob.get(delta.id);
  if (!jobId) {
    return;
  }

  const job = jobs.get(jobId);
  if (!job) {
    downloadToJob.delete(delta.id);
    return;
  }

  if (delta.bytesReceived || delta.totalBytes) {
    const received = delta.bytesReceived?.current ?? job.bytesReceived;
    const total = delta.totalBytes?.current ?? job.totalBytes;
    job.bytesReceived = received;
    job.totalBytes = total;
    job.progress = total > 0 ? Math.round((received / total) * 100) : null;
    job.updatedAt = Date.now();
    schedulePersist();
  }

  if (delta.state?.current === "complete") {
    markJobCompleted(job);
    return;
  }

  if (delta.state?.current === "interrupted") {
    if (job.status !== JobStatus.Cancelled) {
      markJobFailed(job, createInterruptedFailure(job, delta.error?.current));
    }
  }
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  const matchedJob = matchPendingPageJob(downloadItem);
  if (!matchedJob) {
    return;
  }

  matchedJob.downloadId = downloadItem.id;
  matchedJob.updatedAt = Date.now();
  downloadToJob.set(downloadItem.id, matchedJob.jobId);
  clearPendingPageJob(matchedJob.jobId);
  schedulePersist();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void initPromise
    .then(() => handleMessage(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

  return true;
});

async function initializeState() {
  retentionDays = await loadRetentionDays();

  const persistedJobs = await loadPersistedJobs();
  for (const raw of persistedJobs) {
    const job = normalizeLoadedJob(raw);
    if (!job) {
      continue;
    }

    jobs.set(job.jobId, job);
    if (job.status === JobStatus.Queued) {
      queue.push(job.jobId);
    }
  }

  const persistedMedia = await loadPersistedMediaCatalog();
  for (const raw of persistedMedia) {
    const item = normalizeCatalogItem(raw);
    if (!item) {
      continue;
    }
    mediaCatalog.set(item.id, item);
  }

  cleanupJobsByRetention();
  initialized = true;
  schedulePersist();
  pumpQueue();
}

async function handleMessage(message) {
  switch (message?.type) {
    case MessageType.Ping:
      return { status: initialized ? "alive" : "initializing" };

    case MessageType.GetPlan:
      return { plan: await getPlan() };

    case MessageType.SetPlan:
      return { plan: await setPlan(message.plan) };

    case MessageType.StartDownload:
      return enqueueDownload(message.url, message.filename, message.tabId);

    case MessageType.GetJobs:
      cleanupJobsByRetention();
      return { jobs: getJobList(), retentionDays };

    case MessageType.CancelJob:
      return cancelJob(message.jobId);

    case MessageType.CleanupJobs:
      return cleanupJobsManual(message.mode);

    case MessageType.SetJobRetentionDays:
      return setJobRetentionDays(message.days);

    case MessageType.RecordMediaDetections:
      return recordMediaDetections(message);

    case MessageType.GetMediaCatalog:
      return { items: await getMediaCatalogListValidated() };

    case MessageType.ClearMediaCatalog:
      return clearMediaCatalog();

    default:
      throw new Error(`Unsupported message type: ${message?.type}`);
  }
}

async function enqueueDownload(url, filename, tabId) {
  if (!url || typeof url !== "string") {
    throw new Error("Missing download URL");
  }

  if (isBlobUrl(url)) {
    if (!Number.isInteger(tabId)) {
      throw new Error("blob_tab_missing_rescan_required");
    }

    const alive = await tabExists(tabId);
    if (!alive) {
      throw new Error("blob_tab_closed_rescan_required");
    }
  }

  const now = Date.now();
  const jobId = `job_${crypto.randomUUID()}`;
  const job = {
    jobId,
    url,
    filename: sanitizeFilename(filename),
    tabId: Number.isInteger(tabId) ? tabId : null,
    mode: null,
    status: JobStatus.Queued,
    progress: 0,
    bytesReceived: 0,
    totalBytes: 0,
    downloadId: null,
    error: null,
    errorCode: null,
    errorMessage: null,
    errorStage: null,
    createdAt: now,
    updatedAt: now
  };

  jobs.set(jobId, job);
  queue.push(jobId);
  schedulePersist();
  pumpQueue();

  return { jobId, status: job.status };
}

async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  if (isTerminalStatus(job.status)) {
    return { jobId, status: job.status };
  }

  if (job.status === JobStatus.Queued) {
    removeFromQueue(jobId);
    markJobCancelled(job);
    return { jobId, status: job.status };
  }

  if (job.status === JobStatus.Downloading && typeof job.downloadId === "number") {
    const controller = jobControllers.get(jobId);
    if (controller) {
      controller.abort();
    }

    try {
      await chrome.downloads.cancel(job.downloadId);
    } catch {
      // Ignore API errors and force local cancellation state.
    }

    markJobCancelled(job);
    return { jobId, status: job.status };
  }

  if (job.status === JobStatus.Downloading) {
    const controller = jobControllers.get(jobId);
    if (controller) {
      controller.abort();
    }

    markJobCancelled(job);
    return { jobId, status: job.status };
  }

  return { jobId, status: job.status };
}

function cleanupJobsManual(mode) {
  const effectiveMode = Object.values(CleanupMode).includes(mode) ? mode : CleanupMode.Terminal;
  let removed = 0;

  for (const [jobId, job] of jobs.entries()) {
    if (!isTerminalStatus(job.status)) {
      continue;
    }

    if (effectiveMode === CleanupMode.Completed && job.status !== JobStatus.Completed) {
      continue;
    }

    if (
      effectiveMode === CleanupMode.FailedCancelled &&
      job.status !== JobStatus.Failed &&
      job.status !== JobStatus.Cancelled
    ) {
      continue;
    }

    clearPendingPageJob(jobId);
    clearJobController(jobId);
    revokeJobBlobUrl(jobId);
    jobs.delete(jobId);
    removed += 1;
  }

  if (removed > 0) {
    schedulePersist();
  }

  return { removed, jobs: getJobList(), retentionDays };
}

async function setJobRetentionDays(days) {
  const parsed = Number(days);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RETENTION_DAYS) {
    throw new Error(`Retention days must be an integer between 0 and ${MAX_RETENTION_DAYS}`);
  }

  retentionDays = parsed;
  await chrome.storage.local.set({ [JOB_RETENTION_DAYS_KEY]: retentionDays });

  const removed = cleanupJobsByRetention();
  if (removed > 0) {
    schedulePersist();
  }

  return { retentionDays, removed, jobs: getJobList() };
}

function recordMediaDetections(payload) {
  const tabId = Number.isInteger(payload?.tabId) ? payload.tabId : null;
  const tabTitle = typeof payload?.tabTitle === "string" ? payload.tabTitle : "";
  const tabUrl = typeof payload?.tabUrl === "string" ? payload.tabUrl : "";
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (tabId == null || items.length === 0) {
    return { saved: 0, items: getMediaCatalogList() };
  }

  const now = Date.now();
  let saved = 0;

  for (const item of items) {
    const normalized = normalizeDetectedMedia(item);
    if (!normalized) {
      continue;
    }

    const id = buildCatalogId(tabId, normalized.url);
    const existing = mediaCatalog.get(id);
    const next = {
      id,
      tabId,
      tabTitle,
      tabUrl,
      kind: normalized.kind,
      title: normalized.title,
      url: normalized.url,
      filename: normalized.filename,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now
    };

    mediaCatalog.set(id, next);
    saved += 1;
  }

  trimMediaCatalog();
  schedulePersist();
  return { saved, items: getMediaCatalogList() };
}

function getMediaCatalogList() {
  return Array.from(mediaCatalog.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((item) => ({ ...item }));
}

async function getMediaCatalogListValidated() {
  const items = getMediaCatalogList();
  const blobItems = items.filter((item) => isBlobUrl(item.url));
  if (!blobItems.length) {
    return items;
  }

  let removed = 0;
  for (const item of blobItems) {
    if (!Number.isInteger(item.tabId)) {
      mediaCatalog.delete(item.id);
      removed += 1;
      continue;
    }

    const alive = await tabExists(item.tabId);
    if (!alive) {
      mediaCatalog.delete(item.id);
      removed += 1;
    }
  }

  if (removed > 0) {
    schedulePersist();
  }

  return getMediaCatalogList();
}

function clearMediaCatalog() {
  const removed = mediaCatalog.size;
  mediaCatalog.clear();
  schedulePersist();
  return { removed, items: [] };
}

function getJobList() {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({ ...job }));
}

function pumpQueue() {
  while (activeJobIds.size < MAX_CONCURRENT_DOWNLOADS && queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== JobStatus.Queued) {
      continue;
    }

    void startJob(job);
  }
}

async function startJob(job) {
  activeJobIds.add(job.jobId);
  job.status = JobStatus.Downloading;
  job.updatedAt = Date.now();
  schedulePersist();

  try {
    if (isBlobUrl(job.url)) {
      await refreshBlobUrlFromTab(job);
      job.mode = "extension-blob";
      const downloadId = await downloadBlobInsideExtension(job);
      job.downloadId = downloadId;
      job.updatedAt = Date.now();
      downloadToJob.set(downloadId, job.jobId);
      schedulePersist();
      return;
    }

    job.mode = "extension";
    const downloadId = await downloadInsideExtension(job);
    job.downloadId = downloadId;
    job.updatedAt = Date.now();
    downloadToJob.set(downloadId, job.jobId);
    schedulePersist();
  } catch (error) {
    if (job.status === JobStatus.Cancelled) {
      return;
    }

    const message = String(error?.message || error);
    if (canFallbackToPageDownload(job, message)) {
      try {
        job.mode = "page-fallback";
        await triggerPageDownload(job);
        registerPendingPageJob(job);
        return;
      } catch (fallbackError) {
        markJobFailed(
          job,
          toFailure({
            stage: "page-fallback",
            code: "page_context_download_failed",
            message: String(fallbackError?.message || fallbackError)
          })
        );
        return;
      }
    }

    markJobFailed(
      job,
      toFailure({
        stage: "start-download",
        code: "start_failed",
        message
      })
    );
  }
}

async function downloadInsideExtension(job) {
  const controller = new AbortController();
  jobControllers.set(job.jobId, controller);

  try {
    const response = await fetch(job.url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`network_${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    const knownSize = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    job.totalBytes = knownSize;
    schedulePersist();

    const chunks = [];
    let received = 0;

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          chunks.push(value);
          received += value.byteLength;
          job.bytesReceived = received;
          job.progress = knownSize > 0 ? Math.min(95, Math.round((received / knownSize) * 95)) : null;
          job.updatedAt = Date.now();
          schedulePersist();
        }
      }
    } else {
      const blob = await response.blob();
      chunks.push(new Uint8Array(await blob.arrayBuffer()));
      received = blob.size;
      job.bytesReceived = received;
      job.progress = 95;
      job.updatedAt = Date.now();
      schedulePersist();
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const blob = new Blob(chunks, { type: contentType });
    const dataUrl = await blobToDataUrl(blob);
    return await chrome.downloads.download({
      url: dataUrl,
      filename: job.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } finally {
    jobControllers.delete(job.jobId);
  }
}

async function downloadBlobInsideExtension(job) {
  if (!Number.isInteger(job.tabId)) {
    throw new Error("blob_tab_missing_rescan_required");
  }

  const controller = new AbortController();
  jobControllers.set(job.jobId, controller);

  try {
    await ensureDetectorInjected(job.tabId);
    const { blob, totalBytes } = await receiveBlobFromTab(job, controller.signal);
    job.totalBytes = totalBytes;
    job.bytesReceived = totalBytes;
    job.progress = 95;
    job.updatedAt = Date.now();
    schedulePersist();

    const dataUrl = await blobToDataUrl(blob);
    return await chrome.downloads.download({
      url: dataUrl,
      filename: job.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } finally {
    jobControllers.delete(job.jobId);
  }
}

async function receiveBlobFromTab(job, signal) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let port = null;
    let totalBytes = 0;
    let contentType = "application/octet-stream";
    const chunks = [];

    const cleanup = () => {
      if (port) {
        try {
          port.onMessage.removeListener(onMessage);
          port.onDisconnect.removeListener(onDisconnect);
          port.disconnect();
        } catch {
          // ignore
        }
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || "blob_transfer_failed")));
    };

    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        blob: new Blob(chunks, { type: contentType }),
        totalBytes: totalBytes > 0 ? totalBytes : job.bytesReceived || 0
      });
    };

    const onMessage = (message) => {
      const type = message?.type;
      if (type === "BLOB_META") {
        const size = Number(message.totalBytes);
        totalBytes = Number.isFinite(size) && size > 0 ? size : 0;
        if (typeof message.contentType === "string" && message.contentType.length > 0) {
          contentType = message.contentType;
        }

        job.totalBytes = totalBytes;
        job.updatedAt = Date.now();
        schedulePersist();
        return;
      }

      if (type === "BLOB_CHUNK") {
        const raw = message.chunk;
        let chunk = null;
        if (raw instanceof ArrayBuffer) {
          chunk = new Uint8Array(raw);
        } else if (ArrayBuffer.isView(raw)) {
          chunk = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        }

        if (!chunk) {
          return;
        }

        chunks.push(chunk);
        job.bytesReceived += chunk.byteLength;
        job.progress =
          job.totalBytes > 0 ? Math.min(95, Math.round((job.bytesReceived / job.totalBytes) * 95)) : null;
        job.updatedAt = Date.now();
        schedulePersist();
        return;
      }

      if (type === "BLOB_DONE") {
        done();
        return;
      }

      if (type === "BLOB_ERROR") {
        fail(new Error(message?.error || "blob_transfer_failed"));
      }
    };

    const onDisconnect = () => {
      if (settled) {
        return;
      }
      const reason = chrome.runtime.lastError?.message || "blob_transfer_disconnected";
      fail(new Error(reason));
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      try {
        port?.postMessage({ type: "ABORT_BLOB_TRANSFER" });
      } catch {
        // ignore
      }
      fail(new Error("download_cancelled"));
    };

    if (signal?.aborted) {
      fail(new Error("download_cancelled"));
      return;
    }

    try {
      port = chrome.tabs.connect(job.tabId, { name: BLOB_TRANSFER_PORT_NAME });
    } catch (error) {
      fail(error);
      return;
    }

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener("abort", onAbort);

    try {
      port.postMessage({
        type: "START_BLOB_TRANSFER",
        url: job.url,
        filename: job.filename,
        jobId: job.jobId
      });
    } catch (error) {
      fail(error);
    }
  });
}

async function triggerPageDownload(job) {
  if (!Number.isInteger(job.tabId)) {
    throw new Error("page_context_download_requires_tab");
  }

  const response = await sendMessageToTabWithInjection(job.tabId, {
    type: "TRIGGER_PAGE_DOWNLOAD",
    url: job.url,
    filename: job.filename
  });

  if (!response?.ok) {
    throw new Error(response?.error || "page_context_download_failed");
  }

  if (typeof response.effectiveUrl === "string" && response.effectiveUrl.length > 0) {
    job.url = response.effectiveUrl;
    job.updatedAt = Date.now();
    schedulePersist();
  }
}

async function refreshBlobUrlFromTab(job) {
  if (!Number.isInteger(job.tabId) || !isBlobUrl(job.url)) {
    return;
  }

  let response;
  try {
    response = await sendMessageToTabWithInjection(job.tabId, { type: MessageType.ScanMedia });
  } catch {
    return;
  }

  const media = Array.isArray(response?.media) ? response.media : [];
  if (!media.length) {
    return;
  }

  const normalized = media.filter((item) => item && typeof item.url === "string");
  if (!normalized.length) {
    return;
  }

  const blobItems = normalized.filter((item) => isBlobUrl(item.url));
  if (!blobItems.length) {
    return;
  }

  const bySameUrl = blobItems.find((item) => item.url === job.url);
  const byFilename =
    job.filename && blobItems.find((item) => sanitizeFilename(item.filename) === job.filename);
  const candidate = bySameUrl || byFilename || blobItems[0];
  if (!candidate?.url) {
    return;
  }

  if (candidate.url !== job.url) {
    job.url = candidate.url;
  }

  const nextFilename = sanitizeFilename(candidate.filename);
  if (nextFilename) {
    job.filename = nextFilename;
  }

  job.updatedAt = Date.now();
  schedulePersist();
}

async function sendMessageToTabWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }

    await ensureDetectorInjected(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function ensureDetectorInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/detector.js"]
  });
}

function isNoReceiverError(error) {
  const message = String(error?.message || error || "");
  const lowered = message.toLowerCase();
  return lowered.includes("receiving end does not exist") || lowered.includes("could not establish connection");
}

function markJobCompleted(job) {
  activeJobIds.delete(job.jobId);
  clearPendingPageJob(job.jobId);
  clearJobController(job.jobId);
  if (typeof job.downloadId === "number") {
    downloadToJob.delete(job.downloadId);
  }
  revokeJobBlobUrl(job.jobId);

  job.status = JobStatus.Completed;
  job.progress = 100;
  job.error = null;
  job.errorCode = null;
  job.errorMessage = null;
  job.errorStage = null;
  job.updatedAt = Date.now();
  schedulePersist();
  pumpQueue();
}

function markJobFailed(job, failureInput) {
  const failure = toFailure(failureInput);
  activeJobIds.delete(job.jobId);
  clearPendingPageJob(job.jobId);
  clearJobController(job.jobId);
  if (typeof job.downloadId === "number") {
    downloadToJob.delete(job.downloadId);
  }
  revokeJobBlobUrl(job.jobId);

  job.status = JobStatus.Failed;
  job.error = failure.code;
  job.errorCode = failure.code;
  job.errorMessage = failure.message;
  job.errorStage = failure.stage;
  job.updatedAt = Date.now();
  logJobFailure(job, failure);
  schedulePersist();
  pumpQueue();
}

function markJobCancelled(job) {
  activeJobIds.delete(job.jobId);
  clearPendingPageJob(job.jobId);
  clearJobController(job.jobId);
  if (typeof job.downloadId === "number") {
    downloadToJob.delete(job.downloadId);
  }
  revokeJobBlobUrl(job.jobId);

  job.status = JobStatus.Cancelled;
  job.error = null;
  job.errorCode = null;
  job.errorMessage = null;
  job.errorStage = null;
  job.updatedAt = Date.now();
  schedulePersist();
  pumpQueue();
}

function removeFromQueue(jobId) {
  const index = queue.indexOf(jobId);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function isTerminalStatus(status) {
  return status === JobStatus.Completed || status === JobStatus.Failed || status === JobStatus.Cancelled;
}

function normalizeLoadedJob(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.jobId !== "string") {
    return null;
  }

  const status = Object.values(JobStatus).includes(raw.status) ? raw.status : JobStatus.Failed;
  const now = Date.now();

  const job = {
    jobId: raw.jobId,
    url: typeof raw.url === "string" ? raw.url : "",
    filename: sanitizeFilename(raw.filename),
    tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
    mode: typeof raw.mode === "string" ? raw.mode : null,
    status,
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    bytesReceived: typeof raw.bytesReceived === "number" ? raw.bytesReceived : 0,
    totalBytes: typeof raw.totalBytes === "number" ? raw.totalBytes : 0,
    downloadId: typeof raw.downloadId === "number" ? raw.downloadId : null,
    error: typeof raw.error === "string" ? raw.error : null,
    errorCode: typeof raw.errorCode === "string" ? raw.errorCode : typeof raw.error === "string" ? raw.error : null,
    errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : null,
    errorStage: typeof raw.errorStage === "string" ? raw.errorStage : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now
  };

  if (job.status === JobStatus.Downloading) {
    job.status = JobStatus.Failed;
    job.error = RESTART_ERROR;
    job.errorCode = RESTART_ERROR;
    job.errorMessage = "Service worker restarted while job was downloading";
    job.errorStage = "startup-recovery";
    job.downloadId = null;
    job.updatedAt = now;
  }

  return job;
}

async function loadPersistedJobs() {
  const data = await chrome.storage.local.get(JOBS_STORAGE_KEY);
  const persisted = data[JOBS_STORAGE_KEY];
  if (!Array.isArray(persisted)) {
    return [];
  }

  return persisted;
}

async function loadPersistedMediaCatalog() {
  const data = await chrome.storage.local.get(MEDIA_CATALOG_STORAGE_KEY);
  const persisted = data[MEDIA_CATALOG_STORAGE_KEY];
  if (!Array.isArray(persisted)) {
    return [];
  }

  return persisted;
}

async function loadRetentionDays() {
  const data = await chrome.storage.local.get(JOB_RETENTION_DAYS_KEY);
  const value = Number(data[JOB_RETENTION_DAYS_KEY]);
  if (Number.isInteger(value) && value >= 0 && value <= MAX_RETENTION_DAYS) {
    return value;
  }

  await chrome.storage.local.set({ [JOB_RETENTION_DAYS_KEY]: DEFAULT_RETENTION_DAYS });
  return DEFAULT_RETENTION_DAYS;
}

function cleanupJobsByRetention() {
  if (retentionDays <= 0) {
    return 0;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const [jobId, job] of jobs.entries()) {
    if (!isTerminalStatus(job.status)) {
      continue;
    }

    const timestamp = typeof job.updatedAt === "number" ? job.updatedAt : job.createdAt;
    if (timestamp >= cutoff) {
      continue;
    }

    clearPendingPageJob(jobId);
    clearJobController(jobId);
    revokeJobBlobUrl(jobId);
    jobs.delete(jobId);
    removed += 1;
  }

  return removed;
}

function schedulePersist() {
  if (persistTimer) {
    return;
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistJobs();
  }, 120);
}

async function persistJobs() {
  const serialized = Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PERSISTED_JOBS)
    .map((job) => ({ ...job }));

  const serializedCatalog = Array.from(mediaCatalog.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_MEDIA_CATALOG_ITEMS)
    .map((item) => ({ ...item }));

  await chrome.storage.local.set({
    [JOBS_STORAGE_KEY]: serialized,
    [MEDIA_CATALOG_STORAGE_KEY]: serializedCatalog
  });
}

function sanitizeFilename(filename) {
  if (!filename || typeof filename !== "string") {
    return undefined;
  }

  return filename.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function normalizeDetectedMedia(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  if (typeof item.url !== "string" || item.url.length === 0) {
    return null;
  }

  return {
    url: item.url,
    kind: typeof item.kind === "string" ? item.kind : "media",
    title: typeof item.title === "string" ? item.title : "Untitled",
    filename: sanitizeFilename(item.filename)
  };
}

function normalizeCatalogItem(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  if (typeof raw.id !== "string" || typeof raw.url !== "string") {
    return null;
  }

  const now = Date.now();
  return {
    id: raw.id,
    tabId: Number.isInteger(raw.tabId) ? raw.tabId : -1,
    tabTitle: typeof raw.tabTitle === "string" ? raw.tabTitle : "",
    tabUrl: typeof raw.tabUrl === "string" ? raw.tabUrl : "",
    kind: typeof raw.kind === "string" ? raw.kind : "media",
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    url: raw.url,
    filename: sanitizeFilename(raw.filename),
    firstSeenAt: typeof raw.firstSeenAt === "number" ? raw.firstSeenAt : now,
    lastSeenAt: typeof raw.lastSeenAt === "number" ? raw.lastSeenAt : now
  };
}

function buildCatalogId(tabId, url) {
  return `${tabId}:${url}`;
}

function trimMediaCatalog() {
  if (mediaCatalog.size <= MAX_MEDIA_CATALOG_ITEMS) {
    return;
  }

  const ordered = Array.from(mediaCatalog.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  mediaCatalog.clear();
  for (const item of ordered.slice(0, MAX_MEDIA_CATALOG_ITEMS)) {
    mediaCatalog.set(item.id, item);
  }
}

function clearJobController(jobId) {
  const controller = jobControllers.get(jobId);
  if (!controller) {
    return;
  }

  try {
    controller.abort();
  } catch {
    // ignore
  }
  jobControllers.delete(jobId);
}

function revokeJobBlobUrl(jobId) {
  const blobUrl = jobBlobUrls.get(jobId);
  if (!blobUrl) {
    return;
  }

  try {
    URL.revokeObjectURL(blobUrl);
  } catch {
    // ignore
  }
  jobBlobUrls.delete(jobId);
}

function isBlobUrl(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function canFallbackToPageDownload(job, errorMessage) {
  if (!Number.isInteger(job.tabId)) {
    return false;
  }
  if (isBlobUrl(job.url)) {
    return false;
  }

  const msg = (errorMessage || "").toLowerCase();
  return msg.includes("network_failed") || msg.includes("network") || msg.includes("interrupted");
}

function toFailure(input) {
  if (typeof input === "string") {
    return {
      code: input || "unknown",
      message: input || "Unknown failure",
      stage: "unknown"
    };
  }

  if (!input || typeof input !== "object") {
    return {
      code: "unknown",
      message: "Unknown failure",
      stage: "unknown"
    };
  }

  return {
    code: typeof input.code === "string" ? input.code : "unknown",
    message: typeof input.message === "string" ? input.message : String(input.code || "Unknown failure"),
    stage: typeof input.stage === "string" ? input.stage : "unknown"
  };
}

function createInterruptedFailure(job, interruptedCode) {
  const rawCode =
    typeof interruptedCode === "string" && interruptedCode.length > 0 ? interruptedCode : "interrupted";
  const normalizedCode = rawCode.toUpperCase();

  if (job.mode === "page-blob" && normalizedCode === "NETWORK_FAILED") {
    return toFailure({
      stage: "browser-download",
      code: "page_blob_network_failed",
      message: "Browser could not download this blob URL. Keep the source tab open and retry from a fresh scan."
    });
  }

  return toFailure({
    stage: "browser-download",
    code: rawCode,
    message: "Browser download interrupted"
  });
}

function logJobFailure(job, failure) {
  const details = {
    jobId: job.jobId,
    stage: failure.stage,
    code: failure.code,
    message: failure.message,
    mode: job.mode || "unknown",
    url: truncateForLog(job.url, 240),
    tabId: job.tabId,
    downloadId: job.downloadId,
    bytesReceived: job.bytesReceived,
    totalBytes: job.totalBytes,
    progress: job.progress
  };

  console.error(`[MediaCapture][JobFailed] ${safeJsonStringify(details)}`);
}

function truncateForLog(text, maxLen) {
  if (typeof text !== "string") {
    return text;
  }

  if (text.length <= maxLen) {
    return text;
  }

  return `${text.slice(0, maxLen)}...`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function blobToDataUrl(blob) {
  const mime = blob.type || "application/octet-stream";
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

function registerPendingPageJob(job) {
  const requestedAt = Date.now();
  pendingPageJobs.set(job.jobId, requestedAt);
  clearPendingPageJobTimer(job.jobId);

  const timer = setTimeout(() => {
    pendingPageJobTimers.delete(job.jobId);
    const pending = pendingPageJobs.get(job.jobId);
    if (!pending) {
      return;
    }

    pendingPageJobs.delete(job.jobId);
    const liveJob = jobs.get(job.jobId);
    if (!liveJob) {
      return;
    }

    if (liveJob.status === JobStatus.Downloading && liveJob.downloadId == null) {
      markJobFailed(
        liveJob,
        toFailure({
          stage: "page-fallback",
          code: "browser_download_not_started",
          message: "Browser did not start fallback download in time"
        })
      );
    }
  }, 15000);

  pendingPageJobTimers.set(job.jobId, timer);
}

function clearPendingPageJob(jobId) {
  pendingPageJobs.delete(jobId);
  clearPendingPageJobTimer(jobId);
}

function clearPendingPageJobTimer(jobId) {
  const timer = pendingPageJobTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    pendingPageJobTimers.delete(jobId);
  }
}

function matchPendingPageJob(downloadItem) {
  const now = Date.now();
  const candidates = [];

  for (const [jobId, requestedAt] of pendingPageJobs.entries()) {
    const job = jobs.get(jobId);
    if (!job || job.status !== JobStatus.Downloading || job.downloadId != null) {
      clearPendingPageJob(jobId);
      continue;
    }

    if (now - requestedAt > 20000) {
      continue;
    }

    if (typeof downloadItem.url === "string" && downloadItem.url === job.url) {
      candidates.push({ job, score: 0 });
      continue;
    }

    // Fallback by recency when browser does not expose comparable URL.
    candidates.push({ job, score: now - requestedAt + 1000 });
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].job;
}
