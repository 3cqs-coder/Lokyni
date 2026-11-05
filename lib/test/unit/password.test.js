'use strict';
// Guards password hashing (lib/password.js). Human accounts rest on this: a correct password must verify, a
// wrong one must not, the stored form must be self-describing (so cost can rise without breaking old hashes),
// and a malformed/garbage stored hash must fail closed (return false), never throw. Hashing is scrypt via
// node:crypto — no native addon, same on every platform. Functional, no model/network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { hashPassword, verifyPassword, dummyHash } = require(path.join(PROJECT, 'lib', 'password'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };

(async () => {
  try {
    // ── Round-trip: the right password verifies, the wrong one does not ──
    const hash = await hashPassword('correct horse battery staple');
    ok(/^scrypt:\d+:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/.test(hash), 'the stored hash is self-describing (scrypt:N:r:p:keylen:salt:hash)');
    ok(await verifyPassword('correct horse battery staple', hash), 'the correct password verifies');
    no(await verifyPassword('wrong password', hash), 'a wrong password does not verify');
    no(await verifyPassword('', hash), 'an empty candidate does not verify');
    console.log('✓ password: a correct password verifies and a wrong one is rejected');

    // ── Unique salt: the same password hashes to different strings, both valid ──
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    ok(h1 !== h2, 'the same password produces different hashes (random per-hash salt)');
    ok(await verifyPassword('same-password', h1) && await verifyPassword('same-password', h2), 'both salted hashes verify');
    console.log('✓ password: each hash uses a fresh random salt, and both verify');

    // ── Self-describing: a hash made with different embedded params still verifies ──
    // Simulate an "old" hash whose embedded cost differs from the current default by rewriting N downward.
    // verifyPassword must re-derive with the STORED params, not the current ones.
    const parts = hash.split(':');                 // scrypt:N:r:p:keylen:salt:hashHex — we can't cheaply
    ok(parts.length === 7, 'hash splits into 7 fields');  // forge a valid hash at a different N here, so just
    ok(Number(parts[1]) >= 2, 'the embedded N is present and sane');   // assert the params are embedded for the reader to use.
    console.log('✓ password: cost parameters are embedded in the hash so they can be raised without breaking old hashes');

    // ── Fail-closed on malformed/garbage stored hashes (never throw) ──
    for (const bad of ['', 'not-a-hash', 'scrypt:bad', 'scrypt:16384:8:1:64:zz:zz', 'bcrypt:1:2:3:4:ab:cd',
                       'scrypt:16384:8:1:64::' + 'ab'.repeat(64), null, undefined, 42, {}]) {
      // eslint-disable-next-line no-await-in-loop
      no(await verifyPassword('whatever', bad), `a malformed stored hash fails closed: ${JSON.stringify(bad)}`);
    }
    console.log('✓ password: malformed/garbage stored hashes fail closed (false), never throw');

    // ── hashPassword rejects an empty/invalid plaintext (a bug, not a login attempt) ──
    let threw = false;
    try { await hashPassword(''); } catch { threw = true; }
    ok(threw, 'hashing an empty password throws (programming error, caught before storage)');

    // ── Dummy hash for enumeration defense: valid format, verifies against nothing real ──
    const d = await dummyHash();
    ok(/^scrypt:/.test(d), 'the dummy hash has the real format (so unknown-user login does the same work)');
    ok(await dummyHash() === d, 'the dummy hash is cached (computed once)');
    no(await verifyPassword('guess', d), 'no guess verifies against the dummy hash');
    console.log('✓ password: the enumeration-defense dummy hash is valid-format, cached, and unguessable');

    // ── Stored params are honored within a BOUNDED envelope (future-proof + OOM/crash-proof) ──
    const crypto = require('crypto');
    // Build a genuinely valid hash at a different (lower, power-of-two) N; the verifier must re-derive with the
    // STORED parameters, not the current defaults, so this still verifies.
    const low = await new Promise((res, rej) => {
      const salt = crypto.randomBytes(16);
      crypto.scrypt('alt-cost', salt, 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, dk) =>
        e ? rej(e) : res(`scrypt:1024:8:1:64:${salt.toString('hex')}:${dk.toString('hex')}`));
    });
    ok(await verifyPassword('alt-cost', low), 'a hash with valid lower-N stored params verifies (re-derives with the stored cost)');
    no(await verifyPassword('nope', low), 'a wrong password still fails against a lower-N hash');
    // A structurally valid hash whose cost is OUTSIDE the accepted envelope must fail closed — the verifier
    // refuses the absurd work factor at the parameter check, before scrypt ever allocates (OOM/crash guard).
    const hexSalt = 'ab'.repeat(16), hexHash = 'cd'.repeat(64);
    no(await verifyPassword('x', `scrypt:${1 << 20}:8:1:64:${hexSalt}:${hexHash}`), 'an out-of-envelope N (too large) fails closed before scrypt runs');
    no(await verifyPassword('x', `scrypt:1000:8:1:64:${hexSalt}:${hexHash}`), 'a non-power-of-two N (corruption) is rejected');
    no(await verifyPassword('x', `scrypt:16384:999:1:64:${hexSalt}:${hexHash}`), 'an out-of-envelope r is rejected');
    console.log('✓ password: stored cost parameters are honored within a bounded envelope and rejected outside it');

    console.log(`\nALL PASSWORD UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ PASSWORD UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
