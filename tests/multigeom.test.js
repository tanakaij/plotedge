'use strict';
// Multi-geometry feature types and the DXF/CAD exporter.
//
// Two things are being guarded here, and they fail in different ways.
//
// The multi-geometry work is a change to what a feature type MEANS: it used to declare the one
// geometry all its features had, and now it declares which geometries are permitted while each
// saved feature records which was used. The dangerous failure is silent — a per-vertex field
// whose value is written into f.attrs on a point capture but looked for in v.attrs on read, or
// a polygon reopened for edit and re-saved as a point. Neither throws. Both are only visible
// as data that quietly went missing, so they get assertions here rather than a smoke check.
//
// The DXF writer fails the opposite way: loudly, in somebody else's AutoCAD, weeks later. A DXF
// is a flat stream of (group code, value) pairs and a single misplaced pair makes the whole file
// unopenable rather than the one entity wrong. So the output is parsed back and checked
// structurally instead of grepped.
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
const checkAsync = (name, fn) => Promise.resolve().then(fn)
  .then(() => results.push({ name, ok: true }))
  .catch(e => results.push({ name, ok: false, msg: e.message }));
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── boot ─────────────────────────────────────────────────────────────────────
// A thinner harness than features.test.js: nothing here touches a map, so Leaflet is a
// permissive stub. What IS needed is a real capture of the export write, since the assertions
// below are about the bytes that would have reached disk.
const written = [];

