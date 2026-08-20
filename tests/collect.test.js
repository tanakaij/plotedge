'use strict';
// Covers the three things that made the capture loop impossible to close in the
// field, plus the query engine added alongside them:
//
//   1. exports that produced no file at all inside the APK,
//   2. capture taps and back gestures that silently lost or destroyed work,
//   3. the attribute query language.
//
// The query engine is executed for real (it is pure, so it lifts straight out of
// the file); the DOM-bound fixes are asserted against the shipped source, in the
// same style as the theme/nav suites.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readIndex } = require('./lib');

const ROOT = path.join(__dirname, '..');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = readIndex();

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT ACTUALLY WRITES SOMETHING
// ══════════════════════════════════════════════════════════════════════════════
const exportSrc = read('js/17-export.js');

check('no export still relies on <a download>, which does nothing in the APK', () => {
  // A Capacitor WebView has no download manager, so an anchor click writes no file and reports
  // no error — the exact failure that made exported projects unfindable. Exactly ONE anchor is
  // allowed, and only inside saveExportFile()'s browser fallback, where it is reached only when
  // there is no native filesystem to write to. Anywhere else is a re-introduction of the bug.
  const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  const offenders = [];
  for (const f of ['js/17-export.js', 'js/05-projects.js']) {
    stripComments(read(f)).split('\n').forEach((line, i) => {
      if (/\.download\s*=|download\s*:/.test(line)) offenders.push(`${f}:${i + 1} ${line.trim()}`);
    });
  }
  assert(offenders.length <= 1, `anchor-download used outside the single fallback:\n    ${offenders.join('\n    ')}`);

  // ...and that one must genuinely be the fallback, not a stray survivor somewhere else.
  const src = read('js/17-export.js');
  const fallbackStart = src.indexOf('// Browser / PWA path.');
  const fallbackEnd = src.indexOf('async function offerShareFile');
  assert(fallbackStart !== -1 && fallbackEnd > fallbackStart, 'the browser fallback block is gone');
  const anchorAt = src.indexOf('.download = name');
  assert(anchorAt > fallbackStart && anchorAt < fallbackEnd,
    'the surviving anchor download is not inside saveExportFile()\'s browser fallback');
});

check('the native write targets a folder the user can actually open', () => {
  assert(/DOCUMENTS/.test(exportSrc), 'exports do not target the Documents directory');
  assert(/Filesystem/.test(exportSrc) && /writeFile/.test(exportSrc),
    'no Capacitor Filesystem write path — the APK would still produce nothing');
});

