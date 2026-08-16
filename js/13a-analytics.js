// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Analytics: charts, time series, distributions, interactive filters
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══════════════════════════════════════════════════════════════════════════════
// WHY THESE ARE HAND-DRAWN SVG AND NOT A CHART LIBRARY
// ══════════════════════════════════════════════════════════════════════════════
// Every chart here is a few dozen numbers. Chart.js is ~200 KB before a plugin,
// D3 more, and both would have to come off a CDN — on an app whose whole promise
// is that it works with no signal, in a field, all day. Inline SVG costs nothing
// to load, renders identically offline, inherits the theme tokens for free, and
// is trivially exportable. The existing 7-day sparkline on the dashboard already
// made this call; this file just follows it.
//
// The other rule this file keeps: every chart is a CONTROL, not a picture.
// Tapping a bar, a slice or a cell narrows the Review list to exactly those
// features. A chart you can only look at tells you a number you then have to go
// hunting for by hand — which is the failure mode of most dashboards.
const ANALYTICS_PALETTE = ['#38BDF8','#A78BFA','#34D399','#FBBF24','#FB7185','#60A5FA','#F472B6','#4ADE80','#FACC15','#22D3EE'];

function analyticsColor(i){ return ANALYTICS_PALETTE[i % ANALYTICS_PALETTE.length]; }

// The chart set reads the same filtered view the rest of Review uses, so a type
// filter or a query applied there is reflected here rather than the two screens
// quietly disagreeing about how many features exist.
// It used to fall back to the full set when the filter matched nothing, which
// meant a deliberately narrow filter produced charts of the whole project with
// no indication they were not what had been asked for — the one failure mode a
// dashboard must not have.
function analyticsFeatures(){
  return (typeof getFilteredFeatures === 'function') ? getFilteredFeatures() : savedFeatures;
}


function openAnalytics(){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  if (!savedFeatures.length){ showToast('Capture something first — there is nothing to chart yet'); return; }
  renderAnalytics();
  document.getElementById('analyticsModal').classList.add('show');
}

function closeAnalytics(){
  document.getElementById('analyticsModal').classList.remove('show');
}

function renderAnalytics(){
  const body = document.getElementById('analyticsBody');
  if (!body) return;
  const feats = analyticsFeatures();
  if (!feats.length){
    body.innerHTML = `<div class="an-card"><div class="an-title">Nothing to chart</div>
      <div class="pmind-empty">The Review tab's search, type filter or query is currently matching no
      features, so there is nothing for these charts to describe. Clear that filter and reopen.</div></div>`;
    return;
  }
  body.innerHTML =
    analyticsHeadline(feats) +
    analyticsTypeChart(feats) +
    analyticsTimeSeries(feats) +
    analyticsAccuracyChart(feats) +
    analyticsQualityChart(feats) +
    analyticsHourHeatmap(feats) +
    analyticsGeometryStats(feats) +
    analyticsPhotoCoverage(feats);
}


// ══ HEADLINE STATS ══
// Numbers that are genuinely derived rather than counted: total surveyed length,
// enclosed area, mean vertices per feature, capture span. The KPI tiles on the
// dashboard already carry the counts; repeating them here would waste the space.
function analyticsHeadline(feats){
  let totalLen = 0, totalArea = 0, verts = 0, photos = 0;
  feats.forEach(f=>{
    const vs = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
    verts += vs.length;
    photos += vs.reduce((s,v)=>s+((v.photos||[]).length),0);
    const geo = f.geometryType || 'point';
    if (geo === 'line' && vs.length >= 2) totalLen += lineLengthM(vs);
    if (geo === 'polygon' && vs.length >= 3){
      const pa = polygonAreaAndPerimeterM(vs);
      totalArea += pa.area; totalLen += pa.perimeter;
    }
  });
  const times = feats.map(f=>new Date(f.savedAt).getTime()).filter(t=>!isNaN(t));
  const span = times.length > 1 ? (Math.max(...times) - Math.min(...times)) : 0;
  const spanLabel = span
    ? (span < 3600000 ? Math.round(span/60000) + ' min'
      : span < 86400000 ? (span/3600000).toFixed(1) + ' hrs'
      : Math.round(span/86400000) + ' days')
    : '—';
  const cell = (label, value) => `<div class="an-stat"><div class="an-stat-val">${value}</div><div class="an-stat-lbl">${escapeHtml(label)}</div></div>`;
  return `<div class="an-card">
    <div class="an-title">At a glance</div>
    <div class="an-stat-grid">
      ${cell('Surveyed length', totalLen ? formatLength(totalLen) : '—')}
      ${cell('Enclosed area', totalArea ? formatArea(totalArea) : '—')}
      ${cell('Vertices / feature', feats.length ? (verts/feats.length).toFixed(1) : '—')}
      ${cell('Photos / feature', feats.length ? (photos/feats.length).toFixed(1) : '—')}
      ${cell('Capture span', spanLabel)}
      ${cell('Feature types', String(new Set(feats.map(f=>resolveFeatureType(f).key)).size))}
    </div>
  </div>`;
}


