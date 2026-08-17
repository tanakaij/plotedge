// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — PlotMind: on-device AI assistance for the captured dataset
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══════════════════════════════════════════════════════════════════════════════
// WHAT "AI" MEANS HERE, AND WHY IT COSTS NOTHING
// ══════════════════════════════════════════════════════════════════════════════
// There is already a bring-your-own-endpoint hook in this app for photo
// recognition (see js/19-sync.js) — it is off unless someone supplies a URL,
// because shipping an API key in client code is not an option and neither is
// billing a field crew per request.
//
// Everything in this file is the other kind: classical machine learning and
// spatial statistics, running entirely on the device, against data that is
// already in memory. No key, no endpoint, no network, no cost, and it works in
// a field with no signal — which is the only place it would actually be used.
//
// The methods are deliberately ones whose output can be explained in a sentence,
// because a field crew has to be able to disagree with a suggestion:
//
//   • k-nearest-neighbour classification — suggests a feature type, and an
//     attribute value, from the features physically nearest to it.
//   • k-means clustering — groups captures into work zones.
//   • Modified z-score on the median absolute deviation — flags outlier
//     attribute values and GPS spikes. MAD rather than standard deviation
//     because a survey with three wild fixes has its own standard deviation
//     wrecked by exactly the points it is meant to be detecting.
//   • Segment-intersection and near-duplicate tests — plain computational
//     geometry for self-intersecting polygons and features captured twice.
//   • A small grammar over the attribute schema — turns "polygons bigger than
//     500 m2 with no photos" into a filter, without a language model.
//
// Nothing here writes to the dataset on its own. Every finding is a suggestion
// with an explicit Apply, because an assistant that silently edits survey data
// is a liability, not a feature.

// Vertices that can actually be measured. A single null coordinate propagates
// NaN through every length and area calculation below, and NaN compares false
// against everything — so a filter that should have matched silently does not.
function pmUsableVerts(f){
  return (f && f.vertices || []).filter(v => v && v.lat != null && v.lon != null);
}

// ── geodesy ──
// One local haversine rather than reaching for the geometry file's helpers: this
// runs inside O(n²) neighbour loops, and it needs to stay a plain arithmetic
// call with no unit-formatting or projection work attached to it.
const PM_EARTH_R = 6371008.8;

