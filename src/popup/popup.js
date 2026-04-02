import { MessageType } from "../shared/messages.js";

const planSelect = document.getElementById("plan");
const savePlanButton = document.getElementById("save-plan");
const planStatus = document.getElementById("plan-status");
const scanButton = document.getElementById("scan");
const clearMediaButton = document.getElementById("clear-media");
const scanStatus = document.getElementById("scan-status");
const mediaList = document.getElementById("media-list");
const refreshJobsButton = document.getElementById("refresh-jobs");
const clearCompletedButton = document.getElementById("clear-completed");
const clearFailedCancelledButton = document.getElementById("clear-failed-cancelled");
const clearTerminalButton = document.getElementById("clear-terminal");
const retentionDaysInput = document.getElementById("retention-days");
const saveRetentionButton = document.getElementById("save-retention");
const jobsStatus = document.getElementById("jobs-status");
const jobList = document.getElementById("job-list");

await loadPlan();
await refreshJobs();
await refreshMediaCatalog();
await scanCurrentTab();

const jobRefreshInterval = setInterval(() => {
  void refreshJobs();
}, 1200);

const autoScanInterval = setInterval(() => {
  void scanCurrentTab({ silent: true });
}, 4000);

window.addEventListener("unload", () => {
  clearInterval(jobRefreshInterval);
  clearInterval(autoScanInterval);
});

savePlanButton.addEventListener("click", async () => {
  const plan = planSelect.value;
  const response = await chrome.runtime.sendMessage({ type: MessageType.SetPlan, plan });

  if (!response?.ok) {
    planStatus.textContent = `Error: ${response?.error || "unknown"}`;
    return;
  }

  planStatus.textContent = `Plan saved: ${response.result.plan}`;
});

scanButton.addEventListener("click", async () => {
  await scanCurrentTab({ silent: false });
});

clearMediaButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MessageType.ClearMediaCatalog });
  if (!response?.ok) {
    scanStatus.textContent = `Could not clear media: ${response?.error || "unknown"}`;
    return;
  }

  scanStatus.textContent = `Cleared ${response.result.removed} saved media item(s)`;
  renderMediaCatalog([]);
});

refreshJobsButton.addEventListener("click", async () => {
  await refreshJobs();
});

clearCompletedButton.addEventListener("click", async () => {
  await cleanupJobs("completed");
});

clearFailedCancelledButton.addEventListener("click", async () => {
  await cleanupJobs("failed_cancelled");
});

clearTerminalButton.addEventListener("click", async () => {
  await cleanupJobs("terminal");
});

saveRetentionButton.addEventListener("click", async () => {
  const days = Number(retentionDaysInput.value);
  const response = await chrome.runtime.sendMessage({
    type: MessageType.SetJobRetentionDays,
    days
  });

  if (!response?.ok) {
    jobsStatus.textContent = `Retention error: ${response?.error || "unknown"}`;
    return;
  }

  jobsStatus.textContent = `Retention set to ${response.result.retentionDays} day(s), removed ${response.result.removed}`;
  renderJobs(response.result.jobs || []);
});

async function loadPlan() {
  const response = await chrome.runtime.sendMessage({ type: MessageType.GetPlan });
  if (response?.ok) {
    planSelect.value = response.result.plan;
    planStatus.textContent = `Current plan: ${response.result.plan}`;
  } else {
    planStatus.textContent = "Could not read plan";
  }
}

