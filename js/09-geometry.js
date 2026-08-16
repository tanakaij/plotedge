// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Manual entry, hold-to-average, shape preview, vertex map, digitizing aids
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ MANUAL COORDINATE ENTRY ══ — fallback for when GPS can't settle indoors (see
// updateIndoorGpsBanner). Adds a vertex straight from typed lat/lon, bypassing GPS entirely.
function openManualCoordEntry(){
  document.getElementById('manualLat').value='';
  document.getElementById('manualLon').value='';
  document.getElementById('manualCoordModal').classList.add('show');
}

function closeManualCoordEntry(){
  document.getElementById('manualCoordModal').classList.remove('show');
}

function submitManualCoordEntry(){
  const lat=parseFloat(document.getElementById('manualLat').value);
  const lon=parseFloat(document.getElementById('manualLon').value);
  if (isNaN(lat) || lat<-90 || lat>90){ showToast('Enter a valid latitude (-90 to 90)'); return; }
  if (isNaN(lon) || lon<-180 || lon>180){ showToast('Enter a valid longitude (-180 to 180)'); return; }
  closeManualCoordEntry();
  commitVertex(lat, lon, null, null, false, true);
}


function doCapture(coords, weak){
  const {latitude:lat,longitude:lon,altitude:alt,accuracy:acc}=coords;
  commitVertex(lat, lon, alt, acc, weak);
}


// ══ A TAP ALWAYS ANSWERS ══
// Both guards here used to `return` with no feedback whatsoever. Tapping Capture before the first
// fix arrived, or twice in quick succession while walking a boundary, produced nothing: no vertex,
// no toast, no sound. There is no way to tell that apart from a vertex that was recorded and not
// drawn, which is the whole of "confusion of missing capture you have captured" — so the crew
// re-tapped, or worse, walked on believing the corner was in. Every path now says what happened.
function attemptCapture(){
  if(!currentPos){
    showToast(gpsActive || extGpsActive
      ? 'Waiting for a GPS fix — nothing captured yet. Use "Enter coordinates" if you need to log this now.'
      : 'GPS is off. Start GPS above, or use "Enter coordinates".');
    return;
  }
  const now = Date.now();
  if (now - lastCaptureAt < CAPTURE_DEBOUNCE_MS){
    // Reported rather than swallowed: silence here reads as a lost capture, and the crew's next
    // move is to tap again, which the debounce eats too.
    showToast(`Too fast — vertex ${currentVertices.length} is already in. Tap again in a moment for the next one.`);
    return;
  }
  const acc = currentPos.coords.accuracy;
  doCapture(currentPos.coords, acc > CAPTURE_ACCURACY_WARN_M);
}


// ══ HOLD-TO-AVERAGE ══
function startHoldAveraging(){
  holdActive = true;
  holdSamples = currentPos ? [currentPos.coords] : [];
  holdStartedAt = Date.now();
  const btn = document.getElementById('captureBtn');
  btn.classList.add('averaging');
  updateHoldLabel();
  clearInterval(holdSampleInterval);
  holdSampleInterval = setInterval(()=>{
    if (currentPos) holdSamples.push(currentPos.coords);
    updateHoldLabel();
    if (Date.now() - holdStartedAt >= HOLD_MAX_MS) finishHoldAveraging();
  }, HOLD_SAMPLE_MS);
}

function updateHoldLabel(){
  const label = document.getElementById('captureBtnLabel');
  const secs = Math.min(HOLD_MAX_MS, Date.now()-holdStartedAt)/1000;
  label.textContent = `Averaging… ${holdSamples.length} fix${holdSamples.length===1?'':'es'} (${secs.toFixed(1)}s)`;
}

function finishHoldAveraging(){
  clearInterval(holdSampleInterval); holdSampleInterval = null;
  const btn = document.getElementById('captureBtn');
  btn.classList.remove('averaging');
  holdActive = false;
  const sel=document.getElementById('featureTypeSelect');
  const ft=sel && !sel.disabled ? getFeatureType(sel.value) : null;
  if (ft) updateGeometryUI(ft); // restores the normal button label
  if (!holdSamples.length){ return; }
  const n = holdSamples.length;
  const lat = holdSamples.reduce((s,c)=>s+c.latitude,0)/n;
  const lon = holdSamples.reduce((s,c)=>s+c.longitude,0)/n;
  const alts = holdSamples.filter(c=>c.altitude!=null).map(c=>c.altitude);
  const alt = alts.length ? alts.reduce((s,a)=>s+a,0)/alts.length : null;
  const acc = holdSamples.reduce((s,c)=>s+c.accuracy,0)/n;
  commitVertex(lat, lon, alt, acc, acc > CAPTURE_ACCURACY_WARN_M);
  if (acc <= CAPTURE_ACCURACY_WARN_M) showToast(`Averaged ${n} fix${n===1?'':'es'} (±${acc.toFixed(1)} m)`);
}

