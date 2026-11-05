'use strict';
// Regression tests for the install file staging (lib/service.js). The set of application
// files the installer copies into the install directory is derived from the package's own
// publish allowlist (the "files" field in package.json), not a second hand-maintained list,
// so the two can never drift. These tests assert that derivation and then perform a real
// staged copy into a temp directory to confirm that everything the running app serves is
// included and that development-only trees (tests, scripts, node_modules) are left out.
// Uses a temp dir — no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const svc = require(path.join(PROJECT, 'lib', 'service'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-installtest-'));
try {
  // ── package.json has an explicit publish allowlist ──
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf-8'));
  ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json declares a "files" allowlist');
  console.log('✓ install-staging: package.json declares a publish allowlist');

  // ── the staging plan is derived from that allowlist ──
  const { appEntries, excludes } = svc.stagingPlan(PROJECT);
  ok(appEntries.includes('lokyni.js') && appEntries.includes('lib'), 'the plan includes the entry point and lib');
  ok(appEntries.includes('package.json'), 'the plan always includes the package manifest');
  ok(!appEntries.includes('package-lock.json'), 'the plan does not stage a lockfile (dependencies resolve from ranges)');
  ok(excludes.has('lib/test') && excludes.has('lib/scripts'),
     'the plan excludes the development-only trees named in the allowlist');
  // Every non-negated allowlist entry must exist on disk (catches a stale allowlist).
  for (const raw of pkg.files) {
    const norm = String(raw).replace(/\/+$/, '');
    if (norm.startsWith('!')) continue;
    ok(fs.existsSync(path.join(PROJECT, norm)), `allowlisted path "${norm}" exists on disk`);
  }
  console.log('✓ install-staging: the copy set is derived from the allowlist and every entry exists');

  // ── a real staged copy contains what the app serves, and omits dev-only trees ──
  for (const name of appEntries) {
    const src = path.join(PROJECT, name);
    if (!fs.existsSync(src)) continue;
    svc.copyTree(src, path.join(tmp, name), { rel: name, excludes });
  }
  const staged = (...p) => fs.existsSync(path.join(tmp, ...p));

  // Everything the running UI needs must be present.
  for (const rel of [
    ['lokyni.js'], ['package.json'],
    ['lib', 'server.js'], ['lib', 'service.js'],
    ['lib', 'views', 'chat.ejs'],
    ['lib', 'public', 'css', 'app.css'],
    ['lib', 'public', 'js', 'chat.js'],
    ['lib', 'public', 'sw.js'],
    ['lib', 'public', 'fonts', 'fonts.css'],
    ['lib', 'public', 'icons', 'icon-512.png'],
  ]) ok(staged(...rel), `staged install includes ${path.join(...rel)}`);
  console.log('✓ install-staging: the staged copy includes every served asset (UI, fonts, icons, worker)');

  // Development-only and dependency trees must be left behind.
  ok(!staged('lib', 'test'), 'the staged copy omits lib/test');
  ok(!staged('lib', 'scripts'), 'the staged copy omits lib/scripts');
  ok(!staged('node_modules'), 'the staged copy omits node_modules (handled separately)');
  ok(!staged('.git'), 'the staged copy omits .git');
  console.log('✓ install-staging: development-only and dependency trees are left out');

  console.log(`\nALL INSTALL-STAGING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ INSTALL-STAGING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
