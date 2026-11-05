'use strict';
// Guards stall attribution: a turn that goes quiet is reported as the STAGE it is stuck in, once per silence
// stretch, without per-token timer churn. Uses an injected clock and timer, so it runs instantly. Also guards
// the server/client wiring and the stage names the user sees. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const { create, DEFAULT_THRESHOLD_MS } = require(path.join(PROJECT, 'lib', 'stallwatch'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// A deterministic timer: `advance` moves the clock and runs every timer that is due.
const fakeTime = () => {
  let now = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms, cancelled: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cancelled = true; };
  const runDue = () => {
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.cancelled = true;
      due.fn();
    }
  };
  return {
    now: () => now,
    setTimer, clearTimer,
    advance(ms) { now += ms; runDue(); },
    get pending() { return timers.filter((t) => !t.cancelled).length; },
  };
};

try {
  // ── A silence in one stage is attributed once ──
  const clock = fakeTime();
  const stalls = [];
  const w = create({ onStall: (s) => stalls.push(s), thresholdMs: 1000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  w.start('Searching your documents…');
  clock.advance(500);
  w.note();                       // a token keeps the turn alive
  clock.advance(600);             // 600ms since the signal — not a stall yet
  eq(stalls.length, 0, 'activity below the threshold reports nothing');
  clock.advance(500);             // now 1100ms silent
  eq(stalls.length, 1, 'a silence past the threshold reports one stall');
  eq(stalls[0].stage, 'Searching your documents…', 'the stall names the stage');
  ok(stalls[0].elapsedMs >= 1000, 'the report includes how long the stage was silent');
  clock.advance(5000);
  eq(stalls.length, 1, 'the same silence is never re-reported');

  // ── A new stage starts a new silence stretch ──
  w.note('Writing the answer…');
  clock.advance(1100);
  eq(stalls.length, 2, 'a later silence in a new stage is reported');
  eq(stalls[1].stage, 'Writing the answer…', 'the newest stage is named');

  // ── A token resets the stretch even within the same stage ──
  w.note();
  clock.advance(700);
  w.note();
  clock.advance(400);
  eq(stalls.length, 2, 'a signal inside the window prevents a false stall');
  clock.advance(700);
  eq(stalls.length, 3, 'silence after the last token is still reported');

  // ── stop() ends attribution (turn finished) ──
  w.stop();
  clock.advance(10000);
  eq(stalls.length, 3, 'a stopped tracker never fires');

  // ── A throwing callback never breaks the turn ──
  const clock2 = fakeTime();
  const w2 = create({ onStall: () => { throw new Error('boom'); }, thresholdMs: 100, now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer });
  w2.start('x');
  let threw = false;
  try { clock2.advance(200); } catch { threw = true; }
  ok(!threw, 'a failing attribution callback is contained');
  ok(DEFAULT_THRESHOLD_MS >= 30000, 'the default threshold leaves room for a normal first token');

  // ── Wiring: the server announces stages and the client shows them ──
  const socket = read('lib/socket.js');
  ok(/const newTurnStall = \(\) => require\('\.\/stallwatch'\)\.create\(\{/.test(socket), 'the server builds the tracker from the shared module');
  ok(/turnStallHolder\.current\.start\('your documents'\)/.test(socket), 'each message turn starts a stall tracker');
  ok(/onStage: \(text\) => \{ if \(!abort\.signal\.aborted\) \{ stallThisTurn\.note\(text\)/.test(socket),
    'retrieval stage announcements feed the tracker');
  ok(/stallThisTurn\.note\('Searching your documents…'\)/.test(socket), 'the document search is its own attributed stage');
  ok(/stall\.note\('Searching the web…'\)/.test(socket) && /stall\.note\('Researching your documents…'\)/.test(socket),
    'the web and research paths announce their stage');
  ok(/summaryStall\.start\(`summarizing \$\{name\}`\)/.test(socket), 'a document summary is attributed to its model pass');
  ok(/client\.emit\('turn_stall', \{ stage, elapsedMs \}\)/.test(socket), 'the server emits the attributed stall');
  ok(/turnStallHolder\.current\.stop\(\)/.test(socket), 'the tracker is stopped when the turn ends');

  const chat = read('lib/public/js/chat.js');
  ok(/socket\.on\('turn_stall'/.test(chat), 'the client listens for the attributed stall');
  ok(/_turnStage = String\(data\.text\)/.test(chat), 'the client remembers the last announced stage');
  ok(/Still working — \$\{String\(_turnStage\)\.replace/.test(chat), 'the local slow-turn notice names the stage too');
  ok(/if \(_turnStallNoticed === label\) return;/.test(chat), 'the stall notice is not re-announced for the same stage');
  ok(/turnActive/.test(chat.slice(chat.indexOf("socket.on('turn_stall'"), chat.indexOf("socket.on('turn_stall'") + 600)),
    'a stall from a finished turn is ignored');

  const docs = read('docs/README.md');
  ok(/names the stage it is waiting on/.test(docs) && /searching your documents/.test(docs),
    'the guide explains stall attribution');

  console.log(`\nALL STALL-ATTRIBUTION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ STALL-ATTRIBUTION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
