// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Save/finish feature, auto geometry attrs, drafts, edit feature
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ SAVE / FINISH FEATURE ══
// ══ AUTO GEOMETRY ATTRIBUTES ══ — length for lines, area+perimeter for polygons, computed from
// the captured vertices at save time and written into the feature's own attrs so they flow
// through every export (CSV/Excel/GeoJSON/GPKG/FlatGeobuf) the same way any other attribute does.
function haversineM(lat1,lon1,lat2,lon2){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(Math.min(1,a)));
}

function lineLengthM(vertices){
  let total=0;
  for(let i=1;i<vertices.length;i++) total+=haversineM(vertices[i-1].lat,vertices[i-1].lon,vertices[i].lat,vertices[i].lon);
  return total;
}

// Equirectangular projection centered on the ring's mean latitude, then plain planar shoelace —
// accurate for typical survey-scale plots (up to a few km across); not intended for
// country-scale polygons, where the flat-earth approximation would start to drift.
function polygonAreaAndPerimeterM(vertices){
  const latAvg = vertices.reduce((s,v)=>s+v.lat,0)/vertices.length;
  const R=6378137, cosLat=Math.cos(latAvg*Math.PI/180);
  const pts = vertices.map(v=>({ x:(v.lon*Math.PI/180)*R*cosLat, y:(v.lat*Math.PI/180)*R }));
  let area=0, perim=0;
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length];
    area += (a.x*b.y - b.x*a.y);
    perim += haversineM(vertices[i].lat,vertices[i].lon, vertices[(i+1)%vertices.length].lat, vertices[(i+1)%vertices.length].lon);
  }
  return { area: Math.abs(area/2), perimeter: perim };
}

// `geo` is the geometry actually being saved. It is passed explicitly rather than read off the
// feature type because a multi-geometry type has no single answer — the same "Septic Tank" type
// yields a length for its line captures and an area for its polygon ones. Callers that omit it
// fall back to the type's default, which is correct for every single-geometry type.
function computeGeometryAttrs(ft, vertices, geo){
  if (!ft) return {};
  const g = geo || (typeof ftDefaultGeometry === 'function' ? ftDefaultGeometry(ft) : ft.geometryType);
  if (g==='line' && vertices.length>=2){
    return { geom_length_m: +lineLengthM(vertices).toFixed(2) };
  }
  if (g==='polygon' && vertices.length>=3){
    const {area,perimeter}=polygonAreaAndPerimeterM(vertices);
    return { geom_area_sqm: +area.toFixed(2), geom_perimeter_m: +perimeter.toFixed(2) };
  }
  return {};
}


// ══ COLLECT DRAFT: CAPTURE / RESTORE ══
// See writeDraft() in the store block for why this is kept off the main store.
// Written on a short debounce from a delegated input listener, and flushed
// synchronously on the two events Android does fire when it takes the app away
// (visibilitychange to hidden, and pagehide). "unload"/"beforeunload" are not
// reliable on a WebView that is being reclaimed, so they are not depended on.
let _draftTimer = null;

function currentDraftSnapshot(){
  if (!activeProjectId) return null;
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel ? getFeatureType(sel.value) : null;
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    projectId: activeProjectId,
    ftId: ft ? ft.id : (sel ? sel.value : ''),
    name: val('featureName'),
    ref: val('featureRef'),
    assignedTo: val('featureAssignedTo'),
    notes: val('featureNotes'),
    // Reuses collectAttrs() so the draft can never disagree with what Save
    // would have read off the same form.
    attrs: ft ? collectAttrs(ft) : {},
    editingFeatureId: editingFeatureId || null,
    environment: currentEnvironment === 'PlotIn' ? 'PlotIn' : 'PlotOut',
    buildingId: val('collectBuildingId'),
    floorLevel: val('collectFloorLevel')
  };
}

