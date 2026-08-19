// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — History stack, back button, overlays, sheets, app exit
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ── HEADER TITLE ──
// The in-project header used to show the open project's name (plus a feature-count badge). Both
// were project identity, which already has a home one level in — the strip under the map
// thumbnail on the Dashboard. Up here the header now just says which of the five panels sharing
// it (Dashboard/Collect/Review/Import/Export) is on screen, the same for every project. Applied
// by switchTab() in js/06-collect.js on every tab change.
const HEADER_TITLES = { dashboard:'PlotEdge', collect:'Capture', review:'Review', import:'Import', export:'Export' };

// Bottom-nav / dashboard shortcuts call this instead of switchTab() directly, so a *user tap*
// on a tab always leaves a back-button stop behind it. Programmatic switchTab() calls elsewhere
// (e.g. openProject() landing on 'dashboard', or Save routing back to 'review') don't — those
// are consequences of another action, not a navigation the user should have to back out of twice.
// ── App header back arrow ──
// Shared by every tab (Dashboard/Collect/Review/Import/Export) since it's the same header. It
// used to call showProjects() unconditionally, which meant tapping it from Collect (or any
// non-dashboard tab) skipped straight past Dashboard to the Projects list — a step further back
// than the arrow should ever jump in one tap. Now it's context-aware: from any tab other than
// Dashboard, it takes you to this project's Dashboard first, matching what a back arrow should
// do; only from Dashboard itself does it back out of the project to the Projects list. This
// mirrors (and stays consistent with) the hardware/gesture back-button stack below, which was
// already doing tab-by-tab stepping correctly — the visible header arrow was the one place still
// skipping a level.
// The visible back arrow and the hardware/gesture back button must be the SAME action. They
// weren't: this used to call switchTabNav('dashboard'), which *pushes* a stop. Going
// Dashboard → Collect → arrow left the stack as [dashboard, collect, dashboard], so the next
// hardware Back popped to 'collect' — the arrow sent you back and the button sent you forward
// again, into the screen you had just left. Consuming the stop instead keeps one stack that both
// controls walk identically, and the stack can no longer grow while the user is going backwards.
// ══ NAV:BEGIN ══
// ══════════════════════════════════════════════════════════════════════════════
// WHY BACK USED TO NEED TWO OR THREE PRESSES
// ══════════════════════════════════════════════════════════════════════════════
// switchTabNav() pushed a history stop unconditionally — including when the tab
// tapped was the tab already open. Re-tapping Collect in the bottom bar (trivial
// to do on a phone held one-handed in the field, and the dashboard's in-progress
// banner and KPI cards route through the same function) left the stack as
// [.., app/collect, app/collect, app/collect]. Every Back press then dutifully
// popped one stop and replayed the identical screen, so the arrow appeared dead
// until the duplicates were exhausted. The stack was recording taps, not
// navigations.
//
// Two changes fix it at the source: switchTabNav() no longer pushes for a tab
// that is already current, and pushNavState() refuses to stack a stop identical
// to the one already on top — which also covers any other caller that repeats
// itself now or later.
let currentTabName = null;

// switchTab() calls this on every entry — including programmatic ones
// (openProject landing on Dashboard, Save routing to Review, a popstate replay)
// — so the "am I already here?" check below stays correct no matter how the tab
// was reached.
function noteCurrentTab(name) { currentTabName = name; }

function getCurrentTab() { return currentTabName; }


function switchTabNav(name) {
  // The bar is docked on the Project Manager too, where no project is open. A tab tap there means
  // "take me into that tab of the project I'm working in", so resolve the active project and open
  // it first — otherwise switchTab() would quietly re-skin a hidden #view-app and the tap would
  // look like it did nothing.
  if (!activeProjectId) {
    const id = (activeProjectRef && projects.find(x=>x.id === activeProjectRef)) ? activeProjectRef : null;
    if (!id) { showToast('Open a project first'); return; }
    openProject(id);
    switchTab(name);
    // openProject() already pushed an 'app' stop pointing at the dashboard; correct it in place
    // rather than leaving a duplicate stop the user has to press Back through twice.
    history.replaceState({ screen:'app', projectId:id, tab:name }, '');
    return;
  }
  // Already here: re-run the tab's own side effects (the caller may be doing
  // more than navigating — a KPI card also sets a view mode), but do NOT record
  // a stop for a journey that did not happen.
  if (currentTabName === name) { switchTab(name); return; }
  switchTab(name);
  pushNavState('app', { projectId: activeProjectId, tab: name });
}


