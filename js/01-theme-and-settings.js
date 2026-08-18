// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Theme, domain palette, screen bands, units, contrast, density, settings modal
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.

// ══ THEME (light/dark) ══
// ══ THEME (auto / light / dark) ══
// The initial theme is already applied by the tiny blocking script in <head> (avoids a flash of
// the wrong theme). This block owns the toggle button + Settings seg-control, persistence, and
// OS-preference syncing for the rest of the session. 'auto' is not just the default — it stays
// live for as long as the person leaves it on Auto, so the app keeps following the device's
// light/dark switch (e.g. sunrise/sunset auto-switching on iOS) rather than only reading it once
// at first launch. Picking Light or Dark explicitly stops that syncing until switched back.
const THEME_KEY = 'plotedge_theme';

// ══ DOMAIN THEME + SCREEN STATE ══
// Two axes, both stored on <html> so a single CSS selector can express any combination:
//   data-theme  light/dark   (existing)
//   data-domain the GIS palette
//   data-screen the ambient intensity band
const DOMAIN_KEY = 'plotedge_domain';

// The six pillars. Order here drives the settings picker, and is arranged so
// adjacent swatches are never adjacent hues — two greens or two blues side by
// side is what made the old picker hard to read.
const GIS_DOMAINS = {
  land:        { label:'Earth & Land',     hint:'Soils, terrain, land use' },
  water:       { label:'Water',            hint:'Hydrology, drainage, WASH' },
  climate:     { label:'Climate',          hint:'Weather, hazard, risk' },
  environment: { label:'Environment',      hint:'Forestry, conservation, biodiversity' },
  people:      { label:'People & Places',  hint:'Settlements, households, social survey' },
  geospatial:  { label:'Geospatial',       hint:'Cadastral, control, instrument work' }
};

// ══ LEGACY MIGRATION ══
// Devices already in the field have one of the old five keys in localStorage.
// Without this table setDomainTheme() would fall through to its default and
// silently reset a crew's chosen palette on the first launch after updating.
// Mapped by meaning, not by colour: Agriculture was the soils/land pillar, so
// it becomes Earth & Land rather than Environment.
const DOMAIN_ALIASES = {
  default:  'water',        // was "Hydrology & Field"
  forestry: 'environment',  // was "Canopy & Conservation"
  agric:    'land',         // was "Precision Ag & Soils"
  survey:   'geospatial',   // was "Cadastral & Parcels"
  climate:  'climate'       // unchanged in name; re-tinted violet
};

// Single resolver used by both the pre-paint boot script and setDomainTheme(),
// so a stored value can never be interpreted two different ways.
function resolveDomain(name){
  if (GIS_DOMAINS[name]) return name;
  if (DOMAIN_ALIASES[name]) return DOMAIN_ALIASES[name];
  return 'geospatial';
}

function currentDomain(){ return document.documentElement.getAttribute('data-domain') || 'geospatial'; }

function setDomainTheme(name, announce){
  name = resolveDomain(name);
  // Reuses the theme-switching freeze: without it every accent-coloured control animates its own
  // transition independently and the swap arrives as a ragged wash instead of a clean cut.
  const root = document.documentElement;
  root.classList.add('theme-switching');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  root.setAttribute('data-domain', name);
  try { localStorage.setItem(DOMAIN_KEY, name); } catch(e) {}
  // ══ MAKE THE CHANGE VISIBLE ══
  // A toast alone was not enough: on a scrolled list, or on Review where the
  // ambient layer is deliberately at zero over the map tiles, the switch could
  // land with no perceptible result. This washes the NEW accent across the
  // screen once and fades. It is its own fixed overlay rather than an animation
  // on .mesh-blobs, for two reasons: the mesh is suppressed on exactly the
  // screens that need the confirmation most, and an animation ending on the
  // mesh would have to land on whatever opacity the current screen band sets,
  // snapping when it finished.
  const bloom = document.getElementById('domainBloom');
  if (bloom) {
    bloom.classList.remove('play');
    void bloom.offsetWidth;            // force a reflow so the class re-triggers
    bloom.classList.add('play');
    bloom.addEventListener('animationend', () => bloom.classList.remove('play'), { once:true });
  }
  // The status bar and PWA chrome read a resolved colour, not a token, so they have to be told
  // again after the palette changes.
  requestAnimationFrame(()=>{
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', cssVar('--grad-1') || '#0B0F19');
  });
  syncDomainPickerUI();
  if (announce) showToast('Theme: ' + GIS_DOMAINS[name].label);
}

// Screen context drives how loud the ambient mesh is allowed to be. Called from the navigation
// entry points rather than inferred from a scroll position or a route string, so a screen that
// needs a specific band (Map, above all) can never end up with the wrong one.
const SCREEN_STATES = ['home','form','map','settings'];

function setScreenState(name){
  if (SCREEN_STATES.indexOf(name) === -1) name = 'home';
  document.documentElement.setAttribute('data-screen', name);
}

