'use strict';
const { readIndex, contrast, hueGap, deltaEok, oklch, domainTokens, decls, ruleBody,
        compositeScreen, worstTextContrast, screenSeparation } = require('./lib');

const DOMAINS = ['land', 'water', 'climate', 'environment', 'people', 'geospatial'];
const LABELS = {
  land: 'Earth & Land', water: 'Water', climate: 'Climate',
  environment: 'Environment', people: 'People & Places', geospatial: 'Geospatial'
};
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const css = readIndex();

// ── 1. all six exist, in both modes ────────────────────────────────────────
check('six domains declared in CSS (dark + light)', () => {
  for (const d of DOMAINS) {
    assert(css.includes(`html[data-domain="${d}"] {`), `missing dark rule for ${d}`);
    assert(css.includes(`html[data-domain="${d}"][data-theme="light"] {`), `missing light rule for ${d}`);
  }
});

check('six domains declared in JS GIS_DOMAINS with the new names', () => {
  const body = css.slice(css.indexOf('const GIS_DOMAINS'), css.indexOf('const GIS_DOMAINS') + 1400);
  for (const d of DOMAINS) assert(new RegExp(`\\b${d}\\s*:`).test(body), `GIS_DOMAINS missing key ${d}`);
  for (const l of Object.values(LABELS)) assert(body.includes(l), `GIS_DOMAINS missing label "${l}"`);
});

check('legacy domain keys migrate instead of silently resetting', () => {
  assert(/DOMAIN_ALIASES/.test(css), 'no DOMAIN_ALIASES migration table');
  for (const old of ['default', 'forestry', 'agric', 'survey']) {
    assert(new RegExp(`${old}\\s*:\\s*'`).test(css.slice(css.indexOf('DOMAIN_ALIASES'), css.indexOf('DOMAIN_ALIASES') + 500)),
      `no migration for legacy key "${old}"`);
  }
});

check('settings picker offers exactly the six domains', () => {
  const grid = css.slice(css.indexOf('id="domainGrid"'), css.indexOf('id="domainGrid"') + 4000);
  const found = [...grid.matchAll(/class="domain-swatch" data-domain="([a-z]+)"/g)].map(m => m[1]);
  assert(found.length === 6, `expected 6 swatches, found ${found.length}: ${found}`);
  for (const d of DOMAINS) assert(found.includes(d), `picker missing ${d}`);
});

// ── 2. sunlight legibility: WCAG AA on the label the accent actually carries ─
for (const mode of ['dark', 'light']) {
  check(`[${mode}] accent/label contrast >= 4.5:1 in every domain`, () => {
    for (const d of DOMAINS) {
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const acc = t['--accent-primary'], on = t['--on-accent'];
      assert(acc && on, `${d}/${mode}: missing --accent-primary or --on-accent`);
      const r = contrast(acc, on);
      assert(r >= 4.5, `${d}/${mode}: ${acc} on ${on} = ${r.toFixed(2)}:1 (needs 4.5)`);
    }
  });
}

check('[light] accent is dark enough to hold its own against a white card', () => {
  // The light theme is the sunlight theme; an accent that only barely separates
  // from #FFFFFF disappears at high ambient brightness even when its label passes.
  for (const d of DOMAINS) {
    const t = domainTokens(css, d, 'light');
    const r = contrast(t['--accent-primary'], '#FFFFFF');
    assert(r >= 4.5, `${d}: accent ${t['--accent-primary']} vs white card = ${r.toFixed(2)}:1`);
  }
});

