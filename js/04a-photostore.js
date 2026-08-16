// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Photo media store (IndexedDB), the fix for the 5 MB capture ceiling
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ══════════════════════════════════════════════════════════════════════════════
// Photos used to live inside the project store, as base64 `dataUrl` strings, in
// localStorage. localStorage is a ~5 MB budget on the tightest common device,
// and base64 inflates every byte by 33%. A single 1200px JPEG lands at roughly
// 150-250 KB encoded, so the real ceiling was somewhere around twenty photos —
// which is exactly what was reported: two features saved fine, the third stopped
// keeping its pictures. The rolling backup made it worse by holding a second
// copy of the same bytes in the same budget.
//
// The fix is to stop putting binary in a text key/value store. Photo bytes now
// live in IndexedDB as real Blobs, keyed by the photo's id:
//
//   • IndexedDB is quota-managed per origin, not per-key. On Android WebView and
//     Chrome that is a share of free disk (hundreds of MB to GB), not 5 MB.
//   • Blobs are stored as bytes, so the 33% base64 tax disappears entirely.
//   • The browser can page a Blob to disk. A base64 string cannot be paged — it
//     is a live JS string pinned in the renderer's heap, which is the other half
//     of why long photo sessions were killing the WebView.
//
// localStorage keeps only the *record*: id, filename, timestamps, heading, angle
// label, upload state. About 200 bytes per photo instead of 200 KB — a thousand
// times smaller. A project of 100 features, 7 vertices each, with photos on every
// vertex now costs a few hundred KB of localStorage, comfortably inside budget.
//
// Nothing above this layer had to become async to *render*: persistStore() strips
// `dataUrl`/`thumbUrl` on the way out (see photoStripFields in js/04-store.js),
// the bytes go to IndexedDB, and everything that draws a photo reads an object
// URL out of the cache below — a short string that costs nothing to hold. Code
// that genuinely needs the base64 back (exports, backups, cloud upload) calls
// photoStoreHydrate() first, which puts `dataUrl` back on the record in memory
// only; the next save strips it again, so a hydrated photo can never leak back
// into localStorage.
const PHOTO_DB_NAME = 'plotedge-media';

const PHOTO_DB_VERSION = 1;

const PHOTO_OS = 'photos';

let _photoDbPromise = null;

// Set once if IndexedDB is missing or refuses to open (private browsing on some
// engines, a corrupt profile). Everything below then degrades to "no media
// store": photos still work for the session, and persistStore() keeps stripping
// them, so the app never regresses to filling localStorage with base64.
let photoStoreBroken = false;

function photoStoreAvailable() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB && !photoStoreBroken; }
  catch (e) { return false; }
}

function photoDb() {
  if (!photoStoreAvailable()) return Promise.resolve(null);
  if (_photoDbPromise) return _photoDbPromise;
  _photoDbPromise = new Promise(resolve => {
    let req;
    try { req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION); }
    catch (e) { photoStoreBroken = true; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_OS)) db.createObjectStore(PHOTO_OS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { photoStoreBroken = true; resolve(null); };
    req.onblocked = () => resolve(null);
  });
  return _photoDbPromise;
}

// Every read/write goes through here so a transaction failure is a resolved
// null rather than an unhandled rejection — a media-store hiccup must never be
// able to break a capture.
function photoIdb(mode, fn) {
  return photoDb().then(db => {
    if (!db) return null;
    return new Promise(resolve => {
      let tx;
      try { tx = db.transaction(PHOTO_OS, mode); }
      catch (e) { resolve(null); return; }
      const store = tx.objectStore(PHOTO_OS);
      let out = null;
      try { out = fn(store, v => { out = v; }); } catch (e) { resolve(null); return; }
      tx.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  }).catch(() => null);
}

function reqValue(request) { return { __req: request }; }


// ══ OBJECT-URL CACHE ══
// An object URL is a short string; the Blob behind it stays under the browser's
// management rather than in the JS heap. That is what lets every list, grid,
// popup and map marker keep rendering synchronously from a plain <img src>
// without holding a megabyte of base64 per photo the way the old code did.
const _photoUrls = new Map();   // id -> { thumb?:string, full?:string }

// ══ THE STRIP INTERLOCK ══
// Ids whose bytes are confirmed in IndexedDB — populated by the boot preload
// pass (everything already there) and by each successful write. js/04-store.js
// consults this before dropping a photo's base64 on the way to localStorage, so
// the bytes can never be removed from one store before they exist in the other.
//
// Deliberately conservative in both failure directions: an id that is not in
// here keeps its base64 (larger write, no loss), and if IndexedDB is unavailable
// entirely nothing is ever stripped, so the app degrades to its old behaviour
// rather than to silent data loss.
const _photoBytesOnDisk = new Set();

function photoBytesOnDisk(id) {
  if (!photoStoreAvailable()) return false;
  return _photoBytesOnDisk.has(id);
}

function photoUrlEntry(id) {
  let e = _photoUrls.get(id);
  if (!e) { e = {}; _photoUrls.set(id, e); }
  return e;
}

function photoCachedThumb(id) { const e = _photoUrls.get(id); return (e && e.thumb) || ''; }

function photoCachedFull(id) { const e = _photoUrls.get(id); return (e && e.full) || ''; }

function registerPhotoBlob(id, which, blob) {
  if (!blob || typeof URL === 'undefined' || !URL.createObjectURL) return '';
  const e = photoUrlEntry(id);
  if (e[which]) return e[which];
  try { e[which] = URL.createObjectURL(blob); } catch (err) { return ''; }
  return e[which];
}

function releasePhotoUrls(id) {
  const e = _photoUrls.get(id);
  if (!e) return;
  try {
    if (e.thumb) URL.revokeObjectURL(e.thumb);
    if (e.full) URL.revokeObjectURL(e.full);
  } catch (err) {}
  _photoUrls.delete(id);
}


// ══ CONVERSION ══
// fetch() on a data: URL is the shortest correct decoder available in a WebView
// and does the base64 work off the main thread. atob()+Uint8Array is kept as the
// fallback for the rare engine that refuses to fetch data: URLs.
function photoDataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return Promise.resolve(null);
  if (typeof fetch === 'function') {
    return fetch(dataUrl).then(r => r.blob()).catch(() => photoDataUrlToBlobSync(dataUrl));
  }
  return Promise.resolve(photoDataUrlToBlobSync(dataUrl));
}

function photoDataUrlToBlobSync(dataUrl) {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const head = dataUrl.slice(0, comma);
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (e) { return null; }
}

function photoBlobToDataUrl(blob) {
  return new Promise(resolve => {
    if (!blob) { resolve(''); return; }
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    } catch (e) { resolve(''); }
  });
}