function cancelHoldAveraging(){
  clearInterval(holdSampleInterval); holdSampleInterval = null;
  holdActive = false; holdSamples = [];
  const btn = document.getElementById('captureBtn');
  btn.classList.remove('averaging');
  const sel=document.getElementById('featureTypeSelect');
  const ft=sel && !sel.disabled ? getFeatureType(sel.value) : null;
  if (ft) updateGeometryUI(ft);
}

function onCaptureBtnDown(){
  const btn = document.getElementById('captureBtn');
  if (btn.disabled) return;
  enterCollectDataEntry();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(startHoldAveraging, HOLD_THRESHOLD_MS);
}

function onCaptureBtnUp(){
  clearTimeout(holdTimer);
  if (holdActive) finishHoldAveraging();
  else attemptCapture();
}

function onCaptureBtnCancel(){
  clearTimeout(holdTimer);
  if (holdActive) cancelHoldAveraging();
}


function deletePoint(i) {
  const [removed] = currentVertices.splice(i,1);
  const prevOpenVertexIndex = openVertexIndex;
  if (openVertexIndex===i) openVertexIndex = currentVertices.length ? Math.max(0,i-1) : null;
  else if (openVertexIndex!==null && openVertexIndex>i) openVertexIndex--;
  persist({ destructive: true }); renderPoints(); renderVertexEditor();
  const sel=document.getElementById('featureTypeSelect');
  const ft=sel && !sel.disabled ? getFeatureType(sel.value) : null;
  if (ft) updateGeometryUI(ft);
  showUndoToast('Vertex deleted', () => {
    currentVertices.splice(i,0,removed);
    openVertexIndex = prevOpenVertexIndex;
    persist(); renderPoints(); renderVertexEditor();
    if (ft) updateGeometryUI(ft);
    showToast('Vertex restored');
  });
}

function editVertex(i) { openVertexIndex = i; renderPoints(); renderVertexEditor(); }

function renderPoints() {
  const el=document.getElementById('pointsList');
  const n=currentVertices.length;
  document.getElementById('ptCount').textContent=n?`(${n})`:'';
  if(!n){el.innerHTML='<div class="empty-box"><strong>No vertices yet</strong>Start GPS above and tap Capture</div>';updateShapePreview();return;}
  const geo = getCurrentGeometryType();
  // Start/End only mean something once there's an actual line/path — a lone vertex on a
  // line/polygon feature is neither yet, so this only kicks in from the 2nd vertex on.
  const showRoles = (geo==='line' || geo==='polygon') && n>=2;
  // Reordering only makes sense once there's more than one vertex, and only for line/polygon —
  // a "point" feature's multiple captures are independent re-shoots, not a sequence.
  const canReorder = (geo==='line' || geo==='polygon') && n>=2;
  el.innerHTML=currentVertices.map((p,i)=>{
    const cls=p.acc==null?'manual':p.acc<=5?'good':p.acc<=15?'ok':'poor';
    const nPh=(p.photos||[]).length;
    const phBadge=nPh?`<span class="pt-photos-badge">📷${nPh}</span>`:'';
    const roleBadge = !showRoles ? '' : i===0 ? '<span class="pt-role-badge pt-role-start">Start</span>' : i===n-1 ? '<span class="pt-role-badge pt-role-end">End</span>' : '';
    const moveGroup = !canReorder ? '' : `<div class="pt-move-group">
        <button class="pt-move" onclick="moveVertex(${i},-1)" ${i===0?'disabled':''} title="Move earlier in the sequence" aria-label="Move vertex earlier in the sequence">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="pt-move" onclick="moveVertex(${i},1)" ${i===n-1?'disabled':''} title="Move later in the sequence" aria-label="Move vertex later in the sequence">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>`;
    // Arming, not inserting: the point does not exist yet, so the crew names the
    // position, walks there and captures. Offered only for lines — a polygon ring
    // and a point feature's re-shoots have no "between" that means anything.
    const insertBtn = (geo !== 'line' || n < 2) ? '' :
      `<button class="pt-insert${pendingInsertAfter===i?' armed':''}" onclick="armInsertAfter(${i})" title="Next capture goes after this vertex" aria-label="Insert next captured point after vertex ${i+1}" aria-pressed="${pendingInsertAfter===i?'true':'false'}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>`;
    return `<div class="point-item ${i===openVertexIndex?'open':''}${pendingInsertAfter===i?' insert-armed':''}" data-idx="${i}">
      ${moveGroup}
      <div class="pt-num">${i+1}</div>
      <div class="pt-coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
      ${roleBadge}
      ${phBadge}
      <div class="pt-acc ${cls}">${p.acc==null?'manual':'±'+p.acc.toFixed(1)+'m'}</div>
      <button class="pt-edit" onclick="editVertex(${i})" title="Edit this vertex's details" aria-label="Edit vertex details">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      ${insertBtn}
      <button class="pt-del" onclick="deletePoint(${i})">×</button>
    </div>`;
  }).join('');
  // A banner, not just a highlighted row: arming changes what the capture button
  // will DO, and a mode you cannot see from the capture button is a mode that
  // catches people out.
  if (pendingInsertAfter !== null && pendingInsertAfter < n){
    el.insertAdjacentHTML('afterbegin',
      `<div class="insert-armed-banner">Next capture will be inserted after vertex ${pendingInsertAfter + 1}
        <button type="button" onclick="armInsertAfter(${pendingInsertAfter})">Cancel</button></div>`);
  }
  updateShapePreview();
}

