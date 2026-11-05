'use strict';
// Unit test for the shared concurrency gate (lib/semaphore.js). It caps how many holders run at
// once, bounds the wait queue so a burst fails fast with backpressure instead of piling up, hands a
// freed slot straight to the next waiter (FIFO), and never leaks a slot even when the wrapped work
// throws. These are the guarantees the URL-ingestion browser gate and the API generation gate rely
// on to stay OOM-proof and non-blocking. No model, no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { createSemaphore } = require(path.join(PROJECT, 'lib', 'semaphore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── Cap: at most `max` holders at once ──
    {
      const gate = createSemaphore({ max: 2 });
      await gate.acquire();
      await gate.acquire();
      eq(gate.stats().available, 0, 'both slots are taken');
      let third = 'pending';
      gate.acquire().then(() => { third = 'acquired'; });
      await new Promise(r => setImmediate(r));
      eq(third, 'pending', 'a third caller waits while the cap is reached');
      gate.release();                         // free one → the waiter gets it
      await new Promise(r => setImmediate(r));
      eq(third, 'acquired', 'a freed slot is handed to the waiting caller');
      console.log('✓ semaphore: caps concurrent holders and wakes a waiter on release');
    }

    // ── Bounded queue: beyond queueMax, acquire rejects immediately (backpressure) ──
    {
      const gate = createSemaphore({ max: 1, queueMax: 2, message: 'saturated' });
      await gate.acquire();                    // holder
      const w1 = gate.acquire();               // queued (1/2)
      const w2 = gate.acquire();               // queued (2/2)
      let rejected = null;
      await gate.acquire().catch(e => { rejected = e; });   // queue full → reject
      ok(rejected && /saturated/.test(rejected.message), 'a saturated queue rejects with the configured message');
      ok(rejected && rejected.backpressure === true, 'the rejection is tagged as backpressure so callers can tell it from a real error');
      eq(gate.stats().waiting, 2, 'the queue never grows past its bound');
      // Drain so the queued waiters settle (no unhandled rejections/leaks).
      gate.release(); gate.release(); gate.release();
      await Promise.all([w1, w2]);
      console.log('✓ semaphore: a full wait queue fails fast instead of growing unbounded');
    }

    // ── run(): releases on success AND on throw (no leaked slot) ──
    {
      const gate = createSemaphore({ max: 1 });
      const val = await gate.run(async () => 42);
      eq(val, 42, 'run() returns the wrapped result');
      eq(gate.stats().available, 1, 'run() releases the slot after success');
      let threw = false;
      try { await gate.run(async () => { throw new Error('boom'); }); }
      catch (e) { threw = /boom/.test(e.message); }
      ok(threw, 'run() propagates the wrapped error');
      eq(gate.stats().available, 1, 'run() releases the slot even when the work throws');
      console.log('✓ semaphore: run() always releases, on success and on throw');
    }

    // ── Unbounded queue (queueMax=0): every caller waits, none is rejected ──
    {
      const gate = createSemaphore({ max: 1, queueMax: 0 });
      await gate.acquire();
      let got = 0;
      const waiters = [gate.acquire().then(() => got++), gate.acquire().then(() => got++)];
      await new Promise(r => setImmediate(r));
      eq(got, 0, 'with no queue bound, extra callers all wait');
      gate.release(); gate.release(); gate.release();
      await Promise.all(waiters);
      eq(got, 2, 'every waiter is eventually served');
      console.log('✓ semaphore: an unbounded queue serves every waiter in turn');
    }

    // ── Over-release cannot push the live count above the limit ──
    {
      const gate = createSemaphore({ max: 2 });
      gate.release(); gate.release(); gate.release();   // more releases than acquires
      eq(gate.stats().available, 2, 'a double/over-release never lets available exceed the limit');
      console.log('✓ semaphore: over-release is clamped to the configured limit');
    }

    console.log(`\nALL SEMAPHORE UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ SEMAPHORE UNIT TEST FAILED:', e && e.message, e && e.stack);
    process.exit(1);
  }
})();
