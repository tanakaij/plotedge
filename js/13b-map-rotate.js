// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Shared map rotation: fixed compass control + overlay sync
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ WHY THIS FILE EXISTS ══
// leaflet-rotate@0.2.8 (loaded from the CDN in index.html) supplies the bearing
// machinery Leaflet core has never shipped, and the two-finger twist itself is
// fine. What is not fine is the control it draws and the way overlays trail the
// map during a gesture. Both were reported from the field, and both are defects
// in the plugin rather than in how this app calls it — so they are fixed here,
// once, for every map instead of being worked around per screen.
//
// The plugin is left on disk untouched: it is a CDN URL, not a vendored file, so
// patching it in place is not an option and pinning a fork would cost the app its
// offline-cacheable single-origin story. These overrides are installed lazily
// (see peInstallMapRotationFixes) because js/*.js are NOT deferred while
// leaflet.js and leaflet-rotate are — at the moment this file parses, `L` does
// not exist yet. Every map factory calls the installer before L.map().
//
// ── DEFECT 1: the compass control ──
//   a) L.Control.Rotate::_handleMouseDrag calls `map.setBearing(deltaX)` — the
//      raw pixel delta, as an ABSOLUTE bearing rather than an offset from the
//      bearing the drag started at. Grabbing the compass therefore snaps the map
//      to an unrelated angle and jumps again on every mousemove.
//   b) The same handler compares `e.clientX` against a `dragstartX` captured
//      from `e.pageX`, so on a scrolled page the first frame jumps by the scroll
//      offset on top of (a).
//   c) It binds mousedown/mousemove/mouseup only. A phone never fires a real
//      mousedown, so dragging the compass does nothing at all on the devices
//      this app is built for — and the synthesised click still runs _cycleState,
//      so a tap meant as a drag silently changes rotation mode instead.
//   d) closeOnZeroBearing never re-hides it: _restyle only hides inside its
//      "locked" branch, but _cycleState's locked branch re-enables touchRotate
//      when closeOnZeroBearing is set, so after tapping back to north the
//      control takes the "touch" branch and stays on screen for good.
//   e) _restyle writes backgroundColor as an INLINE style ('grey' / 'orange'),
//      which outranks the themed `background: var(--nav-bg)` rules in
//      04-screens.css, 05-components.css and 06-plotatlas.css — the button stops
//      matching the app the first time it is used.
//   f) The needle is a hard-coded `fill='%23333'` data-URI, near invisible on
//      the dark theme.
//   g) The plugin's init hook adds the control to EVERY map, because it merges
//      `rotateControl: true` into L.Map's defaults. On a map without
//      `rotate:true`, onAdd reads `map.getBearing()` → `undefined * RAD_TO_DEG`
//      → NaN, the `=== 0` test fails, and closeOnZeroBearing never hides it. So
//      the non-rotating maps (the capture screen's vertex map, the PlotLens
//      story map) each grew a permanently visible, permanently disabled compass.
//      That is the "glitchy icon" on the maps that cannot even rotate.
//
// The replacement below is a whole control rather than a patch of the original:
// four of those seven are in one method and the tri-state cycle that produces
// (d) and (e) is a feature this app never wanted. Tap means north, drag means
// rotate, and the thing is invisible while the map is square to north.
//
// ── DEFECT 2: overlays trailing the map ──
//   L.Renderer::getEvents registers `moveend: this._update` and nothing on
//   `move`, and the SVG container is only re-transformed on the `zoom` event.
//   A two-finger twist held at a constant finger distance changes the bearing
//   without changing the zoom, so no `zoom` fires and the paths sit still until
//   the gesture ends. Worse, TouchGestures::_onTouchMove calls setBearing()
//   SYNCHRONOUSLY but defers map._move() into a requestAnimationFrame, so even
//   when something does update, the pane has already turned a frame earlier.
//   peSyncRotatedOverlays() re-runs the geometry half of Renderer::_reset()
//   synchronously on `move` and `rotate`, which is what closes that gap.


// Degrees of bearing per pixel of horizontal drag on the compass. A full turn in
// roughly a screen width: fine enough to line up with a road, coarse enough that
// a gloved thumb can hit a bearing on the first go.
const PE_ROTATE_DEG_PER_PX = 0.9;

// Below this many degrees off north the map counts as "square", and the compass
// hides again under closeOnZeroBearing. Not zero, because a twist gesture almost
// never lands on exactly 0 and a control that will not go away is the complaint
// this whole file exists to answer.
const PE_ROTATE_NORTH_EPSILON = 0.75;

let _peRotateFixesInstalled = false;


