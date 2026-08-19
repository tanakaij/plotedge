// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Geodesic maths, projections, area/length, coordinate conversion
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══════════════════════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════════════════
function peShowResult(title, lines, note){
  const el = document.getElementById('peResult');
  if (!el) return;
  el.innerHTML = `<div class="pe-result">
    <div class="pe-result-title">${escapeHtml(title)}</div>
    ${lines.map(l=>`<div class="pe-result-line">${l}</div>`).join('')}
    ${note?`<div class="pe-result-note">${escapeHtml(note)}</div>`:''}
  </div>`;
  el.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function peRequireSelected(){
  const s = peSelected();
  if (!s) showToast('Select a sketch first');
  return s;
}


// ── MEASURE ── exact: haversine geodesics, not the projected plane used by the raster ops.
function peMeasure(){
  const s = peRequireSelected(); if (!s) return;
  const v = s.vertices;
  const lines = [`Type      ${s.type}`, `Vertices  ${v.length}`];
  if (s.type==='point'){
    // Labelled from the CRS itself rather than hardcoded "Lat/Lon", so a Gauss belt shows Y/X in
    // the order its own axes are quoted — printing an easting under a heading that says "Lat" is
    // how a coordinate ends up entered in the wrong field.
    const pr = (typeof crsProject === 'function') ? crsProject(v[0].lat, v[0].lon) : null;
    if (pr && pr.units !== 'degrees') lines.push(`${pr.yLabel}  ${pr.y.toFixed(3)}`, `${pr.xLabel}  ${pr.x.toFixed(3)}`);
    else lines.push(`Lat       ${v[0].lat.toFixed(6)}`, `Lon       ${v[0].lon.toFixed(6)}`);
  } else if (s.type==='polygon'){
    // Deliberately no "Length" row here. lineLengthM() walks an open path, so on a closed ring it
    // returns the perimeter minus the closing edge — a number that looks authoritative, sits right
    // above the real Perimeter, and means nothing. Same reason Span/Bearing are line-only: on a
    // ring, start→end is just whichever edge happens to close it.
    const r = polygonAreaAndPerimeterM(v);
    lines.push(`Perimeter ${formatLength(r.perimeter)}`);
    lines.push(`Area      ${formatArea(r.area)}`);
  } else {
    lines.push(`Length    ${formatLength(lineLengthM(v))}`);
    const a=v[0], b=v[v.length-1];
    lines.push(`Span      ${formatLength(haversineM(a.lat,a.lon,b.lat,b.lon))}`);
    lines.push(`Bearing   ${peBearing(a,b).toFixed(1)}° (start→end)`);
  }
  peShowResult(`Measure: ${s.name}`, lines);
}

// Initial great-circle bearing, normalised to 0–360.
function peBearing(a, b){
  const toRad=d=>d*Math.PI/180;
  const y = Math.sin(toRad(b.lon-a.lon))*Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat))*Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.cos(toRad(b.lon-a.lon));
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}


// ── CENTROID ── area-weighted for polygons (not the vertex mean, which drags toward whichever
// edge happens to be most finely digitized), length-weighted midpoint for lines.
function peCentroid(){
  const s = peRequireSelected(); if (!s) return;
  let c;
  if (s.type==='point'){
    c = { lat:s.vertices[0].lat, lon:s.vertices[0].lon };
  } else if (s.type==='polygon'){
    const proj = peProjector(s.vertices);
    const p = s.vertices.map(proj.fwd);
    let a=0, cx=0, cy=0;
    for (let i=0;i<p.length;i++){
      const q=p[i], r=p[(i+1)%p.length];
      const f = q.x*r.y - r.x*q.y;
      a += f; cx += (q.x+r.x)*f; cy += (q.y+r.y)*f;
    }
    a *= 0.5;
    c = Math.abs(a) < 1e-9
      ? proj.inv({ x:p.reduce((s2,q)=>s2+q.x,0)/p.length, y:p.reduce((s2,q)=>s2+q.y,0)/p.length })
      : proj.inv({ x:cx/(6*a), y:cy/(6*a) });
  } else {
    const half = lineLengthM(s.vertices)/2;
    let run = 0; c = { lat:s.vertices[0].lat, lon:s.vertices[0].lon };
    for (let i=1;i<s.vertices.length;i++){
      const a=s.vertices[i-1], b=s.vertices[i];
      const d = haversineM(a.lat,a.lon,b.lat,b.lon);
      if (run + d >= half){
        const t = d===0 ? 0 : (half-run)/d;
        c = { lat:a.lat+(b.lat-a.lat)*t, lon:a.lon+(b.lon-a.lon)*t };
        break;
      }
      run += d;
    }
  }
  peAddSketch('point', [c], `${s.name} centroid`, { derived:true, note:'centroid' });
  const cp = (typeof crsProject === 'function') ? crsProject(c.lat, c.lon) : null;
  const cLines = (cp && cp.units !== 'degrees')
    ? [`${cp.yLabel}  ${cp.y.toFixed(3)}`, `${cp.xLabel}  ${cp.x.toFixed(3)}`]
    : [`Lat  ${c.lat.toFixed(6)}`, `Lon  ${c.lon.toFixed(6)}`];
  peShowResult(`Centroid: ${s.name}`, cLines, 'Added as a new derived sketch.');
}


// ── CONVEX HULL ── exact.
function peConvexHull(){
  const s = peRequireSelected(); if (!s) return;
  if (s.vertices.length < 3){ showToast('Need at least 3 vertices for a hull'); return; }
  const proj = peProjector(s.vertices);
  const hull = peConvexHullXY(s.vertices.map(proj.fwd)).map(proj.inv);
  if (hull.length < 3){ showToast('Those vertices are collinear, no hull'); return; }
  const r = polygonAreaAndPerimeterM(hull);
  const area = r.area!=null?r.area:r.areaSqm;
  peAddSketch('polygon', hull, `${s.name} hull`, { derived:true, note:'convex hull' });
  peShowResult(`Convex hull: ${s.name}`, [
    `Input     ${s.vertices.length} vertices`,
    `Hull      ${hull.length} vertices`,
    `Area      ${formatArea(area)}`
  ], 'Added as a new derived sketch.');
}


// ── BUFFER ── raster engine; see peRasterOp.
function openBufferModal(){
  if (!peSelected()){ showToast('Select a sketch first'); return; }
  document.getElementById('bufferModal').classList.add('show');
}

function closeBufferModal(){ document.getElementById('bufferModal').classList.remove('show'); }

