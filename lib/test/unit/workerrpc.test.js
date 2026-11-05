'use strict';
// Unit tests for the persistent-worker supervisor (lib/workerrpc.js): request/reply
// correlation, crash detection + automatic respawn on the next call, the availability
// gate, and shutdown rejecting in-flight calls. Uses tiny inline eval workers so there
// is no model or native dependency. The supervisor unref()s its worker and timers (so a
// worker never holds the server open), which means a standalone script must keep the
// event loop alive itself — hence the keep-alive interval below.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { WorkerRpc } = require(path.join(PROJECT, 'lib', 'workerrpc'));

const keepAlive = setInterval(() => {}, 1000);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

(async () => {
  // ── request/reply correlation ──
  const adder = new WorkerRpc({
    name: 'adder',
    code: `const {parentPort}=require('worker_threads');
           parentPort.on('message',(m)=>{ if(m.op==='add') parentPort.postMessage({id:m.id,sum:m.a+m.b}); });`,
    timeoutMs: 2000,
  });
  const r1 = await adder.request({ op: 'add', a: 2, b: 3 });
  ok(r1.sum === 5, 'request resolves with the correlated reply');
  // Interleaved concurrent requests resolve to their own replies (id correlation).
  const [x, y] = await Promise.all([
    adder.request({ op: 'add', a: 10, b: 1 }),
    adder.request({ op: 'add', a: 100, b: 1 }),
  ]);
  ok(x.sum === 11 && y.sum === 101, 'concurrent requests each get their own reply');
  console.log('✓ workerrpc: request/reply correlation');

  // ── crash detection + automatic respawn ──
  const crasher = new WorkerRpc({
    name: 'crasher',
    code: `const {parentPort}=require('worker_threads');
           parentPort.on('message',(m)=>{ if(m.op==='boom') process.exit(3); else parentPort.postMessage({id:m.id,ok:true}); });`,
    timeoutMs: 2000, maxFails: 3,
  });
  ok((await crasher.request({ op: 'ping' })).ok === true, 'worker answers before the crash');
  let rejected = false;
  try { await crasher.request({ op: 'boom' }); } catch (_) { rejected = true; }
  ok(rejected, 'an in-flight call is rejected when the worker dies');
  ok((await crasher.request({ op: 'ping' })).ok === true, 'the next call transparently respawns the worker');
  console.log('✓ workerrpc: crash rejection + automatic respawn');

  // ── cooldown after repeated crashes gates spawning ──
  // Use an UNCAUGHT throw (emits 'error' then 'exit'), the path a naive identity guard
  // fails to count — so this also guards against that regression.
  const flaky = new WorkerRpc({
    name: 'flaky',
    code: `require('worker_threads'); setTimeout(() => { throw new Error('boom'); }, 10);`,
    timeoutMs: 1000, maxFails: 2, cooldownMs: 10000,
  });
  for (let i = 0; i < 2; i++) { try { await flaky.request({ op: 'x' }); } catch (_) {} }
  let gated = false;
  try { await flaky.request({ op: 'x' }); } catch (e) { gated = /unavailable/.test(e.message); }
  ok(gated, 'after maxFails deaths (via error→exit) the cooldown makes ensure() yield null');
  flaky.shutdown();
  console.log('✓ workerrpc: crash cap counts the error→exit path and triggers a cooldown');

  // ── availability gate ──
  let allow = false;
  const gatedRpc = new WorkerRpc({
    name: 'gated',
    code: `const {parentPort}=require('worker_threads'); parentPort.on('message',(m)=>parentPort.postMessage({id:m.id,ok:true}));`,
    available: () => allow, timeoutMs: 2000,
  });
  let blocked = false;
  try { await gatedRpc.request({ op: 'x' }); } catch (e) { blocked = /unavailable/.test(e.message); }
  ok(blocked, 'request rejects while the availability gate is closed');
  allow = true;
  ok((await gatedRpc.request({ op: 'x' })).ok === true, 'request works once the gate opens');
  gatedRpc.shutdown();
  console.log('✓ workerrpc: availability gate');

  // ── shutdown rejects in-flight calls ──
  const slow = new WorkerRpc({
    name: 'slow',
    code: `const {parentPort}=require('worker_threads'); parentPort.on('message',()=>{ /* never replies */ });`,
    timeoutMs: 30000,
  });
  const pending = slow.request({ op: 'x' });
  let shutRejected = false;
  const guard = pending.catch(() => { shutRejected = true; });
  slow.shutdown('bye');
  await guard;
  ok(shutRejected, 'shutdown() rejects any in-flight request');
  ok(slow.alive() === false, 'shutdown() drops the worker');

  adder.shutdown(); crasher.shutdown();
  console.log('✓ workerrpc: shutdown rejects in-flight calls');

  // ── hasPending reflects in-flight work (voice idle-release defers teardown on it, never cancelling a request) ──
  const pend = new WorkerRpc({
    name: 'pend',
    code: `const {parentPort}=require('worker_threads'); parentPort.on('message',(m)=>setTimeout(()=>parentPort.postMessage({id:m.id,ok:true}),60));`,
    timeoutMs: 30000,
  });
  ok(pend.hasPending() === false, 'hasPending is false when idle');
  const inflight = pend.request({ op: 'x' });
  ok(pend.hasPending() === true, 'hasPending is true while a request is in flight');
  await inflight;
  ok(pend.hasPending() === false, 'hasPending is false again after the request settles');
  pend.shutdown();
  console.log('✓ workerrpc: hasPending tracks in-flight requests');

  clearInterval(keepAlive);
  console.log(`\nALL WORKERRPC UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
})().catch((e) => {
  clearInterval(keepAlive);
  console.error('✗ workerrpc test failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