function currentScreenState(){ return document.documentElement.getAttribute('data-screen') || 'home'; }

function syncDomainPickerUI(){
  const active = currentDomain();
  document.querySelectorAll('.domain-swatch').forEach(el => {
    const on = el.dataset.domain === active;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function currentTheme(){ return document.documentElement.getAttribute('data-theme') || 'dark'; }

function currentThemeMode(){ return document.documentElement.getAttribute('data-theme-mode') || 'auto'; }

function systemPrefersLight(){ return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); }

function applyTheme(theme){
  // ══ GLITCH-FREE SWITCH ══
  // Many components carry transitions on background/border/color (buttons, chips, inputs, the
  // step badges). Flipping the theme attribute makes every one of those animate independently,
  // so the repaint arrives as a ragged several-hundred-ms wash rather than a clean cut. Killing
  // transitions for exactly one frame makes the swap atomic. The double rAF matters: the first
  // frame is where the new colours are painted, so the class can only be lifted on the second —
  // removing it after a single frame reintroduces the fade it was meant to suppress.
  const root = document.documentElement;
  root.classList.add('theme-switching');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  document.documentElement.setAttribute('data-theme', theme);
  // Keep the browser/PWA chrome (status bar, task switcher) in sync with the active theme — read
  // the *actual* --grad-1 token rather than a hardcoded hex, so the status bar is always the exact
  // same shade as the header sitting right below it (edge-to-edge, no visible seam), including in
  // outdoor/high-contrast mode where surfaces shift slightly.
  requestAnimationFrame(()=>{
    const metaTheme=document.querySelector('meta[name="theme-color"]');
    if(metaTheme) metaTheme.setAttribute('content', cssVar('--grad-1') || (theme==='light' ? '#FFFFFF' : '#0B0F19'));
  });
  // The status bar is transparent and draws over the app's own gradient (edge-to-edge), so the
  // ANDROID APK build needs its icon color (clock/battery/notch) flipped to match — dark icons
  // over the light/pink theme's header, light icons over the dark theme's. AndroidChrome is
  // injected by MainActivity (see scripts/patch-android-ui.py) and is only present in the APK
  // build, not in the plain browser/PWA, so this is a no-op there.
  if (window.AndroidChrome && typeof window.AndroidChrome.setLightStatusBar === 'function') {
    try { window.AndroidChrome.setLightStatusBar(theme === 'light'); } catch(e) {}
  }
  const mode = currentThemeMode();
  const nextLabel = mode==='auto' ? 'light' : mode==='light' ? 'dark' : 'auto';
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.innerHTML = mode==='auto' ? AUTO_ICON : (theme==='light' ? SUN_ICON : MOON_ICON);
    btn.setAttribute('title', mode==='auto' ? `Auto theme (currently ${theme}) · tap for ${nextLabel}` : `${theme[0].toUpperCase()}${theme.slice(1)} theme · tap for ${nextLabel}`);
  });
  syncSettingsModalUI();
}

// mode: 'auto' | 'light' | 'dark'. Replaces the old binary setTheme(); kept as the single place
// that resolves a mode down to an actual rendered theme and persists the *mode* (not the
// resolved theme), since 'auto' has to be stored as itself to keep following the OS afterward.
function setThemeMode(mode){
  document.documentElement.setAttribute('data-theme-mode', mode);
  applyTheme(mode==='auto' ? (systemPrefersLight() ? 'light' : 'dark') : mode);
  try{ localStorage.setItem(THEME_KEY, mode); }catch(e){}
}

// toggleTheme() removed: the Settings modal shows Auto/Light/Dark as a segmented control and
// calls setThemeMode() with an explicit value, so nothing cycled through them any more.
const MOON_ICON='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

const SUN_ICON='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

// Distinct from both — a small monitor/device glyph, so "Auto" reads as "following the system"
// rather than looking like a third light/dark variant.
const AUTO_ICON='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

// Sync automatically with OS-level changes for as long as the mode is 'auto'.
if(window.matchMedia){
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e=>{
    if (currentThemeMode() === 'auto') applyTheme(e.matches ? 'light' : 'dark');
  });
}

// applyTheme(currentTheme()) used to run HERE. It moved to js/22-boot.js.
//
// WHY: it paints the toggle icons, which means it calls syncSettingsModalUI(),
// which calls syncPlotLensEntry() (js/15) and renderQuickActions() (js/16).
// In the old single file every function declaration hoisted to the top of one
// script, so a load-time call could reach a function defined 10,000 lines below
// it. Split across files that is no longer true: js/01 runs before js/15 exists,
// and this threw ReferenceError on every launch — taking the rest of js/01 with
// it, which is how one stray call becomes a blank app.
// The visible theme is already correct before this runs: the pre-paint script in
// index.html sets data-theme on <html>. This call only syncs the toggle icons,
// so running it at the end of boot costs nothing.


