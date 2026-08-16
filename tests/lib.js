'use strict';
const fs = require('fs');
const path = require('path');

// Walk up from tests/ until index.html turns up, so the suite runs the same
// whether it is invoked as `npm test` from the repo root or directly by path.
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate index.html above ' + start);
}
const ROOT = findRoot(path.join(__dirname, '..'));
const INDEX = path.join(ROOT, 'index.html');

// ══ THE APP IS NOW A TREE, NOT A FILE ══
// The suites were written against a single index.html and check CSS rules and JS
// bodies by searching that text. Rather than rewrite every assertion, this
// rebuilds the equivalent whole-app source by concatenating index.html with every
// stylesheet and script it references, IN THE ORDER IT REFERENCES THEM. So the
// tests still see one document, but one assembled from the real tree — meaning a
// file that exists but is never linked is invisible to them, exactly as it would
// be to the browser.
function readIndex() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const grab = (re, dir) => [...html.matchAll(re)]
    .map(m => path.join(ROOT, dir, m[1]))
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const css = grab(/<link rel="stylesheet" href="css\/([^"]+)">/g, 'css');
  const js = grab(/<script src="js\/([^"]+)"><\/script>/g, 'js');
  // Wrapped so the tags the suites look for (<style>, <script>) are still present.
  return html + '\n<style>\n' + css + '\n</style>\n<script>\n' + js + '\n</script>\n';
}
// The raw shell, for tests that care about index.html itself rather than the app.
function readShell() { return fs.readFileSync(INDEX, 'utf8'); }
// Ordered lists of the real files, for tests about the split itself.
function appFiles() {
  const html = fs.readFileSync(INDEX, 'utf8');
  return {
    css: [...html.matchAll(/<link rel="stylesheet" href="css\/([^"]+)">/g)].map(m => m[1]),
    js: [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1])
  };
}

// ── colour maths ───────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}
function relLum(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// sRGB -> OKLab -> OKLCh. Used for perceptual hue separation between themes;
// plain RGB distance says #22C55E and #A3E635 are far apart when the eye says
// "two greens", which is exactly the bug being tested for.
function oklch(hex) {
  let [r, g, b] = hexToRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  let H = Math.atan2(B, A) * 180 / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.sqrt(A * A + B * B), h: H };
}
function hueGap(a, b) {
  const d = Math.abs(oklch(a).h - oklch(b).h) % 360;
  return d > 180 ? 360 - d : d;
}
// Perceived difference of two flat colours filling the screen.
function deltaEok(a, b) {
  const x = oklch(a), y = oklch(b);
  const ax = x.C * Math.cos(x.h * Math.PI / 180), ay = y.C * Math.cos(y.h * Math.PI / 180);
  const bx = x.C * Math.sin(x.h * Math.PI / 180), by = y.C * Math.sin(y.h * Math.PI / 180);
  return Math.sqrt((x.L - y.L) ** 2 + (ax - ay) ** 2 + (bx - by) ** 2);
}

// ── CSS block extraction ───────────────────────────────────────────────────
// Pulls the declarations out of a `html[data-domain="x"]...{ }` rule so the
// tests read the same source of truth the browser does, rather than a
// duplicated table that can drift out of sync with the stylesheet.
function ruleBody(css, selector) {
  const i = css.indexOf(selector + ' {');
  const j = i === -1 ? css.indexOf(selector + '{') : i;
  if (j === -1) return null;
  const open = css.indexOf('{', j);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
function decls(body) {
  const out = {};
  if (!body) return out;
  // strip comments first so a hex inside /* ... */ can't be read as a value
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const part of clean.split(';')) {
    const m = part.match(/(--[a-z0-9-]+)\s*:\s*([^;]+)/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
function domainTokens(css, domain, mode) {
  const sel = mode === 'light'
    ? `html[data-domain="${domain}"][data-theme="light"]`
    : `html[data-domain="${domain}"]`;
  return decls(ruleBody(css, sel));
}

// ── screen compositing ────────────────────────────────────────────────────
// The eye does not see --glow-1; it sees glow-1 blended over the canvas at the
// blob's opacity, times the mesh layer's opacity, under whatever blend mode the
// theme uses. Comparing raw tokens is why two pillars could pass a hue test and
// still look alike on a phone. This reproduces the actual paint.
function srgbToLin(v) { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function linToSrgb(v) { const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, s)) * 255); }
function toHex(rgb) { return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''); }

