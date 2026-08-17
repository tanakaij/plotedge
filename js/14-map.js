// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Review map, popups, basemaps
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ REVIEW MAP ══
// Leaflet map on the Review tab showing every saved feature for the active project, color-coded
// by feature type (same palette as the review-list badges and feature-type manager above), so the
// user can visually confirm coverage before exporting.
let reviewMap = null;

let reviewMapLayerGroup = null;

// One layer, swapped in place. The old pair of pre-built street/satellite layers
// could not express a five-entry registry without becoming five variables.
let reviewMapBaseLayer = null;

let currentBasemap = localStorage.getItem('plotedge_basemap') || 'street'; // 'street' | 'satellite', remembered across sessions


// Lazily creates the map the first time the Review tab is opened. Returns null (and leaves the
// rest of the app working normally) if Leaflet itself never loaded — e.g. the very first time the
// app is opened there's no network and the CDN script/stylesheet couldn't be fetched.
function ensureReviewMap(){
  if (reviewMap) return reviewMap;
  const el = document.getElementById('reviewMap');
  if (!el || typeof L === 'undefined') return null;
  // rotate/touchRotate (from the Leaflet-Rotate plugin loaded in index.html) is what makes a
  // two-finger twist actually turn the map, the way it does in Google Maps — plain Leaflet has no
  // rotation of its own. The compass control only shows up once rotated (closeOnZeroBearing) and
  // taps back to north; bottomleft is the one corner this map doesn't already use.
  //
  // Both the options and the control itself now come from js/13b-map-rotate.js. The plugin's own
  // control is unusable on a phone and its overlays trail the map during a twist; that file
  // replaces the first and closes the second, and MUST run before L.map() for the replacement
  // control to be the one the plugin's init hook installs. peRotateMapOptions() returns nothing
  // when the plugin never loaded (offline first launch), in which case this is a plain map.
  const canRotate = peCanRotateMaps();
  reviewMap = L.map(el, Object.assign(
    { zoomControl:true, attributionControl:true, scrollWheelZoom:true },
    canRotate ? peRotateMapOptions('bottomleft') : {}
  ));
  if (canRotate) peAttachRotationSync(reviewMap);
  applyReviewBasemap();
  reviewMapLayerGroup = L.layerGroup().addTo(reviewMap);
  reviewMap.setView([0,0], 2);
  return reviewMap;
}


// ══ ONE REGISTRY, ONE PREFERENCE ══
// This map used to own a hard-coded pair of tile layers and a boolean flip
// between them, while PlotAtlas carried five basemaps under a different key and
// the PlotLens minimap chose its own. Now all three read ATLAS_BASEMAPS
// (js/14a-plotatlas.js) and the single 'plotedge_basemap' key that the Settings
// control writes, so the choice made in Settings is the choice on every map.
// ATLAS_BASEMAPS is declared in a later file, which is fine: this only runs when
// a map is opened, never while the scripts are loading.
function applyReviewBasemap(){
  if (!reviewMap || typeof L === 'undefined') return;
  let key = 'street';
  try { key = localStorage.getItem('plotedge_basemap') || 'street'; } catch(e) {}
  const registry = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  const spec = (registry && registry[key]) || { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr:'&copy; OpenStreetMap contributors', max:19, label:'Map' };
  currentBasemap = key;
  if (reviewMapBaseLayer) { try { reviewMap.removeLayer(reviewMapBaseLayer); } catch(e) {} }
  reviewMapBaseLayer = L.tileLayer(spec.url, { maxZoom: spec.max, attribution: spec.attr });
  reviewMapBaseLayer.addTo(reviewMap);
  if (reviewMapBaseLayer.bringToBack) reviewMapBaseLayer.bringToBack();
  updateBasemapToggleLabel();
}

// The corner button cycles through the same five basemaps rather than flipping
// between two — and, unlike before, it now shows the basemap you are ON rather
// than the one you would switch to. With five options "the next one" is not a
// label anyone can predict, so naming the current state is the only honest thing
// the button can say.
function toggleBasemap(){
  const registry = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  if (!registry) return;
  const keys = Object.keys(registry);
  const next = keys[(keys.indexOf(currentBasemap) + 1) % keys.length];
  setBasemapPref(next);
}

function updateBasemapToggleLabel(){
  const label = document.getElementById('mapBasemapToggleLabel');
  if (!label) return;
  const registry = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  label.textContent = (registry && registry[currentBasemap] && registry[currentBasemap].label) || 'Map';
}