// ══ KEYBOARD-AWARE VIEWPORT ══
// Two separate mobile-keyboard problems, one script:
// 1) Fixed-position bottom sheets (.modal-overlay/.modal-box — coordinate entry, settings, etc.)
//    are sized against the *layout* viewport, which iOS Safari does NOT shrink when the keyboard
//    opens. That leaves the sheet's own action buttons positioned behind the keyboard, invisible,
//    even though the sheet itself looks fine. --vvh (set from window.visualViewport, which DOES
//    shrink) lets the CSS constrain the sheet to only the actually-visible area above the keyboard.
// 2) Inputs living in normal page flow (New Project, Feature Type editor, attribute fields, etc.)
//    can still end up covered right as the keyboard finishes animating in, especially the button
//    sitting just below the last field in a form — the browser's own "scroll focused input into
//    view" doesn't always leave room for what's below it. A short delay + explicit scrollIntoView
//    on focus (timed to land after the keyboard's opening animation, not before) fixes that for
//    both platforms without depending on browser-specific auto-scroll behavior.
// PERF: this used to write --vvh straight onto documentElement on every event, with a
// visualViewport 'scroll' listener attached. visualViewport scroll fires continuously while
// a finger is on the screen, and --vvh is a custom property on the root — so every single
// scroll frame invalidated style for the entire document tree. That was the single largest
// source of the app feeling sticky/jerky while scrolling long vertex lists.
//
// Two changes: coalesce writes into one rAF (so at most one per frame no matter how many
// events land), and skip the write entirely when the height hasn't actually changed — which
// is the case for essentially every scroll event, since only the keyboard and the URL bar
// really move it. Steady-state cost is now zero style invalidations instead of ~60/second.
//
// --vvh alone was not enough. It tells you how tall the visible strip is, but not *where* it
// starts, and not how much of the screen the keyboard is eating — both of which the overlay
// rules now need (see the .modal-overlay comment in the stylesheet). Three values, one pass:
//   --vvh  visible viewport height          (unchanged, kept for anything still reading it)
//   --kbh  keyboard height, bottom-anchored (innerHeight − visible height − top offset)
//   --vvot how far the visual viewport has been scrolled below the layout viewport
// --vvot is only written while the keyboard is actually up. Outside that it is pinned to 0,
// which keeps the steady-state write count at zero during ordinary scrolling — the whole point
// of the rAF coalescing below — since offsetTop otherwise ticks on every rubber-band frame.
let vvhPending = false, vvhLast = -1, kbhLast = -1, vvotLast = -1;

// ══ WHY THERE ARE TWO THRESHOLDS, NOT ONE ══
// A single KB_OPEN_PX cutoff is a step function sitting exactly where the keyboard's own
// open/close animation crosses it. Android reports the IME height as it slides, so the raw
// value sweeps 0 → 40 → 95 → 180 → 320 over ~250ms; with one cutoff at 90 the class and the
// --kbh custom property flip on and off across consecutive frames while the value hovers near
// it, and every flip re-lays out the sheet (border-radius, --sab-sheet, padding-bottom). That
// flapping IS the "violent snap/flicker" — it is not one jump, it is a dozen.
// Hysteresis fixes it: it takes 120px to declare the keyboard OPEN and it must fall below 60px
// to be declared CLOSED again, so the noisy band in between can never toggle the state.
const KB_OPEN_PX  = 120; // rising edge — below this it's browser chrome moving, not a keyboard
const KB_CLOSE_PX = 60;  // falling edge — must drop under this before we call it closed

// ══ NATIVE KEYBOARD BRIDGE (Capacitor / Android WebView) ══
// MainActivity (generated by scripts/patch-android-ui.py) reads the real ime() inset and calls
// these two hooks. They are deliberately plain globals rather than a plugin: the JS interface is
// injected before the first script tag runs, and everything here has to work identically in a
// plain browser where neither hook is ever called.
//
// WHY NATIVE WINS WHEN IT IS AVAILABLE:
// visualViewport is a *derived* signal — innerHeight minus a height the compositor updates on its
// own schedule. During the IME's ~250ms slide it sweeps through intermediate values, which is what
// the KB_OPEN_PX/KB_CLOSE_PX hysteresis above exists to filter. The native inset is the value the
// platform is animating TO, delivered with the animation, so it needs no filtering and never
// flaps. Where we have it, we use it and skip the heuristics entirely.
//
// nativeKbh stays null until the first native callback, so a browser build (or Android < 30, where
// the animation callbacks never fire) keeps the visualViewport path unchanged.
let nativeKbh = null;
let kbAnimating = false;

window.__plotedgeNativeKbh = function(px){
  const next = Math.max(0, Math.round(Number(px) || 0));
  if (next === nativeKbh) return;
  nativeKbh = next;
  setVvh();
};

// While the platform is animating the IME, CSS must not ALSO be easing the same geometry — two
// animations targeting one value on different clocks is precisely the stutter. html.kb-animating
// switches the overlay to instant tracking (see css/05-components.css) for the duration.
window.__plotedgeKbAnimating = function(active){
  kbAnimating = !!active;
  document.documentElement.classList.toggle('kb-animating', kbAnimating);
  // A freeze started by a closing sheet must not outlive the platform animation it was guarding.
  if (!kbAnimating) { kbFrozenUntil = 0; setVvh(); }
};

