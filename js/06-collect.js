// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Collect tab: feature type select, attributes, scanner, tabs, accordion
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ REFERENCE ID AUTO-GENERATION ══
// One less thing to type per capture: picking a feature type fills Reference ID with
// TYPE-001/TYPE-002/... (sequential per type, based on how many of that type are already saved
// in this project). Fully editable — typing over it is respected on later type changes.
let refIdAutoFilled = null; // last value *we* wrote, so we can tell a user edit apart from our own autofill

function generateReferenceId(ft){
  if (!ft) return '';
  const prefix = (ft.name||'FEAT').toUpperCase().replace(/[^A-Z0-9]+/g,'').slice(0,6) || 'FEAT';
  const count = savedFeatures.filter(f=>f.featureTypeId===ft.id).length + 1;
  return `${prefix}-${String(count).padStart(3,'0')}`;
}

function autofillReferenceId(ft){
  if (editingFeatureId) return; // never touch an existing feature's already-saved Reference ID
  const input = document.getElementById('featureRef');
  if (!input) return;
  const current = input.value.trim();
  if (current !== '' && current !== refIdAutoFilled) return; // user typed their own — leave it alone
  refIdAutoFilled = generateReferenceId(ft);
  input.value = refIdAutoFilled;
}


// ══ PLOTIN / PLOTOUT ══
// Switches the Collect form between the standard outdoor GNSS workflow and the indoor one. PlotIn
// does not touch GPS gating at all (startGPS/onPos/onErr/captureBtn.disabled are untouched) —
// instead it makes the satellite/plan tap map (see ensureVertexMap in js/09-geometry.js) the
// primary capture surface, since that path never depends on a fix. A crew near a window can still
// use GPS normally; PlotIn just stops requiring it.
function setCollectEnvironment(env){
  env = env === 'PlotIn' ? 'PlotIn' : 'PlotOut';
  currentEnvironment = env;
  const toggle = document.getElementById('collectEnvToggle');
  if (toggle) {
    toggle.dataset.val = env;
    toggle.querySelectorAll('.geo-opt').forEach(el => el.classList.toggle('sel', el.dataset.env === env));
  }
  const indoorFields = document.getElementById('collectIndoorFields');
  if (indoorFields) indoorFields.style.display = env === 'PlotIn' ? '' : 'none';
  const note = document.getElementById('plotinCaptureNote');
  if (note) note.style.display = env === 'PlotIn' ? 'flex' : 'none';

  // Force the satellite/plan tap map into view the moment PlotIn is selected, rather than waiting
  // on the line/polygon-only "Adjust on satellite map" toggle it normally rides along with (see
  // updateShapePreview() in js/09-geometry.js, which now also shows that button for any geometry
  // type while PlotIn is active).
  const mapToggle = document.getElementById('vertexMapToggleBtn');
  if (mapToggle) mapToggle.style.display = '';
  if (env === 'PlotIn' && !vertexMapVisible) toggleVertexMap();
  else if (env === 'PlotOut' && vertexMapVisible && !currentVertices.length) toggleVertexMap();
}

function resetCollectEnvironmentFields(){
  setCollectEnvironment('PlotOut');
  const bId = document.getElementById('collectBuildingId'); if (bId) bId.value = '';
  const fl = document.getElementById('collectFloorLevel'); if (fl) fl.value = '';
}


// ══ FEATURE TYPE SELECT (Collect tab) ══
let activeVertexFields = []; // this project type's fields with scope==='vertex' — rendered per-captured-vertex in the Vertex Details card


function populateFeatureTypeSelect() {
  const sel = document.getElementById('featureTypeSelect');
  const card = document.getElementById('noFeatureTypesCard');
  const banner = document.getElementById('noFtBanner');
  const triggerBtn = document.getElementById('featureTypePickerBtn');
  if (!featureTypes.length) {
    sel.innerHTML = '';
    sel.disabled = true;
    triggerBtn.disabled = true;
    document.getElementById('featureTypePickerLabel').textContent = 'No feature types yet';
    document.getElementById('featureTypePickerGlyph').textContent = '';
    card.style.display = '';
    if (banner) banner.style.display = '';
    document.getElementById('attrFields').innerHTML = '';
    document.getElementById('geoTag').textContent = '—';
    document.getElementById('captureBtn').disabled = true;
    document.getElementById('saveFeatureBtn').disabled = true;
    return;
  }
  card.style.display = 'none';
  if (banner) banner.style.display = 'none';
  sel.disabled = false;
  triggerBtn.disabled = false;
  sel.innerHTML = featureTypes.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  onFeatureTypeChange();
}


// ══ FEATURE TYPE PICKER MODAL ══
// A big-target modal list standing in for the hidden native <select> above — see the CSS comment
// (search "FEATURE TYPE PICKER") for why rows instead of the fixed 3-way geo-opt pills.
const ftPickerGlyph = { point:'●', line:'—', polygon:'▱' };

function openFeatureTypePicker(){
  if (document.getElementById('featureTypePickerBtn').disabled) return;
  const sel = document.getElementById('featureTypeSelect');
  const list = document.getElementById('featureTypePickerList');
  list.innerHTML = featureTypes.map(t => {
    const isSel = t.id === sel.value;
    return `<div class="ft-picker-row ${isSel?'sel':''}" onclick="selectFeatureTypeFromPicker('${t.id}')">
      <div class="ft-picker-row-glyph">${ftGeometries(t).map(g=>ftPickerGlyph[g]||'').join('')}</div>
      <div class="ft-picker-row-text">
        <div class="ft-picker-row-name">${escapeHtml(t.name)}</div>
        <div class="ft-picker-row-meta">${escapeHtml(ftGeometryLabel(t))} · ${t.fields.length} field${t.fields.length===1?'':'s'}</div>
      </div>
      <div class="ft-picker-row-check">✓</div>
    </div>`;
  }).join('');
  document.getElementById('featureTypePickerModal').classList.add('show');
}

function closeFeatureTypePicker(){
  document.getElementById('featureTypePickerModal').classList.remove('show');
}

function selectFeatureTypeFromPicker(id){
  const sel = document.getElementById('featureTypeSelect');
  sel.value = id;
  closeFeatureTypePicker();
  onFeatureTypeChange();
  // Picking the type is the moment attention should move to the fix — that is the whole reason
  // GPS & Capture was ordered second. Advancing the accordion here saves the crew a scroll and a
  // tap on every single feature, and only fires on an explicit pick (not on the programmatic
  // onFeatureTypeChange() calls that run during project load or edit prefill).
  openCollectStep('collectCardGps', true);
}

function updateFeatureTypePickerTrigger(ft){
  document.getElementById('featureTypePickerGlyph').textContent = ftGeometries(ft).map(g=>ftPickerGlyph[g]||'').join('');
  document.getElementById('featureTypePickerLabel').textContent = ft.name;
}


