'use strict';
// Cross-platform service installation — run Lokyni in the background, starting at
// login and restarting on crash, without pm2 or any extra runtime dependency.
//
//   node lokyni.js --install     register with the OS and start
//   node lokyni.js --uninstall   remove the service and stop
//   node lokyni.js --restart     restart the running service
//   node lokyni.js --status      show whether it's running, plus health
//   node lokyni.js --open        open the web UI in the default browser
//
// Platform mechanisms (all user-level — no admin required for the default paths):
//   macOS   ~/Library/LaunchAgents/com.lokyni.server.plist  (launchctl)
//   Linux   ~/.config/systemd/user/lokyni.service           (systemctl --user)
//   Windows Scheduled Task, falling back to the HKCU Run key
//
// pm2 remains fully supported and is unaffected by any of this — these commands
// are an alternative for people who don't want the extra dependency, not a
// replacement. Running both at once would start two servers on the same port, so
// the install path warns when it detects a pm2-managed instance.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { DEFAULT_PORT, APP_ID, MAC_SERVICE_ID, WIN_TASK_NAME } = require('./constants');

const MAC_LABEL  = MAC_SERVICE_ID;
const WIN_TASK   = WIN_TASK_NAME;
// The state directory (pid, logs, branded node) is normally the user's ~/.lokyni. But a service can be
// launched under a DIFFERENT identity than the installing user — notably a Windows ADMIN onstart task runs as
// SYSTEM, whose home is not the user's — which would drift the pid/log paths and orphan the running server on
// uninstall (the user's CLI couldn't find its pid). So the generated service command embeds the installing
// user's absolute state dir (this STATE_DIR, resolved at install time) via `--state-dir`, and the running
// process honors it; the user's own CLI passes no flag and falls back to the same ~/.lokyni, so the two always
// agree regardless of run-as identity — and for an in-place install (where the install dir is the source
// checkout, not ~/.lokyni) the pid/logs still land in ~/.lokyni, matching the CLI and the unit's own log paths.
const _stateDirArg = (() => {
  const a = process.argv;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--state-dir' && a[i + 1] && !a[i + 1].startsWith('--')) return a[i + 1];
    if (a[i].startsWith('--state-dir=')) return a[i].slice('--state-dir='.length);
  }
  return null;
})();
const STATE_DIR  = _stateDirArg || path.join(os.homedir(), '.lokyni');
const PID_PATH   = path.join(STATE_DIR, 'lokyni.pid');
const LOG_PATH   = path.join(STATE_DIR, 'lokyni.log');
const ERR_PATH   = path.join(STATE_DIR, 'lokyni-error.log');

// Where `--install` places the application. Using the same directory that already
// holds logs and the pid keeps everything Lokyni owns in one predictable place, and
// the layout inside it is identical to a source checkout (lokyni.js, lib/,
// node_modules/, config/, data/) so every relative path resolves unchanged.
const INSTALL_DIR = STATE_DIR;

// The set of application files copied into the install directory is derived from the
// package's own publish allowlist (the "files" field in package.json) rather than a second
// hand-maintained list here, so the two can never silently drift: anything added to or
// removed from what the package ships automatically flows into the install too. The package
// manifests are always included (they are needed at the install location even though npm
// treats them specially), and node_modules is handled separately below — it is large and
// platform-specific. A unit test asserts this staging tracks the allowlist. Reads
// package.json directly (no spawn), so it works with only Node present.
const stagingPlan = (sourceDir) => {
  let files = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8'));
    if (Array.isArray(pkg.files)) files = pkg.files;
  } catch { /* fall back to the built-in defaults below */ }
  const includes = [], excludes = new Set();
  for (const raw of files) {
    const norm = String(raw).replace(/\\/g, '/').replace(/\/+$/, '');
    // The copier matches literal paths, not globs. npm's "files" allows glob patterns, so a
    // future entry like "lib/**/*.js" would silently copy nothing (include) or fail to
    // exclude (negation). Warn loudly rather than produce a wrong install that looks fine.
    if (/[*?[\]{}]/.test(norm)) {
      console.warn(`⚠  Ignoring glob pattern in package.json "files": ${raw} — the installer copies literal paths only. Use a plain path.`);
      continue;
    }
    if (norm.startsWith('!')) excludes.add(norm.slice(1).replace(/\/+$/, ''));
    else if (norm) includes.push(norm);
  }
  // A checkout with no allowlist still installs correctly.
  if (!includes.length) includes.push('lokyni.js', 'lib');
  // package.json is always needed; the lockfile is deliberately not used or shipped (dependencies
  // resolve from package.json ranges), so it is not staged.
  const appEntries = Array.from(new Set([...includes, 'package.json']));
  return { appEntries, excludes };
};

// User data moved (not copied) so exactly one authoritative copy exists. The whole config/ folder
// (the live config.json plus its shipped template) travels with the user's data.
const DATA_ENTRIES = ['config', 'data'];

// Locations that suggest the user is running from a temporary or throwaway folder.
// Installing in place from one of these means the service breaks as soon as they
// tidy up, so `--install` warns before proceeding. Paths are normalized to forward
// slashes so the same patterns work on Windows.
const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