// ══ THE CLOSE LOCK ══
// While a sheet is running its exit transition the keyboard is collapsing at the same time, on a
// different clock. Every --kbh write during that window retargets `padding-bottom` on the overlay
// the sheet is still sliding inside, so the sheet's own travel distance changes mid-flight — the
// ghosting and clipping reported on dismissal. Freezing the geometry for the length of the exit
// lets the two animations run in sequence instead of fighting. Values are re-read once on unlock.
let kbFrozenUntil = 0;
function freezeKeyboardGeometry(ms){
  kbFrozenUntil = Math.max(kbFrozenUntil, Date.now() + (ms || 260));
  setTimeout(setVvh, (ms || 260) + 20);
}
window.freezeKeyboardGeometry = freezeKeyboardGeometry;

function applyVvh(){
  vvhPending = false;
  if (Date.now() < kbFrozenUntil) return;
  const vv = window.visualViewport;
  const h = Math.round((vv && vv.height) || window.innerHeight);
  const offTop = Math.round((vv && vv.offsetTop) || 0);
  let kbh;
  if (nativeKbh !== null) {
    // Authoritative: the platform's own ime() inset. No hysteresis — it does not flap, and
    // filtering it would only add lag to an already-correct number.
    kbh = nativeKbh;
  } else {
    kbh = Math.max(0, Math.round(window.innerHeight - h - offTop));
    // Hysteresis: which threshold applies depends on the state we are already in.
    const wasOpen = kbhLast > 0;
    if (wasOpen ? kbh < KB_CLOSE_PX : kbh < KB_OPEN_PX) kbh = 0;
  }
  const vvot = kbh > 0 ? offTop : 0;
  const root = document.documentElement;
  if (h !== vvhLast)      { vvhLast = h;      root.style.setProperty('--vvh', h + 'px'); }
  if (kbh !== kbhLast) {
    const wasClosed = kbhLast <= 0;
    kbhLast = kbh;
    root.style.setProperty('--kbh', kbh + 'px');
    root.classList.toggle('kb-open', kbh > 0);
    // The sheet has just been resized under a field that was already focused. The browser's own
    // "scroll focused element into view" ran against the pre-keyboard layout, so re-run it now
    // that the sheet knows its real height — this is what stops a tapped field from sitting
    // half-under the keyboard on the first tap and only correcting on the second.
    if (kbh > 0 && wasClosed) scheduleFocusScroll(0);
  }
  if (vvot !== vvotLast)  { vvotLast = vvot;  root.style.setProperty('--vvot', vvot + 'px'); }
}

// ══ ONE SCROLL, NOT TWO ══
// There used to be two independent "bring the focused field into view" paths: a 300ms setTimeout
// hung off `focusin` using block:'nearest', and an rAF off the kb-open transition using
// block:'center'. Both fire for a single tap on a field, both animate smoothly, and they disagree
// about where the field should end up — so the sheet scrolls to one position and is immediately
// dragged to another. That is the second half of the jump on keyboard open, and it is also what
// slid the (previously non-sticky) sheet header up out of the modal.
// One scheduler, one alignment, one timer that later calls cancel — and it refuses to run against
// a sheet that has since been closed, which is what used to scroll an invisible modal.
let focusScrollTimer = null;
function cancelFocusScroll(){ if (focusScrollTimer){ clearTimeout(focusScrollTimer); focusScrollTimer = null; } }

function scheduleFocusScroll(delay){
  cancelFocusScroll();
  focusScrollTimer = setTimeout(() => {
    focusScrollTimer = null;
    scrollFocusedIntoView();
  }, delay || 0);
}

function scrollFocusedIntoView(){
  const el = document.activeElement;
  if (!el || !el.matches || !el.matches('input, textarea, select')) return;
  // A field inside a sheet that is no longer showing must not be scrolled to: the sheet is
  // mid-exit, and scrolling it repaints a container that is supposed to be leaving.
  const overlay = el.closest && el.closest('.modal-overlay');
  if (overlay && !overlay.classList.contains('show')) return;
  try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch(e) { el.scrollIntoView(false); }
  if (typeof refreshOpenSheetScrollFlags === 'function') refreshOpenSheetScrollFlags();
}

// ══ EXPLICIT KEYBOARD DISMISSAL ══
// The web has no Keyboard.dismiss(); blurring the focused control is the equivalent, and nothing
// in this app was doing it. Every close*() function went straight to classList.remove('show'),
// leaving the input focused — so the keyboard collapsed on its own schedule, overlapping the
// sheet's 0.22s exit. dismissKeyboard() blurs, then freezes the viewport geometry for the length
// of the collapse so the exit animation runs against a stable layout.
function dismissKeyboard(freezeMs){
  cancelFocusScroll();
  const el = document.activeElement;
  if (el && el.blur && el.matches && el.matches('input, textarea, select')) {
    try { el.blur(); } catch(e) {}
  }
  if (document.documentElement.classList.contains('kb-open')) freezeKeyboardGeometry(freezeMs || 280);
}
window.dismissKeyboard = dismissKeyboard;


