// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Project store: load, write guard, rolling backup, capture draft, widget
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ STORE:BEGIN ══
// ══════════════════════════════════════════════════════════════════════════════
// PROJECT STORE — DURABILITY
// ══════════════════════════════════════════════════════════════════════════════
// This layer used to have one failure mode that could destroy a whole survey in
// a single frame, silently:
//
//   loadStore() swallowed *any* exception and returned {} with projects=[].
//   The very next persist() — and persist() runs on every vertex capture — then
//   wrote {projects:[],data:{}} straight over the top of the raw string it had
//   just failed to read. A value that was merely unparseable (and therefore
//   still fully recoverable by hand) became genuinely, permanently gone.
//
// There was also no second copy anywhere: one key, one write, no rollback. A
// write interrupted mid-flight left the only copy of the data corrupt.
//
// Three defences, in order of how often they matter:
//   1. NEVER OVERWRITE MORE THAN THE USER ASKED TO REMOVE. A save that would
//      drop every project, or empty a project that had features, is refused
//      unless the caller explicitly marks it destructive (i.e. an actual delete
//      the user confirmed). A bug, a half-initialised boot or a failed load can
//      no longer express itself as data loss.
//   2. ROLLING BACKUP. The previous good value is copied to STORAGE_BAK_KEY
//      before each write, and loadStore() falls back to it when the primary is
//      unreadable.
//   3. READ-BACK VERIFY. After writing, the value is re-read and re-parsed. A
//      truncated or rejected write is rolled back rather than left in place.
//
// None of this protects against the app being uninstalled — that deletes the
// whole data directory regardless. See scripts/patch-android-signing.py for why
// that was happening on every update, and keep exporting backups.
const STORAGE_BAK_KEY = STORAGE_KEY + '_bak';

const STORAGE_QUARANTINE_PREFIX = STORAGE_KEY + '_corrupt_';


// Set when the primary AND the backup both failed to parse. While true, the
// store is considered "unknown, not empty": writes are refused so the bytes we
// could not read are left intact for recovery.
let storeLoadFailed = false;

let storeRecoveryNote = '';


// Keeps the unreadable bytes rather than letting the next save flatten them.
// Timestamped so a second failure never clobbers the first quarantine.
function quarantineRaw(raw, why) {
  if (!raw) return;
  try {
    // Don't fill the 5 MB budget with copies — one quarantine slot is enough to
    // recover from, and a second failure usually has the same cause.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf(STORAGE_QUARANTINE_PREFIX) === 0) localStorage.removeItem(k);
    }
    localStorage.setItem(STORAGE_QUARANTINE_PREFIX + Date.now(), raw);
    console.warn('PlotEdge: quarantined unreadable store (' + why + '), ' + raw.length + ' bytes');
  } catch(e) { /* if even this fails, the guards below still refuse to overwrite */ }
}


function parseStore(raw) {
  if (!raw) return null;
  const d = JSON.parse(raw);
  if (!d || typeof d !== 'object' || !Array.isArray(d.projects)) throw new Error('unexpected shape');
  return d;
}


// ══ WHAT THE GUARD COUNTS, AND WHY IT IS *NOT* VERTICES ══
// This used to be `savedFeatures.length + currentVertices.length`, which made
// the guard fire on the single most common action in the app.
//
// currentVertices is a SCRATCHPAD. Finishing a polygon moves five vertices out
// of it and into one saved feature, so that sum goes 0+5=5 -> 1+0=1. The guard
// read the drop as "this save would drop 4 captured items", refused the write,
// and left the feature in memory but not on disk. The screen said saved; the
// next launch said nothing was ever captured. Clearing the form, cancelling an
// edit and finishing a line all tripped the same wire.
//
// The durable unit of work is a SAVED FEATURE. It only ever goes down when the
// user deletes something, and every one of those paths already passes
// {destructive:true}. Counting features (never scratch vertices) makes the
// guard fire exactly when data is genuinely about to vanish and never when the
// user completes the thing they came here to do.
function countFeatures(data) {
  let n = 0;
  for (const k in (data || {})) {
    const d = data[k] || {};
    n += (d.savedFeatures || []).length;
  }
  return n;
}