// ── 3. the actual reported bug: themes must look different from each other ──
for (const mode of ['dark', 'light']) {
  check(`[${mode}] every pair of domains is perceptually distinct (accent hue)`, () => {
    const fails = [];
    for (let i = 0; i < DOMAINS.length; i++) {
      for (let j = i + 1; j < DOMAINS.length; j++) {
        const a = { ...domainTokens(css, DOMAINS[i], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[i], 'light') : {}) }['--accent-primary'];
        const b = { ...domainTokens(css, DOMAINS[j], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[j], 'light') : {}) }['--accent-primary'];
        const gap = hueGap(a, b);
        if (gap < 25) fails.push(`${DOMAINS[i]}(${a}) vs ${DOMAINS[j]}(${b}) = ${gap.toFixed(1)}deg`);
      }
    }
    assert(!fails.length, `accent hues too close:\n    ${fails.join('\n    ')}`);
  });

  check(`[${mode}] every domain paints its own canvas, not a shared one`, () => {
    // This is what made theme switching invisible: light mode reset --grad-1/2
    // to the same #F8FAFC/#E7EEF5 for every domain, so the page base never moved.
    const seen = new Map();
    for (const d of DOMAINS) {
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const key = `${t['--grad-1']}|${t['--grad-2']}`;
      assert(t['--grad-1'] && t['--grad-2'], `${d}/${mode}: no canvas tokens`);
      assert(!seen.has(key), `${d} and ${seen.get(key)} share the same canvas ${key}`);
      seen.set(key, d);
    }
  });

  check(`[${mode}] canvas tint is actually perceivable between adjacent domains`, () => {
    const fails = [];
    for (let i = 0; i < DOMAINS.length; i++) {
      for (let j = i + 1; j < DOMAINS.length; j++) {
        const a = { ...domainTokens(css, DOMAINS[i], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[i], 'light') : {}) }['--grad-2'];
        const b = { ...domainTokens(css, DOMAINS[j], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[j], 'light') : {}) }['--grad-2'];
        const dE = deltaEok(a, b);
        if (dE < 0.012) fails.push(`${DOMAINS[i]}(${a}) vs ${DOMAINS[j]}(${b}) dEok=${dE.toFixed(4)}`);
      }
    }
    assert(!fails.length, `canvases indistinguishable:\n    ${fails.join('\n    ')}`);
  });
}

// ── the reported complaint: Water / Climate / Geospatial read as one ───────
for (const mode of ['dark', 'light']) {
  check(`[${mode}] no two pillars look alike as a rendered screen`, () => {
    // Compares the COMPOSITED background — canvas plus every blob at its real
    // opacity and blend mode — not the raw tokens. Water, Climate and Geospatial
    // passed a token-level hue test while still reading as one blue-purple
    // family on a phone, because the canvas dominates the screen area and all
    // three canvases were near-neutral.
    const fails = [];
    for (let i = 0; i < DOMAINS.length; i++) {
      for (let j = i + 1; j < DOMAINS.length; j++) {
        const ta = { ...domainTokens(css, DOMAINS[i], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[i], 'light') : {}) };
        const tb = { ...domainTokens(css, DOMAINS[j], 'dark'), ...(mode === 'light' ? domainTokens(css, DOMAINS[j], 'light') : {}) };
        const sep = screenSeparation(ta, tb, mode);
        if (sep.mean < 0.070) fails.push(`${DOMAINS[i]} vs ${DOMAINS[j]}: mean dEok ${sep.mean.toFixed(3)} (min ${sep.min.toFixed(3)})`);
      }
    }
    assert(!fails.length, `pillars render too similarly:\n    ${fails.join('\n    ')}`);
  });

  check(`[${mode}] every pillar's canvas carries a real tint`, () => {
    // A canvas within a hair of neutral means the pillar is expressed only by
    // small accented controls, which is how the palette became invisible in the
    // field. Geospatial is the deliberate exception: graphite IS its identity,
    // and it is separated by the graticule and its cyan instead.
    const weak = [];
    for (const d of DOMAINS) {
      if (d === 'geospatial') continue;
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const c = oklch(t['--grad-2']).C;
      if (c < 0.018) weak.push(`${d} --grad-2 ${t['--grad-2']} C=${c.toFixed(4)}`);
    }
    assert(!weak.length, `canvases too close to neutral to read as a theme:\n    ${weak.join('\n    ')}`);
  });
}

check('Geospatial stays deliberately achromatic where the others are tinted', () => {
  // Its separation comes from being the ONLY neutral one, plus the graticule.
  // If it ever drifts to a tinted canvas it becomes another blue theme.
  for (const mode of ['dark', 'light']) {
    const t = { ...domainTokens(css, 'geospatial', 'dark'), ...(mode === 'light' ? domainTokens(css, 'geospatial', 'light') : {}) };
    const c = oklch(t['--grad-2']).C;
    assert(c < 0.030, `geospatial/${mode} canvas ${t['--grad-2']} has chroma ${c.toFixed(4)} — it should read as graphite`);
  }
});