function saveCollectDraft(){
  const snap = currentDraftSnapshot();
  if (!snap) return;
  // Nothing typed and nothing captured — don't leave an empty draft behind that
  // would prompt a pointless "restore?" on the next launch.
  const hasContent = snap.name || snap.ref || snap.notes || snap.assignedTo || snap.buildingId || snap.floorLevel
    || Object.keys(snap.attrs || {}).some(k => {
      const v = snap.attrs[k];
      return Array.isArray(v) ? v.length : (v !== '' && v != null && v !== false);
    });
  if (!hasContent) { clearDraft(); return; }
  writeDraft(snap);
}

function scheduleDraftSave(){
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(saveCollectDraft, 400);
}

(function(){
  const panel = document.getElementById('panel-collect');
  if (panel) {
    panel.addEventListener('input', scheduleDraftSave);
    panel.addEventListener('change', scheduleDraftSave);
  }
  // Synchronous flush — no debounce — because by the time these fire the app
  // may not get another frame.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(_draftTimer); saveCollectDraft(); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(_draftTimer); saveCollectDraft(); });
})();


// Offered rather than applied silently: the vertices are already back on screen
// from the project store, so the crew should be told what else was recovered
// and given the option to start clean instead.
// Shown once per project open, and only when the draft holds something the
// project store did not already bring back.
function maybeOfferDraftRecovery(projectId){
  const d = readDraft(projectId);
  if (!d) return;
  const label = d.name ? `"${d.name}"` : 'an unsaved capture';
  const age = d.at ? Math.round((Date.now() - d.at) / 60000) : null;
  const when = age == null ? '' : age < 1 ? ' from moments ago' : age < 60 ? ` from ${age} min ago` : ` from ${Math.round(age/60)} h ago`;
  showConfirm(
    `PlotEdge closed with ${label} still being filled in${when}. Restore it?`,
    () => { if (restoreCollectDraft()) { switchTab('collect'); showToast('Unsaved capture restored'); } },
    'Restore', 'default',
    () => clearDraft()   // "Discard" — don't keep re-asking on every open
  );
}


function restoreCollectDraft(){
  const d = readDraft(activeProjectId);
  if (!d) return false;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  // Rebuild the attribute fields for the drafted type FIRST — the inputs the
  // loop below writes into do not exist until onFeatureTypeChange() has run.
  const sel = document.getElementById('featureTypeSelect');
  if (sel && d.ftId && getFeatureType(d.ftId)) { sel.value = d.ftId; onFeatureTypeChange(); }
  set('featureName', d.name); set('featureRef', d.ref);
  set('featureAssignedTo', d.assignedTo); set('featureNotes', d.notes);
  setCollectEnvironment(d.environment === 'PlotIn' ? 'PlotIn' : 'PlotOut');
  set('collectBuildingId', d.buildingId); set('collectFloorLevel', d.floorLevel);
  Object.keys(d.attrs || {}).forEach(k => {
    const el = document.getElementById('attr_' + k);
    if (el && 'value' in el && !Array.isArray(d.attrs[k])) el.value = d.attrs[k];
  });
  return true;
}


