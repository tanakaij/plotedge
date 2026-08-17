
// PlotEdge — PlotFix: GNSS quality, NMEA ingest and capture gating
//
// ══ WHAT THIS FILE CAN AND CANNOT DO, STATED FIRST ══
// Until now every position came from navigator.geolocation, which hands back one number for
// accuracy and nothing else. No fix type, no satellite count, no DOP, no way to tell an RTK fixed
// solution from a smoothed autonomous one. That is the difference between locating an asset and
// establishing a boundary, and it is the app's largest single limitation.
//
// This file closes the part of that gap which is closable in JavaScript, and is explicit about the
// part that is not:
//
//   1. NMEA PARSING — done here, fully. GGA, GST, GSA, GSV and RMC, giving fix quality, satellites
//      used and in view, HDOP/VDOP/PDOP, age of correction, base station id, and — from GST — the
//      actual per-axis standard deviations, which is the only honest accuracy figure a receiver
//      emits. This is pure computation and is unit-tested.
//
//   2. CAPTURE GATING — done here. A project can require a minimum fix type and a maximum
//      horizontal deviation, and the Capture button refuses below it. This is what stops a crew
//      from unknowingly recording a boundary corner on an autonomous 4 m fix.
//
//   3. THE TRANSPORT — NOT done here, and cannot be. Survey receivers emit NMEA over Bluetooth
//      Classic SPP (RFCOMM). Web Bluetooth is BLE GATT only and cannot open an SPP socket; this is
//      a deliberate limitation of the web platform, not an oversight we can code around. Reaching a
//      receiver needs native Android code behind a Capacitor plugin.
//
// So `plotfixIngest(line)` is the seam. Anything that can produce NMEA lines drives the whole
// stack. Three feeders are wired below, in descending order of what they give you:
//
//   (a) NATIVE PLUGIN (best, not yet written). If a Capacitor plugin named 'PlotFixSerial' is
//       present and exposes an 'nmea' listener, it is used. The interface it must satisfy is
//       documented at plotfixAttachNative() so the Java side can be written against a fixed
//       contract rather than being designed twice.
//
//   (b) MOCK LOCATION PROVIDER (works today, no code needed). On Android, apps like Bluetooth GNSS
//       feed a paired receiver's position into the system location provider. navigator.geolocation
//       then returns the RECEIVER's position — genuinely better coordinates, immediately, with no
//       plugin. What it does not carry is the metadata, so PlotFix marks these fixes
//       `source:'system'` and the quality fields read unknown rather than being fabricated.
//
//   (c) MANUAL NMEA PASTE (diagnostics). A text field that accepts pasted NMEA, so a receiver's
//       output can be verified against this parser before anyone trusts a build in the field.

// ══ FIX TYPES ══
// The GGA quality digit. Ordered by trustworthiness, because the gate compares them.
const PLOTFIX_QUALITY = {
  0: { key: 'invalid',   rank: 0, label: 'No fix',            short: 'NO FIX' },
  1: { key: 'gps',       rank: 1, label: 'Autonomous GNSS',   short: 'GNSS' },
  2: { key: 'dgps',      rank: 2, label: 'Differential GNSS', short: 'DGNSS' },
  3: { key: 'pps',       rank: 2, label: 'PPS',               short: 'PPS' },
  4: { key: 'rtk_fix',   rank: 5, label: 'RTK fixed',         short: 'RTK FIX' },
  5: { key: 'rtk_float', rank: 4, label: 'RTK float',         short: 'RTK FLT' },
  6: { key: 'estimated', rank: 0, label: 'Dead reckoning',    short: 'DR' },
  7: { key: 'manual',    rank: 0, label: 'Manual input',      short: 'MANUAL' },
  8: { key: 'simulated', rank: 0, label: 'Simulated',         short: 'SIM' }
};

// A fix from the system provider has no quality digit. It gets its own pseudo-entry rather than
// being mapped onto 'gps' — claiming autonomous GNSS for a position that might have come from an
// RTK receiver via the mock provider would understate it, and claiming better would be a lie.
const PLOTFIX_SYSTEM_QUALITY = { key: 'system', rank: 1, label: 'Device location', short: 'DEVICE' };

// ══ CURRENT STATE ══
// One object, replaced wholesale on each update so a reader can never see a half-applied fix.
let plotfixState = {
  source: 'none',        // 'none' | 'system' | 'nmea'
  at: null,              // ms epoch of last update
  lat: null, lon: null,
  altEllipsoid: null,    // metres above the ellipsoid, as the receiver reports it
  geoidSep: null,        // GGA field 11 — the receiver's own geoid separation, when it sends one
  quality: PLOTFIX_QUALITY[0],
  satsUsed: null, satsInView: null,
  hdop: null, vdop: null, pdop: null,
  sdHoriz: null,         // metres, from GST — the honest horizontal figure when available
  sdVert: null,
  correctionAge: null,   // seconds since last RTK correction
  baseId: null,
  raw: {}                // last seen sentence of each type, for the diagnostics panel
};

