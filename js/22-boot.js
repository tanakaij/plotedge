// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Init, floating capture button, install prompt, service worker, voice, splash
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ INIT ══
projectData = loadStore();

persistStore();

renderProjectsList();

populateAssignedToSuggestions();

// Drives the --grad-tint offline shift on <html> (see CSS) so the ambient background tint
// reflects connectivity everywhere in the app, not just on the Review map screen.
function updateNetworkGradientState(){
  document.documentElement.dataset.network = (('onLine' in navigator) ? (navigator.onLine ? 'online' : 'offline') : 'online');
}

updateNetworkGradientState();

window.addEventListener('online', updateNetworkGradientState);

window.addEventListener('offline', updateNetworkGradientState);

// Resume exactly where the user left off (same project + tab) on reload, or after the OS/browser
// fully kills and relaunches the page (e.g. backgrounding the installed app for a while). While
// the page just stays open in memory (the normal "switch away and come back" case) the SPA never
// unmounts, so this only actually matters when the JS context itself restarts.
(function restoreLastSession(){
  try {
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || 'null'); } catch(e) {}
    if (last && last.projectId && projects.some(p => p.id === last.projectId)) {
      openProject(last.projectId);
      if (last.tab && last.tab !== 'dashboard') switchTab(last.tab);
    } else if (projects.length) {
      // No session to resume, but projects exist — so this is a returning user, not a first run.
      // Land on the Project Manager rather than the Welcome/onboarding screen. Done inline
      // instead of via renderProjectsScreen() because that also writes an empty last-session
      // record, and there is nothing to clear at boot.
      activateView('view-projectmgr');
      renderProjectManager();
    } else {
      // Genuine first run: Welcome is the correct landing screen. It carries no app chrome.
      activateView('view-projects');
      renderProjectsList();
    }
  } catch(e) {
    // If resuming threw for any reason (e.g. a map-library hiccup), fall back to the normal
    // Projects screen rather than leaving the app on a blank hidden view — see the
    // #preRestoreHide removal below, which runs regardless of how this try block exits.
  } finally {
    // Undo the early inline hide from the top of <body> now that we know how this resolved —
    // if openProject() succeeded it already switched .active off #view-projects, and if it
    // didn't (deleted project, error, or no last session) this makes sure Projects is visible
    // instead of staying hidden forever.
    const hideStyle = document.getElementById('preRestoreHide');
    if (hideStyle) hideStyle.remove();
  }
})();

// ══ MEDIA STORE START-UP ══
// Runs after the project store is loaded and the last session restored, so it
// can see every photo record the app knows about. Three jobs, in order:
//
//   1. Preload thumbnails as object URLs, so the first paint of Review, the map
//      and the dashboard is synchronous. Until this resolves, photoThumbSrc()
//      falls back to a 1×1 placeholder rather than a broken-image box — hence
//      the redraw at the end.
//   2. Migrate any photo still carrying inline base64 into IndexedDB. This is
//      the one-time move that gives an existing device its localStorage back;
//      on a project that was already at the old ceiling it is several megabytes.
//   3. Sweep blobs nothing points at any more — deleted features, deleted
//      projects, restores that replaced a project wholesale. Reconciling once at
//      boot is more reliable than hooking every deletion path and silently
//      leaking on whichever one gets added later.
//
// All of it is best-effort: a device with no IndexedDB gets a resolved null at
// every step and simply keeps its photos in memory for the session.
(function initMediaStore(){
  if (typeof photoStorePreloadThumbs !== 'function') return;
  requestPersistentStorage();
  refreshMediaUsage();
  photoStorePreloadThumbs()
    .then(()=>{
      const all = collectPhotoRecords(Object.values(projectData || {}), savedFeatures, currentVertices);
      const legacy = all.filter(p => p && p.dataUrl);
      if (!legacy.length) return 0;
      return photoStoreMigrate(legacy).then(moved => {
        if (moved){
          // The write itself is what drops the inline copies: persistStore()
          // strips dataUrl/thumbUrl, so this is the moment the space comes back.
          persistStore();
          photoStoreShed(legacy);
          console.info('PlotEdge: moved ' + moved + ' photo(s) out of localStorage into the media store');
        }
        return moved;
      });
    })
    .then(()=> photoStoreSweep(allReferencedPhotoIds()))
    .then(()=> refreshMediaUsage())
    .then(()=>{
      updateStorageWarning();
      // Thumbnails resolved after the first paint, so redraw whatever is on
      // screen that shows them.
      if (activeProjectId){
        try { renderFeatures(); } catch(e) {}
        try { renderReviewMap(); } catch(e) {}
        try { updateStats(); } catch(e) {}
      }
    })
    .catch(err => console.warn('PlotEdge: media store start-up did not complete', err));
})();

