// ══ PLOTALERT ══
// System notifications for the small number of things worth interrupting somebody for.
//
// ══ THE BAR FOR SHIPPING A NOTIFICATION ══
// A field app that pings is a field app that gets its notifications switched off, and once they
// are off the ONE that mattered never arrives either. So the test every event here has to pass is
// deliberately hostile: would a crew member, reading this on a lock screen in the rain, do
// something differently because of it? Four events pass. Everything considered and rejected is
// listed at the bottom of this file with the reason, so it does not get re-proposed.
//
// The events, and what each one is actually protecting against:
//
//  · CAPTURE STILL OPEN — the app was backgrounded with live vertices or a paused capture on the
//    stack. This is the one the whole file exists for. An unfinished capture is invisible once the
//    app is off screen, and the way it gets lost is the crew walking to the next site believing
//    the last feature was saved. The notification is the only thing standing between that and a
//    re-walk.
//  · UNEXPORTED WORK — the app was backgrounded with saved features that have never left the
//    device. Same class of failure, longer fuse: it is fine for an hour and expensive if the phone
//    is wiped or replaced before anybody notices.
//  · STORAGE CRITICAL — at/over 90% the next photo write is the one that fails, and a failed photo
//    write during a survey is unrecoverable data. Worth an interrupt because the fix (export and
//    clear) has to happen BEFORE the capture, not after.
//  · EXPORT FINISHED — fires only for exports that ran long enough that somebody put the phone
//    down. A large PlotPack can take a while; without this the user either stares at the screen or
//    walks away and does not learn it finished.
//
// ══ WHY THERE IS NO NOTIFICATION PLUGIN IN package.json ══
// @capacitor/local-notifications would be the obvious dependency, and it was not added, because
// the app already has a native bridge that costs nothing to extend: MainActivity carries a
// JavascriptInterface (see scripts/patch-android-ui.py) which is how the theme already reaches the
// status bar. One more method on it posts a real system notification through NotificationManager,
// with a channel, in about forty lines of Java that the build already patches in.
//
// That avoids a new Gradle dependency, a new permission-request code path, and a plugin whose
// version has to track Capacitor's across upgrades — for a feature that needs exactly one call.
//
// THREE DELIVERY PATHS, tried in order, so the same call site works everywhere the app runs:
//   1. PlotEdgeNative.notify()               — the Android shell. A real system notification.
//   2. registration.showNotification()       — installed PWA. Survives the tab being backgrounded.
//   3. new Notification()                    — desktop browser. Same thing, no service worker.
// If none is available (permission denied, or a browser with no Notification API) the call is a
// silent no-op. Nothing in the app branches on whether a notification was delivered.

const PLOTALERT_KEY = 'plotedge_alerts';
const PLOTALERT_CHANNEL = 'plotedge-major';

// ══ EVENT CATALOGUE ══
// `cooldown` is the minimum gap between two notifications of the SAME event, in minutes. These are
// long on purpose. The unexported-work reminder in particular describes a condition that persists
// for as long as the user chooses not to export, so a short cooldown would turn a useful warning
// into a nag that trains people to swipe it away without reading.
const PLOTALERT_EVENTS = {
  captureOpen:  { cooldown: 30,  title: 'Capture still open' },
  unexported:   { cooldown: 720, title: 'Work not exported yet' },
  storageFull:  { cooldown: 180, title: 'Device storage nearly full' },
  exportDone:   { cooldown: 0,   title: 'Export finished' }
};

// ── Preference ──
// Default ON. The events are rare enough and consequential enough that a crew who never opens
// Settings should still be told their capture is open — this is the opposite of the default a
// marketing notification should get, and for the opposite reason.
function plotalertEnabled(){
  try { return localStorage.getItem(PLOTALERT_KEY) !== '0'; } catch(e) { return true; }
}

function setPlotalertEnabled(on){
  try { localStorage.setItem(PLOTALERT_KEY, on ? '1' : '0'); } catch(e) {}
  if (on) plotalertRequestPermission();
  if (typeof showToast === 'function') showToast(on ? 'Major alerts on' : 'Major alerts off');
}

