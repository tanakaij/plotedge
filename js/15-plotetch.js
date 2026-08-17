// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — PlotEtch sketching: raster boolean engine, map, render, tools
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.



// ══════════════════════════════════════════════════════════════════════════════════════════
// PLOTLENS — VISUAL STORY FROM CAPTURED PHOTOS
// ══════════════════════════════════════════════════════════════════════════════════════════
// See the #view-plotlens markup comment for why this is photo-driven rather than video. The one
// invariant worth restating here: a story NEVER stores image bytes. A beat is a reference —
// {fid, vi, pi, narration, dur} — resolved against savedFeatures at play time. That is what keeps
// the whole feature clear of the 5 MB localStorage ceiling that photos already press against.
const PLOTLENS_KEY = 'plotedge_plotlens_enabled';

const PL_DEFAULT_DUR = 5;   // seconds per beat; 12 beats ≈ a one-minute story

let plStory = null;         // beats currently loaded in the player

let plIndex = 0;

let plTimer = null;


function plotLensEnabled(){ try { return localStorage.getItem(PLOTLENS_KEY) === '1'; } catch(e){ return false; } }

function setPlotLensPref(on){
  try { localStorage.setItem(PLOTLENS_KEY, on ? '1' : '0'); } catch(e){}
  showToast(on ? 'PlotLens enabled' : 'PlotLens hidden');
  syncPlotLensEntry();
}

// The entry point is on Review because that's where a finished survey is looked over. Hidden
// rather than removed when the toggle is off, so flipping it back needs no re-render elsewhere.
function syncPlotLensEntry(){
  const t = document.getElementById('settingsPlotLensToggle');
  if (t) t.checked = plotLensEnabled();
  // PlotLens now lives in the Quick Actions registry (gated by its available() predicate), so
  // flipping the toggle has to redraw the grid and drawer — otherwise the tile only appears or
  // disappears the next time something else happens to re-render the dashboard.
  // The try is load-bearing, not defensive padding: renderQuickActions() reads QA_REGISTRY, a
  // `const` declared thousands of lines below this function. applyTheme() runs during the initial
  // parse and reaches here, so on that very first call the binding is still in its temporal dead
  // zone and touching it throws — and `typeof` does NOT rescue you with let/const the way it does
  // with var, it throws too. Without this guard the ReferenceError propagates out and kills the
  // whole script block, taking `projects` and every function after it down with the app.
  // On that boot pass the grid simply isn't drawn yet (init does it moments later); every
  // subsequent call renders normally.
  try { renderQuickActions(); } catch(e) {}
}


// ── STORY BUILDING ──
// Capture order is the story. savedAt/time ordering replays the survey as it actually happened,
// which is the whole point — "from beginning to end" is data the app already has.
function buildPlotLensBeats(){
  const beats = [];
  savedFeatures.forEach(f => {
    (f.vertices || []).forEach((v, vi) => {
      (v.photos || []).forEach((p, pi) => {
        beats.push({
          fid: f.id, vi, pi,
          t: new Date(p.takenAt || v.time || f.savedAt || 0).getTime() || 0,
          narration: '',
          dur: PL_DEFAULT_DUR
        });
      });
    });
  });
  beats.sort((a,b) => a.t - b.t);
  return beats;
}

// Saved stories live beside the project's other per-project state. Narration text only — a
// twenty-beat story is a couple of KB.
function plSavedStory(){
  const d = projectData[activeProjectId];
  return (d && d.plotlens) || null;
}

function plPersistStory(beats){
  const d = projectData[activeProjectId];
  if (!d) return;
  d.plotlens = beats.map(b => ({ fid:b.fid, vi:b.vi, pi:b.pi, narration:b.narration||'', dur:b.dur||PL_DEFAULT_DUR }));
  persistStore();
}

// Resolve a beat reference back to live data. Returns null if the feature or photo was deleted
// since the story was saved — beats are references, so this is expected, not an error.
function plResolve(b){
  const f = savedFeatures.find(x => String(x.id) === String(b.fid));
  if (!f) return null;
  const v = (f.vertices || [])[b.vi];
  if (!v) return null;
  const p = (v.photos || [])[b.pi];
  if (!p) return null;
  return { f, v, p };
}


function showPlotLens(){
  if (!plotLensEnabled()){ showToast('Enable PlotLens in Settings first'); return; }
  plotwordsExplain('plotlens');
  activateView('view-plotlens');
  renderPlotLens();
  document.getElementById('scrollRoot').scrollTo(0, 0);
  pushNavState('plotlens');
}

function closePlotLens(){
  plotwordsDismissAll();
  plFlushNarration();
  stopPlotLens();
  destroyPlMap();
  // activateView() was missing here. switchTab() only swaps the PANELS inside #view-app — it does
  // nothing to the active VIEW — so the app stayed sitting on #view-plotlens and the back arrow
  // looked completely dead: it ran, it re-pointed the tab underneath, and nothing moved.
  activateView('view-app');
  switchTab('review');
  // Consumes this screen's own 'plotlens' stop rather than leaving it on the stack, matching
  // closeFeatureTypes()/closeMediaGallery(). Without it, a hardware Back from Review would walk
  // straight back into the story screen the user just left.
  history.back();
}


function renderPlotLens(){
  const body = document.getElementById('plotlensBody');
  if (!body) return;
  const saved = plSavedStory();
  const fresh = buildPlotLensBeats();
  // Merge: keep narration already written for a beat, drop beats whose photo is gone, and pick up
  // photos captured since the story was last saved so it stays current without manual rebuilding.
  const narrByKey = new Map((saved || []).map(b => [b.fid+':'+b.vi+':'+b.pi, b]));
  const beats = fresh.map(b => {
    const prev = narrByKey.get(b.fid+':'+b.vi+':'+b.pi);
    return prev ? { ...b, narration: prev.narration || '', dur: prev.dur || PL_DEFAULT_DUR } : b;
  });
  plStory = beats;

  const exportBtn = document.getElementById('plExportBtn');
  if (exportBtn) exportBtn.disabled = !beats.length;

  if (!beats.length){
    body.innerHTML = `<div class="hub-block">
      <div class="hub-block-title">Nothing to show yet</div>
      <div class="hub-block-desc">PlotLens builds a story from the photos captured against your features, in the order they were taken. Add a photo to a vertex in Collect and it'll appear here.</div>
    </div>`;
    return;
  }

  const mins = Math.round(beats.reduce((s,b)=>s+(b.dur||PL_DEFAULT_DUR),0));

  // ══ STORY TRAY ══
  // One horizontally-scrolling row of ringed thumbnails above everything else —
  // the convention every story product uses, and the reason it earns the space
  // is that nothing here duplicates what is already below it. The Frames list
  // further down is an EDITOR (narration boxes, timestamps, full titles); this
  // is the PLAYER's index. Before it existed the only way into the reel was
  // "Play story", which always started at frame 1, so reviewing the ninth photo
  // of a twenty-frame survey meant watching eight or tapping through them.
  //
  // Kept to a single 66px row with no wrapping and no card around it, so it adds
  // one band of height rather than a block: the map and the frame list below sit
  // where they always did. The leading tile is Play-all so the primary action is
  // still the first thing under the thumb, and the tray degrades to nothing at
  // one frame, where an index would be pure decoration.
  const trayHtml = beats.length > 1 ? `
    <div class="pl-tray" role="list" aria-label="Jump to a frame">
      <button class="pl-tray-item pl-tray-all" role="listitem" onclick="playPlotLens(0)" aria-label="Play the whole story">
        <span class="pl-tray-ring pl-tray-ring-all">
          <span class="pl-tray-play" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5 19 12 8 18.5z"/></svg>
          </span>
        </span>
        <span class="pl-tray-label">Play all</span>
      </button>
      ${beats.map((b,i)=>{
        const r = plResolve(b);
        if (!r) return '';
        const name = r.f.name || '(unnamed)';
        return `<button class="pl-tray-item" role="listitem" onclick="playPlotLens(${i})"
            aria-label="Play from frame ${i+1}: ${escapeHtml(name)}">
          <span class="pl-tray-ring${b.narration ? ' has-narr' : ''}">
            <img class="pl-tray-thumb" src="${photoThumbSrc(r.p)}" alt="" loading="lazy" decoding="async">
            <span class="pl-tray-num">${i+1}</span>
          </span>
          <span class="pl-tray-label">${escapeHtml(name)}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  body.innerHTML = trayHtml + `
    <div class="hub-block">
      <div class="hub-block-title">${escapeHtml(beats.length + (beats.length===1?' frame':' frames'))} · about ${escapeHtml(mins < 60 ? mins+'s' : Math.round(mins/60)+'m')}</div>
      <div class="hub-block-desc">Your captured photos, in the order they were taken, played back with a slow pan over each. Add a line of narration to any frame — narration is the only thing saved, so a story costs almost nothing.</div>
      <!-- ══ STORY MAP PREVIEW ══
           Shows the survey drawing itself: each frame's location drops in sequence with a trail
           connecting them, so you can see the shape of the story — the route walked, where the
           work concentrated — before committing to a full playback or an export. Uses the Leaflet
           already loaded for Review, so it adds no dependency and no bytes. -->
      <div class="pl-map" id="plMap"></div>
      <div class="pl-map-actions">
        <button class="pl-map-btn" id="plMapBtn" onclick="animateStoryMap()">Preview route</button>
        <button class="btn-pill" onclick="playPlotLens()" style="margin-top:0;flex:1;">Play story</button>
      </div>
    </div>
    <div class="pm-section-label">Frames</div>
    ${beats.map((b,i)=>{
      const r = plResolve(b);
      if (!r) return '';
      const info = resolveFeatureType(r.f);
      const when = r.p.takenAt || r.v.time;
      return `<div class="pl-beat-wrap">
        <div class="pl-beat">
          <img class="pl-beat-thumb" src="${photoThumbSrc(r.p)}" alt="" loading="lazy" decoding="async">
          <div class="pl-beat-body">
            <div class="pl-beat-title">${escapeHtml(String(i+1))}. ${escapeHtml(r.f.name || '(unnamed)')}</div>
            <div class="pl-beat-sub">${escapeHtml(info.label)}${when ? ' · ' + escapeHtml(new Date(when).toLocaleString()) : ''}</div>
          </div>
        </div>
        <textarea class="pl-beat-narr" rows="1" placeholder="Narration for this frame…"
          oninput="plSetNarration(${i}, this.value)">${escapeHtml(b.narration || '')}</textarea>
      </div>`;
    }).join('')}`;
  // After innerHTML, not before: the previous #plMap element was just destroyed by that write, so
  // any existing Leaflet instance is now bound to a detached node and must be rebuilt.
  destroyPlMap();
  renderStoryMap();
}


