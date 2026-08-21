'use strict';
// ══ THE DEVICE SCAN ══
// findAllDeviceBackupFiles() used to read only Documents/PlotEdge and Storage/PlotEdge — the two
// folders saveExportFile() writes to — so it could only ever find a backup that had never left the
// device. The two situations where somebody most needs it are the opposite: a new handset, or a
// project sent over by a colleague, where the file lands in Download or the root of Documents. The
// scan answered "no backups found", which does not read as "I only looked in one folder".
//
// Everything here is driven through a mocked Capacitor Filesystem, because the real one exists
// only inside the APK: this is the one path in the app that cannot be exercised by opening it in a
// browser, which is why it shipped wrong.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/',
  beforeParse(w) {
    const anything = new Proxy(function () {}, {
      get: (t, k) => (k === 'then' ? undefined : anything), apply: () => anything, construct: () => anything
    });
    w.L = anything; w.JSZip = function () {};
    w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
    w.scrollTo = () => {};
    w.HTMLElement.prototype.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
    w.URL.createObjectURL = () => 'blob:stub'; w.URL.revokeObjectURL = () => {};
    w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
    w.onerror = () => true;
  }
});
const w = dom.window, d = w.document;
for (const f of jsOrder) {
  const el = d.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  d.head.appendChild(el);
}

const results = [];
const ok = (c, m) => results.push({ name: m, ok: !!c });

// ── a device shaped like a real reinstall: the file arrived by WhatsApp, into Download ──
const jsonBackup = {
  peBackup: w.eval('PE_BACKUP_VERSION'), kind: 'all',
  projects: [{ id: 'a', name: 'Ward 7' }, { id: 'b', name: 'Mabvuku' }],
  data: { a: { savedFeatures: [1, 2, 3] }, b: { savedFeatures: [4] } }
};
const jsonB64 = Buffer.from(JSON.stringify(jsonBackup), 'utf8').toString('base64');

const DEVICE = {
  DOCUMENTS: { 'PlotEdge': [{ name: 'Site_A.plotpack', type: 'file', mtime: 300, size: 24 * 1024 * 1024 }],
               '': [{ name: 'PlotEdge', type: 'directory' }, { name: 'notes.txt', type: 'file' }] },
  EXTERNAL_STORAGE: { 'Download': [{ name: 'handover.plotedge.json', type: 'file', mtime: 500, size: 900 },
                                   { name: 'invoice.pdf', type: 'file', mtime: 900 }],
                      '': [] }
};
let readdirCalls = [];
w.eval(`window.__caps = {};`);
const Filesystem = {
  async readdir({ path: p, directory }) {
    readdirCalls.push(directory + ':' + p);
    const dir = DEVICE[directory];
    if (!dir || dir[p] === undefined) throw new Error('ENOENT');
    return { files: dir[p] };
  },
  async stat() { throw new Error('no stat'); },
  async readFile({ path: p }) {
    if (/handover\.plotedge\.json$/.test(p)) return { data: jsonB64 };
    throw new Error('unreadable');
  }
};
w.capPlugin = name => (name === 'Filesystem' ? Filesystem : null);
w.eval('capPlugin = window.capPlugin;');

