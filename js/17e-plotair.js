// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — PlotAir: planning a drone flight over a surveyed boundary
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename order by
// index.html. Order matters — a file can only use top-level names declared in itself or in a file
// loaded before it. `npm test` checks this.
//
// ══ WHAT THIS IS, AND THE THREE THINGS IT DELIBERATELY IS NOT ══
// PlotEdge cannot fly a drone, and this does not pretend to. The manufacturer SDKs are native and
// need app-level integration a WebView cannot reach; MAVLink needs USB or serial. So there is no
// control, no telemetry, no over-the-air upload here, and no photogrammetric processing either —
// structure-from-motion is desktop or cloud work by an order of magnitude.
//
// What is left is the part that actually belongs in a survey app: the geometry BEFORE the flight
// and the record AFTER it. A boundary polygon is already captured — PlotBounds and every polygon
// feature type produce one — and turning that polygon into a flight path is arithmetic this app is
// already equipped for. The output is a file the pilot imports into whatever flight app they use.
//
// ══ WHY THIS IS ACCURACY-INDEPENDENT, WHICH MATTERS HERE ══
// A phone GNSS fix is 3–5 m. That rules out the obvious drone feature — surveying ground control
// points — because GCPs at 3–5 m are worse than no GCPs at all: they drag the photogrammetric
// solution away from where a good relative reconstruction would have put it. There is deliberately
// no GCP export in this file, and there should not be one until there is an RTK or PPK source.
//
// Flight PLANNING has no such problem. The plan only has to cover the polygon, the aircraft
// navigates on its own GNSS, and every real flight carries buffer beyond the boundary anyway — so
// a boundary known to 3–5 m plans a perfectly good flight. That is why this is the drone work
// worth building on this hardware and the GCP workflow is not.
//
// ══ THE PROJECTION ══
// Everything below works in a local east/north metre frame about the polygon's centroid, using the
// standard equirectangular approximation (a degree of longitude shrinks by cos(latitude)). Over a
// survey block — kilometres, not hundreds of kilometres — the error is far below the metre-scale
// this is planning at, and it avoids pulling in a projection library for arithmetic that is three
// lines. Capture stays WGS84 lat/lon exactly as it does everywhere else in the app (see the note
// at the top of js/16b-plotgrid.js); nothing here is ever stored projected.

const PLOTAIR_EARTH_R = 6378137;

// ══ WHY Number.isFinite AND NOT isFinite ══
// The global isFinite() COERCES before it tests, so isFinite(null) evaluates isFinite(0), which is
// true. Every "does this have a position" guard in this file takes values that are null when the
// camera had no fix — and with the global, a photo with no GPS passed every check and was placed at
// 0°N 0°E, in the Gulf of Guinea. It does not throw, it does not warn, and on a map centred over
// the actual site it does not even appear: the feature is simply somewhere else, in the project,
// counted. Number.isFinite does not coerce, so null is null.
function plotairNum(v){ return typeof v === 'number' && Number.isFinite(v); }

// ══ CAMERA PRESETS ══
// Sensor width and focal length are what set ground sample distance, and they are the two numbers
// nobody remembers. These cover the aircraft most likely to be in a field kit; "Custom" exists
// because the list will always be incomplete and a wrong preset is worse than a typed number.
// Figures are the manufacturers' published sensor sizes — not derived, not guessed.
const PLOTAIR_CAMERAS = [
  { id: 'mini',    label: 'DJI Mini 3 / 4 series', sensorW: 9.7,  focal: 6.7,  imgW: 4032 },
  { id: 'air',     label: 'DJI Air 2S / Air 3',    sensorW: 13.2, focal: 8.4,  imgW: 5472 },
  { id: 'mavic3',  label: 'DJI Mavic 3 (Hasselblad)', sensorW: 17.3, focal: 12.3, imgW: 5280 },
  { id: 'p4p',     label: 'DJI Phantom 4 Pro',     sensorW: 13.2, focal: 8.8,  imgW: 5472 },
  { id: 'custom',  label: 'Custom camera',         sensorW: 13.2, focal: 8.8,  imgW: 5472 }
];

// Defaults chosen as a sane mapping mission rather than as neutral values: 80/70 overlap is the
// usual recommendation for photogrammetry over anything with low texture, and under-lapping is the
// single most common reason a set of images fails to reconstruct.
let plotairPlan = null;      // the last computed plan, or null
let plotairSourceId = null;  // id of the polygon feature being flown

function plotairCamera(id){
  return PLOTAIR_CAMERAS.find(c => c.id === id) || PLOTAIR_CAMERAS[0];
}

// ══ GSD ══
// Ground sample distance in cm/px: how much ground one pixel covers. It is the number that decides
// whether a crack, a meter dial or a pole number is legible in the imagery, and it is what the
// altitude should be chosen FROM rather than the other way round.
function plotairGsdCm(cam, altitudeM){
  if (!cam || !(altitudeM > 0) || !(cam.focal > 0) || !(cam.imgW > 0)) return 0;
  // (sensor width mm × altitude m) / (focal mm × image width px) → metres/px, ×100 → cm/px
  return (cam.sensorW * altitudeM) / (cam.focal * cam.imgW) * 100;
}

// The inverse, so the altitude can be driven by the GSD the job actually needs.
function plotairAltitudeForGsd(cam, gsdCm){
  if (!cam || !(gsdCm > 0)) return 0;
  return (gsdCm / 100) * cam.focal * cam.imgW / cam.sensorW;
}

// Ground footprint of one frame, across-track and along-track. 2:3 is the aspect of every sensor
// in the list above; a 4:3 sensor differs by about 12% along-track, which is well inside the
// overlap margin this is feeding.
function plotairFootprint(cam, altitudeM){
  const w = (cam.sensorW * altitudeM) / cam.focal;   // metres across track
  return { w, h: w * (2 / 3) };
}