const isDisposableLocation = (dir) => {
  const lower = norm(dir);
  const home  = norm(os.homedir());
  const patterns = [
    `${home}/downloads`, `${home}/desktop`,
    `${home}/appdata/local/temp`,          // Windows temp
    '/tmp/', '/var/folders/', '/private/var/',  // unix temp
    ':/windows/temp', ':/temp/',           // Windows system temp
  ];
  if (patterns.some(p => lower.startsWith(p) || lower.includes(p))) return true;
  // A version number in the leaf directory ("lokyni-1.2.0", "rag copy 2") suggests
  // an unpacked archive rather than a permanent home.
  const leaf = path.basename(lower);
  return /[-_ ]v?\d+[._]\d+|\bcopy\b|\(\d+\)/.test(leaf);
};

// A source checkout — don't relocate a developer's working tree.
const isGitCheckout = (dir) => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

// Recursive copy that skips junk and any path in the exclude set. Node 16.7+ has fs.cpSync,
// but this keeps the exclusion logic explicit and works the same across supported versions.
// `rel` is the path of the current node relative to the copy root, so excludes expressed as
// allowlist negations (for example "lib/test") match by their full relative path, not just a
// bare directory name that might occur legitimately elsewhere.
const JUNK_NAMES = new Set(['.git', '.DS_Store', 'node_modules', '.gitignore']);
const copyTree = (src, dest, { rel = '', excludes = new Set() } = {}) => {
  if (JUNK_NAMES.has(path.basename(src)) || excludes.has(rel)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dest, name), { rel: rel ? `${rel}/${name}` : name, excludes });
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
};

const dirSize = (dir) => {
  let total = 0;
  const walk = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else total += st.size;
  };
  walk(dir);
  return total;
};
const human = (bytes) => bytes > 1e9 ? `${(bytes/1e9).toFixed(1)} GB`
  : bytes > 1e6 ? `${Math.round(bytes/1e6)} MB` : `${Math.round(bytes/1e3)} KB`;

const ensureStateDir = () => { try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {} };

// The directory this process is running from.
const getSourceDir = () => path.dirname(path.resolve(process.argv[1] || __filename));

// The directory the service runs from. After a relocating install this is
// INSTALL_DIR; for an in-place install (a git checkout, or --in-place) it's wherever
// the code already lives. Lokyni resolves config/config.json and ./data relative to the
// working directory, so pinning the service to this location keeps every path
// working exactly as it does when run manually — no env vars needed.
const getInstallDir = () => {
  // If an installed copy exists and we're not running from it, the service points at
  // the installed copy.
  try {
    if (fs.existsSync(path.join(INSTALL_DIR, 'lokyni.js'))) return INSTALL_DIR;
  } catch {}
  return getSourceDir();
};

// ── Branded process name ────────────────────────────────────────────────────
// Run the background service through a copy/hardlink of the Node binary named
// "lokyni" so OS process lists show the app name instead of the generic "node":
// macOS Activity Monitor's Process Name column and the Windows Task Manager Details
// tab both key off the executable's on-disk filename, which no runtime API
// (process.title included) can change. process.title — set in lokyni.js — still
// covers the foreground case and the ps/top command column; this covers the columns
// that only ever reflect the filename.
//
// The branded binary lives under ~/.lokyni/bin so it stays out of any source tree
// and is trivial to remove on uninstall. A version marker records the source Node
// binary's size+mtime, so the branded copy is rebuilt after a Node upgrade (also
// refreshed on --restart). Everything here is cosmetic and best-effort: any failure
// falls back to the plain node path so branding can never block an install.
const BIN_DIR      = path.join(STATE_DIR, 'bin');
const BRANDED_NAME = process.platform === 'win32' ? `${APP_ID}.exe` : APP_ID;
const BRANDED_PATH = path.join(BIN_DIR, BRANDED_NAME);

// codesign ships with the Xcode command-line tools; probe for them without ever
// triggering their installer prompt. macOS only.
const macHasCodesign = () => {
  try { execFileSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 3000 }); return true; }
  catch { return false; }
};

const ensureBrandedNode = () => {
  const isWin = process.platform === 'win32';
  const src   = process.execPath;
  // Already running FROM the branded binary (e.g. the installed service): nothing to
  // build, and no system-node reference to rebuild against.
  if (path.basename(src).replace(/\.exe$/i, '') === APP_ID) return src;

  const target = BRANDED_PATH;
  const marker = target + '.src';
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const s = fs.statSync(src);
    const stamp = `${s.size}:${Math.round(s.mtimeMs)}`;
    // Up to date? Built from the current node binary and still present.
    try { if (fs.existsSync(target) && fs.readFileSync(marker, 'utf-8').trim() === stamp) return target; } catch {}

    // Free the path. Windows can't delete a running image, so rename it aside instead.
    try { fs.rmSync(target, { force: true }); }
    catch { try { fs.rmSync(target + '.old', { force: true }); } catch {} try { fs.renameSync(target, target + '.old'); } catch {} }

    let built = false;
    // On macOS the Activity Monitor "Process Name" follows the code-signing
    // identifier, and stock node is signed as "node" — so a plain hardlink would
    // still read "node". Copy the binary and ad-hoc re-sign it as "lokyni", but only
    // when the developer tools are already present so we never trigger their install.
    if (process.platform === 'darwin' && macHasCodesign()) {
      try {
        fs.copyFileSync(src, target);
        try { fs.chmodSync(target, 0o755); } catch {}
        execFileSync('codesign', ['-s', '-', '-i', APP_ID, '--force', target], { stdio: 'ignore', timeout: 20000 });
        built = true;
      } catch { try { fs.rmSync(target, { force: true }); } catch {} }
    }
    // Everywhere else (and on macOS without codesign): a hardlink — no extra disk,
    // identical bytes, and it keeps working even if the system node is later removed
    // (the inode is reference-counted). A copy is the fallback across filesystems.
    if (!built) {
      try { fs.linkSync(src, target); built = true; }
      catch {
        try {
          fs.copyFileSync(src, target);
          if (!isWin) { try { fs.chmodSync(target, 0o755); } catch {} }
          built = true;
        } catch {}
      }
    }
    if (built && fs.existsSync(target)) { try { fs.writeFileSync(marker, stamp); } catch {} return target; }
    return src;
  } catch { return src; }
};