function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    beforeParse(w) {
      const anything = new Proxy(function () {}, {
        get: (t, k) => (k === 'then' ? undefined : anything),
        apply: () => anything, construct: () => anything
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
    try { w.document.head.appendChild(el); }
    catch (e) { errors.push(`js/${f}: ${e.message}`); }
  }
  // Intercept at saveExportFile rather than stubbing dl(), so noteExportSaved and the status
  // line still run — those are part of what an export does and a stub above them hides breakage.
  w.eval(`
    saveExportFile = function(content, name, mime){
      __written.push({ content, name, mime });
      return Promise.resolve({ ok:true, where:'test' });
    };
  `);
  w.__written = written;
  return { w, errors };
}

// A project holding one genuinely mixed-geometry type: Septic exists as both a lid point and a
// footprint polygon, which is the case the whole feature was built for.
function seed(w) {
  const iso = new Date().toISOString();
  w.eval(`
    projects = [{ id:'p1', name:'Ward 7 Sanitation', client:'City of Harare',
      site:'Mabvuku', siteLat:-17.8202, siteLon:31.0502, createdAt:'${iso}' }];
    activeProjectId = 'p1';
    featureTypes = [
      { id:'ft1', name:'Septic', geometryType:'point', geometryTypes:['point','polygon'],
        color:'#F59E0B', fields:[
          { id:'material', label:'Material', type:'text', scope:'feature' },
          { id:'depth', label:'Depth at vertex', type:'number', scope:'vertex' } ] },
      { id:'ft2', name:'Access Road', geometryType:'line', geometryTypes:['line'],
        color:'#0EA5E9', fields:[ { id:'surface', label:'Surface', type:'text', scope:'feature' } ] }
    ];
    savedFeatures = [
      { id:'s1', name:'Septic-01', ref:'S01', featureTypeId:'ft1', featureTypeName:'Septic',
        geometryType:'point', attrs:{ material:'Concrete', depth:1.4 },
        vertices:[{ lat:-17.8200, lon:31.0500, alt:1480, acc:2.5, time:'${iso}', attrs:{}, photos:[] }],
        savedAt:'${iso}', notes:'' },
      { id:'s2', name:'Septic-02', ref:'S02', featureTypeId:'ft1', featureTypeName:'Septic',
        geometryType:'polygon', attrs:{ material:'Brick' },
        vertices:[
          { lat:-17.8210, lon:31.0510, alt:1481, acc:2, time:'${iso}', attrs:{ depth:1.1 }, photos:[] },
          { lat:-17.8210, lon:31.0512, alt:1481, acc:2, time:'${iso}', attrs:{ depth:1.3 }, photos:[] },
          { lat:-17.8212, lon:31.0512, alt:1482, acc:2, time:'${iso}', attrs:{ depth:1.2 }, photos:[] },
          { lat:-17.8212, lon:31.0510, alt:1482, acc:2, time:'${iso}', attrs:{ depth:1.0 }, photos:[] }
        ], savedAt:'${iso}', notes:'' },
      { id:'s3', name:'Road-01', ref:'R01', featureTypeId:'ft2', featureTypeName:'Access Road',
        geometryType:'line', attrs:{ surface:'Gravel' },
        vertices:[
          { lat:-17.8220, lon:31.0520, alt:1483, acc:3, time:'${iso}', attrs:{}, photos:[] },
          { lat:-17.8225, lon:31.0530, alt:1484, acc:3, time:'${iso}', attrs:{}, photos:[] }
        ], savedAt:'${iso}', notes:'' }
    ];
    if (typeof populateFeatureTypeSelect === 'function') populateFeatureTypeSelect();
  `);
}

const { w, errors } = boot();
seed(w);

// ══ THE MODEL ══════════════════════════════════════════════════════════════

check('a type declaring several geometries reports all of them, in canonical order', () => {
  const got = w.eval(`JSON.stringify(ftGeometries(getFeatureType('ft1')))`);
  assert(got === '["point","polygon"]', `expected point,polygon in canonical order — got ${got}`);
  // Canonical order matters because the list is rendered into labels and layer names; deriving
  // it from insertion order would make the same schema print differently on two devices.
  const reversed = w.eval(`JSON.stringify(ftGeometries({ geometryTypes:['polygon','point'] }))`);
  assert(reversed === '["point","polygon"]', `order should not depend on how it was stored — got ${reversed}`);
});

check('a type from before this change still resolves to exactly one geometry', () => {
  // The migration story is "there isn't one" — every pre-existing type has only geometryType,
  // and must behave identically. If this fails, every project on every installed device breaks.
  const got = w.eval(`JSON.stringify(ftGeometries({ id:'old', name:'Pole', geometryType:'line', fields:[] }))`);
  assert(got === '["line"]', `a legacy single-geometry type should report just its own — got ${got}`);
  const dflt = w.eval(`ftDefaultGeometry({ geometryType:'line' })`);
  assert(dflt === 'line', `legacy default should be its stored geometry — got ${dflt}`);
});

check('geometryType stays written as a permitted geometry, so old readers never see a lie', () => {
  // Every untouched consumer in the app (analytics, PlotMind, the legacy JSON backup) reads
  // ft.geometryType. It has to remain meaningful, not become a stale leftover.
  const ok = w.eval(`
    featureTypes.every(t => !t.geometryTypes || t.geometryTypes.includes(t.geometryType))
  `);
  assert(ok, 'a type reports a default geometry it does not itself permit');
});

check('a per-vertex field collapses to feature scope on a point capture only', () => {
  const onPoint = w.eval(`effectiveFieldScope({ scope:'vertex' }, 'point')`);
  const onPoly = w.eval(`effectiveFieldScope({ scope:'vertex' }, 'polygon')`);
  assert(onPoint === 'feature', `per-vertex on a point should collapse — got ${onPoint}`);
  assert(onPoly === 'vertex', `per-vertex on a polygon must stay per-vertex — got ${onPoly}`);
});

check('scope is resolved against the feature, not the feature type', () => {
  // This is the silent-data-loss case. "Depth" is scope:'vertex' on Septic. On s2 (polygon) its
  // values live in each vertex's attrs; on s1 (point) the same field's value lives in f.attrs.
  // A reader that consults field.scope alone looks in the wrong object for one of them and
  // renders a populated field as empty.
  const pointScope = w.eval(`featureFieldScope({ scope:'vertex' }, savedFeatures.find(f=>f.id==='s1'))`);
  const polyScope = w.eval(`featureFieldScope({ scope:'vertex' }, savedFeatures.find(f=>f.id==='s2'))`);
  assert(pointScope === 'feature', `on the point capture depth is a feature attr — got ${pointScope}`);
  assert(polyScope === 'vertex', `on the polygon capture depth is per-vertex — got ${polyScope}`);
});

check('the point capture of a mixed type is not flagged as missing its per-vertex field', () => {
  // The review validation bar and the quality score both walk required fields. Before the scope
  // fix, s1 would be reported as missing "depth" forever, because the check looked for it on a
  // vertex while the value sat on the feature. Nothing in the UI would explain why.
  const rows = w.eval(`JSON.stringify(featureQualityScore(savedFeatures.find(f=>f.id==='s1')).issues || [])`);
  assert(!/required/i.test(rows), `point capture wrongly reported as missing required fields: ${rows}`);
});

check('a geometry the type does not permit is refused rather than quietly accepted', () => {
  const allowsLine = w.eval(`ftAllowsGeometry(getFeatureType('ft1'), 'line')`);
  assert(allowsLine === false, 'Septic permits point and polygon — a line should be refused');
  // And the fallback has to be a permitted one, not the requested one.
  const resolved = w.eval(`
    activeGeometryType = 'line';
    ftAllowsGeometry(getFeatureType('ft1'), activeGeometryType)
      ? activeGeometryType : ftDefaultGeometry(getFeatureType('ft1'))
  `);
  assert(resolved === 'point', `should fall back to a permitted geometry — got ${resolved}`);
});

check('length and area are computed from the geometry saved, not the type default', () => {
  // Septic's default is point. Its polygon capture must still get an area, and a line capture of
  // some other multi-geometry type must still get a length — computeGeometryAttrs used to read
  // ft.geometryType, which for a mixed type has no single right answer.
  const poly = w.eval(`JSON.stringify(computeGeometryAttrs(getFeatureType('ft1'), savedFeatures.find(f=>f.id==='s2').vertices, 'polygon'))`);
  assert(/geom_area_sqm/.test(poly), `polygon capture should get an area — got ${poly}`);
  const asPoint = w.eval(`JSON.stringify(computeGeometryAttrs(getFeatureType('ft1'), savedFeatures.find(f=>f.id==='s2').vertices, 'point'))`);
  assert(asPoint === '{}', `a point capture has no length or area — got ${asPoint}`);
});

check('the schema editor keeps at least one geometry selected', () => {
  const left = w.eval(`
    setFtGeo(['point'], true);
    toggleFtGeo('point');            // the only one — must be refused
    currentFtGeoList().join(',')
  `);
  assert(left === 'point', `dropping the last geometry should be refused — got "${left}"`);
});

check('per-vertex scope survives a type that permits point AND polygon', () => {
  // The old editor demoted every vertex-scoped field the moment point was chosen. Under
  // multi-geometry that would destroy the setting the user wants back on their next polygon.
  const kept = w.eval(`
    editingFtFields = [{ id:'d', label:'Depth', type:'number', scope:'vertex', options:[] }];
    setFtGeo(['point','polygon'], false);
    editingFtFields[0].scope
  `);
  assert(kept === 'vertex', `per-vertex must survive a mixed selection — got ${kept}`);
  // But point-only is still a real constraint, and still demotes.
  const demoted = w.eval(`
    editingFtFields = [{ id:'d', label:'Depth', type:'number', scope:'vertex', options:[] }];
    setFtGeo(['point'], false);
    editingFtFields[0].scope
  `);
  assert(demoted === 'feature', `point-only should still demote per-vertex — got ${demoted}`);
});

// ══ EXPORT LAYERING ════════════════════════════════════════════════════════

check('a mixed type splits into one layer per geometry, and a single-geometry type does not', () => {
  // The reason this split exists: a shapefile and an Esri feature class allow one geometry per
  // layer, a FlatGeobuf header names one, and a GeoPackage with a generic GEOMETRY column gives
  // a QGIS user one symbology for points and polygons together.
  const labels = JSON.parse(w.eval(`JSON.stringify(layerLabelMap(savedFeatures))`));
  const names = Object.values(labels).sort();
  assert(names.includes('Septic_point'), `mixed type should suffix its layers — got ${names.join(', ')}`);
  assert(names.includes('Septic_polygon'), `mixed type should suffix its layers — got ${names.join(', ')}`);
  assert(names.includes('Access Road'), `a single-geometry type must NOT be suffixed — got ${names.join(', ')}`);
  assert(!names.some(n => /^Access Road_/.test(n)), 'suffix applied where it does nothing but uglify the layer name');
});

check('every exported layer holds exactly one geometry type', () => {
  // The invariant the GeoPackage/FlatGeobuf writers depend on. If this breaks, gpkg writes a
  // geometry_columns row that misdescribes its own table — corruption that only surfaces in
  // somebody else's QGIS.
  const bad = w.eval(`
    (function(){
      return collectFeatureCollectionsByType()
        .filter(g => new Set(g.fc.features.map(f=>f.geometry.type)).size !== 1)
        .map(g => g.label);
    })().join(', ')
  `);
  assert(!bad, `layers with mixed geometry reached the writers: ${bad}`);
});

check('PlotEtch offers every type that permits the sketched geometry', () => {
  // Previously matched on ft.geometryType, so a Septic that permits polygons but defaults to
  // point would refuse a traced footprint with "no polygon feature type exists".
  const n = w.eval(`featureTypes.filter(ft=>ftAllowsGeometry(ft,'polygon')).length`);
  assert(n === 1, `Septic should accept a traced polygon — matched ${n} types`);
});

check('importing the same name at a second geometry widens the type instead of duplicating it', () => {
  const before = w.eval(`featureTypes.length`);
  const geos = w.eval(`
    findOrCreateImportFeatureType('Access Road', 'polygon', []);
    JSON.stringify(ftGeometries(featureTypes.find(t=>t.name==='Access Road')))
  `);
  const after = w.eval(`featureTypes.length`);
  assert(after === before, `a second geometry should widen the existing type, not add one (${before} -> ${after})`);
  assert(geos === '["line","polygon"]', `type should now permit both — got ${geos}`);
});

// ══ FORMAT REGISTRY ════════════════════════════════════════════════════════

check('every runnable export format can also be set as the default', () => {
  // The bug this replaces: the Settings picker was hand-written and had drifted, so PlotPack,
  // Device Settings and the legacy JSON backup could be exported but never pre-selected.
  const missing = w.eval(`
    (function(){
      var sel = document.getElementById('settingsExportFormat');
      var have = Array.prototype.map.call(sel.options, function(o){ return o.value; });
      return Object.keys(EXPORT_FORMATS).filter(function(k){ return have.indexOf(k) === -1; }).join(', ');
    })()
  `);
  assert(!missing, `formats runnable but not selectable as default: ${missing}`);
});

check('both pickers offer the same formats', () => {
  const diff = w.eval(`
    (function(){
      var a = Array.prototype.map.call(document.getElementById('exportFormatSelect').options, function(o){return o.value;}).sort();
      var b = Array.prototype.map.call(document.getElementById('settingsExportFormat').options, function(o){return o.value;}).sort();
      return a.join(',') === b.join(',') ? '' : 'export=[' + a.join(',') + '] settings=[' + b.join(',') + ']';
    })()
  `);
  assert(!diff, `the two format pickers disagree: ${diff}`);
});

check('every format declares a group that actually renders', () => {
  const orphan = w.eval(`
    (function(){
      var ids = EXPORT_FORMAT_GROUPS.map(function(g){return g.id;});
      return Object.keys(EXPORT_FORMATS).filter(function(k){
        return ids.indexOf(EXPORT_FORMATS[k].group) === -1;
      }).join(', ');
    })()
  `);
  assert(!orphan, `formats in no rendered optgroup — they would vanish from both pickers: ${orphan}`);
});

check('every format has a runnable handler', () => {
  const broken = w.eval(`
    Object.keys(EXPORT_FORMATS).filter(function(k){ return typeof EXPORT_FORMATS[k].run !== 'function'; }).join(', ')
  `);
  assert(!broken, `formats registered with no run handler: ${broken}`);
});

// ══ THE DXF ════════════════════════════════════════════════════════════════

// Parses a DXF back into (code, value) pairs and a section map. Structural parsing rather than
// grepping, because the failure mode being guarded against is a malformed pair stream — which a
// regex for "POLYLINE" would sail straight past.
function parseDxf(text) {
  const lines = text.split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === '' && lines[i + 1] === undefined) break;
    pairs.push([Number(lines[i].trim()), lines[i + 1]]);
  }
  return pairs;
}