// Idempotent. Safe to call before every L.map() — and it must be, since these
// factories are the first code in the app that can be sure Leaflet has loaded.
// Returns true when the rotation plugin is present and the overrides are live,
// false when it never loaded (first-ever launch with no network), in which case
// the caller should build a plain unrotatable map rather than fail.
function peInstallMapRotationFixes(){
  if (_peRotateFixesInstalled) return true;
  if (typeof L === 'undefined' || !L.Control || !L.Control.Rotate) return false;
  _peRotateFixesInstalled = true;
  peDefineRotateControl();
  return true;
}


// Standard options for a map that should rotate. Centralised so "which maps can
// twist" is one list rather than four call sites that drifted apart — the review
// map, PlotAtlas and PlotEtch each spelled this out separately, and the vertex
// map and story map were simply never given it.
// Pass the control's corner; everything else is the same everywhere.
function peRotateMapOptions(position){
  return {
    rotate: true,
    bearing: 0,
    touchRotate: true,
    rotateControl: { position: position || 'bottomleft', closeOnZeroBearing: true }
  };
}

// The counterpart for maps that deliberately do not rotate (the story playback
// minimap is an indicator, not a map you touch). Without this the plugin's
// default `rotateControl: true` bolts a dead compass onto them — defect (g).
const PE_NO_ROTATE_OPTIONS = { rotate: false, touchRotate: false, rotateControl: false };


