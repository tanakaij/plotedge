// ═══════════════════════════════════════════════════════════════════════════
// PlotMate — collaboration identity layer (STAGE 1: identity + causality only)
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.
//
// Loaded at 03a (after the schema, before the store) because js/04-store.js and
// js/05-projects.js both need to stamp records as they load them, and nothing
// here depends on either.
//
// ══ WHAT THIS FILE IS FOR ══
// PlotMate is shared-project collaboration: several crews editing one project,
// mostly offline, reconciling when they get signal. This file contains NO
// network code and nothing user-visible. It exists to fix the three things in
// the current data model that make merging impossible, so that data captured
// from today onward is mergeable whenever the transport lands.
//
// The three problems, in the order they bite:
//
//   1. FEATURE IDS ARE NOT GLOBALLY UNIQUE.
//      newFeatureId() (js/11-features.js) mints Date.now() and bumps it past
//      the local maximum. That is a fine device-local monotonic counter and a
//      guaranteed collision across devices: two crews capturing within the same
//      millisecond — or on devices whose clocks agree to the second, which is
//      all of them — mint the same integer. On merge those are indistinguishable
//      records. So every feature gains a `uid` that carries the device identity
//      in it and can never collide. The legacy numeric `id` is left exactly as
//      it is, because ~15 files index features by it; `uid` is additive.
//
//   2. THERE IS NO CAUSALITY, ONLY WALL CLOCKS.
//      Features carry savedAt/editedAt ISO strings. "Newest wins" on a raw wall
//      clock loses data the moment two devices disagree about the time, which
//      for field tablets that have been off-network for a day is routine — and
//      it is not even deterministic: two devices can each conclude they won.
//      `rev` is a hybrid logical clock (HLC) instead: physical time so it stays
//      human-meaningful and sorts sensibly, a logical counter so events on one
//      device are always ordered even inside a single millisecond, and the
//      device id as the final tiebreak so EVERY device independently computes
//      the same winner. That last property is what makes "newest wins" safe.
//
//   3. DELETES CANNOT WIN.
//      deleteFeature() splices the array. An absence is not a fact — when a
//      device that deleted a feature meets one that merely has it, the delete
//      looks like missing data and the feature returns from the dead. Deletes
//      are therefore recorded as tombstones: {u, rev} kept in a separate
//      per-project list so no existing render/export/stats code has to learn to
//      skip them.
//
// ══ WHY TOMBSTONES ARE NOT A FLAG ON THE FEATURE ══
// The obvious shape is `f.deleted = true` left in savedFeatures. That would mean
// auditing every one of the ~20 call sites that iterate savedFeatures (renders,
// exports, dashboard counts, PlotMind queries, the plan sheet) and adding a
// filter to each, where one miss is a deleted feature silently reappearing in a
// deliverable. A separate list keeps the blast radius at zero: nothing that
// exists today has to change, and the merge step reads the list explicitly.


// ══ BYTE BUDGET ══
// Records live in the ~5 MB localStorage text budget (see js/04-store.js), so
// the field names here are one character each and the device id is 8. A stamped
// feature costs about 60 extra bytes; 2000 features is ~120 KB, roughly 2% of
// budget. Spelling these `revision`/`timestamp`/`device` would triple that for
// no benefit, since nothing but this file reads them.
const PLOTMATE_DEVICE_KEY = 'plotedge_plotmate_device';
const PLOTMATE_CLOCK_KEY  = 'plotedge_plotmate_clock';

// How far ahead of local time a received stamp is allowed to drag our clock.
// An HLC adopts the max of local and remote physical time, which means one
// device with a badly wrong clock would otherwise poison every device it syncs
// with — permanently, since the clock only moves forward. 24h is generous
// enough for real timezone/NTP drift and tight enough that a device stuck in
// 2038 cannot take the crew with it.
const PLOTMATE_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;


let _plotmateDeviceId = null;