// ══ PER-CAPTURE GEOMETRY ══
// Sets which geometry the capture in progress is building. Refuses a switch that would throw
// away vertices already captured: dropping from polygon to point after five vertices is walked
// is not something to do on a mis-tap, so it asks first. Switching UP (point -> line/polygon)
// is always safe — the vertices are the same list, only reinterpreted, which is the whole
// reason this is cheap: a point capture with four vertices already contains a polygon.
function setCaptureGeometry(geo, silent){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel ? getFeatureType(sel.value) : null;
  if (!ft || !ftAllowsGeometry(ft, geo)) return;
  if (activeGeometryType === geo) return;

  const minFor = g => g==='polygon' ? 3 : g==='line' ? 2 : 1;
  const losing = geo === 'point' && currentVertices.length > 1;
  const apply = () => {
    // onFeatureTypeChange() rebuilds every attribute pane from scratch, which would blank
    // anything already typed for this feature. The values are read out first and put back
    // after — the same collectAttrs/applyAttrValues pair the capture stack uses to park and
    // resume a capture, so a geometry switch can't disagree with what Save would have written.
    const carried = collectAttrs(ft);
    const carriedGroups = JSON.parse(JSON.stringify(repeatGroupState || {}));
    activeGeometryType = geo;
    // Per-vertex fields appear or vanish with the geometry (they collapse to feature-scope on a
    // point), so the panes have to be rebuilt against the new scope resolution.
    // onFeatureTypeChange() does that and ends by calling updateGeometryUI + renderVertexEditor.
    onFeatureTypeChange();
    (ft.fields || []).filter(a => a.type === 'repeat_group').forEach(a => {
      repeatGroupState[a.id] = Array.isArray(carriedGroups[a.id]) ? carriedGroups[a.id].map(i=>({...i})) : [];
      if (typeof rerenderRepeatGroupPane === 'function') rerenderRepeatGroupPane(a.id);
    });
    if (typeof applyAttrValues === 'function') applyAttrValues(ft, carried);
    refreshFieldConditionsAndCalcs();
    renderPoints();
    if (!silent) showToast('Capturing as ' + geo + (currentVertices.length < minFor(geo) ? ` — needs ${minFor(geo)}+ vertices` : ''));
  };
  if (losing && !silent){
    // Nothing is actually deleted by the switch — the extra vertices stay in currentVertices and
    // come back if they switch geometry again before saving. What IS lost is what gets written:
    // a point capture exports one feature per vertex, so the crew should know that is the shape
    // they are choosing rather than discovering it in QGIS.
    showConfirm(`This capture has ${currentVertices.length} vertices. As a point feature each one is saved as its own point rather than a single shape. Continue?`, apply, 'Capture as point');
    return;
  }
  apply();
}

// Reflects the current session geometry onto the Collect pills, and hides the whole control for
// a type that only permits one geometry.
function syncCaptureGeometryUI(ft){
  const field = document.getElementById('collectGeoField');
  if (!field) return;
  const allowed = ftGeometries(ft);
  if (allowed.length < 2){ field.style.display = 'none'; return; }
  field.style.display = '';
  document.querySelectorAll('#collectGeoToggle .geo-opt').forEach(el=>{
    const ok = allowed.includes(el.dataset.geo);
    el.style.display = ok ? '' : 'none';
    el.classList.toggle('sel', ok && el.dataset.geo === activeGeometryType);
  });
  const hint = document.getElementById('collectGeoHint');
  if (hint) hint.textContent = '(this feature only)';
}


function onFeatureTypeChange() {
  const sel = document.getElementById('featureTypeSelect');
  const ft = getFeatureType(sel.value);
  if (!ft) return;
  updateFeatureTypePickerTrigger(ft);
  // Carry the session geometry over if the newly-picked type also permits it (switching between
  // two types that both do polygons shouldn't silently reset to point), otherwise fall to the
  // type's own default.
  if (!ftAllowsGeometry(ft, activeGeometryType)) activeGeometryType = ftDefaultGeometry(ft);
  syncCaptureGeometryUI(ft);
  const geo = activeGeometryType;
  const tag = document.getElementById('geoTag');
  tag.textContent = geo.charAt(0).toUpperCase() + geo.slice(1);
  autofillReferenceId(ft);

  // Scope is resolved against the geometry being captured, not the one declared on the type —
  // a per-vertex field folds back to feature-scope on a point capture. See effectiveFieldScope.
  const featureFields = ft.fields.filter(f => effectiveFieldScope(f, geo) !== 'vertex');
  activeVertexFields = ft.fields.filter(f => effectiveFieldScope(f, geo) === 'vertex');

  const container = document.getElementById('attrFields');
  const noMsg = document.getElementById('noFeatureAttrsMsg');
  const notesField = document.getElementById('notesField');
  // While editing an existing feature of this same type, prefill each field with its saved value
  const prefillAttrs = (editingFeatureId && editingFeatureSnapshot && editingFeatureSnapshot.featureTypeId === ft.id) ? (editingFeatureSnapshot.attrs || {}) : null;
  // Repeating-group entries live in repeatGroupState, not in the DOM (see renderRepeatGroupField's
  // comment) — this has to be populated before featureFields.map(renderAttrField) below builds the
  // panes, since a group's initial instance cards are rendered directly from this state.
  repeatGroupState = {};
  featureFields.filter(a=>a.type==='repeat_group').forEach(a=>{
    const existing = prefillAttrs && Array.isArray(prefillAttrs[a.id]) ? prefillAttrs[a.id] : [];
    repeatGroupState[a.id] = existing.map(inst => ({...inst}));
  });
  if (!featureFields.length) {
    container.innerHTML = '';
    noMsg.style.display = ft.fields.length ? '' : 'none';
    notesField.style.borderTop = 'none';
    notesField.style.marginTop = '0';
    notesField.style.paddingTop = '0';
  } else {
    noMsg.style.display = 'none';
    notesField.style.borderTop = '';
    notesField.style.marginTop = '';
    notesField.style.paddingTop = '';
    // Each field becomes its own pane so the sheet can show one at a time. renderAttrField() is
    // untouched — same markup, same `attr_<id>` ids collectAttrs() reads.
    // Seeding happens here, at the single point where a field's opening value is decided
    // (js/06b-plotseed.js). Anything seeded is marked in the same pass — a value can never be
    // supplied without being marked, because both come from the same call.
    const seeds = {};
    container.innerHTML = featureFields.map(a => {
      const seed = (typeof seedForField === 'function')
        ? seedForField(ft, a, prefillAttrs ? prefillAttrs[a.id] : undefined)
        : { value: prefillAttrs ? prefillAttrs[a.id] : undefined, source: null };
      if (seed.source) seeds[a.id] = seed.source;
      return `<div class="attr-pane" data-fid="${a.id}">${renderAttrField(a, seed.value)}</div>`;
    }).join('');
    // Applied after the innerHTML assignment because the panes do not exist until then.
    Object.keys(seeds).forEach(fid => {
      const pane = container.querySelector(`.attr-pane[data-fid="${fid}"]`);
      if (typeof markPaneSeeded === 'function') markPaneSeeded(pane, seeds[fid]);
    });
  }
  attrSheetFields = featureFields;
  bindAttrFieldsListenerOnce();
  refreshFieldConditionsAndCalcs();
  bindSeedClearOnce();
  if (typeof renderValueSuggestions === 'function') renderValueSuggestions();

  // Ad hoc attributes: when editing an existing feature, pull in anything saved on it that isn't
  // part of this type's schema (and isn't an auto-computed geom_* attr) so it's still editable;
  // for a brand-new capture, start with a clean slate.
  if (editingFeatureId && editingFeatureSnapshot && editingFeatureSnapshot.featureTypeId === ft.id) {
    const schemaIds = new Set(featureFields.map(a=>a.id));
    customFeatureAttrs = {};
    Object.keys(editingFeatureSnapshot.attrs || {}).forEach(k=>{
      if (!schemaIds.has(k) && !k.startsWith('geom_')) customFeatureAttrs[k] = editingFeatureSnapshot.attrs[k];
    });
  } else if (!editingFeatureId) {
    customFeatureAttrs = {};
  }
  renderCustomAttrsList();

  updateGeometryUI(ft);
  renderVertexEditor(); // vertex-scope fields may have changed — refresh the open vertex's editor, if any
}