function saveFeature(){
  if(!featureTypes.length){showToast('Add a feature type first');return;}
  const ft=getFeatureType(document.getElementById('featureTypeSelect').value);
  if(!ft){showToast('Choose a feature type');return;}
  const name=document.getElementById('featureName').value.trim();
  const ref=document.getElementById('featureRef').value.trim();
  const assignedTo=document.getElementById('featureAssignedTo').value.trim();
  const notes=document.getElementById('featureNotes').value.trim();
  const attrs=collectAttrs(ft);
  if(!name){showToast('Enter a feature name first');return;}

  const environment = currentEnvironment === 'PlotIn' ? 'PlotIn' : 'PlotOut';
  const buildingId = (document.getElementById('collectBuildingId')?.value || '').trim();
  const floorLevel = (document.getElementById('collectFloorLevel')?.value || '').trim();
  if (environment === 'PlotIn'){
    if (!buildingId){ showToast('Building ID / Name is required for PlotIn'); document.getElementById('collectBuildingId')?.focus(); return; }
    if (!floorLevel){ showToast('Floor Level is required for PlotIn'); document.getElementById('collectFloorLevel')?.focus(); return; }
  }

  // The geometry this capture is being saved as — resolved once here and used for the vertex
  // minimum, the scope resolution below, the geometry attrs, and what lands on the feature.
  const saveGeo = ftAllowsGeometry(ft, activeGeometryType) ? activeGeometryType : ftDefaultGeometry(ft);
  const minVerts = saveGeo==='polygon' ? 3 : saveGeo==='line' ? 2 : 1;
  if(currentVertices.length < minVerts){
    const geoWord = saveGeo==='line'?'A line':saveGeo==='polygon'?'A polygon':'This feature';
    showToast(`${geoWord} needs at least ${minVerts} vertex${minVerts===1?'':'es'}. Capture ${minVerts-currentVertices.length} more.`);
    return;
  }
  // hiddenAttrIds (js/06-collect.js) is fields currently hidden by unmet skip-logic — collectAttrs
  // already excludes them, so without the exclusion here a required-but-hidden field would block
  // saving over an answer the form never actually asked for this capture.
  const missingFeature=ft.fields.filter(a=>effectiveFieldScope(a, saveGeo)!=='vertex' && !hiddenAttrIds.has(a.id)).find(a=>a.required && (attrs[a.id]===''||attrs[a.id]==null||(Array.isArray(attrs[a.id])&&!attrs[a.id].length)));
  if(missingFeature){showToast(`"${missingFeature.label}" is required`);return;}
  // A repeating group's own "required" (checked above) only means "at least one entry" — each
  // entry can still have its own required sub-fields (e.g. every occupant needs a name even if
  // "Occupants" itself isn't mandatory). Checked separately since it's one level deeper than the
  // rest of missingFeature's flat field list.
  for (const a of ft.fields.filter(a=>a.type==='repeat_group' && !hiddenAttrIds.has(a.id))){
    const entries = attrs[a.id] || [];
    for (let ei=0; ei<entries.length; ei++){
      const missingSub = (a.subfields||[]).find(s => s.required && (entries[ei][s.id]===''||entries[ei][s.id]==null||(Array.isArray(entries[ei][s.id])&&!entries[ei][s.id].length)));
      if (missingSub){ showToast(`"${a.label}" entry ${ei+1}: "${missingSub.label}" is required`); return; }
    }
  }
  const vertexReqFields = ft.fields.filter(a=>effectiveFieldScope(a, saveGeo)==='vertex' && a.required);
  for (let vi=0; vi<currentVertices.length; vi++){
    const va = currentVertices[vi].attrs || {};
    const missingV = vertexReqFields.find(a=> va[a.id]===''||va[a.id]==null||(Array.isArray(va[a.id])&&!va[a.id].length));
    if (missingV){ showToast(`Vertex ${vi+1}: "${missingV.label}" is required`); editVertex(vi); return; }
  }

  // `fix` carries the GNSS provenance captured at the mark (js/17d-plotfix.js). Copied through
  // explicitly rather than by spread so an edit of an existing feature preserves the ORIGINAL
  // fix quality — re-stamping it with today's would claim an accuracy the mark never had.
  const vertices = currentVertices.map(v=>({ lat:v.lat, lon:v.lon, alt:v.alt, acc:v.acc, time:v.time, attrs:{...(v.attrs||{})}, photos:(v.photos||[]).map(p=>({...p})), capture_method:v.capture_method||'gps_fix', fix:v.fix||null }));
  // Auto-computed length/area/perimeter — always recalculated from the current vertices so an
  // edited feature's geometry attrs stay in sync with whatever shape it ends up with.
  Object.assign(attrs, computeGeometryAttrs(ft, vertices, saveGeo));

  // Same name already used elsewhere in this project — easy to do by accident (retyping "Marker 3"
  // without realizing it's already logged), so ask before silently creating a second feature
  // with the identical name.
  const isDuplicateName = savedFeatures.some(f => f.id!==editingFeatureId && (f.name||'').trim().toLowerCase()===name.toLowerCase());
  if (isDuplicateName){
    showConfirm(`A feature named "${name}" already exists in this project. Save anyway?`, ()=>finalizeSaveFeature(ft,name,ref,assignedTo,notes,attrs,vertices,environment,buildingId,floorLevel,saveGeo), 'Save anyway', 'default');
    return;
  }
  finalizeSaveFeature(ft,name,ref,assignedTo,notes,attrs,vertices,environment,buildingId,floorLevel,saveGeo);
}