function pmDistM(a, b){
  const toRad = Math.PI/180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const la = a.lat * toRad, lb = b.lat * toRad;
  const h = Math.sin(dLat/2)**2 + Math.cos(la)*Math.cos(lb)*Math.sin(dLon/2)**2;
  return 2 * PM_EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pmCentroid(f){
  const vs = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
  if (!vs.length) return null;
  return { lat: vs.reduce((s,v)=>s+v.lat,0)/vs.length, lon: vs.reduce((s,v)=>s+v.lon,0)/vs.length };
}

// ── robust statistics ──
// Median absolute deviation, scaled to be comparable with a standard deviation
// for normally distributed data (the 0.6745 constant). A |score| above ~3.5 is
// the conventional outlier threshold.
function pmMedian(arr){
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

function pmModifiedZ(values){
  const med = pmMedian(values);
  const mad = pmMedian(values.map(v=>Math.abs(v-med)));
  if (!mad) return values.map(()=>0);
  return values.map(v => 0.6745 * (v - med) / mad);
}


// ══ THE SHEET ══
function openPlotMind(){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  plotwordsExplain('plotmind');
  renderPlotMind();
  document.getElementById('plotMindModal').classList.add('show');
}

function closePlotMind(){
  plotwordsDismissAll();
  document.getElementById('plotMindModal').classList.remove('show');
}

function renderPlotMind(){
  const body = document.getElementById('plotMindBody');
  if (!body) return;
  if (!savedFeatures.length){
    body.innerHTML = '<div class="empty-box"><strong>Nothing to analyse yet</strong>Capture a few features and PlotMind will start finding patterns and problems in them.</div>';
    return;
  }
  const findings = pmRunAllChecks();
  body.innerHTML =
    pmSummaryCard(findings) +
    pmFindingsCard(findings) +
    pmSuggestionsCard() +
    pmZonesCard() +
    pmQueryCard();
}


// ══ THE SCAN ══
// One pass that every card reads from, so two cards can never report different
// counts for the same problem.
function pmRunAllChecks(){
  return []
    .concat(pmCheckGpsSpikes())
    .concat(pmCheckDuplicates())
    .concat(pmCheckSelfIntersections())
    .concat(pmCheckDegenerate())
    .concat(pmCheckAttributeOutliers())
    .concat(pmCheckMissingAttributes())
    .concat(pmCheckDuplicateVertices())
    .sort((a,b)=>({high:0,medium:1,low:2})[a.severity] - ({high:0,medium:1,low:2})[b.severity]);
}

// ── 1. GPS spikes ──
// A vertex that sits far off the run of its own neighbours. The threshold is
// derived from the feature's own segment lengths rather than fixed, because a
// 40 m jump is a spike in a building outline and normal in a road centreline.
function pmCheckGpsSpikes(){
  const out = [];
  savedFeatures.forEach(f=>{
    const vs = pmUsableVerts(f);
    if (vs.length < 4) return;
    const segs = [];
    for (let i=1;i<vs.length;i++) segs.push(pmDistM(vs[i-1], vs[i]));
    const z = pmModifiedZ(segs);
    const bad = [];
    z.forEach((v,i)=>{ if (v > 4.5 && segs[i] > 8) bad.push(i+1); });
    if (bad.length) out.push({
      id: 'spike-'+f.id, featureId: f.id, severity: 'high',
      title: `Possible GPS spike in "${f.name||'unnamed'}"`,
      detail: `Vertex ${bad.slice(0,3).join(', ')} jump${bad.length===1?'s':''} far further than the rest of this feature's steps (median step ${formatLength(pmMedian(segs))}). Usually a bad fix rather than real geometry.`,
      action: { label:'Open feature', run:()=>pmOpenFeature(f.id) }
    });
  });
  return out;
}

// ── 2. near-duplicate features ──
// Same feature type, centroids within a few metres. Almost always the same
// object captured twice — a second crew member, or a save that looked like it
// had not landed.
function pmCheckDuplicates(){
  const out = [];
  const pts = savedFeatures.map(f=>({ f, c: pmCentroid(f), key: String(resolveFeatureType(f).key) })).filter(x=>x.c);
  const seen = new Set();
  for (let i=0;i<pts.length;i++){
    for (let j=i+1;j<pts.length;j++){
      if (pts[i].key !== pts[j].key) continue;
      const d = pmDistM(pts[i].c, pts[j].c);
      if (d > 3) continue;
      const k = pts[i].f.id + ':' + pts[j].f.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: 'dup-'+k, featureId: pts[j].f.id, severity: 'medium',
        title: 'Two features almost on top of each other',
        detail: `"${pts[i].f.name||'unnamed'}" and "${pts[j].f.name||'unnamed'}" are the same type and ${d.toFixed(1)}m apart. If that is one object captured twice, delete one before exporting.`,
        action: { label:'Open the second', run:()=>pmOpenFeature(pts[j].f.id) }
      });
    }
  }
  return out.slice(0, 12);
}

// ── 3. self-intersecting polygons ──
// A bow-tie ring is accepted by every capture app and rejected by PostGIS,
// QGIS's geometry validity check and most spatial databases — so it is found
// here, before the export, rather than by whoever receives the file.
function pmSegmentsCross(p1,p2,p3,p4){
  const d = (a,b,c) => (c.lon-a.lon)*(b.lat-a.lat) - (c.lat-a.lat)*(b.lon-a.lon);
  const d1=d(p3,p4,p1), d2=d(p3,p4,p2), d3=d(p1,p2,p3), d4=d(p1,p2,p4);
  return ((d1>0&&d2<0)||(d1<0&&d2>0)) && ((d3>0&&d4<0)||(d3<0&&d4>0));
}

function pmCheckSelfIntersections(){
  const out = [];
  savedFeatures.forEach(f=>{
    if ((f.geometryType||'point') !== 'polygon') return;
    const vs = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
    if (vs.length < 4) return;
    const ring = vs.concat([vs[0]]);
    for (let i=0;i<ring.length-1;i++){
      for (let j=i+2;j<ring.length-1;j++){
        if (i===0 && j===ring.length-2) continue;   // shared closing vertex
        if (pmSegmentsCross(ring[i],ring[i+1],ring[j],ring[j+1])){
          out.push({
            id:'selfint-'+f.id, featureId:f.id, severity:'high',
            title:`"${f.name||'unnamed'}" crosses itself`,
            detail:`Edge ${i+1} crosses edge ${j+1}. PostGIS and QGIS both treat this as an invalid polygon, so it will fail on import even though it exports cleanly. Re-order or move a vertex to fix it.`,
            action:{ label:'Open feature', run:()=>pmOpenFeature(f.id) }
          });
          return;
        }
      }
    }
  });
  return out;
}

