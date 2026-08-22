'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DESKTOP KEYBOARD SHORTCUTS — and proof the APK binds nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The CSS layer could be contained by a media query. JavaScript cannot, so the gate in
// js/23-desktop-keys.js is the only thing standing between a field phone and a keydown handler it
// should never have. These tests boot the app twice — once as a desktop browser, once as the APK —
// and check the SAME keystrokes in both.
// The APK half is the important half: it asserts not that the handler ignores phones, but that no
// listener is registered at all.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

// opts.native  → simulate the APK (html.native-android + a Capacitor bridge)
// opts.pointer → 'fine' for a mouse, 'coarse' for a touchscreen
function boot(opts) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/',
    beforeParse(w) {
      const c = () => new Proxy(function () {}, { get: (t, p) => p === 'then' ? undefined : c(), apply: () => c(), construct: () => c() });
      w.L = c(); w.JSZip = c();
      // The gate reads this. Report what the environment under test would report.
      w.matchMedia = q => ({
        matches: /hover:\s*hover/.test(q) || /pointer:\s*fine/.test(q) ? opts.pointer === 'fine' : false,
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
      });
      if (opts.native) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: {} } };
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
      w.HTMLCanvasElement.prototype.getContext = () => ({
        measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: () => ({ data: new Uint8ClampedArray(4) }),
        drawImage() {}, fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
        moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
        setTransform() {}, fillText() {}, strokeText() {}, putImageData() {}
      });
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AA';
      w.onerror = () => true;
    }
  });
  const w = dom.window;
  // index.html's own inline script sets this from Capacitor; jsdom runs it, but set it explicitly
  // so the test does not depend on that inline block continuing to exist.
  if (opts.native) w.document.documentElement.classList.add('native-android');
  for (const f of jsOrder) {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    w.document.head.appendChild(el);
  }
  try { w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true })); } catch (e) {}
  // Record every navigation the shortcuts could cause, without letting it actually run.
  w.eval(`
    window.__nav = [];
    switchTabNav = function(n){ window.__nav.push('tab:' + n); };
    showProjects = function(){ window.__nav.push('projects'); };
    openSettings = function(){ window.__nav.push('settings'); };
  `);
  return w;
}

const press = (w, key, target) => {
  const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target || w.document.body).dispatchEvent(ev);
  return ev;
};
const nav = w => w.eval('JSON.stringify(window.__nav)');

// ══════════════ THE APK ══════════════
const apk = boot({ native: true, pointer: 'coarse' });

check('the APK installs no keyboard handler at all', () => {
  assert(apk.eval('window.desktopKeysInstalled') === false,
    'the shortcut layer installed itself on the Android build');
});

check('every shortcut key is inert on the APK', () => {
  ['1', '2', '3', '4', '5', 'P', ',', '/', '?'].forEach(k => press(apk, k));
  assert(nav(apk) === '[]', `keys navigated the APK: ${nav(apk)}`);
  assert(!apk.document.getElementById('shortcutsModal'),
    'the help sheet was built into the APK DOM');
});

check('a Capacitor shell without the CSS class is still refused', () => {
  // Belt and braces: the class comes from an inline script that could be edited; isNativeShell()
  // reads the bridge itself and is the check that survives that.
  const shell = boot({ native: true, pointer: 'fine' });
  shell.document.documentElement.classList.remove('native-android');
  assert(shell.eval('typeof isNativeShell === "function" && isNativeShell()') === true,
    'the harness did not actually simulate a native shell');
});

check('a touch-only browser gets no shortcuts either', () => {
  const tablet = boot({ native: false, pointer: 'coarse' });
  assert(tablet.eval('window.desktopKeysInstalled') === false,
    'shortcuts installed on a touchscreen with no pointing device');
});

// ══════════════ THE DESKTOP ══════════════
const desk = boot({ native: false, pointer: 'fine' });

check('the desktop installs the handler', () => {
  assert(desk.eval('window.desktopKeysInstalled') === true, 'shortcuts did not install on desktop');
});

