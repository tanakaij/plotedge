// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Photo cloud backup queue, device folder auto-export, AI recognition
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ PHOTO BACKUP — cloud upload queue + device folder save ══
// Photos are always kept in projectData/localStorage first (as today). These two backup paths
// are best-effort and additive: a failed/unavailable backup never blocks or loses the local copy.

// -- Cloud upload: a small localStorage-backed retry queue. We only persist lightweight metadata
// (ids + coordinates + timestamp) here, NOT the photo bytes themselves — the actual dataUrl is
// looked up live from projectData when a queue item is processed, so we don't double the
// localStorage footprint that this feature exists to relieve.
const UPLOAD_QUEUE_KEY='plotedge-upload-queue';

function loadUploadQueue(){ try{return JSON.parse(localStorage.getItem(UPLOAD_QUEUE_KEY)||'[]');}catch(e){return [];} }

function saveUploadQueue(q){ try{localStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(q));}catch(e){ console.warn('Could not persist upload queue', e); } }

function getCloudEndpoint(){ return localStorage.getItem('plotedge-cloud-endpoint')||''; }

function saveCloudEndpoint(){
  const url=document.getElementById('cloudEndpointInput').value.trim();
  localStorage.setItem('plotedge-cloud-endpoint', url);
  showToast(url?'Cloud endpoint saved':'Cloud endpoint cleared');
  updateCloudQueueStatus();
  // The timer only exists while an endpoint is set (see startUploadTimer), so setting one here
  // has to start it and clearing one has to stop it — otherwise configuring cloud backup would
  // not take effect until the next visibilitychange.
  if(url){ startUploadTimer(); processUploadQueue(); }
  else stopUploadTimer();
}

function updateCloudQueueStatus(){
  const el=document.getElementById('cloudQueueStatus'); if(!el) return;
  if(!getCloudEndpoint()){ el.textContent='No cloud endpoint set. Photos stay local-only.'; return; }
  const n=loadUploadQueue().length;
  el.textContent = n ? `${n} photo${n>1?'s':''} waiting to sync…` : 'All photos synced.';
}


// Finds a photo object (and its parent vertex) wherever it currently lives — in the in-memory
// project if it's the active one, or in the loaded-but-inactive projectData snapshot otherwise —
// since a queued upload can outlive the user switching projects or reloading the page.
function findPhotoRef(projectId, photoId){
  const isActive = projectId===activeProjectId;
  const src = isActive ? {savedFeatures, currentVertices} : (projectData[projectId]||{});
  const verts = [...(src.currentVertices||[]), ...((src.savedFeatures||[]).flatMap(f=>f.vertices||[]))];
  for(const v of verts){ const p=(v.photos||[]).find(ph=>ph.id===photoId); if(p) return {photo:p, vertex:v, isActive}; }
  return null;
}

function persistProject(projectId){
  if(projectId===activeProjectId){ persist(); return; }
  persistStore(); // projectData[projectId] was mutated in place above — just flush it to storage
}


let _uploadingNow=false;

async function processUploadQueue(){
  const endpoint=getCloudEndpoint();
  if(!endpoint || _uploadingNow || ('onLine' in navigator && !navigator.onLine)){ updateCloudQueueStatus(); return; }
  _uploadingNow=true;
  const q=loadUploadQueue();
  for(const item of q){
    const ref=findPhotoRef(item.projectId, item.photoId);
    if(!ref){ item.done=true; continue; } // photo since deleted, or its project isn't loaded — drop the stale entry
    // The bytes live in the media store, not on the record. Read them back for
    // the POST; the next persistStore() strips the field again, so hydrating
    // here can never push base64 into localStorage.
    if(!ref.photo.dataUrl && typeof photoStoreHydrate==='function') await photoStoreHydrate([ref.photo]);
    if(!ref.photo.dataUrl){ item.attempts=(item.attempts||0)+1; continue; }
    ref.photo.uploadStatus='syncing';
    if(ref.isActive){ renderVertexPhotos(); renderFeatures(); }
    try{
      const res=await fetch(endpoint,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projectId:item.projectId, lat:item.lat, lon:item.lon, takenAt:item.takenAt, name:item.name, photoBase64:ref.photo.dataUrl})
      });
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data=await res.json();
      ref.photo.cloudUrl=data.url||null;
      ref.photo.uploadStatus='synced';
      item.done=true;
    }catch(err){
      item.attempts=(item.attempts||0)+1;
      ref.photo.uploadStatus='failed';
      console.warn('Cloud upload failed, will retry', err);
    }
    persistProject(item.projectId);
    if(typeof photoStoreShed==='function') photoStoreShed([ref.photo]);
    if(ref.isActive){ renderVertexPhotos(); renderFeatures(); }
  }
  saveUploadQueue(q.filter(i=>!i.done));
  _uploadingNow=false;
  updateCloudQueueStatus();
}

