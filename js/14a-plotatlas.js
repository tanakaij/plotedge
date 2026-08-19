// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — PlotAtlas: the full-screen map screen
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══════════════════════════════════════════════════════════════════════════════
// WHY THIS REPLACED THE OLD "EXPAND MAP" BUTTON
// ══════════════════════════════════════════════════════════════════════════════
// The previous full-screen mode pinned .review-map-wrap over the viewport and
// told #reviewMap to fill it:
//
//     .review-map-wrap.fullscreen          { position:fixed; inset:0; height:100dvh; }
//     .review-map-wrap.fullscreen #reviewMap { height:100% !important; }
//
// #reviewMap does not sit directly inside that wrapper — there is a
// `<div style="position:relative">` between them, and that div has auto height.
// A percentage height resolved against an auto-height parent is auto, which for
// an empty div is zero. So the map collapsed to nothing, and what was left on
// screen was the legend and the connection strip that live *below* it inside the
// same wrapper: a blank screen you could scroll to find a layer list in. That is
// the reported bug, and it was never a Leaflet problem.
//
// Rather than patch the height chain, PlotAtlas is its own screen with its own
// Leaflet instance. That buys three things the docked map could not have:
//
//   1. It never fights dockReviewMap(). The Review map is physically moved
//      between the Dashboard slot and the Review tab as tabs change; a
//      full-screen mode layered on top of a node that another function relocates
//      is fragile by construction.
//   2. Its controls can be laid out for a full screen instead of a 260px strip.
//      The old expand button sat at top:10px/left:10px — exactly where Leaflet
//      puts its zoom control, which is the "stacking on the zoom control" report.
//      Here the zoom lives bottom-right, the tools collapse into a rail on the
//      right, and nothing overlaps anything.
//   3. It can carry the things a review thumbnail should not: measurement,
//      density, labels, clustering, a dropped-pin readout, a feature sheet.
//
// The three named surfaces now divide cleanly: PlotEtch digitises, PlotLens
// narrates, PlotAtlas is where you look at what you have.
let atlasMap = null;

let atlasFeatureLayer = null;

let atlasDensityLayer = null;

let atlasMeasureLayer = null;

let atlasPinLayer = null;

let atlasLocateMarker = null;

// Basemaps are all key-free public tile services, matching the "no external
// accounts" posture the rest of the app keeps. Order here is the order of the
// basemap switcher.
const ATLAS_BASEMAPS = {
  street:    { label:'Map',       url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
               attr:'&copy; OpenStreetMap contributors', max:19 },
  satellite: { label:'Satellite', url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
               attr:'Imagery &copy; Esri, Maxar, Earthstar Geographics', max:19 },
  topo:      { label:'Terrain',   url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
               attr:'&copy; OpenTopoMap (CC-BY-SA)', max:17 },
  light:     { label:'Light',     url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
               attr:'&copy; OpenStreetMap contributors, &copy; CARTO', max:19 },
  dark:      { label:'Dark',      url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
               attr:'&copy; OpenStreetMap contributors, &copy; CARTO', max:19 }
};

// The SAME key the Settings basemap control and the Review map write. One
// preference, every map: PlotAtlas, the Review/Dashboard map and the PlotLens
// minimap all resolve their tiles through ATLAS_BASEMAPS and this key, so
// choosing Satellite in Settings means satellite everywhere rather than in
// whichever screen happened to own the toggle you last touched.
const ATLAS_BASEMAP_KEY = 'plotedge_basemap';

const ATLAS_TOOLS_KEY = 'plotedge_atlas_tools_open';

let atlasBasemap = 'street';

let atlasBasemapLayer = null;

let atlasLabelsOn = false;

let atlasClusterOn = true;

let atlasDensityOn = false;

let atlasMeasureOn = false;

let atlasMeasurePoints = [];

let atlasSelectedId = null;

let atlasSearchQuery = '';


function plotAtlasIsOpen(){
  const el = document.getElementById('plotAtlas');
  return !!(el && el.classList.contains('show'));
}


// ══ OPEN / CLOSE ══
// Which view was underneath when PlotAtlas opened. It can be entered from the
// Review map, from Quick Actions on the Dashboard, and from PlotMind's work
// zones — closing it used to hard-code a return to #view-app, which quietly
// moved the user off whatever screen they had actually come from.
let _viewBeforeAtlas = null;