function runBuffer(){
  const s = peSelected(); if (!s){ closeBufferModal(); return; }
  const dist = parseFloat(document.getElementById('bufferDistInput').value);
  if (!isFinite(dist) || dist <= 0){ showToast('Enter a distance greater than zero'); return; }
  closeBufferModal();
  const proj = peProjector(s.vertices);
  const pts = s.vertices.map(proj.fwd);
  const closed = s.type==='polygon';
  const inside = p => {
    if (s.type==='point') return pts.some(q=>Math.hypot(p.x-q.x,p.y-q.y) <= dist);
    if (closed && pePointInRingXY(p, pts)) return true;
    const n = pts.length;
    const last = closed ? n : n-1;
    for (let i=0;i<last;i++){
      if (peDistToSeg(p, pts[i], pts[(i+1)%n]) <= dist) return true;
    }
    return false;
  };
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const bbox = { minX:Math.min(...xs), maxX:Math.max(...xs), minY:Math.min(...ys), maxY:Math.max(...ys) };
  const out = peRasterOp(inside, bbox, proj, dist*1.25);
  if (!out.rings.length){ showToast('Buffer produced no area'); return; }
  const ring = out.rings[0];
  const r = polygonAreaAndPerimeterM(ring);
  peAddSketch('polygon', ring, `${s.name} +${dist}m`, { derived:true, note:`buffer ${dist}m` });
  peShowResult(`Buffer: ${s.name}`, [
    `Distance  ${formatLength(dist)}`,
    `Area      ${formatArea(r.area!=null?r.area:r.areaSqm)}`,
    `Vertices  ${ring.length}`
  ], `Grid-sampled at about ${out.cell.toFixed(1)} m per cell, so the boundary is accurate to roughly that. Fine for planning, not for cadastral work.`);
}


// ── POINT IN POLYGON ── exact. Tests every point sketch AND every saved point feature against the
// selected polygon, since "which of the things I collected fall inside this boundary" is the
// question that actually gets asked in the field.
function pePointInPolygon(){
  const s = peRequireSelected(); if (!s) return;
  if (s.type!=='polygon'){ showToast('Select a polygon sketch first'); return; }
  const insideSketches = plotetchSketches.filter(x=>x.type==='point' && pointInPolygonLL(x.vertices[0].lat, x.vertices[0].lon, s.vertices));
  const insideFeatures = [];
  savedFeatures.forEach(f=>{
    if ((f.geometryType||'point')!=='point') return;
    (f.vertices||[]).forEach(v=>{
      if (pointInPolygonLL(v.lat, v.lon, s.vertices)) { insideFeatures.push(f.name||'(unnamed)'); }
    });
  });
  const totalPts = plotetchSketches.filter(x=>x.type==='point').length;
  const lines = [
    `Sketch points   ${insideSketches.length} / ${totalPts} inside`,
    `Saved features  ${insideFeatures.length} inside`
  ];
  const names = [...insideSketches.map(x=>x.name), ...new Set(insideFeatures)];
  if (names.length) lines.push('', ...names.slice(0,12).map(n=>`  · ${escapeHtml(n)}`));
  if (names.length>12) lines.push(`  …and ${names.length-12} more`);
  peShowResult(`Points in ${s.name}`, lines, 'Exact ray-casting test, no approximation here.');
}


// ── INTERSECT / CLIP ── raster engine again; both are just different predicates over the same
// two polygons, which is exactly why they share one code path.
function peOverlay(kind){
  const a = peSelected();
  if (!a){ showToast('Select polygon A first'); return; }
  if (a.type!=='polygon'){ showToast('Select a polygon sketch first'); return; }
  const others = plotetchSketches.filter(s=>s.type==='polygon' && s.id!==a.id);
  if (!others.length){ showToast('Digitize a second polygon to overlay against'); return; }
  // B is the most recently added other polygon — with two on screen (the common case) that's
  // unambiguous, and the result names both so there's no doubt which way round it ran.
  const b = others[others.length-1];
  const all = a.vertices.concat(b.vertices);
  const proj = peProjector(all);
  const pa = a.vertices.map(proj.fwd), pb = b.vertices.map(proj.fwd);
  const pred = kind==='intersect'
    ? (p => pePointInRingXY(p,pa) && pePointInRingXY(p,pb))
    : (p => pePointInRingXY(p,pa) && !pePointInRingXY(p,pb));
  const xs=all.map(v=>proj.fwd(v).x), ys=all.map(v=>proj.fwd(v).y);
  const bbox = { minX:Math.min(...xs), maxX:Math.max(...xs), minY:Math.min(...ys), maxY:Math.max(...ys) };
  const out = peRasterOp(pred, bbox, proj, Math.max((bbox.maxX-bbox.minX),(bbox.maxY-bbox.minY))*0.02);
  if (!out.rings.length){
    peShowResult(kind==='intersect'?'Intersect':'Clip (A−B)', [
      `A  ${escapeHtml(a.name)}`,
      `B  ${escapeHtml(b.name)}`,
      '',
      kind==='intersect' ? 'No overlap between these polygons.' : 'A is entirely inside B, nothing remains.'
    ]);
    return;
  }
  const ring = out.rings[0];
  const r = polygonAreaAndPerimeterM(ring);
  const area = r.area!=null?r.area:r.areaSqm;
  const ra = polygonAreaAndPerimeterM(a.vertices);
  const aArea = ra.area!=null?ra.area:ra.areaSqm;
  const label = kind==='intersect' ? `${a.name} ∩ ${b.name}` : `${a.name} − ${b.name}`;
  peAddSketch('polygon', ring, label, { derived:true, note:kind });
  peShowResult(kind==='intersect'?'Intersect':'Clip (A−B)', [
    `A         ${escapeHtml(a.name)}`,
    `B         ${escapeHtml(b.name)}`,
    `Result    ${formatArea(area)}`,
    `% of A    ${aArea>0 ? ((area/aArea)*100).toFixed(1) : '—'}%`,
    `Parts     ${out.rings.length}`
  ], `Grid-sampled at about ${out.cell.toFixed(1)} m per cell. Only the largest part was kept as a sketch.`);
}


// ══════════════════════════════════════════════════════════════════════════════════════════
// LAYER MANAGER
// ══════════════════════════════════════════════════════════════════════════════════════════
// Feature types ARE the layers here — inventing a separate grouping would mean two overlapping
// concepts for the same thing. Visibility is a session-level display filter held in memory rather
// than persisted: a hidden layer that stayed hidden across restarts is the classic way to lose
// track of data you still have, and the cost of re-hiding is one tap.
let hiddenLayerKeys = new Set();

function openLayerModal(){
  renderLayerModal();
  document.getElementById('layerModal').classList.add('show');
}

function closeLayerModal(){ document.getElementById('layerModal').classList.remove('show'); }

function layerInventory(){
  const map = new Map();
  savedFeatures.forEach(f=>{
    const info = resolveFeatureType(f);
    const key = info.key;
    if (!map.has(key)) map.set(key, { key, label:info.label, color:featureTypeColor(key), count:0, verts:0 });
    const e = map.get(key);
    e.count++; e.verts += (f.vertices||[]).length;
  });
  return Array.from(map.values()).sort((a,b)=>b.count-a.count);
}

function renderLayerModal(){
  const el = document.getElementById('layerModalList');
  if (!el) return;
  const items = layerInventory();
  if (!items.length){
    el.innerHTML = '<div class="pe-empty">No features captured yet, so there are no layers to manage.</div>';
    return;
  }
  el.innerHTML = items.map(it=>{
    const on = !hiddenLayerKeys.has(it.key);
    return `<div class="lm-row">
      <span class="lm-swatch" style="background:${it.color}"></span>
      <div class="lm-body">
        <div class="lm-name">${escapeHtml(it.label)}</div>
        <div class="lm-meta">${it.count} feature${it.count===1?'':'s'} · ${it.verts} vertices</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" ${on?'checked':''} onchange="toggleLayer('${escapeHtml(it.key)}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
    </div>`;
  }).join('');
}