// Swaps a vertex with its neighbor — the simplest safe way to fix a mis-ordered capture (e.g. a
// polygon corner shot out of sequence) without needing full drag-and-drop reordering.
function moveVertex(i, dir){
  const j = i+dir;
  if (j<0 || j>=currentVertices.length) return;
  [currentVertices[i], currentVertices[j]] = [currentVertices[j], currentVertices[i]];
  if (openVertexIndex===i) openVertexIndex=j;
  else if (openVertexIndex===j) openVertexIndex=i;
  persist(); renderPoints(); renderVertexEditor();
}

// ══════════════════════════════════════════════════════════════════════════════
// WHICH END DOES A NEW VERTEX BELONG TO?
// ══════════════════════════════════════════════════════════════════════════════
// Capture is append-only: js/08-gps.js does currentVertices.push(vertex) with no
// regard for geometry type. That is correct while a feature is being collected
// for the first time — you walk it in order, so the order is the walk.
//
// It is wrong when EDITING. Come back to a 400 m road, walk to the START end and
// shoot three more points, and they land after the existing last vertex. The
// line then runs old-start -> old-end -> back across the whole road to the new
// points: one enormous spurious segment, and lineLengthM() sums consecutive
// pairs so the recorded length is out by roughly twice the road. It looks
// plausible in the list and is wrong in the export, which is the worst way for a
// bug to behave.
//
// The only existing remedy is moveVertex(), one swap per tap. Moving three
// points to the front of a twenty-vertex line is fifty-seven taps.
//
// ── WHY ASK RATHER THAN JUST DO IT ──
// A survey that silently reverses direction on you is worse than one that
// appends wrongly, because you would never think to look. And the ambiguous
// cases are real: a loop road, a switchback, a feature short enough that both
// ends sit inside GPS error. So PlotEdge asks once per editing session and then
// remembers the answer — asking on every point would be intolerable.
//
// Only lines. A point has one vertex, and a polygon is a closed ring where
// appending near the start still closes: a bad edge rather than a doubled-back
// geometry.

// null until the question has been answered for the current edit. Reset whenever
// an edit begins or the form is blanked, so an answer never leaks between
// features.
let captureEndPreference = null;

// Set by armInsertAfter() from the vertex list: an explicit instruction that the
// NEXT captured point goes at a named position. Overrides everything below,
// because a crew that has said where a point goes has more information than any
// distance calculation.
let pendingInsertAfter = null;

function resetCaptureEndPreference(){
  captureEndPreference = null;
  pendingInsertAfter = null;
}


// ── ARMING AN EXPLICIT INSERT ──
// Inserting needs a point that does not exist yet, so this cannot be a single
// action: you arm the position, walk there, and capture. The banner in the
// vertex list is what stops that being a hidden mode.
function armInsertAfter(i){
  pendingInsertAfter = (pendingInsertAfter === i) ? null : i;
  renderPoints();
  showToast(pendingInsertAfter === null
    ? 'Insert cancelled'
    : `Next capture goes after vertex ${i + 1}`);
}


// Places a freshly captured vertex. Returns the index it landed at so the caller
// can open it in the editor.
//
// Everything here is deliberately conservative: unless it is confident the point
// belongs somewhere other than the end, it appends, which is what the app has
// always done.
function placeCapturedVertex(vertex){
  // 1. An explicit instruction wins outright.
  if (pendingInsertAfter !== null){
    const at = Math.min(pendingInsertAfter + 1, currentVertices.length);
    currentVertices.splice(at, 0, vertex);
    pendingInsertAfter = null;
    showToast(`Inserted as vertex ${at + 1}`);
    return at;
  }

  const plan = planVertexPlacement(vertex);
  if (!plan.ask){
    currentVertices.splice(plan.index, 0, vertex);
    return plan.index;
  }

  // 2. Append FIRST, then move if the answer says so. A captured GPS fix must
  // survive the dialog being dismissed, backgrounded or answered wrong — nothing
  // is ever held hostage to an unanswered question.
  currentVertices.push(vertex);
  const at = currentVertices.length - 1;
  showConfirm(plan.question,
    () => {
      captureEndPreference = plan.remember || null;
      const [v] = currentVertices.splice(at, 1);
      currentVertices.splice(plan.index, 0, v);
      openVertexIndex = plan.index;
      persist(); renderPoints(); renderVertexEditor(); renderVertexMap();
      showToast(plan.confirmToast);
    },
    plan.okLabel, 'default',
    () => {
      captureEndPreference = 'end';
      showToast('Continuing from the end');
    }
  );
  return at;
}


