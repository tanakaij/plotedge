
// PlotEdge — PlotMind memory bank: learned vocabulary and domain suggestions
//
// This is the third PlotMind method, and it belongs here for the same reason as the other two:
// on-device, no endpoint, explainable in a sentence, and it works in a field with no signal.
//
// ══ SUGGESTING IS NOT FILLING ══
// js/06b-plotseed.js already fills fields — defaults and carried-forward values — and everything
// there is arranged around making a supplied value visibly different from an observed one, because
// two hundred poles recorded as concrete is how an asset inventory quietly fills with garbage.
//
// This file does the opposite thing on purpose. It never writes a value. It offers chips above a
// field, and a chip only becomes a value when somebody taps it. That distinction is the whole
// design: seeding trades verification for speed and pays for it with a marking; suggesting costs
// nothing because the crew's answer is still their own. A suggestion that filled itself in would
// be a seed with worse provenance, and there is no reason to build one of those.
//
// So nothing here can make an entry the crew did not make. The worst a bad suggestion can do is
// take up a row of space and be ignored.
//
// ══ TWO SOURCES ══
// LEARNED — what this crew actually types. Counted per (feature type, field), so "Material" on a
// pole and "Material" on a culvert learn separately. Purely local: a frequency table, no model,
// no training, and the reason a suggestion appears is always "you have used it N times", which
// somebody can disagree with.
//
// DOMAIN — a small vocabulary keyed off what the feature type is called. A crew defining "Access
// Road" on day one has typed nothing yet, so the learned bank is empty exactly when help is worth
// most. The lexicon covers that first day and then quietly loses to the learned values, which is
// the correct order: what this crew says beats what the app guessed they might say.

const PLOTMIND_BANK_KEY = 'plotedge_value_bank';
const BANK_MAX_PER_FIELD = 12;   // more than a phone can show without scrolling is dead weight
const BANK_MIN_LEN = 1;
const BANK_MAX_LEN = 60;         // a sentence is a note, not a vocabulary item

function loadValueBank(){
  try { return JSON.parse(localStorage.getItem(PLOTMIND_BANK_KEY) || '{}') || {}; }
  catch(e){ return {}; }
}

function saveValueBank(bank){
  try { localStorage.setItem(PLOTMIND_BANK_KEY, JSON.stringify(bank)); } catch(e){}
}

// Keyed on the field id within the feature type. Two types can both have "condition" and mean
// entirely different scales.
function bankKey(ftId, fieldId){ return ftId + '::' + fieldId; }

// Called after a save. Counts, rather than storing a list, so a value typed forty times outranks
// one typed once — and so a typo entered on a bad afternoon sinks on its own rather than needing
// to be cleaned up.
function learnFromSave(ft, attrs){
  if (!ft || !attrs) return;
  const bank = loadValueBank();
  (ft.fields || []).forEach(a => {
    // Free-text and numbers only. A select already lists its own options — learning them back and
    // showing them a second time above the control is noise, and a boolean has two states.
    if (['single_select','multi_select','boolean','repeat_group','calculated','photo'].includes(a.type)) return;
    const raw = attrs[a.id];
    if (raw == null) return;
    const v = String(raw).trim();
    if (v.length < BANK_MIN_LEN || v.length > BANK_MAX_LEN) return;
    const k = bankKey(ft.id, a.id);
    bank[k] = bank[k] || {};
    bank[k][v] = (bank[k][v] || 0) + 1;
    // Trimmed at write time rather than read time so the stored object cannot grow without bound
    // on a long survey. The least-used entries go, which is also the ones most likely to be typos.
    const entries = Object.entries(bank[k]).sort((x, y) => y[1] - x[1]).slice(0, BANK_MAX_PER_FIELD);
    bank[k] = Object.fromEntries(entries);
  });
  saveValueBank(bank);
}

// What this crew has actually used here, most-used first.
function learnedValuesFor(ftId, fieldId){
  const bank = loadValueBank();
  const entry = bank[bankKey(ftId, fieldId)];
  if (!entry) return [];
  return Object.entries(entry).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, count: n }));
}

function forgetLearnedValue(ftId, fieldId, value){
  const bank = loadValueBank();
  const k = bankKey(ftId, fieldId);
  if (bank[k]) { delete bank[k][value]; saveValueBank(bank); }
  if (typeof renderValueSuggestions === 'function') renderValueSuggestions();
}

function clearValueBank(){
  try { localStorage.removeItem(PLOTMIND_BANK_KEY); } catch(e){}
  showToast('Learned values cleared');
  if (typeof renderValueSuggestions === 'function') renderValueSuggestions();
}