// ── Native bridge ──
// Named separately from the Capacitor check because the bridge is injected by our own build patch,
// not by Capacitor: on a web build the object simply is not there.
function plotalertNativeBridge(){
  const b = window.PlotEdgeNative;
  return (b && typeof b.notify === 'function') ? b : null;
}

// ══ PERMISSION ══
// Asked for lazily rather than at launch. A permission prompt on first open, before the user has
// created a project, is the prompt everybody denies — and on Android a denial is sticky. Asking at
// the first moment the app actually has something to say means the request arrives with its reason
// visible behind it.
// Android 13+ needs POST_NOTIFICATIONS granted; MainActivity requests it (see
// scripts/patch-android-ui.py), so the native path only has to check that the bridge is present.
function plotalertRequestPermission(){
  if (plotalertNativeBridge()) return Promise.resolve(true);
  if (typeof Notification === 'undefined') return Promise.resolve(false);
  if (Notification.permission === 'granted') return Promise.resolve(true);
  if (Notification.permission === 'denied') return Promise.resolve(false);
  try { return Notification.requestPermission().then(p => p === 'granted'); }
  catch(e) { return Promise.resolve(false); }
}

// ══ THROTTLE ══
// Kept in localStorage rather than in a module variable so the cooldown survives the WebView being
// reclaimed — which is precisely the situation the captureOpen alert fires in. An in-memory
// timestamp would reset on every relaunch and let the same warning fire repeatedly.
function plotalertLastFired(key){
  try { return Number(localStorage.getItem(`plotedge_alert_${key}`) || 0); } catch(e) { return 0; }
}
function plotalertStampFired(key){
  try { localStorage.setItem(`plotedge_alert_${key}`, String(Date.now())); } catch(e) {}
}
function plotalertInCooldown(key){
  const ev = PLOTALERT_EVENTS[key];
  if (!ev || !ev.cooldown) return false;
  return (Date.now() - plotalertLastFired(key)) < ev.cooldown * 60000;
}

// ══ THE GATE ══
// Every caller goes through here. Returns whether the alert was RAISED — preference on, cooldown
// clear — which is the app's own decision and the thing worth asserting on. Whether the OS then
// draws it depends on a permission the user controls and on which APIs the platform exposes;
// plotalertDeliver() below owns that half and its success is deliberately not folded into this
// return value. A browser with no Notification API is not a reason for the policy layer to start
// reporting that nothing was wrong.
function plotalertRaise(key, body, opts){
  const ev = PLOTALERT_EVENTS[key];
  if (!ev) return false;
  if (!plotalertEnabled()) return false;
  if (!(opts && opts.force) && plotalertInCooldown(key)) return false;

  plotalertStampFired(key);
  plotalertDeliver((opts && opts.title) || ev.title, body, key);
  return true;
}