// Works out where a point geometrically belongs, by asking which placement adds
// the least length to the line. That single measure covers all three cases
// uniformly:
//
//   prepend            d(v, first)
//   append             d(last, v)
//   insert i..i+1      d(pi, v) + d(v, pi+1) - d(pi, pi+1)   — the detour cost
//
// The insert term is the honest one: putting a point between two others does not
// add its distance from them, it adds only the DETOUR, which is near zero for a
// point that genuinely sits on the segment. That is why a mid-line point wins
// cleanly over appending, and why a point out in a field does not.
//
// Returns { index, ask, question, okLabel, confirmToast, remember }.
function planVertexPlacement(v){
  const n = currentVertices.length;
  const append = { index: n, ask: false };
  if (!editingFeatureId) return append;                    // a fresh capture has no shape to fit into
  if (getCurrentGeometryType() !== 'line') return append;  // a polygon ring still closes; a point has one vertex
  if (n < 2) return append;                                // nothing to be between
  if (captureEndPreference === 'end') return append;

  const d = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);
  const appendCost = d(currentVertices[n - 1], v);
  const prependCost = d(v, currentVertices[0]);

  let bestSeg = -1, bestSegCost = Infinity;
  for (let i = 0; i < n - 1; i++){
    const a = currentVertices[i], b = currentVertices[i + 1];
    const cost = d(a, v) + d(v, b) - d(a, b);
    if (cost < bestSegCost){ bestSegCost = cost; bestSeg = i; }
  }

  // The margin a rival has to beat append by. Below this, "closer" is GPS noise
  // rather than intent, and a prompt the crew cannot answer correctly is worse
  // than no prompt at all — a loop road, a switchback, or a feature shorter than
  // the fix is accurate all land here.
  const slack = Math.max(8, (v.acc || 8) * 2);

  if (captureEndPreference === 'start'){
    return { index: 0, ask: false };
  }

  // Mid-line insert is checked before prepend: a point that sits ON a segment is
  // a stronger signal than one that is merely nearer the start end.
  if (bestSeg >= 0 && bestSegCost + slack < appendCost && bestSegCost < slack){
    return {
      index: bestSeg + 1, ask: true,
      question: `This point sits on the line between vertex ${bestSeg + 1} and ${bestSeg + 2}. Insert it there, or add it to the end?`,
      okLabel: `Insert at ${bestSeg + 2}`,
      confirmToast: `Inserted as vertex ${bestSeg + 2}`,
      // Not remembered: an insert position is specific to one point, unlike
      // "I am working from the start end now", which holds for a whole session.
      remember: null
    };
  }

  if (prependCost * 2 < appendCost && appendCost - prependCost >= slack){
    return {
      index: 0, ask: true,
      question: 'This point is near the START of the line. Add it to the start, or continue from the end?',
      okLabel: 'Add to start',
      confirmToast: 'Added to the start — further points will go there too',
      remember: 'start'
    };
  }

  return append;
}


// ══════════════════════════════════════════════════════════════════════════════
// COURSE-UP: THE PREVIEW MAP FACES THE WAY YOU ARE WALKING
// ══════════════════════════════════════════════════════════════════════════════
// North-up is right for reading a plan and wrong for standing in a road. If the
// survey runs south, a north-up preview shows the line growing DOWNWARDS while
// the crew walks forwards, and left and right on the screen are the crew's right
// and left. Every judgement about which side a vertex belongs on is then made
// through a mental mirror, which is exactly when a point ends up on the wrong
// kerb.
//
// So the preview rotates to put the direction of travel at the top. Same
// convention as a car satnav, for the same reason.
//
// Bearing sign: the rotate plugin turns map CONTENT clockwise by the bearing, so
// to bring a compass bearing of theta to the top the map must turn by -theta.
const VERTEX_COURSE_UP_KEY = 'plotedge_vertex_course_up';

function vertexCourseUpEnabled(){
  try { return localStorage.getItem(VERTEX_COURSE_UP_KEY) !== 'off'; } catch(e){ return true; }
}

function toggleVertexCourseUp(){
  const on = !vertexCourseUpEnabled();
  try { localStorage.setItem(VERTEX_COURSE_UP_KEY, on ? 'on' : 'off'); } catch(e){}
  if (!on && vertexMap && typeof vertexMap.setBearing === 'function') vertexMap.setBearing(0);
  renderVertexMap();
  showToast(on ? 'Map follows the direction of travel' : 'Map faces north');
}