// ── STORY MAP PREVIEW ──
// A third Leaflet instance, created lazily and only while the PlotLens screen is open. Kept
// separate from #reviewMap rather than docking that shared instance here (as the Dashboard does)
// because the two can be wanted at once — the review map keeps its own fit/zoom while this one
// animates — and re-fitting a map the user left framed elsewhere is exactly the kind of state
// clobbering dockReviewMap() has to work around.
let plMap = null, plMapLayer = null, plMapTimer = null;

function ensurePlMap(){
  if (plMap) return plMap;
  const el = document.getElementById('plMap');
  if (!el || typeof L === 'undefined') return null;
  // This map was never given rotation, but it inherited a compass anyway: the
  // Leaflet-Rotate plugin merges `rotateControl: true` into L.Map's DEFAULTS, so
  // its init hook added a control to every map in the app — and on a map without
  // `rotate:true` the control's onAdd reads an undefined bearing, gets NaN, and
  // so never satisfies the `=== 0` test that would have hidden it. That dead,
  // permanently-disabled button is the "glitchy rotation icon" reported on this
  // screen. Two things fix it: the replacement control in js/13b-map-rotate.js
  // hides itself on a non-rotatable map, and the map now genuinely rotates, which
  // is more useful here than not — a route walked along a diagonal reads far
  // better turned to face the way the survey was walked.
  const canRotate = peCanRotateMaps();
  plMap = L.map(el, Object.assign(
    { zoomControl:false, attributionControl:true, scrollWheelZoom:false, dragging:true },
    canRotate ? peRotateMapOptions('bottomleft') : {}
  ));
  if (canRotate) peAttachRotationSync(plMap);
  // Same single preference as every other map — see plMiniBasemapSpec().
  const spec = plMiniBasemapSpec();
  L.tileLayer(spec.url, { maxZoom: spec.max, attribution: spec.attr }).addTo(plMap);
  plMapLayer = L.layerGroup().addTo(plMap);
  return plMap;
}

// Every frame that resolves to a real coordinate, in story order.
function plMapPoints(){
  return (plStory || []).map(b => {
    const r = plResolve(b);
    if (!r || r.v.lat == null) return null;
    return { lat:r.v.lat, lon:r.v.lon, name:r.f.name || '', narration:b.narration || '' };
  }).filter(Boolean);
}

function renderStoryMap(){
  const map = ensurePlMap();
  if (!map) return;                      // Leaflet never loaded (offline first run) — silently skip
  const pts = plMapPoints();
  plMapLayer.clearLayers();
  if (!pts.length) return;
  const ll = pts.map(p => [p.lat, p.lon]);
  if (ll.length === 1) map.setView(ll[0], 17);
  else map.fitBounds(L.latLngBounds(ll), { padding:[28,28], maxZoom:18 });
  // Static state: the whole route, faint. animateStoryMap() redraws it piece by piece on top.
  if (ll.length > 1) L.polyline(ll, { color:cssVar('--accent-primary'), weight:2, opacity:0.35, dashArray:'4 5' }).addTo(plMapLayer);
  pts.forEach((p,i)=> L.circleMarker([p.lat,p.lon], {
    radius:5, color:'#fff', weight:1.5, fillColor:cssVar('--accent-primary'), fillOpacity:0.5
  }).addTo(plMapLayer));
  setTimeout(()=>map.invalidateSize(), 60);
}

// The storytelling touch: replays the route in capture order. Each step drops its marker and
// extends the trail, so the survey visibly draws itself.
function animateStoryMap(){
  const map = ensurePlMap();
  if (!map) { showToast('Map needs a connection the first time'); return; }
  const pts = plMapPoints();
  if (!pts.length) return;
  stopStoryMapAnimation();
  plMapLayer.clearLayers();
  const btn = document.getElementById('plMapBtn');
  if (btn) btn.textContent = 'Replay route';

  const accent = cssVar('--accent-primary');
  const trail = L.polyline([], { color:accent, weight:3 }).addTo(plMapLayer);
  let i = 0;
  // Total is held near 6s regardless of frame count: a two-point survey shouldn't finish before
  // it registers, and a forty-point one shouldn't outlast the viewer's patience.
  const step = Math.max(120, Math.min(600, Math.round(6000 / pts.length)));
  const tick = () => {
    if (i >= pts.length){ plMapTimer = null; return; }
    const p = pts[i];
    trail.addLatLng([p.lat, p.lon]);
    const m = L.circleMarker([p.lat,p.lon], { radius:6, color:'#fff', weight:2, fillColor:accent, fillOpacity:1 }).addTo(plMapLayer);
    m.bindTooltip(String(i+1) + (p.narration ? ' · ' + p.narration : (p.name ? ' · ' + p.name : '')),
      { direction:'top', opacity:0.9 });
    // Pan rather than fit, so the map follows the walk instead of jumping scale on every step.
    map.panTo([p.lat, p.lon], { animate:true, duration:step/1000 });
    i++;
    plMapTimer = setTimeout(tick, step);
  };
  tick();
}

function stopStoryMapAnimation(){
  clearTimeout(plMapTimer); plMapTimer = null;
}

// Leaflet keeps timers and DOM handlers alive on an instance whose container has been thrown away
// by a re-render, so the map is torn down whenever the screen is left.
function destroyPlMap(){
  stopStoryMapAnimation();
  if (plMap){ try { plMap.remove(); } catch(e) {} }
  plMap = null; plMapLayer = null;
}


function plSetNarration(i, text){
  if (!plStory || !plStory[i]) return;
  plStory[i].narration = text;
  clearTimeout(plSetNarration._t);
  // Debounced: this fires on every keystroke, and persistStore() serialises the whole store.
  plSetNarration._t = setTimeout(()=>plPersistStory(plStory), 400);
}