// ══ LOCAL METRE FRAME ══
function plotairProjector(lat0, lon0){
  const k = Math.PI / 180;
  const cosLat = Math.cos(lat0 * k);
  return {
    toXY: (lat, lon) => ({
      x: (lon - lon0) * k * PLOTAIR_EARTH_R * cosLat,
      y: (lat - lat0) * k * PLOTAIR_EARTH_R
    }),
    toLL: (x, y) => ({
      lat: lat0 + (y / PLOTAIR_EARTH_R) / k,
      lon: lon0 + (x / (PLOTAIR_EARTH_R * cosLat)) / k
    })
  };
}

function plotairCentroid(verts){
  let lat = 0, lon = 0;
  verts.forEach(v => { lat += v.lat; lon += v.lon; });
  return { lat: lat / verts.length, lon: lon / verts.length };
}

// Shoelace area in the local metre frame. Used only to report hectares and to sanity-check that a
// polygon was actually given — a degenerate ring plans a flight with no lines and would otherwise
// fail silently.
function plotairAreaM2(pts){
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++){
    a += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
  }
  return Math.abs(a / 2);
}


// ══ THE PATH ══
// A lawnmower pattern: parallel lines at the across-track spacing, clipped to the polygon, walked
// in alternating directions so the aircraft turns at the end of each line rather than flying back
// to the start of the block.
//
// Generated in a frame rotated by the flight heading, so the maths is always "horizontal scan
// lines" no matter which way the lines actually run. Heading matters in the field — flying the
// long axis of a site means fewer turns, and turns are where battery and time go.
//
// Clipping is even–odd: a scan line crosses a simple polygon an even number of times, and the
// interior is the span between crossing 1–2, 3–4 and so on. That handles concave shapes correctly,
// which matters because real boundaries are rarely convex — an L-shaped yard planned as its convex
// hull flies a lot of sky nobody asked for.
function plotairScanLines(pts, spacing, headingDeg){
  const th = -headingDeg * Math.PI / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const rot = p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const unrot = p => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });
  const R = pts.map(rot);

  let minY = Infinity, maxY = -Infinity;
  R.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  if (!(spacing > 0) || !isFinite(minY)) return [];

  const lines = [];
  // Half a spacing in from the edge: a line exactly on the boundary images half a frame of nothing,
  // and the frame's own width already covers outward to the edge.
  let flip = false;
  for (let y = minY + spacing / 2; y <= maxY; y += spacing){
    const xs = [];
    for (let i = 0, j = R.length - 1; i < R.length; j = i++){
      const a = R[j], b = R[i];
      // Strictly one endpoint above and one below, so a vertex sitting exactly on the scan line is
      // counted once rather than twice — the classic double-count that produces a stray segment.
      if ((a.y > y) !== (b.y > y)){
        xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2){
      let x1 = xs[i], x2 = xs[i + 1];
      // Segments shorter than a single frame are not worth a turn.
      if (x2 - x1 < 1) continue;
      const seg = flip ? [{ x: x2, y }, { x: x1, y }] : [{ x: x1, y }, { x: x2, y }];
      lines.push(seg.map(unrot));
    }
    flip = !flip;
  }
  return lines;
}


// ══ THE PLAN ══
// opts: { verts, cameraId, sensorW, focal, imgW, altitude, front, side, heading, speed }
function plotairComputePlan(opts){
  const verts = (opts.verts || []).filter(v => v && plotairNum(v.lat) && plotairNum(v.lon));
  if (verts.length < 3) return { error: 'A flight needs a boundary of at least three points.' };

  const cam = opts.cameraId === 'custom'
    ? { sensorW: +opts.sensorW || 13.2, focal: +opts.focal || 8.8, imgW: +opts.imgW || 5472 }
    : plotairCamera(opts.cameraId);

  const altitude = +opts.altitude;
  if (!(altitude > 0)) return { error: 'Set a flight altitude.' };

  const centre = plotairCentroid(verts);
  const proj = plotairProjector(centre.lat, centre.lon);
  const pts = verts.map(v => proj.toXY(v.lat, v.lon));
  const areaM2 = plotairAreaM2(pts);
  if (areaM2 < 1) return { error: 'That boundary encloses no area.' };

  const fp = plotairFootprint(cam, altitude);
  const side = Math.min(Math.max(+opts.side || 0, 0), 95) / 100;
  const front = Math.min(Math.max(+opts.front || 0, 0), 95) / 100;
  const spacing = fp.w * (1 - side);            // distance between flight lines
  const trigger = fp.h * (1 - front);           // distance between shutter releases
  if (!(spacing > 0.5) || !(trigger > 0.5)) return { error: 'Overlap is too high to fly.' };

  const lines = plotairScanLines(pts, spacing, +opts.heading || 0);
  if (!lines.length) return { error: 'No flight lines fit inside that boundary at this altitude.' };

  // Path length is the lines plus the turns between them — leaving the turns out understates a
  // dense mission badly, and the turns are exactly what a tight spacing multiplies.
  let lineM = 0, turnM = 0;
  lines.forEach((seg, i) => {
    lineM += Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
    if (i > 0){
      const prev = lines[i - 1][1];
      turnM += Math.hypot(seg[0].x - prev.x, seg[0].y - prev.y);
    }
  });

  const speed = +opts.speed > 0 ? +opts.speed : 8;
  const photos = lines.reduce((n, seg) =>
    n + Math.max(1, Math.ceil(Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y) / trigger) + 1), 0);

  const waypoints = [];
  lines.forEach(seg => seg.forEach(p => {
    const ll = proj.toLL(p.x, p.y);
    waypoints.push({ lat: ll.lat, lon: ll.lon, alt: altitude });
  }));

  return {
    error: null,
    camera: cam, cameraId: opts.cameraId,
    altitude, heading: +opts.heading || 0, speed,
    frontOverlap: Math.round(front * 100), sideOverlap: Math.round(side * 100),
    gsdCm: plotairGsdCm(cam, altitude),
    footprint: fp, spacing, trigger,
    areaHa: areaM2 / 10000,
    lineCount: lines.length,
    distanceM: lineM + turnM,
    // Turn allowance rather than a precise model: a real mission also climbs, holds and returns to
    // home, and a figure presented to two decimal places would be a false promise. Rounded up to
    // the minute for the same reason.
    minutes: Math.ceil(((lineM + turnM) / speed) / 60 * 1.25),
    photos,
    lines, waypoints,
    boundary: verts.map(v => ({ lat: v.lat, lon: v.lon })),
    createdAt: new Date().toISOString()
  };
}

