'use strict';
// Executes the real store block lifted out of index.html (between the
// STORE:BEGIN / STORE:END sentinels) against a fake localStorage, so these are
// behavioural tests of the shipped code rather than a re-implementation of it.
const vm = require('vm');
const { readIndex } = require('./lib');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const html = readIndex();
const BEGIN = '// ══ STORE:BEGIN ══', END = '// ══ STORE:END ══';
const i = html.indexOf(BEGIN), j = html.indexOf(END);
if (i === -1 || j === -1) {
  results.push({ name: 'store block is extractable for testing', ok: false, msg: 'STORE:BEGIN/STORE:END sentinels not found in index.html' });
} else {
  results.push({ name: 'store block is extractable for testing', ok: true });
  // `let projectData = {}` inside the extracted block would land in the VM's
  // global *lexical* scope, which the test cannot read or write through the
  // context object. Demoting that one declaration to a plain assignment (backed
  // by a `var` in the preamble) is the whole transform — nothing else in the
  // block is reached from the outside.
  const src = html.slice(i, j).replace(/^let projectData = \{\};$/m, 'projectData = {};');

  function makeLS(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
      _m: m,
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: k => { m.delete(k); },
      key: n => [...m.keys()][n],
      get length() { return m.size; }
    };
  }
  // Boots the extracted block in isolation with just enough of the app around
  // it to run: the globals it reads, and no-op stand-ins for the UI it pokes.
  function boot(seed) {
    const ls = makeLS(seed);
    const toasts = [];
    const ctx = {
      localStorage: ls,
      console,
      Blob: function (a) { this.size = String(a[0] || '').length; },
      Date, JSON, Math, Object, Array, String, Number, isNaN, parseInt,
      window: {},
      document: { getElementById: () => null, querySelectorAll: () => [], documentElement: { classList: { add() {}, remove() {} } } },
      STORAGE_KEY: 'plotedge_v2', LEGACY_KEY: 'plotedge_v1',
      showToast: m => toasts.push(m),
      publishWidgetSummary: () => {},
      getProjectStats: () => ({ features: 0, synced: true }),
      projects: [], projectData: {},
      activeProjectId: null, savedFeatures: [], currentVertices: [], featureTypes: [],
      projectNotes: '', projectNotesUpdatedAt: null, plotetchSketches: [],
      requestAnimationFrame: fn => fn(),
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'store-block' });
    return { ctx, ls, toasts };
  }

  const KEY = 'plotedge_v2', BAK = 'plotedge_v2_bak';
  const goodStore = () => JSON.stringify({
    projects: [{ id: 'p1', name: 'Survey A' }, { id: 'p2', name: 'Survey B' }],
    data: { p1: { savedFeatures: [{ id: 'f1', vertices: [{ lat: 1, lon: 2 }] }], currentVertices: [], featureTypes: [] } }
  });

  // ── the reported fatal: a crash/parse failure must never destroy the data ──
  check('corrupt store is quarantined, not silently replaced with an empty one', () => {
    const { ctx, ls } = boot({ plotedge_v2: '{"projects":[{"id":"p1"' });
    ctx.projectData = ctx.loadStore();
    const keys = [...ls._m.keys()];
    assert(keys.some(k => /corrupt|quarantine/i.test(k)), `no quarantine copy was kept; keys were ${keys}`);
    const quar = ls._m.get(keys.find(k => /corrupt|quarantine/i.test(k)));
    assert(quar.includes('"p1"'), 'quarantined copy does not contain the original bytes');
  });

  check('after a failed load, the next save refuses to overwrite the original', () => {
    const { ctx, ls } = boot({ plotedge_v2: '{"projects":[{"id":"p1"' });
    ctx.projectData = ctx.loadStore();
    ctx.projects = [];
    ctx.persistStore();
    assert(ls._m.get('plotedge_v2').includes('"p1"'),
      'the unreadable-but-recoverable original was overwritten by an empty store');
  });

  check('a save that would drop every project is blocked unless explicitly destructive', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    ctx.projects = [];            // simulate a bug / half-initialised state
    ctx.projectData = {};
    ctx.persistStore();
    const after = JSON.parse(ls._m.get('plotedge_v2'));
    assert(after.projects.length === 2, `projects went from 2 to ${after.projects.length} without an explicit delete`);
  });

  check('a genuine user delete still goes through', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    ctx.projects = [];
    ctx.projectData = {};
    ctx.persistStore({ destructive: true });
    const after = JSON.parse(ls._m.get('plotedge_v2'));
    assert(after.projects.length === 0, 'an explicit delete was incorrectly blocked');
  });

  check('a save that would drop every feature of a project is blocked', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    ctx.projectData.p1.savedFeatures = [];   // e.g. openProject() ran before load finished
    ctx.persistStore();
    const after = JSON.parse(ls._m.get('plotedge_v2'));
    assert(after.data.p1.savedFeatures.length === 1, 'captured features were wiped by a non-destructive save');
  });

  // ══ THE FIELD BUG: FINISHING A SHAPE IS NOT DATA LOSS ══
  // The guard used to count savedFeatures + currentVertices as one total. Finishing a polygon
  // moves N vertices out of the scratch list into a single saved feature, so the total fell and
  // the write was refused — the feature stayed in memory, never reached disk, and the next launch
  // reported an empty project. These four cover every shape of that mistake.
  const inProgressStore = (nVerts) => JSON.stringify({
    projects: [{ id: 'p1', name: 'Survey A' }],
    data: { p1: {
      savedFeatures: [],
      currentVertices: Array.from({ length: nVerts }, (_, i) => ({ lat: i, lon: i })),
      featureTypes: []
    } }
  });

  check('finishing a polygon is saved, not refused as "dropping captured items"', () => {
    const { ctx, ls } = boot({ plotedge_v2: inProgressStore(5) });
    ctx.projectData = ctx.loadStore();
    // exactly what finalizeSaveFeature does: five scratch vertices become one saved feature
    ctx.projectData.p1.savedFeatures = [{ id: 'f1', name: 'Plot 12', vertices: ctx.projectData.p1.currentVertices }];
    ctx.projectData.p1.currentVertices = [];
    const ok = ctx.persistStore();
    assert(ok !== false, 'the save was refused');
    const after = JSON.parse(ls._m.get('plotedge_v2'));
    assert(after.data.p1.savedFeatures.length === 1, 'the finished polygon never reached disk');
    assert(after.data.p1.savedFeatures[0].name === 'Plot 12', 'the saved feature lost its name');
  });

  check('clearing the in-progress form is saved, not refused', () => {
    const { ctx, ls } = boot({ plotedge_v2: inProgressStore(3) });
    ctx.projectData = ctx.loadStore();
    ctx.projectData.p1.currentVertices = [];      // Clear current / Cancel edit
    const ok = ctx.persistStore();
    assert(ok !== false, 'clearing the scratch vertices was refused as data loss');
    assert(JSON.parse(ls._m.get('plotedge_v2')).data.p1.currentVertices.length === 0, 'the clear did not persist');
  });

  check('editing a feature down to fewer vertices still saves', () => {
    const seed = JSON.stringify({
      projects: [{ id: 'p1', name: 'Survey A' }],
      data: { p1: { savedFeatures: [{ id: 'f1', vertices: [{lat:1,lon:1},{lat:2,lon:2},{lat:3,lon:3},{lat:4,lon:4}] }], currentVertices: [], featureTypes: [] } }
    });
    const { ctx, ls } = boot({ plotedge_v2: seed });
    ctx.projectData = ctx.loadStore();
    ctx.projectData.p1.savedFeatures[0].vertices = [{lat:1,lon:1},{lat:2,lon:2},{lat:3,lon:3}];
    const ok = ctx.persistStore();
    assert(ok !== false, 'removing a mis-shot vertex from a saved feature was refused');
    assert(JSON.parse(ls._m.get('plotedge_v2')).data.p1.savedFeatures[0].vertices.length === 3, 'the edit did not persist');
  });

  check('losing a whole saved feature is still blocked', () => {
    // The protection that matters must survive the fix above: the guard still has to catch a
    // save that would make a completed feature disappear without an explicit delete.
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    ctx.projectData.p1.savedFeatures = [];
    ctx.projectData.p1.currentVertices = [{ lat: 9, lon: 9 }, { lat: 8, lon: 8 }];  // scratch must not mask it
    ctx.persistStore();
    const after = JSON.parse(ls._m.get('plotedge_v2'));
    assert(after.data.p1.savedFeatures.length === 1,
      'a completed feature was wiped by a non-destructive save, masked by scratch vertices');
  });

  // ── rolling backup + recovery ────────────────────────────────────────────
  check('every successful save leaves a restorable previous copy behind', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    ctx.projects.push({ id: 'p3', name: 'Survey C' });
    ctx.persistStore();
    const bak = ls._m.get('plotedge_v2_bak');
    assert(bak, 'no backup slot was written');
    assert(JSON.parse(bak).projects.length === 2, 'backup does not hold the previous good state');
  });

  check('an unreadable primary falls back to the backup instead of starting empty', () => {
    const { ctx } = boot({
      plotedge_v2: '}{ truncated',
      plotedge_v2_bak: goodStore()
    });
    const data = ctx.loadStore();
    assert(ctx.projects.length === 2, `expected 2 projects recovered from backup, got ${ctx.projects.length}`);
    assert(data.p1.savedFeatures.length === 1, 'features were not recovered from the backup');
  });

  check('a truncated write is detected and rolled back', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    const real = ls.setItem.bind(ls);
    // A partial write is a transient failure (quota pressure, interrupted IO),
    // so only the first attempt is truncated — a stub that corrupted the
    // rollback too would be testing an impossible device.
    let tripped = false;
    ls.setItem = (k, v) => {
      if (k === 'plotedge_v2' && !tripped) { tripped = true; return real(k, String(v).slice(0, 20)); }
      return real(k, v);
    };
    ctx.projects.push({ id: 'p3', name: 'Survey C' });
    ctx.persistStore();
    ls.setItem = real;
    let restored = null;
    try { restored = JSON.parse(ls._m.get('plotedge_v2')); } catch (e) {}
    assert(restored, 'a corrupt value was left in the primary slot after a failed write');
    assert(restored.projects.length === 2, 'rollback did not restore the previous good state');
  });

  check('even if the rollback itself fails, the backup still holds a good copy', () => {
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    const real = ls.setItem.bind(ls);
    ls.setItem = (k, v) => real(k, k === 'plotedge_v2' ? String(v).slice(0, 20) : v); // primary permanently broken
    ctx.projects.push({ id: 'p3', name: 'Survey C' });
    ctx.persistStore();
    ls.setItem = real;
    // Next launch must still find the survey rather than an empty app.
    const fresh = boot({ plotedge_v2: ls._m.get('plotedge_v2'), plotedge_v2_bak: ls._m.get('plotedge_v2_bak') });
    const data = fresh.ctx.loadStore();
    assert(fresh.ctx.projects.length === 2, `expected recovery of 2 projects, got ${fresh.ctx.projects.length}`);
    assert(data.p1.savedFeatures.length === 1, 'captured features were not recoverable');
  });

  // ── cost of a save (this is what a photo-heavy session pays, per photo) ──
  check('a save does not re-read or re-parse the whole store', () => {
    // persist() runs on every photo capture. The first version of the write
    // guard parsed the entire store to work out what was on disk, which is
    // ruinous once the store is full of base64: adding 20 photos meant parsing
    // a growing multi-megabyte string 20 times.
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    let gets = 0;
    const realGet = ls.getItem.bind(ls);
    ls.getItem = k => { if (k === 'plotedge_v2') gets++; return realGet(k); };
    ctx.projects.push({ id: 'p3', name: 'C' });
    ctx.persistStore();
    assert(gets <= 2, `a single save read the primary store ${gets} times`);
  });

  check('the backup is throttled, not written on every save', () => {
    // A second full copy per save doubles both bytes written and localStorage
    // occupancy — halving how many photos fit before the quota is reached.
    const { ctx, ls } = boot({ plotedge_v2: goodStore() });
    ctx.projectData = ctx.loadStore();
    let bakWrites = 0;
    const realSet = ls.setItem.bind(ls);
    ls.setItem = (k, v) => { if (k === 'plotedge_v2_bak') bakWrites++; return realSet(k, v); };
    for (let n = 0; n < 10; n++) { ctx.projects.push({ id: 'x' + n, name: 'x' }); ctx.persistStore(); }
    assert(bakWrites === 1, `expected 1 throttled backup write across 10 saves, got ${bakWrites}`);
  });

  check('nothing on the save path clones the store just to measure it', () => {
    // Both getStorageUsageInfo() and getProjectStats() used to wrap a full
    // JSON.stringify in a Blob purely to read .size. Both run on every save;
    // with base64 photos in the store that is several complete copies per
    // captured photo.
    const code = html.replace(/\/\/[^\n]*/g, '');   // strip comments so prose can't match
    assert(!/new Blob\(\[\s*raw\s*\]\)/.test(code),
      'getStorageUsageInfo still clones the whole store into a Blob to measure it');
    assert(!/new Blob\(\[\s*JSON\.stringify\(d\)\s*\]\)/.test(code),
      'getProjectStats still clones each project into a Blob to measure it');
  });

  check('the per-save widget refresh does not serialise every project', () => {
    // publishWidgetSummary() runs at the end of every persistStore() and only
    // reads .synced, but was paying for a full serialisation of every project.
    assert(/getProjectStats\(pr,\s*\{\s*skipBytes:\s*true\s*\}\)/.test(html),
      'the widget summary still asks for byte sizes it never reads, on every save');
  });

  check('storage usage counts the backup slot, not just the primary', () => {
    // Both live in the same quota. Reporting only the primary meant the meter
    // read half the truth exactly when it mattered, and the pre-flight check
    // that refuses new photos would let them through until the write failed.
    assert(/backupBytes/.test(html), 'usage does not account for the backup copy');
  });

  // ── crash-safe draft autosave ────────────────────────────────────────────
  check('in-progress capture form is autosaved outside the main store', () => {
    assert(/DRAFT_KEY/.test(html), 'no separate draft key for in-flight capture state');
    assert(/function saveCollectDraft/.test(html), 'no saveCollectDraft()');
    assert(/function restoreCollectDraft/.test(html), 'no restoreCollectDraft()');
  });

  check('draft is flushed on the events Android actually fires when killing the app', () => {
    // Android does not reliably fire "unload" when it reclaims a backgrounded
    // WebView; visibilitychange/pagehide are the two that do.
    assert(/visibilitychange[\s\S]{0,400}saveCollectDraft|saveCollectDraft[\s\S]{0,400}visibilitychange/.test(html),
      'draft is not flushed on visibilitychange');
    assert(/pagehide/.test(html), 'draft is not flushed on pagehide');
  });

  check('draft survives a simulated crash and is offered back', () => {
    const { ctx, ls } = boot({});
    ctx.writeDraft({ projectId: 'p1', name: 'Beacon 12', ftId: 'ft1', attrs: { depth: '4.2' } });
    const raw = ls._m.get('plotedge_collect_draft');
    assert(raw, 'draft was not written');
    const back = ctx.readDraft('p1');
    assert(back && back.name === 'Beacon 12' && back.attrs.depth === '4.2', 'draft did not round-trip');
  });
}

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  store: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