// In-progress vertices, reported for diagnostics only — deliberately kept out
// of the verdict above. See the comment there.
function countDraftVertices(data) {
  let n = 0;
  for (const k in (data || {})) {
    const d = data[k] || {};
    n += (d.currentVertices || []).length;
  }
  return n;
}


function loadStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  // 1. the primary copy
  try {
    const d = parseStore(raw);
    // Seed the write-guard cache from the copy we just parsed, so the first
    // save of the session does not have to parse the whole store again.
    if (d) { projects = d.projects; lastWritten = storeShape(d); noteStoreBytes(raw ? raw.length : 0); return d.data || {}; }
  } catch(e) {
    // 2. the rolling backup, written before the previous save
    try {
      const d = parseStore(localStorage.getItem(STORAGE_BAK_KEY));
      if (d) {
        quarantineRaw(raw, 'primary unreadable, restored from backup');
        projects = d.projects;
        storeRecoveryNote = 'Recovered ' + d.projects.length + ' project(s) from the automatic backup.';
        return d.data || {};
      }
    } catch(e2) {}
    // 3. neither copy is readable — keep the bytes and refuse to write over them
    quarantineRaw(raw, 'primary and backup both unreadable');
    storeLoadFailed = true;
    storeRecoveryNote = 'Saved data could not be read. It has been set aside untouched — export a backup before continuing.';
    projects = [];
    return {};
  }
  // migrate legacy single-session data into a project, if present
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const d = JSON.parse(legacy);
      if ((d.savedFeatures && d.savedFeatures.length) || (d.currentPoints && d.currentPoints.length)) {
        const id = 'p_' + Date.now();
        projects = [{ id, name:'Imported Session', client:'', site:'', createdAt:new Date().toISOString() }];
        return { [id]: { savedFeatures:d.savedFeatures||[], currentPoints:d.currentPoints||[], currentPhotos:d.currentPhotos||[] } };
      }
    }
  } catch(e) {}
  projects = [];
  return {};
}

let projectData = {};


// ══ STORAGE USAGE / SOFT WARNING ══
// persistStore()'s catch block only ever fires *after* localStorage is already full (too late to
// act on). This estimates usage proactively against a conservative baseline quota — Safari/iOS
// caps around 5MB, well below Chrome's much larger allowance, so warning against the tighter
// common case keeps the warning meaningful across devices — and surfaces it both as a persistent
// meter (Export tab) and a one-time-per-band toast, so a long capture session isn't nagged after
// every single vertex.
const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;

let _storageWarnBand = 0;

// ══ WHY THIS IS CACHED ══
// This used to measure by cloning the raw string into a Blob, which copies the
// entire store purely to read its size — and updateStorageWarning() runs at the end of
// every persistStore(), so every photo capture cloned megabytes to learn a
// number we already knew. The write path knows exactly how many bytes it just
// wrote, so it tells us instead of us going and looking. `.length` is the right
// measure regardless: the store is JSON of base64 and ASCII, where code units
// and bytes coincide, and browsers meter localStorage in code units anyway.
let _storeBytes = null;      // primary slot

let _backupBytes = 0;        // backup slot — also consumes the same quota

function noteStoreBytes(n) { _storeBytes = n; }

function noteBackupBytes(n) { _backupBytes = n; }