// PlotAtlas and PlotMind are new, so a device that had already customised its
// Quick Actions would never see them — a new entry in QA_DEFAULT only reaches
// people who never touched the grid. Seeded once, here in boot rather than
// inside the render path, so it can never re-add a tile someone has removed.
qaSeedNewActions();

(function(){
  const wm = document.getElementById('watermarkToggle');
  if (wm) wm.checked = getWatermarkPref();
})();

// ══ WHY THE BUTTON CAPTURES THE POINTER ══
// pointerup only reaches an element if the finger is still over it. `pointerleave` was wired to
// cancel, so the extremely common field gesture — press, thumb rolls a few millimetres off the
// edge, release — fired pointerleave and then delivered pointerup somewhere else entirely. The
// press was cancelled and the release never arrived: no vertex, no toast, nothing. That is the
// other half of "missing capture you have captured", and it gets worse with gloves, in the cold,
// or one-handed.
// setPointerCapture() redirects every later event for that finger back to the button, so a press
// that starts on Capture always finishes on Capture. pointerleave then has no job to do and is
// dropped; genuine interruptions still arrive as pointercancel.
function bindCaptureButton(btn){
  if (!btn) return;
  btn.addEventListener('pointerdown', e => {
    try { btn.setPointerCapture(e.pointerId); } catch(err) { /* not supported — plain events still work */ }
    onCaptureBtnDown();
  });
  btn.addEventListener('pointerup', e => {
    try { if (btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch(err) {}
    onCaptureBtnUp();
  });
  btn.addEventListener('pointercancel', onCaptureBtnCancel);
  // Right-click / long-press context menus interrupt a hold-to-average on some WebViews.
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

bindCaptureButton(document.getElementById('captureBtn'));

// ══ FLOATING CAPTURE BUTTON ══
// Forwards the exact same press/hold handlers as the real button (tap-to-capture, hold-to-average)
// so the two are always functionally identical — only their on-screen visibility differs.
let _captureBtnOnScreen = true;

function updateCaptureFabVisibility(){
  const fab = document.getElementById('captureFab');
  if (!fab) return;
  // Unconditional on Collect now. The old rule ("only once the real button scrolls off") meant
  // the one control the crew reaches for most kept appearing and disappearing as the form
  // scrolled, and Save was never reachable at all without scrolling to the bottom card.
  const collectActive = document.getElementById('panel-collect')?.classList.contains('active');
  fab.classList.toggle('show', !!collectActive);
}

function syncCaptureFab(){
  const fabBtn = document.getElementById('captureFabBtn');
  const realBtn = document.getElementById('captureBtn');
  if (!fabBtn || !realBtn) return;
  fabBtn.disabled = realBtn.disabled;
  fabBtn.classList.toggle('averaging', realBtn.classList.contains('averaging'));
  document.getElementById('captureFabLabel').textContent = document.getElementById('captureBtnLabel').textContent;
  fabBtn.setAttribute('aria-label', document.getElementById('captureBtnLabel').textContent);
  const realBadge = document.getElementById('capturePhotoBadge');
  const fabBadge = document.getElementById('captureFabPhotoBadge');
  fabBadge.textContent = realBadge.textContent;
  fabBadge.className = realBadge.className.replace('capture-photo-badge', '').trim();
  fabBadge.classList.add('capture-photo-badge');
  updateCollectDockStatus();
}

// ══ DOCK STATUS ══
// Deliberately a mirror of DOM the app already maintains (#gpsStatus, #gpsAcc, #ptCount, the real
// Save button) rather than a second source of truth reading gpsActive/currentVertices directly.
// Anything that changes the fix or the vertex list already updates those nodes, so the dock can
// never drift out of sync with the cards — which is the failure mode a parallel implementation
// would eventually hit.
function collectFixQuality(accM){
  if (!isFinite(accM)) return '';
  if (accM <= 5)  return 'good';
  if (accM <= 15) return 'fair';
  return 'poor';
}

function updateCollectDockStatus(){
  const mainEl = document.getElementById('cdStatusMain');
  const subEl  = document.getElementById('cdStatusSub');
  const dotEl  = document.getElementById('cdDot');
  if (!mainEl || !subEl || !dotEl) return;

  const accText = (document.getElementById('gpsAcc')?.textContent || '').trim();
  const statusText = (document.getElementById('gpsStatus')?.textContent || '').trim();
  const accNum = parseFloat(accText);
  const quality = collectFixQuality(accNum);

  dotEl.dataset.fix = quality;
  if (quality) {
    // The accuracy node already carries the user's chosen units, so reuse its string verbatim
    // instead of re-formatting and risking a metric/imperial mismatch against the card above.
    mainEl.innerHTML = '';
    mainEl.appendChild(dotEl);
    mainEl.appendChild(document.createTextNode('±' + accText.replace(/^±\s*/, '')));
  } else {
    mainEl.innerHTML = '';
    mainEl.appendChild(dotEl);
    mainEl.appendChild(document.createTextNode(statusText || 'GPS off'));
  }

  const n = Array.isArray(currentVertices) ? currentVertices.length : 0;
  const typeLabel = (document.getElementById('geoTag')?.textContent || '').trim().toLowerCase();
  subEl.textContent = n === 0
    ? (typeLabel ? 'No vertices · ' + typeLabel : 'No vertices yet')
    : n + (n === 1 ? ' vertex' : ' vertices') + (typeLabel ? ' · ' + typeLabel : '');

  // Save mirrors the real button's own enablement, plus a "there is something here" test so the
  // dock's primary colour is a genuine signal rather than permanent decoration.
  const dockSave = document.getElementById('collectDockSave');
  const realSave = document.getElementById('saveFeatureBtn');
  if (dockSave && realSave) {
    dockSave.disabled = !!realSave.disabled;
    dockSave.classList.toggle('ready', n > 0 && !realSave.disabled);
    const lbl = document.getElementById('collectDockSaveLabel');
    const realLbl = document.getElementById('saveFeatureBtnLabel')?.textContent || 'Save Feature';
    if (lbl) lbl.textContent = /update/i.test(realLbl) ? 'Update' : 'Save';
  }
}

// One observer per node the dock reads. Cheaper and far less noisy than watching the whole
// Collect panel, which re-renders large lists on every capture.
(function bindCollectDockStatus(){
  const watch = ['gpsAcc','gpsStatus','ptCount','geoTag','saveFeatureBtnLabel']
    .map(id => document.getElementById(id)).filter(Boolean);
  if (!watch.length) return;
  const obs = new MutationObserver(() => updateCollectDockStatus());
  watch.forEach(el => obs.observe(el, { childList:true, characterData:true, subtree:true }));
  const realSave = document.getElementById('saveFeatureBtn');
  if (realSave) new MutationObserver(() => updateCollectDockStatus())
    .observe(realSave, { attributes:true, attributeFilter:['disabled'] });
  updateCollectDockStatus();
})();

(function(){
  const realBtn = document.getElementById('captureBtn');
  const fabBtn = document.getElementById('captureFabBtn');
  if (!realBtn || !fabBtn) return;
  fabBtn.addEventListener('pointerdown', onCaptureBtnDown);
  fabBtn.addEventListener('pointerup', onCaptureBtnUp);
  fabBtn.addEventListener('pointercancel', onCaptureBtnCancel);
  fabBtn.addEventListener('pointerleave', onCaptureBtnCancel);
  // Keeps the floating button's label/disabled/averaging state in sync with the real one
  // automatically, without having to touch every place that updates the real button.
  new MutationObserver(syncCaptureFab).observe(realBtn, { attributes:true, attributeFilter:['disabled','class'], childList:true, subtree:true, characterData:true });
  syncCaptureFab();
  new IntersectionObserver(entries=>{
    entries.forEach(entry=>{ _captureBtnOnScreen = entry.isIntersecting; updateCaptureFabVisibility(); });
  }, { threshold: 0 }).observe(realBtn);
})();

// ══ INSTALL PROMPT ══
// Chrome/Edge/Android fire `beforeinstallprompt` when the app is installable; we stash that event
// (browsers only let it fire once and only let you call .prompt() from a user gesture, so it has
// to be captured early and held until the person taps our own Install button) and show a banner
// instead of relying on the browser's own install UI, which is easy to miss. iOS Safari never
// fires this event at all — "Add to Home Screen" is a manual Share-sheet action there — so on iOS
// we show the same banner with instructions instead of a button. Already-installed (standalone)
// sessions never show it. Dismissing is remembered so it doesn't nag every visit, but the flag is
// versioned so a future re-ask (e.g. after a big feature) is possible by bumping INSTALL_DISMISS_KEY.
const INSTALL_DISMISS_KEY = 'plotedge_install_dismissed_v1';

let deferredInstallPrompt = null;

function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function showInstallBanner(mode){
  if (isStandalone()) return;
  try { if (localStorage.getItem(INSTALL_DISMISS_KEY)) return; } catch(e) {}
  const banner = document.getElementById('installBanner');
  if (!banner) return;
  if (mode === 'ios') {
    banner.classList.add('ios');
    document.getElementById('installBannerSub').textContent = 'Tap Share, then "Add to Home Screen".';
  }
  banner.style.display = 'flex';
}

function dismissInstallBanner(){
  const banner = document.getElementById('installBanner');
  if (banner) banner.style.display = 'none';
  try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch(e) {}
}

async function handleInstallClick(){
  if (!deferredInstallPrompt) return;
  const banner = document.getElementById('installBanner');
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  if (outcome === 'accepted') {
    if (banner) banner.style.display = 'none';
  } else {
    // Declined this time, not "never ask again" — leave the dismiss decision to the explicit
    // close button so a mis-tap on the browser's own confirm dialog doesn't silently hide it.
    dismissInstallBanner();
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner('standard');
});

window.addEventListener('appinstalled', () => {
  const banner = document.getElementById('installBanner');
  if (banner) banner.style.display = 'none';
  deferredInstallPrompt = null;
  showToast('PlotEdge installed');
});

// iOS never fires beforeinstallprompt — show the manual-steps version on a short delay so it
// doesn't compete with the splash screen on a brand-new visit.
if (isIOS() && !isStandalone()) {
  setTimeout(() => showInstallBanner('ios'), 1200);
}


// ══ SERVICE WORKER + UPDATE DETECTION ══
// Registers the app-shell service worker (see plotedge-sw.js — now network-first for the shell,
// so a fresh deploy is fetched on the very next load rather than served from cache). This
// part handles the case where the app was ALREADY open in a tab when the new version deployed: the
// new SW activates in the background, and we reload once so that tab picks up the new JS/HTML
// instead of continuing to run the old code against a new SW.
//
// updateViaCache:'none' tells the browser to never satisfy plotedge-sw.js itself from the HTTP
// cache — always hit the network for the SW script — regardless of whatever Cache-Control header
// the host sends (or doesn't send). This used to be backed up by a Netlify-only `_headers` file;
// doing it here instead means the same guarantee holds on GitHub Pages, Cloudflare Pages, or
// anywhere else this gets deployed, with no host-specific config required.
if ('serviceWorker' in navigator) {
  let _swReady = false; // guards against reloading on the very first install for a brand-new visitor
  navigator.serviceWorker.register('plotedge-sw.js', { updateViaCache: 'none' })
    .then(()=>{ setTimeout(()=>{ _swReady = true; }, 1500); })
    .catch(()=>{});
  let _swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!_swReady || _swRefreshing) return;
    _swRefreshing = true;
    showToast('Updating to the latest version…');
    setTimeout(()=>location.reload(), 900);
  });
}

