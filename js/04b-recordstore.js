// Ordered, transactional snapshots. Legacy data is removed only after verified migration.
const recordStore = (() => {
  const MARKER = "plotedge-records-db-v1",
    KEY = "plotedge_v2";
  let db = null,
    raw = null,
    backup = null,
    committed = null,
    active = false,
    error = null,
    pending = 0;
  let chain = Promise.resolve(true),
    requiresLoad = false;
  try {
    requiresLoad = localStorage.getItem(MARKER) === "1";
  } catch (_) {}
  function status() {
    return {
      active,
      pending,
      error: error ? error.message : null,
      bytes: raw ? raw.length : 0,
    };
  }
  function notify() {
    window.dispatchEvent(
      new CustomEvent("plotedge-storage", { detail: status() }),
    );
  }
  function transaction(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode);
      let result;
      fn(tx.objectStore("snapshots"), (v) => {
        result = v;
      });
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("Device database write failed"));
    });
  }
  async function put(next, previous) {
    await transaction("readwrite", (s) => {
      if (previous != null) s.put(previous, "backup");
      s.put(next, "current");
    });
  }
  const ready = (async () => {
    if (typeof indexedDB === "undefined") {
      if (requiresLoad)
        throw new Error(
          "The project database is unavailable. Reopen the app in its usual browser.",
        );
      return false;
    }
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("plotedge-records", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("snapshots");
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () =>
        reject(r.error || new Error("Cannot open project database"));
      r.onblocked = () =>
        reject(new Error("Close other PlotEdge tabs and retry."));
    });
    if (requiresLoad) {
      const values = await transaction("readonly", (s, done) => {
        const a = s.get("current"),
          b = s.get("backup");
        b.onsuccess = () => done([a.result, b.result]);
      });
      raw = values[0] || null;
      backup = values[1] || null;
      if (!raw)
        throw new Error(
          "Project database is empty. Existing records have not been replaced.",
        );
      committed = raw;
      active = true;
    }
    return true;
  })().catch((e) => {
    error = e;
    notify();
    return false;
  });
  async function migrate() {
    if (!(await ready) || active || requiresLoad) return;
    try {
      for (;;) {
        const source = localStorage.getItem(KEY);
        if (!source) return;
        const parsed = JSON.parse(source);
        if (!Array.isArray(parsed.projects) || !parsed.data) return;
        await put(source, localStorage.getItem(KEY + "_bak"));
        const check = await transaction("readonly", (s, done) => {
          const r = s.get("current");
          r.onsuccess = () => done(r.result);
        });
        if (check !== source)
          throw new Error(
            "Migration verification failed. Original data has been kept.",
          );
        if (source !== localStorage.getItem(KEY)) continue;
        localStorage.setItem(MARKER, "1");
        raw = committed = source;
        active = true;
        error = null;
        localStorage.removeItem(KEY);
        localStorage.removeItem(KEY + "_bak");
        notify();
        return;
      }
    } catch (e) {
      error = e;
      notify();
    }
  }
  function write(next) {
    if (!active || error) return false;
    raw = next;
    pending++;
    notify();
    chain = chain.then(async () => {
      try {
        await put(next, committed);
        backup = committed;
        committed = next;
        error = null;
        return true;
      } catch (e) {
        error = e;
        return false;
      } finally {
        pending--;
        notify();
      }
    });
    return true;
  }
  async function flush() {
    await chain;
    return !error && pending === 0;
  }
  async function retry() {
    if (!active) {
      if (!(await ready)) return false;
      error = null;
      await migrate();
      return active && !error;
    }
    error = null;
    if (raw) write(raw);
    return flush();
  }
  function stage(next) {
    raw = next;
    notify();
  }
  window.addEventListener("beforeunload", (e) => {
    if (pending || (active && error)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return {
    ready,
    requiresLoad,
    migrate,
    write,
    flush,
    retry,
    stage,
    status,
    get active() {
      return active;
    },
    get raw() {
      return raw;
    },
    get backup() {
      return backup;
    },
  };
})();
