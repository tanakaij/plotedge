// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — GPS, external NMEA receiver, compass, step nav, capture
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ GPS ══
// Wake Lock keeps the screen (and therefore GPS tracking) alive while actively capturing —
// otherwise the OS can dim/lock the screen mid-walk (e.g. tracing a long fence line) and
// interrupt watchPosition. Not supported everywhere, so every call is wrapped defensively —
// GPS capture works exactly the same with or without it, this is purely a battery/screen nicety.
let wakeLock = null;

async function requestWakeLock(){
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', ()=>{ wakeLock = null; });
    }
  } catch(e) { /* not supported / denied — GPS still works fine without it */ }
}

function releaseWakeLock(){
  if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
}

// The wake lock is auto-released by the OS whenever the tab is hidden (e.g. switching apps to
// check something), so it needs to be re-acquired on return if GPS is still meant to be active.
document.addEventListener('visibilitychange', ()=>{
  if (document.visibilityState === 'visible' && gpsActive && !wakeLock) requestWakeLock();
});

// ══ EXTERNAL GPS — Bluetooth NMEA receiver ══
// Targets the Nordic UART Service (UUID 6e400001-...), the de facto standard BLE-serial bridge
// used by most consumer/survey-grade GNSS receivers that expose NMEA over Bluetooth LE (many
// u-blox-based boards, DIY RTK bridges, etc). Emlid Reach units primarily talk over their own
// Wi-Fi/TCP stream rather than BLE NMEA, and Trimble/other survey brands often use vendor-specific
// GATT services this won't recognise — device support genuinely varies and can't be verified
// without the physical hardware, so this covers the common case rather than every receiver brand.
// Once connected, parsed fixes are fed straight into onPos() — the exact same function the phone's
// own GPS uses — so capture, hold-to-average, and the accuracy-based capture warnings all keep
// working completely unchanged regardless of which GPS source is live.
const NMEA_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

const NMEA_UART_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notifications *from* the receiver

let extGpsDevice = null, extGpsChar = null, extGpsActive = false, extGpsLineBuffer = '';


function nmeaToDecimal(raw, hemi){
  if (!raw) return null;
  const val = parseFloat(raw);
  if (isNaN(val)) return null;
  const deg = Math.floor(val / 100);
  const min = val - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') dec = -dec;
  return dec;
}

// Rough accuracy-in-metres estimate from NMEA GGA's fix-quality + HDOP fields. These constants are
// approximations (real accuracy depends on the specific receiver/antenna) — good enough to drive
// the same "good/fair/weak fix" UI and capture-warning thresholds the internal GPS uses, not
// intended as a survey-grade error budget.
function nmeaAccuracyEstimate(fixQuality, hdop){
  const h = hdop || 1;
  switch (fixQuality) {
    case 4: return Math.max(0.01, h * 0.02);   // RTK fixed
    case 5: return Math.max(0.1,  h * 0.3);    // RTK float
    case 2: return h * 2.0;                     // DGPS
    case 1: return h * 4.0;                     // plain GPS
    default: return null;                       // 0 = invalid fix
  }
}

function parseGGA(fields){
  // $--GGA,time,lat,N,lon,E,fixQuality,numSats,HDOP,alt,M,geoidSep,M,dgpsAge,dgpsId*checksum
  const lat = nmeaToDecimal(fields[2], fields[3]);
  const lon = nmeaToDecimal(fields[4], fields[5]);
  const fixQuality = parseInt(fields[6], 10) || 0;
  const numSats = parseInt(fields[7], 10);
  const hdop = parseFloat(fields[8]);
  const alt = parseFloat(fields[9]);
  if (lat == null || lon == null || fixQuality === 0) return null;
  const accuracy = nmeaAccuracyEstimate(fixQuality, hdop);
  if (accuracy == null) return null;
  return { lat, lon, alt: isNaN(alt) ? null : alt, accuracy, fixQuality, hdop: isNaN(hdop) ? null : hdop, numSats: isNaN(numSats) ? null : numSats };
}

const NMEA_FIX_LABELS = {1:'GPS',2:'DGPS',4:'RTK Fixed',5:'RTK Float'};

// Last external-GPS fix diagnostics (fix type, HDOP, satellite count), kept around so the
// dashboard GPS Accuracy card can show them when expanded without re-parsing NMEA itself.
let lastExtFix = null;

