'use strict';
// Guards version and runtime pins across the ship manifests. The app version is single-sourced from the root
// package.json: tauri.conf.json derives the installer version from it, and every user-facing version reader
// (the MCP server and client) does the same. Cargo cannot read JSON, so the Rust crate carries a fixed 0.0.0
// placeholder rather than a second release literal — there is nothing to sync and nothing to drift.
//
// The same guard aligns the pinned Node runtime across the desktop workflow and the Docker bases, checks the
// package engines floor against the sidecar minimum, and keeps the declared macOS floor at or above the
// bundled runtime's. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const semver = (s) => {
  const m = String(s || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
};
const atLeast = (a, b) => {
  const x = semver(a), y = semver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return true;
    if (x[i] < y[i]) return false;
  }
  return true;
};

try {
  const pkg = JSON.parse(read('package.json'));
  const pkgVersion = pkg.version;
  ok(semver(pkgVersion), `package.json version is a semver (${pkgVersion})`);

  // tauri.conf.json must DERIVE the installer version from package.json rather than carry its own literal.
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  ok(conf.version === '../package.json',
    `src-tauri/tauri.conf.json derives its version from package.json (found "${conf.version}")`);

  // Cargo's own copy is a fixed placeholder, not a release literal. Check Cargo.toml and the committed lock.
  const cargo = read('src-tauri/Cargo.toml');
  const pkgSection = cargo.split(/^\[/m).find((s) => s.startsWith('package]')) || cargo;
  const cargoVer = (pkgSection.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1];
  ok(cargoVer === '0.0.0', `src-tauri/Cargo.toml uses the fixed 0.0.0 placeholder (found "${cargoVer}")`);
  const lockVer = (read('src-tauri/Cargo.lock').match(/name = "lokyni-shell"\r?\nversion = "([^"]+)"/) || [])[1];
  ok(lockVer === '0.0.0', `src-tauri/Cargo.lock uses the same placeholder (found "${lockVer}")`);

  // No mirror script may creep back in: that would reintroduce a second release literal.
  const scripts = pkg.scripts || {};
  ok(!scripts['sync-version'], 'package.json has no version-mirror script');
  ok(!/sync-version/.test(scripts['tauri:prepare'] || ''), 'tauri:prepare does not run a version mirror');
  ok(!fs.existsSync(path.join(ROOT, 'src-tauri', 'sync-version.js')), 'no version-mirror script file remains');
  ok(!/sync-version/.test(read('.github/workflows/desktop.yml')), 'the desktop workflow does not describe a version mirror');

  // The desktop installers bundle an exact Node, and the Docker image must use the same pin so the server and
  // the desktop sidecar are tested against one runtime. The sidecar's minimum must match the package engines
  // floor, and the pinned runtime must satisfy both.
  const wf = read('.github/workflows/desktop.yml');
  const nodePin = (wf.match(/NODE_VERSION:\s*'(\d+\.\d+\.\d+)'/) || [])[1];
  ok(!!nodePin, `the desktop workflow pins an exact Node (found "${nodePin || ''}")`);
  const dockerBases = [...read('docker/Dockerfile').matchAll(/^FROM\s+node:(\d+\.\d+\.\d+)-/gm)].map((m) => m[1]);
  ok(dockerBases.length >= 2, 'the Dockerfile pins exact Node versions in its build stages');
  ok(dockerBases.every((v) => v === nodePin),
    `every Docker base matches the desktop Node (${nodePin}); found ${dockerBases.join(', ')}`);

  // Every workflow that declares a Node pin must use the same one. A second workflow (the Safari pass) must
  // not quietly test on a different runtime than the desktop and Docker builds.
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  for (const file of fs.readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    const src = read(`.github/workflows/${file}`);
    const pins = [...src.matchAll(/NODE_VERSION:\s*['"]?(\d+\.\d+\.\d+)['"]?/g)].map((m) => m[1]);
    for (const pin of pins) {
      ok(pin === nodePin, `${file} pins the same Node as the desktop build (${nodePin}); found ${pin}`);
    }
  }

  const engines = (pkg.engines && pkg.engines.node) || '';
  ok(!!semver(engines), `package.json declares a Node engines floor (${engines})`);
  ok(atLeast(nodePin, engines), `the pinned Node (${nodePin}) satisfies engines.node (${engines})`);

  const sidecar = require(path.join(ROOT, 'src-tauri', 'prepare-sidecar.js'));
  ok(Array.isArray(sidecar.MIN_NODE) && sidecar.MIN_NODE.length === 2, 'the sidecar exports its minimum Node');
  const enginesFloor = semver(engines);
  ok(enginesFloor && sidecar.MIN_NODE[0] === enginesFloor[0] && sidecar.MIN_NODE[1] === enginesFloor[1],
    `the sidecar minimum (${sidecar.MIN_NODE.join('.')}) matches engines.node (${engines})`);
  ok(atLeast(nodePin, sidecar.MIN_NODE.join('.')), 'the pinned Node satisfies the sidecar minimum');
  ok(sidecar.MIN_NODE_MACOS === '13.5', 'the sidecar records the bundled Node macOS floor');

  // The installer must not advertise an older macOS than the bundled runtime can start on. The floor check is
  // also called during staging, so a stale config fails the build rather than shipping a broken installer.
  const macFloor = conf && conf.bundle && conf.bundle.macOS && conf.bundle.macOS.minimumSystemVersion;
  ok(!!macFloor, 'tauri.conf.json declares a macOS minimum system version');
  ok(atLeast(macFloor, sidecar.MIN_NODE_MACOS),
    `the macOS floor (${macFloor}) covers the bundled Node floor (${sidecar.MIN_NODE_MACOS})`);
  ok(sidecar.assertTauriMacosFloor() === macFloor, 'the build-time macOS floor check accepts the config');

  // The MCP server and client advertise the app version to MCP clients — derive it from package.json, never a
  // hard-coded literal that would silently drift on the next bump.
  for (const f of ['lib/mcp/server.js', 'lib/mcp/client.js']) {
    const src = read(f);
    ok(/version:\s*require\('\.\.\/\.\.\/package\.json'\)\.version/.test(src), `${f} derives its version from package.json`);
    ok(!/version:\s*['"]\d+\.\d+\.\d+['"]/.test(src), `${f} has no hard-coded version literal`);
  }

  console.log(`\nALL VERSION-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ VERSION-DRIFT UNIT TEST FAILED:', e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