// A random, stable, per-install identifier. NOT a user identity and not derived
// from any hardware value: it only has to be unique and stable, and anything
// fingerprint-shaped would be both less reliable and a privacy problem in an
// app that already records people's locations for a living.
function plotmateDeviceId() {
  if (_plotmateDeviceId) return _plotmateDeviceId;
  let id = null;
  try { id = localStorage.getItem(PLOTMATE_DEVICE_KEY); } catch (e) {}
  if (!id || typeof id !== 'string' || id.length !== 8) {
    id = '';
    // crypto where available; Math.random only as a fallback, because a
    // predictable device id in a shared project is a collision risk, not just
    // an aesthetic one.
    try {
      const buf = new Uint8Array(6);
      crypto.getRandomValues(buf);
      for (let i = 0; i < buf.length; i++) id += (buf[i] % 36).toString(36);
      id = (id + '00000000').slice(0, 8);
    } catch (e) {
      id = (Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6)).slice(0, 8);
    }
    try { localStorage.setItem(PLOTMATE_DEVICE_KEY, id); } catch (e) {}
  }
  _plotmateDeviceId = id;
  return id;
}


// ══ THE CLOCK ══
// {t: physical ms, c: logical counter}. Persisted on every issue, because the
// guarantee that matters is monotonicity across RELOADS, not just within a
// session: an Android WebView is killed and restored constantly, and a clock
// that resets to Date.now() on each launch can reissue a stamp it already used
// if the system clock has moved backwards (NTP correction, manual change,
// timezone-as-clock confusion on cheap tablets). Reissuing a stamp means two
// different edits comparing as equal, which is the one case LWW cannot resolve.
let _plotmateClock = null;

function plotmateLoadClock() {
  if (_plotmateClock) return _plotmateClock;
  let c = null;
  try { c = JSON.parse(localStorage.getItem(PLOTMATE_CLOCK_KEY) || 'null'); } catch (e) {}
  _plotmateClock = (c && typeof c.t === 'number' && typeof c.c === 'number') ? c : { t: 0, c: 0 };
  return _plotmateClock;
}

function plotmateSaveClock() {
  try { localStorage.setItem(PLOTMATE_CLOCK_KEY, JSON.stringify(_plotmateClock)); } catch (e) {}
}

// Issue a new stamp for a local edit.
function plotmateStamp() {
  const clock = plotmateLoadClock();
  const now = Date.now();
  if (now > clock.t) { clock.t = now; clock.c = 0; }
  else { clock.c += 1; }   // clock stalled or went backwards — logical counter carries the order
  plotmateSaveClock();
  return { t: clock.t, c: clock.c, d: plotmateDeviceId() };
}

// Fold a stamp seen from another device into our clock. Not used until the
// transport lands, but it belongs with the clock it mutates: without it, a
// device that receives a newer edit and then makes its own would stamp the new
// edit as OLDER than the one it just learned about, and lose its own work.
function plotmateObserve(remote) {
  if (!remote || typeof remote.t !== 'number') return;
  const clock = plotmateLoadClock();
  const now = Date.now();
  if (remote.t > now + PLOTMATE_MAX_DRIFT_MS) return; // implausible clock — ignore, don't adopt
  const t = Math.max(clock.t, remote.t, now);
  if (t === clock.t && t === remote.t) clock.c = Math.max(clock.c, remote.c || 0) + 1;
  else if (t === clock.t) clock.c += 1;
  else if (t === remote.t) clock.c = (remote.c || 0) + 1;
  else clock.c = 0;
  clock.t = t;
  plotmateSaveClock();
}

// Total order over stamps: > 0 when a wins. Physical time, then logical
// counter, then device id as an arbitrary-but-identical-everywhere tiebreak.
// Every device computes the same answer from the same two stamps, which is the
// whole point — a merge that depends on who is doing the merging is not a merge.
function plotmateCompare(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.t !== b.t) return a.t > b.t ? 1 : -1;
  const ac = a.c || 0, bc = b.c || 0;
  if (ac !== bc) return ac > bc ? 1 : -1;
  const ad = a.d || '', bd = b.d || '';
  if (ad === bd) return 0;
  return ad > bd ? 1 : -1;
}