// Capture/Save button labels, "needs N vertices" hint, and Finish-button gating all depend on geometry type
function updateGeometryUI(ft) {
  // The session geometry, not ft.geometryType: for a multi-geometry type the same feature type
  // can be mid-capture as a point on one feature and a polygon on the next.
  const geo = ftAllowsGeometry(ft, activeGeometryType) ? activeGeometryType : ftDefaultGeometry(ft);
  activeGeometryType = geo;
  syncCaptureGeometryUI(ft);
  const geoWord = geo === 'line' ? 'Line' : geo === 'polygon' ? 'Polygon' : 'Point';
  const min = geo === 'polygon' ? 3 : geo === 'line' ? 2 : 1;
  document.getElementById('captureBtnLabel').textContent = geo === 'point'
    ? 'Capture Point' : `Capture Vertex ${currentVertices.length + 1}`;
  document.getElementById('saveFeatureBtnLabel').textContent = editingFeatureId
    ? 'Save Changes'
    : (geo === 'point' ? 'Save Feature' : `Finish ${geoWord}`);
  // Live length/area preview while capturing — same computeGeometryAttrs() used at save time, so
  // what's shown here always matches what actually gets written to the feature.
  let measureText = '';
  if (geo==='line' && currentVertices.length>=2){
    measureText = ` · ${formatLength(lineLengthM(currentVertices))}`;
  } else if (geo==='polygon' && currentVertices.length>=3){
    measureText = ` · ${formatArea(polygonAreaAndPerimeterM(currentVertices).area)}`;
  }
  document.getElementById('geoMinHint').textContent = geo === 'point' ? '' : `(needs ${min}+ vertices)${measureText}`;
  document.getElementById('saveFeatureBtn').disabled = currentVertices.length < min;
  // Reinforce what Start/End mean geometrically for a polygon once there's enough of a ring
  // forming (2+ vertices) that "closing" it is a meaningful next step.
  document.getElementById('closeRingHint').classList.toggle('show', geo === 'polygon' && currentVertices.length >= 2);
  document.getElementById('swipeHint').style.display = currentVertices.length ? '' : 'none';
  updateCaptureStrip();
  // Whether a capture can be paused turns on whether one is in progress, and this
  // runs on every vertex added or removed — which is exactly when that flips.
  renderCaptureStack();
}


// A seeded value stops being inherited the moment the crew touches it — whether or not the value
// changed. Looking at a carried value and deciding it is right IS confirming it, and demanding an
// edit to clear the mark would push people to change values needlessly.
// Delegated once on the container, so it survives every re-render of the panes.
let _seedClearBound = false;
function bindSeedClearOnce(){
  if (_seedClearBound) return;
  const host = document.getElementById('attrFields');
  if (!host) return;
  ['input','change','click'].forEach(evt => host.addEventListener(evt, e => {
    // The pin is a control ON the field, not an answer to it — pinning must not count as touching.
    if (e.target.closest && e.target.closest('.attr-pin')) return;
    const pane = e.target.closest && e.target.closest('.attr-pane');
    if (pane && pane.dataset.fid && typeof clearSeedMark === 'function') clearSeedMark(pane.dataset.fid);
    // A suggestion row is for an empty box. Leaving it up once the field has an answer turns it
    // into a standing invitation to second-guess a value already given.
    if (typeof renderValueSuggestions === 'function') renderValueSuggestions();
  }, { passive:true }));
  _seedClearBound = true;
}