// Writes any keystroke still sitting inside that 400ms debounce window. Without this, typing a
// line of narration and immediately tapping Back lost it: renderPlotLens() rebuilds every beat
// from the PERSISTED story, so an in-memory edit that hadn't been flushed yet was simply
// overwritten by the older saved copy. Called on every exit path from the screen.
function plFlushNarration(){
  if (!plSetNarration._t) return;
  clearTimeout(plSetNarration._t);
  plSetNarration._t = null;
  if (plStory) plPersistStory(plStory);
}


// ══ PLAYBACK MINIMAP ══
// A story of photographs answers "what did we see"; it cannot answer "where was
// that, and how far had we walked by then" — and on a survey those are the same
// question. So the player carries a small map in the corner, in the StoryMapJS
// tradition: the whole route drawn as a dotted trail, the part already narrated
// drawn solid on top of it, and a pulse on the frame currently on screen. The
// map pans between points as the story advances, so the trail is watched being
// walked rather than presented finished.
//
// Its own Leaflet instance, and only alive while the player is open. The story
// map on the PlotLens screen underneath keeps its own framing, and re-fitting a
// map the user left somewhere is exactly the state-clobbering dockReviewMap()
// exists to avoid.
//
// Tiles come from the single 'plotedge_basemap' preference through ATLAS_BASEMAPS,
// like every other map in the app — the Settings choice governs this one too.
let plMiniMap = null, plMiniLayer = null, plMiniBase = null, plMiniTrack = null;

function plMiniBasemapSpec(){
  let key = 'street';
  try { key = localStorage.getItem('plotedge_basemap') || 'street'; } catch(e) {}
  const registry = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  return (registry && registry[key])
    || { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr:'', max:19 };
}

function ensurePlMiniMap(){
  if (plMiniMap) return plMiniMap;
  const el = document.getElementById('plMiniMap');
  if (!el || typeof L === 'undefined') return null;
  // Every interaction is off: this is an indicator inside a playing story, not a
  // map to pan. A stray drag while reaching for the next-frame tap zone would
  // otherwise leave the route off-screen for the rest of the playback.
  // PE_NO_ROTATE_OPTIONS is not redundant with "we never asked for rotation":
  // the plugin defaults `rotateControl` to true for EVERY map, so without an
  // explicit false this indicator grew a compass button of its own (see the
  // comment in ensurePlMap above). Rotation itself stays off here on purpose —
  // every other interaction is off too, because this is a read-only pulse in the
  // corner of a playing story, not a map to handle.
  peCanRotateMaps();
  plMiniMap = L.map(el, Object.assign({
    zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false,
    doubleClickZoom:false, boxZoom:false, keyboard:false, touchZoom:false, tap:false
  }, PE_NO_ROTATE_OPTIONS));
  const spec = plMiniBasemapSpec();
  plMiniBase = L.tileLayer(spec.url, { maxZoom: spec.max });
  plMiniBase.addTo(plMiniMap);
  plMiniLayer = L.layerGroup().addTo(plMiniMap);
  return plMiniMap;
}

// Called by setBasemapPref() so changing the style mid-story takes effect at
// once rather than on the next playback.
function plSyncMiniMapBasemap(){
  if (!plMiniMap) return;
  const spec = plMiniBasemapSpec();
  if (plMiniBase) { try { plMiniMap.removeLayer(plMiniBase); } catch(e) {} }
  plMiniBase = L.tileLayer(spec.url, { maxZoom: spec.max });
  plMiniBase.addTo(plMiniMap);
  if (plMiniBase.bringToBack) plMiniBase.bringToBack();
}

function destroyPlMiniMap(){
  if (plMiniMap){ try { plMiniMap.remove(); } catch(e) {} }
  plMiniMap = null; plMiniLayer = null; plMiniBase = null; plMiniTrack = null;
}

// Redrawn per frame rather than mutated, because frames can be stepped BACKWARDS
// (the left tap zone) and a trail that only ever grows would be lying about
// where the story currently is.
function plUpdateMiniMap(){
  const map = ensurePlMiniMap();
  const wrap = document.getElementById('plMiniMapWrap');
  if (!map){ if (wrap) wrap.style.display = 'none'; return; }
  const pts = plMapPoints();
  // A story whose photos carry no coordinates has nothing to show; hiding the
  // box is better than an empty grey square in the corner of every frame.
  if (pts.length < 1){ if (wrap) wrap.style.display = 'none'; return; }
  if (wrap) wrap.style.display = '';
  plMiniLayer.clearLayers();

  const accent = cssVar('--accent-primary');
  const all = pts.map(p=>[p.lat, p.lon]);
  const here = Math.min(plIndex, pts.length - 1);

  // The full route, dotted and faint — the part still to come.
  if (all.length > 1){
    L.polyline(all, { color:'#fff', weight:2, opacity:0.55, dashArray:'3 5', interactive:false }).addTo(plMiniLayer);
  }
  // The part already told, solid and in the app's accent, drawn over the dots.
  if (here > 0){
    L.polyline(all.slice(0, here + 1), { color:accent, weight:3, opacity:0.95, interactive:false }).addTo(plMiniLayer);
  }
  pts.forEach((p, i)=>{
    if (i === here) return;
    L.circleMarker([p.lat, p.lon], {
      radius: i < here ? 3.5 : 2.5,
      color:'#fff', weight:1,
      fillColor: i < here ? accent : '#fff',
      fillOpacity: i < here ? 1 : 0.6,
      interactive:false
    }).addTo(plMiniLayer);
  });
  // The current frame. A divIcon rather than a circleMarker so the pulse can be
  // a CSS animation — Leaflet vectors cannot animate their own radius.
  L.marker(all[here], {
    interactive:false,
    icon: L.divIcon({ className:'pl-mini-here', html:'<span></span>', iconSize:[16,16], iconAnchor:[8,8] })
  }).addTo(plMiniLayer);

  // Framing: the whole route while it still fits comfortably, otherwise follow
  // the current point. On a long corridor a fitted route is a line of pixels and
  // tells you nothing; on a small site, watching the pin move across the whole
  // shape is the entire point.
  const expanded = wrap && wrap.classList.contains('expanded');
  if (all.length === 1){
    map.setView(all[0], 17);
  } else if (expanded || all.length <= 12){
    map.fitBounds(L.latLngBounds(all), { padding:[18,18], maxZoom:17, animate:true });
  } else {
    map.setView(all[here], Math.max(map.getZoom() || 16, 16), { animate:true });
  }
  setTimeout(()=>{ if (plMiniMap) plMiniMap.invalidateSize(); }, 40);
}

// Tapping the minimap swaps between "follow the pin" and "show the whole route".
// Stops propagation so it never reads as a next-frame tap.
function plToggleMiniMap(ev){
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const wrap = document.getElementById('plMiniMapWrap');
  if (!wrap) return;
  wrap.classList.toggle('expanded');
  setTimeout(()=>{ if (plMiniMap) plMiniMap.invalidateSize(); plUpdateMiniMap(); }, 220);
}


// ── PLAYBACK ──
// startAt lets the story tray drop straight into a frame instead of always
// replaying from the beginning. Defaulted and clamped rather than trusted: the
// tray is rendered from plStory, but a beat can be dropped between render and
// tap (a photo deleted in another tab), and an out-of-range plIndex would put
// plRenderFrame() into its "no beat here" path and close the player instantly.
function playPlotLens(startAt){
  plFlushNarration();
  if (!plStory || !plStory.length) return;
  const n = Number(startAt);
  plIndex = Number.isInteger(n) ? Math.min(Math.max(n, 0), plStory.length - 1) : 0;
  document.getElementById('plPlayer').classList.add('show');
  plRenderFrame();
  // After .show, not before: Leaflet measures its container on creation, and the
  // player is visibility:hidden until that class lands. Created at zero size it
  // would render a single grey tile and stay that way.
  requestAnimationFrame(()=>plUpdateMiniMap());
}

