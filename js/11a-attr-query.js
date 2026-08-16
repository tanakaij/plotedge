// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Attribute query engine (QGIS-style expressions) + table selection
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.
//
// This file loads immediately BEFORE js/12-review.js, and the ordering is not
// cosmetic: js/22-boot.js runs render code at load time that reaches into the
// review module, which reaches in here, so a query engine sitting after review
// would be undefined at first paint. (`npm test` checks exactly this — see
// "no load-time code REACHES a name declared in a later script".)
//
// The dependency at *runtime* points the other way: this file reuses
// js/12-review.js's attrTableColumns() as the single definition of "what fields
// exist". The query builder, the table header and the export must never disagree
// about that, and they cannot if there is only one list. That call happens inside
// a function body, long after every script has run, so the two files can depend
// on each other without a load-order problem.
//
// ══ WHY AN EXPRESSION LANGUAGE AND NOT MORE DROPDOWNS ══
// The Review tab already had free-text search over name+ref and a feature-type
// dropdown. That answers "find the pole I named P-14". It cannot answer the
// questions that actually come up once a survey has a few hundred features:
// which polygons are under a hectare, which structures are in poor condition and
// have no photo, which of today's captures came in worse than ±5 m. Each of
// those is a filter over two or three fields at once, and adding a dropdown per
// field does not scale past about four.
//
// The syntax deliberately mirrors QGIS's field calculator / "Select by
// Expression", because that is the tool this data is going to end up in. A crew
// member who has written  "condition" = 'poor' AND "photos" = 0  in QGIS can
// write it here unchanged, and vice versa.


// ══════════════════════════════════════════════════════════════════════════════
// TOKENIZER
// ══════════════════════════════════════════════════════════════════════════════
// Single-quoted strings are literals ('poor'), double-quoted are field references
// ("condition") — same split QGIS uses, and the reason a bare  condition = poor
// is an error rather than a silent always-false comparison of two field names.
const PEQ_OPERATORS = ['<=', '>=', '<>', '!=', '=', '<', '>'];

function peqTokenize(src) {
  const out = [];
  let i = 0;
  const isIdentStart = c => /[A-Za-z_]/.test(c);
  const isIdent = c => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma' }); i++; continue; }
    if (c === "'") {
      let s = '', j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }  // SQL-style '' escape
        if (src[j] === "'") break;
        s += src[j++];
      }
      if (j >= src.length) throw new Error('unclosed quote — a text value needs a closing \'');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j === -1) throw new Error('unclosed " — a field name needs a closing "');
      out.push({ t: 'field', v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    const op = PEQ_OPERATORS.find(o => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op === '!=' ? '<>' : op }); i += op.length; continue; }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      out.push({ t: 'word', v: word, upper: word.toUpperCase() });
      i = j; continue;
    }
    throw new Error(`unexpected character "${c}"`);
  }
  return out;
}


// ══════════════════════════════════════════════════════════════════════════════
// PARSER — recursive descent, precedence: OR < AND < NOT < comparison < primary
// ══════════════════════════════════════════════════════════════════════════════
const PEQ_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'LIKE', 'ILIKE', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE']);

