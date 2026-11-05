'use strict';
// prepare-sidecar.js — stage everything the desktop shell bundles, using Node built-ins only
// so it runs the same on macOS, Windows, and Linux with nothing extra to install. It does two
// things:
//
//   1. Stage the application into `app/` — the exact published file set plus the production
//      dependencies. The shell launches `app/lokyni.js` through the bundled runtime.
//   2. Copy the current runtime into `app/runtime/` (with the `.exe` suffix on Windows), so
//      the end user needs no separate runtime installation. It is a plain bundled resource,
//      not a launcher "sidecar", so on macOS it stays out of the app's executable directory
//      and raises no second Dock tile of its own.
//
// No drift by construction: the set of application files is not hand-maintained here. It is
// the package's own publish allowlist, resolved by the same helper the background-service
// installer uses, so anything added to or removed from what the app ships flows into the
// desktop bundle automatically. Run from the project root, or via `npm run tauri:prepare`.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..');
const APP_DIR = path.join(HERE, 'app');
const RUNTIME_DIR = path.join(APP_DIR, 'runtime');

// The authoritative application file set and the same copy routine the installer uses.
const { stagingPlan, copyTree } = require(path.join(REPO, 'lib', 'service'));

// Recursive delete with retries. Node's recursive rmSync can intermittently throw ENOTEMPTY
// (and EBUSY on Windows) part-way through a large tree — a filesystem race, common on macOS
// APFS with an indexer touching files as they are removed. maxRetries/retryDelay make Node
// re-attempt rather than abort the whole build on a transient error.
function rimraf(p) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

function stageApp() {
  rimraf(APP_DIR);
  fs.mkdirSync(APP_DIR, { recursive: true });
  const { appEntries, excludes } = stagingPlan(REPO);
  for (const name of appEntries) {
    const src = path.join(REPO, name);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(APP_DIR, name), { rel: name, excludes });
  }
  console.log(`  ✓ Staged application files (${appEntries.join(', ')})`);

  // Dependencies are copied whole (they are not part of the publish allowlist): a
  // self-contained bundle must carry node_modules, including any nested trees.
  const srcModules = path.join(REPO, 'node_modules');
  if (!fs.existsSync(srcModules)) {
    throw new Error('node_modules is missing — run the dependency install first.');
  }
  fs.cpSync(srcModules, path.join(APP_DIR, 'node_modules'), { recursive: true });
  console.log('  ✓ Staged dependencies');
  pruneStagedModules();
}

// Packages that are pulled in transitively but never reached at runtime, removed from the
// staged copy only (the development tree is left untouched). Each entry must be verified as
// genuinely unreachable before being added here, because an over-eager removal would only
// surface as a crash in the bundled app.
//
// The retrieval library loads each provider integration lazily, so an integration the app
// never constructs — and everything unique to it — is dead weight in the bundle. The cloud
// integration below is one such case: it drags in a full TypeScript toolchain that nothing
// else needs. (The local model runtime is deliberately NOT listed: one of its browser-only
// backends looks unused in this context but is imported unconditionally by its loader, so
// removing it would break the reranker. Shrinking that belongs to an on-demand approach, not
// a static prune.)
const PRUNE = [
  '@tauri-apps',  // the desktop build tool — needed to build the bundle, never at runtime
  '@ibm-cloud',   // cloud model integration the app never instantiates
  'ts-node',      // only reached through that integration
  'typescript',   // only reached through that integration
  'marked',       // a devDependency; both the browser AND lib/docx.js use the vendored copy, so the npm package is never require()d at runtime
];

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else total += st.size;
  };
  walk(dir);
  return total;
}

// Every devDependency, read from the project's package.json — the single source — so a dev-only package can
// never ship in the desktop bundle even if the staged tree was produced by a plain `npm install` (not
// `--omit=dev`), and a NEW devDependency is pruned automatically without editing this list. Combined with the
// curated PRUNE above, which also drops production dead-weight (a cloud integration the app never constructs).
function devDependencyNames() {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).devDependencies || {}); }
  catch { return []; }
}

