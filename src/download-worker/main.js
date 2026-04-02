const workerBlobUrls = new Set();

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  const requestId = message.requestId;
  const payload = message.payload || {};

  if (!requestId) {
    return;
  }

  try {
    const result = await handlePayload(payload);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: String(error?.message || error || "download_worker_error")
    });
  }
});

async function handlePayload(payload) {
  const type = payload?.type;
  if (type === "CREATE_BLOB_URL") {
    return createBlobUrl(payload);
  }

  if (type === "REVOKE_BLOB_URL") {
    return revokeBlobUrl(payload);
  }

  throw new Error(`unsupported_worker_message:${type}`);
}

function createBlobUrl(payload) {
  const arrayBuffer = payload?.arrayBuffer;
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error("create_blob_url_missing_buffer");
  }

  const mime = typeof payload?.mime === "string" && payload.mime.length > 0 ? payload.mime : "application/octet-stream";
  const blob = new Blob([arrayBuffer], { type: mime });
  const blobUrl = URL.createObjectURL(blob);
  workerBlobUrls.add(blobUrl);

  return {
    blobUrl,
    size: blob.size,
    mime
  };
}

function revokeBlobUrl(payload) {
  const blobUrl = payload?.blobUrl;
  if (typeof blobUrl !== "string" || blobUrl.length === 0) {
    return { revoked: false };
  }

  if (!workerBlobUrls.has(blobUrl)) {
    return { revoked: false };
  }

  try {
    URL.revokeObjectURL(blobUrl);
  } catch {
    // ignore revoke errors
  }
  workerBlobUrls.delete(blobUrl);
  return { revoked: true };
}