function handleNmeaLine(line){
  line = line.trim();

  // ══ EVERY sentence goes to PlotFix first ══
  // js/17d-plotfix.js parses GGA, GST, GSA, GSV and RMC, and — unlike the GGA-only path below —
  // VERIFIES THE NMEA CHECKSUM before believing anything. That matters more than it sounds: this
  // function used to split on '*' and throw the checksum away, so a sentence corrupted over a
  // flaky Bluetooth link would parse into a plausible-looking wrong position and be captured as
  // real. Feeding PlotFix everything also picks up GST, which is the only sentence carrying
  // MEASURED position error rather than HDOP (a geometry multiplier, not a distance), plus the
  // DOP and satellites-in-view figures the GGA-only path never saw.
  //
  // Both run for now rather than the old path being deleted: onPos() and the whole capture,
  // averaging and warning stack are driven from the shape below, and swapping their input is a
  // separate change from starting to parse properly. PlotFix is the source of truth for quality
  // and provenance; this remains the source of position.
  if (typeof plotfixIngest === 'function') plotfixIngest(line);
  // The gate has to re-evaluate on every sentence, not only on device-provider updates: an RTK
  // link dropping to float is exactly the moment capture should stop, and no geolocation event
  // accompanies it.
  applyFixGateToCaptureButton();

  if (!line.startsWith('$') || !/GGA/.test(line.slice(0,6))) return; // only GGA carries fix quality + HDOP
  // Refuse a sentence whose checksum does not verify. Previously absent, which meant a mangled
  // latitude reached onPos() and could be captured as a vertex.
  if (typeof plotfixChecksumOk === 'function' && !plotfixChecksumOk(line)) return;
  const body = line.split('*')[0];
  const fields = body.split(',');
  const fix = parseGGA(fields);
  const statusEl = document.getElementById('extGpsStatus');
  if (!fix) {
    if (statusEl) { statusEl.className = 'ext-gps-status fix-none'; statusEl.textContent = 'No fix'; statusEl.style.display = 'inline-block'; }
    return;
  }
  lastExtFix = { fixQuality: fix.fixQuality, hdop: fix.hdop, numSats: fix.numSats, accuracy: fix.accuracy, time: Date.now() };
  if (statusEl) {
    const label = NMEA_FIX_LABELS[fix.fixQuality] || 'Fix';
    statusEl.className = 'ext-gps-status' + (fix.fixQuality>=4?' fix-rtk':fix.fixQuality===2?' fix-dgps':'');
    // plotfixAccuracy() prefers GST's measured standard deviation over HDOP × a nominal UERE, and
    // says which it used. A figure the receiver measured and one this app estimated should never
    // be shown in the same format — the old pill presented both as "±N m".
    const pf = (typeof plotfixAccuracy === 'function') ? plotfixAccuracy() : null;
    statusEl.textContent = (pf && pf.m != null)
      ? `${label} · HDOP ${fix.hdop!=null?fix.hdop.toFixed(1):'—'} · ${pf.label}`
      : `${label} · HDOP ${fix.hdop!=null?fix.hdop.toFixed(1):'—'} · ±${fix.accuracy.toFixed(2)}m`;
    statusEl.style.display = 'inline-block';
  }
  // Same shape as a browser GeolocationPosition, so onPos()/currentPos/capture logic need no
  // external-GPS-specific branching anywhere else in the app.
  onPos({ coords: { latitude:fix.lat, longitude:fix.lon, altitude:fix.alt, accuracy:fix.accuracy }, timestamp: Date.now() });
  document.getElementById('captureBtn').disabled = false;
}

function onNmeaData(event){
  const chunk = new TextDecoder().decode(event.target.value);
  extGpsLineBuffer += chunk;
  const lines = extGpsLineBuffer.split(/\r?\n/);
  extGpsLineBuffer = lines.pop(); // last element may be a partial line — keep it for next chunk
  lines.forEach(handleNmeaLine);
}

async function toggleExternalGps(){
  if (extGpsActive) { disconnectExternalGps('Disconnected'); return; }
  if (!navigator.bluetooth) {
    showToast(/iphone|ipad|ipod/i.test(navigator.userAgent) ? 'Bluetooth GPS needs Chrome on Android/desktop. Not supported in iOS browsers.' : 'Web Bluetooth isn\'t available in this browser');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NMEA_UART_SERVICE] }],
    });
    extGpsDevice = device;
    device.addEventListener('gattserverdisconnected', () => disconnectExternalGps('External GPS disconnected'));
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NMEA_UART_SERVICE);
    extGpsChar = await service.getCharacteristic(NMEA_UART_TX_CHAR);
    await extGpsChar.startNotifications();
    extGpsChar.addEventListener('characteristicvaluechanged', onNmeaData);
    extGpsActive = true;
    extGpsLineBuffer = '';
    // External receiver is now the source of truth for position — stop the phone's own GPS watch
    // so the two don't race and overwrite each other's fixes in currentPos.
    if (gpsActive) stopGPS();
    const btn = document.getElementById('extGpsBtn');
    btn.classList.add('connected');
    document.getElementById('extGpsBtnLabel').textContent = device.name ? `Disconnect ${device.name}` : 'Disconnect external GPS';
    setGPSUI('acquiring', 'External GPS connected. Waiting for fix…', '');
    requestWakeLock();
    startCompassWatch();
  } catch(e) {
    if (e.name !== 'NotFoundError') showToast('Couldn\'t connect to external GPS'); // NotFoundError = user cancelled the picker
  }
}