function getStorageUsageInfo(){
  let bytes = _storeBytes;
  if (bytes == null) {
    try { const raw = localStorage.getItem(STORAGE_KEY); bytes = raw ? raw.length : 0; }
    catch(e) { bytes = 0; }
    _storeBytes = bytes;
  }
  // The rolling backup is a real second copy in the same quota. Reporting only
  // the primary meant the meter read half the truth exactly when it mattered,
  // and the pre-flight check that refuses new photos would have let them
  // through until the write itself failed.
  const total = bytes + _backupBytes;
  const percent = Math.min(100, Math.round((total / STORAGE_QUOTA_BYTES) * 100));
  return { bytes: total, primaryBytes: bytes, backupBytes: _backupBytes, percent };
}

// ══ WHY THE METER READS TWO NUMBERS NOW ══
// Records live in localStorage (a ~5 MB text budget); photo bytes live in
// IndexedDB (a share of free disk, typically hundreds of MB to several GB).
// Reporting only the first would now be actively misleading — it is the small
// budget, but it is no longer the one that fills. The bar tracks whichever of
// the two is closer to its own limit, and the label names it, so "storage is
// nearly full" always points at the thing that is actually nearly full.
function effectiveStoragePercent(){
  const rec = getStorageUsageInfo();
  const media = (typeof getMediaUsageInfo === 'function') ? getMediaUsageInfo() : null;
  const mediaPct = (media && media.known) ? media.percent : 0;
  return { percent: Math.max(rec.percent, mediaPct), records: rec, mediaPercent: mediaPct, media };
}

function updateStorageWarning(){
  const combined = effectiveStoragePercent();
  const info = { percent: combined.percent };
  const wrap = document.getElementById('storageMeterWrap');
  const fill = document.getElementById('storageMeterFill');
  const label = document.getElementById('storageMeterLabel');
  if (fill) fill.style.width = info.percent + '%';
  if (label) {
    const media = combined.media;
    const photoLine = (media && media.known && media.bytes)
      ? ` · photos ${typeof formatBytes === 'function' ? formatBytes(media.bytes) : Math.round(media.bytes/1048576) + ' MB'}`
      : '';
    label.textContent = (info.percent>=80
      ? `Storage ${info.percent}% full. Export soon to free up space`
      : `Storage ${info.percent}% used`) + photoLine;
  }
  if (wrap) wrap.classList.toggle('warn', info.percent>=80);
  const bands=[80,90,95,99];
  const crossed = bands.filter(b=>info.percent>=b).pop() || 0;
  if (crossed && crossed>_storageWarnBand){
    _storageWarnBand = crossed;
    showToast(`Storage ${info.percent}% full. Export soon to free up space.`);
  } else if (info.percent<80) {
    _storageWarnBand = 0; // usage dropped back down (exported/cleared data) — allow future warnings again
  }
}


// ══ WRITE GUARD ══
// Decides whether a save is allowed to reduce what is on disk. Everything that
// only adds or edits passes straight through; only a save that would make data
// disappear has to justify itself. `destructive` is set by the handful of call
// sites where the user actually asked for the removal (delete project, clear
// all, restore-from-backup), so a genuine delete is never blocked — and a bug,
// a failed load, or a persist() that fired before state finished loading can no
// longer present itself as one.
//
// ══ WHY THIS READS A CACHE AND NOT localStorage ══
// The first version re-read and re-parsed the whole store on every save to work
// out what was currently on disk. That is fine for a store of text, and ruinous
// for one full of base64 photos: persist() runs on every photo add, so a session
// adding 20 photos to a vertex was parsing a growing multi-megabyte string
// twenty times over. Measured, it made each save touch 4x the bytes it needed
// to and turned a photo-heavy session into hundreds of megabytes of avoidable
// string churn — which on an Android WebView is exactly how you get the renderer
// killed mid-capture. What is on disk is something we already know, because we
// are the only writer: it is whatever we last successfully wrote.
let lastWritten = null;   // { projectCount, itemCount } — mirrors the disk copy


function storeShape(payload) {
  return { projectCount: payload.projects.length, itemCount: countFeatures(payload.data) };
}