// Blend a blob over a base. `screen` lightens (glowing light on a dark canvas);
// `multiply` darkens (pigment on a light canvas). Both done in linear light,
// which is where the browser composites.
function blend(base, blob, alpha, mode) {
  const b = hexToRgb(base).map(srgbToLin);
  const s = hexToRgb(blob).map(srgbToLin);
  const mixed = b.map((bv, i) => mode === 'multiply' ? bv * s[i] : 1 - (1 - bv) * (1 - s[i]));
  return toHex(b.map((bv, i) => linToSrgb(bv * (1 - alpha) + mixed[i] * alpha)));
}

// Blob layout and strengths mirror the .mesh-blob rules in index.html. Sampled
// where each blob is densest, plus a centre point where all four overlap
// weakly — the five places a thumb actually covers.
// Blob layout and strengths mirror the .mesh-blob rules in index.html. Sampled
// where each blob is densest, plus a centre point where all four overlap
// weakly — the five places a thumb actually covers.
// Peaks are per-mode and deliberately lower than a plain alpha stack would need:
// under `screen`/`multiply` a blob pushes the canvas much further per unit of
// alpha, and letting one reach mid-luminance is exactly what makes a label
// vanish in sun.
const BLOB_LAYOUT = [
  { token: '--glow-1', peak: { dark: 0.42, light: 0.34 }, at: 'top-left' },
  { token: '--glow-2', peak: { dark: 0.38, light: 0.30 }, at: 'bottom-right' },
  { token: '--glow-3', peak: { dark: 0.18, light: 0.16 }, at: 'top-right' },
  { token: '--glow-4', peak: { dark: 0.20, light: 0.16 }, at: 'centre-left' }
];
function meshLayerOpacity(mode) { return mode === 'light' ? 0.86 : 0.80; }

// Returns the composited colour at each sample point for one pillar.
function compositeScreen(tokens, mode) {
  const blendMode = mode === 'light' ? 'multiply' : 'screen';
  const layer = meshLayerOpacity(mode);
  const canvasA = tokens['--grad-1'], canvasB = tokens['--grad-2'];
  const glow = t => t === '--glow-3' ? tokens['--accent-primary'] : tokens[t];
  const out = {};
  for (const b of BLOB_LAYOUT) {
    // Top half of the screen sits nearer --grad-1, bottom half nearer --grad-2.
    const base = (b.at === 'bottom-right' || b.at === 'centre-left') ? canvasB : canvasA;
    out[b.at] = blend(base, glow(b.token), b.peak[mode] * layer, blendMode);
  }
  // Centre: every blob's tail, roughly a quarter strength each, applied in order.
  let c = canvasA;
  for (const b of BLOB_LAYOUT) c = blend(c, glow(b.token), b.peak[mode] * layer * 0.25, blendMode);
  out.centre = c;
  return out;
}

// Worst-case text legibility across the whole background of one pillar.
function worstTextContrast(tokens, mode, textColor) {
  const samples = compositeScreen(tokens, mode);
  let worst = Infinity, where = null;
  for (const [k, v] of Object.entries(samples)) {
    const r = contrast(v, textColor);
    if (r < worst) { worst = r; where = `${k} (${v})`; }
  }
  return { ratio: worst, where };
}

// How different two pillars look on screen: the average separation across all
// sample points, so a pillar cannot pass on one loud corner alone.
function screenSeparation(tokensA, tokensB, mode) {
  const a = compositeScreen(tokensA, mode), b = compositeScreen(tokensB, mode);
  const keys = Object.keys(a);
  const each = keys.map(k => deltaEok(a[k], b[k]));
  return { mean: each.reduce((s, v) => s + v, 0) / each.length, min: Math.min(...each), each, keys };
}

module.exports = { ROOT, INDEX, readIndex, readShell, appFiles, hexToRgb, relLum, contrast, oklch, hueGap, deltaEok, ruleBody, decls, domainTokens, blend, compositeScreen, worstTextContrast, screenSeparation, meshLayerOpacity, toHex };
