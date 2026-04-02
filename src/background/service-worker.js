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
const DOWNLOAD_WORKER_PATH = "src/download-worker/main.js";

const jobs = new Map();
const queue = [];
const activeJobIds = new Set();
const downloadToJob = new Map();
const pendingPageJobs = new Map();
const pendingPageJobTimers = new Map();
const jobControllers = new Map();
const jobBlobUrls = new Map();
const mediaCatalog = new Map();
const workerPendingRequests = new Map();
const NETWORK_MEDIA_TYPES = new Set([
  "media",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-matroska",
  "video/mp2t",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml"
]);
const NETWORK_MEDIA_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "m4a",
  "mp3",
  "webm",
  "ogg",
  "ogv",
  "wav",
  "aac",
  "mov",
  "mkv",
  "ts",
  "m3u8",
  "mpd"
]);
const GENERIC_FILENAMES = new Set([
  "download",
  "video",
  "audio",
  "media",
  "file",
  "videoplayback",
  "playlist"
]);

let initialized = false;
let persistTimer = null;
let retentionDays = DEFAULT_RETENTION_DAYS;
let downloadWorker = null;
const initPromise = initializeState();

chrome.runtime.onInstalled.addListener(async () => {
  const plan = await getPlan();
  if (!plan) {
    await chrome.storage.local.set({ plan: defaultPlan });
  }
});

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    void captureNetworkMedia(details);
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "other"]
  },
  ["responseHeaders"]
);

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

