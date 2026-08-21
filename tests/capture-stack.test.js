'use strict';
// Drives the capture stack (js/06a-capture-stack.js) and the replacement
// rotation control (js/13b-map-rotate.js) in a real DOM.
//
// Both features exist to fix bugs that every static check passed straight over.
// The old "switch feature type mid-capture" path parsed fine, wired up fine, and
// silently moved a road's vertices onto a traffic sign. The plugin's compass
// control parsed fine too, and set the map's bearing to a raw pixel delta. So
// this suite runs them: it seeds a project, starts a line, pauses it, collects a
// point, and asserts the line comes back with its own vertices, its own
// attributes and its own photos — and separately that a drag on the compass
// produces a bearing relative to where the drag started.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── boot ─────────────────────────────────────────────────────────────────────
// Leaflet is absent on purpose for the capture-stack half: none of it touches a
// map, and every map factory already has to survive Leaflet never loading (the
// offline first-launch case). The rotation half builds its own minimal L.
function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    beforeParse(w) {
      w.JSZip = function () {};
      w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
      w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
      w.URL.createObjectURL = () => 'blob:stub';
      w.URL.revokeObjectURL = () => {};
      w.indexedDB = new FDBFactory();
      w.IDBKeyRange = FDBKeyRange;
      w.onerror = msg => { errors.push(String(msg)); return true; };
    }
  });
  const w = dom.window;
  w.addEventListener('error', e => errors.push(e.message || String(e.error)));
  for (const f of jsOrder) {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    try { w.document.head.appendChild(el); }
    catch (e) { errors.push(`js/${f}: ${e.message}`); }
  }
  return { w, errors };
}

// A road (line, with a per-feature "surface" attribute) and a sign (point).
// Two types, because the whole feature is about moving between them.
function seed(w) {
  // Through eval for the same reason everything else is: `projects` and
  // `projectData` are top-level `let`s, so assigning w.projects would create an
  // unrelated window property and openProject() would find nothing.
  w.eval(`
    projects = [{ id: 'p1', name: 'Stack test', createdAt: new Date().toISOString() }];
    projectData = {
      p1: {
        savedFeatures: [],
        currentVertices: [],
        featureTypes: [
          { id: 'road', name: 'Road', geometryType: 'line', fields: [
            { id: 'surface', label: 'Surface', type: 'single_select', options: ['gravel', 'paved'] }
          ] },
          { id: 'sign', name: 'Traffic Sign', geometryType: 'point', fields: [
            { id: 'sign_code', label: 'Code', type: 'text' },
            // The link field under test: a sign hangs off the road it stands on. Constrained to
            // 'road', which is what makes the picker offer roads rather than every feature.
            { id: 'on_road', label: 'On road', type: 'feature_ref', refTargetFtId: 'road' }
          ] }
        ]
      }
    };
    openProject('p1');
    switchTab('collect');
  `);
}

const { w, errors } = boot();
seed(w);
const doc = w.document;
const $ = id => doc.getElementById(id);
// Top-level `let`/`const` in a classic script land in the global DECLARATIVE
// scope, not on `window` — so currentVertices, suspendedCaptures and
// CAPTURE_STACK_MAX are unreachable as properties however the app is booted.
// window.eval is an indirect eval, which runs at global scope and can see them.
// Everything below that touches app state goes through this rather than through
// `w.`, which would silently create a shadowing window property and test nothing.
const run = code => w.eval(code);

// Puts a half-finished road on the Collect tab: two vertices, one carrying a
// photo, a name, and an answered attribute.
function startRoad() {
  $('featureTypeSelect').value = 'road';
  w.onFeatureTypeChange();
  $('featureName').value = 'Main Street';
  const surface = $('attr_surface');
  if (surface) surface.value = 'gravel';
  run(`currentVertices = [
    { lat: -17.82, lon: 31.05, acc: 4, time: new Date().toISOString(), attrs: {}, photos: [{ id: 'ph1', name: 'ph1.jpg' }] },
    { lat: -17.83, lon: 31.06, acc: 4, time: new Date().toISOString(), attrs: {}, photos: [] }
  ]; updateGeometryUI(getFeatureType('road'));`);
}

check('nothing threw while the app booted and the project opened', () => {
  assert(!errors.length, errors.join(' | '));
});

check('a capture with no vertices and no name cannot be paused', () => {
  assert(run('suspendCurrentCapture()') === false, 'an empty form was allowed onto the stack');
  assert(run('suspendedCaptures.length') === 0, 'an empty form left a row in the resume bar');
});

check('pausing a road clears the form completely', () => {
  startRoad();
  assert(run('suspendCurrentCapture()') === true, 'a real capture was refused');
  // THE bug this feature exists to prevent: the road's vertices becoming the
  // sign's vertices. Every field the road touched has to be gone.
  assert(run('currentVertices.length') === 0, `the road's vertices survived the pause (${run('currentVertices.length')})`);
  assert($('featureName').value === '', `the road's name survived the pause ("${$('featureName').value}")`);
  assert(run('openVertexIndex') === null, 'an open vertex index survived the pause');
});

check('the paused road is on the stack with its vertices, attributes and photos', () => {
  assert(run('suspendedCaptures.length') === 1, 'the road is not on the stack');
  const s = run('suspendedCaptures[0]');
  assert(s.ftId === 'road', `wrong type parked: ${s.ftId}`);
  assert(s.name === 'Main Street', `wrong name parked: ${s.name}`);
  assert(s.vertices.length === 2, `wrong vertex count parked: ${s.vertices.length}`);
  assert(s.attrs.surface === 'gravel', `the road's attribute was not parked: ${JSON.stringify(s.attrs)}`);
  assert((s.vertices[0].photos || []).length === 1, 'the vertex photo was not parked');
});

check('the parked copy is a deep copy, not a live reference', () => {
  // A shallow copy would have the parked road silently follow whatever the next
  // capture does to currentVertices — the subtler version of the same bug.
  const before = run('suspendedCaptures[0].vertices.length');
  run('currentVertices.push({ lat: 0, lon: 0, attrs: {}, photos: [] })');
  assert(run('suspendedCaptures[0].vertices.length') === before, 'mutating the live capture changed the parked one');
  run('currentVertices = []');
});