// ── 4. degenerate geometry ──
function pmCheckDegenerate(){
  const out = [];
  savedFeatures.forEach(f=>{
    const geo = f.geometryType||'point';
    const vs = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
    const need = geo==='polygon' ? 3 : geo==='line' ? 2 : 1;
    if (vs.length < need) out.push({
      id:'degen-'+f.id, featureId:f.id, severity:'high',
      title:`"${f.name||'unnamed'}" has too few vertices to be a ${geo}`,
      detail:`A ${geo} needs at least ${need}; this has ${vs.length}. It will be dropped or rejected by most of the export formats.`,
      action:{ label:'Open feature', run:()=>pmOpenFeature(f.id) }
    });
  });
  return out;
}

// ── 5. attribute outliers ──
function pmCheckAttributeOutliers(){
  const out = [];
  const byType = new Map();
  savedFeatures.forEach(f=>{
    const k = String(resolveFeatureType(f).key);
    (byType.get(k) || byType.set(k, []).get(k)).push(f);
  });
  byType.forEach(list=>{
    if (list.length < 6) return;    // too few to say anything honest about spread
    const ft = getFeatureType(list[0].featureTypeId);
    const numeric = ((ft && ft.fields) || []).filter(fl=>fl.type === 'number');
    numeric.forEach(fl=>{
      const pairs = list.map(f=>({ f, v: parseFloat((f.attrs||{})[fl.id]) })).filter(p=>!isNaN(p.v));
      if (pairs.length < 6) return;
      const z = pmModifiedZ(pairs.map(p=>p.v));
      z.forEach((score, i)=>{
        if (Math.abs(score) < 4) return;
        out.push({
          id:'outlier-'+pairs[i].f.id+'-'+fl.id, featureId:pairs[i].f.id, severity:'medium',
          title:`Unusual ${fl.label||fl.id} on "${pairs[i].f.name||'unnamed'}"`,
          detail:`${pairs[i].v} is far outside the range of the other ${pairs.length-1} readings of this type (typical value around ${pmMedian(pairs.map(p=>p.v))}). Worth confirming it is not a typo.`,
          action:{ label:'Open feature', run:()=>pmOpenFeature(pairs[i].f.id) }
        });
      });
    });
  });
  return out.slice(0, 10);
}

// ── 6. missing attributes that neighbours could fill ──
function pmCheckMissingAttributes(){
  const out = [];
  const gaps = pmFindFillableGaps();
  if (gaps.length) out.push({
    id:'fillable', severity:'low',
    title:`${gaps.length} blank field${gaps.length===1?'':'s'} could be filled from nearby captures`,
    detail:'PlotMind can suggest a value for each from the nearest features of the same type. Suggestions only — nothing is written until you accept it.',
    action:{ label:'See suggestions', run:()=>pmScrollTo('pmSuggestions') }
  });
  return out;
}

// ── 7. duplicate consecutive vertices ──
function pmCheckDuplicateVertices(){
  const out = [];
  savedFeatures.forEach(f=>{
    const vs = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
    let dupes = 0;
    for (let i=1;i<vs.length;i++) if (pmDistM(vs[i-1], vs[i]) < 0.15) dupes++;
    if (dupes) out.push({
      id:'dupv-'+f.id, featureId:f.id, severity:'low',
      title:`"${f.name||'unnamed'}" has ${dupes} repeated vertex${dupes===1?'':'es'}`,
      detail:'Consecutive vertices less than 15cm apart — usually a double tap on Capture. Harmless, but they inflate the file and some tools reject zero-length segments.',
      action:{ label:'Open feature', run:()=>pmOpenFeature(f.id) }
    });
  });
  return out.slice(0, 8);
}


// ══ CARDS ══
function pmSummaryCard(findings){
  const high = findings.filter(f=>f.severity==='high').length;
  const med  = findings.filter(f=>f.severity==='medium').length;
  const low  = findings.filter(f=>f.severity==='low').length;
  const verdict = high ? 'Needs attention before export'
                : med ? 'Worth a look'
                : low ? 'Minor tidy-ups available'
                : 'Nothing looks wrong';
  return `<div class="pmind-card pmind-verdict ${high?'bad':med?'warn':'good'}">
    <div class="pmind-verdict-title">${escapeHtml(verdict)}</div>
    <div class="pmind-verdict-sub">${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} scanned on this device · nothing was uploaded anywhere</div>
    <div class="pmind-verdict-pills">
      <span class="pmind-pill bad">${high} critical</span>
      <span class="pmind-pill warn">${med} to check</span>
      <span class="pmind-pill low">${low} minor</span>
    </div>
  </div>`;
}