// Direction of travel in degrees clockwise from north, or null when there isn't
// one yet. Uses the LAST segment rather than first-to-last: on a road that bends,
// what matters is the way the crew is walking now, not the average of where they
// have been.
function captureCourseDeg(){
  const n = currentVertices.length;
  if (n < 2) return null;
  const a = currentVertices[n - 2], b = currentVertices[n - 1];
  if (haversineM(a.lat, a.lon, b.lat, b.lon) < 1.5) return null;   // too short to mean anything
  const toRad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * toRad;
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad)
          - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function applyVertexCourseUp(){
  if (!vertexMap || typeof vertexMap.setBearing !== 'function') return;
  if (!vertexCourseUpEnabled()) return;
  if (getCurrentGeometryType() !== 'line') return;   // only a line has a direction
  const course = captureCourseDeg();
  if (course === null) return;
  // Don't fight small wobble: re-rotating a few degrees on every fix makes the
  // preview twitch and makes the crew seasick rather than oriented.
  const now = ((vertexMap.getBearing() || 0) % 360 + 360) % 360;
  const want = (360 - course) % 360;
  let diff = Math.abs(want - now); if (diff > 180) diff = 360 - diff;
  if (diff < 8) return;
  vertexMap.setBearing(want);
}


// ══ INLINE SHAPE PREVIEW ══
// Pure-SVG plot of the captured vertices' relative lat/lon — no map tiles or network needed, so
// it works exactly as well offline as on. Only meaningful for line/polygon once there's a shape
// forming; a lone point or a "point" feature's independent re-shoots don't need it.
function updateShapePreview(){
  const svg = document.getElementById('shapePreview');
  const geo = getCurrentGeometryType();
  const n = currentVertices.length;
  if (!svg) return;
  // The satellite-correction toggle can appear a little earlier than the SVG plot itself (useful
  // from the very first vertex, since "this pin landed on the wrong side of the road" is just as
  // real a problem with one point as with a whole line) — SVG needs 2+ points to draw anything.
  const mapToggle = document.getElementById('vertexMapToggleBtn');
  // PlotIn always shows/uses this map, regardless of geometry type or vertex count — it's the
  // primary capture surface indoors (see setCollectEnvironment in js/06-collect.js), not just a
  // correction tool for an in-progress line/polygon.
  if (mapToggle) mapToggle.style.display = (currentEnvironment==='PlotIn' || ((geo==='line' || geo==='polygon') && n>=1)) ? '' : 'none';
  if (vertexMapVisible) renderVertexMap();
  if ((geo!=='line' && geo!=='polygon') || n<2){ svg.classList.remove('show'); svg.innerHTML=''; return; }
  const W=300,H=130,PAD=14;
  const lats = currentVertices.map(v=>v.lat), lons = currentVertices.map(v=>v.lon);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats), minLon=Math.min(...lons), maxLon=Math.max(...lons);
  const spanLat = Math.max(maxLat-minLat, 1e-9), spanLon = Math.max(maxLon-minLon, 1e-9);
  // Longitude degrees compress with latitude — correct so the preview isn't stretched/squashed
  const lonScale = Math.cos((minLat+maxLat)/2 * Math.PI/180) || 1;
  const spanX = spanLon*lonScale, spanY = spanLat;
  const scale = Math.min((W-PAD*2)/Math.max(spanX,1e-9), (H-PAD*2)/Math.max(spanY,1e-9));
  const cx = (v)=> W/2 + (v.lon-(minLon+maxLon)/2)*lonScale*scale;
  const cy = (v)=> H/2 - (v.lat-(minLat+maxLat)/2)*scale; // screen Y is inverted vs latitude
  const pts = currentVertices.map(v=>`${cx(v).toFixed(1)},${cy(v).toFixed(1)}`).join(' ');
  const fillPoly = geo==='polygon' ? `<polygon class="sp-fill" points="${pts}"></polygon>` : '';
  const line = geo==='polygon'
    ? `<polygon class="sp-line" points="${pts}"></polygon>`
    : `<polyline class="sp-line" points="${pts}"></polyline>`;
  const dots = currentVertices.map((v,i)=>`<circle class="sp-vertex ${i===openVertexIndex?'sp-open':''}" cx="${cx(v).toFixed(1)}" cy="${cy(v).toFixed(1)}" r="${i===openVertexIndex?4.5:3}"></circle>`).join('');
  // ══ THE PREVIEW MUST SHOW ITS ORDER ══
  // The plot drew the ring in capture order but gave no way to READ that order, so a shape that
  // looked wrong was indistinguishable from a shape whose corners had been shot out of sequence —
  // there was nothing on screen to check the numbering against. Labelling each vertex with its
  // index (matching the numbers in the list below and the pins on the satellite map) makes the
  // sequence legible, so a crossed polygon can be spotted and fixed with the ↑↓ buttons on the
  // spot rather than after it reaches QGIS.
  // Drawn last so labels sit above the fill, and offset up-left of the dot so they never sit on
  // the vertex they name. A halo stroke keeps them readable over the fill in bright sun.
  const labels = currentVertices.map((v,i)=>{
    const x = cx(v), y = cy(v);
    // Nudged back inside the viewBox at the extremes, or the first/last corner's number clips off.
    const lx = Math.max(7, Math.min(W-7, x + 7));
    const ly = Math.max(9, Math.min(H-3, y - 6));
    return `<text class="sp-idx" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${i+1}</text>`;
  }).join('');
  // The first vertex gets a ring of its own: for a polygon it is the corner the ring closes back
  // onto, which is the single most useful thing to be able to find at a glance.
  const startMark = currentVertices.length
    ? `<circle class="sp-start" cx="${cx(currentVertices[0]).toFixed(1)}" cy="${cy(currentVertices[0]).toFixed(1)}" r="6.5"></circle>`
    : '';
  svg.innerHTML = fillPoly + line + startMark + dots + labels;
  svg.classList.add('show');
}