check('the resume bar renders a row for the paused road', () => {
  w.renderCaptureStack();
  const bar = $('captureStackBar');
  assert(bar.style.display !== 'none', 'the resume bar is hidden while a capture is paused');
  w.eval('captureStackOpen = true'); w.renderCaptureStack();   // the bar rests collapsed
  assert(bar.querySelectorAll('.cap-stack-row').length === 1, 'no row rendered for the paused road');
  assert(bar.textContent.includes('Main Street'), 'the row does not name the paused capture');
});

check('collecting the interrupting sign does not disturb the paused road', () => {
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Stop sign 12';
  const code = $('attr_sign_code');
  if (code) code.value = 'R1-1';
  run(`currentVertices = [{ lat: -17.825, lon: 31.055, acc: 3, time: new Date().toISOString(), attrs: {}, photos: [] }]; saveFeature();`);
  assert(run('savedFeatures.length') === 1, `the sign did not save (${run('savedFeatures.length')} features)`);
  assert(run("savedFeatures[0].featureTypeId") === 'sign', 'the saved feature is not the sign');
  assert(run('savedFeatures[0].vertices.length') === 1, "the sign inherited the road's vertices");
  assert(run('suspendedCaptures.length') === 1, 'saving the sign disturbed the stack');
});

check('resuming brings the road back exactly as it was left', () => {
  run('resumeCapture(suspendedCaptures[0].id)');
  assert(run('suspendedCaptures.length') === 0, 'the resumed road is still on the stack');
  assert($('featureTypeSelect').value === 'road', 'the type did not switch back to the road');
  assert($('featureName').value === 'Main Street', `the name did not come back: "${$('featureName').value}"`);
  assert(run('currentVertices.length') === 2, `the vertices did not come back (${run('currentVertices.length')})`);
  assert(run('(currentVertices[0].photos || []).length') === 1, 'the vertex photo did not come back');
  const surface = $('attr_surface');
  assert(surface && surface.value === 'gravel', 'the answered attribute did not come back');
});

check('the resumed road saves as one feature, not two', () => {
  run('saveFeature()');
  assert(run('savedFeatures.length') === 2, `expected the sign and one road, got ${run('savedFeatures.length')}`);
  const road = run("savedFeatures.find(f => f.featureTypeId === 'road')");
  assert(road, 'the road never saved');
  assert(road.vertices.length === 2, `the road saved with ${road.vertices.length} vertices, not 2`);
  assert(road.attrs.surface === 'gravel', 'the road saved without its attribute');
});

check('resuming while something else is in progress swaps rather than discards', () => {
  startRoad();
  run('suspendCurrentCapture()');            // road parked
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Sign in progress';
  run('currentVertices = [{ lat: -17.8, lon: 31.0, attrs: {}, photos: [] }]');
  run('resumeCapture(suspendedCaptures[0].id)'); // pull the road back mid-sign
  assert($('featureName').value === 'Main Street', 'the road did not come back');
  assert(run('suspendedCaptures.length') === 1, 'the in-progress sign was thrown away instead of parked');
  assert(run('suspendedCaptures[0].name') === 'Sign in progress', 'the wrong capture was parked on the swap');
});

check('a swap says what happened to the capture that was on screen', () => {
  // A swap that silently parks your traffic sign reads exactly like a swap that
  // silently deleted it. The toast has to name both ends.
  run(`suspendedCaptures = []; blankCollectForm();`);
  startRoad();
  run('suspendCurrentCapture()');
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Sign in progress';
  run(`resumeCapture(suspendedCaptures[0].id)`);
  const toast = $('toast').textContent;
  assert(toast.includes('Main Street'), `the toast does not name the resumed capture: "${toast}"`);
  assert(toast.includes('Sign in progress'), `the toast does not say the in-progress capture was parked: "${toast}"`);
  assert(/paused/i.test(toast), `the toast does not say what happened to it: "${toast}"`);
});

check('the bar warns that resuming will park the capture in progress', () => {
  w.eval('captureStackOpen = true'); w.renderCaptureStack();
  const bar = $('captureStackBar');
  assert(bar.querySelector('.cap-stack-note'), 'no note rendered while a capture is in progress');
  assert(bar.textContent.includes('Main Street'), 'the note does not name the capture in progress');
  assert(bar.textContent.includes('Swap to this'), 'Resume still reads as a plain restore during a swap');
});

check('discard-and-resume bins the current capture and restores the paused one', () => {
  // The whole point: one tap for "I started this by mistake, put me back",
  // instead of Clear current feature followed by a scroll and a Resume.
  run(`suspendedCaptures = []; blankCollectForm();`);
  startRoad();
  run('suspendCurrentCapture()');                       // road parked
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Mis-started sign';
  run(`currentVertices = [{ lat: -17.8, lon: 31.0, attrs: {}, photos: [] }]`);

  run(`resumeCaptureDiscardingCurrent(suspendedCaptures[0].id)`);
  // showConfirm is a real dialog in the shipped app — take the confirming path
  // the way a user would rather than reaching past it.
  $('confirmModalOk').click();

  assert($('featureName').value === 'Main Street', `the road did not come back: "${$('featureName').value}"`);
  assert(run('currentVertices.length') === 2, `the road's vertices did not come back (${run('currentVertices.length')})`);
  assert(run('suspendedCaptures.length') === 0,
    `the mis-started sign was parked instead of discarded (${run('suspendedCaptures.length')} on the stack)`);
});

check('discard-and-resume with nothing in progress is just a resume', () => {
  run(`suspendedCaptures = []; blankCollectForm();`);
  startRoad();
  run('suspendCurrentCapture()');
  run(`blankCollectForm(); resumeCaptureDiscardingCurrent(suspendedCaptures[0].id);`);
  assert($('featureName').value === 'Main Street', 'the road did not come back without a confirm step');
  assert(run('suspendedCaptures.length') === 0, 'the stack was not emptied by the resume');
});

