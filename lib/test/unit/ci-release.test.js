'use strict';
// Guards the desktop release workflow's macOS-universal and version-safety posture so a CI refactor
// can't silently regress it. Text checks on the committed workflow and build scripts (no CI needed):
//   - macOS builds ONE universal installer (--target universal-apple-darwin) on a single Apple-Silicon
//     runner. GitHub retired the macos-13 Intel image (Dec 2025) and removes all x86_64 runners
//     (Aug 2027), so there is no per-arch Intel runner; the universal build carries both slices.
//   - the bundled Node runtime and native addons are made universal, with a fail-loud check that every
//     bundled darwin .node works on both architectures (so a missing x64 prebuilt fails the build
//     instead of shipping an app that crashes on Intel).
//   - the build fails fast when the release reference does not match package.json.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const wf = read('.github/workflows/desktop.yml');

  // ── One universal macOS build, no retired/per-arch Intel runner ──
  ok(/- os: macos-latest\s+label: macos/.test(wf), 'the desktop build uses a single macos-latest runner labeled macos');
  // No per-arch runner is actually USED (a prose mention of the retired image in a comment is fine).
  ok(!/os:\s*macos-1[34]\b/.test(wf), 'no retired/per-arch macOS runner is used (os: macos-13/14)');
  ok(!/label:\s*macos-(intel|arm)\b/.test(wf), 'the per-arch macOS labels are gone');
  ok(/LOKYNI_TAURI_TARGET=universal-apple-darwin/.test(wf), 'the macOS leg builds the universal-apple-darwin target');
  ok(/rustup target add x86_64-apple-darwin aarch64-apple-darwin/.test(wf), 'both Rust targets are installed for the universal lipo');

  // ── Universal Node runtime ──
  ok(/lipo -create -output universal-node/.test(wf) && /LOKYNI_RUNTIME_NODE=/.test(wf),
    'a universal Node runtime is lipo-combined and exposed via LOKYNI_RUNTIME_NODE');
  ok(/shasum -a 256 -c -/.test(wf), 'the downloaded Node tarballs are checksum-verified');
  ok(/LOKYNI_RUNTIME_NODE/.test(read('src-tauri/prepare-sidecar.js')),
    'prepare-sidecar bundles the universal Node when LOKYNI_RUNTIME_NODE is set');

  // ── Universal native addons, with a fail-loud verify ──
  ok(/npm install --cpu=x64 --os=darwin/.test(wf), 'a second x64 install provides the other architecture native binaries');
  ok(/universal-mac-natives\.js merge/.test(wf) && /universal-mac-natives\.js verify/.test(wf),
    'the native addons are merged to universal and then verified');
  const nat = read('src-tauri/universal-mac-natives.js');
  ok(/lipo/.test(nat) && /process\.exit\(1\)/.test(nat),
    'the native-universal script uses lipo and fails the build when a darwin .node is single-architecture');

  // ── Build wrapper passes the target only when set (host build unchanged locally) ──
  const pkg = JSON.parse(read('package.json'));
  ok(/node src-tauri\/tauri-build\.js/.test(pkg.scripts['tauri:build']), 'tauri:build runs through the target-aware wrapper');

  // ── Staging runs automatically before every compile, exactly once ──
  // tauri.conf.json's beforeBuildCommand stages the bundle, so a plain `tauri build` is correct too — not
  // only `npm run tauri:build`. Because the hook stages it, the tauri:build script must NOT also stage it
  // (that would run the heavy node_modules copy twice).
  ok(JSON.parse(read('src-tauri/tauri.conf.json')).build.beforeBuildCommand === 'npm run tauri:prepare',
    'tauri.conf.json stages the bundle via beforeBuildCommand');
  ok(!/tauri:prepare/.test(pkg.scripts['tauri:build']),
    'tauri:build does NOT also run tauri:prepare (the hook stages once; no double staging)');

  const tb = read('src-tauri/tauri-build.js');
  ok(/LOKYNI_TAURI_TARGET/.test(tb) && /'--target', target/.test(tb), 'the wrapper adds --target only when LOKYNI_TAURI_TARGET is set');
  // On Windows the tauri binary is a `.cmd` shim; since the Node CVE-2024-27980 fix, spawning a .cmd
  // without shell:true fails with EINVAL and the Windows installer is never built. The wrapper must run it
  // through the shell on Windows (with the path quoted for spaces) and keep the direct spawn on POSIX.
  ok(/isWin\b/.test(tb) && /shell: isWin/.test(tb) && /`"\$\{bin\}"`/.test(tb),
    'the Windows branch spawns the .cmd through the shell with a quoted path (no EINVAL)');
  ok(/spawn\(command, args, \{[^}]*shell: isWin[^}]*\}\)/.test(tb),
    'POSIX keeps the direct, no-shell spawn of the bare tauri binary');

  // ── Release-reference version check ──
  ok(/Verify the version matches the release reference/.test(wf), 'a version-vs-release-reference check step exists');
  ok(/exit 1/.test(wf.slice(wf.indexOf('Verify the version matches'))), 'the version check fails the build on a mismatch');

  // ── Artifact globs cover the explicit-target (universal) output path ──
  ok(/src-tauri\/target\/\*\*\/bundle\/\*\*\/\*\.dmg/.test(wf), 'the artifact globs cover the universal-target bundle path');

  // ── The tauri minimum-macOS floor is still honorable (Intel slice honors 10.15; arm64 is 11+) ──
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const minOS = tauri?.bundle?.macOS?.minimumSystemVersion;
  ok(typeof minOS === 'string' && /^\d+\.\d+$/.test(minOS), `tauri.conf declares a macOS minimum system version (${minOS})`);

  console.log(`\nALL CI-RELEASE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CI-RELEASE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