// ══ DOMAIN VOCABULARY ══
// Matched on the words in a feature type's NAME, because that is the only description of what a
// thing is that the app has. "Access Road", "Road Centreline" and "Farm road" all hit `road`.
//
// Kept deliberately small and generic. A lexicon that tried to be complete would be wrong more
// often than right — surface types differ by country, condition scales differ by client — and a
// wrong suggestion costs more trust than a missing one saves time. These are the terms that hold
// across most jurisdictions; anything local gets learned from what the crew actually types, which
// is the better mechanism anyway.
const PLOTMIND_LEXICON = [
  { match: ['road','street','carriageway','highway','track','lane'], fields: {
      surface:   ['Asphalt','Chip seal','Gravel','Earth','Concrete','Cobble'],
      condition: ['Good','Fair','Poor','Failed'],
      material:  ['Asphalt','Concrete','Gravel'],
      type:      ['Primary','Secondary','Access','Service'] } },
  { match: ['house','dwelling','building','structure','stand','premise'], fields: {
      material:  ['Brick','Block','Concrete','Timber','Steel sheet','Mud brick'],
      roof:      ['Corrugated iron','Tile','Asbestos','Thatch','Concrete'],
      condition: ['Good','Fair','Poor','Derelict'],
      use:       ['Residential','Commercial','Institutional','Industrial','Vacant'] } },
  { match: ['pole','pylon','mast','streetlight','lamp'], fields: {
      material:  ['Wood','Concrete','Steel','Composite'],
      condition: ['Good','Fair','Poor','Leaning','Rotted'],
      owner:     ['Municipal','Utility','Private'] } },
  { match: ['pipe','main','water','sewer','reticulation'], fields: {
      material:  ['uPVC','HDPE','Ductile iron','Steel','Asbestos cement','Concrete'],
      condition: ['Good','Fair','Poor','Leaking'],
      status:    ['In service','Abandoned','Proposed'] } },
  { match: ['manhole','chamber','valve','hydrant','meter'], fields: {
      material:  ['Concrete','Brick','uPVC','Cast iron'],
      condition: ['Good','Fair','Poor','Damaged','Missing cover'],
      status:    ['In service','Abandoned','Buried'] } },
  { match: ['septic','soakaway','tank','latrine','toilet'], fields: {
      material:  ['Concrete','Brick','Plastic','Fibreglass'],
      condition: ['Good','Fair','Poor','Overflowing','Collapsed'],
      status:    ['In use','Decommissioned','Full'] } },
  { match: ['borehole','well','pump','tap','standpipe'], fields: {
      status:    ['Functional','Partially functional','Non-functional','Abandoned'],
      condition: ['Good','Fair','Poor'],
      power:     ['Hand pump','Solar','Electric','Diesel'] } },
  { match: ['culvert','drain','ditch','channel','bridge'], fields: {
      material:  ['Concrete','Steel','Masonry','HDPE'],
      condition: ['Good','Fair','Poor','Blocked','Collapsed'],
      type:      ['Pipe','Box','Slab','Open drain'] } },
  { match: ['fence','wall','boundary','beacon','peg'], fields: {
      material:  ['Wire','Palisade','Brick','Precast concrete','Hedge'],
      condition: ['Good','Fair','Poor','Missing'] } },
  { match: ['tree','crop','plot','field','farm','vegetation'], fields: {
      condition: ['Healthy','Stressed','Diseased','Dead'],
      status:    ['Mature','Young','Cleared'] } }
];

// Suggestions from the lexicon for one field. Matched loosely on both sides: the feature type's
// name against the entry's keywords, and the field's LABEL against the entry's field names — a
// field called "Surface type" should hit `surface`.
function domainValuesFor(ft, field){
  if (!ft || !field) return [];
  const name = String(ft.name || '').toLowerCase();
  const label = String(field.label || '').toLowerCase();
  const out = [];
  PLOTMIND_LEXICON.forEach(entry => {
    if (!entry.match.some(w => name.includes(w))) return;
    Object.keys(entry.fields).forEach(fname => {
      if (!label.includes(fname)) return;
      entry.fields[fname].forEach(v => { if (!out.includes(v)) out.push(v); });
    });
  });
  return out;
}


// ══ RENDERING ══
// Chips above the field. Learned first, because what this crew says beats what the app guessed
// they might say — and once a crew has typed "Chip seal" forty times, the lexicon's opinion about
// road surfaces has stopped being useful.
function suggestionsFor(ft, field){
  const out = [];
  const seen = new Set();
  const near = nearestValueFor(ft, field);
  if (near){
    out.push({ value: near.value, count: near.agree, of: near.of, from: 'nearest' });
    seen.add(near.value.toLowerCase());
  }
  const learned = learnedValuesFor(ft.id, field.id)
    .filter(x => !seen.has(x.value.toLowerCase()))
    .map(x => ({ ...x, from: 'learned' }));
  learned.forEach(x => seen.add(x.value.toLowerCase()));
  const domain = domainValuesFor(ft, field)
    .filter(v => !seen.has(v.toLowerCase()))
    .map(v => ({ value: v, count: 0, from: 'domain' }));
  return out.concat(learned, domain).slice(0, 8);
}