// ══ IDs MUST NOT COLLIDE ══
// Date.now() alone gave two features saved inside the same millisecond the same id — and id is
// what editFeature/deleteFeature/selectAttrRow all key off, so a collision silently edits or
// deletes the wrong feature. Cheap to make certain instead.
let _lastFeatureId = 0;

function newFeatureId(){
  // The floor considers what is already in the project, not just what this session issued, so a
  // device whose clock has moved backwards still cannot mint an id that is already in use.
  const maxExisting = savedFeatures.reduce((m,f)=> (typeof f.id === 'number' && f.id > m) ? f.id : m, 0);
  const floor = Math.max(_lastFeatureId, maxExisting);
  let id = Date.now();
  if (id <= floor) id = floor + 1;
  _lastFeatureId = id;
  return id;
}


// ══ SAVE IS ALL-OR-NOTHING ══
// This used to blank the form, drop currentVertices and clear the crash draft BEFORE calling
// persist(), then ignore what persist() returned. When a save was refused or the disk write
// failed, the app had already destroyed every copy of the work except the one in memory — which
// the next launch did not have. The crew saw "saved ✓", came back to an empty project, and the
// only surviving trace was the vertices (persisted at capture time) with no name on them.
//
// Now the write happens first and the clean-up only runs if the bytes actually landed. If they
// did not, every part of the capture is put back exactly as it was so it can be retried or
// exported — nothing is thrown away on the strength of a save that did not happen.
// `saveGeo` is the geometry this capture is being written as, resolved once in saveFeature() and
// handed down rather than re-derived here: the two must agree, and re-reading activeGeometryType
// at this point would let a geometry switch made while the duplicate-name confirm was open change
// what gets saved out from under the validation that already ran against it.
function finalizeSaveFeature(ft,name,ref,assignedTo,notes,attrs,vertices,environment,buildingId,floorLevel,saveGeo){
  saveGeo = saveGeo || ftDefaultGeometry(ft);
  const wasEditing = !!editingFeatureId;
  environment = environment === 'PlotIn' ? 'PlotIn' : 'PlotOut';
  // Only meaningful for PlotIn — kept as null rather than '' for PlotOut features so a query like
  // "has a building_id" reads unambiguously, and so existing PlotOut features (saved before this
  // feature existed) round-trip the same way once re-saved.
  buildingId = environment === 'PlotIn' ? (buildingId || '') : null;
  floorLevel = environment === 'PlotIn' ? (floorLevel || '') : null;

  // Rollback snapshot, taken before anything is mutated.
  const prevSaved = savedFeatures.slice();
  const prevVertices = currentVertices;
  const prevOpenVertexIndex = openVertexIndex;
  const prevEditingId = editingFeatureId;
  const prevEditingSnapshot = editingFeatureSnapshot;

  let successMsg;
  if (wasEditing) {
    const idx = savedFeatures.findIndex(f => f.id === editingFeatureId);
    if (idx === -1) {
      // Original entry vanished (e.g. deleted or "Clear all" elsewhere) while this edit was open —
      // save as a new feature instead of silently losing the edit.
      savedFeatures.push(plotmateTouch({ id:newFeatureId(), name, ref, featureTypeId:ft.id, featureTypeName:ft.name, assignedTo, attrs, notes, geometryType:saveGeo, vertices, environment, building_id:buildingId, floor_level:floorLevel, savedAt:new Date().toISOString() }, 'ft'));
      successMsg = 'Original feature no longer exists. Saved as a new feature.';
    } else {
      const original = savedFeatures[idx];
      // Update in place: keep the original id and savedAt, add editedAt as a record that this was
      // modified after initial capture.
      // plotmateTouch AFTER the spread, so the edit gets a fresh revision while keeping the
      // original's uid — the uid is the record's identity across devices and must never change,
      // or an edit becomes an unrelated second feature on merge.
      savedFeatures[idx] = plotmateTouch({ ...original, name, ref, featureTypeId:ft.id, featureTypeName:ft.name, assignedTo, attrs, notes, geometryType:saveGeo, vertices, environment, building_id:buildingId, floor_level:floorLevel, savedAt:original.savedAt, editedAt:new Date().toISOString() }, 'ft');
      successMsg = `"${name}" updated ✓`;
    }
  } else {
    savedFeatures.push(plotmateTouch({ id:newFeatureId(), name, ref, featureTypeId:ft.id, featureTypeName:ft.name, assignedTo, attrs, notes, geometryType:saveGeo, vertices, environment, building_id:buildingId, floor_level:floorLevel, savedAt:new Date().toISOString() }, 'ft'));
    successMsg = `"${name}" saved ✓`;
  }

  // Cleared before the write so what reaches disk is exactly what the screen will show
  // afterwards — restored below if the write does not land.
  currentVertices=[]; openVertexIndex=null;

  if (persist() === false) {
    savedFeatures = prevSaved;
    currentVertices = prevVertices;
    openVertexIndex = prevOpenVertexIndex;
    editingFeatureId = prevEditingId;
    editingFeatureSnapshot = prevEditingSnapshot;
    renderPoints(); renderVertexEditor(); renderFeatures(); updateStats(); updateGeometryUI(ft);
    // The form still holds everything the user typed; make sure a copy is on disk too, so even
    // killing the app now does not lose it.
    saveCollectDraft();
    showToast('Could not save to this device — your capture is still here. Export a backup now.');
    return;
  }

  // The feature is on disk and so are its photo blobs, so the base64 copies the
  // capture flow was holding can go. Only ever drops what the media store has
  // confirmed (see photoBytesOnDisk), so a device without IndexedDB keeps them
  // and simply behaves as it did before.
  if (typeof photoStoreShed === 'function' && typeof collectPhotoRecords === 'function') {
    const justSaved = savedFeatures[savedFeatures.length - 1];
    photoStoreShed(collectPhotoRecords(wasEditing ? savedFeatures : [justSaved]));
  }

  editingFeatureId = null; editingFeatureSnapshot = null;
  document.getElementById('editModeBanner').style.display = 'none';
  document.getElementById('cancelEditBtn').style.display = 'none';
  showToast(successMsg);

  rememberAssignee(assignedTo);
  customFeatureAttrs={}; renderCustomAttrsList();
  document.getElementById('featureName').value='';
  document.getElementById('featureRef').value='';
  document.getElementById('featureAssignedTo').value='';
  document.getElementById('featureNotes').value='';
  resetCollectEnvironmentFields();
  refIdAutoFilled = null;   // the next capture of this type should autofill afresh
  // The draft has served its purpose the moment the feature is on disk —
  // leaving it behind would offer to "recover" work that is already saved.
  clearDraft();
  renderPoints(); renderVertexEditor(); renderFeatures(); updateStats(); updateGeometryUI(ft);
  if (reviewMap) renderReviewMap();
  maybeAutoExportToDevice();
  // Saving always ends the current data-entry burst — including a fresh capture that stays on
  // Collect for the next feature, so the nav bar is back for the crew to navigate between shapes.
  exitCollectDataEntry();
  renderCaptureStack();
  // After saving an edit, return to the Review list so the user sees the updated card; a
  // brand-new capture stays on Collect so multi-feature capture sessions aren't interrupted.
  if (wasEditing) { switchTab('review'); return; }
  // ══ THE INTERRUPTION IS OVER ══
  // If this save was the traffic sign that interrupted a road, the road is still
  // parked and this is the moment to hand it back. Offered, not resumed silently:
  // the crew may be standing in front of a third feature, and a form that refills
  // itself unasked is a form that gets saved with the wrong thing in it. See
  // js/06a-capture-stack.js.
  offerResumeAfterSave();
}


