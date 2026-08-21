// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Feature type schema builder, attribute fields, media gallery, reorder
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ FEATURE TYPE SCHEMA BUILDER ══
let editingFt = null;      // working copy of the feature type currently being edited, or null for a new one

let editingFtFields = [];  // working copy of its fields array

let ftFieldIdSeq = 0;

let editingFtColor = null; // explicit hex color chosen in the swatch picker, or null = auto (hash-based)

let editingFtShape = 'circle';     // point symbol — only meaningful while Point is a permitted geometry

let editingFtLineStyle = 'solid';  // shared by line strokes and polygon borders — see renderFtStyleControls()

let editingFtFill = true;          // polygon fill — only meaningful while Polygon is a permitted geometry


function showFeatureTypes() {
  activateView('view-featuretypes');
  renderFeatureTypesList();
  pushNavState('featuretypes');
}

function closeFeatureTypes() {
  activateView('view-app');
  switchTab('dashboard');
  // "Manage feature types" is only ever opened from the dashboard (see the dash-action above),
  // so that dashboard's history stop is already sitting directly below this one — back() consumes
  // it instead of pushNavState() stacking a duplicate 'app' stop on top, which would otherwise
  // make Back from the dashboard bounce straight back into this screen.
  history.back();
}


// ══ MEDIA GALLERY ══ — flattens every photo across every feature/vertex into one filterable
// filmstrip. Same "opened from the dashboard, Back consumes the one stop below it" pattern as
// Feature Types above.
let mediaTypeFilterId = '';

let mediaDateFilter = '';

function collectMediaItems(){
  return savedFeatures.flatMap(f=>{
    const info = resolveFeatureType(f);
    return (f.vertices||[]).flatMap(v=>(v.photos||[]).map(p=>({
      ...p,
      featureId: f.id,
      featureName: f.name || info.label,
      featureTypeKey: info.key,
      featureTypeLabel: info.label,
      time: p.takenAt || v.time || null,
    })));
  });
}

