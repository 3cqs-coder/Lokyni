'use strict';
// Guards the concurrency-limited async queue (lib/queue.js), which serializes connector syncs (concurrency 1)
// so several syncs can't spawn several MCP servers at once and hammer the machine. It had no test, yet its
// invariants are easy to break: at most `concurrency` tasks run at once; a REJECTED task must still drain the
// queue (a regression wedges every later sync after one failure); and cancel() must remove only a WAITING task.
// These are verified with deterministic deferred promises (no timers, no real work). Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const { create } = require(path.resolve(__dirname, '..', '..', 'queue'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
// Flush the microtask queue so the queue's Promise.resolve().then(fn) chains advance deterministically.
const tick = () => new Promise(r => setImmediate(r));
const defer = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

(async () => {
  try {
    // ── concurrency cap: at most `concurrency` tasks run at once; the rest wait ──
    {
      const q = create({ concurrency: 2 });
      const gates = [defer(), defer(), defer(), defer(), defer()];
      let started = 0;
      const results = gates.map((g, i) => q.enqueue(() => { started++; return g.promise; }));
      await tick();
      eq(started, 2, 'only `concurrency` (2) tasks start; the rest wait');
      eq(q.running(), 2, 'running() reports the active count');
      eq(q.queued(), 3, 'queued() reports the waiting count');
      eq(q.pending(), 5, 'pending() is running + waiting');

      gates[0].resolve('a');           // free one slot
      await results[0];
      await tick();
      eq(started, 3, 'finishing one task starts exactly one waiting task (cap held)');
      eq(q.running(), 2, 'still at the concurrency cap after the hand-off');

      // Drain the rest so the queue empties cleanly.
      for (let i = 1; i < gates.length; i++) gates[i].resolve(String(i));
      await Promise.all(results);
      eq(q.pending(), 0, 'the queue fully drains once every task settles');
      console.log('✓ queue: never exceeds the concurrency cap; a finished task starts exactly one waiting task');
    }

    // ── a rejected task still drains the queue (finally → next), and its own promise rejects ──
    {
      const q = create({ concurrency: 1 });
      const boom = new Error('task blew up');
      let secondRan = false;
      const p1 = q.enqueue(() => Promise.reject(boom));
      const p2 = q.enqueue(() => { secondRan = true; return 'ok'; });
      await assert.rejects(() => p1, (e) => e === boom, 'a failing task rejects its own promise with the real error');
      eq(await p2, 'ok', 'the next task still runs after a rejection (the queue is not wedged)');
      ok(secondRan, 'a rejected task does not block the queue from draining');
      console.log('✓ queue: a rejected task rejects its caller yet the queue keeps draining');
    }

    // ── cancel() removes only a WAITING task, rejects it as canceled, and no-ops otherwise ──
    {
      const q = create({ concurrency: 1 });
      const running = defer();
      let waitingRan = false;
      const pRunning = q.enqueue(() => running.promise, 'running-key');   // occupies the single slot
      const pWaiting = q.enqueue(() => { waitingRan = true; return 'nope'; }, 'waiting-key');
      await tick();
      eq(q.running(), 1, 'the first task is running');
      eq(q.queued(), 1, 'the second task is waiting');

      eq(q.cancel('missing-key'), false, 'cancel() returns false for an unknown key');
      eq(q.cancel(null), false, 'cancel(null) is a safe no-op');
      eq(q.cancel('running-key'), false, 'cancel() cannot pull a task that already started');

      const ret = q.cancel('waiting-key');
      eq(ret, true, 'cancel() returns true when it removes a waiting task');
      await assert.rejects(() => pWaiting, (e) => e && e.canceled === true, 'a canceled waiting task rejects with err.canceled = true');
      eq(q.queued(), 0, 'the canceled task is removed from the waiting list');

      running.resolve('done');
      eq(await pRunning, 'done', 'the still-running task is untouched by the cancel and completes normally');
      ok(!waitingRan, 'the canceled task never ran');
      console.log('✓ queue: cancel removes only a waiting task (canceled flag), never a running one, and no-ops on unknown/null');
    }

    // ── concurrency is clamped to at least 1 so a bad config can't deadlock the queue ──
    {
      const q = create({ concurrency: 0 });
      eq(await q.enqueue(() => 'ran'), 'ran', 'concurrency 0 is clamped to 1, so tasks still run (no deadlock)');
      const qd = create();   // default options
      eq(await qd.enqueue(() => 'default'), 'default', 'the default options construct a working queue');
      console.log('✓ queue: concurrency is clamped to >= 1 (a 0/omitted config never deadlocks)');
    }

    console.log(`\nALL QUEUE UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ QUEUE UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