// ══ RECENT ASSIGNEE SUGGESTIONS ══
// Small quality-of-life memory so the same crew member isn't retyped for every feature in a
// session — stored in localStorage (device-level, not project data) and offered via the
// Assigned To field's <datalist>.
function rememberAssignee(name){
  if (!name) return;
  try {
    let list = JSON.parse(localStorage.getItem('plotedge_recent_assignees')||'[]');
    list = [name, ...list.filter(n=>n.toLowerCase()!==name.toLowerCase())].slice(0,8);
    localStorage.setItem('plotedge_recent_assignees', JSON.stringify(list));
    populateAssignedToSuggestions(list);
  } catch(e) {}
}

function populateAssignedToSuggestions(list){
  const dl = document.getElementById('assignedToSuggestions');
  if (!dl) return;
  const names = list || (()=>{ try{ return JSON.parse(localStorage.getItem('plotedge_recent_assignees')||'[]'); }catch(e){ return []; } })();
  dl.innerHTML = names.map(n=>`<option value="${escapeHtml(n)}">`).join('');
}


function deleteFeature(id){
  const idx = savedFeatures.findIndex(f=>f.id===id);
  if (idx===-1) return;
  const [removed] = savedFeatures.splice(idx,1);
  // An absence is not a fact. Without a tombstone, a device that deleted this feature meeting one
  // that merely still has it reads the delete as missing data, and the feature returns from the
  // dead. Recorded BEFORE persist() so the tombstone and the removal reach disk together — a
  // crash between the two would otherwise resurrect it on next load. See js/03a-plotmate.js.
  plotmateRecordDelete(activeProjectId, removed);
  persist({ destructive: true }); renderFeatures(); updateStats(); if (reviewMap) renderReviewMap();
  maybeAutoExportToDevice();
  showUndoToast(`"${removed.name||'Feature'}" deleted`, () => {
    savedFeatures.splice(idx,0,removed);
    // The tombstone has to go, or the feature the crew just restored is deleted again by the next
    // sync — minutes later, with no visible cause. The most alarming way this could fail.
    plotmateWithdrawDelete(activeProjectId, removed);
    persist(); renderFeatures(); updateStats(); if (reviewMap) renderReviewMap();
    maybeAutoExportToDevice();
    showToast('Feature restored');
  });
}