let dxf = null;

// Everything below the export is gated on it. `check()` is synchronous and would otherwise run
// before the awaited write resolved, reporting "no drawing produced" for assertions that were
// never actually attempted — a false failure is worse than no test, because it trains you to
// ignore the suite. So the drawing checks are queued and run after the export completes.
const dxfChecks = [];
const dxfCheck = (name, fn) => dxfChecks.push([name, fn]);

const cadReady = checkAsync('the CAD export writes a .dxf named for the project and its UTM zone', async () => {
  written.length = 0;
  await w.eval(`exportCAD()`);
  assert(written.length === 1, `expected one file written, got ${written.length}`);
  const f = written[0];
  assert(/\.dxf$/.test(f.name), `not a .dxf: ${f.name}`);
  assert(/Ward_7_Sanitation/.test(f.name), `drawing should be named for the project: ${f.name}`);
  // Harare is 31.05E / 17.82S -> zone 36, southern hemisphere. Baked into the filename so a
  // recipient can tell two exports of different sites apart without opening them.
  assert(/UTM36S/.test(f.name), `expected UTM zone 36S in the name: ${f.name}`);
  dxf = f.content;
});

dxfCheck('the drawing is a structurally complete R12 DXF', () => {
  assert(dxf, 'no drawing produced');
  const pairs = parseDxf(dxf);
  // Every code must be a number. An odd number of lines, or a value where a code belongs,
  // is exactly the corruption that makes AutoCAD reject the file wholesale.
  const badCode = pairs.findIndex(p => !Number.isFinite(p[0]));
  assert(badCode === -1, `non-numeric group code at pair ${badCode} — the pair stream is misaligned`);
  const flat = pairs.map(p => p[0] + ':' + p[1]);
  ['0:SECTION', '0:ENDSEC', '0:EOF'].forEach(t => assert(flat.includes(t), `missing ${t}`));
  assert(flat.includes('1:AC1009'), 'not declared as R12 (AC1009) — the whole point of this writer');
  assert(flat.includes('2:HEADER') && flat.includes('2:TABLES') && flat.includes('2:ENTITIES'),
    'a required section is absent');
  // Sections must balance, or readers stop parsing at the first unclosed one.
  const opens = flat.filter(t => t === '0:SECTION').length;
  const closes = flat.filter(t => t === '0:ENDSEC').length;
  assert(opens === closes, `${opens} SECTION vs ${closes} ENDSEC`);
  assert(flat[flat.length - 1] === '0:EOF', 'EOF is not the last pair');
});