let pmFindings = [];

function pmFindingsCard(findings){
  pmFindings = findings;
  if (!findings.length){
    return `<div class="pmind-card"><div class="pmind-title">Findings</div>
      <div class="pmind-empty">No spikes, duplicates, invalid rings or outliers found. The geometry and attributes are internally consistent.</div></div>`;
  }
  const rows = findings.slice(0, 20).map((f,i)=>`
    <div class="pmind-finding sev-${f.severity}">
      <div class="pmind-finding-head">
        <span class="pmind-sev-dot"></span>
        <span class="pmind-finding-title">${escapeHtml(f.title)}</span>
      </div>
      <div class="pmind-finding-detail">${escapeHtml(f.detail)}</div>
      ${f.action ? `<button class="pmind-act" onclick="pmRunFinding(${i})">${escapeHtml(f.action.label)}</button>` : ''}
    </div>`).join('');
  const more = findings.length > 20 ? `<div class="pmind-empty">+${findings.length-20} more of the same kinds.</div>` : '';
  return `<div class="pmind-card"><div class="pmind-title">Findings<span class="an-hint">${findings.length}</span></div>${rows}${more}</div>`;
}

function pmRunFinding(i){
  const f = pmFindings[i];
  if (f && f.action && f.action.run) f.action.run();
}

function pmOpenFeature(id){
  closePlotMind();
  if (typeof openInspect === 'function') openInspect(id);
}

function pmScrollTo(id){
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
}


// ══ SUGGESTIONS ══
// k-nearest-neighbour fill. For each blank field on a feature, look at the k
// nearest features of the same type that DO have a value, and propose the
// majority (categorical) or the distance-weighted mean (numeric). This is the
// oldest trick in spatial statistics and it is genuinely good at exactly this
// job: attributes that vary smoothly over a survey area — surface type, owner,
// pressure class, road class — are far more likely to match a neighbour than
// not.
const PM_KNN_K = 5;

const PM_KNN_MAX_M = 250;

function pmFindFillableGaps(){
  const gaps = [];
  const byType = new Map();
  savedFeatures.forEach(f=>{
    const k = String(resolveFeatureType(f).key);
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(f);
  });
  byType.forEach(list=>{
    if (list.length < 4) return;
    const ft = getFeatureType(list[0].featureTypeId);
    const fields = ((ft && ft.fields) || []).filter(fl=>featureFieldScope(fl, list[0]) !== 'vertex');
    fields.forEach(fl=>{
      const withVal = list.filter(f=>{ const v=(f.attrs||{})[fl.id]; return v!=='' && v!=null && !(Array.isArray(v)&&!v.length); });
      if (withVal.length < 3) return;
      list.forEach(f=>{
        const v = (f.attrs||{})[fl.id];
        if (!(v==='' || v==null || (Array.isArray(v)&&!v.length))) return;
        const c = pmCentroid(f);
        if (!c) return;
        const near = withVal
          .map(o=>({ o, d: (pmCentroid(o) ? pmDistM(c, pmCentroid(o)) : Infinity) }))
          .filter(x=>x.d <= PM_KNN_MAX_M)
          .sort((a,b)=>a.d-b.d)
          .slice(0, PM_KNN_K);
        if (near.length < 2) return;
        let suggestion, confidence;
        if (fl.type === 'number'){
          // Inverse-distance weighting — the standard spatial interpolation, and
          // the honest one: a reading 5 m away should count for more than one
          // 200 m away.
          let wsum = 0, vsum = 0;
          near.forEach(x=>{ const w = 1/Math.max(x.d, 1); wsum += w; vsum += w * parseFloat((x.o.attrs||{})[fl.id]); });
          if (!wsum || isNaN(vsum)) return;
          suggestion = +(vsum/wsum).toFixed(2);
          confidence = Math.min(0.95, 0.4 + near.length*0.1);
        } else {
          const tally = new Map();
          near.forEach(x=>{ const val = String((x.o.attrs||{})[fl.id]); tally.set(val, (tally.get(val)||0)+1); });
          const best = [...tally.entries()].sort((a,b)=>b[1]-a[1])[0];
          suggestion = best[0];
          confidence = best[1]/near.length;
          if (confidence < 0.6) return;   // the neighbours disagree — say nothing
        }
        gaps.push({ featureId: f.id, featureName: f.name, fieldId: fl.id, fieldLabel: fl.label || fl.id, suggestion, confidence, from: near.length });
      });
    });
  });
  return gaps.slice(0, 30);
}

