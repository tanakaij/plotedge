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
  ['plotWordsScreen', 'plotAtlas', 'plPlayer', 'photoLightbox'].forEach(id => {
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
  const words = chain.indexOf('plotWordsScreen');
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
  // Colour alone fails in direct sunlight, which is the app's normal working condition, and fails
  // outright for a colour-blind user. The active tab needs a surface treatment the eye reads as a
  // different material.
  const css = fs.readFileSync(path.join(ROOT, 'css/05-components.css'), 'utf8');
  assert(/\.nav-btn\.active::after/.test(css), 'the active tab has no background texture, only a tint');
  assert(/\.nav-btn\.active::before/.test(css), 'the active tab has no accent bar');
  assert(/\.nav-btn\.active svg/.test(css), 'the active tab icon is not differentiated');
  // The wash must sit behind the glyph, or it tints the icon instead of the cell.
  assert(/\.nav-btn svg, \.nav-btn span \{ position:relative; z-index:1/.test(css),
    'the icon and label are not lifted above the active wash — the tint would wash over them');
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
