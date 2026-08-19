'use strict';
// PlotMate wiring, PlotGrid coordinate systems, PlotFix GNSS quality.
//
// The three of these share a property that shapes how they are tested: they are all about data
// whose correctness you cannot see. A feature saved without a merge revision looks identical to
// one saved with it. A coordinate projected onto the wrong datum has the right number of decimal
// places. An RTK-fixed mark and an autonomous one are both a dot on a map. So none of these can
// be caught by using the app — only by asserting the invariant directly, which is what follows.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/',
    beforeParse(w) {
      const anything = new Proxy(function () {}, {
        get: (t, k) => (k === 'then' ? undefined : anything), apply: () => anything, construct: () => anything
      });
      w.L = anything;
      w.JSZip = function () {};
      w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
      w.URL.createObjectURL = () => 'blob:stub';
      w.URL.revokeObjectURL = () => {};
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
    try { w.document.head.appendChild(el); } catch (e) { errors.push(`js/${f}: ${e.message}`); }
  }
  return { w, errors };
}

const { w, errors } = boot();

w.eval(`
  projects = [{ id:'p1', name:'Ward 7', client:'City', site:'Mabvuku', createdAt:new Date().toISOString() }];
  activeProjectId = 'p1';
  projectData = { p1: { savedFeatures:[], currentVertices:[], featureTypes:[] } };
  featureTypes = [{ id:'ft1', name:'Septic', geometryType:'point', geometryTypes:['point'], fields:[] }];
  savedFeatures = [];
`);

// ══ PLOTMATE: IS IT ACTUALLY ON? ═════════════════════════════════════════════
// The whole point. The module was complete and well-tested for months while being called from
// nowhere, so every feature captured in that period is un-mergeable and can never be causally
// ordered against another device's. These checks are about the WIRING, not the algorithm — the
// algorithm has its own suite in plotmate.test.js.

check('a newly saved feature carries a uid and a revision', () => {
  const got = w.eval(`
    (function(){
      var f = plotmateTouch({ id: 1, name:'Septic-01', savedAt:new Date().toISOString() }, 'ft');
      return JSON.stringify({ uid: !!f.uid, rev: !!(f.rev && f.rev.d && typeof f.rev.t === 'number') });
    })()
  `);
  const { uid, rev } = JSON.parse(got);
  assert(uid, 'no uid — this feature can collide with another device’s on merge');
  assert(rev, 'no revision — "newest wins" would fall back to comparing wall clocks');
});

check('the save path stamps, rather than merely being able to', () => {
  // Reads the source, because the assertion is about a call site existing. A behavioural test
  // would need the whole capture form driven, and would still not prove the OTHER two write paths
  // in finalizeSaveFeature were covered.
  const src = fs.readFileSync(path.join(ROOT, 'js/11-features.js'), 'utf8');
  const pushes = (src.match(/savedFeatures\.push\(/g) || []).length;
  const stamped = (src.match(/savedFeatures\.push\(plotmateTouch\(/g) || []).length;
  assert(pushes === stamped, `${pushes - stamped} of ${pushes} feature writes are unstamped — those features are unmergeable`);
  assert(/savedFeatures\[idx\] = plotmateTouch\(/.test(src), 'the in-place edit path does not bump the revision');
});

check('an edit keeps the uid and bumps the revision', () => {
  // Identity must survive an edit. If plotmateTouch minted a fresh uid, an edited feature would
  // arrive on the other device as an unrelated second record and the original would never be
  // superseded — a duplicate in the deliverable rather than a correction.
  const got = w.eval(`
    (function(){
      var f = plotmateTouch({ id:1, name:'a' }, 'ft');
      var uid1 = f.uid, rev1 = f.rev;
      f.name = 'b';
      plotmateTouch(f, 'ft');
      return JSON.stringify({ same: f.uid === uid1, newer: plotmateNewer(f.rev, rev1) });
    })()
  `);
  const { same, newer } = JSON.parse(got);
  assert(same, 'the uid changed on edit — the edit becomes a duplicate record on merge');
  assert(newer, 'the revision did not advance — the edit would lose to its own earlier version');
});

check('deleting records a tombstone and persist does not throw it away', () => {
  // The subtle half. persist() REPLACES projectData[activeProjectId] wholesale from globals, and
  // tombstones have no global — so before they were carried forward explicitly, the very persist()
  // that saved a delete discarded its tombstone. Silent, and it would have resurrected deleted
  // features on the first merge.
  const got = w.eval(`
    (function(){
      var f = plotmateTouch({ id:99, name:'dupe' }, 'ft');
      plotmateRecordDelete('p1', f);
      var before = plotmateTombstones('p1').length;
      persist();
      var after = (projectData['p1'].tombstones || []).length;
      return JSON.stringify({ before: before, after: after });
    })()
  `);
  const { before, after } = JSON.parse(got);
  assert(before === 1, `tombstone not recorded (${before})`);
  assert(after === 1, 'persist() discarded the tombstone — the delete would be undone by the next sync');
});

check('undo withdraws the tombstone', () => {
  const n = w.eval(`
    (function(){
      var f = plotmateTouch({ id:98, name:'restore-me' }, 'ft');
      plotmateRecordDelete('p1', f);
      plotmateWithdrawDelete('p1', f);
      return plotmateTombstones('p1').filter(function(t){ return t.u === f.uid; }).length;
    })()
  `);
  assert(n === 0, 'a restored feature still has a tombstone — it would be deleted again minutes later');
});

check('load-time migration stamps legacy features in their real history order', () => {
  // Not migration-time order. A feature edited last Tuesday must not outrank one edited today just
  // because the migration happened to visit it first.
  const got = w.eval(`
    (function(){
      var old = { id:1, savedAt:'2020-01-01T00:00:00.000Z', vertices:[] };
      var recent = { id:2, savedAt:'2026-01-01T00:00:00.000Z', vertices:[] };
      migrateFeatureToVertices(recent);
      migrateFeatureToVertices(old);
      return JSON.stringify({ ordered: plotmateNewer(recent.rev, old.rev), bothStamped: !!(old.uid && recent.uid) });
    })()
  `);
  const { ordered, bothStamped } = JSON.parse(got);
  assert(bothStamped, 'the load path does not stamp legacy features');
  assert(ordered, 'migration collapsed real edit history into visit order');
});

check('tombstones travel in a plotpack, so a handoff cannot undo a delete', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/17b-plotpack.js'), 'utf8');
  assert(/'tombstones\.json': JSON\.stringify/.test(src), 'the bundle does not carry tombstones');
  assert(/tombstones: Array\.isArray\(p\.tombstones\)/.test(src), 'restore does not read them back');
});

// ══ PLOTGRID: COORDINATE SYSTEMS ════════════════════════════════════════════

check('a project defaults to WGS84 and nothing is projected until asked', () => {
  const r = JSON.parse(w.eval(`JSON.stringify(crsProject(-17.8202, 31.0502))`));
  assert(r.crs === 'wgs84', `default should be wgs84 — got ${r.crs}`);
  assert(r.units === 'degrees', 'default CRS should be in degrees');
  near(r.y, -17.8202, 1e-9, 'latitude passed through');
  near(r.x, 31.0502, 1e-9, 'longitude passed through');
});

check('a south-oriented Gauss belt puts Harare where the survey office would', () => {
  // Lo31 with CM 31°E: Harare at 31.0502E, 17.8202S. Y is measured WEST-positive from the CM, so a
  // point EAST of it has NEGATIVE Y — and X is measured SOUTH-positive from the equator, so a
  // southern-hemisphere point has a large POSITIVE X. Getting either sign wrong is the classic
  // way a Gauss coordinate ends up in the wrong hemisphere, and it produces numbers that look
  // entirely plausible.
  const r = JSON.parse(w.eval(`
    (function(){ setProjectCrs('lo31'); return JSON.stringify(crsProject(-17.8202, 31.0502)); })()
  `));
  assert(r.units === 'm', 'a projected grid should be in metres');
  assert(r.y > 1960000 && r.y < 1980000, `X (south+) should be ~1.97 million m — got ${r.y}`);
  assert(r.x < 0, `Y (west+) should be negative for a point east of the central meridian — got ${r.x}`);
  near(Math.abs(r.x), 5320, 200, 'the point is ~0.05° east of the CM, so ~5.3 km');
  assert(/west/.test(r.xLabel) && /south/.test(r.yLabel), `axes should be labelled by convention — got ${r.xLabel} / ${r.yLabel}`);
});

check('the projection inverts back to where it started', () => {
  // A forward/inverse pair derived independently is a classic source of a round-trip error nobody
  // notices until it is in a deliverable, which is why the inverse iterates the forward rather
  // than carrying its own series.
  const d = JSON.parse(w.eval(`
    (function(){
      setProjectCrs('lo31');
      var f = crsProject(-17.8202, 31.0502);
      var back = crsUnproject(f.x, f.y);
      return JSON.stringify({ dLat: Math.abs(back.lat + 17.8202), dLon: Math.abs(back.lon - 31.0502) });
    })()
  `));
  assert(d.dLat < 1e-7, `latitude round-trip off by ${d.dLat}° (~${(d.dLat * 111132).toFixed(3)} m)`);
  assert(d.dLon < 1e-7, `longitude round-trip off by ${d.dLon}°`);
});

check('a point on the central meridian has zero offset', () => {
  // The one case with an analytically known answer, so it is the sharpest available check on the
  // series: on the CM, easting must be exactly the false easting.
  const y = Number(w.eval(`(function(){ setProjectCrs('lo31'); return crsProject(-17.8202, 31).x; })()`));
  near(y, 0, 0.001, 'a point on the central meridian must have zero Y offset');
});

check('a legacy datum is flagged rather than silently projected wrong', () => {
  // OSGB36's grid parameters are exact but its datum differs from WGS84 by up to ~120 m. Projecting
  // anyway and saying nothing is the failure this guards: the coordinates look right and are not.
  assert(w.eval(`crsNeedsDatumShift('osgb')`) === true, 'OSGB36 should be flagged as needing a datum shift');
  assert(w.eval(`crsNeedsDatumShift('lo31')`) === false, 'Hartebeesthoek-based Lo31 is WGS84 and should not be flagged');
  const stmt = w.eval(`(function(){ setProjectCrs('osgb'); return crsStatement(); })()`);
  assert(/DATUM NOT APPLIED/.test(stmt), `the export statement must say so — got "${stmt}"`);
});

check('every export carries a CRS statement, including the datum caveat', () => {
  const stmt = w.eval(`(function(){ setProjectCrs('lo31'); return crsStatement(); })()`);
  assert(/Lo31/.test(stmt), `should name the grid — got "${stmt}"`);
  assert(/EPSG:2048/.test(stmt), `should carry the EPSG code — got "${stmt}"`);
  assert(/ellipsoidal|orthometric/.test(stmt), `should state the height reference — got "${stmt}"`);
});

check('heights are labelled ellipsoidal until a geoid offset is set', () => {
  // GNSS altitude is height above the spheroid, 10-60 m from sea level. Presenting it as
  // "elevation" is the quiet error that ruins a drainage design.
  const before = w.eval(`(function(){ setProjectGeoidOffset(0); return crsProject(-17.82, 31.05, 1480).heightRef; })()`);
  assert(/ellipsoidal/.test(before), `should say ellipsoidal — got "${before}"`);
  const after = JSON.parse(w.eval(`
    (function(){ setProjectGeoidOffset(-14.2); return JSON.stringify(crsProject(-17.82, 31.05, 1480)); })()
  `));
  near(after.height, 1465.8, 0.01, 'the offset should be applied to the height');
  assert(/orthometric/.test(after.heightRef), `should say orthometric — got "${after.heightRef}"`);
});

check('an unconfigured custom CRS falls back to lat/lon instead of inventing parameters', () => {
  const r = JSON.parse(w.eval(`(function(){ setProjectCrs('custom'); return JSON.stringify(crsProject(-17.82, 31.05)); })()`));
  near(r.x, 31.05, 1e-9, 'should fall back to longitude, not a fabricated easting');
  assert(r.exact === false, 'an unconfigured CRS must not report itself as exact');
});

// ══ PLOTFIX: GNSS QUALITY ═══════════════════════════════════════════════════

// Checksums are COMPUTED, not hand-written. Typing them by hand is how the first draft of this
// suite silently tested nothing: every sentence failed verification, so the parser was never
// reached and six checks failed for a reason that had nothing to do with the parser.
function withChecksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return '$' + body + '*' + sum.toString(16).toUpperCase().padStart(2, '0');
}

// A receiver in RTK fixed: quality 4, 12 satellites, HDOP 0.8, 1480.4 m MSL, geoid separation
// -14.2 m, correction 1.2 s old from base 0123.
const GGA_RTK = withChecksum('GPGGA,123519.00,1749.2120,S,03103.0120,E,4,12,0.8,1480.4,M,-14.2,M,1.2,0123');
// GST fields 6/7/8 are the latitude, longitude and altitude standard deviations — the only
// MEASURED error figures NMEA carries.
const GST_LINE = withChecksum('GPGST,123519.00,0.012,0.008,0.006,0.0,0.008,0.006,0.014');

check('a sentence with a bad checksum is refused', () => {
  // Previously the checksum was split off and thrown away, so a latitude corrupted over a flaky
  // Bluetooth link parsed into a plausible wrong position and could be captured as a real mark.
  const good = withChecksum('GPGGA,123519.00,1749.2120,S,03103.0120,E,4,12,0.8,1480.4,M,-14.2,M,1.2,0123');
  assert(w.eval(`plotfixChecksumOk(${JSON.stringify(good)})`) === true, 'a valid checksum was rejected');
  const bad = good.slice(0, -2) + 'FF';
  assert(w.eval(`plotfixChecksumOk(${JSON.stringify(bad)})`) === false, 'a corrupted sentence was accepted');
  // No checksum at all is also refused — an unverifiable position is not a position.
  assert(w.eval(`plotfixChecksumOk('$GPGGA,123519.00,1749.2120,S')`) === false, 'a sentence with no checksum was accepted');
  assert(w.eval(`plotfixIngest(${JSON.stringify(bad)})`) === null, 'ingest accepted a corrupt sentence');
});

check('NMEA ddmm.mmmm is read as degrees and decimal MINUTES', () => {
  // The classic NMEA bug: 1749.2120 is 17°49.212', which is 17.8202°. Read as decimal degrees it
  // becomes 1749.212° — but intermediate mistakes produce values that still look like coordinates
  // and land tens of kilometres away.
  const lat = Number(w.eval(`plotfixDegMin('1749.2120','S')`));
  near(lat, -17.8202, 1e-6, 'latitude should be -17.8202');
  const lon = Number(w.eval(`plotfixDegMin('03103.0120','E')`));
  near(lon, 31.0502, 1e-6, 'longitude should be 31.0502');
  assert(Number(w.eval(`plotfixDegMin('1749.2120','N')`)) > 0, 'N should be positive');
  assert(Number(w.eval(`plotfixDegMin('03103.0120','W')`)) < 0, 'W should be negative');
});

check('GGA yields fix type, satellites and DOP', () => {
  const s = JSON.parse(w.eval(`
    (function(){ plotfixIngest(${JSON.stringify(GGA_RTK)}); return JSON.stringify({
      q: plotfixState.quality.key, sats: plotfixState.satsUsed, hdop: plotfixState.hdop,
      age: plotfixState.correctionAge, base: plotfixState.baseId, src: plotfixState.source }); })()
  `));
  assert(s.q === 'rtk_fix', `quality 4 is RTK fixed — got ${s.q}`);
  assert(s.sats === 12, `12 satellites — got ${s.sats}`);
  near(s.hdop, 0.8, 1e-9, 'HDOP');
  near(s.age, 1.2, 1e-9, 'correction age');
  assert(s.base === '0123', `base station id — got ${s.base}`);
  assert(s.src === 'nmea', 'source should be nmea');
});

check('ellipsoidal height is reconciled from GGA fields 9 and 11', () => {
  // GGA field 9 is orthometric per the spec and field 11 is the geoid separation, so ellipsoidal
  // is their sum. Receivers disagree about this field, and getting it wrong is a whole-geoid
  // error in height — tens of metres, which is exactly the size that ruins a drainage design.
  const alt = Number(w.eval(`(function(){ plotfixIngest(${JSON.stringify(GGA_RTK)}); return plotfixState.altEllipsoid; })()`));
  near(alt, 1480.4 + -14.2, 0.001, 'ellipsoidal height should be MSL + geoid separation');
});

check('GST measured deviation beats an HDOP estimate', () => {
  // HDOP is a geometry multiplier, not a distance. Quoting it as accuracy is a category error, so
  // where GST exists it must win — and the basis must be reported so a measured figure and an
  // estimated one are never presented identically.
  const est = JSON.parse(w.eval(`
    (function(){
      plotfixState = { ...plotfixState, sdHoriz:null, hdop:0.8 };
      return JSON.stringify(plotfixAccuracy());
    })()
  `));
  assert(est.basis === 'estimated', `HDOP-derived accuracy should be labelled estimated — got ${est.basis}`);
  const meas = JSON.parse(w.eval(`
    (function(){ plotfixIngest(${JSON.stringify(GST_LINE)}); return JSON.stringify(plotfixAccuracy()); })()
  `));
  assert(meas.basis === 'measured', `GST accuracy should be labelled measured — got ${meas.basis}`);
  // sqrt(0.008² + 0.006²) = 0.01 m
  near(meas.m, 0.01, 0.001, 'horizontal deviation from GST lat/lon sigmas');
});

check('the capture gate refuses a fix that fails the project standard', () => {
  const res = JSON.parse(w.eval(`
    (function(){
      setPlotfixGate({ on:true, minQuality:'rtk_fix', maxHoriz:0.05 });
      plotfixIngest(${JSON.stringify(GGA_RTK)});
      plotfixIngest(${JSON.stringify(GST_LINE)});
      var pass = plotfixCheckGate();
      // Now the same gate against an autonomous fix.
      var auto = ${JSON.stringify(withChecksum('GPGGA,123520.00,1749.2120,S,03103.0120,E,1,07,2.4,1480.4,M,-14.2,M,,'))};
      plotfixState = { ...plotfixState, sdHoriz:null, sdVert:null };
      plotfixIngest(auto);
      var fail = plotfixCheckGate();
      return JSON.stringify({ pass: pass.ok, fail: fail.ok, why: fail.reason });
    })()
  `));
  assert(res.pass === true, 'an RTK fixed solution at 1 cm should pass an RTK gate');
  assert(res.fail === false, 'an autonomous fix passed a gate demanding RTK fixed');
  assert(/requires RTK_FIX/i.test(res.why), `the refusal should say what is required — got "${res.why}"`);
});

check('the gate refuses rather than guesses when the device provider cannot report fix type', () => {
  // The mock-location-provider case: a receiver feeding Android's system provider gives genuinely
  // better coordinates with NO metadata. The provider might be RTK-fed and we would never know, so
  // a gate demanding better than autonomous cannot be honestly evaluated. Refusing is correct;
  // mapping it onto 'gps' and passing would be a fabricated claim about a boundary mark.
  const res = JSON.parse(w.eval(`
    (function(){
      setPlotfixGate({ on:true, minQuality:'rtk_fix', maxHoriz:5 });
      // Reset first: plotfixFromGeolocation deliberately REFUSES to overwrite a live NMEA fix
      // (a 50 m device position must never displace an RTK one), so a previous check's receiver
      // state would make this a no-op and the assertion would pass for the wrong reason.
      plotfixState = { ...plotfixState, source:'none' };
      plotfixFromGeolocation({ coords:{ latitude:-17.82, longitude:31.05, altitude:1480, accuracy:3 } });
      var r = plotfixCheckGate();
      return JSON.stringify({ ok:r.ok, why:r.reason, q:plotfixState.quality.key });
    })()
  `));
  assert(res.ok === false, 'a metadata-free device fix passed a gate demanding RTK');
  assert(/does not report fix type/.test(res.why), `the refusal should explain why — got "${res.why}"`);
  assert(res.q === 'system', `a device fix should not claim a GNSS quality digit — got ${res.q}`);
});

check('a device fix does not inherit a previous receiver’s metadata', () => {
  // The most damaging possible staleness: DOP and satellite counts from a real receiver left
  // sitting on a fix that came from the phone. A surveyor reads exactly these fields to decide
  // whether to trust a mark.
  const s = JSON.parse(w.eval(`
    (function(){
      plotfixIngest(${JSON.stringify(GGA_RTK)});
      // Simulate the receiver dropping out: source is cleared the way plotfixAttachNative's
      // disconnect handler does, leaving the stale DOP/satellite fields behind. Those are exactly
      // what must not survive into the next device fix.
      plotfixState = { ...plotfixState, source:'none' };
      plotfixFromGeolocation({ coords:{ latitude:-17.82, longitude:31.05, altitude:1480, accuracy:4 } });
      return JSON.stringify({ hdop:plotfixState.hdop, sats:plotfixState.satsUsed, base:plotfixState.baseId, age:plotfixState.correctionAge });
    })()
  `));
  assert(s.hdop === null && s.sats === null, `stale receiver metadata carried into a device fix: ${JSON.stringify(s)}`);
  assert(s.base === null && s.age === null, `stale correction data carried into a device fix: ${JSON.stringify(s)}`);
});

check('a real NMEA link is never downgraded by an incoming device fix', () => {
  const src = w.eval(`
    (function(){
      plotfixIngest(${JSON.stringify(GGA_RTK)});
      plotfixFromGeolocation({ coords:{ latitude:0, longitude:0, accuracy:50 } });
      return plotfixState.source;
    })()
  `);
  assert(src === 'nmea', `a 50 m device fix overwrote an RTK receiver fix — got source ${src}`);
});

check('fix provenance is recorded on the vertex, not just displayed', () => {
  // Not reconstructible afterwards. A survey where you cannot tell which marks were RTK is a
  // survey you cannot defend.
  const keys = JSON.parse(w.eval(`
    (function(){ plotfixIngest(${JSON.stringify(GGA_RTK)}); return JSON.stringify(Object.keys(plotfixVertexMeta())); })()
  `));
  ['fix_quality', 'sats_used', 'hdop', 'accuracy_m', 'accuracy_basis', 'correction_age_s', 'base_station_id']
    .forEach(k => assert(keys.includes(k), `vertex provenance is missing ${k}`));
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/capture_method:captureMethod, fix\}/.test(gps), 'the capture path does not attach fix provenance to the vertex');
  const feat = fs.readFileSync(path.join(ROOT, 'js/11-features.js'), 'utf8');
  assert(/fix:v\.fix\|\|null/.test(feat), 'the save path drops the fix provenance');
});

