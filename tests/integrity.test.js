'use strict';
const vm = require('vm');
const { readIndex } = require('./lib');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const html = readIndex();

check('every inline <script> parses as valid JavaScript', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(blocks.length > 0, 'no inline scripts found');
  blocks.forEach((b, n) => {
    try { new vm.Script(b[1], { filename: `inline-script-${n}` }); }
    catch (e) { throw new Error(`inline script #${n} failed to parse: ${e.message}`); }
  });
});

check('the document parses without unclosed tags', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html);
  assert(dom.window.document.querySelector('#view-app'), '#view-app missing after parse');
  assert(dom.window.document.querySelector('#domainGrid'), '#domainGrid missing after parse');
  assert(dom.window.document.querySelectorAll('.mesh-blob').length >= 4,
    `expected at least 4 mesh blobs, found ${dom.window.document.querySelectorAll('.mesh-blob').length}`);
});

check('every onclick handler names a function that exists', () => {
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(html).window.document;
  const defined = new Set([...html.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  [...html.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].forEach(m => defined.add(m[1]));
  const builtins = new Set(['history', 'window', 'document', 'event', 'this', 'alert', 'console', 'location']);
  const missing = new Set();
  doc.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]').forEach(el => {
    for (const attr of ['onclick', 'onchange', 'oninput', 'onsubmit']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      // (?<![.\w$]) so `history.back()` / `el.click()` are read as method calls
      // on an object, not as bare global functions we are expected to declare.
      for (const m of v.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const fn = m[1];
        if (!defined.has(fn) && !builtins.has(fn) && !/^(if|for|while|return|typeof|new|catch|switch)$/.test(fn)) missing.add(fn);
      }
    }
  });
  assert(missing.size === 0, `handlers reference undefined functions: ${[...missing].join(', ')}`);
});

check('no stale references to the removed domain keys remain', () => {
  const stale = [];
  for (const k of ['forestry', 'agric']) {
    // legitimate mentions: the DOMAIN_ALIASES migration table and its comment
    const hits = [...html.matchAll(new RegExp(`data-domain="${k}"`, 'g'))];
    if (hits.length) stale.push(`data-domain="${k}" still styled/used`);
  }
  assert(!stale.length, stale.join('; '));
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  integrity: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