function peqParse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isWord = (w) => { const t = peek(); return t && t.t === 'word' && t.upper === w; };
  const eatWord = (w) => { if (isWord(w)) { pos++; return true; } return false; };

  function parseOr() {
    let left = parseAnd();
    while (isWord('OR')) { pos++; left = { k: 'or', l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isWord('AND')) { pos++; left = { k: 'and', l: left, r: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (isWord('NOT')) { pos++; return { k: 'not', v: parseNot() }; }
    return parseComparison();
  }

  function parseComparison() {
    const left = parsePrimary();
    const t = peek();
    if (!t) return left;

    if (t.t === 'op') { next(); return { k: 'cmp', op: t.v, l: left, r: parsePrimary() }; }

    if (t.t === 'word' && t.upper === 'IS') {
      next();
      const negated = eatWord('NOT');
      if (!eatWord('NULL')) throw new Error('expected NULL after IS');
      return negated ? { k: 'notnull', v: left } : { k: 'isnull', v: left };
    }
    if (t.t === 'word' && (t.upper === 'LIKE' || t.upper === 'ILIKE')) {
      next();
      return { k: 'like', ci: t.upper === 'ILIKE', l: left, r: parsePrimary() };
    }
    if (t.t === 'word' && t.upper === 'IN') {
      next();
      return { k: 'in', l: left, list: parseList() };
    }
    if (t.t === 'word' && t.upper === 'NOT') {
      // NOT LIKE / NOT IN — only valid here as a suffix on a comparison
      const save = pos;
      next();
      if (isWord('LIKE') || isWord('ILIKE')) {
        const kw = next();
        return { k: 'not', v: { k: 'like', ci: kw.upper === 'ILIKE', l: left, r: parsePrimary() } };
      }
      if (eatWord('IN')) return { k: 'not', v: { k: 'in', l: left, list: parseList() } };
      pos = save;
    }
    return left;
  }

  function parseList() {
    if (!peek() || peek().t !== 'lp') throw new Error('expected ( after IN');
    next();
    const items = [];
    if (peek() && peek().t === 'rp') { next(); return items; }
    for (;;) {
      items.push(parsePrimary());
      const t = next();
      if (!t) throw new Error('unclosed ( in IN list');
      if (t.t === 'rp') break;
      if (t.t !== 'comma') throw new Error('expected , or ) in IN list');
    }
    return items;
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new Error('expression ended early');
    if (t.t === 'lp') {
      const e = parseOr();
      const close = next();
      if (!close || close.t !== 'rp') throw new Error('missing )');
      return e;
    }
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'field') return { k: 'ref', v: t.v };
    if (t.t === 'word') {
      if (t.upper === 'NULL') return { k: 'lit', v: null };
      if (t.upper === 'TRUE') return { k: 'lit', v: true };
      if (t.upper === 'FALSE') return { k: 'lit', v: false };
      if (t.upper === 'NOT') { pos--; return parseNot(); }
      // A function call, or a bare (unquoted) field name — both are accepted, the
      // second because typing the quotes on a phone keyboard is a real cost.
      if (peek() && peek().t === 'lp') {
        next();
        const args = [];
        if (peek() && peek().t === 'rp') next();
        else for (;;) {
          args.push(parseOr());
          const n = next();
          if (!n) throw new Error('unclosed ( in function call');
          if (n.t === 'rp') break;
          if (n.t !== 'comma') throw new Error('expected , or ) in function arguments');
        }
        return { k: 'fn', name: t.v.toLowerCase(), args };
      }
      if (PEQ_KEYWORDS.has(t.upper)) throw new Error(`"${t.v}" is a keyword — put a field name in "double quotes" and text in 'single quotes'`);
      return { k: 'ref', v: t.v };
    }
    throw new Error('unexpected token in expression');
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new Error('unexpected text after the end of the expression');
  return ast;
}


// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR
// ══════════════════════════════════════════════════════════════════════════════
// NULL propagation follows SQL/QGIS: comparing against a missing value yields
// null (unknown), not false — so  "condition" <> 'poor'  does NOT quietly match
// features whose condition was never filled in. Those are found with IS NULL,
// which is the behaviour anyone coming from QGIS will expect.
function peqIsBlank(v) { return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length); }

function peqNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

function peqCompare(op, a, b) {
  if (peqIsBlank(a) || peqIsBlank(b)) return null;
  const na = peqNum(a), nb = peqNum(b);
  let c;
  if (na !== null && nb !== null) c = na < nb ? -1 : na > nb ? 1 : 0;
  else {
    // Numeric-aware string compare, so "P-2" sorts and compares against "P-10" sensibly.
    c = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    c = c < 0 ? -1 : c > 0 ? 1 : 0;
  }
  switch (op) {
    case '=':  return c === 0;
    case '<>': return c !== 0;
    case '<':  return c < 0;
    case '<=': return c <= 0;
    case '>':  return c > 0;
    case '>=': return c >= 0;
  }
  return null;
}

// SQL LIKE: % is any run of characters, _ is exactly one. Everything else is literal,
// so a value containing a regex metacharacter cannot turn into a pattern by accident.
function peqLikeToRegExp(pattern, ci) {
  let re = '';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}

function peqEval(node, row) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': {
      const v = row.get(node.v);
      if (v === undefined) throw new Error(`no field called "${node.v}"`);
      return v;
    }
    case 'and': {
      const l = peqEval(node.l, row);
      if (l === false) return false;                 // short-circuit, and null AND false is false
      const r = peqEval(node.r, row);
      if (l === null || r === null) return r === false ? false : null;
      return !!(l && r);
    }
    case 'or': {
      const l = peqEval(node.l, row);
      if (l === true) return true;
      const r = peqEval(node.r, row);
      if (l === null || r === null) return r === true ? true : null;
      return !!(l || r);
    }
    case 'not': {
      const v = peqEval(node.v, row);
      return v === null ? null : !v;
    }
    case 'cmp':    return peqCompare(node.op, peqEval(node.l, row), peqEval(node.r, row));
    case 'isnull': return peqIsBlank(peqEval(node.v, row));
    case 'notnull':return !peqIsBlank(peqEval(node.v, row));
    case 'like': {
      const l = peqEval(node.l, row), r = peqEval(node.r, row);
      if (peqIsBlank(l) || peqIsBlank(r)) return null;
      return peqLikeToRegExp(r, node.ci).test(String(l));
    }
    case 'in': {
      const l = peqEval(node.l, row);
      if (peqIsBlank(l)) return null;
      let sawNull = false;
      for (const item of node.list) {
        const v = peqEval(item, row);
        if (peqIsBlank(v)) { sawNull = true; continue; }
        if (peqCompare('=', l, v) === true) return true;
      }
      return sawNull ? null : false;
    }
    case 'fn': {
      const a = node.args.map(x => peqEval(x, row));
      switch (node.name) {
        case 'lower':  return a[0] == null ? null : String(a[0]).toLowerCase();
        case 'upper':  return a[0] == null ? null : String(a[0]).toUpperCase();
        case 'trim':   return a[0] == null ? null : String(a[0]).trim();
        case 'length': return a[0] == null ? null : String(a[0]).length;
        case 'abs':    return peqNum(a[0]) == null ? null : Math.abs(peqNum(a[0]));
        case 'round':  {
          const n = peqNum(a[0]); if (n === null) return null;
          const d = a.length > 1 ? (peqNum(a[1]) || 0) : 0;
          const f = Math.pow(10, d);
          return Math.round(n * f) / f;
        }
        case 'coalesce': return a.find(v => !peqIsBlank(v)) ?? null;
        default: throw new Error(`unknown function "${node.name}()"`);
      }
    }
  }
  throw new Error('could not evaluate the expression');
}


