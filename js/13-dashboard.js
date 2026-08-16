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

function updateStats(){
  renderReadinessChecklist();
  renderDashHealth();

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
  renderDashBackup();
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


function renderDashBackup(){
  const card = document.getElementById('dashBackupCard');
  if (!card) return;
  if (!savedFeatures.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const info = getStorageUsageInfo();
  const fill = document.getElementById('dashStorageFill');
  const label = document.getElementById('dashStorageLabel');
  if (fill) fill.style.width = info.percent + '%';
  if (label) label.textContent = info.percent>=80 ? `Storage ${info.percent}% full` : `Storage ${info.percent}% used`;

  const p = projects.find(x=>x.id===activeProjectId);
  const line = document.getElementById('dashExportLine');
  if (!line) return;
  if (!p || !p.lastExportedAt) {
    line.innerHTML = `<strong>Never exported</strong> · ${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} waiting`;
    line.classList.add('warn');
  } else {
    const newSince = savedFeatures.filter(f=> new Date(f.savedAt) > new Date(p.lastExportedAt)).length;
    line.innerHTML = newSince
      ? `Last exported ${timeAgo(p.lastExportedAt)} · <strong>${newSince} new since</strong>`
      : `Last exported ${timeAgo(p.lastExportedAt)} · <strong>up to date</strong>`;
    line.classList.toggle('warn', newSince > 0);
  }
}