function openPlotAtlas(){
  const el = document.getElementById('plotAtlas');
  if (!el) return;
  if (!activeProjectId){ showToast('Open a project first'); return; }
  // First open only — see js/21a-plotwords.js. After the guards, so the explainer does not appear
  // on a tap that then bounces the user back with "Open a project first".
  plotwordsExplain('plotatlas');
  const current = document.querySelector('.view.active');
  _viewBeforeAtlas = current ? current.id : 'view-app';
  el.classList.add('show');
  document.body.style.overflow = 'hidden';
  // The ambient mesh is faded out on map screens so it cannot tint imagery —
  // same band the docked Review map uses. 'map' is one of the two bands
  // setScreenState() is allowed to be called with directly (see the theme suite).
  setScreenState('map');
  // Leaflet measures its container on creation, and the overlay was display:none
  // until the line above. Creating the map on the next frame means it is
  // measured at full size instead of at zero and then corrected.
  requestAnimationFrame(()=>{
    const map = ensureAtlasMap();
    if (!map){
      const note = document.getElementById('atlasEmpty');
      if (note){ note.textContent = 'The map library has not loaded yet. Connect once and reopen PlotAtlas.'; note.style.display = 'flex'; }
      return;
    }
    renderPlotAtlas();
    atlasFitData(true);
    setTimeout(()=>map.invalidateSize(), 60);
  });
  const title = document.getElementById('atlasProjectName');
  const p = projects.find(x=>x.id===activeProjectId);
  if (title) title.textContent = p ? p.name : 'PlotAtlas';
}

function closePlotAtlas(){
  plotwordsDismissAll();
  const el = document.getElementById('plotAtlas');
  if (!el) return;
  el.classList.remove('show');
  document.body.style.overflow = '';
  atlasCloseSheet();
  if (atlasMeasureOn) atlasToggleMeasure();
  // Hand the ambient band back to the screen that was underneath. activateView()
  // owns that decision everywhere else, so route through it rather than setting
  // a band directly — and give it the view we actually came from, not a guess.
  activateView(_viewBeforeAtlas || 'view-app');
  _viewBeforeAtlas = null;
}


// ══ MAP ══
function ensureAtlasMap(){
  if (atlasMap) return atlasMap;
  const el = document.getElementById('atlasMap');
  if (!el || typeof L === 'undefined') return null;
  try { atlasBasemap = localStorage.getItem(ATLAS_BASEMAP_KEY) || 'street'; } catch(e){}
  if (!ATLAS_BASEMAPS[atlasBasemap]) atlasBasemap = 'street';

  // Google Maps' feel: pinch zoom is smooth rather than stepped, and a two-finger
  // twist rotates the map the same way it would in Google Maps. The rotation
  // options and the compass control both come from js/13b-map-rotate.js — see the
  // header there for what was wrong with the plugin's own control and why the
  // installer has to run before L.map(). Returns false offline on a first-ever
  // launch, where this is simply a map that does not turn.
  const canRotate = peCanRotateMaps();
  atlasMap = L.map(el, Object.assign({
    // Every control is placed deliberately below. Leaflet's defaults are what
    // put the zoom control under the old expand button in the first place.
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    tap: true
  }, canRotate ? peRotateMapOptions('topright') : {}));
  if (canRotate) peAttachRotationSync(atlasMap);
  L.control.zoom({ position:'bottomright' }).addTo(atlasMap);
  L.control.scale({ position:'bottomleft', imperial:false, maxWidth:120 }).addTo(atlasMap);
  atlasApplyBasemap();

  atlasDensityLayer = L.layerGroup().addTo(atlasMap);
  atlasFeatureLayer = L.layerGroup().addTo(atlasMap);
  atlasMeasureLayer = L.layerGroup().addTo(atlasMap);
  atlasPinLayer = L.layerGroup().addTo(atlasMap);

  atlasMap.setView([0,0], 2);

  // Clustering and the density grid are both zoom-dependent, so they have to be
  // rebuilt as the view changes. moveend (not move) so this runs once per
  // gesture rather than once per frame.
  atlasMap.on('moveend zoomend', ()=>{ atlasUpdateZoomDependent(); });
  atlasMap.on('click', ev => atlasOnMapClick(ev));
  // Long-press / right-click drops a pin and reads out its coordinate, the way
  // Google Maps does. It is the fastest way to answer "what is that spot?" in
  // the field without capturing a feature you did not mean to capture.
  atlasMap.on('contextmenu', ev => atlasDropPin(ev.latlng));

  atlasRestoreToolbarState();
  return atlasMap;
}

function atlasApplyBasemap(){
  if (!atlasMap) return;
  const spec = ATLAS_BASEMAPS[atlasBasemap] || ATLAS_BASEMAPS.street;
  if (atlasBasemapLayer) atlasMap.removeLayer(atlasBasemapLayer);
  atlasBasemapLayer = L.tileLayer(spec.url, { maxZoom: spec.max, attribution: spec.attr, crossOrigin: true });
  atlasBasemapLayer.addTo(atlasMap);
  // Under the tiles, not over them: the feature layers were added after the
  // basemap originally, but swapping the basemap re-adds it on top otherwise.
  atlasBasemapLayer.bringToBack();
  const label = document.getElementById('atlasBasemapLabel');
  if (label) label.textContent = spec.label;
  document.querySelectorAll('#atlasBasemapSheet .atlas-bm-opt').forEach(b=>{
    b.classList.toggle('on', b.getAttribute('data-bm') === atlasBasemap);
  });
}

