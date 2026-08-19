// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Photo capture pipeline, watermark, thumbnails, lightbox, swipe-to-delete
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ VERTEX DETAILS: per-vertex photos (tagged with an optional angle/view label) ══
function renderVertexEditor() {
  const card = document.getElementById('vertexEditorCard');
  if (openVertexIndex===null || !currentVertices[openVertexIndex]) { card.style.display='none'; syncCollectVertexPill(false); updateCapturePhotoBadge(); return; }
  card.style.display='';
  syncCollectVertexPill(true);
  const v = currentVertices[openVertexIndex];
  const geo = getCurrentGeometryType();
  const n = currentVertices.length;
  const roleSuffix = (geo==='line'||geo==='polygon') && n>=2
    ? (openVertexIndex===0 ? ' · Start' : openVertexIndex===n-1 ? ' · End' : '')
    : '';
  document.getElementById('vertexEditorNum').textContent = `Vertex ${openVertexIndex+1}${roleSuffix}`;
  const container = document.getElementById('vertexAttrFields');
  container.innerHTML = activeVertexFields.length
    ? activeVertexFields.map(a => renderVertexAttrField(a, openVertexIndex, v.attrs ? v.attrs[a.id] : undefined)).join('')
    : '';
  renderVertexPhotos();
  // Attributes + photo capture for a vertex are meant to feel like one step, not two — so instead
  // of leaving this card wherever it falls below the (potentially long) vertex list, bring it into
  // view and flash it whenever it opens (fresh capture, tapping Edit on a vertex, undo-restore,
  // etc.), so what to fill in next is always obvious without a scroll-hunt.
  requestAnimationFrame(()=>{
    card.scrollIntoView({behavior:'smooth', block:'center'});
    card.classList.remove('vertex-editor-flash');
    void card.offsetWidth; // restart the animation even if it's already mid-flash from a rapid prior open
    card.classList.add('vertex-editor-flash');
  });
}

// Looks up the geometry type of whichever feature type is currently selected on the Collect tab
// (point/line/polygon) — used to decide whether Start/End role labels make sense on the vertex
// list (only meaningful for multi-vertex line/polygon features).
function getCurrentGeometryType(){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel && !sel.disabled ? getFeatureType(sel.value) : null;
  return ft ? ft.geometryType : null;
}

// ══ PHOTO WATERMARK (optional) ══
// Burns a small coordinate/timestamp/heading strip into the bottom of the photo itself, on the
// same canvas already used for resizing — so turning it on costs nothing extra beyond a couple of
// canvas draw calls. Off by default (keeps photos clean unless the crew wants field-stamped
// evidence); the checkbox preference persists across sessions.
const WATERMARK_KEY = 'plotedge_watermark';

function getWatermarkPref(){ try { return localStorage.getItem(WATERMARK_KEY) === '1'; } catch(e) { return false; } }

function setWatermarkPref(on){ try { localStorage.setItem(WATERMARK_KEY, on ? '1' : '0'); } catch(e) {} }

function drawPhotoWatermark(canvas, vertex, heading){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const lines = [];
  if (vertex && vertex.lat != null) lines.push(`${vertex.lat.toFixed(6)}, ${vertex.lon.toFixed(6)}`);
  lines.push(new Date().toLocaleString());
  if (heading != null) lines.push(headingLabel(heading));
  const fontSize = Math.max(11, Math.round(w / 42));
  const lineHeight = fontSize * 1.35;
  const padding = fontSize * 0.7;
  const barHeight = lines.length * lineHeight + padding;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, h - barHeight, w, barHeight);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${fontSize}px -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, padding, h - barHeight + padding/2 + i*lineHeight));
}


