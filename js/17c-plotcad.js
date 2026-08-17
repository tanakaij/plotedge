
// PlotEdge — PlotCAD: CAD export
//
// ══ WHY DXF AND NOT DWG ══
// DWG is Autodesk's closed binary format. The only sanctioned writer is RealDWG, a licensed
// C++ library; there is no browser-capable DWG writer, and the reverse-engineered ones are
// version-fragile in exactly the way you cannot afford in a file a surveyor hands to a client.
// DWF is likewise proprietary (a ZIP of binary W2D streams) and is a *review* format anyway —
// you cannot draft on top of it, which defeats the point of sending geometry to a CAD office.
//
// DXF is Autodesk's own published interchange format, and R12 (AC1009) is the most universally
// readable revision of it: AutoCAD, Civil 3D, BricsCAD, ZWCAD, DraftSight, LibreCAD and Revit
// all import it without a converter. It is also plain ASCII, which means this file needs no
// CDN engine — unlike the GeoPackage/FlatGeobuf/Parquet/Excel/PDF writers, CAD export works
// with no signal at all. For a field app that is the difference between "export from the truck"
// and "export back at the office".
//
// A CAD office asking for "the DWG" will accept a DXF; if one genuinely insists on DWG, the
// conversion is one drag-and-drop in any of the readers above, or a free ODA File Converter run.

// ══ WGS84 → UTM ══
// CAD is a flat-plane format with no CRS: written in degrees, a site would come out a few
// drawing units across with northings and eastings on wildly different scales, and every
// dimension a drafter took off it would be meaningless. So coordinates are projected to metres.
//
// UTM, with the zone taken from the centroid of the features being exported, because it is the
// projection every CAD/survey package in the world already understands and it puts the drawing
// in true metres. Implemented here from the Snyder series rather than by loading proj4, both to
// keep the offline guarantee above and because this is the one transform needed — proj4 is a
// 40KB CDN fetch to do what forty lines do exactly as accurately (sub-centimetre).
const CAD_A = 6378137.0;              // WGS84 semi-major axis
const CAD_F = 1 / 298.257223563;      // WGS84 flattening
const CAD_K0 = 0.9996;                // UTM scale factor on the central meridian

function cadUtmZone(lon){ return Math.floor(((lon + 180) % 360) / 6) + 1; }

function cadLatLonToUtm(lat, lon, zone){
  const e2 = CAD_F * (2 - CAD_F);
  const ep2 = e2 / (1 - e2);
  const rad = Math.PI / 180;
  const phi = lat * rad;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * rad;
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);

  const N = CAD_A / Math.sqrt(1 - e2 * sinP * sinP);
  const T = tanP * tanP;
  const C = ep2 * cosP * cosP;
  const A = (lon * rad - lon0) * cosP;

  const M = CAD_A * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi)
  );

  const easting = CAD_K0 * N * (
    A + (1 - T + C) * Math.pow(A, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
  ) + 500000;

  let northing = CAD_K0 * (M + N * tanP * (
    A * A / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
  ));
  if (lat < 0) northing += 10000000; // southern-hemisphere false northing

  return { e: easting, n: northing };
}

// The EPSG code for the chosen zone, written into the drawing's comment header so whoever opens
// it can georeference it rather than guessing. Same 326xx/327xx ranges js/18-import.js recognizes
// on the way in, which keeps a PlotEdge → CAD → PlotEdge round trip self-consistent.
function cadUtmEpsg(zone, southern){ return (southern ? 32700 : 32600) + zone; }