function renderAttrField(a, val) {
  const req = a.required ? ' <span class="hint">(required)</span>' : ' <span class="hint">(optional)</span>';
  // The pin sits on the label rather than beside the input: it is a statement about the FIELD
  // ("this one is constant for this run"), not about the value currently in it, and putting it in
  // the input row would read as an action on the value. Excluded for repeat groups (no single
  // value to carry) and calculated fields (they fill themselves).
  const _sel0 = document.getElementById('featureTypeSelect');
  const _ftId = _sel0 ? _sel0.value : '';
  const _pin = (typeof pinButtonHtml === 'function' && _ftId && a.type !== 'repeat_group' && a.type !== 'calculated')
    ? pinButtonHtml(_ftId, a.id) : '';
  const label = `<label>${escapeHtml(a.label)}${req}${_pin}</label>`;
  if (a.type === 'single_select') {
    const opts = (a.options||[]).map(o => `<option value="${escapeHtml(o)}" ${val===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="field">${label}<div class="select-wrap"><select id="attr_${a.id}">${opts}</select></div></div>`;
  }
  if (a.type === 'multi_select') {
    const sel = Array.isArray(val) ? val : [];
    const chips = (a.options||[]).map(o => `<div class="chip-opt ${sel.includes(o)?'sel':''}" data-val="${escapeHtml(o)}" onclick="this.classList.toggle('sel')">${escapeHtml(o)}</div>`).join('');
    return `<div class="field"><label>${escapeHtml(a.label)}</label><div class="chip-select" id="attr_${a.id}">${chips}</div></div>`;
  }
  if (a.type === 'boolean') {
    return `<div class="field"><label>${escapeHtml(a.label)}</label><div class="bool-toggle" id="attr_${a.id}" data-val="${val===true?'true':val===false?'false':''}">
      <div class="bool-opt ${val===true?'sel-yes':''}" onclick="setBoolField('${a.id}',true)">Yes</div>
      <div class="bool-opt ${val===false?'sel-no':''}" onclick="setBoolField('${a.id}',false)">No</div>
    </div></div>`;
  }
  if (a.type === 'number') {
    return `<div class="field">${label}<input type="number" id="attr_${a.id}" value="${val!=null?escapeHtml(String(val)):''}" placeholder="${escapeHtml(a.placeholder||'0')}" step="any"></div>`;
  }
  if (a.type === 'date') {
    return `<div class="field">${label}<input type="date" id="attr_${a.id}" value="${escapeHtml(val||'')}"></div>`;
  }
  if (a.type === 'textarea') {
    return `<div class="field">${label}<textarea id="attr_${a.id}" placeholder="${escapeHtml(a.placeholder||'')}">${escapeHtml(val||'')}</textarea></div>`;
  }
  if (a.type === 'barcode') {
    return `<div class="field">${label}<div class="barcode-row"><input type="text" id="attr_${a.id}" value="${escapeHtml(val||'')}" placeholder="${escapeHtml(a.placeholder||'Scan or type a code')}"><button type="button" class="barcode-scan-btn" onclick="openBarcodeScanner('attr_${a.id}')" title="Scan barcode/QR" aria-label="Scan barcode or QR code"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="17" y1="8" x2="17" y2="16"/></svg></button></div></div>`;
  }
  if (a.type === 'calculated') {
    // Never user-typed — recomputed live by refreshFieldConditionsAndCalcs() whenever any field
    // it depends on changes. data-value (not the visible text) is what collectAttrs() actually
    // reads, so the displayed "—" for an unresolved calc never gets mistaken for a literal value.
    return `<div class="field"><label>${escapeHtml(a.label)} <span class="hint">(calculated)</span></label>
      <div class="calc-display" id="attr_${a.id}" data-value=""><span class="calc-display-value">—</span></div></div>`;
  }
  if (a.type === 'repeat_group') {
    return renderRepeatGroupField(a);
  }
  return `<div class="field">${label}<input type="text" id="attr_${a.id}" value="${escapeHtml(val||'')}" placeholder="${escapeHtml(a.placeholder||'')}"></div>`;
}


// ══ REPEATING GROUPS (capture time) ══
// repeatGroupState[groupFieldId] is the live array of entries: [{subfieldId: value, ...}, ...].
// Unlike every other field type, a group's DOM isn't the source of truth read at collect time —
// it can't be, because adding/removing an entry has to rebuild the DOM (new ids for the new row),
// and rebuilding on every keystroke would drop focus mid-type. So typing into a sub-field writes
// straight into this state object; only Add/Remove Entry re-render the group's markup.
let repeatGroupState = {};

function repeatSubfieldDomId(groupId, idx, subId){ return `attr_${groupId}__${idx}__${subId}`; }

function renderRepeatGroupField(a){
  const entries = repeatGroupState[a.id] || (repeatGroupState[a.id] = []);
  const req = a.required ? ' <span class="hint">(at least one entry required)</span>' : ' <span class="hint">(optional)</span>';
  const cards = entries.map((inst, idx) => renderRepeatInstanceCard(a, idx, inst)).join('');
  return `<div class="field">
    <label>${escapeHtml(a.label)}${req}</label>
    <div class="repeat-group" id="attr_${a.id}" data-count="${entries.length}">
      <div class="repeat-instances">${cards || '<div class="hint repeat-empty-hint">No entries yet</div>'}</div>
      <button type="button" class="btn btn-outline repeat-add-btn" onclick="addRepeatInstance('${a.id}')">+ Add entry</button>
    </div>
  </div>`;
}

function renderRepeatInstanceCard(a, idx, inst){
  inst = inst || {};
  const subRows = (a.subfields||[]).map(sub => renderRepeatSubfieldInput(a, idx, sub, inst[sub.id])).join('');
  return `<div class="repeat-instance-card" data-idx="${idx}">
    <div class="repeat-instance-head">
      <span class="repeat-instance-num">Entry ${idx+1}</span>
      <button type="button" class="repeat-remove-btn" onclick="removeRepeatInstance('${a.id}',${idx})" aria-label="Remove this entry">✕</button>
    </div>
    ${subRows}
  </div>`;
}

// A trimmed cousin of renderAttrField for the restricted sub-field type set (REPEAT_SUBFIELD_TYPES
// in js/02-state.js) — writes directly into repeatGroupState rather than leaving the DOM as the
// value's home, per the comment above renderRepeatGroupField.
function renderRepeatSubfieldInput(a, idx, sub, val){
  const domId = repeatSubfieldDomId(a.id, idx, sub.id);
  const label = `<label>${escapeHtml(sub.label)}${sub.required?' <span class="hint">(required)</span>':''}</label>`;
  if (sub.type === 'single_select'){
    const opts = (sub.options||[]).map(o=>`<option value="${escapeHtml(o)}" ${val===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="field">${label}<div class="select-wrap"><select id="${domId}" onchange="updateRepeatSubfieldValue('${a.id}',${idx},'${sub.id}',this.value)"><option value=""></option>${opts}</select></div></div>`;
  }
  if (sub.type === 'multi_select'){
    const sel = Array.isArray(val) ? val : [];
    const chips = (sub.options||[]).map(o=>`<div class="chip-opt ${sel.includes(o)?'sel':''}" data-val="${escapeHtml(o)}" onclick="toggleRepeatChip(this,'${a.id}',${idx},'${sub.id}')">${escapeHtml(o)}</div>`).join('');
    return `<div class="field">${label}<div class="chip-select" id="${domId}">${chips}</div></div>`;
  }
  if (sub.type === 'boolean'){
    return `<div class="field">${label}<div class="bool-toggle" id="${domId}" data-val="${val===true?'true':val===false?'false':''}">
      <div class="bool-opt ${val===true?'sel-yes':''}" onclick="setRepeatBoolField('${a.id}',${idx},'${sub.id}',true)">Yes</div>
      <div class="bool-opt ${val===false?'sel-no':''}" onclick="setRepeatBoolField('${a.id}',${idx},'${sub.id}',false)">No</div>
    </div></div>`;
  }
  if (sub.type === 'number'){
    return `<div class="field">${label}<input type="number" id="${domId}" value="${val!=null?escapeHtml(String(val)):''}" placeholder="${escapeHtml(sub.placeholder||'0')}" step="any" oninput="updateRepeatSubfieldValue('${a.id}',${idx},'${sub.id}',this.value)"></div>`;
  }
  if (sub.type === 'date'){
    return `<div class="field">${label}<input type="date" id="${domId}" value="${escapeHtml(val||'')}" onchange="updateRepeatSubfieldValue('${a.id}',${idx},'${sub.id}',this.value)"></div>`;
  }
  if (sub.type === 'textarea'){
    return `<div class="field">${label}<textarea id="${domId}" placeholder="${escapeHtml(sub.placeholder||'')}" oninput="updateRepeatSubfieldValue('${a.id}',${idx},'${sub.id}',this.value)">${escapeHtml(val||'')}</textarea></div>`;
  }
  return `<div class="field">${label}<input type="text" id="${domId}" value="${escapeHtml(val||'')}" placeholder="${escapeHtml(sub.placeholder||'')}" oninput="updateRepeatSubfieldValue('${a.id}',${idx},'${sub.id}',this.value)"></div>`;
}

function updateRepeatSubfieldValue(groupId, idx, subId, value){
  const entries = repeatGroupState[groupId];
  if (!entries || !entries[idx]) return;
  entries[idx][subId] = value;
  refreshFieldConditionsAndCalcs(); // a calculated top-level field can't reference into a group, but this keeps the summary/required-state in step regardless of what changed
}

function setRepeatBoolField(groupId, idx, subId, val){
  const entries = repeatGroupState[groupId];
  if (!entries || !entries[idx]) return;
  entries[idx][subId] = val;
  const wrap = document.getElementById(repeatSubfieldDomId(groupId, idx, subId));
  if (wrap){
    wrap.dataset.val = String(val);
    wrap.querySelectorAll('.bool-opt').forEach((el,i)=>{
      el.classList.remove('sel-yes','sel-no');
      if ((i===0 && val===true) || (i===1 && val===false)) el.classList.add(val ? 'sel-yes' : 'sel-no');
    });
  }
  refreshFieldConditionsAndCalcs();
}

function toggleRepeatChip(el, groupId, idx, subId){
  el.classList.toggle('sel');
  const wrap = document.getElementById(repeatSubfieldDomId(groupId, idx, subId));
  const entries = repeatGroupState[groupId];
  if (wrap && entries && entries[idx]) entries[idx][subId] = [...wrap.querySelectorAll('.chip-opt.sel')].map(c=>c.dataset.val);
  refreshFieldConditionsAndCalcs();
}

function addRepeatInstance(groupId){
  const entries = repeatGroupState[groupId] || (repeatGroupState[groupId] = []);
  entries.push({});
  rerenderRepeatGroupPane(groupId);
}

function removeRepeatInstance(groupId, idx){
  const entries = repeatGroupState[groupId];
  if (!entries) return;
  entries.splice(idx,1);
  rerenderRepeatGroupPane(groupId);
}

function rerenderRepeatGroupPane(groupId){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel && getFeatureType(sel.value);
  const a = ft && ft.fields.find(f=>f.id===groupId);
  const pane = document.querySelector(`#attrFields .attr-pane[data-fid="${groupId}"]`);
  if (!a || !pane) return;
  pane.innerHTML = renderRepeatGroupField(a);
  refreshFieldConditionsAndCalcs();
}


function setBoolField(id, val) {
  const wrap = document.getElementById('attr_' + id);
  wrap.dataset.val = String(val);
  wrap.querySelectorAll('.bool-opt').forEach((el,i)=>{
    el.classList.remove('sel-yes','sel-no');
    if ((i===0 && val===true) || (i===1 && val===false)) el.classList.add(val ? 'sel-yes' : 'sel-no');
  });
}


// ══ SKIP LOGIC + CALCULATED FIELDS ══
// A field's `condition` (set in the feature-type editor, js/03-schema.js) says "only show this
// field once another, earlier field matches something" — that's the skip logic. A field of type
// 'calculated' has an `expression` referencing other fields as {field_id} and is never typed into
// directly. Both are re-evaluated together, live, on every input inside #attrFields.

// Which feature-scope field ids are currently hidden by an unmet condition. Read by
// renderAttrSummary, attrSheetNav and collectAttrs so all three agree on what's "in the form" —
// attrSheetFields itself stays the full, stable list (matching the DOM panes 1:1) rather than
// being filtered, so pane indices never shift out from under attrSheetNav/openAttrSheet.
let hiddenAttrIds = new Set();

// Reads every feature-scope field's live value out of the DOM into a plain {fieldId: value} map.
// Single source both fieldConditionMet() and evalFieldExpression() read from, so a condition and a
// calculation checking the same field can never disagree about what its current value is.
function currentFeatureFieldValues(ft){
  const vals = {};
  (ft.fields||[]).filter(a=>effectiveFieldScope(a, currentCaptureGeometry())!=='vertex').forEach(a=>{
    const el = document.getElementById('attr_'+a.id);
    if (!el) return;
    if (a.type==='calculated'){ const dv = el.dataset.value; vals[a.id] = (dv===undefined||dv==='') ? null : Number(dv); return; }
    if (a.type==='repeat_group'){ vals[a.id] = repeatGroupState[a.id] || []; return; }
    if (a.type==='boolean'){ vals[a.id] = el.dataset.val==='true' ? true : el.dataset.val==='false' ? false : null; return; }
    if (a.type==='multi_select'){ vals[a.id] = [...el.querySelectorAll('.chip-opt.sel')].map(c=>c.dataset.val); return; }
    if (a.type==='number'){ vals[a.id] = el.value===''? null : Number(el.value); return; }
    vals[a.id] = el.value;
  });
  return vals;
}

function fieldConditionMet(a, vals){
  const c = a.condition;
  if (!c || !c.fieldId) return true;
  const v = vals[c.fieldId];
  const isEmpty = v==null || v==='' || (Array.isArray(v) && !v.length);
  switch (c.op){
    case 'set':     return !isEmpty;
    case 'not_set': return isEmpty;
    case 'neq':     return Array.isArray(v) ? !v.includes(c.value) : String(v??'') !== String(c.value);
    case 'eq':
    default:        return Array.isArray(v) ? v.includes(c.value) : String(v??'') === String(c.value);
  }
}

// Arithmetic-only evaluator for calculated-field expressions (+ - * / and parentheses over
// {field_id} references and number literals). Deliberately hand-written rather than eval() or
// `new Function()` — an expression here is schema config a project admin typed in, and running
// arbitrary JS over that just to add two numbers together is a needless risk even on a local-only
// app. Returns null (rendered as "—") if the expression is malformed, divides by zero, or any
// field it references is currently blank/non-numeric — a wrong silent number would be worse than
// an honest blank in captured field data.
function evalFieldExpression(expr, vals){
  if (!expr) return null;
  let missing = false;
  const sub = expr.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, id) => {
    const v = vals[id];
    if (v==null || v==='' || Number.isNaN(Number(v))) { missing = true; return '0'; }
    return String(Number(v));
  });
  if (missing) return null;
  if (!/^[0-9+\-*/().\s]+$/.test(sub)) return null; // anything else means a bad expression, not a formula we evaluate
  let i = 0;
  const num = () => { let s=''; while (/[0-9.]/.test(sub[i]||'')) s+=sub[i++]; return s===''? NaN : parseFloat(s); };
  const factor = () => {
    while (sub[i]===' ') i++;
    if (sub[i]==='('){ i++; const v=addsub(); while (sub[i]===' ') i++; if (sub[i]===')') i++; return v; }
    if (sub[i]==='-'){ i++; const v=factor(); return v==null ? null : -v; }
    return num();
  };
  const muldiv = () => {
    let v = factor();
    if (v==null || Number.isNaN(v)) return null;
    while (true){
      while (sub[i]===' ') i++;
      if (sub[i]==='*'){ i++; const r=factor(); if (r==null||Number.isNaN(r)) return null; v*=r; }
      else if (sub[i]==='/'){ i++; const r=factor(); if (r==null||Number.isNaN(r)||r===0) return null; v/=r; }
      else break;
    }
    return v;
  };
  const addsub = () => {
    let v = muldiv();
    if (v==null) return null;
    while (true){
      while (sub[i]===' ') i++;
      if (sub[i]==='+'){ i++; const r=muldiv(); if (r==null) return null; v+=r; }
      else if (sub[i]==='-'){ i++; const r=muldiv(); if (r==null) return null; v-=r; }
      else break;
    }
    return v;
  };
  try {
    const result = addsub();
    return (result==null || Number.isNaN(result) || !Number.isFinite(result)) ? null : result;
  } catch(e){ return null; }
}