// ══ DISMISSAL ON CLOSE — CENTRALLY, NOT PER SHEET ══
// focusWhenSettled() above solved the OPEN half of this properly. The close half was never
// finished: of twenty-three close*() functions in the app, exactly one (closePlotVault) called
// dismissKeyboard(). Every other sheet went straight to classList.remove('show') with its input
// still focused.
//
// What that produces is the reported roughness. The blur never happens, so the IME collapses on
// the platform's own ~250ms schedule, which starts at an arbitrary offset into the sheet's 0.22s
// exit. Android streams the shrinking ime() inset the whole way down; --kbh follows it; the
// overlay's padding-bottom and top are bound to --kbh — so the sheet is being re-laid-out on
// every frame of a journey it is simultaneously animating out of. The card appears to shudder,
// or to snap upward just as it leaves.
//
// Fixing it at each call site would work today and rot immediately: the next sheet somebody adds
// is a sheet somebody forgets. So it is done once here, by watching for the class that every
// dismissal ultimately removes. Any sheet, present or future, gets correct behaviour with no
// call-site change and nothing to remember.
//
// MutationObserver rather than wrapping classList: it fires as a microtask, before the browser
// paints the frame in which .show was removed, so the blur still lands ahead of the exit. And it
// cannot be bypassed the way a helper function can.
const KEYBOARD_HOST_SELECTOR = '.modal-overlay, .plotwords-screen, .plot-atlas, .view';

function installKeyboardDismissOnClose(){
  if (!window.MutationObserver) return;
  const obs = new MutationObserver(muts => {
    // Only care when the keyboard is actually up. Checked once for the whole batch rather than
    // per mutation, since a single close can mutate several elements.
    if (!document.documentElement.classList.contains('kb-open')) return;
    for (const m of muts){
      if (m.attributeName !== 'class') continue;
      const el = m.target;
      if (!el.matches || !el.matches(KEYBOARD_HOST_SELECTOR)) continue;
      // Tokenised rather than substring-matched: a class list containing "shown" or "no-show"
      // would satisfy a raw indexOf and make every unrelated class change look like a close.
      const before = (m.oldValue || '').split(' ').filter(Boolean);
      const had = before.indexOf('show') !== -1 || before.indexOf('active') !== -1;
      const has = el.classList.contains('show') || el.classList.contains('active');
      // Closing only. A sheet gaining .show must not blur the field focusWhenSettled just gave it.
      if (!had || has) continue;
      // Nothing to dismiss unless the thing being closed is what held the focus. Blurring on the
      // close of an unrelated container would kill the keyboard under a sheet still using it —
      // which happens for real, since a confirm can be raised over an open form.
      const active = document.activeElement;
      if (!active || !active.matches || !active.matches('input, textarea, select')) continue;
      if (!el.contains(active)) continue;
      dismissKeyboard();
      return;
    }
  });
  obs.observe(document.body, {
    subtree: true, attributes: true,
    attributeFilter: ['class'], attributeOldValue: true
  });
}

// Installed from here rather than from js/22-boot.js. Hanging it off boot made the guarantee
// depend on boot reaching that particular line — the same kind of ordering dependency the
// observer exists to remove. document.body is checked because this file loads in <head> on a
// cold start but is re-entered from the cache on a warm one.
if (document.body) installKeyboardDismissOnClose();
else document.addEventListener('DOMContentLoaded', installKeyboardDismissOnClose, { once: true });


// ══ DEFERRED FOCUS — \"THE KEYBOARD OPENS, THEN INSTANTLY CLOSES AGAIN\" ══
// Every sheet in this app used to focus its first field on a bare timer:
//     setTimeout(() => document.getElementById('gotoCoordInput').focus(), 80);
// with delays of 50/60/80/90ms picked per call site. .modal-box transitions `transform` over
// --sheet-t, which is 0.22s — so ALL of those fire while the sheet is still travelling, and none
// of them are synchronised to anything.
//
// In a browser that is merely untidy. In an Android WebView it is the whole bug:
//   · .modal-box carries will-change:transform, so it is on its own compositing layer and is
//     mid-transform when focus() lands.
//   · focus() makes WebView ask InputMethodManager to show the IME, anchored to the focused
//     node's rect. That rect is a moving target.
//   · The IME's own slide then changes the ime() inset, the overlay's padding-bottom starts
//     easing, and the anchor rect moves AGAIN. WebView responds to the invalidated anchor by
//     calling restartInput and, on most OEM keyboards, hideSoftInput — the keyboard appears for
//     a few frames and collapses. That is the reported symptom exactly.
//
// The fix is to stop guessing. Wait for the actual transitionend on the element that is actually
// moving, let a couple of frames pass so the compositor has settled, and only then focus — so the
// IME is anchored to a rect that is already at rest and never gets invalidated underneath it.
//
// The timeout is a real code path, not paranoia: transitionend does not fire when the sheet is
// already open (re-focusing a field in a visible sheet), under prefers-reduced-motion, or when the
// element was never laid out. TRANSITION_MAX_MS is --sheet-t plus a frame of slack.
const TRANSITION_MAX_MS = 260;