// ══ DELIVERY ══
// Three paths, tried in order, so the same call site works everywhere the app runs. Returns
// whether one of them accepted the notification; nothing in the app branches on it, and a total
// failure here is a silent no-op by design — an alert that cannot be shown must not become an
// error the user has to deal with instead.
function plotalertDeliver(title, body, tag){
  // 1 · Native shell.
  const bridge = plotalertNativeBridge();
  if (bridge){
    try { bridge.notify(title, body, PLOTALERT_CHANNEL, tag); return true; } catch(e) {}
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const payload = { body, tag, icon: 'resources/icon-192x192-any.png', badge: 'resources/favicon-128.png' };

  // 2 · Installed PWA. Preferred over `new Notification()` because a service worker notification is
  //     still delivered when the page is not in the foreground, which is exactly when these fire.
  if (navigator.serviceWorker && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready
      .then(reg => reg.showNotification(title, payload))
      .catch(() => { try { new Notification(title, payload); } catch(e) {} });   // 3 · plain fallback
    return true;
  }
  try { new Notification(title, payload); return true; } catch(e) {}
  return false;
}

// ══ POLICY, SEPARATE FROM DELIVERY ══
// This decides WHAT should be reported. It touches nothing platform-specific and sends nothing,
// which matters for two reasons: the rule about which condition outranks which is the part worth
// getting right and worth testing, and it must not be entangled with whether a given browser
// happens to expose the Notification API.
//
// Returns { key, body } for the single most serious condition found, or null when there is
// nothing worth saying. ONE result, never a list — three notifications arriving together is three
// swipes and no signal about which one mattered.
function plotalertPending(){
  // 1 · An unfinished capture. Counts the live vertex list and anything parked on the capture
  //     stack (js/06a-capture-stack.js) — a suspended feature is just as unsaved as a live one.
  const live = (typeof currentVertices !== 'undefined' && currentVertices) ? currentVertices.length : 0;
  const parked = (typeof suspendedCaptures !== 'undefined' && suspendedCaptures) ? suspendedCaptures.length : 0;
  if (live || parked){
    const bits = [];
    if (live) bits.push(`${live} vertex${live === 1 ? '' : 'es'} not saved`);
    if (parked) bits.push(`${parked} capture${parked === 1 ? '' : 's'} paused`);
    return { key:'captureOpen', body:`${bits.join(' · ')}. PlotEdge is still holding it. Reopen to finish or save.` };
  }

  // 2 · Storage. Outranks the export reminder because a device at 90% will fail the NEXT capture,
  //     so the fix has to happen before more work, not after it.
  try {
    const info = (typeof getStorageUsageInfo === 'function') ? getStorageUsageInfo() : null;
    if (info && info.percent >= 90){
      return { key:'storageFull', body:`${info.percent}% of this device is used. Export and clear before capturing more; photo writes fail first.` };
    }
  } catch(e) {}

  // 3 · Unexported work, across every project rather than just the open one: the project that gets
  //     forgotten is usually not the one currently in front of you.
  try {
    if (typeof projects !== 'undefined' && typeof getProjectStats === 'function'){
      const n = projects.reduce((acc, pr) => {
        const st = getProjectStats(pr, { skipBytes: true });
        return acc + ((st.features && !st.synced) ? 1 : 0);
      }, 0);
      if (n){
        return { key:'unexported', body:`${n} project${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} data that has never been exported off this device.` };
      }
    }
  } catch(e) {}
  return null;
}

// ══ THE BACKGROUND SWEEP ══
// Runs when the app leaves the foreground, which is the only moment these conditions are worth
// reporting: while the app is open the user can see the capture strip, the export badge and the
// storage row for themselves, and a notification would be telling them something already on
// screen.
//
// Returns whether an alert was RAISED — i.e. whether it passed the preference and the cooldown —
// not whether the operating system ultimately drew it. Those are different questions and only the
// first one is this app's decision to make.
function plotalertOnBackground(){
  if (!plotalertEnabled()) return false;
  const pending = plotalertPending();
  if (!pending) return false;
  return plotalertRaise(pending.key, pending.body);
}

// Called by the export pipeline. `seconds` is how long the export took: a fast export finished
// while the user was watching and needs no notification, and firing one anyway is how a useful
// channel becomes a noisy one. force:true because an export completing is a discrete event the
// user caused — there is nothing to throttle.
function plotalertExportFinished(label, seconds){
  if (!(seconds >= 8)) return false;
  if (document.visibilityState === 'visible') return false;
  return plotalertRaise('exportDone', `${label} is ready.`, { force: true });
}

// ══ WIRING ══
// Two listeners, because the two shells report backgrounding differently and neither covers the
// other: Capacitor's appStateChange is the reliable one in the APK, and visibilitychange is the
// only one a browser or installed PWA gets.
function plotalertInit(){
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') plotalertOnBackground();
  });
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener){
    CapApp.addListener('appStateChange', st => { if (st && st.isActive === false) plotalertOnBackground(); });
  }
}

// ══ CONSIDERED AND REJECTED ══
// Recorded so these do not get proposed again as "while we're here" additions:
//  · GPS FIX LOST / ACCURACY DEGRADED — fires constantly under tree cover and in a valley, which
//    is normal surveying, not an incident. The accuracy KPI card already shows it live, on the
//    screen the person is looking at while capturing.
//  · FEATURE SAVED / PHOTO ATTACHED — confirmation of a thing the user just did, with the result
//    visible on screen. This is what toasts are for.
//  · SYNC / UPLOAD AVAILABLE — the app is offline-first by design. Being offline is the expected
//    state, so announcing the network came back is announcing nothing.
//  · DAILY "don't forget to export" — a scheduled nag rather than a response to a condition. The
//    unexported alert already covers the real case, and only when there is genuinely something to
//    lose.