// GSV arrives as several sentences per cycle; the count is only meaningful once assembled.
let _plotfixGsv = { total: 0, seen: 0, inView: null };


// ══ NMEA ══
// Checksum verified before anything is believed. A corrupted sentence over a flaky Bluetooth link
// is common, and a mangled latitude that parses is far worse than one that is discarded.
function plotfixChecksumOk(line){
  const star = line.lastIndexOf('*');
  if (star === -1 || star < 1) return false;                 // no checksum — refuse it
  const body = line.slice(line.charAt(0) === '$' ? 1 : 0, star);
  const want = parseInt(line.slice(star + 1, star + 3), 16);
  if (!Number.isFinite(want)) return false;
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum === want;
}

// NMEA latitude/longitude is ddmm.mmmm — degrees and DECIMAL MINUTES concatenated, not decimal
// degrees. Reading it as decimal degrees is the classic NMEA bug and puts a position tens of
// kilometres out while still looking like a plausible coordinate.
function plotfixDegMin(v, hemi){
  if (!v) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  const deg = Math.floor(Math.abs(n) / 100);
  const min = Math.abs(n) - deg * 100;
  let out = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') out = -out;
  return out;
}

const _num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// The single entry point. Feed it one sentence; it updates plotfixState and returns the talker
// type it recognized, or null. Tolerates leading/trailing whitespace and both $ and ! prefixes.
function plotfixIngest(line){
  if (typeof line !== 'string') return null;
  line = line.trim();
  if (!line || !plotfixChecksumOk(line)) return null;
  const body = line.slice(line.charAt(0) === '$' || line.charAt(0) === '!' ? 1 : 0, line.lastIndexOf('*'));
  const f = body.split(',');
  // Any talker id: GP (GPS), GL (GLONASS), GA (Galileo), GB (BeiDou), GN (combined), and the
  // proprietary prefixes some receivers use. Matching on the last three characters keeps this
  // working with constellations that did not exist when the sentence formats were written.
  const type = f[0].slice(-3);
  const next = { ...plotfixState, source: 'nmea', at: Date.now(), raw: { ...plotfixState.raw, [type]: line } };

  if (type === 'GGA'){
    const q = parseInt(f[6], 10);
    next.lat = plotfixDegMin(f[2], f[3]);
    next.lon = plotfixDegMin(f[4], f[5]);
    next.quality = PLOTFIX_QUALITY[Number.isFinite(q) ? q : 0] || PLOTFIX_QUALITY[0];
    next.satsUsed = _num(f[7]);
    next.hdop = _num(f[8]);
    next.altEllipsoid = _num(f[9]);   // NB: GGA field 9 is orthometric (MSL) per the spec…
    next.geoidSep = _num(f[11]);      // …and field 11 is the separation, so ellipsoidal = 9 + 11.
    // Reconciled explicitly rather than assumed, because receivers disagree about this field and
    // getting it wrong is a whole-geoid-separation error in height — tens of metres.
    if (next.altEllipsoid != null && next.geoidSep != null) next.altEllipsoid = next.altEllipsoid + next.geoidSep;
    next.correctionAge = _num(f[13]);
    next.baseId = f[14] || null;
  } else if (type === 'GST'){
    // The only sentence that reports actual position error rather than a dilution factor. HDOP is
    // a geometry multiplier, not a distance; quoting it as accuracy is a category error, so where
    // GST exists it wins.
    const latSd = _num(f[6]), lonSd = _num(f[7]);
    next.sdHoriz = (latSd != null && lonSd != null) ? Math.sqrt(latSd * latSd + lonSd * lonSd) : null;
    next.sdVert = _num(f[8]);
  } else if (type === 'GSA'){
    next.pdop = _num(f[15]);
    next.hdop = _num(f[16]) != null ? _num(f[16]) : next.hdop;
    next.vdop = _num(f[17]);
  } else if (type === 'GSV'){
    // Multi-sentence: field 1 is the total, field 2 the index, field 3 the count in view. The
    // count is only trustworthy once the last sentence of the cycle has arrived.
    const total = parseInt(f[1], 10), idx = parseInt(f[2], 10), inView = _num(f[3]);
    if (idx === 1) _plotfixGsv = { total, seen: 1, inView };
    else _plotfixGsv.seen++;
    if (_plotfixGsv.seen >= _plotfixGsv.total) next.satsInView = _plotfixGsv.inView;
  } else if (type === 'RMC'){
    if (next.lat == null) next.lat = plotfixDegMin(f[3], f[4]);
    if (next.lon == null) next.lon = plotfixDegMin(f[5], f[6]);
  } else {
    return null;
  }

  plotfixState = next;
  if (typeof plotfixOnUpdate === 'function') plotfixOnUpdate(plotfixState);
  return type;
}