// ── sunlight legibility, both modes ────────────────────────────────────────
// Direct sun crushes low-contrast detail first, and a field device is held at
// arm's length. 4.5:1 is the indoor floor; these ask for 7:1 (WCAG AAA) against
// the worst point of the actual composited background, because the background
// is not a flat colour — a blob can pool exactly where a label sits.
for (const mode of ['dark', 'light']) {
  const textColor = mode === 'light' ? '#0F172A' : '#F8FAFC';
  check(`[${mode}] body text clears 7:1 against the worst point of the mesh`, () => {
    const fails = [];
    for (const d of DOMAINS) {
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const w = worstTextContrast(t, mode, textColor);
      if (w.ratio < 7) fails.push(`${d}: ${w.ratio.toFixed(2)}:1 at ${w.where}`);
    }
    assert(!fails.length, `text would wash out in sun:\n    ${fails.join('\n    ')}`);
  });

  check(`[${mode}] the accent stays findable against its own background (3:1)`, () => {
    // WCAG 1.4.11 for non-text UI. The capture button, GPS ring and active tab
    // all rely on the accent separating from whatever the mesh put behind them.
    const fails = [];
    for (const d of DOMAINS) {
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const samples = compositeScreen(t, mode);
      for (const [k, v] of Object.entries(samples)) {
        const r = contrast(t['--accent-primary'], v);
        if (r < 3) fails.push(`${d} @ ${k}: accent vs ${v} = ${r.toFixed(2)}:1`);
      }
    }
    assert(!fails.length, `accent disappears into the background:\n    ${fails.join('\n    ')}`);
  });
}

check('[light] mesh glows carry real chroma (not washed-out pastels)', () => {
  const weak = [];
  for (const d of DOMAINS) {
    // Geospatial is the exception on purpose: its mesh is graphite and slate,
    // and the chroma lives in the accent and the graticule instead. Being the
    // only neutral pillar is what separates it — see the test below, which
    // holds it to that rather than to this one.
    if (d === 'geospatial') continue;
    const t = domainTokens(css, d, 'light');
    for (const k of ['--glow-1', '--glow-2']) {
      const c = oklch(t[k]).C;
      if (c < 0.055) weak.push(`${d} ${k}=${t[k]} C=${c.toFixed(3)}`);
    }
  }
  assert(!weak.length, `glows too desaturated to read outdoors:\n    ${weak.join('\n    ')}`);
});

check('Geospatial carries its chroma in the accent, since its mesh is neutral', () => {
  for (const mode of ['dark', 'light']) {
    const t = { ...domainTokens(css, 'geospatial', 'dark'), ...(mode === 'light' ? domainTokens(css, 'geospatial', 'light') : {}) };
    const c = oklch(t['--accent-primary']).C;
    assert(c >= 0.070, `geospatial/${mode} accent ${t['--accent-primary']} C=${c.toFixed(3)} — with a graphite mesh, the accent is the only thing carrying the palette`);
  }
});

check('ambient mesh is multi-hue per domain (Apple-Music-style, not monochrome)', () => {
  for (const mode of ['dark', 'light']) {
    for (const d of DOMAINS) {
      const t = { ...domainTokens(css, d, 'dark'), ...(mode === 'light' ? domainTokens(css, d, 'light') : {}) };
      const gap = hueGap(t['--glow-1'], t['--glow-2']);
      assert(gap >= 12, `${d}/${mode}: glow-1 ${t['--glow-1']} and glow-2 ${t['--glow-2']} are the same hue (${gap.toFixed(1)}deg) — reads as a flat wash`);
    }
  }
});

check('the blend group is not isolated from the base gradient', () => {
  // opacity<1 or will-change:opacity on the .mesh-blobs wrapper creates a stacking
  // context, which isolates the blend group: the blobs then blend against that
  // wrapper's transparent backdrop instead of the gradient on .mesh-bg. Blending
  // with a fully transparent backdrop returns the source unchanged, so screen and
  // multiply both become no-ops and the mesh silently degrades to plain alpha —
  // while every test that models blending keeps passing.
  const wrapper = ruleBody(css, '  .mesh-blobs');
  assert(wrapper !== null, '.mesh-blobs rule not found');
  assert(!/opacity\s*:/.test(wrapper),
    '.mesh-blobs sets its own opacity, which isolates the blend group and makes mix-blend-mode inert');
  assert(!/will-change\s*:[^;]*opacity/.test(wrapper),
    '.mesh-blobs declares will-change:opacity, which also creates a stacking context');
});