// ══ VERTEX SATELLITE MAP ══ — real imagery so a mis-placed vertex is obvious against the actual
// ground (a driveway, a fence line, a building corner), with two ways to fix it: drag an existing
// pin to where it should be, or tap empty map to digitize a vertex that never got a GPS fix at
// all. Shares the same free, no-API-key Esri World Imagery layer as the Review tab's satellite
// basemap (see ensureReviewMap above) rather than the Google Maps tile API, which needs a billed
// API key/account — outside this app's "no external accounts to manage" design elsewhere (e.g.
// the OSM Nominatim geocoding, the Netlify Blobs photo upload).
let vertexMap = null, vertexMapMarkersLayer = null, vertexMapLine = null, vertexMapVisible = false;

function toggleVertexMap(){
  vertexMapVisible = !vertexMapVisible;
  const wrap = document.getElementById('vertexMapWrap');
  const btn = document.getElementById('vertexMapToggleBtn');
  const label = document.getElementById('vertexMapToggleLabel');
  wrap.classList.toggle('show', vertexMapVisible);
  btn.classList.toggle('on', vertexMapVisible);
  label.textContent = vertexMapVisible ? 'Hide satellite map' : 'Adjust on satellite map';
  if (vertexMapVisible) {
    ensureVertexMap();
    renderVertexMap();
    // Leaflet sizes itself off the container's dimensions at creation time — if that happened
    // while the wrap was display:none (0×0), tiles render into a collapsed map. Kicking a resize
    // right after it becomes visible fixes that without needing to eagerly create the map (and
    // fetch tiles) before the user has actually asked to see it.
    setTimeout(()=>{ if (vertexMap) vertexMap.invalidateSize(); }, 60);
  }
}

function ensureVertexMap(){
  if (vertexMap) return vertexMap;
  const el = document.getElementById('vertexMap');
  if (!el || typeof L === 'undefined') return null;
  // Rotation, for the same reason PlotAtlas has it: you are placing vertices
  // against imagery while standing in the scene, and being able to turn the
  // imagery to match which way you are facing is the difference between "that
  // corner" and "which corner". This map previously had no rotation at all, yet
  // still showed a compass button — the plugin adds one to every map by default,
  // and on a non-rotating map it renders dead and never hides itself. See the
  // header of js/13b-map-rotate.js. Bottom-right because zoom sits top-left,
  // the live measurement readout overlays top-left too, and attribution is off
  // here so nothing else wants that corner.
  const canRotate = peCanRotateMaps();
  vertexMap = L.map(el, Object.assign(
    { zoomControl:true, attributionControl:false },
    canRotate ? peRotateMapOptions('bottomright') : {}
  ));
  if (canRotate) peAttachRotationSync(vertexMap);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 21,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
  }).addTo(vertexMap);
  vertexMapMarkersLayer = L.layerGroup().addTo(vertexMap);
  // Tapping open ground digitizes a new vertex there — same "manual" path already used by the
  // typed-coordinates fallback (see submitManualCoordEntry), so it shows up identically in the
  // vertex list (no accuracy value, marked as a manual entry) whether it was typed or tapped.
  // snapLatLng() first, so a tap near an existing vertex lands exactly on it (see below).
  vertexMap.on('click', (e) => {
    const p = snapLatLng(e.latlng);
    commitVertex(p.lat, p.lng, null, null, false, true);
    if (p.snapped) showToast('Snapped to existing vertex');
  });
  vertexMap.setView([0,0], 2);
  return vertexMap;
}