// Batteries is the number a pilot actually plans around, and it belongs to the aircraft rather than
// to the geometry — so it is asked for rather than assumed, and reported as a count with the
// remainder made obvious.
function plotairBatteries(plan, minutesPerBattery){
  const per = +minutesPerBattery > 0 ? +minutesPerBattery : 18;
  return Math.max(1, Math.ceil(plan.minutes / per));
}


// ══ EXPORT ══
// KML, because it is the one format every flight app, Google Earth and every desktop GIS will
// open. Written by hand rather than through a library: it is forty lines of string building, and
// the app ships no XML dependency for exactly this reason.
function plotairKml(plan, name){
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const coord = p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},${Math.round(plan.altitude)}`;
  const path = plan.waypoints.map(coord).join(' ');
  const ring = plan.boundary.map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},0`).join(' ') +
    (plan.boundary.length ? ` ${plan.boundary[0].lon.toFixed(8)},${plan.boundary[0].lat.toFixed(8)},0` : '');

  // Every parameter that produced this path, in the file itself. A KML that says only where to fly
  // is unreproducible six months later — and the first question anyone asks of imagery is what
  // altitude and overlap it was flown at.
  const desc = [
    `Altitude ${Math.round(plan.altitude)} m AGL`,
    `GSD ${plan.gsdCm.toFixed(2)} cm/px`,
    `Overlap ${plan.frontOverlap}% front / ${plan.sideOverlap}% side`,
    `Line spacing ${plan.spacing.toFixed(1)} m`,
    `${plan.lineCount} lines · ${(plan.distanceM / 1000).toFixed(2)} km · ~${plan.minutes} min`,
    `~${plan.photos} photos over ${plan.areaHa.toFixed(2)} ha`,
    'Planned in PlotEdge (PlotAir). Flight path only. Check airspace, height limits and consent before flying.'
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(name || 'PlotAir flight')}</name>
    <description>${esc(desc)}</description>
    <Style id="plotairPath"><LineStyle><color>ff2f6fd6</color><width>3</width></LineStyle></Style>
    <Style id="plotairArea"><LineStyle><color>ff40c057</color><width>2</width></LineStyle>
      <PolyStyle><color>2240c057</color></PolyStyle></Style>
    <Placemark><name>Boundary</name><styleUrl>#plotairArea</styleUrl>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
    <Placemark><name>Flight path</name><styleUrl>#plotairPath</styleUrl>
      <LineString><altitudeMode>relativeToGround</altitudeMode><tessellate>1</tessellate>
        <coordinates>${path}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
}

// A plain waypoint CSV alongside the KML, for flight apps that want a table rather than geometry.
// Deliberately generic — latitude, longitude, altitude, one row per turn point — rather than
// targeting one vendor's column order, which changes between versions and fails silently when it
// does.
function plotairCsv(plan){
  const rows = ['index,latitude,longitude,altitude_m_agl,speed_ms'];
  plan.waypoints.forEach((p, i) => {
    rows.push([i + 1, p.lat.toFixed(8), p.lon.toFixed(8), Math.round(plan.altitude), plan.speed].join(','));
  });
  return rows.join('\n');
}


// ═══════════════════════════════════════════════════════════════════════════
// THE SHEET
// ═══════════════════════════════════════════════════════════════════════════
// A sheet rather than a screen, deliberately. PlotAir is a short arithmetic errand — pick a
// boundary, set an altitude, read the numbers, export a file — not a place to be. A screen would
// have to earn a slot in the nav, be somewhere Back can strand you, and carry its own header; a
// sheet borrows all of that from the shared chrome (js/21c-sheet-chrome.js) and closes when the
// errand is done.

function openPlotAir(){
  const el = document.getElementById('plotairModal');
  if (!el) return;
  plotairPlan = null;
  plotairScan = null;
  renderPlotairSources();
  renderPlotairPhotoTypes();
  renderPlotairScan();
  plotairSetImportEnabled(false);
  el.classList.add('show');
  updatePlotairPlan();
}

function closePlotAir(){
  const el = document.getElementById('plotairModal');
  if (el) el.classList.remove('show');
}