window.addEventListener('online', processUploadQueue);

// ══ WHY THIS TIMER IS GATED ══
// This used to be a bare setInterval(processUploadQueue, 60000) with no clear and no conditions.
// Two costs, both paid forever:
//   · It fires while the app is backgrounded or the screen is off. Android throttles background
//     timers but does not stop them, so the WebView is woken once a minute for the lifetime of
//     the process — on a field device that is real battery for no work, since nothing can have
//     been added to the queue while the app was not in front.
//   · Every tick runs loadUploadQueue() → a synchronous localStorage read plus a JSON.parse of
//     the whole queue, even for the overwhelmingly common case of no cloud endpoint configured
//     at all, where processUploadQueue() can only ever bail on its first line.
// Gating on visibility and on an endpoint actually being set makes the steady-state cost zero for
// anyone not using cloud backup, and the visibilitychange handler below gives back the one thing
// the interval was really for: catching up promptly when the crew returns to the app.
let _uploadTimer = null;

function startUploadTimer(){
  if (_uploadTimer) return;
  if (!getCloudEndpoint()) return;
  _uploadTimer = setInterval(processUploadQueue, 60000);
}

function stopUploadTimer(){
  if (!_uploadTimer) return;
  clearInterval(_uploadTimer);
  _uploadTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible'){
    startUploadTimer();
    processUploadQueue(); // catch up immediately rather than waiting out a full minute
  } else {
    stopUploadTimer();
  }
});

startUploadTimer();


// -- Device folder save (File System Access API — Chrome/Android/desktop only). The directory
// handle is requested once (needs a user gesture, so only from chooseDeviceFolder()'s click) and
// persisted in IndexedDB, since handles aren't JSON-serializable for localStorage.
let _photoDirHandle=null;