// Tile imagery needs a live connection; the service worker opportunistically caches tiles for
// areas already viewed (see plotedge-sw.js) so they still show up offline, but freshly-panned
// areas won't load without network. This banner sets expectations either way.
function updateMapConnectivityBanner(){
  const banner = document.getElementById('reviewMapConn');
  if (!banner) return;
  if (navigator.onLine){
    banner.textContent = 'Map imagery needs a connection to load new areas. Anywhere you\'ve viewed before is cached for offline use.';
    banner.classList.remove('offline');
  } else {
    banner.textContent = 'Offline: showing cached map tiles only. Your saved features and their positions below are unaffected.';
    banner.classList.add('offline');
  }
}

window.addEventListener('online', updateMapConnectivityBanner);

window.addEventListener('offline', updateMapConnectivityBanner);


// Mirrors the good/fair/weak accuracy thresholds used in renderPoints()/onPos() — draws a faint
// halo around lower-confidence vertices so weak fixes are visible on the map, not just in the list.
function accuracyHaloStyle(acc){
  if (acc==null || acc<=5) return null;
  if (acc<=15) return { color:cssVar('--warn'),   weight:1, fillColor:cssVar('--warn'),   fillOpacity:0.10 };
  return          { color:cssVar('--danger'), weight:1, fillColor:cssVar('--danger'), fillOpacity:0.12 };
}


// ══ MAP POPUPS ══
// Popups are built as strings because Leaflet takes HTML, so anything interactive inside them has
// to reach a global. _popupPhotos is that bridge: photo arrays are parked here under a short key
// and the thumbnail's onclick passes the key back, rather than trying to serialise several
// hundred KB of base64 data URLs through an inline attribute (which would also blow past the
// practical attribute-length limit and break the markup).
const _popupPhotos = new Map();

let _popupPhotoSeq = 0;

function registerPopupPhotos(photos){
  if (!photos || !photos.length) return null;
  // Keyed per render pass and cleared in renderReviewMap(), so this can't grow without bound as
  // the map is redrawn — each redraw starts from an empty map.
  const key = 'pp' + (++_popupPhotoSeq);
  _popupPhotos.set(key, photos);
  return key;
}

function openPopupPhoto(key, idx){
  const photos = _popupPhotos.get(key);
  if (photos && photos.length) openLightbox(photos, idx || 0);
}


// Shared photo strip. Every thumbnail is tappable and opens the existing full-screen lightbox with
// the whole set, so a popup is a way into the photos rather than a dead-end preview of one.
function popupPhotoStrip(photos){
  const key = registerPopupPhotos(photos);
  if (!key) return '';
  const shown = photos.slice(0, 6);
  const more = photos.length - shown.length;
  return `<div class="pe-popup-photos">${
    shown.map((p,i)=>`<img src="${photoThumbSrc(p)}" alt="${escapeHtml(p.angleLabel || p.name || 'Photo')}" loading="lazy" decoding="async" onclick="openPopupPhoto('${key}',${i})">`).join('')
  }${more>0 ? `<button class="pe-popup-more" onclick="openPopupPhoto('${key}',${shown.length})">+${more}</button>` : ''}</div>`;
}


// Attribute rows, in the feature type's own schema order first (matching openInspect), then any
// extra keys present on the record. Capped because a popup is a glance, not the Details sheet —
// the "Details" button is right there for the full list.
// `geo` is the geometry of the feature these attrs belong to — needed because a per-vertex field
// collapses to feature-scope on a point capture, so which bucket a field's value sits in depends
// on the feature, not on the schema alone. Defaults to the type's declared geometry when omitted.
function popupAttrRows(ft, attrs, scope, limit, geo){
  const rows = [];
  const seen = new Set();
  const resolved = fl => effectiveFieldScope(fl, geo || (ft ? ftDefaultGeometry(ft) : 'point'));
  if (ft) ft.fields.filter(fl => scope === 'vertex' ? resolved(fl) === 'vertex' : resolved(fl) !== 'vertex').forEach(fl => {
    seen.add(fl.id);
    const v = formatAttrValue(attrs[fl.id], fl);
    if (v && v !== '—') rows.push([fl.label, v]);
  });
  Object.keys(attrs || {}).forEach(k => {
    if (seen.has(k)) return;
    const v = formatAttrValue(attrs[k]);
    if (v && v !== '—') rows.push([k, v]);
  });
  if (!rows.length) return '';
  const shown = rows.slice(0, limit || 5);
  const more = rows.length - shown.length;
  return `<div class="pe-popup-attrs">${
    shown.map(([k,v])=>`<div class="pe-popup-attr"><span class="pe-popup-attr-k">${escapeHtml(k)}</span><span class="pe-popup-attr-v">${escapeHtml(v)}</span></div>`).join('')
  }${more>0 ? `<div class="pe-popup-attr-more">+${more} more in Details</div>` : ''}</div>`;
}


