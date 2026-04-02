(() => {
  if (globalThis.__mediaCaptureDetectorLoaded) {
    return;
  }
  globalThis.__mediaCaptureDetectorLoaded = true;

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
    const title = guessTitle();

    const addCandidate = (url, kind = "media", filenameHint) => {
      const absolute = toAbsoluteUrl(url);
      if (!absolute || seen.has(absolute)) {
        return;
      }

      seen.add(absolute);
      results.push({
        url: absolute,
        kind,
        title,
        filename: buildFilename(filenameHint || kind, absolute)
      });
    };

    for (const el of document.querySelectorAll("video, audio")) {
      const src = el.currentSrc || el.src;
      addCandidate(src, el.tagName.toLowerCase(), el.getAttribute("data-title"));
    }

    for (const el of document.querySelectorAll("source[src]")) {
      addCandidate(el.getAttribute("src"), "source");
    }

    for (const entry of getPerformanceResourceUrls()) {
      addCandidate(entry.url, entry.kind);
    }

    for (const scriptText of getInlineScriptTexts()) {
      for (const match of extractMediaUrlsFromText(scriptText)) {
        addCandidate(match.url, match.kind);
      }
    }

    return sortDetectedMedia(results);
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

  function getPerformanceResourceUrls() {
    if (typeof performance?.getEntriesByType !== "function") {
      return [];
    }

    return performance
      .getEntriesByType("resource")
      .map((entry) => ({
        url: entry?.name,
        kind: inferKindFromUrl(entry?.name)
      }))
      .filter((entry) => entry.kind !== null);
  }

  function getInlineScriptTexts() {
    return Array.from(document.scripts)
      .map((script) => script.textContent || "")
      .filter(Boolean)
      .slice(0, 200);
  }

  function extractMediaUrlsFromText(text) {
    if (typeof text !== "string" || text.length === 0) {
      return [];
    }

    const matches = [];
    const pattern = /https?:\/\/[^"'`\s\\]+/g;
    for (const rawMatch of text.match(pattern) || []) {
      const cleaned = rawMatch.replace(/[),.;]+$/g, "");
      const kind = inferKindFromUrl(cleaned);
      if (!kind) {
        continue;
      }

      matches.push({ url: cleaned, kind });
    }

    return matches;
  }

  function inferKindFromUrl(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }

    const lowered = url.toLowerCase();
    if (lowered.startsWith("blob:")) {
      return "blob";
    }
    if (lowered.includes(".m3u8")) {
      return "hls";
    }
    if (lowered.includes(".mpd")) {
      return "dash";
    }
    if (/\.(mp4|m4v|webm|mov|mkv)([?#]|$)/.test(lowered)) {
      return "video";
    }
    if (/\.(mp3|m4a|aac|ogg|wav)([?#]|$)/.test(lowered)) {
      return "audio";
    }
    return null;
  }

  function sortDetectedMedia(items) {
    const priority = {
      hls: 0,
      dash: 1,
      video: 2,
      audio: 3,
      source: 4,
      video_tag: 5,
      audio_tag: 6,
      blob: 7
    };

    return [...items].sort((left, right) => {
      const leftPriority = priority[normalizePriorityKind(left.kind)] ?? 99;
      const rightPriority = priority[normalizePriorityKind(right.kind)] ?? 99;
      return leftPriority - rightPriority;
    });
  }

  function normalizePriorityKind(kind) {
    if (kind === "video") {
      return "video";
    }
    if (kind === "audio") {
      return "audio";
    }
    if (kind === "source") {
      return "source";
    }
    if (kind === "blob") {
      return "blob";
    }
    return kind;
  }

  async function triggerPageDownload(url, filename) {
    if (!url || typeof url !== "string") {
      throw new Error("invalid download url");
    }

    const downloadUrl = url;

    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = typeof filename === "string" ? filename : "media.bin";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

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
})();
