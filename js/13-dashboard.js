// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — GPS accuracy KPI, dashboard widgets, session insights
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ GPS Accuracy KPI: expand-in-place diagnostics ══
// Tapping the dashboard's GPS Accuracy card reveals live fix info instead of navigating anywhere
// — the phone's built-in GPS only ever gives an accuracy radius, so there's no dedicated
// "diagnostic screen" of satellite plots to justify a whole new destination. When an external
// NMEA receiver is connected, real fix type/HDOP/satellite count are shown; otherwise a short
// note explains why those fields aren't available from the phone alone. Below that, a
// best/average/worst breakdown across every captured vertex gives the historical picture the
// live reading alone doesn't.
function toggleAccuracyDetail(){
  const tile = document.getElementById('dashAccuracyTile');
  if (!tile) return;
  const open = tile.classList.toggle('expanded');
  tile.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderAccuracyDetail(accVals){
  const el = document.getElementById('accDetailBody');
  if (!el) return;
  const rows = [];
  if (extGpsActive && lastExtFix) {
    const label = NMEA_FIX_LABELS[lastExtFix.fixQuality] || 'Fix';
    rows.push(`<div class="acc-detail-row"><span>Source</span><strong>External GPS receiver</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>Fix type</span><strong>${escapeHtml(label)}</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>Satellites</span><strong>${lastExtFix.numSats != null ? lastExtFix.numSats : '—'}</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>HDOP</span><strong>${lastExtFix.hdop != null ? lastExtFix.hdop.toFixed(1) : '—'}</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>Live accuracy</span><strong>±${lastExtFix.accuracy.toFixed(2)}m</strong></div>`);
  } else if (gpsActive && currentPos) {
    rows.push(`<div class="acc-detail-row"><span>Source</span><strong>Built-in GPS (phone)</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>Live accuracy</span><strong>±${currentPos.coords.accuracy.toFixed(1)}m</strong></div>`);
  } else {
    rows.push(`<div class="acc-detail-row"><span>Live fix</span><strong>Not currently acquiring</strong></div>`);
  }
  if (accVals.length) {
    const best = Math.min(...accVals), worst = Math.max(...accVals);
    rows.push(`<div class="acc-detail-row"><span>Best fix captured</span><strong>±${best.toFixed(1)}m</strong></div>`);
    rows.push(`<div class="acc-detail-row"><span>Worst fix captured</span><strong>±${worst.toFixed(1)}m</strong></div>`);
  }
  let note = '';
  if (!(extGpsActive && lastExtFix)) {
    note = `<div class="acc-detail-note">Satellite count and HDOP need an external NMEA GPS receiver — the phone's built-in GPS only reports an accuracy radius. Connect one from the Connect GPS quick action.</div>`;
  }
  el.innerHTML = rows.join('') + note;
}

// ══ PROJECT THUMBNAIL ══
// The dashboard's old full-width Leaflet preview is gone (see the note where dockReviewMap() used
// to live in js/06-collect.js). This draws the same information — the shape of what has been
// collected — as a 46px inline SVG built from vertex coordinates already in memory.
// It is not a map and does not pretend to be one: no tiles, no basemap, no scale. That is the
// point. A field app on a dead data plan renders this identically to one on wifi, and it costs a
// single pass over the vertices rather than a tile fetch and a Leaflet reflow.
// Coordinates are projected with a plain equirectangular fit — longitude scaled by cos(latitude)
// so a survey does not come out stretched sideways — then normalised into the box. At thumbnail
// size any projection more honest than that would be indistinguishable.
function renderDashThumb(){
  const el = document.getElementById('dashProjectThumb');
  if (!el) return;
  const pts = [];
  savedFeatures.forEach(f => (f.vertices || []).forEach(v => {
    if (v && v.lat != null && v.lon != null) pts.push([v.lat, v.lon]);
  }));
  if (!pts.length){
    // An empty project gets a mark, not an empty box: a blank tile beside the project name looks
    // like something failed to load rather than like there is nothing to draw yet.
    el.innerHTML = `<svg class="dash-thumb-empty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px;"><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5z"/><path d="M9 4v13M15 6.5v13"/></svg>`;
    el.setAttribute('aria-label', 'No features captured yet — open the Review map');
    return;
  }
  const lats = pts.map(p=>p[0]), lons = pts.map(p=>p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180) || 1;
  const spanX = Math.max((maxLon - minLon) * kx, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  // One scale for both axes, so the drawing keeps the survey's real proportions instead of
  // stretching a road centreline into a square.
  const S = 100, PAD = 12;
  const scale = (S - PAD * 2) / Math.max(spanX, spanY);
  const offX = (S - spanX * scale) / 2, offY = (S - spanY * scale) / 2;
  const px = (lat, lon) => [
    ((lon - minLon) * kx * scale + offX).toFixed(1),
    // SVG y grows downward; latitude grows northward. Flip, or every survey comes out mirrored.
    (S - ((lat - minLat) * scale + offY)).toFixed(1)
  ];

  let out = '';
  savedFeatures.forEach(f => {
    const vs = (f.vertices || []).filter(v => v && v.lat != null && v.lon != null);
    if (!vs.length) return;
    const color = featureTypeColor(resolveFeatureType(f).key);
    const pathPts = vs.map(v => px(v.lat, v.lon));
    if (vs.length === 1){
      out += `<circle cx="${pathPts[0][0]}" cy="${pathPts[0][1]}" r="3.4" fill="${color}"/>`;
    } else {
      const d = pathPts.map((p,i)=>`${i?'L':'M'}${p[0]} ${p[1]}`).join(' ');
      const closed = (f.geometryType || '') === 'polygon';
      out += `<path d="${d}${closed?' Z':''}" fill="${closed?color:'none'}" fill-opacity="${closed?0.28:0}" stroke="${color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  });
  el.innerHTML = `<svg viewBox="0 0 ${S} ${S}" aria-hidden="true">${out}</svg>`;
  el.setAttribute('aria-label', `${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} captured — open the Review map`);
}


// ══ STATUS SHADE ══
// Every row answers a question about the RIG or the SAFETY of the work, never about how much has
// been collected — that is the KPI grid's job, and repeating it here would make the shade a
// second version of a thing the user already has. Each row is also a link: a status line that
// tells you something is wrong and then leaves you to find the screen that fixes it is only half
// an answer.
// Severity is carried as 'ok' | 'warn' | 'bad' | '' so the peek bar can lead with the worst of
// them rather than with whichever row happens to be first.
// ══ WHAT IS DELIBERATELY *NOT* IN HERE ══
// A status surface earns its space only by saying things nothing else on the screen says. Three
// candidate rows were cut for exactly that reason, and the reasoning is recorded so they do not
// get added back:
//  · POSITION SOURCE / fix type / satellites / HDOP — the GPS Accuracy KPI card already expands in
//    place to show all of it (renderAccuracyDetail above). That card owns the receiver, because
//    that is where the accuracy numbers it explains already live.
//  · UNSAVED CAPTURE — #dashInProgressBanner already announces live vertices and paused captures
//    and taps through to Collect, and it does it more loudly than a row inside a closed drawer
//    could. A second copy would mean the same warning appearing twice on one screen.
//  · DATA QUALITY (low accuracy, missing fields, missing photos) — the readiness checklist and
//    Today's Progress own that, and their rows jump to the offending features, which a status line
//    cannot do.
// What is left is the set of facts with no other home on the dashboard: which grid the project
// works in, whether the work has left the device, how much room is left, and whether the network
// half of the app is reachable.
function dashShadeRows(){
  const rows = [];

  // ── Which grid the numbers come out in ──
  const crs = (typeof projectCrs === 'function') ? projectCrs() : null;
  rows.push({ key:'Working grid', val: crs ? crs.label : 'WGS 84 lat/lon (degrees)', tone:'', run:"openCrsPicker('active')" });

  // ── Has any of it left the device ──
  const p = projects.find(x=>x.id===activeProjectId);
  if (!savedFeatures.length){
    rows.push({ key:'Export', val:'Nothing captured yet', tone:'', run:"switchTabNav('export')" });
  } else if (!p || !p.lastExportedAt){
    rows.push({ key:'Export', val:`Never exported · ${savedFeatures.length} waiting`, tone:'bad', run:"switchTabNav('export')" });
  } else {
    const since = savedFeatures.filter(f => new Date(f.editedAt||f.savedAt) > new Date(p.lastExportedAt)).length;
    rows.push({
      key:'Export',
      val: since ? `${since} change${since===1?'':'s'} since ${timeAgo(p.lastExportedAt)}` : `Up to date · ${timeAgo(p.lastExportedAt)}`,
      tone: since ? 'warn' : 'ok',
      run:"switchTabNav('export')"
    });
  }

  // ── Room left on the device ──
  const info = getStorageUsageInfo();
  rows.push({
    key:'Device storage',
    val:`${info.percent}% used`,
    tone: info.percent >= 90 ? 'bad' : info.percent >= 75 ? 'warn' : 'ok',
    run:'showStorage()'
  });

  // ── Whether the online half of the app is reachable at all ──
  const online = navigator.onLine !== false;
  rows.push({
    key:'Connection',
    // Offline is not a fault in this app — it is the design point — so it reads as neutral, not
    // as an error. It is here because it changes what PlotVault and the web map can do.
    val: online ? 'Online · cloud sync available' : 'Offline · captures stay on device',
    tone: online ? 'ok' : '',
    run:'openPlotVault()'
  });

  return rows;
}

function renderDashShade(){
  const shade = document.getElementById('dashShade');
  const rowsEl = document.getElementById('dashShadeRows');
  const body = document.getElementById('dashShadeBody');
  if (!shade || !rowsEl || !body) return;

  const rows = dashShadeRows();
  rowsEl.innerHTML = rows.map(r =>
    `<button type="button" class="dash-shade-row" onclick="${r.run}">
       <span class="dash-shade-row-dot ${r.tone}"></span>
       <span class="dash-shade-row-body">
         <span class="dash-shade-row-label">${escapeHtml(r.key)}</span>
         <span class="dash-shade-row-val">${escapeHtml(r.val)}</span>
       </span>
       <svg class="dash-shade-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
     </button>`
  ).join('');

  // Three dots, not one per row: the peek bar is read at a glance. These are the three whose bad
  // state actually costs you something — unexported work can be lost, a full device stops capture,
  // and no connection changes what the cloud half of the app can do.
  const byKey = k => rows.find(r => r.key === k) || { tone:'' };
  const dots = ['Export','Device storage','Connection'].map(k =>
    `<span class="dash-shade-dot ${byKey(k).tone}"></span>`).join('');
  const dotsEl = document.getElementById('dashShadeDots');
  if (dotsEl) dotsEl.innerHTML = dots;

  // Lead with the worst thing, so the collapsed bar is never merely decorative.
  const worst = rows.find(r => r.tone === 'bad') || rows.find(r => r.tone === 'warn');
  const line = document.getElementById('dashShadeLine');
  if (line) line.textContent = worst ? `${worst.key}: ${worst.val}` : 'All systems ready';

  // Measured, not guessed. The open height has to be a real number for the transition to ease
  // toward something; it is re-measured on every render because a row's text can wrap differently
  // as the status changes, which would otherwise leave the shade clipped or gapped.
  shade.style.setProperty('--shade-h', body.firstElementChild.scrollHeight + 'px');

  // Restored here rather than at boot, and once: --shade-h has only just become a real number, so
  // restoring any earlier would open the shade to a height of zero and look like a broken drawer.
  if (!_shadeRestored){ _shadeRestored = true; dashShadeRestore(); }
}

let _shadeRestored = false;

function toggleDashShade(){
  const shade = document.getElementById('dashShade');
  if (!shade) return;
  // A drag ends in a pointerup, and a pointerup on a <button> is followed by a click — which would
  // land here and undo whatever the drag just committed. The drag sets this flag on its way out;
  // consuming it here is what keeps one gesture to one state change.
  if (shade.dataset.dragged === '1'){ delete shade.dataset.dragged; return; }
  setDashShadeOpen(!shade.classList.contains('open'));
}

const DASH_SHADE_KEY = 'plotedge_shade_open';

function setDashShadeOpen(open){
  const shade = document.getElementById('dashShade');
  if (!shade) return;
  shade.classList.toggle('open', open);
  const peek = document.getElementById('dashShadePeek');
  if (peek) peek.setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem(DASH_SHADE_KEY, open ? '1' : '0'); } catch(e) {}
}

function dashShadeRestore(){
  let open = false;
  try { open = localStorage.getItem(DASH_SHADE_KEY) === '1'; } catch(e) {}
  const shade = document.getElementById('dashShade');
  if (!shade) return;
  // Applied without the transition so a shade that was left open does not animate itself open on
  // every arrival at the dashboard — that is animating a state the user never left.
  shade.classList.add('dragging');
  setDashShadeOpen(open);
  requestAnimationFrame(()=>shade.classList.remove('dragging'));
}

// ══ THE PULL GESTURE ══
// Tap already works (the peek bar is a button), so this exists to make the shade feel like the
// thing it is modelled on rather than like a disclosure triangle. Pointer events rather than
// touch events so it works with a mouse on the web build and a stylus on a tablet from one path.
//
// Two details that decide whether a drag feels right or wrong:
//  · The height is written directly during the drag, with the CSS transition suppressed. Leaving
//    the transition on means every frame retargets a 300ms ease that never completes, and the
//    shade lags a finger it should be pinned to.
//  · Release commits on distance OR velocity. Distance alone means a fast flick that only
//    travelled 20px snaps shut, which is the specific thing that makes a drawer feel sticky.
(function(){
  const shade = document.getElementById('dashShade');
  if (!shade) return;
  const body = document.getElementById('dashShadeBody');
  if (!body) return;

  let dragging = false, startY = 0, startH = 0, maxH = 0, lastY = 0, lastT = 0, velocity = 0, moved = false;

  const onDown = (e) => {
    // Only from the two grab surfaces. A pointerdown on a status row is somebody pressing that
    // row's link, and turning it into a drag would swallow the tap.
    if (!e.target.closest('#dashShadePeek, #dashShadeGrab')) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    maxH = body.firstElementChild ? body.firstElementChild.scrollHeight : 0;
    startH = shade.classList.contains('open') ? maxH : 0;
    shade.classList.add('dragging');
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    const now = performance.now();
    if (now > lastT) velocity = (e.clientY - lastY) / (now - lastT);   // px per ms, signed
    lastY = e.clientY; lastT = now;
    const h = Math.max(0, Math.min(maxH, startH + dy));
    body.style.height = h + 'px';
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    shade.classList.remove('dragging');
    const h = parseFloat(body.style.height) || 0;
    body.style.height = '';           // hand control back to the class-driven height
    if (!moved) return;               // a tap: the peek bar's own onclick handles it
    // A deliberate flick wins over position; otherwise the halfway point decides.
    const open = Math.abs(velocity) > 0.35 ? velocity > 0 : h > maxH / 2;
    shade.dataset.dragged = '1';      // consumed by toggleDashShade() — see the note there
    setDashShadeOpen(open);
  };

  shade.addEventListener('pointerdown', onDown);
  // Bound to the window, not the shade: a finger that leaves the element mid-drag must keep
  // driving it, and must still commit when it lifts somewhere else entirely.
  window.addEventListener('pointermove', onMove, { passive:true });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
})();

// A tap that followed a drag would toggle a second time on top of what the drag already decided.
// The peek bar's onclick is the tap path; suppressing it after a real drag is handled by the
// `moved` flag above returning early, leaving the click to run alone.

function updateStats(){
  renderReadinessChecklist();
  renderDashHealth();
  renderDashThumb();
  renderDashShade();

  const nF=savedFeatures.length;
  const nP=savedFeatures.reduce((s,f)=>s+(f.vertices||[]).length,0);
  const nL=new Set(savedFeatures.map(f=>f.featureTypeId||f.layer)).size;
  const nPh=savedFeatures.reduce((s,f)=>s+(f.vertices||[]).reduce((s2,v)=>s2+(v.photos||[]).length,0),0);
  ['statFeatures','expStatF','dashFeatures'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=nF;});
  ['statPoints',  'expStatP','dashPoints'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=nP;});
  ['statLayers',  'expStatL'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=nL;});
  ['expStatPh','dashPhotos'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=nPh;});

  // ══ KPI: GPS ACCURACY ══
  // Average accuracy across every captured vertex that recorded a real fix. The signal bar maps
  // that onto a 0-100% position with fixed field-survey bands rather than a linear scale, because
  // the difference between 1m and 3m matters far more to a surveyor than the difference between
  // 20m and 40m — a linear scale would park almost every real reading in the first few pixels.
  const accVals = savedFeatures.flatMap(f=>(f.vertices||[]).map(v=>v.acc)).filter(a=>a!=null && a>0);
  const dashAccEl = document.getElementById('dashAccuracy');
  const dashAccTile = document.getElementById('dashAccuracyTile');
  const dashAccSub = document.getElementById('dashAccuracySub');
  const dashAccMarker = document.getElementById('dashAccMarker');
  if (dashAccEl) {
    if (accVals.length) {
      const avgAcc = accVals.reduce((s,a)=>s+a,0)/accVals.length;
      dashAccEl.innerHTML = '±' + avgAcc.toFixed(1) + '<span class="tile-unit">m</span>';
      if (dashAccTile) {
        dashAccTile.classList.remove('no-fix');
        dashAccTile.classList.toggle('tile-warn', avgAcc > 5);
        dashAccTile.classList.toggle('gps-good',  avgAcc <= 5);
        dashAccTile.classList.toggle('gps-poor',  avgAcc > 5 && avgAcc <= 15);
        dashAccTile.classList.toggle('gps-error', avgAcc > 15);
      }
      // Band edges in metres, mapped to evenly spaced stops along the bar.
      const BANDS = [0, 1, 3, 5, 10, 20, 50];
      let pct = 100;
      for (let i = 1; i < BANDS.length; i++) {
        if (avgAcc <= BANDS[i]) {
          const within = (avgAcc - BANDS[i-1]) / (BANDS[i] - BANDS[i-1]);
          pct = ((i - 1 + within) / (BANDS.length - 1)) * 100;
          break;
        }
      }
      if (dashAccMarker) dashAccMarker.style.left = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
      const quality = avgAcc <= 1 ? 'Excellent signal'
                    : avgAcc <= 3 ? 'Good signal'
                    : avgAcc <= 5 ? 'Usable signal'
                    : avgAcc <= 15 ? 'Weak signal'
                    : 'Poor signal';
      if (dashAccSub) dashAccSub.textContent = `${quality} · average of ${accVals.length} fix${accVals.length===1?'':'es'}`;
    } else {
      dashAccEl.textContent = '—';
      if (dashAccTile) {
        dashAccTile.classList.remove('tile-warn','gps-good','gps-poor','gps-error');
        dashAccTile.classList.add('no-fix');
      }
      if (dashAccSub) dashAccSub.textContent = 'Waiting for a fix';
    }
  }
  renderAccuracyDetail(accVals);

  // ══ KPI SUB-LINES ══ — each says something the numeral alone doesn't.
  const featSub = document.getElementById('dashFeaturesSub');
  if (featSub) featSub.textContent = !nF ? 'No features yet'
    : `Across ${nL} feature type${nL===1?'':'s'}`;
  const ptsSub = document.getElementById('dashPointsSub');
  if (ptsSub) ptsSub.textContent = !nF ? 'Point density tracker'
    : `${(nP/nF).toFixed(1)} per feature on average`;
  const phSub = document.getElementById('dashPhotosSub');
  if (phSub) {
    // "Last capture" is the newest photo, which is the newest save/edit that carried one — photos
    // have no timestamp of their own, so the parent feature's is the honest stand-in.
    let newest = null;
    savedFeatures.forEach(f=>{
      const hasPhoto = (f.vertices||[]).some(v=>(v.photos||[]).length);
      if (!hasPhoto) return;
      const t = f.editedAt || f.savedAt;
      if (t && (!newest || new Date(t) > new Date(newest))) newest = t;
    });
    phSub.textContent = !nPh ? 'No photos yet'
      : newest ? `Last capture ${timeAgo(newest)}` : `${nPh} attached`;
  }

  document.getElementById('sessionBadge').textContent=nF===1?'1 feature':`${nF} features`;
  const sub=document.getElementById('ftDashSub');
  if(sub) sub.textContent = featureTypes.length ? `${featureTypes.length} type${featureTypes.length===1?'':'s'} defined` : 'Define what you capture in this project';
  // In-progress capture banner — surfaces an unfinished line/polygon (or a point mid multi-angle
  // capture) sitting on the Collect tab, so it's obvious there's work to resume even if the user
  // backgrounded the app, switched projects, or reloaded before tapping "Finish"/"Save Feature".
  const banner = document.getElementById('dashInProgressBanner');
  if (banner) {
    // Two kinds of unfinished work, and the dashboard has to name both. The live
    // capture was already covered; paused ones (js/06a-capture-stack.js) were
    // not, and they are the easier of the two to walk away from precisely
    // because nothing on screen is holding them.
    const paused = (typeof suspendedCaptures !== 'undefined') ? suspendedCaptures.length : 0;
    const parts = [];
    if (currentVertices.length) {
      const sel = document.getElementById('featureTypeSelect');
      const ft = sel && !sel.disabled ? getFeatureType(sel.value) : null;
      const geoWord = ft ? (ft.geometryType==='line'?'line':ft.geometryType==='polygon'?'polygon':'point') : 'feature';
      parts.push(`Capture in progress: ${currentVertices.length} vertex${currentVertices.length===1?'':'es'} logged for the current ${geoWord}.`);
    }
    if (paused) {
      parts.push(`${paused} paused capture${paused===1?'':'s'} waiting to be finished.`);
    }
    if (parts.length) {
      banner.textContent = parts.join(' ') + ' Tap to resume.';
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  renderDashWidgets();
}


// ══ DASHBOARD WIDGETS: Recent Activity / Capture Pace + 7-day trend / Backup & Storage ══
// All three read from data already stored on every saved feature (savedAt, editedAt, acc) or the
// existing per-project export tracking (p.lastExportedAt) — nothing new to persist. Hidden with
// display:none until there's at least one saved feature, same as the health card above, so an
// empty project doesn't show three widgets full of zeroes and dashes.
function renderDashWidgets(){
  renderDashRecentActivity();
  renderDashPace();
  renderDashInsightsShell();
}


// ══ SESSION INSIGHTS SHELL ══
// The four widgets above keep their own show/hide logic untouched; this only decides whether the
// wrapper is worth showing at all, and writes the one-line summary shown while it's collapsed.
// Collapsed state is remembered per device — a crew that always wants it open shouldn't have to
// reopen it on every dashboard visit.
const DASH_INSIGHTS_KEY = 'plotedge_insights_open';

function toggleDashInsights(){
  const wrap = document.getElementById('dashInsights');
  if (!wrap) return;
  const open = !wrap.classList.contains('open');
  wrap.classList.toggle('open', open);
  const head = document.getElementById('dashInsightsHead');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem(DASH_INSIGHTS_KEY, open ? '1' : '0'); } catch(e) {}
  // The 7-day sparkline is an SVG inside a max-height:0 container while collapsed, so it may have
  // been drawn with no usable box. Redraw once it actually has one.
  if (open) setTimeout(renderDashPace, 300);
}

function renderDashInsightsShell(){
  const wrap = document.getElementById('dashInsights');
  if (!wrap) return;
  if (!savedFeatures.length){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  let open = false;
  try { open = localStorage.getItem(DASH_INSIGHTS_KEY) === '1'; } catch(e) {}
  wrap.classList.toggle('open', open);
  const head = document.getElementById('dashInsightsHead');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  const summary = document.getElementById('dashInsightsSummary');
  if (summary){
    // Lead with whatever most needs acting on, so the collapsed header is never just decoration:
    // unexported work first, then data-quality problems, then a plain all-clear.
    const { lowacc, missingreq } = computeValidationIssues();
    const p = projects.find(x=>x.id===activeProjectId);
    const unexported = p && p.lastExportedAt
      ? savedFeatures.filter(f=> new Date(f.editedAt||f.savedAt) > new Date(p.lastExportedAt)).length
      : savedFeatures.length;
    const issues = lowacc.length + missingreq.length;
    summary.textContent = unexported
      ? `${unexported} feature${unexported===1?'':'s'} not yet exported`
      : issues
        ? `${issues} feature${issues===1?'':'s'} need attention`
        : 'All captured work exported and checked';
  }
}


// Sync Data tile — this app has no background sync, so it opens Export and lands on the cloud /
// web map end of it rather than the file-download end that "Export Project" already covers.
// openSyncFromDashboard() removed: the dashboard tile that called it no longer exists, and the
// Export tab's Web Map card is reached directly through Quick Actions.

function renderDashRecentActivity(){
  const card = document.getElementById('dashRecentCard');
  const list = document.getElementById('dashRecentList');
  if (!card || !list) return;
  if (!savedFeatures.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const recent = [...savedFeatures]
    .sort((a,b)=> new Date(b.editedAt||b.savedAt) - new Date(a.editedAt||a.savedAt))
    .slice(0, 4);
  list.innerHTML = recent.map(f=>{
    const info = resolveFeatureType(f);
    const color = featureTypeColor(info.key);
    const verts = f.vertices||[];
    const totalPhotos = verts.reduce((s,v)=>s+(v.photos||[]).length,0);
    const meta = `${info.label} · ${verts.length} vertex${verts.length===1?'':'es'}${totalPhotos?` · ${totalPhotos} photo${totalPhotos===1?'':'s'}`:''}`;
    return `<div class="dash-recent-row" onclick="scrollToFeatureCard(${f.id})">
      <div class="dash-recent-chip" style="background:${color};"></div>
      <div class="dash-recent-body">
        <div class="dash-recent-name">${escapeHtml(f.name)}</div>
        <div class="dash-recent-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="dash-recent-time">${timeAgo(f.editedAt||f.savedAt)}</div>
    </div>`;
  }).join('');
}


function renderDashPace(){
  const card = document.getElementById('dashPaceCard');
  if (!card) return;
  if (!savedFeatures.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const now = new Date();
  const dayKey = d => new Date(d).toDateString();
  const todayKey = dayKey(now);
  const todaysFeatures = savedFeatures.filter(f=>dayKey(f.savedAt)===todayKey);

  const valueEl = document.getElementById('dashPaceValue');
  const subEl = document.getElementById('dashPaceSub');
  if (!todaysFeatures.length) {
    valueEl.textContent = '—';
    subEl.textContent = 'No features captured yet today';
  } else {
    const firstToday = todaysFeatures.reduce((min,f)=> new Date(f.savedAt) < new Date(min.savedAt) ? f : min);
    const elapsedHrs = Math.max((now - new Date(firstToday.savedAt)) / 3600000, 1/60); // floor at 1 minute so a single early feature doesn't divide by ~0
    const pace = todaysFeatures.length / elapsedHrs;
    valueEl.innerHTML = pace.toFixed(1) + '<span class="tile-unit" style="font-size:15px;">/hr</span>';
    subEl.textContent = `${todaysFeatures.length} feature${todaysFeatures.length===1?'':'s'} today`;
  }

  // 7-day sparkline — plain inline SVG bars, no charting library needed for 7 numbers.
  const days = [];
  for (let i=6; i>=0; i--){
    const d = new Date(now); d.setDate(d.getDate()-i);
    days.push({ key: d.toDateString(), count: 0, isToday: i===0 });
  }
  const dayMap = new Map(days.map(d=>[d.key, d]));
  savedFeatures.forEach(f=>{
    const k = dayKey(f.savedAt);
    const d = dayMap.get(k);
    if (d) d.count++;
  });
  const max = Math.max(1, ...days.map(d=>d.count));
  const barW = 12, gap = 5, chartH = 32;
  const bars = days.map((d,i)=>{
    const h = d.count ? Math.max(3, Math.round((d.count/max)*chartH)) : 2;
    const x = i*(barW+gap);
    const y = chartH - h + 4;
    return `<rect class="dash-sparkline-bar${d.isToday?' today':''}" x="${x}" y="${y}" width="${barW}" height="${h}" rx="2"><title>${d.count} feature${d.count===1?'':'s'}</title></rect>`;
  }).join('');
  const spark = document.getElementById('dashSparkline');
  if (spark) spark.innerHTML = bars;
}