function stopPlotLens(){
  clearTimeout(plTimer); plTimer = null;
  const p = document.getElementById('plPlayer');
  if (p) p.classList.remove('show');
  // Leaflet keeps timers and listeners on an instance whose container is hidden,
  // and the player can be reopened many times in a session.
  destroyPlMiniMap();
}

function plStep(delta){
  const next = plIndex + delta;
  if (next < 0) return;
  if (next >= plStory.length){ stopPlotLens(); return; }
  plIndex = next;
  plRenderFrame();
}

function plRenderFrame(){
  clearTimeout(plTimer);
  const b = plStory[plIndex];
  const r = b && plResolve(b);
  // A deleted photo mid-story shouldn't strand the player — skip past it.
  if (!r){ if (plIndex + 1 < plStory.length){ plIndex++; plRenderFrame(); } else stopPlotLens(); return; }

  const dur = (b.dur || PL_DEFAULT_DUR);
  const stage = document.getElementById('plStage');
  stage.style.setProperty('--pl-dur', dur + 's');
  // Two layers kept alive at a time so the outgoing frame can fade under the incoming one.
  const incoming = document.createElement('div');
  incoming.className = 'pl-frame';
  // photoFullSrc() paints whatever is already resident (usually the thumbnail)
  // so the frame never appears blank, and photoEnsureFull() upgrades it to the
  // full-resolution image once its blob is read out of the media store.
  incoming.innerHTML = `<img src="${photoFullSrc(r.p)}" alt="">`;
  photoEnsureFull(r.p).then(url=>{
    const img = incoming.querySelector('img');
    if (url && img && incoming.isConnected) img.src = url;
  });
  stage.appendChild(incoming);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    incoming.classList.add('on');
    stage.querySelectorAll('.pl-frame').forEach(el=>{ if (el !== incoming) el.classList.remove('on'); });
    setTimeout(()=>{ stage.querySelectorAll('.pl-frame').forEach(el=>{ if (el !== incoming) el.remove(); }); }, 600);
  }));

  const prog = document.getElementById('plProgress');
  prog.style.setProperty('--pl-dur', dur + 's');
  prog.innerHTML = plStory.map((_,i)=>
    `<span class="${i < plIndex ? 'done' : i === plIndex ? 'active' : ''}"><i></i></span>`).join('');

  document.getElementById('plLoc').textContent = r.v.lat != null
    ? r.v.lat.toFixed(5) + ', ' + r.v.lon.toFixed(5) + (r.v.acc != null ? '  ±' + formatLength(r.v.acc) : '')
    : '';
  document.getElementById('plNarr').textContent = b.narration || r.f.name || '';
  document.getElementById('plJump').style.display = '';
  plUpdateMiniMap();

  plTimer = setTimeout(()=>plStep(1), dur * 1000);
}

// The "linkable to Collect" half: a frame knows which feature it came from, so the story is a way
// back into the data rather than a dead-end slideshow.
function plJumpToFeature(){
  const b = plStory && plStory[plIndex];
  if (!b) return;
  stopPlotLens();
  switchTab('review');
  setTimeout(()=>{ if (typeof openInspect === 'function') openInspect(b.fid); }, 120);
}


