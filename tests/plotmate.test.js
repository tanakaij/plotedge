// PlotMate identity layer — the merge rules, tested in isolation.
//
// These are the properties the whole collaboration feature rests on. If any of
// them fails, "newest wins" is not well defined and a sync will lose a crew's
// work, so they are asserted directly rather than inferred from UI behaviour.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', '03a-plotmate.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

// Each "device" is a fresh sandbox with its own localStorage, which is exactly
// what a second tablet is.
function makeDevice(now) {
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    projectData: {},
    Date: Object.assign(function () {}, Date),
    console,
    module: { exports: {} }
  };
  sandbox.Date.now = now || Date.now;
  sandbox.Date.parse = Date.parse;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: '03a-plotmate.js' });
  sandbox.__store = store;
  return sandbox;
}

console.log('');

check('a device id is stable across reloads and unique across devices', () => {
  const a = makeDevice();
  const first = a.plotmateDeviceId();
  assert.strictEqual(first.length, 8, 'device id should be 8 chars, got ' + first.length);
  assert.strictEqual(a.plotmateDeviceId(), first, 'device id changed within a session');
  // Same localStorage, fresh script execution = a reload.
  const reloaded = makeDevice();
  reloaded.__store.set('plotedge_plotmate_device', first);
  assert.strictEqual(reloaded.plotmateDeviceId(), first, 'device id not restored from storage');

  const b = makeDevice();
  assert.notStrictEqual(b.plotmateDeviceId(), first, 'two devices minted the same id');
});

check('stamps from one device are strictly ordered, even within a millisecond', () => {
  const d = makeDevice(() => 1000);   // clock frozen: worst case
  const stamps = [];
  for (let i = 0; i < 50; i++) stamps.push(d.plotmateStamp());
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(d.plotmateCompare(stamps[i], stamps[i - 1]) > 0,
      `stamp ${i} did not outrank stamp ${i - 1} under a frozen clock`);
  }
});

check('a clock that jumps backwards cannot reissue a stamp', () => {
  let t = 5000;
  const d = makeDevice(() => t);
  const before = d.plotmateStamp();
  t = 3000;                            // NTP correction / manual clock change
  const after = d.plotmateStamp();
  assert.ok(d.plotmateCompare(after, before) > 0,
    'an edit made after a backwards clock jump compared as older');
});

check('monotonicity survives a reload', () => {
  const store = new Map();
  const mk = () => {
    const s = makeDevice(() => 7000);
    s.__store.forEach && null;
    // share one storage between the two runs
    s.localStorage.getItem = k => (store.has(k) ? store.get(k) : null);
    s.localStorage.setItem = (k, v) => store.set(k, String(v));
    return s;
  };
  const a = mk(); const s1 = a.plotmateStamp();
  const b = mk(); const s2 = b.plotmateStamp();
  assert.ok(b.plotmateCompare(s2, s1) > 0,
    'a stamp issued after a reload did not outrank one from before it');
});

check('both devices independently pick the SAME winner', () => {
  const a = makeDevice(() => 1000);
  const b = makeDevice(() => 1000);
  const sa = a.plotmateStamp();
  const sb = b.plotmateStamp();
  // Identical physical time and counter — resolved only by the device tiebreak.
  assert.strictEqual(sa.t, sb.t);
  assert.strictEqual(sa.c, sb.c);
  const verdictA = a.plotmateCompare(sa, sb);
  const verdictB = b.plotmateCompare(sa, sb);
  assert.notStrictEqual(verdictA, 0, 'two concurrent edits compared as equal — no winner');
  assert.strictEqual(verdictA, verdictB,
    'the two devices disagreed about who won — this is the data-loss case');
});

check('observing a remote stamp keeps our next edit newer than it', () => {
  const a = makeDevice(() => 1000);
  const remote = { t: 9000, c: 3, d: 'zzzzzzzz' };   // a device that is ahead of us
  a.plotmateObserve(remote);
  const mine = a.plotmateStamp();
  assert.ok(a.plotmateCompare(mine, remote) > 0,
    'an edit made after seeing a newer remote edit was stamped as older than it');
});

check('an implausible remote clock cannot poison ours', () => {
  const a = makeDevice(() => 1000);
  const insane = { t: 1000 + 400 * 24 * 60 * 60 * 1000, c: 0, d: 'yyyyyyyy' };
  a.plotmateObserve(insane);
  const mine = a.plotmateStamp();
  assert.ok(mine.t < insane.t, 'adopted a clock over a year in the future');
});