function storeWriteVerdict(next, opts) {
  if (opts && opts.destructive) return { ok:true };
  if (storeLoadFailed) return { ok:false, why:'saved data could not be read on startup' };
  let prev = lastWritten;
  if (!prev) {
    // Only on the very first save of a session, or after a failed write reset
    // the cache. One parse at startup is affordable; one per save is not.
    try {
      const d = parseStore(localStorage.getItem(STORAGE_KEY));
      prev = d ? storeShape(d) : null;
    } catch(e) { prev = null; }
  }
  if (!prev) return { ok:true };                      // nothing on disk to lose
  const nextShape = storeShape(next);
  if (prev.projectCount && !nextShape.projectCount)
    return { ok:false, why:'it would remove all ' + prev.projectCount + ' project(s)' };
  // A tolerance of zero is correct here: saving, editing and capturing all
  // leave the saved-feature count the same or higher, and every real deletion
  // goes through the destructive path.
  if (prev.itemCount > nextShape.itemCount)
    return { ok:false, why:'it would drop ' + (prev.itemCount - nextShape.itemCount) + ' saved feature(s)' };
  return { ok:true };
}


// ══ ROLLING BACKUP: THROTTLED, AND ONLY WHEN IT FITS ══
// A second full copy on every save is the single most expensive thing this
// layer could do to a photo-heavy project: it doubles localStorage occupancy,
// halving how many photos fit before the quota is hit, and doubles the bytes
// written per capture. Neither is worth it, because the backup only has to be
// recent enough to save a session — not identical to the last keystroke.
// So it is written at most once a minute, and skipped entirely when the
// duplicate would not comfortably fit. The cost of skipping is losing at most a
// minute of work in a corruption that has never been observed; the cost of not
// skipping is running out of room mid-survey, which is routine.
const BACKUP_MIN_INTERVAL_MS = 60000;

const BACKUP_MAX_FRACTION = 0.35;   // of the assumed quota, so primary+backup <= 70%

let _lastBackupAt = 0;