check('the existing external-GPS path now verifies checksums', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/plotfixChecksumOk\(line\)/.test(src), 'handleNmeaLine still trusts unverified sentences');
  assert(/plotfixIngest\(line\)/.test(src), 'sentences are not fed to the full parser');
});

check('the native serial contract is documented for the Android side', () => {
  // The transport cannot be written in JS: survey receivers use Bluetooth Classic SPP, and Web
  // Bluetooth is BLE GATT only. This asserts the interface the plugin must satisfy is written
  // down, so the Java side is built against a fixed contract rather than designed twice.
  const src = fs.readFileSync(path.join(ROOT, 'js/17d-plotfix.js'), 'utf8');
  assert(/PlotFixSerial/.test(src), 'no plugin name declared');
  assert(/00001101-0000-1000-8000-00805F9B34FB/i.test(src), 'the SPP service UUID is not recorded');
  assert(/addListener\('nmea'/.test(src), 'the event contract is not documented');
});

// ══ PLOTWORDS ═════════════════════════════════════════════════════════════
// The Plot* names are kept deliberately, so the thing to guard is that each one can EXPLAIN
// itself. The failure mode is silent and slow: a module gets added, nobody adds a glossary entry,
// and a first-time user meets a twelfth proper noun with no way to find out what it means.

check('every user-visible Plot* name has a plain-English explanation', () => {
  // Scanned out of index.html rather than listed here, so a name added to the UI without a
  // glossary entry fails this check instead of quietly shipping.
  const shown = new Set();
  const re = />[^<]*\b(Plot[A-Z][a-z]+)\b[^<]*</g;
  let m;
  while ((m = re.exec(html))) if (m[1] !== 'PlotEdge') shown.add(m[1]);
  const known = new Set(Object.keys(w.eval('JSON.stringify(PLOTWORDS)') ? JSON.parse(w.eval('JSON.stringify(PLOTWORDS)')) : {})
    .map(k => JSON.parse(w.eval('JSON.stringify(PLOTWORDS)'))[k].name));
  const orphans = [...shown].filter(n => !known.has(n));
  assert(!orphans.length, `names shown to users with no glossary entry: ${orphans.join(', ')}`);
});

check('the explanations avoid the jargon they exist to replace', () => {
  // A descriptor that needs its own descriptor has failed. These are the terms a layman does not
  // arrive knowing, and the whole point of the long form is to not use them.
  const words = JSON.parse(w.eval(`JSON.stringify(PLOTWORDS)`));
  const jargon = /\b(vector|raster|digitiz|geodes|CRS|datum|WGS|geometry|vertex|vertices|attribute schema)\b/i;
  const bad = Object.keys(words).filter(k => jargon.test(words[k].long) && k !== 'plotgrid');
  assert(!bad.length, `explanations using GIS jargon: ${bad.join(', ')}`);
  // And every one has to actually say something.
  Object.keys(words).forEach(k => {
    assert(words[k].long && words[k].long.length > 40, `${k} has no real explanation`);
    assert(words[k].short && words[k].short.split(/\s+/).length <= 4, `${k}'s short form is too long for a tile`);
  });
});

check('an explanation is shown once and then never again', () => {
  const res = JSON.parse(w.eval(`
    (function(){
      localStorage.removeItem(PLOTWORDS_SEEN_KEY);
      var layer = document.getElementById('plotwordsLayer');
      layer.innerHTML = '';
      plotwordsExplain('plotmind');
      var first = layer.children.length;
      // Dismiss it the way the button does.
      layer.querySelector('.plotwords-strip-x').click();
      var afterDismiss = layer.children.length;
      plotwordsExplain('plotmind');
      var second = layer.children.length;
      return JSON.stringify({ first: first, afterDismiss: afterDismiss, second: second });
    })()
  `));
  assert(res.first === 1, 'the explainer did not appear on first open');
  assert(res.afterDismiss === 0, '"Got it" did not remove the strip');
  assert(res.second === 0, 'the explainer came back after being dismissed — it would become noise');
});

check('two explainers never stack on screen', () => {
  // Opening one module from inside another is normal (PlotMind links to PlotAtlas). Two strips at
  // once would cover the screen and neither would be read.
  const n = Number(w.eval(`
    (function(){
      localStorage.removeItem(PLOTWORDS_SEEN_KEY);
      var layer = document.getElementById('plotwordsLayer');
      layer.innerHTML = '';
      plotwordsExplain('plotmind');
      plotwordsExplain('plotatlas');
      return layer.children.length;
    })()
  `));
  assert(n === 1, `${n} strips on screen at once`);
});

check('closing a module clears its strip', () => {
  // The layer is fixed to the viewport, not to the module. Without an explicit clear, closing
  // PlotEtch mid-explanation leaves the strip floating over whatever screen you land on.
  const n = Number(w.eval(`
    (function(){
      localStorage.removeItem(PLOTWORDS_SEEN_KEY);
      plotwordsExplain('plotetch');
      plotwordsDismissAll();
      return document.getElementById('plotwordsLayer').children.length;
    })()
  `));
  assert(n === 0, 'a strip survived its module being closed');
  // And every module that raises one must clear it on the way out.
  ['js/14a-plotatlas.js', 'js/15-plotetch.js', 'js/16a-plotmind.js', 'js/19a-plotvault.js'].forEach(f => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const raises = (src.match(/plotwordsExplain\(/g) || []).length;
    const clears = (src.match(/plotwordsDismissAll\(/g) || []).length;
    assert(clears >= 1 && raises >= 1, `${f} raises ${raises} strips and clears ${clears}`);
  });
});

check('the glossary renders every name and can reset itself', () => {
  const out = JSON.parse(w.eval(`
    (function(){
      renderPlotWords();
      var rows = document.querySelectorAll('#plotWordsList .plotwords-row').length;
      var total = Object.keys(PLOTWORDS).length;
      return JSON.stringify({ rows: rows, total: total });
    })()
  `));
  assert(out.rows === out.total, `glossary shows ${out.rows} of ${out.total} names`);
  const reset = Number(w.eval(`
    (function(){
      plotwordsMarkSeen('plotmind');
      plotwordsResetAll();
      return Object.keys(plotwordsSeen()).length;
    })()
  `));
  assert(reset === 0, 'resetting did not clear the seen list — a new crew member gets no help');
});

// ══ NAVIGATION INTEGRITY ═══════════════════════════════════════════════════
// Ghost screens are the failure this section exists for: a panel that opens with .show but was
// never registered in closeTopOverlay's hand-maintained chain. Back then falls through it — the
// app navigates underneath while the panel stays on top of the wrong screen. It is invisible in
// review because the panel works perfectly until someone presses Back, and it is exactly the bug
// the glossary shipped with before this check existed.

check('every full-screen panel is registered with the back-button chain', () => {
  const nav = fs.readFileSync(path.join(ROOT, 'js/07-navigation.js'), 'utf8');
  const chain = nav.slice(nav.indexOf('function closeTopOverlay'));
  // Panels that take the whole viewport and are dismissed with .show. A modal inside .modal-overlay
  // is covered by the generic block in the chain; these are the ones that need naming.
  // view-plotwords is a .view rather than an overlay, so it is covered by the view/history
  // routing — but it still needs its own entry, because Back from it must return to Settings
  // rather than to whatever view happened to be active underneath.
  ['view-plotwords', 'plotAtlas', 'plPlayer', 'photoLightbox'].forEach(id => {
    assert(html.includes(`id="${id}"`), `${id} is not in index.html — this check is stale`);
    assert(chain.includes(id), `${id} opens full-screen but Back does not close it — it will strand over the next screen`);
  });
});

check('the glossary is checked before the modals it can be opened from', () => {
  // Order matters, not just presence. The glossary is reached from Settings, which is itself a
  // modal — so if the generic modal block ran first, Back would close Settings UNDERNEATH the
  // glossary and leave it floating over whatever was behind.
  const nav = fs.readFileSync(path.join(ROOT, 'js/07-navigation.js'), 'utf8');
  const chain = nav.slice(nav.indexOf('function closeTopOverlay'));
  const words = chain.indexOf('view-plotwords');
  const confirm = chain.indexOf('confirmModal');
  assert(words !== -1 && confirm !== -1, 'chain markers not found — this check is stale');
  assert(words < confirm, 'the glossary is checked after the modal block; Back would close the wrong layer first');
});

check('exactly one nav tab is active at a time', () => {
  const n = Number(w.eval(`
    (function(){
      document.querySelectorAll('.nav-btn[id^="navBtn-"]').forEach(function(b){ b.classList.add('active'); });
      switchTab('review');
      return document.querySelectorAll('.nav-btn.active').length;
    })()
  `));
  // Deliberately starts with ALL of them marked active: a sync that only ADDS the class, without
  // clearing the others, passes a naive test and leaves two tabs lit in the app.
  assert(n === 1, `${n} nav tabs are lit at once — the bar stops telling you where you are`);
});

check('the active tab is distinguishable by more than colour', () => {
  // Colour alone fails in direct sunlight, which is this app's normal working condition, and fails
  // outright for a colour-blind user. The active tab needs a surface treatment the eye reads as a
  // different material.
  const css = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  assert(/\.nav-pill \{/.test(css), 'there is no active-tab indicator surface');
  assert(/\.nav-btn\.active::before/.test(css), 'the active tab has no accent bar');
  assert(/\.nav-btn\.active svg/.test(css), 'the active tab icon is not differentiated');
  // The indicator must sit behind the glyph, or it tints the icon instead of the cell.
  assert(/\.nav-btn svg, \.nav-btn span \{ position:relative; z-index:1/.test(css),
    'the icon and label are not lifted above the indicator — it would wash over them');
});

check('a floating explainer cannot outlive a tab change', () => {
  // The strip is fixed to the viewport, not to the module that raised it. Relying on each of five
  // modules' close functions leaves every other exit path — Back, a tab tap, a deep link — able to
  // strand help text over unrelated content.
  const n = Number(w.eval(`
    (function(){
      localStorage.removeItem(PLOTWORDS_SEEN_KEY);
      plotwordsExplain('plotetch');
      switchTab('review');
      return document.getElementById('plotwordsLayer').children.length;
    })()
  `));
  assert(n === 0, 'an explainer survived a tab change and is now floating over the wrong screen');
});

check('every button meets the tap target the rest of the app holds to', () => {
  // 44px. A control below it is unreliable with a thumb, outdoors, in gloves — and the two that
  // failed this were the "Got it" button a first-time user is guaranteed to press.
  const css = fs.readFileSync(path.join(ROOT, 'css/08-plotwords.css'), 'utf8');
  const heights = [...css.matchAll(/min-height:\s*(\d+)px/g)].map(m => Number(m[1]));
  assert(heights.length >= 2, 'no explicit tap targets declared');
  const small = heights.filter(h => h < 44);
  assert(!small.length, `tap targets below 44px: ${small.join(', ')}`);
});

check('new buttons opt into the app’s press feedback rather than feeling inert', () => {
  const comp = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  const own = fs.readFileSync(path.join(ROOT, 'css/08-plotwords.css'), 'utf8');
  // The ripple host list is opt-in by design (so it never clips something meant to overflow), which
  // means a new button silently gets no ripple unless it is added.
  assert(/plotwords-strip-x, \.plotwords-row-open \{/.test(comp.replace(/\n\s+/g, ' ')) ||
         comp.includes('.plotwords-strip-x'), 'new buttons are not registered as ripple hosts');
  assert(/\.plotwords-strip-x:active/.test(own), 'no pressed state on the dismiss button');
  assert(/\.plotwords-row-open:active/.test(own), 'no pressed state on the open button');
});

check('a click-only control is not offered as a focusable button', () => {
  // role="button" plus tabindex with no key handler is a control that looks operable from a
  // keyboard and does nothing — worse than not being focusable at all.
  const rows = [...html.matchAll(/<div class="settings-row"[^>]*role="button"[^>]*>/g)].map(m => m[0]);
  rows.forEach(r => {
    assert(/onkeydown=/.test(r), `a settings row is focusable but has no key handler: ${r.slice(0, 90)}`);
  });
});

check('reduced-motion is respected by the new animation', () => {
  // The app animates a lot and someone with vestibular sensitivity has told their OS so. A new
  // keyframe that ignores that is a regression in an area the rest of the app already handles.
  const css = fs.readFileSync(path.join(ROOT, 'css/08-plotwords.css'), 'utf8');
  assert(/prefers-reduced-motion/.test(css), 'the explainer animates with no reduced-motion escape');
});

// ══ KEYBOARD / SHEET CHOREOGRAPHY ══════════════════════════════════════════
// The open half of this was already solved properly (focusWhenSettled waits for the real
// transitionend rather than guessing a delay). The close half was not: one close function out of
// twenty-three blurred its input. Everything else left the field focused, so the IME collapsed on
// the platform's own ~250ms schedule starting at an arbitrary offset into the sheet's 0.22s exit
// — and since --kbh drives the overlay's padding-bottom and top, the sheet was being re-laid-out
// on every frame of a journey it was animating out of. That is the shudder.

// The two RUNTIME keyboard checks live in tests/keyboard.test.js, with their own window. They
// need a document nothing else has touched: the observer keys off the transition of a class on a
// specific element, and forty preceding checks in this file leave modals half-open, fields
// focused and views switched. A check that passes or fails depending on what ran before it is
// worse than no check, so it gets a clean boot rather than a defensive reset.

check('the dismissal is central, not one call site at a time', () => {
  // Twenty-three close functions and counting. Patching each works today and rots on the next
  // sheet somebody adds, so the guarantee has to come from something that cannot be forgotten.
  const src = fs.readFileSync(path.join(ROOT, 'js/01-theme-and-settings.js'), 'utf8');
  assert(/installKeyboardDismissOnClose/.test(src), 'no central dismissal installed');
  assert(/MutationObserver/.test(src), 'dismissal is not observed — it can be bypassed');
  assert(/attributeOldValue:\s*true/.test(src), 'without the old value the observer cannot tell an open from a close');
  // Self-installing, deliberately: hanging it off js/22-boot.js made the guarantee depend on boot
  // reaching one particular line, which is the same ordering dependency the observer exists to
  // remove. It failed exactly that way first time.
  assert(/if \(document\.body\) installKeyboardDismissOnClose\(\)/.test(src),
    'the observer is not self-installing — it depends on another file remembering to call it');
  assert(/DOMContentLoaded', installKeyboardDismissOnClose/.test(src),
    'no fallback for loading before document.body exists');
});

check('the sheet exit and the keyboard collapse run on one clock', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  // padding-bottom (keyboard height) and top (viewport offset) both change on the same keyboard
  // event. Easing one and teleporting the other means the container's height changes at two rates
  // for the whole animation, which reads as snapping rather than following.
  const showBlock = css.slice(css.indexOf('.modal-overlay.show {'), css.indexOf('.modal-overlay.show {') + 400);
  assert(/padding-bottom var\(--sheet-t\)/.test(showBlock), 'padding-bottom is not on the sheet clock');
  assert(/top var\(--sheet-t\)/.test(showBlock), 'top is not on the sheet clock — the sheet edges move at different rates');
  // And when the platform is streaming the inset itself, our transitions must get out of the way
  // rather than retargeting a 220ms ease every frame.
  assert(/html\.kb-animating \.modal-overlay/.test(css), 'no escape hatch for platform-driven inset animation');
});

check('focus scrolling cannot run against a sheet that is leaving', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/01-theme-and-settings.js'), 'utf8');
  const fn = src.slice(src.indexOf('function scrollFocusedIntoView'), src.indexOf('function scrollFocusedIntoView') + 700);
  assert(/classList\.contains\('show'\)/.test(fn),
    'a smooth scroll can still be triggered inside a mid-exit sheet, repainting a container that is supposed to be leaving');
});

check('no stylesheet references a CSS variable that does not exist', () => {
  // A var() with a fallback fails SILENTLY: an invented token name resolves to the fallback and
  // the page looks fine to whoever wrote it. css/08-plotwords.css shipped referencing --surface-1,
  // --text-dim, --border and --accent — none of which exist — so every declaration fell through to
  // a hardcoded dark fallback and the glossary was dark in light mode. Not because light mode was
  // unhandled, but because it never reached the theme at all.
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, ''); // comments discuss token names too
  const cssFiles = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'));
  const allCss = cssFiles.map(f => strip(fs.readFileSync(path.join(ROOT, 'css', f), 'utf8'))).join('\n');
  // A token counts as defined if any stylesheet declares it, OR if JavaScript sets it at runtime —
  // several (--vvh, --kbh, --pl-dur) only ever exist because a module writes them.
  const allJs = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
  const defined = new Set([
    ...[...allCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]),
    ...[...allJs.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)/g)].map(m => m[1]),
    // Also written as inline style strings inside template literals — PlotAtlas colours its
    // cluster dots with style="--cl:${color}". Just as real as setProperty, just less greppable.
    ...[...allJs.matchAll(/style=\\?["'][^"']*?(--[a-z0-9-]+)\s*:/g)].map(m => m[1]),
    ...[...allJs.matchAll(/(--[a-z0-9-]+)\s*:\s*\$\{/g)].map(m => m[1])
  ]);
  // Set by MainActivity from the native side (Android WebView below v140 reports env() safe-area
  // insets unreliably, so the app is handed real numbers instead). They exist at runtime but
  // appear nowhere in the web sources, so they are named here rather than silently skipped.
  const NATIVE_SET = new Set([
    '--sb-top', '--sb-bottom', '--sb-left', '--sb-right',
    // Assigned to an element's inline style from JS in ways no static scan will catch reliably.
    // Named rather than skipped, so the list stays short and visible: anything added here is a
    // token nobody can verify from the sources alone, which is worth knowing about.
    '--measure-ring-color', '--bg'
  ]);
  const orphans = [];
  cssFiles.forEach(f => {
    const css = strip(fs.readFileSync(path.join(ROOT, 'css', f), 'utf8'));
    [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].forEach(m => {
      if (!defined.has(m[1]) && !NATIVE_SET.has(m[1])) orphans.push(`${f}: ${m[1]}`);
    });
  });
  assert(!orphans.length, `CSS variables referenced but never defined:\n        ${[...new Set(orphans)].join('\n        ')}`);
});

check('the active indicator glides between tabs instead of flickering', () => {
  // The reported "re-render flash" was never a re-render: it was five independent per-tab washes
  // fading in and out across each other. One shared element that MOVES cannot flicker, because it
  // is never created or destroyed — the browser interpolates its transform. Same idea as a shared
  // layoutId in Framer Motion, done with a transform because this app is classic scripts.
  const css = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  assert(/\.nav-pill\s*\{[^}]*transition:transform/s.test(css), 'the indicator does not animate its position');
  assert(/cubic-bezier\(0\.22, 1\.28/.test(css), 'the indicator has no spring overshoot — it will feel mechanical');
  assert(!/\.nav-btn\.active::after/.test(css),
    'a per-tab wash is back alongside the shared indicator — the two will cross-fade against each other');

  const js = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  assert(/function positionNavPill/.test(js), 'nothing positions the indicator');
  // Measured, not computed from a tab count: tabs are not equal width once labels are translated
  // or the device font scale is raised, and a hardcoded fraction drifts off the button.
  assert(/getBoundingClientRect/.test(js), 'the indicator position is assumed rather than measured');
  // The first placement must not animate from the corner — that animates a state nobody saw.
  assert(/transition = 'none'/.test(js), 'the indicator flies in from the origin on first paint');
  assert(/addEventListener\('resize'/.test(js), 'the indicator is not repositioned on rotation or font-scale change');
});

check('reduced motion removes the overshoot but keeps the movement', () => {
  // Position is the information here, so it still has to move. The overshoot is the part that
  // causes trouble for vestibular sensitivity, and that is what goes.
  const css = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  // Every reduced-motion block in the file, not just the first — there are several, and slicing
  // from index 0 was testing an unrelated one.
  const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion[^}]*\{[\s\S]{0,700}?\}\s*\}/g)].map(m => m[0]);
  assert(blocks.some(b => /nav-pill/.test(b)), 'the indicator ignores the reduced-motion preference');
});

check('no stylesheet reaches for env(safe-area-inset) directly', () => {
  // The app does not trust env() on its own: Android WebView below v140 reports safe-area insets
  // unreliably, so MainActivity hands in real numbers as --sb-top/--sb-bottom and css/01-tokens.css
  // wraps them as --sat/--sab via max(). A file using the raw env() therefore fails on exactly the
  // devices the token exists to handle — which is how the explainer strip ended up under the
  // status bar while every other surface in the app cleared it.
  const files = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css') && f !== '01-tokens.css');
  const raw = [];
  files.forEach(f => {
    const css = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/env\(\s*safe-area-inset/.test(css)) raw.push(f);
  });
  assert(!raw.length, `stylesheets using env(safe-area-inset) instead of --sat/--sab: ${raw.join(', ')}`);
});

check('the glossary uses the app’s own subpage chrome, not its own', () => {
  // Three faults at once — content under the status bar, a back button that did not match, and a
  // header with no press feedback — were all one mistake: reimplementing chrome that already
  // existed. .subpage-header carries --sat padding, the sticky treatment, and the rules that
  // .icon-back is scoped through.
  assert(/<div class="view" id="view-plotwords">/.test(html), 'the glossary is not a standard view');
  const block = html.slice(html.indexOf('id="view-plotwords"'), html.indexOf('id="view-plotwords"') + 1200);
  assert(/class="subpage-header"/.test(block), 'the glossary has a bespoke header again');
  assert(/class="subpage-body"/.test(block), 'the glossary has a bespoke body again');
  assert(/class="icon-back"/.test(block), 'the back button is not the app’s');
  const own = fs.readFileSync(path.join(ROOT, 'css/08-plotwords.css'), 'utf8');
  assert(!/\.plotwords-screen-head\s*\{/.test(own), 'bespoke header styles are back');
});

check('every button in the app acknowledges being pressed', () => {
  // A sweep, not a list. Fifteen button classes had no :active rule at all — tapping them changed
  // nothing until whatever they did finished, and on a slow frame that reads as a missed tap, so
  // it gets tapped again. Double-fired deletes and double-added repeat rows come from exactly
  // this. Written as a scan so a button added next month is caught rather than trusted.
  const allCss = fs.readdirSync(path.join(ROOT, 'css'))
    .filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  const allJs = fs.readdirSync(path.join(ROOT, 'js'))
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
  // Buttons are written in markup AND built in template literals, so both are scanned.
  const classes = new Set();
  [...(html + '\n' + allJs).matchAll(/<button[^>]*class="([^"]*)"/g)].forEach(m =>
    m[1].split(/\s+/).forEach(c => { if (/^[a-z][a-z0-9-]*$/.test(c)) classes.add(c); }));
  assert(classes.size >= 30, `only found ${classes.size} button classes — the scan is not working`);
  const inert = [...classes].filter(c => {
    if (/^(btn|is-|has-)/.test(c)) return false;                       // the .btn family has its own states
    // Modifiers and state flags. These only ever appear alongside a real component class, so a
    // bare rule for them would reach far wider than intended — they are excluded rather than
    // styled.
    if (['active','sel','show','ghost','open','disabled','primary','wide','tone-danger','compact']
        .includes(c)) return false;
    if (!new RegExp('\\.' + c + '[\\s,{:]').test(allCss)) return false; // not styled in this app at all
    return !new RegExp('\\.' + c + '[^{,]*:active').test(allCss);
  });
  assert(!inert.length, `button classes with no pressed state:\n        ${inert.sort().join('\n        ')}`);
});

check('close and back buttons meet the touch target', () => {
  // These are the buttons most often reached for one-handed, at the very edge of the screen, and
  // three of the four floating close buttons were 34-38px. Under a thumb that is a miss.
  const allCss = fs.readdirSync(path.join(ROOT, 'css'))
    .filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  ['icon-back', 'lb-close', 'pl-close', 'barcode-scanner-close', 'install-banner-close'].forEach(c => {
    const rule = allCss.match(new RegExp('\\.' + c + '\\s*\\{[^}]*\\}'));
    assert(rule, `.${c} has no rule`);
    const w = rule[0].match(/width:\s*(\d+)px/);
    assert(w && Number(w[1]) >= 44, `.${c} is ${w ? w[1] : '?'}px — below the 44px target`);
    assert(new RegExp('\\.' + c + ':active').test(allCss), `.${c} has no pressed state`);
    assert(/transition:/.test(rule[0]), `.${c} snaps between states instead of settling`);
  });
});

check('a destructive press is visually distinct from an ordinary one', () => {
  // The one press you most want unambiguous confirmation of is the one that removes something.
  const allCss = fs.readdirSync(path.join(ROOT, 'css'))
    .filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  assert(/\.ph-del:active[^{]*\{[^}]*--danger-rgb/.test(allCss.replace(/\n/g, ' ')) ||
         /ph-del:active[\s\S]{0,400}danger/.test(allCss),
    'delete buttons press the same as any other button');
});

// ══ THE HOME-SCREEN WIDGET ═══════════════════════════════════════════════════
// The widget is generated by scripts/patch-android-widget.py at APK build time, so it is not
// exercised by any of the DOM tests above. These read the generator, which is the only place its
// behaviour is decided.

check('the widget offers a wallpaper-derived palette on Android 12+', () => {
  // Every first-party widget on a modern Android home screen is tinted from the wallpaper. A
  // widget carrying fixed brand blue sits next to Clock, Weather and Calendar all sharing a
  // palette and reads as the one thing that does not belong. This is not Pixel-specific —
  // dynamic colour is AOSP from API 31, so One UI 4+, OnePlus, Xiaomi and Motorola all do it.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-widget.py'), 'utf8');
  assert(/values-v31/.test(src), 'no Android 12+ colour variant is written');
  assert(/values-night-v31/.test(src), 'no Android 12+ dark colour variant is written');
  assert(/@android:color\/system_accent1_/.test(src), 'the wallpaper palette is never referenced');
  assert(/@android:color\/system_neutral1_/.test(src), 'neutrals are not taken from the system palette');
});

check('the pre-Android-12 palette still exists to fall back to', () => {
  // system_* resources do not exist below API 31. The -v31 qualifier is what keeps older devices
  // on the brand palette; without the unqualified files they would have no colours at all.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-widget.py'), 'utf8');
  assert(/write\(RES \/ "values" \/ "plotedge_widget_colors\.xml"/.test(src), 'no base palette');
  assert(/write\(RES \/ "values-night" \/ "plotedge_widget_colors\.xml"/.test(src), 'no base dark palette');
  // All four files must declare the SAME names, or a device resolving to one of them gets an
  // unresolved reference at inflate time and the widget fails to draw at all.
  const blocks = [...src.matchAll(/COLORS(?:_NIGHT|_DYNAMIC|_DYNAMIC_NIGHT)?_XML = """([\s\S]*?)"""/g)]
    .map(m => new Set([...m[1].matchAll(/<color name="([^"]+)"/g)].map(x => x[1])));
  assert(blocks.length === 4, `expected 4 colour palettes, found ${blocks.length}`);
  const base = [...blocks[0]].sort().join(',');
  blocks.forEach((b, i) => {
    assert([...b].sort().join(',') === base,
      `palette ${i} declares a different set of names — a device resolving to it would fail to inflate the widget`);
  });
});

check('the warning colour is not wallpaper-derived', () => {
  // A warning that turns lilac because the user picked a purple wallpaper has stopped being a
  // warning. This one colour is doing semantic work, not decorative work.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-widget.py'), 'utf8');
  const dyn = src.slice(src.indexOf('COLORS_DYNAMIC_XML'), src.indexOf('WIDGET_JAVA'));
  const warn = dyn.match(/<color name="pe_widget_warn">([^<]+)</g) || [];
  assert(warn.length >= 2, 'the warning colour is missing from a dynamic palette');
  warn.forEach(w => assert(!/@android:color/.test(w), `the warning colour follows the wallpaper: ${w}`));
});

// ══ THE DESIGN SCALE ═══════════════════════════════════════════════════════
// An audit found eighteen border radii, ten transition durations and fourteen font sizes inside a
// three-pixel band. None of it was a bug — every screen looked deliberate alone. But a 9px corner
// beside an 11px one is a difference the eye registers without being able to name, and the
// cumulative effect is an app that reads as assembled rather than designed. These checks hold the
// consolidated scale in place, because this is precisely the kind of consistency that decays one
// reasonable-looking exception at a time.

check('the design scale exists and is documented', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'css/01-tokens.css'), 'utf8');
  ['--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-pill',
   '--dur-fast','--dur-base','--dur-slow','--ease',
   '--elev-1','--elev-2','--elev-3','--elev-4',
   '--radius-xl','--text-2xs','--text-xs','--text-sm','--text-md','--text-lg','--text-xl','--text-2xl']
    .forEach(t => assert(new RegExp('\\' + t + '\\s*:').test(tokens), `${t} is not defined`));
});

check('no stylesheet invents an off-scale corner radius', () => {
  // The scale is 6 / 8 / 12 / 16 / 999 / 50%. Anything else — 9, 11, 14 — is a value somebody
  // nudged rather than chose, and it is what made the app look very slightly out of register.
  // Multi-value radii are SHAPES, not scale steps — a sheet's top-only corners, a teardrop
  // marker, a tab's accent cap. They are exempt because there is no scale step that could
  // express them.
  const ALLOWED = new Set(['0','8px','12px','999px','50%','2px']);
  const isShape = v => v.split(/\s+/).length > 1;
  const bad = [];
  fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css') && f !== '01-tokens.css').forEach(f => {
    const css = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    [...css.matchAll(/border-radius:\s*([^;}]+)[;}]/g)].forEach(m => {
      const v = m[1].trim();
      if (v.startsWith('var(')) return;                    // already on a token
      if (ALLOWED.has(v) || isShape(v)) return;
      bad.push(`${f}: ${v}`);
    });
  });
  assert(!bad.length, `off-scale border radii:\n        ${[...new Set(bad)].join('\n        ')}`);
});