check('uids never collide across devices, even at the same instant', () => {
  const a = makeDevice(() => 1000);
  const b = makeDevice(() => 1000);
  const seen = new Set();
  for (let i = 0; i < 200; i++) { seen.add(a.plotmateUid('ft')); seen.add(b.plotmateUid('ft')); }
  assert.strictEqual(seen.size, 400, `expected 400 distinct uids, got ${seen.size}`);
});

check('migration preserves the real history order of legacy features', () => {
  const d = makeDevice();
  const older = d.plotmateMigrateFeature({ id: 1, savedAt: '2026-01-02T00:00:00.000Z' });
  const newer = d.plotmateMigrateFeature({ id: 2, savedAt: '2026-01-01T00:00:00.000Z',
                                           editedAt: '2026-03-01T00:00:00.000Z' });
  assert.ok(d.plotmateCompare(newer.rev, older.rev) > 0,
    'a feature edited later did not outrank one edited earlier after migration');
  assert.ok(newer.uid && older.uid && newer.uid !== older.uid, 'migration minted colliding uids');
});

check('migration is idempotent — a second load does not re-stamp', () => {
  const d = makeDevice();
  const f = d.plotmateMigrateFeature({ id: 1, savedAt: '2026-01-02T00:00:00.000Z' });
  const uid = f.uid, rev = JSON.stringify(f.rev);
  d.plotmateMigrateFeature(f);
  d.plotmateMigrateFeature(f);
  assert.strictEqual(f.uid, uid, 'uid changed on a second migration pass');
  assert.strictEqual(JSON.stringify(f.rev), rev, 'revision changed on a second migration pass');
});

check('an undatable legacy feature sorts below every real edit', () => {
  const d = makeDevice();
  const orphan = d.plotmateMigrateFeature({ id: 9 });
  const real = d.plotmateMigrateFeature({ id: 10, savedAt: '2020-01-01T00:00:00.000Z' });
  assert.ok(d.plotmateCompare(real.rev, orphan.rev) > 0,
    'a feature with no timestamp outranked a real dated edit');
});

check('touch stamps a new record and bumps an existing one', () => {
  const d = makeDevice();
  const f = {};
  d.plotmateTouch(f, 'ft');
  assert.ok(f.uid && f.rev, 'touch did not stamp a fresh record');
  const uid = f.uid, first = f.rev;
  d.plotmateTouch(f, 'ft');
  assert.strictEqual(f.uid, uid, 'touch changed the uid of an existing record');
  assert.ok(d.plotmateCompare(f.rev, first) > 0, 'touch did not advance the revision');
});

check('deleting records a tombstone, and undo withdraws it', () => {
  const d = makeDevice();
  d.projectData['p1'] = { savedFeatures: [] };
  const f = d.plotmateTouch({ name: 'Manhole 4' }, 'ft');

  d.plotmateRecordDelete('p1', f);
  assert.strictEqual(d.plotmateTombstones('p1').length, 1, 'delete did not record a tombstone');
  assert.strictEqual(d.plotmateTombstones('p1')[0].u, f.uid, 'tombstone points at the wrong uid');

  d.plotmateWithdrawDelete('p1', f);
  assert.strictEqual(d.plotmateTombstones('p1').length, 0, 'undo did not withdraw the tombstone');
});

check('a tombstone outranks the edit it is meant to beat', () => {
  const d = makeDevice();
  d.projectData['p1'] = { savedFeatures: [] };
  const f = d.plotmateTouch({ name: 'Manhole 4' }, 'ft');
  const staleEdit = f.rev;
  d.plotmateRecordDelete('p1', f);
  const tomb = d.plotmateTombstones('p1')[0];
  assert.ok(d.plotmateCompare(tomb.rev, staleEdit) > 0,
    'the delete did not outrank the edit that preceded it — the feature would return');
});

check('repeated delete/undo cycles do not grow the tombstone list', () => {
  const d = makeDevice();
  d.projectData['p1'] = { savedFeatures: [] };
  const f = d.plotmateTouch({ name: 'Manhole 4' }, 'ft');
  for (let i = 0; i < 25; i++) d.plotmateRecordDelete('p1', f);
  assert.strictEqual(d.plotmateTombstones('p1').length, 1,
    'tombstones accumulated per delete instead of per feature');
});

check('a legacy feature deleted before it was ever stamped still tombstones', () => {
  const d = makeDevice();
  d.projectData['p1'] = { savedFeatures: [] };
  const legacy = { id: 41, savedAt: '2026-02-02T00:00:00.000Z' };  // no uid
  d.plotmateRecordDelete('p1', legacy);
  const list = d.plotmateTombstones('p1');
  assert.strictEqual(list.length, 1, 'an unstamped feature produced no tombstone');
  assert.ok(list[0].u, 'tombstone recorded an empty uid');
});

console.log(`\n  plotmate: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