check('the object URL is not revoked in the same tick as the click', () => {
  // Revoking synchronously after click() can truncate or cancel a large export before the
  // browser has finished reading the blob. The old two-liner is quoted verbatim in the comment
  // block at the top of the file as the thing being fixed, so comments are stripped first —
  // otherwise this test fails on its own explanation.
  const live = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const src = live(exportSrc) + '\n' + live(read('js/05-projects.js'));
  assert(!/\.click\(\);\s*URL\.revokeObjectURL/.test(src),
    'revokeObjectURL still runs immediately after click()');
  assert(/setTimeout\(\(\)\s*=>\s*\{\s*URL\.revokeObjectURL/.test(exportSrc),
    'the browser fallback does not defer revocation');
});

check('the user is told where the file went', () => {
  assert(/function noteExportSaved/.test(exportSrc), 'no single place reports where an export landed');
  assert(/Saved "/.test(exportSrc) && /res\.where/.test(exportSrc),
    'the success message does not name the destination — "exported" with no path is what sent people hunting');
});

check('a failed write is reported as a failure, not as success', () => {
  assert(/Could not write/.test(exportSrc), 'no failure message for a write that did not land');
  // The old code printed "✓ CSV" unconditionally, before anything had been written.
  assert(!/exportStatus'\)\.textContent=`✓ CSV/.test(exportSrc),
    'CSV export still claims success without checking the write');
});

check('storage permissions are declared for the devices that need them', () => {
  const manifest = read('scripts/patch-android-manifest.py');
  assert(/WRITE_EXTERNAL_STORAGE/.test(manifest), 'no write permission — Filesystem fails on API <= 28');
  assert(/maxSdkVersion/.test(manifest), 'legacy storage permission is unbounded on modern targets');
});

check('the Filesystem and Share plugins are actual dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.dependencies['@capacitor/filesystem'], '@capacitor/filesystem is not installed — the native path would be dead');
  assert(pkg.dependencies['@capacitor/share'], '@capacitor/share is not installed');
});

// ══════════════════════════════════════════════════════════════════════════════
// CAPTURE AND BACK GESTURES
// ══════════════════════════════════════════════════════════════════════════════
const photoSrc = read('js/10-photos.js');
const geoSrc = read('js/09-geometry.js');
const bootSrc = read('js/22-boot.js');

check('the system back gesture cannot be read as swipe-to-delete', () => {
  // Android's Back is an inward edge swipe; from the right edge that is the identical motion to
  // swipe-to-delete, which is why going Back appeared to undo a capture.
  assert(/SWIPE_EDGE_GUTTER_PX/.test(photoSrc), 'no edge gutter — an edge-swipe still reaches the delete handler');
  assert(/window\.innerWidth\s*-\s*SWIPE_EDGE_GUTTER_PX/.test(photoSrc), 'the right edge is not excluded');
});

check('a cancelled swipe cancels instead of deleting', () => {
  // touchcancel is what fires when the OS claims the gesture. Wiring it to the same finish()
  // as touchend meant the delete committed on exactly the presses that were navigations.
  assert(!/addEventListener\('touchcancel',\s*finish\)/.test(photoSrc),
    'touchcancel still commits the delete');
  assert(/addEventListener\('touchcancel',\s*reset\)/.test(photoSrc),
    'touchcancel is not wired to a reset');
});

check('a capture tap always reports what happened', () => {
  // Both guards used to `return` silently; a tap that produced nothing is indistinguishable from
  // a vertex that was recorded but not drawn.
  const fn = geoSrc.slice(geoSrc.indexOf('function attemptCapture'), geoSrc.indexOf('function doCapture') > geoSrc.indexOf('function attemptCapture') ? geoSrc.indexOf('function doCapture') : geoSrc.length);
  const body = geoSrc.match(/function attemptCapture\(\)\{[\s\S]*?\n\}/);
  assert(body, 'attemptCapture not found');
  assert(!/if\(!currentPos\)\s*return;/.test(body[0]), 'a tap with no GPS fix still fails silently');
  assert((body[0].match(/showToast/g) || []).length >= 2,
    'not every early return from attemptCapture tells the user why nothing was captured');
});

check('a press that drifts off the capture button still captures', () => {
  // pointerup only reaches an element the finger is still over, and pointerleave was wired to
  // cancel — so press, thumb rolls a few mm, release produced no vertex and no message.
  assert(/setPointerCapture/.test(bootSrc), 'the capture button does not capture the pointer');
  assert(!/btn\.addEventListener\('pointerleave',\s*onCaptureBtnCancel\)/.test(bootSrc),
    'pointerleave still cancels a press in progress');
});

check('the vertex list is not subject to render-skipping containment', () => {
  // content-visibility:auto leaves a row as a blank placeholder for a frame or more on Android
  // WebViews — while the crew is checking whether the vertex they just captured is there.
  const css = read('css/05-components.css');
  const rule = css.split('\n').find(l => l.includes('.point-item {'));
  assert(rule && !/content-visibility/.test(rule), 'the vertex row still uses content-visibility');
});

check('the shape preview shows capture order', () => {
  assert(/sp-idx/.test(geoSrc), 'preview vertices carry no index label, so a mis-ordered ring cannot be spotted');
  assert(/sp-start/.test(geoSrc), 'the first vertex is not marked');
});

// ══════════════════════════════════════════════════════════════════════════════
// PLOTIN VERTEX MAP DOES NOT STAY BLANK
// ══════════════════════════════════════════════════════════════════════════════
// The Collect accordion (js/08-gps.js) shows one step card at a time. The PlotIn/PlotOut toggle
// lives in card 1 (Feature Type); the satellite/plan tap map (#vertexMap) lives in card 2
// (GPS & Capture). Selecting PlotIn while card 1 is still open builds the Leaflet map inside
// card 2's collapsed, 0x0 card-body — the tiles it fetches then are for a zero-size viewport, and
// the map stays blank even once the person later opens card 2. Regression coverage for the fix:
// setCardCollapsed() must invalidateSize() the vertex map whenever the card holding it opens.
const gpsSrc = read('js/08-gps.js');

check('opening the accordion card that holds #vertexMap kicks an invalidateSize', () => {
  const fn = gpsSrc.match(/function setCardCollapsed\([\s\S]*?\n\}/);
  assert(fn, 'setCardCollapsed not found');
  assert(/vertexMap[\s\S]*?invalidateSize/.test(fn[0]),
    'setCardCollapsed never invalidates the vertex map\'s size — PlotIn can stay a blank box even after the card opens');
  // Must be conditioned on the card actually opening (collapsed === false), not firing on every
  // toggle — invalidating a still-collapsed map is a no-op that hides the real bug.
  assert(/!collapsed/.test(fn[0]), 'the invalidateSize call is not gated on the card opening');
});

// ══════════════════════════════════════════════════════════════════════════════
// SAVE IS ALL-OR-NOTHING
// ══════════════════════════════════════════════════════════════════════════════
const featSrc = read('js/11-features.js');

check('the form is not cleared before the write is known to have landed', () => {
  const fn = featSrc.slice(featSrc.indexOf('function finalizeSaveFeature'));
  const clearAt = fn.indexOf('clearDraft()');
  const persistAt = fn.indexOf('persist()');
  assert(persistAt !== -1 && clearAt !== -1, 'finalizeSaveFeature no longer persists or clears');
  assert(persistAt < clearAt, 'the crash draft is still discarded before the save is confirmed');
  assert(/persist\(\)\s*===\s*false/.test(fn), 'the return value of persist() is still ignored');
});

check('a refused save puts the capture back', () => {
  const fn = featSrc.slice(featSrc.indexOf('function finalizeSaveFeature'));
  assert(/savedFeatures = prevSaved/.test(fn), 'no rollback of the feature list');
  assert(/currentVertices = prevVertices/.test(fn), 'the captured vertices are not restored');
});

check('two features saved in the same millisecond get different ids', () => {
  assert(/function newFeatureId/.test(featSrc), 'ids are still raw Date.now()');
  assert(!/id:Date\.now\(\)/.test(featSrc), 'a Date.now() id remains — two features can collide');
});

// ══════════════════════════════════════════════════════════════════════════════
// QUERY ENGINE
// ══════════════════════════════════════════════════════════════════════════════
// Lifted and run for real. The parser/evaluator touch no DOM, so this exercises
// the shipped code rather than a description of it.
const qSrc = read('js/11a-attr-query.js');
const ctx = { console, Math, JSON, Number, String, Array, Object, RegExp, isFinite, Set, Map, document: { getElementById: () => null } };
ctx.globalThis = ctx;
vm.createContext(ctx);
// Everything above the query-state section is pure; the rest touches the DOM.
vm.runInContext(qSrc.slice(0, qSrc.indexOf('// ══ QUERY STATE')), ctx, { filename: 'attr-query' });

const COLS = [
  { key: '__name', label: 'Feature', get: f => f.name },
  { key: '__acc', label: 'Acc (m)', get: f => f.acc, num: true },
  { key: '__photos', label: 'Photos', get: f => f.photos, num: true },
  { key: 'condition', label: 'Condition', get: f => f.condition }
];
const ROWS = [
  { name: 'Pole 1', acc: 2.4, photos: 1, condition: 'good' },
  { name: 'Pole 2', acc: 8.1, photos: 0, condition: 'poor' },
  { name: 'Dam wall', acc: 12.0, photos: 3, condition: 'poor' },
  { name: 'Pole 10', acc: 1.1, photos: 0, condition: null }
];
const run = expr => {
  const q = ctx.compileAttrQuery(expr, COLS);
  if (!q.ok) throw new Error('failed to compile: ' + q.error);
  return ROWS.filter(q.test).map(r => r.name);
};

check('comparison and AND', () => {
  const got = run('"__acc" > 5 AND "condition" = \'poor\'');
  assert(JSON.stringify(got) === JSON.stringify(['Pole 2', 'Dam wall']), 'got ' + JSON.stringify(got));
});

check('ILIKE with wildcards is case-insensitive', () => {
  const got = run('"__name" ILIKE \'%pole%\'');
  assert(got.length === 3, 'got ' + JSON.stringify(got));
});

check('IN and NOT IN', () => {
  assert(run('"condition" IN (\'poor\',\'fair\')').length === 2, 'IN failed');
  assert(JSON.stringify(run('"condition" NOT IN (\'poor\')')) === JSON.stringify(['Pole 1']), 'NOT IN failed');
});

check('IS NULL finds blanks that <> deliberately does not', () => {
  // SQL/QGIS semantics: a comparison against a missing value is unknown, not false. If <> matched
  // blanks, "condition" <> 'poor' would quietly report un-surveyed features as surveyed.
  assert(JSON.stringify(run('"condition" IS NULL')) === JSON.stringify(['Pole 10']), 'IS NULL failed');
  assert(!run('"condition" <> \'poor\'').includes('Pole 10'), 'a NULL leaked into a <> comparison');
});

check('OR, NOT and parentheses group correctly', () => {
  const got = run('("__photos" = 0 OR "__acc" > 10) AND NOT "__name" = \'Pole 10\'');
  assert(JSON.stringify(got) === JSON.stringify(['Pole 2', 'Dam wall']), 'got ' + JSON.stringify(got));
});

check('functions work', () => {
  assert(JSON.stringify(run('lower("condition") = \'poor\'')) === JSON.stringify(['Pole 2', 'Dam wall']), 'lower() failed');
  // 'Dam wall' is 8 and 'Pole 10' is 7, so > 7 isolates exactly one row.
  assert(JSON.stringify(run('length("__name") > 7')) === JSON.stringify(['Dam wall']), 'length() failed');
  assert(JSON.stringify(run('round("__acc") = 2')) === JSON.stringify(['Pole 1']), 'round() failed');
  assert(run('coalesce("condition", \'unknown\') = \'unknown\'').length === 1, 'coalesce() failed');
});

check('fields resolve by label as well as by key', () => {
  // The header shows "Acc (m)" and an export shows __acc; a user will type whichever they saw last.
  assert(run('"Acc (m)" > 5').length === 2, 'label lookup failed');
  assert(run('acc > 5').length === 2, 'bare/short name lookup failed');
});

check('a bad expression reports why instead of emptying the table', () => {
  const bad = ctx.compileAttrQuery('"condition" = ', COLS);
  assert(!bad.ok && bad.error, 'an incomplete expression compiled anyway');
  const unknown = ctx.compileAttrQuery('"nosuchfield" = 1', COLS);
  assert(!unknown.ok && /no field called/.test(unknown.error), 'an unknown field was not reported');
  const unclosed = ctx.compileAttrQuery("\"name\" = 'poor", COLS);
  assert(!unclosed.ok, 'an unclosed quote compiled anyway');
});

check('an empty query matches everything', () => {
  const q = ctx.compileAttrQuery('   ', COLS);
  assert(q.ok && q.empty && ROWS.filter(q.test).length === 4, 'a blank query did not pass everything through');
});

check('LIKE metacharacters in the data cannot become a pattern', () => {
  const rows = [{ name: 'a.c' }, { name: 'abc' }];
  const cols = [{ key: 'name', label: 'name', get: f => f.name }];
  const q = ctx.compileAttrQuery("\"name\" LIKE 'a.c'", cols);
  assert(q.ok && rows.filter(q.test).length === 1, 'the . was treated as a regex wildcard');
});

// ══════════════════════════════════════════════════════════════════════════════
// QUERY UI IS WIRED UP
// ══════════════════════════════════════════════════════════════════════════════
check('the query is visible whenever it is filtering', () => {
  // A narrowed attribute table that looks like the whole project is how features get reported
  // missing, so the applied expression must always be on screen with a way to clear it.
  assert(/attrQueryActiveBar/.test(html), 'no banner showing the applied query');
  assert(/clearAttrQuery\(\)/.test(html), 'no one-tap way to clear the query');
});

check('the table, the card list and Copy all honour the query', () => {
  const review = read('js/12-review.js');
  assert(/applyAttrQueryFilter/.test(review), 'the attribute table ignores the query');
  const copyFn = review.slice(review.indexOf('function copyAttributeTable'));
  assert(/applyAttrQueryFilter/.test(copyFn.slice(0, 400)),
    'Copy exports the unfiltered project after the user deliberately narrowed it');
});

check('selection is separate from filtering', () => {
  assert(/attrSelection/.test(qSrc) && /toggleShowSelectedOnly/.test(qSrc),
    'no selection model — "select these, then widen the filter" is impossible');
  assert(/zoomToAttrSelection/.test(qSrc), 'no zoom-to-selection');
});

check('both new sheets are closable with the back button', () => {
  const nav = read('js/07-navigation.js');
  assert(/closeAttrQuery\(\)/.test(nav) && /closeAttrStats\(\)/.test(nav),
    'a new sheet is not in closeTopOverlay() — back would navigate the screen out from under it');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  // tests/run.js totals the suites by parsing this line. Without it the suite runs, prints, and
  // contributes nothing to the count — passing and failing alike, which is worse than not
  // running at all.
  console.log(`\n  collect: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