// ══ NAVIGATION HISTORY (mobile back-button support) ══
// This app is a single-page PWA that swaps .view/.panel elements via plain JS — it never used to
// touch the browser's history stack. That meant the phone's hardware/gesture back button had
// nothing of ours to step back through, so it fell straight through to closing the app/tab
// instead of going to the previous screen. pushNavState() records a stop every time the user
// navigates to a new screen; the popstate listener below replays that state without re-pushing
// (guarded by suppressNavPush) so Back steps through Collect → Review → Dashboard → Projects list
// the way it would on a native app, and only exits the app once that stack is exhausted.
let suppressNavPush = false;

// Compared field-by-field rather than by JSON.stringify, so a difference in key
// order between two callers building the same stop can't defeat the check.
function sameNavState(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function pushNavState(screen, extra) {
  if (suppressNavPush) return;
  const next = { screen, ...(extra || {}) };
  // A stop identical to the one on top would cost the user a Back press that
  // changes nothing on screen. This is the general form of the tab-tap bug.
  if (sameNavState(history.state, next)) return;
  history.pushState(next, '');
}


// ── ONE BACK ACTION ──
// The header arrow, the Android hardware button and the browser gesture must all
// mean the same thing. They used to be three code paths; this is the single one
// they now share, so the stack can never be walked differently depending on
// which affordance the user reached for.
function appBack() {
  if (closeTopOverlay()) return true;
  // history.length===1 means nothing of ours is behind this (deep link / fresh load), so fall
  // back to the projects list rather than letting Back escape the app.
  if (history.length <= 1) { showProjects(); return true; }
  if (history.state && history.state.screen && history.state.screen !== 'projects') { history.back(); return true; }
  return false;   // at the root — caller decides whether that means "exit"
}

function headerBackTap() {
  if (!appBack()) showProjects();
}

// ══ NAV:END ══
window.addEventListener('popstate', (e) => {
  // ── SHEETS INTERCEPT BACK, ALWAYS ──
  // Android's hardware button already went through closeTopOverlay() via the Capacitor listener,
  // but browser/PWA gesture-back landed here directly and navigated the screen *underneath* an
  // open sheet — leaving, say, Help floating over a screen it was never opened from, with the
  // page moving behind it on every further swipe. That's what "I can't close Help" was.
  // Dismissing the sheet and re-pushing the state we just popped keeps the stack at the same
  // depth, so Back means "close this sheet" once and "go back a screen" the next time — which is
  // what it does on every native app.
  if (closeTopOverlay()) { history.pushState(e.state, ''); return; }
  suppressNavPush = true;
  try {
    const st = e.state;
    // Guards below cover the case where Back replays a stop that pointed at something the user
    // has since deleted (a project, a feature type). The screen-opener functions (openProject,
    // editProject, editFeatureType) all silently no-op when the id no longer exists — correct for
    // their normal callers, but wrong here, since popstate has no other fallback. Without this,
    // Back could leave the app showing a stale/blank screen for something that's gone, or stuck
    // unable to go "back" any further. Falling back to the projects list keeps Back always landing
    // somewhere real.
    if (!st || st.screen === 'projects') { showProjects(); }
    // Replayed rather than re-entered — suppressNavPush is already set, so calling the render
    // half directly avoids pushing a duplicate stop.
    else if (st.screen === 'landing') { renderLandingScreen(); }
    // The hub and its two subpages are replayed rather than re-entered: suppressNavPush is
    // already set, so calling the render half directly avoids pushing a duplicate stop while
    // still redrawing counts that may have changed since the stop was recorded.
    else if (st.screen === 'plotlens') {
      // Same guard as the other project-scoped stops: with no project open there is nothing to
      // tell a story about, so Back falls through to the projects screen rather than an empty reel.
      if (!activeProjectId) { showProjects(); }
      else { activateView('view-plotlens'); renderPlotLens(); }
    }
    else if (st.screen === 'datahub') { renderDataHubScreen(); }
    else if (st.screen === 'backup') {
      // Guard for the same reason the project/feature-type stops below are guarded: deleting
      // every project sends the app back to Welcome, and a Backup screen listing nothing to
      // back up is a dead end Back can't escape.
      if (!projects.length) { showProjects(); }
      else { activateView('view-backup'); renderBackupStatus(); }
    }
    else if (st.screen === 'storage') {
      if (!projects.length) { showProjects(); }
      else { activateView('view-storage'); renderStorage(); }
    }
    else if (st.screen === 'newproject') {
      if (st.editId != null && !projects.find(x=>x.id===st.editId)) { showProjects(); }
      else { st.editId != null ? editProject(st.editId) : showNewProject(); }
    }
    else if (st.screen === 'featuretypes') { showFeatureTypes(); }
    else if (st.screen === 'media') { showMediaGallery(); }
    // Replayed without the pushNavState openPlotEtch() normally does — suppressNavPush is already
    // set, but activating the view directly also skips re-running the fit-bounds/toast side
    // effects that only belong to a fresh entry.
    else if (st.screen === 'plotetch') {
      if (st.projectId && !projects.find(x=>x.id===st.projectId)) { showProjects(); }
      else { activateView('view-plotetch'); setTimeout(()=>{ if (peMap) peMap.invalidateSize(); renderPlotEtch(); }, 60); }
    }
    else if (st.screen === 'featuretype-edit') {
      if (st.editId != null && !featureTypes.find(x=>x.id===st.editId)) { showFeatureTypes(); }
      else { st.editId != null ? editFeatureType(st.editId) : newFeatureType(); }
    }
    else if (st.screen === 'app') {
      if (st.projectId && !projects.find(x=>x.id===st.projectId)) { showProjects(); }
      else {
        if (st.projectId && st.projectId !== activeProjectId) openProject(st.projectId);
        // activateView() is the fix for the "Back does nothing" reports. switchTab() only swaps
        // the .panel inside #view-app — if Back was pressed from a *subview* (Feature Types, Media
        // Gallery, PlotEtch), the correct panel was being selected underneath a view that was
        // still covering the screen, so the press consumed a history stop and changed nothing
        // visible. Every close button happened to call activateView() itself before history.back(),
        // which is why the on-screen buttons worked and the hardware button didn't.
        activateView('view-app');
        switchTab(st.tab || 'dashboard');
      }
    } else { showProjects(); }
  } finally { suppressNavPush = false; }
});

// Baseline entry so the very first Back press from wherever the user starts has *something* of
// ours to land on (the projects list) instead of immediately exiting.
history.replaceState({ screen: 'projects' }, '');


// ══ ANDROID HARDWARE BACK BUTTON (Capacitor) ══
// Everything above (pushNavState/popstate) only ever helps in a real browser tab, where the OS's
// own back gesture drives the *browser's* history stack, which then fires popstate for us to
// react to. Inside the wrapped Android APK there is no browser chrome — the hardware/gesture back
// button is caught by Capacitor's native Bridge directly, and without a JS-side listener
// registered for it, Capacitor's default behavior is to just exit the app on every press. It never
// even looks at the WebView history, so all the screen-stack work above was silently doing nothing
// on Android specifically — this is what was making Back always fall straight out of the app.
//
// closeTopOverlay() covers the other half of "back does the wrong thing": modals, the lightbox,
// the barcode scanner, onboarding, and the fullscreen map don't push any nav state of their own
// (they're overlays, not screens), so without this, Back while one of them is open would skip
// straight past it into the screen stack instead of just closing what's on top — which is what a
// user expects (and what tapping outside/Escape already does for each on desktop). Order below is
// outer-to-inner: whichever of these can be open at the same time as another gets closed first.
// ══ GUARANTEED CLOSE AFFORDANCE ══
// Injected once at boot rather than written into each sheet's markup, for the same reason the
// tap-outside listener is delegated: a sheet added later can't forget to include it. Skips
// confirmModal (a yes/no decision needs an answer, not a dismiss) and any sheet that already
// ships its own X.
function installModalCloseButtons(){
  document.querySelectorAll('.modal-overlay').forEach(ov=>{
    if (ov.id === 'confirmModal') return;
    const box = ov.querySelector('.modal-box');
    if (!box || box.querySelector('.modal-x')) return;
    // Sheets carrying a .sheet-head already expose Cancel and Done. Adding a floated X on top of
    // that header overlaps the Done button and offers a third, ambiguous way out of a sheet whose
    // whole point is an explicit commit-or-discard choice.
    if (box.querySelector('.sheet-head')) return;
    const btn = document.createElement('button');
    btn.className = 'modal-x';
    btn.type = 'button';
    btn.setAttribute('aria-label','Close');
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    btn.addEventListener('click', ()=>closeTopOverlay());
    box.insertBefore(btn, box.firstChild);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installModalCloseButtons);
else installModalCloseButtons();


// ══ SCROLLABLE-SHEET FLAG ══
// Drives the divider/fill behind the sticky action row (see .modal-actions in the CSS): a sheet
// that fits on screen shouldn't grow a border out of nowhere, only one that actually scrolls.
// Centralised as an observer rather than a call inside each open*() function for the same reason
// the close button and tap-outside handlers are delegated — a sheet added later can't forget it.
function markSheetScrollable(overlay){
  const box = overlay && overlay.querySelector('.modal-box');
  if (!box) return;
  const measure = () => box.classList.toggle('is-scrollable', box.scrollHeight > box.clientHeight + 1);
  // ── WHY THIS MEASURES TWICE ──
  // The rAF pass alone was the visible "glitch on open". A sheet starts WITHOUT .is-scrollable,
  // and .modal-box:not(.is-scrollable) .modal-actions strips the action row's border-top,
  // background and 12px of top padding. So a scrollable sheet (Settings, the tools sheet — any
  // sheet tall enough to matter) painted its first frame in the short-sheet layout and then, one
  // frame later, gained a divider, a background fill and ~13px of height: a pop landing right on
  // top of the slide-up animation.
  // The observer that calls this runs as a microtask off the class mutation, i.e. still before
  // the next paint, and visibility:hidden (unlike display:none) keeps the box laid out and
  // measurable. So a synchronous read here settles the flag in the SAME frame the sheet appears.
  measure();
  // The rAF pass stays as the correction for anything that changes height after that first
  // measurement — late web fonts, images, or content the opener renders asynchronously.
  requestAnimationFrame(measure);
}

function refreshOpenSheetScrollFlags(){
  document.querySelectorAll('.modal-overlay.show').forEach(markSheetScrollable);
}

// ══ WHY THIS IS COALESCED ══
// refreshOpenSheetScrollFlags() was bound straight to visualViewport 'resize'. That event fires
// on EVERY frame the keyboard animates (10–20 times per open, and again per close), and each call
// does a synchronous scrollHeight/clientHeight read — a forced layout — and then toggles
// .is-scrollable, which adds/removes 12px of padding and a border on .modal-actions.
// Read → write → read → write on consecutive frames is textbook layout thrashing, and because the
// write changes the very height the next read measures, the flag can oscillate: the sheet grows
// 13px, shrinks 13px, grows again, all while the keyboard is sliding. That is the visible
// "snap/flicker" during a keyboard toggle.
// One rAF-coalesced pass per frame at most, and none at all while the close lock is held.
let sheetFlagPending = false;
function queueSheetScrollFlags(){
  if (sheetFlagPending) return;
  sheetFlagPending = true;
  requestAnimationFrame(()=>{ sheetFlagPending = false; refreshOpenSheetScrollFlags(); });
}

// ══ IS ANY SHEET UP? ══
// Drives html.sheet-open, which css/02-mesh.css uses to pause the four animated background blobs
// while they are completely hidden behind a sheet's backdrop. Computed from the same observer
// that already runs on every overlay class change, so it costs one querySelector per open/close
// rather than any new listener — and it can't go stale the way a counter incremented inside each
// open*()/close*() pair would the first time a sheet closes by some path that forgot to decrement.
function syncSheetOpenClass(){
  const any = !!document.querySelector('.modal-overlay.show');
  document.documentElement.classList.toggle('sheet-open', any);
}

(function(){
  const obs = new MutationObserver(muts=>{
    for (const m of muts){
      const el = m.target;
      if (el.classList && el.classList.contains('modal-overlay') && el.classList.contains('show')) markSheetScrollable(el);
    }
    syncSheetOpenClass();
  });
  document.querySelectorAll('.modal-overlay').forEach(ov=>obs.observe(ov, {attributes:true, attributeFilter:['class']}));
  // The keyboard opening/closing resizes the sheet under a sheet that's already up.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueSheetScrollFlags, {passive:true});
  else window.addEventListener('resize', queueSheetScrollFlags, {passive:true});

  // Backgrounded app / screen off: nothing on this page is visible, so no animation on it should
  // be burning GPU. Pairs with the upload-timer gating in js/19-sync.js, which stops the other
  // thing that used to run forever regardless of whether anyone was looking.
  const syncHidden = () => document.documentElement.classList.toggle('app-hidden', document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', syncHidden);
  syncHidden();
  syncSheetOpenClass();
})();


// ══ KEYBOARD-BEFORE-CLOSE, CENTRALISED ══
// The dismissal race is: a close*() handler flips .show off while the soft keyboard is still up,
// so the sheet's 0.22s slide-down and the keyboard's ~250ms collapse run on top of each other,
// each one changing the height the other is animating against.
// There are ~20 close*() functions across nine files and every one of them ends in
// classList.remove('show'). Patching them individually guarantees the next sheet someone adds
// forgets to do it — the same reasoning that made the close button and tap-outside handlers
// delegated rather than per-sheet.
// So this is a single capture-phase pointerdown. It runs before the inline onclick that will
// close the sheet, and crucially before the click even resolves: blurring on press-DOWN gives the
// keyboard the ~120ms between press and release as a head start, so by the time the sheet starts
// moving the collapse is already underway against frozen geometry. No close function changes.
document.addEventListener('pointerdown', (e)=>{
  if (!document.documentElement.classList.contains('kb-open')) return;
  const t = e.target;
  if (!t || !t.closest) return;
  // Only inside an open sheet, and only for controls that end an interaction. Tapping another
  // input inside the same sheet must keep the keyboard up.
  if (!t.closest('.modal-overlay.show')) return;
  if (t.closest('input, textarea, select')) return;
  const hit = t.closest('button, .btn, .sheet-head-btn, .modal-x');
  // A press on the sheet's own backdrop is also a dismissal (tap-outside-to-close).
  const onBackdrop = t.classList && t.classList.contains('modal-overlay');
  if (!hit && !onBackdrop) return;
  if (typeof dismissKeyboard === 'function') dismissKeyboard(300);
}, true);


// ══ TAP-OUTSIDE-TO-CLOSE ══
// One delegated listener rather than an onclick on each of the fourteen .modal-overlay elements:
// a per-modal handler is something every future sheet has to remember to add, and the ones that
// forget are exactly the sheets users get stuck in. Routed through closeTopOverlay() so the tap
// runs the same named close (and therefore the same cleanup) as the back button.
//
// Two deliberate exclusions:
//  · Only fires when the tap lands on the overlay itself, never on a child — otherwise a click
//    that started inside the sheet and drifted onto the backdrop would dismiss it mid-interaction.
//  · confirmModal is exempt. It asks a destructive yes/no question, and a stray backdrop tap
//    resolving it silently — with no answer recorded either way — is the one place where
//    dismiss-on-outside-tap is worse than making the user choose.
document.addEventListener('click', (ev) => {
  if (!ev.target.classList || !ev.target.classList.contains('modal-overlay')) return;
  if (!ev.target.classList.contains('show')) return;
  if (ev.target.id === 'confirmModal') return;
  closeTopOverlay();
});


// ══ "OPEN" MEANS VISIBLE, NOT JUST CLASSED ══
// closeTopOverlay() decides whether a Back press is spent closing something. It
// used to trust the .show class alone — but an overlay can carry .show while
// being display:none, detached, or zero-sized (a render that bailed halfway, a
// sheet hidden by an ancestor, the visibility:hidden pass added in the UI
// audit). In every one of those cases Back was consumed with nothing visibly
// changing, which is the other half of "I have to press it three times".
// offsetParent is null for anything display:none or detached; the rect check
// catches the rest. Cheap enough to run per press.
function isReallyOpen(el){
  if (!el || !el.classList.contains('show')) return false;
  if (!el.isConnected) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function closeTopOverlay(){
  // The pointerdown guard above covers taps on Cancel/Done/backdrop, but a hardware Back press
  // (and the Android system gesture) never produces a pointerdown inside the sheet — so without
  // this the exact same close-while-keyboard-is-collapsing race comes back on the Back path only.
  if (typeof dismissKeyboard === 'function' && document.documentElement.classList.contains('kb-open')) {
    dismissKeyboard(300);
  }
  // Highest layer in the app (z-index 260), so it is checked before anything else — a Back press
  // during playback should stop the story, not the sheet that happens to be open behind it.
  const plPlayer = document.getElementById('plPlayer');
  if (isReallyOpen(plPlayer)) { stopPlotLens(); return true; }
  const barcodeOverlay = document.getElementById('barcodeScannerOverlay');
  if (isReallyOpen(barcodeOverlay)) { closeBarcodeScanner(); return true; }
  const onboardOverlay = document.getElementById('onboardOverlay');
  if (isReallyOpen(onboardOverlay)) { dismissOnboarding(); return true; }
  const lightbox = document.getElementById('photoLightbox');
  if (isReallyOpen(lightbox)) { closeLightbox(); return true; }
  // The glossary (js/21a-plotwords.js) is a fixed full-screen panel opened from Settings — which
  // is itself a modal — so it has to be checked ABOVE the modal block below, or Back would close
  // Settings underneath it and leave the glossary floating over whatever was behind.
  const plotWords = document.getElementById('view-plotwords');
  if (plotWords && plotWords.classList.contains('active')) { closePlotWords(); return true; }
  // PlotAtlas sits above the tab content but below the lightbox and the story
  // player (both of which can be opened from inside it), which is why it is
  // checked here rather than first. Its own sub-surfaces go before it: a Back
  // press with the feature sheet up should close the sheet, not the whole map.
  const atlas = document.getElementById('plotAtlas');
  if (atlas && atlas.classList.contains('show')) {
    const atlasSheet = document.getElementById('atlasSheet');
    if (atlasSheet && atlasSheet.classList.contains('show')) { atlasCloseSheet(); return true; }
    const bmSheet = document.getElementById('atlasBasemapSheet');
    if (bmSheet && bmSheet.classList.contains('show')) { atlasCloseBasemapSheet(); return true; }
    closePlotAtlas();
    return true;
  }
  const mapWrap = document.getElementById('reviewMapWrap');
  if (mapWrap && mapWrap.classList.contains('fullscreen')) { toggleReviewMapFullscreen(); return true; }
  // All the bottom-sheet modals share the .modal-overlay/.show pattern, but each still gets its
  // own named close call here (not a blind classList.remove) so whatever cleanup that modal
  // already does on close — e.g. clearing the pending confirm callback — still runs.
  const confirmModal = document.getElementById('confirmModal');
  if (isReallyOpen(confirmModal)) { closeConfirmModal(); return true; }
  // Back / backdrop / X on the field sheet all discard the draft, matching Cancel — committing
  // half-typed edits on a dismiss gesture would be the surprising outcome here.
  // Checked BEFORE ftFieldModal: the subfield sheet is opened from inside the field sheet, so when
  // both are up Back must close the inner one. It was missing from this list entirely, so Back fell
  // through to the catch-all: the sheet did close, but closeFtSubfieldSheet(false) never ran, so
  // the draft was neither committed nor discarded and ftSubfieldIdx stayed pointing at a row that
  // was no longer being edited.
  const ftSubfieldModal = document.getElementById('ftSubfieldModal');
  if (isReallyOpen(ftSubfieldModal)) { closeFtSubfieldSheet(false); return true; }
  const ftFieldModal = document.getElementById('ftFieldModal');
  if (isReallyOpen(ftFieldModal)) { closeFtFieldSheet(false); return true; }
  // The attribute sheet edits the live inputs directly, so dismissing it keeps what was typed —
  // there is no draft to discard, and losing a value on a stray Back would be the worse outcome.
  const attrSheet = document.getElementById('attrSheet');
  if (isReallyOpen(attrSheet)) { closeAttrSheet(); return true; }
  // Newest sheets first within each nesting level: Buffer is opened from PlotEtch, Inspect from
  // Review, and both sit above anything that could have launched them.
  const bufferModal = document.getElementById('bufferModal');
  if (isReallyOpen(bufferModal)) { closeBufferModal(); return true; }
  // Below Buffer, because Buffer… is launched from inside this sheet.
  const peToolsSheet = document.getElementById('peToolsSheet');
  if (isReallyOpen(peToolsSheet)) { closePeToolsSheet(); return true; }
  const inspectModal = document.getElementById('inspectModal');
  if (isReallyOpen(inspectModal)) { closeInspect(); return true; }
  const gotoModal = document.getElementById('gotoModal');
  if (isReallyOpen(gotoModal)) { closeGotoModal(); return true; }
  const crsPicker = document.getElementById('crsPickerModal');
  if (isReallyOpen(crsPicker)) { closeCrsPicker(); return true; }
  const sitePicker = document.getElementById('sitePickerModal');
  if (isReallyOpen(sitePicker)) { closeSitePicker(); return true; }
  const layerModal = document.getElementById('layerModal');
  if (isReallyOpen(layerModal)) { closeLayerModal(); return true; }
  // PlotVault is a plain top-level sheet — nothing opens from inside it, so it needs no ordering
  // relative to its neighbours. It is listed anyway: the catch-all at the bottom of this function
  // would strip .show and stop Back escaping, but it would NOT run closePlotVault(), which calls
  // dismissKeyboard(). Skipping that puts the close-while-the-keyboard-is-collapsing race back on
  // the Back path only — the same race the guard at the top of this function exists to prevent.
  const plotvaultModal = document.getElementById('plotvaultModal');
  if (isReallyOpen(plotvaultModal)) { closePlotVault(); return true; }
  const helpModal = document.getElementById('helpModal');
  if (isReallyOpen(helpModal)) { closeHelp(); return true; }
  // Quick Notes is checked before the More drawer because Quick Notes can be opened *from* it —
  // when both are somehow up, the inner one goes first.
  const quickNotesModal = document.getElementById('quickNotesModal');
  if (isReallyOpen(quickNotesModal)) { closeQuickNotesModal(); return true; }
  const moreActionsModal = document.getElementById('moreActionsModal');
  if (isReallyOpen(moreActionsModal)) { closeMoreActions(); return true; }
  const webmapDeleteModal = document.getElementById('webmapDeleteModal');
  if (isReallyOpen(webmapDeleteModal)) { closeWebmapDeleteModal(); return true; }
  const manualCoordModal = document.getElementById('manualCoordModal');
  if (isReallyOpen(manualCoordModal)) { closeManualCoordEntry(); return true; }
  const featureTypePickerModal = document.getElementById('featureTypePickerModal');
  if (isReallyOpen(featureTypePickerModal)) { closeFeatureTypePicker(); return true; }
  // Stats is opened from a header inside the table; the query sheet is opened from the bar above
  // it. Neither can be open at the same time as the other, but stats is listed first so that if
  // they ever are, the inner one closes first — same rule as Quick Notes above.
  const attrStatsModal = document.getElementById('attrStatsModal');
  if (isReallyOpen(attrStatsModal)) { closeAttrStats(); return true; }
  // Back leaves the typed expression in place rather than discarding it, matching the attribute
  // sheet above: losing a half-written query on a stray Back is the worse outcome.
  const attrQueryModal = document.getElementById('attrQueryModal');
  if (isReallyOpen(attrQueryModal)) { closeAttrQuery(); return true; }
  const plotMindModal = document.getElementById('plotMindModal');
  if (isReallyOpen(plotMindModal)) { closePlotMind(); return true; }
  const analyticsModal = document.getElementById('analyticsModal');
  if (isReallyOpen(analyticsModal)) { closeAnalytics(); return true; }
  // Above settingsModal, and for the same reason ftSubfieldModal sits above ftFieldModal: the
  // group sheets are opened from inside the Settings index and layer on top of it, so a Back press
  // with one up must return to the index rather than closing Settings out from under it. Routed
  // through the named close so the whole group set is cleared, not just the class on this element.
  const settingsSub = [...document.querySelectorAll('.settings-subsheet.show')].find(isReallyOpen);
  if (settingsSub) { closeSettingsGroup(settingsSub.dataset.group); return true; }
  const settingsModal = document.getElementById('settingsModal');
  if (isReallyOpen(settingsModal)) { closeSettings(); return true; }
  const customizeModal = document.getElementById('customizeQaModal');
  if (isReallyOpen(customizeModal)) { closeCustomizeQa(); return true; }
  const renameModal = document.getElementById('renameModal');
  if (isReallyOpen(renameModal)) { closeRenameModal(false); return true; }
  // Opened from the Dashboard's map tile (openDashMapPreview() in js/13-dashboard.js). Nothing
  // opens from inside it, and nothing typed lives in it, so there's no draft to preserve on
  // close — just listed here so its own close function runs instead of falling through to the
  // stray catch-all below.
  const dashMapPreviewModal = document.getElementById('dashMapPreviewModal');
  if (isReallyOpen(dashMapPreviewModal)) { closeDashMapPreview(); return true; }
  // Catch-all. Every sheet above gets its own named close so its cleanup runs, but Back must never
  // navigate the screen out from under an open sheet just because someone added a modal and forgot
  // to list it here — that failure is invisible until a user is stuck behind it.
  const stray = [...document.querySelectorAll('.modal-overlay.show')].find(isReallyOpen);
  if (stray) { stray.classList.remove('show'); return true; }
  // Anything still carrying .show at this point is invisible — clear the class
  // so it cannot accumulate, but do NOT report it as closed: reporting true
  // here is exactly what made Back feel broken.
  document.querySelectorAll('.modal-overlay.show').forEach(el => el.classList.remove('show'));
  return false;
}

if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) {
    // ══ HOME SCREEN WIDGET DEEP LINKS ══
    // The widget's buttons fire ACTION_VIEW on plotedge://<target>. Capacitor surfaces that as
    // appUrlOpen. Routing here rather than in MainActivity keeps all navigation decisions in the
    // one place that actually knows the app's state (whether a project is open, which tab, etc.).
    CapApp.addListener('appUrlOpen', ev => {
      const url = (ev && ev.url) || '';
      const target = url.replace(/^plotedge:\/\//,'').replace(/\/+$/,'').split('?')[0];
      if (!target) return;
      if (target === 'projects'){ showProjects(); return; }
      if (target === 'new'){ showNewProject(); return; }
      // 'collect' and 'review' want a project open. Fall back to the last active one, and to the
      // projects list if there isn't one, rather than landing on a hidden panel.
      const id = (activeProjectId) || (activeProjectRef && projects.find(x=>x.id===activeProjectRef) ? activeProjectRef : null);
      if (!id){ showProjects(); showToast('Open a project first'); return; }
      if (!activeProjectId) openProject(id);
      switchTab(target === 'review' ? 'review' : 'collect');
    });
    CapApp.addListener('backButton', () => {
      // Same handler the header arrow uses, so the two can never walk the stack
      // differently. It returns false only at the root with nothing behind it,
      // which is the one point where exiting is the correct response.
      if (appBack()) return;
      // ══ PRESS BACK AGAIN TO EXIT ══
      // This used to call exitApp() on the first press, so one stray back tap at
      // the root closed the app outright — on a field device that can mean
      // walking back to re-open it mid-survey. The two-step confirm is the
      // standard Android convention and costs nothing to the user who genuinely
      // means to leave: they simply press twice.
      requestAppExit();
    });
  }
}



// ══ APP EXIT ══
// Only meaningful in the native shell — a browser tab cannot close itself, and pretending
// otherwise would leave a dead button on the web build. isNativeShell() gates both the hardware
// back path and the explicit Exit row on the Data hub.
function isNativeShell(){
  return !!(window.Capacitor && window.Capacitor.isNativePlatform
    ? window.Capacitor.isNativePlatform()
    : (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App));
}

let _exitArmed = false, _exitTimer = null;

// Two-step by design. The first call arms and tells the user; the second within the window
// actually leaves. Anything else (navigating away, waiting it out) silently disarms, so the
// armed state can never leak into a later, unrelated back press.
function requestAppExit(){
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!CapApp || !CapApp.exitApp) return false;
  if (_exitArmed){
    clearTimeout(_exitTimer); _exitArmed = false;
    // Flush anything unsaved before the process goes away. persistStore() is synchronous, so it
    // completes before exitApp() is reached.
    try { persistStore(); } catch(e) {}
    CapApp.exitApp();
    return true;
  }
  _exitArmed = true;
  showToast('Press back again to exit');
  _exitTimer = setTimeout(()=>{ _exitArmed = false; }, 2000);
  return false;
}

// The explicit affordance, from the Data hub. Unlike the back gesture this is unambiguous — the
// user has deliberately tapped "Exit" — so it confirms once through the standard dialog rather
// than the arm-and-repeat dance, and warns first if anything is still unexported.
function confirmExitApp(){
  const t = dataHubTotals();
  const msg = t.unsynced
    ? `${plural(t.unsynced,'project')} still ${t.unsynced===1?'has':'have'} data that hasn't been exported. Your work is saved on this device and will be here when you come back. Exit PlotEdge?`
    : 'Your work is saved on this device. Exit PlotEdge?';
  showConfirm(msg, ()=>{
    const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    try { persistStore(); } catch(e) {}
    if (CapApp && CapApp.exitApp) CapApp.exitApp();
  }, 'Exit', 'default');
}