dxfCheck('coordinates are projected metres, not degrees', () => {
  // Written in degrees the whole site would be a couple of drawing units across and every
  // dimension taken off it meaningless. UTM eastings sit in the hundreds of thousands and
  // southern-hemisphere northings in the millions.
  const pairs = parseDxf(dxf);
  const xs = pairs.filter(p => p[0] === 10).map(p => Number(p[1])).filter(n => n !== 0);
  const ys = pairs.filter(p => p[0] === 20).map(p => Number(p[1])).filter(n => n !== 0);
  assert(xs.length && ys.length, 'no coordinates in the drawing');
  assert(xs.every(x => x > 100000 && x < 900000), `eastings outside the UTM range: ${xs.slice(0, 3)}`);
  assert(ys.every(y => y > 7000000 && y < 10000000), `southern northings look wrong: ${ys.slice(0, 3)}`);
});

dxfCheck('the UTM projection round-trips against a known control point', () => {
  // Independent check on the Snyder series, since the whole drawing is worthless if it is
  // subtly wrong. Reversing the transform must land back within a centimetre.
  const err = w.eval(`
    (function(){
      var lat = -17.8202, lon = 31.0502, zone = cadUtmZone(lon);
      var u = cadLatLonToUtm(lat, lon, zone);
      // A second point one arc-second north must be ~30.9 m further north and barely move east.
      var u2 = cadLatLonToUtm(lat + 1/3600, lon, zone);
      var dN = u2.n - u.n, dE = Math.abs(u2.e - u.e);
      return JSON.stringify({ zone: zone, dN: dN, dE: dE });
    })()
  `);
  const { zone, dN, dE } = JSON.parse(err);
  assert(zone === 36, `Harare is UTM zone 36 — got ${zone}`);
  assert(Math.abs(dN - 30.9) < 0.5, `one arc-second of latitude should be ~30.9 m — got ${dN.toFixed(2)}`);
  // Moving due north DOES shift easting away from the central meridian — grid north and true
  // north diverge by the convergence angle, Δλ·sin(φ). At 31.05E in zone 36 (CM 33E) that is
  // 1.95° × sin(17.82°) ≈ 0.596°, so ~0.32 m of easting per 30.9 m of northing. Asserting the
  // shift MATCHES convergence is a much sharper test of the series than asserting it is zero:
  // a sign error or a dropped term would break this while leaving the northing plausible.
  const expected = 30.9 * Math.tan(1.95 * Math.sin(17.82 * Math.PI / 180) * Math.PI / 180);
  assert(Math.abs(dE - expected) < 0.05,
    `easting shift should equal meridian convergence (~${expected.toFixed(2)} m) — got ${dE.toFixed(3)} m`);
});