// ══ EDIT FEATURE ══
// Loads an existing saved feature into the Collect form/currentVertices so the exact same UI
// used to capture a feature (name/ref/type/attrs, vertex list, per-vertex attrs & photos) is
// reused to edit one. saveFeature() then writes the result back into savedFeatures by id.
function editFeature(id){
  const f = savedFeatures.find(x=>x.id===id);
  if (!f) return;

  const begin = () => {
    editingFeatureId = id;
    editingFeatureSnapshot = {
      name: f.name||'', ref: f.ref||'', assignedTo: f.assignedTo||'', notes: f.notes||'',
      featureTypeId: f.featureTypeId||null,
      attrs: JSON.parse(JSON.stringify(f.attrs||{})),
      vertices: JSON.parse(JSON.stringify(f.vertices||[]))
    };

    document.getElementById('featureName').value = f.name||'';
    document.getElementById('featureRef').value = f.ref||'';
    document.getElementById('featureAssignedTo').value = f.assignedTo||'';
    document.getElementById('featureNotes').value = f.notes||'';
    // Features saved before PlotIn existed have no environment field — treat them as PlotOut.
    setCollectEnvironment(f.environment === 'PlotIn' ? 'PlotIn' : 'PlotOut');
    const bId = document.getElementById('collectBuildingId'); if (bId) bId.value = f.building_id || '';
    const fl = document.getElementById('collectFloorLevel'); if (fl) fl.value = f.floor_level || '';

    // A new edit is a new question. Without this, answering "add to start" on one
    // road would silently keep prepending on the next feature edited.
    resetCaptureEndPreference();
    currentVertices = (f.vertices||[]).map(v=>({
      lat:v.lat, lon:v.lon, alt:v.alt, acc:v.acc, time:v.time,
      attrs:{...(v.attrs||{})}, photos:(v.photos||[]).map(p=>({...p})), capture_method:v.capture_method||'gps_fix', fix:v.fix||null
    }));
    openVertexIndex = currentVertices.length ? 0 : null;

    let ft = f.featureTypeId ? getFeatureType(f.featureTypeId) : null;
    // Editing resumes in the geometry the feature was SAVED as, not the type's default — opening
    // a polygon septic for a correction must not silently re-save it as a point. If the type has
    // since been narrowed and no longer permits that geometry, fall back to its default and the
    // pills show what it is now.
    if (ft) activeGeometryType = ftAllowsGeometry(ft, f.geometryType || 'point') ? (f.geometryType || 'point') : ftDefaultGeometry(ft);
    if (!ft){
      if (featureTypes.length){
        ft = featureTypes[0];
        showToast(`"${f.featureTypeName||'Original type'}" no longer exists. Choose a feature type below.`);
      } else {
        showToast('Add a feature type before editing this feature');
      }
    }
    const sel = document.getElementById('featureTypeSelect');
    if (ft && sel) sel.value = ft.id;
    if (ft) onFeatureTypeChange();

    document.getElementById('editModeBanner').style.display = '';
    document.getElementById('editModeBannerName').textContent = f.name || 'feature';
    document.getElementById('cancelEditBtn').style.display = '';

    switchTab('collect');
    renderPoints(); renderVertexEditor();
    if (ft) updateGeometryUI(ft);
    document.getElementById('scrollRoot').scrollTo({top:0, behavior:'smooth'});
  };

  const draftInProgress = !editingFeatureId && (currentVertices.length || document.getElementById('featureName').value.trim());
  if (draftInProgress){
    // Used to be "Discard & Edit", which made correcting one feature cost you
    // another. Now the in-progress capture is parked on the stack instead and
    // shows up in the resume bar the moment this edit is saved or cancelled —
    // same single tap, nothing thrown away. Falls back to the old discard prompt
    // only when the stack is full, which is the one case where there is nowhere
    // to put it. See js/06a-capture-stack.js.
    if (suspendedCaptures.length < CAPTURE_STACK_MAX){
      showConfirm(
        'You have an unsaved feature in progress. Pause it and edit this one instead? Nothing is lost — it will be waiting on the Capture tab.',
        () => { if (suspendCurrentCapture()) begin(); },
        'Pause & Edit'
      );
    } else {
      showConfirm(`You have an unsaved feature in progress and ${CAPTURE_STACK_MAX} captures already paused. Discard the one in progress to edit this feature instead?`, begin, 'Discard & Edit', 'danger');
    }
  } else {
    begin();
  }
}