// Template for the exported story file. Kept as its own constant rather than inlined so the
// closing script tag it must contain can be written as "<\/script>" — an unescaped one would
// terminate THIS script block and take the whole app down at parse time.
const PLOTLENS_EXPORT_SHELL = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>__TITLE__ — PlotLens</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow:hidden;height:100dvh}
#stage{position:fixed;inset:0;overflow:hidden}
.f{position:absolute;inset:0;opacity:0;transition:opacity .5s ease}
.f.on{opacity:1}
.f img{width:100%;height:100%;object-fit:cover}
.f.on img{animation:kb var(--d,5s) ease-out forwards}
@keyframes kb{from{transform:scale(1.06)}to{transform:scale(1.18) translate3d(-1.5%,-1.5%,0)}}
#scrim{position:fixed;inset:0;pointer-events:none;background:linear-gradient(to top,rgba(0,0,0,.82) 0%,rgba(0,0,0,.25) 38%,transparent 62%)}
#bar{position:fixed;top:10px;left:12px;right:12px;display:flex;gap:4px;z-index:3}
#bar span{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.3);overflow:hidden}
#bar i{display:block;height:100%;width:0;background:#fff}
#bar .done i{width:100%}
#bar .active i{animation:fill var(--d,5s) linear forwards}
@keyframes fill{from{width:0}to{width:100%}}
#info{position:fixed;left:0;right:0;bottom:0;z-index:3;padding:20px 18px calc(24px + env(safe-area-inset-bottom));pointer-events:none}
#loc{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:rgba(255,255,255,.8);margin-bottom:6px}
#narr{font-size:19px;font-weight:700;line-height:1.35;text-shadow:0 2px 12px rgba(0,0,0,.6)}
#meta{margin-top:6px;font-size:11.5px;color:rgba(255,255,255,.65)}
.tap{position:fixed;top:0;bottom:0;z-index:2;border:none;background:transparent;cursor:pointer}
#prev{left:0;width:33%}#next{left:33%;right:0}
#end{position:fixed;inset:0;z-index:5;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:rgba(0,0,0,.9)}
#end button{padding:11px 22px;border-radius:999px;border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
@media(prefers-reduced-motion:reduce){.f.on img{animation:none;transform:scale(1.04)}.f{transition:none}}
</style></head><body>
<div id="stage"></div><div id="scrim"></div><div id="bar"></div>
<div id="info"><div id="loc"></div><div id="narr"></div><div id="meta"></div></div>
<button class="tap" id="prev" aria-label="Previous"></button>
<button class="tap" id="next" aria-label="Next"></button>
<div id="end"><div style="font-size:17px;font-weight:700;">End of story</div><button onclick="go(0)">Replay</button></div>
<script>
var D=__PAYLOAD__,i=0,t=null;
var stage=document.getElementById('stage'),bar=document.getElementById('bar'),endEl=document.getElementById('end');
function go(n){
  clearTimeout(t);
  if(n<0)return;
  if(n>=D.frames.length){endEl.style.display='flex';return;}
  endEl.style.display='none';
  i=n;var f=D.frames[i];
  document.documentElement.style.setProperty('--d',f.dur+'s');
  var el=document.createElement('div');el.className='f';
  var im=document.createElement('img');im.src=f.src;el.appendChild(im);stage.appendChild(el);
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    el.classList.add('on');
    [].forEach.call(stage.querySelectorAll('.f'),function(o){if(o!==el)o.classList.remove('on');});
    setTimeout(function(){[].forEach.call(stage.querySelectorAll('.f'),function(o){if(o!==el)o.remove();});},600);
  });});
  bar.innerHTML=D.frames.map(function(_,k){return '<span class="'+(k<i?'done':k===i?'active':'')+'"><i></i></span>';}).join('');
  document.getElementById('loc').textContent=(f.lat!=null?f.lat.toFixed(5)+', '+f.lon.toFixed(5):'');
  document.getElementById('narr').textContent=f.narration||'';
  document.getElementById('meta').textContent=[f.type,f.feature,f.when?new Date(f.when).toLocaleString():''].filter(Boolean).join(' · ');
  t=setTimeout(function(){go(i+1);},f.dur*1000);
}
document.getElementById('prev').onclick=function(){go(i-1);};
document.getElementById('next').onclick=function(){go(i+1);};
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(i+1);if(e.key==='ArrowLeft')go(i-1);});
go(0);
<\/script></body></html>`;


// ── EXPORT ──
// Self-contained HTML: photos are inlined as base64 here, at export time only. That is the whole
// reason PlotLens can afford to be photo-driven — the bytes exist in the exported file, never in
// the app's localStorage budget. Exports as a separate file, as asked, and plays anywhere with a
// browser and no network.
async function exportPlotLensStory(){
  plFlushNarration();
  if (!plStory || !plStory.length){ showToast('No frames to export'); return; }
  // A story file is standalone HTML with its images inlined, so the bytes have
  // to be read back out of the media store before the frames are built.
  const _photos = await hydrateExportPhotos(savedFeatures);
  const proj = projects.find(p => p.id === activeProjectId);
  const title = (proj && proj.name) || 'PlotEdge story';
  const frames = plStory.map(b => {
    const r = plResolve(b);
    if (!r) return null;
    return {
      src: photoFullSrc(r.p),
      narration: b.narration || r.f.name || '',
      feature: r.f.name || '',
      type: resolveFeatureType(r.f).label,
      lat: r.v.lat, lon: r.v.lon,
      when: r.p.takenAt || r.v.time || null,
      dur: b.dur || PL_DEFAULT_DUR
    };
  }).filter(Boolean);
  releaseExportPhotos(_photos);
  if (!frames.length){ showToast('No frames to export'); return; }

  // JSON is embedded inside a script block in the exported file, so a closing script tag
  // appearing in user-entered narration would close it early and corrupt that file. Escaping
  // "</" is the standard fix. (Note this comment describes the tag rather than spelling it out:
  // writing it literally here would close THIS script block — which is exactly what happened
  // the first time round.)
  const payload = JSON.stringify({ title, frames }).replace(/<\//g, '<\\/');
  const html = PLOTLENS_EXPORT_SHELL.replace('__TITLE__', escapeHtml(title)).replace('__PAYLOAD__', payload);
  dl(html, 'PlotLens_' + (title||'story').replace(/[^\w-]+/g,'_') + '_' + ts() + '.html', 'text/html');
  showToast('Story exported');
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Collect answers "what is where I'm standing"; PlotEtch answers "what is over there". Sketches
// are kept in their own array rather than mixed into savedFeatures — see the view comment in the
// markup for why that separation matters to every accuracy figure in the app.
let plotetchSketches = [];      // finished shapes: {id,name,type,vertices:[{lat,lon}],derived,note}

let peDraft = null;             // in-progress shape: {type, vertices:[]}

let peMode = 'point';

let peSelectedId = null;

let peMap = null, peLayerGroup = null, peDraftGroup = null;

let peStreetLayer = null, peSatLayer = null, peBasemap = 'street';


// ── LOCAL PLANAR PROJECTION ──
// Every analysis operation below works in metres on a local tangent plane rather than in degrees:
// a degree of longitude is ~111km at the equator and ~0km at the poles, so any distance, area or
// intersection computed directly on lat/lon is wrong by a latitude-dependent factor. Anchoring on
// the data's own mean latitude keeps the distortion under a tenth of a percent across the few-km
// extents this app deals with, and makes the inverse exact enough to round-trip vertices.
function peProjector(vertices){
  const R = 6378137;
  const lat0 = vertices.reduce((s,v)=>s+v.lat,0)/vertices.length;
  const cosLat = Math.cos(lat0*Math.PI/180);
  return {
    fwd: v => ({ x:(v.lon*Math.PI/180)*R*cosLat, y:(v.lat*Math.PI/180)*R }),
    inv: p => ({ lat:(p.y/R)*180/Math.PI, lon:(p.x/(R*cosLat))*180/Math.PI })
  };
}


// ── CONVEX HULL (Andrew's monotone chain) ── exact, O(n log n).
function peConvexHullXY(pts){
  if (pts.length < 3) return pts.slice();
  const s = pts.slice().sort((a,b)=> a.x===b.x ? a.y-b.y : a.x-b.x);
  const cross = (o,a,b)=> (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x);
  const lower=[], upper=[];
  for (const p of s){ while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop(); lower.push(p); }
  for (let i=s.length-1;i>=0;i--){ const p=s[i]; while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}


// ── DISTANCE TO A SEGMENT ── the primitive the buffer's distance field is built on.
function peDistToSeg(p, a, b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2 = dx*dx+dy*dy;
  if (len2 === 0) return Math.hypot(p.x-a.x, p.y-a.y);
  let t = ((p.x-a.x)*dx + (p.y-a.y)*dy)/len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x-(a.x+t*dx), p.y-(a.y+t*dy));
}

function pePointInRingXY(p, ring){
  let inside=false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++){
    const vi=ring[i], vj=ring[j];
    if (((vi.y>p.y)!==(vj.y>p.y)) && (p.x < (vj.x-vi.x)*(p.y-vi.y)/(vj.y-vi.y)+vi.x)) inside=!inside;
  }
  return inside;
}


// ══ RASTER BOOLEAN ENGINE ══
// Buffer, intersect and clip all reduce to the same question — "which points satisfy predicate
// P?" — so they share one implementation: sample P over a grid, then trace the boundary of the
// true region with marching squares.
//
// The alternative was three separate exact algorithms (Minkowski offsetting for buffer,
// Greiner–Hormann for the two overlays), each with its own degenerate-case failures around
// collinear points, touching edges and self-intersections. Those failure modes are silent and
// produce plausible-looking wrong answers. This engine instead has one honest, bounded error —
// the boundary is accurate to roughly one cell — which is reported to the user with every result
// rather than hidden. For planning-scale field work that's the right trade; the UI says so
// explicitly so nobody mistakes it for survey-grade output.
const PE_GRID = 220; // cells per axis — ~48k samples, fast enough to stay interactive on a phone

function peRasterize(predicate, bbox, n){
  const { minX, minY, maxX, maxY } = bbox;
  const dx=(maxX-minX)/n, dy=(maxY-minY)/n;
  const g = new Uint8Array((n+1)*(n+1));
  for (let j=0;j<=n;j++){
    for (let i=0;i<=n;i++){
      g[j*(n+1)+i] = predicate({ x:minX+i*dx, y:minY+j*dy }) ? 1 : 0;
    }
  }
  return { g, n, minX, minY, dx, dy };
}

// Marching squares, boundary-following variant: walks cell edges and stitches the crossings into
// closed rings. Returns rings sorted largest-first so callers can treat ring[0] as the main body.
function peMarchingSquares(field){
  const { g, n, minX, minY, dx, dy } = field;
  const at = (i,j)=> (i<0||j<0||i>n||j>n) ? 0 : g[j*(n+1)+i];
  const segs = [];
  const px = (i,j)=>({ x:minX+i*dx, y:minY+j*dy });
  const mid = (a,b)=>({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
  for (let j=0;j<n;j++){
    for (let i=0;i<n;i++){
      const tl=at(i,j+1), tr=at(i+1,j+1), br=at(i+1,j), bl=at(i,j);
      const idx = (tl<<3)|(tr<<2)|(br<<1)|bl;
      if (idx===0 || idx===15) continue;
      const pTL=px(i,j+1), pTR=px(i+1,j+1), pBR=px(i+1,j), pBL=px(i,j);
      const eT=mid(pTL,pTR), eR=mid(pTR,pBR), eB=mid(pBL,pBR), eL=mid(pTL,pBL);
      const push=(a,b)=>segs.push([a,b]);
      switch(idx){
        case 1: case 14: push(eL,eB); break;
        case 2: case 13: push(eB,eR); break;
        case 3: case 12: push(eL,eR); break;
        case 4: case 11: push(eT,eR); break;
        case 6: case 9:  push(eT,eB); break;
        case 7: case 8:  push(eL,eT); break;
        case 5: push(eL,eT); push(eB,eR); break;   // saddle
        case 10: push(eL,eB); push(eT,eR); break;  // saddle
      }
    }
  }
  if (!segs.length) return [];
  // Stitch segments into rings by matching endpoints on a rounded key (floating-point midpoints
  // of the same edge are computed identically, but rounding guards against drift regardless).
  const key = p => `${Math.round(p.x*1000)}_${Math.round(p.y*1000)}`;
  const adj = new Map();
  segs.forEach(([a,b])=>{
    const ka=key(a), kb=key(b);
    if(!adj.has(ka)) adj.set(ka,{p:a,links:[]});
    if(!adj.has(kb)) adj.set(kb,{p:b,links:[]});
    adj.get(ka).links.push(kb); adj.get(kb).links.push(ka);
  });
  const used = new Set(), rings = [];
  for (const startK of adj.keys()){
    if (used.has(startK)) continue;
    const ring = []; let cur = startK, prev = null, guard = 0;
    while (cur && !used.has(cur) && guard++ < 200000){
      used.add(cur); ring.push(adj.get(cur).p);
      const nexts = adj.get(cur).links.filter(k=>k!==prev && !used.has(k));
      prev = cur; cur = nexts[0];
    }
    if (ring.length >= 3) rings.push(ring);
  }
  const ringArea = r => { let a=0; for(let i=0;i<r.length;i++){ const p=r[i],q=r[(i+1)%r.length]; a+=p.x*q.y-q.x*p.y; } return Math.abs(a)/2; };
  return rings.sort((a,b)=>ringArea(b)-ringArea(a));
}

// Drops near-collinear vertices so a 220×220 trace doesn't hand back 1,400 points for what is
// visually a rectangle. Ramer–Douglas–Peucker, tolerance in metres.
function peSimplify(pts, tol){
  if (pts.length < 3) return pts;
  const d = (p,a,b)=>{
    const dx=b.x-a.x, dy=b.y-a.y;
    if (dx===0&&dy===0) return Math.hypot(p.x-a.x,p.y-a.y);
    return Math.abs(dy*p.x - dx*p.y + b.x*a.y - b.y*a.x)/Math.hypot(dx,dy);
  };
  const rec = (s,e)=>{
    let maxD=0, idx=-1;
    for (let i=s+1;i<e;i++){ const dd=d(pts[i],pts[s],pts[e]); if(dd>maxD){maxD=dd;idx=i;} }
    if (maxD>tol && idx>0) return [...rec(s,idx), ...rec(idx,e).slice(1)];
    return [pts[s], pts[e]];
  };
  return rec(0, pts.length-1);
}


// ── SHARED ENTRY POINT for the three raster ops ──
// Takes a predicate in projected metres plus the extent it should be evaluated over, and returns
// lat/lon rings ready to store as a sketch.
function peRasterOp(predicate, bboxXY, proj, pad){
  const bbox = {
    minX: bboxXY.minX-pad, minY: bboxXY.minY-pad,
    maxX: bboxXY.maxX+pad, maxY: bboxXY.maxY+pad
  };
  const field = peRasterize(predicate, bbox, PE_GRID);
  const rings = peMarchingSquares(field);
  const cell = Math.max(field.dx, field.dy);
  return {
    rings: rings.map(r=>peSimplify(r, cell*0.55).map(p=>proj.inv(p))),
    cell
  };
}


// ══ SKETCH HELPERS ══
function peSketchById(id){ return plotetchSketches.find(s=>s.id===id); }

function peSelected(){ return peSelectedId ? peSketchById(peSelectedId) : null; }

function peNewId(){ return 'pe_'+Date.now()+'_'+Math.floor(Math.random()*1000); }

function peMeasureOf(s){
  if (s.type==='point') return `${s.vertices.length} pt`;
  if (s.type==='line')  return formatLength(lineLengthM(s.vertices));
  const r = polygonAreaAndPerimeterM(s.vertices);
  return formatArea(r.area != null ? r.area : r.areaSqm);
}

function peAddSketch(type, vertices, name, extra){
  const s = Object.assign({ id:peNewId(), name: name || peAutoName(type), type, vertices }, extra||{});
  plotetchSketches.push(s);
  peSelectedId = s.id;
  persist();
  renderPlotEtch();
  return s;
}

function peAutoName(type){
  const n = plotetchSketches.filter(s=>s.type===type).length + 1;
  return `${type.charAt(0).toUpperCase()+type.slice(1)} ${n}`;
}


// ══ MAP ══
function ensurePlotEtchMap(){
  if (peMap) return peMap;
  const el = document.getElementById('plotetchMap');
  if (!el || typeof L === 'undefined') return null;
  // rotate/touchRotate (Leaflet-Rotate plugin, loaded in index.html) makes a two-finger twist
  // turn the map the way Google Maps does — without it the gesture is just silently ignored,
  // since plain Leaflet never implemented rotation. Compass control only appears once actually
  // rotated (closeOnZeroBearing) and taps back to north; bottomleft is free on this map.
  // Options and control both come from js/13b-map-rotate.js — see the header there.
  const canRotate = peCanRotateMaps();
  peMap = L.map(el, Object.assign(
    { zoomControl:true, attributionControl:true },
    canRotate ? peRotateMapOptions('bottomleft') : {}
  ));
  if (canRotate) peAttachRotationSync(peMap);
  peStreetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'&copy; OpenStreetMap contributors' });
  peSatLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
  peBasemap = (typeof currentBasemap!=='undefined' && currentBasemap) ? currentBasemap : 'street';
  (peBasemap==='satellite' ? peSatLayer : peStreetLayer).addTo(peMap);
  peLayerGroup = L.layerGroup().addTo(peMap);
  peDraftGroup = L.layerGroup().addTo(peMap);
  peMap.on('click', onPlotEtchMapClick);
  peMap.setView([0,0], 2);
  updatePeBasemapLabel();
  return peMap;
}

function togglePlotEtchBasemap(){
  if (!peMap) return;
  if (peBasemap==='street'){ peMap.removeLayer(peStreetLayer); peSatLayer.addTo(peMap); peBasemap='satellite'; }
  else { peMap.removeLayer(peSatLayer); peStreetLayer.addTo(peMap); peBasemap='street'; }
  updatePeBasemapLabel();
}

function updatePeBasemapLabel(){
  const l = document.getElementById('peBasemapLabel');
  if (l) l.textContent = peBasemap==='street' ? 'Satellite' : 'Map';
}


// ── SNAPPING ──
// Candidates are every vertex already on screen — other sketches and, importantly, saved features
// too, so a sketch can be traced flush against something already walked with GPS. The threshold is
// defined in screen pixels rather than metres so it feels the same at every zoom: at street zoom
// it's a tight sub-metre snap, zoomed out it's forgiving, which matches what the finger expects.
const PE_SNAP_PX = 14;

function peSnap(latlng){
  if (!snapPref() || !peMap) return { lat:latlng.lat, lon:latlng.lng, snapped:false };
  const target = peMap.latLngToContainerPoint(latlng);
  let best = null, bestD = PE_SNAP_PX;
  const consider = (lat, lon) => {
    const p = peMap.latLngToContainerPoint([lat, lon]);
    const d = Math.hypot(p.x-target.x, p.y-target.y);
    if (d < bestD){ bestD = d; best = { lat, lon }; }
  };
  plotetchSketches.forEach(s=>s.vertices.forEach(v=>consider(v.lat, v.lon)));
  if (peDraft) peDraft.vertices.forEach(v=>consider(v.lat, v.lon));
  savedFeatures.forEach(f=>(f.vertices||[]).forEach(v=>consider(v.lat, v.lon)));
  if (best) return { lat:best.lat, lon:best.lon, snapped:true };
  return { lat:latlng.lat, lon:latlng.lng, snapped:false };
}


function onPlotEtchMapClick(e){
  const snap = peSnap(e.latlng);
  if (peMode === 'point'){
    // A point sketch is complete the moment it's placed — making the user also press Finish for a
    // single tap would be ceremony with no decision in it.
    peAddSketch('point', [{ lat:snap.lat, lon:snap.lon }]);
    showToast(snap.snapped ? 'Point placed (snapped)' : 'Point placed');
    return;
  }
  if (!peDraft) peDraft = { type:peMode, vertices:[] };
  peDraft.vertices.push({ lat:snap.lat, lon:snap.lon });
  renderPlotEtch();
}

function plotEtchUndoVertex(){
  if (!peDraft || !peDraft.vertices.length) return;
  peDraft.vertices.pop();
  if (!peDraft.vertices.length) peDraft = null;
  renderPlotEtch();
}

function plotEtchDiscard(){
  peDraft = null;
  renderPlotEtch();
}

function plotEtchFinish(){
  if (!peDraft) return;
  const min = peDraft.type==='polygon' ? 3 : 2;
  if (peDraft.vertices.length < min){
    showToast(`A ${peDraft.type} needs at least ${min} vertices`);
    return;
  }
  peAddSketch(peDraft.type, peDraft.vertices.slice());
  peDraft = null;
  showToast('Sketch saved');
}

function setPlotEtchMode(mode){
  if (peDraft && peDraft.vertices.length){
    showConfirm('Switching geometry type will discard the shape you\u2019re drawing. Continue?', ()=>{
      peDraft = null; peMode = mode; renderPlotEtch();
    }, 'Discard', 'danger');
    return;
  }
  peDraft = null;
  peMode = mode;
  renderPlotEtch();
}


// ══ RENDER ══
function renderPlotEtch(){
  ['point','line','polygon'].forEach(m=>{
    const b = document.getElementById('peMode'+m.charAt(0).toUpperCase()+m.slice(1));
    if (b) b.classList.toggle('active', peMode===m);
  });
  renderPeSketchList();
  renderPeMap();
  renderPeReadout();
  // The sketch list now lives behind a sheet, so the handle has to carry the count — otherwise
  // there is no way to tell a project with twelve sketches from an empty one without opening it.
  const countEl = document.getElementById('peSketchCount');
  if (countEl) countEl.textContent = String(plotetchSketches.length);
  const snapBtn = document.getElementById('peSnapBtn');
  if (snapBtn) {
    const on = snapPref();
    snapBtn.classList.toggle('on', on);
    snapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    snapBtn.title = on ? 'Snapping on' : 'Snapping off';
  }
  const hasDraft = !!(peDraft && peDraft.vertices.length);
  const min = peMode==='polygon' ? 3 : 2;
  const u = document.getElementById('peUndoBtn'), f = document.getElementById('peFinishBtn'), d = document.getElementById('peDiscardBtn');
  if (u) u.disabled = !hasDraft;
  if (d) d.disabled = !hasDraft;
  if (f) f.disabled = !(hasDraft && peDraft.vertices.length >= min);
  const tc = document.getElementById('peToCollectBtn');
  if (tc) tc.disabled = !peSelected();
}

function renderPeReadout(){
  const t = document.getElementById('peReadoutText');
  const snapEl = document.getElementById('peSnapState');
  if (snapEl) snapEl.textContent = snapPref() ? 'Snap on' : 'Snap off';
  if (!t) return;
  if (peMode==='point' && !peDraft){ t.textContent = 'Tap the map to drop a point'; return; }
  if (!peDraft || !peDraft.vertices.length){ t.textContent = `Tap to place the first vertex of a ${peMode}`; return; }
  const v = peDraft.vertices;
  if (peDraft.type==='line'){
    t.innerHTML = `<strong>${v.length}</strong> vertices · <strong>${escapeHtml(formatLength(lineLengthM(v)))}</strong>`;
  } else if (v.length>=3){
    const r = polygonAreaAndPerimeterM(v);
    t.innerHTML = `<strong>${v.length}</strong> vertices · <strong>${escapeHtml(formatArea(r.area!=null?r.area:r.areaSqm))}</strong>`;
  } else {
    t.innerHTML = `<strong>${v.length}</strong> vertex — ${3-v.length} more to close a polygon`;
  }
}

function renderPeSketchList(){
  const el = document.getElementById('peSketchList');
  if (!el) return;
  if (!plotetchSketches.length){
    el.innerHTML = '<div class="pe-empty">Nothing digitized yet. Pick a geometry type above and tap the map.</div>';
    return;
  }
  el.innerHTML = plotetchSketches.map(s=>`
    <div class="pe-sketch ${s.id===peSelectedId?'sel':''}" onclick="peSelectSketch('${s.id}')">
      <span class="pe-sketch-chip" style="background:${s.derived?'#F59E0B':'#0EA5E9'}"></span>
      <div class="pe-sketch-body">
        <div class="pe-sketch-name">${escapeHtml(s.name)}</div>
        <div class="pe-sketch-meta">${s.type} · ${escapeHtml(peMeasureOf(s))}${s.derived?' · derived':''}</div>
      </div>
      <button class="pe-sketch-x" onclick="event.stopPropagation();peDeleteSketch('${s.id}')" aria-label="Delete sketch">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}