// ══ WHAT CAN BE FLOWN ══
// Any closed ring already in the project: a polygon feature, or the project's PlotBounds working
// area. Nothing new is captured here — a boundary walked or traced once should not have to be
// walked again to plan a flight over it, and re-entering it by hand is how the plan ends up
// covering somewhere slightly different from the survey.
// ══ WHERE THE FEATURES ACTUALLY ARE ══
// savedFeatures is the OPEN project's working array, and the Data hub has just closed the project
// (see plotairProjectId above), so by the time this sheet renders that array is empty. The
// features are on disk in projectData[id], which is where persistStore() puts them. Read the live
// array when the project is genuinely open — it may hold edits not yet flushed — and fall back to
// the stored copy when it is not.
function plotairFeaturesFor(id){
  if (id && id === activeProjectId && (savedFeatures || []).length) return savedFeatures;
  const d = (typeof projectData === 'object' && projectData) ? projectData[id] : null;
  return (d && d.savedFeatures) || [];
}

function plotairSources(){
  const out = [];
  const pid = plotairProjectId();
  const types = plotairFeatureTypesFor(pid);
  plotairFeaturesFor(pid).forEach(f => {
    const vs = (f.vertices || []).filter(v => v && plotairNum(v.lat) && plotairNum(v.lon));
    if (vs.length < 3) return;
    const ft = types.find(t => t.id === f.featureTypeId);
    // Polygon rings only. A line with three points is not an area, and planning a raster over one
    // would silently invent a boundary nobody drew.
    const geom = f.geometryType || (ft && ft.geometryType);
    if (geom && geom !== 'polygon') return;
    out.push({ id: f.id, label: (f.name || '(unnamed)') + ' · ' + vs.length + ' pts', verts: vs });
  });
  const proj = (projects || []).find(p => p.id === pid);
  // ══ THE PROJECT AREA WAS NEVER OFFERED ══
  // This looked for proj.boundary as an array of vertices. Nothing in the app has ever written
  // that key: PlotBounds stores the working area on proj.BOUNDS, as a {north,south,east,west}
  // rectangle (js/05a-plotbounds.js). So the one source that needs no capture at all — the area
  // the crew framed when they created the project — silently never appeared in the list, which is
  // half of why this sheet looked broken even when it did open. boundsToRing() turns the box into
  // the closed ring the planner wants.
  const fence = proj && (Array.isArray(proj.boundary) && proj.boundary.length >= 3
    ? proj.boundary
    : boundsToRing(proj.bounds));
  if (fence && fence.length >= 3){
    out.unshift({ id: '__bounds', label: 'Project working area · ' + fence.length + ' pts', verts: fence });
  }
  return out;
}