(function(){
  // Build both format pickers from EXPORT_FORMATS first, then apply the stored default — the
  // options have to exist before a value can be assigned to them.
  if (typeof buildExportFormatSelects === 'function') buildExportFormatSelects();
  const sel=document.getElementById('exportFormatSelect');
  if(sel){ sel.value = defaultExportFormat(); if (typeof updateExportFormatUI === 'function') updateExportFormatUI(); }
  const ssel=document.getElementById('settingsExportFormat');
  if(ssel) ssel.value = defaultExportFormat();
})();

updateExportFormatUI();

initPhotoBackupSettings();


// ══ VOICE NOTES ══ — free, built-in browser speech-to-text (Web Speech API). No server, API key,
// or paid transcription service involved — everything runs through the browser's own recognizer.
// Support varies: solid on Chrome/Edge (desktop) and Chrome for Android; Firefox and most iOS
// browsers don't implement it, so we feature-detect and disable the button with an explanation
// rather than pretending it works everywhere.
let voiceRecognition = null;

let voiceRecording = false;

let voiceNotesBaseText = '';

function initVoiceNotes(){
  const btn = document.getElementById('voiceNoteBtn');
  if (!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.title = "Voice-to-text isn't supported in this browser. Try Chrome on Android or desktop";
    return;
  }
  voiceRecognition = new SR();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = navigator.language || 'en-US';
  voiceRecognition.onresult = (e) => {
    let finalText = '', interimText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += transcript + ' ';
      else interimText += transcript;
    }
    if (finalText) voiceNotesBaseText = (voiceNotesBaseText + ' ' + finalText).trim();
    document.getElementById('featureNotes').value = (voiceNotesBaseText + ' ' + interimText).trim();
  };
  voiceRecognition.onerror = (e) => {
    if (e.error === 'no-speech') return; // benign — recognizer just heard silence, keeps going
    const wasRecording = voiceRecording;
    stopVoiceNote();
    if (!wasRecording) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showToast('Microphone access denied. Check browser/site permissions.');
    } else {
      showToast('Voice input stopped (' + e.error + ')');
    }
  };
  voiceRecognition.onend = () => {
    // Some browsers auto-stop the recognizer after a pause in speech even though we asked for
    // continuous listening — if the user hasn't tapped Stop, restart it so it feels seamless.
    if (voiceRecording) { try { voiceRecognition.start(); } catch(e) {} }
  };
}