// ══ THE COMPASS ══
function peDefineRotateControl(){
  L.Control.Rotate = L.Control.extend({

    options: { position: 'bottomleft', closeOnZeroBearing: true },

    onAdd: function(map){
      const container = this._container = L.DomUtil.create('div', 'leaflet-control-rotate leaflet-bar');
      const link = this._link = L.DomUtil.create('a', 'leaflet-control-rotate-toggle', container);
      link.href = '#';
      link.title = 'Drag to rotate · tap to face north';
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', 'Map rotation. Drag sideways to rotate, tap to face north.');

      // Built as real SVG rather than the plugin's data-URI so the needle can use
      // currentColor and inherit whatever the theme has set on the button — the
      // fix for (f). North half solid, south half faded, the usual compass
      // convention that tells you which end is which at a glance.
      const needle = this._needle = L.DomUtil.create('span', 'leaflet-control-rotate-arrow', link);
      needle.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<path class="pe-needle-n" d="M12 3.5 16.2 13H7.8z" fill="currentColor"/>' +
          '<path class="pe-needle-s" d="M12 20.5 7.8 11h8.4z" fill="currentColor" opacity="0.28"/>' +
        '</svg>';

      this._dragging = false;
      this._moved = false;

      // Pointer Events cover mouse, touch and stylus in one path, which is the
      // fix for (c) — the plugin's mouse-only binding meant the drag simply did
      // not exist on a phone. setPointerCapture keeps the gesture alive when the
      // finger slides off the 30px button, which it always does.
      if (window.PointerEvent){
        L.DomEvent.on(link, 'pointerdown', this._onPointerDown, this);
      } else {
        // Ancient WebView fallback. Same relative maths, two transports.
        L.DomEvent.on(link, 'mousedown', this._onLegacyDown, this);
        L.DomEvent.on(link, 'touchstart', this._onLegacyDown, this);
      }
      // The anchor must never navigate or scroll the page under any transport.
      L.DomEvent.on(link, 'click', L.DomEvent.stop);
      L.DomEvent.on(link, 'dblclick', L.DomEvent.stopPropagation);
      L.DomEvent.disableClickPropagation(container);

      map.on('rotate', this._restyle, this);
      this._restyle();
      return container;
    },

    onRemove: function(map){
      map.off('rotate', this._restyle, this);
      this._releaseLegacy();
    },

    // A map built without `rotate:true` has no bearing at all — the plugin read
    // it anyway and got NaN, which is defect (g). Everything here goes through
    // this instead of map.getBearing().
    _bearing: function(){
      const map = this._map;
      if (!map || !map.options || !map.options.rotate || typeof map.getBearing !== 'function') return null;
      const b = map.getBearing();
      return (typeof b === 'number' && isFinite(b)) ? b : null;
    },

    _isNorth: function(bearing){
      const off = Math.abs(((bearing % 360) + 360) % 360);
      return off < PE_ROTATE_NORTH_EPSILON || off > (360 - PE_ROTATE_NORTH_EPSILON);
    },

    // ── DRAG ──
    _onPointerDown: function(e){
      const bearing = this._bearing();
      if (bearing == null) return;
      L.DomEvent.stop(e);
      this._dragging = true;
      this._moved = false;
      this._startX = e.clientX;               // clientX throughout — fixes (b)
      this._startBearing = bearing;
      this._pointerId = e.pointerId;
      try { this._link.setPointerCapture(e.pointerId); } catch(err) {}
      L.DomEvent.on(this._link, 'pointermove', this._onPointerMove, this);
      L.DomEvent.on(this._link, 'pointerup', this._onPointerUp, this);
      L.DomEvent.on(this._link, 'pointercancel', this._onPointerUp, this);
      L.DomUtil.addClass(this._container, 'is-turning');
    },

    _onPointerMove: function(e){
      if (!this._dragging || e.pointerId !== this._pointerId) return;
      L.DomEvent.stop(e);
      this._applyDrag(e.clientX);
    },

    _onPointerUp: function(e){
      if (!this._dragging) return;
      L.DomEvent.stop(e);
      L.DomEvent.off(this._link, 'pointermove', this._onPointerMove, this);
      L.DomEvent.off(this._link, 'pointerup', this._onPointerUp, this);
      L.DomEvent.off(this._link, 'pointercancel', this._onPointerUp, this);
      try { this._link.releasePointerCapture(this._pointerId); } catch(err) {}
      this._finishGesture();
    },

    _onLegacyDown: function(e){
      const bearing = this._bearing();
      if (bearing == null) return;
      L.DomEvent.stop(e);
      const pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
      this._dragging = true;
      this._moved = false;
      this._startX = pt.clientX;
      this._startBearing = bearing;
      this._legacyMove = ev => {
        if (!this._dragging) return;
        const p = (ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
        L.DomEvent.stop(ev);
        this._applyDrag(p.clientX);
      };
      this._legacyUp = ev => { L.DomEvent.stop(ev); this._releaseLegacy(); this._finishGesture(); };
      document.addEventListener('mousemove', this._legacyMove, { passive:false });
      document.addEventListener('touchmove', this._legacyMove, { passive:false });
      document.addEventListener('mouseup', this._legacyUp);
      document.addEventListener('touchend', this._legacyUp);
      L.DomUtil.addClass(this._container, 'is-turning');
    },

    _releaseLegacy: function(){
      if (!this._legacyMove) return;
      document.removeEventListener('mousemove', this._legacyMove);
      document.removeEventListener('touchmove', this._legacyMove);
      document.removeEventListener('mouseup', this._legacyUp);
      document.removeEventListener('touchend', this._legacyUp);
      this._legacyMove = null; this._legacyUp = null;
    },

    // THE fix for (a): a bearing RELATIVE to where the drag started, not the
    // pixel delta reinterpreted as an absolute angle.
    _applyDrag: function(clientX){
      const dx = clientX - this._startX;
      if (Math.abs(dx) > 3) this._moved = true;
      this._map.setBearing(this._startBearing + dx * PE_ROTATE_DEG_PER_PX);
    },

    // A press that never moved is a tap, and a tap on a compass means "face
    // north" — the single intent the tri-state cycle used to bury behind two
    // other modes. Replaces (d)'s unreachable locked state.
    _finishGesture: function(){
      this._dragging = false;
      L.DomUtil.removeClass(this._container, 'is-turning');
      if (!this._moved && this._map && typeof this._map.setBearing === 'function'){
        this._map.setBearing(0);
      }
      this._restyle();
    },

    // No inline backgroundColor anywhere — that was (e). State is a class, so
    // the themed CSS in 04/05/06 keeps ownership of how the button looks.
    _restyle: function(){
      if (!this._container) return;
      const bearing = this._bearing();
      if (bearing == null){
        // Not a rotatable map. The plugin drew a dead grey button here; draw
        // nothing at all.
        this._container.style.display = 'none';
        return;
      }
      this._needle.style.transform = 'rotate(' + bearing + 'deg)';
      const hide = this.options.closeOnZeroBearing && this._isNorth(bearing) && !this._dragging;
      this._container.style.display = hide ? 'none' : '';
      this._link.setAttribute('aria-valuenow', String(Math.round(((bearing % 360) + 360) % 360)));
    }
  });

  L.control.rotate = function(options){ return new L.Control.Rotate(options); };
}


// Set window.PE_ROTATE_SYNC = false in a console to switch the sync below off at
// runtime, then repeat the gesture. If the lag is unchanged the cause is not
// here and this file is the wrong place to be looking; if it comes back, it is.
// Cheap to leave in — it is one boolean read per move event, and it turns "the
// map still feels wrong" into an answerable question in about five seconds.
function peSyncEnabled(){
  return (typeof window === 'undefined') || window.PE_ROTATE_SYNC !== false;
}


// ══ KEEPING GEOMETRY WITH THE MAP ══
// Re-runs the geometry half of L.Renderer::_reset() — _update() to recompute the
// container's bounds/viewBox for the current bearing, then _updateTransform() to
// absorb the pixel-origin change — plus a reposition of any real L.Marker icons,
// which live in the unrotated pane and are placed through the plugin's own
// rotatedPointToMapPanePoint().
//
// ── WHY IT BAILS DURING A ZOOM ANIMATION ──
// leaflet.css carries `.leaflet-zoom-anim .leaflet-zoom-animated { transition:
// transform 0.25s }`, and an SVG renderer's container is exactly a
// .leaflet-zoom-animated element. So every transform written while Leaflet has
// .leaflet-zoom-anim on the map pane is EASED over a quarter of a second rather
// than applied — and writing one repeatedly restarts that ease from scratch each
// time. Geometry that slides toward where the tiles already are is the exact
// symptom this function exists to remove, so syncing through an animated zoom
// would have caused the bug rather than fixed it. Leaflet's own _onAnimZoom()
// owns that window; it sets the transform once and lets the transition play.
//
// ── WHY reproject ON SETTLE ──
// Mid-gesture the container transform is what compensates for a moving pixel
// origin, which is cheap and right. But it accumulates rounding, and after a
// pinch the zoom snaps to a level the last frame never used. _reset() reprojects
// every path from its latlngs against the settled origin, so whatever drifted
// during the gesture is corrected the moment it ends rather than persisting
// until the next redraw.
function peSyncRotatedOverlays(map, opts){
  if (!map || !map._rotate || typeof L === 'undefined') return;
  if (!peSyncEnabled()) return;
  if (map._animatingZoom) return;    // see above — writing here would CAUSE the lag
  let center, zoom;
  try { center = map.getCenter(); zoom = map.getZoom(); } catch(e){ return; }
  if (!center || !isFinite(zoom)) return;

  // Belt and braces for the transition described above. _animatingZoom covers
  // Leaflet's own animated zoom, but a gesture that begins inside the tail of
  // one — a twist started a fraction of a second after a double-tap zoom — would
  // still find the class on the pane. This suppresses the transition outright
  // for anything positioned from here, and is lifted again on settle.
  const settling = !!(opts && opts.reproject);
  try {
    map._container.classList.toggle('pe-no-anim', !settling);
  } catch(e) {}

  const renderers = new Set();
  if (map._renderer) renderers.add(map._renderer);
  const paneRenderers = map._paneRenderers || {};
  for (const k in paneRenderers){ if (paneRenderers[k]) renderers.add(paneRenderers[k]); }

  renderers.forEach(r => {
    try {
      if (settling && typeof r._reset === 'function'){ r._reset(); return; }
      if (r._container && typeof r._update === 'function') r._update();
      if (typeof r._updateTransform === 'function') r._updateTransform(center, zoom);
    } catch(e) { /* one bad renderer must not freeze the gesture */ }
  });

  // circleMarker/polyline/polygon are paths and were handled above; this is for
  // true L.Marker icons — the GPS "you are here" pin, and PlotAtlas's cluster
  // bubbles, which are divIcon markers. Those live in the UNROTATED pane, so
  // unlike the paths they do not come along for free when the rotate pane turns;
  // every one of them has to be repositioned by hand on each frame.
  try {
    map.eachLayer(l => { if (l && l._icon && typeof l.update === 'function') l.update(); });
  } catch(e) {}
}


// Attaches the sync to a map, once. Synchronous on `move`/`zoom` rather than
// throttled through requestAnimationFrame on purpose: those already fire at most
// once per frame during a gesture, and deferring the sync into the NEXT frame is
// the one-frame lag this is here to remove.
function peAttachRotationSync(map){
  if (!map || map._peRotationSync) return map;
  map._peRotationSync = true;
  const live = () => peSyncRotatedOverlays(map);
  // `zoom` fires on every frame of a pinch (an animated zoom is excluded inside
  // the sync itself), which is the half of "zoom or rotate" that `move` alone
  // does not reliably cover: a pinch held at a steady centre changes the zoom
  // without changing the centre.
  map.on('move zoom rotate', live);
  // Settle: reproject and drop the no-transition class. viewreset covers a
  // programmatic setView, zoomend the end of a pinch, moveend inertia.
  const settle = () => peSyncRotatedOverlays(map, { reproject: true });
  map.on('moveend zoomend viewreset', settle);
  // Leaflet is about to run its own 250ms transition and owns the panes for its
  // duration; anything we suppressed has to be handed back before it starts or
  // the animation plays as a jump.
  map.on('zoomanim', () => { try { map._container.classList.remove('pe-no-anim'); } catch(e) {} });
  return map;
}


// One call for the whole dance: install the overrides, build nothing, and hand
// back whether rotation is available. Callers spread peRotateMapOptions() into
// their L.map() options only when this says yes, then run peAttachRotationSync()
// on the result.
function peCanRotateMaps(){
  return peInstallMapRotationFixes();
}
