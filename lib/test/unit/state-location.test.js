'use strict';
// Guards WHERE an instance's state lives, so config, pid, and data can't silently split across the three
// packaging modes or collide between standalone instances:
//   • config.json follows an explicit --config-dir, else a relocated --data-dir, else stays cwd-relative
//     (the layout the shipped standalone/Docker/desktop modes rely on, since each pins cwd and passes no flag);
//   • the auth session-secret lives in that same config dir (never wandering with the cwd, which would mint a
//     new secret and log everyone out);
//   • the pid follows --state-dir (the installed service embeds one — unchanged), else a relocated --data-dir
//     (so two standalone instances on different data dirs don't collide on one pid), else ~/.lokyni.
// Both modules read process.argv at load, so each case is checked in its OWN child process with controlled
// args and cwd — exactly how the real CLI parses them. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Resolve one exported path from a module, in a child process, with the given extra argv and cwd.
const resolveIn = (moduleRel, exportName, args, cwd) => {
  const mod = path.join(PROJECT, moduleRel).replace(/\\/g, '\\\\');
  const code = `const m=require('${mod}'); process.stdout.write(String(m['${exportName}']));`;
  return execFileSync(process.execPath, ['-e', code, '--', ...args], { cwd, encoding: 'utf-8' }).trim();
};

try {
  // realpath the temp root: on macOS os.tmpdir() is /var/... but a child process resolves its cwd to the real
  // /private/var/..., so the default (cwd-relative) expectation must use the real path to match.
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-stateloc-')));
  const cwdDir = path.join(TMP, 'cwd'); fs.mkdirSync(cwdDir, { recursive: true });
  const dataDir = path.join(TMP, 'mydata');
  const cfgDir  = path.join(TMP, 'mycfg');

  // ── config.json location ──
  const cfgDefault = resolveIn('lib/config.js', 'CONFIG_PATH', [], cwdDir);
  ok(cfgDefault === path.join(cwdDir, 'config', 'config.json'),
    `no flags: config.json is cwd-relative (${cfgDefault}) — the shipped modes' layout is unchanged`);

  const cfgFollowsData = resolveIn('lib/config.js', 'CONFIG_PATH', ['--data-dir', dataDir], cwdDir);
  ok(cfgFollowsData === path.join(dataDir, 'config', 'config.json'),
    `--data-dir relocates config WITH the data (${cfgFollowsData}) — config and data can't split`);

  const cfgOverride = resolveIn('lib/config.js', 'CONFIG_PATH', ['--config-dir', cfgDir, '--data-dir', dataDir], cwdDir);
  ok(cfgOverride === path.join(cfgDir, 'config.json'),
    `--config-dir wins over --data-dir (${cfgOverride})`);

  // ── the auth secret sits in the config dir (single source), so it never wanders and logs users out ──
  const authSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'authsecret.js'), 'utf-8');
  ok(/require\('\.\/config'\)\.CONFIG_DIR/.test(authSrc),
    'the single-node auth secret dir is config.CONFIG_DIR (follows --config-dir / --data-dir, never the cwd)');

  // ── pid location ──
  const home = os.homedir();
  const pidDefault = resolveIn('lib/service.js', 'PID_PATH', [], cwdDir);
  ok(pidDefault === path.join(home, '.lokyni', 'lokyni.pid'),
    `no flags: pid stays in ~/.lokyni (${pidDefault}) — the bare CLI still finds it`);

  const pidFollowsData = resolveIn('lib/service.js', 'PID_PATH', ['--data-dir', dataDir], cwdDir);
  ok(pidFollowsData === path.join(dataDir, 'lokyni.pid'),
    `--data-dir takes the pid WITH it (${pidFollowsData}) — two standalone instances don't collide`);

  // The installed service embeds --state-dir, which must WIN over --data-dir so its pid lands where the CLI
  // (and the service unit's own log redirection) expect it — the installed-service path is unchanged.
  const pidStateWins = resolveIn('lib/service.js', 'PID_PATH', ['--state-dir', cfgDir, '--data-dir', dataDir], cwdDir);
  ok(pidStateWins === path.join(cfgDir, 'lokyni.pid'),
    `--state-dir wins over --data-dir for the pid (${pidStateWins}) — the installed service is unchanged`);

  // LOG/ERR stay STATE_DIR-based even with --data-dir (they belong to the service unit + management CLI, not a
  // foreground run), so the install flow is untouched.
  const logWithData = resolveIn('lib/service.js', 'LOG_PATH', ['--data-dir', dataDir], cwdDir);
  ok(logWithData === path.join(home, '.lokyni', 'lokyni.log'),
    `--data-dir does NOT move the service log path (${logWithData}) — the install flow is untouched`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log('✓ state-location: config/secret/pid follow the right dir; installed-service + shipped-mode layouts unchanged');
  console.log(`\nALL STATE-LOCATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ STATE-LOCATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