function cancelEditFeature(){
  const hasChanges = () => {
    if (!editingFeatureSnapshot) return false;
    const b = editingFeatureSnapshot;
    const nowName = document.getElementById('featureName').value.trim();
    const nowRef = document.getElementById('featureRef').value.trim();
    const nowAssigned = document.getElementById('featureAssignedTo').value.trim();
    const nowNotes = document.getElementById('featureNotes').value.trim();
    return nowName!==b.name || nowRef!==b.ref || nowAssigned!==b.assignedTo || nowNotes!==b.notes
      || JSON.stringify(currentVertices)!==JSON.stringify(b.vertices);
  };

  const finish = () => {
    editingFeatureId = null; editingFeatureSnapshot = null;
    currentVertices=[]; openVertexIndex=null;
    document.getElementById('featureName').value='';
    document.getElementById('featureRef').value='';
    document.getElementById('featureAssignedTo').value='';
    document.getElementById('featureNotes').value='';
    resetCollectEnvironmentFields();
    document.getElementById('editModeBanner').style.display='none';
    document.getElementById('cancelEditBtn').style.display='none';
    persist(); renderPoints(); renderVertexEditor();
    const ft=getFeatureType(document.getElementById('featureTypeSelect').value);
    if (ft){ onFeatureTypeChange(); updateGeometryUI(ft); }
    switchTab('review');
  };

  if (hasChanges()){
    showConfirm('Discard your changes to this feature?', finish, 'Discard');
  } else {
    finish();
  }
}