async function captureNetworkMedia(details) {
  const item = normalizeNetworkMedia(details);
  if (!item) {
    return;
  }

  const tabId = details.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  let tabTitle = "";
  let tabUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitle = typeof tab?.title === "string" ? tab.title : "";
    tabUrl = typeof tab?.url === "string" ? tab.url : "";
  } catch {
    // Ignore closed tabs.
  }

  const now = Date.now();
  const id = buildCatalogId(tabId, item.url);
  const existing = mediaCatalog.get(id);
  mediaCatalog.set(id, {
    id,
    tabId,
    tabTitle,
    tabUrl,
    kind: item.kind,
    title: item.title || tabTitle || "Network media",
    url: item.url,
    filename: item.filename,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now
  });
  trimMediaCatalog();
  schedulePersist();
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

  const preferredSource = choosePreferredDownloadSource(url, tabId);
  const effectiveUrl = preferredSource?.url || url;
  const effectiveFilename = preferredSource?.filename || filename;

  if (isBlobUrl(effectiveUrl)) {
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
    url: effectiveUrl,
    filename: sanitizeFilename(effectiveFilename),
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
  const sortedItems = Array.from(mediaCatalog.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((item) => ({ ...item }));

  const preferredByTab = new Map();
  for (const item of sortedItems) {
    const existing = preferredByTab.get(item.tabId);
    if (!existing || getMediaSourcePriority(item) < getMediaSourcePriority(existing)) {
      preferredByTab.set(item.tabId, item);
    }
  }

  return sortedItems.filter((item) => {
    if (!isBlobUrl(item.url)) {
      return true;
    }

    const preferred = preferredByTab.get(item.tabId);
    return !preferred || isBlobUrl(preferred.url);
  });
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

      try {
        job.mode = "page-blob";
        await triggerPageDownload(job);
        registerPendingPageJob(job);
        return;
      } catch {
        job.mode = "extension-blob";
        const downloadId = await downloadBlobInsideExtension(job);
        job.downloadId = downloadId;
        job.updatedAt = Date.now();
        downloadToJob.set(downloadId, job.jobId);
        schedulePersist();
        return;
      }
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
    if (looksLikeHlsSource(job.url, job.filename)) {
      return await downloadM3u8InsideExtension(job, controller.signal);
    }

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
    const blobUrl = await createWorkerBlobUrl(blob);
    jobBlobUrls.set(job.jobId, blobUrl);

    return await chrome.downloads.download({
      url: blobUrl,
      filename: job.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } finally {
    jobControllers.delete(job.jobId);
  }
}

async function downloadM3u8InsideExtension(job, signal) {
  const playlist = await loadResolvedHlsPlaylist(job.url, signal);
  const segmentUrls = parseMediaPlaylistSegments(playlist.url, playlist.text);
  if (!segmentUrls.length) {
    throw new Error("hls_no_segments_found");
  }

  if (hasEncryptedSegments(playlist.text)) {
    throw new Error("hls_encrypted_not_supported");
  }

  const chunks = [];
  let received = 0;

  job.mode = "extension-hls";
  job.totalBytes = 0;
  job.bytesReceived = 0;
  job.progress = 0;
  schedulePersist();

  for (let index = 0; index < segmentUrls.length; index += 1) {
    const segmentUrl = segmentUrls[index];
    const response = await fetch(segmentUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal
    });

    if (!response.ok) {
      throw new Error(`hls_segment_network_${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    chunks.push(bytes);
    received += bytes.byteLength;

    job.bytesReceived = received;
    job.progress = Math.min(95, Math.round(((index + 1) / segmentUrls.length) * 95));
    job.updatedAt = Date.now();
    schedulePersist();
  }

  const blob = new Blob(chunks, { type: "video/mp2t" });
  const blobUrl = await createWorkerBlobUrl(blob);
  jobBlobUrls.set(job.jobId, blobUrl);
  job.totalBytes = received;
  job.bytesReceived = received;

  return await chrome.downloads.download({
    url: blobUrl,
    filename: toHlsOutputFilename(job.filename, playlist.url),
    saveAs: false,
    conflictAction: "uniquify"
  });
}

async function downloadBlobInsideExtension(job) {
  if (!Number.isInteger(job.tabId)) {
    throw new Error("blob_tab_missing_rescan_required");
  }

  const controller = new AbortController();
  jobControllers.set(job.jobId, controller);

  try {
    const { blob, totalBytes } = await receiveBlobFromPage(job, controller.signal);
    job.totalBytes = totalBytes;
    job.bytesReceived = totalBytes;
    job.progress = 95;
    job.updatedAt = Date.now();
    schedulePersist();

    const blobUrl = await createWorkerBlobUrl(blob);
    jobBlobUrls.set(job.jobId, blobUrl);

    return await chrome.downloads.download({
      url: blobUrl,
      filename: job.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } finally {
    jobControllers.delete(job.jobId);
  }
}

async function receiveBlobFromPage(job, signal) {
  try {
    return await receiveBlobFromMainWorld(job, signal);
  } catch {
    await ensureDetectorInjected(job.tabId);
    return await receiveBlobFromTab(job, signal);
  }
}

async function receiveBlobFromMainWorld(job, signal) {
  if (signal?.aborted) {
    throw new Error("download_cancelled");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: job.tabId },
    world: "MAIN",
    args: [job.url],
    func: async (url) => {
      if (!url || typeof url !== "string" || !url.startsWith("blob:")) {
        throw new Error("invalid_blob_url");
      }

      const response = await fetch(url, {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`blob_fetch_failed_${response.status}`);
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      return {
        arrayBuffer,
        totalBytes: blob.size,
        contentType: blob.type || "application/octet-stream"
      };
    }
  });

  const arrayBuffer = result?.arrayBuffer;
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error("blob_main_world_missing_buffer");
  }

  return {
    blob: new Blob([arrayBuffer], { type: result?.contentType || "application/octet-stream" }),
    totalBytes: Number(result?.totalBytes) || arrayBuffer.byteLength
  };
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

  if (isBlobUrl(job.url)) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: job.tabId },
      world: "MAIN",
      args: [job.url, job.filename],
      func: (url, filename) => {
        if (!url || typeof url !== "string") {
          throw new Error("invalid_download_url");
        }

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = typeof filename === "string" && filename.length > 0 ? filename : "media.bin";
        anchor.rel = "noopener";
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        return { effectiveUrl: url };
      }
    });

    if (!result?.effectiveUrl) {
      throw new Error("page_context_download_failed");
    }

    job.url = result.effectiveUrl;
    job.updatedAt = Date.now();
    schedulePersist();
    return;
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

  return filename
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
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
    filename: resolveDownloadFilename({
      kind: typeof item.kind === "string" ? item.kind : "media",
      title: typeof item.title === "string" ? item.title : "Untitled",
      url: item.url,
      candidate: item.filename
    })
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
    filename: resolveDownloadFilename({
      kind: typeof raw.kind === "string" ? raw.kind : "media",
      title: typeof raw.title === "string" ? raw.title : "Untitled",
      url: raw.url,
      candidate: raw.filename
    }),
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

function choosePreferredDownloadSource(url, tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  const sameTabItems = Array.from(mediaCatalog.values()).filter((item) => item.tabId === tabId);
  if (!sameTabItems.length) {
    return null;
  }

  const normalizedItems = sameTabItems
    .filter((item) => item && typeof item.url === "string")
    .sort((left, right) => {
      const scoreDiff = getMediaSourcePriority(left) - getMediaSourcePriority(right);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return right.lastSeenAt - left.lastSeenAt;
    });

  if (typeof url === "string" && !isBlobUrl(url)) {
    const exact = normalizedItems.find((item) => item.url === url);
    return exact || null;
  }

  const preferred = normalizedItems.find((item) => !isBlobUrl(item.url) && getMediaSourcePriority(item) < 90);
  return preferred || null;
}

function getMediaSourcePriority(item) {
  switch (item?.kind) {
    case "hls":
      return 0;
    case "dash":
      return 1;
    case "video":
      return 2;
    case "audio":
      return 3;
    case "source":
      return 4;
    case "media":
      return 5;
    default:
      return isBlobUrl(item?.url) ? 99 : 50;
  }
}

function normalizeNetworkMedia(details) {
  if (!details || typeof details.url !== "string" || details.url.length === 0) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(details.url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }

  const contentType = getHeaderValue(details.responseHeaders, "content-type");
  const disposition = getHeaderValue(details.responseHeaders, "content-disposition");
  const pathnameTail = parsedUrl.pathname.split("/").pop() || "";
  const extension = getPathExtension(pathnameTail);
  const normalizedType = normalizeMime(contentType);
  const looksLikeMedia =
    details.type === "media" ||
    NETWORK_MEDIA_TYPES.has(normalizedType) ||
    NETWORK_MEDIA_EXTENSIONS.has(extension);

  if (!looksLikeMedia) {
    return null;
  }

  const filename =
    resolveDownloadFilename({
      kind: inferKind(normalizedType, extension),
      title: decodeURIComponentSafe(pathnameTail) || parsedUrl.hostname,
      url: parsedUrl.href,
      candidate:
        sanitizeFilename(extractFilenameFromContentDisposition(disposition)) ||
        sanitizeFilename(decodeURIComponentSafe(pathnameTail)) ||
        sanitizeFilename(buildFilenameFromUrl(parsedUrl, normalizedType, extension))
    }) || sanitizeFilename(`media-${Date.now()}`);

  return {
    url: parsedUrl.href,
    kind: inferKind(normalizedType, extension),
    title: filename,
    filename
  };
}

function looksLikeHlsSource(url, filename) {
  const candidates = [url, filename].filter((value) => typeof value === "string" && value.length > 0);
  return candidates.some((value) => {
    const lowered = value.toLowerCase();
    return lowered.includes(".m3u8") || lowered.includes("mpegurl");
  });
}

async function loadResolvedHlsPlaylist(entryUrl, signal) {
  const firstPlaylist = await fetchPlaylistText(entryUrl, signal);
  if (!isMasterPlaylist(firstPlaylist.text)) {
    return firstPlaylist;
  }

  const variantUrl = selectPreferredHlsVariant(firstPlaylist.url, firstPlaylist.text);
  if (!variantUrl) {
    throw new Error("hls_master_without_variant");
  }

  return await fetchPlaylistText(variantUrl, signal);
}

async function fetchPlaylistText(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(`hls_playlist_network_${response.status}`);
  }

  return {
    url: response.url || url,
    text: await response.text()
  };
}

function isMasterPlaylist(text) {
  return typeof text === "string" && text.includes("#EXT-X-STREAM-INF");
}

function selectPreferredHlsVariant(baseUrl, text) {
  const lines = splitPlaylistLines(text);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.startsWith("#")) {
      continue;
    }

    variants.push({
      url: toAbsolutePlaylistUrl(baseUrl, nextLine),
      bandwidth: parseHlsBandwidth(line)
    });
  }

  if (!variants.length) {
    return null;
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0].url;
}

function parseHlsBandwidth(streamInfLine) {
  const match = streamInfLine.match(/BANDWIDTH=(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function parseMediaPlaylistSegments(baseUrl, text) {
  const lines = splitPlaylistLines(text);
  const segments = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseHlsAttributeList(line.slice("#EXT-X-MAP:".length));
      if (attributes.URI) {
        segments.push(toAbsolutePlaylistUrl(baseUrl, attributes.URI));
      }
      continue;
    }

    if (!line || line.startsWith("#")) {
      continue;
    }

    segments.push(toAbsolutePlaylistUrl(baseUrl, line));
  }

  return segments;
}

function splitPlaylistLines(text) {
  if (typeof text !== "string") {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function toAbsolutePlaylistUrl(baseUrl, path) {
  return new URL(path, baseUrl).href;
}

function hasEncryptedSegments(text) {
  if (typeof text !== "string") {
    return false;
  }

  return text
    .split(/\r?\n/)
    .some((line) => line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/i.test(line));
}

function parseHlsAttributeList(value) {
  const attributes = {};
  if (typeof value !== "string" || value.length === 0) {
    return attributes;
  }

  const matches = value.match(/([A-Z0-9-]+)=((\"[^\"]*\")|[^,]+)/gi) || [];
  for (const match of matches) {
    const separatorIndex = match.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = match.slice(0, separatorIndex).trim();
    const raw = match.slice(separatorIndex + 1).trim();
    attributes[key] = raw.replace(/^"|"$/g, "");
  }

  return attributes;
}

function toHlsOutputFilename(filename, playlistUrl) {
  const preferred =
    resolveDownloadFilename({
      kind: "hls",
      title: filename || filenameFromUrl(playlistUrl) || "stream",
      url: playlistUrl,
      candidate: filename
    }) || "stream.ts";
  return sanitizeFilename(stripPlaylistSuffix(preferred)) || "stream.ts";
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponentSafe(parsed.pathname.split("/").pop() || "");
  } catch {
    return "";
  }
}

function replaceFilenameExtension(filename, nextExtension) {
  if (typeof filename !== "string" || filename.length === 0) {
    return `media.${nextExtension}`;
  }

  const normalizedExtension = String(nextExtension || "bin").replace(/^\.+/, "");
  const withoutQuery = filename.split("?")[0];
  const nextName = withoutQuery.replace(/\.[^./]+$/, "");
  return `${nextName || "media"}.${normalizedExtension}`;
}

function stripPlaylistSuffix(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    return "stream.ts";
  }

  let next = filename.split("?")[0];
  next = next.replace(/\.m3u8$/i, "");
  next = next.replace(/\.mpd$/i, "");
  next = next.replace(/\.(mp4|m4v|webm|mov|mkv)\.(m3u8|mpd)$/i, ".$1");

  if (!/\.(ts|mp4|m4v|webm|mov|mkv)$/i.test(next)) {
    next = `${next}.ts`;
  } else if (!/\.ts$/i.test(next)) {
    next = replaceFilenameExtension(next, "ts");
  }

  return next;
}

function resolveDownloadFilename({ kind, title, url, candidate }) {
  const normalizedKind = typeof kind === "string" ? kind : "media";
  const ext = getPreferredExtensionForKind(normalizedKind, url);
  const options = [
    sanitizeFilename(candidate),
    sanitizeFilename(filenameFromUrl(url)),
    sanitizeFilename(titleToFilename(title)),
    sanitizeFilename(`media-${Date.now()}`)
  ].filter(Boolean);

  const preferred = options.find((value) => !isGenericFilename(value)) || options[0];
  if (!preferred) {
    return undefined;
  }

  return ensureFilenameExtension(preferred, ext);
}

function titleToFilename(title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    return "";
  }

  return title
    .replace(/\s*[|_-]\s*[^|_-]+$/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim();
}

function isGenericFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    return true;
  }

  const withoutExtension = filename.replace(/\.[^./]+$/, "").trim().toLowerCase();
  return GENERIC_FILENAMES.has(withoutExtension);
}

function ensureFilenameExtension(filename, extension) {
  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    return undefined;
  }

  const normalizedExtension = String(extension || "").replace(/^\.+/, "").toLowerCase();
  if (!normalizedExtension) {
    return safeName;
  }

  if (safeName.toLowerCase().endsWith(`.${normalizedExtension}`)) {
    return safeName;
  }

  return replaceFilenameExtension(safeName, normalizedExtension);
}

function getPreferredExtensionForKind(kind, url) {
  const fromUrl = getPathExtension(filenameFromUrl(url));
  if (kind === "hls") {
    return "ts";
  }
  if (kind === "dash") {
    return fromUrl || "mp4";
  }
  if (kind === "video") {
    return fromUrl || "mp4";
  }
  if (kind === "audio") {
    return fromUrl || "mp3";
  }
  return fromUrl || "";
}

function getHeaderValue(headers, name) {
  if (!Array.isArray(headers)) {
    return "";
  }

  const loweredName = name.toLowerCase();
  const match = headers.find((header) => String(header?.name || "").toLowerCase() === loweredName);
  return typeof match?.value === "string" ? match.value : "";
}

function normalizeMime(contentType) {
  if (typeof contentType !== "string") {
    return "";
  }

  return contentType.split(";")[0].trim().toLowerCase();
}

function getPathExtension(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    return "";
  }

  const clean = filename.split("?")[0];
  const parts = clean.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function extractFilenameFromContentDisposition(disposition) {
  if (typeof disposition !== "string" || disposition.length === 0) {
    return "";
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponentSafe(utf8Match[1]);
  }

  const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
  return basicMatch?.[1] || "";
}

function decodeURIComponentSafe(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildFilenameFromUrl(url, normalizedType, extension) {
  const inferredExtension = extension || getExtensionFromMime(normalizedType) || "bin";
  const baseName = url.hostname.replace(/[\\/:*?"<>|]+/g, "_");
  return `${baseName}-${Date.now()}.${inferredExtension}`;
}

function getExtensionFromMime(normalizedType) {
  switch (normalizedType) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/ogg":
      return "ogv";
    case "video/quicktime":
      return "mov";
    case "video/x-matroska":
      return "mkv";
    case "video/mp2t":
      return "ts";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "application/vnd.apple.mpegurl":
    case "application/x-mpegurl":
      return "m3u8";
    case "application/dash+xml":
      return "mpd";
    default:
      return "";
  }
}

function inferKind(normalizedType, extension) {
  if (normalizedType.startsWith("audio/")) {
    return "audio";
  }

  if (
    normalizedType === "application/vnd.apple.mpegurl" ||
    normalizedType === "application/x-mpegurl" ||
    extension === "m3u8"
  ) {
    return "hls";
  }

  if (normalizedType === "application/dash+xml" || extension === "mpd") {
    return "dash";
  }

  return "video";
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

  void revokeWorkerBlobUrl(blobUrl);
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

  if ((job.mode === "page-blob" || job.mode === "extension-blob") && normalizedCode === "NETWORK_FAILED") {
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

async function createWorkerBlobUrl(blob) {
  if (typeof Worker === "undefined") {
    return await blobToDataUrl(blob);
  }

  const mime = blob.type || "application/octet-stream";
  const arrayBuffer = await blob.arrayBuffer();
  const result = await callDownloadWorker(
    {
      type: "CREATE_BLOB_URL",
      mime,
      arrayBuffer
    },
    [arrayBuffer]
  );

  if (!result?.blobUrl || typeof result.blobUrl !== "string") {
    throw new Error("worker_blob_url_missing");
  }

  return result.blobUrl;
}

async function revokeWorkerBlobUrl(blobUrl) {
  if (!blobUrl || typeof blobUrl !== "string") {
    return;
  }

  // data: URLs do not need explicit revocation.
  if (blobUrl.startsWith("data:")) {
    return;
  }

  if (typeof Worker === "undefined") {
    return;
  }

  try {
    await callDownloadWorker({ type: "REVOKE_BLOB_URL", blobUrl });
  } catch {
    // ignore cleanup errors
  }
}

function getDownloadWorker() {
  if (typeof Worker === "undefined") {
    throw new Error("worker_api_unavailable");
  }

  if (downloadWorker) {
    return downloadWorker;
  }

  const workerUrl = chrome.runtime.getURL(DOWNLOAD_WORKER_PATH);
  downloadWorker = new Worker(workerUrl, { type: "module" });
  downloadWorker.addEventListener("message", (event) => {
    const message = event.data || {};
    const requestId = message.requestId;
    if (!requestId || !workerPendingRequests.has(requestId)) {
      return;
    }

    const pending = workerPendingRequests.get(requestId);
    workerPendingRequests.delete(requestId);
    clearTimeout(pending.timeoutId);

    if (message.ok) {
      pending.resolve(message.result || null);
      return;
    }

    pending.reject(new Error(message.error || "download_worker_error"));
  });

  downloadWorker.addEventListener("error", (event) => {
    const reason = event?.message || "download_worker_crashed";
    for (const pending of workerPendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    workerPendingRequests.clear();
    downloadWorker = null;
  });

  return downloadWorker;
}

async function callDownloadWorker(payload, transfer = []) {
  const worker = getDownloadWorker();
  const requestId = `dw_${crypto.randomUUID()}`;

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      workerPendingRequests.delete(requestId);
      reject(new Error("download_worker_timeout"));
    }, 120000);

    workerPendingRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      worker.postMessage({ requestId, payload }, transfer);
    } catch (error) {
      clearTimeout(timeoutId);
      workerPendingRequests.delete(requestId);
      reject(error);
    }
  });
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
