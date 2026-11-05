'use strict';
// Offline tests for the operational-hardening layer:
//   • lib/logbuffer redact()   — secrets are masked by shape; ordinary text is untouched.
//   • lib/disk freeBytes()     — returns a non-negative number or null, never throws.
//   • lib/config               — a BROKEN config.json refuses to start (exit 1) while a
//                                valid or missing one starts clean (exit 0).
// Pure functions + a subprocess for the config exit behavior. No model, no index.
// Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawnSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-hard-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  // ── logbuffer.redact ─────────────────────────────────────────────────────
  const { redact } = require(path.join(PROJECT, 'lib', 'logbuffer'));
  const bearer = redact('Authorization: Bearer abc123.def-456');
  ok(bearer.includes('***') && !/abc123/.test(bearer), 'bearer token masked');
  ok(bearer === 'Authorization: ***', 'adjacent masks from overlapping rules collapse to a single ***');
  const basic = redact('Authorization: Basic dXNlcjpwYXNzd29yZA==');
  ok(basic.includes('***') && !/dXNlcjpwYXNzd29yZA/.test(basic), 'HTTP Basic auth credential masked');
  ok(!/theme=dark/.test(redact('Cookie: sessionid=SECRET; theme=dark')) && redact('Cookie: sessionid=SECRET; theme=dark').includes('***'), 'cookie header value masked');
  ok(redact('key sk-ABCDEFGHIJKLMNOP123').includes('sk-***'), 'OpenAI-style key masked');
  ok(redact('using lok_AbCd1234EfGh').includes('lok_***') && !/AbCd1234/.test(redact('using lok_AbCd1234EfGh')), 'Lokyni API key masked');
  ok(redact('fetch https://alice:s3cret@example.com/x') === 'fetch https://alice:***@example.com/x', 'user:pass@ URL password masked');
  ok(redact('GET /x?api_key=SUPERSECRETVALUE&z=1').includes('api_key=***') && !/SUPERSECRET/.test(redact('GET /x?api_key=SUPERSECRETVALUE&z=1')), 'query-param secret masked');
  ok(redact('{"password":"hunter2"}').includes('***') && !/hunter2/.test(redact('{"password":"hunter2"}')), 'password field masked');
  // Conservative: ordinary text (including a bare "key") is NOT mangled.
  ok(redact('cache key = abc123 rebuilt') === 'cache key = abc123 rebuilt', 'a bare "key" in ordinary text is left alone');
  ok(redact('indexed 42 documents in 3s') === 'indexed 42 documents in 3s', 'a line with no secret trigger is returned unchanged');
  console.log('✓ hardening: log redaction masks secret shapes, leaves ordinary text intact');

  // ── disk.freeBytes / probeWritable ────────────────────────────────────────
  const diskMod = require(path.join(PROJECT, 'lib', 'disk'));
  const { freeBytes } = diskMod;
  ok(typeof diskMod.LOW_DISK_BYTES === 'number', 'the shared low-disk threshold is exported');
  ok(/probeWritable/.test(fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8')),
    'startup probes the data and configuration folders before warming');
  const writableDir = path.join(tmp, 'writable');
  const writable = diskMod.probeWritable(writableDir);
  ok(writable.ok && writable.path === path.resolve(writableDir), 'a writable data folder passes the real write probe');
  ok(fs.readdirSync(writableDir).length === 0, 'the write probe leaves no file behind');
  const notADir = path.join(tmp, 'not-a-directory');
  fs.writeFileSync(notADir, 'x');
  const rejected = diskMod.probeWritable(notADir);
  ok(!rejected.ok && rejected.code, 'a path that cannot be a writable directory is rejected with an error code');
  // Both the boot warning and the periodic watchdog read the one threshold, so their guidance can't diverge.
  ok(/LOW_DISK_BYTES/.test(fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8')), 'the boot path uses the shared low-disk threshold');
  ok(/LOW_DISK_BYTES/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'watchdog.js'), 'utf-8')), 'the watchdog uses the shared low-disk threshold');
  const hasStatfs = typeof fs.statfsSync === 'function';
  const free = freeBytes(tmp);
  ok(free === null || (typeof free === 'number' && free >= 0), 'freeBytes returns a non-negative number or null');
  if (hasStatfs) ok(typeof free === 'number' && free >= 0, 'on a platform with statfs, an existing dir yields a byte count');
  // A not-yet-created path climbs to the nearest existing ancestor (never throws).
  const climbed = freeBytes(path.join(tmp, 'does', 'not', 'exist', 'x'));
  ok(climbed === null || (typeof climbed === 'number' && climbed >= 0), 'freeBytes climbs to an existing ancestor for a missing dir, never throws');
  if (hasStatfs) ok(typeof climbed === 'number', 'the missing-dir probe still returns a number via the ancestor');
  console.log('✓ hardening: disk.freeBytes returns a sane value, climbs to an ancestor, never throws');

  // ── config: broken refuses to start; valid/missing start clean ───────────
  const runConfig = (cwd) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(PROJECT, 'lib', 'config.js'))})`], { cwd, encoding: 'utf-8' });

  // config.json lives in a config/ folder beside the install (cwd-relative), so write it there.
  const writeCfg = (dir, contents) => {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), contents);
  };

  const brokenDir = path.join(tmp, 'broken'); fs.mkdirSync(brokenDir);
  writeCfg(brokenDir, '{ "provider": "ollama", }bad');   // trailing comma + junk
  const broken = runConfig(brokenDir);
  ok(broken.status === 1, 'a broken config.json exits non-zero (refuse to start)');
  ok(/not valid JSON/.test(broken.stderr || ''), 'the broken-config error names the cause (invalid JSON)');

  const validDir = path.join(tmp, 'valid'); fs.mkdirSync(validDir);
  writeCfg(validDir, JSON.stringify({ provider: 'ollama', model: 'llama3.2' }));
  ok(runConfig(validDir).status === 0, 'a valid config.json starts clean');

  // A config-time warning (binding to 0.0.0.0 without an account) is logged through lib/logbuffer's
  // console wrapper while config is still evaluating. That must not produce Node's circular-dependency
  // warning for `fileLogging`; the logger checks that config has finished loading first.
  const warnDir = path.join(tmp, 'bindwarn'); fs.mkdirSync(warnDir);
  writeCfg(warnDir, JSON.stringify({ provider: 'ollama', model: 'llama3.2', bindAddress: '0.0.0.0' }));
  const warnScript = `require(${JSON.stringify(path.join(PROJECT, 'lib', 'logbuffer.js'))}).install();` +
    `require(${JSON.stringify(path.join(PROJECT, 'lib', 'config.js'))});`;
  const warned = spawnSync(process.execPath, ['-e', warnScript], { cwd: warnDir, encoding: 'utf-8' });
  ok(warned.status === 0, 'config loads when a boot warning fires');
  ok(/bound to 0\.0\.0\.0|Network access/i.test((warned.stderr || '') + (warned.stdout || '')), 'the exposure warning was emitted');
  ok(!/circular dependency/i.test(warned.stderr || ''), 'the early warning does not trigger a circular-dependency warning');

  const missingDir = path.join(tmp, 'missing'); fs.mkdirSync(missingDir);
  ok(runConfig(missingDir).status === 0, 'a missing config.json falls back to defaults (starts clean)');
  console.log('✓ hardening: broken config refuses to start; valid/missing start clean');

  console.log(`\nALL HARDENING UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ HARDENING UNIT TEST FAILED:', e.message);
  cleanup(1);
}
