// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Capture stack: pause one feature, collect another, come back
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ WHY ══
// The Collect tab has only ever held ONE capture in progress. That is fine until
// the walk itself interrupts you, which on a real survey it always does: you are
// 300m into a road centreline, you reach a traffic sign, and the sign is a point
// feature of a different type with its own attributes and its own photo.
//
// Before this file there were three ways through that, and all three were bad:
//   - Finish the road early and start a second road afterwards, leaving a seam
//     in the geometry and two records where the ground has one.
//   - Switch the feature type mid-capture. onFeatureTypeChange() rebuilds the
//     attribute panes but deliberately does NOT touch currentVertices, so the
//     road's vertices silently become the sign's vertices.
//   - Walk past the sign and come back for it later, which is the option crews
//     actually take, and is why signs go missing.
//
// So: a capture can now be SUSPENDED. Its entire state — vertices, per-vertex
// photos and attributes, the form fields, the repeating groups, the ad hoc
// attributes, edit mode if it was an edit — is lifted off the screen in one
// piece and parked. The form comes back blank for the interruption. Finishing
// the interruption offers the parked capture straight back.
//
// ── WHY A STACK AND NOT A LIST ──
// Interruptions nest in practice (a sign, then a culvert under the same road)
// and they nest in the order you meet them, so the last thing paused is nearly
// always the next thing wanted. The bar still shows every entry and any of them
// can be resumed out of order — the stack is about what gets OFFERED by default
// after a save, not about restricting the crew.
//
// ── WHY IT IS CAPPED ──
// Five deep. Not a technical limit: each parked capture is real unsaved work
// with photos attached, and a crew holding six half-finished features has lost
// track of the survey, not gained flexibility. The cap makes that a refusal at
// the moment it happens rather than a discovery at export.
//
// ── WHY IT PERSISTS ──
// A parked capture is unsaved work, and unsaved work that only exists in a
// WebView the Android OS is free to reclaim is work that will be lost. The stack
// rides along in projectData through persist() (see js/04-store.js), the same
// way currentVertices already does, so a killed app comes back with every parked
// capture intact.

const CAPTURE_STACK_MAX = 5;

// LIFO: the last entry is the most recently paused and the one offered first.
let suspendedCaptures = [];


// ══ SNAPSHOT ══
// Everything the Collect tab holds that is not already on disk. Deep-copied at
// the moment of suspension, because currentVertices and repeatGroupState are
// both mutated in place by the capture flow — a shallow copy would have the
// parked capture quietly track the live one.
function captureSnapshot(){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel ? getFeatureType(sel.value) : null;
  if (!ft) return null;
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    id: 'cs_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    at: Date.now(),
    ftId: ft.id,
    ftName: ft.name,
    // The geometry this capture is being built as, not the type's default — a parked polygon
    // must come back as a polygon even if the type also permits points.
    geometryType: activeGeometryType && ftAllowsGeometry(ft, activeGeometryType) ? activeGeometryType : ftDefaultGeometry(ft),
    name: val('featureName'),
    ref: val('featureRef'),
    assignedTo: val('featureAssignedTo'),
    notes: val('featureNotes'),
    environment: currentEnvironment === 'PlotIn' ? 'PlotIn' : 'PlotOut',
    buildingId: val('collectBuildingId'),
    floorLevel: val('collectFloorLevel'),
    // collectAttrs() rather than a hand-rolled DOM read, so a parked capture can
    // never disagree with what Save would have written from the same form.
    attrs: collectAttrs(ft),
    customAttrs: { ...customFeatureAttrs },
    repeatState: JSON.parse(JSON.stringify(repeatGroupState || {})),
    vertices: JSON.parse(JSON.stringify(currentVertices || [])),
    openVertexIndex: openVertexIndex,
    // An edit can be interrupted too. Carrying the id and the original snapshot
    // means resuming lands back in edit mode against the same feature rather
    // than turning someone's correction into a duplicate.
    editingFeatureId: editingFeatureId || null,
    editingFeatureSnapshot: editingFeatureSnapshot ? JSON.parse(JSON.stringify(editingFeatureSnapshot)) : null
  };
}


// Is there anything on the Collect tab worth parking? A named feature or at
// least one vertex. Anything less is an empty form, and parking an empty form
// would put a row in the bar that means nothing.
function hasCaptureInProgress(){
  if (currentVertices && currentVertices.length) return true;
  const nameEl = document.getElementById('featureName');
  return !!(nameEl && nameEl.value.trim());
}