function renderPlotairSources(){
  const sel = document.getElementById('plotairSource');
  if (!sel) return;
  const list = plotairSources();
  sel.innerHTML = list.length
    ? list.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')
    : '<option value="">No polygon in this project</option>';
  sel.disabled = !list.length;
  if (list.length && !list.some(s => s.id === plotairSourceId)) plotairSourceId = list[0].id;
  if (plotairSourceId) sel.value = plotairSourceId;

  const camSel = document.getElementById('plotairCamera');
  if (camSel && !camSel.options.length){
    camSel.innerHTML = PLOTAIR_CAMERAS.map(c =>
      `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  }
}

function plotairVal(id, fallback){
  const el = document.getElementById(id);
  const v = el ? parseFloat(el.value) : NaN;
  return isFinite(v) ? v : fallback;
}

// Recomputed on every input rather than behind a "calculate" button. The whole value of this sheet
// is watching the GSD and the flight time move as the altitude does — that is how an altitude gets
// chosen, and a button would turn a dialogue into a series of guesses.
function updatePlotairPlan(){
  const sel = document.getElementById('plotairSource');
  plotairSourceId = sel ? sel.value : plotairSourceId;
  const src = plotairSources().find(s => s.id === plotairSourceId);
  const camId = (document.getElementById('plotairCamera') || {}).value || 'mini';

  // Custom camera fields only mean anything for the custom preset; showing them always would
  // suggest the preset figures are editable, and a silently-ignored input is worse than a hidden
  // one.
  const custom = document.getElementById('plotairCustomRow');
  if (custom) custom.style.display = camId === 'custom' ? '' : 'none';

  const out = document.getElementById('plotairResult');
  if (!src){
    if (out) out.innerHTML = '<div class="plotair-empty">Capture or trace a boundary polygon in this project first \u2014 PlotAir plans over an area you have already surveyed rather than one typed in here.</div>';
    plotairPlan = null;
    plotairSetExportEnabled(false);
    return;
  }

  const plan = plotairComputePlan({
    verts: src.verts,
    cameraId: camId,
    sensorW: plotairVal('plotairSensorW', 13.2),
    focal: plotairVal('plotairFocal', 8.8),
    imgW: plotairVal('plotairImgW', 5472),
    altitude: plotairVal('plotairAlt', 80),
    front: plotairVal('plotairFront', 80),
    side: plotairVal('plotairSide', 70),
    heading: plotairVal('plotairHeading', 0),
    speed: plotairVal('plotairSpeed', 8)
  });

  if (plan.error){
    plotairPlan = null;
    plotairSetExportEnabled(false);
    if (out) out.innerHTML = `<div class="plotair-empty">${escapeHtml(plan.error)}</div>`;
    return;
  }

  plotairPlan = plan;
  plotairSetExportEnabled(true);
  const batteries = plotairBatteries(plan, plotairVal('plotairBattery', 18));
  const stat = (n, l) => `<div class="plotair-stat"><div class="plotair-stat-n">${escapeHtml(n)}</div>` +
    `<div class="plotair-stat-l">${escapeHtml(l)}</div></div>`;

  // GSD leads because it is the number that decides whether the imagery answers the question the
  // survey is asking. Everything else is cost.
  if (out) out.innerHTML =
    `<div class="plotair-headline">
       <div class="plotair-gsd">${plan.gsdCm.toFixed(2)}<span>cm/px</span></div>
       <div class="plotair-gsd-sub">Ground sample distance at ${Math.round(plan.altitude)} m AGL</div>
     </div>
     <div class="plotair-stats">
       ${stat(plan.areaHa.toFixed(2) + ' ha', 'Area')}
       ${stat(String(plan.lineCount), 'Lines')}
       ${stat((plan.distanceM / 1000).toFixed(2) + ' km', 'Path')}
     </div>
     <div class="plotair-stats">
       ${stat('~' + plan.minutes + ' min', 'Air time')}
       ${stat('~' + plan.photos, 'Photos')}
       ${stat(String(batteries), batteries === 1 ? 'Battery' : 'Batteries')}
     </div>
     <div class="plotair-spec">
       Line spacing ${plan.spacing.toFixed(1)} m &middot; shutter every ${plan.trigger.toFixed(1)} m &middot;
       frame covers ${plan.footprint.w.toFixed(0)}&nbsp;&times;&nbsp;${plan.footprint.h.toFixed(0)} m
     </div>`;
}

// ══ THE OTHER DIRECTION ══
// Altitude is what a flight app asks for, but it is not what a survey needs — the survey needs a
// detail level, and the altitude is whatever delivers it. This lets someone say "2 cm/px" and be
// given the height that produces it, which is how the number should be chosen when the job has a
// legibility requirement (a meter dial, a pole number, a crack) rather than a height limit.
function plotairSolveAltitude(){
  const camId = (document.getElementById('plotairCamera') || {}).value || 'mini';
  const cam = camId === 'custom'
    ? { sensorW: plotairVal('plotairSensorW', 13.2), focal: plotairVal('plotairFocal', 8.8), imgW: plotairVal('plotairImgW', 5472) }
    : plotairCamera(camId);
  const want = plotairVal('plotairTargetGsd', 0);
  if (!(want > 0)){ showToast('Enter the detail you need, in cm per pixel'); return; }
  const alt = plotairAltitudeForGsd(cam, want);
  if (!(alt > 0)){ showToast('That camera cannot reach that detail'); return; }
  const el = document.getElementById('plotairAlt');
  if (el) el.value = Math.round(alt);
  updatePlotairPlan();
  // Said out loud because the altitude just changed under them, and a height that appeared on its
  // own is a height nobody checked against the local limit.
  showToast('Altitude set to ' + Math.round(alt) + ' m for ' + want + ' cm/px');
}

function plotairSetExportEnabled(on){
  ['plotairExportKml', 'plotairExportCsv'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !on;
  });
}

async function plotairExport(kind){
  if (!plotairPlan) return;
  const proj = (projects || []).find(p => p.id === activeProjectId);
  const base = ((proj && proj.name) || 'flight').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  const isKml = kind === 'kml';
  const name = `${base}_flight_${stamp}.${isKml ? 'kml' : 'csv'}`;
  const body = isKml ? plotairKml(plotairPlan, (proj && proj.name) || 'PlotAir flight') : plotairCsv(plotairPlan);
  try {
    const res = await saveExportFile(body, name, isKml ? 'application/vnd.google-earth.kml+xml' : 'text/csv');
    showToast(res && res.ok ? `Saved to ${res.where}` : 'Could not write the file');
  } catch(e){
    console.warn('PlotEdge: PlotAir export failed', e);
    showToast('Could not write the file');
  }
}


// ══ WHY THIS COULD NEVER OPEN ══
// PlotAir lives on the Data hub, and renderDataHubScreen() (js/05-projects.js) sets
// activeProjectId = null on the way in — leaving a project is exactly what "go to Data" means.
// This guard then read that null and refused. The row was therefore unreachable by construction:
// no polygon anybody captured could ever satisfy it, because the act of navigating to the button
// cleared the very thing the button checked for. It always toasted "Open a project first", and
// the hub row's own subtitle was stuck saying so for the same reason.
//
// The fix is to ask the question the guard was always trying to ask — "which project are we
// talking about?" — of activeProjectRef, the persisted last-opened id (js/02-state.js) that
// renderDataHubScreen() deliberately writes BEFORE it clears activeProjectId, precisely so
// screens like this one can still answer it.
function plotairProjectId(){
  if (activeProjectId) return activeProjectId;
  // Verified against the live list: a ref can outlive the project it names (deleted, or restored
  // from a backup that renumbered ids), and planning a flight over a project that is gone is a
  // worse failure than declining to.
  if (activeProjectRef && (projects || []).some(p => p.id === activeProjectRef)) return activeProjectRef;
  return null;
}

// Called from the Data hub. Refuses politely rather than opening an empty sheet: PlotAir plans over
// a boundary the project already holds, so with nothing open there is nothing to plan against.
function openPlotAirFromHub(){
  if (!plotairProjectId()){
    showToast('Open a project first \u2014 PlotAir plans over its boundary');
    return;
  }
  openPlotAir();
}


// ═══════════════════════════════════════════════════════════════════════════
// FLIGHT PHOTO INGEST
// ═══════════════════════════════════════════════════════════════════════════
// PlotAir planned a flight and nothing came back. This is the return leg, and it is built around
// one number: a 16 ha mission at the settings this sheet defaults to is about 700 frames, and a
// drone frame is 8–12 MB. That is 6–8 GB. No amount of compression makes that a thing a phone app
// holds, so the design does not try — it stores what is useful and leaves the photographs where
// they are.
//
// ══ THREE DECISIONS THAT MAKE THIS CHEAP ══
//
// 1. NEVER READ THE WHOLE FILE. EXIF lives in the APP1 segment at the head of a JPEG. Slicing the
//    first 128 KB gets all of it, and File.slice() reads only that slice — so 700 photos costs
//    tens of megabytes of reads rather than eight gigabytes, and a card full of imagery can be
//    scanned without ever being copied.
//
// 2. NEVER DECODE THE IMAGE. Drone JPEGs carry their own thumbnail inside EXIF IFD1, usually
//    160×120 and a few kilobytes. It is extracted as bytes and stored as-is. Decoding a 12 MP
//    frame to a canvas 700 times would kill the app long before storage became the problem — this
//    path never constructs an Image at all.
//
// 3. THIN ON THE WAY IN. A mapping flight is 80% overlap BY DESIGN — consecutive frames are
//    near-identical, because they are inputs to photogrammetry rather than documentation. Keeping
//    all of them would fill the project with the same picture. One frame per N metres along the
//    path is what a person actually wants to look at, and the count kept versus found is reported
//    so the thinning is never silent.
//
// Net: roughly 15–25 KB per kept photo. The originals are untouched on the card, and the filename
// travels with each record so the real frame can always be found again.

const PLOTAIR_EXIF_SCAN_BYTES = 131072;   // enough for APP1 on every drone JPEG seen in the wild

// ══ EXIF ══
// Hand-rolled rather than pulled in as a dependency: this reads four tags out of one IFD chain, and
// the app ships no image library for exactly this kind of reason. TIFF structure, so byte order is
// declared in the header and everything after it has to respect it.
function plotairReadExif(buf){
  const dv = new DataView(buf);
  if (dv.byteLength < 12 || dv.getUint16(0) !== 0xFFD8) return null;   // not a JPEG

  // Walk the marker segments to find APP1/Exif. Segments are length-prefixed, so this skips over
  // the image data rather than scanning it.
  let off = 2, app1 = -1;
  while (off + 4 < dv.byteLength){
    if (dv.getUint8(off) !== 0xFF) break;
    const marker = dv.getUint8(off + 1);
    if (marker === 0xDA) break;                       // start of scan: no metadata past here
    const len = dv.getUint16(off + 2);
    if (len < 2) break;
    if (marker === 0xE1 && off + 10 < dv.byteLength &&
        dv.getUint32(off + 4) === 0x45786966){        // "Exif"
      app1 = off + 10;
      break;
    }
    off += 2 + len;
  }
  if (app1 < 0 || app1 + 8 > dv.byteLength) return null;

  const bomTag = dv.getUint16(app1);
  if (bomTag !== 0x4949 && bomTag !== 0x4D4D) return null;
  const le = bomTag === 0x4949;                        // Intel byte order
  const u16 = p => dv.getUint16(p, le);
  const u32 = p => dv.getUint32(p, le);

  const readIfd = (ptr, want) => {
    const out = {};
    if (ptr + 2 > dv.byteLength) return { entries: out, next: 0 };
    const n = u16(ptr);
    // A corrupt or truncated header can claim thousands of entries; the file itself is the bound.
    if (n > 512) return { entries: out, next: 0 };
    for (let i = 0; i < n; i++){
      const e = ptr + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (want && want.indexOf(tag) === -1) continue;
      const size = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 }[type] || 1;
      const bytes = size * count;
      // Values of four bytes or fewer are stored inline in the entry itself; anything larger is a
      // pointer relative to the TIFF header. Getting this backwards is the classic EXIF bug.
      const vOff = bytes <= 4 ? e + 8 : app1 + u32(e + 8);
      out[tag] = { type, count, off: vOff, bytes };
    }
    const nextAt = ptr + 2 + n * 12;
    return { entries: out, next: nextAt + 4 <= dv.byteLength ? u32(nextAt) : 0 };
  };

  const rational = (v, i) => {
    const p = v.off + i * 8;
    if (p + 8 > dv.byteLength) return NaN;
    const den = u32(p + 4);
    return den ? u32(p) / den : NaN;
  };
  const ascii = v => {
    let s = '';
    for (let i = 0; i < v.bytes && v.off + i < dv.byteLength; i++){
      const c = dv.getUint8(v.off + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const ifd0 = readIfd(app1 + u32(app1 + 4), [0x010F, 0x0110, 0x8825, 0x0132]);
  const make = ifd0.entries[0x010F] ? ascii(ifd0.entries[0x010F]).trim() : '';
  const model = ifd0.entries[0x0110] ? ascii(ifd0.entries[0x0110]).trim() : '';
  const taken = ifd0.entries[0x0132] ? ascii(ifd0.entries[0x0132]).trim() : '';

  let lat = null, lon = null, alt = null, altRef = 0;
  const gpsPtr = ifd0.entries[0x8825];
  if (gpsPtr){
    // The pointer tag is a LONG whose VALUE is the offset of the GPS IFD, relative to the TIFF
    // header — not a pointer to where the value lives. Four bytes, so it is stored inline in the
    // entry and readIfd() has already resolved `off` to that inline position.
    const gpsIfd = readIfd(app1 + u32(gpsPtr.off), [0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006]);
    const e = gpsIfd.entries;
    const dms = v => {
      if (!v || v.count < 3) return NaN;
      return rational(v, 0) + rational(v, 1) / 60 + rational(v, 2) / 3600;
    };
    if (e[0x0002]) lat = dms(e[0x0002]);
    if (e[0x0004]) lon = dms(e[0x0004]);
    if (e[0x0001] && ascii(e[0x0001]).charAt(0) === 'S') lat = -lat;
    if (e[0x0003] && ascii(e[0x0003]).charAt(0) === 'W') lon = -lon;
    if (e[0x0006]) alt = rational(e[0x0006], 0);
    if (e[0x0005] && e[0x0005].off < dv.byteLength) altRef = dv.getUint8(e[0x0005].off);
    if (altRef === 1 && plotairNum(alt)) alt = -alt;    // below sea level
  }

  // IFD1 is the thumbnail directory. This is the whole reason a 12 MP frame never has to be
  // decoded: the camera already made a small one and put it in the file.
  let thumb = null;
  if (ifd0.next){
    const ifd1 = readIfd(app1 + ifd0.next, [0x0201, 0x0202]);
    const tOff = ifd1.entries[0x0201], tLen = ifd1.entries[0x0202];
    if (tOff && tLen){
      const start = app1 + u32(tOff.off), len = u32(tLen.off);
      if (len > 0 && len < 2000000 && start + len <= dv.byteLength){
        thumb = new Uint8Array(buf, start, len);
      }
    }
  }

  if (!plotairNum(lat) || !plotairNum(lon) || (lat === 0 && lon === 0)) return { make, model, taken, thumb, lat: null, lon: null, alt: null };
  return { make, model, taken, lat, lon, alt: isFinite(alt) ? alt : null, altRef, thumb };
}


// ══ THINNING ══
// Greedy, in capture order: keep a frame, then skip everything within `minGapM` of it. Order
// matters — the frames arrive along the flight path, so this leaves an evenly spaced sample of the
// route rather than a random subset. Photos with no fix are kept aside and reported, never
// silently dropped: a frame the drone could not place is still a frame that was taken.
function plotairThinByDistance(shots, minGapM){
  const gap = +minGapM > 0 ? +minGapM : 20;
  const kept = [];
  shots.forEach(s => {
    if (!plotairNum(s.lat) || !plotairNum(s.lon)) return;
    const tooClose = kept.length &&
      haversineM(kept[kept.length - 1].lat, kept[kept.length - 1].lon, s.lat, s.lon) < gap;
    if (!tooClose) kept.push(s);
  });
  return kept;
}


// ══ INGEST ══
// Two passes on purpose. The first only reads heads and reports what is there — how many frames,
// how many placed, what a given spacing would keep — because importing several hundred photos is
// not something to discover the shape of afterwards. The second writes only what was chosen.
let plotairScan = null;   // { shots:[], noFix:n, total:n }

function plotairChoosePhotos(){
  const input = document.getElementById('plotairPhotoInput');
  if (input){ input.value = ''; input.click(); }
}

async function plotairScanPhotos(event){
  const files = Array.from((event.target && event.target.files) || []);
  if (event.target) event.target.value = '';
  if (!files.length) return;

  const out = document.getElementById('plotairPhotoResult');
  const say = msg => { if (out) out.innerHTML = `<div class="plotair-empty">${escapeHtml(msg)}</div>`; };
  say(`Reading ${files.length} photo${files.length === 1 ? '' : 's'}\u2026`);

  const shots = [];
  let noFix = 0;
  for (let i = 0; i < files.length; i++){
    const f = files[i];
    try {
      // The slice is the whole trick: this reads the head of the file, not the file.
      const buf = await f.slice(0, PLOTAIR_EXIF_SCAN_BYTES).arrayBuffer();
      const ex = plotairReadExif(buf);
      if (!ex || ex.lat == null){ noFix++; continue; }
      shots.push({
        name: f.name, size: f.size,
        lat: ex.lat, lon: ex.lon, alt: ex.alt,
        make: ex.make, model: ex.model, taken: ex.taken,
        thumb: ex.thumb ? plotairThumbDataUrl(ex.thumb) : null
      });
    } catch(e){ noFix++; }
    // Yielded periodically so a card full of imagery does not lock the UI thread for the whole
    // scan. Every 25 files is often enough to keep the progress line moving.
    if (i % 25 === 0){
      say(`Reading ${i + 1} of ${files.length}\u2026`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  plotairScan = { shots, noFix, total: files.length };
  renderPlotairScan();
}

// The embedded thumbnail is already a complete JPEG; it only needs a data URL wrapper. No canvas,
// no decode.
function plotairThumbDataUrl(bytes){
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  try { return 'data:image/jpeg;base64,' + btoa(bin); } catch(e){ return null; }
}

function renderPlotairScan(){
  const out = document.getElementById('plotairPhotoResult');
  if (!out) return;
  if (!plotairScan || !plotairScan.total){ out.innerHTML = ''; return; }
  const { shots, noFix, total } = plotairScan;
  if (!shots.length){
    out.innerHTML = `<div class="plotair-empty">None of those ${total} photos carry a position. ` +
      `Check the drone had a GPS lock, and that the files are the originals rather than copies ` +
      `passed through an app that strips metadata.</div>`;
    plotairSetImportEnabled(false);
    return;
  }
  const gap = plotairVal('plotairThin', 20);
  const kept = plotairThinByDistance(shots, gap);
  const cam = [shots[0].make, shots[0].model].filter(Boolean).join(' ');
  const withThumb = kept.filter(s => s.thumb).length;

  // Kept versus found, always both. Thinning that does not say what it discarded is indistinguish-
  // able from an import that failed.
  out.innerHTML =
    `<div class="plotair-stats">
       ${['<div class="plotair-stat"><div class="plotair-stat-n">' + kept.length + '</div><div class="plotair-stat-l">Keeping</div></div>',
          '<div class="plotair-stat"><div class="plotair-stat-n">' + shots.length + '</div><div class="plotair-stat-l">Placed</div></div>',
          '<div class="plotair-stat"><div class="plotair-stat-n">' + total + '</div><div class="plotair-stat-l">Found</div></div>'].join('')}
     </div>
     <div class="plotair-spec">
       ${escapeHtml(cam || 'Unknown camera')} &middot; one frame every ${escapeHtml(String(gap))} m &middot;
       ${withThumb} of ${kept.length} carry an embedded preview
       ${noFix ? '<br>' + noFix + ' photo' + (noFix === 1 ? '' : 's') + ' had no position and will not be imported' : ''}
     </div>`;
  plotairSetImportEnabled(true);
}

function plotairSetImportEnabled(on){
  const b = document.getElementById('plotairImportBtn');
  if (b) b.disabled = !on;
}

// ══ WHAT ACTUALLY GETS SAVED ══
// One point feature per kept frame, carrying the filename, the camera, the timestamp and the
// altitude as EXIF reported it. The photograph itself is NOT copied — the embedded thumbnail is
// all that is stored, and the original stays on the card where it already lives.
//
// Altitude is recorded but deliberately not called elevation. Some drones write height above the
// take-off point, some write ellipsoidal height, and some put the absolute figure in an XMP block
// this does not read at all. Horizontal position is dependable across manufacturers; vertical is
// not, and labelling an unknown datum as elevation is how a survey acquires a number nobody can
// defend later.
// ══ WRITING INTO A PROJECT THAT IS NOT OPEN ══
// savedFeatures / featureTypes / persist() all operate on the OPEN project, and PlotAir is reached
// from the Data hub, which closes it. Pushing to the global array and calling persistStore() from
// here therefore wrote the imported points into a detached array that is not part of projectData —
// persist() itself bails on a null activeProjectId, so nothing ever reached disk. The photos were
// reported as imported and were gone on the next render.
// This commits to the project record directly when that project is not the open one, and takes the
// ordinary in-memory path when it is.
function plotairCommitFeatures(pid, made){
  if (!pid || !made.length) return false;
  if (pid === activeProjectId){
    made.forEach(f => savedFeatures.push(f));
    persist({ destructive: false });
    return true;
  }
  const rec = projectData[pid];
  if (!rec) return false;
  rec.savedFeatures = (rec.savedFeatures || []).concat(made);
  const p = (projects || []).find(x => x.id === pid);
  if (p) p.updatedAt = new Date().toISOString();
  persistStore({ destructive: false });
  return true;
}

async function plotairImportPhotos(){
  if (!plotairScan || !plotairScan.shots.length) return;
  const pid = plotairProjectId();
  if (!pid){ showToast('No project to add these to'); return; }
  const ftId = (document.getElementById('plotairPhotoFt') || {}).value || '';
  const ft = plotairFeatureTypesFor(pid).find(t => t.id === ftId);
  if (!ft){ showToast('Pick a feature type for the photo points'); return; }
  const made = [];

  const kept = plotairThinByDistance(plotairScan.shots, plotairVal('plotairThin', 20));
  const stamp = Date.now();
  let n = 0;

  for (const s of kept){
    const id = 'f_air_' + stamp + '_' + (n++);
    const photos = [];
    if (s.thumb){
      const pid = 'ph_air_' + stamp + '_' + n;
      // Same id in both slots: there is no full-resolution copy to point at, and inventing one by
      // upscaling the thumbnail would be a lie the media store then has to carry.
      try { await photoStoreSave({ id: pid, dataUrl: s.thumb, thumbUrl: s.thumb }); } catch(e){}
      photos.push({ id: pid, note: s.name });
    }
    made.push({
      id,
      name: s.name.replace(/\.[^.]+$/, ''),
      ref: '',
      featureTypeId: ft.id,
      featureTypeName: ft.name,
      geometryType: 'point',
      vertices: [{ lat: s.lat, lon: s.lon, attrs: {}, photos: [] }],
      attrs: {},
      photos,
      notes: [
        'Imported from a flight photo by PlotAir.',
        'File: ' + s.name,
        s.taken ? 'Taken: ' + s.taken : '',
        (s.make || s.model) ? 'Camera: ' + [s.make, s.model].filter(Boolean).join(' ') : '',
        s.alt != null ? 'EXIF altitude: ' + s.alt.toFixed(1) + ' m (datum not stated by the camera)' : '',
        'The full-resolution original was not copied into this project.'
      ].filter(Boolean).join('\n'),
      environment: 'PlotOut',
      createdAt: new Date().toISOString()
    });
  }

  if (!plotairCommitFeatures(pid, made)){
    showToast('Could not add those to the project');
    return;
  }
  if (typeof renderFeatures === 'function') renderFeatures();
  if (typeof refreshProjectsScreen === 'function') refreshProjectsScreen();
  plotairScan = null;
  renderPlotairScan();
  plotairSetImportEnabled(false);
  showToast(kept.length + ' flight photo' + (kept.length === 1 ? '' : 's') + ' added as points');
}

// Feature types are per-project and loaded into the global by openProject() (js/05-projects.js),
// so the global is only populated while a project is actually open. Launch straight into the
// Project Manager, walk to Data, open PlotAir, and it still holds the empty array it was
// initialised with — the sheet then reported "No point feature type in this project" for a project
// that has plenty. Same shape of bug, and the same fix, as plotairFeaturesFor() above.
function plotairFeatureTypesFor(id){
  if (id && id === activeProjectId && (featureTypes || []).length) return featureTypes;
  const d = (typeof projectData === 'object' && projectData) ? projectData[id] : null;
  return (d && d.featureTypes) || [];
}

function renderPlotairPhotoTypes(){
  const sel = document.getElementById('plotairPhotoFt');
  if (!sel) return;
  // Point-capable types only: a flight photo is a position, and offering a polygon type would
  // produce a one-vertex ring that no export knows what to do with.
  const list = plotairFeatureTypesFor(plotairProjectId())
    .filter(t => !t.geometryType || t.geometryType === 'point');
  sel.innerHTML = list.length
    ? list.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join('')
    : '<option value="">No point feature type in this project</option>';
  sel.disabled = !list.length;
}