function formatCalcResult(n){
  // Trims float noise (e.g. 12.000000001) without hard-coding a fixed decimal count that would be
  // wrong for both "count of something" and "a computed area" fields.
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

let attrFieldsListenerBound = false;

// Re-evaluates every feature-scope field's condition and every calculated field's expression, and
// updates the DOM to match. Called once after the form is built (onFeatureTypeChange) and again on
// every input inside #attrFields via a single delegated listener — bound once, not per-render, so
// switching feature type repeatedly never stacks up duplicate listeners.
function refreshFieldConditionsAndCalcs(){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel && getFeatureType(sel.value);
  if (!ft) return;
  const featureFields = ft.fields.filter(f=>effectiveFieldScope(f, currentCaptureGeometry())!=='vertex');
  if (!featureFields.length) return;
  const vals = currentFeatureFieldValues(ft);
  hiddenAttrIds = new Set();
  featureFields.forEach(a=>{
    const visible = fieldConditionMet(a, vals);
    if (!visible) hiddenAttrIds.add(a.id);
    if (a.type === 'calculated'){
      const el = document.getElementById('attr_'+a.id);
      if (el){
        const result = visible ? evalFieldExpression(a.expression, vals) : null;
        el.dataset.value = result==null ? '' : String(result);
        const disp = el.querySelector('.calc-display-value');
        if (disp) disp.textContent = result==null ? '—' : formatCalcResult(result);
      }
    }
  });
  // If the pane currently open in the stepper just became hidden (its own condition's dependency
  // changed while it was on screen), step off it rather than leave an unreachable pane active.
  if (attrSheetFields[attrSheetIdx] && hiddenAttrIds.has(attrSheetFields[attrSheetIdx].id)) attrSheetNav(1);
  renderAttrSummary();
}

function bindAttrFieldsListenerOnce(){
  if (attrFieldsListenerBound) return;
  attrFieldsListenerBound = true;
  const container = document.getElementById('attrFields');
  if (!container) return;
  container.addEventListener('input', refreshFieldConditionsAndCalcs);
  container.addEventListener('change', refreshFieldConditionsAndCalcs);
  // The boolean and multi-select controls are div/button-based (see renderAttrField), not real
  // <input>s, so they don't fire native input/change events — their own onclick handlers
  // (setBoolField, the inline chip-opt toggle) run first, then this catches the aftermath.
  container.addEventListener('click', ev => {
    if (ev.target.closest('.bool-opt, .chip-opt')) setTimeout(refreshFieldConditionsAndCalcs, 0);
  });
}


// Feature-wide attrs only (scope!=='vertex') — gathered once at Save time, same as the original single-point flow
// ══ ATTRIBUTE SUMMARY + SHEET ══
// attrSheetFields mirrors the feature-scoped fields currently rendered into #attrFields.
let attrSheetFields = [], attrSheetIdx = 0;


// Reads the live input for a field and returns a display string. Deliberately reads the DOM
// rather than a parallel state object: the inputs are the single source of truth here (that's
// what collectAttrs does at save), so a preview built from anything else could disagree with
// what actually gets saved.
function attrValuePreview(a){
  const el = document.getElementById('attr_' + a.id);
  if (!el) return '';
  if (a.type === 'boolean'){
    const v = el.dataset.val;
    return v === 'true' ? 'Yes' : v === 'false' ? 'No' : '';
  }
  if (a.type === 'multi_select'){
    // .chip-opt, not .chip — renderAttrField emits `<div class="chip-opt sel">`. The wrong
    // selector matched nothing, so every multi-select summary read as empty no matter what was
    // ticked, and the required-but-empty highlight fired on fields that were actually filled.
    return [...el.querySelectorAll('.chip-opt.sel')].map(c=>c.textContent.trim()).join(', ');
  }
  if (a.type === 'calculated'){
    return el.dataset.value ? formatCalcResult(Number(el.dataset.value)) : '';
  }
  if (a.type === 'repeat_group'){
    const n = (repeatGroupState[a.id]||[]).length;
    return n ? `${n} ${n===1?'entry':'entries'}` : '';
  }
  return (el.value || '').trim();
}


function renderAttrSummary(){
  const el = document.getElementById('attrSummary');
  if (!el) return;
  el.innerHTML = attrSheetFields.map((a,i) => ({a,i}))
    .filter(({a}) => !hiddenAttrIds.has(a.id))
    .map(({a,i}) => {
      const v = attrValuePreview(a);
      const empty = !v;
      return `<div class="attr-sum-row${a.required && empty ? ' needs-value' : ''}" role="button" tabindex="0" onclick="openAttrSheet(${i})">
        <div class="attr-sum-body">
          <div class="attr-sum-label">${escapeHtml(a.label)}${a.required?'<span class="sum-pill req">REQUIRED</span>':''}</div>
          <div class="attr-sum-val${empty?' is-empty':''}">${empty ? (a.placeholder ? escapeHtml(a.placeholder) : 'Not set') : escapeHtml(v)}</div>
        </div>
        <span class="attr-sum-chev"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
      </div>`;
    }).join('');
}


function openAttrSheet(idx){
  if (!attrSheetFields.length) return;
  attrSheetIdx = Math.max(0, Math.min(idx, attrSheetFields.length - 1));
  showAttrPane();
  document.getElementById('attrSheet').classList.add('show');
  // No pushNavState here. Overlays in this app are not history stops — closeTopOverlay() handles
  // Back for them and returns without popping, so a pushed state would never be consumed and the
  // next Back press would silently burn it instead of navigating.
}

function showAttrPane(){
  const a = attrSheetFields[attrSheetIdx];
  if (!a) return;
  document.querySelectorAll('#attrFields .attr-pane').forEach(p =>
    p.classList.toggle('active', p.dataset.fid === a.id));
  document.getElementById('attrSheetTitle').textContent = a.label || 'Attribute';
  document.getElementById('attrSheetStep').textContent =
    'FIELD ' + (attrSheetIdx + 1) + ' OF ' + attrSheetFields.length;
  document.getElementById('attrSheetPrev').disabled = attrSheetIdx === 0;
  const next = document.getElementById('attrSheetNext');
  // On the last field Next becomes the way out, so the whole schema can be filled in one pass
  // without reaching for Done — the common case is stepping straight through.
  next.textContent = attrSheetIdx === attrSheetFields.length - 1 ? 'Finish' : 'Next';
  const input = document.querySelector('#attrFields .attr-pane.active input, #attrFields .attr-pane.active textarea');
  if (input) focusWhenSettled(input);
}

function attrSheetNav(delta){
  let target = attrSheetIdx + delta;
  while (target >= 0 && target < attrSheetFields.length && hiddenAttrIds.has(attrSheetFields[target].id)) {
    target += delta;
  }
  if (target < 0) return;
  if (target >= attrSheetFields.length){ closeAttrSheet(); return; }
  attrSheetIdx = target;
  showAttrPane();
  renderAttrSummary();
}

function closeAttrSheet(){
  document.getElementById('attrSheet').classList.remove('show');
  renderAttrSummary();
  // Step 3's badge keys off "any attribute non-empty", which can only have changed here.
  // (updateStepBadges never existed — the guard meant the badge simply never refreshed.)
  if (typeof updateCollectStepStatus === 'function') updateCollectStepStatus();
}


function collectAttrs(ft) {
  const attrs = {};
  if (!ft) return attrs;
  ft.fields.filter(a => effectiveFieldScope(a, currentCaptureGeometry()) !== 'vertex').forEach(a => {
    // A field hidden by unmet skip-logic never had a chance to be answered — persisting whatever
    // was typed into it before its condition flipped would save an answer to a question the form
    // never actually asked this time.
    if (hiddenAttrIds.has(a.id)) return;
    const el = document.getElementById('attr_' + a.id);
    if (!el) return;
    if (a.type === 'calculated') {
      attrs[a.id] = (el.dataset.value === '' || el.dataset.value === undefined) ? null : Number(el.dataset.value);
    } else if (a.type === 'repeat_group') {
      // Drop entries the crew added but left entirely blank — the Add-entry button has no
      // "cancel" of its own, so an accidental tap plus a change of mind shouldn't save a junk row.
      attrs[a.id] = (repeatGroupState[a.id]||[]).filter(inst =>
        Object.values(inst).some(v => v!=null && v!=='' && !(Array.isArray(v)&&!v.length))
      ).map(inst => ({...inst}));
    } else if (a.type === 'multi_select') {
      attrs[a.id] = Array.from(el.querySelectorAll('.chip-opt.sel')).map(c => c.dataset.val);
    } else if (a.type === 'boolean') {
      attrs[a.id] = el.dataset.val === 'true' ? true : el.dataset.val === 'false' ? false : null;
    } else {
      attrs[a.id] = el.value;
    }
  });
  Object.assign(attrs, customFeatureAttrs);
  return attrs;
}


// ══ AD HOC ATTRIBUTES ══ — lets a field crew tack on an attribute this feature type's schema
// doesn't define, without stopping to edit the schema. Kept in a separate runtime object rather
// than injected into ft.fields, so it never touches the shared schema other features rely on;
// it's just merged into this one feature's attrs on save (see collectAttrs above).
let customFeatureAttrs = {};

function renderCustomAttrsList(){
  const wrap = document.getElementById('customAttrsList');
  if (!wrap) return;
  const keys = Object.keys(customFeatureAttrs);
  wrap.innerHTML = keys.map(k => `<div class="field">
    <label>${escapeHtml(k)} <span class="hint">(added on the go)</span></label>
    <div style="display:flex;gap:8px;">
      <input type="text" value="${escapeHtml(customFeatureAttrs[k])}" oninput="setCustomAttr('${k.replace(/'/g,"\\'")}', this.value)" style="flex:1;">
      <button type="button" class="feat-del" onclick="removeCustomAttr('${k.replace(/'/g,"\\'")}')" title="Remove attribute" style="flex-shrink:0;">✕</button>
    </div>
  </div>`).join('');
}

function setCustomAttr(key, value){ customFeatureAttrs[key] = value; }

function removeCustomAttr(key){ delete customFeatureAttrs[key]; renderCustomAttrsList(); }

function promptAddCustomAttr(){
  const name = (prompt('Attribute name (e.g. "Condition")') || '').trim();
  if (!name) return;
  if (name.toLowerCase().startsWith('geom_')) { showToast('That name is reserved for auto-computed geometry attributes'); return; }
  const value = (prompt(`Value for "${name}"`) || '').trim();
  customFeatureAttrs[name] = value;
  renderCustomAttrsList();
}


// ══ VERTEX-SCOPE ATTRS (per captured vertex — written live as the user fills the Vertex Details card) ══
function setVertexAttr(vIdx, fieldId, value) {
  if (!currentVertices[vIdx]) return;
  currentVertices[vIdx].attrs = currentVertices[vIdx].attrs || {};
  currentVertices[vIdx].attrs[fieldId] = value;
  persist();
}

function setVertexBoolField(vIdx, fieldId, val) {
  const wrap = document.getElementById(`vattr_${vIdx}_${fieldId}`);
  if (wrap) {
    wrap.dataset.val = String(val);
    wrap.querySelectorAll('.bool-opt').forEach((el,i)=>{
      el.classList.remove('sel-yes','sel-no');
      if ((i===0 && val===true) || (i===1 && val===false)) el.classList.add(val ? 'sel-yes' : 'sel-no');
    });
  }
  setVertexAttr(vIdx, fieldId, val);
}

function toggleVertexMultiChip(vIdx, fieldId, el) {
  el.classList.toggle('sel');
  const wrap = document.getElementById(`vattr_${vIdx}_${fieldId}`);
  const vals = Array.from(wrap.querySelectorAll('.chip-opt.sel')).map(c => c.dataset.val);
  setVertexAttr(vIdx, fieldId, vals);
}

function renderVertexAttrField(a, vIdx, val) {
  const req = a.required ? ' <span class="hint">(required)</span>' : ' <span class="hint">(optional)</span>';
  const label = `<label>${escapeHtml(a.label)}${req}</label>`;
  const id = `vattr_${vIdx}_${a.id}`;
  if (a.type === 'single_select') {
    const opts = (a.options||[]).map(o => `<option value="${escapeHtml(o)}" ${val===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="field">${label}<div class="select-wrap"><select id="${id}" onchange="setVertexAttr(${vIdx},'${a.id}',this.value)">${opts}</select></div></div>`;
  }
  if (a.type === 'multi_select') {
    const sel = Array.isArray(val) ? val : [];
    const chips = (a.options||[]).map(o => `<div class="chip-opt ${sel.includes(o)?'sel':''}" data-val="${escapeHtml(o)}" onclick="toggleVertexMultiChip(${vIdx},'${a.id}',this)">${escapeHtml(o)}</div>`).join('');
    return `<div class="field">${label}<div class="chip-select" id="${id}">${chips}</div></div>`;
  }
  if (a.type === 'boolean') {
    return `<div class="field">${label}<div class="bool-toggle" id="${id}" data-val="${val===true?'true':val===false?'false':''}">
      <div class="bool-opt ${val===true?'sel-yes':''}" onclick="setVertexBoolField(${vIdx},'${a.id}',true)">Yes</div>
      <div class="bool-opt ${val===false?'sel-no':''}" onclick="setVertexBoolField(${vIdx},'${a.id}',false)">No</div>
    </div></div>`;
  }
  if (a.type === 'number') {
    return `<div class="field">${label}<input type="number" id="${id}" value="${val!=null?escapeHtml(String(val)):''}" placeholder="${escapeHtml(a.placeholder||'0')}" step="any" oninput="setVertexAttr(${vIdx},'${a.id}',this.value)"></div>`;
  }
  if (a.type === 'date') {
    return `<div class="field">${label}<input type="date" id="${id}" value="${escapeHtml(val||'')}" onchange="setVertexAttr(${vIdx},'${a.id}',this.value)"></div>`;
  }
  if (a.type === 'textarea') {
    return `<div class="field">${label}<textarea id="${id}" placeholder="${escapeHtml(a.placeholder||'')}" oninput="setVertexAttr(${vIdx},'${a.id}',this.value)">${escapeHtml(val||'')}</textarea></div>`;
  }
  if (a.type === 'barcode') {
    return `<div class="field">${label}<div class="barcode-row"><input type="text" id="${id}" value="${escapeHtml(val||'')}" placeholder="${escapeHtml(a.placeholder||'Scan or type a code')}" oninput="setVertexAttr(${vIdx},'${a.id}',this.value)"><button type="button" class="barcode-scan-btn" onclick="openBarcodeScanner('${id}')" title="Scan barcode/QR" aria-label="Scan barcode or QR code"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="17" y1="8" x2="17" y2="16"/></svg></button></div></div>`;
  }
  return `<div class="field">${label}<input type="text" id="${id}" value="${escapeHtml(val||'')}" placeholder="${escapeHtml(a.placeholder||'')}" oninput="setVertexAttr(${vIdx},'${a.id}',this.value)"></div>`;
}


// ══ BARCODE / QR SCANNER ══ — uses the browser's built-in BarcodeDetector (Chrome/Edge/Android,
// no library, no network call). On browsers without it (Safari/iOS as of this writing) the scan
// button just tells the person to type the code instead — the field itself is a normal text input
// either way, so nothing is ever blocked on scanning working.
let barcodeScanStream = null;

let barcodeScanTargetId = null;

let barcodeScanRAF = null;

async function openBarcodeScanner(targetInputId) {
  if (!('BarcodeDetector' in window)) {
    showToast('Barcode scanning isn\'t supported on this browser — you can still type the code in');
    return;
  }
  barcodeScanTargetId = targetInputId;
  const overlay = document.getElementById('barcodeScannerOverlay');
  const video = document.getElementById('barcodeScannerVideo');
  const hint = document.getElementById('barcodeScannerHint');
  try {
    barcodeScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    showToast('Camera access denied or unavailable');
    return;
  }
  video.srcObject = barcodeScanStream;
  overlay.classList.add('show');
  hint.textContent = 'Line the code up inside the frame';
  let detector;
  try {
    detector = new BarcodeDetector();
  } catch (e) {
    showToast('Barcode scanning isn\'t supported on this browser — you can still type the code in');
    closeBarcodeScanner();
    return;
  }
  const scanLoop = async () => {
    if (!barcodeScanStream) return; // closed mid-loop
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) {
        const value = codes[0].rawValue;
        const input = document.getElementById(barcodeScanTargetId);
        if (input) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        showToast('Scanned: ' + value);
        closeBarcodeScanner();
        return;
      }
    } catch (e) { /* keep trying — a stray decode error shouldn't kill the loop */ }
    barcodeScanRAF = requestAnimationFrame(scanLoop);
  };
  barcodeScanRAF = requestAnimationFrame(scanLoop);
}