function disconnectExternalGps(statusText){
  extGpsActive = false;
  lastExtFix = null;
  if (extGpsChar) { try { extGpsChar.removeEventListener('characteristicvaluechanged', onNmeaData); } catch(e) {} }
  if (extGpsDevice && extGpsDevice.gatt && extGpsDevice.gatt.connected) { try { extGpsDevice.gatt.disconnect(); } catch(e) {} }
  extGpsDevice = null; extGpsChar = null;
  const btn = document.getElementById('extGpsBtn');
  if (btn) btn.classList.remove('connected');
  const label = document.getElementById('extGpsBtnLabel');
  if (label) label.textContent = 'Connect external GPS';
  const statusEl = document.getElementById('extGpsStatus');
  if (statusEl) statusEl.style.display = 'none';
  if (statusText) setGPSUI('', statusText, '—');
  maybeStopCompassWatch();
}


// ══ COMPASS HEADING (for photo metadata) ══
// Tracks device compass heading continuously while GPS is active (either source) so the value is
// already fresh the instant a photo is taken — sampling on-demand at capture time would mean
// waiting for the first orientation event, which can take a beat. iOS Safari requires an explicit
// permission prompt from a user gesture (13+); Android doesn't. `deviceorientationabsolute` (true
// north, when the browser supports it) is preferred over plain `deviceorientation`, which on
// Android is only relative to wherever the device was pointed when the page loaded unless the
// event itself reports `absolute:true`.
let lastCompassHeading = null;

let compassListenerType = null; // which event name we ended up attached to, so stopCompassWatch removes the right one

function onDeviceOrientation(e){
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading; // iOS Safari: already true-north
  else if (e.absolute && e.alpha != null) heading = 360 - e.alpha;
  else if (e.alpha != null && compassListenerType === 'deviceorientationabsolute') heading = 360 - e.alpha;
  if (heading == null || isNaN(heading)) return;
  lastCompassHeading = ((heading % 360) + 360) % 360;
}

async function startCompassWatch(){
  if (compassListenerType) return; // already watching
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } catch(e) { return; }
  }
  const type = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  compassListenerType = type;
  window.addEventListener(type, onDeviceOrientation);
}

function stopCompassWatch(){
  if (!compassListenerType) return;
  window.removeEventListener(compassListenerType, onDeviceOrientation);
  compassListenerType = null;
  lastCompassHeading = null;
}

function maybeStopCompassWatch(){
  if (!gpsActive && !extGpsActive) stopCompassWatch();
}

const COMPASS_DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function headingLabel(deg){
  if (deg == null) return '';
  const idx = Math.round(deg / 22.5) % 16;
  return `${COMPASS_DIRS[idx]} ${Math.round(deg)}°`;
}


function toggleGPS() { gpsActive ? stopGPS() : startGPS(); }

// Generic collapse toggle for Collect-tab card sections (Feature Type, Attributes) — purely a
// display:none on the card-body; nothing is unmounted or cleared, so validation/save logic
// downstream reads the same field values regardless of collapsed state. aria-expanded is kept in
// sync for screen readers since this behaves like a disclosure widget.
function setCardCollapsed(titleEl, collapsed){
  const body = titleEl && titleEl.nextElementSibling;
  if (!body || !body.classList.contains('card-body')) return;
  body.classList.toggle('collapsed', collapsed);
  titleEl.classList.toggle('is-collapsed', collapsed);
  titleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  titleEl.closest('.card')?.classList.toggle('step-collapsed', collapsed);
}

// ══ COLLECT ACCORDION ══
// Every step card used to be expanded at once, which made the Collect tab roughly four screens of
// continuous scroll before the crew had entered anything — the "modals didn't help" complaint is
// really this: sheets shortened individual *sections* but nothing shortened the page.
// One step open at a time is the standard shape for a mobile GIS capture form (Survey123's page
// mode, Fulcrum's sections, QField's grouped form): the open step fills the screen, the closed
// ones collapse to a labelled row carrying their own Pending/Active/Completed badge, so the whole
// workflow stays visible as a list while only the step being worked on takes up space.
// Scoped to #panel-collect only — collapsible cards elsewhere in the app keep independent state.
function collapseSiblingCollectCards(exceptTitleEl){
  const panel = document.getElementById('panel-collect');
  if (!panel || !panel.contains(exceptTitleEl)) return;
  panel.querySelectorAll('.card-title.collapsible-title').forEach(t => {
    if (t !== exceptTitleEl) setCardCollapsed(t, true);
  });
}

