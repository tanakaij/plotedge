'use strict';
// Round-trips a real .plotpack bundle: builds one from a seeded project, reads it
// back, and asserts the restored project is the same survey — schema, per-vertex
// data, photos and all. Also covers the widget theme payload.
//
// The reason this is a driven test and not a static one: a lossy export is
// syntactically perfect. It parses, it downloads, it opens in QGIS. The loss
// only shows up months later when someone tries to restore it and the feature
// types are gone. The only way to catch that is to actually restore one and
// compare.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const results = [];
const check = (name, fn) => {
  const done = r => results.push(r);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.then(() => done({ name, ok: true }), e => done({ name, ok: false, msg: e.message }));
    done({ name, ok: true });
  } catch (e) { done({ name, ok: false, msg: e.message }); }
  return Promise.resolve();
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// A 1x1 JPEG as a data URL — small, but genuinely binary once decoded, which is
// the point: the bundle must carry real bytes, not base64 in JSON.
const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/',
  beforeParse(w) {
    w.JSZip = JSZip;
    w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
    w.scrollTo = () => {};
    w.HTMLElement.prototype.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
    w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    w.indexedDB = new FDBFactory();
    w.IDBKeyRange = FDBKeyRange;
    w.onerror = msg => { errors.push(String(msg)); return true; };
  }
});
const w = dom.window;
w.__media = new Map();
// Node's Uint8Array, not jsdom's. JSZip runs in the node realm and does an
// instanceof check, which fails across realms — a jsdom Uint8Array is not a node
// one however identical the bytes.
w.__U8 = Uint8Array;
w.addEventListener('error', e => errors.push(e.message || String(e.error)));
for (const f of jsOrder) {
  const el = w.document.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  try { w.document.head.appendChild(el); } catch (e) { errors.push(`js/${f}: ${e.message}`); }
}
const run = code => w.eval(code);

// jsdom does not fetch <link rel=stylesheet>, so css/01-tokens.css never lands
// and getComputedStyle sees no custom properties at all. Inject the dark-theme
// token values the widget palette reads, so this suite tests the resolver rather
// than jsdom's resource loader.
{
  const st = w.document.createElement('style');
  st.textContent = `:root{--card-bg:#141A26;--card-border:#26314A;--text-tertiary:#7C8AA5;
    --text-primary:#FFFFFF;--text-secondary:#A9B4C7;--accent-primary:#10B981;--warn:#F59E0B;
    --surface-sunken:#161F30;--on-accent:#052E22;}`;
  w.document.head.appendChild(st);
}

// ══ WHY THE MEDIA STORE IS STUBBED ══
// fake-indexeddb's structured clone does not preserve a jsdom Blob: a photo
// written as a Blob reads back as a plain object, so photoBlobToDataUrl() gets
// nothing and every photo silently vanishes. That is a limitation of the test
// doubles, not of the app — on a real WebView the round trip works. Stubbing it
// with an in-memory map keeps this suite pointed at the bundle packing and
// restore logic, which is the code actually under test here.
let mediaStore = new Map();

// Captures whatever the export hands to saveExportFile, instead of writing a
// file. The bundle bytes are the thing under test; where they land is not.
let lastExport = null;
run(`
  // Node's JSZip cannot read a jsdom Blob either, so the data-URL decoder hands
  // back a Uint8Array here. Same bytes, a type both sides understand — a real
  // WebView's Blob works with the browser build of JSZip untouched.
  photoDataUrlToBlobSync = function(dataUrl){
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new globalThis.__U8(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  // JSZip's async('blob') gives a real Blob in a browser but not under node, and
  // FileReader cannot read what it returns here. Same substitution as above:
  // bytes in, data URL out, so the restore path itself is still exercised.
  photoBlobToDataUrl = function(b){
    if (!b) return Promise.resolve('');
    if (typeof b === 'string') return Promise.resolve(b);
    let bin = '';
    const bytes = new globalThis.__U8(b.buffer ? b.buffer : b);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return Promise.resolve('data:image/jpeg;base64,' + btoa(bin));
  };
  photoStoreSave = function(p){ globalThis.__media.set(p.id, p.dataUrl); return Promise.resolve(true); };
  photoStoreGet  = function(id){ const u = globalThis.__media.get(id); return Promise.resolve(u ? { full: u, thumb: u } : null); };
  photoStoreIdle = function(){ return Promise.resolve(); };
  photoStoreShed = function(){};
  photoStoreHydrate = function(list){
    (list || []).forEach(p => { const u = globalThis.__media.get(p.id); if (u) p.dataUrl = u; });
    return Promise.resolve((list || []).length);
  };
  saveExportFile = function(content, name, mime){
    globalThis.__lastExport = { content, name, mime };
    return Promise.resolve({ ok: true, native: false, path: name });
  };
  noteExportSaved = function(){};
`);