function plotmateNewer(a, b) { return plotmateCompare(a, b) > 0; }


// Globally unique id: device id + the stamp that minted it. Readable enough to
// grep for in a log, and unique by construction rather than by luck.
function plotmateUid(prefix) {
  const s = plotmateStamp();
  return (prefix || 'x') + '_' + s.d + '_' + s.t.toString(36) + (s.c ? '.' + s.c.toString(36) : '');
}


// Mark a record as edited here, now. Call AFTER mutating it.
function plotmateTouch(entity, prefix) {
  if (!entity || typeof entity !== 'object') return entity;
  if (!entity.uid) entity.uid = plotmateUid(prefix || 'ft');
  entity.rev = plotmateStamp();
  return entity;
}


// ══ MIGRATION ══
// Stamp a record that predates this file. Runs on load, once per record.
//
// The revision is derived from the record's OWN editedAt/savedAt rather than
// from the migration moment, so a project's existing history keeps its real
// ordering: a feature edited last Tuesday must not outrank one edited today
// just because the migration happened to visit it first. Records with no usable
// timestamp fall back to t:0, which sorts below everything real — correct, since
// an undatable record is the weakest possible claim to being newest.
//
// Uid minting is device-local and that is fine: legacy records only exist on the
// device that captured them. Two devices cannot have "the same" legacy feature
// unless it travelled between them by export/import, and js/18-import.js already
// mints fresh ids on the way in, so it is genuinely a different record.
function plotmateMigrateFeature(f) {
  if (!f || typeof f !== 'object') return f;
  if (f.uid && f.rev) return f;
  if (!f.uid) f.uid = plotmateUid('ft');
  if (!f.rev) {
    let t = 0;
    const stamp = f.editedAt || f.savedAt;
    if (stamp) { const parsed = Date.parse(stamp); if (!isNaN(parsed)) t = parsed; }
    f.rev = { t: t, c: 0, d: plotmateDeviceId() };
  }
  return f;
}


// ══ TOMBSTONES ══
// Per project, kept alongside savedFeatures in projectData but deliberately not
// inside it. {u: uid, rev: stamp}.
function plotmateTombstones(projectId) {
  const d = projectData[projectId];
  if (!d) return [];
  if (!Array.isArray(d.tombstones)) d.tombstones = [];
  return d.tombstones;
}

// Record a delete so it can beat a stale edit of the same feature on merge.
// Idempotent per uid: re-deleting only bumps the revision, so the list length
// is bounded by the number of distinct features ever deleted rather than by the
// number of delete/undo cycles a frustrated user performs.
function plotmateRecordDelete(projectId, feature) {
  if (!feature || !projectId) return;
  const uid = feature.uid || plotmateMigrateFeature(feature).uid;
  const list = plotmateTombstones(projectId);
  const existing = list.find(t => t.u === uid);
  if (existing) existing.rev = plotmateStamp();
  else list.push({ u: uid, rev: plotmateStamp() });
}

// An undo has to withdraw the tombstone, or the feature the crew just restored
// would be deleted again by the next sync — the single most alarming way this
// could fail, since it would happen minutes later with no visible cause.
function plotmateWithdrawDelete(projectId, feature) {
  if (!feature || !projectId) return;
  const uid = feature.uid;
  if (!uid) return;
  const d = projectData[projectId];
  if (!d || !Array.isArray(d.tombstones)) return;
  d.tombstones = d.tombstones.filter(t => t.u !== uid);
}


// Node's test harness executes these files standalone; the browser has no
// module system here and everything is already a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    plotmateDeviceId, plotmateStamp, plotmateObserve, plotmateCompare,
    plotmateNewer, plotmateUid, plotmateTouch, plotmateMigrateFeature,
    plotmateTombstones, plotmateRecordDelete, plotmateWithdrawDelete,
    PLOTMATE_DEVICE_KEY, PLOTMATE_CLOCK_KEY, PLOTMATE_MAX_DRIFT_MS
  };
}