let pmGaps = [];

function pmSuggestionsCard(){
  pmGaps = pmFindFillableGaps();
  const naming = pmSuggestNextName();
  let namingHtml = '';
  if (naming) namingHtml = `<div class="pmind-suggest">
      <div class="pmind-suggest-body">
        <div class="pmind-suggest-name">Next feature name</div>
        <div class="pmind-suggest-meta">Your naming follows a pattern — the next one is probably <strong>${escapeHtml(naming)}</strong></div>
      </div>
      <button class="pmind-act" onclick="pmUseName('${escapeHtml(naming)}')">Use it</button>
    </div>`;
  if (!pmGaps.length && !namingHtml){
    return `<div class="pmind-card" id="pmSuggestions"><div class="pmind-title">Suggestions</div>
      <div class="pmind-empty">Nothing to suggest — no blank fields that nearby captures could speak for.</div></div>`;
  }
  const rows = pmGaps.slice(0, 12).map((g,i)=>`
    <div class="pmind-suggest">
      <div class="pmind-suggest-body">
        <div class="pmind-suggest-name">${escapeHtml(g.featureName||'unnamed')} · ${escapeHtml(g.fieldLabel)}</div>
        <div class="pmind-suggest-meta">Suggest <strong>${escapeHtml(String(g.suggestion))}</strong> — from the ${g.from} nearest captures of this type · ${Math.round(g.confidence*100)}% agreement</div>
      </div>
      <button class="pmind-act" onclick="pmApplySuggestion(${i})">Apply</button>
    </div>`).join('');
  const bulk = pmGaps.length > 1
    ? `<button class="pmind-act wide" onclick="pmApplyAllSuggestions()">Apply all ${Math.min(pmGaps.length,12)} suggestions</button>`
    : '';
  return `<div class="pmind-card" id="pmSuggestions"><div class="pmind-title">Suggestions<span class="an-hint">tap to accept</span></div>${namingHtml}${rows}${bulk}</div>`;
}

function pmApplySuggestion(i){
  const g = pmGaps[i];
  if (!g) return;
  const f = savedFeatures.find(x=>x.id===g.featureId);
  if (!f) return;
  f.attrs = f.attrs || {};
  f.attrs[g.fieldId] = g.suggestion;
  f.editedAt = new Date().toISOString();
  persist();
  renderFeatures(); updateStats();
  showToast(`Set ${g.fieldLabel} on "${f.name||'unnamed'}"`);
  renderPlotMind();
}

function pmApplyAllSuggestions(){
  const list = pmGaps.slice(0, 12);
  if (!list.length) return;
  showConfirm(`Fill ${list.length} blank field${list.length===1?'':'s'} with the suggested values? Each comes from the nearest captures of the same type, and you can still edit any of them afterwards.`, ()=>{
    let n = 0;
    list.forEach(g=>{
      const f = savedFeatures.find(x=>x.id===g.featureId);
      if (!f) return;
      f.attrs = f.attrs || {};
      f.attrs[g.fieldId] = g.suggestion;
      f.editedAt = new Date().toISOString();
      n++;
    });
    persist();
    renderFeatures(); updateStats();
    showToast(`${n} field${n===1?'':'s'} filled`);
    renderPlotMind();
  }, 'Fill them');
}

// ── naming pattern ──
// Trailing-number detection. "Pole-007" becomes "Pole-008", and the zero padding
// is preserved, because a survey whose ids stop lining up in a sorted column is
// a survey somebody has to renumber by hand later.
function pmSuggestNextName(){
  const names = savedFeatures.map(f=>f.name).filter(n=>typeof n === 'string' && n.trim());
  if (names.length < 3) return null;
  const parsed = names.map(n=>{
    const m = String(n).match(/^(.*?)(\d+)\s*$/);
    return m ? { prefix: m[1], num: parseInt(m[2],10), pad: m[2].length } : null;
  }).filter(Boolean);
  if (parsed.length < 3) return null;
  const tally = new Map();
  parsed.forEach(p=>tally.set(p.prefix, (tally.get(p.prefix)||0)+1));
  const [prefix, count] = [...tally.entries()].sort((a,b)=>b[1]-a[1])[0];
  if (count < 3) return null;
  const same = parsed.filter(p=>p.prefix===prefix);
  const next = Math.max(...same.map(p=>p.num)) + 1;
  const pad = Math.max(...same.map(p=>p.pad));
  return prefix + String(next).padStart(pad, '0');
}