function toggleVoiceNote(){
  if (!voiceRecognition) return;
  if (voiceRecording) stopVoiceNote(); else startVoiceNote();
}

function startVoiceNote(){
  voiceNotesBaseText = document.getElementById('featureNotes').value.trim();
  try { voiceRecognition.start(); } catch(e) { return; }
  voiceRecording = true;
  const btn = document.getElementById('voiceNoteBtn');
  btn.classList.add('recording');
  document.getElementById('voiceNoteBtnText').textContent = 'Stop';
  const status = document.getElementById('voiceNoteStatus');
  status.style.display = 'flex';
  status.classList.add('recording');
  document.getElementById('voiceNoteStatusText').textContent = 'Listening… tap Stop when done';
}

function stopVoiceNote(){
  voiceRecording = false;
  try { voiceRecognition && voiceRecognition.stop(); } catch(e) {}
  const btn = document.getElementById('voiceNoteBtn');
  if (btn) btn.classList.remove('recording');
  const label = document.getElementById('voiceNoteBtnText');
  if (label) label.textContent = 'Record';
  const status = document.getElementById('voiceNoteStatus');
  if (status) { status.style.display = 'none'; status.classList.remove('recording'); document.getElementById('voiceNoteStatusText').textContent = ''; }
}

initVoiceNotes();


