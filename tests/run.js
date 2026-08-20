'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// smoke.js runs last and is the only suite that BOOTS the app rather than
// reading it. It is slower than the rest put together, and it catches the one
// class of bug static analysis cannot see at all: a script that loads fine on
// its own and throws when loaded with the others.
// ══ PREFLIGHT ══
// Fails with a diagnosis rather than letting the first suite die on a bare
// ENOENT naming a path that is invisible in Finder.
//
// The dot-paths (.gitignore, .github/workflows/build-apk.yml) are deliberately
// NOT in this list. They are created directly on GitHub rather than shipped in
// the archive, because macOS hides them and Archive Utility drops them — so a
// fresh local copy legitimately does not have them yet. The suites that read
// the workflow skip themselves and say so instead of failing.
const REQUIRED = [
  ['index.html', null],
  ['css', null],
  ['js', null],
  ['signing/plotedge-release.keystore', 're-extract the archive; this file must not be lost'],
  ['scripts/patch-android-signing.py', null],
  ['node_modules/acorn', 'npm install'],
  ['node_modules/jsdom', 'npm install'],
  // jsdom has no IndexedDB, and every photo byte lives there now.
  ['node_modules/fake-indexeddb', 'npm install']
];
const root = path.join(__dirname, '..');
const absent = REQUIRED.filter(([p]) => !fs.existsSync(path.join(root, p)));
if (absent.length) {
  console.error('\nCannot run: required files are missing.\n');
  for (const [p, fix] of absent) console.error(`  missing  ${p}${fix ? `\n           fix: ${fix}` : ''}`);
  console.error('');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, '.github/workflows/build-apk.yml'))) {
  console.log('\nNote: .github/workflows/build-apk.yml is not present locally, so the APK');
  console.log('packaging checks will be skipped. They run in CI, where it exists.');
}

// plotarchive.test.js sits beside plotpack.test.js: both are static readers of a
// single feature's source, and both are fast. It also checks that symbology
// reaches every rendering surface, which is a cross-file grep rather than a
// behavioural drive — so it belongs with the readers, not with the bootstrappers.
//
// features.test.js sits just before smoke.js for the same reason smoke.js is
// last: both boot the real app in a DOM rather than reading it, so both are slow
// and both are backstops. It is the only suite that DRIVES the screens — a
// full-screen map that opens blank is invisible to every static check.
const suites = ['split.test.js', 'integrity.test.js', 'store.test.js', 'plotmate.test.js', 'collect.test.js', 'photo.test.js', 'nav-build.test.js', 'theme.test.js', 'capture-stack.test.js', 'plotpack.test.js', 'backup-scan.test.js', 'plotarchive.test.js', 'android-patch.test.js', 'features.test.js', 'multigeom.test.js', 'survey.test.js', 'keyboard.test.js', 'smoke.js'];
let total = 0, failed = 0;

for (const s of suites) {
  console.log(`\n── ${s.replace('.test.js', '').toUpperCase()} ─────────────────────────────`);
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8' });
    process.stdout.write(out);
    const m = out.match(/(\d+)\/(\d+) passed/);
    if (m) { total += +m[2]; }
  } catch (e) {
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || '');
    const m = (e.stdout || '').match(/(\d+)\/(\d+) passed/);
    if (m) { total += +m[2]; failed += (+m[2] - +m[1]); } else { failed++; total++; }
  }
}
console.log(`\n═══════════════════════════════════════════`);
console.log(`  TOTAL: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
