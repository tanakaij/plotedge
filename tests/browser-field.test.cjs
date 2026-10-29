// Optional real-browser acceptance tests. Run npm run test:browser after installing Chromium.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  os = require("node:os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.join(__dirname, ".."),
  out =
    process.env.QA_OUTPUT ||
    fs.mkdtempSync(path.join(os.tmpdir(), "plotedge-qa-"));
fs.mkdirSync(out, { recursive: true });
const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split("?")[0]);
  if (name.endsWith("/")) name += "index.html";
  const file = path.join(root, name);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (e, b) => {
    res.writeHead(e ? 404 : 200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
    });
    res.end(e ? "Missing" : b);
  });
});
let browser,
  checks = 0;
function passed(name) {
  checks++;
  console.log("PASS " + name);
}
function ply() {
  const points = [];
  for (let x = 0; x < 40; x++)
    for (let z = 0; z < 40; z++)
      points.push(
        [x / 20, Math.sin(x / 7) * 0.1, z / 20, 70, 200, 170].join(" "),
      );
  return Buffer.from(
    "ply\nformat ascii 1.0\ncomment Scanner test fixture\nelement vertex " +
      points.length +
      "\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n" +
      points.join("\n") +
      "\n",
  );
}
function glb() {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
  };
  let str = JSON.stringify(json);
  str += " ".repeat((4 - (str.length % 4)) % 4);
  const j = Buffer.from(str),
    bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => bin.writeFloatLE(n, i * 4));
  const b = Buffer.alloc(28 + j.length + bin.length);
  b.writeUInt32LE(0x46546c67, 0);
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(j.length, 12);
  b.writeUInt32LE(0x4e4f534a, 16);
  j.copy(b, 20);
  b.writeUInt32LE(bin.length, 20 + j.length);
  b.writeUInt32LE(0x004e4942, 24 + j.length);
  bin.copy(b, 28 + j.length);
  return b;
}
async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ["geolocation"],
    geolocation: { latitude: -17.82, longitude: 31.05, accuracy: 3 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("plotedge_visited", "1"));
  await page.goto(origin);
  await page.evaluate(() => window.plotedgeReady);
  await page.evaluate(async () => {
    await recordStore.migrate();
    projects = [
      {
        id: "qa",
        name: "Msasa Site Survey",
        createdAt: new Date().toISOString(),
      },
    ];
    projectData = {
      qa: {
        savedFeatures: [],
        currentVertices: [],
        currentScans: [],
        suspended: [],
        featureTypes: [
          {
            id: "asset",
            name: "Site asset",
            geometryType: "point",
            fields: [
              {
                id: "condition",
                label: "Condition",
                type: "single_select",
                options: ["Good", "Needs repair"],
                required: true,
              },
              { id: "material", label: "Material", type: "text" },
              { id: "height", label: "Height (m)", type: "number" },
            ],
          },
        ],
      },
    };
    lastWritten = null;
    persistStore({ destructive: true });
    await recordStore.flush();
    openProject("qa");
    switchTab("collect");
  });
  await page.waitForFunction(
    () => recordStore.active && !recordStore.status().pending,
  );
  assert.equal(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    true,
  );
  passed("Mobile capture has no horizontal overflow");
  await page.evaluate(() => openCollectStep("collectCardAttrs", true));
  await page.locator("#attr_condition").selectOption("Good");
  await page.locator("#attr_material").fill("Steel");
  await page.locator("#attr_height").fill("4.5");
  assert.equal(await page.locator("#attr_material").isVisible(), true);
  passed("Inline fields accept answers without a modal");
  await page.screenshot({
    path: path.join(out, "capture-mobile.png"),
    fullPage: true,
  });
  // Install every optional dependency before going offline, without loading them in the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.evaluate(() => window.plotedgeReady);
  assert.equal(
    await page.evaluate(() => projects[0].name),
    "Msasa Site Survey",
  );
  await page.evaluate(() => {
    closeConfirmModal(false);
    openProject("qa");
    switchTab("collect");
  });
  passed("Offline reload restores the committed project from IndexedDB");
  // Optional engines must load for the first time while offline.
  assert.equal(
    await page.evaluate(async () => {
      const SQL = await ensureSqlJs();
      const db = new SQL.Database();
      db.run("CREATE TABLE test (id INTEGER)");
      db.close();
      await ensureXlsx();
      await ensureFlatgeobuf();
      return typeof XLSX === "object" && typeof flatgeobuf === "object";
    }),
    true,
  );
  passed("Offline SQLite, spreadsheet and FlatGeobuf libraries load locally");
  await page.evaluate(() => {
    document.getElementById("scanImportUnits").value = "m";
  });
  const original = ply();
  await page
    .locator("#scanFileInput")
    .setInputFiles({
      name: "equipment.ply",
      mimeType: "application/octet-stream",
      buffer: original,
    });
  await page.waitForFunction(
    () => !scanImportBusy && currentScans.length === 1,
  );
  assert.equal(await page.evaluate(() => currentScans[0].sha256.length), 64);
  passed("PLY import stores original bytes with a checksum");
  await page
    .locator("#scanFileInput")
    .setInputFiles({
      name: "duplicate.ply",
      mimeType: "application/octet-stream",
      buffer: original,
    });
  await page.waitForFunction(() => !scanImportBusy);
  assert.equal(await page.evaluate(() => currentScans.length), 1);
  assert.match(
    await page.locator("#scanImportStatus").innerText(),
    /already attached/,
  );
  passed("Duplicate scan imports are detected");
  await page
    .locator("#scanFileInput")
    .setInputFiles({
      name: "broken.glb",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("bad"),
    });
  await page.waitForFunction(() => !scanImportBusy);
  assert.equal(await page.evaluate(() => currentScans.length), 1);
  passed("Invalid scanner files are rejected without losing attachments");
  await page.evaluate(() => openScanViewer(currentScans[0].id, null));
  await page.waitForFunction(() => !!scanViewer, { timeout: 20000 });
  assert.match(
    await page.locator("#scanViewerStatus").innerText(),
    /1,600 preview points/,
  );
  await page.screenshot({ path: path.join(out, "scanner-mobile.png") });
  passed("PLY preview parses in a worker and renders offline");
  await page.evaluate(() => measureScan());
  const canvas = page.locator("#scanViewport canvas"),
    box = await canvas.boundingBox();
  await canvas.click({
    position: { x: box.width * 0.46, y: box.height * 0.5 },
  });
  await canvas.click({
    position: { x: box.width * 0.54, y: box.height * 0.5 },
  });
  assert.ok(
    (await page.evaluate(() => currentScans[0].measurements.length)) > 0,
  );
  passed("Two-point measurement is captured from the 3D view");
  await page.evaluate(() => closeScanViewer());
  await page
    .locator("#scanFileInput")
    .setInputFiles({
      name: "model.glb",
      mimeType: "model/gltf-binary",
      buffer: glb(),
    });
  await page.waitForFunction(
    () => !scanImportBusy && currentScans.length === 2,
  );
  await page.evaluate(() => openScanViewer(currentScans[1].id, null));
  await page.waitForFunction(() => !!scanViewer, { timeout: 20000 });
  assert.match(
    await page.locator("#scanViewerStatus").innerText(),
    /3 model vertices/,
  );
  await page.evaluate(() => closeScanViewer());
  passed("GLB models render through the same offline viewer");
  await page.evaluate(() => {
    document.getElementById("featureName").value = "Pump 01";
    document.getElementById("featureRef").value = "P-01";
    currentVertices = [
      {
        lat: -17.82,
        lon: 31.05,
        acc: 3,
        time: new Date().toISOString(),
        attrs: {},
        photos: [],
      },
    ];
    document.getElementById("attr_condition").value = "Good";
    document.getElementById("attr_material").value = "Steel";
    renderPoints();
    saveCollectDraft();
    suspendCurrentCapture();
  });
  assert.equal(await page.evaluate(() => suspendedCaptures[0].scans.length), 2);
  await page.evaluate(() => resumeCapture(suspendedCaptures[0].id));
  assert.equal(await page.evaluate(() => currentScans.length), 2);
  passed("Pause and resume retain scan attachments and form answers");
  await page.evaluate(() => saveFeature());
  await page.waitForFunction(
    () => !window.featureSaveInFlight && savedFeatures.length === 1,
  );
  assert.equal(await page.evaluate(() => savedFeatures[0].scans.length), 2);
  assert.equal(await page.evaluate(() => currentScans.length), 0);
  assert.equal(
    await page.evaluate(() => document.getElementById("attr_material").value),
    "",
  );
  passed("Save & Next commits scans and clears answers for the next record");
  await page.evaluate(() => editFeature(savedFeatures[0].id));
  assert.equal(await page.evaluate(() => currentScans.length), 2);
  await page.evaluate(() => {
    document.getElementById("featureName").value = "Pump 01 updated";
    saveFeature();
  });
  await page.waitForFunction(
    () =>
      !window.featureSaveInFlight &&
      savedFeatures[0].name === "Pump 01 updated",
  );
  passed("Editing updates the existing record and keeps its scans");
  // Exercise a real failed IndexedDB transaction; the form must survive.
  await page.evaluate(() => {
    switchTab("collect");
    document.getElementById("featureName").value = "Must survive";
    document.getElementById("attr_condition").value = "Good";
    currentVertices = [
      { lat: -17.81, lon: 31.06, acc: 2, attrs: {}, photos: [] },
    ];
    window.originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = window.originalTransaction.apply(this, args);
      if (this.name === "plotedge-records" && args[1] === "readwrite")
        queueMicrotask(() => tx.abort());
      return tx;
    };
    saveFeature();
  });
  await page.waitForFunction(() => !window.featureSaveInFlight);
  assert.equal(await page.evaluate(() => savedFeatures.length), 1);
  assert.equal(await page.locator("#featureName").inputValue(), "Must survive");
  assert.equal(await page.evaluate(() => currentVertices.length), 1);
  assert.equal(
    await page.evaluate(() => readDraft(activeProjectId).name),
    "Must survive",
  );
  await page.evaluate(async () => {
    IDBDatabase.prototype.transaction = window.originalTransaction;
    await retryDeviceSave();
    blankCollectForm();
    persist();
    await recordStore.flush();
  });
  passed("A failed device commit preserves the capture; Retry saves it");
  // Intercept download transport only; the full serializers and bytes are real.
  await page.evaluate(() => {
    window.realSaveExportFile = saveExportFile;
    saveExportFile = async (blob, name) => {
      window.exportedBlob = blob;
      window.exportedName = name;
      return { ok: true, where: "test download" };
    };
  });
  await page.evaluate(() => { document.getElementById("featureNotes").value="Inspection started"; saveCollectDraft(); });
  assert.equal(await page.evaluate(() => hasCaptureInProgress()),true);
  await page.evaluate(() => exportPlotpack());
  assert.match(await page.evaluate(() => exportedName), /\.plotpack$/);
  const bundle = await page.evaluate(async () => {
    const zip = await JSZip.loadAsync(exportedBlob);
    const m = JSON.parse(await zip.file("manifest.json").async("string"));
    return {
      scans: m.counts.scans,
      version: m.formatVersion,
      files: Object.keys(zip.files).filter((n) =>
        /scans\/.*\.(glb|ply)$/.test(n),
      ),
    };
  });
  assert.equal(bundle.scans, 2);
  assert.equal(bundle.version, 2);
  passed(
    "Project Bundle includes original scan files and a versioned manifest",
  );
  const before = await page.evaluate(() => projects.length);
  await page.evaluate(async () => {
    await preparePlotpackImport(exportedBlob);
    window.restoreResult = await importPlotpackBundle();
  });
  assert.equal(await page.evaluate(() => restoreResult.ok), true);
  assert.equal(await page.evaluate(() => projects.length), before + 1);
  assert.equal(
    await page.evaluate(async () => {
      const a = savedFeatures[0].scans[0],
        b = projectData[restoreResult.projectId].savedFeatures[0].scans[0];
      return (
        a.id !== b.id &&
        (await scanDigest(await scanFileGet(b.id))) === a.sha256
      );
    }),
    true,
  );
  assert.equal(await page.evaluate(() => projectData[restoreResult.projectId].suspended[0].notes),"Inspection started");
  passed("Bundle restore remaps ids and verifies byte-for-byte scan integrity");
  await page.evaluate(async () => {
    const zip = await JSZip.loadAsync(exportedBlob);
    const meta = JSON.parse(await zip.file("features.json").async("string"));
    zip.file(meta[0].scans[0].file, "corrupt");
    const broken = await zip.generateAsync({ type: "blob" });
    await preparePlotpackImport(broken);
    window.badRestore = await importPlotpackBundle();
  });
  assert.equal(await page.evaluate(() => badRestore.ok), false);
  assert.equal(await page.evaluate(() => projects.length), before + 1);
  passed(
    "Corrupt scan bytes block restore before project metadata is committed",
  );
  await page.evaluate(() => exportAllProjectsBackup());
  await page.evaluate(async () => {
    window.jsonBackup = JSON.parse(await exportedBlob.text());
    window.jsonRestoredIds = await importJsonBackupPayload(jsonBackup);
  });
  assert.equal(await page.evaluate(() => jsonRestoredIds.length), before + 1);
  assert.equal(
    await page.evaluate(async () => {
      const s = projectData[jsonRestoredIds[0]].savedFeatures[0].scans[0];
      return (await scanDigest(await scanFileGet(s.id))) === s.sha256;
    }),
    true,
  );
  passed(
    "All-project JSON backups preserve project ids, attachments and original bytes",
  );
  // Large forms no longer consume the localStorage quota.
  await page.evaluate(async () => {
    projectData.qa.notes = "x".repeat(6 * 1024 * 1024);
    persistStore();
    await recordStore.flush();
  });
  await page.reload();
  await page.evaluate(() => window.plotedgeReady);
  assert.equal(
    await page.evaluate(() => projectData.qa.notes.length),
    6 * 1024 * 1024,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("plotedge_v2")),
    null,
  );
  passed("A project snapshot larger than 5 MB survives a cold reload");
  await page.evaluate(() => {
    openProject("qa");
    closeConfirmModal(false);
    projectNotes = "";
    persist();
    switchTab("review");
  });
  await page.evaluate(() => {
    const base = savedFeatures[0];
    for (let i = 1; i < 65; i++)
      savedFeatures.push({
        ...JSON.parse(JSON.stringify(base)),
        id: "extra" + i,
        name: "Asset " + i,
        ref: "A-" + i,
        scans: [],
        reviewStatus: "collected",
      });
    savedFeatures[1].attrs.condition = "";
    savedFeatures[2].vertices[0].acc = 35;
    savedFeatures[3].ref = savedFeatures[0].ref;
    renderFeatures();
  });
  assert.equal(await page.locator("#featuresList .feature-card").count(), 30);
  assert.equal(await page.locator("#featuresList .field-pager").count(), 1);
  assert.ok(
    (await page.evaluate(
      () => fieldReviewIndex.get(savedFeatures[1].id).length,
    )) > 0,
  );
  await page.evaluate(() => setFieldReviewFilter("attention"));
  assert.ok((await page.locator("#featuresList .feature-card").count()) < 30);
  passed("Review flags quality issues and paginates without dropping records");
  await page.screenshot({
    path: path.join(out, "review-mobile.png"),
    fullPage: true,
  });
  await context.setOffline(false);
  const desktop = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    desk = await desktop.newPage();
  await desk.addInitScript(() => localStorage.setItem("plotedge_visited", "1"));
  await desk.goto(origin);
  await desk.evaluate(() => window.plotedgeReady);
  // Copy metadata for a visual-only desktop inspection; no claim of cross-device sync.
  const state = await page.evaluate(() =>
    JSON.stringify({ projects, data: projectData }),
  );
  await desk.evaluate((s) => {
    const p = JSON.parse(s);
    projects = p.projects;
    projectData = p.data;
    lastWritten = null;
    persistStore({ destructive: true });
    openProject("qa");
    switchTab("review");
  }, state);
  await desk.screenshot({
    path: path.join(out, "review-desktop.png"),
    fullPage: true,
  });
  assert.equal(
    await desk.evaluate(() => document.body.scrollWidth <= innerWidth),
    true,
  );
  await desk.evaluate(() => switchTab("collect"));
  assert.equal(await desk.locator("#panel-review").isVisible(), false);
  await desk.evaluate(() => {
    applyTheme("dark");
    openCollectStep("collectCardAttrs", true);
  });
  await desk.screenshot({
    path: path.join(out, "capture-dark-desktop.png"),
    fullPage: true,
  });
  passed("Desktop layout stays within the viewport and hides inactive Review");
  assert.deepEqual(errors, []);
  passed("No uncaught browser errors during the full workflow");
  console.log(
    checks +
      "/" +
      checks +
      " browser acceptance checks passed. Screenshots: " +
      out,
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    server.close();
  });