function maybeWriteBackup(prevRaw) {
  if (!prevRaw) return;
  const now = Date.now();
  if (now - _lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
  if (prevRaw.length > STORAGE_QUOTA_BYTES * BACKUP_MAX_FRACTION) {
    // Too big to duplicate safely. Drop any stale copy rather than leaving an
    // old one that could be restored over much newer work.
    try { localStorage.removeItem(STORAGE_BAK_KEY); noteBackupBytes(0); } catch(e) {}
    return;
  }
  try { localStorage.setItem(STORAGE_BAK_KEY, prevRaw); noteBackupBytes(prevRaw.length); _lastBackupAt = now; }
  catch(e) { /* backup is best effort; never block or fail the real save */ }
}


// ══ WHAT NEVER GOES INTO localStorage ══
// The single change that lifted the capture ceiling. Photo bytes used to be
// serialised straight into this store as base64 `dataUrl`/`thumbUrl` strings —
// roughly 200 KB per photo against a ~5 MB budget, and doubled again whenever
// the rolling backup ran. Two features' worth of photos fit; the third did not,
// which is precisely the failure that was reported.
//
// The bytes now live in IndexedDB (see js/04a-photostore.js). This replacer is
// what guarantees they never come back: whatever any caller has put on a photo
// record in memory — a freshly captured image, or a `dataUrl` an export
// temporarily hydrated — is dropped on the way out. Everything else about the
// photo (id, filename, timestamps, heading, angle label, upload state) is a few
// hundred bytes and stays, so the record is intact and the blob is one lookup
// away by id.
//
// Deliberately a JSON.stringify replacer rather than a pre-pass that deletes the
// fields: a pre-pass would either mutate live objects the UI is still rendering
// from, or deep-copy the whole store on every capture. This costs one function
// call per key and copies nothing.
//
// ══ WHY THIS CHECKS BEFORE IT STRIPS ══
// A first version of this dropped dataUrl/thumbUrl unconditionally, by key. That
// is a data-loss bug on exactly one launch: the upgrade one. persistStore() runs
// at boot (js/22-boot.js) before the media store has migrated anything, so an
// unconditional strip removed every photo from disk while its bytes still only
// existed in memory. A process kill in that window — routine on Android — took
// every photo on the device with it.
//
// So the rule is: the bytes may only be dropped once they are provably somewhere
// else. photoBytesOnDisk() answers that per photo id. Until it says yes the
// record keeps its base64 and the write is simply larger, which costs space and
// loses nothing. typeof-guarded because tests/store.test.js executes this block
// standalone, without the media store.
function photoStripFields(key, value) {
  if (value && typeof value === 'object'
      && typeof value.id === 'string'
      && value.takenAt !== undefined
      && (typeof value.dataUrl === 'string' || typeof value.thumbUrl === 'string')) {
    if (typeof photoBytesOnDisk === 'function' && !photoBytesOnDisk(value.id)) return value;
    const stripped = {};
    for (const k in value) if (k !== 'dataUrl' && k !== 'thumbUrl') stripped[k] = value[k];
    return stripped;
  }
  return value;
}

function persistStore(opts) {
  const payload = { projects, data: projectData };
  const verdict = storeWriteVerdict(payload, opts);
  if (!verdict.ok) {
    // Loud, because a silently skipped save is its own kind of data loss — the
    // crew needs to know the screen and the disk have diverged.
    console.error('PlotEdge: refused a save because ' + verdict.why);
    showToast('Save blocked to protect your data — ' + verdict.why + '. Export a backup.');
    publishWidgetSummary();
    return false;
  }
  let next;
  try { next = JSON.stringify(payload, photoStripFields); }
  catch(e) { showToast('Could not prepare data for saving.'); return false; }

  const prevRaw = localStorage.getItem(STORAGE_KEY);
  maybeWriteBackup(prevRaw);

  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch(e) {
    noteStoreBytes(prevRaw ? prevRaw.length : 0);
    showToast('Storage full. Export before continuing.');
    updateStorageWarning();
    publishWidgetSummary();
    return false;
  }

  // ══ READ-BACK VERIFY, CHEAPLY ══
  // A quota rejection can land as a partial write on some WebViews rather than
  // a clean throw, so the write does have to be confirmed. But re-parsing
  // megabytes of JSON to do it costs more than the save itself. A length match
  // catches truncation, which is the failure mode that actually occurs; the
  // full parse is kept only for when the lengths disagree.
  const wroteRaw = localStorage.getItem(STORAGE_KEY);
  let ok = wroteRaw != null && wroteRaw.length === next.length;
  if (!ok) { try { ok = !!parseStore(wroteRaw); } catch(e) { ok = false; } }
  if (!ok) {
    if (prevRaw) { try { localStorage.setItem(STORAGE_KEY, prevRaw); } catch(e) {} }
    lastWritten = null;   // disk state is no longer known; re-derive on next save
    noteStoreBytes(prevRaw ? prevRaw.length : 0);
    showToast('Save failed and was rolled back. Export a backup now.');
    updateStorageWarning();
    publishWidgetSummary();
    return false;
  }

  lastWritten = storeShape(payload);
  noteStoreBytes(next.length);
  updateStorageWarning();
  publishWidgetSummary();
  return true;
}


// ══════════════════════════════════════════════════════════════════════════════
// CRASH-SAFE CAPTURE DRAFT
// ══════════════════════════════════════════════════════════════════════════════
// Vertices were already durable — commitVertex() calls persist() on every tap.
// Everything else on the Collect form was not: the feature name, reference,
// assignee, notes and all the attribute values lived only in the DOM until the
// moment Save was pressed. Killing the WebView (Android reclaiming a
// backgrounded app is the common case, not just a crash) threw all of it away,
// which is why a recovered session still felt like starting over.
//
// Deliberately a SEPARATE key from the project store, for two reasons: it is
// written far more often than the store and must never risk the store's bytes,
// and a draft is disposable in a way captured data is not — if it is ever
// unreadable, dropping it silently is the right outcome, so it does not go
// through the write guard above.
const DRAFT_KEY = 'plotedge_collect_draft';


function writeDraft(draft) {
  try {
    if (!draft || !draft.projectId) return false;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, at: Date.now() }));
    return true;
  } catch(e) { return false; }   // full storage must never break the capture flow
}