function renderValueSuggestions(){
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel ? getFeatureType(sel.value) : null;
  if (!ft) return;
  document.querySelectorAll('#attrFields .attr-pane').forEach(pane => {
    const field = (ft.fields || []).find(f => f.id === pane.dataset.fid);
    if (!field) return;
    const old = pane.querySelector('.suggest-row');
    if (old) old.remove();
    if (['single_select','multi_select','boolean','repeat_group','calculated','photo'].includes(field.type)) return;

    // Hidden once the field has an answer. Suggestions are for an empty box; leaving them up
    // afterwards turns them into a standing invitation to second-guess a value already given.
    const input = pane.querySelector(`#attr_${field.id}`);
    if (input && String(input.value || '').trim() !== '') return;

    const items = suggestionsFor(ft, field);
    if (!items.length) return;
    const row = document.createElement('div');
    row.className = 'suggest-row';
    row.innerHTML = items.map(s =>
      `<button type="button" class="suggest-chip" data-from="${s.from}"
        onclick="applySuggestion('${field.id}', ${JSON.stringify(s.value).replace(/"/g, '&quot;')})"
        ${s.from === 'learned' ? `oncontextmenu="event.preventDefault();offerForget('${ft.id}','${field.id}', ${JSON.stringify(s.value).replace(/"/g, '&quot;')})"` : ''}
        title="${s.from === 'nearest' ? s.count + ' of the ' + s.of + ' nearest captures of this type' : s.from === 'learned' ? 'Used ' + s.count + ' time' + (s.count === 1 ? '' : 's') + ', long-press to forget' : 'Common for this kind of feature'}"
        >${escapeHtml(s.value)}</button>`).join('');
    const fieldEl = pane.querySelector('.field');
    if (fieldEl) fieldEl.appendChild(row);
  });
}

// Tapping a chip writes the value the same way typing it would, then dispatches the events the
// rest of the form listens for. It is NOT marked as seeded: the crew chose it, so it is their
// answer, not one the app supplied.
// Long-press on a learned chip. Confirmed rather than immediate, because a long-press is easy to
// trigger by accident while scrolling a form with a thumb.
function offerForget(ftId, fieldId, value){
  showConfirm(`Forget “${value}” as a suggestion for this field?`,
    () => forgetLearnedValue(ftId, fieldId, value), 'Forget');
}

function applySuggestion(fieldId, value){
  const el = document.getElementById('attr_' + fieldId);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  renderValueSuggestions();
}


// ══ THE THIRD SOURCE: WHAT IS ACTUALLY NEXT TO YOU ══
// PlotMind already does k-nearest-neighbour attribute fill, but only as a post-hoc review action:
// you finish a survey, open PlotMind, run the checks, and it offers to fill the blanks it found.
// That is the right tool applied at the wrong moment. The single best predictor of a septic's
// material is the material of the three septics either side of it — and that information exists
// while the crew is standing there, not two weeks later at a desk.
//
// So the same maths runs at capture time and feeds the chip row. It costs nothing extra: the
// features are already in memory, pmDistM and pmCentroid are already loaded, and the loop is over
// one feature type within a radius rather than the whole dataset.
//
// Ranked ABOVE the learned bank on purpose. Learned says "you usually type this"; nearest says
// "the ones right here are this". The second is more specific evidence about the thing actually in
// front of the crew, and specificity should win — the same reason a sticky value beats a schema
// default in js/06b-plotseed.js.

const BANK_NEAR_RADIUS_M = 250;   // matches PM_KNN_MAX_M — one idea, one number
const BANK_NEAR_K = 5;

// The majority value among the nearest already-captured features of this type, with the agreement
// level, so the chip can say how much to trust it. Returns null rather than a weak guess: a
// suggestion backed by two neighbours that disagree is worse than no suggestion, because it looks
// exactly like one backed by five that agree.
function nearestValueFor(ft, field){
  if (typeof pmCentroid !== 'function' || typeof pmDistM !== 'function') return null;
  if (!Array.isArray(currentVertices) || !currentVertices.length) return null;   // nowhere to be near
  if (['repeat_group','calculated','photo'].includes(field.type)) return null;

  const here = { lat: currentVertices[0].lat, lon: currentVertices[0].lon };
  if (here.lat == null || here.lon == null) return null;

  const withVal = savedFeatures.filter(f => {
    if (f.featureTypeId !== ft.id) return false;
    if (editingFeatureId && f.id === editingFeatureId) return false;   // never suggest a feature to itself
    const v = (f.attrs || {})[field.id];
    return v !== '' && v != null && !(Array.isArray(v) && !v.length);
  });
  if (withVal.length < 2) return null;

  const near = withVal
    .map(f => { const c = pmCentroid(f); return c ? { f, d: pmDistM(here, c) } : null; })
    .filter(x => x && x.d <= BANK_NEAR_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, BANK_NEAR_K);
  if (near.length < 2) return null;

  const counts = {};
  near.forEach(x => {
    const v = String((x.f.attrs || {})[field.id]);
    counts[v] = (counts[v] || 0) + 1;
  });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const agreement = best[1] / near.length;
  // Below a majority it is not a finding, it is noise wearing a chip.
  if (agreement < 0.6) return null;
  return { value: best[0], of: near.length, agree: best[1], agreement };
}
