'use strict';
// Boots the real app in a DOM, puts real captured data in it, and DRIVES the new
// surfaces — PlotAtlas, Analytics, PlotMind — the way a user would.
//
// The other suites are static: they read the source and check its shape. That
// catches a missing <script> tag or a forward reference, and catches nothing at
// all about a screen that opens to a blank box because a percentage height
// resolved against an auto-height parent. Which is exactly the bug this release
// exists to fix, so it gets a suite that would have caught it.
//
// Leaflet is stubbed with a stand-in that returns REAL values from getZoom(),
// getBounds() and latLngToContainerPoint(), rather than the permissive proxy
// smoke.js uses. Clustering and the density grid do arithmetic on those, and a
// proxy that answers every call with another proxy would let a divide-by-proxy
// sail straight through.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
// jsdom ships no IndexedDB, and the media store is where every photo byte now
// lives. Without a real one the strip interlock (correctly) refuses to drop any
// photo's base64, so the storage assertions below would be testing the fallback
// path rather than the shipped one.
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);
const css = [...html.matchAll(/<link rel="stylesheet" href="css\/([^"]+)">/g)]
  .map(m => fs.readFileSync(path.join(ROOT, 'css', m[1]), 'utf8')).join('\n');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
// The media store is async, so a couple of checks have to await it. Same shape,
// same results array — just awaited by the caller.
const checkAsync = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => results.push({ name, ok: true }))
  .catch(e => results.push({ name, ok: false, msg: e.message }));
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── a Leaflet stand-in with real numbers in it ───────────────────────────────
function makeLeaflet(w) {
  const layers = [];
  const drawn = [];
  const mkLayer = (kind, arg, opts) => {
    const o = {
      _kind: kind, _arg: arg, _opts: opts || {},
      _added: [],
      addTo(target) { if (target && target._added) target._added.push(o); if (target && target._kind === 'group') o._group = target; layers.push(o); return o; },
      bindPopup() { return o; },
      on() { return o; },
      clearLayers() { o._added.length = 0; return o; },
      bringToBack() { return o; },
      remove() { return o; },
      getElement() { return null; }
    };
    drawn.push(o);
    return o;
  };
  const map = {
    _added: [], _view: [0, 0], _zoom: 14, _handlers: {},
    setView(ll, z) { map._view = ll; if (z != null) map._zoom = z; return map; },
    fitBounds() { return map; },
    getZoom() { return map._zoom; },
    getCenter() { return { lat: map._view[0], lng: map._view[1] }; },
    invalidateSize() { return map; },
    removeLayer() { return map; },
    addLayer() { return map; },
    on(ev, fn) { String(ev).split(' ').forEach(e => { (map._handlers[e] = map._handlers[e] || []).push(fn); }); return map; },
    fire(ev, payload) { (map._handlers[ev] || []).forEach(fn => fn(payload)); },
    // Real projection maths, near enough: the cluster grid divides by these.
    latLngToContainerPoint(ll) {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat;
      const lon = Array.isArray(ll) ? ll[1] : ll.lng;
      const scale = 256 * Math.pow(2, map._zoom) / 360;
      return { x: (lon + 180) * scale, y: (90 - lat) * scale };
    }
  };
  const bounds = pts => {
    const arr = (pts || []).map(p => (Array.isArray(p) ? p : [p.lat, p.lng]));
    const lats = arr.map(a => a[0]), lons = arr.map(a => a[1]);
    return {
      getNorth: () => Math.max(...lats), getSouth: () => Math.min(...lats),
      getEast: () => Math.max(...lons), getWest: () => Math.min(...lons)
    };
  };
  const L = {
    map: () => map,
    tileLayer: (url, o) => mkLayer('tile', url, o),
    layerGroup: () => {
      const g = mkLayer('group');
      const base = g.clearLayers;
      g.clearLayers = () => { for (let i = drawn.length - 1; i >= 0; i--) if (drawn[i]._group === g) drawn.splice(i, 1); return base(); };
      g.addTo = t => { if (t && t._added) t._added.push(g); return g; };
      return g;
    },
    circle: (ll, o) => mkLayer('circle', ll, o),
    circleMarker: (ll, o) => mkLayer('circleMarker', ll, o),
    polyline: (ll, o) => mkLayer('polyline', ll, o),
    polygon: (ll, o) => mkLayer('polygon', ll, o),
    rectangle: (ll, o) => mkLayer('rectangle', ll, o),
    marker: (ll, o) => mkLayer('marker', ll, o),
    divIcon: o => o,
    latLngBounds: bounds,
    control: {
      zoom: () => ({ addTo() {} }),
      scale: () => ({ addTo() {} })
    },
    DomEvent: { stop() {} }
  };
  w.L = L;
  return { L, map, layers, drawn };
}

let leaflet = null;

function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    beforeParse(w) {
      leaflet = makeLeaflet(w);
      w.JSZip = function () {};
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
      w.HTMLCanvasElement.prototype.getContext = () => ({
        drawImage() {}, fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
        moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
        setTransform() {}, measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
        createLinearGradient: () => ({ addColorStop() {} }), putImageData() {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }), set fillStyle(v) {}, set font(v) {}
      });
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AA';
      w.indexedDB = new FDBFactory();
      w.IDBKeyRange = FDBKeyRange;
      w.onerror = msg => { errors.push(String(msg)); return true; };
    }
  });
  const w = dom.window;
  w.addEventListener('error', e => errors.push(e.message || String(e.error)));
  for (const f of jsOrder) {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    try { w.document.head.appendChild(el); }
    catch (e) { errors.push(`js/${f}: ${e.message}`); }
  }
  return { w, errors };
}