function focusWhenSettled(target, opts){
  const o = opts || {};
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  // The moving element is the sheet card, not the overlay: the overlay only fades its ::before
  // backdrop and eases padding, while .modal-box is what actually translates.
  const box = (el.closest && (el.closest('.modal-box') || el.closest('.sheet'))) || null;
  const overlay = el.closest && el.closest('.modal-overlay');

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (box) box.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    // Two frames, not one. transitionend fires during the frame the transition completes; the
    // compositor has not necessarily handed the layer back and the final rect is not yet stable
    // until the frame after that. Focusing on the first frame reintroduces the moving-anchor race
    // this function exists to remove.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // The sheet may have been dismissed while we waited (fast tap through). Focusing a field in
      // a closed sheet is what used to pop the keyboard back up over the screen behind it.
      if (overlay && !overlay.classList.contains('show')) return;
      if (!el.isConnected) return;
      try {
        el.focus({ preventScroll: true });
        if (o.select && el.select) el.select();
      } catch(e) {
        try { el.focus(); } catch(_) {}
      }
    }));
  };

  const onEnd = (e) => {
    // Only the card's own transform ends this wait. padding/opacity/border-radius on descendants
    // bubble to here too and finish on different clocks.
    if (e.target === box && e.propertyName === 'transform') finish();
  };

  if (box) box.addEventListener('transitionend', onEnd);
  const timer = setTimeout(finish, o.maxWait || TRANSITION_MAX_MS);
}
window.focusWhenSettled = focusWhenSettled;

function setVvh(){
  if (vvhPending) return;
  vvhPending = true;
  requestAnimationFrame(applyVvh);
}

applyVvh();

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setVvh, { passive: true });
  window.visualViewport.addEventListener('scroll', setVvh, { passive: true });
} else {
  window.addEventListener('resize', setVvh, { passive: true });
}

document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('input, textarea, select')) return;
  // Delay lets the on-screen keyboard finish opening first — scrolling immediately on focus means
  // the browser measures "visible area" before the keyboard has actually taken up its space, so
  // the button just past the field can still end up hidden underneath it.
  // Routed through the shared scheduler so that if --kbh lands first (applyVvh calls the same
  // scheduler) only ONE scroll ever runs, and it is the later, better-informed one.
  scheduleFocusScroll(300);
}, true);

// Leaving a field cancels a scroll that has not fired yet. Without this, tapping a field and then
// immediately tapping Done queues a scroll that lands ~300ms later — on a sheet that is already
// closing — and yanks it visibly on the way out.
document.addEventListener('focusout', cancelFocusScroll, true);


// Chrome/Safari change a number input's value when the mouse wheel passes over it *while it's
// focused* — nothing to do with the (now-hidden) stepper arrows, it fires even without them. On
// the Collect page's attribute fields this reads as the page "glitching" mid-scroll: a value
// silently ticks up/down as the wheel scrolls past it. Blurring the field the instant a wheel
// event starts means the scroll just scrolls the page like normal, and the field keeps whatever
// value was last typed.
document.addEventListener('wheel', (e) => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'number') el.blur();
}, { passive: true });


// ══ UNITS (metric / imperial display) ══
// Everything is captured and stored in metric/SI (meters, square meters) — that never changes,
// so exports stay consistent regardless of this setting. This only controls how distances/areas
// are *displayed* on screen (accuracy, altitude, and the auto-computed line/polygon geometry).
const UNITS_KEY = 'plotedge_units';

function currentUnits(){ try{ return localStorage.getItem(UNITS_KEY) || 'metric'; }catch(e){ return 'metric'; } }

function setUnits(next, announce){
  try{ localStorage.setItem(UNITS_KEY, next); }catch(e){}
  document.querySelectorAll('.units-toggle').forEach(btn=>{ btn.textContent = next==='metric' ? 'm' : 'ft'; });
  if (announce) showToast(next==='metric' ? 'Units: metric (m)' : 'Units: imperial (ft)');
  // Refresh anything currently on screen that shows a length/area/altitude so the change is
  // immediately visible without needing a new GPS fix or re-opening the feature.
  if (typeof renderVertexEditor==='function') renderVertexEditor();
  if (typeof renderPoints==='function') renderPoints();
  if (typeof renderFeatures==='function') renderFeatures();
  syncSettingsModalUI();
}

// toggleUnits() removed — superseded by setUnits() called with an explicit value from Settings.
// Settings-modal entry point — sets an explicit value rather than toggling, since the modal shows
// both options at once (a segmented control) rather than one button that flips state on tap.
function setUnitsPref(mode){ setUnits(mode, true); }