// ══ THE ACCURACY THAT SHOULD BE BELIEVED ══
// In descending order of honesty: GST standard deviation, then HDOP scaled by a nominal UERE,
// then whatever the browser said. Which one was used is returned alongside the number, because a
// figure derived from HDOP and one measured by the receiver should not be presented identically.
const PLOTFIX_NOMINAL_UERE = 2.5; // metres; a conventional single-frequency figure

function plotfixAccuracy(){
  const s = plotfixState;
  if (s.sdHoriz != null) return { m: s.sdHoriz, basis: 'measured', label: '±' + s.sdHoriz.toFixed(2) + ' m (GST)' };
  if (s.hdop != null) {
    const m = s.hdop * PLOTFIX_NOMINAL_UERE;
    return { m, basis: 'estimated', label: '≈±' + m.toFixed(1) + ' m (HDOP ' + s.hdop.toFixed(1) + ')' };
  }
  if (s.source === 'system' && s.sdHoriz == null && typeof lastKnownAccuracy === 'function'){
    const a = lastKnownAccuracy();
    if (a != null) return { m: a, basis: 'device', label: '±' + a.toFixed(1) + ' m (device)' };
  }
  return { m: null, basis: 'unknown', label: 'accuracy unknown' };
}


// ══ CAPTURE GATE ══
// Per project, because the same crew's asset inventory and boundary survey have different
// standards and a single global threshold would be set to whichever is looser.
function plotfixGate(){
  const p = (typeof projects !== 'undefined') ? projects.find(x => x.id === activeProjectId) : null;
  const g = (p && p.fixGate) || {};
  return {
    on: !!g.on,
    minQuality: g.minQuality || 'gps',   // a PLOTFIX_QUALITY key
    maxHoriz: Number.isFinite(Number(g.maxHoriz)) ? Number(g.maxHoriz) : 5
  };
}

function setPlotfixGate(patch){
  const p = projects.find(x => x.id === activeProjectId);
  if (!p) { showToast('Open a project first'); return; }
  p.fixGate = { ...plotfixGate(), ...patch };
  persist();
  if (typeof plotfixSyncUI === 'function') plotfixSyncUI();
}

// Returns {ok, reason}. The reason is written to be readable on a capture button's disabled
// tooltip, because "why can't I capture" answered anywhere other than at the button is answered
// too late.
function plotfixCheckGate(){
  const gate = plotfixGate();
  if (!gate.on) return { ok: true, reason: null };

  const wantRank = (Object.values(PLOTFIX_QUALITY).find(q => q.key === gate.minQuality) || PLOTFIX_QUALITY[1]).rank;
  const have = plotfixState.source === 'system' ? PLOTFIX_SYSTEM_QUALITY : plotfixState.quality;

  // A gate demanding better than autonomous, with only the system provider available, cannot be
  // satisfied OR honestly evaluated — the provider might be fed by an RTK receiver and we would
  // never know. Refusing is the safe answer, and the message says what to do about it.
  if (plotfixState.source === 'system' && wantRank > 1){
    return { ok: false, reason: 'This project requires ' + gate.minQuality.toUpperCase() +
      ', but the device location provider does not report fix type. Connect a receiver that sends NMEA.' };
  }
  if (have.rank < wantRank){
    return { ok: false, reason: 'Fix is ' + have.label + '; this project requires ' + gate.minQuality.toUpperCase() + '.' };
  }
  const acc = plotfixAccuracy();
  if (acc.m == null){
    return { ok: false, reason: 'No accuracy figure available — cannot confirm this fix meets the ' + gate.maxHoriz + ' m limit.' };
  }
  if (acc.m > gate.maxHoriz){
    return { ok: false, reason: 'Accuracy ' + acc.label + ' exceeds this project’s ' + gate.maxHoriz + ' m limit.' };
  }
  return { ok: true, reason: null };
}


// ══ FEEDERS ══