function clearCurrent(){
  if(!currentVertices.length && !document.getElementById('featureName').value){
    showToast('Nothing to clear'); return;
  }
  showConfirm('Are you sure you want to clear current feature data? This clears the form, vertices and photos. This action cannot be undone.', () => {
    currentVertices=[]; openVertexIndex=null;
    document.getElementById('featureName').value='';
    document.getElementById('featureRef').value='';
    document.getElementById('featureAssignedTo').value='';
    document.getElementById('featureNotes').value='';
    resetCollectEnvironmentFields();
    // Reset all feature-wide attr fields to blank / unselected
    const ft=getFeatureType(document.getElementById('featureTypeSelect').value);
    (ft?ft.fields.filter(a=>effectiveFieldScope(a, currentCaptureGeometry())!=='vertex'):[]).forEach(a=>{
      if (a.type === 'repeat_group'){ repeatGroupState[a.id] = []; rerenderRepeatGroupPane(a.id); return; }
      const el=document.getElementById('attr_'+a.id);
      if(!el) return;
      if(a.type==='multi_select'){ el.querySelectorAll('.chip-opt.sel').forEach(c=>c.classList.remove('sel')); }
      else if(a.type==='boolean'){ el.dataset.val=''; el.querySelectorAll('.bool-opt').forEach(o=>o.classList.remove('sel-yes','sel-no')); }
      else if(a.type==='calculated'){ el.dataset.value=''; const disp=el.querySelector('.calc-display-value'); if(disp) disp.textContent='—'; }
      else if(el.tagName==='SELECT'){ el.selectedIndex=0; }
      else { el.value=''; }
    });
    refreshFieldConditionsAndCalcs();
    persist(); renderPoints(); renderVertexEditor(); showToast('Current feature cleared');
    if (ft) updateGeometryUI(ft);
    // Clearing ends the data-entry burst the same way Save does, so the nav bar comes back —
    // otherwise a user who backs out via Clear instead of Save is stuck with no bottom nav.
    exitCollectDataEntry();
  }, 'Clear');
}

function clearAll(){
  if(!savedFeatures.length){showToast('Nothing to clear');return;}
  // Paused captures are named in the prompt rather than deleted quietly: they are
  // the one thing here that has never been written to a feature, so a crew that
  // has forgotten about them would lose work they cannot get back.
  const parked = suspendedCaptures.length
    ? ` This also discards ${suspendedCaptures.length} paused capture${suspendedCaptures.length===1?'':'s'} that ${suspendedCaptures.length===1?'has':'have'} never been saved.`
    : '';
  showConfirm(`Delete all ${savedFeatures.length} features? Cannot be undone.${parked}`, () => {
    savedFeatures=[]; currentVertices=[]; openVertexIndex=null;
    suspendedCaptures=[]; renderCaptureStack();
    // Whatever feature was being edited on the Collect tab no longer exists — exit edit mode too.
    editingFeatureId = null; editingFeatureSnapshot = null;
    document.getElementById('editModeBanner').style.display = 'none';
    document.getElementById('cancelEditBtn').style.display = 'none';
    persist({ destructive: true }); renderPoints(); renderVertexEditor(); renderFeatures(); updateStats(); updateCaptureStrip(); showToast('Session cleared');
    maybeAutoExportToDevice();
  });
}


function attrChipsHtml(attrs, fields){
  return Object.entries(attrs||{}).filter(([,v])=>v!==''&&v!=null&&!(Array.isArray(v)&&!v.length)).map(([k,v])=>{
    const fdef=(fields||[]).find(x=>x.id===k);
    const flabel=fdef?fdef.label:k.replace(/_/g,' ');
    const disp=Array.isArray(v)?v.join(', '):(v===true?'Yes':v===false?'No':v);
    return `<span class="feat-attr-chip">${escapeHtml(flabel)}: ${escapeHtml(String(disp))}</span>`;
  }).join('');
}