function formatLength(m){
  if (m==null || isNaN(m)) return '—';
  return currentUnits()==='metric' ? `${m.toFixed(m<10?2:1)} m` : `${(m*3.28084).toFixed((m*3.28084)<10?2:1)} ft`;
}

function formatArea(sqm){
  if (sqm==null || isNaN(sqm)) return '—';
  if (currentUnits()==='metric') return sqm>=10000 ? `${(sqm/10000).toFixed(2)} ha` : `${sqm.toFixed(1)} m²`;
  const sqft = sqm*10.7639;
  return sqft>=43560 ? `${(sqft/43560).toFixed(2)} ac` : `${sqft.toFixed(0)} ft²`;
}

document.querySelectorAll('.units-toggle').forEach(btn=>{ btn.textContent = currentUnits()==='metric' ? 'm' : 'ft'; });


// ══ OUTDOOR / HIGH-CONTRAST MODE ══ — independent of light/dark theme, see CSS for what it
// overrides. Deliberately NOT persisted and deliberately NOT in the Settings modal, unlike
// Theme/Units/Density/Map style/Export format/snapping above, which all do carry across sessions.
// Outdoor mode is a situational squint-in-bright-sun toggle, not a standing preference — a crew
// that flips it on for a midday walk shouldn't come back the next morning indoors to a UI that's
// still in high-contrast mode for no visible reason. It stays a one-tap header/control-pill icon
// (see contrastToggleLanding/Pm/App) rather than a modal row, since it's the one control here
// that genuinely needs to be reachable in a single glance-and-tap rather than two taps into
// Settings — every session simply starts with it off.
function applyContrast(on){
  document.documentElement.toggleAttribute('data-contrast', on);
  if (on) document.documentElement.setAttribute('data-contrast','high');
  document.querySelectorAll('.contrast-toggle').forEach(btn=>btn.classList.toggle('active', on));
}

function toggleContrast(){
  const on = document.documentElement.getAttribute('data-contrast') !== 'high';
  applyContrast(on);
}

// ══ DENSITY (compact / comfortable) ══ — independent of theme/contrast. Compact trims the
// padding on tiles, dashboard action rows, and cards so more of the project fits on screen at
// once — useful once a project has a lot of feature types or a long Recent Activity list.
const DENSITY_KEY = 'plotedge_density';

function applyDensity(compact){
  document.documentElement.toggleAttribute('data-density', compact);
  if (compact) document.documentElement.setAttribute('data-density','compact');
}

// toggleDensity() removed for the same reason as toggleTheme() — setDensityPref() below is the
// only entry point, and it takes an explicit mode from the Settings segmented control.
function setDensityPref(mode){
  applyDensity(mode==='compact');
  showToast(mode==='compact' ? 'Compact view' : 'Comfortable view');
  syncSettingsModalUI();
}

(function(){
  let stored = null;
  try { stored = localStorage.getItem(DENSITY_KEY); } catch(e) {}
  if (stored === '1') applyDensity(true);
})();

// No restore-from-storage step for Contrast — every session starts with outdoor mode off, by
// design (see the comment above applyContrast/toggleContrast).

// ══ SETTINGS MODAL ══ — consolidates the existing units/density icon toggles above with two
// preferences that didn't have a home before: a default map style (previously only changeable
// from inside the Review tab's own basemap button, with no way to set it ahead of time) and a
// default export format (previously the Export tab always opened on GeoJSON regardless of what
// was used last time).
// Settings gets its own ambience band, and restores whatever the screen underneath was using on
// close — otherwise closing the sheet on the Map tab would leave the mesh switched back on over
// the satellite tiles.
let _screenBeforeSettings = null;

function openSettings(){
  syncSettingsModalUI();
  _screenBeforeSettings = currentScreenState();
  setScreenState('settings');
  document.getElementById('settingsModal').classList.add('show');
}

function closeSettings(){
  document.getElementById('settingsModal').classList.remove('show');
  if (_screenBeforeSettings) { setScreenState(_screenBeforeSettings); _screenBeforeSettings = null; }
}