// ══════════════════════════════════════════════════════════════════════════════
// COMPILE — text in, predicate out
// ══════════════════════════════════════════════════════════════════════════════
// Field lookup is case-insensitive and matches on either the display label
// ("Condition") or the underlying key (condition), because the table header shows
// the label while an exported CSV shows the key, and a user will reasonably type
// whichever one they last looked at.
function attrQueryRowLookup(cols) {
  const byKey = new Map();
  cols.forEach(c => {
    byKey.set(String(c.key).toLowerCase(), c);
    byKey.set(String(c.label).toLowerCase(), c);
    // The synthetic columns are prefixed __name/__ref/… in the table; let people type the
    // obvious bare word for them too.
    if (String(c.key).startsWith('__')) byKey.set(String(c.key).slice(2).toLowerCase(), c);
  });
  return byKey;
}

function compileAttrQuery(expr, cols) {
  const text = String(expr || '').trim();
  if (!text) return { ok: true, empty: true, test: () => true };
  let ast;
  try { ast = peqParse(peqTokenize(text)); }
  catch (e) { return { ok: false, error: e.message }; }

  const lookup = attrQueryRowLookup(cols);
  // Resolve every field reference once, up front, so an unknown field is reported as an error
  // the moment Apply is pressed rather than throwing partway through the rows.
  const unknown = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'ref' && !lookup.has(String(n.v).toLowerCase())) unknown.push(n.v);
    ['l', 'r', 'v'].forEach(k => { if (n[k] && typeof n[k] === 'object') walk(n[k]); });
    (n.list || []).forEach(walk);
    (n.args || []).forEach(walk);
  })(ast);
  if (unknown.length) {
    return { ok: false, error: `no field called "${unknown[0]}". Tap a field name below to insert one that exists.` };
  }

  const test = (f) => {
    const row = { get: (name) => {
      const col = lookup.get(String(name).toLowerCase());
      if (!col) return undefined;
      return col.get(f);
    } };
    try { return peqEval(ast, row) === true; }   // null (unknown) is not a match, same as SQL WHERE
    catch (e) { return false; }
  };
  return { ok: true, empty: false, test };
}