// ══ FEATURE TYPE MIX — donut ══
// A donut rather than a pie: the hole carries the total, which is the number
// most often wanted alongside the split, and arcs are easier to compare when
// they share an inner radius.
function analyticsTypeChart(feats){
  const tally = new Map();
  feats.forEach(f=>{
    const info = resolveFeatureType(f);
    const k = String(info.key);
    const e = tally.get(k) || { label: info.label, n: 0, key: k };
    e.n++; tally.set(k, e);
  });
  const items = [...tally.values()].sort((a,b)=>b.n-a.n);
  if (!items.length) return '';
  const total = items.reduce((s,i)=>s+i.n,0);
  const R = 52, r = 32, cx = 62, cy = 62;
  let angle = -Math.PI/2;
  const arcs = items.map((it,i)=>{
    const sweep = (it.n/total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad, a) => `${(cx + rad*Math.cos(a)).toFixed(2)} ${(cy + rad*Math.sin(a)).toFixed(2)}`;
    // A single-type project is a full circle, and a 360° arc path collapses to
    // nothing because its start and end points coincide — draw two rings instead.
    if (items.length === 1){
      return `<circle cx="${cx}" cy="${cy}" r="${(R+r)/2}" fill="none" stroke="${featureTypeColor(it.key)}" stroke-width="${R-r}"/>`;
    }
    return `<path class="an-arc" d="M ${p(R,a0)} A ${R} ${R} 0 ${large} 1 ${p(R,a1)} L ${p(r,a1)} A ${r} ${r} 0 ${large} 0 ${p(r,a0)} Z"
      fill="${featureTypeColor(it.key)}" opacity="0.92"
      onclick="analyticsFilterByType('${escapeHtml(it.key)}')"><title>${escapeHtml(it.label)}: ${it.n}</title></path>`;
  }).join('');
  const legend = items.map(it=>`
    <button class="an-legend-row" onclick="analyticsFilterByType('${escapeHtml(it.key)}')">
      <span class="an-legend-swatch" style="background:${featureTypeColor(it.key)}"></span>
      <span class="an-legend-name">${escapeHtml(it.label)}</span>
      <span class="an-legend-val">${it.n}</span>
      <span class="an-legend-pct">${Math.round(it.n/total*100)}%</span>
    </button>`).join('');
  return `<div class="an-card">
    <div class="an-title">Feature mix<span class="an-hint">tap to filter</span></div>
    <div class="an-donut-wrap">
      <svg viewBox="0 0 124 124" class="an-donut" role="img" aria-label="Feature type distribution">
        ${arcs}
        <text x="62" y="58" class="an-donut-total">${total}</text>
        <text x="62" y="74" class="an-donut-cap">features</text>
      </svg>
      <div class="an-legend">${legend}</div>
    </div>
  </div>`;
}