// Paints every control in the modal from current state — called on open, and after any change
// made elsewhere (the quick icon toggles) so the modal never shows a stale selection if it was
// left open in another tab/window, or opened again later in the same session.
function syncSettingsModalUI(){
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  syncDomainPickerUI();
  const mode = currentThemeMode();
  const ta = document.getElementById('settingsThemeAuto'), tl = document.getElementById('settingsThemeLight'), td = document.getElementById('settingsThemeDark');
  if (ta && tl && td) { ta.classList.toggle('active', mode==='auto'); tl.classList.toggle('active', mode==='light'); td.classList.toggle('active', mode==='dark'); }
  const units = currentUnits();
  const um = document.getElementById('settingsUnitsMetric'), ui = document.getElementById('settingsUnitsImperial');
  if (um && ui) { um.classList.toggle('active', units==='metric'); ui.classList.toggle('active', units==='imperial'); }
  const basemap = defaultBasemapPref();
  document.querySelectorAll('#settingsBasemapGrid .atlas-bm-opt').forEach(b=>{
    b.classList.toggle('on', b.getAttribute('data-bm') === basemap);
  });
  const compact = document.documentElement.getAttribute('data-density')==='compact';
  const dc = document.getElementById('settingsDensityComfortable'), dk = document.getElementById('settingsDensityCompact');
  if (dc && dk) { dc.classList.toggle('active', !compact); dk.classList.toggle('active', compact); }
  const wd = document.getElementById('widgetDynamicToggle');
  if (wd && typeof widgetFollowsHomeScreen === 'function') wd.checked = widgetFollowsHomeScreen();
  const sel = document.getElementById('settingsExportFormat');
  if (sel){
    // Rebuilt on open rather than only at boot: cheap, and it means the picker is correct even if
    // the modal's markup was rendered before js/17-export.js had defined the registry.
    if (!sel.options.length && typeof buildExportFormatSelects === 'function') buildExportFormatSelects();
    sel.value = defaultExportFormat();
  }
  const snapToggle = document.getElementById('settingsSnapToggle');
  if (snapToggle) snapToggle.checked = snapPref();
  // Reflect the stored PlotLens preference whenever Settings opens, and keep the Review entry
  // point in step with it — the toggle and the button it governs must never disagree.
  syncPlotLensEntry();
}

// ── PlotEtch snapping ── on by default: a crew digitizing adjacent parcels almost always wants
// shared edges to actually coincide, and the failure mode of snapping-off (slivers between
// polygons that only show up in QGIS later) is far more expensive than the failure mode of
// snapping-on (a vertex lands 2m from where you tapped, immediately visible and undoable).
const SNAP_KEY = 'plotedge_snap';

function snapPref(){ try{ return localStorage.getItem(SNAP_KEY) !== '0'; }catch(e){ return true; } }

function setSnapPref(on){ try{ localStorage.setItem(SNAP_KEY, on ? '1' : '0'); }catch(e){} showToast(on ? 'Snapping on' : 'Snapping off'); }

// ── Default map style ── shares the exact localStorage key (plotedge_basemap) and in-memory
// currentBasemap variable the Review tab's own toggleBasemap() already uses (see ensureReviewMap
// further down), so setting it here and switching it from inside Review always agree with each
// other rather than tracking two separate "which basemap" preferences.
function defaultBasemapPref(){ try{ return localStorage.getItem('plotedge_basemap') || 'street'; }catch(e){ return 'street'; } }

// ══ ONE BASEMAP, EVERY MAP ══
// This used to be a two-option Settings control that only the Review map read,
// while PlotAtlas kept its own separate key and the PlotLens minimap picked
// street-or-satellite on its own. Three maps could show three different
// basemaps, and the screen labelled "Settings" governed one of them.
//
// Now it is the single writer. ATLAS_BASEMAPS (js/14a-plotatlas.js) is the
// registry of what a basemap IS; this decides which one is current and tells
// every live map to catch up. Reaching a later file is safe here because this
// only ever runs from a tap, long after every script has loaded.
function setBasemapPref(key){
  const known = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  if (known && !known[key]) return;
  try { localStorage.setItem('plotedge_basemap', key); } catch(e) {}
  if (typeof currentBasemap !== 'undefined') currentBasemap = key;
  // Each of these is a no-op unless that map currently exists.
  try { if (typeof applyReviewBasemap === 'function') applyReviewBasemap(); } catch(e) {}
  try { if (typeof atlasSyncBasemapFromPref === 'function') atlasSyncBasemapFromPref(); } catch(e) {}
  try { if (typeof plSyncMiniMapBasemap === 'function') plSyncMiniMapBasemap(); } catch(e) {}
  try { if (typeof renderStoryMap === 'function' && document.getElementById('plMap')) { destroyPlMap(); renderStoryMap(); } } catch(e) {}
  const label = (known && known[key] && known[key].label) || key;
  showToast('Map style: ' + label);
  syncSettingsModalUI();
}


// ── Default export format ── the Export tab's format <select> now opens on whatever was set
// here (see the page-init hook near updateExportFormatUI() at the bottom of the file) instead of
// always resetting to GeoJSON.
const EXPORT_FORMAT_DEFAULT_KEY = 'plotedge_export_format_default';

function defaultExportFormat(){ try{ return localStorage.getItem(EXPORT_FORMAT_DEFAULT_KEY) || 'geojson'; }catch(e){ return 'geojson'; } }

function setExportFormatDefault(fmt){
  try { localStorage.setItem(EXPORT_FORMAT_DEFAULT_KEY, fmt); } catch(e) {}
  const sel = document.getElementById('exportFormatSelect');
  if (sel) { sel.value = fmt; if (typeof updateExportFormatUI==='function') updateExportFormatUI(); }
  const ssel = document.getElementById('settingsExportFormat');
  if (ssel) ssel.value = fmt;
  showToast('Default export format saved');
}