function pruneStagedModules() {
  const modulesDir = path.join(APP_DIR, 'node_modules');
  let saved = 0;
  const removed = [];
  const targets = [...new Set([...PRUNE, ...devDependencyNames()])];   // curated prod dead-weight + all devDependencies
  for (const name of targets) {
    const target = path.join(modulesDir, name);
    if (!fs.existsSync(target)) continue;
    saved += dirSize(target);
    rimraf(target);
    removed.push(name);
  }
  if (removed.length) {
    console.log(`  ✓ Pruned unused packages (${removed.join(', ')}) — saved ${Math.round(saved / 1e6)} MB`);
  }
}

// Stage the BUNDLED OCR language pack(s) into app/tessdata/, so the shipped desktop app can read scanned pages
// offline out of the box (OCR is on by default, and the English floor pack is otherwise a one-time online fetch).
// Only the English floor is bundled; the optional languages stay fetch-on-demand so the installer does not bloat.
// The source is reused from the single OCR catalog (lib/ocr-languages): a locally-cached valid copy is used when
// present (a dev machine that has run OCR — so this stages OFFLINE here), otherwise the pinned pack is downloaded
// once at BUILD time. Either way it is SHA-256-verified before it is staged, so a swapped or corrupt pack fails
// the build loudly rather than shipping. Node built-ins only (global fetch, crypto), so it runs the same on every OS.
async function stageBundledLang() {
  const crypto = require('crypto');
  const { OCR_BASE_LANGUAGE, OCR_LANGDATA_URL, OCR_LANGDATA_SHA256 } = require(path.join(REPO, 'lib', 'ocr-languages'));
  const code = OCR_BASE_LANGUAGE;                 // the always-on floor — the only pack that must be present offline
  const pin = OCR_LANGDATA_SHA256[code];
  const name = code + '.traineddata.gz';
  const destDir = path.join(APP_DIR, 'tessdata');
  fs.mkdirSync(destDir, { recursive: true });
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const cached = path.join(REPO, 'data', 'tessdata', name);
  let buf = null;
  if (fs.existsSync(cached)) { const b = fs.readFileSync(cached); if (sha(b) === pin) buf = b; }   // reuse a valid local copy (offline build)
  if (!buf) {
    const res = await fetch(OCR_LANGDATA_URL(code), { redirect: 'follow' });
    if (!res.ok) throw new Error(`could not download the ${code} OCR language pack for bundling: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (sha(buf) !== pin) throw new Error(`the ${code} OCR language pack failed its pinned checksum — refusing to bundle a mismatched pack`);
  fs.writeFileSync(path.join(destDir, name), buf);
  console.log(`  ✓ Bundled the ${code} OCR language pack (${Math.round(buf.length / 1e6)} MB, verified)`);
}

function stageRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const dest = path.join(RUNTIME_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
  // For a macOS UNIVERSAL build the CI provides a pre-combined universal Node (both the Intel and
  // Apple-Silicon slices, joined with `lipo`) at LOKYNI_RUNTIME_NODE, so the one .app runs natively on
  // either architecture. Without it, fall back to this build's own runtime (the normal per-OS path).
  const provided = String(process.env.LOKYNI_RUNTIME_NODE || '').trim();
  const source = (provided && fs.existsSync(provided)) ? provided : process.execPath;
  fs.copyFileSync(source, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`  ✓ Bundled the runtime (${path.basename(dest)}${provided && source === provided ? ', universal' : ''})`);
}

// ── Pre-flight: fail LOUDLY before staging, rather than shipping a bundle that is broken for every user ──
const { execFileSync } = require('child_process');
// The bundled runtime (and this build's own Node when none is provided) must satisfy the sidecar's minimum —
// app/lokyni.js exits with an error on every launch below Node 22.22, which would look like "Lokyni failed to
// start" to every user while the build itself reported success.
const MIN_NODE = [22, 22];
// The oldest macOS the bundled Node runtime can start on. Node 24.11.1's official darwin binaries report
// LC_BUILD_VERSION minos 13.5, so an installer that claims to support an older macOS would install and then fail
// at launch with a dyld error. tauri.conf.json carries the user-facing floor; assertTauriMacosFloor() keeps it at
// or above this value on every build, and the version-drift unit guard checks it without a compile.
const MIN_NODE_MACOS = '13.5';
const nodeVersionOk = (v) => {
  const [maj, min] = String(v).replace(/^v/, '').split('.').map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
};
const versionAtLeast = (actual, minimum) => {
  const a = String(actual || '').split('.').map(Number);
  const b = String(minimum || '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
};
// Fail the build rather than ship an installer that advertises an OS the bundled runtime cannot start on.
function assertTauriMacosFloor() {
  const conf = JSON.parse(fs.readFileSync(path.join(HERE, 'tauri.conf.json'), 'utf8'));
  const declared = conf && conf.bundle && conf.bundle.macOS && conf.bundle.macOS.minimumSystemVersion;
  if (!declared || !versionAtLeast(declared, MIN_NODE_MACOS)) {
    throw new Error(`tauri.conf.json declares macOS ${declared || '(none)'}, but the bundled Node requires macOS ${MIN_NODE_MACOS} or newer. Raise bundle.macOS.minimumSystemVersion.`);
  }
  return declared;
}
function verifyPrereqs() {
  assertTauriMacosFloor();
  // The runtime that will actually be bundled: a provided universal Node, else this build's own.
  const provided = String(process.env.LOKYNI_RUNTIME_NODE || '').trim();
  let runtimeVersion = process.version;
  if (provided && fs.existsSync(provided)) {
    try { runtimeVersion = execFileSync(provided, ['--version'], { encoding: 'utf8' }).trim(); }
    catch (e) { throw new Error(`could not probe LOKYNI_RUNTIME_NODE (${provided}): ${e.message}`); }
  }
  if (!nodeVersionOk(runtimeVersion)) {
    throw new Error(`the runtime to be bundled is Node ${runtimeVersion}, but the sidecar requires >= ${MIN_NODE.join('.')} — the app would fail to start for every user. Build with a newer Node (or point LOKYNI_RUNTIME_NODE at one).`);
  }
  // A partial/aborted dependency install would be copied as-is and ship a broken bundle. Confirm a few
  // load-bearing production deps are actually installed. Check the package directory (its package.json), not
  // require.resolve — some packages (e.g. @modelcontextprotocol/sdk) export only subpaths, so resolving the bare
  // name throws even when they are correctly installed.
  const required = ['express', 'zod', 'multer', 'faiss-node', '@huggingface/transformers', '@modelcontextprotocol/sdk'];
  const missing = required.filter((m) => !fs.existsSync(path.join(REPO, 'node_modules', m, 'package.json')));
  if (missing.length) throw new Error(`these production dependencies are missing from node_modules (incomplete install?): ${missing.join(', ')} — run the dependency install first.`);
}

// ── Post-stage: assert the pieces the shell will spawn actually landed (non-empty), not silently skipped ──
function verifyStaged() {
  const entry = path.join(APP_DIR, 'lokyni.js');
  const modules = path.join(APP_DIR, 'node_modules');
  const runtime = path.join(RUNTIME_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
  const nonEmptyFile = (p) => { try { return fs.statSync(p).isFile() && fs.statSync(p).size > 0; } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (!nonEmptyFile(entry)) throw new Error(`staging produced no app/lokyni.js — the bundle is incomplete`);
  if (!isDir(modules)) throw new Error(`staging produced no app/node_modules — the bundle is incomplete`);
  if (!nonEmptyFile(runtime)) throw new Error(`staging produced no runtime at ${runtime} — the bundle is incomplete`);
  // The bundled English OCR pack must have landed, so the shipped app can OCR offline on first run.
  const engPack = path.join(APP_DIR, 'tessdata', 'eng.traineddata.gz');
  if (!nonEmptyFile(engPack)) throw new Error(`staging produced no app/tessdata/eng.traineddata.gz — the offline OCR pack is missing`);
}

if (require.main === module) {
  (async () => {
    console.log('Preparing the desktop bundle…');
    verifyPrereqs();
    stageApp();
    await stageBundledLang();
    stageRuntime();
    verifyStaged();
    console.log(`\nBundle staged at ${APP_DIR}`);
  })().catch((e) => { console.error(`\n✗ Bundle preparation failed: ${e && e.message || e}`); process.exit(1); });
}

module.exports = { MIN_NODE, MIN_NODE_MACOS, assertTauriMacosFloor, verifyPrereqs };