function readDraft(projectId) {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!d || (projectId && d.projectId !== projectId)) return null;
    return d;
  } catch(e) { return null; }
}

function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch(e) {} }

// ══ STORE:END ══

// ══ ANDROID HOME SCREEN WIDGET ══
// The widget is a native AppWidgetProvider and cannot read localStorage — that lives inside the
// WebView. Capacitor's Preferences plugin writes to Android SharedPreferences ("CapacitorStorage"),
// which native code CAN read, so this mirrors a small summary out on every save. Web builds and
// any native build without the plugin simply no-op.
function publishWidgetSummary(){
  try {
    if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return;
    const Prefs = window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
    if (!Prefs || !Prefs.set) return;
    const id = activeProjectId || activeProjectRef;
    const p = id ? projects.find(x=>x.id===id) : null;
    const d = (p && projectData[p.id]) || {};
    const feats = (d.savedFeatures||[]).length;
    // Reuse getProjectStats().synced rather than re-deriving it. The hand-rolled version here
    // compared lastExportedAt against p.updatedAt only, which misses edits stamped on features
    // rather than the project — so a project could report "synced" on the widget while the
    // Project Manager showed it as not synced. One definition, one answer.
    const unsynced = projects.reduce((n,pr)=>{
      // skipBytes: this runs on every save and only .synced is read here.
      const st = getProjectStats(pr, { skipBytes: true });
      return n + ((st.features && !st.synced) ? 1 : 0);
    },0);
    // ══ THEME ══
    // The widget used to follow the SYSTEM light/dark setting only, through
    // values/ and values-night/ colour resources (scripts/patch-android-widget.py).
    // That is not the same thing as following the theme the user chose IN
    // PlotEdge: pick the light theme on a dark-set phone, or switch data domain
    // and change the accent, and the widget stayed on whatever the OS said —
    // the one tile on the home screen not matching its own app.
    //
    // RemoteViews cannot read a running app's CSS, so the colours are resolved
    // here, from the live computed styles, and shipped alongside the counts. The
    // provider applies them with setInt/setTextColor, which DOES work in the
    // launcher process. Sent on every save because that is already when the
    // widget payload is written; a theme change triggers one via persist().
    Prefs.set({ key:'plotedge_widget', value: JSON.stringify({
      project: p ? p.name : null,
      features: feats,
      inProgress: (d.currentVertices||[]).length,
      projects: projects.length,
      unsynced,
      theme: widgetThemeColors(),
      updatedAt: Date.now()
    })});
  } catch(e){ /* widget data is best-effort; never let it break a save */ }
}


