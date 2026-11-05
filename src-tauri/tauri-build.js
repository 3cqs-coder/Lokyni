'use strict';
// Runs `tauri build`, adding `--target` only when LOKYNI_TAURI_TARGET is set. The macOS universal CI
// leg sets it to `universal-apple-darwin` so Tauri lipo's both architectures into one .app; local dev
// and the Windows/Linux legs leave it unset and get a normal host-target build — unchanged behavior.
// Any extra CLI arguments are forwarded (e.g. `-- --debug`).
//
// macOS DMGs: Tauri styles the disk-image window through Finder AppleScript. That step is flaky across
// Finder/macOS states and can fail with "Can't get disk" (-1728) after the app has already built. Retrying
// would rebuild the staged app and run the compile a second time, so local macOS builds use the same plain
// CI layout as the release builds by default. Set LOKYNI_DMG_STYLE=1 to opt into the Finder-styled window;
// that build fails rather than silently rebuilding if Finder cannot lay it out.
const { spawn } = require('child_process');
const path = require('path');

const target = String(process.env.LOKYNI_TAURI_TARGET || '').trim();
// @tauri-apps/cli is a root dependency, so its binary lives in the repo-root node_modules/.bin.
const isWin = process.platform === 'win32';
const bin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'tauri.cmd' : 'tauri');
const args = ['build', ...(target ? ['--target', target] : []), ...process.argv.slice(2)];
// On Windows the binary is a `.cmd` shim, and since the Node CVE-2024-27980 fix (present in every Node this
// project supports) spawn/spawnSync refuse to run a .cmd/.bat unless shell:true — otherwise they fail with
// EINVAL and the Windows desktop build never produces an installer. Run it through the shell on Windows, with
// the binary path quoted so an install path containing a space still resolves. POSIX keeps the direct, no-shell
// spawn of the bare `tauri` symlink. Our args are fixed tokens (no spaces, no user input), so they need no
// extra quoting in the shell form.
const command = isWin ? `"${bin}"` : bin;

const styleDmg = process.platform === 'darwin' && process.env.LOKYNI_DMG_STYLE === '1';
const env = { ...process.env };
if (process.platform === 'darwin' && !styleDmg) {
  // Tauri skips the Finder AppleScript when CI is set. Remove an explicit opt-out so the plain layout is
  // actually used; otherwise the default would still attempt (and possibly fail) the styled path.
  env.CI = 'true';
  delete env.TAURI_BUNDLER_DMG_IGNORE_CI;
}

const run = () => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env, shell: isWin });
  let output = '';
  if (child.stdout) child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
  if (child.stderr) child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
  child.once('error', (error) => resolve({ error, output, status: null }));
  child.once('close', (status) => resolve({ status, output }));
});

(async () => {
  const result = await run();
  if (result.error) { console.error(`Failed to run tauri: ${result.error.message}`); process.exitCode = 1; return; }
  if (result.status !== 0 && styleDmg && /Failed running AppleScript|Can't get disk|\(-1728\)/i.test(result.output)) {
    console.error('\nThe Finder-styled DMG layout failed. Unset LOKYNI_DMG_STYLE to build the plain CI layout in one pass.');
  }
  process.exitCode = result.status == null ? 1 : result.status;
})();