function idbGet(key){
  return new Promise(resolve=>{
    if(!('indexedDB' in window)){ resolve(null); return; }
    const req=indexedDB.open('plotedge-fs',1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles'); };
    req.onsuccess=()=>{
      const gr=req.result.transaction('handles','readonly').objectStore('handles').get(key);
      gr.onsuccess=()=>resolve(gr.result||null); gr.onerror=()=>resolve(null);
    };
    req.onerror=()=>resolve(null);
  });
}

function idbSet(key,val){
  return new Promise(resolve=>{
    if(!('indexedDB' in window)){ resolve(); return; }
    const req=indexedDB.open('plotedge-fs',1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles'); };
    req.onsuccess=()=>{
      const tx=req.result.transaction('handles','readwrite');
      tx.objectStore('handles').put(val,key);
      tx.oncomplete=()=>resolve(); tx.onerror=()=>resolve();
    };
    req.onerror=()=>resolve();
  });
}

async function chooseDeviceFolder(){
  if(!('showDirectoryPicker' in window)){ showToast('Device folders need Chrome/Android. Use "Download Photos" instead on this browser.'); document.getElementById('saveToDeviceToggle').checked=false; return; }
  try{
    const handle=await window.showDirectoryPicker({id:'plotedge-photos', mode:'readwrite'});
    await idbSet('rootDir', handle);
    _photoDirHandle=handle;
    localStorage.setItem('plotedge-save-to-device','1');
    document.getElementById('saveToDeviceToggle').checked=true;
    document.getElementById('deviceFolderStatus').textContent=`✓ Saving into "${handle.name}/<Project name>/…"`;
    showToast('Device folder selected');
  }catch(err){ console.warn(err); showToast('Folder selection cancelled'); }
}

function toggleSaveToDevice(on){
  if(on){ chooseDeviceFolder(); return; }
  localStorage.setItem('plotedge-save-to-device','0');
  document.getElementById('deviceFolderStatus').textContent='';
}

// Silent (non-prompting) re-acquisition of a previously granted directory handle, used at capture
// time — showDirectoryPicker() itself needs a fresh user gesture so it can only run from the
// "Choose folder…" button, not from background photo processing.
async function ensurePhotoDirHandle(){
  if(_photoDirHandle) return _photoDirHandle;
  try{
    const stored=await idbGet('rootDir');
    if(stored && (await stored.queryPermission({mode:'readwrite'}))==='granted'){ _photoDirHandle=stored; return stored; }
  }catch(err){ console.warn('Directory handle unavailable', err); }
  return null;
}

function sanitizeFileSegment(s){ return String(s).replace(/[\\/:*?"<>|]+/g,'_').trim()||'Untitled'; }

// Generic version of the photo-folder writer — same root handle, arbitrary subfolder/filename/blob.
// savePhotoToDeviceFolder() is a thin wrapper over this for the (no subfolder) photos case.
async function saveToDeviceFolder(projectName, subfolder, filename, blob){
  const root=await ensurePhotoDirHandle();
  if(!root) return false;
  try{
    let dir=await root.getDirectoryHandle(sanitizeFileSegment(projectName),{create:true});
    if (subfolder) dir=await dir.getDirectoryHandle(sanitizeFileSegment(subfolder),{create:true});
    const fileHandle=await dir.getFileHandle(filename,{create:true});
    const writable=await fileHandle.createWritable();
    await writable.write(blob); await writable.close();
    return true;
  }catch(err){ console.warn('Device save failed', err); return false; }
}

async function savePhotoToDeviceFolder(projectName, filename, blob){
  return saveToDeviceFolder(projectName, null, filename, blob);
}


// ══ AUTO-EXPORT TO DEVICE FOLDER (GeoJSON + CSV) ══
// Reuses the same directory handle/permission flow as photo device-saving — one folder picker
// covers both. Triggered after every feature save/delete/import (see finalizeSaveFeature,
// deleteFeature, clearAll, applyImport) rather than on a timer, so the folder is never more than
// one capture stale. Writes fixed "_latest" filenames — this runs constantly, so timestamped
// files would fill the folder with hundreds of near-duplicates over a working day; anyone wanting
// a dated snapshot still has the manual Export buttons below for that.
function getAutoExportPref(){ return localStorage.getItem('plotedge-autoexport-device')==='1'; }

async function toggleAutoExport(on){
  if (on) {
    let root = await ensurePhotoDirHandle();
    if (!root) await chooseDeviceFolder();
    if (!(await ensurePhotoDirHandle())) { document.getElementById('autoExportToggle').checked=false; return; }
  }
  localStorage.setItem('plotedge-autoexport-device', on ? '1' : '0');
  const status = document.getElementById('autoExportStatus');
  if (status) status.textContent = on ? 'Will save after every capture, edit, or delete' : '';
  if (on) maybeAutoExportToDevice();
}

let autoExportInFlight = false, autoExportPending = false;

async function maybeAutoExportToDevice(){
  if (!getAutoExportPref() || !activeProjectId) return;
  if (autoExportInFlight) { autoExportPending = true; return; } // coalesce rapid back-to-back saves
  autoExportInFlight = true;
  const status = document.getElementById('autoExportStatus');
  try {
    const projName = (projects.find(x=>x.id===activeProjectId)||{}).name || 'Project';
    if (!savedFeatures.length) return;
    const layers = collectFeatureCollectionsByType();
    for (const layer of layers) {
      const blob = new Blob([JSON.stringify(layer.fc, null, 2)], {type:'application/json'});
      await saveToDeviceFolder(projName, 'exports', `${sanitizeFileSegment(layer.label)}_latest.geojson`, blob);
    }
    const csvBlob = new Blob([buildCSVString()], {type:'text/csv'});
    await saveToDeviceFolder(projName, 'exports', `${sanitizeFileSegment(projName)}_latest.csv`, csvBlob);
    if (status) status.textContent = `✓ Last saved ${new Date().toLocaleTimeString()}`;
  } catch(e) {
    if (status) status.textContent = 'Auto-export failed. Will retry on the next capture.';
  } finally {
    autoExportInFlight = false;
    if (autoExportPending) { autoExportPending = false; maybeAutoExportToDevice(); }
  }
}


// Called right after a photo is captured — kicks off whichever backup paths are turned on.
// Never blocks the capture UI: everything here runs in the background off the already-saved
// local dataUrl.
function queuePhotoForBackup(photo, vertex){
  const wantsDevice = localStorage.getItem('plotedge-save-to-device')==='1';
  const endpoint = getCloudEndpoint();
  if(!wantsDevice && !endpoint) return;
  fetch(photo.dataUrl).then(r=>r.blob()).then(blob=>{
    if(wantsDevice){
      const projName=(projects.find(x=>x.id===activeProjectId)||{}).name||'Project';
      const filename=sanitizeFileSegment(photo.name||('photo_'+photo.id))+(/\.[a-z0-9]+$/i.test(photo.name||'')?'':'.jpg');
      savePhotoToDeviceFolder(projName, filename, blob).then(ok=>{
        photo.savedToDevice=!!ok;
        persist(); renderVertexPhotos(); renderFeatures();
      });
    }
    if(endpoint){
      photo.uploadStatus='queued';
      const q=loadUploadQueue();
      q.push({photoId:photo.id, projectId:activeProjectId, lat:vertex.lat, lon:vertex.lon, takenAt:photo.takenAt, name:photo.name, attempts:0});
      saveUploadQueue(q);
      updateCloudQueueStatus();
      processUploadQueue();
    }
  }).catch(err=>console.warn('Photo backup prep failed', err));
}


// ══ AI PHOTO RECOGNITION ══ — same bring-your-own-endpoint shape as cloud backup above. PlotEdge
// never talks to a vision API directly (that would mean shipping an API key in client code); it
// posts the photo to a URL the person supplies and reads back a label. Best-effort and additive,
// same as backup: a failed/unset endpoint just means no label, never a lost or blocked photo.
function getAiEndpoint(){ return localStorage.getItem('plotedge-ai-endpoint')||''; }

function saveAiEndpoint(){
  const url=document.getElementById('aiEndpointInput').value.trim();
  localStorage.setItem('plotedge-ai-endpoint', url);
  showToast(url?'Recognition endpoint saved':'Recognition endpoint cleared');
  updateAiEndpointStatus();
}

function updateAiEndpointStatus(){
  const el=document.getElementById('aiEndpointStatus'); if(!el) return;
  el.textContent = getAiEndpoint() ? 'New photos will be sent for recognition.' : 'No endpoint set. Photos won\'t be auto-labeled.';
}

function queuePhotoForRecognition(photo, vertex){
  const endpoint = getAiEndpoint();
  if(!endpoint) return;
  photo.aiStatus='pending';
  fetch(endpoint, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ image: photo.dataUrl, photoId: photo.id })
  }).then(r=>r.json()).then(data=>{
    photo.aiLabel = (data && data.label) ? String(data.label).slice(0,60) : null;
    photo.aiStatus = photo.aiLabel ? 'done' : 'failed';
    persist(); renderVertexPhotos(); renderFeatures();
  }).catch(err=>{
    photo.aiStatus='failed';
    console.warn('Photo recognition failed', err);
  });
}


// Small overlay icon(s) shown on a photo thumbnail reflecting its current backup state.
function photoAiLabelHtml(p){
  return p.aiLabel ? `<span class="ph-ai-label" title="AI recognition: ${escapeHtml(p.aiLabel)}">${escapeHtml(p.aiLabel)}</span>` : '';
}

function photoStatusBadge(p){
  const badges=[];
  if(p.savedToDevice) badges.push('<span class="ph-badge" title="Saved to device folder">📁</span>');
  if(getCloudEndpoint()){
    const map={queued:['⏳','Queued for cloud backup'],syncing:['⏳','Uploading…'],synced:['☁️','Backed up to cloud'],failed:['⚠️','Cloud backup failed, will retry']};
    const s=map[p.uploadStatus];
    if(s) badges.push(`<span class="ph-badge" title="${s[1]}">${s[0]}</span>`);
  }
  return badges.length?`<div class="ph-badges">${badges.join('')}</div>`:'';
}

function initPhotoBackupSettings(){
  document.getElementById('cloudEndpointInput').value=getCloudEndpoint();
  updateCloudQueueStatus();
  document.getElementById('aiEndpointInput').value=getAiEndpoint();
  updateAiEndpointStatus();
  const wantsDevice=localStorage.getItem('plotedge-save-to-device')==='1';
  document.getElementById('saveToDeviceToggle').checked=wantsDevice;
  if(wantsDevice){
    ensurePhotoDirHandle().then(h=>{
      document.getElementById('deviceFolderStatus').textContent = h ? `✓ Saving into "${h.name}/<Project name>/…"` : 'Folder access needs to be re-granted. Tap "Choose folder…" again.';
    });
  }
  const wantsAutoExport=getAutoExportPref();
  document.getElementById('autoExportToggle').checked=wantsAutoExport;
  if(wantsAutoExport){
    ensurePhotoDirHandle().then(h=>{
      document.getElementById('autoExportStatus').textContent = h ? 'Will save after every capture, edit, or delete' : 'Folder access needs to be re-granted. Tap "Choose folder…" again.';
    });
  }
  processUploadQueue();
}