function pmUseName(name){
  closePlotMind();
  switchTabNav('collect');
  setTimeout(()=>{
    const input = document.getElementById('featureName');
    if (input){ input.value = name; input.dispatchEvent(new Event('input', { bubbles:true })); }
    showToast(`Name set to ${name}`);
  }, 120);
}


// ══ WORK ZONES — k-means ══
// Answers a question a field lead asks constantly and no other screen in the app
// does: "how does this split into a sensible day's work per crew?" k-means over
// the feature centroids, with k chosen from the count unless the user picks one.
let pmZoneK = 3;

function pmSetZoneK(k){ pmZoneK = Math.max(2, Math.min(8, k)); renderPlotMind(); }

function pmKMeans(points, k, iterations){
  if (points.length <= k) return points.map((p,i)=>({ centroid:p, members:[i] }));
  // k-means++ style seeding, simplified: first centre random-ish (the first
  // point, so results are reproducible), the rest the furthest from any chosen
  // centre. Plain random seeding on clustered survey data regularly produces two
  // centres inside the same cluster and one empty.
  const centres = [points[0]];
  while (centres.length < k){
    let best = null, bestD = -1;
    points.forEach(p=>{
      const d = Math.min(...centres.map(c=>pmDistM(p,c)));
      if (d > bestD){ bestD = d; best = p; }
    });
    centres.push(best);
  }
  let assign = new Array(points.length).fill(0);
  for (let it=0; it<(iterations||18); it++){
    let moved = false;
    points.forEach((p,i)=>{
      let bi = 0, bd = Infinity;
      centres.forEach((c,ci)=>{ const d = pmDistM(p,c); if (d < bd){ bd = d; bi = ci; } });
      if (assign[i] !== bi){ assign[i] = bi; moved = true; }
    });
    centres.forEach((c,ci)=>{
      const mem = points.filter((_,i)=>assign[i]===ci);
      if (!mem.length) return;
      c.lat = mem.reduce((s,p)=>s+p.lat,0)/mem.length;
      c.lon = mem.reduce((s,p)=>s+p.lon,0)/mem.length;
    });
    if (!moved) break;
  }
  return centres.map((c,ci)=>({ centroid:c, members: points.map((_,i)=>i).filter(i=>assign[i]===ci) }));
}

function pmZonesCard(){
  const pts = savedFeatures.map(f=>({ f, c: pmCentroid(f) })).filter(x=>x.c);
  if (pts.length < 4) return '';
  const k = Math.min(pmZoneK, pts.length);
  const clusters = pmKMeans(pts.map(x=>({ lat:x.c.lat, lon:x.c.lon })), k)
    .filter(c=>c.members.length)
    .sort((a,b)=>b.members.length-a.members.length);
  const rows = clusters.map((c,i)=>{
    const members = c.members.map(mi=>pts[mi]);
    // The zone's own extent, so "how far apart is this work" is answerable
    // without opening a map.
    let spread = 0;
    members.forEach(m=>{ const d = pmDistM(c.centroid, m.c); if (d>spread) spread = d; });
    const types = new Map();
    members.forEach(m=>{ const l = resolveFeatureType(m.f).label; types.set(l,(types.get(l)||0)+1); });
    const topTypes = [...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2).map(([l,n])=>`${n} ${l}`).join(', ');
    return `<div class="pmind-zone">
      <span class="pmind-zone-dot" style="background:${analyticsColor(i)}"></span>
      <div class="pmind-zone-body">
        <div class="pmind-zone-name">Zone ${i+1} · ${members.length} feature${members.length===1?'':'s'}</div>
        <div class="pmind-zone-meta">${escapeHtml(topTypes)} · within ${formatLength(spread)} of centre</div>
      </div>
      <button class="pmind-act" onclick="pmZoomZone(${c.centroid.lat},${c.centroid.lon},${Math.max(spread,30)})">Map</button>
    </div>`;
  }).join('');
  const picker = [2,3,4,5,6].map(n=>`<button class="pmind-k${n===pmZoneK?' on':''}" onclick="pmSetZoneK(${n})">${n}</button>`).join('');
  return `<div class="pmind-card">
    <div class="pmind-title">Work zones<span class="an-hint">k-means, on device</span></div>
    <div class="pmind-k-row"><span>Split into</span>${picker}<span>zones</span></div>
    ${rows}
    <div class="pmind-note">Clustered by position only. Useful for splitting a corridor between crews or planning a return visit.</div>
  </div>`;
}

