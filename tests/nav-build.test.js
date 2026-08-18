'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readIndex, ROOT } = require('./lib');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const html = readIndex();

// ══════════════════ NAVIGATION / BACK BUTTON ══════════════════
const BEGIN = '// ══ NAV:BEGIN ══', END = '// ══ NAV:END ══';
const i = html.indexOf(BEGIN), j = html.indexOf(END);
if (i === -1 || j === -1) {
  results.push({ name: 'nav block is extractable for testing', ok: false, msg: 'NAV:BEGIN/NAV:END sentinels not found' });
} else {
  results.push({ name: 'nav block is extractable for testing', ok: true });
  const src = html.slice(i, j);

  // Minimal history stack that behaves like the browser's for our purposes.
  function boot() {
    const stack = [{ screen: 'projects' }];
    let idx = 0;
    const ctx = {
      console, JSON, Object, Math, Date,
      history: {
        get state() { return stack[idx]; },
        get length() { return idx + 1; },
        pushState(s) { stack.length = idx + 1; stack.push(s); idx++; },
        replaceState(s) { stack[idx] = s; },
        back() { if (idx > 0) { idx--; ctx._onpop(stack[idx]); } }
      },
      _stack: stack,
      _idx: () => idx,
      showToast: () => {},
      _onpop: () => {},
      activeProjectId: 'p1',
      projects: [{ id: 'p1' }],
      currentTab: null,
      // Mirrors what the real switchTab() does, so the "already on this tab"
      // check is exercised rather than being masked by the push dedupe.
      switchTab(n) { ctx.currentTab = n; ctx.noteCurrentTab(n); },
      openProject() {},
      showProjects() {},
      suppressNavPush: false
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'nav-block' });
    return ctx;
  }

  check('re-tapping the tab you are already on does not stack a history stop', () => {
    const ctx = boot();
    ctx.switchTabNav('collect');
    const depth = ctx._idx();
    ctx.switchTabNav('collect');
    ctx.switchTabNav('collect');
    assert(ctx._idx() === depth,
      `three taps on Collect left ${ctx._idx() - depth + 1} stops — Back would need that many presses to move one screen`);
  });

  check('one Back press moves one screen after a realistic tab tour', () => {
    const ctx = boot();
    ctx.switchTabNav('collect');
    ctx.switchTabNav('collect');   // stray double-tap, very easy on a field device
    ctx.switchTabNav('review');
    ctx.switchTabNav('review');
    let landed = null;
    ctx._onpop = st => { landed = st; };
    ctx.history.back();
    assert(landed && landed.tab === 'collect', `first Back landed on ${landed && landed.tab} — expected collect`);
    ctx.history.back();
    assert(landed && landed.screen === 'projects', `second Back landed on ${JSON.stringify(landed)} — expected the projects root`);
  });

  check('pushNavState refuses to duplicate the state already on top', () => {
    const ctx = boot();
    ctx.pushNavState('app', { projectId: 'p1', tab: 'export' });
    const d = ctx._idx();
    ctx.pushNavState('app', { projectId: 'p1', tab: 'export' });
    assert(ctx._idx() === d, 'an identical consecutive history stop was pushed');
  });

  check('a real screen change still pushes', () => {
    const ctx = boot();
    const d = ctx._idx();
    ctx.pushNavState('app', { projectId: 'p1', tab: 'import' });
    assert(ctx._idx() === d + 1, 'a genuine navigation was swallowed by the dedupe');
  });

  check('the same-tab check works even when the stop differs (KPI card re-entry)', () => {
    // A dashboard KPI card calls switchTabNav('review') then changes the view
    // mode. Tapping two different cards that both land on Review must not leave
    // two stops behind, even though the push-dedupe alone would not catch a
    // caller that varied the extra fields.
    const ctx = boot();
    ctx.switchTabNav('review');
    const depth = ctx._idx();
    ctx.switchTabNav('review');
    assert(ctx.getCurrentTab() === 'review', 'current tab was not tracked');
    assert(ctx._idx() === depth, 'a second stop was recorded for a tab already open');
  });

  check('the landing screen is reachable once projects exist', () => {
    // renderProjectsScreen() routes past #view-projects to the Project Manager the moment one
    // project exists, so the home screen — and the three primary actions on it — became
    // unreachable after first use. showLanding() forces it regardless of count.
    assert(/function showLanding\(\)/.test(html), 'no showLanding() route');
    assert(/function renderLandingScreen\(\)[\s\S]{0,400}activateView\('view-projects'\)/.test(html),
      'renderLandingScreen does not force the landing view');
    const entries = (html.match(/onclick="showLanding\(\)"/g) || []).length;
    assert(entries >= 3, `only ${entries} way(s) into the landing screen — expected the app header, Data hub and Project Manager`);
  });

  check('Back replays the landing stop instead of falling through', () => {
    assert(/st\.screen === 'landing'[\s\S]{0,120}renderLandingScreen\(\)/.test(html),
      'popstate has no handler for the landing stop, so Back would skip past it');
    assert(/pushNavState\('landing'\)/.test(html), 'showLanding does not record a history stop');
  });

  check('the landing texture is scoped to the landing screen only', () => {
    assert(/#view-projects::before/.test(html), 'no landing texture');
    assert(/--contour-tile:\s*url\("data:image\/svg\+xml/.test(html), 'contour tile is not inlined');
    // It must not leak onto any other view, and must never eat a tap.
    const rule = html.slice(html.indexOf('#view-projects::before'), html.indexOf('#view-projects::before') + 600);
    assert(/pointer-events:\s*none/.test(rule), 'the texture can intercept taps');
    assert(/mask-image/.test(rule), 'the texture is not masked, so it cannot follow the accent');
    assert(/html\[data-contrast="high"\] #view-projects::before \{ display: none/.test(html),
      'the texture survives outdoor high-contrast mode, where all decoration should be stripped');
  });

  check('back arrow and hardware Back run the same code path', () => {
    assert(/function headerBackTap[\s\S]{0,600}appBack\(\)/.test(html) || /headerBackTap\s*=\s*appBack/.test(html),
      'the header arrow does not delegate to the shared back handler');
    assert(/addListener\('backButton'[\s\S]{0,400}appBack\(\)/.test(html),
      'the Android hardware button does not delegate to the shared back handler');
  });

  check('an invisible overlay cannot swallow a Back press', () => {
    // .show on an element that is display:none / not connected used to make
    // closeTopOverlay() return true and eat the press with nothing visible.
    assert(/function isReallyOpen|offsetParent|checkVisibility/.test(html),
      'closeTopOverlay() trusts the .show class alone, with no visibility check');
  });
}

// ══════════════════ ANDROID PACKAGING ══════════════════
// The workflow is created on GitHub rather than shipped in the archive (macOS
// hides dot-paths and Archive Utility drops them), so a fresh local checkout may
// not have it yet. These checks then skip rather than fail — they still run in
// CI, which is the only place the workflow actually matters.
const WF_PATH = path.join(ROOT, '.github/workflows/build-apk.yml');
const haveWf = fs.existsSync(WF_PATH);
const wf = haveWf ? fs.readFileSync(WF_PATH, 'utf8') : '';
function checkCI(name, fn) {
  if (!haveWf) { results.push({ name, ok: true, skipped: true }); return; }
  check(name, fn);
}

// ══ EVERY PATCH SCRIPT MUST ACTUALLY BE RUN ══
// The widget shipped broken for exactly this reason: scripts/patch-android-widget.py existed,
// worked, and was documented in BUILD_APK.md as a workflow step — but the step was never added
// to build-apk.yml. Nothing failed. The APK just came out with no <receiver>, so the launcher's
// widget picker had nothing to list and the feature looked like it had never been built.
// A script in scripts/ that no step calls is dead code at best and a missing feature at worst,
// so the check is on the directory rather than on a hand-written list that can drift the same way.
checkCI('every patch script in scripts/ is invoked by the workflow', () => {
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.py'));
  const never = scripts.filter(s => !wf.includes('scripts/' + s));
  assert(!never.length,
    `scripts/ contains patch scripts the workflow never runs, so their output never reaches the APK: ${never.join(', ')}`);
});

checkCI('the home screen widget provider is built into the APK', () => {
  assert(/patch-android-widget\.py/.test(wf),
    'workflow never runs the widget patch — no appwidget-provider is declared, so the launcher cannot list the widget');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-widget.py'), 'utf8');
  // The three things whose absence makes the widget invisible rather than merely ugly.
  assert(/android\.appwidget\.provider/.test(src), 'the script does not declare the provider meta-data');
  assert(/APPWIDGET_UPDATE/.test(src), 'the receiver has no APPWIDGET_UPDATE filter, so the system never binds it');
  assert(/android:exported="true"/.test(src),
    'the receiver is not exported — AppWidgetService runs in another process and could not deliver to it');
  // aapt fails outright on an unresolved @string, so the script must write these too.
  assert(/plotedge_widget_label/.test(src) && /plotedge_widget_description/.test(src),
    'the widget label/description strings are never written, so @string references would fail to resolve');
});

checkCI('APK is signed with a stable key across builds', () => {
  // Without this every CI run generates a fresh ~/.android/debug.keystore, so
  // each APK has a different signature. Android then refuses an in-place update
  // and the only way in is uninstall+reinstall, which deletes app data.
  assert(/patch-android-signing\.py/.test(wf), 'workflow never runs the signing patch');
  assert(/ANDROID_KEYSTORE_B64|plotedge-release\.keystore|plotedge\.jks/.test(wf), 'workflow has no persistent keystore source');
  assert(fs.existsSync(path.join(ROOT, 'scripts/patch-android-signing.py')), 'scripts/patch-android-signing.py missing');
});

check('signing patch applies the stable key to the build type that is shipped', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-signing.py'), 'utf8');
  assert(/signingConfigs/.test(s), 'no signingConfigs block injected');
  assert(/debug\s*\{[\s\S]{0,400}signingConfig/.test(s) || /buildTypes[\s\S]{0,800}signingConfig/.test(s),
    'the shipped build type does not reference the stable signing config');
});

checkCI('versionCode increments per build so Android sees a real update', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-signing.py'), 'utf8');
  assert(/versionCode/.test(s), 'versionCode is never rewritten — every build stays at 1');
  assert(/run_number|GITHUB_RUN_NUMBER|PLOTEDGE_VERSION_CODE/.test(wf + s), 'versionCode is not derived from the build number');
});

check('versionCode survives the repo being deleted and recreated', () => {
  // GITHUB_RUN_NUMBER only counts up within ONE repo. A fresh repo restarts at 1 while the phone
  // still holds the old APK at a higher number, so Android reads the new build as a downgrade and
  // refuses to install — and the obvious workaround, uninstalling, destroys every capture on the
  // device. The run number therefore has to be an offset above a floor, never the version itself.
  const s = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-signing.py'), 'utf8');
  assert(/VERSION_CODE_FLOOR/.test(s), 'no floor — a recreated repo would emit versionCode 1 and fail to install over the existing app');
  const m = s.match(/VERSION_CODE_FLOOR\s*=\s*(\d+)/);
  assert(m && +m[1] >= 100, 'the floor is too low to clear a previous repo\'s run count');
  assert(/VERSION_CODE_FLOOR\s*\+\s*int\(run\)/.test(s), 'the run number is not added to the floor, so builds would not increment');
});

check('app data is included in Android auto-backup', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-manifest.py'), 'utf8');
  assert(/allowBackup/.test(s), 'android:allowBackup is never set, so device transfer/restore skips the survey data');
});

checkCI('the build fails loudly rather than shipping an unsignable APK', () => {
  assert(/exit 1|::error|set -e/.test(wf), 'no failure path if the keystore cannot be resolved');
});

// ══════════════════ TAP TARGETS & OVERLAY ROLL CALL ══════════════════
// Both guards below exist because the same bug shipped twice in different forms: something was
// declared correct in one file and quietly cancelled in another, and nothing failed.

// Comments are stripped before any of this is matched. These stylesheets are heavily commented and
// the comments name the very selectors being searched for, so an unstripped match happily lands in
// a paragraph of prose about a rule instead of on the rule.
const navCss = ['css/01-tokens.css','css/02-mesh.css','css/03-base.css','css/05-components.css','css/10-quick-actions.css']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const navJsNav = fs.readFileSync(path.join(ROOT, 'js/07-navigation.js'), 'utf8');

// Selectors given overflow:hidden so the universal ripple stays inside them.
function rippleClippedSelectors(css) {
  const m = css.match(/([^{}]*)\{\s*position:relative;\s*overflow:hidden;\s*\}/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(s => s.startsWith('.'));
}
// Selectors relying on a ::before to enlarge their hit area.
function hitExpandedSelectors(css) {
  const out = [];
  const re = /([^{}]*)::before\s*\{[^}]*content:''[^}]*position:absolute[^}]*width:(\d+)px[^}]*\}/g;
  let m;
  while ((m = re.exec(css))) {
    m[1].split(',').map(s => s.trim().replace(/::before$/, ''))
      .filter(s => s.startsWith('.')).forEach(s => out.push(s));
  }
  return out;
}