(async () => {
  const found = await w.eval('findAllDeviceBackupFiles()');

  ok(found.length === 2, `finds both backups (got ${found.length}: ${found.map(f => f.name).join(', ')})`);
  ok(found.some(f => f.name === 'handover.plotedge.json' && f.where === 'Download'),
    'finds the file that arrived in Download — the case the old scan missed entirely');
  ok(!found.some(f => /\.pdf$/.test(f.name)), 'ignores non-backup files');
  ok(!found.some(f => f.name === 'PlotEdge'), 'does not mistake the PlotEdge folder for a file');
  ok(found[0].name === 'handover.plotedge.json', 'newest first');
  ok(found.every(f => f.path && f.dir), 'every entry carries a readable path, not just a name');
  ok(readdirCalls.length >= 5, `searches every configured location (${readdirCalls.length} readdir calls)`);

  // deduplication: Documents/PlotEdge is reachable via the Documents root listing too
  const keys = found.map(f => w.eval('backupFileKey')(f));
  ok(new Set(keys).size === keys.length, 'no duplicate entries across overlapping locations');

  // ── content peek: names the projects inside a small JSON backup ──
  const jsonEntry = found.find(f => /\.plotedge\.json$/.test(f.name));
  await w.eval('peekBackupContents')(jsonEntry);
  ok((jsonEntry.projectNames || []).join(',') === 'Ward 7,Mabvuku', 'reads the project names out of the backup');
  ok(jsonEntry.featureCount === 4, `counts the features inside (got ${jsonEntry.featureCount})`);
  const desc = w.eval('describeBackupEntry')(jsonEntry);
  ok(/Ward 7/.test(desc) && /Download/.test(desc), 'the row says what is inside and where it is: ' + desc);

  // ── the big .plotpack is never opened ──
  const pack = found.find(f => /\.plotpack$/.test(f.name));
  await w.eval('peekBackupContents')(pack);
  ok(!pack.projectNames, 'a 24 MB .plotpack is not read into memory just to label a row');
  ok(/24 MB/.test(w.eval('describeBackupEntry')(pack)), 'it still shows a size');

  // ── duplicate warning ──
  w.eval(`projects = [{ id:'zzz', name:'ward 7' }];`);
  ok(w.eval('backupLooksAlreadyRestored')(jsonEntry), 'warns when a project of that name is already here');
  w.eval(`projects = [];`);
  ok(!w.eval('backupLooksAlreadyRestored')(jsonEntry), 'and stays quiet when it is not');

  // ── empty scan OFFERS the picker instead of launching it ──
  // This assertion was inverted deliberately. It used to require that an empty scan open the OS
  // file picker on its own, which is what made the Restore button feel like an ambush: one tap
  // closed the sheet, fired a toast and threw up a system dialog, all on the COMMON path — a scan
  // finding nothing is the normal outcome whenever the backup arrived by chat or Drive. The sheet
  // now stays put on a "nothing found" step whose primary button is the picker. Same destination,
  // one deliberate tap instead of a hijack, and no dead end either — which is what the original
  // test was really protecting.
  w.eval('triggerBackupImport = () => { window.__picked = true; };');
  w.__picked = false;
  const emptyFs = { readdir: async () => { throw new Error('ENOENT'); } };
  w.capPlugin = n => (n === 'Filesystem' ? emptyFs : null);
  w.eval('capPlugin = window.capPlugin;');
  await w.eval('welcomeRestore()');
  ok(!w.__picked, 'an empty scan does not force the file picker open by itself');
  ok(d.getElementById('restoreModal').classList.contains('show'),
    'the sheet stays open on the nothing-found step rather than vanishing');
  ok(/Pick a file/.test(d.getElementById('restorePrimary').textContent),
    'the picker is offered as the primary action');
  ok(!/^\s*$/.test(d.getElementById('restoreBody').textContent),
    'the nothing-found step explains where it looked');
  // And the offer still works when taken.
  w.eval('restorePrimaryAction()');
  ok(w.__picked, 'pressing Pick a file opens the picker');

  // ── no Filesystem at all (web build) goes straight to the picker ──
  w.__picked = false;
  w.capPlugin = () => null;
  w.eval('capPlugin = window.capPlugin;');
  await w.eval('welcomeRestore()');
  ok(w.__picked, 'on web the row opens the picker instead of apologising');

  // ── the row is no longer left in its scanning state ──
  ok(!d.getElementById('importBackupBtn').classList.contains('is-scanning'),
    'the spinner state is always cleared');

  let pass = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.ok) pass++;
  }
  console.log(`\n  backup-scan: ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