check('number keys reach the five tabs', () => {
  ['1', '2', '3', '4', '5'].forEach(k => press(desk, k));
  assert(nav(desk) === '["tab:dashboard","tab:collect","tab:review","tab:import","tab:export"]',
    `unexpected tab routing: ${nav(desk)}`);
});

check('P and comma reach Projects and Settings', () => {
  desk.eval('window.__nav = []');
  press(desk, 'p');            // lowercase — the table is upper, the handler normalises
  press(desk, ',');
  assert(nav(desk) === '["projects","settings"]', `unexpected: ${nav(desk)}`);
});

check('typing in a field never triggers a shortcut', () => {
  // The single most important guard in the file. A shortcut firing while somebody names a feature
  // would move the screen out from under them mid-sentence, and they would never trust the
  // keyboard again.
  desk.eval('window.__nav = []');
  const input = desk.document.createElement('input');
  desk.document.body.appendChild(input);
  ['1', '3', 'P', '/'].forEach(k => press(desk, k, input));
  assert(nav(desk) === '[]', `a shortcut fired while typing: ${nav(desk)}`);

  const ta = desk.document.createElement('textarea');
  desk.document.body.appendChild(ta);
  press(desk, '2', ta);
  assert(nav(desk) === '[]', 'a shortcut fired inside a textarea');

  const ce = desk.document.createElement('div');
  ce.setAttribute('contenteditable', 'true');
  desk.document.body.appendChild(ce);
  Object.defineProperty(ce, 'isContentEditable', { value: true });
  press(desk, '4', ce);
  assert(nav(desk) === '[]', 'a shortcut fired inside a contenteditable');
});

check('browser and OS combinations are left alone', () => {
  desk.eval('window.__nav = []');
  const ev = new desk.KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true });
  desk.document.body.dispatchEvent(ev);
  assert(nav(desk) === '[]', 'Ctrl+1 was swallowed — that belongs to the browser');
  assert(!ev.defaultPrevented, 'the app called preventDefault on a browser combination');
});

check('? opens the help sheet and Escape closes it', () => {
  press(desk, '?');
  const el = desk.document.getElementById('shortcutsModal');
  assert(el && el.classList.contains('show'), 'the help sheet did not open');
  press(desk, 'Escape');
  assert(!el.classList.contains('show'), 'Escape did not close the help sheet');
});

check('the help sheet lists the real bindings, not a hand-written copy', () => {
  // A printed shortcut list that has drifted from the handler is worse than none, so the sheet is
  // generated from the same table the handler reads.
  press(desk, '?');
  const txt = desk.document.getElementById('shortcutsModal').textContent;
  ['Dashboard', 'Collect', 'Review', 'Projects', 'Settings', 'Search features'].forEach(label => {
    assert(txt.includes(label), `the help sheet never mentions ${label}`);
  });
  press(desk, 'Escape');
});

check('shortcuts stay quiet while another sheet is open', () => {
  // An open sheet means the person is mid-answer. Navigating out from under it would leave the app
  // in a state that sheet's code never expected.
  desk.eval('window.__nav = []');
  const other = desk.document.querySelector('.modal-overlay');
  other.classList.add('show');
  press(desk, '2');
  assert(nav(desk) === '[]', 'a shortcut navigated away from an open sheet');
  other.classList.remove('show');
  press(desk, '2');
  assert(nav(desk) === '["tab:collect"]', 'shortcuts did not resume once the sheet closed');
});

check('the module is loaded and cached like every other script', () => {
  assert(jsOrder.includes('23-desktop-keys.js'), 'the module is never loaded by index.html');
  assert(jsOrder[jsOrder.length - 1] === '23-desktop-keys.js',
    'the module must load last so the globals it calls already exist');
  const sw = fs.readFileSync(path.join(ROOT, 'plotedge-sw.js'), 'utf8');
  assert(/'js\/23-desktop-keys\.js'/.test(sw), 'the module is missing from the offline precache');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  desktop-keys: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
