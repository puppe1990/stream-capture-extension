const MessageType = {
  ScanMedia: "SCAN_MEDIA",
  TriggerPageDownload: "TRIGGER_PAGE_DOWNLOAD"
};
const BlobTransferPortName = "MEDIA_CAPTURE_BLOB_TRANSFER";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MessageType.ScanMedia) {
    const media = detectMedia();
    sendResponse({ ok: true, media });
    return;
  }

  if (message?.type === MessageType.TriggerPageDownload) {
    void triggerPageDownload(message.url, message.filename)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BlobTransferPortName) {
    return;
  }

  let aborted = false;
  port.onDisconnect.addListener(() => {
    aborted = true;
  });

  port.onMessage.addListener((message) => {
    if (message?.type === "ABORT_BLOB_TRANSFER") {
      aborted = true;
      return;
    }

    if (message?.type !== "START_BLOB_TRANSFER") {
      return;
    }

    void streamBlobToExtensionPort(port, message, () => aborted);
  });
});

function detectMedia() {
  const results = [];
  const seen = new Set();

  for (const el of document.querySelectorAll("video, audio")) {
    const src = el.currentSrc || el.src;
    if (!src || seen.has(src)) {
      continue;
    }

    seen.add(src);
    results.push({
      url: src,
      kind: el.tagName.toLowerCase(),
      title: guessTitle(),
      filename: buildFilename(el.tagName.toLowerCase(), src)
    });
  }

  for (const el of document.querySelectorAll("source[src]")) {
    const src = el.getAttribute("src");
    if (!src) {
      continue;
    }

    const absolute = toAbsoluteUrl(src);
    if (!absolute || seen.has(absolute)) {
      continue;
    }

    seen.add(absolute);
    results.push({
      url: absolute,
      kind: "source",
      title: guessTitle(),
      filename: buildFilename("media", absolute)
    });
  }

  return results;
}

function guessTitle() {
  const title = document.title?.trim();
  return title || "untitled";
}

function toAbsoluteUrl(url) {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return null;
  }
}

function buildFilename(kind, url) {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  const tail = parsed ? parsed.pathname.split("/").pop() : "";
  const base = tail || `${kind}-${Date.now()}`;
  return base.replace(/[\\/:*?"<>|]+/g, "_");
}

async function triggerPageDownload(url, filename) {
  if (!url || typeof url !== "string") {
    throw new Error("invalid download url");
  }

  let downloadUrl = url;
  let transientBlobUrl = null;

  // Blob URLs can be revoked quickly. Try clone first; fallback to original URL.
  if (url.startsWith("blob:")) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`blob_fetch_failed_${response.status}`);
      }

      const blob = await response.blob();
      transientBlobUrl = URL.createObjectURL(blob);
      downloadUrl = transientBlobUrl;
    } catch {
      downloadUrl = url;
    }
  }

  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = typeof filename === "string" ? filename : "media.bin";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  if (transientBlobUrl) {
    // Keep URL alive briefly so browser can start the download stream.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(transientBlobUrl);
      } catch {
        // ignore
      }
    }, 30000);
  }

  return { effectiveUrl: downloadUrl };
}

async function streamBlobToExtensionPort(port, message, isAborted) {
  const url = message?.url;
  if (!url || typeof url !== "string" || !url.startsWith("blob:")) {
    port.postMessage({ type: "BLOB_ERROR", error: "invalid_blob_url" });
    return;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`blob_fetch_failed_${response.status}`);
    }

    const blob = await response.blob();
    port.postMessage({
      type: "BLOB_META",
      totalBytes: blob.size,
      contentType: blob.type || "application/octet-stream"
    });

    if (typeof blob.stream === "function") {
      const reader = blob.stream().getReader();
      while (true) {
        if (isAborted()) {
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!value || value.byteLength === 0) {
          continue;
        }

        const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        port.postMessage({ type: "BLOB_CHUNK", chunk });
      }
    } else {
      const chunk = await blob.arrayBuffer();
      if (!isAborted()) {
        port.postMessage({ type: "BLOB_CHUNK", chunk });
      }
    }

    if (!isAborted()) {
      port.postMessage({ type: "BLOB_DONE" });
    }
  } catch (error) {
    if (!isAborted()) {
      port.postMessage({
        type: "BLOB_ERROR",
        error: String(error?.message || error || "blob_transfer_failed")
      });
    }
  }
}