function toggleCardCollapse(titleEl){
  const body = titleEl && titleEl.nextElementSibling;
  if (!body || !body.classList.contains('card-body')) return;
  const willCollapse = !body.classList.contains('collapsed');
  if (!willCollapse) collapseSiblingCollectCards(titleEl);
  setCardCollapsed(titleEl, willCollapse);
  // Collapsing the cards above the one just opened removes height from *above* the scroll
  // position, so without this the page appears to jump somewhere unrelated. Re-anchoring on the
  // header that was tapped is what makes the accordion feel like turning a page.
  if (!willCollapse) requestAnimationFrame(() => scrollCollectTitleIntoView(titleEl));
}

function scrollCollectTitleIntoView(titleEl){
  const card = titleEl.closest('.card');
  if (!card) return;
  const headerH = document.querySelector('#view-app header')?.offsetHeight || 60;
  const scrollRoot = document.getElementById('scrollRoot');
  const y = card.getBoundingClientRect().top + scrollRoot.scrollTop - headerH - 10;
  scrollRoot.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

// Opens one step by card id and closes the rest. Used on tab entry and by the auto-advance below.
function openCollectStep(cardId, scroll){
  const title = document.querySelector('#' + cardId + ' > .card-title.collapsible-title');
  if (!title) return;
  collapseSiblingCollectCards(title);
  setCardCollapsed(title, false);
  if (scroll) requestAnimationFrame(() => scrollCollectTitleIntoView(title));
}

// Resets the accordion to the earliest step that still needs input whenever Collect is opened, so
// arriving on the tab always lands on something actionable rather than wherever it was left.
function resetCollectAccordion(){
  const order = ['collectCardType','collectCardGps','collectCardAttrs'];
  const next = order.find(id => !isCollectStepDone(id)) || 'collectCardGps';
  openCollectStep(next, false);
}


// ══ COLLECT STEP NAV ══ — keeps the sticky "1 Type · 2 GPS · 3 Attributes · 4 Vertex · 5 Save"
// jump bar's --header-h in sync with the real header height (so it sits flush under it rather
// than at a guessed offset), tapping a pill auto-expands that section if it's collapsed then
// smooth-scrolls to it, and a scroll-spy keeps the active pill in sync with whatever section is
// actually in view as the crew scrolls the form by hand.
(function initCollectStepNav(){
  // The ResizeObserver that used to keep a --header-h custom property in sync lived here purely
  // to position the sticky horizontal step bar under the header. That bar is gone, nothing reads
  // --header-h any more, and an observer firing on every header resize for a variable no rule
  // consumes is pure overhead — so it has been removed with the bar.
  const targets = ['collectCardType','collectCardGps','collectCardAttrs','vertexEditorCard','collectCardSave'];
  if (!('IntersectionObserver' in window)) return;
  const spy = new IntersectionObserver((entries) => {
    // Pick whichever observed section has the topmost visible edge closest to the nav bar —
    // more reliable than "first intersecting entry" when several short sections are on screen
    // at once (common once a few cards are collapsed).
    let best = null, bestTop = Infinity;
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const top = Math.abs(en.boundingClientRect.top);
      if (top < bestTop) { bestTop = top; best = en.target.id; }
    });
    if (best) updateCollectStepNavActive(best);
  }, { root: null, rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.1, 0.5, 1] });
  targets.forEach(id => { const el = document.getElementById(id); if (el) spy.observe(el); });
})();

// jumpToCollectStep() lived here: the tap handler for the horizontal step bar. The bar was
// removed (see the comment in initCollectStepNav above) and nothing has called this since.
// The scroll-spy that still drives the step badges is untouched.
// ══ STEP STATUS ══
// The horizontal pill bar used to own "which step am I on". That state now lives on the step
// cards themselves. Two inputs drive each badge:
//   - "active": which card the scroll spy currently reports as in view (transient, view-only).
//   - "done":   whether that step's data has actually been filled in (real form state).
// "done" always wins over "active" so a completed step doesn't lose its green tick just because
// the crew scrolled back up to re-read it.
const COLLECT_STEP_CARDS = {
  collectCardType:  'stepBadge1',
  collectCardGps:   'stepBadge2',
  collectCardAttrs: 'stepBadge3',
  vertexEditorCard: 'stepBadge4',
  collectCardSave:  'stepBadge5'
};

let activeCollectStepId = null;

function updateCollectStepNavActive(id){
  activeCollectStepId = id;
  updateCollectStepStatus();
}

