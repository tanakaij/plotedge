'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// RESTORE SHEET — the flow that replaced the inline Welcome-page restore
// ═══════════════════════════════════════════════════════════════════════════
// This is a RUNTIME suite, not a static reader: the failure it exists to catch is a step that
// renders into nothing. The old inline flow broke in exactly that way — a wizard written into a
// hidden div, buttons re-wired by hand after the fact, and three entry points that had each
// drifted into rendering something slightly different. None of that throws. It just produces a
// screen with the wrong thing on it, which no amount of grepping the source will notice.
//
// So the app is booted for real (same technique as smoke.js — real <script> elements sharing one
// global lexical environment, because eval() gives each file its own scope and a top-level `const`
// in one would be invisible to the next), and then each step of the sheet is driven and read back
// off the DOM.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsOrder = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);

const results = [];
function ok(name, cond, detail) { results.push({ name, ok: !!cond, detail }); }

const bootErrors = [];

// Deliberately thin, same as smoke.js: a stub that does too much hides the failure it was added
// to survive.
function installStubs(w) {
  const chain = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : chain()),
    apply: () => chain(),
    construct: () => chain()
  });
  w.L = chain();
  w.JSZip = chain();
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
  w.onerror = msg => { bootErrors.push(String(msg)); return true; };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/',
  beforeParse: installStubs
});
const w = dom.window;
const d = w.document;
w.addEventListener('error', e => bootErrors.push(e.message || String(e.error)));
for (const f of jsOrder) {
  const el = d.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  d.head.appendChild(el);
}
try { d.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true })); } catch (e) {}

const body = () => d.getElementById('restoreBody').textContent;
const title = () => d.getElementById('restoreTitle').textContent;
const stageIsNow = s => d.querySelector(`.restore-rail-step[data-stage="${s}"]`).classList.contains('is-now');