// A project with enough shape for every chart and check to have something to
// say: two feature types, points and a polygon, photos on some vertices, a
// deliberate GPS spike, a deliberate near-duplicate and a bow-tie ring.
function seed(w) {
  const day = n => new Date(Date.now() - n * 3600e3).toISOString();
  const v = (lat, lon, acc, photos) => ({
    lat, lon, alt: 100, acc, time: day(2),
    attrs: {}, photos: (photos || []).map((id, i) => ({
      id, name: id + '.jpg', takenAt: day(2), heading: 90, angleLabel: '',
      uploadStatus: 'local', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(500),
      thumbUrl: 'data:image/jpeg;base64,' + 'B'.repeat(80)
    }))
  });
  w.eval(`
    projects = [{ id:'p1', name:'Corridor Survey',
      client:'Zesa Holdings', site:'Msasa feeder, Harare', manager:'T. Moyo',
      description:'11kV overhead reconductoring survey, section 4.',
      siteLat:-17.8202, siteLon:31.0502,
      createdAt:'${day(48)}', updatedAt:'${day(1)}' }];
    activeProjectId = 'p1';
    featureTypes = [
      { id:'ft1', name:'Pole', geometryType:'point', fields:[
        {id:'material', label:'Material', type:'text'},
        {id:'height', label:'Height', type:'number'} ] },
      { id:'ft2', name:'Parcel', geometryType:'polygon', fields:[
        {id:'owner', label:'Owner', type:'text'} ] }
    ];
  `);
  const mk = (id, name, ftId, geo, verts, attrs) => ({
    id, name, ref: name.replace(/\D/g, ''), featureTypeId: ftId, geometryType: geo,
    vertices: verts, attrs: attrs || {}, savedAt: day(6), notes: ''
  });
  const feats = [];
  // eight poles on a line, with a spike on the seventh
  for (let i = 0; i < 8; i++) {
    const lat = -17.82 + i * 0.0004;
    const spike = i === 6 ? 0.004 : 0;                       // ~440 m sideways jump
    feats.push(mk('f' + i, 'Pole-' + String(i + 1).padStart(3, '0'), 'ft1', 'point',
      [v(lat + spike, 31.05 + i * 0.0004, i === 3 ? 22 : 2.5, i % 2 ? ['ph' + i] : [])],
      { material: i === 5 ? 'Steel' : 'Wood', height: i === 4 ? 940 : 9 + i * 0.1 }));
  }
  // an eight-vertex cable run with one bad fix in the middle of it
  const cable = [];
  for (let i = 0; i < 8; i++) {
    const jump = i === 5 ? 0.004 : 0;                        // ~440 m sideways
    cable.push(v(-17.830 + i * 0.0003 + jump, 31.060 + i * 0.0003, 3));
  }
  feats.push(mk('fline', 'Cable-01', 'ft1', 'line', cable, { material: 'Copper', height: 8 }));
  // a near-duplicate of the first pole
  feats.push(mk('fdup', 'Pole-001b', 'ft1', 'point', [v(-17.82000, 31.05000, 3, [])], { material: 'Wood', height: 9 }));
  // one pole with a blank field the neighbours can speak for
  feats.push(mk('fgap', 'Pole-009', 'ft1', 'point', [v(-17.8195, 31.0505, 3, [])], { material: '', height: 9.4 }));
  // a self-intersecting parcel (bow tie)
  feats.push(mk('fpoly', 'Parcel-01', 'ft2', 'polygon', [
    v(-17.821, 31.051, 2), v(-17.820, 31.052, 2), v(-17.821, 31.052, 2), v(-17.820, 31.051, 2)
  ], { owner: 'State' }));
  w.eval('savedFeatures = ' + JSON.stringify(feats) + ';');
  w.eval("currentVertices = []; projectData = { p1: { savedFeatures, currentVertices, featureTypes } };");
}

const { w, errors: bootErrors } = boot();
seed(w);

// The media store is asynchronous by nature, and the strip interlock will not
// drop a photo's base64 until the bytes are confirmed in it. So the suite does
// what the app does at boot: move the seeded photos across, and wait.
async function settleMediaStore() {
  await w.eval('photoStoreMigrate(collectPhotoRecords(savedFeatures, currentVertices))');
  await w.eval('photoStoreIdle()');
}

