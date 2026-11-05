'use strict';
// universal-mac-natives.js — make the bundled native code work on BOTH macOS architectures so the
// single universal-apple-darwin .app runs natively on Intel and Apple Silicon.
//
// Lokyni bundles real native addons (faiss-node — the vector index, @napi-rs/canvas, sharp, fsevents;
// onnxruntime-node already ships every arch). A normal install on the Apple-Silicon CI runner produces
// arm64-only binaries, which would crash on Intel. This script takes a SECOND install tree built for
// the other architecture (x64) and folds it into the main tree.
//
// It handles BOTH the loadable addons (.node) AND the companion shared libraries (.dylib) they load at
// run time. That distinction matters: an addon can be a perfectly universal .node yet still dlopen a
// single-architecture .dylib next to it (faiss-node's arm64-only libomp.dylib) or from an arch-specific
// vendor folder (sharp's libvips under vendor/<v>/darwin-<arch>/lib) — either of which crashes the app on
// the missing architecture even though the .node itself is fat. So .dylib files go through the same merge
// and the same fail-loud verification as .node files, or the universal build would be broken on Intel.
//
//   merge <x64_node_modules>   For every native artifact (.node or .dylib):
//                                • a package present only in the x64 tree (an arch-specific package
//                                  such as @napi-rs/canvas-darwin-x64) is copied in whole;
//                                • an artifact that exists in both trees at the same path is combined
//                                  with `lipo` into one universal (fat) binary — unless the main one
//                                  already carries the x86_64 slice, in which case it is left alone
//                                  (e.g. onnxruntime, which ships a separate per-arch file), or
//                                  faiss-node's libomp.dylib, which is fattened here;
//                                • an artifact that exists only in the x64 tree inside a package that
//                                  also exists in the main tree (a differently-named or arch-foldered
//                                  per-arch file, such as sharp's .node and its libvips .dylib) is
//                                  copied in so both arch files coexist and the loader picks the right one.
//
//   verify <node_modules>      Fail LOUDLY if any bundled darwin .node or .dylib is not usable on both
//                              arches — i.e. it is neither universal (fat) nor one of a matched
//                              x64+arm64 pair. This guarantees a broken Intel slice can never ship
//                              silently: if an x64 prebuilt could not be obtained, the build fails here.
//
// macOS-only (needs `lipo`/`file` from the Xcode command-line tools). Node built-ins + those tools only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARCH_TOKENS = /(x86_64|x64|amd64|arm64v8|arm64|aarch64)/g;

// The architectures a Mach-O .node contains, via `lipo -archs`. Returns [] if it is not a Mach-O the
// tools understand (a non-native file that merely ends in .node).
function archsOf(file) {
  try { return execFileSync('lipo', ['-archs', file], { encoding: 'utf-8' }).trim().split(/\s+/).filter(Boolean); }
  catch { return []; }
}
const hasX64 = (a) => a.includes('x86_64');
const hasArm = (a) => a.includes('arm64') || a.includes('arm64e');

// Every native artifact under a directory (loadable addons AND the shared libraries they load), as
// paths relative to it. Both extensions matter: a fat .node can still load a single-arch .dylib beside
// it, so a .dylib that ships on only one architecture is just as fatal as a single-arch .node. Static
// archives (.a) are excluded on purpose — they are linked at build time, not loaded at run time, so a
// single-arch .a left in a package (e.g. faiss-node's libfaiss.a) is harmless and must not fail verify.
function findNativeFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (e.name.endsWith('.node') || e.name.endsWith('.dylib'))) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

// The package directory (…/node_modules/<name> or …/<@scope/name>) that a relative path lives in.
function packageRootRel(rel) {
  const parts = rel.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i === -1 || i + 1 >= parts.length) return null;
  const scoped = parts[i + 1].startsWith('@');
  const end = scoped ? i + 3 : i + 2;
  return parts.slice(0, end).join(path.sep);
}