// Completion tests are deliberately conservative — a step only reads as Done when there is
// unambiguous evidence the crew supplied something. Attributes are optional on many feature
// types, so that step counts as done once any attribute field is non-empty.
function isCollectStepDone(cardId){
  switch (cardId) {
    case 'collectCardType':
      return !!(document.getElementById('featureName')?.value || '').trim();
    case 'collectCardGps':
      return Array.isArray(currentVertices) && currentVertices.length > 0;
    case 'collectCardAttrs':
      // Was a raw scan of #attrFields input/select/textarea. That misses the two field types
      // rendered as divs — multi_select (.chip-opt) and boolean (.bool-toggle[data-val]) — so a
      // feature type built only from those left step 3 reading "Pending" no matter how much the
      // crew filled in. attrValuePreview() is the same reader the summary rows use, so "shows a
      // value" and "counts as done" can no longer disagree. Falls back to the old DOM scan for
      // ad hoc attributes, which aren't part of the schema and so aren't in attrSheetFields.
      if (Array.isArray(attrSheetFields) && attrSheetFields.some(a => attrValuePreview(a) !== '')) return true;
      return Array.from(document.querySelectorAll('#attrFields input, #attrFields select, #attrFields textarea, #customAttrsList input'))
        .some(el => el.type === 'checkbox' ? el.checked : String(el.value || '').trim() !== '');
    case 'vertexEditorCard':
      return false; // transient editor — never "done", only active while open
    case 'collectCardSave':
      return false; // the terminal action; completion is leaving this screen
    default:
      return false;
  }
}

function updateCollectStepStatus(){
  Object.entries(COLLECT_STEP_CARDS).forEach(([cardId, badgeId]) => {
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    let state = 'pending';
    if (isCollectStepDone(cardId))        state = 'done';
    else if (activeCollectStepId === cardId) state = 'active';
    badge.dataset.state = state;
    badge.textContent = state === 'done' ? 'Completed' : state === 'active' ? 'Active' : 'Pending';
  });
}

// Recompute whenever the crew types or picks anything inside the Collect panel. 'input' and
// 'change' both bubble, so one delegated listener per panel covers every current and future
// field without needing to re-bind after the attribute fields are re-rendered.
(function bindCollectStepStatus(){
  const panel = document.getElementById('panel-collect');
  if (!panel) return;
  ['input', 'change'].forEach(evt => panel.addEventListener(evt, () => updateCollectStepStatus(), { passive: true }));
  // #attrSheet is a top-level overlay, so it sits OUTSIDE #panel-collect and nothing typed into
  // it reaches the listener above any more. Binding it too keeps the step badge and the summary
  // rows live while the sheet is open, instead of only catching up when it closes.
  const sheet = document.getElementById('attrSheet');
  // 'click' as well as input/change: multi_select chips and the boolean toggle are plain divs
  // whose handlers just flip a class, so they emit neither of the form events.
  if (sheet) ['input','change','click'].forEach(evt => sheet.addEventListener(evt, () => {
    updateCollectStepStatus();
    if (typeof renderAttrSummary === 'function') renderAttrSummary();
  }, { passive: true }));
})();

// Mirrors #vertexEditorCard's own show/hide (see renderVertexEditor) so the "4 · Vertex" step
// only reads as active while a vertex is actually open for editing.
function syncCollectVertexPill(visible){
  const badge = document.getElementById('stepBadge4');
  if (badge) badge.dataset.state = visible ? 'active' : 'pending';
  updateCollectStepStatus();
}

function toggleGpsDetail() {
  const row = document.getElementById('gpsDetailRow');
  const btn = document.getElementById('gpsDetailToggle');
  const open = row.style.display === 'none';
  row.style.display = open ? '' : 'none';
  btn.classList.toggle('open', open);
  document.getElementById('gpsDetailToggleLabel').textContent = open ? 'Hide altitude & accuracy detail' : 'Show altitude & accuracy detail';
}

function startGPS() {
  if (extGpsActive) { showToast('External GPS is connected. Disconnect it first to use the internal GPS.'); return; }
  if (!navigator.geolocation) { showToast('GPS not available'); return; }
  setGPSUI('acquiring','Acquiring signal…','');
  const btn = document.getElementById('gpsBtn');
  btn.textContent='Stop GPS'; btn.classList.add('active');
  gpsActive=true;
  weakFixStreak=0; updateIndoorGpsBanner();
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy:true, maximumAge:0, timeout:15000 });
  requestWakeLock();
  startCompassWatch();
}

function stopGPS() {
  if (watchId!==null) navigator.geolocation.clearWatch(watchId);
  gpsActive=false; currentPos=null;
  const btn=document.getElementById('gpsBtn');
  btn.textContent='Start GPS'; btn.classList.remove('active');
  document.getElementById('captureBtn').disabled=true;
  setGPSUI('','GPS stopped','—');
  ['latVal','lonVal','altVal','accVal'].forEach(id=>document.getElementById(id).textContent='—');
  releaseWakeLock();
  maybeStopCompassWatch();
  weakFixStreak=0; updateIndoorGpsBanner();
}

// Indoors, GPS accuracy usually never settles below ~30m (walls/roof block enough satellites
// that it plateaus rather than improving with more time) — so rather than a fixed wait, this
// counts consecutive weak fixes and offers a manual-coordinates fallback once it looks stuck.
const INDOOR_WEAK_STREAK_THRESHOLD = 6;

