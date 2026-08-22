'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DESKTOP SHELL — and, more importantly, PROOF THAT THE APK CANNOT SEE IT
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The whole safety claim for css/13-desktop.css is structural: every rule sits behind four
// independent locks, so the Android build cannot reach a single declaration. A claim like that is
// worth nothing unless something checks it, because the failure mode is silent — a rule added
// later outside the media query would ship to every phone in the field with no visible sign here.
// So these tests parse the stylesheet rather than render it: they assert the SHAPE of the file,
// which is the thing that actually guarantees the isolation.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const FILE = path.join(ROOT, 'css', '13-desktop.css');
const raw = fs.readFileSync(FILE, 'utf8');
// Comments carry example selectors and prose about the media query; stripping them keeps the
// analysis on real declarations.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

// Every top-level @media block, as [conditionText, bodyText].
function topLevelMediaBlocks(src) {
  const out = [];
  const re = /@media([^{]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push([m[1].trim(), src.slice(re.lastIndex, i - 1), m.index, i]);
    re.lastIndex = i;
  }
  return out;
}

const blocks = topLevelMediaBlocks(css);

check('every declaration in the desktop layer lives inside a media query', () => {
  // Strip the media blocks out and whatever is left should hold no rules at all. This is the
  // assertion that actually protects the APK: a rule added at the top level of this file would
  // apply on a phone, and nothing else in the suite would notice.
  // Cut the blocks out by index rather than by matching their text back — the text form is
  // whitespace-sensitive and a failed replace would make this test silently pass.
  let outside = '';
  let cursor = 0;
  for (const [, , start, end] of blocks) { outside += css.slice(cursor, start); cursor = end; }
  outside += css.slice(cursor);
  const stray = outside.replace(/\s+/g, '');
  assert(!stray.length, `rules outside any media query would reach the APK:\n        ${outside.trim().slice(0, 300)}`);
});

const deskBlocks = blocks.filter(([c]) => /min-width:\s*1024px/.test(c));

check('the desktop block carries all three viewport locks', () => {
  assert(deskBlocks.length === 1, `expected exactly one 1024px block, found ${deskBlocks.length}`);
  const cond = deskBlocks[0][0];
  assert(/hover:\s*hover/.test(cond), 'no hover:hover lock — a large touch tablet would get the desktop rail');
  assert(/pointer:\s*fine/.test(cond), 'no pointer:fine lock');
});

check('every desktop selector also excludes the native Android build', () => {
  // The media query alone would already keep the APK out. This is the lock that still holds if
  // somebody runs the Android build on a Chromebook with a mouse attached, which is the one
  // plausible way all three viewport conditions could pass at once.
  const body = deskBlocks[0][1];
  const bad = [];
  // Selector = whatever precedes each declaration block, minus nested at-rules.
  body.replace(/@supports[^{]+\{/g, '').split('}').forEach(chunk => {
    const sel = chunk.split('{')[0].trim();
    if (!sel || sel.startsWith('@')) return;
    sel.split(',').forEach(s => {
      const t = s.trim();
      if (!t) return;
      if (!/^html:not\(\.native-android\)/.test(t)) bad.push(t);
    });
  });
  assert(!bad.length, `selectors missing the html:not(.native-android) guard:\n        ${bad.slice(0, 6).join('\n        ')}`);
});

check('the touch-tablet block only widens the content column', () => {
  // The one block the Android build CAN reach (a tablet held sideways). It is allowed to exist
  // because a 600px strip on a 1280px tablet wastes the same space it does on a monitor — but it
  // must not touch geometry the APK depends on, so max-width is the only property permitted.
  const touch = blocks.filter(([c]) => /hover:\s*none/.test(c));
  assert(touch.length === 1, `expected exactly one touch-tablet block, found ${touch.length}`);
  const props = [...touch[0][1].matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
  const offenders = props.filter(p => p !== 'max-width');
  assert(!offenders.length, `the touch block changes more than width: ${[...new Set(offenders)].join(', ')}`);
  assert(!/position|display|transform|flex-direction/.test(touch[0][1]),
    'the touch block alters layout geometry the APK relies on');
});

check('the desktop layer adds no JavaScript dependency', () => {
  // positionNavPill() drives #navPill with a horizontal transform. Rather than teach it about a
  // vertical rail — a JS change, which WOULD reach the APK — the pill is hidden and the active tab
  // carries a static wash. If that ever changes, this test is the reminder that the JS is shared.
  const body = deskBlocks[0][1];
  assert(/\.nav-pill\s*\{[^}]*display:\s*none/.test(body),
    'the sliding pill is not hidden — its JS-driven geometry assumes a horizontal row');
  assert(/\.nav-btn\.active\s*\{[^}]*background/.test(body),
    'nothing replaces the hidden pill, so the active tab would lose its indicator');
});

check('the rail uses the real brand mark, not a CSS text string', () => {
  // content:'PlotEdge' was the placeholder in the first pass. A CSS string cannot be translated,
  // is invisible to a screen reader, and ignored the mark already sitting in resources/.
  const body = deskBlocks[0][1];
  assert(!/content:\s*['"]PlotEdge['"]/.test(body), 'the rail still hard-codes a wordmark string');
  const m = /background-image:\s*url\(['"]?\.\.\/([^'")]+)['"]?\)/.exec(body);
  assert(m, 'the rail has no brand mark at all');
  assert(fs.existsSync(path.join(ROOT, m[1])), `the rail points at a missing asset: ${m[1]}`);
});

check('hover states move colour, not filter', () => {
  // filter:brightness() washes the label along with the fill, and creates a stacking context that
  // interferes with backdrop-filter on any child.
  const body = deskBlocks[0][1];
  assert(!/filter:\s*brightness/.test(body),
    'brightness() is back — move background/border-color instead');
});

check('keyboard focus is visible and does not fire on mouse clicks', () => {
  const body = deskBlocks[0][1];
  assert(/:focus-visible/.test(body), 'no visible focus ring — the keyboard floor is not met');
  // The shortcuts themselves are js/23-desktop-keys.js; tests/desktop-keys.test.js owns them.
  assert(fs.existsSync(path.join(ROOT, 'js', '23-desktop-keys.js')),
    'the focus ring promises a keyboard the app does not actually have');
  assert(!/[^-]:focus\s*\{/.test(body),
    'plain :focus draws a ring on every mouse click; :focus-visible is the whole point');
});

check('every token the desktop layer reads actually exists', () => {
  // A typo'd var() fails silently and falls back to nothing, which on a colour means invisible
  // text. Cheap to check, and the kind of thing that only shows up on the one screen nobody opened.
  const tokens = new Set([...deskBlocks[0][1].matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  const declared = fs.readFileSync(path.join(ROOT, 'css', '01-tokens.css'), 'utf8');
  const localDecl = new Set([...deskBlocks[0][1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const missing = [...tokens].filter(t => !localDecl.has(t) && !new RegExp('\\' + t + '\\s*:').test(declared));
  assert(!missing.length, `undeclared tokens: ${missing.join(', ')}`);
});

check('every class the desktop layer targets is one the app actually renders', () => {
  // ══ THE CHECK THAT WAS MISSING ══
  // The first version of this file styled .stat-value, .mono, .list-row, .feature-row and
  // .modal-wide. Not one of those classes exists anywhere in PlotEdge — they were assumed rather
  // than looked up. The rules parsed cleanly, the suite stayed green, and the density pass this
  // file's header describes did precisely nothing.
  // A CSS selector that matches no element is invisible in every other way: no error, no warning,
  // no failing test. The only way to catch it is to ask whether the app ever emits the class.
  const body = deskBlocks[0][1];
  const emitted = [
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
    ...fs.readdirSync(path.join(ROOT, 'js')).map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))
  ].join('\n');

  // Classes this layer legitimately introduces itself, or that live in another stylesheet as
  // structural hooks rather than being written into markup.
  const OWN = new Set(['native-android']);

  const used = new Set();
  body.replace(/@supports[^{]+\{/g, '').split('}').forEach(chunk => {
    const sel = chunk.split('{')[0];
    if (!sel || sel.trim().startsWith('@')) return;
    [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].forEach(m => used.add(m[1]));
  });

  const dead = [...used].filter(c => {
    if (OWN.has(c)) return false;
    // Either written into markup as a class, or added at runtime via classList/className.
    return !new RegExp(`["'\\s.]${c}["'\\s,)]|classList\\.[a-z]+\\(['"]${c}['"]`).test(emitted);
  });
  assert(!dead.length,
    `desktop rules target classes the app never renders:\n        .${dead.join('\n        .')}`);
});

check('the density rule reaches the list it claims to', () => {
  // Specifically pinned because this is the claim that was false: the header calls density "the
  // substance of this pass", so something had better actually change size.
  const body = deskBlocks[0][1];
  assert(/\.feature-card-header\s*\{[^}]*padding/.test(body),
    'the review list rows are not tightened — density is asserted but not applied');
});

check('descendant selectors resolve against real markup, not just real class names', () => {
  // The class-existence check above passes for `#panel-collect .field-row2` because .field-row2 IS a
  // real class — it just never appears inside #panel-collect. A dead rule can be built entirely out
  // of live parts, so any `#id .class` pair is verified against the actual containing element.
  const body = deskBlocks[0][1];
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const bad = [];
  [...body.matchAll(/#([\w-]+)\s+\.([\w-]+)/g)].forEach(m => {
    const [, id, cls] = m;
    const open = html.indexOf(`id="${id}"`);
    if (open === -1) { bad.push(`#${id} does not exist`); return; }
    // Walk from the id to its closing tag by depth, then look for the class inside that span.
    let i = html.indexOf('>', open) + 1, depth = 1;
    const tagRe = /<(\/?)div\b[^>]*>/g;
    tagRe.lastIndex = i;
    let t;
    while (depth > 0 && (t = tagRe.exec(html))) { depth += t[1] ? -1 : 1; }
    const inner = html.slice(i, t ? t.index : html.length);
    if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(inner)) bad.push(`#${id} .${cls}`);
  });
  assert(!bad.length, `descendant rules that match nothing:\n        ${bad.join('\n        ')}`);
});

check('Review is a two-column master-detail with the map parked beside the list', () => {
  // The point of the desktop build: read a row, find it on the map, read the next — without a
  // scroll between every step.
  const body = deskBlocks[0][1];
  assert(/#panel-review\s*\{[^}]*display:\s*grid/.test(body), 'Review is still a single column');
  assert(/\.review-map-wrap\s*\{[^}]*position:\s*sticky/.test(body), 'the map does not stay in view');
  // Full-screen is position:fixed in 05-components.css and this file loads after it, so the sticky
  // rule would silently break the full-screen toggle unless it is re-asserted.
  assert(/\.review-map-wrap\.fullscreen\s*\{[^}]*position:\s*fixed/.test(body),
    'the sticky map broke the full-screen toggle');
});

check('nothing in Review is laid over the sticky map', () => {
  // The map spans rows 1–99 of column 2 and stays visible in BOTH card and table modes
  // (setReviewView in js/12-review.js swaps the list for the table and leaves the map alone). So
  // any other child spanning into column 2 is drawn on top of it. Grid allows the overlap silently
  // — no error, nothing in the console, just a table painted over a map.
  const body = deskBlocks[0][1];
  const scope = body.slice(body.indexOf('#panel-review'));
  const spans = scope.split('}')
    .filter(chunk => /grid-column:\s*1\s*\/\s*-1/.test(chunk))
    .map(chunk => chunk.split('{')[0].trim())
    // Full-screen legitimately takes both columns — at that point it is position:fixed and out of
    // the grid's flow entirely, so it cannot land on anything.
    .filter(sel => !/review-map-wrap/.test(sel));
  assert(!spans.length,
    `these span both columns and would be drawn over the map: ${spans.join(', ')}`);
});

check('full-screen surfaces do not cover the navigation rail', () => {
  // PlotAtlas and PlotWords are position:fixed from the viewport edge, so on desktop they painted
  // over the rail — the one place you could not see where you were.
  const body = deskBlocks[0][1];
  ['.plot-atlas', '.plotwords-layer'].forEach(sel => {
    assert(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*left:').test(body),
      `${sel} still starts at the viewport edge and covers the rail`);
  });
});

check('the ambient mesh is calmed rather than left at phone intensity', () => {
  // On a 27" display the drifting wash becomes the largest object on screen, behind a table of
  // coordinates. Dimmed and stopped, not deleted — the theme still has to be recognisable.
  const body = deskBlocks[0][1];
  const i = /--mesh-i:\s*([\d.]+)/.exec(body);
  assert(i, 'the desktop layer never touches mesh intensity');
  assert(parseFloat(i[1]) < 0.5, `mesh intensity ${i[1]} is still phone-loud at desk distance`);
  assert(/animation-play-state:\s*paused/.test(body), 'the blobs still drift at desk distance');
});

check('the stylesheet is loaded last, after every other sheet', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="css\/([^"]+)"/g)].map(m => m[1]);
  assert(sheets.includes('13-desktop.css'), 'the desktop sheet is never linked');
  assert(sheets[sheets.length - 1] === '13-desktop.css',
    `desktop must load last to win on equal specificity without !important; loads before ${sheets.slice(sheets.indexOf('13-desktop.css') + 1).join(', ')}`);
  assert(!/!important/.test(css), 'the desktop layer resorts to !important instead of load order');
});

check('the service worker precaches it, so offline desktop is not unstyled', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'plotedge-sw.js'), 'utf8');
  assert(/'css\/13-desktop\.css'/.test(sw), 'the desktop sheet is missing from the precache list');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  desktop: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