function renderMediaCatalog(items) {
  mediaList.innerHTML = "";

  for (const item of items) {
    const isBlob = typeof item.url === "string" && item.url.startsWith("blob:");
    const li = document.createElement("li");
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title || "Untitled";
    titleRow.appendChild(title);

    if (isBlob) {
      const blobBadge = document.createElement("span");
      blobBadge.className = "blob-badge";
      blobBadge.textContent = "blob";
      titleRow.appendChild(blobBadge);
    }

    const source = document.createElement("div");
    source.className = "meta";
    const where = item.tabTitle ? `Tab: ${item.tabTitle}` : `Tab #${item.tabId}`;
    source.textContent = `${where}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${item.kind} - ${item.url}`;

    const button = document.createElement("button");
    button.className = "download";
    button.textContent = isBlob ? "Queue Blob Download" : "Queue Download";
    button.addEventListener("click", async () => {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.StartDownload,
        url: item.url,
        filename: item.filename,
        tabId: item.tabId
      });

      if (!response?.ok) {
        scanStatus.textContent = `Download error: ${response?.error || "unknown"}`;
        return;
      }

      scanStatus.textContent = `Job queued (${response.result.jobId})`;
      await refreshJobs();
    });

    li.append(titleRow, source, meta, button);
    mediaList.appendChild(li);
  }
}

async function refreshMediaCatalog() {
  const response = await chrome.runtime.sendMessage({ type: MessageType.GetMediaCatalog });
  if (!response?.ok) {
    scanStatus.textContent = `Could not load saved media: ${response?.error || "unknown"}`;
    return;
  }

  const items = response.result.items || [];
  if (!items.length) {
    scanStatus.textContent = "No saved media yet";
    renderMediaCatalog([]);
    return;
  }

  scanStatus.textContent = `${items.length} saved media item(s) across tabs`;
  renderMediaCatalog(items);
}

async function scanCurrentTab(options = { silent: false }) {
  const { silent } = options;
  if (!silent) {
    scanStatus.textContent = "Scanning current tab...";
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    if (!silent) {
      scanStatus.textContent = "No active tab found";
    }
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: MessageType.ScanMedia });
  } catch {
    if (!silent) {
      scanStatus.textContent = "Content script unavailable on this page";
    }
    return;
  }

  const items = response?.media || [];
  if (!items.length) {
    if (!silent) {
      scanStatus.textContent = "No media found in this tab";
    }
    await refreshMediaCatalog();
    return;
  }

  const recordResponse = await chrome.runtime.sendMessage({
    type: MessageType.RecordMediaDetections,
    tabId: tab.id,
    tabTitle: tab.title || "",
    tabUrl: tab.url || "",
    items
  });

  if (!recordResponse?.ok) {
    if (!silent) {
      scanStatus.textContent = `Failed to save media: ${recordResponse?.error || "unknown"}`;
    }
    return;
  }

  const catalogItems = recordResponse.result.items || [];
  scanStatus.textContent = `${items.length} found now | ${catalogItems.length} saved across tabs`;
  renderMediaCatalog(catalogItems);
}

async function refreshJobs() {
  const response = await chrome.runtime.sendMessage({ type: MessageType.GetJobs });
  if (!response?.ok) {
    jobsStatus.textContent = `Could not load jobs: ${response?.error || "unknown"}`;
    return;
  }

  const jobs = response.result.jobs || [];
  const retentionDays = response.result.retentionDays;
  retentionDaysInput.value = String(retentionDays);

  if (!jobs.length) {
    jobsStatus.textContent = `No jobs yet (retention: ${retentionDays} day(s))`;
    jobList.innerHTML = "";
    return;
  }

  jobsStatus.textContent = `${jobs.length} job(s) | retention: ${retentionDays} day(s)`;
  renderJobs(jobs);
}

async function cleanupJobs(mode) {
  const response = await chrome.runtime.sendMessage({
    type: MessageType.CleanupJobs,
    mode
  });

  if (!response?.ok) {
    jobsStatus.textContent = `Cleanup failed: ${response?.error || "unknown"}`;
    return;
  }

  jobsStatus.textContent = `Removed ${response.result.removed} job(s)`;
  renderJobs(response.result.jobs || []);
}