// opts.destructive marks the save as an intentional removal the user asked for
// (a delete they confirmed), which is what lets it past the write guard in
// persistStore(). Every ordinary save omits it, so a bug can never claim it.
function persist(opts) {
  if (!activeProjectId) return;
  // `suspended` is the capture stack (js/06a-capture-stack.js) — features the crew
  // paused part-way to go and collect something else. It rides along here for the
  // same reason currentVertices does: it is real unsaved work, including photos,
  // and a WebView the OS reclaims must not take it with it.
  // Tombstones are read forward off the existing record rather than rebuilt from a global,
  // because there is no global holding them — they live only in projectData (deliberately, so no
  // render/export/stats code has to learn to skip them). This assignment REPLACES the project
  // record wholesale, so without carrying them over, every delete's tombstone would be discarded
  // by the very persist() call that saved the delete. Silent, and it would have resurrected
  // deleted features on the first merge.
  const prior = projectData[activeProjectId];
  const tombstones = (prior && Array.isArray(prior.tombstones)) ? prior.tombstones : [];
  projectData[activeProjectId] = { savedFeatures, currentVertices, featureTypes, notes: projectNotes, notesUpdatedAt: projectNotesUpdatedAt, sketches: plotetchSketches, suspended: captureStackForStore(), tombstones };
  // Stamp the project record too, so the Project Manager's "Modified" figure reflects every
  // capture, edit and schema change — not just the ones that happen to touch a saved feature.
  const p = projects.find(x=>x.id === activeProjectId);
  if (p) p.updatedAt = new Date().toISOString();
  // Returns persistStore()'s verdict so callers that just added something
  // expensive (a photo) can undo it rather than showing work that is not on
  // disk. Callers that don't care can keep ignoring it.
  return persistStore(opts);
}


// ══ MIGRATION: old {points:[...], photos:[...]} feature shape -> new {vertices:[...]} shape ══
// Old features had one shared photo set per feature and no per-vertex attrs. We fold that
// photo set into the first vertex so old data keeps displaying/exporting exactly as it used to
// (single-point-single-photo is just the simplest case of the new vertex model).
function migrateFeatureToVertices(f) {
  // PlotMate identity is stamped here rather than in a separate pass: this is already the single
  // funnel every stored feature passes through on load (both call sites in js/05-projects.js), and
  // a second pass would be one more place to forget. plotmateMigrateFeature is idempotent and
  // derives the revision from the record's own savedAt/editedAt, so a project's real edit history
  // keeps its ordering instead of collapsing to "whenever the migration ran".
  if (typeof plotmateMigrateFeature === 'function') plotmateMigrateFeature(f);
  if (f.vertices) return f;
  const photos = f.photos || [];
  const pts = f.points || [];
  f.vertices = pts.map((p,i)=>({ lat:p.lat, lon:p.lon, alt:p.alt, acc:p.acc, time:p.time, attrs:{}, photos: i===0 ? photos : [] }));
  f.geometryType = f.geometryType || 'point';
  delete f.points; delete f.photos;
  return f;
}

function migrateCurrentVertices(d) {
  if (d.currentVertices) return d.currentVertices;
  const pts = d.currentPoints || [];
  const photos = d.currentPhotos || [];
  return pts.map((p,i)=>({ lat:p.lat, lon:p.lon, alt:p.alt, acc:p.acc, time:p.time, attrs:{}, photos: i===0 ? photos : [] }));
}


// Resolves the app's live theme into the flat ARGB integers a RemoteViews can
// actually apply. Returns null if anything is unreadable, which the provider
// treats as "use the built-in light/dark resources" — so a failure here degrades
// to the previous behaviour rather than to an unstyled widget.
//
// Colours are read from the computed style of <html> rather than from a table in
// JS, so a new theme or a retuned token needs no change here. Everything is
// funnelled through a canvas to normalise oklch()/color-mix()/hsl() into rgb,
// because modern token values are not parseable by hand and getComputedStyle
// hands back whatever the stylesheet wrote.
// ══ WHY THE WIDGET IGNORED MATERIAL YOU ══
// The values-v31 dynamic palette added to scripts/patch-android-widget.py was correct and had no
// effect, because this function overrides it. The widget provider's applyTheme() paints every
// leaf view from the colours below at each update, and the XML palettes are only what shows when
// this returns null.
//
// That was a deliberate decision and a defensible one: the widget matched PlotEdge's OWN theme, so
// choosing the light theme on a dark-set phone kept the tile consistent with the app. But on a
// modern home screen every other widget is tinted from the wallpaper, and a fixed white card next
// to them reads as the one thing that does not belong.
//
// So it is now a choice rather than an assumption. When "match home screen" is on, this returns
// null — the provider's own null-guard then leaves the resource palette in place, which on Android
// 12+ resolves to values-v31 and the wallpaper colours. No Java change was needed: the escape
// hatch was already there.
const WIDGET_DYNAMIC_KEY = 'plotedge_widget_dynamic';