// ══════════════════════════════════════════════════════════════════════════════
// QUERY STATE
// ══════════════════════════════════════════════════════════════════════════════
// attrQueryExpr is the applied expression; attrQueryError is set when the last
// Apply failed so the sheet can show why without losing what was typed.
let attrQueryExpr = '';

let attrQueryError = '';

// Selection is a Set of feature ids and is deliberately separate from the query:
// in QGIS, filtering and selecting are different operations, and conflating them
// makes "select these, now widen the filter, now act on my selection" impossible.
let attrSelection = new Set();

// When on, the table and the map show only selected rows — the equivalent of
// QGIS's "Show Selected Features" in the attribute table's view dropdown.
let attrShowSelectedOnly = false;


function attrQueryActive(){ return !!attrQueryExpr; }

// Applied on top of the existing search/type/validation filters (getFilteredFeatures), never
// instead of them, so the query composes with the controls above it rather than fighting them.
function applyAttrQueryFilter(features){
  let out = features;
  if (attrQueryExpr){
    const cols = attrTableColumns(features);
    const q = compileAttrQuery(attrQueryExpr, cols);
    if (q.ok && !q.empty) out = out.filter(q.test);
  }
  if (attrShowSelectedOnly) out = out.filter(f => attrSelection.has(f.id));
  return out;
}


// Keeps the "this table is filtered" banner honest. A narrowed table that looks like the whole
// project is exactly how features get reported missing, so the applied expression is always
// visible above the rows, with one tap to remove it.
function updateAttrQueryBar(){
  const bar = document.getElementById('attrQueryActiveBar');
  const txt = document.getElementById('attrQueryActiveText');
  const btn = document.getElementById('attrQueryBtn');
  if (btn) btn.classList.toggle('on', !!attrQueryExpr);
  if (!bar) return;
  bar.style.display = attrQueryExpr ? '' : 'none';
  if (txt) txt.textContent = attrQueryExpr;
}


// ══ QUERY SHEET ══
function openAttrQuery(){
  const modal = document.getElementById('attrQueryModal');
  if (!modal) return;
  const input = document.getElementById('attrQueryInput');
  if (input) input.value = attrQueryExpr;
  renderAttrQueryFields();
  renderAttrQueryPresets();
  setAttrQueryError(attrQueryError);
  liveValidateAttrQuery();
  modal.classList.add('show');
  if (input) focusWhenSettled(input);
}

function closeAttrQuery(){
  const modal = document.getElementById('attrQueryModal');
  if (modal) modal.classList.remove('show');
}