function pmZoomZone(lat, lon, radius){
  closePlotMind();
  openPlotAtlas();
  setTimeout(()=>{
    if (!atlasMap) return;
    // Convert the zone radius to a bounds box so the whole zone frames rather
    // than centring on a point at an arbitrary zoom.
    const dLat = (radius*1.4) / 111320;
    const dLon = (radius*1.4) / (111320 * Math.cos(lat*Math.PI/180) || 1);
    atlasMap.fitBounds([[lat-dLat, lon-dLon],[lat+dLat, lon+dLon]], { maxZoom:19 });
  }, 420);
}


// ══ ASK IN PLAIN ENGLISH ══
// A small grammar, not a language model: it matches geometry words, comparison
// phrases, the project's own attribute labels and the quality checks the app
// already runs. That covers the questions field crews actually ask, works with
// no signal, and — unlike an LLM — cannot invent a field that does not exist.
function pmQueryCard(){
  return `<div class="pmind-card">
    <div class="pmind-title">Ask about this project</div>
    <div class="pmind-ask-row">
      <input type="text" id="pmAskInput" class="pmind-ask-input" placeholder="e.g. polygons bigger than 500 m2 with no photos"
             autocomplete="off" autocorrect="off" spellcheck="false"
             onkeydown="if(event.key==='Enter'){event.preventDefault();pmAsk();}">
      <button class="pmind-act" onclick="pmAsk()">Ask</button>
    </div>
    <div class="pmind-ask-examples">
      <button onclick="pmAskExample('features with no photos')">no photos</button>
      <button onclick="pmAskExample('polygons over 500 m2')">big polygons</button>
      <button onclick="pmAskExample('accuracy worse than 10m')">weak fixes</button>
      <button onclick="pmAskExample('captured today')">captured today</button>
      <button onclick="pmAskExample('lines longer than 100 m')">long lines</button>
    </div>
    <div class="pmind-ask-result" id="pmAskResult"></div>
  </div>`;
}

function pmAskExample(q){
  const input = document.getElementById('pmAskInput');
  if (input) input.value = q;
  pmAsk();
}

function pmAsk(){
  const input = document.getElementById('pmAskInput');
  const out = document.getElementById('pmAskResult');
  if (!input || !out) return;
  const q = String(input.value||'').toLowerCase().trim();
  if (!q){ out.innerHTML = ''; return; }
  const parsed = pmParseQuestion(q);
  if (!parsed.tests.length){
    out.innerHTML = `<div class="pmind-empty">Not sure what to filter on there. Try a geometry type, a size or length, "no photos", an accuracy, or a date.</div>`;
    return;
  }
  const matches = savedFeatures.filter(f=>parsed.tests.every(t=>t(f)));
  pmAskMatches = matches;
  out.innerHTML = `<div class="pmind-ask-summary">
      <strong>${matches.length}</strong> of ${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} match
      <span class="pmind-ask-reading">read as: ${escapeHtml(parsed.description.join(' + '))}</span>
    </div>` +
    (matches.length ? `<div class="pmind-ask-hits">${matches.slice(0,8).map(f=>
        `<button class="pmind-ask-hit" onclick="pmOpenFeature(${JSON.stringify(f.id)})">${escapeHtml(f.name||'unnamed')}<span>${escapeHtml(resolveFeatureType(f).label)}</span></button>`
      ).join('')}${matches.length>8?`<div class="pmind-empty">+${matches.length-8} more</div>`:''}</div>
      <button class="pmind-act wide" onclick="pmShowMatchesOnMap()">Show these on PlotAtlas</button>` : '');
}

let pmAskMatches = [];