// A survey with everything a delivery format throws away: a typed schema with
// options, a feature-level photo, a VERTEX-level photo, and per-vertex accuracy.
run(`
  projects = [{ id: 'p1', name: 'Bundle Test', createdAt: '2026-01-01T00:00:00Z',
    client: 'Ministry of Transport', manager: 'T. Moyo', site: 'Harare Ring Road',
    description: 'Condition survey', siteLat: -17.82, siteLon: 31.05,
    updatedAt: '2026-01-02T00:00:00Z', lastExportedAt: '2026-01-03T00:00:00Z' }];
  projectData = { p1: { savedFeatures: [], currentVertices: [], featureTypes: [
    { id: 'road', name: 'Road', geometryType: 'line', fields: [
      { id: 'surface', label: 'Surface', type: 'single_select', options: ['gravel','paved'] },
      { id: 'defect', label: 'Defect here', type: 'text', scope: 'vertex' }
    ] }
  ] } };
  openProject('p1');
`);

const main = (async () => {
  await check('a photo can be written to the media store', async () => {
    await w.photoStoreSave({ id: 'ph_a', dataUrl: JPEG_1PX, thumbUrl: JPEG_1PX });
    await w.photoStoreSave({ id: 'ph_b', dataUrl: JPEG_1PX, thumbUrl: JPEG_1PX });
    assert(w.__media.size === 2, 'the fixture photos are not in the store');
    // Cleared so the restore has to genuinely put them back rather than finding
    // them already there.
    mediaStore = new Map(w.__media);
  });

  await check('a bundle is produced, and it is a ZIP with a stored mimetype first', async () => {
    run(`
      savedFeatures = [{
        id: 'f1', name: 'Main Street', featureTypeId: 'road', layer: 'Road',
        attrs: { surface: 'gravel' },
        photos: [{ id: 'ph_a', name: 'a.jpg' }],
        vertices: [
          { lat: -17.82, lon: 31.05, acc: 3.5, time: '2026-01-01T00:00:00Z',
            attrs: { defect: 'pothole' }, photos: [{ id: 'ph_b', name: 'b.jpg' }] },
          { lat: -17.83, lon: 31.06, acc: 4.1, time: '2026-01-01T00:01:00Z', attrs: {}, photos: [] }
        ],
        savedAt: '2026-01-01T00:02:00Z'
      }];
      projectNotes = 'Survey run in the rain.';
    `);
    await w.exportPlotpack();
    lastExport = w.__lastExport;
    assert(lastExport, 'nothing was handed to saveExportFile');
    // The export hands over a jsdom Blob, which node's JSZip cannot read
    // directly. Pull the bytes out once and work with those.
    lastExport.bytes = Buffer.from(await lastExport.content.arrayBuffer());
    assert(/\.plotpack$/.test(lastExport.name), `wrong extension: ${lastExport.name}`);
    assert(lastExport.mime === 'application/vnd.plotedge.plotpack+zip', `wrong mime: ${lastExport.mime}`);

    const zip = await JSZip.loadAsync(lastExport.bytes);
    // The EPUB trick: identifiable by content after someone renames it.
    assert(zip.file('mimetype'), 'no mimetype entry');
    assert(Object.keys(zip.files)[0] === 'mimetype', 'mimetype is not the first entry');
    assert(await zip.file('mimetype').async('string') === 'application/vnd.plotedge.plotpack+zip',
      'the mimetype entry does not name the format');
  });

  await check('the bundle carries every part, including readable ones', async () => {
    const zip = await JSZip.loadAsync(lastExport.bytes);
    for (const f of ['manifest.json', 'schema.json', 'features.json', 'features.geojson', 'notes.md', 'README.txt']) {
      assert(zip.file(f), `${f} missing from the bundle`);
    }
    // Photos as real files, not base64 inside JSON — the whole reason it is a ZIP.
    assert(zip.file('photos/ph_a.jpg'), 'the feature photo is not in the bundle as a file');
    assert(zip.file('photos/ph_b.jpg'), 'the VERTEX photo is not in the bundle as a file');
    const featuresText = await zip.file('features.json').async('string');
    assert(!featuresText.includes('data:image'), 'features.json still embeds base64 photo data');
    // The part that makes it useful to somebody without PlotEdge.
    const gj = JSON.parse(await zip.file('features.geojson').async('string'));
    assert(gj.type === 'FeatureCollection' && gj.features.length, 'the embedded GeoJSON is empty');
  });

  await check('the manifest states a version and checksums each part', async () => {
    const zip = await JSZip.loadAsync(lastExport.bytes);
    const m = JSON.parse(await zip.file('manifest.json').async('string'));
    assert(m.format === 'plotpack', 'the manifest does not identify the format');
    assert(m.formatVersion === 1, `unexpected format version ${m.formatVersion}`);
    assert(m.counts.features === 1 && m.counts.photos === 2,
      `counts wrong: ${JSON.stringify(m.counts)}`);
    assert(m.checksums && m.checksums['features.json'], 'no checksum for features.json');
  });

  await check('restoring rebuilds the survey — schema, vertex data and photos', async () => {
    // preparePlotpackImport takes anything JSZip.loadAsync accepts, plus a .name.
    const file = lastExport.bytes;
    file.name = 'Bundle_Test.plotpack';
    await w.preparePlotpackImport(file);
    assert(run('pendingPlotpackImport'), 'the bundle was rejected at the wizard stage');
    await w.importPlotpackBundle();

    const restored = run(`projects.find(p => p.name.indexOf('Bundle Test') === 0 && p.id !== 'p1')`);
    assert(restored, 'no new project was created');
    const d = run(`projectData[${JSON.stringify(restored.id)}]`);
    assert(d.featureTypes.length === 1, 'the schema did not survive');
    // The thing every delivery format loses.
    assert(d.featureTypes[0].fields.find(f => f.id === 'surface').options.length === 2,
      'the select options did not survive');
    assert(d.featureTypes[0].fields.find(f => f.id === 'defect').scope === 'vertex',
      'the vertex-scoped field lost its scope');
    assert(d.savedFeatures.length === 1, 'the feature did not survive');
    const f = d.savedFeatures[0];
    assert(f.attrs.surface === 'gravel', 'feature attributes did not survive');
    assert(f.vertices[0].attrs.defect === 'pothole', 'PER-VERTEX attributes did not survive');
    assert(f.vertices[0].acc === 3.5, 'per-vertex accuracy did not survive');
    assert(d.notes === 'Survey run in the rain.', 'project notes did not survive');
  });

  await check('the project header survives — client, site, manager, coordinates', () => {
    // These feed the Plan Sheet title block and the Survey Register masthead. A
    // bundle that restores every feature but loses them produces a survey that
    // is complete as data and unissuable as a document.
    const restored = run(`projects.find(p => p.id !== 'p1' && p.name.indexOf('Bundle Test') === 0)`);
    assert(restored, 'no restored project to check');
    assert(restored.client === 'Ministry of Transport', `client lost: ${restored.client}`);
    assert(restored.manager === 'T. Moyo', `manager lost: ${restored.manager}`);
    assert(restored.site === 'Harare Ring Road', `site lost: ${restored.site}`);
    assert(restored.description === 'Condition survey', 'description lost');
    assert(restored.siteLat === -17.82 && restored.siteLon === 31.05, 'site coordinates lost');
    // Provenance kept, device-specific state not.
    assert(restored.createdAt === '2026-01-01T00:00:00Z', 'the original creation date was not kept');
    assert(restored.id !== 'p1', 'the restored project reused the source id');
    assert(restored.lastExportedAt === null,
      'the restore inherited an export stamp, so it would claim to have been delivered already');
  });

  await check('the restored photos are really back in the media store', async () => {
    // Wiped before the restore ran? No — so prove the restore WROTE them, by
    // checking the bytes came back out of the bundle rather than out of the
    // pre-existing store.
    w.__media.clear();
    run('pendingPlotpackImport = null');
    const file = lastExport.bytes; file.name = 'again.plotpack';
    await w.preparePlotpackImport(file);
    await w.importPlotpackBundle();
    assert(w.__media.get('ph_a'), 'the feature photo was not restored from the bundle');
    assert(w.__media.get('ph_b'), 'the VERTEX photo was not restored from the bundle');
    assert(String(w.__media.get('ph_a')).startsWith('data:image/jpeg'),
      'the restored photo is not a JPEG data URL');
  });

  // ══ THE SAME BUNDLE, DRIVEN THROUGH THE RESTORE SHEET ══
  // Every check above calls preparePlotpackImport()/importPlotpackBundle() directly, which is the
  // right level for asking "did the survey survive the round trip". It is the wrong level for
  // asking "did the person see what happened" — and that is the half that was broken. The sheet
  // sits between those functions and the screen: it reads pendingPlotpackImport to build its
  // confirm step, hooks the photo loop to drive its progress bar, and reads the importer's return
  // value to report what came back. None of that is exercised by calling the importer directly, and
  // none of it throws when it is wrong; it just puts the wrong numbers on screen.
  // tests/restore-sheet.test.js drives the same flow with a JSON backup, where JSZip is stubbed.
  // This is the one place a REAL .plotpack — real zip, real checksums, real photo bytes — goes
  // through it.
  await check('the restore sheet reports a real .plotpack accurately, start to finish', async () => {
    w.__media.clear();
    run('pendingPlotpackImport = null');
    const file = lastExport.bytes; file.name = 'Sheet_Run.plotpack';

    // Every progress report is recorded, so the bar can be checked for the two failures that matter:
    // never moving, and lying about the total.
    run('globalThis.__prog = []; globalThis.__realProg = restoreSetProgress; restoreSetProgress = (d,t) => { globalThis.__prog.push([d,t]); return globalThis.__realProg(d,t); };');

    run("openRestoreSheet(null,{source:'file'})");
    await w.restorePreparePack(file);

    const bodyText = () => w.document.getElementById('restoreBody').textContent;
    assert(run('pendingPlotpackImport'), 'the sheet did not leave a pending import to confirm');
    // The counts are the whole reason the Check step exists: it is the one moment someone can tell
    // whether the file they picked is the survey they think it is.
    assert(/Bundle Test/.test(bodyText()), `the confirm step does not name the project: ${bodyText()}`);
    assert(/Features/.test(bodyText()) && /Photos/.test(bodyText()),
      'the confirm step is not showing the counts');
    assert(/new project/.test(bodyText()),
      'the confirm step dropped the "into a new project, nothing is touched" promise');
    // Still nothing written at this point — that is what the step is promising.
    assert(w.__media.size === 0, 'the Check step wrote photos before the person confirmed');
    assert(/Restore as a new project/.test(w.document.getElementById('restorePrimary').textContent),
      'the primary button does not commit');

    const before = run('projects.length');
    await w.restoreCommit();

    assert(run('projects.length') === before + 1, 'confirming did not restore the project');
    assert(w.__media.get('ph_a') && w.__media.get('ph_b'),
      'the sheet path did not restore the photos the direct path does');

    // The bar has to have moved, and its total has to be the real photo count — a bundle carrying
    // two photos that reports "photo 1 of 1" is worse than no bar.
    const prog = run('globalThis.__prog');
    assert(prog.length >= 3, `the progress bar barely reported: ${JSON.stringify(prog)}`);
    assert(prog.every(([, t]) => t === 2), `the progress total is not the real photo count: ${JSON.stringify(prog)}`);
    assert(prog[prog.length - 1][0] === 2, `the bar never reached the end: ${JSON.stringify(prog)}`);

    // And the finished step has to say what actually came back, from the importer's own numbers.
    assert(/Restored/.test(bodyText()), 'the sheet did not reach its finished step');
    assert(/1 feature\b/.test(bodyText()) && /2 photos/.test(bodyText()),
      `the finished step misreports what was restored: ${bodyText()}`);

    // The write is over, so the sheet must be dismissable again.
    assert(run('restoreIsLocked()') === false, 'the sheet stayed locked after the restore finished');
    run('closeRestoreModal()');
    assert(!w.document.getElementById('restoreModal').classList.contains('show'),
      'the sheet would not close once the restore was done');
    // The hook must not survive the call: left set, the Import screen’s own restores would report
    // into a sheet that is not on screen.
    assert(run('plotpackProgressHook') === null, 'the progress hook was left attached after the restore');
    run('restoreSetProgress = globalThis.__realProg;');
  });

  await check('restoring never overwrites — it lands as a separate project', async () => {
    // v1 is deliberately new-project-only. A duplicate project is a nuisance; a
    // silently merged one is lost work.
    // p1 must still be the project the test seeded — not replaced, not merged.
    assert(run(`projectData.p1.featureTypes.length`) === 1, 'the original project was rewritten');
    assert(run(`projects.find(p => p.id === 'p1').name`) === 'Bundle Test', 'the original was renamed');
    const names = run(`projects.map(p => p.name)`);
    // Two restores have run by now; each one is its own project and none of them
    // touched the original.
    assert(names.filter(n => n.indexOf('Bundle Test') === 0).length >= 2,
      `the restore did not create a separate project: ${JSON.stringify(names)}`);
    assert(new Set(names).size === names.length, `duplicate project names: ${JSON.stringify(names)}`);
  });

  await check('a bundle from a future version is refused, not guessed at', async () => {
    const zip = await JSZip.loadAsync(lastExport.bytes);
    const m = JSON.parse(await zip.file('manifest.json').async('string'));
    m.formatVersion = 99;
    zip.file('manifest.json', JSON.stringify(m));
    const blob = await zip.generateAsync({ type: 'nodebuffer' });
    run('pendingPlotpackImport = null');
    await w.preparePlotpackImport(Object.assign(blob, { name: 'future.plotpack' }));
    assert(!run('pendingPlotpackImport'), 'a newer-format bundle was accepted anyway');
  });

  await check('a truncated bundle is refused by its checksum', async () => {
    // Chat apps and Bluetooth truncate large attachments. A half-written restore
    // that reports success is exactly the corruption to avoid.
    const zip = await JSZip.loadAsync(lastExport.bytes);
    zip.file('features.json', '[{"id":"tampered"}]');
    const blob = await zip.generateAsync({ type: 'nodebuffer' });
    run('pendingPlotpackImport = null');
    await w.preparePlotpackImport(Object.assign(blob, { name: 'damaged.plotpack' }));
    assert(!run('pendingPlotpackImport'), 'a damaged bundle passed the checksum gate');
  });

  await check('a plain ZIP that is not a bundle is refused', async () => {
    const z = new JSZip();
    z.file('hello.txt', 'not a bundle');
    const blob = await z.generateAsync({ type: 'nodebuffer' });
    run('pendingPlotpackImport = null');
    await w.preparePlotpackImport(Object.assign(blob, { name: 'random.plotpack' }));
    assert(!run('pendingPlotpackImport'), 'an unrelated ZIP was accepted as a bundle');
  });

  await check('the import picker offers .plotpack', () => {
    const accept = w.document.getElementById('importFileInput').getAttribute('accept');
    assert(accept.includes('.plotpack'), `the file picker does not offer .plotpack: ${accept}`);
  });

  // ── the picker actually offers them ──
  await check('every export format is reachable from the dropdown, and vice versa', () => {
    // The bug this exists for: PlotPack and the settings pack were both added to
    // EXPORT_FORMATS and to the docs and to this suite, and neither was ever added
    // as an <option>. Every test passed. The features were unclickable.
    // runSelectedExport() reads the select's value and looks it up in
    // EXPORT_FORMATS, so the two lists have to agree in BOTH directions: a format
    // with no option is unreachable, an option with no format throws on selection.
    const keys = Object.keys(run('EXPORT_FORMATS')).sort();
    const opts = [...w.document.querySelectorAll('#exportFormatSelect option')]
      .map(o => o.value).sort();
    const missingOption = keys.filter(k => !opts.includes(k));
    const orphanOption = opts.filter(o => !keys.includes(o));
    assert(!missingOption.length,
      `these formats exist but cannot be chosen: ${missingOption.join(', ')}`);
    assert(!orphanOption.length,
      `these options name a format that does not exist: ${orphanOption.join(', ')}`);
  });

  await check('the picker stays navigable — grouped, and not an endless list', () => {
    const sel = w.document.getElementById('exportFormatSelect');
    const groups = sel.querySelectorAll('optgroup');
    const opts = sel.querySelectorAll('option');
    assert(groups.length >= 3, `${groups.length} groups for ${opts.length} options — too flat to scan`);
    // Not a hard product limit, a tripwire. Past roughly this many a dropdown
    // stops being scannable on a phone and the screen needs rethinking rather
    // than one more entry appended.
    assert(opts.length <= 16, `${opts.length} export formats — time to rethink the screen, not add another`);
    [...groups].forEach(g => {
      assert(g.querySelectorAll('option').length <= 6,
        `the "${g.label}" group has ${g.querySelectorAll('option').length} entries`);
    });
  });

  await check('the re-importable formats are grouped together and come first', () => {
    const sel = w.document.getElementById('exportFormatSelect');
    const first = sel.querySelector('optgroup');
    const vals = [...first.querySelectorAll('option')].map(o => o.value);
    // These answer a different question from the rest: everything else hands data
    // to other software, these move a project or a device.
    assert(vals.includes('plotpack'), 'PlotPack is not in the first group');
    assert(vals.includes('settings'), 'the settings pack is not in the first group');
    assert(vals[0] === 'plotpack', `the first option is "${vals[0]}", not the main native format`);
  });

  // ── device settings pack ──
  await check('a settings pack exports, and carries preferences not data', async () => {
    run(`
      localStorage.setItem('plotedge_theme','light');
      localStorage.setItem('plotedge_units','feet');
      localStorage.setItem('plotedge_gh_owner','someone');
      localStorage.setItem('plotedge_gh_token','ghp_SECRET_TOKEN_VALUE');
    `);
    await w.exportDeviceSettings();
    const bytes = Buffer.from(await w.__lastExport.content.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const m = JSON.parse(await zip.file('manifest.json').async('string'));
    assert(m.format === 'plotpack-settings', `wrong kind: ${m.format}`);
    const settings = JSON.parse(await zip.file('settings.json').async('string'));
    assert(settings.plotedge_theme === 'light', 'the theme was not packed');
    assert(settings.plotedge_units === 'feet', 'the units were not packed');
    assert(settings.plotedge_gh_owner === 'someone', 'the publishing target was not packed');
    // THE one that matters: a pack is designed to be emailed between phones.
    assert(!('plotedge_gh_token' in settings), 'a GitHub ACCESS TOKEN was written into the pack');
    const whole = await zip.file('settings.json').async('string');
    assert(!whole.includes('ghp_SECRET_TOKEN_VALUE'), 'the token leaked into the pack anyway');
    w.__settingsPack = bytes;
  });

  await check('a settings pack restores preferences and refuses unknown keys', async () => {
    run(`
      localStorage.setItem('plotedge_theme','dark');
      localStorage.setItem('plotedge_units','metres');
      showConfirm = function(){};            // skip the restart prompt
    `);
    const file = w.__settingsPack; file.name = 'settings.plotpack';
    run('pendingPlotpackImport = null');
    await w.preparePlotpackImport(file);
    assert(run('pendingPlotpackImport && !!pendingPlotpackImport.settings'),
      'the settings pack was not recognised');
    // A hand-edited pack must not be able to write a key the app never meant to
    // restore — the allowlist is enforced on the way in as well as out.
    run(`pendingPlotpackImport.settings['plotedge_gh_token'] = 'ghp_INJECTED';`);
    run(`pendingPlotpackImport.settings['totally_unrelated'] = 'x';`);
    w.importDeviceSettings();
    assert(run(`localStorage.getItem('plotedge_theme')`) === 'light', 'the theme was not restored');
    assert(run(`localStorage.getItem('plotedge_units')`) === 'feet', 'the units were not restored');
    assert(run(`localStorage.getItem('plotedge_gh_token')`) === 'ghp_SECRET_TOKEN_VALUE',
      'an injected token overwrote the real one');
    assert(run(`localStorage.getItem('totally_unrelated')`) === null,
      'an unlisted key was written from the pack');
  });

  await check('a settings pack never touches projects', () => {
    assert(run('projects.length') >= 2, 'projects disappeared during a settings restore');
    assert(run(`projectData.p1.featureTypes.length`) === 1, 'the settings restore altered a project');
  });

  // ══ REGRESSION: Welcome/device-scan restore paths silently failing on settings packs ══
  // restoreDetectedBackupAt(), restoreManualScanEntry() and handleWelcomeRestoreFile() each have
  // to rewire the wizard's confirm button by hand (to fold the entry out of their own list once
  // the person decides), and all three used to rewire it straight to importPlotpackBundle() —
  // which reads pendingPlotpackImport.features, undefined on a settings pack — regardless of
  // which kind of pack preparePlotpackImport() had actually detected. That made "Apply these
  // settings" throw, get swallowed by importPlotpackBundle()'s own try/catch, and report "Restore
  // failed, nothing was changed" without ever touching localStorage. runPendingPlotpackImport()
  // is the shared fix all three now call instead — this exercises it directly against a real
  // settings pack, the same way those three call sites do.
  await check('runPendingPlotpackImport() applies a pending settings pack instead of trying to import it as a project', async () => {
    run(`
      localStorage.setItem('plotedge_theme','dark');
      localStorage.setItem('plotedge_units','metres');
      showConfirm = function(){}; // skip the restart prompt
    `);
    const file = w.__settingsPack; file.name = 'settings3.plotpack';
    run('pendingPlotpackImport = null');
    await w.preparePlotpackImport(file);
    assert(run('pendingPlotpackImport && !!pendingPlotpackImport.settings'),
      'the settings pack was not recognised');
    const projectsBefore = run('projects.length');
    await w.runPendingPlotpackImport();
    assert(run(`localStorage.getItem('plotedge_theme')`) === 'light',
      'runPendingPlotpackImport() did not apply the settings pack — the Welcome/device-scan restore paths would silently no-op again');
    assert(run(`localStorage.getItem('plotedge_units')`) === 'feet',
      'runPendingPlotpackImport() only partially applied the settings pack');
    assert(run('projects.length') === projectsBefore,
      'runPendingPlotpackImport() minted a new project from a settings pack — it fell through to importPlotpackBundle()');
    assert(run('pendingPlotpackImport') === null,
      'the pending import was left dangling instead of being cleared on success');
  });

  await check('no restore path calls importPlotpackBundle() directly — every one goes through runPendingPlotpackImport()', () => {
    // Static guard alongside the runtime check above, and deliberately broader than the one it
    // replaces. That one counted `confirmBtn.onclick = async () => {…}` rewire blocks, which only
    // existed because three restore paths each rendered the legacy confirm wizard inline and then
    // patched its buttons by hand. Those paths are gone — they all open the restore sheet
    // (#restoreModal) now — so counting rewire sites would be checking for a pattern that no
    // longer exists and would pass trivially forever.
    //
    // What actually has to stay true is the reason that guard was written: a .plotpack can be
    // EITHER a project pack or a settings pack, and only runPendingPlotpackImport() looks at which.
    // Anything calling importPlotpackBundle() directly reads p.features — undefined on a settings
    // pack — throws, and has the throw swallowed by that function's own try/catch and reported as
    // "Restore failed, nothing was changed" while localStorage is never touched. So this asserts
    // the invariant itself: exactly one caller, and it is the dispatcher.
    const src = fs.readFileSync(path.join(ROOT, 'js', '17b-plotpack.js'), 'utf8');
    const calls = [...src.matchAll(/^(?!\s*(?:\/\/|\*)).*\bimportPlotpackBundle\(\)/gm)].map(m => m[0].trim());
    // The two legitimate mentions: the function's own declaration, and the single call inside
    // runPendingPlotpackImport(). Everything else is a path that has skipped the kind check.
    const offenders = calls.filter(line =>
      !/^async function importPlotpackBundle/.test(line) &&
      !/^return await importPlotpackBundle\(\)/.test(line));
    assert(offenders.length === 0,
      'these call importPlotpackBundle() directly instead of runPendingPlotpackImport(); a settings ' +
      'pack routed through them will silently fail:\n    ' + offenders.join('\n    '));
    assert(/return await importPlotpackBundle\(\);/.test(src),
      'runPendingPlotpackImport() no longer calls importPlotpackBundle() at all');
  });

  await check('the restore sheet is the single confirm surface, and it cannot be dismissed mid-write', () => {
    // The inline hosts are what made the old flow read as the page breaking: the confirm step was
    // written into a hidden div in the middle of the Welcome screen. If one comes back, the mess
    // comes back with it.
    const src = fs.readFileSync(path.join(ROOT, 'js', '17b-plotpack.js'), 'utf8');
    const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert(/id="restoreModal"/.test(shell), 'the restore sheet markup is missing from index.html');
    assert(!/getElementById\('foundBackupWizard'\)/.test(src),
      'something is rendering into the old inline #foundBackupWizard host again');
    // The invariant: a restore that is writing to the store refuses to close. Without this, the X,
    // a backdrop tap or hardware Back can tear the sheet away mid-loop and leave a project holding
    // half its photos with nothing on screen to explain it.
    const close = src.slice(src.indexOf('function closeRestoreModal('));
    assert(/if \(_restoreBusy\) return;/.test(close.slice(0, 1200)),
      'closeRestoreModal() no longer refuses to close while a restore is in flight');
    assert(/closeRestoreModal\(\)/.test(fs.readFileSync(path.join(ROOT, 'js', '07-navigation.js'), 'utf8')),
      'closeTopOverlay() does not route the restore sheet through its own close — hardware Back ' +
      'would fall through to the catch-all and strip .show mid-write');
  });

  // ── widget theme ──
  await check('the widget defers to the system palette by default', () => {
    // Material You is what the rest of the home screen is doing, so matching it is the less
    // surprising default. Returning null is the mechanism: the provider's applyTheme() no-ops on
    // null, which leaves the values-v31 resource palette — and therefore the wallpaper colours —
    // in place. See the note above widgetThemeColors() in js/04-store.js.
    run(`localStorage.removeItem('plotedge_widget_dynamic')`);
    assert(run('widgetFollowsHomeScreen()') === true, 'the widget does not follow the home screen by default');
    assert(run('widgetThemeColors()') === null,
      'a palette was sent while following the home screen — it would paint over the wallpaper colours');
  });

  await check('the widget payload carries the live theme as ARGB ints when asked to', () => {
    run(`setWidgetFollowsHomeScreen(false)`);
    const theme = run('widgetThemeColors()');
    assert(theme, 'no theme palette was resolved');
    for (const key of ['bg', 'title', 'body', 'eyebrow', 'accent', 'warn']) {
      assert(typeof theme[key] === 'number', `${key} is not a number: ${theme[key]}`);
      // Java int range. A bare 0xFF...  would exceed Integer.MAX_VALUE and be
      // rejected by setTextColor.
      assert(theme[key] >= -2147483648 && theme[key] <= 2147483647, `${key} is outside Java int range`);
      assert((theme[key] >>> 24) === 255, `${key} is not fully opaque`);
    }
  });

  await check('the palette is all-or-nothing, never half-resolved', () => {
    // A partial palette would mix app colours with the values/ resources and
    // match neither theme.
    run(`setWidgetFollowsHomeScreen(false)`);
    const theme = run('widgetThemeColors()');
    const keys = Object.keys(theme);
    assert(keys.length === 12, `expected the full palette, got ${keys.length}: ${keys.join(',')}`);
    // Restore the default so nothing after this runs against the wrong mode.
    run(`localStorage.removeItem('plotedge_widget_dynamic')`);
  });

  await check('an unreadable colour yields null rather than a broken palette', () => {
    assert(run(`cssColorToArgb('')`) === null, 'an empty colour returned something');
    assert(run(`cssColorToArgb('not-a-colour')`) !== 0, 'an invalid colour resolved to transparent black');
  });

  await check('nothing threw across the whole run', () => {
    assert(!errors.length, errors.join(' | '));
  });
})();

module.exports = main.then(() => results);
if (require.main === module) {
  main.then(() => {
    let bad = 0;
    for (const r of results) {
      console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
      if (!r.ok) bad++;
    }
    console.log(`\n  plotpack: ${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  });
}