// ══ WRITE ══
// Called right after a photo is built, from addVertexPhoto(). Deliberately fire
// and forget from the caller's point of view: the in-memory record already has
// the image, so the capture UI is correct immediately and the disk write catches
// up. The returned promise exists so exports/backups can await quiescence.
let _photoWriteChain = Promise.resolve();

function photoStoreIdle() { return _photoWriteChain; }

function photoStoreSave(photo) {
  if (!photo || !photo.id) return Promise.resolve(false);
  const id = photo.id, full = photo.dataUrl, thumb = photo.thumbUrl;
  const job = Promise.all([photoDataUrlToBlob(full), photoDataUrlToBlob(thumb)])
    .then(([fullBlob, thumbBlob]) => {
      if (!fullBlob) return false;
      // Registering the object URLs here (not only on the boot preload pass)
      // means a photo captured this session keeps rendering after its base64
      // fields are shed on save — otherwise the thumbnail would blank out the
      // moment the feature was written.
      registerPhotoBlob(id, 'full', fullBlob);
      if (thumbBlob) registerPhotoBlob(id, 'thumb', thumbBlob);
      return photoIdb('readwrite', store => reqValue(store.put({ full: fullBlob, thumb: thumbBlob || null }, id)))
        .then(() => {
          // Only now may the project store drop this photo's base64. Marking it
          // before the transaction completed would reopen the same window the
          // interlock exists to close.
          _photoBytesOnDisk.add(id);
          return true;
        });
    })
    .catch(() => false);
  _photoWriteChain = _photoWriteChain.then(() => job).catch(() => false);
  return job;
}


// ══ READ ══
function photoStoreGet(id) {
  if (!id) return Promise.resolve(null);
  return photoIdb('readonly', store => reqValue(store.get(id)));
}

// Preloads every thumbnail as an object URL in one cursor pass at boot. A
// thumbnail is ~8 KB, so even a thousand-photo device is a few megabytes of
// browser-managed Blob and a thousand short strings — and it means the first
// paint of Review, the map and the dashboard is synchronous, exactly as before.
function photoStorePreloadThumbs() {
  return photoIdb('readonly', store => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const rec = cur.value || {};
      if (rec.full) _photoBytesOnDisk.add(cur.key);
      if (rec.thumb) registerPhotoBlob(cur.key, 'thumb', rec.thumb);
      cur.continue();
    };
    return null;
  }).then(() => _photoUrls.size);
}

// Puts `dataUrl` back on each photo record, in memory only. Exports, backups and
// cloud uploads all read that field; rather than rewrite every one of them to be
// blob-aware, they call this first and then run unchanged. persistStore() strips
// the field again on the next save, so a hydrated record can never be written
// back into localStorage.
function photoStoreHydrate(photos) {
  const list = (photos || []).filter(p => p && p.id && !p.dataUrl);
  if (!list.length) return Promise.resolve(0);
  let done = 0;
  return list.reduce((chain, p) => chain.then(() => photoStoreGet(p.id)).then(rec => {
    if (!rec || !rec.full) return;
    return photoBlobToDataUrl(rec.full).then(url => {
      if (url) { p.dataUrl = url; done++; }
      if (!p.thumbUrl && rec.thumb) return photoBlobToDataUrl(rec.thumb).then(t => { if (t) p.thumbUrl = t; });
    });
  }), Promise.resolve()).then(() => done);
}