// Routes the "Tap to Take / Add Photo" button. In the Android app (Capacitor native), the plain
// <input type="file" capture="environment"> below goes through the WebView's file-chooser
// heuristics, which have a long history of flaky/inconsistent behavior across Android WebView
// versions and OEM skins — even with the CAMERA permission correctly granted, it can silently
// fall back to a picker, a broken intent, or nothing at all. Capacitor's own Camera plugin talks
// to the native camera Activity directly and sidesteps that entirely, so we use it whenever we're
// actually running as the native app. The file input remains the fallback for the plain
// browser/PWA install, where there is no native plugin to call.
function openVertexPhotoCapture() {
  if (openVertexIndex===null) return;
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const CameraPlugin = isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
  if (!CameraPlugin) { document.getElementById('vertexPhotoInput').click(); return; }
  CameraPlugin.getPhoto({
    resultType: 'dataUrl',
    source: 'CAMERA',
    quality: 85,
    saveToGallery: false,
    correctOrientation: true
  }).then(result=>{
    if (result && result.dataUrl) addVertexPhotoFromDataUrl(result.dataUrl, 'camera.jpg');
  }).catch(err=>{
    // User cancelled the native camera sheet, or (rarely) the plugin itself failed to launch —
    // either way there's nothing to add, and no need to bother the user with an error toast for
    // a plain cancel. Fall back to the file-input path only on an actual plugin failure.
    if (err && err.message && /cancel/i.test(err.message)) return;
    document.getElementById('vertexPhotoInput').click();
  });
}


// Shared by both photo-intake paths below: resizes to a sane max dimension, applies the
// optional GPS/heading watermark, and appends the finished photo record to the open vertex.
// ══ PHOTO:BEGIN ══
// ══════════════════════════════════════════════════════════════════════════════
// PHOTO CAPTURE — WHY THIS USED TO CRASH THE APP
// ══════════════════════════════════════════════════════════════════════════════
// Adding several photos to one vertex would kill the app outright. Three things
// were happening at once, all of them memory:
//
//   1. handleVertexPhotos() fired every FileReader AT THE SAME TIME. Picking ten
//      photos meant ten full-resolution base64 strings alive simultaneously —
//      a 12 MP phone photo is ~4 MB of JPEG, so ~5.5 MB as a data URL, ten of
//      them ~55 MB of pure string.
//   2. Each then got assigned to an Image, which DECODES AT FULL RESOLUTION
//      before the downscale. A 12 MP bitmap is 12M pixels x 4 bytes = ~48 MB of
//      RAM. Ten decoding in parallel is ~480 MB. An Android WebView renderer is
//      killed long before that, which is the crash: not an exception the app
//      could catch and report, but the OS reclaiming the process.
//   3. persist() ran per photo, re-serialising the whole store each time.
//
// The fix for (1) and (2) is the same idea: never hold more than one image, and
// never decode at a size we are about to throw away. createImageBitmap() with
// resize options decodes STRAIGHT to the target dimensions — the full-size
// bitmap is never materialised — and takes the File directly, so the
// full-resolution data URL is never created either. Queueing makes it one at a
// time. Measured peak drops from hundreds of megabytes to a few.
//
// (3) is handled in persistStore() — see the write-guard notes there.
const PHOTO_MAX_EDGE = 1200;          // stored image, long edge

const PHOTO_THUMB_EDGE = 220;         // list/grid image — see makeThumb()

const PHOTO_QUALITY = 0.75;

const PHOTO_THUMB_QUALITY = 0.55;

// A soft cap, not a rule of physics: the point is to stop a runaway session
// silently filling the quota, and to tell the crew before it costs them work.
const PHOTO_MAX_PER_VERTEX = 24;


// One-at-a-time queue. Photos are appended in the order they were selected.
let _photoQueue = Promise.resolve();

// Exposed because the queue is now the only thing that knows whether capture
// work is still outstanding: an export or a backup taken mid-queue would miss
// photos that are encoded but not yet stored.
function photoQueueIdle() { return _photoQueue; }

function enqueuePhotoWork(fn) {
  _photoQueue = _photoQueue.then(fn).catch(err => {
    console.error('PlotEdge: photo processing failed', err);
    showToast('That photo could not be processed');
  });
  return _photoQueue;
}