function peSelectSketch(id){
  peSelectedId = (peSelectedId===id) ? null : id;
  renderPlotEtch();
  const s = peSelected();
  if (s && peMap){
    const b = s.vertices.map(v=>[v.lat,v.lon]);
    if (b.length===1) peMap.setView(b[0], Math.max(peMap.getZoom(), 17));
    else peMap.fitBounds(b, { padding:[36,36] });
  }
}

function peDeleteSketch(id){
  const s = peSketchById(id);
  if (!s) return;
  showConfirm(`Delete "${s.name}"?`, ()=>{
    plotetchSketches = plotetchSketches.filter(x=>x.id!==id);
    if (peSelectedId===id) peSelectedId=null;
    persist(); renderPlotEtch(); showToast('Sketch deleted');
  }, 'Delete', 'danger');
}

function renderPeMap(){
  const map = ensurePlotEtchMap();
  const empty = document.getElementById('plotetchMapEmpty');
  if (!map){
    if (empty){ empty.textContent = 'Map couldn\'t load (no connection yet). It\'ll appear next time you have network.'; empty.style.display='flex'; }
    return;
  }
  if (empty) empty.style.display='none';
  peLayerGroup.clearLayers();
  peDraftGroup.clearLayers();

  // Saved features render underneath, dimmed — context to trace against, not something you can
  // accidentally edit here.
  savedFeatures.forEach(f=>{
    const verts = f.vertices||[];
    if (!verts.length) return;
    const geo = f.geometryType||'point';
    if (geo==='point') verts.forEach(v=>L.circleMarker([v.lat,v.lon],{radius:4,color:'#94A3B8',weight:1,fillColor:'#94A3B8',fillOpacity:0.5,interactive:false}).addTo(peLayerGroup));
    else if (geo==='polygon') L.polygon(verts.map(v=>[v.lat,v.lon]),{color:'#94A3B8',weight:1,fillOpacity:0.06,dashArray:'4 3',interactive:false}).addTo(peLayerGroup);
    else L.polyline(verts.map(v=>[v.lat,v.lon]),{color:'#94A3B8',weight:1.5,dashArray:'4 3',interactive:false}).addTo(peLayerGroup);
  });

  plotetchSketches.forEach(s=>{
    const sel = s.id===peSelectedId;
    const color = s.derived ? '#F59E0B' : '#0EA5E9';
    const w = sel ? 4 : 2.5;
    const ll = s.vertices.map(v=>[v.lat,v.lon]);
    if (s.type==='point') ll.forEach(p=>L.circleMarker(p,{radius:sel?8:6,color:'#fff',weight:2,fillColor:color,fillOpacity:0.95}).addTo(peLayerGroup));
    else if (s.type==='polygon') L.polygon(ll,{color,weight:w,fillColor:color,fillOpacity:sel?0.3:0.18}).addTo(peLayerGroup);
    else L.polyline(ll,{color,weight:w}).addTo(peLayerGroup);
  });

  if (peDraft && peDraft.vertices.length){
    const ll = peDraft.vertices.map(v=>[v.lat,v.lon]);
    if (peDraft.type==='polygon' && ll.length>=3) L.polygon(ll,{color:'#10B981',weight:3,dashArray:'6 4',fillOpacity:0.15}).addTo(peDraftGroup);
    else if (ll.length>=2) L.polyline(ll,{color:'#10B981',weight:3,dashArray:'6 4'}).addTo(peDraftGroup);
    ll.forEach((p,i)=>L.circleMarker(p,{radius:5,color:'#fff',weight:2,fillColor: i===0?'#10B981':'#34D399',fillOpacity:1}).addTo(peDraftGroup));
  }
}