(async () => {
  // ══ THE SHEET IS A REAL SHEET ══
  // applySheetChrome() (js/21c-sheet-chrome.js) MOVES the heading node into a header bar and wraps
  // everything between the header and .modal-actions into a scrolling body. If that pass ever stops
  // recognising this sheet, the symptom is not an exception — it is a sheet with no way out and a
  // title that scrolls away with the content.
  const box = d.querySelector('#restoreModal .modal-box');
  ok('the shared sheet chrome builds a header for it', box && !!box.querySelector('.sheet-head-bar'));
  ok('the header carries a close button', box && !!box.querySelector('.sheet-head-bar .sheet-close'));
  // The chrome pass moves the node rather than rebuilding it precisely so ids survive — every step
  // below writes the title by id.
  ok('the title node keeps its id through the move', !!d.getElementById('restoreTitle'));
  ok('the step body ends up inside the scrolling area', box && !!box.querySelector('.sheet-body #restoreBody'));
  ok('the action row stays pinned as the last row', box && box.lastElementChild && box.lastElementChild.id === 'restoreActions');

  // ══ STEP: FIND (scanning) ══
  // The sheet opens BEFORE the scan finishes, which is the whole reason a slow scan no longer looks
  // like a tap that did nothing.
  w.eval("openRestoreSheet(null,{source:'scan'})");
  ok('opening the sheet shows it', d.getElementById('restoreModal').classList.contains('show'));
  ok('it opens on a visible searching state', /Searching this device/.test(body()));
  ok('the rail starts on Find', stageIsNow('find'));

  // ══ STEP: FIND (choose) ══
  w.eval(`restoreShowChoose([
    {name:'Ward7.plotpack',dir:'DOCUMENTS',path:'PlotEdge/Ward7.plotpack',where:'Documents/PlotEdge',mtime:Date.now(),size:2400000},
    {name:'all.plotedge.json',dir:'EXTERNAL_STORAGE',path:'Download/all.plotedge.json',where:'Download',mtime:1,size:1024,projectNames:['Mabvuku']}
  ])`);
  ok('every found backup gets a row', d.querySelectorAll('.restore-row').length === 2,
    `${d.querySelectorAll('.restore-row').length} rows`);
  ok('the header says how many were found', /2 backups found/.test(title()), title());
  // The scan cannot see a file that arrived by email or Drive and was never saved down, so the
  // picker has to stay one tap away rather than being something to back out of the sheet to find.
  ok('the picker is still one tap away from the list', /Choose a file/.test(d.getElementById('restorePrimary').textContent));

  // ══ STEP: CHECK ══
  // Nothing is written yet at this point, and the sheet has to say so — this is the one moment
  // someone can tell whether the file they picked is the survey they think it is.
  w.eval(`restorePrepareJson(JSON.stringify({
    peBackup: PE_BACKUP_VERSION, kind:'project',
    project:{id:'probe1',name:'Hatfield Ext'},
    data:{probe1:{savedFeatures:[{id:'f1',photos:[{id:'ph1'}],vertices:[]}],featureTypes:[]}}
  }),'hat.plotedge.json')`);
  ok('the confirm step names the project inside the file', /Hatfield Ext/.test(body()));
  ok('the confirm step counts what is coming back', /Features/.test(body()) && /Photos/.test(body()));
  ok('the rail moves to Check', stageIsNow('check'));
  ok('the confirm step promises a new project', /new project/.test(body()));
  ok('the primary button commits', /Restore as a new project/.test(d.getElementById('restorePrimary').textContent));

  // Cancel from a confirm step must not be a dead end. With a list behind it, it goes back to the
  // list; with nothing behind it, it closes.
  const beforeCancel = w.eval('projects.length');
  w.eval('restoreSecondaryAction()');
  ok('cancelling the confirm writes nothing', w.eval('projects.length') === beforeCancel);

  // ══ STEP: APPLY ══
  w.eval(`restorePrepareJson(JSON.stringify({
    peBackup: PE_BACKUP_VERSION, kind:'project',
    project:{id:'probe2',name:'Hatfield Ext'},
    data:{probe2:{savedFeatures:[{id:'f1',photos:[{id:'ph1'}],vertices:[]}],featureTypes:[]}}
  }),'hat.plotedge.json')`);
  const before = w.eval('projects.length');
  w.eval('restorePrimaryAction()');
  await new Promise(r => setTimeout(r, 250));
  ok('confirming actually restores the project', w.eval('projects.length') === before + 1,
    `${before} -> ${w.eval('projects.length')}`);
  ok('the rail reaches Restore', stageIsNow('apply'));
  ok('the finished step reports what came back', /Restored/.test(body()) && /Open them from Projects/.test(body()));

  // ══ THE INVARIANT ══
  // Restoring is additive, so an interruption cannot corrupt anything — but it CAN leave a project
  // holding half its photos with nothing on screen to say so. The write is therefore not
  // interruptible, and that has to hold for the X, a backdrop tap and hardware Back alike, all
  // three of which resolve to closeRestoreModal() through closeTopOverlay().
  w.eval('_restoreBusy = true');
  w.eval('closeRestoreModal()');
  ok('the sheet refuses to close while a restore is in flight',
    d.getElementById('restoreModal').classList.contains('show'));
  w.eval('closeTopOverlay()');
  ok('hardware Back cannot tear it off mid-write either',
    d.getElementById('restoreModal').classList.contains('show'));
  w.eval('_restoreBusy = false');
  w.eval('closeTopOverlay()');
  ok('and it closes normally once the write is done',
    !d.getElementById('restoreModal').classList.contains('show'));

  // ══ REJECTIONS LAND SOMEWHERE, NOT NOWHERE ══
  // The old flow's failure mode was a toast and a screen that had not changed. Every rejection now
  // has to leave the person on a step with a way forward.
  w.eval("openRestoreSheet(null,{source:'file'}); restorePrepareJson('{not json','bad.plotedge.json')");
  ok('unparseable JSON reaches a real error step', /not valid JSON/.test(body()));
  ok('the error step always offers a way on', d.getElementById('restorePrimary').style.display !== 'none');
  w.eval("restorePrepareJson(JSON.stringify({hello:'world'}),'wrong.json')");
  ok('a file that is not a PlotEdge backup says so', /not a PlotEdge backup/.test(body()));
  w.eval('closeRestoreModal()');

  // ══ THE INLINE FLOW IS GONE ══
  // Guarding the actual regression: if a confirm step is ever rendered into the Welcome page again,
  // the pile of unstyled text and out-of-nowhere buttons comes back with it.
  ok('no inline wizard host is left on the Welcome screen', !d.getElementById('foundBackupWizard'));

  // ══ PLOTIN: THE DOCK REPORTS A FLOOR, NOT A FIX ══
  // The mode's whole point is that GPS is not the source of truth indoors, and the dock's status
  // line is the one piece of chrome on screen for the entire session. Left alone it reported
  // "GPS off" permanently — a dead status in the most valuable slot on the screen. What replaces
  // it is the field that is actually wrong when something is wrong: capture forty vertices
  // believing you set Level 1 when you set Level 2 and the survey is silently wrong, with no
  // geometry cue to catch it the way a bad fix betrays itself outdoors.
  const dockMain = () => d.getElementById('cdStatusMain');
  w.eval("currentEnvironment='PlotOut'; updateCollectDockStatus();");
  ok('outdoors the dock still reports the fix', !dockMain().classList.contains('is-level'));

  w.eval("currentEnvironment='PlotIn'; document.getElementById('collectBuildingId').value=''; document.getElementById('collectFloorLevel').value=''; updateCollectDockStatus();");
  ok('indoors the dock switches to a level chip', dockMain().classList.contains('is-level'));
  // A prompt, not an error: nothing is blocked and no modal is raised, but the omission has to be
  // visible before it becomes forty points on the wrong storey.
  ok('an unset floor is called out rather than left blank',
    dockMain().classList.contains('is-unset') && /Set floor level/.test(dockMain().textContent),
    dockMain().textContent);

  // An <input>'s value is not its DOM content, so the MutationObserver that keeps the rest of the
  // dock in step never sees these two fields — they need their own listeners, or the chip would
  // keep saying "Set floor level" for as long as the card stayed open.
  const floorEl = d.getElementById('collectFloorLevel');
  d.getElementById('collectBuildingId').value = 'NORTHWOOD-A';
  floorEl.value = 'Level 2';
  floorEl.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok('typing a floor updates the chip without any other trigger',
    /Level 2/.test(dockMain().textContent) && !dockMain().classList.contains('is-unset'),
    dockMain().textContent);
  // Floor first: it changes several times per building and is the field that is wrong when
  // something is wrong. The building name is context, and is what truncates first.
  ok('the floor reads before the building name',
    dockMain().textContent.indexOf('Level 2') < dockMain().textContent.indexOf('NORTHWOOD-A'),
    dockMain().textContent);

  w.eval("currentEnvironment='PlotOut'; updateCollectDockStatus();");
  ok('switching back restores the fix reading',
    !dockMain().classList.contains('is-level') && !dockMain().classList.contains('is-unset'));

  // ══ PLOTIN: THE MODE SWITCH ══
  // The toggle carries the consequence of each mode, not just its name — PlotIn versus PlotOut
  // says nothing about what changes; "Indoors · plan" does.
  const envToggle = d.getElementById('collectEnvToggle');
  ok('each side of the environment toggle states what it changes',
    envToggle.querySelectorAll('.env-opt-sub').length === 2 &&
    /Indoors/.test(envToggle.querySelector('[data-env="PlotIn"] .env-opt-sub').textContent));
  ok('each side carries an icon for the arm\u2019s-length read',
    envToggle.querySelectorAll('.env-opt-icon').length === 2);

  // ══ PLOTIN: THE GPS ROW IS DEMOTED, NOT HIDDEN ══
  // GPS genuinely does work near a window, and a crew that gets a fix indoors should still be able
  // to use it — so the row keeps working and keeps its ids. It just stops being the headline.
  ok('the demoted GPS row is still present and still wired',
    !!d.querySelector('#collectCardGps .gps-bar') && !!d.getElementById('gpsBtn'));
  ok('it gains the line that stops "Tap Start" reading as an instruction',
    !!d.querySelector('#collectCardGps .gt-optional'));

  // ══ PLOTIN TEXTURE ══
  // The texture layer is toggled by one class. Everything else about it is CSS, but the class has
  // to be set on <html> or none of that CSS applies.
  w.eval("currentEnvironment='PlotIn'; getCurrentTab=()=>'collect'; updateIndoorTexture()");
  ok('selecting PlotIn arms the indoor texture', d.documentElement.classList.contains('indoor-active'));
  w.eval("getCurrentTab=()=>'review'; updateIndoorTexture()");
  ok('and it never lingers on another tab', !d.documentElement.classList.contains('indoor-active'));

  ok('the app booted without errors', bootErrors.length === 0, bootErrors.join(' | '));

  let pass = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '\n        ' + r.detail}`);
    if (r.ok) pass++;
  }
  console.log(`\n  restore-sheet: ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