// ══ SPLASH SCREEN: SOUND + FIRST-VISIT-ONLY ══
// The chime is synthesized with Web Audio (no audio file, works offline) and is scheduled
// against the SAME timeline the CSS animations run on — see the :root --sp-* variables in the
// splash stylesheet. Nothing here invents its own timings.
//
// What was wrong before: the old version called ctx.resume() and, if the browser's autoplay
// policy blocked it, armed a `pointerdown` listener that fired the chime on the user's FIRST TAP.
// That tap could land three seconds after the animation had finished, so the sound arrived
// completely detached from the picture — which is exactly what "the tone rings separate" is.
// It also started counting from whenever the JS happened to run, not from when the animation
// actually began painting.
//
// What happens now: t=0 is taken from the glow's own `animationstart` event, so audio time and
// animation time share an origin by construction. If audio can't unlock inside a short grace
// window we stay SILENT rather than ring late — a missing chime is invisible, a late one is
// jarring.

// Read a beat straight out of the stylesheet. The CSS is the single source of truth for timing;
// this just parses it back so the synth can schedule against the same numbers.
function readSplashBeat(name, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(raw);
    if (!isFinite(n)) return fallback;
    return raw.endsWith('ms') ? n / 1000 : n;
  } catch (e) { return fallback; }
}