function pmParseQuestion(q){
  const tests = [], description = [];
  const num = re => { const m = q.match(re); return m ? parseFloat(m[1]) : null; };

  if (/\bpolygon|\barea\b|\bplot\b|\bparcel/.test(q)){ tests.push(f=>(f.geometryType||'point')==='polygon'); description.push('polygons'); }
  else if (/\bline\b|\blines\b|\bpipe|\bcable|\broad|\bcorridor/.test(q)){ tests.push(f=>(f.geometryType||'point')==='line'); description.push('lines'); }
  else if (/\bpoint\b|\bpoints\b/.test(q)){ tests.push(f=>(f.geometryType||'point')==='point'); description.push('points'); }

  if (/no photo|without photo|missing photo/.test(q)){
    tests.push(f=>!(f.vertices||[]).some(v=>(v.photos||[]).length));
    description.push('with no photos');
  } else if (/with photo|has photo/.test(q)){
    tests.push(f=>(f.vertices||[]).some(v=>(v.photos||[]).length));
    description.push('with photos');
  }

  const area = num(/(?:bigger than|larger than|over|above|more than|>)\s*([\d.]+)\s*(?:m2|sqm|square)/);
  if (area != null && isFinite(area)){
    tests.push(f=>f.geometryType==='polygon' && pmUsableVerts(f).length>=3 && polygonAreaAndPerimeterM(pmUsableVerts(f)).area > area);
    description.push(`area over ${area} m²`);
  }
  const areaLt = num(/(?:smaller than|under|below|less than|<)\s*([\d.]+)\s*(?:m2|sqm|square)/);
  if (areaLt != null && isFinite(areaLt)){
    tests.push(f=>f.geometryType==='polygon' && pmUsableVerts(f).length>=3 && polygonAreaAndPerimeterM(pmUsableVerts(f)).area < areaLt);
    description.push(`area under ${areaLt} m²`);
  }
  const len = num(/(?:longer than|over|above|more than|>)\s*([\d.]+)\s*(?:m|metre|meter)s?\b/);
  if (len != null && isFinite(len) && area == null){
    tests.push(f=>f.geometryType==='line' && pmUsableVerts(f).length>=2 && lineLengthM(pmUsableVerts(f)) > len);
    description.push(`longer than ${len} m`);
  }
  const acc = num(/accuracy (?:worse than|above|over|>)\s*([\d.]+)/) ?? num(/(?:worse than|above|over)\s*([\d.]+)\s*m(?:etre|eter)?s? accuracy/);
  if (acc != null){
    tests.push(f=>(f.vertices||[]).some(v=>v.acc!=null && v.acc > acc));
    description.push(`a fix worse than ±${acc} m`);
  }
  if (/\btoday\b/.test(q)){
    const key = new Date().toDateString();
    tests.push(f=>new Date(f.savedAt).toDateString()===key);
    description.push('captured today');
  } else if (/yesterday/.test(q)){
    const d = new Date(); d.setDate(d.getDate()-1);
    const key = d.toDateString();
    tests.push(f=>new Date(f.savedAt).toDateString()===key);
    description.push('captured yesterday');
  } else if (/this week|last 7|past week/.test(q)){
    const cut = Date.now() - 7*86400000;
    tests.push(f=>new Date(f.savedAt).getTime() >= cut);
    description.push('captured in the last 7 days');
  }
  if (/missing (?:a )?required|incomplete|unfinished/.test(q) && typeof featureQualityScore === 'function'){
    tests.push(f=>featureQualityScore(f).issues.includes('missing required fields'));
    description.push('missing a required field');
  }
  // Feature-type names from this project's own schema, so "show me the manholes"
  // works without anyone configuring anything.
  const types = new Map();
  savedFeatures.forEach(f=>{ const i = resolveFeatureType(f); types.set(String(i.label||'').toLowerCase(), String(i.key)); });
  for (const [label, key] of types){
    if (!label) continue;
    const stem = label.replace(/s$/,'');
    if (stem.length >= 3 && q.includes(stem)){
      tests.push(f=>String(resolveFeatureType(f).key)===key);
      description.push(label);
      break;
    }
  }
  return { tests, description };
}

function pmShowMatchesOnMap(){
  if (!pmAskMatches.length) return;
  const ids = new Set(pmAskMatches.map(f=>f.id));
  closePlotMind();
  openPlotAtlas();
  setTimeout(()=>{
    if (!atlasMap) return;
    const pts = [];
    pmAskMatches.forEach(f=>(f.vertices||[]).forEach(v=>{ if (v.lat!=null) pts.push([v.lat, v.lon]); }));
    if (pts.length) atlasMap.fitBounds(L.latLngBounds(pts), { padding:[60,60], maxZoom:19 });
    showToast(`${ids.size} matching feature${ids.size===1?'':'s'} framed`);
  }, 420);
}
