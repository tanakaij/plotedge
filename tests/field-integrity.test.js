const fs = require("fs"),
  path = require("path"),
  vm = require("vm"),
  assert = require("node:assert/strict"),
  os = require("os");
const { execFileSync } = require("child_process");
const { IDBFactory, IDBDatabase } = require("fake-indexeddb");
const { pathToFileURL } = require("url");
const root = path.join(__dirname, "..");
let total = 0,
  failed = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log("  PASS  " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL  " + name + "\n        " + e.message);
  }
}
function storeContext(factory, values) {
  const map = values || new Map(),
    events = [];
  const context = vm.createContext({
    indexedDB: factory,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    console,
    events,
  });
  context.window = context;
  context.addEventListener = () => {};
  context.dispatchEvent = (e) => events.push(e.detail);
  vm.runInContext(
    fs.readFileSync(path.join(root, "js/04b-recordstore.js"), "utf8"),
    context,
  );
  return { run: (code) => vm.runInContext(code, context), map, events };
}
const payload = (note) =>
  JSON.stringify({
    projects: [{ id: "p", name: "Survey" }],
    data: {
      p: {
        savedFeatures: [{ id: "f", name: "Asset" }],
        featureTypes: [],
        notes: note,
      },
    },
  });
(async () => {
  await check(
    "legacy records migrate only after an exact read-back, then cold-load from IndexedDB",
    async () => {
      const factory = new IDBFactory(),
        original = payload("original"),
        values = new Map([["plotedge_v2", original]]);
      const first = storeContext(factory, values);
      await first.run("recordStore.migrate()");
      assert.equal(first.run("recordStore.raw"), original);
      assert.equal(values.get("plotedge-records-db-v1"), "1");
      assert.equal(values.has("plotedge_v2"), false);
      const cold = storeContext(factory, values);
      assert.equal(cold.run("recordStore.requiresLoad"), true);
      assert.equal(await cold.run("recordStore.ready"), true);
      assert.equal(cold.run("recordStore.raw"), original);
    },
  );
  await check(
    "ordered writes keep a previous snapshot and support more than 5 MB",
    async () => {
      const ctx = storeContext(
        new IDBFactory(),
        new Map([["plotedge_v2", payload("start")]]),
      );
      await ctx.run("recordStore.migrate()");
      const large = payload("n".repeat(6 * 1024 * 1024));
      ctx.run("recordStore.write(" + JSON.stringify(large) + ")");
      ctx.run("recordStore.write(" + JSON.stringify(payload("last")) + ")");
      assert.equal(await ctx.run("recordStore.flush()"), true);
      assert.equal(ctx.run("recordStore.backup"), large);
      assert.equal(ctx.run("recordStore.raw"), payload("last"));
      assert.equal(ctx.events.at(-1).pending, 0);
    },
  );
  await check(
    "a failed database migration retains the legacy source for recovery",
    async () => {
      const ctx = storeContext(
        new IDBFactory(),
        new Map([["plotedge_v2", payload("keep me")]]),
      );
      await ctx.run("recordStore.ready");
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === "readwrite") throw new Error("Quota exceeded");
        return transaction.apply(this, args);
      };
      try {
        await ctx.run("recordStore.migrate()");
        assert.equal(ctx.map.get("plotedge_v2"), payload("keep me"));
        assert.equal(ctx.map.has("plotedge-records-db-v1"), false);
        assert.equal(ctx.run("recordStore.active"), false);
      } finally {
        IDBDatabase.prototype.transaction = transaction;
      }
    },
  );
  await check(
    "a failed commit is visible and the retained snapshot can be retried",
    async () => {
      const ctx = storeContext(
        new IDBFactory(),
        new Map([["plotedge_v2", payload("safe")]]),
      );
      await ctx.run("recordStore.migrate()");
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === "readwrite") throw new Error("Disk unavailable");
        return transaction.apply(this, args);
      };
      try {
        ctx.run(
          "recordStore.write(" + JSON.stringify(payload("retry me")) + ")",
        );
        assert.equal(await ctx.run("recordStore.flush()"), false);
        assert.match(ctx.run("recordStore.status().error"), /Disk unavailable/);
        assert.equal(ctx.run('recordStore.write("ignored")'), false);
      } finally {
        IDBDatabase.prototype.transaction = transaction;
      }
      assert.equal(await ctx.run("recordStore.retry()"), true);
      assert.equal(ctx.run("recordStore.raw"), payload("retry me"));
    },
  );
  await check(
    "a database marker with missing data blocks startup instead of replacing records",
    async () => {
      const ctx = storeContext(
        new IDBFactory(),
        new Map([["plotedge-records-db-v1", "1"]]),
      );
      assert.equal(await ctx.run("recordStore.ready"), false);
      assert.equal(ctx.run("recordStore.active"), false);
      assert.match(ctx.run("recordStore.status().error"), /empty/);
    },
  );
  const { parsePly } = await import(
    pathToFileURL(path.join(root, "scanner/ply-parser.mjs"))
  );
  const buffer = (s) => new TextEncoder().encode(s).buffer;
  const header = (encoding, count, properties) =>
    "ply\nformat " +
    encoding +
    " 1.0\ncomment mètres\nelement vertex " +
    count +
    "\n" +
    properties +
    "end_header\n";
  const props = "property double x\nproperty double y\nproperty double z\n";
  await check(
    "ASCII PLY preserves a large coordinate origin before float conversion",
    () => {
      const cloud = parsePly(
        buffer(header("ascii", 2, props) + "6000000 3 4\n6000000.01 3 4\n"),
      );
      assert.equal(cloud.count, 2);
      assert.equal(cloud.origin[0], 6000000);
      assert.ok(Math.abs(cloud.positions[3] - 0.01) < 1e-6);
    },
  );
  for (const little of [true, false])
    await check(
      "binary " +
        (little ? "little" : "big") +
        " endian PLY respects Unicode header byte offsets",
      () => {
        const head = new TextEncoder().encode(
            header(
              little ? "binary_little_endian" : "binary_big_endian",
              2,
              props,
            ),
          ),
          bytes = new Uint8Array(head.length + 48);
        bytes.set(head);
        const view = new DataView(bytes.buffer);
        [10, 20, 30, 11, 22, 33].forEach((n, i) =>
          view.setFloat64(head.length + i * 8, n, little),
        );
        const cloud = parsePly(bytes.buffer);
        assert.deepEqual(Array.from(cloud.positions), [0, 0, 0, 1, 2, 3]);
      },
    );
  await check(
    "large PLY previews are sampled without changing the declared original count",
    () => {
      const cloud = parsePly(
        buffer(
          header("ascii", 100, props) +
            Array.from({ length: 100 }, (_, i) => i + " 1 2").join("\n") +
            "\n",
        ),
        10,
      );
      assert.equal(cloud.count, 100);
      assert.equal(cloud.displayed, 10);
    },
  );
  await check(
    "truncated and non-finite PLY files fail with useful errors",
    () => {
      assert.throws(
        () => parsePly(buffer(header("binary_little_endian", 9, props))),
        /truncated/,
      );
      assert.throws(
        () => parsePly(buffer(header("ascii", 1, props) + "nan inf 3\n")),
        /finite/,
      );
    },
  );
  await check(
    "Android scanner patch registers once and USB host support is optional",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plotedge-android-")),
        main = path.join(tmp, "app/src/main/java/com/plotedge/app");
      fs.mkdirSync(main, { recursive: true });
      fs.writeFileSync(
        path.join(main, "MainActivity.java"),
        "class MainActivity { void onCreate(Bundle savedInstanceState) { super.onCreate(savedInstanceState); } }",
      );
      fs.writeFileSync(
        path.join(tmp, "app/src/main/AndroidManifest.xml"),
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>',
      );
      for (let i = 0; i < 2; i++)
        execFileSync("python3", [
          path.join(root, "scripts/patch-android-scanner.py"),
          "--android-dir",
          tmp,
        ]);
      const java = fs.readFileSync(
          path.join(main, "MainActivity.java"),
          "utf8",
        ),
        manifest = fs.readFileSync(
          path.join(tmp, "app/src/main/AndroidManifest.xml"),
          "utf8",
        ),
        plugin = fs.readFileSync(
          path.join(main, "PlotScanPlugin.java"),
          "utf8",
        );
      assert.equal(
        (java.match(/registerPlugin\(PlotScanPlugin.class\)/g) || []).length,
        1,
      );
      assert.match(
        manifest,
        /android:name="android.hardware.usb.host" android:required="false"/,
      );
      assert.match(plugin, /result.put\("liveCapture", false\)/);
      assert.match(plugin, /directory.equals\(file.getParentFile\(\)\)/);
      fs.rmSync(tmp, { recursive: true });
    },
  );
  console.log(
    "\n  field-integrity: " + (total - failed) + "/" + total + " passed",
  );
  process.exitCode = failed ? 1 : 0;
})();
