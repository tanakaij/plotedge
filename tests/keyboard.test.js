'use strict';
// Keyboard ↔ sheet choreography, on a document nothing else has touched.
//
// These four checks are split out of survey.test.js for a specific reason. The dismissal
// mechanism is a MutationObserver watching one class transition on one element, and it is
// therefore sensitive to what state the document is already in — a modal left half-open by an
// earlier check, a field still focused, a view switched underneath. Run at the end of a
// forty-check file these failed, not because the mechanism was broken (it demonstrably was not)
// but because the document had accumulated state.
//
// A check whose result depends on what ran before it is worse than no check: it teaches you to
// distrust the suite. So these get their own window, freshly booted, and assert against a
// sequence that matches how the app actually behaves — a sheet opened in one task and closed in
// another, never both in the same synchronous block.
//
// ══ WHAT IS BEING GUARDED ══
// Of the twenty-three close*() functions in the app, exactly one used to blur its input before
// removing .show. Every other sheet left the field focused, so the IME collapsed on the
// platform's own ~250ms schedule, beginning at an arbitrary offset into the sheet's 0.22s exit.
// Android streams the shrinking inset the whole way down, --kbh follows it, and the overlay's
// padding-bottom and top are bound to --kbh — so the sheet was being re-laid-out on every frame
// of a journey it was simultaneously animating out of. That is the shudder on close.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const results = [];
// Async, because every assertion here has to be read AFTER the observer's callback has run.
// MutationObserver callbacks are microtasks on the JSDOM window's queue, and a synchronous
// w.eval() from Node does not give that queue a chance to drain — the first version of this file
// read the result too early and reported a working mechanism as broken. `tick()` yields a real
// macrotask, which is also what happens in the app: the class is removed in one frame and the
// blur lands before the next paint.
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};

const tick = w => new Promise(res => w.setTimeout(res, 0));
const assert = (c, m) => { if (!c) throw new Error(m); };

function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/',
    beforeParse(w) {
      const anything = new Proxy(function () {}, {
        get: (t, k) => (k === 'then' ? undefined : anything), apply: () => anything, construct: () => anything
      });
      w.L = anything;
      w.JSZip = function () {};
      w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
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
    try { w.document.head.appendChild(el); } catch (e) { errors.push(`js/${f}: ${e.message}`); }
  }
  return { w, errors };
}

// Puts a field in a named sheet, opens it and focuses. Returns whether focus landed, so a setup
// failure is reported as a setup failure rather than as the behaviour under test.
function openSheetWithField(w, overlayId, fieldId){
  return w.eval(`
    (function(){
      var overlay = document.getElementById(${JSON.stringify(overlayId)});
      var box = overlay.querySelector('.modal-box') || overlay;
      var input = document.createElement('input');
      input.id = ${JSON.stringify(fieldId)};
      box.appendChild(input);
      overlay.classList.add('show');
      input.focus();
      document.documentElement.classList.add('kb-open');
      return document.activeElement === input;
    })()
  `);
}

const activeTag = w => w.eval(`(document.activeElement||{}).tagName`);

// Each block below awaits its own checks in order, and the report waits for all of them.
const pending = [];

// ── 1. the core case ──
{
  const { w, errors } = boot();
  pending.push(check('closing a sheet with a focused field dismisses the keyboard', async () => {
    assert(openSheetWithField(w, 'plotMindModal', 'kbField1'), 'setup failed — the field never took focus');
    // Separate eval from the open: a sheet is opened in one task and closed in another, minutes
    // apart. Doing both in one synchronous block puts an add and a remove of the same class into a
    // single observer batch, which is a state the app can never be in.
    w.eval(`document.getElementById('plotMindModal').classList.remove('show');`);
    // The observer callback is a microtask, so it has run by the time this next eval begins.
    await tick(w);
    assert(activeTag(w) !== 'INPUT',
      'the field is still focused after its sheet closed — the IME will collapse across the exit animation');
  }));
  pending.push(check('the close path itself did not throw', () => {
    assert(!errors.length, errors.slice(0, 2).join(' | '));
  }));
}

// ── 2. the inverse failure ──
// An observer that fired on any class change would kill the keyboard the instant focusWhenSettled
// granted it — turning a fix for one stutter into a much worse bug.
{
  const { w } = boot();
  pending.push(check('opening a sheet does not blur the field it just focused', async () => {
    assert(openSheetWithField(w, 'plotMindModal', 'kbField2'), 'setup failed');
    w.eval(`document.getElementById('plotMindModal').classList.add('some-unrelated-class');`);
    await tick(w);
    assert(activeTag(w) === 'INPUT', 'a class change unrelated to closing blurred the focused field');
  }));
}

// ── 3. the neighbouring-sheet case ──
// A confirm raised over an open form is routine. Blurring on the close of a container that does
// not hold the focus would collapse the keyboard under the sheet still using it.
{
  const { w } = boot();
  pending.push(check('closing one sheet does not kill the keyboard under another', async () => {
    assert(openSheetWithField(w, 'plotMindModal', 'kbField3'), 'setup failed');
    w.eval(`document.getElementById('confirmModal').classList.add('show');`);
    await tick(w);
    w.eval(`document.getElementById('confirmModal').classList.remove('show');`);
    await tick(w);
    assert(activeTag(w) === 'INPUT', 'closing an unrelated sheet blurred a field in the sheet still open');
  }));
}

// ── 4. the guard that makes it cheap ──
{
  const { w } = boot();
  pending.push(check('nothing happens when the keyboard was never up', async () => {
    // The observer runs on every class mutation in the document, which is a lot. It has to bail on
    // the first cheap test or it becomes a cost on every animation in the app.
    const tag = w.eval(`
      (function(){
        document.documentElement.classList.remove('kb-open');
        var o = document.getElementById('plotMindModal');
        var i = document.createElement('input');
        o.querySelector('.modal-box').appendChild(i);
        o.classList.add('show');
        i.focus();
        return (document.activeElement||{}).tagName;
      })()
    `);
    assert(tag === 'INPUT', 'setup failed');
    w.eval(`document.getElementById('plotMindModal').classList.remove('show');`);
    await tick(w);
    // Focus is left alone: with no keyboard up there is nothing to choreograph, and blurring would
    // be a side effect nobody asked for.
    assert(activeTag(w) === 'INPUT', 'the observer acted with no keyboard open — it is doing work on every class change');
  }));
}

const ready = Promise.all(pending).then(() => results);

module.exports = ready;
if (require.main === module) {
  ready.then(() => {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  keyboard: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
  });
}