function merge(mainMods, x64Mods) {
  let lipoed = 0, copiedPkgs = 0, copiedFiles = 0, skipped = 0;
  const x64Files = findNativeFiles(x64Mods);
  const copiedPkgSet = new Set();
  for (const rel of x64Files) {
    const mainFile = path.join(mainMods, rel);
    const x64File = path.join(x64Mods, rel);
    const pkgRel = packageRootRel(rel);
    const mainPkg = pkgRel ? path.join(mainMods, pkgRel) : null;

    // 1) An arch-specific package that isn't in the main tree at all — copy it whole (once).
    if (mainPkg && !fs.existsSync(mainPkg)) {
      if (!copiedPkgSet.has(pkgRel)) {
        fs.cpSync(path.join(x64Mods, pkgRel), mainPkg, { recursive: true });
        copiedPkgSet.add(pkgRel);
        copiedPkgs++;
      }
      continue;
    }
    // 2) The .node isn't at this path in the main tree, but its package is — copy the file so both
    //    arch-named files coexist and the loader picks the right one at runtime (e.g. sharp).
    if (!fs.existsSync(mainFile)) {
      fs.mkdirSync(path.dirname(mainFile), { recursive: true });
      fs.copyFileSync(x64File, mainFile);
      copiedFiles++;
      continue;
    }
    // 3) Same path in both. Combine into a universal binary unless the main one already has the x64
    //    slice (already universal, or a package that ships a separate per-arch file like onnxruntime).
    const mainArchs = archsOf(mainFile);
    const x64Archs = archsOf(x64File);
    if (!mainArchs.length || !x64Archs.length) { skipped++; continue; } // not a Mach-O we can fatten
    if (hasX64(mainArchs)) { skipped++; continue; }
    if (!hasX64(x64Archs)) { skipped++; continue; }
    const tmp = mainFile + '.universal';
    execFileSync('lipo', ['-create', mainFile, x64File, '-output', tmp]);
    fs.renameSync(tmp, mainFile);
    lipoed++;
  }
  console.log(`  ✓ Universal native merge: lipo'd ${lipoed}, copied ${copiedPkgs} arch package(s) and ${copiedFiles} arch file(s), left ${skipped} as-is`);
}

// A darwin native artifact (.node or .dylib) is acceptable when it is fat (has both slices) OR it is one
// of a matched x64+arm64 pair (grouped by its path with the arch tokens stripped out, so a per-arch
// pair such as sharp's darwin-x64/darwin-arm64v8 libvips maps to one group). Anything else is a
// single-arch binary that would crash on the other architecture — the build must fail rather than ship it.
function verify(mainMods) {
  const files = findNativeFiles(mainMods);
  const groups = new Map();   // arch-stripped key -> { x64: bool, arm: bool, fat: bool, members: [] }
  for (const rel of files) {
    const archs = archsOf(path.join(mainMods, rel));
    if (!archs.length) continue;  // not a native Mach-O (a stray file named .node/.dylib) — irrelevant
    const key = rel.replace(ARCH_TOKENS, '#');
    const g = groups.get(key) || { x64: false, arm: false, fat: false, members: [] };
    g.members.push(rel);
    if (hasX64(archs) && hasArm(archs)) g.fat = true;
    if (hasX64(archs)) g.x64 = true;
    if (hasArm(archs)) g.arm = true;
    groups.set(key, g);
  }
  const bad = [];
  for (const [, g] of groups) {
    const ok = g.fat || (g.x64 && g.arm);
    if (!ok) bad.push(g.members.join(', '));
  }
  if (bad.length) {
    console.error('✗ Universal check FAILED — these bundled native addons or libraries are single-architecture');
    console.error('  and would crash on the other Mac architecture (no universal or paired x64/arm64 build):');
    for (const b of bad) console.error(`    • ${b}`);
    process.exit(1);
  }
  console.log(`  ✓ Universal check passed — every bundled darwin native addon and library runs on Intel and Apple Silicon (${groups.size} checked)`);
}

const [mode, arg] = process.argv.slice(2);
if (process.platform !== 'darwin') { console.log('universal-mac-natives: not macOS — nothing to do'); process.exit(0); }
if (mode === 'merge') {
  if (!arg || !fs.existsSync(arg)) { console.error('merge needs a path to the x64 node_modules tree'); process.exit(1); }
  merge(path.resolve('node_modules'), path.resolve(arg));
} else if (mode === 'verify') {
  verify(path.resolve(arg || 'node_modules'));
} else {
  console.error('usage: universal-mac-natives.js merge <x64_node_modules> | verify [node_modules]');
  process.exit(1);
}