check('no stylesheet invents an off-scale transition duration', () => {
  // Three steps: 0.12 / 0.15 / 0.28. 0.22s is the deliberate exception — it is --sheet-t, matched
  // to the platform keyboard animation rather than to the app's own rhythm, and changing it would
  // desynchronise every sheet from the IME.
  // The long ones (0.35s, 0.4s, 0.5s) are entrance choreography — a splash bloom, a first-run
  // reveal — not interaction feedback, and they are timed to their own sequences.
  const ALLOWED = new Set(['0s','0.12s','0.15s','.15s','0.22s','0.35s','0.4s','0.5s']);
  const bad = [];
  fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css') && f !== '01-tokens.css').forEach(f => {
    const css = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    [...css.matchAll(/transition:([^;}]+)[;}]/g)].forEach(m => {
      [...m[1].matchAll(/(?<![\w.-])(\d*\.?\d+s)/g)].forEach(d => {
        if (!ALLOWED.has(d[1])) bad.push(`${f}: ${d[1]}`);
      });
    });
  });
  assert(!bad.length, `off-scale transition durations:\n        ${[...new Set(bad)].join('\n        ')}`);
});

check('elevation comes from the scale, not from a fresh guess each time', () => {
  // Fifty-one distinct box-shadows is not fifty-one levels of height — it is fifty-one guesses.
  // Insets (bevels), coloured shadows (glows) and multi-layer compositions are excluded: those do
  // a different job and were composed deliberately.
  const bad = [];
  fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css') && f !== '01-tokens.css').forEach(f => {
    const css = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    [...css.matchAll(/box-shadow:([^;}]+)[;}]/g)].forEach(m => {
      const v = m[1].trim();
      if (v.startsWith('var(') || v === 'none' || v.includes('inset') || v.includes(',')) return;
      if (/^0 \d+px \d+px rgba\(0,0,0/.test(v)) bad.push(`${f}: ${v}`);
    });
  });
  assert(!bad.length, `plain shadows not on the elevation scale:\n        ${[...new Set(bad)].join('\n        ')}`);
});