function atlasSetBasemap(key){
  if (!ATLAS_BASEMAPS[key]) return;
  // Routed through the shared setter rather than writing the key directly, so
  // picking a basemap here also moves the Review map, the PlotLens minimap and
  // the Settings control. A picker that silently disagrees with the preference
  // screen is worse than no picker.
  setBasemapPref(key);
  atlasCloseBasemapSheet();
}

// Called by setBasemapPref() when the choice was made somewhere else.
function atlasSyncBasemapFromPref(){
  if (!atlasMap) return;
  let key = 'street';
  try { key = localStorage.getItem(ATLAS_BASEMAP_KEY) || 'street'; } catch(e){}
  if (!ATLAS_BASEMAPS[key]) key = 'street';
  if (key === atlasBasemap) return;
  atlasBasemap = key;
  atlasApplyBasemap();
}

function atlasOpenBasemapSheet(){
  const s = document.getElementById('atlasBasemapSheet');
  if (s) s.classList.add('show');
}

function atlasCloseBasemapSheet(){
  const s = document.getElementById('atlasBasemapSheet');
  if (s) s.classList.remove('show');
}


// ══ THE COLLAPSIBLE TOOL RAIL ══
// Every tool that acts on the map lives here, on the right edge, stacked
// vertically and collapsed behind one button by default. Collapsed it is a
// single 44px target; expanded it is a labelled column. Nothing in it overlaps
// the zoom control (bottom-right), the scale bar (bottom-left) or the basemap
// chip (bottom-left) — which is the layout problem the old single expand button
// had. The open/closed choice is remembered, because a crew that works with the
// rail open should not have to reopen it on every visit.
function atlasToggleTools(){
  const rail = document.getElementById('atlasRail');
  if (!rail) return;
  const open = !rail.classList.contains('open');
  rail.classList.toggle('open', open);
  const btn = document.getElementById('atlasRailToggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem(ATLAS_TOOLS_KEY, open ? '1' : '0'); } catch(e){}
}

function atlasRestoreToolbarState(){
  let open = false;
  try { open = localStorage.getItem(ATLAS_TOOLS_KEY) === '1'; } catch(e){}
  const rail = document.getElementById('atlasRail');
  if (rail) rail.classList.toggle('open', open);
  const btn = document.getElementById('atlasRailToggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function atlasSyncToolStates(){
  const set = (id, on) => {
    const el = document.getElementById(id);
    if (el){ el.classList.toggle('on', !!on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  };
  set('atlasToolLabels', atlasLabelsOn);
  set('atlasToolCluster', atlasClusterOn);
  set('atlasToolDensity', atlasDensityOn);
  set('atlasToolMeasure', atlasMeasureOn);
  const legend = document.getElementById('atlasLegend');
  set('atlasToolLegend', legend && legend.classList.contains('show'));
}

function atlasToggleLabels(){ atlasLabelsOn = !atlasLabelsOn; renderPlotAtlas(); atlasSyncToolStates(); }

function atlasToggleCluster(){ atlasClusterOn = !atlasClusterOn; renderPlotAtlas(); atlasSyncToolStates(); }

function atlasToggleDensity(){
  atlasDensityOn = !atlasDensityOn;
  renderAtlasDensity();
  atlasSyncToolStates();
  if (atlasDensityOn) showToast('Density grid on — brighter cells hold more captures');
}

function atlasToggleLegend(){
  const legend = document.getElementById('atlasLegend');
  if (legend) legend.classList.toggle('show');
  atlasSyncToolStates();
}


// ══ FEATURE RENDERING ══
// Same colour-by-feature-type convention as the Review map and the review list,
// so a colour means one thing everywhere in the app.
function renderPlotAtlas(){
  const map = ensureAtlasMap();
  if (!map || !atlasFeatureLayer) return;
  atlasFeatureLayer.clearLayers();

  const legendSeen = new Map();
  const points = [];      // point-geometry captures, candidates for clustering
  let drawn = 0;

  const matches = f => {
    if (!atlasSearchQuery) return true;
    const hay = `${f.name||''} ${f.ref||''} ${resolveFeatureType(f).label||''}`.toLowerCase();
    return hay.includes(atlasSearchQuery);
  };

  savedFeatures.forEach(f=>{
    const info = resolveFeatureType(f);
    if (typeof hiddenLayerKeys !== 'undefined' && hiddenLayerKeys.has(info.key)) return;
    if (!matches(f)) return;
    const color = featureTypeColor(info.key);
    const geo = f.geometryType || 'point';
    legendSeen.set(info.key, { label:info.label, color, geo,
      shape:featureTypeShape(info.key), lineStyle:featureTypeLineStyle(info.key), filled:featureTypeFilled(info.key) });
    const verts = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
    if (!verts.length) return;
    drawn++;

    if (geo === 'point'){
      const pointShape = featureTypeShape(info.key);
      verts.forEach(v => points.push({ f, v, color, info, shape:pointShape }));
      return;
    }
    const latlngs = verts.map(v=>[v.lat, v.lon]);
    const lineStyle = featureTypeLineStyle(info.key);
    const filled = featureTypeFilled(info.key);
    const shape = geo === 'polygon'
      ? L.polygon(latlngs, { color, weight:2.5, fillColor:color, fillOpacity:filled?0.22:0, fill:filled, dashArray:leafletDashArray(lineStyle,2.5) })
      : L.polyline(latlngs, { color, weight:4, dashArray:leafletDashArray(lineStyle,4) });
    // NOTE: Leaflet's vector layers (polyline/polygon/circleMarker) default
    // `bubblingMouseEvents: true`, so a click on a feature is also re-fired on
    // the map itself, via Leaflet's own internal propagation bookkeeping — not
    // native DOM bubbling. Calling L.DomEvent.stop() on ev.originalEvent only
    // stops the native event; it does not set the internal flag Leaflet checks
    // before re-firing on the map. You must call L.DomEvent.stopPropagation()
    // on the Leaflet event itself. Without this, atlasOnMapClick() fires right
    // after atlasOpenSheet(), closing the sheet the instant it opens.
    shape.on('click', ev => { L.DomEvent.stopPropagation(ev); atlasOpenSheet(f.id); });
    shape.addTo(atlasFeatureLayer);
    if (atlasLabelsOn) atlasAddLabel(latlngs[Math.floor(latlngs.length/2)], f.name || '(unnamed)', color);
    // Vertex handles, matching the Review map: each standpoint carries its own
    // fix quality and photos, and a single popup for a twelve-vertex boundary
    // throws all of that away.
    verts.forEach((v, vi)=>{
      L.circleMarker([v.lat, v.lon], {
        radius: (v.photos||[]).length ? 5.5 : 4.5,
        color:'#fff', weight:2, fillColor:color, fillOpacity:1
      }).on('click', ev => { L.DomEvent.stopPropagation(ev); atlasOpenSheet(f.id, vi); })
        .addTo(atlasFeatureLayer);
    });
  });

  atlasRenderPoints(points);
  renderAtlasLegend(legendSeen);
  renderAtlasDensity();
  atlasSyncToolStates();

  const empty = document.getElementById('atlasEmpty');
  if (empty){
    if (drawn){ empty.style.display = 'none'; }
    else {
      empty.textContent = atlasSearchQuery
        ? 'Nothing matches that search.'
        : (savedFeatures.length ? 'Every layer is hidden. Turn one back on from Layers.' : 'No features captured in this project yet.');
      empty.style.display = 'flex';
    }
  }
  const count = document.getElementById('atlasCount');
  if (count) count.textContent = drawn ? `${drawn} feature${drawn===1?'':'s'}` : '';
}


// ══ CLUSTERING, WITHOUT A PLUGIN ══
// A survey corridor puts hundreds of points within a few hundred metres of each
// other. Zoomed out that is a solid blob of overlapping markers: unreadable, and
// hundreds of DOM/canvas objects for no information. Rather than pull in
// Leaflet.markercluster (another CDN dependency on an app that has to work
// offline), this bins by screen-space grid at the current zoom — the same idea,
// a fraction of the code, and no extra network dependency. Above zoom 17 the
// points are far enough apart to draw individually and clustering switches off
// on its own, so the crew never has to think about it.
const ATLAS_CLUSTER_CELL_PX = 46;

const ATLAS_CLUSTER_MAX_ZOOM = 17;

function atlasRenderPoints(points){
  if (!points.length) return;
  const zoom = atlasMap.getZoom();
  if (!atlasClusterOn || zoom >= ATLAS_CLUSTER_MAX_ZOOM || points.length < 12){
    points.forEach(({f, v, color, shape}) => {
      const halo = (typeof accuracyHaloStyle === 'function') ? accuracyHaloStyle(v.acc) : null;
      if (halo) L.circle([v.lat, v.lon], { radius: Math.max(v.acc, 3), ...halo, interactive:false }).addTo(atlasFeatureLayer);
      featurePointLayer([v.lat, v.lon], { shape, radius:7, color:'#fff', weight:2.5, fillColor:color, fillOpacity:0.95 })
        .on('click', ev => { L.DomEvent.stopPropagation(ev); atlasOpenSheet(f.id); })
        .addTo(atlasFeatureLayer);
      if (atlasLabelsOn) atlasAddLabel([v.lat, v.lon], f.name || '(unnamed)', color);
    });
    return;
  }
  const cells = new Map();
  points.forEach(pt => {
    const px = atlasMap.latLngToContainerPoint([pt.v.lat, pt.v.lon]);
    const key = Math.floor(px.x / ATLAS_CLUSTER_CELL_PX) + ':' + Math.floor(px.y / ATLAS_CLUSTER_CELL_PX);
    let c = cells.get(key);
    if (!c){ c = { items:[], sumLat:0, sumLon:0 }; cells.set(key, c); }
    c.items.push(pt); c.sumLat += pt.v.lat; c.sumLon += pt.v.lon;
  });
  cells.forEach(c => {
    const n = c.items.length;
    const centre = [c.sumLat / n, c.sumLon / n];
    if (n === 1){
      const { f, v, color, shape } = c.items[0];
      featurePointLayer([v.lat, v.lon], { shape, radius:7, color:'#fff', weight:2.5, fillColor:color, fillOpacity:0.95 })
        .on('click', ev => { L.DomEvent.stopPropagation(ev); atlasOpenSheet(f.id); })
        .addTo(atlasFeatureLayer);
      if (atlasLabelsOn) atlasAddLabel([v.lat, v.lon], f.name || '(unnamed)', color);
      return;
    }
    // The cluster takes the colour of whichever feature type dominates it, so
    // the map still reads as "mostly poles here, mostly manholes there" rather
    // than turning every group into the same neutral disc.
    const tally = new Map();
    c.items.forEach(it => tally.set(it.color, (tally.get(it.color)||0) + 1));
    const color = [...tally.entries()].sort((a,b)=>b[1]-a[1])[0][0];
    const size = n < 10 ? 34 : n < 50 ? 42 : 50;
    L.marker(centre, {
      icon: L.divIcon({
        className: 'atlas-cluster',
        html: `<div class="atlas-cluster-dot" style="--cl:${color};width:${size}px;height:${size}px;">${n}</div>`,
        iconSize: [size, size], iconAnchor: [size/2, size/2]
      })
    }).on('click', ()=>{
      // Zooming to the cluster's own extent is what makes a cluster feel like a
      // door rather than a wall.
      const b = L.latLngBounds(c.items.map(it=>[it.v.lat, it.v.lon]));
      atlasMap.fitBounds(b, { padding:[60,60], maxZoom: ATLAS_CLUSTER_MAX_ZOOM + 1 });
    }).addTo(atlasFeatureLayer);
  });
}

function atlasAddLabel(latlng, text, color){
  L.marker(latlng, {
    interactive: false,
    icon: L.divIcon({
      className: 'atlas-label',
      html: `<span style="--cl:${color}">${escapeHtml(String(text).slice(0,28))}</span>`,
      iconSize: [0,0], iconAnchor: [0,-10]
    })
  }).addTo(atlasFeatureLayer);
}

function atlasUpdateZoomDependent(){
  if (!plotAtlasIsOpen()) return;
  if (atlasClusterOn || atlasDensityOn) renderPlotAtlas();
}


// ══ DENSITY GRID ══
// The honest version of a heatmap for this data. A true kernel-density raster
// needs a canvas plugin; binning captures into equal-area cells and shading by
// count answers the same question ("where did we concentrate?") with no
// dependency, and unlike a blurred heat blob it stays readable about *how many*.
function renderAtlasDensity(){
  if (!atlasDensityLayer) return;
  atlasDensityLayer.clearLayers();
  if (!atlasDensityOn || !atlasMap) return;
  const pts = [];
  savedFeatures.forEach(f=>{
    const info = resolveFeatureType(f);
    if (typeof hiddenLayerKeys !== 'undefined' && hiddenLayerKeys.has(info.key)) return;
    (f.vertices||[]).forEach(v=>{ if (v.lat!=null && v.lon!=null) pts.push(v); });
  });
  if (pts.length < 3) return;
  const b = L.latLngBounds(pts.map(v=>[v.lat, v.lon]));
  const GRID = 22;
  const latSpan = Math.max(b.getNorth() - b.getSouth(), 1e-6);
  const lonSpan = Math.max(b.getEast() - b.getWest(), 1e-6);
  const cellLat = latSpan / GRID, cellLon = lonSpan / GRID;
  const bins = new Map();
  pts.forEach(v=>{
    const r = Math.min(GRID-1, Math.floor((v.lat - b.getSouth()) / cellLat));
    const c = Math.min(GRID-1, Math.floor((v.lon - b.getWest()) / cellLon));
    const k = r + ':' + c;
    bins.set(k, (bins.get(k)||0) + 1);
  });
  const max = Math.max(...bins.values());
  bins.forEach((n, k)=>{
    const [r, c] = k.split(':').map(Number);
    const t = n / max;
    // Cool-to-warm, and deliberately never fully opaque: the imagery underneath
    // is the reason someone turned this on over a bare chart.
    const color = t > 0.75 ? '#EF4444' : t > 0.5 ? '#F59E0B' : t > 0.25 ? '#EAB308' : '#38BDF8';
    L.rectangle([
      [b.getSouth() + r*cellLat,       b.getWest() + c*cellLon],
      [b.getSouth() + (r+1)*cellLat,   b.getWest() + (c+1)*cellLon]
    ], {
      stroke:false, fillColor:color, fillOpacity: 0.12 + t*0.42, interactive:false
    }).addTo(atlasDensityLayer);
  });
}


function renderAtlasLegend(legendMap){
  const el = document.getElementById('atlasLegendBody');
  if (!el) return;
  const items = Array.from(legendMap.values());
  el.innerHTML = items.length
    ? items.map(i=>`<span class="map-legend-chip"><span class="map-legend-swatch">${legendGlyphSvg(i.geo,i.color,i.shape,i.lineStyle,i.filled)}</span>${escapeHtml(i.label)}</span>`).join('')
    : '<span class="atlas-legend-empty">Nothing on the map yet</span>';
}


// ══ FEATURE SHEET ══
// The bottom card a tap on a feature opens — the same pattern a map app uses,
// and the reason a full-screen map is worth having: there is finally room to
// show the photos, the readings and the attributes without a 260px popup
// covering the whole thing.
function atlasOpenSheet(featureId, vertexIndex){
  const f = savedFeatures.find(x=>x.id===featureId);
  const sheet = document.getElementById('atlasSheet');
  if (!f || !sheet) return;
  atlasSelectedId = featureId;
  const info = resolveFeatureType(f);
  const color = featureTypeColor(info.key);
  // Filtered once, here, so nothing below has to remember to. A feature can
  // legitimately have vertices with no coordinates — a CSV import whose lat/lon
  // columns were never mapped is the common case — and this sheet is exactly
  // where someone would go to find out why it is not on the map.
  const allVerts = f.vertices || [];
  const verts = allVerts.filter(x => x && x.lat != null && x.lon != null);
  const v = (vertexIndex != null) ? allVerts[vertexIndex] : null;
  const photos = v ? (v.photos||[]) : allVerts.flatMap(x=>x.photos||[]);
  const geo = f.geometryType || 'point';

  let measure = '';
  if (geo === 'line' && verts.length >= 2) measure = formatLength(lineLengthM(verts));
  else if (geo === 'polygon' && verts.length >= 3) measure = formatArea(polygonAreaAndPerimeterM(verts).area);

  const accVals = allVerts.map(x=>x.acc).filter(a=>a!=null && a>0);
  const avgAcc = accVals.length ? (accVals.reduce((s,a)=>s+a,0)/accVals.length) : null;

  const meta = [
    v ? `Vertex ${vertexIndex+1} of ${allVerts.length}` : `${allVerts.length} vertex${allVerts.length===1?'':'es'}`,
    measure,
    avgAcc != null ? '±' + formatLength(avgAcc) : '',
    photos.length ? `${photos.length} photo${photos.length===1?'':'s'}` : ''
  ].filter(Boolean).join(' · ');

  const coordSource = (v && v.lat != null && v.lon != null) ? v : verts[0];
  const coordLine = coordSource
    ? (function(){
        const shown = (typeof crsFormat === 'function') ? crsFormat(coordSource.lat, coordSource.lon)
                                                        : `${coordSource.lat.toFixed(6)}, ${coordSource.lon.toFixed(6)}`;
        return `<button type="button" class="atlas-sheet-coord" onclick="atlasCopyText('${shown.replace(/'/g, "\\'")}')">${escapeHtml(shown)}<span>copy</span></button>`;
      })()
    : `<div class="atlas-sheet-nocoord">This feature has no coordinates, so it cannot be drawn on the map. Usually an import whose latitude/longitude columns were not mapped.</div>`;

  const photoStrip = photos.length
    ? `<div class="atlas-sheet-photos">${photos.slice(0,8).map((p,i)=>
        `<img src="${photoThumbSrc(p)}" alt="${escapeHtml(p.angleLabel||'Photo')}" loading="lazy" decoding="async" onclick="openLightbox(atlasSheetPhotos,${i})">`
      ).join('')}${photos.length>8?`<button class="atlas-sheet-more" onclick="openLightbox(atlasSheetPhotos,8)">+${photos.length-8}</button>`:''}</div>`
    : '';

  const attrs = (v ? v.attrs : f.attrs) || {};
  const ft = getFeatureType(f.featureTypeId);
  const rows = (typeof popupAttrRows === 'function') ? popupAttrRows(ft, attrs, v ? 'vertex' : 'feature', 6, f.geometryType || 'point') : '';

  atlasSheetPhotos = photos;
  sheet.innerHTML = `
    <button class="atlas-sheet-grip" onclick="atlasCloseSheet()" aria-label="Close"></button>
    <div class="atlas-sheet-type" style="color:${color};">${escapeHtml(info.label)}</div>
    <div class="atlas-sheet-name">${escapeHtml(f.name || '(unnamed)')}${f.ref?` <span class="atlas-sheet-ref">#${escapeHtml(f.ref)}</span>`:''}</div>
    <div class="atlas-sheet-meta">${escapeHtml(meta)}</div>
    ${coordLine}
    ${rows}
    ${photoStrip}
    <div class="atlas-sheet-actions">
      <button class="atlas-sheet-btn" style="background:${color};color:${contrastText(color)};" onclick="atlasOpenDetails(${JSON.stringify(f.id)})">Details</button>
      <button class="atlas-sheet-btn ghost" onclick="atlasZoomTo(${JSON.stringify(f.id)})">Zoom to</button>
      <button class="atlas-sheet-btn ghost" onclick="atlasShowInList(${JSON.stringify(f.id)})">In list</button>
    </div>`;
  sheet.classList.add('show');
}

let atlasSheetPhotos = [];

function atlasCloseSheet(){
  const sheet = document.getElementById('atlasSheet');
  if (sheet) sheet.classList.remove('show');
  atlasSelectedId = null;
}

function atlasOpenDetails(id){
  // Inspect is a modal that layers above PlotAtlas, so the map stays where the
  // user left it when they close it again.
  if (typeof openInspect === 'function') openInspect(id);
}

function atlasZoomTo(id){
  const f = savedFeatures.find(x=>x.id===id);
  if (!f || !atlasMap) return;
  const verts = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
  if (!verts.length) return;
  if (verts.length === 1) atlasMap.setView([verts[0].lat, verts[0].lon], Math.max(atlasMap.getZoom(), 19));
  else atlasMap.fitBounds(L.latLngBounds(verts.map(v=>[v.lat,v.lon])), { padding:[70,70], maxZoom:19 });
}

function atlasShowInList(id){
  closePlotAtlas();
  if (typeof scrollToFeatureCard === 'function') scrollToFeatureCard(id);
}


// ══ MAP TAPS ══
function atlasOnMapClick(ev){
  if (atlasMeasureOn){ atlasAddMeasurePoint(ev.latlng); return; }
  // A tap on empty map dismisses whatever is open, matching every map app.
  atlasCloseSheet();
  atlasCloseBasemapSheet();
}


// ══ DROPPED PIN ══
function atlasDropPin(latlng){
  if (!atlasPinLayer) return;
  atlasPinLayer.clearLayers();
  // Projected where the project uses a grid; identical to the old output on a WGS84 project.
  const shownCoord = (typeof crsFormat === 'function') ? crsFormat(latlng.lat, latlng.lng) : null;
  const lat = latlng.lat.toFixed(6), lon = latlng.lng.toFixed(6);
  L.marker(latlng, {
    icon: L.divIcon({ className:'atlas-pin', html:'<div class="atlas-pin-dot"></div>', iconSize:[18,18], iconAnchor:[9,9] })
  }).addTo(atlasPinLayer);
  const bar = document.getElementById('atlasPinBar');
  if (bar){
    const pinText = shownCoord || `${lat}, ${lon}`;
    bar.innerHTML = `<span class="atlas-pin-coord">${escapeHtml(pinText)}</span>
      <button onclick="atlasCopyText('${pinText.replace(/'/g, "\\'")}')">Copy</button>
      <button onclick="atlasClearPin()">Clear</button>`;
    bar.classList.add('show');
  }
}

function atlasClearPin(){
  if (atlasPinLayer) atlasPinLayer.clearLayers();
  const bar = document.getElementById('atlasPinBar');
  if (bar) bar.classList.remove('show');
}

function atlasCopyText(text){
  const done = ()=>showToast('Copied ' + text);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}


// ══ MEASURE ══
// Tap-to-measure: two or more points give a running distance, three or more
// also give an enclosed area. Uses the same geodesic helpers as the capture
// screen's live readout, so a measurement here and a measurement there can
// never disagree.
function atlasToggleMeasure(){
  atlasMeasureOn = !atlasMeasureOn;
  if (!atlasMeasureOn) atlasClearMeasure();
  else showToast('Tap the map to measure. Tap the tool again to finish.');
  const readout = document.getElementById('atlasMeasure');
  if (readout) readout.classList.toggle('show', atlasMeasureOn);
  atlasSyncToolStates();
}

function atlasAddMeasurePoint(latlng){
  atlasMeasurePoints.push({ lat: latlng.lat, lon: latlng.lng });
  atlasRedrawMeasure();
}

function atlasUndoMeasurePoint(){
  atlasMeasurePoints.pop();
  atlasRedrawMeasure();
}

function atlasClearMeasure(){
  atlasMeasurePoints = [];
  if (atlasMeasureLayer) atlasMeasureLayer.clearLayers();
  const el = document.getElementById('atlasMeasureText');
  if (el) el.textContent = 'Tap the map to start measuring';
}

function atlasRedrawMeasure(){
  if (!atlasMeasureLayer) return;
  atlasMeasureLayer.clearLayers();
  const pts = atlasMeasurePoints;
  const latlngs = pts.map(p=>[p.lat, p.lon]);
  if (latlngs.length >= 2){
    L.polyline(latlngs, { color:'#F59E0B', weight:3, dashArray:'6 5' }).addTo(atlasMeasureLayer);
  }
  if (latlngs.length >= 3){
    L.polygon(latlngs, { color:'#F59E0B', weight:1, fillColor:'#F59E0B', fillOpacity:0.14, interactive:false }).addTo(atlasMeasureLayer);
  }
  latlngs.forEach(ll => L.circleMarker(ll, { radius:5, color:'#fff', weight:2, fillColor:'#F59E0B', fillOpacity:1, interactive:false }).addTo(atlasMeasureLayer));
  const el = document.getElementById('atlasMeasureText');
  if (!el) return;
  if (pts.length < 2){ el.textContent = pts.length ? '1 point — tap again for a distance' : 'Tap the map to start measuring'; return; }
  const bits = [formatLength(lineLengthM(pts))];
  if (pts.length >= 3) bits.push(formatArea(polygonAreaAndPerimeterM(pts).area));
  bits.push(`${pts.length} points`);
  el.textContent = bits.join(' · ');
}


// ══ LOCATE ══
function atlasLocate(){
  if (!atlasMap) return;
  if (!navigator.geolocation){ showToast('This device has no geolocation'); return; }
  showToast('Finding your position…');
  navigator.geolocation.getCurrentPosition(pos=>{
    const { latitude, longitude, accuracy } = pos.coords;
    if (atlasLocateMarker) atlasMap.removeLayer(atlasLocateMarker);
    atlasLocateMarker = L.layerGroup([
      L.circle([latitude, longitude], { radius: Math.max(accuracy||0, 3), color:'#3B82F6', weight:1, fillColor:'#3B82F6', fillOpacity:0.14, interactive:false }),
      L.circleMarker([latitude, longitude], { radius:7, color:'#fff', weight:3, fillColor:'#3B82F6', fillOpacity:1, interactive:false })
    ]).addTo(atlasMap);
    atlasMap.setView([latitude, longitude], Math.max(atlasMap.getZoom(), 17));
    showToast(`You are here · ±${(accuracy||0).toFixed(0)}m`);
  }, err=>{
    showToast(err && err.code === 1 ? 'Location permission denied' : 'Could not get a position fix');
  }, { enableHighAccuracy:true, timeout:12000, maximumAge:5000 });
}


// ══ FIT ══
function atlasFitData(quiet){
  if (!atlasMap) return;
  const pts = [];
  savedFeatures.forEach(f=>{
    const info = resolveFeatureType(f);
    if (typeof hiddenLayerKeys !== 'undefined' && hiddenLayerKeys.has(info.key)) return;
    (f.vertices||[]).forEach(v=>{ if (v.lat!=null && v.lon!=null) pts.push([v.lat, v.lon]); });
  });
  if (!pts.length){
    const p = projects.find(x=>x.id===activeProjectId);
    if (p && p.siteLat!=null && p.siteLon!=null) atlasMap.setView([p.siteLat, p.siteLon], 14);
    else if (!quiet) showToast('Nothing captured yet to zoom to');
    return;
  }
  if (pts.length === 1) atlasMap.setView(pts[0], 18);
  else atlasMap.fitBounds(L.latLngBounds(pts), { padding:[60,60], maxZoom:19 });
}


// ══ SEARCH ══
// Filters what is drawn rather than jumping to one result: on a survey the
// question is usually "show me only the manholes", not "find manhole 7".
function atlasOnSearch(value){
  atlasSearchQuery = String(value||'').trim().toLowerCase();
  renderPlotAtlas();
  const clear = document.getElementById('atlasSearchClear');
  if (clear) clear.style.display = atlasSearchQuery ? 'flex' : 'none';
}

function atlasClearSearch(){
  const input = document.getElementById('atlasSearchInput');
  if (input) input.value = '';
  atlasOnSearch('');
}


// ══ LAYERS ══
// Deliberately reuses the existing layer modal rather than growing a second
// list: hidden layers are one set of state shared by the Review map, the
// exports and this screen, and two lists that can disagree is how a feature
// goes missing from an export nobody checked.
function atlasOpenLayers(){
  if (typeof openLayerModal === 'function') openLayerModal();
}
