
// PlotEdge — PlotBounds: picking a site on a map, and fencing a project's working area
//
// ══ TWO PROBLEMS, ONE MAP ══
//
// 1. SITE ACCURACY. The site coordinate was only ever settable from the phone's own GPS, which
//    means it is captured wherever the person happened to be standing when they created the
//    project — the office, the truck, the wrong end of the property. That coordinate is not
//    decoration: it is what suggests the working coordinate system (crsSuggestFor in
//    js/16b-plotgrid.js), what centres every map the crew opens, and what the project cards sort
//    and group by. A site set from the office car park quietly makes all three wrong.
//
// 2. OUTLIERS. Nothing stopped a feature being saved a hundred kilometres from the survey. A
//    mis-tapped manual coordinate, a GPS fix that latched onto a cached position from the
//    previous job, a vertex dropped while the map was panned somewhere else — all of them save
//    silently and all of them are found later, in QGIS, by which time the crew has left site.
//    A project area turns that from a discovery into a question asked at the moment of capture.
//
// The same map answers both: drop a pin for the site, then frame the area and take the boundary
// from what you can see.
//
// ══ WHY A BOX AND NOT A POLYGON ══
// A drawn polygon would be a tighter fence, and PlotEtch could already draw one. But the job here
// is catching a point that is obviously, grossly wrong — a hundred kilometres out, not three
// metres over a fence line — and for that a rectangle is exactly as effective, needs no drawing
// tools, survives being edited on a phone, and cannot be accidentally self-intersecting. A tight
// fence would also start rejecting legitimate captures just outside the line, which is the
// fastest way to teach a crew to switch the warning off.

let boundsMap = null, boundsPin = null, boundsRect = null, boundsMode = 'site';

// ══ THE PICKER ══
// `mode` is 'site' (place the pin) or 'area' (frame the working area). One map, two jobs, because
// they are done at the same moment and on the same view — you frame the area you are about to
// work in, having just marked where it is.
function openSitePicker(mode){
  boundsMode = mode || 'site';
  const modal = document.getElementById('sitePickerModal');
  if (!modal) return;
  modal.classList.add('show');
  document.getElementById('sitePickerTitle').textContent =
    boundsMode === 'area' ? 'Project area' : 'Site location';
  document.getElementById('sitePickerHint').textContent = boundsMode === 'area'
    ? 'Pan and zoom until the frame covers everything you will survey. Anything captured outside it will be queried, not blocked.'
    : 'Drag the map to put the pin on the site. This centres your maps and suggests the coordinate system.';
  document.getElementById('siteAreaFrame').style.display = boundsMode === 'area' ? '' : 'none';
  document.getElementById('sitePinMarker').style.display = boundsMode === 'area' ? 'none' : '';

  // Built on first open rather than at boot: Leaflet cannot measure a container inside a hidden
  // modal, and a map created against a zero-height div stays zero-height until something forces
  // an invalidateSize — which is the classic "grey box" bug.
  setTimeout(() => {
    if (!boundsMap){
      boundsMap = L.map('sitePickerMap', { zoomControl:true, attributionControl:true });
      applySitePickerBasemap();
    }
    boundsMap.invalidateSize();
    const start = sitePickerStartView();
    boundsMap.setView([start.lat, start.lon], start.zoom);
    updateSitePickerReadout();
    boundsMap.on('move', updateSitePickerReadout);
  }, 60);
}

// Where to open. In order of usefulness: the area already set, then the site already set, then
// the live GPS fix, then the active project's site — and only then a world view, which is what
// the old flow effectively gave everyone.
function sitePickerStartView(){
  const b = pendingProjectBounds();
  if (b) return { lat:(b.north+b.south)/2, lon:(b.east+b.west)/2, zoom:13 };
  const el = document.getElementById('newProjSite');
  if (el && el.dataset.lat) return { lat:Number(el.dataset.lat), lon:Number(el.dataset.lon), zoom:16 };
  if (typeof plotfixState !== 'undefined' && plotfixState.lat != null)
    return { lat:plotfixState.lat, lon:plotfixState.lon, zoom:17 };
  const p = projects.find(x => x.id === activeProjectId);
  if (p && p.siteLat != null) return { lat:p.siteLat, lon:p.siteLon, zoom:14 };
  return { lat:0, lon:20, zoom:2 };
}

function applySitePickerBasemap(){
  let key = 'satellite'; // imagery by default: you are identifying a place, and a road map of
                         // farmland or bush shows nothing to aim at
  try { key = localStorage.getItem('plotedge_basemap') || 'satellite'; } catch(e) {}
  const reg = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  const spec = (reg && reg[key]) || (reg && reg.satellite) ||
    { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr:'&copy; OpenStreetMap contributors', max:19 };
  L.tileLayer(spec.url, { maxZoom:spec.max, attribution:spec.attr }).addTo(boundsMap);
}