// Built here rather than at play time so the browser's unlock has a head start on the animation.
// Gated on the first-visit flag: the splash only ever runs once, and spinning up an AudioContext
// on every subsequent launch would hold audio hardware open for a cue that will never play.
let splashCtx = null;

let splashMaster = null;

try {
  const SplashCtxCtor = window.AudioContext || window.webkitAudioContext;
  if (SplashCtxCtor && !localStorage.getItem('plotedge_visited')) {
    splashCtx = new SplashCtxCtor();
    splashCtx.resume().catch(()=>{});
  }
} catch (e) { splashCtx = null; }


// One struck note. Two detuned triangles an octave apart through a shared envelope: the octave
// gives it a struck/bell quality instead of a flat beep, and the few cents of detune between the
// pair is what stops it sounding synthetic. Fast attack, long exponential tail.
function splashVoice(ctx, dest, freq, at, peak, decay) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  gain.connect(dest);

  [[freq, 0, 1], [freq, 7, 0.55], [freq * 2, -5, 0.28]].forEach(([f, cents, mix]) => {
    const osc = ctx.createOscillator();
    const lvl = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    osc.detune.value = cents;
    lvl.gain.value = mix;
    osc.connect(lvl); lvl.connect(gain);
    osc.start(at);
    osc.stop(at + decay + 0.08);
  });
}


// Schedules the whole cue. `lateBy` is how far past the animation's t=0 we already are, so a
// context that took an extra frame to unlock still lands its notes on the right beats instead of
// replaying the cue from the start.
function scheduleSplashChime(ctx, lateBy) {
  const logoIn = readSplashBeat('--sp-logo-start', 0.14);
  const nameIn = readSplashBeat('--sp-name-start', 0.74);
  const settle = readSplashBeat('--sp-settle',     1.04);
  const glowIn = readSplashBeat('--sp-glow-start', 0.06);
  const glowDur = readSplashBeat('--sp-glow-dur',  1.50);
  const bloom  = glowIn + glowDur * 0.25;   // glow reaches full strength

  const t0 = ctx.currentTime - lateBy;      // audio-clock position of animation t=0

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  splashMaster = master;

  // Lowpass opening from muffled to bright across the glow bloom — the sonic equivalent of the
  // glow blooming out of the dark. Same curve, same duration, same start.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.7;
  tone.frequency.setValueAtTime(520, t0 + glowIn);
  tone.frequency.exponentialRampToValueAtTime(5200, t0 + glowIn + glowDur * 0.6);
  tone.connect(master);

  // Cheap stereo-less "air": two delay taps with light feedback, rolled off so the repeats sit
  // behind the notes rather than smearing them. A convolver would need an impulse file, which
  // would break the single-file-works-offline rule.
  const space = ctx.createGain();
  space.gain.value = 0.22;
  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = 0.17;
  const fb = ctx.createGain();
  fb.gain.value = 0.26;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 2600;
  delay.connect(damp); damp.connect(fb); fb.connect(delay);
  damp.connect(space); space.connect(master);
  tone.connect(delay);

  // Sustained root underneath, swelling and receding with the glow. Stacked fifth (D2 + A2) so
  // the pad agrees with the quintal voicing above it.
  [73.42, 110.00].forEach((f, i) => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + glowIn);
    g.gain.exponentialRampToValueAtTime(i ? 0.030 : 0.045, t0 + bloom);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + glowIn + glowDur);
    osc.connect(g); g.connect(master);
    osc.start(t0 + glowIn);
    osc.stop(t0 + glowIn + glowDur + 0.1);
  });

  // The four beats. Each one is a frame the eye is already looking at: mark enters, glow peaks,
  // wordmark enters, mark settles. Perfect fifths stacked upward — D4, A4, E5, B5.
  [
    { f: 293.66, at: logoIn, peak: 0.15, decay: 1.5 },
    { f: 440.00, at: bloom,  peak: 0.14, decay: 1.5 },
    { f: 659.25, at: nameIn, peak: 0.12, decay: 1.4 },
    { f: 987.77, at: settle, peak: 0.10, decay: 1.6 },
  ].forEach(n => {
    const at = t0 + n.at;
    if (at < ctx.currentTime) return;   // beat already gone by — skip it, don't crowd the next one
    splashVoice(ctx, tone, n.f, at, n.peak, n.decay);
  });
}