function toggleLayer(key, visible){
  if (visible) hiddenLayerKeys.delete(key); else hiddenLayerKeys.add(key);
  renderReviewMap();
  updateLayerBtnState();
}

function showAllLayers(){
  hiddenLayerKeys.clear();
  renderLayerModal();
  renderReviewMap();
  updateLayerBtnState();
  showToast('All layers shown');
}

// The map button carries a count when anything is hidden, so a filtered map can never be mistaken
// for an empty one — the single most confusing state a layer control can leave you in.
function updateLayerBtnState(){
  const lbl = document.getElementById('mapLayerToggleLabel');
  if (lbl) lbl.textContent = hiddenLayerKeys.size ? `${hiddenLayerKeys.size} hidden` : 'Layers';
}


// ══════════════════════════════════════════════════════════════════════════════════════════
// GO TO COORDINATE / FEATURE SEARCH
// ══════════════════════════════════════════════════════════════════════════════════════════
function openGotoModal(){
  document.getElementById('gotoCoordInput').value = '';
  document.getElementById('gotoSearchInput').value = '';
  document.getElementById('gotoResults').innerHTML = '';
  document.getElementById('gotoDestChooser').style.display = 'none';
  _gotoPendingCoord = null;
  _gotoPendingFeatureId = null;
  document.getElementById('gotoModal').classList.add('show');
  focusWhenSettled('gotoCoordInput');
}

function closeGotoModal(){ document.getElementById('gotoModal').classList.remove('show'); }

// Set by gotoCoordinate()/gotoFeature() when neither PlotEtch nor PlotAtlas is the screen
// underneath (e.g. opened from Quick Actions) — held here until gotoResolveDestination() picks
// where to send the user, rather than silently defaulting to Review.
let _gotoPendingCoord = null;

let _gotoPendingFeatureId = null;


// Accepts decimal degrees ("-17.82, 31.03") and DMS ("17°49'30.7\"S 31°02'00.6\"E"), because field
// coordinates arrive in whichever of the two the source system happened to use and retyping one
// as the other by hand is exactly where transcription errors come from.
function parseCoordInput(raw){
  const s = String(raw||'').trim();
  if (!s) return null;
  const dec = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (dec){
    const lat = parseFloat(dec[1]), lon = parseFloat(dec[2]);
    if (Math.abs(lat)<=90 && Math.abs(lon)<=180) return { lat, lon };
    return null;
  }
  const dmsRe = /(\d+(?:\.\d+)?)\s*[°d:]\s*(?:(\d+(?:\.\d+)?)\s*['m:]\s*)?(?:(\d+(?:\.\d+)?)\s*["s]?\s*)?([NSEW])/gi;
  const found = [];
  let m;
  while ((m = dmsRe.exec(s)) !== null){
    const deg = parseFloat(m[1]) + (parseFloat(m[2])||0)/60 + (parseFloat(m[3])||0)/3600;
    const hemi = m[4].toUpperCase();
    found.push({ v: (hemi==='S'||hemi==='W') ? -deg : deg, axis: (hemi==='N'||hemi==='S') ? 'lat' : 'lon' });
  }
  if (found.length===2){
    const lat = found.find(f=>f.axis==='lat'), lon = found.find(f=>f.axis==='lon');
    if (lat && lon && Math.abs(lat.v)<=90 && Math.abs(lon.v)<=180) return { lat:lat.v, lon:lon.v };
  }
  return null;
}

function gotoCoordinate(){
  const raw = document.getElementById('gotoCoordInput').value;
  let c = parseCoordInput(raw);
  // Grid coordinates, if the project is working in one. A crew handed an easting/northing by the
  // office should be able to type it in as given, rather than converting it by hand first — which
  // is both a chore and a place to make an error nobody would catch.
  // Tried only AFTER lat/lon parsing fails, so a legitimate lat/lon is never reinterpreted as a
  // grid pair by a project that happens to have a CRS set.
  if (!c && typeof crsUnproject === 'function'){
    const pair = String(raw).split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
    if (pair.length === 2){
      // Entered in the order the axes are LABELLED, which for a south-oriented Gauss belt is
      // Y then X — the reverse of easting/northing. Reading them the other way round puts the
      // point in the wrong hemisphere, so the order follows what the read-out shows.
      const g = crsUnproject(pair[0], pair[1]);
      if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon) &&
          Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180){
        c = g;
        showToast('Read as ' + (typeof projectCrs === 'function' ? projectCrs().label : 'grid') + ' coordinates');
      }
    }
  }
  if (!c){ showToast('Couldn\'t read that coordinate'); return; }
  // Whichever map the user is actually looking at is the one that should move — PlotAtlas is an
  // overlay (not a `.view`), so it has to be checked explicitly before the `.view.active` check
  // below, or opening Go To from inside PlotAtlas would silently boot the user out to Review.
  const onPlotAtlas = (typeof plotAtlasIsOpen === 'function') && plotAtlasIsOpen();
  const onPlotEtch = document.getElementById('view-plotetch').classList.contains('active');
  if (onPlotAtlas && typeof atlasMap !== 'undefined' && atlasMap){
    closeGotoModal();
    atlasMap.setView([c.lat, c.lon], 18);
    if (typeof atlasDropPin === 'function') atlasDropPin({ lat:c.lat, lng:c.lon });
    showToast(`Moved to ${(typeof crsFormat === 'function') ? crsFormat(c.lat, c.lon) : c.lat.toFixed(5) + ', ' + c.lon.toFixed(5)}`);
  } else if (onPlotEtch && peMap){
    closeGotoModal();
    peMap.setView([c.lat, c.lon], 18);
    L.circleMarker([c.lat,c.lon],{radius:9,color:'#F59E0B',weight:3,fillOpacity:0}).addTo(peDraftGroup);
    showToast(`Moved to ${(typeof crsFormat === 'function') ? crsFormat(c.lat, c.lon) : c.lat.toFixed(5) + ', ' + c.lon.toFixed(5)}`);
  } else {
    // Opened from somewhere with no map underneath it (Quick Actions, Dashboard, …) — ask which
    // map should open instead of guessing Review every time.
    _gotoPendingCoord = c;
    _gotoPendingFeatureId = null;
    document.getElementById('gotoDestChooser').style.display = 'block';
  }
}

function renderGotoResults(){
  const q = document.getElementById('gotoSearchInput').value.trim().toLowerCase();
  const el = document.getElementById('gotoResults');
  if (!q){ el.innerHTML=''; return; }
  const hits = savedFeatures.filter(f=>
    (f.name||'').toLowerCase().includes(q) || (f.ref||'').toLowerCase().includes(q)
  ).slice(0, 8);
  if (!hits.length){ el.innerHTML = '<div class="pe-empty">No features match that.</div>'; return; }
  el.innerHTML = hits.map(f=>{
    const info = resolveFeatureType(f);
    return `<div class="pe-sketch" onclick="gotoFeature(${JSON.stringify(f.id)})">
      <span class="pe-sketch-chip" style="background:${featureTypeColor(info.key)}"></span>
      <div class="pe-sketch-body">
        <div class="pe-sketch-name">${escapeHtml(f.name||'(unnamed)')}</div>
        <div class="pe-sketch-meta">${escapeHtml(info.label)}${f.ref?' · '+escapeHtml(f.ref):''}</div>
      </div>
    </div>`;
  }).join('');
}