// ══ SUSPEND ══
function suspendCurrentCapture(){
  if (!featureTypes.length){ showToast('Add a feature type first'); return false; }
  if (!hasCaptureInProgress()){
    showToast('Nothing in progress to pause — just pick the type you want');
    return false;
  }
  if (suspendedCaptures.length >= CAPTURE_STACK_MAX){
    showToast(`${CAPTURE_STACK_MAX} paused captures already — finish or discard one first`);
    return false;
  }
  const snap = captureSnapshot();
  if (!snap){ showToast('Choose a feature type first'); return false; }
  suspendedCaptures.push(snap);
  blankCollectForm();
  persist();
  renderCaptureStack();
  showToast(`"${snap.name || snap.ftName}" paused — collect the other feature, then tap Resume`);
  // Attention goes back to the type picker, because the whole point of pausing
  // is that the next thing captured is a DIFFERENT type.
  if (typeof openCollectStep === 'function') openCollectStep('collectCardType', true);
  return true;
}


// ══ RESUME ══
// Resuming while something else is in progress swaps rather than clobbers: the
// live capture is pushed before the parked one is pulled. That makes Resume
// non-destructive in every case, which is what lets it be a single tap with no
// confirmation dialog in front of it.
function resumeCapture(id){
  const idx = suspendedCaptures.findIndex(s => s.id === id);
  if (idx === -1){ showToast('That paused capture is no longer here'); return; }

  // What happened to the capture that was on screen, so the toast below can say
  // so. A swap that silently parks your traffic sign reads exactly like a swap
  // that silently deleted it, and "did that just get thrown away" is not a
  // question a crew should have to answer by scrolling.
  let parkedLabel = null;
  if (hasCaptureInProgress()){
    if (suspendedCaptures.length >= CAPTURE_STACK_MAX){
      showToast('Too many paused captures to swap — finish or discard one first');
      return;
    }
    const live = captureSnapshot();
    if (live){
      suspendedCaptures.push(live);
      parkedLabel = live.name || live.ftName;
    }
  }

  // Re-find after the possible push: the array changed underneath the index.
  const at = suspendedCaptures.findIndex(s => s.id === id);
  const snap = suspendedCaptures.splice(at, 1)[0];
  restoreCaptureSnapshot(snap);
  persist();
  renderCaptureStack();
  showToast(parkedLabel
    ? `Back on "${snap.name || snap.ftName}" · "${parkedLabel}" paused`
    : `Back on "${snap.name || snap.ftName}"`);
  switchTab('collect');
}


// The other half of the same decision. Resume swaps because that is right most of
// the time — you stopped for the sign, you finished the sign, you want the road.
// But "I started this by mistake, bin it and put me back" is a real intent too,
// and expressing it used to cost two separate trips (Clear current feature, then
// scroll up and Resume). One tap, with the thing being destroyed named in the
// confirm, because unlike Resume this one genuinely does lose work.
function resumeCaptureDiscardingCurrent(id){
  const target = suspendedCaptures.find(s => s.id === id);
  if (!target){ showToast('That paused capture is no longer here'); return; }
  if (!hasCaptureInProgress()){ resumeCapture(id); return; }

  const live = captureSnapshot();
  const liveLabel = (live && (live.name || live.ftName)) || 'the capture in progress';
  const nVerts = live ? (live.vertices || []).length : 0;
  const nPhotos = live ? (live.vertices || []).reduce((n, v) => n + ((v.photos || []).length), 0) : 0;
  const bits = [`${nVerts} vertex${nVerts === 1 ? '' : 'es'}`];
  if (nPhotos) bits.push(`${nPhotos} photo${nPhotos === 1 ? '' : 's'}`);

  showConfirm(
    `Discard "${liveLabel}" (${bits.join(', ')}) and go back to "${target.name || target.ftName}"? The discarded capture has never been saved and cannot be recovered.`,
    () => {
      // Blanking first is what makes the resume below a plain restore rather than
      // a swap: hasCaptureInProgress() is false by the time it runs, so nothing
      // gets pushed back onto the stack.
      blankCollectForm();
      resumeCapture(id);
    },
    'Discard & resume', 'danger'
  );
}