check('three deep: road, side road, sign — saved back out in reverse order', () => {
  // The scenario this feature was actually asked for. Each pause must park a
  // complete, independent capture, and unwinding must produce three separate
  // features with their own geometry — not one merged mess.
  // savedFeatures is NOT cleared here: persistStore()'s write guard refuses any
  // save that would reduce what is on disk unless it is explicitly destructive,
  // so zeroing it would make every save below fail. Count the delta instead.
  run(`suspendedCaptures = []; blankCollectForm();`);
  const before = run('savedFeatures.length');

  const start = (ftId, name, verts) => {
    $('featureTypeSelect').value = ftId;
    w.onFeatureTypeChange();
    $('featureName').value = name;
    run(`currentVertices = ${JSON.stringify(verts)}; updateGeometryUI(getFeatureType('${ftId}'));`);
  };
  // Names are unique across the whole suite on purpose: saveFeature() treats a
  // repeated name as probably-accidental and opens a confirm instead of saving,
  // which would stall this walkthrough on its first step.
  const line = n => Array.from({ length: n }, (_, i) => ({ lat: -17.8 - i / 100, lon: 31 + i / 100, attrs: {}, photos: [] }));

  start('road', 'Nested Main', line(3));
  assert(run('suspendCurrentCapture()') === true, 'the main road would not pause');

  start('road', 'Nested Side', line(2));
  assert(run('suspendCurrentCapture()') === true, 'the side road would not pause');
  assert(run('suspendedCaptures.length') === 2, 'both roads are not parked');

  // The sign, collected on top of two parked roads, and saved.
  start('sign', 'Nested Sign', line(1));
  run('saveFeature()');
  assert(run('savedFeatures.length') === before + 1, `the sign did not save — app said: "${$('toast').textContent}"`);
  assert(run('suspendedCaptures.length') === 2, 'saving the sign disturbed the parked roads');

  // Unwind: side road (last in, first out), then the main road.
  run(`resumeCapture(suspendedCaptures[suspendedCaptures.length - 1].id)`);
  assert($('featureName').value === 'Nested Side', `expected the side road back, got "${$('featureName').value}"`);
  assert(run('currentVertices.length') === 2, 'the side road came back with the wrong geometry');
  run('saveFeature()');

  run(`resumeCapture(suspendedCaptures[suspendedCaptures.length - 1].id)`);
  assert($('featureName').value === 'Nested Main', `expected the main road back, got "${$('featureName').value}"`);
  assert(run('currentVertices.length') === 3, 'the main road came back with the wrong geometry');
  run('saveFeature()');

  assert(run('suspendedCaptures.length') === 0, 'the stack did not empty');
  assert(run('savedFeatures.length') === before + 3, `expected three new features, got ${run('savedFeatures.length') - before}`);
  const byName = n => run(`savedFeatures.find(f => f.name === ${JSON.stringify(n)})`);
  assert(byName('Nested Sign').vertices.length === 1, 'the sign did not keep its own single vertex');
  assert(byName('Nested Side').vertices.length === 2, 'the side road did not keep its own two vertices');
  assert(byName('Nested Main').vertices.length === 3, 'the main road did not keep its own three vertices');
});

// ══════════════════════════════════════════════════════════════════════════
// REFERENCE IDS ARE IDENTIFIERS, SO THEY HAVE TO BE UNIQUE
// ══════════════════════════════════════════════════════════════════════════
// These live in this suite rather than features.test.js because the bug they cover is a capture-
// STACK bug. generateReferenceId() counted saved features of the type and added one, which is
// correct only while exactly one capture is in flight — and the stack exists precisely so it is
// not. Pause a road, start another, and both autofilled the same number. Nothing caught it,
// because a duplicated ref still looks like a ref; it surfaces months later when the register is
// matched against another system and one asset ID returns two rows.
check('two captures of the same type parked at once do not autofill the same ref', () => {
  run(`suspendedCaptures = []; blankCollectForm();`);
  const startRoadNamed = name => {
    $('featureTypeSelect').value = 'road';
    w.onFeatureTypeChange();
    $('featureName').value = name;
    run(`currentVertices = [{lat:-17.8,lon:31,attrs:{},photos:[]},{lat:-17.81,lon:31.01,attrs:{},photos:[]}];`);
  };
  startRoadNamed('Ref collide A');
  const refA = $('featureRef').value;
  assert(refA, 'the first capture did not autofill a ref at all');
  run('suspendCurrentCapture()');

  startRoadNamed('Ref collide B');
  const refB = $('featureRef').value;
  assert(refB && refB !== refA,
    `both captures autofilled the same reference ID (${refA}) — the counter is ignoring the stack`);
  run(`suspendedCaptures = []; blankCollectForm();`);
});

