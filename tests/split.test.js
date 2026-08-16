'use strict';
// Guards the file split. These are the ways a multi-file app silently breaks:
// a script that stops being loaded, a rename that changes load order, a new file
// that never reaches the APK or the offline cache, or a refactor that introduces
// a cross-file forward reference that hoisting used to hide.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { ROOT, readShell, appFiles } = require('./lib');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) {
    // A check can opt out by throwing SKIP — used where a file is legitimately
    // absent locally (the dot-paths are created on GitHub, not shipped).
    if (e && e.skip) results.push({ name, ok: true, skipped: true });
    else results.push({ name, ok: false, msg: e.message });
  }
};
const skip = reason => { const e = new Error(reason); e.skip = true; throw e; };
const assert = (c, m) => { if (!c) throw new Error(m); };

const shell = readShell();
const { css: cssOrder, js: jsOrder } = appFiles();

check('index.html links every file on disk, and every linked file exists', () => {
  assert(cssOrder.length > 0 && jsOrder.length > 0, 'index.html references no css or js');
  for (const f of cssOrder) assert(fs.existsSync(path.join(ROOT, 'css', f)), `linked but missing: css/${f}`);
  for (const f of jsOrder) assert(fs.existsSync(path.join(ROOT, 'js', f)), `linked but missing: js/${f}`);
  const onDisk = d => fs.readdirSync(path.join(ROOT, d)).filter(f => /\.(css|js)$/.test(f));
  const orphanCss = onDisk('css').filter(f => !cssOrder.includes(f));
  const orphanJs = onDisk('js').filter(f => !jsOrder.includes(f));
  assert(!orphanCss.length, `css/ files never loaded: ${orphanCss.join(', ')}`);
  assert(!orphanJs.length, `js/ files never loaded: ${orphanJs.join(', ')} — an orphan script is dead code that looks live`);
});

check('load order matches filename order', () => {
  // The numeric prefixes are a promise about the cascade and about declaration
  // order. If the tags disagree with the names, the numbering is lying.
  assert(JSON.stringify([...cssOrder].sort()) === JSON.stringify(cssOrder), `css load order is not filename order: ${cssOrder}`);
  assert(JSON.stringify([...jsOrder].sort()) === JSON.stringify(jsOrder), `js load order is not filename order: ${jsOrder}`);
});

check('every script parses on its own', () => {
  for (const f of jsOrder) {
    try { acorn.parse(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { ecmaVersion: 2022 }); }
    catch (e) { throw new Error(`js/${f}: ${e.message}`); }
  }
});