function closeBarcodeScanner() {
  if (barcodeScanRAF) cancelAnimationFrame(barcodeScanRAF);
  barcodeScanRAF = null;
  if (barcodeScanStream) { barcodeScanStream.getTracks().forEach(t => t.stop()); barcodeScanStream = null; }
  document.getElementById('barcodeScannerOverlay').classList.remove('show');
  barcodeScanTargetId = null;
}


// ══ TABS (within a project) ══
function toggleCard(id){
  const card = document.getElementById(id);
  if(!card) return;
  card.classList.toggle('collapsed');
}

// Moves the single shared #reviewMap Leaflet instance between the Dashboard preview slot and its
// home position on the Review tab, rather than standing up a second map (and downloading a second
// set of tiles) for the dashboard — this app is built to work offline on field data plans, so a
// duplicate map would be a real cost for what's meant to be a lightweight "here's your coverage"
// glance. invalidateSize() is required after the move: Leaflet lays tiles out for the container
// size at the moment it becomes visible, and the dashboard/review slots are different heights.
function dockReviewMap(destination){
  const wrap = document.getElementById('reviewMapWrap');
  const dashSlot = document.getElementById('dashMapSlot');
  const anchor = document.getElementById('reviewMapAnchor');
  if (!wrap || !dashSlot || !anchor) return;
  if (destination === 'dashboard') {
    dashSlot.appendChild(wrap);
    wrap.classList.add('dash-preview');
  } else if (destination === 'review') {
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    wrap.classList.remove('dash-preview');
  } else {
    return;
  }
  setTimeout(() => { if (reviewMap) reviewMap.invalidateSize(); }, 60);
}

