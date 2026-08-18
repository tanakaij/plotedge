
// PlotEdge — PlotSeed: schema defaults, sticky values, and telling them apart from real answers
//
// ══ THE PROBLEM WITH AUTOFILL ══
// Forty poles down one street share a material, an owner and a road name, and retyping them is
// most of the work. So carrying values forward is obviously worth doing — and it is also the
// single most common source of garbage in an asset inventory. Two hundred poles all recorded as
// concrete because the first one was, and nobody looked again. The field is filled, the step badge
// says complete, and afterwards nothing distinguishes a value somebody OBSERVED from one the app
// INHERITED on their behalf.
//
// That is the real design question here. Not "should values carry forward" but "how does the crew
// know which values were carried". Everything below follows from that:
//
//   1. A seeded value is always visibly marked until it is touched. Not a subtle cue — a tinted
//      field with a label saying where the value came from.
//   2. Seeding is opt-in per field, never global. The crew decides that road name is constant for
//      this run and condition is not; the app is in no position to guess that.
//   3. The provenance survives into the saved feature and out into exports, so a survey can be
//      audited months later for which readings were actually taken.
//
// Without (3) the other two are cosmetic — they help during capture and vanish the moment the
// data leaves the phone, which is exactly when somebody needs to know.
//
// ══ TWO SOURCES, ONE MECHANISM ══
// A DEFAULT is part of the feature type: "material defaults to concrete", decided once by whoever
// designed the survey. Low risk, because it is a deliberate schema decision rather than an
// accident of capture order.
//
// A STICKY value is captured behaviour: the crew pins a field mid-run and it carries to the next
// feature. Higher value and higher risk, which is why it is opt-in and why the pin is visible on
// the field itself rather than buried in settings.
//
// Both render through the same path and produce the same visible marking, because to the person
// checking the form they are the same thing: a value that is there without them having typed it.

// Sticky values are per feature type, not global: "condition" on a pole and "condition" on a
// culvert are different questions that happen to share a label, and carrying a value between them
// would be worse than not carrying it at all. Held in memory rather than persisted — a pin is a
// statement about the run you are on now, and one silently surviving until next week is precisely
// the unnoticed-inheritance problem this file exists to prevent.
let stickyValues = {};   // { [featureTypeId]: { [fieldId]: value } }
let stickyPinned = {};   // { [featureTypeId]: Set<fieldId> }

function stickyPinsFor(ftId){
  if (!stickyPinned[ftId]) stickyPinned[ftId] = new Set();
  return stickyPinned[ftId];
}

function isFieldPinned(ftId, fieldId){ return stickyPinsFor(ftId).has(fieldId); }

function toggleFieldPin(ftId, fieldId){
  const pins = stickyPinsFor(ftId);
  if (pins.has(fieldId)){
    pins.delete(fieldId);
    if (stickyValues[ftId]) delete stickyValues[ftId][fieldId];
    showToast('Value will not carry to the next feature');
  } else {
    pins.add(fieldId);
    // Captured immediately rather than at save: pinning a field is a statement about the value
    // in front of you, and waiting until save would silently pin whatever it had become by then.
    const el = document.getElementById('attr_' + fieldId);
    const ft = getFeatureType(ftId);
    const field = ft && (ft.fields || []).find(f => f.id === fieldId);
    const val = field ? readAttrValue(field) : (el ? el.value : '');
    if (val !== '' && val != null){
      stickyValues[ftId] = stickyValues[ftId] || {};
      stickyValues[ftId][fieldId] = val;
    }
    showToast('Value will carry to the next feature');
  }
  syncFieldPinUI(fieldId, isFieldPinned(ftId, fieldId));
}

// Reads a field's current value in the same shape collectAttrs() would store it, so a pinned
// value and a saved value can never be different representations of the same answer.
function readAttrValue(field){
  if (typeof collectAttrs !== 'function') return null;
  const sel = document.getElementById('featureTypeSelect');
  const ft = sel ? getFeatureType(sel.value) : null;
  if (!ft) return null;
  try {
    const all = collectAttrs(ft);
    return all ? all[field.id] : null;
  } catch(e){ return null; }
}