function gotoFeature(id){
  const f = savedFeatures.find(x=>String(x.id)===String(id));
  if (!f) return;
  const verts = f.vertices||[];
  if (!verts.length){ closeGotoModal(); showToast('That feature has no geometry'); return; }
  // Same PlotAtlas-first check as gotoCoordinate() above — stay on the map the user actually
  // opened Go To from, rather than always jumping to the Review tab underneath it.
  const onPlotAtlas = (typeof plotAtlasIsOpen === 'function') && plotAtlasIsOpen();
  const onPlotEtch = document.getElementById('view-plotetch').classList.contains('active');
  if (onPlotAtlas && typeof atlasMap !== 'undefined' && atlasMap){
    closeGotoModal();
    const b = verts.map(v=>[v.lat,v.lon]);
    b.length===1 ? atlasMap.setView(b[0], 18) : atlasMap.fitBounds(b, { padding:[60,60], maxZoom:19 });
    if (typeof atlasOpenSheet === 'function') atlasOpenSheet(f.id);
    return;
  }
  if (onPlotEtch && peMap){
    closeGotoModal();
    const b = verts.map(v=>[v.lat,v.lon]);
    b.length===1 ? peMap.setView(b[0], 18) : peMap.fitBounds(b, { padding:[36,36] });
    return;
  }
  // No map screen underneath (Quick Actions, Dashboard, …) — ask which one should open.
  _gotoPendingFeatureId = f.id;
  _gotoPendingCoord = null;
  document.getElementById('gotoDestChooser').style.display = 'block';
}

// Fires once the user picks PlotEtch / PlotAtlas / Review from the chooser shown when Go To was
// opened from a screen with no map underneath it (see gotoCoordinate()/gotoFeature() above).
function gotoResolveDestination(dest){
  const coord = _gotoPendingCoord;
  const feature = _gotoPendingFeatureId != null ? savedFeatures.find(x=>String(x.id)===String(_gotoPendingFeatureId)) : null;
  closeGotoModal();
  _gotoPendingCoord = null;
  _gotoPendingFeatureId = null;
  if (!coord && !feature) return;

  if (dest === 'review'){
    switchTab('review');
    setTimeout(()=>{
      if (!reviewMap) return;
      if (coord) reviewMap.setView([coord.lat, coord.lon], 18);
      else {
        const b = (feature.vertices||[]).map(v=>[v.lat,v.lon]);
        b.length===1 ? reviewMap.setView(b[0], 18) : reviewMap.fitBounds(b, { padding:[40,40] });
      }
    }, 120);
  } else if (dest === 'plotetch'){
    openPlotEtch();
    // Longer delay than the in-view case above — openPlotEtch() is doing its own async map setup
    // (ensurePlotEtchMap + its own fitBounds), and this needs to win the race and land last.
    setTimeout(()=>{
      if (!peMap) return;
      if (coord){
        peMap.setView([coord.lat, coord.lon], 18);
        L.circleMarker([coord.lat,coord.lon],{radius:9,color:'#F59E0B',weight:3,fillOpacity:0}).addTo(peDraftGroup);
      } else {
        const b = (feature.vertices||[]).map(v=>[v.lat,v.lon]);
        b.length===1 ? peMap.setView(b[0], 18) : peMap.fitBounds(b, { padding:[36,36] });
      }
    }, 220);
  } else if (dest === 'plotatlas'){
    openPlotAtlas();
    setTimeout(()=>{
      if (typeof atlasMap === 'undefined' || !atlasMap) return;
      if (coord){
        atlasMap.setView([coord.lat, coord.lon], 18);
        if (typeof atlasDropPin === 'function') atlasDropPin({ lat:coord.lat, lng:coord.lon });
      } else {
        const b = (feature.vertices||[]).map(v=>[v.lat,v.lon]);
        b.length===1 ? atlasMap.setView(b[0], 18) : atlasMap.fitBounds(b, { padding:[60,60], maxZoom:19 });
        if (typeof atlasOpenSheet === 'function') atlasOpenSheet(feature.id);
      }
    }, 260);
  }
  if (coord) showToast(`Moved to ${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`);
}


// ══════════════════════════════════════════════════════════════════════════════════════════
// FEATURE INSPECTOR
// ══════════════════════════════════════════════════════════════════════════════════════════
let _inspectId = null;

function openInspect(id){
  const f = savedFeatures.find(x=>String(x.id)===String(id));
  if (!f){ showToast('That feature no longer exists'); return; }
  _inspectId = f.id;
  const info = resolveFeatureType(f);
  const color = featureTypeColor(info.key);
  const verts = f.vertices||[];
  const geo = f.geometryType||'point';

  const stats = [['Geometry', geo.charAt(0).toUpperCase()+geo.slice(1)], ['Vertices', String(verts.length)]];
  if (geo==='line' && verts.length>=2) stats.push(['Length', formatLength(lineLengthM(verts))]);
  if (geo==='polygon' && verts.length>=3){
    const r = polygonAreaAndPerimeterM(verts);
    stats.push(['Area', formatArea(r.area)], ['Perimeter', formatLength(r.perimeter)]);
  }
  const accs = verts.map(v=>v.acc).filter(a=>a!=null && isFinite(a));
  if (accs.length) stats.push(['Best acc', formatLength(Math.min(...accs))]);
  const photoCount = verts.reduce((s,v)=>s+((v.photos||[]).length),0);
  if (photoCount) stats.push(['Photos', String(photoCount)]);

  // The feature type's own declared fields first and in schema order, then anything else present
  // on the record (auto-computed geometry attrs, imported columns) so nothing is silently hidden.
  const ft = getFeatureType(f.featureTypeId);
  const attrs = f.attrs || {};
  const rows = [];
  const seen = new Set();
  if (ft) ft.fields.filter(fl=>featureFieldScope(fl,f)!=='vertex').forEach(fl=>{
    seen.add(fl.id);
    rows.push([fl.label, formatAttrValue(attrs[fl.id], fl)]);
  });
  Object.keys(attrs).forEach(k=>{ if (!seen.has(k)) rows.push([k, formatAttrValue(attrs[k])]); });

  document.getElementById('inspectBody').innerHTML = `
    <div class="fi-head">
      <span class="fi-chip" style="background:${color}"></span>
      <div style="min-width:0;">
        <div class="fi-title">${escapeHtml(f.name||'(unnamed)')}</div>
        <div class="fi-sub">${escapeHtml(info.label)}${f.ref?' · '+escapeHtml(f.ref):''}${f.assignedTo?' · '+escapeHtml(f.assignedTo):''}</div>
      </div>
    </div>
    <div class="fi-grid">
      ${stats.map(([k,v])=>`<div class="fi-stat"><div class="fi-stat-lbl">${escapeHtml(k)}</div><div class="fi-stat-val">${escapeHtml(v)}</div></div>`).join('')}
    </div>
    ${rows.length ? `<div class="pe-result-title" style="margin-bottom:4px;">Attributes</div>${
      rows.map(([k,v])=>`<div class="fi-attr"><span class="fi-attr-k">${escapeHtml(k)}</span><span class="fi-attr-v">${escapeHtml(v)}</span></div>`).join('')
    }` : ''}
    ${f.notes ? `<div class="pe-result-title" style="margin:14px 0 4px;">Notes</div><div class="help-p">${escapeHtml(f.notes)}</div>` : ''}
    <div class="pe-result" style="margin-top:14px;">
      <div class="pe-result-title">First vertex</div>
      ${verts.length ? `<div class="pe-result-line">${verts[0].lat.toFixed(6)}, ${verts[0].lon.toFixed(6)}</div>` : '<div class="pe-result-line">—</div>'}
      <div class="pe-result-note">Saved ${f.savedAt ? escapeHtml(new Date(f.savedAt).toLocaleString()) : 'unknown'}${f.editedAt ? ` · edited ${escapeHtml(new Date(f.editedAt).toLocaleString())}` : ''}</div>
    </div>`;
  const editBtn = document.getElementById('inspectEditBtn');
  editBtn.onclick = () => { closeInspect(); if (typeof editFeature==='function') editFeature(f.id); };
  document.getElementById('inspectModal').classList.add('show');
}