// ══ TOOLS SHEET / MAP CONTROLS ══
// The sketch list, transfer buttons and analysis toolbox moved off the screen and into a sheet
// so the map can own the full canvas. Opening it re-renders the list first: the sheet's content
// is generated by the same renderPlotEtch() path as before, so nothing here needs to know how a
// sketch row is built.
function openPeToolsSheet(){
  renderPlotEtch();
  document.getElementById('peToolsSheet').classList.add('show');
}

function closePeToolsSheet(){
  document.getElementById('peToolsSheet').classList.remove('show');
}

// Snapping was buried in a text label inside the old readout bar with no control next to it on
// this screen (only the Collect digitiser had a toggle). It is a per-tap behaviour, so it gets a
// real on/off button in the map stack where its state is visible while drawing.
function togglePlotEtchSnap(){
  setSnapPref(!snapPref());
  renderPlotEtch();
}

// Centring on the current fix is the normal way to start tracing something you are standing next
// to. One-shot getCurrentPosition rather than a watch: this is a "take me there" action, not a
// tracking session, and PlotEtch never records the device position into a sketch.
function plotEtchLocateMe(){
  if (!navigator.geolocation){ showToast('Location not available on this device'); return; }
  showToast('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const map = ensurePlotEtchMap();
      if (!map) return;
      map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom() || 0, 18));
    },
    () => showToast('Couldn\'t get a location fix'),
    { enableHighAccuracy:true, timeout:12000, maximumAge:10000 }
  );
}


