// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Review list, filters, attribute table, validation, quality score
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══ REVIEW LIST SEARCH / FILTER ══
// Simple client-side filter over savedFeatures: free-text search against name+ref, plus a
// feature-type dropdown. Matters most once projects have many feature types and/or large
// surveys (hundreds of features) — scrolling the full list to find one becomes impractical.
let reviewSearchQuery = '';

let reviewFilterTypeId = '';

function populateReviewTypeFilter(){
  const sel = document.getElementById('reviewTypeFilter');
  if (!sel) return;
  const seen = new Map();
  savedFeatures.forEach(f=>{ const info=resolveFeatureType(f); seen.set(String(info.key), info.label); });
  const opts = Array.from(seen.entries()).sort((a,b)=>a[1].localeCompare(b[1]));
  const current = sel.value;
  sel.innerHTML = '<option value="">All types</option>' + opts.map(([key,label])=>`<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('');
  if (opts.some(([key])=>key===current)) sel.value = current;
  else reviewFilterTypeId = '';
}

function onReviewFilterChange(){
  const input = document.getElementById('reviewSearchInput');
  const sel = document.getElementById('reviewTypeFilter');
  reviewSearchQuery = input ? input.value.trim().toLowerCase() : '';
  reviewFilterTypeId = sel ? sel.value : '';
  renderFeatures();
}


// ══ SHARED REVIEW FILTER ══
// Extracted from renderFeatures() so the card list and the attribute table are guaranteed to be
// looking at exactly the same set — a search or type filter applied in one view carries straight
// across when the user flips to the other.
function getFilteredFeatures(){
  const validationIds = reviewValidationMode ? new Set(computeValidationIssues()[reviewValidationMode]) : null;
  return savedFeatures.filter(f=>{
    if (validationIds && !validationIds.has(f.id)) return false;
    // Set by tapping a day in the Analytics time series. Declared in
    // js/13a-analytics.js — a later file, which is fine because this is a call
    // made at render time, not a name read while the scripts are loading.
    if (typeof analyticsDayFilterPass === 'function' && !analyticsDayFilterPass(f)) return false;
    if (reviewFilterTypeId){
      const info = resolveFeatureType(f);
      if (String(info.key) !== reviewFilterTypeId) return false;
    }
    if (reviewSearchQuery){
      const hay = `${f.name||''} ${f.ref||''}`.toLowerCase();
      if (!hay.includes(reviewSearchQuery)) return false;
    }
    return true;
  });
}


// ══════════════ ATTRIBUTE TABLE ══════════════
// The familiar desktop-GIS view of the same features: a row per feature, a column per attribute,
// sortable, with row selection wired to the map above it. It exists because the card list answers
// "what did I capture?" well but answers "which pole is missing its material?" badly — scanning a
// column beats opening twelve cards. Everything here is derived at render time from savedFeatures;
// nothing extra is persisted.
let reviewView = 'cards';

let attrSortKey = null, attrSortDir = 1;

let attrSelectedId = null;


// Quick-action entry point: the attribute table already exists as a view mode inside Review, so
// this is a jump rather than a second implementation. Going through switchTabNav (not switchTab)
// leaves a back-button stop behind, matching every other dashboard shortcut.
function openAttributeTable(){
  if (!savedFeatures.length){ showToast('No features to show yet'); return; }
  switchTabNav('review');
  setTimeout(()=>{
    setReviewView('table');
    const wrap = document.getElementById('attrTableWrap');
    if (wrap) wrap.scrollIntoView({ behavior:'smooth', block:'start' });
  }, 90);
}


function setReviewView(mode){
  reviewView = mode;
  const table = mode === 'table';
  document.getElementById('rvBtnCards').classList.toggle('active', !table);
  document.getElementById('rvBtnTable').classList.toggle('active', table);
  document.getElementById('attrTableWrap').style.display = table ? 'block' : 'none';
  document.getElementById('featuresList').style.display  = table ? 'none' : '';
  if (table) renderAttributeTable();
}


// Column set = the fixed geometry/QA columns every feature has, plus the union of every attribute
// field actually in use across the filtered features. Union rather than the active type's schema,
// so a project mixing several feature types still shows all their columns (blank where a given
// feature's type doesn't define that field) instead of silently dropping data.
function attrTableColumns(features){
  const cols = [
    { key:'__name', label:'Feature', get:f=>f.name || '(unnamed)' },
    { key:'__ref',  label:'Ref',     get:f=>f.ref || '' },
    { key:'__type', label:'Type',    get:f=>resolveFeatureType(f).label || '' },
    { key:'__geom', label:'Geometry',get:f=>f.geometryType || 'point' },
    { key:'__verts',label:'Vertices',get:f=>(f.vertices||[]).length, num:true },
    { key:'__acc',  label:'Acc (m)', get:f=>{
        const a=(f.vertices||[]).map(v=>v.acc).filter(x=>x!=null&&x>0);
        return a.length ? +(a.reduce((s,x)=>s+x,0)/a.length).toFixed(1) : null;
      }, num:true },
    { key:'__photos',label:'Photos', get:f=>(f.vertices||[]).reduce((s,v)=>s+(v.photos||[]).length,0), num:true },
    { key:'__saved', label:'Captured',get:f=>f.editedAt||f.savedAt, time:true }
  ];
  const seen = new Map();
  features.forEach(f=>{
    const fields = resolveFeatureType(f).fields || [];
    fields.forEach(fl=>{ if (!seen.has(fl.key || fl.id)) seen.set(fl.key || fl.id, fl); });
    // Attributes present on the feature but not in any schema (imported data, or a field deleted
    // from the type after capture) would otherwise be invisible here.
    Object.keys(f.attrs || {}).forEach(k=>{ if (!seen.has(k)) seen.set(k, { key:k, label:k }); });
  });
  seen.forEach((fl, key)=>{
    cols.push({ key, label: fl.label || fl.name || key, attr:true,
                num: fl.type === 'number',
                get: f => { const v = (f.attrs||{})[key]; return Array.isArray(v) ? v.join(', ') : v; } });
  });
  return cols;
}

function attrCellText(col, f){
  const v = col.get(f);
  if (v === null || v === undefined || v === '') return null;
  if (col.time) return timeAgo(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function sortAttributeTable(key){
  if (attrSortKey === key) attrSortDir = -attrSortDir;
  else { attrSortKey = key; attrSortDir = 1; }
  renderAttributeTable();
}

function renderAttributeTable(){
  const scroll = document.getElementById('attrTableScroll');
  const countEl = document.getElementById('attrTableCount');
  if (!scroll) return;
  // The query and the "show selected only" toggle sit on top of the search/type/validation
  // filters rather than replacing them, so every control on the tab composes. See
  // applyAttrQueryFilter() in js/23-attr-query.js.
  const base = getFilteredFeatures();
  const features = (typeof applyAttrQueryFilter === 'function') ? applyAttrQueryFilter(base) : base;
  if (countEl) {
    const q = (typeof attrQueryActive === 'function' && attrQueryActive()) ? ' · filtered by query' : '';
    countEl.textContent = `${features.length} feature${features.length===1?'':'s'} · ${savedFeatures.length} in project${q}`;
  }
  if (typeof updateAttrQueryBar === 'function') updateAttrQueryBar();
  if (typeof updateAttrSelectionBar === 'function') updateAttrSelectionBar();
  if (!features.length){
    scroll.innerHTML = '<div class="attr-table-empty">Nothing to show. Adjust the search, the type filter, or the query.</div>';
    return;
  }
  const cols = attrTableColumns(features);
  const rows = features.slice();
  if (attrSortKey){
    const col = cols.find(c=>c.key === attrSortKey);
    if (col) rows.sort((a,b)=>{
      const av = col.get(a), bv = col.get(b);
      // Blanks always sink to the bottom regardless of direction — a column sorted to surface its
      // empty cells is almost never what someone wants; they are sorting to find real values.
      if (av === null || av === undefined || av === '') return 1;
      if (bv === null || bv === undefined || bv === '') return -1;
      if (col.num) return (av - bv) * attrSortDir;
      if (col.time) return (new Date(av) - new Date(bv)) * attrSortDir;
      return String(av).localeCompare(String(bv), undefined, { numeric:true }) * attrSortDir;
    });
  }
  const head = cols.map(c=>{
    const sorted = attrSortKey === c.key;
    const arrow = sorted ? (attrSortDir === 1 ? '▲' : '▼') : '▲';
    // Tap sorts; long-press opens that column's statistics (count/min/max/mean, or the value
    // counts for a text column). A stats button per header would have cost width the table
    // cannot spare on a phone.
    return `<th class="${sorted?'sorted':''}" onclick="sortAttributeTable('${escapeHtml(c.key)}')"
      oncontextmenu="event.preventDefault();showAttrColumnStats('${escapeHtml(c.key)}')"
      title="Tap to sort by ${escapeHtml(c.label)}, long-press for statistics">${escapeHtml(c.label)}<span class="attr-sort">${arrow}</span></th>`;
  }).join('');
  const selHead = `<th class="attr-sel-col" title="Select rows"></th>`;
  const body = rows.map(f=>{
    const cells = cols.map((c,i)=>{
      const txt = attrCellText(c, f);
      const cls = [c.num ? 'attr-cell-num' : '', txt === null ? 'attr-cell-empty' : ''].filter(Boolean).join(' ');
      // A coloured dot on the accuracy cell so a bad fix is spottable while scanning the column,
      // rather than needing the reader to remember the project's threshold.
      let flag = '';
      if (c.key === '__acc' && txt !== null) flag = `<span class="attr-flag ${parseFloat(txt) > 5 ? 'warn':'ok'}"></span>`;
      return `<td class="${cls}">${flag}${txt === null ? '—' : escapeHtml(txt)}</td>`;
    }).join('');
    const picked = (typeof attrSelection !== 'undefined') && attrSelection.has(f.id);
    // The checkbox is its own cell and stops propagation, so selecting a row for a bulk action is
    // a separate gesture from tapping the row to drive the map — the same separation QGIS keeps
    // between a selection and the current feature.
    const selCell = `<td class="attr-sel-col" onclick="toggleAttrSelect(${JSON.stringify(f.id)}, event)">
      <span class="attr-sel-box${picked?' on':''}" role="checkbox" aria-checked="${picked?'true':'false'}">${picked?'✓':''}</span></td>`;
    // Single tap keeps its existing job (select + drive the map); double-tap opens the full
    // record. Adding an extra column of buttons would have cost horizontal room the table can't
    // spare on a phone.
    return `<tr class="${attrSelectedId === f.id ? 'selected':''}${picked?' picked':''}" onclick="selectAttrRow(${JSON.stringify(f.id)})" ondblclick="openInspect(${JSON.stringify(f.id)})" title="Double-tap for full details">${selCell}${cells}</tr>`;
  }).join('');
  scroll.innerHTML = `<table class="attr-table"><thead><tr>${selHead}${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Row selection drives the map, the way clicking a row in QGIS's attribute table does: the map
// pans to that feature and opens its popup, so the table and the map are one view of one dataset
// rather than two lists that happen to sit on the same screen.
function selectAttrRow(id){
  attrSelectedId = (attrSelectedId === id) ? null : id;
  renderAttributeTable();
  if (attrSelectedId === null) return;
  const f = savedFeatures.find(x=>x.id === id);
  if (!f || !reviewMap) return;
  const verts = (f.vertices||[]).filter(v=>v.lat!=null && v.lon!=null);
  if (!verts.length){ showToast('That feature has no coordinates to show'); return; }
  const latlngs = verts.map(v=>[v.lat, v.lon]);
  if (latlngs.length === 1) reviewMap.setView(latlngs[0], Math.max(reviewMap.getZoom(), 18));
  else reviewMap.fitBounds(L.latLngBounds(latlngs), { padding:[36,36], maxZoom:19 });
  setTimeout(()=>reviewMap.invalidateSize(), 60);
}

// Copy as TSV — pastes straight into Excel/Sheets as a real grid. Useful mid-job when someone
// wants a quick tally in a spreadsheet without running the full export.
function copyAttributeTable(){
  // Copies what is on screen, query and selection included — copying the unfiltered project
  // after deliberately narrowing to eleven rows would be actively misleading.
  const base = getFilteredFeatures();
  const features = (typeof applyAttrQueryFilter === 'function') ? applyAttrQueryFilter(base) : base;
  if (!features.length){ showToast('Nothing to copy'); return; }
  const cols = attrTableColumns(features);
  const esc = v => String(v ?? '').replace(/[\t\r\n]+/g,' ');
  const lines = [cols.map(c=>esc(c.label)).join('\t')];
  features.forEach(f=>{
    lines.push(cols.map(c=>{
      const v = c.get(f);
      // Full ISO timestamp here rather than the table's "2h ago" — a relative time is useless in
      // a spreadsheet that gets opened next week.
      if (c.time && v) return esc(v);
      return esc(v === null || v === undefined ? '' : (typeof v === 'boolean' ? (v?'Yes':'No') : v));
    }).join('\t'));
  });
  const tsv = lines.join('\n');
  const done = () => showToast(`✓ ${features.length} row${features.length===1?'':'s'} copied`);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(tsv).then(done).catch(()=>fallbackCopy(tsv, done));
  } else fallbackCopy(tsv, done);
}

function fallbackCopy(text, done){
  // execCommand('copy') is deprecated but remains the only path in insecure-origin WebViews,
  // which is exactly where this app often runs (a sideloaded APK on a field handset).
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch(e){ showToast('Could not copy on this device'); }
}


function renderFeatures(){
  const el=document.getElementById('featuresList');
  const filterRow=document.getElementById('reviewFilterRow');
  const tableWrap=document.getElementById('attrTableWrap');
  renderValidationBar();
  if(!savedFeatures.length){
    el.innerHTML='<div class="empty-box"><strong>Nothing saved yet</strong>Record features on the Capture tab</div>';
    el.style.display='';
    if (filterRow) filterRow.style.display='none';
    if (tableWrap) tableWrap.style.display='none';
    return;
  }
  // Keep the attribute table in step with the card list: both are rebuilt from the same filtered
  // set, so whichever one is on screen reflects the current search/type/validation filter.
  if (reviewView === 'table'){
    if (tableWrap) tableWrap.style.display='block';
    el.style.display='none';
    renderAttributeTable();
  }
  if (filterRow) filterRow.style.display='flex';
  populateReviewTypeFilter();
  const geoGlyph={point:'●',line:'—',polygon:'▱'};
  const filtered = getFilteredFeatures();
  if (!filtered.length){
    el.innerHTML='<div class="empty-box"><strong>No matches</strong>Try a different search or feature type</div>';
    return;
  }
  el.innerHTML=filtered.map(f=>{
    const info=resolveFeatureType(f);
    const verts=f.vertices||[];
    const geo=f.geometryType || 'point';
    const attrChips=attrChipsHtml(f.attrs, info.fields);
    const notesHtml=f.notes?`<div class="feat-notes">${escapeHtml(f.notes)}</div>`:'';
    const refHtml=f.ref?`<span class="feat-ref">#${escapeHtml(f.ref)}</span>`:'';
    const assignedHtml=f.assignedTo?`<span class="feat-ref">· ${escapeHtml(f.assignedTo)}</span>`:'';
    // Per-vertex breakdown: coordinate chip + this vertex's own attrs/photos (if any)
    const vertsHtml=verts.map((v,i)=>{
      const vAttrChips=attrChipsHtml(v.attrs, info.fields);
      const vPhotos=v.photos||[];
      const vPhotosHtml=vPhotos.length?`<div class="feat-photos" style="margin-top:4px;">${vPhotos.map((p,pi)=>`<div class="feat-photo-thumb" onclick="openFeatureVertexPhoto(${f.id},${i},${pi})"><img src="${photoThumbSrc(p)}" alt="Photo ${pi+1}" loading="lazy" decoding="async" title="${escapeHtml(p.angleLabel||'')}">${photoStatusBadge(p)}${photoAiLabelHtml(p)}</div>`).join('')}</div>`:'';
      const extra = vAttrChips || vPhotosHtml;
      return `<div style="${extra?'margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--card-border);':'margin-bottom:4px;'}">
        <div class="feat-pts-row" style="margin-bottom:${extra?'4px':'0'};"><span class="feat-pt-chip">${i+1}: ${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}</span></div>
        ${vAttrChips?`<div class="feat-attrs">${vAttrChips}</div>`:''}
        ${vPhotosHtml}
      </div>`;
    }).join('');
    const totalPhotos=verts.reduce((s,v)=>s+(v.photos||[]).length,0);
    const typeColor=featureTypeColor(info.key);
    const editedHtml=f.editedAt?`<span class="feat-ref" title="Edited ${new Date(f.editedAt).toLocaleString()}">· edited</span>`:'';
    return `<div class="feature-card" id="feat-${f.id}">
      <div class="feature-card-header">
        <div class="layer-badge" style="background:${typeColor};color:${contrastText(typeColor)};">${geoGlyph[geo]||''} ${escapeHtml(info.label)}</div>
        ${qualityBadgeHtml(f)}
        <div class="feat-name">${escapeHtml(f.name)} ${refHtml}${assignedHtml}${editedHtml}</div>
        <button class="feat-edit" title="Full details" aria-label="Full details" onclick="openInspect(${JSON.stringify(f.id)})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.8" x2="12.01" y2="7.8"/></svg>
        </button>
        <button class="feat-edit" title="Edit feature" aria-label="Edit feature" onclick="editFeature(${f.id})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="feat-del" onclick="deleteFeature(${f.id})">×</button>
      </div>
      <div class="feature-card-body">
        ${attrChips?`<div class="feat-attrs">${attrChips}</div>`:''}
        <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-tertiary);margin:6px 0 6px;">${verts.length} vertex${verts.length===1?'':'es'}${totalPhotos?` · ${totalPhotos} photo${totalPhotos===1?'':'s'}`:''}</div>
        ${vertsHtml}
        ${notesHtml}
      </div>
    </div>`;
  }).join('');
}


function toggleReviewMapFullscreen(){
  const wrap = document.getElementById('reviewMapWrap');
  if (!wrap) return;
  const goingFullscreen = !wrap.classList.contains('fullscreen');
  wrap.classList.toggle('fullscreen', goingFullscreen);
  const btn = document.getElementById('mapFullscreenToggle');
  if (btn) btn.innerHTML = goingFullscreen
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4a2 2 0 0 1-2 2H3m18 0h-4a2 2 0 0 1-2-2V3m0 18v-4a2 2 0 0 1 2-2h4M3 15h4a2 2 0 0 1 2 2v4"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  // Leaflet renders tiles for the container size at creation time; when that size changes (here,
  // 260px -> 100vh or back) it needs an explicit nudge or it keeps the old tile layout until the
  // next pan/zoom. The short delay lets the CSS transition/layout settle first.
  setTimeout(() => { if (reviewMap) reviewMap.invalidateSize(); }, 60);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // closeTopOverlay() already knows the full stacking order — PlotAtlas, its
  // feature sheet, the lightbox, every bottom sheet. Duplicating a slice of that
  // here is how the two get to disagree about what Escape means.
  if (closeTopOverlay()) return;
  const wrap = document.getElementById('reviewMapWrap');
  if (wrap && wrap.classList.contains('fullscreen')) toggleReviewMapFullscreen();
});


// ══ REVIEW VALIDATION CHECKLIST ══
// A lightweight "is this ready to export" QA pass over the current project's saved features:
// low GPS accuracy (reusing the same >15m/>5m bands as the map's accuracy halos, so the two views
// agree with each other), features with no photos at all, and — mostly a defensive check, since
// required fields already block saving on the Collect tab — anything missing a required attribute
// (e.g. brought in via CSV/GeoPackage import, which doesn't run that same check).
let reviewValidationMode = ''; // '' | 'lowacc' | 'nophotos' | 'missingreq'

function computeValidationIssues(){
  const lowacc = [], nophotos = [], missingreq = [];
  savedFeatures.forEach(f=>{
    const verts = f.vertices||[];
    if (verts.some(v=>v.acc!=null && v.acc>15)) lowacc.push(f.id);
    if (!verts.reduce((s,v)=>s+(v.photos||[]).length,0)) nophotos.push(f.id);
    const info = resolveFeatureType(f);
    const reqFeature = (info.fields||[]).filter(a=>a.scope!=='vertex' && a.required);
    const reqVertex = (info.fields||[]).filter(a=>a.scope==='vertex' && a.required);
    const missingF = reqFeature.some(a=>{ const val=(f.attrs||{})[a.id]; return val===''||val==null||(Array.isArray(val)&&!val.length); });
    const missingV = reqVertex.length && verts.some(v=>reqVertex.some(a=>{ const val=(v.attrs||{})[a.id]; return val===''||val==null||(Array.isArray(val)&&!val.length); }));
    if (missingF || missingV) missingreq.push(f.id);
  });
  return { lowacc, nophotos, missingreq };
}

// ══ QUALITY SCORE ══ — a per-feature 0-100 score, reusing the same three checks as the review
// validation bar (GPS accuracy, photo coverage, required fields) so the two views never disagree.
// Deliberately simple/transparent (each check is worth a third) rather than a black-box formula —
// a field crew needs to be able to look at a low score and immediately see why.
function featureQualityScore(f){
  const verts = f.vertices||[];
  const info = resolveFeatureType(f);
  const issues = [];
  const accOk = !verts.some(v=>v.acc!=null && v.acc>15);
  if (!accOk) issues.push('low GPS accuracy');
  const photosOk = verts.reduce((s,v)=>s+(v.photos||[]).length,0) > 0;
  if (!photosOk) issues.push('no photos');
  const reqFeature = (info.fields||[]).filter(a=>a.scope!=='vertex' && a.required);
  const reqVertex = (info.fields||[]).filter(a=>a.scope==='vertex' && a.required);
  const missingF = reqFeature.some(a=>{ const val=(f.attrs||{})[a.id]; return val===''||val==null||(Array.isArray(val)&&!val.length); });
  const missingV = reqVertex.length && verts.some(v=>reqVertex.some(a=>{ const val=(v.attrs||{})[a.id]; return val===''||val==null||(Array.isArray(val)&&!val.length); }));
  const fieldsOk = !missingF && !missingV;
  if (!fieldsOk) issues.push('missing required fields');
  const score = Math.round(((accOk?1:0)+(photosOk?1:0)+(fieldsOk?1:0))/3*100);
  return { score, issues };
}

function qualityBadgeHtml(f){
  const { score, issues } = featureQualityScore(f);
  const tier = score===100 ? 'good' : score>=34 ? 'warn' : 'bad';
  const title = issues.length ? `Quality issues: ${issues.join(', ')}` : 'No quality issues';
  return `<span class="feat-quality-badge feat-quality-${tier}" title="${escapeHtml(title)}">${score}%</span>`;
}

function renderValidationBar(){
  const bar = document.getElementById('reviewValidationBar');
  if (!bar) return;
  if (!savedFeatures.length) { bar.style.display='none'; return; }
  const { lowacc, nophotos, missingreq } = computeValidationIssues();
  bar.style.display = 'block';
  if (!lowacc.length && !nophotos.length && !missingreq.length) {
    reviewValidationMode = '';
    bar.innerHTML = `<div class="review-validation-clear">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      All features passed validation
    </div>`;
    return;
  }
  const pill = (mode, count, label, tone) => count ? `<div class="review-validation-pill${tone==='danger'?' danger':''}${reviewValidationMode===mode?' active':''}" onclick="setReviewValidationFilter('${mode}')">
      <span>${count} ${label}</span>
    </div>` : '';
  bar.innerHTML = `<div class="review-validation-title">Before you export</div>
    <div class="review-validation-pills">
      ${pill('lowacc', lowacc.length, `low-accuracy GPS${lowacc.length===1?'':''}`, 'danger')}
      ${pill('nophotos', nophotos.length, `with no photos`, 'warn')}
      ${pill('missingreq', missingreq.length, `missing required fields`, 'danger')}
    </div>`;
}

function setReviewValidationFilter(mode){
  reviewValidationMode = (reviewValidationMode === mode) ? '' : mode;
  renderValidationBar();
  renderFeatures();
}


function renderReadinessChecklist(){
  const el = document.getElementById('readinessBody');
  if (!el) return;
  if (!savedFeatures.length) {
    el.innerHTML = `<div class="readiness-row"><div class="readiness-icon issue">!</div>No features captured yet</div>`;
    return;
  }
  const { lowacc, nophotos, missingreq } = computeValidationIssues();
  const row = (ok, label, count, mode) => {
    const icon = ok ? `<div class="readiness-icon pass"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`
                     : `<div class="readiness-icon issue"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"/></svg></div>`;
    const countHtml = ok ? '' : `<span class="readiness-count">${count} →</span>`;
    const clickAttr = ok ? '' : ` onclick="jumpToReviewIssue('${mode}')"`;
    return `<div class="readiness-row${ok?'':' issue'}"${clickAttr}>${icon}${label}${countHtml}</div>`;
  };
  el.innerHTML =
    row(true, `${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} captured`, 0, '') +
    row(!lowacc.length, lowacc.length ? 'Some features have low GPS accuracy' : 'GPS accuracy checked', lowacc.length, 'lowacc') +
    row(!nophotos.length, nophotos.length ? 'Some features have no photos' : 'Photos included', nophotos.length, 'nophotos') +
    row(!missingreq.length, missingreq.length ? 'Some features are missing required fields' : 'Metadata complete', missingreq.length, 'missingreq');
}

function jumpToReviewIssue(mode){
  reviewValidationMode = mode;
  switchTab('review');
  renderValidationBar();
  renderFeatures();
}


function renderDashHealth(){
  const card = document.getElementById('dashHealthCard');
  if (!card) return;
  if (!savedFeatures.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const total = savedFeatures.length;
  const { lowacc, nophotos, missingreq } = computeValidationIssues();
  const hardIssues = new Set([...lowacc, ...missingreq]);
  const passing = total - hardIssues.size;
  const pct = Math.round((passing / total) * 100);
  document.getElementById('dashHealthPct').textContent = pct + '%';
  document.getElementById('dashHealthBar').style.width = pct + '%';
  const gpsRatio = lowacc.length / total;
  const gpsLabel = gpsRatio === 0 ? 'Excellent' : gpsRatio < 0.3 ? 'Good' : 'Needs attention';
  const gpsGood = gpsRatio === 0;
  const readyGood = lowacc.length === 0 && missingreq.length === 0;
  const rows = document.getElementById('dashHealthRows');
  rows.innerHTML = `
    <div class="dash-health-row"><div class="dash-health-dot ${gpsGood?'good':'warn'}"></div>GPS quality<span class="dash-health-val">${gpsLabel}</span></div>
    <div class="dash-health-row"><div class="dash-health-dot ${readyGood?'good':'warn'}"></div>Export readiness<span class="dash-health-val">${readyGood?'Ready':'Needs attention'}</span></div>
    <div class="dash-health-row"><div class="dash-health-dot ${nophotos.length?'warn':'good'}"></div>Missing photos<span class="dash-health-val">${nophotos.length||'0'}</span></div>`;
}