function closeInspect(){ document.getElementById('inspectModal').classList.remove('show'); _inspectId=null; }

function formatAttrValue(v, fieldDef){
  if (v===null || v===undefined || v==='') return '—';
  if (Array.isArray(v)){
    if (!v.length) return '—';
    if (typeof v[0] === 'object' && v[0] !== null){
      // A repeating-group value. With the field def (and so its sub-field labels) available, show
      // "Label: value" pairs per entry; without it, fall back to sub-field ids so the value is
      // still legible rather than "[object Object]".
      const subLabel = id => (fieldDef && fieldDef.subfields ? (fieldDef.subfields.find(s=>s.id===id)||{}).label : null) || id;
      return v.map(inst => Object.entries(inst||{})
        .filter(([,sv]) => sv!=null && sv!=='' && !(Array.isArray(sv)&&!sv.length))
        .map(([sk,sv])=>`${subLabel(sk)}: ${Array.isArray(sv)?sv.join(', '):(sv===true?'Yes':sv===false?'No':sv)}`)
        .join(', ')).join(' | ');
    }
    return v.join(', ');
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}


// ══════════════════════════════════════════════════════════════════════════════════════════
// HELP & ABOUT
// ══════════════════════════════════════════════════════════════════════════════════════════
function openHelp(){
  const el = document.getElementById('helpVersion');
  if (el){
    let bytes = 0;
    try { bytes = (localStorage.getItem(STORAGE_KEY)||'').length; } catch(e){}
    const kb = bytes ? (bytes/1024).toFixed(0) : '0';
    el.textContent = `PlotEdge · ${projects.length} project${projects.length===1?'':'s'} on this device · about ${kb} KB stored`;
  }
  document.getElementById('helpModal').classList.add('show');
}

function closeHelp(){ document.getElementById('helpModal').classList.remove('show'); }



// ══════════════════════════════════════════════════════════════════════════════════════════
// QUICK ACTIONS REGISTRY
// ══════════════════════════════════════════════════════════════════════════════════════════
// The dashboard grid and the More drawer are now two renderings of one list rather than two
// hand-maintained blocks of markup. That's what makes them customisable at all: "visible" is just
// a set of ids, everything not in it falls through to the drawer automatically, and neither list
// can drift out of sync with the other or accidentally show the same action twice.
const QA_REGISTRY = [
  { id:'featuretypes', group:'Set up', label:'Feature Types',   run:()=>showFeatureTypes(),
    desc:'Define what this project captures, fields, geometry, validation',
    icon:'<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 12 10 5 6-3"/><circle cx="18.5" cy="18.5" r="3"/><path d="M18.5 14.4v1.1M18.5 21.5v1.1M14.4 18.5h1.1M21.5 18.5h1.1"/>' },
  { id:'plotarchive', group:'Set up', label:'PlotArchive',    run:()=>openPlotArchive(),
    desc:'Ready-made feature types you can add and then edit',
    icon:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="16" y2="7"/><line x1="9" y1="11" x2="14" y2="11"/>' },
  { id:'import', group:'Data',       label:'Import',          run:()=>switchTabNav('import'),
    desc:'Open a PlotPack, or bring in a GeoPackage or CSV',
    icon:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>' },
  { id:'export', group:'Data',       label:'Export',          run:()=>switchTabNav('export'),
    desc:'Send this project out as files, a web map or to a cloud endpoint',
    icon:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' },
  { id:'newproject', group:'Set up',   label:'New Project',     run:()=>showNewProject(),
    desc:'Start a fresh project with its own schema and working grid',
    icon:'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>' },
  { id:'plotatlas', group:'Explore',    label:'PlotAtlas',       run:()=>openPlotAtlas(),
    desc:'Full-screen map with basemaps, layers and feature inspection',
    icon:'<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>' },
  { id:'analytics', group:'Analyse',    label:'Analytics',       run:()=>openAnalytics(),
    desc:'Charts and breakdowns across this project’s captured data',
    icon:'<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>' },
  { id:'plotmind', group:'Explore',     label:'PlotMind',        run:()=>openPlotMind(),
    desc:'Attribute values learned from what you have already captured',
    icon:'<path d="M12 3a5 5 0 0 0-5 5v1a4 4 0 0 0 0 8v1a4 4 0 0 0 8 0V8a5 5 0 0 0-3-5z"/><path d="M12 3a5 5 0 0 1 5 5v1a4 4 0 0 1 0 8v1a4 4 0 0 1-5 3"/><path d="M9 10h1.5M14 14h1.5"/>' },
  { id:'plotetch', group:'Analyse',     label:'PlotEtch',        run:()=>openPlotEtch(),
    desc:'Digitize shapes by hand, with snapping and overlay tools',
    icon:'<polygon points="12 3 20 8.5 17.5 18.5 6.5 18.5 4 8.5"/><circle cx="12" cy="3" r="1.6" fill="currentColor"/><circle cx="20" cy="8.5" r="1.6" fill="currentColor"/><circle cx="4" cy="8.5" r="1.6" fill="currentColor"/>' },
  { id:'attrtable', group:'Data',    label:'Attribute Table', run:()=>openAttributeTable(),
    desc:'Every feature as a table, with query and column statistics',
    icon:'<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/>' },
  { id:'zonal', group:'Analyse',        label:'Zonal Stats',     run:()=>runZonalStatsForProject(),
    desc:'Raster statistics summarised over this project’s polygons',
    icon:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
  { id:'layers', group:'Set up',       label:'Layers',          run:()=>openLayerModal(),
    desc:'Show, hide and reorder feature types on the map',
    icon:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  { id:'goto', group:'Explore',         label:'Go To',           run:()=>openGotoModal(),
    desc:'Jump the map to a coordinate, a grid reference or a feature',
    icon:'<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
  { id:'media', group:'Data',        label:'Media Gallery',   run:()=>showMediaGallery(),
    desc:'Every photo in this project, grouped by the feature it belongs to',
    icon:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>' },
  { id:'gps', group:'Utilities',          label:'Connect GPS',     run:()=>toggleExternalGps(),
    desc:'Pair a Bluetooth NMEA receiver for survey-grade fixes',
    icon:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><line x1="12" y1="1.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22.5" y2="12"/>' },
  { id:'backup', group:'Data',       label:'Backup All',      run:()=>exportAllProjects(),
    desc:'Zip every project on this device, not just the open one',
    icon:'<path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M23 3H1l4 5h14z"/><line x1="10" y1="12" x2="14" y2="12"/>' },
  { id:'notes', group:'Utilities',        label:'Quick Notes',     run:()=>openQuickNotesModal(),
    desc:'A scratchpad for this project: site access, contacts, reminders',
    icon:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>' },
  // Gated by the Settings toggle via available(). PlotLens belongs here rather than as a one-off
  // row on Review: it is the same class of tool as PlotEtch, Media Gallery and Attribute Table —
  // project-scoped, opened occasionally — and putting it in the registry means it inherits the
  // customisable grid, the More drawer and the same tile styling instead of inventing its own.
  { id:'plotlens', group:'Explore',     label:'PlotLens',        run:()=>showPlotLens(), available:()=>plotLensEnabled(),
    desc:'Turn this project’s photos into a narrated visual story',
    icon:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/>' },
  { id:'plotvault', group:'Explore', label:'PlotVault',       run:()=>openPlotVault(),
    desc:'Read reference layers off a bucket without downloading the file',
    icon:'<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' },
  { id:'help', group:'Utilities',         label:'Help & About',    run:()=>openHelp(),
    desc:'How the app works, and where your data actually lives',
    icon:'<circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 2-2.8 2.5-2.8 4"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/>' }
];

// Feature Types leads, then Import, then Export. These three are the spine of a
// session — you define what you are collecting, you bring in what already
// exists, you get the result off the phone — so they hold the top of the grid
// and everything else fills in behind them. PlotAtlas and PlotMind follow.
// Five of the six slots. PlotAtlas and PlotMind stay in the defaults — they have
// no other route in from the dashboard, so dropping them to make room for the
// pinned three would strand them in the More drawer on a fresh install — they
// just no longer lead. The sixth slot is left free deliberately: qaSeedNewActions()
// needs somewhere to put a future action on a device that has never customised.
// Eight, filling two clean rows of the 4-across compact grid. Five defaults left a 4+1 final row,
// which reads as an accident rather than a layout.
//
// The old five deliberately left a slot free "so qaSeedNewActions() has somewhere to put a future
// action on a device that has never customised". That rationale does not hold: qaSeedNewActions()
// returns early when the stored value is not an array, which is exactly the never-customised case,
// so it has never once written to a fresh install. Seeding only ever touches grids the user has
// already rearranged, and those are governed by their own stored array, not by this list. A new
// action still has to be added HERE to reach a fresh install, and to QA_SEED_ACTIONS to reach an
// existing one — two lists, on purpose, because they answer different questions.
//
// PlotVault is deliberately NOT here. It is the one action in the set that cannot work without a
// connection, and leading a fresh install of an offline-first field tool with a tile that fails in
// the field would misrepresent what the app is. It is one tap away in the drawer, and seeded into
// grids whose owners have already shown they curate them.
// Four, matching QA_MAX. The four that make a session possible, in the order one runs: you cannot
// collect without a feature type, you bring existing data in, you send results out, and layers is
// what you reach for constantly while reviewing. PlotAtlas, PlotMind, the attribute table and
// analytics moved to the More drawer — all one tap away, and all searchable there.
const QA_DEFAULT = ['featuretypes','import','export','layers'];

// ══ PINNED ORDER ══
// QA_DEFAULT only governs a grid that has never been customised. Anyone who had
// already rearranged their tiles kept a stored array in localStorage, so for
// them Feature Types could sit anywhere — or third, behind two tools. These ids
// are therefore hoisted to the front of EVERY read, in this order, whenever they
// are present. It is a sort, not an insert: an action the user deliberately
// removed stays removed, it just cannot be out of order while it is switched on.
const QA_PINNED = ['featuretypes','import','export'];

// Stable partition: pinned ids first (in QA_PINNED order), then everything else
// in whatever order the user arranged it.
function qaApplyPinnedOrder(ids){
  const pinned = QA_PINNED.filter(id => ids.includes(id));
  return [...pinned, ...ids.filter(id => !QA_PINNED.includes(id))];
}

// One-time, and deliberately not part of qaVisibleIds(): that runs on every
// dashboard render, and quietly re-adding a tile the user had removed would be
// worse than never offering it. This offers each genuinely new action once, only
// if there is room, and records that it has done so.
const QA_SEEDED_KEY = 'plotedge_qa_seeded';

// Add an id here when a new action ships. Anything already listed will not be
// offered twice, so this is append-only.
const QA_SEED_ACTIONS = ['plotatlas', 'plotmind', 'plotvault', 'plotarchive'];

function qaSeedNewActions(){
  try {
    let seeded = [];
    try { seeded = JSON.parse(localStorage.getItem(QA_SEEDED_KEY) || '[]'); } catch(e) { seeded = []; }
    if (!Array.isArray(seeded)) seeded = [];
    const fresh = QA_SEED_ACTIONS.filter(id => !seeded.includes(id));
    // Recorded whether or not anything is actually added below: an action that
    // did not fit this time must not come back and displace something next time.
    localStorage.setItem(QA_SEEDED_KEY, JSON.stringify(QA_SEED_ACTIONS));
    if (!fresh.length) return;
    const stored = JSON.parse(localStorage.getItem(QA_KEY) || 'null');
    if (!Array.isArray(stored)) return;            // never customised — QA_DEFAULT already has them
    const add = fresh.filter(id => !stored.includes(id)).slice(0, Math.max(0, QA_MAX - stored.length));
    if (!add.length) return;                       // full: leave the user's choices alone
    qaSetVisibleIds([...add, ...stored]);
  } catch(e) {}
}

// Was 6 ("three rows of two"). Compact tiles are four per row, so 8 is two rows
// — one row FEWER than the old six occupied, while exposing two more actions.
// Kept at a multiple of four so the grid never renders a ragged final row, which
// is the detail that makes a dense grid look accidental rather than designed.
// Four, matching what the comment above the grid in index.html has always claimed. It was 8, so
// eight tiles rendered and the dashboard overflowed — the clutter and the cut-off bottom were the
// same bug. Everything beyond four is still one tap away in the More drawer, which already has
// search, so nothing became less reachable: the drawer went from holding 11 actions to 15.
const QA_MAX = 4;

const QA_MIN = 2;

const QA_KEY = 'plotedge_quickactions';


// An action may declare available() to opt out of the grid, the drawer and the customise sheet at
// once. Actions without one are always available, so this changes nothing for the existing twelve.
function qaAvailable(){ return QA_REGISTRY.filter(a => typeof a.available !== 'function' || a.available()); }

function qaVisibleIds(){
  let ids;
  try { ids = JSON.parse(localStorage.getItem(QA_KEY) || 'null'); } catch(e){ ids = null; }
  const avail = qaAvailable();
  if (!Array.isArray(ids)) return qaApplyPinnedOrder(QA_DEFAULT.filter(id => avail.some(a=>a.id===id)));
  // Filter against the registry on every read rather than trusting what was stored: a saved id
  // for an action that has since been renamed, removed, or switched off in Settings would
  // otherwise render a blank tile that does nothing when tapped.
  ids = ids.filter(id => avail.some(a=>a.id===id));
  // Pinned order is applied BEFORE the QA_MAX slice, not after: hoisting first and then cutting
  // is what guarantees Feature Types survives on a grid that is already full, instead of being
  // the tile that falls off the end.
  if (!ids.length) return qaApplyPinnedOrder(QA_DEFAULT.filter(id => avail.some(a=>a.id===id)));
  return qaApplyPinnedOrder(ids).slice(0, QA_MAX);
}

function qaSetVisibleIds(ids){
  try { localStorage.setItem(QA_KEY, JSON.stringify(ids)); } catch(e){}
}

function qaActionById(id){ return QA_REGISTRY.find(a=>a.id===id); }


// ══ TWO TILE SHAPES, ON PURPOSE ══
// The dashboard grid and the More drawer used to share one tile verbatim: a
// full-width row with an icon badge, a label and a chevron. That was right when
// there were four actions. At nineteen it is the thing that makes this section
// feel clunky, and it does so in two separate ways.
//
// On the DASHBOARD, a row-shaped tile can only fit two per line, so six actions
// cost three rows — roughly 170px of the fold — to expose a third of what the
// app can do. The chevron is pure noise: a tile is obviously tappable, and the
// arrow only earns its space on the "More actions" row, where it genuinely means
// "this opens something else". Compact tiles stack the icon over the label at
// four across, so eight actions fit in two rows in LESS height than six took in
// three. Denser and calmer at the same time, because the eye reads a regular
// 4-column rhythm faster than it reads six competing horizontal bars.
//
// In the DRAWER there is no fold to protect, so the row shape stays — it is
// easier to scan a vertical list of unfamiliar names than a grid of icons, and
// the drawer is exactly where the unfamiliar ones live.
function qaTileHtml(action, inDrawer){
  const onclick = inDrawer
    ? `runFromMoreActions(()=>qaRun('${action.id}'))`
    : `qaRun('${action.id}')`;
  const icon = `<span class="qa-icon-badge"><svg class="qa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${action.icon}</svg></span>`;
  if (!inDrawer) {
    return `<button class="qa-tile qa-tile-compact" onclick="${onclick}">
      ${icon}<span class="qa-text">${escapeHtml(action.label)}</span>
    </button>`;
  }
  // ══ THE DRAWER TILE CARRIES A DESCRIPTION ══
  // The dashboard grid cannot: at four across there is room for a two-line label and nothing else.
  // The drawer is the opposite case — it is precisely where the UNFAMILIAR actions live, and a
  // grid of proprietary names (PlotEtch, PlotMind, PlotVault, PlotLens) with nothing but an icon
  // beside them is a list you have to open things to understand. One line of plain English per
  // row is the difference between a menu and a directory. It is also what makes search worth
  // having: the filter reads the description too, so "photo" finds Media Gallery and PlotLens
  // without either label containing the word.
  const desc = action.desc
    ? `<span class="qa-desc">${escapeHtml(action.desc)}</span>`
    : '';
  return `<button class="qa-tile qa-tile-rich" onclick="${onclick}">
    ${icon}
    <span class="qa-rich-body">
      <span class="qa-text">${escapeHtml(action.label)}</span>
      ${desc}
    </span>
    <svg class="qa-tile-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
  </button>`;
}

// ══ GROUPING ══
// Order matters and is not alphabetical: it follows the shape of a session —
// you set the project up, you move data, you look at it, you analyse it, and
// utilities are the things you reach for when something is wrong. An action
// with no group (a future one someone forgets to tag) falls into Utilities
// rather than disappearing.
const QA_GROUP_ORDER = ['Set up', 'Data', 'Explore', 'Analyse', 'Utilities'];

function qaGroupOf(action){
  return (action && action.group && QA_GROUP_ORDER.includes(action.group)) ? action.group : 'Utilities';
}

// ══ WHY THE DRAWER GETS A SEARCH BOX ══
// This is the part that actually answers "it gets clunkier as we add things".
// Headings alone slow the growth, they don't stop it — at thirty actions the
// drawer is five scrolling groups and finding PlotVault still means hunting.
// A filter turns the drawer into a command palette: type three letters and the
// list collapses to what you meant, and it costs exactly the same whether there
// are twelve actions behind it or a hundred. Grouping is what makes BROWSING
// pleasant; search is what makes the section scale. They solve different halves
// and the drawer needs both.
//
// The box is hidden below eight overflow actions, because a search field over a
// list you can already see in one glance reads as friction, not help.
const QA_SEARCH_MIN = 8;

let qaDrawerFilter = '';

// ══ RECENTLY USED ══
// Grouping helps you browse and search helps you aim, but neither helps with the thing people
// actually do most: reaching for the same two or three overflow actions over and over. A crew
// working a site that needs Media Gallery and Quick Notes every hour should not re-scan five
// groups, or retype the same three letters, every time.
// Deliberately a short list and deliberately NOT self-reordering the grid: the grid is the user's
// to arrange (that is what Customise is for), and a dashboard whose tiles move on their own is a
// dashboard you cannot build muscle memory against. This is a shortcut row inside the drawer, and
// nothing more.
const QA_RECENT_KEY = 'plotedge_qa_recent';
const QA_RECENT_MAX = 3;

function qaRecentIds(){
  try {
    const v = JSON.parse(localStorage.getItem(QA_RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch(e){ return []; }
}

// Most-recent-first, de-duplicated, capped. Recorded for every run regardless of where it was
// launched from, because "what did I last use" is a fact about the user, not about which surface
// they happened to tap.
function qaNoteUsed(id){
  try {
    const next = [id, ...qaRecentIds().filter(x => x !== id)].slice(0, QA_RECENT_MAX);
    localStorage.setItem(QA_RECENT_KEY, JSON.stringify(next));
  } catch(e){}
}

function qaDrawerHtml(rest){
  const q = qaDrawerFilter.trim().toLowerCase();
  // Label OR description. Searching the description is what lets someone find an action by what
  // it DOES when they cannot remember what it is called — the whole problem with proprietary
  // module names.
  const matched = q
    ? rest.filter(a => a.label.toLowerCase().includes(q) || (a.desc || '').toLowerCase().includes(q))
    : rest;
  if (!matched.length) {
    return `<div class="qa-drawer-empty">Nothing matches “${escapeHtml(qaDrawerFilter.trim())}”.</div>`;
  }
  // While filtering, headings are dropped: with three results left they label
  // more than they organise, and they push the actual answers down the sheet.
  if (q) return `<div class="qa-grid qa-drawer-grid">${matched.map(a=>qaTileHtml(a, true)).join('')}</div>`;

  // Recents sit above the groups and are ALSO left in their own group below — a shortcut that
  // removes an action from where it normally lives would make the drawer's structure shift under
  // the user, which is exactly the instability the comment above rejects for the grid.
  const recent = qaRecentIds().map(id => matched.find(a => a.id === id)).filter(Boolean);
  const recentBlock = recent.length
    ? `<div class="qa-group qa-group-recent">
         <div class="qa-group-label">Recently used</div>
         <div class="qa-grid qa-drawer-grid">${recent.map(a=>qaTileHtml(a, true)).join('')}</div>
       </div>`
    : '';

  return recentBlock + QA_GROUP_ORDER.map(g => {
    const inGroup = matched.filter(a => qaGroupOf(a) === g);
    if (!inGroup.length) return '';
    return `<div class="qa-group">
      <div class="qa-group-label">${escapeHtml(g)}</div>
      <div class="qa-grid qa-drawer-grid">${inGroup.map(a=>qaTileHtml(a, true)).join('')}</div>
    </div>`;
  }).join('');
}

function onQaSearchInput(v){
  qaDrawerFilter = v || '';
  const drawer = document.getElementById('qaDrawerGrid');
  if (!drawer) return;
  const visible = qaVisibleIds();
  drawer.innerHTML = qaDrawerHtml(qaAvailable().filter(a=>!visible.includes(a.id)));
}

function qaRun(id){
  const a = qaActionById(id);
  if (!a) { showToast('That action is no longer available'); return; }
  // Recorded before the action runs, not after: several of these navigate away or open a sheet,
  // and one that throws is still an action the user reached for.
  qaNoteUsed(id);
  try { a.run(); } catch(e){ console.error('Quick action failed:', e); showToast('That action couldn\'t run'); }
}

function renderQuickActions(){
  const visible = qaVisibleIds();
  const grid = document.getElementById('qaGrid');
  if (grid) grid.innerHTML = visible.map(id=>qaTileHtml(qaActionById(id), false)).join('');
  const rest = qaAvailable().filter(a=>!visible.includes(a.id));
  const drawer = document.getElementById('qaDrawerGrid');
  // Reset on every render, not on open: a filter left over from last time would
  // present a drawer that looks like it has lost most of its actions.
  qaDrawerFilter = '';
  const search = document.getElementById('qaSearchWrap');
  if (search) search.style.display = rest.length >= QA_SEARCH_MIN ? '' : 'none';
  const searchInput = document.getElementById('qaSearchInput');
  if (searchInput) searchInput.value = '';
  if (drawer) drawer.innerHTML = qaDrawerHtml(rest);
  const count = document.getElementById('qaMoreCount');
  if (count) count.textContent = String(rest.length);
  // The sheet says how much is in it, so the drawer's header is informative rather than a bare
  // title over a list whose length you have to scroll to discover.
  const sub = document.getElementById('qaDrawerSub');
  if (sub) sub.textContent = rest.length
    ? `${rest.length} more action${rest.length===1?'':'s'} · tap to run, or customise the grid below`
    : 'Every action is already on your dashboard grid.';
}


// ── CUSTOMISE SHEET ──
function openCustomizeQa(){
  renderCustomizeQa();
  document.getElementById('customizeQaModal').classList.add('show');
}

function closeCustomizeQa(){
  document.getElementById('customizeQaModal').classList.remove('show');
  renderQuickActions();
}

function renderCustomizeQa(){
  const visible = qaVisibleIds();
  const max = document.getElementById('qaMaxLabel');
  if (max) max.textContent = String(QA_MAX);
  const el = document.getElementById('qaCustomList');
  if (!el) return;
  // Selected actions listed first and in their grid order, so the list doubles as a preview of
  // what the dashboard will look like.
  // qaAvailable(), not QA_REGISTRY: the customise sheet must not offer a tile the user cannot
  // currently have — picking a switched-off action would save an id that then filters straight
  // back out, so it would silently do nothing.
  const ordered = visible.map(qaActionById).concat(qaAvailable().filter(a=>!visible.includes(a.id)));
  el.innerHTML = ordered.map(a=>{
    const on = visible.includes(a.id);
    const pos = on ? visible.indexOf(a.id)+1 : null;
    // A pinned action is re-hoisted by qaVisibleIds() on every read, so its arrows could never
    // move it — they'd just repaint unchanged, which reads as a broken button. They are disabled
    // and the row says why instead.
    const pinned = on && QA_PINNED.includes(a.id);
    return `<div class="lm-row">
      <span class="qa-icon-badge" style="width:24px;height:24px;"><svg class="qa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.icon}</svg></span>
      <div class="lm-body">
        <div class="lm-name">${escapeHtml(a.label)}</div>
        <div class="lm-meta">${on ? (pinned ? `Dashboard · slot ${pos} · always first` : `Dashboard · slot ${pos}`) : 'In More actions'}</div>
      </div>
      ${on ? `<button class="pe-sketch-x" onclick="qaMove('${a.id}',-1)" aria-label="Move up" ${(pos===1||pinned)?'disabled style="opacity:0.3"':''}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
      </button>` : ''}
      <label class="toggle-switch">
        <input type="checkbox" ${on?'checked':''} onchange="qaToggle('${a.id}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
    </div>`;
  }).join('');
}

function qaToggle(id, on){
  let visible = qaVisibleIds();
  if (on){
    if (visible.length >= QA_MAX){
      showToast(`The grid holds ${QA_MAX}. Turn one off first.`);
      renderCustomizeQa();   // repaint so the checkbox springs back
      return;
    }
    if (!visible.includes(id)) visible.push(id);
  } else {
    // Never let the grid empty out — an empty Quick actions block looks like a rendering fault
    // rather than a choice, and there'd be no obvious way back to Customise from the dashboard.
    if (visible.length <= QA_MIN){
      showToast(`Keep at least ${QA_MIN} on the dashboard.`);
      renderCustomizeQa();
      return;
    }
    visible = visible.filter(x=>x!==id);
  }
  qaSetVisibleIds(visible);
  renderCustomizeQa();
}

function qaMove(id, dir){
  const visible = qaVisibleIds();
  const i = visible.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return;
  // Belt and braces alongside the disabled arrow in renderCustomizeQa(): swapping either end of
  // a pinned pair would be undone by the next qaVisibleIds() read anyway, so refuse it outright
  // rather than writing a layout that silently will not stick.
  if (QA_PINNED.includes(visible[i]) || QA_PINNED.includes(visible[j])) return;
  [visible[i], visible[j]] = [visible[j], visible[i]];
  qaSetVisibleIds(visible);
  renderCustomizeQa();
}

function resetQuickActions(){
  qaSetVisibleIds(QA_DEFAULT.slice());
  renderCustomizeQa();
  showToast('Quick actions reset');
}