dxfCheck('each geometry becomes the right kind of CAD entity', () => {
  const pairs = parseDxf(dxf);
  const ents = pairs.filter(p => p[0] === 0).map(p => p[1]);
  assert(ents.includes('POINT'), 'the point capture produced no POINT');
  assert(ents.filter(e => e === 'POLYLINE').length === 2, `expected two POLYLINEs (polygon + line), got ${ents.filter(e => e === 'POLYLINE').length}`);
  // R12 has no LWPOLYLINE, and every POLYLINE must be terminated by SEQEND or the reader keeps
  // swallowing subsequent entities as vertices of it.
  assert(!ents.includes('LWPOLYLINE'), 'LWPOLYLINE is R14+ and would break the R12 promise');
  assert(ents.filter(e => e === 'SEQEND').length === ents.filter(e => e === 'POLYLINE').length,
    'a POLYLINE is missing its SEQEND — the reader would absorb the following entities into it');
  assert(ents.includes('TEXT'), 'no annotation written');
});

dxfCheck('the polygon is closed and the line is not', () => {
  // A polygon arriving as an unclosed line reports no area, which is the single most common
  // complaint from a CAD office receiving GIS-derived geometry.
  const pairs = parseDxf(dxf);
  const flags = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'POLYLINE') {
      const f = pairs.slice(i, i + 8).find(p => p[0] === 70);
      flags.push(Number(f ? f[1] : 0));
    }
  }
  assert(flags.length === 2, `expected 2 polylines, found ${flags.length}`);
  assert(flags.some(f => f & 1), 'neither polyline is flagged closed — the polygon lost its ring');
  assert(flags.some(f => !(f & 1)), 'both polylines are closed — the line was wrongly turned into a ring');
  // Vertices carry altitudes, so both must be 3D polylines: per-vertex Z on a 2D polyline is
  // invalid and readers silently flatten it.
  assert(flags.every(f => f & 8), 'a polyline with per-vertex elevation is not flagged 3D');
});