// Remove the branded launcher and its bookkeeping on uninstall. ~/.lokyni itself is
// left in place (it holds the user's documents and index) — only what branding added
// is cleaned up, and the bin dir is dropped if it ends up empty.
const removeBrandedNode = () => {
  for (const p of [BRANDED_PATH, BRANDED_PATH + '.src', BRANDED_PATH + '.old']) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  try { fs.rmdirSync(BIN_DIR); } catch {}
};

// launchd verbs. Prefer the modern bootstrap/bootout (restart already uses kickstart)
// over the deprecated load/unload, but fall back to load/unload if the modern form is
// rejected — so this can never regress on any macOS that runs a supported Node.
const _guiDomain = () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === null ? null : `gui/${uid}`;
};
const launchctlBootstrap = (plistPath) => {
  const dom = _guiDomain();
  if (dom) {
    try { execFileSync('launchctl', ['bootout', dom, plistPath], { stdio: 'ignore' }); } catch {}   // clear any prior instance
    try { execFileSync('launchctl', ['bootstrap', dom, plistPath], { stdio: 'ignore' }); return; } catch {}
  }
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
};
const launchctlBootout = (plistPath, label) => {
  const dom = _guiDomain();
  if (dom) {
    try { execFileSync('launchctl', ['bootout', `${dom}/${label}`], { stdio: 'ignore' }); return; } catch {}
    try { execFileSync('launchctl', ['bootout', dom, plistPath], { stdio: 'ignore' }); return; } catch {}
  }
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
};

