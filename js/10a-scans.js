// Original scanner files live in IndexedDB. Feature records contain metadata only.
let currentScans = [],
  scanDbPromise = null,
  scanImportBusy = false,
  scanImportCancelled = false;
let scanViewerFocus = null,
  scanViewer = null,
  scanViewerModule = null,
  scanViewerToken = 0,
  scanOpenRecord = null;
const SCAN_MAX_BYTES = 64 * 1024 * 1024;
function scanDb() {
  if (scanDbPromise) return scanDbPromise;
  scanDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Scan storage is unavailable."));
      return;
    }
    const r = indexedDB.open("plotedge-scans", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("Cannot open scan storage."));
    r.onblocked = () =>
      reject(new Error("Close other PlotEdge tabs and try again."));
  }).catch((e) => {
    scanDbPromise = null;
    throw e;
  });
  return scanDbPromise;
}
async function scanFileGet(id) {
  const db = await scanDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("files").objectStore("files").get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function scanFilePut(id, blob) {
  const db = await scanDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(blob, id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error("Scan could not be saved."));
  });
}
function newScanId() {
  return (
    "scan_" +
    (crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + "_" + Math.random().toString(36).slice(2))
  );
}
async function scanDigest(blob) {
  if (!crypto.subtle) return null;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function scanNativePlugin() {
  const c = window.Capacitor;
  if (!c || !c.isNativePlatform || !c.isNativePlatform()) return null;
  if (c.isPluginAvailable && !c.isPluginAvailable("PlotScan")) return null;
  return (
    (c.Plugins && c.Plugins.PlotScan) ||
    (c.registerPlugin ? c.registerPlugin("PlotScan") : null)
  );
}
function scanStatus(text, busy) {
  const e = document.getElementById("scanImportStatus");
  if (e) e.textContent = text;
  const c = document.getElementById("scanCancelImport");
  if (c) c.hidden = !busy;
  document
    .querySelectorAll("[data-scan-import]")
    .forEach((b) => (b.disabled = !!busy));
}
function cancelScanImport() {
  scanImportCancelled = true;
  scanStatus("Cancelling after the current step…", true);
}
async function chooseScannerFile() {
  if (!activeProjectId) {
    showToast("Open a project first.");
    return;
  }
  if (scanImportBusy) return;
  const plugin = scanNativePlugin();
  if (!plugin) {
    document.getElementById("scanFileInput").click();
    return;
  }
  let result;
  try {
    result = await plugin.pickScan();
    if (result.cancelled) return;
    const response = await fetch(window.Capacitor.convertFileSrc(result.path));
    if (!response.ok) throw new Error("The scanner file could not be read.");
    await importScanFile(
      new File([await response.blob()], result.name),
      "Android file picker",
    );
  } catch (e) {
    scanStatus(e.message || "Unable to open the scanner file.", false);
  } finally {
    if (result && result.path && plugin.releaseImport)
      plugin.releaseImport({ path: result.path }).catch(() => {});
  }
}
async function handleScanFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (f) await importScanFile(f, "File import");
}
async function importScanFile(file, source) {
  if (scanImportBusy) return false;
  if (!activeProjectId) {
    showToast("Open a project first.");
    return false;
  }
  const projectId = activeProjectId,
    target = currentScans,
    format = (file.name.split(".").pop() || "").toLowerCase();
  if (!["glb", "ply"].includes(format)) {
    scanStatus(
      "Choose a GLB model or PLY point cloud from your scanner.",
      false,
    );
    return false;
  }
  if (!file.size || file.size > SCAN_MAX_BYTES) {
    scanStatus(
      "Choose a scan up to 64 MB. Simplify larger scans in your scanner app.",
      false,
    );
    return false;
  }
  scanImportBusy = true;
  scanImportCancelled = false;
  scanStatus("Checking scan…", true);
  try {
    const head = await file.slice(0, 1024 * 1024).arrayBuffer();
    if (format === "glb") {
      if (head.byteLength < 20) throw new Error("Incomplete GLB file.");
      const d = new DataView(head);
      if (
        d.getUint32(0, true) !== 0x46546c67 ||
        d.getUint32(4, true) !== 2 ||
        d.getUint32(8, true) !== file.size
      )
        throw new Error("Choose a complete GLB 2.0 file.");
    } else {
      const h = new TextDecoder().decode(head);
      if (
        !/^ply\r?\n/.test(h) ||
        !/end_header\r?\n/.test(h) ||
        !/element vertex \d+/.test(h)
      )
        throw new Error("PLY has no readable point-cloud header.");
    }
    if (scanImportCancelled) return false;
    scanStatus("Saving original scan to device…", true);
    const sha256 = await scanDigest(file);
    if (scanImportCancelled) return false;
    if (projectId !== activeProjectId || target !== currentScans)
      throw new Error(
        "The capture changed. Select the scan again for the intended feature.",
      );
    if (sha256 && currentScans.some((s) => s.sha256 === sha256))
      throw new Error("This scan is already attached.");
    const record = {
      id: newScanId(),
      name: file.name.slice(0, 180),
      format,
      bytes: file.size,
      sha256,
      importedAt: new Date().toISOString(),
      fileModifiedAt: file.lastModified
        ? new Date(file.lastModified).toISOString()
        : null,
      source,
      device: document
        .getElementById("scanDeviceName")
        .value.trim()
        .slice(0, 120),
      units:
        format === "glb"
          ? "m"
          : document.getElementById("scanImportUnits").value,
      coordinates: "local",
      alignment: "unregistered",
      measurements: [],
    };
    await scanFilePut(record.id, file);
    if (scanImportCancelled) return false;
    if (projectId !== activeProjectId || target !== currentScans)
      throw new Error("The capture changed. Import the scan again.");
    currentScans.push(record);
    renderScanAttachments();
    saveCollectDraft();
    if (
      persist() === false ||
      (recordStore.active && !(await recordStore.flush()))
    )
      throw new Error(
        "Scan bytes are stored, but the record needs a successful device save. Use Retry save.",
      );
    scanStatus("Scan attached · original saved on device", false);
    showToast("3D scan attached");
    return true;
  } catch (e) {
    scanStatus(e.message || "Scan import failed.", false);
    return false;
  } finally {
    scanImportBusy = false;
    document.getElementById("scanCancelImport").hidden = true;
    document
      .querySelectorAll("[data-scan-import]")
      .forEach((b) => (b.disabled = false));
    if (scanImportCancelled) scanStatus("Import cancelled", false);
  }
}
function scanAttachmentHtml(scans, featureId) {
  return (scans || [])
    .map(
      (s) =>
        `<div class="scan-attachment"><span class="scan-file-icon">3D</span><button class="scan-file-name" onclick="openScanViewer(${escapeHtml(JSON.stringify(s.id))},${featureId == null ? "null" : escapeHtml(JSON.stringify(featureId))})"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml((s.format || "").toUpperCase())} · ${formatBytes(s.bytes || 0)} · ${s.units === "unknown" ? "scale not set" : escapeHtml(s.units || "m")}</span></button>${featureId == null ? `<button class="scan-remove" aria-label="Remove scan attachment" onclick="removeScanAttachment(${escapeHtml(JSON.stringify(s.id))})">×</button>` : ""}</div>`,
    )
    .join("");
}
function renderScanAttachments() {
  const e = document.getElementById("scanAttachments");
  if (e)
    e.innerHTML = currentScans.length
      ? scanAttachmentHtml(currentScans, null)
      : '<p class="field-help">Attach a model or point cloud from your scanner to this feature.</p>';
  const c = document.getElementById("scanAttachmentCount");
  if (c)
    c.textContent = currentScans.length
      ? String(currentScans.length)
      : "Optional";
}
function removeScanAttachment(id) {
  showConfirm(
    "Remove this scan from the current capture?",
    () => {
      currentScans = currentScans.filter((s) => s.id !== id);
      renderScanAttachments();
      saveCollectDraft();
      persist();
    },
    "Remove",
    "danger",
  );
}
function findScanRecord(id, featureId) {
  const f =
    featureId == null
      ? null
      : savedFeatures.find((f) => String(f.id) === String(featureId));
  return (f ? f.scans || [] : currentScans).find((s) => s.id === id);
}
async function showScannerDevices() {
  const e = document.getElementById("scannerDeviceStatus"),
    p = scanNativePlugin();
  if (!p) {
    e.textContent =
      "File import is available. Use the Android APK to inspect attached USB devices.";
    return;
  }
  e.textContent = "Checking attached USB devices…";
  try {
    const c = await p.getCapabilities(),
      d = c.usbDevices || [];
    e.textContent = d.length
      ? d
          .map(
            (x) =>
              `${x.name || "USB device"} (vendor ${x.vendorId}, product ${x.productId})`,
          )
          .join(" · ") +
        ". Export GLB/PLY from the scanner app and import here. Live capture requires a vendor SDK."
      : "No USB device detected. Connect the scanner, or import a file already saved on the phone.";
  } catch (_) {
    e.textContent =
      "USB devices could not be checked. File import is available.";
  }
}
async function openScanViewer(id, featureId) {
  closeScanViewer();
  const s = findScanRecord(id, featureId);
  if (!s) return;
  const token = ++scanViewerToken;
  scanOpenRecord = { id, featureId, projectId: activeProjectId };
  scanViewerFocus = document.activeElement;
  document.getElementById("scanViewerOverlay").classList.add("open");
  document.querySelector("#scanViewerOverlay .scan-close").focus();
  document.getElementById("scanViewerTitle").textContent = s.name;
  document.getElementById("scanViewerUnits").value = s.units || "unknown";
  document.getElementById("scanViewerStatus").textContent =
    "Loading 3D preview…";
  document.getElementById("scanMeasurement").textContent =
    "Local scan coordinates · not registered to the map";
  renderScanMeasurements(s);
  try {
    const blob = await scanFileGet(id);
    if (!blob)
      throw new Error(
        "The original scan is missing. Reattach it from your scanner.",
      );
    if (!scanViewerModule)
      scanViewerModule = import(
        new URL("vendor/scan-viewer.js", document.baseURI).href
      ).catch((e) => {
        scanViewerModule = null;
        throw e;
      });
    const m = await scanViewerModule;
    if (token !== scanViewerToken) return;
    const instance = await m.createScanViewer(
      document.getElementById("scanViewport"),
      blob,
      s.format,
      s.units,
      {
        workerUrl: new URL("scanner/ply-worker.js", document.baseURI).href,
        onStatus: (t) => {
          if (token === scanViewerToken)
            document.getElementById("scanViewerStatus").textContent = t;
        },
        onMeasure: (r) => {
          if (token === scanViewerToken) saveScanMeasurement(r);
        },
      },
    );
    if (token !== scanViewerToken) {
      instance.dispose();
      return;
    }
    scanViewer = instance;
  } catch (e) {
    if (token === scanViewerToken)
      document.getElementById("scanViewerStatus").textContent =
        (e.message || "Preview unavailable") +
        " The original can still be exported.";
  }
}
function closeScanViewer() {
  ++scanViewerToken;
  if (scanViewer) {
    scanViewer.dispose();
    scanViewer = null;
  }
  scanOpenRecord = null;
  const e = document.getElementById("scanViewerOverlay");
  if (e) e.classList.remove("open");
  const h = document.getElementById("scanViewport");
  if (h) h.replaceChildren();
  if (scanViewerFocus && scanViewerFocus.isConnected)
    scanViewerFocus.focus({ preventScroll: true });
  scanViewerFocus = null;
}
function measureScan() {
  if (!scanViewer) {
    showToast("Wait for the preview to load.");
    return;
  }
  if (document.getElementById("scanViewerUnits").value === "unknown") {
    showToast("Set the scan units first.");
    return;
  }
  scanViewer.measure();
  document.getElementById("scanMeasurement").textContent =
    "Tap two points on the scan. Measurements are approximate.";
}
function resetScanView() {
  if (scanViewer) scanViewer.reset();
}
function renderScanMeasurements(s) {
  const e = document.getElementById("scanMeasurements");
  if (e)
    e.textContent = (s.measurements || [])
      .slice(-5)
      .map((m) => Number(m.metres).toFixed(3) + " m")
      .join(" · ");
}
function persistScanChange() {
  if (scanOpenRecord && scanOpenRecord.featureId != null) {
    const f = savedFeatures.find(
      (f) => String(f.id) === String(scanOpenRecord.featureId),
    );
    if (f) {
      f.reviewStatus = "collected";
      f.editedAt = new Date().toISOString();
      plotmateTouch(f, "ft");
    }
  }
  persist();
  saveCollectDraft();
  renderScanAttachments();
  renderFeatures();
}
function changeScanUnits(value) {
  if (
    !scanOpenRecord ||
    scanOpenRecord.projectId !== activeProjectId ||
    !["m", "cm", "mm", "unknown"].includes(value)
  )
    return;
  const s = findScanRecord(scanOpenRecord.id, scanOpenRecord.featureId);
  if (!s) return;
  s.units = value;
  s.measurements = [];
  if (scanViewer) scanViewer.setUnits(value);
  renderScanMeasurements(s);
  persistScanChange();
}
function saveScanMeasurement(result) {
  if (!scanOpenRecord || scanOpenRecord.projectId !== activeProjectId) return;
  const s = findScanRecord(scanOpenRecord.id, scanOpenRecord.featureId);
  if (!s) return;
  s.measurements = (s.measurements || [])
    .concat({ ...result, quality: "approximate", at: new Date().toISOString() })
    .slice(-50);
  document.getElementById("scanMeasurement").textContent =
    result.metres.toFixed(3) + " m · approximate";
  renderScanMeasurements(s);
  persistScanChange();
}
async function downloadScanOriginal() {
  if (!scanOpenRecord) return;
  const s = findScanRecord(scanOpenRecord.id, scanOpenRecord.featureId);
  if (!s) return;
  try {
    const b = await scanFileGet(s.id);
    if (!b) throw new Error("Scan file is missing.");
    const r = await saveExportFile(b, s.name, "application/octet-stream");
    if (!r.ok) throw new Error("Export was not saved.");
    showToast("Original scan exported");
  } catch (e) {
    showToast(e.message);
  }
}
async function packScanFiles(zip, features, extra) {
  const records = [...features.flatMap((f) => f.scans || []), ...(extra || [])],
    added = new Set();
  let bytes = 0;
  for (const s of records) {
    s.file = "scans/" + s.id + "." + s.format;
    if (added.has(s.id)) continue;
    const b = await scanFileGet(s.id);
    if (!b) throw new Error("Missing scan original: " + s.name);
    bytes += b.size;
    if (bytes > 128 * 1024 * 1024)
      throw new Error(
        "Scan originals exceed 128 MB per bundle. Export originals separately or simplify them.",
      );
    zip.file(s.file, await b.arrayBuffer(), {
      binary: true,
      compression: "STORE",
    });
    added.add(s.id);
  }
  return added.size;
}
async function restoreScanFiles(zip, features, extra) {
  const mapping = new Map();
  let total = 0;
  for (const s of [
    ...features.flatMap((f) => f.scans || []),
    ...(extra || []),
  ]) {
    const old = s.id;
    if (mapping.has(old)) {
      s.id = mapping.get(old);
      delete s.file;
      continue;
    }
    if (!s.file || !/^scans\/[A-Za-z0-9_-]+\.(glb|ply)$/.test(s.file))
      throw new Error("Invalid scan file reference.");
    const entry = zip.file(s.file);
    if (!entry) throw new Error("Scan missing from bundle: " + s.name);
    if (entry._data && entry._data.uncompressedSize > SCAN_MAX_BYTES)
      throw new Error("Scan exceeds 64 MB import limit.");
    const bytes = await entry.async("arraybuffer");
    total += bytes.byteLength;
    if (bytes.byteLength > SCAN_MAX_BYTES || total > 128 * 1024 * 1024)
      throw new Error("Scan bundle exceeds device import limits.");
    const b = new Blob([bytes], { type: "application/octet-stream" });
    if (s.sha256 && (await scanDigest(b)) !== s.sha256)
      throw new Error("Scan checksum failed: " + s.name);
    const id = newScanId();
    await scanFilePut(id, b);
    mapping.set(old, id);
    s.id = id;
    delete s.file;
  }
  return mapping.size;
}
function scanBackupRecords(p) {
  const roots = p.kind === "all" ? Object.values(p.data || {}) : [p.data || {}];
  return roots.flatMap((d) => [
    ...(d.savedFeatures || []).flatMap((f) => f.scans || []),
    ...(d.currentScans || []),
    ...(d.suspended || []).flatMap((s) => s.scans || []),
  ]);
}
async function prepareScanBackup(p) {
  const records = scanBackupRecords(p);
  if (!records.length) return p;
  const out = JSON.parse(JSON.stringify(p));
  out.scanFiles = {};
  let bytes = 0;
  for (const s of records) {
    if (out.scanFiles[s.id]) continue;
    const b = await scanFileGet(s.id);
    if (!b) throw new Error("Missing scan original: " + s.name);
    bytes += b.size;
    if (bytes > 64 * 1024 * 1024)
      throw new Error("Use Project Bundle for scan backups larger than 64 MB.");
    out.scanFiles[s.id] = await photoBlobToDataUrl(b);
  }
  return out;
}
async function restoreScanBackup(p) {
  const map = new Map();
  let total = 0;
  for (const s of scanBackupRecords(p)) {
    const old = s.id;
    if (map.has(old)) {
      s.id = map.get(old);
      continue;
    }
    const encoded = p.scanFiles && p.scanFiles[old];
    if (!encoded)
      throw new Error("Backup is missing a scan original: " + s.name);
    const b = photoDataUrlToBlobSync(encoded);
    total += b ? b.size : 0;
    if (!b || b.size > SCAN_MAX_BYTES || total > 128 * 1024 * 1024)
      throw new Error("Scan backup exceeds import limits.");
    if (s.sha256 && (await scanDigest(b)) !== s.sha256)
      throw new Error("Scan checksum failed: " + s.name);
    const id = newScanId();
    await scanFilePut(id, b);
    map.set(old, id);
    s.id = id;
  }
  delete p.scanFiles;
}