// Rebuilds the pins + connecting line from currentVertices. Called whenever vertices change while
// the map is open (capture, delete, reorder, drag-correct) so the map never shows a stale shape.
// Re-fitting the view on every redraw would fight a user mid-drag or mid-pan, so it only fits
// bounds the first time a shape appears on the map (fromEmpty), not on every subsequent update.
// ══════════════ DIGITIZING AIDS ══════════════
// Two things the tap-to-place/drag-to-move map above was missing for real survey work.
//
// 1. SNAPPING. Adjacent parcels share a boundary; a fence line ends where the next one starts.
//    Placed by eye at zoom 20, two "identical" corners end up 20-30cm apart, which becomes a
//    sliver polygon or a gap the moment the data reaches QGIS. Snapping makes a shared corner
//    genuinely identical rather than merely close.
// 2. LIVE MEASUREMENT. Whether the shape being walked is the right size is the question a crew
//    actually has on site, and it was only answerable after saving the feature.
let digiSnapOn = true;

const DIGI_SNAP_PX = 18; // tap tolerance in screen pixels, so it scales naturally with zoom


function toggleDigiSnap(){
  digiSnapOn = !digiSnapOn;
  const btn = document.getElementById('digiSnapBtn');
  const label = document.getElementById('digiSnapLabel');
  if (btn){ btn.classList.toggle('on', digiSnapOn); btn.setAttribute('aria-pressed', digiSnapOn ? 'true':'false'); }
  if (label) label.textContent = digiSnapOn ? 'Snap on' : 'Snap off';
  showToast(digiSnapOn ? 'Snapping on' : 'Snapping off');
  renderVertexMap();
}


// Candidate targets: every vertex of every saved feature in this project, plus the other vertices
// of the shape being drawn (so a polygon can be closed exactly onto its own first corner).
// skipIndex excludes the vertex currently being dragged, which would otherwise snap to itself.
function digiSnapTargets(skipIndex){
  const out = [];
  savedFeatures.forEach(f=>{
    (f.vertices||[]).forEach(v=>{
      if (v.lat!=null && v.lon!=null) out.push({ lat:v.lat, lon:v.lon, name:f.name });
    });
  });
  currentVertices.forEach((v,i)=>{
    if (i === skipIndex) return;
    if (v.lat!=null && v.lon!=null) out.push({ lat:v.lat, lon:v.lon, name:null });
  });
  return out;
}

// Tolerance is measured in screen pixels via the map's own projection, not in metres: at zoom 15
// a 0.5m tolerance is invisible, and at zoom 21 a 5m one would swallow every nearby corner. A
// fixed pixel radius means "near enough to have meant it" at any zoom.
function snapLatLng(latlng, skipIndex){
  const plain = { lat: latlng.lat, lng: latlng.lng, snapped: false };
  if (!digiSnapOn || !vertexMap) return plain;
  const origin = vertexMap.latLngToContainerPoint(latlng);
  let best = null, bestDist = DIGI_SNAP_PX;
  digiSnapTargets(skipIndex).forEach(t=>{
    const p = vertexMap.latLngToContainerPoint([t.lat, t.lon]);
    const d = Math.hypot(p.x - origin.x, p.y - origin.y);
    if (d < bestDist){ bestDist = d; best = t; }
  });
  return best ? { lat:best.lat, lng:best.lon, snapped:true } : plain;
}


// Removes the most recently added vertex — the digitizing equivalent of a mis-tap correction.
// Deliberately routed through the same delete path as the vertex list so the undo toast, persist
// and re-render behave identically however the vertex was removed.
function undoLastVertex(){
  if (!currentVertices.length){ showToast('No vertices to undo'); return; }
  if (typeof deletePoint === 'function') { deletePoint(currentVertices.length - 1); return; }
  currentVertices.pop();
  if (openVertexIndex !== null && openVertexIndex >= currentVertices.length) openVertexIndex = null;
  persist(); renderPoints(); updateShapePreview(); renderVertexEditor();
}


// Running length / area, recomputed from currentVertices on every redraw. Reuses the same
// haversine and shoelace helpers that write geom_length_m / geom_area_sqm onto the saved feature,
// so what the crew reads here is exactly what lands in the export — not a second, near-enough
// estimate that quietly disagrees with it.
function renderDigiReadout(){
  const el = document.getElementById('digiReadout');
  if (!el) return;
  const geo = getCurrentGeometryType();
  const n = currentVertices.length;
  if (n < 2 || (geo !== 'line' && geo !== 'polygon')){ el.style.display = 'none'; return; }
  let html = '';
  if (geo === 'polygon'){
    if (n < 3){ el.style.display = 'none'; return; }
    const { area, perimeter } = polygonAreaAndPerimeterM(currentVertices);
    html = `<span class="digi-main">${formatArea(area)}</span><span class="digi-sub">${formatLength(perimeter)} perimeter · ${n} vertices</span>`;
  } else {
    let len = 0;
    for (let i = 1; i < n; i++){
      len += haversineM(currentVertices[i-1].lat, currentVertices[i-1].lon, currentVertices[i].lat, currentVertices[i].lon);
    }
    html = `<span class="digi-main">${formatLength(len)}</span><span class="digi-sub">${n} vertices</span>`;
  }
  el.innerHTML = html;
  el.style.display = 'block';
}