const getServicePaths = (runDir = null) => {
  const nodePath   = process.execPath;
  const installDir = runDir || getInstallDir();
  const scriptPath = path.join(installDir, 'lokyni.js');
  const plat = process.platform;

  if (plat === 'darwin') {
    return {
      platform: 'macos',
      servicePath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`),
      label: MAC_LABEL, nodePath, scriptPath, installDir,
    };
  }
  if (plat === 'linux') {
    const configDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    return {
      platform: 'linux',
      servicePath: path.join(configDir, `${APP_ID}.service`),
      configDir, nodePath, scriptPath, installDir,
    };
  }
  if (plat === 'win32') {
    return { platform: 'windows', taskName: WIN_TASK, nodePath, scriptPath, installDir };
  }
  return null;
};

// Read the configured port without pulling in the whole config module (which has
// heavy downstream requires). Falls back to the shared default in constants.js.
const getPort = () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getInstallDir(), 'config', 'config.json'), 'utf-8'));
    const p = parseInt(cfg.port, 10);
    if (Number.isInteger(p) && p > 0) return p;
  } catch {}
  return DEFAULT_PORT;
};

const getUrl = () => `http://127.0.0.1:${getPort()}`;

// ── PID tracking ────────────────────────────────────────────────────────────
// Written by the server process itself (see writePidFile) so --status/--restart
// can find it regardless of which mechanism started it.
const writePidFile = () => {
  ensureStateDir();
  // Never clobber a pid file that a DIFFERENT, still-running instance owns. A second start races the
  // running one, will fail the port bind (EADDRINUSE) and exit — it must not overwrite the healthy
  // instance's pid on the way, or --status/--restart/--uninstall would lose track of the real process.
  // A stale pid (the recorded process is gone) is ours to take over.
  const existing = readPid();
  if (existing && existing !== process.pid && isRunning(existing)) return;
  // Atomic write (temp + rename) so a crash mid-write can't leave a torn pid file. Consistent with the rest of
  // the codebase's managed stores; falls back to a plain write if the atomic helper is somehow unavailable.
  try { require('./disk').writeFileAtomic(PID_PATH, String(process.pid)); }
  catch { try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch {} }
};
// The synchronous 'exit' hook is registered ONCE at module load (not inside writePidFile, which would add a
// duplicate listener on any future second call). Signal handling (SIGINT/SIGTERM) is owned centrally by
// lib/shutdown.js so teardown runs in one ordered pass; the pid removal is also registered as a shutdown task by
// the caller, and 'exit' runs regardless, so the file is cleaned up on every path.
process.on('exit', () => { try { removePidFile(); } catch {} });
// Exposed so the central shutdown module can remove the pid file as part of the ordered teardown (in
// addition to the sync 'exit' hook above). Removes the file ONLY when it still records THIS process, so a
// losing second start (or any process that never owned the file) can't delete the running instance's pid.
const removePidFile = () => {
  try { if (readPid() === process.pid) fs.unlinkSync(PID_PATH); } catch {}
};

const readPid = () => {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
};

const isRunning = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Detect a pm2-managed instance so we can warn rather than silently double-start.
const pm2HasLokyni = () => {
  try {
    // pm2 is pm2.cmd on Windows — run through a shell so the extension resolves.
    const out = execSync('pm2 jlist', {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, shell: true,
    }).toString();
    const list = JSON.parse(out);
    return Array.isArray(list) && list.some(p =>
      (p.name || '').toLowerCase().includes(APP_ID) ||
      ((p.pm2_env && p.pm2_env.pm_exec_path) || '').toLowerCase().includes('lokyni'));
  } catch { return false; }
};

const stopRunning = () => {
  const pid = readPid();
  if (isRunning(pid)) {
    if (process.platform === 'win32') {
      // On Windows, process.kill maps BOTH SIGTERM and SIGKILL to TerminateProcess: the target dies with no
      // 'SIGTERM'/'exit' handler, so the no-orphan backstop (shutdown.js onExitKill → killAllBrowsersSync)
      // never runs and a spawned Chromium would be left orphaned (the one process that does not die with its
      // parent). taskkill /T terminates the whole process TREE, so Chromium and its children die with the
      // server; /F forces it. This loses the graceful end-of-run cache flush, an acceptable trade on Windows
      // (caches rebuild) to honor the "never orphan a process" rule.
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      // POSIX: a real SIGTERM runs the graceful shutdown (which reaps the browser), then force after a grace
      // window. Uses Atomics.wait for a portable synchronous sleep — shelling out to `sleep`/`timeout` is
      // platform-specific and `timeout` fails without an attached console on Windows.
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const sleep = (ms) => {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
        catch { const end = Date.now() + ms; while (Date.now() < end) {} }
      };
      const deadline = Date.now() + 5000;
      while (isRunning(pid) && Date.now() < deadline) sleep(200);
      if (isRunning(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  try { fs.unlinkSync(PID_PATH); } catch {}
};

// Stop a previously-installed instance before a re-install overwrites its files and
// re-registers. Without this, re-running --install while the service is up can (1) on
// Windows, fail to copy over the loaded native modules the running process holds open,
// and (2) start a second server that loses the race for the port and dies — leaving the
// OLD code running while the install looks like it succeeded. The stop goes through the
// service manager first, not just the pid: on macOS, killing the pid alone would have
// launchd's KeepAlive relaunch the job a moment later, so the plist must be unloaded.
// Every step is guarded, so this is a harmless no-op on a first install.
const stopForReinstall = (info) => {
  if (info.platform === 'macos') {
    if (fs.existsSync(info.servicePath)) launchctlBootout(info.servicePath, info.label);
  } else if (info.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'stop', `${APP_ID}.service`], { stdio: 'ignore' }); } catch {}
  } else if (info.platform === 'windows') {
    try { execFileSync('schtasks', ['/end', '/tn', info.taskName], { stdio: 'ignore' }); } catch {}
  }
  // pid-based fallback — also covers an instance started manually or via pm2.
  stopRunning();
};

// ── Relocate into the canonical install directory ───────────────────────────
// Copies the application into ~/.lokyni and MOVES config/ + data/ so exactly
// one authoritative copy of the user's documents and index exists. Returns the
// directory the service should run from.
const relocateToInstallDir = (sourceDir, { assumeYes = false } = {}) => {
  const target = INSTALL_DIR;

  if (path.resolve(sourceDir) === path.resolve(target)) {
    console.log(`Already installed at ${target} — refreshing service registration.`);
    return target;
  }

  console.log(`Installing Lokyni to ${target}`);
  console.log('');

  // 1. Application files — exactly the package's publish allowlist (see stagingPlan).
  const { appEntries, excludes } = stagingPlan(sourceDir);
  for (const name of appEntries) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, name);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    copyTree(src, dest, { rel: name, excludes });
  }
  console.log('  ✓ Application files copied');

  // 2. Dependencies. Copying is much faster than a fresh npm install and keeps the
  //    already-built native modules (faiss-node and friends) intact. If it fails, or
  //    node_modules is missing, fall back to npm install in the target.
  const srcModules = path.join(sourceDir, 'node_modules');
  const destModules = path.join(target, 'node_modules');
  let modulesReady = false;
  if (fs.existsSync(srcModules)) {
    try {
      process.stdout.write(`  … Copying dependencies (${human(dirSize(srcModules))}) `);
      try { fs.rmSync(destModules, { recursive: true, force: true }); } catch {}
      // Use fs.cpSync for node_modules, NOT copyTree: copyTree's junk-name filter drops any
      // directory named "node_modules" below the top level, so a package with its own nested
      // node_modules (common when npm can't dedupe a version conflict, e.g. around native
      // modules) would be copied WITHOUT its transitive deps — a broken install that still
      // reported success. cpSync copies the whole tree faithfully.
      fs.cpSync(srcModules, destModules, { recursive: true });
      modulesReady = true;
      console.log('\r  ✓ Dependencies copied' + ' '.repeat(30));
    } catch (e) {
      console.log(`\r  ⚠ Copy failed (${e.message}) — falling back to npm install`);
    }
  }
  if (!modulesReady) {
    try {
      console.log('  … Installing dependencies (npm install)');
      // npm is npm.cmd on Windows — run through a shell so the extension resolves.
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFileSync(npmCmd, ['install', '--omit=dev'], { cwd: target, stdio: 'inherit', shell: true });
      modulesReady = true;
    } catch (e) {
      console.error('  ✖ npm install failed — install dependencies manually in ' + target);
    }
  }

  // 3. User data. MOVED, not copied, so there's a single authoritative corpus and
  //    index. Falls back to copy+remove when a rename can't cross devices.
  for (const name of DATA_ENTRIES) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, name);
    if (fs.existsSync(dest)) {
      console.log(`  ⚠ ${name} already exists in ${target} — keeping the installed copy, leaving the source untouched`);
      continue;
    }
    try {
      fs.renameSync(src, dest);
    } catch {
      try {
        copyTree(src, dest, { rel: name });
        fs.rmSync(src, { recursive: true, force: true });
      } catch (e) {
        console.log(`  ⚠ Could not move ${name}: ${e.message}`);
        continue;
      }
    }
    console.log(`  ✓ Moved ${name}`);
  }

  console.log('');
  return target;
};
// Register with the platform service manager. Throws on failure so the caller
// can report partial-install state clearly.
const registerService = (info) => {
    if (info.platform === 'macos') {
      // XML-escape every interpolated path so a home directory containing & < or >
      // can't produce a malformed plist that launchctl silently rejects.
      const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // PATH is minimal under launchd — set it explicitly so Ollama (commonly in
      // /opt/homebrew/bin or /usr/local/bin) and other tools are reachable.
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xe(info.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xe(info.nodePath)}</string>
      <string>${xe(info.scriptPath)}</string>
      <string>--state-dir</string>
      <string>${xe(STATE_DIR)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${xe(info.installDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xe(LOG_PATH)}</string>
    <key>StandardErrorPath</key>
    <string>${xe(ERR_PATH)}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
  </dict>
  </plist>`;
      fs.mkdirSync(path.dirname(info.servicePath), { recursive: true });
      fs.writeFileSync(info.servicePath, plist);
      launchctlBootstrap(info.servicePath);
      console.log('\x1b[32m✓ Installed as a macOS LaunchAgent\x1b[0m');
      console.log(`  Service:  ${info.servicePath}`);

    } else if (info.platform === 'linux') {
      fs.mkdirSync(info.configDir, { recursive: true });
      const unit = `[Unit]
  Description=Lokyni document intelligence server
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  ExecStart="${info.nodePath}" "${info.scriptPath}" --state-dir "${STATE_DIR}"
  WorkingDirectory=${info.installDir}
  Restart=on-failure
  RestartSec=10
  StandardOutput=append:${LOG_PATH}
  StandardError=append:${ERR_PATH}

  [Install]
  WantedBy=default.target
  `;
      fs.writeFileSync(info.servicePath, unit);
      try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
      execFileSync('systemctl', ['--user', 'enable', '--now', `${APP_ID}.service`], { stdio: 'ignore' });
      // Lingering lets the user service run without an active login session.
      try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); } catch {}
      console.log('\x1b[32m✓ Installed as a systemd user service\x1b[0m');
      console.log(`  Service:  ${info.servicePath}`);

    } else if (info.platform === 'windows') {
      // Clear any registration from a previous install so exactly one method stays
      // active. Otherwise a scheduled task left by an earlier admin install could
      // linger when this run falls back to the Run key, double-starting the server.
      try { execFileSync('schtasks', ['/delete', '/tn', info.taskName, '/f'], { stdio: 'ignore' }); } catch {}
      try { execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', info.taskName, '/f'], { stdio: 'ignore' }); } catch {}

      // A .vbs launcher keeps the console window hidden.
      const vbsPath = path.join(STATE_DIR, 'lokyni-service.vbs');
      const vbs = `Set WshShell = CreateObject("WScript.Shell")\r\n` +
                  `WshShell.CurrentDirectory = "${info.installDir}"\r\n` +
                  `WshShell.Run """${info.nodePath}"" ""${info.scriptPath}"" --state-dir ""${STATE_DIR}""", 0, False\r\n`;
      fs.writeFileSync(vbsPath, vbs);

      // Pass argv arrays (no shell): Node applies the correct Windows quoting to the /tr value, so a launcher
      // path with a space works without the fragile nested cmd-level quote escaping a shell string needs — the
      // same reason the registry fallback below uses execFileSync.
      const trValue = `wscript.exe "${vbsPath}"`;
      let level = 'onstart';
      try {
        execFileSync('schtasks', ['/create', '/tn', info.taskName, '/tr', trValue, '/sc', 'onstart', '/rl', 'highest', '/f'], { stdio: 'ignore' });
      } catch {
        try {
          level = 'onlogon';
          execFileSync('schtasks', ['/create', '/tn', info.taskName, '/tr', trValue, '/sc', 'onlogon', '/f'], { stdio: 'ignore' });
        } catch {
          level = 'registry';
          // Use execFileSync (no shell) so Node applies correct Windows argument quoting to the /d
          // value — a home path with a space (C:\Users\John Doe\.lokyni\...) would otherwise break the
          // fragile nested cmd-level quote escaping a shell string needs.
          execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', info.taskName, '/t', 'REG_SZ', '/d', `wscript.exe "${vbsPath}"`, '/f'], { stdio: 'ignore' });
        }
      }
      // Scheduled tasks default to not running on battery, which silently stops it
      // on laptops — clear both battery conditions.
      if (level !== 'registry') {
        try {
          const ps = `$t = Get-ScheduledTask -TaskName '${info.taskName}'; $t.Settings.DisallowStartIfOnBatteries = $false; $t.Settings.StopIfGoingOnBatteries = $false; Set-ScheduledTask -InputObject $t`;
          execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
        } catch {}
        try { execFileSync('schtasks', ['/run', '/tn', info.taskName], { stdio: 'ignore' }); } catch {}
      } else {
        try { execFileSync('wscript.exe', [vbsPath], { stdio: 'ignore' }); } catch {}
      }
      console.log('\x1b[32m✓ Installed as a Windows background task\x1b[0m');
      console.log(`  Starts at: ${level === 'onstart' ? 'system startup' : level === 'onlogon' ? 'user logon' : 'user logon (registry)'}`);
      if (level !== 'onstart') console.log('  Note:      run from an admin prompt to start at boot without login');
      console.log(`  Launcher:  ${vbsPath}`);
    }

};

const installService = (opts = {}) => {
  ensureStateDir();

  if (pm2HasLokyni()) {
    console.log('\x1b[33m⚠  A pm2-managed Lokyni appears to be running.\x1b[0m');
    console.log('   Running both would start two servers on the same port.');
    console.log('   Stop the pm2 one first:  pm2 stop lokyni && pm2 delete lokyni');
    console.log('');
  }

  const sourceDir = getSourceDir();
  const alreadyInstalled = path.resolve(sourceDir) === path.resolve(INSTALL_DIR);
  const gitCheckout = isGitCheckout(sourceDir);
  let inPlace = opts.inPlace === true || alreadyInstalled;

  // A git checkout is a developer's working tree — don't relocate it silently.
  if (!inPlace && gitCheckout && !opts.relocate) {
    console.log('\x1b[33mℹ  This looks like a source checkout (.git present).\x1b[0m');
    console.log(`   Installing in place so your working tree stays authoritative:`);
    console.log(`   ${sourceDir}`);
    console.log('   Use --relocate to copy it into ' + INSTALL_DIR + ' instead.');
    console.log('');
    inPlace = true;
  }

  // Warn when installing in place from a folder that looks temporary — but not when
  // we chose in-place *because* it's a source checkout. A developer's working tree
  // is a deliberate, permanent location even if it lives under Desktop or Downloads,
  // and stacking a "this looks temporary" warning on top of "this is your checkout"
  // is contradictory noise.
  if (inPlace && !alreadyInstalled && !gitCheckout && isDisposableLocation(sourceDir)) {
    console.log('\x1b[33m⚠  This location looks temporary:\x1b[0m');
    console.log(`   ${sourceDir}`);
    console.log('   The service records this absolute path, so moving or deleting the');
    console.log('   folder will break it. Consider omitting --in-place so Lokyni is');
    console.log(`   installed to ${INSTALL_DIR} instead.`);
    console.log('');
  }

  // Stop any instance from a previous install before we (re)write files and register,
  // so a re-install never copies over files the running service holds open or leaves two
  // servers fighting for the same port. servicePath/taskName don't depend on the run
  // dir, so the pre-relocate lookup is accurate; a no-op on a first install.
  const existing = getServicePaths();
  if (existing) stopForReinstall(existing);

  const runDir = inPlace ? sourceDir : relocateToInstallDir(sourceDir, opts);

  const info = getServicePaths(runDir);
  if (!info) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }

  // Launch the service through a binary named "lokyni" so OS process lists show the
  // app name instead of "node". Best-effort and cosmetic — falls back to plain node.
  info.nodePath = ensureBrandedNode();
  info.branded  = path.basename(info.nodePath).replace(/\.exe$/i, '') === APP_ID;

  // Register with the OS. If this fails the files are already in place, so report
  // what succeeded and how to start Lokyni manually rather than dumping a stack.
  try {
    registerService(info);
  } catch (err) {
    console.error('');
    console.error(`\x1b[31m✖ Could not register the background service: ${(err.message || err).split('\n')[0]}\x1b[0m`);
    console.error('');
    console.error(`  Lokyni itself is installed and usable at ${info.installDir}`);
    console.error(`  Start it manually with:   cd "${info.installDir}" && node lokyni.js`);
    console.error(`  Or use pm2:               pm2 start lokyni.js --name lokyni`);
    if (info.platform === 'linux') {
      console.error('  (systemd user services need a login session — on a headless box try');
      console.error('   `loginctl enable-linger $USER` or run under pm2 instead.)');
    }
    process.exitCode = 1;
    return;
  }

  console.log(`  Run dir:  ${info.installDir}`);
  console.log(`  Config:   ${path.join(info.installDir, 'config', 'config.json')}`);
  console.log(`  Data:     ${path.join(info.installDir, 'data')}`);
  console.log(`  Logs:     ${LOG_PATH}`);
  if (info.branded) console.log(`  Process:  shows as "${APP_ID}" (not "node") in Activity Monitor / Task Manager`);
  console.log(`  Web UI:   ${getUrl()}`);
  console.log(`  Status:   node lokyni.js --status`);
  console.log(`  Remove:   node lokyni.js --uninstall`);
  if (!inPlace && path.resolve(sourceDir) !== path.resolve(info.installDir)) {
    console.log('');
    console.log(`\x1b[32m  Lokyni now runs from ${info.installDir} — the folder you installed`);
    console.log(`  from (${sourceDir}) is no longer needed and can be deleted.\x1b[0m`);
  }

  // Open the web UI once, at the end of an interactive install. This is deliberately
  // NOT done on service start: with KeepAlive a crash loop would spawn a browser tab
  // every restart, and a tab appearing unprompted at login is obnoxious. `--install`
  // is a command a person just typed, so showing them the result is expected.
  // Suppressed with --no-open, or by setting "openAfterInstall": false in config.json.
  if (!opts.noOpen && openAfterInstallEnabled()) {
    waitForServer().then(ok => {
      if (ok) openInBrowser();
      else console.log(`\n  Lokyni is still starting — open ${getUrl()} in a moment.`);
    });
  }
};

// Whether to open the browser after install. Defaults to on; a config value turns
// it off for anyone who finds it intrusive.
const openAfterInstallEnabled = () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getInstallDir(), 'config', 'config.json'), 'utf-8'));
    return cfg.openAfterInstall !== false;
  } catch { return true; }
};

// Poll the health endpoint until the freshly-registered service is actually
// listening. The service manager starts it asynchronously, so opening the browser
// immediately would land on a connection error.
const waitForServer = async (timeoutMs = 20000) => {
  const url = `${getUrl()}/status`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};

// ── Uninstall ───────────────────────────────────────────────────────────────
const uninstallService = () => {
  const info = getServicePaths();
  if (!info) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }

  if (info.platform === 'macos') {
    if (fs.existsSync(info.servicePath)) {
      launchctlBootout(info.servicePath, info.label);
      try { fs.unlinkSync(info.servicePath); } catch {}
      console.log('✓ Removed the macOS LaunchAgent');
    } else {
      console.log(`No LaunchAgent found at ${info.servicePath}`);
    }

  } else if (info.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', `${APP_ID}.service`], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(info.servicePath)) { try { fs.unlinkSync(info.servicePath); } catch {} }
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
    // Intentionally do NOT disable-linger on uninstall: linger is a per-USER setting, not per-service, so turning
    // it off here would silently break ANY other systemd user service the user runs headless (without an active
    // login). Leaving it enabled is harmless. We enable it at install because the service needs it; we can't
    // safely scope the removal, so we don't attempt it.
    console.log('✓ Removed the systemd user service');

  } else if (info.platform === 'windows') {
    try { execFileSync('schtasks', ['/delete', '/tn', info.taskName, '/f'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', info.taskName, '/f'], { stdio: 'ignore' }); } catch {}
    const vbsPath = path.join(STATE_DIR, 'lokyni-service.vbs');
    try { fs.unlinkSync(vbsPath); } catch {}
    console.log('✓ Removed the Windows background task');
  }

  stopRunning();
  // Now that the process is stopped, remove the branded launcher (Windows can't
  // delete it while it's the running image).
  removeBrandedNode();
  console.log('  Stopped the running server (if any). Your documents and index are untouched.');
};

// ── Restart ─────────────────────────────────────────────────────────────────
const restartService = () => {
  const info = getServicePaths();
  if (!info) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }

  // Pick up a newer Node after an upgrade: rebuild the branded launcher in place so
  // the relaunch runs the current runtime. No-op when branding isn't in use or the
  // launcher is already current; the service file's path doesn't change either way.
  try { if (fs.existsSync(BRANDED_PATH)) ensureBrandedNode(); } catch {}

  if (info.platform === 'macos') {
    try {
      // Use the process uid directly rather than a `$(id -u)` subshell.
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid === null) throw new Error('no uid');
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${info.label}`], { stdio: 'ignore' });
      console.log('✓ Restarted the LaunchAgent');
      return;
    } catch {
      try { launchctlBootstrap(info.servicePath); console.log('✓ Reloaded the LaunchAgent'); return; } catch {}
    }
  } else if (info.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'restart', `${APP_ID}.service`], { stdio: 'ignore' }); console.log('✓ Restarted the systemd service'); return; } catch {}
  } else if (info.platform === 'windows') {
    stopRunning();
    try { execFileSync('schtasks', ['/run', '/tn', info.taskName], { stdio: 'ignore' }); console.log('✓ Restarted the scheduled task'); return; } catch {}
    const vbsPath = path.join(STATE_DIR, 'lokyni-service.vbs');
    try { execFileSync('wscript.exe', [vbsPath], { stdio: 'ignore' }); console.log('✓ Restarted via the launcher'); return; } catch {}
  }
  console.log('Could not restart automatically — is the service installed? Try --install.');
};