const INDOOR_WEAK_ACCURACY_M = 30;

let weakFixStreak = 0;

// Enables or disables Capture against the project's fix standard, and explains itself on the
// button's own title/aria-label so "why can't I capture" is answered where it is asked.
// A project with no standard set (the default) always passes, so nothing changes for anyone who
// has not opted in.
function applyFixGateToCaptureButton(){
  const btn = document.getElementById('captureBtn');
  if (!btn) return;
  const gate = (typeof plotfixCheckGate === 'function') ? plotfixCheckGate() : { ok:true };
  btn.disabled = !gate.ok;
  btn.title = gate.reason || '';
  if (gate.reason) btn.setAttribute('aria-label', gate.reason);
  else btn.removeAttribute('aria-label');
  const note = document.getElementById('fixGateNote');
  if (note){
    note.textContent = gate.reason || '';
    note.style.display = gate.reason ? '' : 'none';
  }
  const line = document.getElementById('plotfixStatus');
  if (line && typeof plotfixStatusLine === 'function'){
    // The fix quality read-out: type, satellites, and an accuracy figure that says whether it was
    // measured by the receiver or estimated from HDOP. Previously computed and never shown.
    line.textContent = plotfixStatusLine();
  }
}

function onPos(pos) {
  // The device provider has no fix metadata, so PlotFix records it as source:'system' with the
  // quality fields explicitly null rather than stale. This is also the path that carries a
  // receiver feeding Android's mock location provider — genuinely better coordinates with no
  // metadata, which the gate has to be able to tell apart from a real NMEA link.
  if (typeof plotfixFromGeolocation === 'function' && !extGpsActive) plotfixFromGeolocation(pos);
  currentPos=pos;
  const {latitude:lat,longitude:lon,altitude:alt,accuracy:acc}=pos.coords;
  document.getElementById('latVal').textContent=lat.toFixed(7);
  document.getElementById('lonVal').textContent=lon.toFixed(7);
  document.getElementById('altVal').textContent=alt!==null?alt.toFixed(1):'N/A';
  document.getElementById('accVal').textContent=acc.toFixed(1);
  // Projected read-out (js/16b-plotgrid.js). crsFormat() returns lat/lon unchanged when the
  // project is on WGS84, which is why the row is hidden in that case rather than duplicating the
  // two boxes above it.
  const gridRow = document.getElementById('gridCoordRow');
  if (gridRow && typeof crsProject === 'function'){
    const projected = crsProject(lat, lon, alt);
    const showing = projected.units !== 'degrees';
    gridRow.style.display = showing ? '' : 'none';
    if (showing){
      document.getElementById('gridCoordLabel').textContent = projected.label;
      document.getElementById('gridCoordVal').textContent = crsFormat(lat, lon);
    }
  }
  // Project accuracy standard. Refusing at the button, with the reason on the button itself,
  // rather than at save time — telling a surveyor their fix was inadequate AFTER they walked the
  // boundary is not a warning, it is a report of wasted work.
  applyFixGateToCaptureButton();
  let state,label,cls;
  if(acc<=5){state='good';label='Good fix';cls='acc-good';}
  else if(acc<=15){state='poor';label='Fair fix';cls='acc-ok';}
  else{state='poor';label='Weak, wait for better signal';cls='acc-poor';}
  document.getElementById('gpsAcc').innerHTML=`Accuracy: <span class="${cls}">±${acc.toFixed(1)} m</span>`;
  setGPSUI(state,label,null);
  if (acc>INDOOR_WEAK_ACCURACY_M) weakFixStreak++; else weakFixStreak=0;
  updateIndoorGpsBanner();
}

function updateIndoorGpsBanner(){
  const banner = document.getElementById('indoorGpsBanner');
  if (!banner) return;
  banner.style.display = weakFixStreak>=INDOOR_WEAK_STREAK_THRESHOLD ? 'flex' : 'none';
}

function onErr(err) {
  // The old copy for code 1 said "Enable in Chrome settings" unconditionally — correct advice in
  // a real browser tab, but meaningless inside the installed APK: there's no Chrome UI there at
  // all, just this app's own WebView, and location is granted/denied at the Android app level
  // instead (Settings → Apps → PlotEdge → Permissions → Location).
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const msgs={
    1: isNative
      ? 'Location permission denied. Enable it in Android Settings → Apps → PlotEdge → Permissions → Location'
      : 'Permission denied. Enable location for this site in Chrome settings',
    2:'Position unavailable. Go outside',
    3:'Timeout, retrying…'
  };
  setGPSUI('error',msgs[err.code]||'GPS error','');
  document.getElementById('captureBtn').disabled=true;
  // A timeout (code 3) is itself a strong indoor/no-signal signal — count it the same as a weak
  // fix rather than only counting fixes that actually arrived.
  if (err.code===3){ weakFixStreak++; updateIndoorGpsBanner(); }
}

