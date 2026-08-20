'use strict';
// Runs the Android patch scripts in scripts/ instead of only parsing them.
//
// ══ WHY ══
// Two bugs shipped to CI in one change, and npm test was green for both:
//   * patch_plotpack_association() used _re without the function-local
//     `import re as _re` that every other patcher in that file does. A
//     NameError, invisible until the workflow ran.
//   * its idempotence guard still tested for "vnd.plotedge.project", left over
//     from the .pteg -> .plotpack rename, so a second run appended a duplicate
//     set of intent-filters.
// Neither is findable by reading. Both die instantly the moment the function is
// called with a realistic manifest, which is all this file does.
//
// The Java half is checked differently: there is no JDK here, so instead of
// compiling it, this cross-references every R.id.* the generated provider
// references against the ids the generated layouts actually declare. That is the
// exact shape of the mistake nearly made when the widget started reading its
// colours from the app theme — R.id.widget_eyebrow was used before the TextView
// had an android:id, which is a compile error in CI and nothing at all here.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: (e.message || String(e)).split('\n').slice(0, 6).join('\n        ') }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// Runs a snippet with the patch module already imported as `pm`.
function py(script) {
  const harness = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pm", ${JSON.stringify(path.join(ROOT, 'scripts/patch-android-manifest.py'))})
pm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pm)
${script}
`;
  return execFileSync('python3', ['-c', harness], { encoding: 'utf8', cwd: ROOT });
}

// What `npx cap add android` actually generates, trimmed to what the patchers touch.
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:allowBackup="true" android:label="@string/app_name">
        <activity
            android:configChanges="orientation|keyboardHidden"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

check('every patch script imports without error', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter(n => n.endsWith('.py'))) {
    execFileSync('python3', ['-c',
      `import importlib.util;s=importlib.util.spec_from_file_location("m",${JSON.stringify(path.join(ROOT, 'scripts', f))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)`
    ], { cwd: ROOT, stdio: 'pipe' });
  }
});

check('the .plotpack association actually runs against a real manifest', () => {
  // The NameError check. Nothing subtle — it just has to be CALLED.
  const out = py(`
xml = ${JSON.stringify(MANIFEST)}
print(json.dumps(pm.patch_plotpack_association(xml)))`).trim().split('\n').pop();
  const patched = JSON.parse(out);
  assert(patched.includes('vnd.plotedge.plotpack+zip'), 'the MIME filter was not added');
  assert(patched.includes('.plotpack'), 'no .plotpack pathPattern');
});

check('it adds all three filters, and keeps the launcher one', () => {
  const patched = JSON.parse(py(`
print(json.dumps(pm.patch_plotpack_association(${JSON.stringify(MANIFEST)})))`).trim().split('\n').pop());
  // MAIN/LAUNCHER plus the three VIEW filters. Android matches a file's type
  // from three different sources and none is reliable alone, hence three.
  assert((patched.match(/<intent-filter/g) || []).length === 4,
    `expected 4 intent-filters, got ${(patched.match(/<intent-filter/g) || []).length}`);
  assert(patched.includes('android.intent.category.LAUNCHER'),
    'the launcher filter was destroyed — the app would vanish from the home screen');
  assert(patched.indexOf('</activity>') > patched.indexOf('vnd.plotedge'),
    'the filters landed outside the <activity> they belong to');
});

check('running it twice does not duplicate the filters', () => {
  // The guard bug. The workflow runs it once, so only a re-run or a local
  // invocation would have exposed this.
  const twice = JSON.parse(py(`
a = pm.patch_plotpack_association(${JSON.stringify(MANIFEST)})
b = pm.patch_plotpack_association(a)
print(json.dumps([a, b]))`).trim().split('\n').pop());
  assert(twice[0] === twice[1], 'a second run changed the manifest again');
  assert((twice[1].match(/<intent-filter/g) || []).length === 4, 'the second run duplicated filters');
});

check('a manifest with no MainActivity is skipped, not corrupted', () => {
  const out = JSON.parse(py(`
print(json.dumps(pm.patch_plotpack_association("<manifest><application></application></manifest>")))`)
    .trim().split('\n').pop());
  assert(!out.includes('vnd.plotedge'), 'filters were attached with no activity to attach them to');
});

// ── the widget Java, without a JDK ──
const widgetSrc = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-widget.py'), 'utf8');

check('every R.id the widget Java uses is declared by a generated layout', () => {
  // No javac here, so this stands in for compiling. It catches exactly the
  // mistake nearly made when the widget began reading the app theme: referencing
  // R.id.widget_eyebrow before the TextView had an android:id.
  const used = new Set([...widgetSrc.matchAll(/R\.id\.([a-z0-9_]+)/g)].map(m => m[1]));
  const declared = new Set([...widgetSrc.matchAll(/android:id="@\+id\/([a-z0-9_]+)"/g)].map(m => m[1]));
  const missing = [...used].filter(id => !declared.has(id));
  assert(!missing.length,
    `these R.id names have no matching android:id in any layout, so the APK will not compile: ${missing.join(', ')}`);
});

check('the generated Java is bracket-balanced', () => {
  // A crude but effective guard on string-built source: an unbalanced brace in a
  // heredoc is a compile failure fifteen minutes into a CI run.
  const blocks = [...widgetSrc.matchAll(/"""([\s\S]*?)"""/g)].map(m => m[1]).filter(b => b.includes('class '));
  assert(blocks.length, 'no Java blocks found — has the script been restructured?');
  blocks.forEach((b, i) => {
    let depth = 0;
    for (const ch of b) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    assert(depth === 0, `Java block ${i + 1} is unbalanced by ${depth} brace(s)`);
  });
});

check('the home screen tiles are pushed an update rather than waiting for their tick', () => {
  // ══ THE "WIDGETS ARE NOT CHANGING" BUG ══
  // The tiles read their numbers from SharedPreferences, which publishWidgetSummary() rewrites on
  // every save — so the DATA was never stale. What was stale was the drawn tile: a widget only
  // redraws on its own tick, and Android clamps that to a 30-minute floor. Switch project and the
  // tile kept the old project's name for up to half an hour.
  const ui = fs.readFileSync(path.join(ROOT, 'scripts/patch-android-ui.py'), 'utf8');
  assert(/registerOnSharedPreferenceChangeListener/.test(ui),
    'nothing listens for the widget mirror being written, so the tiles still wait for their tick');
  assert(/CapacitorStorage/.test(ui),
    'the listener is not attached to the file Capacitor Preferences actually writes');
  assert(/PlotEdgeWidget\.refreshAll/.test(ui),
    'the listener does not push a redraw to the tiles');
  // SharedPreferences holds only a WEAK reference to its listeners. Registered without a strong
  // reference held somewhere, it is collected at the next GC and the widget silently goes stale
  // again — a failure that looks exactly like the bug being fixed.
  assert(/widgetMirrorListener\s*=\s*null|private SharedPreferences\.OnSharedPreferenceChangeListener/.test(ui),
    'the listener is not held in a field, so it will be garbage collected');

  assert(/public static void refreshAll/.test(widgetSrc),
    'there is no single redraw path, so the two tile sizes can drift apart');
  // The 2x1 tile shipped with no way to be refreshed at all.
  assert(/R\.id\.widget_small_refresh\b/.test(widgetSrc),
    'the small tile still has no refresh affordance');
});

check('the native bridge degrades to nothing rather than to an error', () => {
  // js/21b-plotalert.js runs in three shells: the APK, an installed PWA and a plain browser tab.
  // Only the first has PlotEdgeNative, so every reach for it has to be a feature detection.
  const alerts = fs.readFileSync(path.join(ROOT, 'js/21b-plotalert.js'), 'utf8');
  assert(/window\.PlotEdgeNative/.test(alerts), 'the native bridge is never looked for');
  assert(/typeof Notification === 'undefined'/.test(alerts),
    'the web path assumes the Notification API exists');
  // Policy must not be entangled with delivery — see plotalertPending().
  assert(/function plotalertPending/.test(alerts),
    'the decision about what to report is fused to the code that sends it');
});


check('the theme applier is wired into both widget sizes', () => {
  // The large and small widgets are rendered by separate methods. Theming one
  // and forgetting the other gives a home screen where the two tiles disagree.
  assert(/applyTheme\(v, summary\.theme/.test(widgetSrc), 'the large widget does not apply the theme');
  assert(/applyTheme\(v, s\.theme/.test(widgetSrc), 'the small widget does not apply the theme');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  android-patch: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
