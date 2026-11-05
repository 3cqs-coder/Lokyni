'use strict';
// Functional guard for the macOS universal native-addon check (src-tauri/universal-mac-natives.js).
// The universal .app must not ship a single-architecture native addon, or it crashes on the other Mac.
// This exercises the real `verify` against real Mach-O binaries: it uses onnxruntime-node's bundled
// darwin x64 and arm64 binaries (that package already ships every arch) to build three fixtures — a
// matched x64+arm64 pair (must pass), a genuine universal/fat file made with lipo (must pass), and a
// lone single-arch file (must FAIL, exit 1). macOS-only (needs lipo/file); skipped elsewhere and in
// the rare case the onnxruntime darwin binaries are absent. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(PROJECT, 'src-tauri', 'universal-mac-natives.js');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const runVerify = (dir) => {
  try { execFileSync('node', [SCRIPT, 'verify', dir], { stdio: 'pipe' }); return 0; }
  catch (e) { return e.status == null ? 1 : e.status; }
};

if (process.platform !== 'darwin') {
  console.log('… universal-natives: not macOS — skipped');
  console.log('\nALL UNIVERSAL-NATIVES UNIT TESTS PASSED (0 checks)');
  process.exit(0);
}

// This test needs two real single-architecture Mach-O binaries (one x86_64, one arm64) to build its
// fixtures. onnxruntime-node ships them under bin/napi-v<N>/darwin/<arch>/, but the NAPI version changes
// across releases, it may be hoisted to the top level or nested under @huggingface/transformers, and
// recent releases install only the CURRENT machine's arch (so both slices are present only where a
// cross-arch install has been done, e.g. the universal-build merge). Find a darwin dir that actually has
// BOTH arch binaries, wherever it landed; skip cleanly when only one arch is installed (the authoritative
// cross-arch check is the desktop CI's real merge+verify step).
const findOnnxDarwin = () => {
  const roots = [
    path.join(PROJECT, 'node_modules', 'onnxruntime-node'),
    path.join(PROJECT, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node'),
  ];
  for (const root of roots) {
    const binDir = path.join(root, 'bin');
    let napis = [];
    try { napis = fs.readdirSync(binDir).filter(n => n.startsWith('napi-')); } catch { continue; }
    for (const napi of napis) {
      const darwin = path.join(binDir, napi, 'darwin');
      const x64 = path.join(darwin, 'x64', 'onnxruntime_binding.node');
      const arm = path.join(darwin, 'arm64', 'onnxruntime_binding.node');
      if (fs.existsSync(x64) && fs.existsSync(arm)) return { x64, arm };
    }
  }
  return null;
};
const onnx = findOnnxDarwin();
if (!onnx) {
  console.log('… universal-natives: both-arch onnxruntime darwin binaries absent (single-arch install) — skipped');
  console.log('\nALL UNIVERSAL-NATIVES UNIT TESTS PASSED (0 checks)');
  process.exit(0);
}
const x64src = onnx.x64;
const armSrc = onnx.arm;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-univ-')));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  // Sanity: confirm the two source binaries really are the two single architectures we rely on.
  const archsX64 = execFileSync('lipo', ['-archs', x64src], { encoding: 'utf-8' }).trim();
  const archsArm = execFileSync('lipo', ['-archs', armSrc], { encoding: 'utf-8' }).trim();
  ok(archsX64.includes('x86_64'), 'onnxruntime darwin/x64 binary is x86_64');
  ok(archsArm.includes('arm64'), 'onnxruntime darwin/arm64 binary is arm64');

  // Fixture 1 — a matched x64+arm64 pair (as onnxruntime itself ships): must PASS.
  const pairDir = path.join(tmp, 'pair', 'node_modules', 'pkg', 'bin', 'darwin');
  fs.mkdirSync(path.join(pairDir, 'x64'), { recursive: true });
  fs.mkdirSync(path.join(pairDir, 'arm64'), { recursive: true });
  fs.copyFileSync(x64src, path.join(pairDir, 'x64', 'b.node'));
  fs.copyFileSync(armSrc, path.join(pairDir, 'arm64', 'b.node'));
  ok(runVerify(path.join(tmp, 'pair', 'node_modules')) === 0, 'verify passes a matched x64+arm64 pair');

  // Fixture 2 — a genuine universal (fat) single-path binary made with lipo: must PASS.
  const fatDir = path.join(tmp, 'fat', 'node_modules', 'faiss-node', 'build', 'Release');
  fs.mkdirSync(fatDir, { recursive: true });
  execFileSync('lipo', ['-create', x64src, armSrc, '-output', path.join(fatDir, 'faiss-node.node')]);
  ok(runVerify(path.join(tmp, 'fat', 'node_modules')) === 0, 'verify passes a universal (fat) single-path binary');

  // Fixture 3 — a lone single-arch binary at a neutral path: must FAIL (exit 1).
  const badDir = path.join(tmp, 'bad', 'node_modules', 'faiss-node', 'build', 'Release');
  fs.mkdirSync(badDir, { recursive: true });
  fs.copyFileSync(armSrc, path.join(badDir, 'faiss-node.node'));
  ok(runVerify(path.join(tmp, 'bad', 'node_modules')) === 1, 'verify FAILS a lone single-architecture binary (fail-loud gate works)');

  // Fixture 4 — the real-world faiss trap: a perfectly universal (fat) .node sitting next to a lone
  // arm64-only companion .dylib (libomp). The addon is fine, but the .dylib it loads is not, so the app
  // still crashes on Intel. verify must FAIL — this is the regression guard for the .node-only blind spot.
  const ompDir = path.join(tmp, 'omp', 'node_modules', 'faiss-node', 'build', 'Release');
  fs.mkdirSync(ompDir, { recursive: true });
  execFileSync('lipo', ['-create', x64src, armSrc, '-output', path.join(ompDir, 'faiss-node.node')]);
  fs.copyFileSync(armSrc, path.join(ompDir, 'libomp.dylib'));   // arm64-only companion library
  ok(runVerify(path.join(tmp, 'omp', 'node_modules')) === 1, 'verify FAILS a fat .node beside a single-arch companion .dylib (companion libraries are checked, not just addons)');

  // Fixture 5 — the sharp vendor case: a per-arch .dylib PAIR under darwin-x64 / darwin-arm64v8 folders.
  // The arch tokens are stripped so the two map to one group — must PASS.
  const vroot = path.join(tmp, 'vendor', 'node_modules', 'sharp', 'vendor', '8.14.5');
  fs.mkdirSync(path.join(vroot, 'darwin-x64', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(vroot, 'darwin-arm64v8', 'lib'), { recursive: true });
  fs.copyFileSync(x64src, path.join(vroot, 'darwin-x64', 'lib', 'libvips-cpp.42.dylib'));
  fs.copyFileSync(armSrc, path.join(vroot, 'darwin-arm64v8', 'lib', 'libvips-cpp.42.dylib'));
  ok(runVerify(path.join(tmp, 'vendor', 'node_modules')) === 0, 'verify passes a per-arch .dylib pair in arch-named vendor folders (sharp/libvips)');

  // Fixture 6 — a fat (lipo'd) .dylib on its own: must PASS (faiss libomp after the merge fattens it).
  const fatDylibDir = path.join(tmp, 'fatlib', 'node_modules', 'faiss-node', 'build', 'Release');
  fs.mkdirSync(fatDylibDir, { recursive: true });
  execFileSync('lipo', ['-create', x64src, armSrc, '-output', path.join(fatDylibDir, 'faiss-node.node')]);
  execFileSync('lipo', ['-create', x64src, armSrc, '-output', path.join(fatDylibDir, 'libomp.dylib')]);
  ok(runVerify(path.join(tmp, 'fatlib', 'node_modules')) === 0, 'verify passes a universal (fat) companion .dylib');

  // Static archives (.a) are build-time only and must be ignored even when single-arch (faiss libfaiss.a).
  const aDir = path.join(tmp, 'archive', 'node_modules', 'faiss-node', 'build', 'Release');
  fs.mkdirSync(aDir, { recursive: true });
  execFileSync('lipo', ['-create', x64src, armSrc, '-output', path.join(aDir, 'faiss-node.node')]);
  fs.copyFileSync(armSrc, path.join(aDir, 'libfaiss.a'));   // arm64-only static lib — not loaded at runtime
  ok(runVerify(path.join(tmp, 'archive', 'node_modules')) === 0, 'verify ignores a single-arch static .a (linked at build time, never loaded)');

  console.log(`\nALL UNIVERSAL-NATIVES UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ UNIVERSAL-NATIVES UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