// Called after a successful save: refreshes every pinned field from what was actually written.
// Reading from the saved attrs rather than the live DOM matters because the form is about to be
// cleared, and because what was saved is the authoritative version of what the crew meant.
function captureStickyFromSave(ft, attrs){
  if (!ft || !attrs) return;
  const pins = stickyPinsFor(ft.id);
  if (!pins.size) return;
  stickyValues[ft.id] = stickyValues[ft.id] || {};
  pins.forEach(fid => {
    const v = attrs[fid];
    if (v !== undefined && v !== null && v !== '') stickyValues[ft.id][fid] = v;
  });
}


// ══ WHAT A FIELD SHOULD OPEN WITH ══
// Order matters and is deliberate. An edit-in-progress always wins — nothing may overwrite a value
// the crew already committed. A sticky value beats a schema default because it is the more recent
// and more specific statement of intent. A default is the floor.
//
// Returns the value AND where it came from, because the caller has to mark it. A function that
// returned only the value would make it possible to seed a field without marking it, which is the
// failure this whole file is arranged to prevent.
function seedForField(ft, field, editingValue){
  if (editingValue !== undefined && editingValue !== null && editingValue !== '')
    return { value: editingValue, source: null };          // a real, previously-saved answer
  const sticky = stickyValues[ft.id] && stickyValues[ft.id][field.id];
  if (sticky !== undefined && sticky !== null && sticky !== '')
    return { value: sticky, source: 'carried' };
  if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== '')
    return { value: field.defaultValue, source: 'default' };
  return { value: editingValue, source: null };
}

// Which fields on the current form hold a seeded, still-untouched value. Feeds the "N carried
// forward" count on the Attributes header — the crew should be able to see at a glance how much
// of a completed-looking form they have not actually looked at.
function seededFieldIds(){
  return Array.from(document.querySelectorAll('#attrFields .attr-pane[data-seeded="1"]'))
    .map(el => el.dataset.fid);
}

// The moment a field is touched it stops being inherited and becomes an answer — whether or not
// the value changed. Looking at a carried value and deciding it is right IS confirming it, and
// requiring an edit to clear the mark would push people to change values needlessly.
function clearSeedMark(fieldId){
  const pane = document.querySelector(`#attrFields .attr-pane[data-fid="${fieldId}"]`);
  if (!pane || pane.dataset.seeded !== '1') return;
  delete pane.dataset.seeded;
  delete pane.dataset.seedSource;
  pane.classList.remove('is-seeded');
  const tag = pane.querySelector('.seed-tag');
  if (tag) tag.remove();
  if (typeof updateCollectStepStatus === 'function') updateCollectStepStatus();
}

// Marks a rendered pane as seeded. Separate from rendering so the same marking applies however the
// pane was produced.
function markPaneSeeded(pane, source){
  if (!pane) return;
  pane.dataset.seeded = '1';
  pane.dataset.seedSource = source;
  pane.classList.add('is-seeded');
  const label = pane.querySelector('label');
  if (label && !pane.querySelector('.seed-tag')){
    const tag = document.createElement('span');
    tag.className = 'seed-tag';
    // Named rather than generic. "Carried forward" and "default" are different claims about how
    // much this value has been thought about, and the crew should be able to tell which.
    tag.textContent = source === 'carried' ? 'carried forward' : 'default';
    label.appendChild(tag);
  }
}

function syncFieldPinUI(fieldId, pinned){
  const btn = document.querySelector(`.attr-pin[data-fid="${fieldId}"]`);
  if (btn){
    btn.classList.toggle('pinned', !!pinned);
    btn.setAttribute('aria-pressed', String(!!pinned));
    btn.title = pinned ? 'Carrying this value to the next feature' : 'Carry this value to the next feature';
  }
}

// The pin control, appended to a field's label. A button rather than a checkbox so it can be an
// icon at a real tap size without a label of its own competing with the field's.
function pinButtonHtml(ftId, fieldId){
  const pinned = isFieldPinned(ftId, fieldId);
  return `<button type="button" class="attr-pin${pinned ? ' pinned' : ''}" data-fid="${fieldId}"
    aria-pressed="${pinned}" title="${pinned ? 'Carrying this value to the next feature' : 'Carry this value to the next feature'}"
    onclick="event.preventDefault();event.stopPropagation();toggleFieldPin('${ftId}','${fieldId}')">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4.5V5H6.5v7.5L5 17z"/></svg>
  </button>`;
}
