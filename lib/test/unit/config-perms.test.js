'use strict';
// Guards that config.json is written owner-only (0600), with its config/ folder owner-only (0700). The
// file can hold provider API keys in cleartext, so on a shared host another local user must not be able
// to read it. config.js derives its paths from the process cwd at import time, so this test chdirs into
// a throwaway temp dir BEFORE requiring config.js (each unit-test file runs in its own process, so the
// chdir is isolated). File-mode bits are not meaningful on Windows, so the mode assertions are POSIX-only.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-cfgperm-')));
const cleanup = (code) => { try { process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  process.chdir(tmp);                       // config.js resolves ./config relative to cwd
  const config = require(path.resolve(__dirname, '..', '..', 'config'));

  config.writeConfigAtomic({ provider: 'ollama', openaiApiKey: 'sk-secret-should-not-be-world-readable' });

  const cfgFile = path.join(tmp, 'config', 'config.json');
  const cfgDir  = path.join(tmp, 'config');
  ok(fs.existsSync(cfgFile), 'writeConfigAtomic writes config/config.json');
  // The shared disk.writeFileAtomic uses a UNIQUE per-writer temp (pid+random) and renames it away, so no
  // temp residue of any name should remain in config/ (not just the old fixed `${file}.tmp`).
  ok(fs.readdirSync(cfgDir).filter(n => n.includes('.tmp')).length === 0, 'the atomic write left no temp residue');

  if (process.platform !== 'win32') {
    const fileMode = fs.statSync(cfgFile).mode & 0o777;
    ok(fileMode === 0o600, `config.json is owner-only (0600), got 0${fileMode.toString(8)}`);
    const dirMode = fs.statSync(cfgDir).mode & 0o777;
    ok(dirMode === 0o700, `the config/ folder is owner-only (0700), got 0${dirMode.toString(8)}`);
  } else {
    ok(true, 'file-mode bits are not meaningful on Windows — skipped');
  }

  // A second write (the common Settings-save case, overwriting an existing file) keeps the mode.
  config.writeConfigAtomic({ provider: 'ollama', openaiApiKey: 'sk-second' });
  if (process.platform !== 'win32') {
    const fileMode = fs.statSync(cfgFile).mode & 0o777;
    ok(fileMode === 0o600, `config.json stays owner-only (0600) after a rewrite, got 0${fileMode.toString(8)}`);
  } else {
    ok(true, 'rewrite mode check skipped on Windows');
  }

  console.log(`\nALL CONFIG-PERMS UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ CONFIG-PERMS UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