function populateMediaTypeFilter(items){
  const sel = document.getElementById('mediaTypeFilter');
  if (!sel) return;
  const seen = new Map();
  items.forEach(p=>seen.set(String(p.featureTypeKey), p.featureTypeLabel));
  const opts = Array.from(seen.entries()).sort((a,b)=>a[1].localeCompare(b[1]));
  const current = sel.value;
  sel.innerHTML = '<option value="">All types</option>' + opts.map(([key,label])=>`<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('');
  if (opts.some(([key])=>key===current)) sel.value = current;
  else mediaTypeFilterId = '';
}

function mediaDateFilterPasses(item){
  if (!mediaDateFilter) return true;
  if (!item.time) return false;
  const t = new Date(item.time).getTime();
  if (isNaN(t)) return false;
  const now = Date.now();
  const DAY = 86400000;
  if (mediaDateFilter === 'today') {
    const d1 = new Date(); d1.setHours(0,0,0,0);
    return t >= d1.getTime();
  }
  if (mediaDateFilter === '7d')  return t >= now - 7*DAY;
  if (mediaDateFilter === '30d') return t >= now - 30*DAY;
  return true;
}

function onMediaFilterChange(){
  const typeSel = document.getElementById('mediaTypeFilter');
  const dateSel = document.getElementById('mediaDateFilter');
  mediaTypeFilterId = typeSel ? typeSel.value : '';
  mediaDateFilter = dateSel ? dateSel.value : '';
  renderMediaGallery();
}

function renderMediaGallery(){
  const allItems = collectMediaItems();
  const filtered = allItems.filter(p=>{
    if (mediaTypeFilterId && String(p.featureTypeKey) !== mediaTypeFilterId) return false;
    if (!mediaDateFilterPasses(p)) return false;
    return true;
  });
  const grid = document.getElementById('mediaGalleryGrid');
  const empty = document.getElementById('mediaGalleryEmpty');
  const countEl = document.getElementById('mediaGalleryCount');
  if (countEl) countEl.textContent = `${filtered.length} photo${filtered.length===1?'':'s'}${allItems.length!==filtered.length ? ` (of ${allItems.length})` : ''}`;
  if (grid) {
    grid.innerHTML = filtered.map((p,i)=>`
      <div class="photo-thumb" onclick="openMediaGalleryPhoto(${i})">
        <img src="${photoThumbSrc(p)}" alt="${escapeHtml(p.featureName)}" loading="lazy" decoding="async">
        <span class="media-thumb-cap">${escapeHtml(p.featureName)}</span>
      </div>`).join('');
  }
  if (empty) empty.style.display = filtered.length ? 'none' : 'block';
  window._mediaGalleryFiltered = filtered;
}

function openMediaGalleryPhoto(i){
  const items = window._mediaGalleryFiltered || [];
  openLightbox(items, i);
}

function showMediaGallery(){
  activateView('view-media');
  mediaTypeFilterId = ''; mediaDateFilter = '';
  const typeSel = document.getElementById('mediaTypeFilter'); if (typeSel) typeSel.value = '';
  const dateSel = document.getElementById('mediaDateFilter'); if (dateSel) dateSel.value = '';
  populateMediaTypeFilter(collectMediaItems());
  renderMediaGallery();
  pushNavState('media');
}

function closeMediaGallery(){
  activateView('view-app');
  switchTab('dashboard');
  history.back();
}


function renderFeatureTypesList() {
  const el = document.getElementById('ftList');
  if (!featureTypes.length) {
    el.innerHTML = '<div class="empty-projects"><strong>No feature types yet</strong>Add your first feature type to start collecting</div>';
    return;
  }
  el.innerHTML = featureTypes.map(t => {
    const color = featureTypeColor(t.id);
    // ══ THIS LIST IS WHERE SYMBOLOGY IS SET, SO IT SHOULD SHOW IT ══
    // The meta line carried a ●/—/▱ character per permitted geometry: it said which geometries
    // the type allows and nothing about what the type actually LOOKS like on a map. Since this
    // screen is the only place a shape, dash or fill is ever chosen, seeing the result required
    // opening the editor, saving, and going to look at the map. The same legendGlyphSvg() the
    // map legends use draws the real symbol per permitted geometry, so a dashed outline-only
    // polygon reads as one from the list.
    const sym = featureTypeSymbol(t.id);
    const glyphs = ftGeometries(t)
      .map(g => `<span class="ft-row-glyph">${legendGlyphSvg(g, color, sym.shape, sym.lineStyle, sym.filled)}</span>`).join('');
    return `
    <div class="ft-row" onclick="editFeatureType('${t.id}')">
      <div class="ft-row-icon" style="background:${hexToRgba(color,0.14)};border-color:${hexToRgba(color,0.35)};color:${color};">${escapeHtml((t.name||'?').charAt(0))}</div>
      <div class="ft-row-body">
        <div class="ft-row-name">${escapeHtml(t.name)}</div>
        <div class="ft-row-meta">${glyphs} ${escapeHtml(ftGeometryLabel(t))} · ${t.fields.length} field${t.fields.length===1?'':'s'}</div>
      </div>
      <div class="ft-row-actions">
        <button class="ft-icon-btn" title="Duplicate" aria-label="Duplicate feature type" onclick="event.stopPropagation();duplicateFeatureType('${t.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="ft-icon-btn danger" title="Delete" aria-label="Delete feature type" onclick="event.stopPropagation();deleteFeatureType('${t.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}


function newFeatureType() {
  editingFt = null;
  editingFtFields = [];
  editingFtColor = null;
  editingFtShape = 'circle';
  editingFtLineStyle = 'solid';
  editingFtFill = true;
  document.getElementById('ftEditorTitle').textContent = 'New feature type';
  document.getElementById('ftName').value = '';
  // "Start from PlotArchive" belongs to creating, not to editing: on an existing type the fields
  // below are the user's own work, and a row inviting them to overwrite it wholesale is a trap
  // sitting directly above it.
  setFtArchiveRowVisible(true);
  setFtGeo('point');
  renderFtFieldsList();
  renderFtColorPicker();
  renderFtStyleControls();
  activateView('view-featuretype-edit');
  focusWhenSettled('ftName');
  pushNavState('featuretype-edit');
}

// One writer for the row's visibility, so the two entry points cannot disagree about it.
function setFtArchiveRowVisible(show){
  const row = document.getElementById('ftArchiveRow');
  if (row) row.style.display = show ? '' : 'none';
}

function editFeatureType(id) {
  const t = featureTypes.find(x=>x.id===id);
  if (!t) return;
  editingFt = t;
  editingFtFields = t.fields.map(f=>({...f, options:[...(f.options||[])], condition: f.condition ? {...f.condition} : null, subfields:(f.subfields||[]).map(s=>({...s, options:[...(s.options||[])]}))}));
  editingFtColor = t.color || null;
  editingFtShape = POINT_SHAPES.includes(t.shape) ? t.shape : 'circle';
  editingFtLineStyle = LINE_STYLES.includes(t.lineStyle) ? t.lineStyle : 'solid';
  editingFtFill = t.fill !== false;
  document.getElementById('ftEditorTitle').textContent = 'Edit feature type';
  document.getElementById('ftName').value = t.name;
  setFtArchiveRowVisible(false);
  setFtGeo(ftGeometries(t), true); // reflect stored geometry only — see writeFtGeoSelection's `silent` note
  renderFtFieldsList();
  renderFtColorPicker();
  renderFtStyleControls();
  activateView('view-featuretype-edit');
  pushNavState('featuretype-edit', { editId: id });
}

function closeFeatureTypeEditor() {
  activateView('view-featuretypes');
  renderFeatureTypesList();
  // newFeatureType()/editFeatureType() are only ever opened from the feature types list, so it's
  // already sitting directly below this one in history (true whether we got here via Cancel/X or
  // via Save, further up in saveFeatureType()) — back() consumes that stop instead of
  // pushNavState() stacking a duplicate 'featuretypes' one on top of it.
  history.back();
}

function duplicateFeatureType(id) {
  const t = featureTypes.find(x=>x.id===id);
  if (!t) return;
  const copy = { id:'ft_'+Date.now(), name:t.name+' (copy)', geometryType:ftDefaultGeometry(t), geometryTypes:ftGeometries(t),
    color:t.color||null, shape:t.shape||'circle', lineStyle:t.lineStyle||'solid', fill:t.fill!==false,
    fields:t.fields.map(f=>({...f, id:'f_'+Date.now()+'_'+Math.random().toString(36).slice(2,7), options:[...(f.options||[])]})) };
  featureTypes.push(copy);
  persist();
  renderFeatureTypesList();
  showToast('Feature type duplicated');
}

function deleteFeatureType(id) {
  const t = featureTypes.find(x=>x.id===id);
  if (!t) return;
  const used = savedFeatures.some(f=>f.featureTypeId===id);
  const msg = used
    ? `"${t.name}" is used by saved features. Delete it anyway? Existing features will keep their saved data.`
    : `Delete feature type "${t.name}"?`;
  showConfirm(msg, () => {
    featureTypes = featureTypes.filter(x=>x.id!==id);
    persist({ destructive: true });
    renderFeatureTypesList();
    showToast('Feature type deleted');
  });
}


// `silent` is set when this is just reflecting stored state into the UI (opening the editor on an
// existing type). Demoting scope there would rewrite a saved schema as a side effect of merely
// looking at it — and pop a toast for something the user never did. The demotion belongs only on
// an actual geometry change.
function setFtGeo(geo, silent) {
  // `geo` may be a single kind (new type, or an older stored type) or an array (a stored
  // multi-geometry type). Both normalize to the same internal list.
  const list = ftGeometries(Array.isArray(geo) ? { geometryTypes: geo } : { geometryType: geo });
  writeFtGeoSelection(list, silent);
}

// Toggles one geometry in or out of the permitted set. The last remaining one can't be
// switched off — a type with no geometry at all could never be captured, and silently
// re-adding one behind the user's back is worse than refusing the tap.
function toggleFtGeo(geo){
  if (!GEOMETRY_KINDS.includes(geo)) return;
  const current = currentFtGeoList();
  const next = current.includes(geo) ? current.filter(g=>g!==geo) : current.concat([geo]);
  if (!next.length){
    showToast('A feature type needs at least one geometry');
    return;
  }
  writeFtGeoSelection(GEOMETRY_KINDS.filter(g=>next.includes(g)), false);
}

// The single writer for the editor's geometry selection. `silent` is set when this is just
// reflecting stored state into the UI (opening the editor on an existing type) — see the note
// on the scope demotion below for why that distinction still matters.
function writeFtGeoSelection(list, silent){
  const toggle = document.getElementById('ftGeoToggle');
  if (!toggle) return;
  document.querySelectorAll('#ftGeoToggle .geo-opt').forEach(el=>el.classList.toggle('sel', list.includes(el.dataset.geo)));
  toggle.dataset.val = list[0];             // kept: older callers read .dataset.val as the default geometry
  toggle.dataset.geos = list.join(',');     // the real selection
  const hint = document.getElementById('ftGeoHint');
  if (hint){
    hint.textContent = list.length > 1
      ? 'Captured as ' + list.join(' or ') + '. The crew picks per feature, attributes stay the same.'
      : 'Every feature of this type is a ' + list[0] + '. Tap another to allow both.';
  }
  // Demotion only applies when point is the ONLY permitted geometry. Under multi-geometry a
  // per-vertex field is still meaningful (it just collapses to feature-scope on the point
  // captures — see effectiveFieldScope in js/02-state.js), so rewriting the saved schema here
  // would destroy a setting the user will want back the moment they capture a polygon.
  const pointOnly = list.length === 1 && list[0] === 'point';
  if (!silent && pointOnly && typeof editingFtFields !== 'undefined' && editingFtFields){
    const demoted = editingFtFields.filter(f=>f.scope==='vertex');
    if (demoted.length){
      demoted.forEach(f=>f.scope='feature');
      showToast(demoted.length===1 ? '“'+(demoted[0].label||'Field')+'” is now once per feature'
                                   : demoted.length+' fields switched to once per feature');
    }
  }
  if (typeof renderFtFieldsList === 'function' && document.getElementById('ftFieldsList')) renderFtFieldsList();
  if (ftFieldDraft) syncFtFieldSheet();
  if (typeof renderFtStyleControls === 'function' && document.getElementById('ftStyleCard')) renderFtStyleControls();
}


// ══ FEATURE TYPE SYMBOLOGY (shape / line style / fill) ══
// One shared row for line style rather than a separate "line" and "polygon border" picker — a
// dashed boundary is the same concept whether it's a fence line or a parcel edge, so a type that
// permits both geometries only ever sees the choice once. Each row only appears for a geometry
// the type actually permits, so a point-only type never sees line/polygon controls and vice
// versa — the whole card hides itself when nothing in it would apply.
function setFtShape(shape){ editingFtShape = shape; renderFtStyleControls(); }
function setFtLineStyle(style){ editingFtLineStyle = style; renderFtStyleControls(); }
function setFtFill(fill){ editingFtFill = fill; renderFtStyleControls(); }

function renderFtStyleControls(){
  const card = document.getElementById('ftStyleCard');
  if (!card) return;
  const geos = currentFtGeoList();
  const hasPoint = geos.includes('point');
  const hasLine = geos.includes('line');
  const hasPolygon = geos.includes('polygon');
  if (!hasPoint && !hasLine && !hasPolygon){ card.style.display = 'none'; return; }
  card.style.display = '';

  const shapeLabels = { circle:'Circle', square:'Square', triangle:'Triangle' };
  const shapeGlyph = { circle:'●', square:'■', triangle:'▲' };
  let html = '';

  if (hasPoint){
    html += `<div class="field" style="margin-bottom:${hasLine||hasPolygon?'14px':'0'};">
      <label>Point shape</label>
      <div class="geo-toggle">${POINT_SHAPES.map(s=>
        `<div class="geo-opt ${editingFtShape===s?'sel':''}" onclick="setFtShape('${s}')">${shapeGlyph[s]} ${shapeLabels[s]}</div>`
      ).join('')}</div>
    </div>`;
  }

  if (hasLine || hasPolygon){
    const lineLabel = hasLine && hasPolygon ? 'Line / border style' : hasPolygon ? 'Border style' : 'Line style';
    html += `<div class="field" style="margin-bottom:${hasPolygon?'14px':'0'};">
      <label>${lineLabel}</label>
      <div class="geo-toggle">
        <div class="geo-opt ${editingFtLineStyle==='solid'?'sel':''}" onclick="setFtLineStyle('solid')">— Solid</div>
        <div class="geo-opt ${editingFtLineStyle==='dashed'?'sel':''}" onclick="setFtLineStyle('dashed')">╌ Dashed</div>
        <div class="geo-opt ${editingFtLineStyle==='dotted'?'sel':''}" onclick="setFtLineStyle('dotted')">⋯ Dotted</div>
      </div>
    </div>`;
  }

  if (hasPolygon){
    html += `<div class="field" style="margin-bottom:0;">
      <label>Polygon fill</label>
      <div class="geo-toggle">
        <div class="geo-opt ${editingFtFill?'sel':''}" onclick="setFtFill(true)">▰ Filled</div>
        <div class="geo-opt ${!editingFtFill?'sel':''}" onclick="setFtFill(false)">▱ Outline only</div>
      </div>
    </div>`;
  }

  card.innerHTML = html;
}


// ══ FEATURE TYPE COLOR SWATCH PICKER ══
// "Auto" keeps the old hash-based behavior (stable but implicit); picking a swatch pins an
// explicit color onto the feature type so badges/map markers/exports all pick it up via
// featureTypeColor(), which checks for an explicit color before falling back to the hash.
function setFtColor(color) {
  editingFtColor = color; // null = Auto
  renderFtColorPicker();
}

function renderFtColorPicker() {
  const el = document.getElementById('ftColorPicker');
  if (!el) return;
  const autoPreview = editingFt ? featureTypeColor(editingFt.id) : FEATURE_COLOR_PALETTE[0];
  const autoSel = !editingFtColor;
  let html = `<div class="ft-swatch ft-swatch-auto ${autoSel?'sel':''}" title="Auto" onclick="setFtColor(null)" style="background:${hexToRgba(autoPreview,0.18)};border-color:${autoSel?autoPreview:'var(--card-border)'};color:${autoPreview};">A</div>`;
  html += FEATURE_COLOR_PALETTE.map(c => {
    const sel = editingFtColor === c;
    return `<div class="ft-swatch ${sel?'sel':''}" title="${c}" onclick="setFtColor('${c}')" style="background:${c};border-color:${sel?'var(--text-primary)':'transparent'};"></div>`;
  }).join('');
  el.innerHTML = html;
}


// ══ ATTRIBUTE FIELD SHEET ══
// ftFieldDraft is a detached copy of the field being edited; ftFieldIdx is its index in
// editingFtFields, or null for a field being added. Nothing touches editingFtFields until Done,
// so Cancel/backdrop/Back all discard cleanly and "Add field" can't leave a blank row behind.
let ftFieldDraft = null, ftFieldIdx = null;


function currentFtGeo(){ return document.getElementById('ftGeoToggle').dataset.val || 'point'; }

// The full permitted set being edited. Falls back to the singular so the editor still behaves
// if it is somehow opened before writeFtGeoSelection has run.
function currentFtGeoList(){
  const raw = (document.getElementById('ftGeoToggle').dataset.geos || '').split(',').filter(Boolean);
  return raw.length ? GEOMETRY_KINDS.filter(g=>raw.includes(g)) : [currentFtGeo()];
}

// True only when point is the sole permitted geometry — the case where "per vertex" genuinely
// cannot mean anything different from "once per feature".
function currentFtIsPointOnly(){
  const list = currentFtGeoList();
  return list.length === 1 && list[0] === 'point';
}


function openFtFieldSheet(idx){
  ftFieldIdx = (idx === null || idx === undefined) ? null : idx;
  ftFieldDraft = ftFieldIdx === null
    ? { id:'f_'+Date.now()+'_'+(ftFieldIdSeq++), label:'', type:'text', options:[], required:false, placeholder:'', scope:'feature', condition:null, expression:'', subfields:[], refTargetFtId:'' }
    : { condition:null, expression:'', subfields:[], refTargetFtId:'', ...editingFtFields[ftFieldIdx], options:[...(editingFtFields[ftFieldIdx].options||[])], condition: editingFtFields[ftFieldIdx].condition ? {...editingFtFields[ftFieldIdx].condition} : null, subfields:(editingFtFields[ftFieldIdx].subfields||[]).map(s=>({...s, options:[...(s.options||[])]})) };
  document.getElementById('ftFieldSheetTitle').textContent = ftFieldIdx === null ? 'New field' : 'Edit field';
  document.getElementById('ftfDeleteBtn').style.display = ftFieldIdx === null ? 'none' : '';
  document.getElementById('ftfType').innerHTML =
    FIELD_TYPES.map(t=>`<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');
  syncFtFieldSheet();
  document.getElementById('ftFieldModal').classList.add('show');
  if (ftFieldIdx === null) focusWhenSettled('ftfLabel');
}


// Fields this field's visibility can depend on, or a calculated field's expression can reference:
// strictly earlier in the list (no forward references, no cycles to detect), the same scope (a
// per-vertex field can't sensibly depend on a once-per-feature value or vice versa — they're
// captured at different times), and NOT a repeating group (its value is a list of entries, not a
// single settable thing a condition or an arithmetic expression can compare against). Excludes the
// field being edited itself.
function ftEligibleDependencies(){
  const pool = ftFieldIdx === null ? editingFtFields : editingFtFields.slice(0, ftFieldIdx);
  return pool.filter(f => f.scope === (ftFieldDraft.scope||'feature') && f.type !== 'repeat_group');
}


// Pushes the draft into the sheet's controls. Value-setting is one-directional (draft → DOM) so
// re-rendering after a type/scope change can never clobber what's mid-typing in another input.
function syncFtFieldSheet(){
  const f = ftFieldDraft; if (!f) return;
  const label = document.getElementById('ftfLabel');
  if (label.value !== f.label) label.value = f.label;
  document.getElementById('ftfType').value = f.type;
  const ph = document.getElementById('ftfPlaceholder');
  if (ph.value !== (f.placeholder||'')) ph.value = f.placeholder||'';
  const dv = document.getElementById('ftfDefault');
  if (dv && dv.value !== (f.defaultValue||'')) dv.value = f.defaultValue||'';
  document.getElementById('ftfRequired').checked = !!f.required;

  const needsOptions = f.type==='single_select' || f.type==='multi_select';
  document.getElementById('ftfOptionsField').style.display = needsOptions ? '' : 'none';
  if (needsOptions){
    document.getElementById('ftfOptTags').innerHTML = (f.options||[]).map((o,oi)=>
      `<span class="opt-tag">${escapeHtml(o)}<button onclick="removeFtDraftOption(${oi})">×</button></span>`).join('');
  }

  // ══ WHAT A LINK FIELD MAY POINT AT ══
  // Offered as the feature types in THIS project's schema, plus an explicit "any". Constraining it
  // is what makes the picker usable at capture time — four Rooms on this floor rather than every
  // feature in the project — and it is also what lets the linked-features list on a feature know
  // which fields to look at. A type cannot point at itself: a room inside a room is a hierarchy
  // this deliberately does not model, and offering it would invite exactly the nesting the flat
  // pointer exists to avoid.
  const isRefLink = f.type === 'feature_ref';
  document.getElementById('ftfRefTargetField').style.display = isRefLink ? '' : 'none';
  if (isRefLink){
    const selfId = editingFt && editingFt.id;
    const others = (featureTypes || []).filter(t => !selfId || t.id !== selfId);
    const sel = document.getElementById('ftfRefTarget');
    sel.innerHTML = '<option value="">Any feature type</option>' +
      others.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join('');
    sel.value = f.refTargetFtId || '';
    // If the saved target has since been deleted from the schema, the select falls back to "any"
    // — and the draft is corrected to match, so saving does not silently re-assert a dead id.
    if (sel.value !== (f.refTargetFtId || '')) f.refTargetFtId = '';
    document.getElementById('ftfRefTargetHint').textContent = others.length
      ? 'At capture time this shows the Reference IDs of features already collected. Capture the thing being pointed at first.'
      : 'Add another feature type first \u2014 a link needs something to point at.';
  }

  // A calculated field is never user-typed and is never "empty vs. required" in the same sense as
  // the rest — it just doesn't resolve when what it depends on is blank. Required and Placeholder
  // don't apply to it.
  const isCalculated = f.type === 'calculated';
  const isGroup = f.type === 'repeat_group';
  document.getElementById('ftfExpressionField').style.display = isCalculated ? '' : 'none';
  if (isCalculated){
    const expr = document.getElementById('ftfExpression');
    if (expr.value !== (f.expression||'')) expr.value = f.expression||'';
    const deps = ftEligibleDependencies();
    document.getElementById('ftfExpressionTokens').innerHTML = deps.length
      ? deps.map(d=>`<span class="opt-tag" style="cursor:pointer;" onclick="insertFtExpressionToken('${d.id}')">${escapeHtml(d.label||d.id)}</span>`).join('')
      : '<span class="hint">Add another field first. An expression needs something to reference.</span>';
  }

  // A repeating group has no single value of its own to type in or pick — what repeats is the set
  // of sub-fields below, once per entry — so Choices/Placeholder/scope don't apply, and "Required"
  // is repurposed to mean "at least one entry" rather than "this input can't be blank".
  document.getElementById('ftfSubfieldsField').style.display = isGroup ? '' : 'none';
  document.getElementById('ftfScopeField').style.display = isGroup ? 'none' : '';
  document.getElementById('ftfRequiredRow').style.display = isCalculated ? 'none' : '';
  document.getElementById('ftfRequiredLabel').textContent = isGroup ? 'Require at least one entry' : 'Required';
  if (isCalculated && f.required) f.required = false;
  if (isGroup){
    f.scope = 'feature'; // a repeating group is always captured once per feature, never per vertex
    renderFtSubfieldsList();
  }

  // A point capture has one vertex, so "per vertex" and "once per feature" ask the same
  // question — but that is only a reason to disable the option when point is the type's ONLY
  // permitted geometry. If the type can also be captured as a line or polygon, per-vertex is a
  // real choice and stays available; it simply collapses to feature-scope on the point captures
  // (effectiveFieldScope, js/02-state.js). The option is disabled rather than removed so the
  // control keeps its shape.
  const pointOnly = currentFtIsPointOnly();
  const multiGeo = currentFtGeoList().length > 1;
  if (pointOnly && f.scope === 'vertex') f.scope = 'feature';
  document.querySelectorAll('#ftfScopeToggle .geo-opt').forEach(el=>{
    const isVertex = el.dataset.scope === 'vertex';
    el.classList.toggle('sel', el.dataset.scope === (f.scope==='vertex'?'vertex':'feature'));
    el.classList.toggle('is-disabled', isVertex && pointOnly);
    el.setAttribute('aria-disabled', String(isVertex && pointOnly));
  });
  document.getElementById('ftfScopeHint').textContent = pointOnly
    ? 'Point features have a single vertex, so every field is captured once per feature.'
    : multiGeo
      ? 'Per-vertex fields are asked again at each captured point. On this type’s point captures they fall back to once per feature.'
      : 'Per-vertex fields are asked again at each captured point along the geometry.';

  // ══ Skip logic (condition) ══
  const depOptions = ftEligibleDependencies();
  const condToggle = document.getElementById('ftfConditionOn');
  const condRow = document.getElementById('ftfConditionRow');
  const hasCondition = !!(f.condition && f.condition.fieldId);
  condToggle.checked = hasCondition;
  condToggle.disabled = !depOptions.length;
  condRow.style.display = hasCondition ? '' : 'none';
  if (!depOptions.length){
    document.getElementById('ftfConditionField').innerHTML = '<option value="">No earlier field to depend on</option>';
  } else {
    const fieldSel = document.getElementById('ftfConditionField');
    fieldSel.innerHTML = depOptions.map(d=>`<option value="${d.id}">${escapeHtml(d.label||d.id)}</option>`).join('');
    fieldSel.value = (f.condition && f.condition.fieldId) || depOptions[0].id;
  }
  if (hasCondition){
    document.getElementById('ftfConditionOp').value = f.condition.op || 'eq';
    const valInput = document.getElementById('ftfConditionValue');
    if (valInput.value !== (f.condition.value||'')) valInput.value = f.condition.value||'';
    const needsValue = f.condition.op !== 'set' && f.condition.op !== 'not_set';
    valInput.style.display = needsValue ? '' : 'none';
  }
}

function toggleFtDraftCondition(on){
  if (!ftFieldDraft) return;
  const deps = ftEligibleDependencies();
  if (on && !deps.length){
    showToast('Add another field first, there\'s nothing earlier to condition on');
    document.getElementById('ftfConditionOn').checked = false;
    return;
  }
  ftFieldDraft.condition = on ? { fieldId: deps[0].id, op:'eq', value:'' } : null;
  syncFtFieldSheet();
}

function updateFtDraftCondition(key, value){
  if (!ftFieldDraft || !ftFieldDraft.condition) return;
  ftFieldDraft.condition[key] = value;
  if (key === 'op') syncFtFieldSheet(); // toggles the value input's visibility (set / not_set need none)
}

function insertFtExpressionToken(fieldId){
  const el = document.getElementById('ftfExpression');
  const token = `{${fieldId}}`;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + token.length;
  updateFtDraft('expression', el.value);
}


// ══ REPEATING GROUPS: sub-field editor ══
// A field of type 'repeat_group' carries its own small field list (ftFieldDraft.subfields) rather
// than reusing the top-level editingFtFields — a group's fields don't have a scope (they're
// captured per group-entry, not per feature or per vertex), can't be conditioned on other fields
// or calculated, and can't themselves be a group. Editing one opens this modal ON TOP of the field
// modal it belongs to (see the two modals' z-index in index.html) rather than replacing it, so
// "Done" on a sub-field returns to the group's own field sheet, not out of it entirely.
let ftSubfieldDraft = null, ftSubfieldIdx = null;

function openFtSubfieldSheet(idx){
  if (!ftFieldDraft) return;
  ftFieldDraft.subfields = ftFieldDraft.subfields || [];
  ftSubfieldIdx = (idx === null || idx === undefined) ? null : idx;
  ftSubfieldDraft = ftSubfieldIdx === null
    ? { id:'sf_'+Date.now()+'_'+(ftFieldIdSeq++), label:'', type:'text', options:[], required:false, placeholder:'' }
    : { ...ftFieldDraft.subfields[ftSubfieldIdx], options:[...(ftFieldDraft.subfields[ftSubfieldIdx].options||[])] };
  document.getElementById('ftSubfieldSheetTitle').textContent = ftSubfieldIdx === null ? 'New field' : 'Edit field';
  document.getElementById('ftsDeleteBtn').style.display = ftSubfieldIdx === null ? 'none' : '';
  document.getElementById('ftsType').innerHTML =
    REPEAT_SUBFIELD_TYPES.map(t=>`<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');
  syncFtSubfieldSheet();
  document.getElementById('ftSubfieldModal').classList.add('show');
  if (ftSubfieldIdx === null) focusWhenSettled('ftsLabel');
}

function syncFtSubfieldSheet(){
  const s = ftSubfieldDraft; if (!s) return;
  const label = document.getElementById('ftsLabel');
  if (label.value !== s.label) label.value = s.label;
  document.getElementById('ftsType').value = s.type;
  const ph = document.getElementById('ftsPlaceholder');
  if (ph.value !== (s.placeholder||'')) ph.value = s.placeholder||'';
  document.getElementById('ftsRequired').checked = !!s.required;
  const needsOptions = s.type==='single_select' || s.type==='multi_select';
  document.getElementById('ftsOptionsField').style.display = needsOptions ? '' : 'none';
  if (needsOptions){
    document.getElementById('ftsOptTags').innerHTML = (s.options||[]).map((o,oi)=>
      `<span class="opt-tag">${escapeHtml(o)}<button onclick="removeFtSubfieldDraftOption(${oi})">×</button></span>`).join('');
  }
}

function updateFtSubfieldDraft(key, value){
  if (!ftSubfieldDraft) return;
  ftSubfieldDraft[key] = value;
  if (key === 'type') syncFtSubfieldSheet();
}

function addFtSubfieldDraftOption(){
  const input = document.getElementById('ftsOptInput');
  const val = input.value.trim();
  if (!val || !ftSubfieldDraft) return;
  ftSubfieldDraft.options = ftSubfieldDraft.options || [];
  if (!ftSubfieldDraft.options.includes(val)) ftSubfieldDraft.options.push(val);
  input.value = '';
  syncFtSubfieldSheet();
  input.focus();
}

function removeFtSubfieldDraftOption(optIdx){
  if (!ftSubfieldDraft) return;
  ftSubfieldDraft.options.splice(optIdx,1);
  syncFtSubfieldSheet();
}

function deleteFtSubfieldDraftField(){
  if (ftSubfieldIdx === null || !ftFieldDraft) return;
  ftFieldDraft.subfields.splice(ftSubfieldIdx,1);
  ftSubfieldDraft = null; ftSubfieldIdx = null;
  document.getElementById('ftSubfieldModal').classList.remove('show');
  renderFtSubfieldsList();
}

function closeFtSubfieldSheet(commit){
  if (commit && ftSubfieldDraft && ftFieldDraft){
    const s = ftSubfieldDraft;
    if (!s.label.trim()){ showToast('Give the field a label'); document.getElementById('ftsLabel').focus(); return; }
    if ((s.type==='single_select'||s.type==='multi_select') && !(s.options||[]).length){
      showToast('Add at least one choice'); document.getElementById('ftsOptInput').focus(); return;
    }
    if (ftSubfieldIdx === null) ftFieldDraft.subfields.push(s);
    else ftFieldDraft.subfields[ftSubfieldIdx] = s;
    renderFtSubfieldsList();
  }
  ftSubfieldDraft = null; ftSubfieldIdx = null;
  document.getElementById('ftSubfieldModal').classList.remove('show');
}

function renderFtSubfieldsList(){
  const el = document.getElementById('ftSubfieldsList');
  if (!el || !ftFieldDraft) return;
  const subs = ftFieldDraft.subfields || [];
  if (!subs.length){
    el.innerHTML = '<div class="empty-box" style="padding:14px;"><strong>No fields yet</strong>Add at least one. This is what repeats per entry</div>';
    return;
  }
  const typeLabel = v => (REPEAT_SUBFIELD_TYPES.find(t=>t.value===v)||{}).label || v;
  el.innerHTML = subs.map((s,i) => `<div class="sum-row" role="button" tabindex="0" onclick="openFtSubfieldSheet(${i})">
    <div class="sum-body">
      <div class="sum-label${s.label.trim()?'':' is-empty'}">${s.label.trim()?escapeHtml(s.label):'Untitled field'}</div>
      <div class="sum-meta"><span>${escapeHtml(typeLabel(s.type))}</span>${s.required?'<span class="sum-pill req">REQUIRED</span>':''}</div>
    </div>
    <span class="attr-sum-chev"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
  </div>`).join('');
}


function updateFtDraft(key, value){
  if (!ftFieldDraft) return;
  if (key === 'scope' && value === 'vertex' && currentFtIsPointOnly()){
    showToast('Point features have only one vertex');
    return;
  }
  ftFieldDraft[key] = value;
  if (key === 'type' || key === 'scope') syncFtFieldSheet();
}

function addFtDraftOption(){
  const input = document.getElementById('ftfOptInput');
  const val = input.value.trim();
  if (!val || !ftFieldDraft) return;
  ftFieldDraft.options = ftFieldDraft.options || [];
  if (!ftFieldDraft.options.includes(val)) ftFieldDraft.options.push(val);
  input.value = '';
  syncFtFieldSheet();
  input.focus();
}

function removeFtDraftOption(optIdx){
  if (!ftFieldDraft) return;
  ftFieldDraft.options.splice(optIdx,1);
  syncFtFieldSheet();
}

function deleteFtDraftField(){
  if (ftFieldIdx === null) return;
  const name = (ftFieldDraft && ftFieldDraft.label.trim()) || 'this field';
  showConfirm(`Delete ${name==='this field'?name:'"'+name+'"'} from this feature type?`, ()=>{
    const removedId = editingFtFields[ftFieldIdx].id;
    editingFtFields.splice(ftFieldIdx,1);
    // Anything conditioned on, or calculating from, the field just deleted would otherwise point
    // at an id that no longer exists — always-visible / unresolvable is the safer failure mode
    // than silently referencing a ghost field.
    editingFtFields.forEach(f=>{
      if (f.condition && f.condition.fieldId === removedId) f.condition = null;
      if (f.type === 'calculated' && f.expression) f.expression = f.expression.replace(new RegExp('\\{'+removedId+'\\}','g'), '0');
    });
    ftFieldDraft = null; ftFieldIdx = null;
    document.getElementById('ftFieldModal').classList.remove('show');
    renderFtFieldsList();
    showToast('Field removed');
  });
}


function closeFtFieldSheet(commit){
  if (commit && ftFieldDraft){
    const f = ftFieldDraft;
    if (!f.label.trim()){ showToast('Give the field a label'); document.getElementById('ftfLabel').focus(); return; }
    if ((f.type==='single_select'||f.type==='multi_select') && !(f.options||[]).length){
      showToast('Add at least one choice'); document.getElementById('ftfOptInput').focus(); return;
    }
    if (f.type==='calculated' && !(f.expression||'').trim()){
      showToast('Add an expression, or pick a different field type'); document.getElementById('ftfExpression').focus(); return;
    }
    if (f.type==='repeat_group' && !(f.subfields||[]).length){
      showToast('Add at least one field to the group'); return;
    }
    if (f.condition && !f.condition.fieldId) f.condition = null; // guard against a stray half-set toggle
    if (ftFieldIdx === null) editingFtFields.push(f);
    else editingFtFields[ftFieldIdx] = f;
    renderFtFieldsList();
  }
  ftFieldDraft = null; ftFieldIdx = null;
  document.getElementById('ftFieldModal').classList.remove('show');
}


// ══ REORDER ══
// Pointer Events cover mouse and touch with one code path. The handle sets touch-action:none so
// a vertical drag on it reorders instead of scrolling the page, while the rest of the row keeps
// normal scrolling.
let ftDragFrom = null;

function ftDragStart(ev, idx){
  ev.preventDefault();
  ftDragFrom = idx;
  const rows = [...document.querySelectorAll('#ftFieldsList .sum-row')];
  rows[idx]?.classList.add('dragging');
  const move = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el && el.closest('.sum-row');
    rows.forEach(r=>r.classList.toggle('drop-target', r === row && r !== rows[ftDragFrom]));
  };
  const up = e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el && el.closest('.sum-row');
    const to = row ? parseInt(row.dataset.idx,10) : null;
    rows.forEach(r=>r.classList.remove('dragging','drop-target'));
    if (to !== null && !isNaN(to) && to !== ftDragFrom){
      const [moved] = editingFtFields.splice(ftDragFrom,1);
      editingFtFields.splice(to,0,moved);
      sanitizeFtFieldOrderDependencies();
      renderFtFieldsList();
    }
    ftDragFrom = null;
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

// Conditions and calculated-field expressions are only ever allowed to reference a field earlier
// in the list (see ftEligibleDependencies) — reordering can invalidate that after the fact, e.g.
// dragging the field a condition depends on to below it. Rather than leave a condition silently
// referencing something that comes later (which the capture form would never be able to satisfy
// in a stepper that only shows earlier answers first), clear anything reorder just broke.
function sanitizeFtFieldOrderDependencies(){
  editingFtFields.forEach((f, idx) => {
    const earlierIds = new Set(editingFtFields.slice(0, idx).map(x=>x.id));
    if (f.condition && f.condition.fieldId && !earlierIds.has(f.condition.fieldId)) f.condition = null;
    if (f.type === 'calculated' && f.expression){
      const refs = [...f.expression.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m=>m[1]);
      if (refs.some(r => !earlierIds.has(r))) f.expression = '';
    }
  });
}


// One fixed-height row per field: drag handle, label, "type · scope" summary, edit affordance.
// Everything editable lives in the sheet — see openFtFieldSheet().
function renderFtFieldsList() {
  const el = document.getElementById('ftFieldsList');
  if (!editingFtFields.length) {
    el.innerHTML = '<div class="empty-box"><strong>No fields yet</strong>Tap “Add field” to define what gets captured</div>';
    return;
  }
  const typeLabel = v => (FIELD_TYPES.find(t=>t.value===v)||{}).label || v;
  el.innerHTML = editingFtFields.map((f,idx) => {
    const bits = [escapeHtml(typeLabel(f.type))];
    if ((f.type==='single_select'||f.type==='multi_select')) bits.push((f.options||[]).length + ' choices');
    return `<div class="sum-row" data-idx="${idx}" role="button" tabindex="0" onclick="openFtFieldSheet(${idx})">
      <div class="sum-drag" aria-label="Reorder field" onclick="event.stopPropagation()" onpointerdown="ftDragStart(event,${idx})">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
      </div>
      <div class="sum-body">
        <div class="sum-label${f.label.trim()?'':' is-empty'}">${f.label.trim()?escapeHtml(f.label):'Untitled field'}</div>
        <div class="sum-meta">
          <span>${bits.join(' <span class="sum-dot">·</span> ')}</span>
          ${f.scope==='vertex'?'<span class="sum-pill vtx">PER VERTEX</span>':''}
          ${f.required?'<span class="sum-pill req">REQUIRED</span>':''}
          ${f.condition && f.condition.fieldId?'<span class="sum-pill">CONDITIONAL</span>':''}
        </div>
      </div>
      <button class="sum-edit" aria-label="Edit ${escapeHtml(f.label||'field')}" onclick="event.stopPropagation();openFtFieldSheet(${idx})">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </div>`;
  }).join('');
}


function saveFeatureType() {
  const name = document.getElementById('ftName').value.trim();
  const geos = currentFtGeoList();
  // geometryType stays written as the first permitted geometry: it is what every pre-existing
  // reader in the app (and every already-exported .plotpack) treats as "the" geometry of a type,
  // and for the single-geometry types that is still exactly right.
  const geo = geos[0];
  if (!name) { showToast('Enter a feature type name'); return; }
  const badField = editingFtFields.find(f=>!f.label.trim());
  if (badField) { showToast('Every field needs a label'); return; }
  const badOptions = editingFtFields.find(f=>(f.type==='single_select'||f.type==='multi_select') && !(f.options||[]).length);
  if (badOptions) { showToast(`Add at least one choice for "${badOptions.label}"`); return; }
  const badGroup = editingFtFields.find(f=>f.type==='repeat_group' && !(f.subfields||[]).length);
  if (badGroup) { showToast(`Add at least one field to "${badGroup.label}"`); return; }

  const fields = editingFtFields.map(f=>({
    id:f.id, label:f.label.trim(), type:f.type, options:f.options||[], required:!!f.required,
    placeholder:f.placeholder||'', scope: f.type==='repeat_group' ? 'feature' : (f.scope==='vertex'?'vertex':'feature'),
    condition: (f.condition && f.condition.fieldId) ? { fieldId:f.condition.fieldId, op:f.condition.op||'eq', value:f.condition.value||'' } : null,
    expression: f.type==='calculated' ? (f.expression||'') : '',
    subfields: f.type==='repeat_group' ? (f.subfields||[]).map(s=>({ id:s.id, label:s.label.trim(), type:s.type, options:s.options||[], required:!!s.required, placeholder:s.placeholder||'' })) : []
  }));

  if (editingFt) {
    editingFt.name = name;
    editingFt.geometryType = geo;
    editingFt.geometryTypes = geos;
    editingFt.fields = fields;
    editingFt.color = editingFtColor || null;
    editingFt.shape = editingFtShape;
    editingFt.lineStyle = editingFtLineStyle;
    editingFt.fill = editingFtFill;
  } else {
    featureTypes.push({ id:'ft_'+Date.now(), name, geometryType:geo, geometryTypes:geos, fields, color: editingFtColor || null,
      shape: editingFtShape, lineStyle: editingFtLineStyle, fill: editingFtFill });
  }
  persist();
  populateFeatureTypeSelect();
  closeFeatureTypeEditor();
  showToast('Feature type saved ✓');
}