// Decodes to a canvas at no more than `maxEdge`, preferring the path that never
// builds the full-size bitmap. `src` may be a File/Blob or a data URL string.
async function decodeToCanvas(src, maxEdge) {
  if (typeof createImageBitmap === 'function' && typeof src !== 'string') {
    // Probe the intrinsic size cheaply, then decode once at the target size.
    let probe = null;
    try {
      probe = await createImageBitmap(src);
      const scale = Math.min(1, maxEdge / Math.max(probe.width, probe.height));
      const w = Math.max(1, Math.round(probe.width * scale));
      const h = Math.max(1, Math.round(probe.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(probe, 0, 0, w, h);
      return canvas;
    } finally {
      // Releasing the decoded bitmap immediately is the whole point; without
      // this it lingers until GC decides to run, which on a device under
      // memory pressure is exactly too late.
      if (probe && probe.close) probe.close();
    }
  }
  // Fallback for engines without createImageBitmap, and for the data-URL entry
  // points (Capacitor camera). Same result, higher peak — still one at a time.
  return await new Promise((resolve, reject) => {
    const img = new Image();
    let objUrl = null;
    const cleanup = () => {
      img.src = '';                      // drop the decoded bitmap's last reference
      // An object URL pins the whole Blob in memory until it is revoked, so
      // skipping this leaks the original full-size photo once per capture —
      // invisible per shot, fatal over a long session.
      if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
    };
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cleanup();
      resolve(canvas);
    };
    // Previously absent: a photo that failed to decode vanished silently and
    // the multi-select counter never completed.
    img.onerror = () => { cleanup(); reject(new Error('image decode failed')); };
    if (typeof src === 'string') { img.src = src; }
    else { objUrl = URL.createObjectURL(src); img.src = objUrl; }
  });
}


// A separate small image for grids and lists. Lists were rendering the full
// 1200px dataUrl in every <img>, and the browser decodes each one to a real
// bitmap: 1200x900 is ~4.3 MB of RAM apiece, so a review screen with twenty
// photos was holding ~86 MB just to show thumbnails. At 220px that is ~35x
// less, for about 8 KB of extra storage per photo.
function makeThumb(canvas) {
  const scale = Math.min(1, PHOTO_THUMB_EDGE / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const url = t.toDataURL('image/jpeg', PHOTO_THUMB_QUALITY);
  t.width = t.height = 0;
  return url;
}

// Canvases are not freed promptly by GC on Android WebView; zeroing the
// dimensions releases the backing store immediately.
function releaseCanvas(c) { if (c) { c.width = 0; c.height = 0; } }


function addVertexPhoto(src, filename, silent) {
  const vIdx = openVertexIndex;
  if (vIdx === null || !currentVertices[vIdx]) return Promise.resolve(false);
  const headingAtCapture = lastCompassHeading;
  const watermarkOn = getWatermarkPref();
  return enqueuePhotoWork(async () => {
    const vertex = currentVertices[vIdx];
    if (!vertex) return false;                       // vertex deleted while queued
    vertex.photos = vertex.photos || [];
    if (vertex.photos.length >= PHOTO_MAX_PER_VERTEX) {
      showToast(`This vertex already has ${PHOTO_MAX_PER_VERTEX} photos. The cap for one point`);
      return false;
    }
    // Refuse before doing the work, not after: encoding a photo only to fail
    // the save wastes the memory that is already scarce at this point.
    // Two budgets are checked, because there are now two. getStorageUsageInfo()
    // is the project *records* (localStorage, ~5 MB of text — photos no longer
    // land here at all, so in practice this only trips on a genuinely enormous
    // attribute set). The media store is the one photos consume, and it is
    // measured against the origin quota the browser actually granted.
    const usage = getStorageUsageInfo();
    if (usage.percent >= 92) {
      showToast('Storage almost full. Export this project before adding more photos');
      return false;
    }
    const media = (typeof getMediaUsageInfo === 'function') ? getMediaUsageInfo() : null;
    if (media && media.known && media.percent >= 92) {
      showToast('Device storage almost full. Export this project before adding more photos');
      return false;
    }
    let canvas = null;
    try {
      canvas = await decodeToCanvas(src, PHOTO_MAX_EDGE);
      if (!currentVertices[vIdx]) return false;
      if (watermarkOn) drawPhotoWatermark(canvas, currentVertices[vIdx], headingAtCapture);
      const photo = {
        id: 'ph_' + Date.now() + '_' + Math.random().toString(36).slice(2,8),
        dataUrl: canvas.toDataURL('image/jpeg', PHOTO_QUALITY),
        thumbUrl: makeThumb(canvas),
        cloudUrl: null, name: filename, takenAt: new Date().toISOString(),
        heading: headingAtCapture, angleLabel: '', uploadStatus: 'local',
        savedToDevice: false, aiLabel: null, aiStatus: null
      };
      currentVertices[vIdx].photos.push(photo);
      // The bytes go to the media store (IndexedDB); persist() below writes only
      // the record. Not awaited: the in-memory photo already carries the image,
      // so the grid, the capture badge and the vertex list are all correct the
      // instant this returns, and the disk write catches up behind them.
      // typeof-guarded because the photo pipeline is lifted out and executed
      // standalone by tests/photo.test.js, where the media store isn't present.
      // Awaited, not fired and forgotten. persist() runs two lines down, and the
      // store may only drop a photo's bytes once the media store confirms it has
      // them (see photoStripFields in js/04-store.js) — so waiting here is what
      // lets the very first write of a new photo already be the small one. It is
      // a few milliseconds inside a queue that is already serialised.
      if (typeof photoStoreSave === 'function') await photoStoreSave(photo);
      queuePhotoForBackup(photo, currentVertices[vIdx]);
      queuePhotoForRecognition(photo, currentVertices[vIdx]);
      // If the save is refused (quota), take the photo back out rather than
      // leaving the screen showing something that is not on disk.
      if (persist() === false) {
        const i = currentVertices[vIdx].photos.indexOf(photo);
        if (i !== -1) currentVertices[vIdx].photos.splice(i, 1);
        renderVertexPhotos();
        return false;
      }
      renderVertexPhotos(); renderPoints(); updateCaptureStrip();
      if (!silent) showToast('Photo added');
      return true;
    } finally {
      releaseCanvas(canvas);
    }
  });
}

// Kept as a named entry point: the Capacitor camera path hands over a data URL.
function addVertexPhotoFromDataUrl(dataUrl, filename, silent) {
  return addVertexPhoto(dataUrl, filename, silent);
}


function handleVertexPhotos(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';                                // release the picker's refs at once
  if (!files.length || openVertexIndex === null) return;
  const multi = files.length > 1;
  if (multi) showToast(`Adding ${files.length} photos…`);
  let added = 0;
  // Files are passed through as File objects, NOT read into data URLs here.
  // decodeToCanvas() consumes them one at a time, so only one image is ever in
  // flight regardless of how many were selected.
  files.forEach(file => {
    addVertexPhoto(file, file.name, true).then(ok => { if (ok) added++; });
  });
  if (multi) enqueuePhotoWork(async () => { showToast(`${added} of ${files.length} photos added`); });
}

// ══ PHOTO:END ══
function deleteVertexPhoto(i){
  if (openVertexIndex===null || !currentVertices[openVertexIndex]) return;
  const vIdx = openVertexIndex;
  const vertex = currentVertices[vIdx];
  const [removed] = vertex.photos.splice(i,1);
  persist(); renderVertexPhotos(); renderPoints(); updateCaptureStrip();
  showUndoToast('Photo deleted', () => {
    if (currentVertices[vIdx]) {
      currentVertices[vIdx].photos.splice(i,0,removed);
      persist(); renderVertexPhotos(); renderPoints(); updateCaptureStrip();
      showToast('Photo restored');
    }
  });
}

function setVertexPhotoAngleLabel(i, val){
  if (openVertexIndex===null || !currentVertices[openVertexIndex]) return;
  const ph = currentVertices[openVertexIndex].photos[i];
  if (ph) { ph.angleLabel = val; persist(); }
}

// ══ THUMBNAIL SOURCE ══
// Lists, grids, map popups and the story reel all show photos at 40-120px, but
// were pointing <img src> at the full 1200px dataUrl. The browser decodes each
// to a real bitmap regardless of the CSS size — ~4.3 MB of RAM per photo — so a
// review screen with twenty photos held ~86 MB purely to draw thumbnails, on top
// of whatever the capture flow was already using. This routes every small
// rendering at the 220px copy instead. Photos captured before thumbUrl existed
// fall back to the full image, so nothing breaks on existing projects.
// Three sources, in cost order. A photo captured this session still has its
// base64 in memory. A photo loaded from a previous session has neither field —
// persistStore() stripped them — and resolves to the object URL registered by
// the media store's boot preload pass, which is a short string pointing at a
// Blob the browser manages rather than a megabyte pinned in the JS heap.
const PHOTO_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function photoThumbSrc(p){
  if (!p) return '';
  return p.thumbUrl || p.dataUrl
    || (typeof photoCachedThumb === 'function' && photoCachedThumb(p.id))
    || (typeof photoCachedFull === 'function' && photoCachedFull(p.id))
    || PHOTO_PLACEHOLDER_SRC;
}

// The full-resolution source, for the lightbox and the PlotLens stage — the two
// places that legitimately want the big image. Falls back through the thumbnail
// so a photo whose blob is still being fetched shows something immediately
// rather than a broken-image box; photoEnsureFull() then upgrades it in place.
function photoFullSrc(p){
  if (!p) return '';
  return p.dataUrl
    || (typeof photoCachedFull === 'function' && photoCachedFull(p.id))
    || photoThumbSrc(p);
}

// Pulls the full blob out of the media store and registers an object URL for it,
// then hands back the URL so the caller can swap it in. Resolves to '' when
// there is nothing better than what photoFullSrc() already returned.
function photoEnsureFull(p){
  if (!p || !p.id) return Promise.resolve('');
  if (p.dataUrl) return Promise.resolve(p.dataUrl);
  if (typeof photoCachedFull === 'function' && photoCachedFull(p.id)) return Promise.resolve(photoCachedFull(p.id));
  if (typeof photoStoreGet !== 'function') return Promise.resolve('');
  return photoStoreGet(p.id).then(rec => {
    if (!rec || !rec.full) return '';
    return registerPhotoBlob(p.id, 'full', rec.full);
  }).catch(() => '');
}

function renderVertexPhotos(){
  if (openVertexIndex===null || !currentVertices[openVertexIndex]) return;
  const photos = currentVertices[openVertexIndex].photos || [];
  const grid=document.getElementById('vertexPhotoGrid');
  const n=photos.length;
  document.getElementById('vertexPhotoCount').textContent=n?`(${n})`:'';
  grid.innerHTML=photos.map((p,i)=>`
    <div class="photo-cell" data-idx="${i}">
      <div class="photo-thumb">
        <img src="${photoThumbSrc(p)}" alt="Photo ${i+1}" loading="lazy" decoding="async" onclick="openLightbox(currentVertices[openVertexIndex].photos, ${i})">
        <button class="ph-del" onclick="deleteVertexPhoto(${i})">×</button>
        <span class="ph-num">${i+1}</span>
        ${photoStatusBadge(p)}
        ${photoAiLabelHtml(p)}
        ${p.heading!=null?`<span class="ph-heading">${headingLabel(p.heading)}</span>`:''}
      </div>
      <input class="photo-angle-input" list="angleLabelSuggestions" placeholder="Angle / view label…" value="${escapeHtml(p.angleLabel||'')}" oninput="setVertexPhotoAngleLabel(${i},this.value)">
    </div>`).join('');
  updateCapturePhotoBadge();
}


// ══ PHOTO LIGHTBOX ══ — fullscreen tap-to-view, opened from either the in-progress vertex photo
// grid or a saved feature's photo thumbnails. Takes the *live* photos array (not a copy) so it
// always reflects the current angle-label/upload-status data if either changes underneath it.
let lightboxPhotos = [];

let lightboxIndex = 0;

function openLightbox(photos, idx){
  if (!photos || !photos.length) return;
  lightboxPhotos = photos;
  lightboxIndex = idx;
  renderLightbox();
  document.getElementById('photoLightbox').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function openFeatureVertexPhoto(featureId, vIdx, pIdx){
  const f = savedFeatures.find(x=>x.id===featureId);
  if (!f) return;
  const photos = (f.vertices||[])[vIdx]?.photos || [];
  openLightbox(photos, pIdx);
}

function closeLightbox(){
  document.getElementById('photoLightbox').classList.remove('show');
  document.body.style.overflow = '';
}

function lightboxNav(dir){
  if (!lightboxPhotos.length) return;
  lightboxIndex = (lightboxIndex + dir + lightboxPhotos.length) % lightboxPhotos.length;
  renderLightbox();
}

function renderLightbox(){
  const p = lightboxPhotos[lightboxIndex];
  if (!p) return;
  const img = document.getElementById('lightboxImg');
  // Paint whatever is already available (usually the thumbnail) so the viewer
  // never shows an empty frame, then swap in the full image the moment its blob
  // comes back out of the media store. The index check stops a slow read for
  // photo 3 from overwriting photo 4 after the user has already swiped on.
  const shownIndex = lightboxIndex;
  img.src = photoFullSrc(p);
  photoEnsureFull(p).then(url => {
    if (url && lightboxIndex === shownIndex && document.getElementById('photoLightbox').classList.contains('show')) img.src = url;
  });
  document.getElementById('lightboxCaption').textContent = [p.featureName, p.angleLabel].filter(Boolean).join(' · ');
  const multi = lightboxPhotos.length > 1;
  document.getElementById('lightboxCounter').textContent = multi ? `${lightboxIndex+1} / ${lightboxPhotos.length}` : '';
  document.getElementById('lightboxPrev').style.display = multi ? 'flex' : 'none';
  document.getElementById('lightboxNext').style.display = multi ? 'flex' : 'none';
}

(function(){
  const lb = document.getElementById('photoLightbox');
  const stage = document.getElementById('lightboxStage');
  if (!lb || !stage) return;
  // Tapping the dark backdrop (not the image itself) closes it
  lb.addEventListener('click', e=>{ if (e.target === lb) closeLightbox(); });
  // Swipe left/right between photos
  let startX=0, startY=0, dragging=false;
  stage.addEventListener('pointerdown', e=>{ startX=e.clientX; startY=e.clientY; dragging=true; });
  stage.addEventListener('pointerup', e=>{
    if (!dragging) return; dragging=false;
    const dx=e.clientX-startX, dy=e.clientY-startY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) lightboxNav(dx<0?1:-1);
  });
  document.addEventListener('keydown', e=>{
    if (!lb.classList.contains('show')) return;
    if (e.key==='Escape') closeLightbox();
    else if (e.key==='ArrowLeft') lightboxNav(-1);
    else if (e.key==='ArrowRight') lightboxNav(1);
  });
})();


// ══ LIVE CAPTURE STRIP (sticks under the header while scrolling a long capture) ══
function updateCaptureStrip(){
  const strip = document.getElementById('captureStrip');
  if (!strip) return;
  const onCollect = document.getElementById('panel-collect').classList.contains('active');
  if (!onCollect || !currentVertices.length){ strip.classList.remove('show'); return; }
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel && !sel.disabled ? getFeatureType(sel.value) : null;
  const label = ft ? ft.name : 'Feature';
  const nV = currentVertices.length;
  const nPh = currentVertices.reduce((s,v)=>s+((v.photos||[]).length),0);
  document.getElementById('captureStripText').textContent = `${label} · ${nV} vertex${nV===1?'':'es'} · ${nPh} photo${nPh===1?'':'s'}`;
  strip.classList.add('show');
}

// Tapping the strip jumps down to the vertex list, since that's the thing it's summarizing.
function scrollToVertexList(){
  const el = document.getElementById('pointsList');
  if (el) el.scrollIntoView({behavior:'smooth', block:'start'});
}


// ══ CAPTURE-BUTTON PHOTO BADGE ══
// Surfaces the currently-open vertex's photo count right on the Capture button, so it's obvious
// mid-flow — before tapping Capture again to move to the next vertex — whether this one still
// needs photos.
function updateCapturePhotoBadge(){
  const badge = document.getElementById('capturePhotoBadge');
  if (!badge) return;
  if (openVertexIndex===null || !currentVertices[openVertexIndex]){ badge.classList.remove('show','warn'); return; }
  const n = (currentVertices[openVertexIndex].photos||[]).length;
  badge.textContent = n ? `📷 ${n}` : 'No photo yet';
  badge.classList.toggle('warn', n===0);
  badge.classList.add('show');
}


// ══ SWIPE-TO-DELETE ══
// Delegated touch handling so it keeps working across re-renders (innerHTML swaps out the rows,
// but the listeners live on the stable parent container). A left swipe past the threshold commits
// the same delete as the × button, which already opens the Undo toast — so swiping is just a
// faster one-handed way to trigger the exact same soft-delete flow.
// ══ WHY THIS IGNORES THE SCREEN EDGES ══
// Android's system Back is an inward edge swipe, and from the right edge that is a leftward
// drag — the identical motion to swipe-to-delete. Performed over the vertex list it armed and
// committed a delete, which is why going Back "undid" a capture. Worse, the gesture that the
// system claims ends in `touchcancel`, and touchcancel was wired to the same finish() as
// touchend — so the delete fired on precisely the presses where the user was navigating, not
// deleting. Two rules fix it: a gesture that begins in either edge gutter belongs to the OS and
// is never ours, and a cancelled gesture is a cancellation, never a commit.
const SWIPE_EDGE_GUTTER_PX = 32;   // a little wider than Android's own ~24dp back-gesture inset

function attachSwipeToDelete(containerId, itemSelector, onDelete){
  const container = document.getElementById(containerId);
  if (!container || container._swipeAttached) return;
  container._swipeAttached = true;
  const THRESHOLD = 96;   // raised: a deliberate flick, not a drifted scroll
  let el=null, startX=0, startY=0, dx=0, dragging=false;
  const reset = () => {
    if (el){ el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; el.classList.remove('swipe-armed'); }
    el = null; dragging = false; dx = 0;
  };
  container.addEventListener('touchstart', e=>{
    const item = e.target.closest(itemSelector);
    if (!item || e.target.closest('button,input,a')) { el=null; return; }
    const x = e.touches[0].clientX;
    // Started in the OS gesture gutter — this stroke is a navigation, so take no part in it.
    if (x <= SWIPE_EDGE_GUTTER_PX || x >= (window.innerWidth - SWIPE_EDGE_GUTTER_PX)) { el=null; return; }
    el = item; startX = x; startY = e.touches[0].clientY; dx=0; dragging=false;
  }, {passive:true});
  container.addEventListener('touchmove', e=>{
    if (!el) return;
    const t = e.touches[0];
    const mdx = t.clientX-startX, mdy = t.clientY-startY;
    // Must be decisively horizontal (not merely more horizontal than vertical) before the row
    // starts moving, so a thumb scrolling a long vertex list never drifts into an armed delete.
    if (!dragging && mdx < -12 && Math.abs(mdx) > Math.abs(mdy) * 2) dragging = true;
    if (!dragging) return;
    dx = Math.min(0, Math.max(mdx, -140));
    el.style.transition = 'none';
    el.style.transform = `translateX(${dx}px)`;
    el.classList.toggle('swipe-armed', dx <= -THRESHOLD);
  }, {passive:true});
  container.addEventListener('touchend', () => {
    if (!el) return;
    if (dragging && dx <= -THRESHOLD){
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      const row = el;
      row.style.transition = '';
      row.style.transform = 'translateX(-100%)';
      row.style.opacity = '0';
      el = null; dragging = false; dx = 0;
      setTimeout(()=> onDelete(idx), 140);
      return;
    }
    reset();
  });
  // Cancelled, not completed. The OS took the gesture (back swipe, notification pull, incoming
  // call); the row goes back where it was and nothing is deleted.
  container.addEventListener('touchcancel', reset);
}