function discardSuspendedCapture(id){
  const snap = suspendedCaptures.find(s => s.id === id);
  if (!snap) return;
  const label = snap.name || snap.ftName || 'this capture';
  const nPhotos = (snap.vertices || []).reduce((n, v) => n + ((v.photos || []).length), 0);
  const detail = `${(snap.vertices||[]).length} vertex${(snap.vertices||[]).length===1?'':'es'}`
    + (nPhotos ? ` and ${nPhotos} photo${nPhotos===1?'':'s'}` : '');
  showConfirm(
    `Discard the paused capture "${label}"? Its ${detail} have never been saved and cannot be recovered.`,
    () => {
      suspendedCaptures = suspendedCaptures.filter(s => s.id !== id);
      persist();
      renderCaptureStack();
      showToast('Paused capture discarded');
    },
    'Discard', 'danger'
  );
}


// ══ RESTORE ══
// The inverse of captureSnapshot(). Order matters here: edit-mode state and the
// repeating-group state have to be in place BEFORE onFeatureTypeChange() runs,
// because that is what builds the attribute panes those values render into.
function restoreCaptureSnapshot(snap){
  editingFeatureId = snap.editingFeatureId || null;
  editingFeatureSnapshot = snap.editingFeatureSnapshot || null;

  currentVertices = JSON.parse(JSON.stringify(snap.vertices || []));
  openVertexIndex = (snap.openVertexIndex != null && snap.openVertexIndex < currentVertices.length)
    ? snap.openVertexIndex
    : (currentVertices.length ? 0 : null);

  customFeatureAttrs = { ...(snap.customAttrs || {}) };

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  set('featureName', snap.name);
  set('featureRef', snap.ref);
  set('featureAssignedTo', snap.assignedTo);
  set('featureNotes', snap.notes);
  setCollectEnvironment(snap.environment === 'PlotIn' ? 'PlotIn' : 'PlotOut');
  set('collectBuildingId', snap.buildingId);
  set('collectFloorLevel', snap.floorLevel);

  const sel = document.getElementById('featureTypeSelect');
  const ft = getFeatureType(snap.ftId);
  if (sel && ft){
    sel.value = ft.id;
    // Set before onFeatureTypeChange() so the attribute panes are built against the right scope
    // resolution first time — rebuilding them afterwards would discard the values applied below.
    activeGeometryType = ftAllowsGeometry(ft, snap.geometryType) ? snap.geometryType : ftDefaultGeometry(ft);
    onFeatureTypeChange();
    // onFeatureTypeChange() resets repeatGroupState and rebuilds every pane, so
    // the group entries and the field values both go back in afterwards.
    (ft.fields || []).filter(a => a.type === 'repeat_group').forEach(a => {
      repeatGroupState[a.id] = (snap.repeatState && Array.isArray(snap.repeatState[a.id]))
        ? snap.repeatState[a.id].map(inst => ({ ...inst }))
        : [];
      if (typeof rerenderRepeatGroupPane === 'function') rerenderRepeatGroupPane(a.id);
    });
    applyAttrValues(ft, snap.attrs || {});
  } else if (!ft){
    // The feature type was deleted while this capture was parked. The vertices
    // and photos are still real, so they are kept and the crew is told to
    // re-point the capture at a type that still exists rather than losing it.
    showToast(`"${snap.ftName}" no longer exists — choose a feature type to finish this capture`);
  }

  const banner = document.getElementById('editModeBanner');
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (editingFeatureId){
    const f = savedFeatures.find(x => x.id === editingFeatureId);
    if (banner) banner.style.display = '';
    const nameEl = document.getElementById('editModeBannerName');
    if (nameEl) nameEl.textContent = (f && f.name) || snap.name || 'feature';
    if (cancelBtn) cancelBtn.style.display = '';
  } else {
    if (banner) banner.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  renderPoints();
  renderVertexEditor();
  if (ft) updateGeometryUI(ft);
  if (typeof refreshFieldConditionsAndCalcs === 'function') refreshFieldConditionsAndCalcs();
}


// Writes saved values back into the freshly-rendered attribute panes. Mirrors
// collectAttrs() field type for field type — the two are inverses and have to
// stay that way, so they are worth reading side by side if either changes.
// repeat_group is absent on purpose: its state is not in the DOM at all (see the
// comment on repeatGroupState in js/06-collect.js) and is restored above.
// calculated is absent too: it is derived, and refreshFieldConditionsAndCalcs()
// recomputes it from the values this function has just put back.
function applyAttrValues(ft, attrs){
  (ft.fields || []).filter(a => effectiveFieldScope(a, currentCaptureGeometry()) !== 'vertex').forEach(a => {
    if (a.type === 'repeat_group' || a.type === 'calculated') return;
    const el = document.getElementById('attr_' + a.id);
    if (!el) return;
    const v = attrs[a.id];
    if (a.type === 'multi_select'){
      const want = Array.isArray(v) ? v : [];
      el.querySelectorAll('.chip-opt').forEach(c => c.classList.toggle('sel', want.includes(c.dataset.val)));
    } else if (a.type === 'boolean'){
      if (v === true || v === false) setBoolField(a.id, v);
      else {
        el.dataset.val = '';
        el.querySelectorAll('.bool-opt').forEach(o => o.classList.remove('sel-yes', 'sel-no'));
      }
    } else {
      el.value = v == null ? '' : v;
    }
  });
  renderCustomAttrsList();
}


// ══ BLANKING THE FORM ══
// Everything finalizeSaveFeature() does to the screen after a successful write,
// minus the saving. Factored out here rather than duplicated because a pause
// that left one field behind would leak the road's name onto the traffic sign,
// which is exactly the class of bug this feature exists to remove.
function blankCollectForm(){
  resetCaptureEndPreference();
  currentVertices = [];
  openVertexIndex = null;
  editingFeatureId = null;
  editingFeatureSnapshot = null;
  customFeatureAttrs = {};
  renderCustomAttrsList();

  ['featureName', 'featureRef', 'featureAssignedTo', 'featureNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  resetCollectEnvironmentFields();
  refIdAutoFilled = null;   // the next capture of this type should autofill afresh

  const banner = document.getElementById('editModeBanner');
  if (banner) banner.style.display = 'none';
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';

  // Rebuilding the panes from the schema is what actually clears the attribute
  // values — they live in the DOM, so a re-render is the reset.
  const ft = getFeatureType((document.getElementById('featureTypeSelect') || {}).value);
  if (ft){ onFeatureTypeChange(); updateGeometryUI(ft); }
  renderPoints();
  renderVertexEditor();
}


// ══ AFTER A SAVE ══
// Called at the end of finalizeSaveFeature(). Offers the top of the stack rather
// than resuming it silently: the crew may well have a third feature in front of
// them, and a form that refills itself without being asked is a form that gets
// saved with the wrong thing in it.
function offerResumeAfterSave(){
  if (!suspendedCaptures.length) return;
  const next = suspendedCaptures[suspendedCaptures.length - 1];
  const label = next.name || next.ftName;
  showConfirm(
    `Saved. Resume "${label}" where you left off?`,
    () => resumeCapture(next.id),
    'Resume', 'default'
  );
}


// ══ THE BAR ══
// Collapsed by default, and that is a deliberate constraint rather than a
// nicety. Collect is already five cards deep before this bar exists; a paused
// capture has to be VISIBLE (unsaved work the crew cannot see is unsaved work
// they walk away from) but it must not push the Capture button below the fold to
// achieve that. So the resting state is one line that names what is paused and
// offers the single action wanted 90% of the time, and everything else —
// per-row detail, discarding, resuming out of order — is one tap behind it.
let captureStackOpen = false;

function toggleCaptureStack(){
  captureStackOpen = !captureStackOpen;
  renderCaptureStack();
}

function renderCaptureStack(){
  const bar = document.getElementById('captureStackBar');
  const pauseBtn = document.getElementById('pauseCaptureBtn');

  if (pauseBtn){
    // Shown only when there is something to pause and room to park it. Hidden
    // rather than disabled: a permanently greyed button on the Save card is
    // noise on a screen that is already five cards long.
    const canPause = featureTypes.length && hasCaptureInProgress() && suspendedCaptures.length < CAPTURE_STACK_MAX;
    pauseBtn.style.display = canPause ? '' : 'none';
  }

  if (!bar) return;
  if (!suspendedCaptures.length){ bar.style.display = 'none'; bar.innerHTML = ''; captureStackOpen = false; return; }
  bar.style.display = '';

  // Is something on screen right now? It changes what resuming MEANS — with a
  // capture in progress it is a swap, not a restore — and the bar has to say so
  // before it is tapped rather than through a toast afterwards.
  const busy = hasCaptureInProgress();
  const liveName = busy
    ? ((document.getElementById('featureName') || {}).value || '').trim()
    : '';
  const liveLabel = liveName || 'the capture in progress';
  const roomToSwap = suspendedCaptures.length < CAPTURE_STACK_MAX;
  const n = suspendedCaptures.length;
  const top = suspendedCaptures[n - 1];
  const topLabel = top.name || top.ftName;

  const head = `<button type="button" class="cap-stack-head" onclick="toggleCaptureStack()" aria-expanded="${captureStackOpen ? 'true' : 'false'}" aria-controls="captureStackBody">
      <svg class="cap-stack-head-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
      <span class="cap-stack-head-text">${n} paused ${n === 1 ? 'capture' : 'captures'} · not saved yet</span>
      <svg class="cap-stack-chev${captureStackOpen ? ' open' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>`;

  if (!captureStackOpen){
    // The 90% case in one line: go back to the last thing you paused. Naming it
    // rather than saying "Resume" is what makes this safe to tap without opening
    // anything first.
    bar.innerHTML = head + `<button type="button" class="cap-stack-quick" onclick="resumeCapture('${top.id}')">
        ${busy ? 'Swap to' : 'Resume'} “${escapeHtml(topLabel)}”${n > 1 ? `<span class="cap-stack-quick-more">+${n - 1} more</span>` : ''}
      </button>`;
    return;
  }

  // Newest first — the last thing paused is the thing most likely wanted back.
  const rows = suspendedCaptures.slice().reverse().map(s => {
    const nVerts = (s.vertices || []).length;
    const nPhotos = (s.vertices || []).reduce((acc, v) => acc + ((v.photos || []).length), 0);
    const mins = Math.round((Date.now() - (s.at || Date.now())) / 60000);
    const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
    const bits = [`${nVerts} vertex${nVerts === 1 ? '' : 'es'}`];
    if (nPhotos) bits.push(`${nPhotos} photo${nPhotos === 1 ? '' : 's'}`);
    bits.push(when);
    const geoGlyph = (typeof ftPickerGlyph !== 'undefined' && ftPickerGlyph[s.geometryType]) || '';
    const safeLabel = escapeHtml(s.name || s.ftName);

    // Actions on their own line rather than beside the name. With a capture in
    // progress there are three of them, and three buttons plus a feature name on
    // one row is where a 360dp phone starts truncating the thing being chosen
    // between.
    const actions = [
      `<button type="button" class="cap-stack-resume" onclick="resumeCapture('${s.id}')">${busy ? 'Swap to this' : 'Resume'}</button>`,
      (busy && roomToSwap)
        ? `<button type="button" class="cap-stack-swapoff" onclick="resumeCaptureDiscardingCurrent('${s.id}')">Discard current &amp; resume</button>`
        : ''
    ].join('');

    return `<div class="cap-stack-row">
      <div class="cap-stack-row-head">
        <span class="cap-stack-glyph" aria-hidden="true">${geoGlyph}</span>
        <span class="cap-stack-text">
          <span class="cap-stack-name">${escapeHtml(s.name || '(unnamed)')}</span>
          <span class="cap-stack-meta">${escapeHtml(s.ftName)} · ${escapeHtml(bits.join(' · '))}</span>
        </span>
        <button type="button" class="cap-stack-drop" onclick="discardSuspendedCapture('${s.id}')" title="Discard this paused capture" aria-label="Discard paused capture ${safeLabel}">✕</button>
      </div>
      <div class="cap-stack-actions">${actions}</div>
    </div>`;
  }).join('');

  const note = busy
    ? `<div class="cap-stack-note">You're on <strong>${escapeHtml(liveLabel)}</strong>. ${
        roomToSwap
          ? 'Swapping parks it here too — nothing is lost.'
          : 'The list is full, so it can\'t be parked — finish or discard one first.'
      }</div>`
    : '';

  bar.innerHTML = head + `<div class="cap-stack-body" id="captureStackBody">${note}${rows}</div>`;
}


// ══ PERSISTENCE HELPERS ══
// Called by persist() (js/04-store.js) and by the project loader
// (js/05-projects.js). Kept as functions rather than having those files touch
// the array directly, so the shape check on load lives next to the shape.
function captureStackForStore(){
  return suspendedCaptures.slice(0, CAPTURE_STACK_MAX);
}

function loadCaptureStack(list){
  suspendedCaptures = Array.isArray(list)
    ? list.filter(s => s && s.id && s.ftId).slice(0, CAPTURE_STACK_MAX)
    : [];
}