// ══ COLLECT DATA-ENTRY CHROME ══
// The bottom nav bar (and the ~56-64dp it occupies) is only useful while browsing between tabs —
// on Collect it's just something to accidentally hit while filling out the form or tapping
// Capture Point. enterCollectDataEntry() slides it out of view (see the .collect-nav-hidden CSS
// above .bottom-nav) and now runs for the whole Collect tab (switchTab() calls it on entry, not
// just on field focus); exitCollectDataEntry() brings it back the moment another tab is opened.
// The header's existing ← Back button (headerBackTap → switchTabNav) keeps working throughout
// since it lives above the fold, not in the bottom bar.
let collectDataEntryActive = false;

function enterCollectDataEntry(){
  if (collectDataEntryActive) return;
  const collectPanel = document.getElementById('panel-collect');
  if (!collectPanel || !collectPanel.classList.contains('active')) return;
  collectDataEntryActive = true;
  document.body.classList.add('collect-nav-hidden');
}

function exitCollectDataEntry(){
  if (!collectDataEntryActive) return;
  collectDataEntryActive = false;
  document.body.classList.remove('collect-nav-hidden');
}

// Delegated rather than bound to individual fields, so newly-rendered inputs (attribute fields,
// custom attrs, vertex editor fields) pick this up automatically with no extra wiring.
(function(){
  const collectPanel = document.getElementById('panel-collect');
  if (!collectPanel) return;
  collectPanel.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea, select')) enterCollectDataEntry();
  });
})();