// ══ OPEN / CLOSE ══
function openPlotEtch(){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  plotwordsExplain('plotetch');
  setScreenState('map'); // full-bleed satellite tracing — the mesh must not tint the imagery
  activateView('view-plotetch');
  pushNavState('plotetch', { projectId: activeProjectId });
  setTimeout(()=>{
    const map = ensurePlotEtchMap();
    if (map){
      map.invalidateSize();
      // Land somewhere useful rather than at [0,0] zoom 2: existing sketches first, then saved
      // features, then the project's recorded site location.
      const pts = [];
      plotetchSketches.forEach(s=>s.vertices.forEach(v=>pts.push([v.lat,v.lon])));
      if (!pts.length) savedFeatures.forEach(f=>(f.vertices||[]).forEach(v=>pts.push([v.lat,v.lon])));
      if (pts.length){ pts.length===1 ? map.setView(pts[0],17) : map.fitBounds(pts,{padding:[36,36]}); }
      else {
        const p = projects.find(x=>x.id===activeProjectId);
        if (p && p.siteLat!=null && p.siteLon!=null) map.setView([p.siteLat,p.siteLon],15);
      }
    }
    renderPlotEtch();
  }, 60);
}

// Consumes the stop openPlotEtch() pushed, the same way closeMediaGallery()/closeFeatureTypes()
// do. Leaving it on the stack made the *next* Back press a dead one: it popped 'plotetch' while
// the app was already showing view-app, so nothing moved and the button felt broken.
// activateView() isn't called here — popstate does it, so the screen swap happens exactly once
// whether you leave via this button or via the hardware back.
function closePlotEtch(){
  plotwordsDismissAll();
  closePeToolsSheet();
  // No setScreenState() here. It used to force 'home' before leaving, which was wrong twice: it
  // changed the band while the confirm dialog was still over PlotEtch, and it guessed 'home' when
  // the crew may be returning to Collect or Review. activateView() now sets the band from the
  // view (and from the open tab, for view-app), so the destination decides.
  if (peDraft && peDraft.vertices.length){
    showConfirm('You have an unfinished shape. Leave PlotEtch and discard it?', ()=>{
      peDraft=null; history.back();
    }, 'Discard', 'danger');
    return;
  }
  history.back();
}


// ══ IMPORT / EXPORT ══
function plotEtchExport(){
  if (!plotetchSketches.length){ showToast('Nothing to export'); return; }
  const fc = {
    type:'FeatureCollection',
    name:'PlotEtch sketches',
    features: plotetchSketches.map(s=>({
      type:'Feature',
      properties:{ name:s.name, sketch_type:s.type, derived:!!s.derived, note:s.note||'', source:'PlotEtch' },
      geometry: s.type==='point'
        ? { type:'Point', coordinates:[s.vertices[0].lon, s.vertices[0].lat] }
        : s.type==='line'
          ? { type:'LineString', coordinates:s.vertices.map(v=>[v.lon,v.lat]) }
          : { type:'Polygon', coordinates:[[...s.vertices.map(v=>[v.lon,v.lat]), [s.vertices[0].lon, s.vertices[0].lat]]] }
    }))
  };
  dl(JSON.stringify(fc,null,2), `plotetch_${ts()}.geojson`, 'application/json');
  showToast(`${plotetchSketches.length} sketch${plotetchSketches.length>1?'es':''} exported`);
}

function plotEtchImport(){ document.getElementById('peImportInput').click(); }

function onPlotEtchImportFile(ev){
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    let gj;
    try { gj = JSON.parse(rd.result); }
    catch(e){ showToast('That file isn\'t valid GeoJSON'); return; }
    const feats = gj.type==='FeatureCollection' ? (gj.features||[]) : gj.type==='Feature' ? [gj] : [];
    if (!feats.length){ showToast('No features found in that file'); return; }
    let added = 0, skipped = 0;
    feats.forEach(f=>{
      const g = f.geometry; if (!g) { skipped++; return; }
      const props = f.properties||{};
      const nm = props.name || props.Name || props.NAME || null;
      // Multi-part geometries are split into one sketch per part: every operation here works on a
      // single ring/path, so keeping a MultiPolygon whole would make it un-analysable.
      const push = (type, coords) => {
        const verts = coords.map(c=>({ lat:c[1], lon:c[0] })).filter(v=>isFinite(v.lat)&&isFinite(v.lon));
        if (!verts.length) { skipped++; return; }
        // GeoJSON rings repeat the first point last; the app's model doesn't.
        if (type==='polygon' && verts.length>1){
          const a=verts[0], b=verts[verts.length-1];
          if (Math.abs(a.lat-b.lat)<1e-12 && Math.abs(a.lon-b.lon)<1e-12) verts.pop();
        }
        plotetchSketches.push({ id:peNewId(), name: nm || peAutoName(type), type, vertices:verts, note:'imported' });
        added++;
      };
      if (g.type==='Point') push('point', [g.coordinates]);
      else if (g.type==='MultiPoint') g.coordinates.forEach(c=>push('point',[c]));
      else if (g.type==='LineString') push('line', g.coordinates);
      else if (g.type==='MultiLineString') g.coordinates.forEach(l=>push('line', l));
      else if (g.type==='Polygon') push('polygon', g.coordinates[0]||[]);
      else if (g.type==='MultiPolygon') g.coordinates.forEach(poly=>push('polygon', poly[0]||[]));
      else skipped++;
    });
    persist();
    renderPlotEtch();
    if (peMap){
      const pts=[]; plotetchSketches.forEach(s=>s.vertices.forEach(v=>pts.push([v.lat,v.lon])));
      if (pts.length>1) peMap.fitBounds(pts,{padding:[36,36]});
    }
    showToast(`${added} sketch${added===1?'':'es'} imported${skipped?`, ${skipped} skipped`:''}`);
  };
  rd.readAsText(file);
}


// ══ SEND TO COLLECT ══
// The bridge from "traced shape" to "real feature". It loads the geometry into Collect's capture
// buffer and hands over — the user then picks a feature type, fills the attributes and saves
// through the ordinary path, so a PlotEtch-originated feature is validated and exported exactly
// like a walked one. Vertices carry no acc/time because they genuinely have none; writing a
// fabricated accuracy here would poison every accuracy figure the app reports.
function plotEtchSendToCollect(){
  const s = peSelected();
  if (!s){ showToast('Select a sketch first'); return; }
  if (!featureTypes.length){ showToast('Add a feature type first'); return; }
  const matching = featureTypes.filter(ft=>ftAllowsGeometry(ft, s.type));
  if (!matching.length){
    showToast(`No ${s.type} feature type exists yet — create one first`);
    return;
  }
  const proceed = () => {
    closePeToolsSheet(); // this action leaves PlotEtch entirely — the sheet must not survive it
    currentVertices = s.vertices.map(v=>({ lat:v.lat, lon:v.lon, alt:null, acc:null, time:null, attrs:{}, photos:[], source:'plotetch' }));
    openVertexIndex = null;
    const sel = document.getElementById('featureTypeSelect');
    if (sel) { sel.value = matching[0].id; onFeatureTypeChange && onFeatureTypeChange(); }
    const nameEl = document.getElementById('featureName');
    if (nameEl && !nameEl.value.trim()) nameEl.value = s.name;
    persist();
    activateView('view-app');
    switchTab('collect');
    renderPoints(); renderVertexEditor(); updateStats();
    showToast(`${s.vertices.length} vertices loaded into Capture`);
  };
  if (currentVertices.length){
    showConfirm(`Collect already has ${currentVertices.length} captured vertices. Replace them with this sketch?`, proceed, 'Replace', 'danger');
    return;
  }
  proceed();
}