check('screen intensity is applied per blob, and transitions', () => {
  assert(/@property\s+--mesh-i/.test(css), '--mesh-i is not registered, so the band would cut instead of fading');
  assert(/transition:\s*--mesh-i/.test(css), 'no transition on the intensity band');
  for (const band of ['home', 'form', 'settings', 'map']) {
    assert(new RegExp(`data-screen="${band}"\\]\\s*\\{[^}]*--mesh-i`).test(css),
      `no --mesh-i value for the "${band}" screen band`);
  }
  // Every blob, static and animated, must respect the multiplier — a keyframe that
  // sets a bare opacity would override the band entirely.
  const bareKeyframe = /@keyframes mesh-breathe-\d \{[^}]*opacity:\s*[\d.]+\s*;/.test(css);
  assert(!bareKeyframe, 'a breathe keyframe sets a fixed opacity, which overrides the screen band');
  assert((css.match(/opacity: calc\([\d.]+ \* var\(--mesh-i\)\)/g) || []).length >= 4,
    'not every blob scales its opacity by the intensity band');
});

check('every view declares an ambient band, so none can inherit a stale one', () => {
  // The band used to be set from four navigation entry points only, so most views simply kept
  // whatever the previous screen left on <html>. Leaving Collect (0.28) for the Data hub rendered
  // the hub at Collect's intensity; arriving from Review (0) left it flat. The gradient WAS
  // responding to the screen state — just not to the screen you were looking at.
  const views = [...new Set([...css.matchAll(/activateView\('([a-z-]+)'\)/g)].map(m => m[1]))];
  assert(views.length >= 10, `only found ${views.length} views to check`);
  const mapBlock = css.slice(css.indexOf('const VIEW_SCREEN_STATE'), css.indexOf('function activateView'));
  const missing = views.filter(v => v !== 'view-app' && !mapBlock.includes(`'${v}'`));
  assert(!missing.length, `views with no declared ambient band: ${missing.join(', ')}`);
  // view-app is the deliberate exception — its band follows the open tab.
  assert(/id === 'view-app'\)\s*switchTabScreenState/.test(css),
    'view-app does not derive its band from the active tab');
});

check('the band is applied in one place, not re-guessed by each caller', () => {
  // closePlotEtch() used to force 'home' on the way out, which changed the band while a confirm
  // dialog was still over PlotEtch and guessed wrong when returning to Collect or Review.
  const strays = [...css.matchAll(/setScreenState\('(\w+)'\)/g)].map(m => m[1]);
  // Only the settings modal legitimately sets a band directly: it is an overlay, not a view.
  const allowed = ['settings', 'map'];
  const bad = strays.filter(v => !allowed.includes(v));
  assert(!bad.length, `setScreenState called directly with ${bad.join(', ')} outside activateView()`);
});

check('a fourth mesh blob exists so the gradient reads as a field, not two smudges', () => {
  assert(/--glow-4/.test(css), 'no --glow-4 token');
  assert(/mesh-blob b4/.test(css), 'no .b4 blob element in the mesh markup');
});

// ── 4. per-screen washes must follow the domain, not a hardcoded cyan ──────
check('per-screen gradient tints follow the active domain', () => {
  const block = css.slice(css.indexOf('#view-projects'), css.indexOf('#view-projects') + 900);
  assert(!/--grad-tint2\s*:\s*14,165,233/.test(block),
    'per-screen rules still hardcode cyan for --grad-tint2, which overrides the domain palette on every screen');
});

// ── 5. theme changes must be visible when they happen ─────────────────────
check('switching domain plays a visible confirmation', () => {
  assert(/\.domain-bloom-layer/.test(css), 'no domain-bloom feedback animation on theme change');
  assert(/id="domainBloom"/.test(css), 'the bloom overlay element is missing from the markup');
  assert(/getElementById\('domainBloom'\)[\s\S]{0,400}classList\.add\('play'\)/.test(css),
    'setDomainTheme() never triggers the bloom overlay');
  // It must sit outside .mesh-bg, or it inherits that layer's z-index:-1 and the
  // map screen's zero opacity — invisible exactly where it is needed most.
  const meshStart = css.indexOf('class="mesh-bg"');
  const bloomAt = css.indexOf('id="domainBloom"');
  const between = css.slice(meshStart, bloomAt);
  assert((between.match(/<\/div>/g) || []).length >= 2,
    'the bloom overlay is nested inside .mesh-bg, where it would be suppressed on the map screen');
});

check('Geospatial gets the survey-grid treatment (techy)', () => {
  assert(/data-domain="geospatial"\][\s\S]{0,200}graticule|geospatial[\s\S]{0,300}--grain/.test(css),
    'geospatial domain does not apply the coordinate-grid texture');
});

// ── report ────────────────────────────────────────────────────────────────
module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  themes: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