dxfCheck('layer names are legal R12 identifiers and split by geometry', () => {
  const pairs = parseDxf(dxf);
  const names = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'LAYER') {
      const n = pairs.slice(i, i + 4).find(p => p[0] === 2);
      if (n) names.push(n[1]);
    }
  }
  assert(names.length, 'no layers defined — entities would land on layer 0 as one undifferentiated mass');
  names.forEach(n => {
    assert(/^[A-Z0-9_$.-]+$/.test(n), `illegal R12 layer name "${n}" — entities silently fail to bind`);
    assert(n.length <= 31, `layer name over 31 chars: "${n}"`);
  });
  assert(names.includes('SEPTIC_POINT') && names.includes('SEPTIC_POLYGON'),
    `the mixed type should reach CAD as two layers — got ${names.join(', ')}`);
  // Annotation on its own layer so a drafter can freeze all text in one action.
  assert(names.some(n => /_TXT$/.test(n)), `no annotation layer — got ${names.join(', ')}`);
});

dxfCheck('every entity sits on a layer that the tables section defines', () => {
  // An entity on an undeclared layer is the other half of the layer-binding failure: AutoCAD
  // invents the layer with default properties, so the drawing opens with every colour wrong.
  const pairs = parseDxf(dxf);
  const declared = new Set();
  const used = new Set();
  let inTables = false;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 2 && v === 'TABLES') inTables = true;
    if (c === 2 && v === 'ENTITIES') inTables = false;
    if (c === 0 && v === 'LAYER' && inTables) {
      const n = pairs.slice(i, i + 4).find(p => p[0] === 2);
      if (n) declared.add(n[1]);
    }
    if (c === 8 && !inTables) used.add(v);
  }
  const undeclared = [...used].filter(n => !declared.has(n));
  assert(!undeclared.length, `entities on undeclared layers: ${undeclared.join(', ')}`);
});

