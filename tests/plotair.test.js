'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PLOTAIR — flight planning arithmetic and geometry
// ═══════════════════════════════════════════════════════════════════════════
// A wrong number here is not a visible failure. A GSD out by a factor, a line spacing that leaves
// a gap, a photo count that under-reads: none of it throws, and none of it is noticeable until
// somebody has flown the site, gone home, and found the images will not reconstruct. So this
// checks the maths against figures that can be derived by hand rather than against the code's own
// output.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);
const results = [];
const bootErrors = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg}: expected ~${b}, got ${a}`);
}

function installStubs(w) {
  const chain = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : chain()), apply: () => chain(), construct: () => chain()
  });
  w.L = chain(); w.JSZip = chain();
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
  w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
    setTransform() {}, measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    createLinearGradient: () => ({ addColorStop() {} }), putImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }), set fillStyle(v) {}, set font(v) {}
  });
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AA';
  w.onerror = m => { bootErrors.push(String(m)); return true; };
}

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/', beforeParse: installStubs });
const w = dom.window, d = w.document;
for (const f of jsOrder) {
  const el = d.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  d.head.appendChild(el);
}
try { d.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true })); } catch (e) {}
const run = c => w.eval(c);

// A 400 m x 400 m square at the equator, where a degree of longitude is at its longest and the
// equirectangular approximation is exactly right in both axes — so any error the projection
// introduces shows up as a discrepancy rather than hiding in a cosine.
const SQ = (() => {
  const dLat = 400 / 111320;
  return [
    { lat: 0, lon: 0 }, { lat: 0, lon: dLat }, { lat: dLat, lon: dLat }, { lat: dLat, lon: 0 }
  ];
})();

check('ground sample distance matches the hand calculation', () => {
  // Phantom 4 Pro: 13.2 mm sensor, 8.8 mm lens, 5472 px wide, at 100 m.
  //   (13.2 x 100) / (8.8 x 5472) = 2.7397e-4 m/px = 2.74 cm/px
  const gsd = run(`plotairGsdCm(plotairCamera('p4p'), 100)`);
  near(gsd, 2.74, 0.01, 'GSD for a P4P at 100 m');
  // Linear in altitude: half the height is half the ground per pixel. If this fails the formula has
  // an altitude term in the wrong place, which no visual check would catch.
  near(run(`plotairGsdCm(plotairCamera('p4p'), 50)`), 1.37, 0.01, 'GSD at half the height');
});

check('altitude and GSD are true inverses of each other', () => {
  // The solver hands someone a height from the detail they asked for. If the round trip drifts,
  // the sheet quietly delivers imagery at a different resolution than the one requested.
  const alt = run(`plotairAltitudeForGsd(plotairCamera('mavic3'), 1.5)`);
  const back = run(`plotairGsdCm(plotairCamera('mavic3'), ${alt})`);
  near(back, 1.5, 0.001, 'GSD recovered from its own solved altitude');
});

check('line spacing follows from the frame width and the side overlap', () => {
  // Footprint width = sensor x altitude / focal = 13.2 x 100 / 8.8 = 150 m.
  // At 70% side overlap the lines sit 30% of that apart: 45 m.
  const plan = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  assert(!plan.error, plan.error);
  near(plan.footprint.w, 150, 0.5, 'frame width on the ground');
  near(plan.spacing, 45, 0.5, 'line spacing at 70% side overlap');
  // Shutter interval uses the ALONG-track dimension, not the across-track one. Using the wrong
  // axis is the classic error here and produces images that overlap sideways but not forwards.
  near(plan.trigger, 20, 0.5, 'shutter interval at 80% front overlap');
});

check('the plan covers the area it was given', () => {
  const plan = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  near(plan.areaHa, 16, 0.1, 'area of a 400 m square in hectares');
  // 400 m of width at 45 m spacing, first line half a spacing in: 9 lines.
  assert(plan.lineCount === 9, `expected 9 flight lines, got ${plan.lineCount}`);
  // Two waypoints per line — a start and an end.
  assert(plan.waypoints.length === plan.lineCount * 2,
    `waypoints do not pair up with lines: ${plan.waypoints.length} for ${plan.lineCount}`);
  // Every waypoint must be inside or on the boundary. A projection sign error puts the whole
  // pattern in the wrong hemisphere and nothing else in the plan would notice.
  const lats = plan.waypoints.map(p => p.lat), lons = plan.waypoints.map(p => p.lon);
  const dLat = 400 / 111320;
  assert(Math.min(...lats) >= -1e-6 && Math.max(...lats) <= dLat + 1e-6, 'a waypoint fell outside the boundary in latitude');
  assert(Math.min(...lons) >= -1e-6 && Math.max(...lons) <= dLat + 1e-6, 'a waypoint fell outside the boundary in longitude');
});

check('the path runs as a lawnmower, not as a return to the start of every line', () => {
  const plan = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  // Alternating direction means consecutive lines start at opposite ends. If every line ran the
  // same way the aircraft would deadhead back across the whole block between each one — the
  // distance and time figures would still be produced, just badly wrong.
  const l0 = plan.lines[0], l1 = plan.lines[1];
  const dir0 = Math.sign(l0[1].x - l0[0].x), dir1 = Math.sign(l1[1].x - l1[0].x);
  assert(dir0 !== 0 && dir1 === -dir0, 'flight lines do not alternate direction');
});

check('heading rotates the pattern without changing what it covers', () => {
  const a = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  const b = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:90, speed:8 })`);
  // A square flown along either axis is the same job: same area, same number of lines.
  near(b.areaHa, a.areaHa, 0.01, 'rotating the heading changed the area');
  assert(a.lineCount === b.lineCount, `heading changed the line count: ${a.lineCount} vs ${b.lineCount}`);
});