function setGPSUI(state,text,acc) {
  const ring=document.getElementById('gpsRing');
  ring.className='gps-ring'+(state?' '+state:'');
  const collectPanel=document.getElementById('panel-collect');
  if (collectPanel) collectPanel.dataset.gps = state || '';
  // Mirrored onto <html> as well: the fix-quality wash is painted by the shared .mesh-bg layer
  // now that the panels themselves are transparent, and that layer can only see attributes on
  // the root. The panel attribute is kept so nothing else that reads it has to change.
  if (state) document.documentElement.setAttribute('data-gps', state);
  else document.documentElement.removeAttribute('data-gps');
  // Read live theme colors from CSS vars (rather than hardcoding hex) so this stays correct
  // whichever theme — light or dark — is currently active.
  const col=state==='good'?cssVar('--success'):state==='error'?cssVar('--danger'):state==='acquiring'?cssVar('--orange'):cssVar('--muted2');
  document.getElementById('gpsIcon').setAttribute('stroke',col);
  document.getElementById('gpsStatus').textContent=text;
  if(acc!==null) document.getElementById('gpsAcc').textContent=acc;
}


// ══ CAPTURE ══
// Every tap logs a new vertex (works the same for point/line/polygon — a "point" feature is simply
// allowed to log more than one vertex, e.g. re-shooting the same spot from a different angle).
// The newly captured vertex becomes the "open" one, shown in the Vertex Details card below for
// per-vertex attrs/photos, until the user captures again or taps another vertex to edit it.
//
// Three ways a tap/hold on the Capture button turns into a vertex:
//  1. Quick tap with a good fix (<=15m)      -> captures immediately.
//  2. Quick tap with a weak fix (>15m)       -> captures immediately anyway (never blocks on a
//                                                confirm tap), then offers a few seconds to Undo —
//                                                same soft-delete-first pattern as deletePoint, so
//                                                a capture never takes longer than the person's
//                                                own reaction time.
//  3. Press and hold (~400ms+)               -> samples the live position every ~350ms while
//                                                held, then captures the *average* of those
//                                                samples on release — cuts down single-fix GPS
//                                                noise, useful under tree cover etc. Capped at 3s
//                                                of sampling so even a "just hold it" capture
//                                                stays well inside a 5-second point.
let lastCaptureAt = 0;

const CAPTURE_DEBOUNCE_MS = 500;      // ignore a second tap this soon after the last capture

const CAPTURE_ACCURACY_WARN_M = 15;   // fixes worse than this are captured anyway, then offered as an Undo

const HOLD_THRESHOLD_MS = 400;        // how long a press must last before it's treated as "hold to average"

const HOLD_SAMPLE_MS = 350;           // how often a new sample is taken while holding

const HOLD_MAX_MS = 3000;             // auto-finish averaging after this long — plenty of samples, keeps the whole point under 5s

let holdTimer = null, holdSampleInterval = null, holdActive = false, holdSamples = [], holdStartedAt = 0;


function rippleOn(btn){
  const r=document.createElement('span'); r.className='ripple';
  const rect=btn.getBoundingClientRect(), sz=Math.max(rect.width,rect.height);
  r.style.cssText=`width:${sz}px;height:${sz}px;left:${(rect.width-sz)/2}px;top:${(rect.height-sz)/2}px`;
  btn.appendChild(r); setTimeout(()=>r.remove(),600);
}

// ══ MICRO-INTERACTIONS: universal tap ripple ══
// rippleOn() used to be wired into the Capture button by hand as a one-off. This delegated
// listener fires it on any tap that lands inside one of the app's standard interactive classes
// (see the matching CSS block in the "PREMIUM POLISH LAYER"), so buttons/rows/tabs added later
// get the same tactile feedback automatically — no per-element plumbing needed. Runs on
// pointerdown (not click) so the ripple starts the instant a finger/cursor lands, same timing the
// Capture button's own ripple already used.
const RIPPLE_HOSTS = '.btn, .btn-pill, .dash-action, .ft-row, .project-row, .icon-back, .contrast-toggle, .ext-gps-btn, .gps-detail-toggle, .vertex-map-toggle, .pt-edit, .pt-del, .pt-move, .nav-btn';

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest(RIPPLE_HOSTS);
  if (!el || el.disabled || el.classList.contains('btn-capture')) return; // btn-capture keeps its own hold-to-average ripple timing in commitVertex/rippleOn calls above
  rippleOn(el);
}, { passive:true });

function hapticTap(){ try{ if (navigator.vibrate) navigator.vibrate(35); }catch(e){} }