// ══ LAYERS ══
// AutoCAD R12 layer names permit letters, digits, $ - _ and dots, and nothing else — no spaces,
// no accents, 31 characters. A name that violates this is not rejected loudly; it silently fails
// to bind entities to their layer, so sanitizing is not optional.
function cadLayerName(label, suffix){
  let base = String(label || 'LAYER').toUpperCase()
    .replace(/[^A-Z0-9_$.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'LAYER';
  const tail = suffix ? '_' + suffix : '';
  return base.slice(0, 31 - tail.length) + tail;
}

// DXF R12 carries colour as an AutoCAD Color Index, not RGB, so each feature type's hex is
// matched to the nearest of the standard low ACI slots. Restricted to the 1-9 range on purpose:
// those are the colours every CAD package renders identically and every plotter has a pen
// mapping for, which matters more for a drawing being issued than an exact hue match.
const CAD_ACI = [
  { i: 1, rgb: [255, 0, 0] },      { i: 2, rgb: [255, 255, 0] },
  { i: 3, rgb: [0, 255, 0] },      { i: 4, rgb: [0, 255, 255] },
  { i: 5, rgb: [0, 0, 255] },      { i: 6, rgb: [255, 0, 255] },
  { i: 7, rgb: [255, 255, 255] },  { i: 8, rgb: [128, 128, 128] },
  { i: 9, rgb: [192, 192, 192] }
];

function cadHexToAci(hex){
  if (!hex || typeof hex !== 'string') return 7;
  const m = hex.replace('#', '');
  if (m.length !== 6) return 7;
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return 7;
  let best = 7, bestD = Infinity;
  CAD_ACI.forEach(c => {
    const d = Math.pow(r - c.rgb[0], 2) + Math.pow(g - c.rgb[1], 2) + Math.pow(b - c.rgb[2], 2);
    if (d < bestD){ bestD = d; best = c.i; }
  });
  return best;
}


// ══ DXF SERIALIZATION ══
// A DXF is a flat stream of (group code, value) pairs, one per line. Everything below builds
// that stream; nothing here is clever, it just has to be exact — a single misplaced pair and
// AutoCAD rejects the whole file rather than the offending entity.
function cadPair(code, value){ return code + '\n' + value + '\n'; }
function cadNum(v){ return (Math.round(v * 1000) / 1000).toFixed(3); }

// R12 TEXT has no Unicode escape mechanism worth relying on, and control characters terminate
// the pair stream early. Anything outside printable ASCII is transliterated away rather than
// risking a truncated drawing.
function cadText(s){
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '').slice(0, 250);
}

function cadPoint(layer, e, n, z){
  return cadPair(0, 'POINT') + cadPair(8, layer)
    + cadPair(10, cadNum(e)) + cadPair(20, cadNum(n)) + cadPair(30, cadNum(z || 0));
}

// POLYLINE/VERTEX/SEQEND rather than LWPOLYLINE: the lightweight variant arrived in R14, and
// R12 is the whole point of this exporter. `closed` sets the ring flag for polygons, so a
// polygon arrives in CAD as a genuinely closed shape that reports an area, not a line that
// happens to end where it started.
function cadPolyline(layer, pts, closed, has3d){
  let flags = 0;
  if (closed) flags |= 1;
  if (has3d) flags |= 8; // 3D polyline — required before per-vertex Z is legal
  let s = cadPair(0, 'POLYLINE') + cadPair(8, layer) + cadPair(66, 1) + cadPair(70, flags)
        + cadPair(10, '0.000') + cadPair(20, '0.000') + cadPair(30, '0.000');
  pts.forEach(p => {
    s += cadPair(0, 'VERTEX') + cadPair(8, layer)
      + cadPair(10, cadNum(p.e)) + cadPair(20, cadNum(p.n)) + cadPair(30, cadNum(p.z || 0));
    if (has3d) s += cadPair(70, 32); // 3D polyline vertex
  });
  return s + cadPair(0, 'SEQEND') + cadPair(8, layer);
}

function cadLabel(layer, e, n, z, height, text){
  return cadPair(0, 'TEXT') + cadPair(8, layer)
    + cadPair(10, cadNum(e)) + cadPair(20, cadNum(n)) + cadPair(30, cadNum(z || 0))
    + cadPair(40, cadNum(height)) + cadPair(1, cadText(text));
}


// ══ THE EXPORT ══
// Layer scheme mirrors the GIS exports: one layer per feature type per geometry, using the same
// featureLayerKey()/layerLabelMap() split from js/17-export.js so a drawing's layer list and a
// GeoPackage's table list describe the same thing. Labels go on a parallel _TXT layer per type
// so a drafter can freeze all annotation in one action without losing the geometry.
//
// Attributes are deliberately NOT written as XDATA. XDATA survives into AutoCAD but is invisible
// in every viewer and most other packages, so it reads as data loss to the recipient; the
// feature name and reference id go on as visible TEXT, and the full attribute table travels in
// the CSV/GeoJSON export alongside, keyed on the same reference_id.
async function exportCAD(){
  if (!savedFeatures.length){ showToast('No features to export'); return; }

  const usable = savedFeatures.filter(f => (f.vertices || []).some(v => v.lat != null && v.lon != null));
  if (!usable.length){ showToast('No features have coordinates to draw'); return; }

  const status = document.getElementById('exportStatus');
  if (status) status.textContent = 'Building drawing…';

  // Zone from the centroid of everything being exported. A survey spanning a zone boundary is
  // projected wholly into one zone rather than split: a drawing with two coordinate systems in
  // it is worse than one with slight scale distortion at the edge, and the alternative (two
  // files) is not what somebody asking for "the CAD" wants.
  let sumLat = 0, sumLon = 0, nPts = 0;
  usable.forEach(f => (f.vertices || []).forEach(v => {
    if (v.lat == null || v.lon == null) return;
    sumLat += v.lat; sumLon += v.lon; nPts++;
  }));
  const cLat = sumLat / nPts, cLon = sumLon / nPts;
  const zone = cadUtmZone(cLon);
  const southern = cLat < 0;
  const epsg = cadUtmEpsg(zone, southern);

  const labels = layerLabelMap(usable);
  const project = projects.find(p => p.id === activeProjectId) || {};

  // ── Entities, and the layer inventory they imply ──
  const layerSpec = {}; // name -> aci
  let entities = '';
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  let drawn = 0;

  usable.forEach(f => {
    const geo = f.geometryType || 'point';
    const key = featureLayerKey(f);
    const layer = cadLayerName(labels[key] || 'FEATURES');
    const txtLayer = cadLayerName(labels[key] || 'FEATURES', 'TXT');
    const aci = cadHexToAci(featureTypeColor(f.featureTypeId));
    layerSpec[layer] = aci;
    layerSpec[txtLayer] = 8; // annotation grey — deliberately not the feature colour, so text
                             // reads as annotation rather than as more geometry

    const pts = (f.vertices || [])
      .filter(v => v.lat != null && v.lon != null)
      .map(v => {
        const u = cadLatLonToUtm(v.lat, v.lon, zone);
        return { e: u.e, n: u.n, z: v.alt == null ? 0 : v.alt, hasZ: v.alt != null };
      });
    if (!pts.length) return;
    pts.forEach(p => {
      minE = Math.min(minE, p.e); maxE = Math.max(maxE, p.e);
      minN = Math.min(minN, p.n); maxN = Math.max(maxN, p.n);
    });
    const has3d = pts.some(p => p.hasZ);

    if (geo === 'point'){
      // One POINT per captured vertex, matching the GeoJSON writer's one-feature-per-capture
      // decision (see its EXPORT CHOICE comment) — a re-shot position is its own mark on the
      // drawing, not an averaged one PlotEdge invented.
      pts.forEach((p, i) => {
        entities += cadPoint(layer, p.e, p.n, p.z);
        const tag = pts.length > 1 ? `${f.name || ''} (${i + 1})` : (f.name || '');
        const label = [tag, f.ref ? '#' + f.ref : ''].filter(Boolean).join(' ');
        if (label) entities += cadLabel(txtLayer, p.e + 0.6, p.n + 0.6, p.z, 0.9, label);
      });
    } else if (pts.length >= 2){
      entities += cadPolyline(layer, pts, geo === 'polygon', has3d);
      const label = [f.name || '', f.ref ? '#' + f.ref : ''].filter(Boolean).join(' ');
      if (label){
        // Ring/line labelled at its centroid for a polygon and at its first vertex for a line,
        // which is where a drafter expects to find each.
        const at = geo === 'polygon'
          ? { e: pts.reduce((s, p) => s + p.e, 0) / pts.length, n: pts.reduce((s, p) => s + p.n, 0) / pts.length, z: pts[0].z }
          : { e: pts[0].e + 0.6, n: pts[0].n + 0.6, z: pts[0].z };
        entities += cadLabel(txtLayer, at.e, at.n, at.z, 0.9, label);
      }
    } else {
      return; // a line/polygon capture with one vertex has no drawable shape
    }
    drawn++;
  });

  if (!drawn){ showToast('Nothing drawable to export'); return; }

  // ── Header ──
  // 999 comment lines are ignored by every reader but carry the georeferencing a DXF has no
  // native slot for, so the recipient is not left guessing which zone the eastings are in.
  let dxf = '';
  [
    'Created by PlotEdge',
    `Project: ${cadText(project.name || 'Untitled')}`,
    project.client ? `Client: ${cadText(project.client)}` : '',
    project.site ? `Site: ${cadText(project.site)}` : '',
    `Coordinate system: WGS84 / UTM zone ${zone}${southern ? 'S' : 'N'} (EPSG:${epsg})`,
    'Units: metres',
    `Exported: ${new Date().toISOString()}`,
    `Features drawn: ${drawn}`,
    'Attribute tables: export CSV or GeoJSON from PlotEdge and join on reference_id'
  ].filter(Boolean).forEach(line => { dxf += cadPair(999, line); });

  dxf += cadPair(0, 'SECTION') + cadPair(2, 'HEADER')
    + cadPair(9, '$ACADVER') + cadPair(1, 'AC1009')
    + cadPair(9, '$INSUNITS') + cadPair(70, 6) // 6 = metres
    + cadPair(9, '$EXTMIN') + cadPair(10, cadNum(minE)) + cadPair(20, cadNum(minN)) + cadPair(30, '0.000')
    + cadPair(9, '$EXTMAX') + cadPair(10, cadNum(maxE)) + cadPair(20, cadNum(maxN)) + cadPair(30, '0.000')
    + cadPair(0, 'ENDSEC');

  // ── Tables ──
  // The LTYPE table is included even though every layer below is CONTINUOUS: a layer referencing
  // a linetype that has no table entry is the single most common reason an otherwise valid R12
  // file is refused on import.
  const layerNames = Object.keys(layerSpec);
  dxf += cadPair(0, 'SECTION') + cadPair(2, 'TABLES')
    + cadPair(0, 'TABLE') + cadPair(2, 'LTYPE') + cadPair(70, 1)
      + cadPair(0, 'LTYPE') + cadPair(2, 'CONTINUOUS') + cadPair(70, 64)
      + cadPair(3, 'Solid line') + cadPair(72, 65) + cadPair(73, 0) + cadPair(40, '0.000')
    + cadPair(0, 'ENDTAB')
    + cadPair(0, 'TABLE') + cadPair(2, 'LAYER') + cadPair(70, layerNames.length);
  layerNames.forEach(name => {
    dxf += cadPair(0, 'LAYER') + cadPair(2, name) + cadPair(70, 0)
      + cadPair(62, layerSpec[name]) + cadPair(6, 'CONTINUOUS');
  });
  dxf += cadPair(0, 'ENDTAB') + cadPair(0, 'ENDSEC');

  // ── Entities ──
  dxf += cadPair(0, 'SECTION') + cadPair(2, 'ENTITIES') + entities + cadPair(0, 'ENDSEC')
    + cadPair(0, 'EOF');

  const label = (project.name || 'plotedge').replace(/\s+/g, '_');
  const res = await dl(dxf, `${label}_UTM${zone}${southern ? 'S' : 'N'}_${ts()}.dxf`, 'image/vnd.dxf');
  if (res && res.ok !== false){
    const where = (res && res.where) || 'your exports folder';
    if (status) status.textContent = `✓ ${drawn} features drawn on ${layerNames.length} layers — UTM zone ${zone}${southern ? 'S' : 'N'}`;
    showToast(`Drawing saved to ${where}`);
  }
  markProjectExported();
}