// Ties the audio's t=0 to the animation's t=0 by listening for the glow's own animationstart.
// `animationstart` fires after animation-delay has elapsed, so the event marks --sp-glow-start,
// not zero — subtract it back off to recover the true origin.
function armSplashChime(glowEl) {
  if (!splashCtx || !glowEl) return;
  let armed = false;

  const onStart = () => {
    if (armed) return;
    armed = true;
    const origin = performance.now() - readSplashBeat('--sp-glow-start', 0.06) * 1000;
    const giveUpAt = performance.now() + 200;   // grace for a context still unlocking

    const attempt = () => {
      if (!splashCtx) return;
      if (splashCtx.state === 'running') {
        scheduleSplashChime(splashCtx, (performance.now() - origin) / 1000);
        return;
      }
      if (performance.now() < giveUpAt) { requestAnimationFrame(attempt); return; }
      // Still blocked. Stay silent — firing on a later tap is what made the old version feel
      // bolted on, and no chime at all is better than one that arrives out of sync.
      try { splashCtx.close(); } catch (e) {}
      splashCtx = null;
    };
    attempt();
  };

  glowEl.addEventListener('animationstart', onStart, { once: true });
  // Reduced-motion disables the animation entirely, so animationstart never arrives and the cue
  // correctly never plays. This is just a guard against a browser that silently drops the event.
  setTimeout(() => { if (!armed) { try { splashCtx && splashCtx.close(); } catch (e) {} splashCtx = null; } }, 900);
}


// Rides the audio out on the same curve as the visual fade, so picture and sound leave together.
function fadeOutSplashChime(seconds) {
  if (!splashCtx || !splashMaster) return;
  try {
    const end = splashCtx.currentTime + seconds;
    splashMaster.gain.cancelScheduledValues(splashCtx.currentTime);
    splashMaster.gain.setValueAtTime(splashMaster.gain.value, splashCtx.currentTime);
    splashMaster.gain.linearRampToValueAtTime(0.0001, end);
    setTimeout(() => { try { splashCtx && splashCtx.close(); } catch (e) {} splashCtx = null; }, seconds * 1000 + 250);
  } catch (e) {}
}