check('no load-time code REACHES a name declared in a later script', () => {
  // THE property that makes this split safe, and the subtle version of it.
  //
  // Checking only direct references is not enough. In the old single file every
  // function declaration hoisted to the top of one script, so a statement on
  // line 10 could call a function defined on line 10,000. Split across files
  // that is no longer true — and the failure is silent to a direct-reference
  // check, because the forward reference is inside a function BODY, not in the
  // statement itself. `applyTheme(currentTheme())` in js/01 looked harmless and
  // reached syncPlotLensEntry() in js/15 two calls down, throwing on every
  // launch and taking the rest of js/01 with it.
  //
  // So this walks the call graph: from every load-time statement, through every
  // function it actually INVOKES, transitively. Function expressions passed as
  // callbacks are not followed — they are created now and run later, which is
  // exactly the distinction that keeps this from drowning in false positives.
  const strip = s2 => s2.replace(/^\/\/ ═[\s\S]*?\n\n/, '');
  const files = jsOrder.map(f => {
    const src = strip(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
    return { f, ast: acorn.parse(src, { ecmaVersion: 2022, locations: true }) };
  });
  const declFile = new Map(), fnNode = new Map();
  files.forEach(({ ast }, i) => {
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration') { declFile.set(n.id.name, i); fnNode.set(n.id.name, n); }
      else if (n.type === 'ClassDeclaration') declFile.set(n.id.name, i);
      else if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.name) declFile.set(d.id.name, i);
    }
  });
  const STOP = { ...walk.base, FunctionDeclaration() {}, FunctionExpression() {}, ArrowFunctionExpression() {} };
  const evaluated = node => {
    const ids = new Set(), calls = new Set();
    walk.simple(node, {
      Identifier(id) { ids.add(id.name); },
      CallExpression(c) { if (c.callee.type === 'Identifier') calls.add(c.callee.name); }
    }, STOP);
    return { ids, calls };
  };
  const bad = new Map();
  files.forEach(({ f, ast }, i) => {
    for (const n of ast.body) {
      const seeds = [];
      if (n.type === 'VariableDeclaration') { for (const d of n.declarations) if (d.init) seeds.push(d.init); }
      else if (n.type !== 'FunctionDeclaration' && n.type !== 'ClassDeclaration') seeds.push(n);
      for (const seed of seeds) {
        const seen = new Set(); const stack = [seed];
        while (stack.length) {
          const { ids, calls } = evaluated(stack.pop());
          for (const name of ids) {
            const at = declFile.get(name);
            if (at !== undefined && at > i) bad.set(`js/${f} L${n.loc.start.line} -> "${name}" in js/${jsOrder[at]}`, 1);
          }
          for (const c of calls) {
            if (seen.has(c)) continue;
            seen.add(c);
            const fn = fnNode.get(c);
            if (fn) stack.push(fn.body);
          }
        }
      }
    }
  });
  assert(!bad.size, `load-time code reaches later files:\n    ${[...bad.keys()].join('\n    ')}`);
});

check('the pre-paint boot script stays inline', () => {
  // It resolves theme, palette and screen band before first paint. Moved to an
  // external file it would be fetched after the HTML parses, flashing the wrong
  // palette on every cold launch — the exact bug it exists to prevent.
  const inline = [...shell.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length;
  assert(inline >= 1, 'no inline scripts left — the pre-paint boot was externalised');
  assert(shell.includes("setAttribute('data-domain'"), 'the pre-paint domain resolution is gone from index.html');
  assert(shell.includes("setAttribute('data-theme'") || shell.includes('data-theme'), 'the pre-paint theme resolution is gone');
});

check('index.html is small enough to actually read', () => {
  const lines = shell.split('\n').length;
  assert(lines < 4000, `index.html is ${lines} lines — the split did not reduce it`);
});

check('no single source file is unwieldy', () => {
  const big = [];
  for (const f of jsOrder) {
    const n = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').split('\n').length;
    if (n > 2000) big.push(`js/${f} (${n} lines)`);
  }
  for (const f of cssOrder) {
    const n = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').split('\n').length;
    if (n > 2500) big.push(`css/${f} (${n} lines)`);
  }
  assert(!big.length, `files large enough to be hard to debug: ${big.join(', ')}`);
});

check('the service worker caches every file the app loads', () => {
  // Caching only the shell would make an offline launch a blank unstyled page —
  // which in a field app is indistinguishable from data loss.
  const sw = fs.readFileSync(path.join(ROOT, 'plotedge-sw.js'), 'utf8');
  const missing = [...cssOrder.map(f => 'css/' + f), ...jsOrder.map(f => 'js/' + f)]
    .filter(p => !sw.includes(p));
  assert(!missing.length, `not in the service worker shell cache: ${missing.join(', ')}`);
});

check('CI stages the split tree into the APK', () => {
  // Skipped when the workflow is not present locally — see the note in
  // tests/nav-build.test.js. It always runs in CI.
  const wfPath = path.join(ROOT, '.github/workflows/build-apk.yml');
  if (!fs.existsSync(wfPath)) skip('workflow not present locally');
  const wf = fs.readFileSync(wfPath, 'utf8');
  assert(/cp -r css www\/css/.test(wf), 'css/ is never copied into www — the APK would launch unstyled');
  assert(/cp -r js www\/js/.test(wf), 'js/ is never copied into www — the APK would launch dead');
  assert(/index.html references .* not staged|not staged/.test(wf), 'no check that every referenced file was staged');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.skipped ? '  SKIP' : r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  split: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