// Shared by both the plain-tap and hold-to-average paths — everything downstream of "we have
// the coords we're going to save" lives here so the two capture modes stay in sync.
function commitVertex(lat, lon, alt, acc, weak, manual){
  // ══ OUTLIER CHECK ══
  // A mis-typed coordinate, or a fix that latched onto a cached position from the previous job,
  // saves silently and is found weeks later in somebody else's QGIS. If the project has an area
  // set, this asks the question now — as a confirm, never a refusal, because a survey legitimately
  // reaches outside its own boundary for a control point and a hard block would get switched off.
  // Re-entered via the callback rather than returning, so the confirm is asynchronous without the
  // rest of this function having to know that. `__outlierOk` guards the second pass.
  if (!commitVertex.__outlierOk && typeof confirmIfOutlier === 'function'){
    const d = (typeof outsideProjectBounds === 'function') ? outsideProjectBounds(lat, lon) : null;
    if (d != null){
      confirmIfOutlier(lat, lon, () => {
        commitVertex.__outlierOk = true;
        try { commitVertex(lat, lon, alt, acc, weak, manual); }
        finally { commitVertex.__outlierOk = false; }
      });
      return;
    }
  }
  // 'gps_fix' covers both the normal and hold-to-average paths (acc is always a real GPS accuracy
  // there); 'manual' covers both the typed-coordinates modal and a tap on the satellite/plan map —
  // those are told apart by which environment the crew is in, since PlotIn's tap map and PlotOut's
  // digitizing-correction tap map are the same code path (see ensureVertexMap in js/09-geometry.js)
  // but mean different things: correcting an outdoor point vs. placing an indoor one from scratch.
  const captureMethod = !manual ? 'gps_fix' : (currentEnvironment === 'PlotIn' ? 'satellite_footprint_tap' : 'manual_tap');
  // ══ FIX PROVENANCE ══
  // Recorded at capture because it is not reconstructible afterwards. A survey where you cannot
  // later tell which marks were RTK-fixed and which were autonomous is a survey you cannot
  // defend — and that distinction is the difference between a boundary corner and an estimate.
  // Carries fix type, satellites used and in view, DOP, the measured standard deviations where
  // the receiver sent GST, correction age and base station id. Spread into `fix` rather than onto
  // the vertex root so it cannot collide with an existing key and so exports can decide whether
  // to flatten it.
  const fix = (typeof plotfixVertexMeta === 'function') ? plotfixVertexMeta() : null;
  const vertex = {lat,lon,alt,acc,time:new Date().toISOString(), attrs:{}, photos:[], manual:!!manual, capture_method:captureMethod, fix};
  // If a reference raster is loaded (see sampleRasterAt above), pull the pixel value under this
  // vertex and stash it as a plain attribute — e.g. an elevation DEM auto-fills a height value
  // instead of relying on GPS altitude, which is usually the least accurate part of a fix.
  if (typeof rasterGeoraster !== 'undefined' && rasterGeoraster){
    const sample = sampleRasterAt(lat, lon);
    if (sample !== null && sample !== undefined) vertex.attrs.raster_sample = sample;
  }
  // Not a bare push any more. While EDITING a line, a point captured back at the
  // start end has to go to the start — appending it produces a line that runs to
  // the far end and then jumps all the way back, and lineLengthM() counts that
  // jump. See placeCapturedVertex() in js/09-geometry.js.
  openVertexIndex = placeCapturedVertex(vertex);
  persist(); renderPoints(); renderVertexEditor();
  const sel=document.getElementById('featureTypeSelect');
  const ft=sel && !sel.disabled ? getFeatureType(sel.value) : null;
  if (ft) updateGeometryUI(ft);
  hapticTap();
  rippleOn(document.getElementById('captureBtn'));
  lastCaptureAt = Date.now();
  if (manual) {
    showToast(`Vertex ${currentVertices.length} added manually (no GPS accuracy)`);
  } else if (weak) {
    // Capture first, ask never — a blocking "capture anyway?" confirm is the one thing that could
    // push a point past the 5-second budget if someone hesitates on it. Undo (same mechanics as
    // deletePoint) gives the same second chance without ever pausing the capture itself.
    showUndoToast(`Weak fix (±${acc.toFixed(1)} m) — vertex ${currentVertices.length} captured`, ()=>{
      const i = currentVertices.indexOf(vertex);
      if (i===-1) return;
      currentVertices.splice(i,1);
      if (openVertexIndex===i) openVertexIndex = currentVertices.length ? Math.max(0,i-1) : null;
      else if (openVertexIndex!==null && openVertexIndex>i) openVertexIndex--;
      persist({ destructive: true }); renderPoints(); renderVertexEditor();
      if (ft) updateGeometryUI(ft);
      showToast('Vertex removed');
    });
  } else {
    showToast(`Vertex ${currentVertices.length} (±${acc.toFixed(1)} m)`);
  }
}