// The other half of hydrate. Base64 held for an export is dead weight the moment
// the export finishes, and on a photo-heavy project it is tens of megabytes.
function photoStoreShed(photos) {
  (photos || []).forEach(p => {
    if (!p || !p.id) return;
    // Only shed what can be read back. A photo whose blob never reached the
    // media store must keep its in-memory copy, or the image is gone for the
    // rest of the session — and gone from the next save too.
    if (!photoBytesOnDisk(p.id)) return;
    delete p.dataUrl;
    delete p.thumbUrl;
  });
}

// Walks any mix of features / vertices / raw photo arrays and returns every
// photo record found. Used by hydrate + shed callers so none of them has to
// re-implement the vertices→photos traversal.
function collectPhotoRecords(...sources) {
  const out = [];
  const eat = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(eat); return; }
    if (node.photos) node.photos.forEach(p => { if (p) out.push(p); });
    if (node.vertices) node.vertices.forEach(eat);
    if (node.savedFeatures) eat(node.savedFeatures);
    if (node.currentVertices) eat(node.currentVertices);
    // A bare photo record (has an id and no geometry of its own).
    if (node.id && (node.dataUrl !== undefined || node.takenAt !== undefined) && !node.vertices && !node.photos) out.push(node);
  };
  sources.forEach(eat);
  return out;
}


// ══ DELETE ══
function photoStoreDelete(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return Promise.resolve(0);
  list.forEach(id => { releasePhotoUrls(id); _photoBytesOnDisk.delete(id); });
  return photoIdb('readwrite', store => { list.forEach(id => store.delete(id)); return null; })
    .then(() => list.length);
}

// ══ ORPHAN SWEEP ══
// Blobs whose record no longer exists anywhere — a deleted feature, a deleted
// project, a restore that replaced a project wholesale. Rather than trying to
// hook every deletion path (and silently leaking on the one that gets added
// later), this reconciles the media store against the project store once at
// boot. Cheap: it reads keys, never values.
function photoStoreSweep(referencedIds) {
  const keep = referencedIds instanceof Set ? referencedIds : new Set(referencedIds || []);
  return photoIdb('readonly', store => reqValue(store.getAllKeys()))
    .then(keys => {
      if (!keys || !keys.length) return 0;
      const dead = keys.filter(k => !keep.has(k));
      if (!dead.length) return 0;
      return photoStoreDelete(dead);
    })
    .catch(() => 0);
}


// ══ MIGRATION ══
// Moves photos captured before this layer existed out of localStorage. Runs once
// at boot: any photo still carrying an inline dataUrl is written to IndexedDB,
// and the very next persistStore() drops the inline copy. On a project that was
// already at the old ceiling this is the moment several megabytes of localStorage
// come back.
function photoStoreMigrate(allPhotos) {
  const pending = (allPhotos || []).filter(p => p && p.id && p.dataUrl);
  if (!pending.length || !photoStoreAvailable()) return Promise.resolve(0);
  let moved = 0;
  return pending.reduce((chain, p) => chain
    .then(() => photoStoreGet(p.id))
    .then(existing => (existing && existing.full) ? null : photoStoreSave(p).then(ok => { if (ok) moved++; }))
    .catch(() => null), Promise.resolve())
    .then(() => moved);
}


// ══ USAGE ══
// localStorage was the only budget worth reporting when photos lived in it.
// Now the number a field crew needs is the media store's share of the origin
// quota, which only navigator.storage.estimate() knows.
let _mediaUsage = { bytes: 0, quota: 0, percent: 0, known: false };

function getMediaUsageInfo() { return _mediaUsage; }

function refreshMediaUsage() {
  if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve(_mediaUsage);
  return navigator.storage.estimate().then(est => {
    const bytes = est.usage || 0;
    const quota = est.quota || 0;
    _mediaUsage = {
      bytes, quota,
      percent: quota ? Math.min(100, Math.round((bytes / quota) * 100)) : 0,
      known: !!quota
    };
    return _mediaUsage;
  }).catch(() => _mediaUsage);
}

// Asks the browser not to evict this origin under disk pressure. Silently
// declined on engines that don't implement it, and on those that only grant it
// to installed PWAs — which is fine, it is a request, not a dependency.
function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && navigator.storage.persisted) {
      return navigator.storage.persisted().then(already => already ? true : navigator.storage.persist()).catch(() => false);
    }
  } catch (e) {}
  return Promise.resolve(false);
}

// The set the orphan sweep keeps. Reads the whole store rather than just the
// open project: a blob belonging to a project that is loaded but not active is
// still very much referenced.
function allReferencedPhotoIds() {
  const ids = new Set();
  const eat = photos => (photos || []).forEach(p => { if (p && p.id) ids.add(p.id); });
  try {
    for (const k in (projectData || {})) eat(collectPhotoRecords(projectData[k]));
    eat(collectPhotoRecords(savedFeatures, currentVertices));
  } catch (e) {}
  return ids;
}

function formatBytes(n) {
  if (!n || n < 1024) return (n || 0) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