// ══ ONBOARDING (first launch) ══
const ONBOARD_STEPS = [
  { icon:'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    title:'Create a project', sub:'Everything you capture in the field lives inside a project. Start by naming the site or job you\'re working on.' },
  { icon:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    title:'Define what you\'re capturing', sub:'Set up feature types (fences, trees, poles, whatever you\'re mapping) with the fields you need for each.' },
  { icon:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    title:'Capture points', sub:'Walk the site and tap Capture to log GPS points, photos, and attributes as you go. Works offline.' },
  { icon:'<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    title:'Review', sub:'Check everything on the map and in the list. PlotEdge flags low-accuracy points and anything missing photos.' },
  { icon:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    title:'Export', sub:'When you\'re done, export to GeoJSON, CSV, or a zipped GeoPackage, ready for QGIS or ArcGIS.' },
];

let onboardStepIdx = 0;

function renderOnboardStep(){
  const box = document.getElementById('onboardBox');
  if (!box) return;
  const step = ONBOARD_STEPS[onboardStepIdx];
  const isLast = onboardStepIdx === ONBOARD_STEPS.length - 1;
  box.innerHTML = `
    <div class="onboard-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${step.icon}</svg></div>
    <div class="onboard-step-lbl">Step ${onboardStepIdx+1} of ${ONBOARD_STEPS.length}</div>
    <div class="onboard-title">${step.title}</div>
    <div class="onboard-sub">${step.sub}</div>
    <div class="onboard-dots">${ONBOARD_STEPS.map((_,i)=>`<div class="onboard-dot${i===onboardStepIdx?' active':''}"></div>`).join('')}</div>
    <div class="onboard-actions">
      <button class="onboard-skip" onclick="dismissOnboarding()">${isLast?'':'Skip'}</button>
      <button class="onboard-next" onclick="onboardNext()">${isLast?'Get started':'Next'}</button>
    </div>`;
}

function onboardNext(){
  if (onboardStepIdx < ONBOARD_STEPS.length - 1) { onboardStepIdx++; renderOnboardStep(); }
  else dismissOnboarding();
}

function showOnboarding(){
  const overlay = document.getElementById('onboardOverlay');
  if (!overlay) return;
  onboardStepIdx = 0;
  renderOnboardStep();
  overlay.classList.add('show');
}

function dismissOnboarding(){
  const overlay = document.getElementById('onboardOverlay');
  if (overlay) overlay.classList.remove('show');
}


// ══ SPLASH SCREEN DISMISS ══
// Only ever shown on the very first visit/install — every reload or later launch after that skips
// straight past it (see the tiny inline script right before #splashScreen in the markup, which
// hides it with zero flash before it can even paint). renderProjectsList()/restoreLastSession()
// above have already populated the app by this point, so the reveal underneath is never
// blank/half-drawn. A short minimum-display time keeps the first-run animation from feeling like a
// flicker, while still getting out of the way quickly. 2000ms gives the glow bloom, logo settle,
// wordmark fade-in, and the four-note chime (finishes ~1.1s in) room to land before fade-out starts.
(function(){
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  let seen = false;
  try { seen = !!localStorage.getItem('plotedge_visited'); } catch(e) {}
  if (seen) { splash.remove(); return; }
  try { localStorage.setItem('plotedge_visited', '1'); } catch(e) {}

  // Hand the chime the glow element so it can take t=0 from that element's own animationstart
  // rather than from whenever this script happens to run.
  armSplashChime(splash.querySelector('.splash-glow'));

  // Hold and fade both come from the stylesheet too, so the whole cue — picture and sound —
  // retimes from one place. The hold is long enough for the last note's tail to bloom before
  // anything starts moving away.
  const hold = readSplashBeat('--sp-hold', 2.30) * 1000;
  const fade = readSplashBeat('--sp-fade', 0.50) * 1000;

  setTimeout(()=>{
    // Ramp the audio down on the same curve, starting on the same frame, as the visual fade.
    // The chime's tail is still ringing here, and hearing it recede exactly as the mark dissolves
    // is what makes the two read as one cue rather than a sound played over a picture.
    fadeOutSplashChime(fade / 1000);
    splash.classList.add('hide');
    setTimeout(()=>{ splash.remove(); showOnboarding(); }, fade);
  }, hold);
})();

// ══ THEME TOGGLE ICONS ══
// Moved here from js/01-theme-and-settings.js — see the note at its original
// site. It has to run after every script is loaded because painting the toggles
// reaches into PlotLens (js/15) and Quick Actions (js/16). The palette itself
// was already applied before first paint by the inline script in index.html.
applyTheme(currentTheme());
