'use strict';
// Secret-at-rest sealing (lib/secretbox.js). The invariants that matter: a sealed value round-trips, it is
// bound to its field label and its key (so a swapped field or a wrong key can't open it), tampering is
// detected, and — the safety-critical ones — it is idempotent, never throws, and NEVER turns a credential
// into something unrecoverable (no key → stays plaintext; a value that doesn't verifiably round-trip stays
// plaintext). node:crypto only, hermetic temp key files. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const sb = require(path.join(PROJECT, 'lib', 'secretbox'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-sb-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  const keyFile = path.join(tmp, 'data', 'secret.key');   // nested, so first use must mkdir
  const SECRET = 'sk-proj-ABCDEFGHIJKLMNOP1234567890';

  // ── round-trip + the key file is created 0600 in a 0700 dir on first use ──
  const sealed = sb.seal(SECRET, 'openaiApiKey', keyFile);
  ok(sb.isSealed(sealed) && sealed.startsWith('sb1:'), 'seal produces an sb1: envelope');
  ok(!sealed.includes(SECRET), 'the plaintext does not appear in the sealed value');
  eq(sb.open(sealed, 'openaiApiKey', keyFile), SECRET, 'open round-trips to the exact plaintext');
  ok(fs.existsSync(keyFile), 'the master key file is created on first use');
  if (process.platform !== 'win32') {
    eq(fs.statSync(keyFile).mode & 0o777, 0o600, 'the key file is 0600');
    eq(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700, 'the key dir is 0700');
  }

  // ── label binding: a value sealed for one field can't be opened as another ──
  eq(sb.open(sealed, 'anthropicApiKey', keyFile), null, 'a different field label cannot open it (bound to its name)');

  // ── wrong key cannot open it ──
  const otherKey = path.join(tmp, 'other.key');
  fs.writeFileSync(otherKey, require('crypto').randomBytes(32));
  eq(sb.open(sealed, 'openaiApiKey', otherKey), null, 'a different master key cannot open it');

  // ── tamper detection (GCM auth tag) ──
  const bytes = Buffer.from(sealed.slice(4), 'base64'); bytes[bytes.length - 1] ^= 0xff;
  const tampered = 'sb1:' + bytes.toString('base64');
  eq(sb.open(tampered, 'openaiApiKey', keyFile), null, 'a tampered ciphertext does not open');

  // ── idempotent: sealing an already-sealed value returns it unchanged (no double-seal) ──
  eq(sb.seal(sealed, 'openaiApiKey', keyFile), sealed, 'sealing an already-sealed value is a no-op');

  // ── empty / non-string inputs pass through untouched ──
  eq(sb.seal('', 'x', keyFile), '', 'empty string seals to empty (nothing to protect)');
  eq(sb.seal(undefined, 'x', keyFile), undefined, 'a non-string passes through');

  // ── SAFETY: no key available → stays plaintext (never an unrecoverable secret) ──
  sb._reset();
  const roDir = path.join(tmp, 'nokey');
  // Point at a path we can't create (parent is a file, so mkdir fails) → master() returns null.
  fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
  const unwritable = path.join(tmp, 'blocker', 'secret.key');
  eq(sb.seal(SECRET, 'openaiApiKey', unwritable), SECRET, 'no writable key → seal keeps plaintext');
  eq(sb.sealVerified(SECRET, 'openaiApiKey', unwritable), SECRET, 'no writable key → sealVerified keeps plaintext');

  // ── sealVerified proves the round-trip before trusting the ciphertext ──
  sb._reset();
  const vSealed = sb.sealVerified(SECRET, 'ollamaApiKey', keyFile);
  ok(sb.isSealed(vSealed) && sb.open(vSealed, 'ollamaApiKey', keyFile) === SECRET, 'sealVerified returns a verified-openable envelope');

  // ── readSecret: sealed → opened; legacy plaintext → passthrough; unopenable → verbatim (fail clean) ──
  eq(sb.readSecret(vSealed, 'ollamaApiKey', keyFile), SECRET, 'readSecret opens a sealed value');
  eq(sb.readSecret('legacy-plaintext-key', 'ollamaApiKey', keyFile), 'legacy-plaintext-key', 'readSecret passes legacy plaintext through (lazy migration)');
  eq(sb.readSecret(tampered, 'openaiApiKey', keyFile), tampered, 'readSecret returns an unopenable sealed value verbatim (auth fails cleanly, no crash)');

  // ── env-var master: short env is refused; a usable env seals without any key file ──
  sb._reset();
  const savedEnv = process.env[sb.ENV_VAR];
  process.env[sb.ENV_VAR] = 'short';
  eq(sb.master(sb.ENV_SENTINEL), null, 'an env key under 16 chars is refused (too weak)');
  sb._reset();
  process.env[sb.ENV_VAR] = 'a-sufficiently-long-operator-supplied-master-key';
  const envSealed = sb.seal(SECRET, 'clientSecret', sb.ENV_SENTINEL);
  ok(sb.isSealed(envSealed) && sb.open(envSealed, 'clientSecret', sb.ENV_SENTINEL) === SECRET, 'a usable $LOKYNI_SECRET_KEY seals/opens with no key file');
  if (savedEnv === undefined) delete process.env[sb.ENV_VAR]; else process.env[sb.ENV_VAR] = savedEnv;

  // ── isSealed boundary: a short sb1:-prefixed string that is too short to be an envelope is NOT sealed ──
  ok(!sb.isSealed('sb1:tooshort'), 'a too-short sb1: string is not treated as a sealed envelope');

  console.log(`\nALL SECRETBOX TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ SECRETBOX TEST FAILED:', e && e.message);
  cleanup(1);
}