// The pin is fixed to the centre of the viewport rather than being a draggable marker: you move
// the map under a stationary crosshair. That is how every mapping app does placement on a phone,
// because a dragged pin spends the whole gesture under your thumb.
function updateSitePickerReadout(){
  if (!boundsMap) return;
  const c = boundsMap.getCenter();
  const out = document.getElementById('sitePickerCoord');
  if (out){
    out.textContent = (typeof crsFormat === 'function')
      ? crsFormat(c.lat, c.lng)
      : `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
  }
  const size = document.getElementById('sitePickerSize');
  if (size && boundsMode === 'area'){
    // Reported in km across rather than area, because "how far apart are the corners" is the
    // question somebody framing a survey is actually asking.
    size.textContent = boundsSizeLabel(sitePickerFrameBounds()) || '';
  } else if (size){
    size.textContent = '';
  }
}

// The frame is inset from the viewport edge so it reads as a deliberate boundary rather than
// "whatever happens to be on screen", and so the corners are visible while you position it.
function sitePickerFrameBounds(){
  const b = boundsMap.getBounds();
  const latPad = (b.getNorth() - b.getSouth()) * 0.08;
  const lonPad = (b.getEast() - b.getWest()) * 0.08;
  return {
    north: b.getNorth() - latPad, south: b.getSouth() + latPad,
    east:  b.getEast()  - lonPad, west:  b.getWest()  + lonPad
  };
}

function confirmSitePicker(){
  if (!boundsMap) return;
  if (boundsMode === 'area'){
    const b = sitePickerFrameBounds();
    setPendingProjectBounds(b);
  } else {
    const c = boundsMap.getCenter();
    newProjSiteLat = c.lat; newProjSiteLon = c.lng;
    const el = document.getElementById('newProjSite');
    if (el){
      el.dataset.lat = c.lat; el.dataset.lon = c.lng;
      // The name field is only auto-filled when the user has not typed one. Overwriting a typed
      // site name with a coordinate string is the kind of helpfulness nobody wants.
      if (!el.value.trim()) el.value = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
    }
    const hint = document.getElementById('locateHint');
    if (hint){ hint.classList.remove('err'); hint.textContent = 'Site placed on map'; }
    // A newly placed site may sit in a different belt from the last one.
    if (typeof renderCrsResults === 'function') renderCrsResults();
  }
  closeSitePicker();
  syncProjectBoundsUI();
}

function closeSitePicker(){
  const modal = document.getElementById('sitePickerModal');
  if (modal) modal.classList.remove('show');
  if (boundsMap) boundsMap.off('move', updateSitePickerReadout);
}


// ══ THE BOUNDARY ══
//
// ══ WHY THE SIZE READOUT SAID "NaN × NaN km" ══
// haversineM() is declared in js/11-features.js as haversineM(lat1, lon1, lat2, lon2) — four
// scalars. Every call in this file passed it two {lat, lon} OBJECTS instead. Objects coerce to NaN
// inside the trigonometry, so the distance came back NaN, and the label rendered the NaN straight
// through to the user. It failed silently in three separate places for the same reason:
//   · the live size readout while framing the area on the map,
//   · the "Project area" row on the New/Edit Project form (the reported symptom),
//   · outsideProjectBounds(), which is the one that actually mattered — it returned NaN, so the
//     `d > 1000` test was always false and the outlier confirm offered to capture a point "NaN m
//     outside the project area". The check was not merely mislabelled, it was inert.
// The calls are now scalar. These two helpers exist so there is ONE place that formats a boundary
// and one place that decides whether a boundary is usable, rather than the three hand-rolled
// copies that all had to be found and fixed together.

// A boundary is only usable if all four edges are real numbers AND the box is non-degenerate.
// Number.isFinite rather than the global isFinite for the reason set out at the top of
// js/17e-plotair.js: the global coerces first, so isFinite(null) tests isFinite(0) and passes.
function boundsIsValid(b){
  if (!b) return false;
  const n = [b.north, b.south, b.east, b.west];
  if (!n.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
  return b.north > b.south && b.east > b.west;
}

// Returns null rather than a string when there is nothing sane to show, so each caller can pick
// its own empty state instead of every one of them printing a broken measurement.
function boundsSizeLabel(b){
  if (!boundsIsValid(b)) return null;
  const w = haversineM(b.north, b.west, b.north, b.east) / 1000;
  const h = haversineM(b.north, b.west, b.south, b.west) / 1000;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  // Under a kilometre "0.1 × 0.4 km" is a worse answer than metres, and a single building survey
  // lands there routinely.
  if (w < 1 && h < 1) return `${Math.round(w * 1000)} × ${Math.round(h * 1000)} m`;
  return `${w.toFixed(1)} × ${h.toFixed(1)} km`;
}

// The four corners of a boundary as a closed ring, so anything that consumes a polygon (PlotAir,
// above all) can take a PlotBounds rectangle without knowing it was stored as a box.
function boundsToRing(b){
  if (!boundsIsValid(b)) return null;
  return [
    { lat: b.north, lon: b.west },
    { lat: b.north, lon: b.east },
    { lat: b.south, lon: b.east },
    { lat: b.south, lon: b.west }
  ];
}

// Held on the form until the project is saved, for the same reason the CRS choice is: on a new
// project there is nothing to persist to yet.
function pendingProjectBounds(){
  const el = document.getElementById('newProjCrsBtn');
  if (el && el.dataset.bounds){
    try { return JSON.parse(el.dataset.bounds); } catch(e) { return null; }
  }
  const p = projects.find(x => x.id === activeProjectId);
  return (p && p.bounds) || null;
}

function setPendingProjectBounds(b){
  const el = document.getElementById('newProjCrsBtn');
  if (el) el.dataset.bounds = b ? JSON.stringify(b) : '';
  showToast(b ? 'Project area set' : 'Project area cleared');
}

function clearProjectBounds(){
  setPendingProjectBounds(null);
  const p = projects.find(x => x.id === activeProjectId);
  if (p){ p.bounds = null; persist(); }
  syncProjectBoundsUI();
}

// Derives the area from what has already been captured. The obvious thing to want once a survey
// is underway and nobody set an area at the start — and far more accurate than framing it by eye,
// because it is the actual extent of the work. Padded by 20%, so the boundary a crew inherits is
// not one they immediately start tripping over at the edges.
function boundsFromFeatures(){
  const pts = [];
  savedFeatures.forEach(f => (f.vertices || []).forEach(v => {
    if (v.lat != null && v.lon != null) pts.push(v);
  }));
  if (pts.length < 2){ showToast('Capture a few features first'); return; }
  let north = -90, south = 90, east = -180, west = 180;
  pts.forEach(v => {
    north = Math.max(north, v.lat); south = Math.min(south, v.lat);
    east  = Math.max(east,  v.lon); west  = Math.min(west,  v.lon);
  });
  const latPad = Math.max((north - south) * 0.2, 0.002);   // ~220 m floor, so a single-building
  const lonPad = Math.max((east - west) * 0.2, 0.002);     // survey does not get a hairline box
  const b = { north:north+latPad, south:south-latPad, east:east+lonPad, west:west-lonPad };
  const p = projects.find(x => x.id === activeProjectId);
  if (p){ p.bounds = b; persist(); }
  setPendingProjectBounds(b);
  syncProjectBoundsUI();
}

function syncProjectBoundsUI(){
  const label = document.getElementById('projBoundsLabel');
  if (!label) return;
  // One expression, one empty state. A boundary that exists but is malformed (the old NaN case,
  // or one hand-edited into a backup) is treated as "not set" rather than printed as nonsense.
  label.textContent = boundsSizeLabel(pendingProjectBounds()) || 'Not set. Captures are never queried';
}


// ══ THE OUTLIER CHECK ══
// Warn, never block. A survey legitimately extends past its own boundary — a control point on a
// hilltop two kilometres away, a benchmark at the district office — and a hard refusal would
// teach the crew to turn the whole thing off within a week. The value is entirely in asking the
// question at the moment of capture, when the answer is still cheap.
function outsideProjectBounds(lat, lon){
  const p = projects.find(x => x.id === activeProjectId);
  const b = p && p.bounds;
  // boundsIsValid rather than a bare truthiness test: a half-written boundary used to sail through
  // here and poison every distance downstream with NaN.
  if (!boundsIsValid(b)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat <= b.north && lat >= b.south && lon <= b.east && lon >= b.west) return null;
  // How far outside, so the message can distinguish "just past the fence" from "wrong district".
  const nearLat = Math.min(Math.max(lat, b.south), b.north);
  const nearLon = Math.min(Math.max(lon, b.west), b.east);
  const d = haversineM(lat, lon, nearLat, nearLon);
  return Number.isFinite(d) ? d : null;
}

// Called before a vertex is committed. Returns true to proceed. The confirm carries the distance
// because "outside the project area" is a fact the crew may already know and accept, whereas
// "31 km outside" is almost always a mistake — and the number is what tells them which.
function confirmIfOutlier(lat, lon, proceed){
  const d = outsideProjectBounds(lat, lon);
  if (d == null){ proceed(); return; }
  const far = d > 1000 ? `${(d/1000).toFixed(1)} km` : `${Math.round(d)} m`;
  showConfirm(
    `This point is ${far} outside the project area. Capture it anyway?`,
    proceed, 'Capture anyway'
  );
}
