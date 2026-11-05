'use strict';
// Functional test for the per-API-key sliding-window rate limiter (lib/ratelimit.js), which throttles
// BOTH the HTTP API and the MCP endpoint. It is deterministic and trivially testable, yet a prune
// off-by-one, a mishandled limit===0 (unlimited), a bad resetMs, or shared per-key state would silently
// disable throttling (a DoS of the single local model) or lock out a legitimate key — invisibly. The
// module reads Date.now() live, so the window-expiry case is exercised by mocking the global clock.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { check, __test } = require(path.join(PROJECT, 'lib', 'ratelimit'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

let idSeq = 0;
const key = (rateLimit) => ({ id: `k${++idSeq}`, ...(rateLimit === undefined ? {} : { rateLimit }) });

try {
  // ── Within the limit: the Nth request is allowed, N+1 is denied with a sane resetMs ──
  {
    const k = key(3);
    for (let i = 1; i <= 3; i++) {
      const r = check(k);
      ok(r.allowed, `request ${i} of 3 is allowed`);
      eq(r.limit, 3, 'the resolved limit is the per-key value');
    }
    const denied = check(k);
    ok(!denied.allowed, 'the 4th request over a limit of 3 is denied');
    eq(denied.remaining, 0, 'a denied request reports zero remaining');
    ok(denied.resetMs > 0 && denied.resetMs <= 60000, 'a denied request reports a sane Retry-After window');
    console.log('✓ ratelimit: Nth allowed, N+1 denied with a sane resetMs');
  }

  // ── limit === 0 means unlimited ──
  {
    const k = key(0);
    let allAllowed = true;
    for (let i = 0; i < 50; i++) if (!check(k).allowed) allAllowed = false;
    ok(allAllowed, 'rateLimit:0 allows every request (explicit opt-out)');
    eq(check(k).limit, 0, 'an unlimited key reports limit 0');
    console.log('✓ ratelimit: rateLimit:0 is unlimited');
  }

  // ── Per-key isolation: one key hitting its limit does not affect another ──
  {
    const a = key(1), b = key(1);
    ok(check(a).allowed, 'key A first request allowed');
    ok(!check(a).allowed, 'key A second request denied (limit 1)');
    ok(check(b).allowed, 'key B is unaffected by A hitting its limit');
    console.log('✓ ratelimit: counters are isolated per key');
  }

  // ── Window expiry: capacity frees after the 60s window (mock the clock) ──
  {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      const k = key(2);
      ok(check(k).allowed, 'req1 at t0 allowed');
      ok(check(k).allowed, 'req2 at t0 allowed');
      ok(!check(k).allowed, 'req3 at t0 denied (limit 2)');
      t += 61_000;   // advance past the 60s window
      ok(check(k).allowed, 'after the window expires, capacity frees and a request is allowed again');
    } finally {
      Date.now = realNow;
    }
    console.log('✓ ratelimit: the sliding window frees capacity after it elapses');
  }

  // ── Default limit applies when a key sets none ──
  {
    const k = key(undefined);
    const r = check(k);
    ok(r.allowed && r.limit === 120, 'a key with no explicit rateLimit gets the default (120/min)');
    console.log('✓ ratelimit: the default limit applies without an explicit per-key value');
  }

  // ── Memory bound: the tracked-key map never exceeds MAX_KEYS, even keyed by many distinct ids ──
  // Today the only caller keys by the small set of configured API keys, but the map must stay bounded as a
  // backstop (so it can't become an unbounded-memory DoS if the key source ever changes). Insert well past
  // the cap with unique ids and assert the map size holds at the cap.
  {
    const cap = __test.MAX_KEYS;
    for (let i = 0; i < cap + 500; i++) check({ id: `bulk_${i}`, rateLimit: 5 });
    ok(__test.size() <= cap, `the key map stays bounded at MAX_KEYS (${cap}); size is ${__test.size()}`);
    console.log('✓ ratelimit: the tracked-key map is bounded (no unbounded-memory growth)');
  }

  console.log(`\nALL RATELIMIT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RATELIMIT UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