function widgetFollowsHomeScreen(){
  try {
    const v = localStorage.getItem(WIDGET_DYNAMIC_KEY);
    // Defaults to ON. Material You is what the platform does and what the rest of the home screen
    // is doing; matching it is the less surprising default, and anyone who preferred the old
    // behaviour can say so.
    return v === null ? true : v === '1';
  } catch(e){ return true; }
}

function setWidgetFollowsHomeScreen(on){
  try { localStorage.setItem(WIDGET_DYNAMIC_KEY, on ? '1' : '0'); } catch(e){}
  persist(); // rewrites the bridge file, which is what the provider reads on its next update
  showToast(on ? 'Widget follows your home screen colours' : 'Widget uses PlotEdge’s theme');
}

function widgetThemeColors(){
  if (widgetFollowsHomeScreen()) return null;
  try {
    const cs = getComputedStyle(document.documentElement);
    const read = name => cs.getPropertyValue(name).trim();
    const out = {};
    const map = {
      bg:'--card-bg', stroke:'--card-border', eyebrow:'--text-tertiary',
      title:'--text-primary', body:'--text-secondary', accent:'--accent-primary',
      warn:'--warn', btn:'--surface-sunken', btnStroke:'--card-border',
      btnText:'--text-primary', btnPrimary:'--accent-primary', btnPrimaryText:'--on-accent'
    };
    for (const key in map){
      const hex = cssColorToArgb(read(map[key]));
      if (hex !== null) out[key] = hex;
    }
    // All or nothing. A half-resolved palette is worse than none: the provider
    // would mix app colours with resource colours and produce a widget that
    // matches neither theme.
    return Object.keys(out).length === Object.keys(map).length ? out : null;
  } catch(e){ return null; }
}

// Any CSS colour -> a signed 32-bit ARGB int, the form Android's setTextColor
// and setBackgroundColor take. The canvas does the parsing so oklch(), hsl() and
// color-mix() all work without a colour library.
let _widgetColorCtx = null;
function cssColorToArgb(value){
  if (!value) return null;
  const v = String(value).trim();

  // Fast path, and the one that actually runs: every colour in css/01-tokens.css
  // is plain #rgb / #rrggbb. Doing it directly means the widget palette resolves
  // with no canvas at all — which matters because a canvas is not guaranteed
  // (a hardened WebView, a headless test, a device that failed to allocate one)
  // and a palette that silently fails to resolve leaves the widget stuck on the
  // system light/dark resources with no sign that anything went wrong.
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m){
    let h = m[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const n = parseInt(h, 16);
    return ((255 << 24) | n) | 0;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (m){
    return ((255 << 24) | (Math.round(+m[1]) << 16) | (Math.round(+m[2]) << 8) | Math.round(+m[3])) | 0;
  }

  // Fallback for anything exotic a future theme might use — oklch(), hsl(),
  // color-mix(). The canvas parses what a regex should not try to.
  try {
    if (typeof document === 'undefined') return null;
    if (!_widgetColorCtx){
      const c = document.createElement('canvas'); c.width = c.height = 1;
      _widgetColorCtx = c.getContext('2d');
    }
    const ctx = _widgetColorCtx;
    if (!ctx) return null;
    ctx.clearRect(0,0,1,1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;                  // invalid values leave the previous one
    ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data;
    // | 0 to land in the signed range Java's int expects; a bare 0xFF...
    // would arrive as a value larger than Integer.MAX_VALUE and be rejected.
    return ((255 << 24) | (d[0] << 16) | (d[1] << 8) | d[2]) | 0;
  } catch(e){ return null; }
}
