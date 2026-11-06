'use strict';
// Guards the one place that turns raw @huggingface/transformers download events into the { pct, bytes, totalBytes }
// snapshot every optional local model (voice synthesis, voice input, the rerankers) surfaces while it downloads on
// first use. The aggregation must: sum bytes across the several files a model fetches, only ever climb, clamp to
// 0..100, report a stall via idleMs(), survive malformed events without throwing, and reset cleanly for a re-warm.
// If this drifts, the UI's "downloading… 42%" misleads and the stall watchdog mis-fires. Pure and deterministic —
// no model, no network, no timers. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { createDownloadTracker, toMB } = require(path.join(PROJECT, 'lib', 'modelprogress'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const MB = 1024 * 1024;

try {
  // ── nothing downloaded yet → no snapshot, idle is zero ──
  {
    const t = createDownloadTracker();
    ok(t.snapshot() === null, 'no events → null snapshot (UI shows "downloads on first use", not a false 0%)');
    ok(t.idleMs() === 0, 'no events → idleMs 0 (the stall watchdog stays disarmed before the first byte)');
  }

  // ── bytes sum ACROSS files; percent is the byte-weighted whole, clamped and floored ──
  {
    const t = createDownloadTracker();
    t.note({ status: 'progress', file: 'config.json', loaded: 1 * MB, total: 1 * MB });   // small file done
    t.note({ status: 'progress', file: 'model.onnx',  loaded: 20 * MB, total: 80 * MB });  // big file partway
    const s = t.snapshot();
    ok(s && s.bytes === 21 * MB && s.totalBytes === 81 * MB, 'bytes/totals sum across every file seen');
    ok(s.pct === Math.floor((21 / 81) * 100), 'pct is the byte-weighted whole across files, floored');
    ok(s.pct >= 0 && s.pct <= 100, 'pct is clamped to 0..100');
  }

  // ── a later file announcing its full size can only lower the percent once, then it climbs — never exceeds 100 ──
  {
    const t = createDownloadTracker();
    t.note({ status: 'progress', file: 'a', loaded: 5 * MB, total: 5 * MB });
    const high = t.snapshot().pct;                 // 100% of the only known file
    t.note({ status: 'progress', file: 'b', loaded: 0, total: 95 * MB });   // the big file appears
    ok(t.snapshot().pct < high, 'a newly-announced large file corrects an over-optimistic early percent');
    t.note({ status: 'progress', file: 'b', loaded: 95 * MB, total: 95 * MB });
    ok(t.snapshot().pct === 100, 'with every byte in, pct reaches exactly 100 (never over)');
  }

  // ── a 'done' event with no byte counts still completes that file (transformers sometimes omits them) ──
  {
    const t = createDownloadTracker();
    t.note({ status: 'progress', file: 'm', loaded: 40 * MB, total: 100 * MB });
    t.note({ status: 'done', file: 'm' });
    ok(t.snapshot().pct === 100, "'done' completes the file even when the event carries no loaded/total");
  }

  // ── idleMs tracks the last advance; reset() clears everything for a fresh re-warm ──
  {
    const t = createDownloadTracker();
    t.note({ status: 'progress', file: 'm', loaded: 10 * MB, total: 100 * MB });
    ok(t.idleMs() >= 0 && t.idleMs() < 1000, 'idleMs is near zero right after an advance (download is live)');
    t.reset();
    ok(t.snapshot() === null && t.idleMs() === 0, 'reset() clears the snapshot and idle clock for the next download');
  }

  // ── malformed / irrelevant events are ignored and never throw (this sits on a hot worker-message path) ──
  {
    const t = createDownloadTracker();
    for (const bad of [null, undefined, {}, { status: 'progress' }, { status: 'initiate', file: 'x' },
                       { status: 'progress', file: 'x', loaded: 5, total: 0 }, { status: 'progress', file: 'x', total: -3 }]) {
      t.note(bad);
    }
    ok(t.snapshot() === null, 'events with no usable byte totals contribute nothing (no divide-by-zero, no NaN)');
  }

  // ── milestone logging fires once per 25% crossing, in order, and only when a logger is supplied ──
  {
    const lines = [];
    const t = createDownloadTracker({ label: 'the voice model', log: (l) => lines.push(l) });
    for (let mb = 10; mb <= 100; mb += 10) t.note({ status: 'progress', file: 'm', loaded: mb * MB, total: 100 * MB });
    ok(lines.length === 4, 'exactly four milestone lines (one per 25% crossing), never one per chunk');
    ok(lines.every((l) => l.includes('the voice model')), 'each milestone names the model from the label');
    const pcts = lines.map((l) => parseInt((l.match(/(\d+)%/) || [])[1], 10));   // the ACTUAL percent at each crossing
    ok(pcts.every((p, i) => i === 0 || p > pcts[i - 1]), 'milestone percents are strictly ascending');
    ok(pcts[pcts.length - 1] === 100, 'the final milestone is logged at 100%');
  }

  // ── toMB is whole-MB, base-1024, floored and never negative (locale-agnostic: a number, caller adds the unit) ──
  ok(toMB(90 * MB) === 90 && toMB(0) === 0 && toMB(-5) === 0 && toMB(1.9 * MB) === 1, 'toMB floors to whole base-1024 MB, clamped at 0');

  console.log('✓ modelprogress: byte-weighted percent across files, stall clock, reset, crash-safety, milestone logs');
  console.log(`\nALL MODELPROGRESS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MODELPROGRESS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
