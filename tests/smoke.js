'use strict';
// Boots the real split app in a DOM and reports anything that throws.
//
// Uses REAL <script> elements, not eval(). That distinction is the whole point:
// eval() gives each call its own lexical scope, so a `const` in one file is
// invisible to the next and you get a pile of ReferenceErrors that say nothing
// about the app. Classic <script> tags share one global lexical environment,
// which is exactly the semantics the split depends on.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const errors = [];

// Everything jsdom or the CDN does not provide. Kept deliberately thin: a stub
// that does too much can hide a real failure.
function installStubs(w) {
  const chain = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : chain()),
    apply: () => chain(),
    construct: () => chain()
  });
  w.L = chain();
  w.JSZip = chain();
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  w.navigator.geolocation = { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} };
  w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
    setTransform() {}, measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    createLinearGradient: () => ({ addColorStop() {} }), putImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }), set fillStyle(v) {}, set font(v) {}
  });
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AA';
  w.onerror = (msg) => { errors.push('window.onerror: ' + msg); return true; };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',       // executes the inline pre-paint boot script
  pretendToBeVisual: true,
  url: 'https://example.test/',
  beforeParse: installStubs        // stubs must exist before the inline script runs
});
const w = dom.window;

w.addEventListener('error', e => errors.push('error event: ' + (e.message || e.error)));

// Append each file exactly as index.html does — same order, same scope.
for (const f of jsOrder) {
  const el = w.document.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  const before = errors.length;
  const onErr = e => errors.push(`js/${f}: ${e.error ? e.error.message : e.message}`);
  w.addEventListener('error', onErr);
  try { w.document.head.appendChild(el); }
  catch (e) { errors.push(`js/${f} threw: ${e.message}`); }
  w.removeEventListener('error', onErr);
  if (errors.length === before) process.stdout.write('.');
}
console.log('');

// Boot happens on DOMContentLoaded/load for some paths; let those run.
try { w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true })); } catch (e) {}

const probes = {
  'data-domain resolved before paint': w.document.documentElement.getAttribute('data-domain'),
  'data-screen resolved before paint': w.document.documentElement.getAttribute('data-screen'),
  'data-theme resolved before paint': w.document.documentElement.getAttribute('data-theme'),
  'showLanding()': typeof w.showLanding,
  'persistStore()': typeof w.persistStore,
  'addVertexPhoto()': typeof w.addVertexPhoto,
  'appBack()': typeof w.appBack,
  'setDomainTheme()': typeof w.setDomainTheme,
  'activateView()': typeof w.activateView,
  // Probed through eval, not off `window`: top-level `let`/`const` live in the
  // global LEXICAL environment and are not properties of the global object, so
  // `w.projects` is undefined even when the binding exists and works.
  'projects array': w.eval('typeof projects === "undefined" ? "MISSING" : "[" + projects.length + "]"'),
  'projectData object': w.eval('typeof projectData === "object" ? "ok" : "MISSING"'),
  'store loaded without wiping': w.eval('typeof lastWritten !== "undefined" ? "ok" : "MISSING"')
};

const missing = Object.entries(probes).filter(([, v]) => v === 'undefined' || v === 'MISSING' || v === null);
if (errors.length) console.log(`  FAIL  the app boots with every script loaded\n        ` + errors.join('\n        '));
else console.log('  PASS  the app boots with every script loaded');
if (missing.length) console.log(`  FAIL  the app wires itself up after boot\n        not available: ` + missing.map(([k]) => k).join(', '));
else console.log('  PASS  the app wires itself up after boot');
for (const [k, v] of Object.entries(probes)) console.log(`          ${String(v).padEnd(12)} ${k}`);
const total = 2, bad = (errors.length ? 1 : 0) + (missing.length ? 1 : 0);
console.log(`\n  smoke: ${total - bad}/${total} passed`);
process.exit(bad ? 1 : 0);