// (a) The native plugin contract, written down so the Android side can be built against it.
//
// Java/Kotlin side must register a Capacitor plugin named 'PlotFixSerial' with:
//   - listPaired(): Promise<{devices: [{id, name}]}>       — paired Bluetooth Classic devices
//   - connect({id}): Promise<{connected: boolean}>          — open an RFCOMM/SPP socket, UUID
//                                                             00001101-0000-1000-8000-00805F9B34FB
//   - disconnect(): Promise<void>
//   - addListener('nmea', cb)                               — cb({line: "<one sentence>"})
//   - addListener('serialState', cb)                        — cb({connected, error})
//
// One sentence per event, newline-stripped. Line assembly belongs on the native side because a
// Bluetooth read returns arbitrary byte boundaries, and reassembling partial sentences across
// JS bridge events would drop data under load.
function plotfixAttachNative(){
  const plugin = (typeof capPlugin === 'function') ? capPlugin('PlotFixSerial') : null;
  if (!plugin || !plugin.addListener) return false;
  plugin.addListener('nmea', ev => { if (ev && ev.line) plotfixIngest(ev.line); });
  plugin.addListener('serialState', ev => {
    if (ev && ev.connected === false){
      // Falling silently back to the device provider would be the worst outcome: coordinates would
      // quietly get worse mid-survey with the same UI. The state is reset so the gate refuses and
      // the crew is told.
      plotfixState = { ...plotfixState, source: 'none', quality: PLOTFIX_QUALITY[0] };
      showToast('GNSS receiver disconnected — capture is gated until it returns');
    }
    if (typeof plotfixSyncUI === 'function') plotfixSyncUI();
  });
  return true;
}

// (b) The system provider. Called from the existing geolocation watch so there is one position
// pipeline rather than two competing ones. Marked 'system' precisely so nothing downstream can
// mistake it for a metadata-bearing fix.
function plotfixFromGeolocation(pos){
  if (!pos || !pos.coords) return;
  if (plotfixState.source === 'nmea') return; // a real receiver outranks the provider; never regress
  plotfixState = {
    ...plotfixState,
    source: 'system', at: Date.now(),
    lat: pos.coords.latitude, lon: pos.coords.longitude,
    altEllipsoid: pos.coords.altitude,
    quality: PLOTFIX_SYSTEM_QUALITY,
    sdHoriz: (pos.coords.accuracy != null) ? pos.coords.accuracy : null,
    sdVert: (pos.coords.altitudeAccuracy != null) ? pos.coords.altitudeAccuracy : null,
    // Explicitly nulled, not left stale: these are the fields a surveyor would read to decide
    // whether to trust a mark, and carrying a previous receiver's DOP into a device fix would be
    // the most damaging possible kind of stale data.
    satsUsed: null, satsInView: null, hdop: null, vdop: null, pdop: null,
    correctionAge: null, baseId: null
  };
  if (typeof plotfixOnUpdate === 'function') plotfixOnUpdate(plotfixState);
}

// (c) Diagnostics paste. Returns a count so the panel can report how much of what was pasted was
// actually valid — a receiver emitting sentences this parser rejects is exactly what you want to
// find out on a desk rather than on a site.
function plotfixIngestBlock(text){
  const lines = String(text || '').split(/[\r\n]+/);
  let ok = 0, bad = 0;
  lines.forEach(l => { if (!l.trim()) return; if (plotfixIngest(l)) ok++; else bad++; });
  return { ok, bad, total: ok + bad };
}


// ══ WHAT GETS RECORDED ON A VERTEX ══
// Attached at capture so the provenance of every mark travels with it. A survey where you cannot
// later tell which points were RTK and which were autonomous is a survey you cannot defend, and
// this is not reconstructible after the fact.
function plotfixVertexMeta(){
  const s = plotfixState;
  const acc = plotfixAccuracy();
  return {
    fix_source: s.source,
    fix_quality: s.quality ? s.quality.key : null,
    fix_quality_label: s.quality ? s.quality.label : null,
    sats_used: s.satsUsed, sats_in_view: s.satsInView,
    hdop: s.hdop, vdop: s.vdop, pdop: s.pdop,
    sd_horiz_m: s.sdHoriz, sd_vert_m: s.sdVert,
    accuracy_m: acc.m, accuracy_basis: acc.basis,
    correction_age_s: s.correctionAge, base_station_id: s.baseId,
    alt_ellipsoid_m: s.altEllipsoid,
    geoid_separation_m: s.geoidSep
  };
}

// Short status string for the GPS card — fix type, satellites, accuracy and its basis.
function plotfixStatusLine(){
  const s = plotfixState;
  if (s.source === 'none') return 'No GNSS source';
  const bits = [s.quality ? s.quality.short : '—'];
  if (s.satsUsed != null) bits.push(s.satsUsed + (s.satsInView != null ? '/' + s.satsInView : '') + ' sats');
  bits.push(plotfixAccuracy().label);
  if (s.correctionAge != null && s.correctionAge < 60) bits.push('corr ' + s.correctionAge.toFixed(0) + 's');
  return bits.join(' · ');
}