function setAttrQueryError(msg){
  const el = document.getElementById('attrQueryError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

// Every field the current data actually has, as tappable chips. Typing  "geom_area_sqm"  correctly
// on a phone in the field is not realistic; tapping it is.
function renderAttrQueryFields(){
  const wrap = document.getElementById('attrQueryFields');
  if (!wrap) return;
  const cols = attrTableColumns(savedFeatures);
  wrap.innerHTML = cols.map(c =>
    `<button type="button" class="aq-chip" onclick="insertAttrQueryToken('&quot;${escapeHtml(String(c.key))}&quot; ')" title="${escapeHtml(String(c.key))}">${escapeHtml(c.label)}</button>`
  ).join('');
}

function insertAttrQueryToken(token){
  const input = document.getElementById('attrQueryInput');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + token + input.value.slice(end);
  const caret = start + token.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  liveValidateAttrQuery();
}

// Validates as the user types so a typo is caught at the character that caused it, rather than
// after Apply has cleared the table to nothing.
function liveValidateAttrQuery(){
  const input = document.getElementById('attrQueryInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text){ setAttrQueryError(''); return; }
  const q = compileAttrQuery(text, attrTableColumns(savedFeatures));
  if (!q.ok){ setAttrQueryError(q.error); return; }
  const n = savedFeatures.filter(q.test).length;
  setAttrQueryError('');
  const hint = document.getElementById('attrQueryPreview');
  if (hint) hint.textContent = `${n} of ${savedFeatures.length} feature${savedFeatures.length===1?'':'s'} match`;
}

function applyAttrQuery(){
  const input = document.getElementById('attrQueryInput');
  const text = input ? input.value.trim() : '';
  if (!text){ clearAttrQuery(); return; }
  const q = compileAttrQuery(text, attrTableColumns(savedFeatures));
  if (!q.ok){ attrQueryError = q.error; setAttrQueryError(q.error); return; }
  attrQueryExpr = text; attrQueryError = '';
  closeAttrQuery();
  renderAttributeTable(); renderFeatures();
  if (typeof renderReviewMap === 'function' && reviewMap) renderReviewMap();
  const n = applyAttrQueryFilter(getFilteredFeatures()).length;
  showToast(n ? `${n} feature${n===1?'':'s'} match` : 'No features match that query');
}

function clearAttrQuery(){
  attrQueryExpr = ''; attrQueryError = '';
  const input = document.getElementById('attrQueryInput');
  if (input) input.value = '';
  const hint = document.getElementById('attrQueryPreview');
  if (hint) hint.textContent = '';
  setAttrQueryError('');
  closeAttrQuery();
  renderAttributeTable(); renderFeatures();
  if (typeof renderReviewMap === 'function' && reviewMap) renderReviewMap();
}

// ══ PRESETS ══
// The handful of questions that come up on nearly every job, pre-written. They double as worked
// examples of the syntax — tapping one puts real, editable text in the box, which teaches the
// language far better than a syntax reference nobody reads in the field.
const ATTR_QUERY_PRESETS = [
  { label: 'Poor accuracy (worse than ±5 m)', expr: '"__acc" > 5' },
  { label: 'No photo captured',               expr: '"__photos" = 0' },
  { label: 'Missing a reference ID',          expr: '"__ref" IS NULL' },
  { label: 'Polygons only',                   expr: "\"__geom\" = 'polygon'" },
  { label: 'Lines only',                      expr: "\"__geom\" = 'line'" },
  { label: 'Name contains…',                  expr: "\"__name\" ILIKE '%pole%'" },
  { label: 'Condition is poor',               expr: "\"condition\" ILIKE 'poor'" },
  { label: 'More than 4 vertices',            expr: '"__verts" > 4' }
];

function renderAttrQueryPresets(){
  const wrap = document.getElementById('attrQueryPresets');
  if (!wrap) return;
  wrap.innerHTML = ATTR_QUERY_PRESETS.map((p,i) =>
    `<button type="button" class="aq-preset" onclick="useAttrQueryPreset(${i})">${escapeHtml(p.label)}</button>`
  ).join('');
}

function useAttrQueryPreset(i){
  const p = ATTR_QUERY_PRESETS[i];
  if (!p) return;
  const input = document.getElementById('attrQueryInput');
  if (input){ input.value = p.expr; input.focus(); }
  liveValidateAttrQuery();
}


// ══════════════════════════════════════════════════════════════════════════════
// SELECTION
// ══════════════════════════════════════════════════════════════════════════════
function toggleAttrSelect(id, ev){
  if (ev && ev.stopPropagation) ev.stopPropagation();
  if (attrSelection.has(id)) attrSelection.delete(id); else attrSelection.add(id);
  renderAttributeTable();
  updateAttrSelectionBar();
  if (reviewMap) renderReviewMap();
}

function selectAllInAttrQuery(){
  const rows = applyAttrQueryFilter(getFilteredFeatures());
  rows.forEach(f => attrSelection.add(f.id));
  renderAttributeTable(); updateAttrSelectionBar();
  if (reviewMap) renderReviewMap();
  showToast(`${rows.length} feature${rows.length===1?'':'s'} selected`);
}

function invertAttrSelection(){
  const rows = applyAttrQueryFilter(getFilteredFeatures());
  rows.forEach(f => { if (attrSelection.has(f.id)) attrSelection.delete(f.id); else attrSelection.add(f.id); });
  renderAttributeTable(); updateAttrSelectionBar();
  if (reviewMap) renderReviewMap();
}

function clearAttrSelection(){
  attrSelection.clear();
  attrShowSelectedOnly = false;
  renderAttributeTable(); updateAttrSelectionBar();
  if (reviewMap) renderReviewMap();
}

function toggleShowSelectedOnly(){
  if (!attrSelection.size){ showToast('Nothing selected yet'); return; }
  attrShowSelectedOnly = !attrShowSelectedOnly;
  renderAttributeTable(); renderFeatures(); updateAttrSelectionBar();
}

function updateAttrSelectionBar(){
  const bar = document.getElementById('attrSelectionBar');
  if (!bar) return;
  const n = attrSelection.size;
  bar.style.display = n ? '' : 'none';
  const label = document.getElementById('attrSelectionCount');
  if (label) label.textContent = `${n} selected`;
  const btn = document.getElementById('attrShowSelectedBtn');
  if (btn){
    btn.classList.toggle('on', attrShowSelectedOnly);
    btn.textContent = attrShowSelectedOnly ? 'Show all' : 'Show selected';
  }
}

// Zoom the map to everything currently selected — the counterpart of QGIS's "Zoom to Selection",
// and the reason selecting is worth doing on a phone at all.
function zoomToAttrSelection(){
  if (!attrSelection.size){ showToast('Nothing selected yet'); return; }
  if (!reviewMap){ showToast('Open the Review map first'); return; }
  const latlngs = [];
  savedFeatures.forEach(f => {
    if (!attrSelection.has(f.id)) return;
    (f.vertices||[]).forEach(v => { if (v.lat!=null && v.lon!=null) latlngs.push([v.lat, v.lon]); });
  });
  if (!latlngs.length){ showToast('The selected features have no coordinates'); return; }
  if (latlngs.length === 1) reviewMap.setView(latlngs[0], Math.max(reviewMap.getZoom(), 18));
  else reviewMap.fitBounds(L.latLngBounds(latlngs), { padding:[36,36], maxZoom:19 });
  setTimeout(()=>reviewMap.invalidateSize(), 60);
}


// ══════════════════════════════════════════════════════════════════════════════
// FIELD STATISTICS
// ══════════════════════════════════════════════════════════════════════════════
// The other half of what a desktop attribute table is for: not just "which rows",
// but "what is in this column". Long-pressing a header opens this rather than
// sorting, so it costs no horizontal room in a table already tight on a phone.
function showAttrColumnStats(key){
  const rows = applyAttrQueryFilter(getFilteredFeatures());
  const cols = attrTableColumns(rows);
  const col = cols.find(c => c.key === key);
  if (!col){ return; }
  const values = rows.map(f => col.get(f));
  const present = values.filter(v => !peqIsBlank(v));
  const nums = present.map(peqNum).filter(v => v !== null);

  let body = `<div class="aq-stat"><span>Rows</span><strong>${rows.length}</strong></div>`;
  body += `<div class="aq-stat"><span>Filled in</span><strong>${present.length}</strong></div>`;
  body += `<div class="aq-stat"><span>Empty</span><strong>${rows.length - present.length}</strong></div>`;
  if (nums.length && nums.length === present.length){
    const sum = nums.reduce((s,x)=>s+x,0);
    const sorted = nums.slice().sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length/2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
    const round = n => Math.round(n*100)/100;
    body += `<div class="aq-stat"><span>Min</span><strong>${round(sorted[0])}</strong></div>`;
    body += `<div class="aq-stat"><span>Max</span><strong>${round(sorted[sorted.length-1])}</strong></div>`;
    body += `<div class="aq-stat"><span>Mean</span><strong>${round(sum/nums.length)}</strong></div>`;
    body += `<div class="aq-stat"><span>Median</span><strong>${round(median)}</strong></div>`;
    body += `<div class="aq-stat"><span>Sum</span><strong>${round(sum)}</strong></div>`;
  } else {
    // Categorical: the value counts are what matter, and they double as a menu — tapping one
    // writes the query that isolates it.
    const counts = new Map();
    present.forEach(v => {
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      counts.set(s, (counts.get(s)||0) + 1);
    });
    const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12);
    body += `<div class="aq-stat"><span>Distinct values</span><strong>${counts.size}</strong></div>`;
    body += top.map(([v,n]) =>
      `<button type="button" class="aq-stat aq-stat-row" onclick="queryFromStatValue('${escapeHtml(String(key)).replace(/'/g,"\\'")}','${escapeHtml(v).replace(/'/g,"\\'")}')">
        <span>${escapeHtml(v)}</span><strong>${n}</strong></button>`
    ).join('');
  }

  document.getElementById('attrStatsTitle').textContent = col.label;
  document.getElementById('attrStatsBody').innerHTML = body;
  document.getElementById('attrStatsModal').classList.add('show');
}

function closeAttrStats(){
  document.getElementById('attrStatsModal').classList.remove('show');
}

function queryFromStatValue(key, value){
  closeAttrStats();
  attrQueryExpr = `"${key}" = '${String(value).replace(/'/g, "''")}'`;
  attrQueryError = '';
  renderAttributeTable(); renderFeatures();
  if (reviewMap) renderReviewMap();
  showToast(`Filtered to ${value}`);
}
