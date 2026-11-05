'use strict';
// Guards the shared scrypt cost-parameter helpers (lib/scrypt.js). These are the ONE place the human-password
// hasher and the backup-archive KDF agree on "is this a sane work factor" and "how large may maxmem be", so the
// two can't drift. Functional, no model/network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const scrypt = require(path.join(PROJECT, 'lib', 'scrypt'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── isPowerOfTwo: scrypt requires N to be a power of two ──
  for (const n of [1, 2, 4, 1024, 16384, 1 << 18]) ok(scrypt.isPowerOfTwo(n), `${n} is a power of two`);
  for (const n of [0, 3, 1000, 16383, -2, 2.5, NaN, Infinity, '16384', null, undefined]) ok(!scrypt.isPowerOfTwo(n), `${n} is not accepted as a power of two`);
  console.log('✓ scrypt: isPowerOfTwo accepts only integer powers of two');

  // ── workingSetBytes is the standard ~128*N*r (p deliberately excluded) ──
  eq(scrypt.workingSetBytes({ N: 16384, r: 8 }), 128 * 16384 * 8, 'working set is 128*N*r for the default params');
  eq(scrypt.workingSetBytes({ N: 1024, r: 1 }), 128 * 1024, 'working set scales with N and r');
  console.log('✓ scrypt: workingSetBytes is 128*N*r');

  // ── maxmemForBounds: twice the working set of the MAX params, plus a fixed slack ──
  const SLACK = 16 * 1024 * 1024;
  eq(scrypt.maxmemForBounds({ N: 1 << 16, r: 8 }), 128 * (1 << 16) * 8 * 2 + SLACK, 'ceiling is 2x the working set + slack');
  ok(scrypt.maxmemForBounds({ N: 16384, r: 8 }) > scrypt.workingSetBytes({ N: 16384, r: 8 }), 'the ceiling comfortably exceeds the working set');
  // Parity lock: the backup KDF ceiling must equal the helper applied to its MAX bound, i.e. the long-standing
  // value `256*N*r + 16MB` for N=2^18, r=8. If the helper's formula ever changes, this catches the drift.
  const BACKUP_MAX = { N: 1 << 18, r: 8, p: 4 };
  eq(scrypt.maxmemForBounds(BACKUP_MAX), 256 * BACKUP_MAX.N * BACKUP_MAX.r + SLACK, 'the backup KDF ceiling value is preserved by the shared helper');
  console.log('✓ scrypt: maxmemForBounds is fixed-bound-derived and preserves the backup KDF value');

  console.log(`\nALL SCRYPT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SCRYPT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