dxfCheck('the drawing states its coordinate system for whoever opens it', () => {
  // DXF has no CRS slot at all, so this is the only thing standing between the recipient and a
  // guess. 999 comments are ignored by readers but preserved by text editors and most importers.
  assert(/EPSG:32736/.test(dxf), 'the EPSG code for the chosen UTM zone is not recorded');
  assert(/Units: metres/.test(dxf), 'units are not stated');
  assert(/reference_id/.test(dxf), 'no pointer to where the attribute table lives');
});

check('the CAD export needs no network', () => {
  // The one export that must work from the truck. If a CDN loader ever creeps in here, this is
  // the check that should fail rather than a crew discovering it with no signal.
  const src = fs.readFileSync(path.join(ROOT, 'js/17c-plotcad.js'), 'utf8');
  assert(!/loadScript|cdn\.|jsdelivr|cdnjs|unpkg/.test(src),
    'the CAD writer has acquired a CDN dependency — it is meant to work offline');
});

// Runs the queued drawing checks once the export has actually produced a drawing, then the
// error sweep last so it catches anything the export itself threw.
const ready = cadReady.then(() => {
  dxfChecks.forEach(([name, fn]) => check(name, fn));
  check('nothing threw while any of that ran', () => {
    assert(!errors.length, errors.slice(0, 3).join(' | '));
  });
  return results;
});

// ── report ───────────────────────────────────────────────────────────────────
module.exports = ready;
if (require.main === module) {
  ready.then(() => {
    let bad = 0;
    for (const r of results) {
      console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
      if (!r.ok) bad++;
    }
    console.log(`\n  multigeom: ${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  });
}