// ══ CAPTURE TIME SERIES ══
// Cumulative area plus a per-day bar, on one axis. The bars answer "how much did
// we do each day", the curve answers "are we on track" — and the shape of a
// flattening curve is the thing a project lead actually reads.
function analyticsTimeSeries(feats){
  const byDay = new Map();
  feats.forEach(f=>{
    const d = new Date(f.savedAt);
    if (isNaN(d)) return;
    const k = d.toISOString().slice(0,10);
    byDay.set(k, (byDay.get(k)||0)+1);
  });
  if (byDay.size < 1) return '';
  const keys = [...byDay.keys()].sort();
  // Fill the gaps: a survey with a two-day break should show the break, not
  // silently close it up and imply continuous work.
  const first = new Date(keys[0]), last = new Date(keys[keys.length-1]);
  const days = [];
  for (let d = new Date(first); d <= last && days.length < 120; d.setDate(d.getDate()+1)){
    const k = d.toISOString().slice(0,10);
    days.push({ key:k, n: byDay.get(k)||0 });
  }
  let run = 0;
  days.forEach(d=>{ run += d.n; d.cum = run; });
  const W = 320, H = 120, pad = 6;
  const maxN = Math.max(1, ...days.map(d=>d.n));
  const maxC = Math.max(1, run);
  const bw = Math.max(2, (W - pad*2) / days.length - 2);
  const bars = days.map((d,i)=>{
    const x = pad + i * ((W - pad*2)/days.length);
    const h = d.n ? Math.max(2, (d.n/maxN) * (H*0.62)) : 0;
    return `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"
      class="an-bar" onclick="analyticsFilterByDay('${d.key}')"><title>${d.key}: ${d.n} feature${d.n===1?'':'s'}</title></rect>`;
  }).join('');
  const pts = days.map((d,i)=>{
    const x = pad + i * ((W - pad*2)/days.length) + bw/2;
    const y = H - (d.cum/maxC) * (H*0.86);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<div class="an-card">
    <div class="an-title">Capture over time<span class="an-hint">tap a day to filter</span></div>
    <svg viewBox="0 0 ${W} ${H+14}" class="an-chart" role="img" aria-label="Features captured per day and cumulative total">
      ${bars}
      <polyline points="${pts}" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>
    </svg>
    <div class="an-axis"><span>${escapeHtml(days[0].key)}</span><span>${run} total</span><span>${escapeHtml(days[days.length-1].key)}</span></div>
  </div>`;
}


// ══ GPS ACCURACY DISTRIBUTION ══
// A histogram over the survey bands the rest of the app already uses, so the
// chart and the KPI tile classify a fix identically. Bands, not a linear axis:
// the gap between 1 m and 3 m matters to a surveyor and the gap between 20 m and
// 40 m does not.
const ACC_BANDS = [
  { max: 1,        label: '≤1m',   tone: 'good' },
  { max: 3,        label: '1–3m',  tone: 'good' },
  { max: 5,        label: '3–5m',  tone: 'ok'   },
  { max: 15,       label: '5–15m', tone: 'warn' },
  { max: Infinity, label: '>15m',  tone: 'bad'  }
];

function analyticsAccuracyChart(feats){
  const counts = ACC_BANDS.map(()=>0);
  let n = 0;
  feats.forEach(f=>(f.vertices||[]).forEach(v=>{
    if (v.acc == null || !(v.acc > 0)) return;
    n++;
    for (let i=0;i<ACC_BANDS.length;i++){ if (v.acc <= ACC_BANDS[i].max){ counts[i]++; break; } }
  }));
  if (!n) return '';
  const max = Math.max(...counts);
  const rows = ACC_BANDS.map((b,i)=>`
    <div class="an-hbar-row">
      <span class="an-hbar-lbl">${b.label}</span>
      <span class="an-hbar-track"><span class="an-hbar-fill tone-${b.tone}" style="width:${max?(counts[i]/max*100).toFixed(1):0}%"></span></span>
      <span class="an-hbar-val">${counts[i]}</span>
    </div>`).join('');
  const poor = counts[3] + counts[4];
  return `<div class="an-card">
    <div class="an-title">GPS accuracy spread</div>
    ${rows}
    <div class="an-note">${n} fix${n===1?'':'es'} recorded${poor?` · <button class="an-inline-btn" onclick="analyticsJumpToIssue('lowacc')">${poor} above 5m — review</button>`:' · all inside 5m'}</div>
  </div>`;
}


// ══ QUALITY SCORE DISTRIBUTION ══
function analyticsQualityChart(feats){
  if (typeof featureQualityScore !== 'function') return '';
  const buckets = { 100:0, 67:0, 33:0, 0:0 };
  feats.forEach(f=>{
    const s = featureQualityScore(f).score;
    const k = s === 100 ? 100 : s >= 67 ? 67 : s >= 33 ? 33 : 0;
    buckets[k]++;
  });
  const defs = [
    { k:100, label:'Complete',        tone:'good' },
    { k:67,  label:'One issue',       tone:'ok'   },
    { k:33,  label:'Two issues',      tone:'warn' },
    { k:0,   label:'Three issues',    tone:'bad'  }
  ];
  const total = feats.length || 1;
  const segs = defs.filter(d=>buckets[d.k]).map(d=>
    `<span class="an-stack-seg tone-${d.tone}" style="flex:${buckets[d.k]}" title="${d.label}: ${buckets[d.k]}"></span>`).join('');
  const keys = defs.filter(d=>buckets[d.k]).map(d=>
    `<span class="an-stack-key"><span class="an-stack-dot tone-${d.tone}"></span>${d.label} · ${buckets[d.k]}</span>`).join('');
  return `<div class="an-card">
    <div class="an-title">Data quality</div>
    <div class="an-stack">${segs}</div>
    <div class="an-stack-keys">${keys}</div>
    <div class="an-note">${Math.round(buckets[100]/total*100)}% of features are export-ready with no outstanding issues.</div>
  </div>`;
}


// ══ WHEN THE WORK HAPPENS — day × hour heatmap ══
// The calendar-style grid every activity tracker uses, and for once it earns its
// place: crews reading it can see the hours they actually capture in, which is
// what a realistic day plan has to be built on.
function analyticsHourHeatmap(feats){
  const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const grid = Array.from({length:7}, ()=>new Array(24).fill(0));
  let any = 0;
  feats.forEach(f=>{
    const d = new Date(f.savedAt);
    if (isNaN(d)) return;
    grid[d.getDay()][d.getHours()]++; any++;
  });
  if (!any) return '';
  const max = Math.max(...grid.flat());
  // Only the hours that were ever worked, so a survey that runs 07:00–17:00
  // doesn't waste half its width on empty night columns.
  const usedHours = [];
  for (let h=0; h<24; h++) if (grid.some(row=>row[h])) usedHours.push(h);
  const lo = Math.max(0, Math.min(...usedHours) - 1), hi = Math.min(23, Math.max(...usedHours) + 1);
  const rows = grid.map((row, di)=>{
    const cells = [];
    for (let h=lo; h<=hi; h++){
      const n = row[h];
      const t = max ? n/max : 0;
      cells.push(`<span class="an-heat-cell${n?'':' empty'}" style="--t:${t.toFixed(3)}" title="${DAY_LABELS[di]} ${String(h).padStart(2,'0')}:00 — ${n} feature${n===1?'':'s'}"></span>`);
    }
    return `<div class="an-heat-row"><span class="an-heat-day">${DAY_LABELS[di]}</span>${cells.join('')}</div>`;
  }).join('');
  return `<div class="an-card">
    <div class="an-title">When the work happens</div>
    <div class="an-heat">${rows}</div>
    <div class="an-axis"><span>${String(lo).padStart(2,'0')}:00</span><span>${String(hi).padStart(2,'0')}:00</span></div>
  </div>`;
}


// ══ GEOMETRY PROFILE ══
function analyticsGeometryStats(feats){
  const byGeo = { point:0, line:0, polygon:0 };
  feats.forEach(f=>{ const g = f.geometryType || 'point'; if (byGeo[g] != null) byGeo[g]++; });
  // Coordinates are filtered before measuring, not after: a single null vertex
  // turns the whole length into NaN, and NaN sorts and formats without ever
  // announcing itself.
  const usable = f => (f.vertices||[]).filter(v=>v && v.lat!=null && v.lon!=null);
  const lens = feats.filter(f=>f.geometryType==='line' && usable(f).length>=2).map(f=>lineLengthM(usable(f)));
  const areas = feats.filter(f=>f.geometryType==='polygon' && usable(f).length>=3).map(f=>polygonAreaAndPerimeterM(usable(f)).area);
  const stat = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a,b)=>a-b);
    return { min:s[0], med:s[Math.floor(s.length/2)], max:s[s.length-1] };
  };
  const L = stat(lens), A = stat(areas);
  const rows = [];
  rows.push(`<div class="an-kv"><span>Points</span><strong>${byGeo.point}</strong></div>`);
  rows.push(`<div class="an-kv"><span>Lines</span><strong>${byGeo.line}</strong></div>`);
  rows.push(`<div class="an-kv"><span>Polygons</span><strong>${byGeo.polygon}</strong></div>`);
  if (L) rows.push(`<div class="an-kv"><span>Line length min / median / max</span><strong>${formatLength(L.min)} · ${formatLength(L.med)} · ${formatLength(L.max)}</strong></div>`);
  if (A) rows.push(`<div class="an-kv"><span>Polygon area min / median / max</span><strong>${formatArea(A.min)} · ${formatArea(A.med)} · ${formatArea(A.max)}</strong></div>`);
  return `<div class="an-card"><div class="an-title">Geometry profile</div>${rows.join('')}</div>`;
}


// ══ PHOTO COVERAGE ══
function analyticsPhotoCoverage(feats){
  let withPhotos = 0, totalVerts = 0, vertsWithPhotos = 0, photos = 0;
  feats.forEach(f=>{
    const vs = f.vertices||[];
    let n = 0;
    vs.forEach(v=>{ totalVerts++; const c=(v.photos||[]).length; photos+=c; if (c){ vertsWithPhotos++; n+=c; } });
    if (n) withPhotos++;
  });
  if (!feats.length) return '';
  const featPct = Math.round(withPhotos/feats.length*100);
  const vertPct = totalVerts ? Math.round(vertsWithPhotos/totalVerts*100) : 0;
  const ring = (pct, label, sub) => {
    const C = 2*Math.PI*26;
    return `<div class="an-ring-item">
      <svg viewBox="0 0 64 64" class="an-ring">
        <circle cx="32" cy="32" r="26" class="an-ring-track"/>
        <circle cx="32" cy="32" r="26" class="an-ring-fill" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C*(1-pct/100)).toFixed(1)}"/>
        <text x="32" y="37" class="an-ring-text">${pct}%</text>
      </svg>
      <div class="an-ring-lbl">${escapeHtml(label)}</div>
      <div class="an-ring-sub">${escapeHtml(sub)}</div>
    </div>`;
  };
  return `<div class="an-card">
    <div class="an-title">Photo coverage</div>
    <div class="an-ring-row">
      ${ring(featPct, 'Features', `${withPhotos} of ${feats.length}`)}
      ${ring(vertPct, 'Vertices', `${vertsWithPhotos} of ${totalVerts}`)}
    </div>
    <div class="an-note">${photos} photo${photos===1?'':'s'} attached in total${featPct<100?` · <button class="an-inline-btn" onclick="analyticsJumpToIssue('nophotos')">show features with none</button>`:''}</div>
  </div>`;
}


// ══ INTERACTIVE FILTERING ══
// The point of every chart above. Each of these closes the sheet and leaves the
// Review tab showing exactly the subset that was tapped, rather than a number
// the user then has to reproduce by hand.
function analyticsFilterByType(key){
  const sel = document.getElementById('reviewTypeFilter');
  closeAnalytics();
  switchTabNav('review');
  setTimeout(()=>{
    if (sel){ sel.value = key; onReviewFilterChange(); }
    showToast('Filtered to that feature type');
  }, 90);
}

// Days have no dedicated filter control, so this drives the free-text search the
// Review tab already has — by writing the ISO date into it. Features are matched
// on savedAt below via analyticsDayFilter, which the review filter consults.
let analyticsDayFilterKey = '';

function analyticsFilterByDay(key){
  analyticsDayFilterKey = key;
  closeAnalytics();
  switchTabNav('review');
  setTimeout(()=>{
    renderFeatures();
    showToast(`Showing features captured on ${key}`);
    const bar = document.getElementById('analyticsDayBar');
    if (bar){
      bar.innerHTML = `<span>Captured on <strong>${escapeHtml(key)}</strong></span><button type="button" onclick="clearAnalyticsDayFilter()">Clear</button>`;
      bar.style.display = 'flex';
    }
  }, 90);
}

function clearAnalyticsDayFilter(){
  analyticsDayFilterKey = '';
  const bar = document.getElementById('analyticsDayBar');
  if (bar) bar.style.display = 'none';
  renderFeatures();
}

// Consulted from getFilteredFeatures() so the day filter composes with the
// search box, the type dropdown and the validation pills instead of replacing
// them — the same rule every other filter on that tab follows.
function analyticsDayFilterPass(f){
  if (!analyticsDayFilterKey) return true;
  const d = new Date(f.savedAt);
  if (isNaN(d)) return false;
  return d.toISOString().slice(0,10) === analyticsDayFilterKey;
}

function analyticsJumpToIssue(mode){
  closeAnalytics();
  if (typeof jumpToReviewIssue === 'function') jumpToReviewIssue(mode);
}
