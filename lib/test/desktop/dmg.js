'use strict';
// Verify the actual macOS installer users receive. The build directory was already exercised; this mounts the
// newest DMG read-only and checks the artifact itself: its ad-hoc signature, bundle version, macOS floor, app
// executable, and packaged sidecar/runtime. It never launches the app or touches user data.
//
// Run after `npm run tauri:build`:
//   npm run verify:dmg
//   node lib/test/desktop/dmg.js --dmg=path/to/Lokyni.dmg
//
// macOS-only. On another operating system it reports a skip so the command stays usable in a mixed CI script.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));
const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const dirExists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const plistValue = (plist, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim();

const main = () => {
  if (process.platform !== 'darwin') {
    console.log('DMG verification is macOS-only; skipped on this host.');
    return 0;
  }

  const arg = process.argv.find((a) => a.startsWith('--dmg='));
  let dmg = arg ? path.resolve(arg.slice('--dmg='.length)) : null;
  if (!dmg) {
    const dir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
    const candidates = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n) => n.endsWith('.dmg')).map((n) => path.join(dir, n))
      : [];
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    dmg = candidates[0] || null;
  }
  if (!dmg || !fileExists(dmg)) {
    console.error('No DMG found. Build it first with `npm run tauri:build`, or pass --dmg=<path>.');
    return 1;
  }

  const pkg = readJson('package.json');
  const conf = readJson('src-tauri/tauri.conf.json');
  const expectedVersion = pkg.version;
  const expectedFloor = conf && conf.bundle && conf.bundle.macOS && conf.bundle.macOS.minimumSystemVersion;
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dmg-'));
  let mounted = false;
  try {
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    mounted = true;

    const appName = fs.readdirSync(mount).find((n) => n.endsWith('.app'));
    if (!appName) throw new Error('The DMG contains no .app bundle.');
    const app = path.join(mount, appName);
    const plist = path.join(app, 'Contents', 'Info.plist');

    const version = plistValue(plist, 'CFBundleShortVersionString');
    if (version !== expectedVersion) {
      throw new Error(`The DMG app version is ${version}; package.json is ${expectedVersion}.`);
    }
    const floor = plistValue(plist, 'LSMinimumSystemVersion');
    if (!expectedFloor || floor !== expectedFloor) {
      throw new Error(`The DMG macOS floor is ${floor}; tauri.conf.json is ${expectedFloor}.`);
    }

    // The bundle is ad-hoc signed. A broken or missing signature is what makes a downloaded app report as
    // damaged, so this is a hard failure. Notarization is separate and intentionally absent.
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const assess = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', app], { encoding: 'utf-8' });
    const notarized = assess.status === 0;

    const macosDir = path.join(app, 'Contents', 'MacOS');
    const binary = fs.readdirSync(macosDir).filter((n) => !n.startsWith('.')).map((n) => path.join(macosDir, n)).find(fileExists);
    if (!binary) throw new Error('The app bundle has no executable.');
    fs.accessSync(binary, fs.constants.X_OK);

    const payload = [
      'Contents/Resources/app/lokyni.js',
      'Contents/Resources/app/lib/paths.js',
      'Contents/Resources/app/runtime/node',
      'Contents/Resources/app/node_modules/express/package.json',
      'Contents/Resources/app/docs/README.md',
      'Contents/Resources/app/tessdata/eng.traineddata.gz',   // bundled English OCR pack — reads scanned pages offline
    ];
    for (const rel of payload) {
      if (!fileExists(path.join(app, rel))) throw new Error(`The app bundle is missing ${rel}.`);
    }
    fs.accessSync(path.join(app, 'Contents/Resources/app/runtime/node'), fs.constants.X_OK);

    const archs = run('/usr/bin/lipo', ['-archs', binary]).trim();
    if (!archs) throw new Error('The app executable reports no architecture.');

    console.log(`DMG: ${path.relative(ROOT, dmg)}`);
    console.log(`App: ${appName} ${version}, macOS ${floor}, architectures: ${archs}`);
    console.log(`Signature: valid${notarized ? ' (notarized)' : ' (ad-hoc; not notarized, as expected)'}`);
    console.log('Payload: app entry, shared paths module, runtime, dependencies, and guide present');
    console.log('\nDMG VERIFICATION PASSED');
    return 0;
  } catch (e) {
    console.error(`\nDMG VERIFICATION FAILED: ${e && e.message ? e.message : e}`);
    if (e && e.stderr) console.error(String(e.stderr).trim());
    return 1;
  } finally {
    if (mounted) {
      try { run('/usr/bin/hdiutil', ['detach', mount, '-force']); }
      catch { try { spawnSync('/usr/bin/hdiutil', ['detach', mount, '-force']); } catch { /* best-effort */ } }
    }
    try { fs.rmSync(mount, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
};

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