// ══ THE SLIDING INDICATOR ══
// Moves the one shared #navPill element to sit behind the active tab. Measured rather than
// computed from a tab count, because the bar's tabs are not all the same width once labels are
// translated or the device font scale is turned up — a hardcoded 1/5 would drift off the button.
//
// The spring is a CSS cubic-bezier with a slight overshoot rather than a physics simulation. A
// real spring (stiffness 400 / damping 35) settles in about 300ms with a small overshoot, and
// that curve reproduces the felt result closely enough that nobody could pick them apart on a
// 60px travel — without a rAF loop running on every tab change on a low-end phone.
function positionNavPill(name){
  const pill = document.getElementById('navPill');
  const btn = document.getElementById('navBtn-' + name);
  const bar = document.getElementById('bottomNav');
  if (!pill || !btn || !bar) return;

  const b = btn.getBoundingClientRect();
  const r = bar.getBoundingClientRect();
  if (!b.width) return; // the bar is hidden — measuring now would park the pill at zero

  // Inset so the indicator reads as a highlight behind the tab rather than a button around it.
  const insetX = 6, insetY = 5;
  pill.style.width  = (b.width - insetX * 2) + 'px';
  pill.style.height = (b.height - insetY * 2) + 'px';
  pill.style.transform = `translate3d(${b.left - r.left + insetX}px, ${b.top - r.top + insetY}px, 0)`;

  // First positioning happens with transitions suppressed, or the pill flies in from the corner
  // on the very first paint — an animation of a state the user never saw.
  if (!pill.dataset.ready){
    pill.style.transition = 'none';
    void pill.offsetWidth;              // flush, so the next frame has a real starting point
    pill.style.transition = '';
    pill.dataset.ready = '1';
    pill.classList.add('show');
  }
}

// The bar's geometry changes without any tab change: rotation, the keyboard resizing the
// viewport, or a font-scale change. Re-measured rather than assumed, since a stale position
// leaves the indicator behind the wrong tab.
window.addEventListener('resize', () => {
  const active = document.querySelector('.nav-btn.active');
  if (active) positionNavPill(active.id.replace('navBtn-', ''));
}, { passive:true });

function switchTab(name) {
  // Recorded here rather than in switchTabNav(), so it stays correct even when
  // a tab is entered programmatically. See noteCurrentTab().
  noteCurrentTab(name);
  // ══ AMBIENT INTENSITY ══ Collect is the data-entry screen (inputs must stay sharp in sun);
  // Review is the map canvas (no tint over satellite tiles at all); everything else is ambient.
  // Shared with activateView('view-app') so entering a project and switching tabs inside it can
  // never disagree about which band applies.
  switchTabScreenState(name);
  if (name !== 'collect') exitCollectDataEntry();
  const tabs = ['dashboard','collect','review','import','export'];
  document.querySelectorAll('.nav-btn[id^="navBtn-"]').forEach(b=>b.classList.toggle('active', b.id==='navBtn-'+name));
  positionNavPill(name);
  // Per-project controls, refreshed on entry. At boot would be wrong: opening a second project
  // would leave the first one's coordinate system and accuracy standard on screen.
  if (name === 'export' && typeof syncCrsUI === 'function') syncCrsUI();
  if (name === 'collect'){
    if (typeof plotfixSyncUI === 'function') plotfixSyncUI();
    if (typeof applyFixGateToCaptureButton === 'function') applyFixGateToCaptureButton();
  }
  // A first-open explainer belongs to the module that raised it. Switching tabs abandons that
  // module without necessarily running its close function, and the strip is fixed to the viewport
  // rather than to the module — so it is cleared here, centrally, rather than relying on every
  // exit path remembering.
  if (typeof plotwordsDismissAll === 'function') plotwordsDismissAll();
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id==='panel-'+name));
  // Collect is a full-screen capture workflow — the bottom nav bar should stay out of the way for
  // the whole tab, not just once a field is focused. enterCollectDataEntry() is idempotent (it
  // no-ops if already active), so calling it here on every entry is safe; the focusin listener
  // further down still covers it defensively in case switchTab() is ever bypassed.
  // renderCaptureStack() on entry rather than only when the stack changes: the
  // "Pause" button's visibility depends on whether anything is in progress, and
  // that can change from the Review tab (starting an edit) as well as from here.
  if (name === 'collect') { enterCollectDataEntry(); resetCollectAccordion(); renderCaptureStack(); }
  if (name==='review'||name==='export'||name==='dashboard') updateStats();
  // syncPlotLensEntry() here rather than only on boot: the toggle can be flipped in Settings at
  // any time, and Review is the tab that hosts the entry point.
  if (name==='review') { dockReviewMap('review'); renderReviewMap(); syncPlotLensEntry(); }
  if (name==='dashboard') { dockReviewMap('dashboard'); renderReviewMap(); }
  if (name==='export') refreshExportMeta();
  // Field workflow: a GPS fix takes a few seconds to settle, so start acquiring the moment Collect
  // opens rather than waiting for a manual "Start GPS" tap — by the time the feature type/name are
  // filled in, accuracy is usually already good enough to capture. Only kicks in with a feature
  // type to collect against, and never fights an already-connected external GPS receiver.
  if (name==='collect' && !gpsActive && !extGpsActive && featureTypes.length && navigator.geolocation) startGPS();
  updateCaptureStrip();
  if (activeProjectId) saveLastSession(name);
  updateCaptureFabVisibility();
}