check('every function the app defines is reachable from somewhere', () => {
  // The check I most needed and did not have. PlotGrid and PlotFix were built, unit-tested and
  // wired to nothing: setProjectCrs, setPlotfixGate, plotfixCheckGate and plotfixStatusLine all
  // had passing tests proving they behaved correctly, and no caller anywhere. The capture button
  // had never once refused a bad fix, which was the entire point of that work.
  //
  // Unit tests cannot catch this by construction — they call the function themselves, which is
  // exactly what a real caller would look like. Only a scan of the whole source can tell you
  // whether the app can get there.
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
  const sources = {};
  files.forEach(f => { sources[f] = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'); });
  const all = Object.values(sources).join('\n') + '\n' + html;

  // Deliberately kept but not called from app code. Each is named with a reason, so the list
  // stays short and every entry is a decision rather than an oversight.
  const KEPT = {
    'ftIsMultiGeometry': 'reads as intent at a call site; kept alongside ftGeometries',
    'countDraftVertices': 'diagnostic, called from the console when investigating a store issue',
    'photoQueueIdle': 'test seam for the photo pipeline',
    'selectAllInAttrQuery': 'attr-query bulk actions, reachable only when that panel gains buttons',
    'invertAttrSelection': 'same',
    'canWriteDeviceFiles': 'capability probe used by the export path in some builds',
    'shareLastExport': 'share-sheet entry point, platform dependent',
    'peBackupEnvelope': 'backup format helper retained for reading older files',
    'plotfixIngestBlock': 'diagnostics — pastes raw NMEA to verify a receiver against the parser',
    'plotvaultClearAll': 'destructive; deliberately not bound to a button'
  };

  const unreachable = [];
  files.forEach(f => {
    [...sources[f].matchAll(/^(?:async )?function ([a-zA-Z_$][\w$]*)\s*\(/gm)].forEach(m => {
      const n = m[1];
      if (KEPT[n]) return;
      const refs = (all.match(new RegExp('(?<![\\w$.])' + n + '(?![\\w$])', 'g')) || []).length;
      const defs = (all.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length;
      if (refs - defs === 0) unreachable.push(`${f}: ${n}`);
    });
  });
  assert(!unreachable.length,
    `functions defined but called from nowhere — features the user cannot reach:\n        ${unreachable.join('\n        ')}`);
});

check('the accuracy gate is enforced at the capture button', () => {
  // Specifically, not just "is reachable". The gate has to run where capture becomes pressable,
  // and it has to run on BOTH position sources — an RTK link dropping to float is exactly when
  // capture should stop, and no geolocation event accompanies that.
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/function applyFixGateToCaptureButton/.test(gps), 'nothing applies the gate to the button');
  assert(/plotfixCheckGate\(\)/.test(gps), 'the gate is never evaluated');
  const calls = (gps.match(/applyFixGateToCaptureButton\(\)/g) || []).length;
  assert(calls >= 2, `the gate is applied ${calls} time(s) — it must run on the NMEA path as well as the device one`);
  // And the refusal has to be legible: a disabled button with no explanation is worse than no gate.
  assert(/fixGateNote/.test(gps) && /fixGateNote/.test(html), 'the gate gives no visible reason for refusing');
});

check('the coordinate system is selectable, not just implemented', () => {
  // Both entry points open the SAME searchable sheet. Export briefly had a plain <select> while
  // the project form had the picker — two interfaces for one setting, which is worse than either
  // alone: the dropdown cannot search two dozen entries, and anyone who learns one has to learn
  // the other.
  const opens = (html.match(/openCrsPicker\(/g) || []).length;
  assert(opens >= 2, `only ${opens} entry point(s) to the coordinate picker — expected the project form and Export`);
  assert(!/id="projectCrsSelect"/.test(html), 'a second, non-searchable coordinate control is back');
  assert(/id="geoidOffsetInput"/.test(html), 'no way to set a height offset');
  const grid = fs.readFileSync(path.join(ROOT, 'js/16b-plotgrid.js'), 'utf8');
  // The picker list is built from the registry, so adding a grid stays a data edit.
  // The list comes from crsSearch(), which enumerates the registry — so adding a grid stays a
  // data edit. Asserted via the search function rather than a literal Object.keys call, since the
  // enumeration moved there when the dropdown was replaced.
  assert(/Object\.keys\(PLOTGRID_REGISTRY\)/.test(grid), 'the CRS list does not come from the registry');
  assert(/host\.innerHTML = keys\.map/.test(grid), 'the picker rows are not generated from the search result');
  // The datum caveat must reach the screen, not only the export header.
  assert(/datum shift is NOT applied/.test(grid), 'a legacy datum is not flagged in the UI');
});

check('the coordinate system is searchable, not a two-dozen-entry dropdown', () => {
  // A <select> works at eight entries. The registry now has two dozen, and the useful queries are
  // "harare", "2048" and "zone 36" — none of which a dropdown can answer.
  const grid = fs.readFileSync(path.join(ROOT, 'js/16b-plotgrid.js'), 'utf8');
  assert(/function crsSearch/.test(grid), 'there is no search');
  assert(/id="crsSearchInput"/.test(html), 'the picker has no search field');
  // Search has to reach beyond the label, or the two most likely queries both fail.
  const reg = JSON.parse(w.eval(`JSON.stringify(PLOTGRID_REGISTRY)`));
  const withFind = Object.keys(reg).filter(k => reg[k].find);
  assert(withFind.length >= Object.keys(reg).length - 1,
    `${Object.keys(reg).length - withFind.length} coordinate systems have no search keywords and are effectively unfindable`);
});

check('searching finds a grid by town, by EPSG code and by belt', () => {
  const byTown = JSON.parse(w.eval(`JSON.stringify(crsSearch('harare'))`));
  assert(byTown.includes('lo31'), `"harare" should find Lo31 — got ${byTown.join(', ') || 'nothing'}`);
  const byEpsg = JSON.parse(w.eval(`JSON.stringify(crsSearch('2048'))`));
  assert(byEpsg[0] === 'lo31', `an exact EPSG match should rank first — got ${byEpsg.join(', ') || 'nothing'}`);
  const byZone = JSON.parse(w.eval(`JSON.stringify(crsSearch('utm 36'))`));
  assert(byZone.length, '"utm 36" found nothing');
  // Terms must narrow, not widen: an OR search would return every Gauss belt for this.
  const narrowed = JSON.parse(w.eval(`JSON.stringify(crsSearch('zimbabwe 31'))`));
  assert(narrowed.length && narrowed.length < 5,
    `two terms should narrow the result — got ${narrowed.length} matches`);
});

check('the right grid is suggested from the project site', () => {
  // So a crew does not have to work out which 2-degree belt they are standing in.
  const harare = w.eval(`crsSuggestFor(-17.8202, 31.0502)`);
  assert(harare === 'lo31', `Harare sits in the Lo31 belt — got ${harare}`);
  const jhb = w.eval(`crsSuggestFor(-26.2041, 28.0473)`);
  assert(jhb === 'lo27' || jhb === 'lo29', `Johannesburg should suggest a nearby belt — got ${jhb}`);
  // Hemisphere must agree: a south-oriented belt is not the answer north of the equator.
  const north = w.eval(`crsSuggestFor(51.5, 31.0)`);
  assert(north !== 'lo31', 'a south-oriented Gauss belt was suggested for a northern-hemisphere site');
  // And no answer is better than a wrong one outside the covered regions.
  const pacific = w.eval(`crsSuggestFor(-20, -140)`);
  assert(pacific === null, `nothing covers the mid-Pacific — should return null, got ${pacific}`);
});

check('the coordinate system is chosen at project creation and stored on the project', () => {
  assert(/id="newProjCrsBtn"/.test(html), 'the project form has no coordinate system control');
  const proj = fs.readFileSync(path.join(ROOT, 'js/05-projects.js'), 'utf8');
  assert(/crs, bounds, createdAt:nowIso/.test(proj), 'a new project does not store its coordinate system or its area');
  assert(/p\.crs = crs;/.test(proj), 'editing a project does not update its coordinate system');
  assert(/function syncProjectFormCrs/.test(proj), 'the form does not reflect the stored choice');
});

check('every map read-out speaks the project’s coordinate system', () => {
  // Setting a CRS is only worth doing if the whole app speaks it. A crew seeing grid numbers on
  // Collect and degrees on the map is worse off than one seeing degrees everywhere, because it
  // invites reading one for the other.
  [['js/14a-plotatlas.js', 'PlotAtlas'], ['js/14-map.js', 'the review map'],
   ['js/16-geometry-math.js', 'PlotEtch measurements'], ['js/08-gps.js', 'the GPS card']]
    .forEach(([f, what]) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert(/crsFormat\(|crsProject\(/.test(src), `${what} still prints raw lat/lon`);
    });
});

check('the picker sheet is closed by the back button', () => {
  const nav = fs.readFileSync(path.join(ROOT, 'js/07-navigation.js'), 'utf8');
  assert(/crsPickerModal/.test(nav), 'Back falls through the coordinate picker');
});

check('the site can be placed on a map, not only taken from the phone’s position', () => {
  // The site was only ever settable from the device's own GPS, so it recorded wherever the person
  // was standing when they made the project — the office, the truck. That coordinate suggests the
  // coordinate system, centres every map the crew opens, and groups the project cards.
  assert(/id="sitePickerMap"/.test(html), 'there is no map picker for the site');
  assert(/openSitePicker\('site'\)/.test(html), 'nothing opens it for placing the site');
  const b = fs.readFileSync(path.join(ROOT, 'js/05a-plotbounds.js'), 'utf8');
  assert(/function sitePickerStartView/.test(b), 'the picker has no sensible opening view');
  // Opening on a world view when a position is already known would make the accurate option the
  // slower one, and nobody would use it.
  assert(/plotfixState\.lat/.test(b), 'the picker ignores the live GPS fix when choosing where to open');
});

check('a project can carry a working area, and it warns rather than blocks', () => {
  const b = fs.readFileSync(path.join(ROOT, 'js/05a-plotbounds.js'), 'utf8');
  assert(/function outsideProjectBounds/.test(b), 'no outlier check exists');
  assert(/showConfirm\(/.test(b), 'the outlier check does not ask — it either blocks or ignores');
  // Blocking would get switched off within a week: a survey legitimately reaches outside its own
  // boundary for a control point on a hilltop or a benchmark at the district office.
  assert(!/return false;\s*\/\/ block/.test(b), 'the boundary hard-blocks capture');
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/confirmIfOutlier/.test(gps), 'the check never runs at capture time');
  // Guarded at the single funnel both capture modes and both coordinate sources pass through,
  // rather than at four call sites of which one would eventually be forgotten.
  assert(/function commitVertex[\s\S]{0,900}confirmIfOutlier/.test(gps),
    'the outlier check is not inside commitVertex — some capture paths would skip it');
});

check('the area can be derived from what has already been captured', () => {
  // The obvious thing to want once a survey is underway and nobody set an area at the start, and
  // more accurate than framing it by eye.
  const b = fs.readFileSync(path.join(ROOT, 'js/05a-plotbounds.js'), 'utf8');
  assert(/function boundsFromFeatures/.test(b), 'no way to derive the area from captured data');
  assert(/0\.2/.test(b), 'the derived area is not padded — a crew would immediately trip over its own edges');
  assert(/boundsFromFeatures\(\)/.test(html), 'nothing in the UI calls it');
});

check('the outlier message says how far outside, not just that it is', () => {
  // "Outside the project area" is a fact the crew may already know and accept. "31 km outside" is
  // almost always a mistake, and the number is what tells them which of the two this is.
  const b = fs.readFileSync(path.join(ROOT, 'js/05a-plotbounds.js'), 'utf8');
  assert(/km|Math\.round\(d\)/.test(b), 'the distance outside is never computed for the message');
  assert(/outside the project area/i.test(b), 'no message is shown');
});

check('the dashboard shows four actions plus More, not eight', () => {
  // The comment above the grid in index.html has said "only the top four" since it was written,
  // while QA_MAX was 8 the whole time. Eight tiles rendered, and the dashboard ran off the bottom
  // of a short screen — the clutter and the cut-off were the same bug.
  const geo = fs.readFileSync(path.join(ROOT, 'js/16-geometry-math.js'), 'utf8');
  const max = Number((geo.match(/const QA_MAX = (\d+)/) || [])[1]);
  assert(max === 4, `QA_MAX is ${max}, so the dashboard renders ${max} tiles`);
  const def = (geo.match(/const QA_DEFAULT = \[([^\]]*)\]/) || [])[1] || '';
  assert(def.split(',').length <= 4, 'the default grid is over the maximum and would be silently truncated');
});

check('More is the fifth tile, not a footer, and opens the existing drawer', () => {
  // It was a full-width row below the grid, which read as a footer and sat below the fold on a
  // short screen — the dashboard's most-used escape hatch, hardest to reach.
  assert(/class="qa-tile qa-tile-more"/.test(html), 'More is not styled as a tile');
  assert(/qa-tile-more[^>]*onclick="openMoreActions\(\)"/.test(html),
    'the More tile does not open the existing searchable drawer');
  // Reusing the drawer matters: it already has search, grouping and the full action list. A new
  // sheet would be a second thing to keep in step with the registry.
  assert(/id="moreActionsModal"/.test(html), 'the drawer it points at does not exist');
  assert(/id="qaSearchInput"/.test(html), 'the drawer has no search — demoting actions would bury them');
});

check('the quick action tiles read as one block, not five cards', () => {
  // Quick actions moved to their own stylesheet once 05-components.css outgrew the size the split
  // test allows; the rules are unchanged, only their address is.
  const css = fs.readFileSync(path.join(ROOT, 'css/10-quick-actions.css'), 'utf8');
  const block = css.slice(css.indexOf('.qa-grid .qa-tile, .qa-tile-more'), css.indexOf('.qa-grid .qa-tile, .qa-tile-more') + 320);
  assert(/box-shadow:none/.test(block), 'the tiles still carry individual card shadows');
  assert(/surface-sunken/.test(block), 'the tiles are not on a recessed surface');
  // Scoped to the dashboard: the drawer's tiles sit on a modal, where a recessed surface would
  // disappear into the backdrop.
  assert(/\.qa-grid \.qa-tile/.test(css), 'the lighter treatment is not scoped to the dashboard grid');
});

check('set-once settings do not sit open on the busiest screens', () => {
  // Measured before changing anything: Collect and Export carry the most markup in the app, and
  // both are screens a crew is on constantly. A control that is configured once per project and
  // then never touched costs vertical space on every visit for the life of the project — which is
  // the specific shape of clutter worth removing, as distinct from "there is a lot here".
  //
  // The accuracy standard sits inside the GPS card's existing collapsed detail area rather than
  // getting a second collapsible of its own: two collapsibles side by side on one card is the
  // thing this was meant to remove, not a smaller version of it.
  const gateField = html.slice(html.indexOf('id="fixGateField"'), html.indexOf('id="fixGateField"') + 120);
  assert(/display:none/.test(gateField), 'the accuracy standard is always visible on Collect');
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/fixGateField/.test(gps), 'nothing ever reveals the accuracy standard — it would be unreachable');
  assert(/toggleGpsDetail[\s\S]{0,500}fixGateField/.test(gps),
    'the standard is not revealed by the existing detail toggle, so the card has two collapsibles');

  // What must NOT be hidden: the live fix line changes every second and is the reason to look at
  // this card at all, and the refusal note explains a disabled button — hiding that behind a
  // toggle would be perverse.
  const status = html.slice(html.indexOf('id="plotfixStatus"'), html.indexOf('id="plotfixStatus"') + 90);
  assert(!/display:none/.test(status), 'the live fix quality line is hidden by default');
});

check('the coordinate system card is collapsed but readable while collapsed', () => {
  // Set once per project, so it starts closed. But a collapsed card that hides the ONE fact you
  // would open it to check just makes you open it — the current grid is in the header.
  assert(/id="cardCoordSystem"[^>]*|class="card card-collapsible collapsed" id="cardCoordSystem"/.test(html),
    'the coordinate system card is missing');
  const card = html.slice(html.indexOf('id="cardCoordSystem"') - 60, html.indexOf('id="cardCoordSystem"') + 400);
  assert(/collapsed/.test(card), 'the coordinate system card starts expanded');
  assert(/id="exportCrsSummary"/.test(card), 'the collapsed header does not show the current grid');
  const grid = fs.readFileSync(path.join(ROOT, 'js/16b-plotgrid.js'), 'utf8');
  assert(/exportCrsSummary/.test(grid), 'the summary is never filled in');
});

check('a collapsed attributes card is honest about what is left blank', () => {
  // The badge was binary: one filled field flipped step 3 to "Completed", and the card could then
  // be folded away over seven empty ones. Nothing was wrong — none were required — but the crew
  // had no way to know, and the entire purpose of collapsing a step is to stop looking at it.
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/function collectBlankCounts/.test(gps), 'nothing counts what is still blank');
  assert(/id="attrBlankChip"/.test(html), 'the header has nowhere to report it');
  // The chip must live in the TITLE, which stays visible when the body collapses. Inside the body
  // it would vanish at exactly the moment it becomes useful.
  const title = html.slice(html.indexOf('3 · Attributes'), html.indexOf('3 · Attributes') + 400);
  assert(/attrBlankChip/.test(title), 'the blank count is not on the collapsed header');
  assert(/"Completed"/.test(gps) && /of \$\{counts\.total\}|counts\.total - counts\.blank/.test(gps),
    'the badge can still claim Completed with fields outstanding');
});

check('the blank count never becomes a requirement', () => {
  // The explicit brief: tell me, do not stop me. If this ever hardens into validation, a survey
  // that legitimately leaves half its schema blank starts being nagged, and the crew learns to
  // fill fields they do not need just to clear the warning.
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  const fn = gps.slice(gps.indexOf('function noteBlankFieldsOnCollapse'), gps.indexOf('function scrollCollectTitleIntoView'));
  assert(/showToast/.test(fn), 'nothing is said when a half-filled card is collapsed');
  assert(!/showConfirm|return false|preventDefault/.test(fn),
    'collapsing a half-filled card is blocked or challenged — it must be a note, not a gate');
  assert(/still save/.test(fn), 'the optional message does not make clear that saving is allowed');
  // And the save path must be untouched by any of this.
  const feat = fs.readFileSync(path.join(ROOT, 'js/11-features.js'), 'utf8');
  assert(!/collectBlankCounts/.test(feat), 'the blank count has leaked into save validation');
});

check('required and optional gaps are reported differently', () => {
  // Two different statements: "there is more you could add" versus "save will refuse". Merging
  // them either overstates the first or buries the second.
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/requiredBlank/.test(gps), 'required-and-empty is not counted separately');
  // Read across the whole stylesheet set rather than one file: these moved to
  // css/09-capture-form.css when 05-components passed the size limit, and a check that names a
  // file breaks on a split that changed nothing about the behaviour.
  const css = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  assert(/blank-chip\[data-tone="optional"\]/.test(css), 'no quiet tone for optional gaps');
  assert(/blank-chip\[data-tone="required"\]/.test(css), 'no distinct tone for required gaps');
  assert(/danger-rgb/.test(css.slice(css.indexOf('blank-chip[data-tone="required"]'), css.indexOf('blank-chip[data-tone="required"]') + 220)),
    'a required gap looks the same as an optional one');
});

check('fields nobody can fill are not counted as blank', () => {
  // A calculated field fills itself, a hidden field is hidden because its condition is unmet, and
  // a per-vertex field belongs to the vertex editor. Counting any of them would report a number
  // the crew cannot act on from this card — which is how an advisory becomes an irritation.
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  const fn = gps.slice(gps.indexOf('function collectBlankCounts'), gps.indexOf('function updateCollectStepStatus'));
  assert(/'calculated'/.test(fn), 'calculated fields are counted as blank');
  assert(/hiddenAttrIds/.test(fn), 'fields hidden by skip-logic are counted as blank');
  assert(/effectiveFieldScope/.test(fn), 'per-vertex fields are counted against the feature card');
});

check('a value the app supplied is never mistaken for one the crew gave', () => {
  // The failure this whole feature is arranged around: two hundred poles recorded as concrete
  // because the first one was. It happens when an inherited value is indistinguishable from an
  // observed one, so the marking is the non-negotiable part — not the carrying.
  const seed = fs.readFileSync(path.join(ROOT, 'js/06b-plotseed.js'), 'utf8');
  // seedForField returns the value AND its source together. A function returning only the value
  // would make it possible to seed a field without marking it, which is the exact hole.
  assert(/return \{ value:.*source:/.test(seed), 'a seeded value can be supplied without its source');
  assert(/function markPaneSeeded/.test(seed), 'nothing marks a seeded field');
  const collect = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  assert(/seedForField\(/.test(collect) && /markPaneSeeded\(/.test(collect),
    'seeding and marking are not both wired into the render path');
  const css = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  assert(/\.attr-pane\.is-seeded/.test(css), 'a seeded field looks identical to a filled one');
  assert(/\.seed-tag/.test(css), 'the source of a seeded value is not named on the field');
});

check('touching a seeded field confirms it, without needing an edit', () => {
  // Looking at a carried value and deciding it is right IS confirming it. Requiring an actual
  // change to clear the mark would push people to alter values needlessly, which is worse than
  // the problem being solved.
  const seed = fs.readFileSync(path.join(ROOT, 'js/06b-plotseed.js'), 'utf8');
  assert(/function clearSeedMark/.test(seed), 'a seeded mark can never be cleared');
  const collect = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  const fn = collect.slice(collect.indexOf('function bindSeedClearOnce'), collect.indexOf('function renderAttrField'));
  assert(/'input','change','click'/.test(fn), 'only edits clear the mark, not attention');
  // Pinning is a control ON the field, not an answer to it.
  assert(/attr-pin/.test(fn), 'tapping the pin would count as answering the field');
});

check('carrying forward is opt-in per field, never global', () => {
  // The app is in no position to guess that road name is constant for this run and condition is
  // not. A global carry-forward would be right for a few fields and quietly wrong for the rest.
  const seed = fs.readFileSync(path.join(ROOT, 'js/06b-plotseed.js'), 'utf8');
  assert(/function toggleFieldPin/.test(seed), 'there is no per-field opt-in');
  assert(/stickyPinsFor\(ftId\)/.test(seed), 'pins are not scoped per feature type');
  // "Condition" on a pole and "condition" on a culvert are different questions that share a label.
  assert(/stickyValues\[ft(Id)?\.?(id)?\]/.test(seed), 'carried values are not scoped per feature type');
  // Not persisted: a pin is a statement about the run you are on, and one silently surviving until
  // next week is the unnoticed-inheritance problem all over again.
  assert(!/localStorage[^\n]*sticky/i.test(seed), 'pins persist across sessions — they would be forgotten and still active');
});

check('a form that looks complete but is partly inherited says so', () => {
  const gps = fs.readFileSync(path.join(ROOT, 'js/08-gps.js'), 'utf8');
  assert(/seededFieldIds\(\)/.test(gps), 'the header never reports carried values');
  assert(/carried/.test(gps), 'there is no distinct state for "nothing blank, but not all of it reviewed"');
  const css = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  assert(/blank-chip\[data-tone="seeded"\]/.test(css), 'the carried state has no visual treatment');
});

check('a schema default is available and marked like any other seeded value', () => {
  // Lower risk than sticky — a deliberate decision made once by whoever designed the survey — but
  // to the person checking the form it is still a value they did not type.
  assert(/id="ftfDefault"/.test(html), 'a feature type field cannot declare a default');
  const schema = fs.readFileSync(path.join(ROOT, 'js/03-schema.js'), 'utf8');
  assert(/ftfDefault/.test(schema), 'the default is never read back into the field editor');
  const seed = fs.readFileSync(path.join(ROOT, 'js/06b-plotseed.js'), 'utf8');
  assert(/defaultValue/.test(seed), 'defaults are not applied at capture');
  // Sticky beats default: it is the more recent and more specific statement of intent.
  const fn = seed.slice(seed.indexOf('function seedForField'), seed.indexOf('function seededFieldIds'));
  assert(fn.indexOf('sticky') < fn.indexOf('defaultValue'), 'a stale default would override a value just carried forward');
});

// ══ THE MEMORY BANK ══════════════════════════════════════════════════════════
// PlotMind's third method. The line that matters: it SUGGESTS, it never fills. Seeding
// (js/06b-plotseed.js) trades verification for speed and pays for it with a visible marking; a
// suggestion costs nothing because the crew's answer is still their own. A suggestion that wrote
// itself in would just be a seed with worse provenance.

check('a suggestion never becomes a value on its own', () => {
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  // The only writer is applySuggestion, and it runs from a tap.
  const render = bank.slice(bank.indexOf('function renderValueSuggestions'), bank.indexOf('function applySuggestion'));
  assert(!/\.value\s*=/.test(render), 'the render pass writes a value into a field');
  assert(/onclick="applySuggestion/.test(bank), 'suggestions are not applied by an explicit tap');
  // And a tapped suggestion is the crew's answer, so it must NOT be marked as app-supplied.
  const apply = bank.slice(bank.indexOf('function applySuggestion'));
  assert(!/markPaneSeeded/.test(apply), 'a value the crew chose is marked as if the app supplied it');
});

check('the bank learns from what was saved, and counts rather than lists', () => {
  // Counting is what lets a typo entered once sink on its own instead of needing to be cleaned up,
  // and what makes the reason for a suggestion explainable: "you have used it N times".
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/function learnFromSave/.test(bank), 'nothing learns');
  assert(/\(bank\[k\]\[v\] \|\| 0\) \+ 1/.test(bank), 'values are stored as a list, so frequency is lost');
  const feat = fs.readFileSync(path.join(ROOT, 'js/11-features.js'), 'utf8');
  assert(/learnFromSave\(ft, attrs\)/.test(feat), 'learning is not wired into save');
  // Bounded, or a long survey grows the stored object without limit.
  assert(/BANK_MAX_PER_FIELD/.test(bank), 'the bank is unbounded');
});

check('learned values are scoped per feature type, not per field name', () => {
  // "Condition" on a pole and "condition" on a culvert are different questions that happen to
  // share a label; merging them would suggest a pole's vocabulary for a pipe.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/function bankKey/.test(bank) && /ftId \+ '::' \+ fieldId/.test(bank),
    'the bank is keyed on field alone');
});

check('what the crew types outranks what the app guessed', () => {
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  const fn = bank.slice(bank.indexOf('function suggestionsFor'), bank.indexOf('function renderValueSuggestions'));
  assert(fn.indexOf('learned') < fn.indexOf('domainValuesFor'), 'lexicon guesses are offered ahead of learned values');
  assert(/seen\.has/.test(fn), 'a learned value and a lexicon value can both appear for the same word');
});

check('the domain lexicon matches on what a feature type is called', () => {
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/PLOTMIND_LEXICON/.test(bank), 'there is no domain vocabulary');
  ['road','house','pole','pipe','septic','borehole','culvert'].forEach(w =>
    assert(new RegExp("'" + w + "'").test(bank), `the lexicon has nothing for ${w}`));
  // Matched loosely on both sides: "Access Road" must hit `road`, and "Surface type" must hit
  // `surface`, or the lexicon only fires for feature types named exactly right.
  const fn = bank.slice(bank.indexOf('function domainValuesFor'), bank.indexOf('function suggestionsFor'));
  assert(/name\.includes/.test(fn) && /label\.includes/.test(fn), 'the lexicon needs an exact name match to fire');
});

check('a suggestion row disappears once the field has an answer', () => {
  // Leaving it up turns it into a standing invitation to second-guess a value already given.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/String\(input\.value \|\| ''\)\.trim\(\) !== ''/.test(bank), 'suggestions persist over an answered field');
  const collect = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  assert(/renderValueSuggestions\(\)/.test(collect), 'suggestions are never refreshed as the form is filled');
});

check('learned values can be forgotten, singly and wholesale', () => {
  // A crew that mistyped a word once must be able to remove it without wiping everything — and
  // must be able to wipe everything, since the bank is a record of their own habits.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/function forgetLearnedValue/.test(bank) && /function clearValueBank/.test(bank),
    'learned values cannot be removed');
  assert(/showConfirm/.test(bank), 'a long-press deletes a suggestion with no confirmation');
  assert(/clearValueBank\(\)/.test(html), 'there is no way to clear the bank from the UI');
});

check('what is physically nearby is offered at capture, not only in review', () => {
  // PlotMind already did kNN attribute fill — but only as a post-hoc action: finish the survey,
  // open PlotMind, run checks, accept fills. That is the right tool at the wrong moment. The best
  // predictor of a septic's material is the three septics either side of it, and that is known
  // while the crew is standing there, not two weeks later at a desk.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  assert(/function nearestValueFor/.test(bank), 'nearby captures are not consulted at capture time');
  // Reuses PlotMind's own geodesy rather than carrying a second copy that could drift from it.
  assert(/pmDistM/.test(bank) && /pmCentroid/.test(bank), 'a second distance implementation was introduced');
  const mind = fs.readFileSync(path.join(ROOT, 'js/16a-plotmind.js'), 'utf8');
  const pmRadius = (mind.match(/PM_KNN_MAX_M = (\d+)/) || [])[1];
  const bankRadius = (bank.match(/BANK_NEAR_RADIUS_M = (\d+)/) || [])[1];
  assert(pmRadius && pmRadius === bankRadius,
    `capture-time and review-time kNN disagree about what "nearby" means (${bankRadius} vs ${pmRadius})`);
});

check('a weak spatial agreement is withheld rather than shown', () => {
  // A suggestion backed by two neighbours that disagree is worse than none, because on screen it
  // looks exactly like one backed by five that agree.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  const fn = bank.slice(bank.indexOf('function nearestValueFor'));
  assert(/agreement < 0\.6/.test(fn), 'a minority value can be suggested as if it were a consensus');
  assert(/near\.length < 2/.test(fn), 'a single neighbour is treated as evidence');
  assert(/editingFeatureId && f\.id === editingFeatureId/.test(fn),
    'a feature can be suggested its own value back when edited');
});

check('the three suggestion sources are ranked by specificity and look different', () => {
  // Nearest ("the ones right here are this") beats learned ("you usually type this") beats domain
  // ("features like this often are this"). The same ordering rule as sticky-beats-default.
  const bank = fs.readFileSync(path.join(ROOT, 'js/16c-plotbank.js'), 'utf8');
  const fn = bank.slice(bank.indexOf('function suggestionsFor'), bank.indexOf('function renderValueSuggestions'));
  assert(fn.indexOf('nearestValueFor') < fn.indexOf('learnedValuesFor'), 'learned values outrank nearby evidence');
  assert(fn.indexOf('learnedValuesFor') < fn.indexOf('domainValuesFor'), 'lexicon guesses outrank learned values');
  const css = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'))
    .map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
  ['nearest', 'learned', 'domain'].forEach(k =>
    assert(new RegExp('suggest-chip\\[data-from="' + k + '"\\]').test(css),
      `${k} suggestions look identical to the others — the crew cannot tell evidence from a guess`));
});

check('the site geocoder asks at suburb level, not city level', () => {
  // Reported from the field: standing in Hatfield, a Harare suburb, the site read "Chitungwiza" —
  // a separate town 20 km away. zoom=12 is a city/district query and Nominatim does not return
  // suburbs at that level at all; it returns the nearest thing it ranks as a settlement.
  const proj = fs.readFileSync(path.join(ROOT, 'js/05-projects.js'), 'utf8');
  const zoom = (proj.match(/nominatim[^`]*zoom=(\d+)/) || [])[1];
  assert(Number(zoom) >= 16, `the geocoder asks at zoom=${zoom}, which cannot return a suburb`);
});

check('a suburb name beats a neighbouring town', () => {
  // The old chain was town || village || city || … — `suburb` was not in it at all, so even at a
  // fine zoom the suburb would have been thrown away. And `town` came before `city`, which is
  // exactly how a neighbouring town wins over the city you are standing in.
  const proj = fs.readFileSync(path.join(ROOT, 'js/05-projects.js'), 'utf8');
  const block = proj.slice(proj.indexOf('const local = a &&'), proj.indexOf('const centreLat'));
  assert(/a\.suburb/.test(block), 'suburb is still not consulted');
  assert(block.indexOf('a.suburb') < block.indexOf('a.town'), 'a town name still outranks the suburb you are in');
  assert(block.indexOf('a.city') < block.indexOf('a.town'), 'town is still tried before city');
  // "Hatfield, Harare" — a bare suburb is ambiguous on a job sheet and a bare city is useless.
  assert(/\$\{local\}, \$\{wider\}/.test(block), 'the site name is not qualified with its city');
});

check('a place name far from the fix is refused', () => {
  // Nominatim returns the centre of whatever it matched, so a result far from where we are means
  // it reached outward for something larger. Caught rather than trusted — the coordinates are
  // never wrong, so they win, and the rejected name goes in the hint rather than being dropped
  // silently, because it is sometimes still what the crew wants to type.
  const proj = fs.readFileSync(path.join(ROOT, 'js/05-projects.js'), 'utf8');
  assert(/farAway/.test(proj), 'a distant place name is accepted without question');
  assert(/> 25000/.test(proj), 'no distance threshold on the returned place centre');
  assert(/is far from here/.test(proj), 'the rejected name is discarded without telling anyone');
});

// ══════════════════ DASHBOARD, SETTINGS GROUPING, NAV INDICATOR ══════════════════
// These run against the booted window rather than against the source text, because every one of
// them is about behaviour that reads correctly in the markup and was still wrong on the device.
// The nav one in particular: the class was always being set: it was the indicator that stayed put.

check('the Data tab moves the indicator, not just the class', () => {
  // The bug: switchTab() set the .active class AND positioned #navPill; renderDataHub() and
  // renderProjectManager() set only the class, because Data is the one tab in the bar that is not
  // a tab of #view-app and so never routes through switchTab(). Data lit up in the accent colour
  // while the sliding highlight stayed parked behind whichever tab was visited last.
  const geo = fs.readFileSync(path.join(ROOT, 'js/05-projects.js'), 'utf8');
  const collect = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  assert(/function setActiveNavTab/.test(collect), 'there is no single place that lights a tab');
  assert(/setActiveNavTab\(name\)/.test(collect), 'switchTab does not use the shared helper');
  const bare = geo.match(/classList\.toggle\('active', b\.id === 'navBtn-data'\)/g) || [];
  assert(!bare.length, `${bare.length} call site(s) still set the class without moving the pill`);
  assert((geo.match(/setActiveNavTab\('data'\)/g) || []).length === 2,
    'both Data-tab screens should light the tab through the helper');
});

check('every status shade row leads somewhere', () => {
  // The shade replaced a full-width map. A status line that reports a problem and then leaves the
  // user to find the screen that fixes it is only half an answer, so each row is a link.
  //
  // The floor is FOUR, not six. Three candidate rows were deliberately cut once it was clear each
  // repeated something the dashboard already shows: position source and fix type (the GPS Accuracy
  // KPI card expands to show all of it), unsaved capture (#dashInProgressBanner announces it more
  // loudly), and data quality (the readiness checklist owns it, and its rows can jump to the
  // offending features, which a status line cannot). A status surface earns its space only by
  // saying what nothing else says — so this asserts every row is a link, and does NOT reward
  // padding the list back out. See dashShadeRows() for the same reasoning at the source.
  w.eval(`
    projects.push({ id:'pShade', name:'Shade Test', crs:'wgs84', createdAt:new Date().toISOString() });
    projectData['pShade'] = { savedFeatures:[], currentVertices:[], featureTypes:[] };
    activeProjectId = 'pShade'; savedFeatures = []; currentVertices = [];
    renderDashShade();
  `);
  const rows = [...w.document.querySelectorAll('.dash-shade-row')];
  assert(rows.length >= 4, `only ${rows.length} status rows rendered`);
  rows.forEach(r => assert(r.getAttribute('onclick'), 'a status row is a dead end'));
  assert(w.document.getElementById('dashShadeLine').textContent.trim(), 'the collapsed summary is blank');
});

check('the shade commits a drag once, not twice', () => {
  // A drag ends in a pointerup, and a pointerup on a button is followed by a click — which would
  // land in toggleDashShade() and undo whatever the drag just decided. The flag is what keeps one
  // gesture to one state change.
  w.eval("setDashShadeOpen(true); document.getElementById('dashShade').dataset.dragged='1'; toggleDashShade();");
  assert(w.document.getElementById('dashShade').classList.contains('open'),
    'the trailing click reversed the drag');
  w.eval('toggleDashShade()');
  assert(!w.document.getElementById('dashShade').classList.contains('open'),
    'the flag was not consumed, so the next real tap did nothing');
});

check('the project thumbnail is a constant map glyph, captured or not', () => {
  // The thumbnail used to plot the survey's own vertices, which meant a degenerate one-point or
  // zero-span extent could render NaN coordinates. It is now a fixed folded-map icon regardless
  // of what has been captured, so there is no geometry math left to break — this just pins that
  // the icon renders identically whether the project is empty or has real vertices, and that the
  // aria-label is still the thing that carries the feature count.
  w.eval(`
    savedFeatures = [{ id:1, name:'Sign', featureTypeId:'ft', geometryType:'point',
      savedAt:new Date().toISOString(), vertices:[{lat:-25.75, lon:28.23, photos:[]}] }];
    renderDashThumb();
  `);
  const withFeature = w.document.getElementById('dashProjectThumb').innerHTML;
  assert(/<svg/.test(withFeature), 'the thumbnail did not render an icon');
  assert(!/NaN|Infinity/.test(withFeature), `rendering produced ${withFeature.slice(0, 120)}`);
  assert(/1 feature captured/.test(w.document.getElementById('dashProjectThumb').getAttribute('aria-label')),
    'the feature count did not reach the aria-label');

  w.eval('savedFeatures = []; renderDashThumb();');
  const empty = w.document.getElementById('dashProjectThumb').innerHTML;
  assert(/<svg/.test(empty), 'an empty project lost its icon');
  assert(empty === withFeature, 'the icon changed shape based on captured features');
  assert(/No features captured yet/.test(w.document.getElementById('dashProjectThumb').getAttribute('aria-label')),
    'the empty state lost its aria-label');
});

check('the map tile opens a legible preview instead of jumping straight to Review', () => {
  // The 46px tile was too small to read a shape in, so tapping it now opens
  // #dashMapPreviewModal — a bigger version of the same drawing — with an explicit "Open Review"
  // handoff for whoever wants the real map from there.
  w.eval(`
    savedFeatures = [{ id:3, name:'Boundary', featureTypeId:'ft', geometryType:'polygon',
      savedAt:new Date().toISOString(),
      vertices:[{lat:-25.750, lon:28.230, photos:[]}, {lat:-25.751, lon:28.235, photos:[]},
                {lat:-25.753, lon:28.232, photos:[]}] }];
    document.getElementById('dashMapPreviewModal').classList.remove('show');
    openDashMapPreview();
  `);
  assert(w.document.getElementById('dashMapPreviewModal').classList.contains('show'),
    'openDashMapPreview() did not open the modal');
  const preview = w.document.getElementById('dashMapPreviewFrame').innerHTML;
  assert(/<path[^>]*d="M/.test(preview), 'the preview did not draw the captured shape');
  assert(!/NaN|Infinity/.test(preview), `the preview projection produced ${preview.slice(0, 120)}`);
  assert(/1 feature captured/.test(w.document.getElementById('dashMapPreviewSub').textContent),
    'the preview subtitle did not report the feature count');

  // The tile itself must still be the constant map glyph from the check above — the preview is
  // additive, not a reversion of that change.
  assert(/dash-thumb-icon/.test(w.document.getElementById('dashProjectThumb').innerHTML),
    'the map tile stopped being the constant glyph once a preview modal existed');

  w.eval('closeDashMapPreview();');
  assert(!w.document.getElementById('dashMapPreviewModal').classList.contains('show'),
    'closeDashMapPreview() did not close the modal');

  // openDashMapPreviewReview() is the one path out that actually leaves the tab; it must close
  // the popup on the way, or reopening Dashboard later would show it again unprompted.
  w.eval(`
    window.__reviewCalls = 0;
    window.__realSwitchTabNav = switchTabNav;
    switchTabNav = function(name){ window.__reviewCalls++; };
    openDashMapPreview();
    openDashMapPreviewReview();
  `);
  assert(Number(w.eval('window.__reviewCalls')) === 1, 'Open Review did not hand off to switchTabNav');
  assert(!w.document.getElementById('dashMapPreviewModal').classList.contains('show'),
    'Open Review left the preview modal open behind Review');
  w.eval('switchTabNav = window.__realSwitchTabNav;');
});

check('the project thumbnail survives a degenerate extent in the preview', () => {
  // The projection math moved from the tile to the preview modal, not away — a one-point or
  // zero-span extent can still produce NaN if the projection is wrong, so this is the same
  // degenerate-extent check the old thumbnail test ran, aimed at the new home for that code.
  w.eval(`
    savedFeatures = [{ id:1, name:'Sign', featureTypeId:'ft', geometryType:'point',
      savedAt:new Date().toISOString(), vertices:[{lat:-25.75, lon:28.23, photos:[]}] }];
    renderDashMapPreview();
  `);
  const one = w.document.getElementById('dashMapPreviewFrame').innerHTML;
  assert(!/NaN|Infinity/.test(one), `a single vertex produced ${one.slice(0, 120)}`);
  assert(/<circle/.test(one), 'a lone point is not drawn');

  w.eval('savedFeatures = []; renderDashMapPreview();');
  assert(/svg/.test(w.document.getElementById('dashMapPreviewFrame').innerHTML),
    'an empty project lost its placeholder mark in the preview');
});

check('the dashboard no longer stands up a third map', () => {
  // Review owns the working map and PlotAtlas owns the full-screen one. The dashboard preview was
  // the same shared #reviewMap element being physically relocated between tabs on every switch,
  // with an invalidateSize() and a tile fetch behind it — on a screen nobody opens to look at a map.
  const collect = fs.readFileSync(path.join(ROOT, 'js/06-collect.js'), 'utf8');
  assert(!/function dockReviewMap/.test(collect), 'the map is still being moved between tabs');
  assert(!/id="dashMapSlot"/.test(html), 'the dashboard still has a map slot to dock into');
  assert(/id="dashProjectThumb"/.test(html), 'nothing replaced the map');
  const base = fs.readFileSync(path.join(ROOT, 'css/03-base.css'), 'utf8');
  assert(!/dash-preview/.test(base), 'the docked-preview styles outlived the feature');
});

check('Settings is an index of groups, and a group layers over it', () => {
  // Twelve preference rows in one sheet meant the last few were only ever reached by scrolling
  // past everything else. Groups layer ON TOP of the index rather than replacing it, so Done or
  // Back returns to the group list instead of dropping the user out of Settings entirely.
  w.eval("openSettings(); openSettingsGroup('appearance');");
  assert(w.document.getElementById('settingsGroup-appearance').classList.contains('show'),
    'the group sheet did not open');
  assert(w.document.getElementById('settingsModal').classList.contains('show'),
    'the index closed underneath the group — Back would leave Settings entirely');
  w.eval("closeSettingsGroup('appearance')");
  assert(!w.document.getElementById('settingsGroup-appearance').classList.contains('show'),
    'the group did not close');

  // A group is a sibling overlay, not a child, so closing Settings does not take it along for free.
  w.eval("openSettingsGroup('maps'); closeSettings();");
  assert(!w.document.getElementById('settingsGroup-maps').classList.contains('show'),
    'a group sheet was left floating over the screen Settings was opened from');

  // Reopening must land on the index. Restoring the last group visited would be a hidden mode.
  w.eval("openSettingsGroup('capture'); closeSettings(); openSettings();");
  assert(!w.document.querySelector('.settings-subsheet.show'),
    'Settings reopened into a group instead of the index');
  w.eval('closeSettings()');
});

check('regrouping Settings did not lose a single control', () => {
  // The rows moved between sheets; every id and handler stayed put, so syncSettingsModalUI()
  // paints the groups exactly as it painted the flat list. This is the assertion that would have
  // caught a row dropped during the move.
  ['settingsThemeAuto', 'settingsThemeLight', 'settingsThemeDark', 'domainGrid',
   'settingsDensityComfortable', 'settingsDensityCompact', 'widgetDynamicToggle',
   'settingsUnitsMetric', 'settingsUnitsImperial', 'settingsBasemapGrid', 'settingsSnapToggle',
   'settingsExportFormat', 'settingsPlotLensToggle'].forEach(id => {
    assert(w.document.getElementById(id), `#${id} did not survive the regrouping`);
  });
  w.eval('syncSettingsModalUI()');   // throws if a group's controls moved out from under it
  // The two adjacent rows both labelled "Theme" — one the light/dark mode, one the palette — were
  // indistinguishable from each other in the flat list.
  assert(!/>Theme<\/div>\s*<div class="settings-row-sub">Auto follows/.test(html),
    'the light/dark row is still called "Theme", same as the palette row below it');
});

check('the More drawer is searchable by what an action does, not only its name', () => {
  // Searching labels alone only helps people who already know the labels — which is the group
  // least in need of a search box. The drawer is where the UNFAMILIAR actions live.
  const geo = fs.readFileSync(path.join(ROOT, 'js/16-geometry-math.js'), 'utf8');
  const described = (geo.match(/\bdesc:['"]/g) || []).length;
  const actions = (geo.match(/\{ id:'/g) || []).length;
  assert(described === actions, `${actions - described} action(s) have no description`);

  w.eval("qaNoteUsed('notes'); openMoreActions();");
  const drawer = () => w.document.getElementById('qaDrawerGrid').innerHTML;
  assert(/Recently used/.test(drawer()), 'the drawer does not surface recently used actions');
  assert(/qa-desc/.test(drawer()), 'descriptions are not rendered in the drawer');

  w.eval("onQaSearchInput('bluetooth')");
  assert(/Connect GPS/.test(drawer()), 'searching a description does not find the action');
  w.eval("onQaSearchInput('')");
  w.eval('closeMoreActions()');
});

check('every card on the dashboard leads somewhere', () => {
  // A card that reports a number and then does nothing when tapped teaches the user that tapping
  // cards does nothing, which costs the cards that DO lead somewhere.
  // dashBackupCard is not in this list because it no longer exists: storage and export status
  // moved into the status shade, which is open on arrival rather than buried inside a section
  // that is collapsed by default. Two renderings of the same two facts is the redundancy the
  // shade was meant to remove, not add.
  ['dashHealthCard', 'dashPaceCard'].forEach(id => {
    const block = html.slice(html.indexOf(`id="${id}"`) - 300, html.indexOf(`id="${id}"`) + 200);
    assert(/onclick=/.test(block), `#${id} is a dead end`);
    assert(/onkeydown=/.test(block), `#${id} cannot be reached from a keyboard`);
  });
});

check('nothing threw while any of that ran', () => {
  assert(!errors.length, errors.slice(0, 3).join(' | '));
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  survey: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