function renderVertexMap(){
  if (!vertexMap || !vertexMapMarkersLayer) return;
  const hadNone = vertexMapMarkersLayer.getLayers().length === 0;
  vertexMapMarkersLayer.clearLayers();
  if (vertexMapLine) { vertexMap.removeLayer(vertexMapLine); vertexMapLine = null; }
  const n = currentVertices.length;
  renderDigiReadout();
  if (!n) {
    // PlotIn's "no floor plan available" path (satellite footprint tapping): with nothing
    // captured yet, center on the project's own site coordinates at a tight zoom instead of a
    // blank world view, so the crew is looking at the actual building footprint to tap on rather
    // than having to find it first. Falls back to the world view if the project has none set.
    if (currentEnvironment === 'PlotIn'){
      const p = projects.find(x=>x.id===activeProjectId);
      if (p && p.siteLat!=null && p.siteLon!=null){ vertexMap.setView([p.siteLat, p.siteLon], 19); return; }
    }
    vertexMap.setView([0,0], 2);
    return;
  }
  const geo = getCurrentGeometryType();
  const latlngs = currentVertices.map(v => [v.lat, v.lon]);
  if (n >= 2 && (geo==='line' || geo==='polygon')) {
    vertexMapLine = (geo==='polygon' ? L.polygon(latlngs, { color: cssVar('--orange'), weight:2, fillOpacity:0.14 })
                                      : L.polyline(latlngs, { color: cssVar('--orange'), weight:2 })).addTo(vertexMap);
  }
  // Faint ghosts of nearby saved vertices — without them, snapping is invisible until it fires
  // and the operator has no idea a shared corner is even available to snap to. Capped and
  // non-interactive so a dense project can't turn the map into a wall of dots or steal taps.
  if (digiSnapOn){
    const bounds = vertexMap.getBounds();
    let drawn = 0;
    savedFeatures.forEach(f=>{
      (f.vertices||[]).forEach(v=>{
        if (drawn >= 150 || v.lat==null || v.lon==null) return;
        if (!bounds.contains([v.lat, v.lon])) return;
        L.circleMarker([v.lat, v.lon], {
          radius:4, color:cssVar('--accent-primary'), weight:1.5, opacity:0.55,
          fillColor:cssVar('--accent-primary'), fillOpacity:0.22, interactive:false
        }).addTo(vertexMapMarkersLayer);
        drawn++;
      });
    });
  }
  currentVertices.forEach((v, i) => {
    const isOpen = i === openVertexIndex;
    const icon = L.divIcon({
      className: '',
      html: `<div class="vmap-pin${isOpen ? ' vmap-pin-open' : ''}"><span>${i+1}</span></div>`,
      iconSize: isOpen ? [30,30] : [26,26],
      iconAnchor: isOpen ? [15,29] : [13,25]
    });
    const marker = L.marker([v.lat, v.lon], { icon, draggable:true }).addTo(vertexMapMarkersLayer);
    // This is the actual position-correction path: dragging a pin writes straight back into
    // currentVertices, same array the vertex list / SVG preview / export all read from — no
    // separate "map version" of the geometry to keep in sync.
    marker.on('dragend', () => {
      const pos = snapLatLng(marker.getLatLng(), i);
      if (pos.snapped) marker.setLatLng([pos.lat, pos.lng]);
      currentVertices[i].lat = pos.lat;
      currentVertices[i].lon = pos.lng;
      currentVertices[i].manual = true; // no longer the raw GPS fix, flag it same as a typed entry
      persist(); renderPoints(); updateShapePreview();
      if (openVertexIndex === i) renderVertexEditor();
      showToast(`Vertex ${i+1} moved`);
    });
    marker.on('click', () => { openVertexIndex = i; renderVertexEditor(); renderVertexMap(); });
  });
  if (hadNone) {
    if (n === 1) vertexMap.setView(latlngs[0], 19);
    else vertexMap.fitBounds(L.latLngBounds(latlngs), { padding:[28,28], maxZoom:20 });
  }
  // After the view is settled, not before: fitBounds does its own work and a
  // bearing set first would be recomputed against the wrong centre.
  applyVertexCourseUp();
  updateCourseUpButton();
}

// Only lines get the control, and only once there are two vertices to define a
// direction. Offering it earlier would be a button that does nothing.
function updateCourseUpButton(){
  const btn = document.getElementById('courseUpBtn');
  if (!btn) return;
  const relevant = getCurrentGeometryType() === 'line' && currentVertices.length >= 2;
  btn.style.display = relevant ? '' : 'none';
  if (!relevant) return;
  const on = vertexCourseUpEnabled();
  btn.classList.toggle('is-on', on);
  const label = document.getElementById('courseUpLabel');
  if (label) label.textContent = on ? 'Facing travel' : 'Facing north';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on
    ? 'The map is turned so the way you are walking is up. Tap for north-up.'
    : 'The map faces north. Tap to turn it the way you are walking.';
}