// ── Status ──────────────────────────────────────────────────────────────────
const statusService = async () => {
  const info = getServicePaths();
  const pid  = readPid();
  const up   = isRunning(pid);
  const url  = getUrl();

  // Fetch health first so the header can distinguish "up and ready" from "up but
  // still loading the index" — during startup the process is alive but queries
  // would fail, and reporting a flat "running" hides that.
  let health = null;
  if (up) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) health = await res.json();
    } catch {}
  }
  const ready = health ? (health.index?.ready === true) : null;

  const headline = !up
    ? '\x1b[31m○ not running\x1b[0m'
    : ready === false
      ? '\x1b[33m◐ starting up\x1b[0m'
      : '\x1b[32m● running\x1b[0m';
  console.log(`Lokyni ${headline}${up ? `  (pid ${pid})` : ''}`);
  console.log(`  Web UI:   ${url}`);
  if (info) {
    console.log(`  Run dir:  ${info.installDir}`);
    console.log(`  Config:   ${path.join(info.installDir, 'config', 'config.json')}`);
    console.log(`  Data:     ${path.join(info.installDir, 'data')}  (documents, index, sessions)`);
  }
  console.log(`  Logs:     ${LOG_PATH}`);

  // Service registration state
  if (info?.platform === 'macos') {
    console.log(`  Service:  ${fs.existsSync(info.servicePath) ? 'installed (LaunchAgent)' : 'not installed'}`);
  } else if (info?.platform === 'linux') {
    console.log(`  Service:  ${fs.existsSync(info.servicePath) ? 'installed (systemd user)' : 'not installed'}`);
  } else if (info?.platform === 'windows') {
    let reg = 'not installed';
    try { execFileSync('schtasks', ['/query', '/tn', info.taskName], { stdio: 'ignore' }); reg = 'installed (scheduled task)'; } catch {
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', info.taskName], { stdio: ['ignore','pipe','ignore'] }).toString();
        if (out.includes(info.taskName)) reg = 'installed (registry Run key)';
      } catch {}
    }
    console.log(`  Service:  ${reg}`);
  }
  if (fs.existsSync(BRANDED_PATH)) console.log(`  Process:  runs as "${APP_ID}" in the OS process list`);
  if (pm2HasLokyni()) console.log('  pm2:      a pm2-managed Lokyni is also registered');

  // Live health (fetched above, before the header, so readiness is known).
  if (up) {
    if (health) {
      const idx = health.index || {};
      const prov = health.provider || {};
      // The index loads in stages (documents, then chunks, then BM25), so a status
      // check during startup legitimately shows partial counts. Say so, rather than
      // leaving "0 chunks" looking like a failure.
      let idxNote = '';
      if (idx.indexing)      idxNote = '  \x1b[33m(updating…)\x1b[0m';
      else if (!idx.ready)   idxNote = '  \x1b[33m(still loading — not ready for queries yet)\x1b[0m';
      console.log(`  Index:    ${idx.documents ?? '?'} documents · ${idx.chunks ?? '?'} chunks${idxNote}`);
      console.log(`  Provider: ${prov.name ?? '?'} · ${prov.model ?? '?'}${prov.embeddings ? ` · ${prov.embeddings}` : ''} ${prov.reachable === false ? `\x1b[31m(unreachable${prov.detail ? ': ' + prov.detail : ''})\x1b[0m` : ''}`);
      // Uptime is a useful sanity check when a service is restarting in a loop.
      const upSec = health.lifecycle?.uptimeSeconds;
      if (Number.isInteger(upSec)) {
        const pretty = upSec < 60 ? `${upSec}s`
          : upSec < 3600 ? `${Math.floor(upSec/60)}m`
          : upSec < 86400 ? `${Math.floor(upSec/3600)}h ${Math.floor((upSec%3600)/60)}m`
          : `${Math.floor(upSec/86400)}d ${Math.floor((upSec%86400)/3600)}h`;
        console.log(`  Uptime:   ${pretty}`);
      }
    } else {
      console.log('  Health:   server process is up but not responding yet');
    }
  }
};

// ── Integrity: does the installed service still point at files that exist? ────
// A registered service records absolute paths to the Node binary/launcher and the
// script. A Node upgrade that relocates process.execPath, a moved/deleted install dir,
// or a removed branded launcher leaves the service unable to start — invisible from
// inside the running process. This reads the INSTALLED definition and reports any
// referenced path that no longer exists. Returns { installed, missing:[...] }; best-effort
// (any parse/read error yields no findings rather than a false alarm). Used by the watchdog.
const checkServicePaths = () => {
  const info = getServicePaths();
  const out = { installed: false, missing: [] };
  if (!info) return out;
  const check = (p) => { if (p && !fs.existsSync(p)) out.missing.push(p); };
  try {
    if (info.platform === 'macos') {
      if (!fs.existsSync(info.servicePath)) return out;
      out.installed = true;
      const xml = fs.readFileSync(info.servicePath, 'utf-8');
      // The plist XML-escapes paths (& < >), so undo that before testing existence — else a
      // home directory containing '&' would look like a missing path and false-alarm.
      const xu = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
      if (block) for (const m of block[1].matchAll(/<string>([^<]*)<\/string>/g)) check(xu(m[1]));
      const wd = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
      if (wd) check(xu(wd[1]));
    } else if (info.platform === 'linux') {
      if (!fs.existsSync(info.servicePath)) return out;
      out.installed = true;
      const unit = fs.readFileSync(info.servicePath, 'utf-8');
      const exec = unit.match(/^\s*ExecStart=(.+)$/m);
      if (exec) for (const m of exec[1].matchAll(/"([^"]+)"|(\S+)/g)) { const p = m[1] || m[2]; if (p && p.startsWith('/')) check(p); }
      const wd = unit.match(/^\s*WorkingDirectory=(.+)$/m);
      if (wd && wd[1].startsWith('/')) check(wd[1].trim());
    } else if (info.platform === 'windows') {
      const vbsPath = path.join(STATE_DIR, 'lokyni-service.vbs');
      if (!fs.existsSync(vbsPath)) return out;
      out.installed = true;
      const vbs = fs.readFileSync(vbsPath, 'utf-8');
      for (const m of vbs.matchAll(/"([A-Za-z]:\\[^"]+|[^"]+\.(?:exe|js))"/gi)) check(m[1]);
    }
  } catch { /* best-effort — never turn a parse hiccup into a false alarm */ }
  return out;
};

// ── Open in browser ─────────────────────────────────────────────────────────
const openInBrowser = () => {
  const url = getUrl();
  try {
    if (process.platform === 'darwin')      execFileSync('open', [url]);
    else if (process.platform === 'win32')  execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else                                    execFileSync('xdg-open', [url]);
    console.log(`Opened ${url}`);
  } catch {
    console.log(`Open this in your browser: ${url}`);
  }
};

module.exports = {
  installService, uninstallService, restartService, statusService, openInBrowser,
  writePidFile, removePidFile, getPort, getUrl, checkServicePaths, LOG_PATH, ERR_PATH, PID_PATH, STATE_DIR,
  // Exported for the install-staging regression test (asserts no drift from package.json "files").
  stagingPlan, copyTree,
};