function renderJobs(jobs) {
  jobList.innerHTML = "";

  for (const job of jobs) {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "job-head";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = job.filename || "download";

    const status = document.createElement("span");
    status.className = `pill ${job.status}`;
    status.textContent = job.status;

    head.append(title, status);

    const meta = document.createElement("div");
    meta.className = "meta";
    const progress = job.progress == null ? "n/a" : `${job.progress}%`;
    const mode = job.mode || "unknown";
    meta.textContent = `Progress: ${progress} | Mode: ${mode} | Job: ${job.jobId}`;

    const progressWrap = document.createElement("div");
    progressWrap.className = "progress-wrap";

    const progressTrack = document.createElement("div");
    progressTrack.className = "progress-track";

    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    const progressValue = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Number(job.progress))) : 0;
    progressFill.style.width = `${progressValue}%`;
    if (job.status === "failed" || job.status === "cancelled") {
      progressFill.classList.add("is-error");
    }
    if (job.status === "completed") {
      progressFill.classList.add("is-done");
    }
    progressTrack.appendChild(progressFill);

    const progressText = document.createElement("div");
    progressText.className = "progress-text";
    progressText.textContent = `${progressValue}%`;

    progressWrap.append(progressTrack, progressText);
    li.append(head, meta, progressWrap);

    if (job.error) {
      const error = document.createElement("div");
      error.className = "meta";
      const readable = formatJobError(job);
      const stage = job.errorStage || "unknown";
      const code = job.errorCode || job.error || "unknown";
      error.textContent = `Error: ${readable} (stage=${stage}, code=${code})`;
      li.append(error);

      const reportActions = document.createElement("div");
      reportActions.className = "job-actions";
      const copyReport = document.createElement("button");
      copyReport.className = "btn secondary";
      copyReport.textContent = "Copy Report";
      copyReport.addEventListener("click", async () => {
        const report = buildFailureReport(job);
        const copied = await copyText(JSON.stringify(report, null, 2));
        if (copied) {
          jobsStatus.textContent = `Failure report copied for ${job.jobId}`;
        } else {
          jobsStatus.textContent = `Could not copy report for ${job.jobId}`;
        }
      });
      reportActions.appendChild(copyReport);
      li.append(reportActions);
    }

    if (job.status === "queued" || job.status === "downloading") {
      const actions = document.createElement("div");
      actions.className = "job-actions";

      const cancel = document.createElement("button");
      cancel.className = "btn danger";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        const response = await chrome.runtime.sendMessage({
          type: MessageType.CancelJob,
          jobId: job.jobId
        });

        if (!response?.ok) {
          jobsStatus.textContent = `Cancel failed: ${response?.error || "unknown"}`;
          return;
        }

        jobsStatus.textContent = `Cancelled ${job.jobId}`;
        await refreshJobs();
      });

      actions.appendChild(cancel);
      li.append(actions);
    }

    jobList.appendChild(li);
  }
}

function formatJobError(job) {
  const code = (job.errorCode || job.error || "").toLowerCase();
  const message = job.errorMessage || "";

  if (code.includes("page_blob_network_failed")) {
    return "Browser could not read this blob anymore. Keep the source tab open and run Scan again";
  }

  if (code.includes("network_failed") || code.includes("network_")) {
    return "Network failure while fetching media";
  }

  if (code.includes("blob_tab_closed_rescan_required")) {
    return "Original tab for this blob is closed. Scan again in the active tab";
  }

  if (code.includes("blob_tab_missing_rescan_required")) {
    return "Blob source tab is missing. Scan again before downloading";
  }

  if (code.includes("browser_download_not_started")) {
    return "Browser did not start download";
  }

  if (code.includes("page_context_download_failed")) {
    return "Fallback download in page context failed";
  }

  if (code.includes("service_worker_restarted")) {
    return "Service worker restarted during download";
  }

  if (code.includes("interrupted")) {
    return "Browser interrupted the download";
  }

  return message || job.error || "Unknown error";
}

function buildFailureReport(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    mode: job.mode || "unknown",
    stage: job.errorStage || "unknown",
    code: job.errorCode || job.error || "unknown",
    message: job.errorMessage || formatJobError(job),
    url: job.url || null,
    tabId: Number.isInteger(job.tabId) ? job.tabId : null,
    bytesReceived: job.bytesReceived ?? null,
    totalBytes: job.totalBytes ?? null,
    progress: job.progress ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    generatedAt: Date.now()
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