check('a concave boundary is clipped to its actual shape', () => {
  // An L-shaped site. Even-odd clipping must skip the notch; treating the polygon as its convex
  // hull would fly a lot of sky nobody asked for and inflate every cost figure on the sheet.
  const D = 400 / 111320;
  const L = [
    { lat: 0, lon: 0 }, { lat: 0, lon: D }, { lat: D / 2, lon: D },
    { lat: D / 2, lon: D / 2 }, { lat: D, lon: D / 2 }, { lat: D, lon: 0 }
  ];
  const plan = run(`plotairComputePlan({ verts:${JSON.stringify(L)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  assert(!plan.error, plan.error);
  // Three quarters of the square: 12 ha, not 16.
  near(plan.areaHa, 12, 0.2, 'area of the L-shape');
  const square = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  assert(plan.distanceM < square.distanceM,
    'the L-shape plans the same path length as the full square, so the notch is not being clipped');
});

check('impossible plans are refused with a reason, not silently produced', () => {
  // Each of these used to be capable of producing a plausible-looking plan made of nonsense.
  const two = run(`plotairComputePlan({ verts:[{lat:0,lon:0},{lat:0,lon:0.001}], cameraId:'p4p', altitude:100, front:80, side:70 })`);
  assert(two.error, 'two points were accepted as a boundary');
  const noAlt = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:0, front:80, side:70 })`);
  assert(noAlt.error, 'a zero altitude was accepted');
  const flat = run(`plotairComputePlan({ verts:[{lat:0,lon:0},{lat:0,lon:0.001},{lat:0,lon:0.002}], cameraId:'p4p', altitude:100, front:80, side:70 })`);
  assert(flat.error, 'three collinear points were accepted as an area');
  // Overlap is clamped rather than allowed to drive spacing to zero and the line count to infinity.
  const mad = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:100, side:100 })`);
  assert(!mad.error && mad.lineCount > 0 && mad.lineCount < 1e5,
    'a 100% overlap was not clamped and produced an unusable plan');
});

check('the exported KML is well formed and carries the parameters that produced it', () => {
  const kml = run(`plotairKml(plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 }), 'Test & Site <1>')`);
  assert(/^<\?xml/.test(kml), 'no XML declaration');
  assert(kml.includes('<kml xmlns="http://www.opengis.net/kml/2.2">'), 'missing the KML namespace');
  // Hand-written XML, so the escaping is the app's own responsibility — a project called
  // "Smith & Sons <north>" must not produce a file no flight app will parse.
  assert(kml.includes('Test &amp; Site &lt;1&gt;'), 'the document name was not escaped');
  // Check the CONTENT of every <name>, not the markup around it: a bare '&', '<' or '>' inside the
  // text is the failure, and an '&' that opens a real entity is not.
  for (const m of kml.matchAll(/<name>([\s\S]*?)<\/name>/g)){
    const body = m[1];
    assert(!/[<>]/.test(body), `unescaped angle bracket inside a name: "${body}"`);
    assert(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(body), `bare ampersand inside a name: "${body}"`);
  }
  // A KML that says only where to fly is unreproducible six months later.
  assert(/GSD 2\.7\d cm\/px/.test(kml), 'the GSD is not recorded in the file');
  assert(/Overlap 80% front \/ 70% side/.test(kml), 'the overlap is not recorded in the file');
  assert(/Check airspace/.test(kml), 'the airspace caveat did not travel with the file');
  // Balanced tags, cheaply: every opener has a closer.
  ['Document', 'Placemark', 'LineString', 'Polygon'].forEach(tag => {
    const open = (kml.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
    const close = (kml.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert(open === close, `${tag} tags do not balance (${open} open, ${close} close)`);
  });
});

check('the waypoint CSV has one row per waypoint and a header', () => {
  const plan = run(`plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 })`);
  const csv = run(`plotairCsv(plotairComputePlan({ verts:${JSON.stringify(SQ)}, cameraId:'p4p', altitude:100, front:80, side:70, heading:0, speed:8 }))`);
  const lines = csv.trim().split('\n');
  assert(lines.length === plan.waypoints.length + 1,
    `expected ${plan.waypoints.length} rows plus a header, got ${lines.length}`);
  assert(/^index,latitude,longitude/.test(lines[0]), 'no CSV header');
  // Eight decimals is about a millimetre. Rounding coordinates for display is fine; rounding them
  // in an export is a flight path that drifts.
  assert(/,-?\d+\.\d{8},/.test(lines[1]), `coordinates lost precision: ${lines[1]}`);
});

// ══════════════════════════════════════════════════════════════════════════
// FLIGHT PHOTO INGEST
// ══════════════════════════════════════════════════════════════════════════
// The EXIF reader is hand-rolled — four tags out of a TIFF IFD chain — and every failure mode it
// has is silent. A byte-order bug reads a position in the wrong hemisphere. An inline-versus-
// pointer mistake reads a coordinate out of the middle of the file. Neither throws; both produce a
// number that looks like a number. So these run against JPEGs assembled byte by byte, in both byte
// orders, with known coordinates.
const EXIF_FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-exif.json'), 'utf8'));
function exifBuf(key) {
  const arr = EXIF_FIXTURES[key];
  const u8 = new w.Uint8Array(arr.length);
  arr.forEach((b, i) => { u8[i] = b; });
  return u8.buffer;
}

check('EXIF position is read correctly from a little-endian file', () => {
  const ex = run('plotairReadExif')(exifBuf('le'));
  assert(ex, 'nothing was read from a valid JPEG');
  // Harare. Southern and eastern hemispheres, so a dropped ref tag shows up as a sign error rather
  // than as a plausible-looking coordinate somewhere else.
  near(ex.lat, -17.8252, 0.0002, 'latitude');
  near(ex.lon, 31.0335, 0.0002, 'longitude');
  near(ex.alt, 118.5, 0.05, 'altitude');
  assert(ex.model === 'FC3582', `camera model not read: "${ex.model}"`);
  assert(/2026:08:21/.test(ex.taken || ''), `timestamp not read: "${ex.taken}"`);
});

check('EXIF position is read correctly from a big-endian file', () => {
  // Motorola byte order is rarer but real, and a reader that assumes Intel produces garbage rather
  // than failing. Northern and western this time, so both ref signs are exercised.
  const ex = run('plotairReadExif')(exifBuf('be'));
  assert(ex, 'a big-endian JPEG was rejected');
  near(ex.lat, 53.5461, 0.0002, 'latitude');
  near(ex.lon, -113.4938, 0.0002, 'longitude');
});

check('the embedded thumbnail is lifted without decoding the image', () => {
  // This is what keeps 700 frames affordable: the camera already made a small one, so nothing here
  // ever constructs an Image or touches a canvas.
  const ex = run('plotairReadExif')(exifBuf('le'));
  assert(ex.thumb && ex.thumb.length > 0, 'no thumbnail was extracted');
  assert(ex.thumb[0] === 0xFF && ex.thumb[1] === 0xD8, 'the extracted thumbnail is not a JPEG');
  // A file with no thumbnail must still yield its position — plenty of cameras omit IFD1.
  const bare = run('plotairReadExif')(exifBuf('nothumb'));
  assert(bare && bare.lat != null, 'a file without a thumbnail lost its position too');
});

check('a file with no EXIF is refused rather than guessed at', () => {
  const notJpeg = new w.Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
  assert(run('plotairReadExif')(notJpeg) === null, 'a non-JPEG was accepted');
  // A JPEG with no APP1 at all: valid file, no metadata.
  const plain = new w.Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).buffer;
  assert(run('plotairReadExif')(plain) === null, 'a JPEG with no EXIF returned something');
});

check('thinning keeps an evenly spaced sample and never invents one', () => {
  // A mapping flight is 80% overlap by design, so consecutive frames are the same picture. Ten
  // shots 10 m apart, thinned at 25 m, must keep roughly every third.
  const shots = [];
  for (let i = 0; i < 10; i++) shots.push({ name: 'DJI_' + i + '.JPG', lat: 0, lon: (i * 10) / 111320 });
  const kept = run(`plotairThinByDistance(${JSON.stringify(shots)}, 25)`);
  assert(kept.length === 4, `expected 4 of 10 at 25 m spacing, got ${kept.length}`);
  // Order preserved: the frames arrive along the flight path, so thinning in order leaves a sample
  // of the ROUTE rather than a random subset.
  assert(kept[0].name === 'DJI_0.JPG' && kept[1].name === 'DJI_3.JPG',
    `thinning did not walk the path in order: ${kept.map(k => k.name).join(',')}`);
  // A wider gap keeps fewer; a gap wider than the flight keeps exactly one.
  assert(run(`plotairThinByDistance(${JSON.stringify(shots)}, 1000)`).length === 1,
    'a gap wider than the whole flight did not collapse to one frame');
  // Unplaced frames are dropped from the sample rather than positioned at null island.
  const mixed = shots.concat([{ name: 'nofix.JPG', lat: null, lon: null }]);
  assert(run(`plotairThinByDistance(${JSON.stringify(mixed)}, 25)`).every(k => k.name !== 'nofix.JPG'),
    'a photo with no position was kept as if it had one');
});

check('PlotAir is reachable and explains itself', () => {
  assert(!!d.getElementById('plotairModal'), 'the PlotAir sheet is missing from index.html');
  // It needs a project to have a boundary to plan over, so it says so rather than opening onto an
  // apology.
  run(`activeProjectId = null; openPlotAirFromHub();`);
  assert(!d.getElementById('plotairModal').classList.contains('show'),
    'PlotAir opened with no project, where it has nothing to plan against');
  assert(/Open a project first/i.test(d.getElementById('toast').textContent),
    `no explanation was given: "${d.getElementById('toast').textContent}"`);
  // Every user-visible Plot* name owes the crew a plain-English entry — enforced globally, checked
  // here too so a failure points at this module rather than at the sweep.
  assert(run(`!!(typeof PLOTWORDS !== 'undefined' && PLOTWORDS.plotair)`), 'PlotAir has no glossary entry');
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSIONS — the four failures the 577 tests above all sailed past
// ═══════════════════════════════════════════════════════════════════════════
// Every one of these was live in a build where the whole suite was green, which is the reason
// they are written against BEHAVIOUR at the call site rather than against the helpers underneath.
// The arithmetic in haversineM was never wrong; it was being called with the wrong shape of
// argument, and a unit test of haversineM itself would have passed forever.

// Puts a project on the device shaped exactly like one the user has: a PlotBounds working area,
// one captured polygon, and the features flushed to projectData rather than sitting in the live
// array — which is the state the Data hub leaves behind.
function seedProject() {
  run(`
    projects.length = 0;
    projects.push({ id:'rp', name:'Frog Lake', crs:'wgs84',
      bounds:{ north:-17.80, south:-17.86, east:31.10, west:31.02 } });
    projectData['rp'] = { savedFeatures: [{ id:'rf', name:'Yard boundary', geometryType:'polygon',
      featureTypeId:'x', vertices:[
        {lat:-17.81,lon:31.03},{lat:-17.81,lon:31.09},{lat:-17.85,lon:31.09},{lat:-17.85,lon:31.03}] }] };
    savedFeatures.length = 0;
    activeProjectId = 'rp'; activeProjectRef = 'rp';
  `);
}

check('a project area reports its size instead of "NaN x NaN km"', () => {
  seedProject();
  const label = run(`syncProjectBoundsUI(); document.getElementById('projBoundsLabel').textContent`);
  assert(!/NaN/.test(label), `the size readout printed NaN: "${label}"`);
  // ~8.5 x 6.7 km for the box above. The point is not the exact figure, it is that a real
  // measurement came back at all.
  assert(/\d/.test(label) && /km|m\b/.test(label), `no measurement in the readout: "${label}"`);
});

check('the outlier check returns a real distance, so the warning can grade it', () => {
  seedProject();
  const d = run(`outsideProjectBounds(-10, 20)`);
  assert(Number.isFinite(d), `outsideProjectBounds returned ${d} — the confirm would say "NaN m outside"`);
  assert(d > 1000, 'a point ~1500 km away should read as far outside, which is what picks the km wording');
  assert(run(`outsideProjectBounds(-17.83, 31.06)`) === null, 'a point inside the area was reported as outside');
});

check('a malformed boundary is treated as unset rather than printed', () => {
  assert(run(`boundsSizeLabel({north:NaN, south:1, east:2, west:1})`) === null, 'NaN boundary produced a label');
  assert(run(`boundsSizeLabel({north:1, south:1, east:2, west:1})`) === null, 'a zero-height boundary produced a label');
  assert(run(`boundsSizeLabel(null)`) === null, 'a missing boundary produced a label');
});

check('PlotAir opens from the Data hub, which clears activeProjectId on the way in', () => {
  seedProject();
  // Exactly what renderDataHubScreen() leaves behind: the ref is written, the active id is not.
  run(`activeProjectId = null;`);
  assert(run(`plotairProjectId()`) === 'rp', 'the hub could not work out which project it was on');
  run(`openPlotAirFromHub()`);
  assert(run(`document.getElementById('plotairModal').classList.contains('show')`),
    'the sheet refused to open from the one screen it is reachable from');
});

check('PlotAir finds the polygons even when the project is closed', () => {
  seedProject();
  run(`activeProjectId = null;`);
  const labels = JSON.parse(run(`JSON.stringify(plotairSources().map(s => s.label))`));
  assert(labels.length >= 2, `expected the working area and the captured polygon, got ${labels.length}`);
  assert(labels.some(l => /Yard boundary/.test(l)), 'the captured polygon was not offered');
});

check('a PlotBounds working area is flyable without capturing anything', () => {
  seedProject();
  // The old code looked for proj.boundary (an array nothing ever writes) instead of proj.bounds
  // (the rectangle PlotBounds actually stores), so this source silently never existed.
  run(`projectData['rp'].savedFeatures = []; activeProjectId = null;`);
  const src = JSON.parse(run(`JSON.stringify(plotairSources())`));
  assert(src.length === 1 && src[0].id === '__bounds',
    'the project working area was not offered as something to fly');
  assert(src[0].verts.length === 4, 'the working area did not become a closed ring');
});

check('a project with nothing in it still refuses politely rather than opening empty', () => {
  run(`projects.length = 0; activeProjectId = null; activeProjectRef = null;`);
  assert(run(`plotairProjectId()`) === null, 'a project id was invented from nothing');
});

check('the flight-photo section finds the point types of a closed project', () => {
  // featureTypes is per-project and only populated by openProject(). Reaching PlotAir from the Data
  // hub — the only way to reach it — leaves the global empty, so the section reported "No point
  // feature type in this project" for a project full of them.
  run(`
    projects.length = 0;
    projects.push({ id:'rp', name:'Frog Lake', crs:'wgs84' });
    projectData['rp'] = { savedFeatures: [], featureTypes: [
      { id:'ftP', name:'Utility pole', geometryType:'point', fields:[] },
      { id:'ftG', name:'Parcel', geometryType:'polygon', fields:[] }] };
    featureTypes.length = 0; savedFeatures.length = 0;
    activeProjectId = null; activeProjectRef = 'rp';
  `);
  run(`renderPlotairPhotoTypes()`);
  const html = run(`document.getElementById('plotairPhotoFt').innerHTML`);
  assert(/Utility pole/.test(html), `point type not offered: ${html}`);
  assert(!/Parcel/.test(html), 'a polygon type was offered for single-point photo placement');
  assert(run(`document.getElementById('plotairPhotoFt').disabled`) === false, 'the picker was left disabled');
});

check('imported flight photos reach the project rather than a detached array', () => {
  // savedFeatures and persist() both work on the OPEN project. From the hub there isn't one, so
  // the points were pushed to a stale global that persistStore() never writes — reported as
  // imported, gone on the next render.
  run(`
    projects.length = 0;
    projects.push({ id:'rp', name:'Frog Lake', crs:'wgs84' });
    projectData['rp'] = { savedFeatures: [], featureTypes: [{ id:'ftP', name:'Pole', geometryType:'point', fields:[] }] };
    savedFeatures.length = 0; activeProjectId = null; activeProjectRef = 'rp';
  `);
  const ok = run(`plotairCommitFeatures('rp', [{ id:'x1', name:'DJI_0001', geometryType:'point',
    featureTypeId:'ftP', vertices:[{lat:-17.82, lon:31.05}] }])`);
  assert(ok === true, 'the commit reported failure');
  assert(run(`projectData['rp'].savedFeatures.length`) === 1, 'the point never reached the project record');
  assert(run(`!!projects.find(p=>p.id==='rp').updatedAt`), 'the project was not stamped as modified');
});

check('a closed project still resolves its own polygons and types together', () => {
  // plotairSources() looked feature types up through getFeatureType(), which reads the same empty
  // global — so a polygon whose type says "polygon" could be dropped for the wrong reason.
  run(`
    projects.length = 0;
    projects.push({ id:'rp', name:'Frog Lake', crs:'wgs84' });
    projectData['rp'] = { featureTypes: [{ id:'ftG', name:'Parcel', geometryType:'polygon', fields:[] }],
      savedFeatures: [{ id:'f1', name:'Parcel 12', featureTypeId:'ftG', vertices:[
        {lat:-17.81,lon:31.03},{lat:-17.81,lon:31.09},{lat:-17.85,lon:31.09}] }] };
    featureTypes.length = 0; savedFeatures.length = 0;
    activeProjectId = null; activeProjectRef = 'rp';
  `);
  const labels = JSON.parse(run(`JSON.stringify(plotairSources().map(s=>s.label))`));
  assert(labels.some(l => /Parcel 12/.test(l)),
    `a polygon typed only on its feature type was dropped: ${JSON.stringify(labels)}`);
});

check('notifications ask for permission instead of defaulting to silently off', () => {
  // The preference defaulted to ON while the OS permission was never requested anywhere except
  // the Settings toggle, so a normal install could never deliver a single alert.
  assert(run(`typeof plotalertPrimePermission`) === 'function', 'no permission priming exists');
  assert(run(`/pointerdown/.test(plotalertPrimePermission.toString())`),
    'permission is not primed on a user gesture, which is the only time it can be granted');
  assert(run(`/plotalertRequestPermission\(\)/.test(plotalertRaise.toString())`),
    'raising an alert never asks for the permission it needs');
});

check('the service worker delivery path cannot hang forever', () => {
  // navigator.serviceWorker.ready is a promise and therefore always truthy. Where no worker is
  // registered it never settles, so the old code reported success having delivered nothing.
  assert(run(`/Promise.race/.test(plotalertDeliver.toString())`),
    'the worker path has no deadline, so an unregistered worker swallows the notification');
});

check('the backup scan asks for storage permission before reading folders', () => {
  assert(run(`typeof ensureBackupScanPermission`) === 'function', 'no permission step for the scan');
  assert(run(`/ensureBackupScanPermission/.test(findAllDeviceBackupFiles.toString())`),
    'readdir runs without requesting storage access, so every location is denied and the scan reports nothing');
});

check('nothing threw while any of that ran', () => {
  assert(bootErrors.length === 0, 'errors during boot: ' + bootErrors.join(' | '));
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  plotair: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