check('a ref already used elsewhere in the project is queried before it is saved', () => {
  // A warning, never a block. Refs legitimately arrive pre-printed and occasionally duplicated on
  // the asset itself, and a crew standing in front of a tag that genuinely reads POLE-014 twice has
  // to be able to record what is there. What matters is that the save cannot happen SILENTLY, and
  // that the prompt names the other feature — that turns "that's a duplicate" into "that's the one
  // I did on Tuesday".
  run(`suspendedCaptures = []; blankCollectForm();`);
  const before = run('savedFeatures.length');
  const existing = run(`savedFeatures.find(f => (f.ref||'').trim())`);
  assert(existing, 'no already-saved feature carries a ref to collide with');

  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Ref clash probe';
  $('featureRef').value = existing.ref;
  run(`currentVertices = [{lat:-17.8,lon:31,attrs:{},photos:[]}];`);
  run('saveFeature()');

  assert(run('savedFeatures.length') === before,
    'the duplicate ref was saved without asking');
  const msg = $('confirmModalMsg').textContent;
  assert(new RegExp(existing.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(msg),
    `the prompt does not quote the clashing ref: "${msg}"`);
  assert(msg.indexOf(existing.name) !== -1,
    `the prompt does not name the feature already using it: "${msg}"`);

  // Confirming goes through, because the crew is the one who can see the tag.
  $('confirmModalOk').click();
  assert(run('savedFeatures.length') === before + 1,
    'confirming the duplicate ref did not save the feature');
});

check('an empty ref is not treated as a collision', () => {
  // Ref is optional, and two features with no ref are not two features sharing one. Getting this
  // wrong would put a confirm in front of every single save on a survey that does not use refs.
  run(`suspendedCaptures = []; blankCollectForm();`);
  run(`savedFeatures.push({ id:'noref_a', name:'No ref A', ref:'', featureTypeId:'sign', vertices:[{lat:-17.8,lon:31}], attrs:{} });`);
  const before = run('savedFeatures.length');
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'No ref B';
  $('featureRef').value = '';
  run(`currentVertices = [{lat:-17.8,lon:31,attrs:{},photos:[]}];`);
  run('saveFeature()');
  assert(run('savedFeatures.length') === before + 1,
    `an empty ref raised a prompt instead of saving: "${$('confirmModalMsg').textContent}"`);
});

check('editing a feature does not collide with its own ref', () => {
  // The check skips the feature being edited. Without that, re-saving any feature that has a ref
  // would accuse it of clashing with itself — a confirm on every single edit.
  run(`suspendedCaptures = []; blankCollectForm();`);
  // Must be a feature whose ref is unique in the project — the check above deliberately created a
  // genuine duplicate, and picking that one would be testing the clash path, not the self path.
  const target = run(`savedFeatures.find(f => {
    const r = (f.ref||'').trim().toLowerCase();
    return r && savedFeatures.filter(g => (g.ref||'').trim().toLowerCase() === r).length === 1;
  })`);
  assert(target, 'no feature with a unique ref to re-save');
  const before = run('savedFeatures.length');
  run(`editFeature(${JSON.stringify(target.id)})`);
  assert(run('editingFeatureId') === target.id, 'the feature did not open for editing');
  run('saveFeature()');
  assert(run('savedFeatures.length') === before,
    'editing created a new feature instead of updating');
  assert(!$('confirmModal').classList.contains('show'),
    `re-saving a feature accused it of clashing with its own ref: "${$('confirmModalMsg').textContent}"`);
});

// ══════════════════════════════════════════════════════════════════════════
// LINKING ONE FEATURE TO ANOTHER
// ══════════════════════════════════════════════════════════════════════════
// A sink in a bathroom, a transformer on a pole, a sign on a road: all the same relationship, and
// all of it was already recordable by typing the parent's ref into a text field. That is exactly
// the problem — a typed ref is a pointer with no spell-check, and "ROAD-01" for "ROAD-001" orphans
// the child silently. These cover the picker that replaces the typing, and the back-reference list
// that makes the link readable from the other end.
check('a link field offers the refs already captured, not a text box', () => {
  run(`suspendedCaptures = []; blankCollectForm();`);
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  const el = $('attr_on_road');
  assert(el, 'the link field did not render at all');
  assert(el.tagName === 'SELECT', `a link field rendered as <${el.tagName.toLowerCase()}> — it must be a picker, or the typo it exists to prevent is still possible`);
  const values = Array.from(el.options).map(o => o.value).filter(Boolean);
  assert(values.length, 'the picker offered nothing despite roads being saved');
  // Constrained to 'road', so nothing of another type may appear — an unconstrained picker on a
  // real survey is a list of hundreds and invites picking the wrong thing.
  const roadRefs = run(`savedFeatures.filter(f => f.featureTypeId === 'road').map(f => (f.ref||'').trim()).filter(Boolean)`);
  values.forEach(v => assert(roadRefs.some(r => r.toLowerCase() === v.toLowerCase()),
    `the picker offered "${v}", which is not a Road — the refTargetFtId constraint is not being applied`));
});

check('a link is stored as a plain ref string, so nothing downstream changes shape', () => {
  run(`suspendedCaptures = []; blankCollectForm();`);
  const target = run(`savedFeatures.find(f => f.featureTypeId === 'road' && (f.ref||'').trim())`);
  assert(target, 'no road with a ref to link to');
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  $('featureName').value = 'Linked sign probe';
  $('attr_on_road').value = target.ref;
  run(`currentVertices = [{lat:-17.8,lon:31,attrs:{},photos:[]}];`);
  const before = run('savedFeatures.length');
  run('saveFeature()');
  assert(run('savedFeatures.length') === before + 1,
    `the linked sign did not save — app said: "${$('toast').textContent}"`);
  const saved = run(`savedFeatures.find(f => f.name === 'Linked sign probe')`);
  assert(typeof saved.attrs.on_road === 'string',
    `the link saved as ${typeof saved.attrs.on_road}, not a string — plotpack/GeoJSON/CSV all expect a plain attribute`);
  assert(saved.attrs.on_road === target.ref, `the link stored "${saved.attrs.on_road}" instead of "${target.ref}"`);
  // The child stays its own feature. Nesting would have put it inside the parent, which is what
  // makes "every sign in the survey, worst condition first" a tree walk instead of a filter.
  assert(run(`savedFeatures.some(f => f.id === ${JSON.stringify(target.id)})`),
    'the parent feature disappeared');
  assert(!run(`!!(savedFeatures.find(f => f.id === ${JSON.stringify(target.id)}).children)`),
    'the parent grew a children array — the link must stay flat');
});

check('the parent can see what points at it', () => {
  // The whole reason the field type declares itself rather than being an ordinary text field: with
  // a text field nothing distinguishes a pointer from any other string on the record, so this list
  // could only ever have been produced by guessing which values look like refs.
  const target = run(`savedFeatures.find(f => f.featureTypeId === 'road' && (f.ref||'').trim())`);
  const linked = run(`featuresLinkingTo(savedFeatures.find(f => f.id === ${JSON.stringify(target.id)}))`);
  assert(linked.length >= 1, 'the road cannot see the sign that points at it');
  assert(linked.some(l => l.feature.name === 'Linked sign probe'), 'the linked sign is missing from the list');
  // Grouped by the field carrying the link, because one feature can be pointed at through more
  // than one relationship and flattening them says less than either.
  assert(linked.every(l => l.via === 'On road'), `the link is not attributed to its field: ${JSON.stringify(linked.map(l => l.via))}`);

  // And it renders as tappable rows, which is the flat-storage claim honoured: the child is a
  // first-class record you can open, not a detail of its parent.
  run(`openInspect(${JSON.stringify(target.id)})`);
  const rows = $('inspectBody').querySelectorAll('.fi-linked-row');
  assert(rows.length >= 1, 'the inspector did not render the linked features');
  assert(/Linked sign probe/.test($('inspectBody').textContent), 'the linked sign is not named in the inspector');
  run('closeInspect()');
});

check('a link is an ordinary column in Review, so it can be filtered like any other field', () => {
  // This is the payoff for storing the link as a plain string rather than nesting. The review
  // table, the attribute query engine and every export path read it through the generic attribute
  // route with no knowledge that a link field exists — which is what makes
  //   "On road" = 'ROAD-001'
  // work in the Review query box, and what makes the value survive into GeoJSON, CSV and an
  // external asset system as a normal column. A nested child would have had no column at all.
  const cols = run(`attrTableColumns(savedFeatures).map(c => c.label)`);
  assert(cols.indexOf('On road') !== -1,
    `the link field has no column in Review: ${JSON.stringify(cols)}`);
  const col = run(`attrTableColumns(savedFeatures).find(c => c.label === 'On road')`);
  assert(col.attr === true, 'the link column is not being read through the generic attribute path');
});

check('a feature with no ref is never offered as a link target', () => {
  // The stored link IS the ref, so a feature without one is not a thing that can be pointed at.
  // Offering it would put a blank row in the picker that silently records nothing.
  run(`savedFeatures.push({ id:'road_noref', name:'Unreffed road', ref:'', featureTypeId:'road', featureTypeName:'Road', vertices:[{lat:-17.8,lon:31}], attrs:{} });`);
  run(`blankCollectForm();`);
  $('featureTypeSelect').value = 'sign';
  w.onFeatureTypeChange();
  const labels = Array.from($('attr_on_road').options).map(o => o.textContent);
  assert(!labels.some(l => /Unreffed road/.test(l)),
    'a feature with no ref was offered as a link target');
});

check('a link whose target has gone is kept and flagged, not silently dropped', () => {
  // Losing a recorded relationship because the other end was deleted is worse than showing a link
  // that needs looking at — and the crew is the only one who can decide which.
  run(`blankCollectForm();`);
  const saved = run(`savedFeatures.find(f => f.name === 'Linked sign probe')`);
  run(`savedFeatures.push({ id:'ghost_sign', name:'Ghost link sign', ref:'GHOSTREF-1', featureTypeId:'sign', featureTypeName:'Traffic Sign', vertices:[{lat:-17.8,lon:31}], attrs:{ on_road:'ROAD-DELETED-999' } });`);
  run(`editFeature('ghost_sign')`);
  const el = $('attr_on_road');
  assert(el.value === 'ROAD-DELETED-999', `the dangling link was dropped instead of preserved (got "${el.value}")`);
  const sel = Array.from(el.options).find(o => o.value === 'ROAD-DELETED-999');
  assert(sel && /no longer/i.test(sel.textContent),
    `the dangling link is not flagged: "${sel ? sel.textContent : '(missing)'}"`);
  run(`blankCollectForm(); editingFeatureId = null;`);
});

check('the dashboard reports paused captures after leaving the tab', () => {
  run(`suspendedCaptures = []; blankCollectForm();`);
  $('featureTypeSelect').value = 'road';
  w.onFeatureTypeChange();
  $('featureName').value = 'Unfinished road';
  run(`currentVertices = [{lat:-17.8,lon:31,attrs:{},photos:[]}]; suspendCurrentCapture();`);
  run(`blankCollectForm(); updateStats();`);
  const banner = $('dashInProgressBanner');
  assert(banner.style.display !== 'none', 'the dashboard says nothing about the paused capture');
  assert(/paused/i.test(banner.textContent), `the banner does not mention pausing: "${banner.textContent}"`);
});

check('the resume bar starts collapsed to one line', () => {
  // The Collect tab is already five cards long. A paused capture has to be
  // visible, but it must not push the capture button off screen.
  run(`suspendedCaptures = []; blankCollectForm();`);
  startRoad();
  run('suspendCurrentCapture()');
  const bar = $('captureStackBar');
  assert(bar.style.display !== 'none', 'the bar is hidden while something is paused');
  assert(!bar.querySelector('.cap-stack-row'), 'the bar opened expanded rather than collapsed');
  assert(bar.querySelector('.cap-stack-quick'), 'no one-tap resume on the collapsed bar');
  assert(bar.textContent.includes('Main Street'), 'the collapsed bar does not name what is paused');
});

check('expanding the bar reveals the full rows, and it collapses again', () => {
  w.toggleCaptureStack();
  assert($('captureStackBar').querySelectorAll('.cap-stack-row').length === 1, 'expanding showed no rows');
  w.toggleCaptureStack();
  assert(!$('captureStackBar').querySelector('.cap-stack-row'), 'collapsing left the rows on screen');
});

check('the collapsed one-tap resume works and empties the stack', () => {
  $('captureStackBar').querySelector('.cap-stack-quick').click();
  assert($('featureName').value === 'Main Street', 'the one-tap resume did not restore the road');
  assert(run('suspendedCaptures.length') === 0, 'the one-tap resume left the road parked');
});

// ══ WHICH END DOES A NEW VERTEX BELONG TO ══
// The bug: capture was an unconditional currentVertices.push(). Walk back to the
// START of a road you are editing, shoot three points, and they land after the
// last vertex — the line runs to the far end and jumps all the way back, and
// lineLengthM() sums that jump into the recorded length. Plausible in the list,
// wrong in the export.
const M_PER_DEG = 111320;   // near enough at this latitude for a fixture
const at = (metresNorth, metresEast) => ({
  lat: -17.82 + metresNorth / M_PER_DEG,
  lon: 31.05 + metresEast / (M_PER_DEG * Math.cos(17.82 * Math.PI / 180)),
  acc: 4, attrs: {}, photos: []
});

// A 400 m road running north, mid-edit.
function editingRoad(){
  run(`suspendedCaptures = []; blankCollectForm();`);
  $('featureTypeSelect').value = 'road';
  w.onFeatureTypeChange();
  $('featureName').value = 'Edited Road';
  run(`
    editingFeatureId = 'existing1';
    currentVertices = ${JSON.stringify([at(0, 0), at(200, 0), at(400, 0)])};
    resetCaptureEndPreference();
  `);
}

check('a point near the far end still just appends', () => {
  editingRoad();
  const before = run('currentVertices.length');
  run(`placeCapturedVertex(${JSON.stringify(at(430, 0))})`);
  assert(run('currentVertices.length') === before + 1, 'the point was not added');
  assert(Math.round(run('currentVertices[currentVertices.length-1].lat') * 1e5) === Math.round(at(430,0).lat * 1e5),
    'a point past the end did not land at the end');
});

check('a point back at the start raises the question instead of appending blindly', () => {
  editingRoad();
  run(`placeCapturedVertex(${JSON.stringify(at(-30, 0))})`);
  // Appended first on purpose: a captured GPS fix must survive the dialog being
  // dismissed. The confirm then moves it.
  assert(run('currentVertices.length') === 4, 'the captured point was lost');
  assert($('confirmModal').classList.contains('show'), 'no question was asked');
  assert(/START/i.test($('confirmModalMsg').textContent), 'the question does not say which end');
});

check('answering "add to start" moves it to the front and sticks for the session', () => {
  $('confirmModalOk').click();
  assert(run('currentVertices.length') === 4, 'the point was lost when answering');
  // The road runs north, so a point added at the start must be the southernmost.
  assert(run('currentVertices[0].lat') < run('currentVertices[1].lat'),
    'the new first vertex is not south of the one after it');
  assert(Math.round(run('currentVertices[0].lat') * 1e5) === Math.round(at(-30,0).lat * 1e5),
    'the point did not move to the start');
  // Asked once, then remembered — a prompt on every fix would be intolerable.
  run(`placeCapturedVertex(${JSON.stringify(at(-60, 0))})`);
  assert(!$('confirmModal').classList.contains('show'), 'it asked again after being told');
  assert(Math.round(run('currentVertices[0].lat') * 1e5) === Math.round(at(-60,0).lat * 1e5),
    'the second point did not also go to the start');
});

check('declining keeps the point at the end and stops asking', () => {
  editingRoad();
  run(`placeCapturedVertex(${JSON.stringify(at(-30, 0))})`);
  assert($('confirmModal').classList.contains('show'), 'no question was asked');
  run('closeConfirmModal(false)');   // the Cancel button has no id; same code path
  assert(Math.round(run('currentVertices[currentVertices.length-1].lat') * 1e5) === Math.round(at(-30,0).lat * 1e5),
    'declining moved the point anyway');
  run(`placeCapturedVertex(${JSON.stringify(at(-60, 0))})`);
  assert(!$('confirmModal').classList.contains('show'), 'it asked again after being declined');
});

check('a fresh capture is never asked — there is no direction to violate', () => {
  editingRoad();
  run(`editingFeatureId = null`);
  run(`placeCapturedVertex(${JSON.stringify(at(-30, 0))})`);
  assert(!$('confirmModal').classList.contains('show'),
    'a first-time capture was asked which end to use');
});

check('a polygon is never asked — a ring still closes', () => {
  editingRoad();
  // Save and restore, not delete: `delete` on a function-declaration binding
  // fails silently, so a stub left behind here leaks into every later check.
  run(`globalThis.__realGeoType = getCurrentGeometryType;
       getCurrentGeometryType = function(){ return 'polygon'; };`);
  run(`placeCapturedVertex(${JSON.stringify(at(-30, 0))})`);
  const asked = $('confirmModal').classList.contains('show');
  run(`getCurrentGeometryType = globalThis.__realGeoType;`);
  assert(!asked, 'a polygon was asked which end to use');
  assert(run(`getCurrentGeometryType()`) === 'line', 'the real geometry lookup was not restored');
});

check('an ambiguous point is not queried — a prompt you cannot answer is noise', () => {
  // A short feature where both ends sit inside GPS error, and a loop. "Nearer the
  // start" is meaningless in both, so it appends rather than asking.
  run(`suspendedCaptures = []; blankCollectForm();`);
  $('featureTypeSelect').value = 'road';
  w.onFeatureTypeChange();
  run(`
    editingFeatureId = 'short1';
    currentVertices = ${JSON.stringify([at(0, 0), at(3, 0), at(6, 0)])};
    resetCaptureEndPreference();
  `);
  run(`placeCapturedVertex(${JSON.stringify(at(-1, 0))})`);
  assert(!$('confirmModal').classList.contains('show'),
    'a 6 m feature with 4 m fixes produced a start/end question');
});

check('a point sitting on the line is offered the segment it belongs to', () => {
  // The general case the start/end prompt was only half of. Detour cost is what
  // makes this work: a point ON a segment adds almost no length there, but adds
  // its full distance if appended.
  editingRoad();                                    // vertices at 0m, 200m, 400m north
  run(`placeCapturedVertex(${JSON.stringify(at(100, 0))})`);
  assert($('confirmModal').classList.contains('show'), 'a mid-line point was appended silently');
  const msg = $('confirmModalMsg').textContent;
  assert(/between vertex 1 and 2/.test(msg), `wrong segment offered: "${msg}"`);
  $('confirmModalOk').click();
  assert(run('currentVertices.length') === 4, 'the point was lost');
  assert(Math.round(run('currentVertices[1].lat') * 1e5) === Math.round(at(100,0).lat * 1e5),
    'the point was not inserted into the segment it sits on');
});

check('an insert position is not remembered — unlike working from the start end', () => {
  // "I am collecting from the start now" holds for a session. "This one goes
  // between 1 and 2" does not.
  run(`placeCapturedVertex(${JSON.stringify(at(300, 0))})`);
  assert($('confirmModal').classList.contains('show'),
    'the second mid-line point was placed without asking');
  run('closeConfirmModal(false)');
});

check('a point well off the line is appended, not forced into a segment', () => {
  editingRoad();
  // 150 m north but 120 m east — near the line's midpoint in plan, nowhere near
  // the line itself. Its detour cost is large, so appending wins.
  run(`placeCapturedVertex(${JSON.stringify(at(150, 120))})`);
  assert(!$('confirmModal').classList.contains('show'),
    'a point far off the line was offered as an insert');
  assert(run('currentVertices.length') === 4, 'the point was not added');
  assert(Math.round(run('currentVertices[3].lon') * 1e5) === Math.round(at(150,120).lon * 1e5),
    'the off-line point did not land at the end');
});

check('arming an insert overrides the calculation entirely', () => {
  // A crew that has said where a point goes knows more than any distance measure.
  editingRoad();
  run(`showToast = function(){}`);
  w.armInsertAfter(1);
  assert(run('pendingInsertAfter') === 1, 'the insert was not armed');
  // This point would otherwise have been appended — it is past the far end.
  run(`placeCapturedVertex(${JSON.stringify(at(500, 0))})`);
  assert(!$('confirmModal').classList.contains('show'), 'an armed insert still asked');
  assert(Math.round(run('currentVertices[2].lat') * 1e5) === Math.round(at(500,0).lat * 1e5),
    'the armed insert did not land after vertex 2');
  assert(run('pendingInsertAfter') === null, 'the arming was not consumed');
});

check('arming shows a banner and can be cancelled', () => {
  editingRoad();
  w.armInsertAfter(0);
  w.renderPoints();
  const banner = w.document.querySelector('.insert-armed-banner');
  assert(banner, 'no banner while an insert is armed');
  assert(/after vertex 1/.test(banner.textContent), `banner does not name the position: "${banner.textContent}"`);
  w.armInsertAfter(0);                 // tapping the same one again disarms
  assert(run('pendingInsertAfter') === null, 'tapping the armed vertex again did not cancel');
  w.renderPoints();
  assert(!w.document.querySelector('.insert-armed-banner'), 'the banner outlived the arming');
});

check('arming is cleared when the form is blanked', () => {
  editingRoad();
  w.armInsertAfter(1);
  run('blankCollectForm()');
  assert(run('pendingInsertAfter') === null, 'an armed insert survived into the next feature');
});

// ══ COURSE-UP ══
check('the course is the bearing of the last segment, in degrees from north', () => {
  run(`currentVertices = ${JSON.stringify([at(0, 0), at(100, 0)])}`);
  const north = run('captureCourseDeg()');
  assert(Math.abs(north) < 3 || Math.abs(north - 360) < 3, `walking north read as ${north}°`);
  run(`currentVertices = ${JSON.stringify([at(0, 0), at(0, 100)])}`);
  const east = run('captureCourseDeg()');
  assert(Math.abs(east - 90) < 3, `walking east read as ${east}°`);
  run(`currentVertices = ${JSON.stringify([at(0, 0), at(-100, 0)])}`);
  const south = run('captureCourseDeg()');
  assert(Math.abs(south - 180) < 3, `walking south read as ${south}°`);
});

check('a segment too short to mean anything gives no course', () => {
  run(`currentVertices = ${JSON.stringify([at(0, 0), at(0.4, 0)])}`);
  assert(run('captureCourseDeg()') === null, 'a 40 cm segment was treated as a direction');
  run(`currentVertices = ${JSON.stringify([at(0, 0)])}`);
  assert(run('captureCourseDeg()') === null, 'a single vertex produced a direction');
});

check('course-up is on by default and can be turned off and back', () => {
  assert(run('vertexCourseUpEnabled()') === true, 'course-up is not the default');
  run(`showToast = function(){}`);
  w.toggleVertexCourseUp();
  assert(run('vertexCourseUpEnabled()') === false, 'it could not be turned off');
  w.toggleVertexCourseUp();
  assert(run('vertexCourseUpEnabled()') === true, 'it could not be turned back on');
});

check('the stack is capped and says so rather than growing', () => {
  const cap = run('CAPTURE_STACK_MAX');
  run('suspendedCaptures = []');
  let parked = 0;
  for (let i = 0; i < cap + 3; i++) {
    startRoad();
    $('featureName').value = 'Road ' + i;
    if (run('suspendCurrentCapture()')) parked++;
  }
  assert(parked === cap, `parked ${parked}, expected the cap of ${cap}`);
  assert(run('suspendedCaptures.length') === cap, 'the stack grew past its cap');
});

check('the stack survives a persist/reload round trip', () => {
  // Paused captures are unsaved work; a WebView the OS reclaims must not take
  // them with it. persist() writes them into projectData, openProject() reads
  // them back.
  const cap = run('CAPTURE_STACK_MAX');
  run('persist()');
  const storedLen = run('(projectData.p1.suspended || []).length');
  assert(storedLen === cap, `the stack did not reach the store (${storedLen})`);
  run("suspendedCaptures = []; openProject('p1');");
  assert(run('suspendedCaptures.length') === cap, 'the stack did not come back from the store');
});

check('a malformed stored stack is dropped, not rendered', () => {
  w.loadCaptureStack([{ id: 'ok', ftId: 'road', vertices: [] }, { nonsense: true }, null, 'x']);
  assert(run('suspendedCaptures.length') === 1, `expected the one valid row, got ${run('suspendedCaptures.length')}`);
  w.renderCaptureStack();   // must not throw on the survivor
});

// ── the compass ──────────────────────────────────────────────────────────────
// Enough of Leaflet to build the control and record what it does to the bearing.
// The plugin's version called setBearing(deltaX) — the pixel delta, absolutely —
// so a drag from any non-zero starting bearing jumped. This asserts the fix:
// bearing ends up relative to where the drag began.
function fakeLeaflet(w) {
  const proto = {};
  const L = {
    Browser: { any3d: true },
    DomUtil: {
      create(tag, cls, parent) {
        const el = w.document.createElement(tag === 'a' ? 'a' : tag);
        if (cls) el.className = cls;
        if (parent) parent.appendChild(el);
        return el;
      },
      addClass(el, c) { el.classList.add(c); },
      removeClass(el, c) { el.classList.remove(c); },
      DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI
    },
    DomEvent: {
      on(el, ev, fn, ctx) { String(ev).split(' ').forEach(e => el.addEventListener(e, ctx ? fn.bind(ctx) : fn)); return L.DomEvent; },
      off() { return L.DomEvent; },
      stop() {}, stopPropagation() {}, disableClickPropagation() {}
    },
    Control: Object.assign(function () {}, {
      extend(props) {
        function C(opts) { this.options = Object.assign({}, props.options, opts); }
        C.prototype = Object.assign(Object.create(proto), props);
        return C;
      }
    }),
    control: {}
  };
  L.Control.Rotate = L.Control.extend({ options: {} });  // stand-in for the plugin being present
  w.L = L;
  return L;
}

check('the compass turns a drag into a bearing relative to where it started', () => {
  const L = fakeLeaflet(w);
  assert(w.peInstallMapRotationFixes() === true, 'the rotation fixes refused to install');

  const seen = [];
  const map = {
    options: { rotate: true },
    _bearing: 40 * Math.PI / 180,
    getBearing() { return this._bearing * 180 / Math.PI; },
    setBearing(d) { seen.push(d); this._bearing = d * Math.PI / 180; },
    on() {}, off() {}
  };
  const ctl = new L.Control.Rotate({ closeOnZeroBearing: true });
  ctl._map = map;
  const container = ctl.onAdd(map);

  // Grab at x=200 with the map already 40° off north, drag 100px right.
  ctl._onPointerDown({ clientX: 200, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  ctl._applyDrag(300);
  const expected = 40 + 100 * run('PE_ROTATE_DEG_PER_PX');
  const got = seen[seen.length - 1];
  assert(Math.abs(got - expected) < 0.001,
    `drag produced ${got}°, expected ${expected}° (start 40° + 100px). The plugin's bug was passing the raw delta as an absolute bearing.`);
  assert(container.querySelector('svg'), 'the needle did not render as inline SVG');
});

check('a tap on the compass faces north, and it hides once there', () => {
  const L = w.L;
  const map = {
    options: { rotate: true },
    _bearing: 55 * Math.PI / 180,
    getBearing() { return this._bearing * 180 / Math.PI; },
    setBearing(d) { this._bearing = d * Math.PI / 180; },
    on() {}, off() {}
  };
  const ctl = new L.Control.Rotate({ closeOnZeroBearing: true });
  ctl._map = map;
  const container = ctl.onAdd(map);
  ctl._onPointerDown({ clientX: 100, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  ctl._finishGesture();   // released without moving — a tap
  assert(Math.abs(map.getBearing()) < 0.001, `tap left the map at ${map.getBearing()}°, not north`);
  // The plugin never re-hid the control after a reset, because the only branch
  // that hides it was unreachable once closeOnZeroBearing re-enabled touchRotate.
  assert(container.style.display === 'none', 'the compass stayed on screen at north');
});

check('a map that cannot rotate gets no compass at all', () => {
  // The plugin merges rotateControl:true into L.Map's defaults, so its control
  // was added to every map — and on a non-rotating one it read an undefined
  // bearing, got NaN, failed the `=== 0` test and never hid. That dead button is
  // the glitchy icon reported on the capture and story maps.
  const L = w.L;
  const map = { options: { rotate: false }, on() {}, off() {} };
  const ctl = new L.Control.Rotate({ closeOnZeroBearing: true });
  ctl._map = map;
  const container = ctl.onAdd(map);
  assert(container.style.display === 'none', 'a non-rotating map still shows a compass');
});

check('the non-rotating map options actually switch the control off', () => {
  assert(run('PE_NO_ROTATE_OPTIONS.rotateControl') === false, 'rotateControl is not explicitly false');
  assert(run('PE_NO_ROTATE_OPTIONS.rotate') === false, 'rotate is not explicitly false');
});

check('overlay sync is a no-op on a map without rotation', () => {
  // It runs on every `move`, including on maps that never rotate, so the guard
  // matters more than the work.
  let touched = false;
  w.peSyncRotatedOverlays({ _rotate: false, getCenter() { touched = true; return { lat: 0, lng: 0 }; } });
  assert(!touched, 'the sync did work on a map that cannot rotate');
});

// A map stub that records whether the sync wrote anything, and what class state
// it left on the container.
function syncStub(over) {
  const el = w.document.createElement('div');
  return Object.assign({
    _rotate: true, _animatingZoom: false, _container: el,
    _renderer: { _container: el, _update() { this.updated = true; }, _updateTransform() { this.transformed = true; }, _reset() { this.reset = true; } },
    _paneRenderers: {},
    getCenter() { return { lat: 0, lng: 0 }; },
    getZoom() { return 14; },
    eachLayer() {}
  }, over || {});
}

check('the sync stands aside during Leaflet\'s own zoom animation', () => {
  // THE regression this guard exists for. .leaflet-zoom-anim puts a 250ms
  // transition on every .leaflet-zoom-animated element, and an SVG renderer
  // container is one. Writing a transform inside that window makes the geometry
  // ease toward where the tiles already are — which is the lag, not the fix.
  const map = syncStub({ _animatingZoom: true });
  w.peSyncRotatedOverlays(map);
  assert(!map._renderer.transformed, 'the sync wrote a transform mid zoom-animation');
  assert(!map._container.classList.contains('pe-no-anim'), 'the sync fought the zoom animation with a class');
});

check('a live gesture suppresses easing, and settling lifts it and reprojects', () => {
  const map = syncStub();
  w.peSyncRotatedOverlays(map);
  assert(map._renderer.transformed, 'the sync did nothing on a live gesture');
  assert(map._container.classList.contains('pe-no-anim'), 'easing was not suppressed during the gesture');

  w.peSyncRotatedOverlays(map, { reproject: true });
  assert(map._renderer.reset, 'settling did not reproject the paths');
  assert(!map._container.classList.contains('pe-no-anim'), 'the no-easing class outlived the gesture');
});

check('the runtime kill switch actually switches it off', () => {
  // So "is this file causing it or not" is answerable in the field in seconds
  // rather than by another round of source reading.
  const map = syncStub();
  w.PE_ROTATE_SYNC = false;
  w.peSyncRotatedOverlays(map);
  assert(!map._renderer.transformed, 'PE_ROTATE_SYNC = false did not disable the sync');
  w.PE_ROTATE_SYNC = true;
  w.peSyncRotatedOverlays(map);
  assert(map._renderer.transformed, 'the sync did not come back when re-enabled');
});

check('nothing threw across the whole run', () => {
  assert(!errors.length, errors.join(' | '));
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  capture-stack: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