async function main() {

// ── the storage ceiling ──────────────────────────────────────────────────────
await settleMediaStore();

check('photo bytes never reach localStorage', () => {
  w.eval('persistStore();');
  const raw = w.localStorage.getItem(w.eval('STORAGE_KEY'));
  assert(raw, 'nothing was written at all');
  assert(!/"dataUrl"/.test(raw), 'dataUrl was serialised into the project store — this is the 5 MB ceiling');
  assert(!/"thumbUrl"/.test(raw), 'thumbUrl was serialised into the project store');
  assert(/"id":"ph1"/.test(raw), 'the photo RECORD was dropped too — only its bytes should be');
});

check('bytes are never dropped before the media store confirms it has them', () => {
  // The upgrade-launch data-loss bug: persistStore() runs at boot long before
  // the migration, so an unconditional strip removed every photo from disk while
  // its bytes were still only in memory. A kill in that window — routine on
  // Android — lost the lot.
  w.eval(`window.__probe = { id:'ph_never_written', takenAt:'2026-01-01T00:00:00Z',
           dataUrl:'data:image/jpeg;base64,ZZZZ', thumbUrl:'data:image/jpeg;base64,YY' };`);
  const kept = w.eval('JSON.stringify({ p: window.__probe }, photoStripFields)');
  assert(/ZZZZ/.test(kept),
    'a photo whose bytes are NOT in the media store had them stripped anyway — that is the upgrade-launch data loss');
  assert(w.eval("photoBytesOnDisk('ph1') === true"), 'a migrated photo was not marked as safe to strip');
  assert(w.eval("photoBytesOnDisk('ph_never_written') === false"), 'an unwritten photo was marked safe to strip');
});

await checkAsync('a project of 100 photo-bearing features fits inside the localStorage budget', async () => {
  // The reported failure was photos vanishing on the third feature. The record
  // for a photo is a couple of hundred bytes, so the honest way to prove the
  // ceiling has moved is to build the load that used to break it.
  const big = [];
  for (let f = 0; f < 100; f++) {
    const verts = [];
    for (let n = 0; n < 7; n++) {
      verts.push({
        lat: -17.8 + f * 1e-4, lon: 31.0 + n * 1e-4, alt: 100, acc: 3,
        time: new Date().toISOString(), attrs: { note: 'v' + n },
        photos: [0, 1, 2].map(k => ({
          id: `ph_${f}_${n}_${k}`, name: 'p.jpg', takenAt: new Date().toISOString(),
          heading: 90, angleLabel: 'N', uploadStatus: 'local',
          // Stands in for a real 1200px JPEG. Deliberately not the full ~250 KB:
          // 2100 of those is more base64 than V8 will hold in one string, which
          // is its own comment on why this data was never fit for localStorage.
          // The assertion is that NONE of it is written, so the size only has to
          // be large enough that a leak would be obvious.
          dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(4000),
          thumbUrl: 'data:image/jpeg;base64,' + 'B'.repeat(800)
        }))
      });
    }
    big.push({ id: 'bf' + f, name: 'F' + f, featureTypeId: 'ft1', geometryType: 'line', vertices: verts, attrs: {}, savedAt: new Date().toISOString() });
  }
  w.savedFeaturesBackup = w.eval('savedFeatures');
  w.__big = big;
  w.eval('projectData.p1.savedFeatures = window.__big; savedFeatures = window.__big; lastWritten = null;');
  // Same order the app uses: bytes to the media store first, then the write.
  await settleMediaStore();
  w.eval('persistStore();');
  const raw = w.localStorage.getItem(w.eval('STORAGE_KEY'));
  const bytes = raw.length;
  const photos = 100 * 7 * 3;
  assert(!/"dataUrl"/.test(raw), 'binary leaked into the store on the large project');
  assert(bytes < 5 * 1024 * 1024,
    `${photos} photos across 100 features wrote ${(bytes / 1048576).toFixed(1)} MB — still over the ~5 MB localStorage budget`);
  // Restore the smaller fixture for the rest of the suite. Marked destructive
  // because it genuinely does reduce the feature count, and the write guard is
  // supposed to refuse a shrink that nobody asked for — going around it with a
  // reset flag would be testing the app with one of its safeties disabled.
  w.__small = w.savedFeaturesBackup;
  w.eval('savedFeatures = window.__small; projectData.p1.savedFeatures = savedFeatures; persistStore({destructive:true});');
});

check('a thumbnail still resolves when its base64 has been shed', () => {
  const src = w.eval("photoThumbSrc({ id:'ph1', name:'x' })");
  assert(typeof src === 'string' && src.length, 'photoThumbSrc returned nothing for a shed photo');
  assert(!/undefined/.test(src), 'photoThumbSrc produced an "undefined" src');
});

// ── PlotAtlas ────────────────────────────────────────────────────────────────
check('PlotAtlas opens and draws the project', () => {
  w.eval('openPlotAtlas();');
  const el = w.document.getElementById('plotAtlas');
  assert(el && el.classList.contains('show'), 'the overlay did not open');
  w.eval('ensureAtlasMap(); renderPlotAtlas();');
  const count = w.document.getElementById('atlasCount').textContent;
  assert(/\d+ feature/.test(count), `nothing was drawn — the counter reads "${count}"`);
  const empty = w.document.getElementById('atlasEmpty');
  assert(empty.style.display === 'none', 'the empty-state message is showing over a map that has features');
});

check('the map element is given a real box, not a percentage of an auto-height parent', () => {
  // The exact bug: height:100% against an auto-height ancestor resolves to zero,
  // which is why the old expand button produced a blank screen you could scroll
  // past. #atlasMap must be positioned against the fixed overlay itself.
  const rule = css.slice(css.indexOf('#atlasMap {'), css.indexOf('}', css.indexOf('#atlasMap {')));
  assert(/position:\s*absolute/.test(rule), '#atlasMap is not positioned, so its height depends on its parent flowing');
  assert(/inset:\s*0/.test(rule), '#atlasMap does not pin to its container');
  const overlay = css.slice(css.indexOf('.plot-atlas {'), css.indexOf('}', css.indexOf('.plot-atlas {')));
  assert(/position:\s*fixed/.test(overlay) && /inset:\s*0/.test(overlay),
    '.plot-atlas is not a fixed full-viewport box, so #atlasMap has nothing to fill');
  const parent = html.slice(html.indexOf('<div class="plot-atlas"'), html.indexOf('<div class="atlas-top"'));
  assert(/<div id="atlasMap"><\/div>/.test(parent),
    '#atlasMap is no longer a direct child of .plot-atlas — the height chain is broken again');
});

check('no control is placed on top of the zoom control', () => {
  // The reported stacking. Leaflet's zoom is bottom-right on PlotAtlas, so
  // nothing else may claim that corner; on the Review map the zoom is top-left,
  // where the expand button lives, so that stack has to be pushed clear.
  assert(/\.plot-atlas .leaflet-control-zoom|position:'bottomright'|position: *'bottomright'/.test(css + fs.readFileSync(path.join(ROOT, 'js/14a-plotatlas.js'), 'utf8')),
    'the zoom control has no explicit position, so it falls back to top-left under the close button');
  const railRule = css.slice(css.indexOf('.atlas-rail {'), css.indexOf('}', css.indexOf('.atlas-rail {')));
  assert(/right:\s*12px/.test(railRule) && /top:\s*50%/.test(railRule),
    'the tool rail is not on the right edge at mid-height, where it clears both the search and the zoom');
  assert(/\.review-map-wrap \.leaflet-top\.leaflet-left\s*\{\s*margin-top:\s*46px/.test(css),
    'the Review map still lets Leaflet draw its zoom control under the expand button');
});

check('the tool rail collapses and expands', () => {
  const rail = w.document.getElementById('atlasRail');
  const before = rail.classList.contains('open');
  w.eval('atlasToggleTools();');
  assert(rail.classList.contains('open') !== before, 'toggling did nothing');
  w.eval('atlasToggleTools();');
  assert(rail.classList.contains('open') === before, 'toggling back did nothing');
  assert(w.document.querySelectorAll('#atlasRailTools .atlas-tool').length >= 6,
    'the rail carries fewer than six tools — it is meant to be where every map tool lives');
});

check('every rail tool runs without throwing', () => {
  ['atlasToggleLabels', 'atlasToggleCluster', 'atlasToggleDensity', 'atlasToggleLegend', 'atlasFitData']
    .forEach(fn => {
      try { w.eval(fn + '();'); } catch (e) { throw new Error(`${fn}() threw: ${e.message}`); }
    });
  // and back off again, so the suite leaves the state it found
  ['atlasToggleLabels', 'atlasToggleDensity', 'atlasToggleLegend'].forEach(fn => w.eval(fn + '();'));
});

check('measuring reports a distance and an area', () => {
  w.eval('atlasToggleMeasure();');
  w.eval("atlasAddMeasurePoint({lat:-17.82, lng:31.05}); atlasAddMeasurePoint({lat:-17.821, lng:31.051}); atlasAddMeasurePoint({lat:-17.822, lng:31.050});");
  const text = w.document.getElementById('atlasMeasureText').textContent;
  assert(/\d/.test(text) && /points/.test(text), `the readout says "${text}"`);
  w.eval('atlasClearMeasure(); atlasToggleMeasure();');
});

check('tapping a feature opens the sheet, and it closes again', () => {
  w.eval("atlasOpenSheet('f1');");
  const sheet = w.document.getElementById('atlasSheet');
  assert(sheet.classList.contains('show'), 'the feature sheet did not open');
  assert(/Pole-002/.test(sheet.textContent), 'the sheet is not showing the feature that was tapped');
  w.eval('atlasCloseSheet();');
  assert(!sheet.classList.contains('show'), 'the sheet did not close');
});

check('search filters what is drawn', () => {
  w.eval("atlasOnSearch('Parcel');");
  assert(/^1 feature/.test(w.document.getElementById('atlasCount').textContent),
    'searching did not narrow the map');
  w.eval("atlasOnSearch('');");
});

check('Back closes the sheet first, then PlotAtlas — never the screen underneath', () => {
  w.eval("openPlotAtlas(); atlasOpenSheet('f1');");
  assert(w.eval('closeTopOverlay()') === true, 'Back was not consumed by the open sheet');
  assert(!w.document.getElementById('atlasSheet').classList.contains('show'), 'the sheet stayed open');
  assert(w.document.getElementById('plotAtlas').classList.contains('show'), 'the whole map closed when only the sheet should have');
  assert(w.eval('closeTopOverlay()') === true, 'Back was not consumed by PlotAtlas itself');
  assert(!w.document.getElementById('plotAtlas').classList.contains('show'), 'PlotAtlas stayed open');
});

// ── Analytics ────────────────────────────────────────────────────────────────
check('Analytics renders every chart against real data', () => {
  w.eval('renderAnalytics();');
  const body = w.document.getElementById('analyticsBody');
  const text = body.textContent;
  ['At a glance', 'Feature mix', 'Capture over time', 'GPS accuracy spread', 'Data quality', 'When the work happens', 'Geometry profile', 'Photo coverage']
    .forEach(t => assert(text.includes(t), `the "${t}" card did not render`));
  assert(body.querySelectorAll('svg').length >= 4, 'fewer than four charts drew — something returned empty');
  assert(!/NaN|undefined|Infinity/.test(text), 'a chart produced NaN/undefined/Infinity from real data');
});

check('charts are controls: a slice and a bar both carry a filter action', () => {
  const body = w.document.getElementById('analyticsBody');
  assert(body.querySelector('[onclick*="analyticsFilterByType"]'), 'the donut is not tappable');
  assert(body.querySelector('[onclick*="analyticsFilterByDay"]'), 'the time series is not tappable');
});

check('the day filter composes with the other Review filters instead of replacing them', () => {
  const key = new Date(w.eval('savedFeatures[0].savedAt')).toISOString().slice(0, 10);
  w.eval(`analyticsDayFilterKey = '${key}';`);
  const n = w.eval('getFilteredFeatures().length');
  w.eval("analyticsDayFilterKey = '1999-01-01';");
  const none = w.eval('getFilteredFeatures().length');
  w.eval("analyticsDayFilterKey = '';");
  assert(n > 0, 'filtering to the day the features were captured returned nothing');
  assert(none === 0, 'filtering to a day with no captures still returned features');
  assert(w.eval('getFilteredFeatures().length') > n - 1, 'clearing the day filter did not restore the full set');
});

// ── PlotMind ─────────────────────────────────────────────────────────────────
check('PlotMind runs entirely on device — no endpoint, no network', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/16a-plotmind.js'), 'utf8');
  assert(!/fetch\s*\(|XMLHttpRequest|https?:\/\//.test(src),
    'PlotMind reaches the network — it is meant to cost nothing and work with no signal');
});

check('PlotMind finds the GPS spike, the duplicate and the invalid ring', () => {
  const findings = w.eval('JSON.stringify(pmRunAllChecks().map(f=>f.title))');
  const titles = JSON.parse(findings).join(' | ');
  assert(/spike/i.test(titles), `no GPS spike found in a dataset with a 400 m jump — got: ${titles}`);
  assert(/on top of each other/i.test(titles), `the near-duplicate pole was not flagged — got: ${titles}`);
  assert(/crosses itself/i.test(titles), `the bow-tie polygon was not flagged — got: ${titles}`);
});

check('PlotMind flags an attribute outlier without being fooled by it', () => {
  // 940 among a run of ~9s. Median-absolute-deviation, not standard deviation:
  // the outlier itself would wreck an SD-based threshold.
  const titles = JSON.parse(w.eval('JSON.stringify(pmRunAllChecks().map(f=>f.title))')).join(' | ');
  assert(/Unusual Height/i.test(titles), `the 940 m pole height was not flagged — got: ${titles}`);
});

check('PlotMind suggests a value for a blank field from its neighbours', () => {
  const gaps = JSON.parse(w.eval('JSON.stringify(pmFindFillableGaps())'));
  const mat = gaps.find(g => g.fieldId === 'material' && g.featureId === 'fgap');
  assert(mat, 'the blank Material field was not picked up');
  assert(mat.suggestion === 'Wood', `expected the majority neighbour value "Wood", got "${mat.suggestion}"`);
  assert(mat.confidence > 0.5, 'a suggestion was made on neighbours that mostly disagree');
});

check('PlotMind reads the naming pattern', () => {
  const next = w.eval('pmSuggestNextName()');
  assert(next === 'Pole-010', `expected Pole-010 from a Pole-00N series, got ${next}`);
});

check('PlotMind renders, and its zones cluster', () => {
  w.eval('renderPlotMind();');
  const text = w.document.getElementById('plotMindBody').textContent;
  ['Findings', 'Suggestions', 'Work zones', 'Ask about this project'].forEach(t =>
    assert(text.includes(t), `the "${t}" card did not render`));
  assert(!/NaN|undefined/.test(text), 'PlotMind produced NaN/undefined from real data');
});

check('plain-English questions resolve to real filters', () => {
  const ask = q => JSON.parse(w.eval(`JSON.stringify((function(){
    const p = pmParseQuestion(${JSON.stringify(q)});
    return { n: savedFeatures.filter(f=>p.tests.every(t=>t(f))).length, read: p.description };
  })())`));
  const noPhotos = ask('features with no photos');
  assert(noPhotos.read.includes('with no photos'), 'the question was not understood');
  assert(noPhotos.n > 0 && noPhotos.n < w.eval('savedFeatures.length'), 'the no-photos filter matched everything or nothing');
  const polys = ask('polygons');
  assert(polys.n === 1, `expected 1 polygon, got ${polys.n}`);
  const weak = ask('accuracy worse than 10m');
  assert(weak.n === 1, `expected the single 22 m fix, got ${weak.n}`);
  const nonsense = ask('what is the airspeed of a swallow');
  assert(nonsense.read.length === 0, 'a question about nothing in the schema was answered anyway');
});

// ── PlotLens minimap ─────────────────────────────────────────────────────────
check('the story player carries a route minimap in the top-right corner', () => {
  const wrap = html.slice(html.indexOf('id="plPlayer"'), html.indexOf('</div>', html.indexOf('pl-tap-next')));
  assert(/id="plMiniMapWrap"/.test(wrap) && /id="plMiniMap"/.test(wrap),
    'the minimap is not inside the player');
  const rule = css.slice(css.indexOf('.pl-minimap-wrap {'), css.indexOf('}', css.indexOf('.pl-minimap-wrap {')));
  assert(/right:\s*12px/.test(rule), 'the minimap is not pinned to the right edge');
  assert(/top:/.test(rule), 'the minimap is not pinned to the top');
  // It has to clear the progress bar (top 10px) and the close button (top 24px,
  // 34px tall) or it lands on top of them.
  const top = parseInt((rule.match(/top:\s*calc\((\d+)px/) || [])[1], 10);
  assert(top >= 58, `the minimap sits at ${top}px, under the close button at 24-58px`);
});

check('the minimap draws a dotted full route with the travelled part solid over it', () => {
  w.eval("plStory = buildPlotLensBeats(); playPlotLens(); plIndex = 2; plUpdateMiniMap();");
  // Scoped to the minimap's own layer group. The shared draw log also holds the
  // line features PlotAtlas drew earlier in the suite — one of which is an
  // eight-vertex cable run that would otherwise be mistaken for the trail — and
  // slicing by index does not work because clearLayers() removes entries from
  // the middle of that log.
  const group = w.eval('plMiniLayer');
  const lines = leaflet.drawn.filter(o => o._kind === 'polyline' && o._group === group);
  assert(lines.length >= 2, `expected a dotted route plus a solid travelled trail, drew ${lines.length} line(s)`);
  const dotted = lines.find(o => o._opts.dashArray);
  const solid = lines.find(o => !o._opts.dashArray);
  assert(dotted, 'the full route is not drawn as a dotted trail');
  assert(solid, 'the part of the story already told is not drawn solid over it');
  assert(solid._arg.length === 3, `the solid trail should cover frames 1-3 at index 2, covered ${solid._arg.length}`);
  assert(dotted._arg.length > solid._arg.length, 'the dotted route is not the whole story');
});

check('the minimap marks the frame currently on screen, and moves with it', () => {
  const here = () => leaflet.drawn.filter(o => o._kind === 'marker' && o._opts.icon && /pl-mini-here/.test(o._opts.icon.className || ''));
  w.eval('plIndex = 1; plUpdateMiniMap();');
  const a = here();
  assert(a.length === 1, `expected exactly one current-frame pin, found ${a.length}`);
  const first = JSON.stringify(a[a.length - 1]._arg);
  w.eval('plIndex = 3; plUpdateMiniMap();');
  const b = here();
  const second = JSON.stringify(b[b.length - 1]._arg);
  assert(first !== second, 'the pin did not move when the story advanced');
});

check('closing the story tears the minimap down', () => {
  w.eval('stopPlotLens();');
  assert(w.eval('plMiniMap === null'), 'the minimap Leaflet instance outlived the player');
});

// ── one basemap preference, every map ────────────────────────────────────────
check('Settings offers every basemap, not just two', () => {
  const grid = html.slice(html.indexOf('id="settingsBasemapGrid"'), html.indexOf('</div>', html.indexOf('id="settingsBasemapGrid"')));
  const opts = (grid.match(/data-bm="/g) || []).length;
  assert(opts >= 10, `the Settings picker offers ${opts / 2} basemap(s) — the registry has five`);
});

check('the Settings choice drives Review, PlotAtlas and the PlotLens minimap', () => {
  const tileUrls = () => leaflet.drawn.filter(o => o._kind === 'tile').map(o => o._arg);
  const before = tileUrls().length;
  w.eval("ensureReviewMap(); ensureAtlasMap(); setBasemapPref('dark');");
  const added = tileUrls().slice(before);
  assert(added.some(u => /dark_all/.test(u)), `no dark tiles were requested after the preference changed — got ${added.join(' ')}`);
  assert(w.eval("localStorage.getItem('plotedge_basemap')") === 'dark', 'the preference was not stored');
  assert(w.eval('currentBasemap') === 'dark', 'the Review map did not adopt the preference');
  assert(w.eval('atlasBasemap') === 'dark', 'PlotAtlas did not adopt the preference');
  w.eval("setBasemapPref('street');");
});

check('PlotAtlas and the Review map no longer keep separate basemap keys', () => {
  const atlas = fs.readFileSync(path.join(ROOT, 'js/14a-plotatlas.js'), 'utf8');
  assert(!/plotedge_atlas_basemap/.test(atlas),
    'PlotAtlas still stores its basemap under its own key, so Settings cannot govern it');
  assert(/ATLAS_BASEMAP_KEY = 'plotedge_basemap'/.test(atlas), 'PlotAtlas is not reading the shared key');
});

// ── quick actions ────────────────────────────────────────────────────────────
check('PlotAtlas and PlotMind are both reachable as quick actions', () => {
  const ids = JSON.parse(w.eval('JSON.stringify(QA_REGISTRY.map(a=>a.id))'));
  ['plotatlas', 'plotmind', 'analytics'].forEach(id =>
    assert(ids.includes(id), `${id} is not in the quick-action registry`));
  const def = JSON.parse(w.eval('JSON.stringify(QA_DEFAULT)'));
  assert(def.includes('plotatlas') && def.includes('plotmind'),
    `a fresh install would not see them on the dashboard — defaults are ${def.join(', ')}`);
  assert(def.length <= w.eval('QA_MAX'), 'the default grid is over its own maximum');
});

check('a device that had already customised its grid still gets the new actions', () => {
  w.eval("localStorage.removeItem('plotedge_qa_seeded'); localStorage.setItem('plotedge_quickactions', JSON.stringify(['import','export'])); qaSeedNewActions();");
  const after = JSON.parse(w.eval("localStorage.getItem('plotedge_quickactions')"));
  assert(after.includes('plotatlas') && after.includes('plotmind'), `seeding missed them: ${after.join(', ')}`);
  assert(after.includes('import') && after.includes('export'), 'seeding threw away the choices the user had made');
  // and never twice
  w.eval('qaSeedNewActions();');
  const again = JSON.parse(w.eval("localStorage.getItem('plotedge_quickactions')"));
  assert(again.length === after.length, 'seeding ran a second time and duplicated the tiles');
});

check('a full grid is left alone rather than displaced', () => {
  // "Full" is derived from QA_MAX, not hardcoded: this test used to assert a length of 6, so
  // raising QA_MAX to 8 for the compact grid failed it even though the behaviour was correct —
  // a 6-tile grid genuinely has room now. Deriving it keeps the test about the RULE (a full grid
  // is never displaced) instead of about one particular grid size.
  const max = w.eval('QA_MAX');
  const full = w.eval('qaAvailable().map(a=>a.id).filter(id=>!QA_SEED_ACTIONS.includes(id))').slice(0, max);
  w.eval("localStorage.removeItem('plotedge_qa_seeded'); localStorage.setItem('plotedge_quickactions', JSON.stringify(" + JSON.stringify(full) + ")); qaSeedNewActions();");
  const after = JSON.parse(w.eval("localStorage.getItem('plotedge_quickactions')"));
  assert(after.length === max, `a full grid changed length: ${after.length} vs ${max}`);
  QA_SEED_ACTIONS_CHECK(w, after);
});

function QA_SEED_ACTIONS_CHECK(w, after){
  const seeds = w.eval('QA_SEED_ACTIONS');
  seeds.forEach(id => assert(!after.includes(id),
    `a grid that was already full had one of the user's own choices pushed out by "${id}"`));
}

check('every registered action declares a drawer group', () => {
  const ungrouped = w.eval("QA_REGISTRY.filter(a=>!a.group).map(a=>a.id)");
  assert(ungrouped.length === 0, `these actions would fall into Utilities by default: ${ungrouped.join(', ')}`);
  const order = w.eval('QA_GROUP_ORDER');
  const stray = w.eval("QA_REGISTRY.map(a=>a.group)").filter(g => !order.includes(g));
  assert(stray.length === 0, `group(s) not in QA_GROUP_ORDER, so they would render last: ${stray.join(', ')}`);
});

check('PlotVault is reachable and offered to existing installs', () => {
  const ids = w.eval('QA_REGISTRY.map(a=>a.id)');
  assert(ids.includes('plotvault'), 'plotvault is not in the quick-action registry');
  const seeds = w.eval('QA_SEED_ACTIONS');
  assert(seeds.includes('plotvault'),
    'plotvault is not seeded, so anyone who ever customised their grid would never be offered it');
});

// ── the two PDF deliverables ─────────────────────────────────────────────────
// Rendered for real against a jsPDF stand-in that records every draw call, so
// these assert what lands on the paper rather than that the code parses.
function pdfHarness(w) {
  const calls = [];
  const rec = (op, args) => calls.push({ op, args });
  const doc = {
    internal: {
      pageSize: { getWidth: () => 842, getHeight: () => 595 },
      getNumberOfPages: () => doc._pages,
      getPageHeight: () => 595
    },
    _pages: 1,
    lastAutoTable: { finalY: 300 },
    setFontSize: v => rec('setFontSize', [v]), setFont: (...a) => rec('setFont', a),
    setTextColor: (...a) => rec('setTextColor', a), setDrawColor: (...a) => rec('setDrawColor', a),
    setFillColor: (...a) => rec('setFillColor', a), setLineWidth: v => rec('setLineWidth', [v]),
    setLineDashPattern: (...a) => rec('dash', a),
    text: (t, x, y, o) => rec('text', [Array.isArray(t) ? t.join(' ') : t, x, y, o]),
    line: (...a) => rec('line', a), rect: (...a) => rec('rect', a),
    circle: (...a) => rec('circle', a), triangle: (...a) => rec('triangle', a),
    lines: (...a) => rec('lines', a), addImage: (...a) => rec('addImage', a),
    addPage: () => { doc._pages++; rec('addPage', []); }, setPage: n => rec('setPage', [n]),
    splitTextToSize: (t, w2) => {
      // Real wrapping, near enough: the layout code sizes its panels from this,
      // so a stub that always returns one line would hide every overflow.
      const words = String(t).split(/\s+/); const out = []; let cur = '';
      const max = Math.max(4, Math.floor(w2 / 3.6));
      words.forEach(word => {
        if ((cur + ' ' + word).trim().length > max) { if (cur) out.push(cur); cur = word; }
        else cur = (cur + ' ' + word).trim();
      });
      if (cur) out.push(cur);
      return out.length ? out : [''];
    },
    autoTable: opts => { rec('autoTable', [opts]); if (opts.didDrawPage) opts.didDrawPage(); },
    output: () => ({ size: 4096, type: 'application/pdf' }),
    GState: function (o) { return o; }, setGState: () => {}
  };
  w.jspdf = { jsPDF: function () { return doc; } };
  w.eval('ensureJsPdf = () => Promise.resolve(true);');
  w.eval("saveExportFile = (blob,name) => { window.__lastExport = name; return Promise.resolve({ok:true, where:'/x/'+name, uri:'file:///x/'+name, native:true}); };");
  w.eval('noteExportSaved = () => true; markProjectExported = () => {};');
  w.eval("document.getElementById('exportFormatBtn') || (function(){ const b=document.createElement('button'); b.id='exportFormatBtn'; document.body.appendChild(b); const t=document.createElement('span'); t.id='exportFormatBtnText'; document.body.appendChild(t); const s2=document.createElement('div'); s2.id='exportStatus'; document.body.appendChild(s2); })();");
  w.eval('updateExportFormatUI = () => {};');
  w.__pdfErrors = [];
  w.console.error = (...a2) => { w.__pdfErrors.push(a2.map(String).join(' ')); };
  w.eval("maplayoutBasemapMode = () => 'none';");
  return { doc, calls, textOf: () => calls.filter(c => c.op === 'text').map(c => String(c.args[0])).join(' | ') };
}

await checkAsync('the plan sheet carries a real engineering title block', async () => {
  const h = pdfHarness(w);
  await w.eval('exportMapLayout()');
  const t = h.textOf();
  assert(!w.__pdfErrors.length, 'the plan sheet threw: ' + w.__pdfErrors.join(' | '));
  ['PlotEdge', 'FIELD SURVEY PLAN', 'PROJECT', 'SCALE', 'LEGEND', 'ISSUED', 'NOTES', 'COORDINATE REFERENCE']
    .forEach(x => assert(t.includes(x), `the title block has no "${x}" panel — got: ${t.slice(0, 500)}`));
  assert(/Corridor Survey/.test(t), 'the project name is not on the sheet');
  assert(/Zesa Holdings/.test(t), 'the client is missing from the details panel');
  assert(/Msasa feeder/.test(t), 'the site is missing from the details panel');
  assert(/EPSG:4326/.test(t), 'the coordinate reference system is not stated');
  assert(/Features:\s*\d+/.test(t), 'the survey totals are missing');
  assert(/not a cadastral/i.test(t) || /Not a cadastral/.test(t), 'the sheet carries no limitations note');
});

check('the plan states a true drafting scale, not a fitted ratio', () => {
  const t = w.eval('(function(){ return 1; })()');
  const denom = w.eval('planScaleDenominator(planPointsPerMetre(500))');
  assert(denom === 500, `a 1:500 sheet round-tripped to 1:${denom}`);
  // Never rounds the wrong way: a denominator SMALLER than the fitted one would
  // zoom in past the plot rect and push features off the paper.
  const fitted = w.eval('planPointsPerMetre(437)');
  const picked = w.eval('planScaleDenominator(planPointsPerMetre(437))');
  assert(picked >= 437, `fitted 1:437 was rounded to 1:${picked}, which crops the drawing`);
  assert(w.eval('JSON.stringify(PLAN_SCALE_DENOMS)').includes('500'), 'no conventional scale denominators');
  assert(fitted > 0, 'points-per-metre is not positive');
});

await checkAsync('the plan sheet draws a graticule and a segmented scale bar', async () => {
  const h = pdfHarness(w);
  await w.eval('exportMapLayout()');
  const t = h.textOf();
  assert(/\u00B0|°/.test(t), 'no degree-labelled graticule ticks were drawn');
  assert(/1 : /.test(t), 'the scale ratio is not printed');
  assert(/\bm$|\d+ m/.test(t), 'the scale bar has no ground-distance label');
  assert(h.calls.filter(c => c.op === 'rect').length > 8, 'too few rects — the scale bar segments or panels did not draw');
  assert(h.calls.some(c => c.op === 'triangle'), 'no north arrow head');
});

await checkAsync('the register PDF opens as an identified document, not a bare table', async () => {
  const h = pdfHarness(w);
  await w.eval('exportPDF()');
  const t = h.textOf();
  assert(/SURVEY FEATURE REGISTER/.test(t), 'the register has no masthead');
  assert(/Corridor Survey/.test(t), 'the project name is not on the front sheet');
  ['CLIENT', 'SITE', 'COORDINATE SYSTEM', 'FEATURES / VERTICES'].forEach(k =>
    assert(t.includes(k), `the project header is missing "${k}"`));
  assert(/Basis and limitations/.test(t), 'no basis-and-limitations statement');
  assert(/EPSG:4326/.test(t), 'the coordinate system is not stated');
  assert(h.calls.some(c => c.op === 'autoTable'), 'the feature schedule was never drawn');
  const at = h.calls.find(c => c.op === 'autoTable').args[0];
  assert(at.didDrawPage, 'no per-page hook, so a page 2 would carry no header or page number');
  assert(!(at.head[0] || []).includes('photo_data_uris'), 'base64 photo blobs are still a column in the printed table');
});

await checkAsync('both PDFs are named after the project, not "plotedge"', async () => {
  const h = pdfHarness(w);
  await w.eval('exportMapLayout()');
  const planName = w.eval('window.__lastExport');
  await w.eval('exportPDF()');
  const regName = w.eval('window.__lastExport');
  assert(/^Corridor_Survey/.test(planName), `plan filename is "${planName}" — spaces break links and shell commands`);
  assert(/_plan_/.test(planName), 'the plan sheet is not identifiable by filename');
  assert(/Corridor_Survey/.test(regName) && /_register_/.test(regName), `register filename is "${regName}"`);
});

check('nothing threw while any of that ran', () => {
  assert(bootErrors.length === 0, 'errors during boot: ' + bootErrors.join(' | '));
});

}   // end main()

main().then(() => {
  module.exports = results;
  if (require.main === module) {
    let bad = 0;
    for (const r of results) {
      console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
      if (!r.ok) bad++;
    }
    console.log(`\n  features: ${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  }
});
