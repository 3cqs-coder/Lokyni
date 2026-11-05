'use strict';
// Guards the server auth secret (lib/authsecret.js) used to sign CSRF tokens. It must be generated once,
// persisted owner-only, read back stably across "restarts", and sign/verify in constant time while failing
// closed on a bad signature. Functional, in a temp dir. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const secret = require(path.join(PROJECT, 'lib', 'authsecret'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-secret-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };

try {
  secret._resetCache();
  const s1 = secret.getSecret(tmp);
  ok(/^[0-9a-f]{64}$/.test(s1), 'getSecret returns a 32-byte hex secret');
  ok(fs.existsSync(path.join(tmp, secret.SECRET_FILE)), 'the secret is persisted to the config dir');
  ok(secret.getSecret(tmp) === s1, 'a second call returns the cached secret');

  // Survives a "restart": drop the cache, read again — same value from disk (so CSRF tokens stay valid).
  secret._resetCache();
  ok(secret.getSecret(tmp) === s1, 'the secret is stable across a cache reset (read back from disk)');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(tmp, secret.SECRET_FILE)).mode & 0o777;
    ok(mode === 0o600, `the secret file is owner-only (0600), got 0${mode.toString(8)}`);
  }
  console.log('✓ authsecret: generated once, persisted owner-only, stable across restarts');

  // sign/verify round-trip + rejection + fail-closed on garbage.
  const sig = secret.sign('csrf:session-abc', tmp);
  ok(/^[0-9a-f]{64}$/.test(sig), 'sign produces an HMAC hex digest');
  ok(secret.verify('csrf:session-abc', sig, tmp), 'verify accepts a valid signature');
  no(secret.verify('csrf:session-xyz', sig, tmp), 'verify rejects a signature for different data');
  no(secret.verify('csrf:session-abc', 'deadbeef', tmp), 'verify rejects a wrong-length signature');
  no(secret.verify('csrf:session-abc', '', tmp), 'verify rejects an empty signature');
  no(secret.verify('csrf:session-abc', null, tmp), 'verify fails closed on a null signature (no throw)');
  console.log('✓ authsecret: sign/verify round-trips and fails closed on a bad or missing signature');

  // secretDir: a single node keeps the secret in the LOCAL config folder; a cluster node must resolve it to the
  // SHARED data dir so every instance signs and verifies CSRF tokens + the SSO flow cookie with the same key.
  const origArgv = process.argv.slice();
  try {
    ok(secret.secretDir() === path.resolve('config'), 'single node keeps the secret in the local config folder');
    process.argv.push('--replica');   // cluster.mode() reads argv live
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    ok(secret.secretDir() === cfg.DATA_DIR, 'in cluster mode the secret resolves to the shared data dir');
  } finally { process.argv = origArgv; }
  ok(secret.secretDir() === path.resolve('config'), 'reverting cluster mode restores the local config folder');
  console.log('✓ authsecret: the secret dir is shared (data dir) in cluster mode, local otherwise');

  // ── Fail-closed: a present-but-malformed secret THROWS rather than silently regenerating (which would rotate
  // the key, invalidating every CSRF token / SSO cookie — cluster-wide). ──
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-secret-bad-'));
  fs.writeFileSync(path.join(tmp2, secret.SECRET_FILE), 'not-a-valid-secret');
  secret._resetCache();
  let threw = false;
  try { secret.getSecret(tmp2); } catch { threw = true; }
  ok(threw, 'a present-but-malformed secret throws (fail-closed) instead of regenerating');
  ok(fs.readFileSync(path.join(tmp2, secret.SECRET_FILE), 'utf-8') === 'not-a-valid-secret',
    'the malformed secret file is NOT overwritten (no silent key rotation)');
  // A short legacy (32-hex) secret is now treated as invalid (we require the 64-hex value we write).
  fs.writeFileSync(path.join(tmp2, secret.SECRET_FILE), 'a'.repeat(32));
  secret._resetCache();
  let threw2 = false;
  try { secret.getSecret(tmp2); } catch { threw2 = true; }
  ok(threw2, 'a too-short legacy secret is rejected (64-hex floor), not trusted');
  // verify() still fails closed (never throws) even when the secret is broken.
  no(secret.verify('csrf:x', 'deadbeef'.repeat(8), tmp2), 'verify fails closed (false) when the secret is broken');
  fs.rmSync(tmp2, { recursive: true, force: true });
  secret._resetCache();
  console.log('✓ authsecret: fail-closed on a present-but-malformed/short secret (never silently regenerated)');

  // ── Warm-at-boot: the server establishes the secret once up front, non-fatally ──
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/require\('\.\/authsecret'\)\.getSecret\(\)/.test(serverSrc), 'the server warms the auth secret at boot');
  ok(/catch \(e\) \{ console\.warn\([^)]*Auth secret could not be established at boot/.test(serverSrc),
    'the boot warm is non-fatal — a failure warns and defers to first-use (never crashes startup)');
  console.log('✓ authsecret: warmed once at boot (off the first-request path), non-fatally');

  console.log(`\nALL AUTHSECRET UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ AUTHSECRET UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