check('no button relies on a hit area that overflow:hidden throws away', () => {
  const clipped = new Set(rippleClippedSelectors(navCss).map(s => s.split(/\s+/).pop()));
  const expanded = hitExpandedSelectors(navCss).map(s => s.split(/\s+/).pop());
  const broken = [...new Set(expanded.filter(s => clipped.has(s)))];
  // A ::before that extends past its host is clipped by overflow:hidden, and clipping removes it
  // from hit testing as well as from paint — so the "expanded" target is silently the icon's own
  // box. This is how .icon-back ended up advertising 44x44 and delivering 32x32.
  assert(broken.length === 0,
    `these have a ::before hit area that is clipped away by the ripple's overflow:hidden, so it does nothing: ${broken.join(', ')}`);
});

check('header controls meet a real minimum tap size', () => {
  // Declared sizes, read from CSS rather than measured: jsdom has no layout, and the failure being
  // guarded against is a declaration being wrong, not a layout engine disagreeing about it.
  const want = { '.icon-back': 44, '.pill-icon-btn': 40 };
  for (const [sel, min] of Object.entries(want)) {
    // Match only a rule that actually declares a width, not the first rule that merely mentions the
    // selector — the ripple's shared `position:relative;overflow:hidden` block lists .icon-back too,
    // and matching that one made this test report "?px" for a button that was correctly sized.
    const re = new RegExp('(?:^|,|\\})\\s*[^{}]*\\' + sel + '[^{}]*\\{([^}]*[;{\\s]width:\\d+px[^}]*)\\}', 'm');
    const rule = navCss.match(re);
    assert(rule, `${sel} has no rule declaring a width`);
    // Anchored so `width:` cannot match inside `min-width:` / `max-width:`, which is how a 40px
    // min-width was read as the declared width of a 44px button.
    const w = /(?:^|[;{\s])width:(\d+)px/.exec(rule[1]);
    const h = /(?:^|[;{\s])height:(\d+)px/.exec(rule[1]);
    assert(w && Number(w[1]) >= min, `${sel} is ${w ? w[1] : '?'}px wide, want >= ${min}`);
    assert(h && Number(h[1]) >= min, `${sel} is ${h ? h[1] : '?'}px tall, want >= ${min}`);
  }
});

check('no inline width/height override shrinks a header icon button below 40px', () => {
  // The back arrow's class said 36px and an inline style said 32px. Inline wins, and it is the one
  // place a reviewer reading the stylesheet would never look.
  const bad = [];
  const re = /<button[^>]*class="([^"]*(?:icon-back|pill-icon-btn|contrast-toggle|settings-gear|home-btn)[^"]*)"[^>]*style="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const size = /(?:width|height):(\d+)px/.exec(m[2]);
    if (size && Number(size[1]) < 40) bad.push(`${m[1].trim()} -> ${size[0]}`);
  }
  assert(bad.length === 0, `inline styles shrink these below 40px: ${bad.join('; ')}`);
});

check('every bottom sheet is handled by the back button', () => {
  // closeTopOverlay() is a hand-maintained roll call with a catch-all at the end, so a missing
  // sheet still closes and Back does not escape past it. What the catch-all cannot do is run that
  // sheet's OWN close function — the draft discard, the keyboard dismiss, the index reset. So a
  // sheet missing from this list closes visually while leaving its state half-torn-down.
  // PlotVault and ftSubfieldModal were both missing, which is what prompted this test.
  const body = navJsNav.slice(navJsNav.indexOf('function closeTopOverlay'));
  const ids = [];
  const re = /<div class="modal-overlay"[^>]*id="([A-Za-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  // Sheets deliberately outside the Back stack: these are opened only from inside another sheet
  // that already closes first, or are non-dismissable by design.
  const exempt = new Set(['customizeQaModal']);
  const missing = ids.filter(id => !exempt.has(id) && !body.includes(`'${id}'`));
  assert(missing.length === 0,
    `these sheets are not in closeTopOverlay(), so Back closes them via the catch-all without running their cleanup: ${missing.join(', ')}`);
});

check('an icon inside a text input cannot be overrun by a blanket input rule', () => {
  // .qa-search-wrap and .pm-search both place an absolutely-positioned icon over a text field and
  // rely on left padding to keep the text clear of it. That padding competes with the stylesheet's
  // blanket `input[type="text"], ... { padding:13px 14px }`, which is (0,1,1) — the same weight as
  // a bare `.wrap input` — and sits later in source order, so it wins and the placeholder lands
  // underneath the icon. Adding [type="text"] to the scoped rule lifts it to (0,2,1).
  // Both fields have now hit this; the check exists so the third one fails here instead of on a
  // handset.
  const wraps = ['.qa-search-wrap', '.pm-search'];
  for (const wrap of wraps) {
    const bare = new RegExp('\\' + wrap + '\\s+input\\s*\\{[^}]*padding', 'm');
    assert(!bare.test(navCss),
      `${wrap} sets padding via a bare "input" selector, which the generic input[type="text"] rule outranks by source order — add [type="text"] to it`);
    const scoped = new RegExp('\\' + wrap + '\\s+input\\[type="text"\\]\\s*\\{([^}]*)\\}', 'm');
    const m = navCss.match(scoped);
    assert(m, `${wrap} has no input[type="text"] padding rule at all`);
    assert(/padding:\s*\d+px\s+\d+px\s+\d+px\s+(\d+)px/.test(m[1]),
      `${wrap} needs an explicit four-value padding so the icon clearance is visible in the rule`);
    const px = Number(/padding:\s*\d+px\s+\d+px\s+\d+px\s+(\d+)px/.exec(m[1])[1]);
    // Icon sits at left:13px and is 15px wide, so anything under ~30px overlaps the text.
    assert(px >= 30, `${wrap} left padding is ${px}px — too small to clear the icon`);
  }
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.skipped ? '  SKIP' : r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  nav+build: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