function featurePopupHtml(f, info, color){
  const verts = f.vertices || [];
  const geo = f.geometryType || 'point';
  const photos = verts.flatMap(v => v.photos || []);
  const ft = getFeatureType(f.featureTypeId);

  // A one-line measurement for the geometry, so a line or polygon popup answers "how big" without
  // opening Details. Same helpers the Inspect sheet uses, so the numbers can't disagree.
  let measure = '';
  if (geo === 'line' && verts.length >= 2) measure = formatLength(lineLengthM(verts));
  else if (geo === 'polygon' && verts.length >= 3) measure = formatArea(polygonAreaAndPerimeterM(verts).area);

  const meta = [
    verts.length + (verts.length === 1 ? ' vertex' : ' vertices'),
    measure,
    photos.length ? photos.length + (photos.length === 1 ? ' photo' : ' photos') : ''
  ].filter(Boolean).join(' · ');

  return `<div class="pe-popup">
    <div class="pe-popup-type" style="color:${color};">${escapeHtml(info.label)}</div>
    <div class="pe-popup-name">${escapeHtml(f.name || '(unnamed)')}${f.ref?` <span class="pe-popup-ref">#${escapeHtml(f.ref)}</span>`:''}</div>
    <div class="pe-popup-meta">${escapeHtml(meta)}</div>
    ${popupAttrRows(ft, f.attrs || {}, 'feature', 5, geo)}
    ${popupPhotoStrip(photos)}
    ${geo !== 'point' && verts.length ? `<div class="pe-popup-hint">Tap any vertex marker for its own readings and photos.</div>` : ''}
    <button class="pe-popup-btn" style="background:${color};color:${contrastText(color)};" onclick="openInspect(${JSON.stringify(f.id)})">Details</button>
    <button class="pe-popup-btn pe-popup-btn-ghost" style="color:${color};border-color:${color};" onclick="scrollToFeatureCard(${f.id})">View in list</button>
  </div>`;
}


// ── PER-VERTEX POPUP ──
// Lines and polygons are captured one physical standpoint at a time, and each of those standpoints
// carries its own fix quality, timestamp, vertex-scoped attributes and photos. Binding a single
// popup to the whole geometry threw all of that away — a 12-vertex boundary showed one popup and
// one photo. Each vertex now gets its own marker and its own popup.
function vertexPopupHtml(f, v, idx, total, info, color){
  const ft = getFeatureType(f.featureTypeId);
  const photos = v.photos || [];
  const bits = [];
  if (v.acc != null && isFinite(v.acc)) bits.push('±' + formatLength(v.acc));
  if (v.alt != null && isFinite(v.alt)) bits.push(formatLength(v.alt) + ' alt');
  if (v.time) bits.push(new Date(v.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));

  return `<div class="pe-popup">
    <div class="pe-popup-type" style="color:${color};">Vertex ${idx+1} of ${total}</div>
    <div class="pe-popup-name">${escapeHtml(f.name || '(unnamed)')}</div>
    <div class="pe-popup-meta">${escapeHtml(info.label)}</div>
    <div class="pe-popup-coord">${v.lat.toFixed(6)}, ${v.lon.toFixed(6)}</div>
    ${bits.length ? `<div class="pe-popup-meta">${escapeHtml(bits.join(' · '))}</div>` : ''}
    ${popupAttrRows(ft, v.attrs || {}, 'vertex', 4, f.geometryType || 'point')}
    ${photos.length ? popupPhotoStrip(photos) : '<div class="pe-popup-hint">No photos at this vertex.</div>'}
    <button class="pe-popup-btn" style="background:${color};color:${contrastText(color)};" onclick="openInspect(${JSON.stringify(f.id)})">Feature details</button>
  </div>`;
}


// Rebuilds every marker/line/polygon from `savedFeatures` and refits the map. Called whenever the
// Review tab is opened, and again after any add/delete so the map never shows stale data.
function renderReviewMap(){
  const map = ensureReviewMap();
  updateMapConnectivityBanner();
  const emptyMsg = document.getElementById('reviewMapEmpty');
  if (!map){
    if (emptyMsg){ emptyMsg.textContent='Map couldn\'t load (no connection yet). It\'ll appear next time you have network.'; emptyMsg.style.display='flex'; }
    return;
  }
  reviewMapLayerGroup.clearLayers();
  // Every popup from the previous render is gone with its layer, so the photo references parked
  // for them are dead too. Clearing here is what keeps _popupPhotos from accumulating a copy of
  // every photo array across repeated redraws.
  _popupPhotos.clear();

  const bounds = [];
  const legendSeen = new Map(); // type key -> {label,color}, de-duplicated for the legend strip

  savedFeatures.forEach(f=>{
    const info = resolveFeatureType(f);
    // Layer manager filter — hidden types are skipped before anything is drawn, so they drop out
    // of the legend and the auto-fit bounds too rather than leaving a legend chip for a layer
    // that isn't on the map or zooming to features nobody can see.
    if (hiddenLayerKeys.has(info.key)) return;
    const color = featureTypeColor(info.key);
    legendSeen.set(info.key, {label:info.label, color});
    const verts = f.vertices || [];
    const geo = f.geometryType || 'point';
    const popupHtml = featurePopupHtml(f, info, color);

    if (geo === 'point'){
      verts.forEach(v=>{
        const latlng=[v.lat,v.lon];
        bounds.push(latlng);
        const halo=accuracyHaloStyle(v.acc);
        if (halo) L.circle(latlng,{radius:Math.max(v.acc,3),...halo,interactive:false}).addTo(reviewMapLayerGroup);
        L.circleMarker(latlng,{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:0.95})
          .bindPopup(popupHtml).addTo(reviewMapLayerGroup);
      });
    } else {
      const latlngs = verts.map(v=>[v.lat,v.lon]);
      latlngs.forEach(ll=>bounds.push(ll));
      if (latlngs.length){
        if (geo === 'polygon'){
          L.polygon(latlngs,{color,weight:2,fillColor:color,fillOpacity:0.25}).bindPopup(popupHtml).addTo(reviewMapLayerGroup);
        } else {
          L.polyline(latlngs,{color,weight:3}).bindPopup(popupHtml).addTo(reviewMapLayerGroup);
        }
        // Vertex handles. Previously the only per-vertex mark was a non-interactive accuracy halo,
        // so every tap anywhere on a line or polygon opened the same whole-feature popup and the
        // per-standpoint readings, vertex-scoped attributes and photos were unreachable from the
        // map. These are small, drawn on top of the geometry, and each carries its own popup.
        // Radius stays modest so a dense boundary doesn't turn into a solid band of handles, but
        // it's above the ~10px comfortable-touch floor once the 2px stroke is counted.
        verts.forEach((v, vi)=>{
          const halo=accuracyHaloStyle(v.acc);
          if (halo) L.circle([v.lat,v.lon],{radius:Math.max(v.acc,3),...halo,interactive:false}).addTo(reviewMapLayerGroup);
          const hasPhotos = (v.photos||[]).length > 0;
          L.circleMarker([v.lat,v.lon],{
            radius: hasPhotos ? 6 : 5,
            color: '#fff',
            weight: 2,
            fillColor: color,
            fillOpacity: 1,
            // A vertex carrying photos reads as slightly heavier, so "where are the pictures on
            // this boundary" is answerable without opening every handle in turn.
            className: hasPhotos ? 'pe-vertex-marker has-photos' : 'pe-vertex-marker'
          })
            .bindPopup(vertexPopupHtml(f, v, vi, verts.length, info, color))
            .addTo(reviewMapLayerGroup);
        });
      }
    }
  });

  renderMapLegend(legendSeen);

  if (!bounds.length){
    const p = projects.find(x=>x.id===activeProjectId);
    if (p && p.siteLat!=null && p.siteLon!=null){
      map.setView([p.siteLat, p.siteLon], 13);
      if (emptyMsg){ emptyMsg.textContent='No features captured yet. Centered on the project site.'; emptyMsg.style.display='flex'; }
    } else {
      map.setView([0,0], 2);
      if (emptyMsg){ emptyMsg.textContent='No features captured yet, and no project site location set.'; emptyMsg.style.display='flex'; }
    }
  } else {
    if (emptyMsg) emptyMsg.style.display='none';
    if (bounds.length===1) map.setView(bounds[0], 17);
    else map.fitBounds(bounds, { padding:[24,24] });
  }
  // Panels are display:none until switched to, so the container may have been laid out at zero
  // size when the map first initialized — invalidateSize() after the tab-switch reflow fixes that.
  setTimeout(()=>map.invalidateSize(), 60);
}


function renderMapLegend(legendMap){
  const el = document.getElementById('reviewMapLegend');
  if (!el) return;
  el.innerHTML = Array.from(legendMap.values()).map(item=>
    `<span class="map-legend-chip"><span class="map-legend-swatch" style="background:${item.color}"></span>${escapeHtml(item.label)}</span>`
  ).join('');
}


// Called from a map popup's "View in list" button — jumps to the Review list and briefly
// highlights the matching feature card so it's easy to find among a long list.
function scrollToFeatureCard(id){
  switchTab('review');
  setTimeout(()=>{
    const card=document.getElementById('feat-'+id);
    if (!card) return;
    card.scrollIntoView({behavior:'smooth', block:'center'});
    card.classList.add('flash');
    setTimeout(()=>card.classList.remove('flash'), 1600);
  }, 80);
}
