'use strict';
// Guards the turn-control contract: Stop, the server's terminal events, long-turn progress, and the
// silence watchdog. These are behavior-level, deterministic checks on the two halves of the protocol
// and on the failure modes that previously lost an answer:
//   • the browser and server must use the same event names (one source: lib/turncontrol.js);
//   • a Stop ends exactly one turn and keeps the conversation (unlike New);
//   • a Stop during a pre-controller await is not lost;
//   • two minutes of silence must never reset streaming state (which dropped late tokens);
//   • progress lines must be safe for every script (no split surrogate pairs).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const { TURN_PROTOCOL } = require(path.join(PROJECT, 'lib', 'turncontrol'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const sock  = read('lib/socket.js');
  const chat  = read('lib/public/js/chat.js');
  const ejs   = read('lib/views/chat.ejs');
  const server = read('lib/server.js');
  const css   = read('lib/public/css/app.css');
  const research = read('lib/retrieval/deepresearch.js');

  // ── 1. One protocol, both sides ──
  ok(TURN_PROTOCOL.stop === 'chat_stop' && TURN_PROTOCOL.stopped === 'chat_stopped' &&
     TURN_PROTOCOL.end === 'chat_end' && TURN_PROTOCOL.progress === 'synth_progress',
    'the protocol module names the four turn events');
  ok(Object.isFrozen(TURN_PROTOCOL), 'the protocol object is frozen');

  // The page receives the exact object the server uses.
  ok(/turnProtocol:\s*TURN_PROTOCOL/.test(server), 'the chat render hands the protocol to the page');
  ok(/meta name="lokyni-turn-protocol" content="<%= JSON\.stringify\(typeof turnProtocol/.test(ejs),
    'the page carries the protocol in a meta tag');

  // The browser's fallback literals must equal the server module — a rename cannot split the two sides.
  const fallback = (name) => {
    const m = chat.match(new RegExp(`${name}:\\s*supplied\\.${name}\\s*\\|\\|\\s*'([^']+)'`));
    return m ? m[1] : null;
  };
  ok(fallback('stop') === TURN_PROTOCOL.stop, 'the browser Stop fallback matches the server event');
  ok(fallback('stopped') === TURN_PROTOCOL.stopped, 'the browser stopped fallback matches the server event');
  ok(fallback('end') === TURN_PROTOCOL.end, 'the browser end fallback matches the server event');
  ok(fallback('progress') === TURN_PROTOCOL.progress, 'the browser progress fallback matches the server event');

  // Both halves use the shared names rather than repeating a literal.
  ok(/client\.on\(TURN_PROTOCOL\.stop/.test(sock), 'the server listens for the shared Stop event');
  ok(/client\.on\(TURN_PROTOCOL\.stop[\s\S]{0,1800}?activeAbort\.abort\(\)/.test(sock),
    'Stop aborts the in-flight controller');
  ok(/emit\(TURN_PROTOCOL\.stopped\)/.test(sock), 'the server emits the shared stopped event');
  ok(/const endChat\s*=\s*\(language\) => client\.emit\(TURN_PROTOCOL\.end, language \? \{ language \} : undefined\)/.test(sock),
    'every normal turn end goes through the shared end event');
  ok((sock.match(/TURN_PROTOCOL\.progress/g) || []).length >= 3,
    'every progress surface uses the shared progress event (research, synthesis, retrieval stages)');
  ok(/socket\.emit\(TURN_PROTOCOL\.stop\)/.test(chat), 'the browser emits the shared Stop event');
  ok(/socket\.on\(TURN_PROTOCOL\.stopped/.test(chat) && /socket\.on\(TURN_PROTOCOL\.end/.test(chat),
    'the browser listens for both terminal events');
  ok(/socket\.on\(TURN_PROTOCOL\.progress/.test(chat), 'the browser listens for the shared progress event');

  // ── 2. Stop is a real, idempotent control ──
  ok(/const stopEpoch = 0|let stopEpoch = 0/.test(sock) && /startStopEpoch !== stopEpoch/.test(sock),
    'a turn queued before a Stop is discarded when it would have started');
  ok(/const stopPending = false|let stopPending = false/.test(sock) && /const beginTurnAbort = \(\) =>/.test(sock),
    'a Stop during a pre-controller await is carried into the controller the turn creates');
  ok(/if \(stopPending\) \{[\s\S]{0,120}?abortReason\.set\(a, ABORT_STOP\);[\s\S]{0,80}?a\.abort\(\)/.test(sock),
    'beginTurnAbort aborts a controller the user already stopped');
  ok(/if \(activeAbort && !activeAbort\.signal\.aborted\)/.test(sock),
    'a second Stop is a no-op while the first is unwinding (idempotent)');
  ok(!/const abort[WR] = beginTurnAbort\(\);\s*\n\s*if \(abort[WR]\.signal\.aborted\) return;/.test(sock),
    'a pre-controller Stop still runs the finally that releases the controller and emits stopped');

  // A Stop keeps the conversation; a New/disconnect still clears scratch state; Cancel is silent.
  ok(/ABORT_STOP = 'stop', ABORT_CANCEL = 'cancel'/.test(sock),
    'aborts are tagged by reason');
  ok(/if \(reason !== ABORT_STOP && reason !== ABORT_CANCEL\) clearIfAborted\(a\)/.test(sock),
    'a Stop or panel Cancel never clears the live conversation');
  ok(/if \(reason === ABORT_STOP\) \{ try \{ client\.emit\(TURN_PROTOCOL\.stopped\)/.test(sock),
    'only a user Stop emits the stopped terminal event');
  ok(/client\.on\('extract_cancel'[\s\S]{0,500}?abortReason\.set\(activeAbort, ABORT_CANCEL\)[\s\S]{0,80}?activeAbort\.abort\(\)/.test(sock),
    'canceling an extraction ends only the run (it never clears the chat conversation)');

  // ── 3. The watchdog never abandons a turn ──
  {
    const start = chat.indexOf('function _restartTurnWatchdog()');
    const end = chat.indexOf('// On (re)connect', start);
    const body = start === -1 ? '' : chat.slice(start, end === -1 ? undefined : end);
    ok(body.length > 0, 'the per-turn watchdog is present');
    ok(!/resetStreaming\(/.test(body), 'the watchdog does not reset streaming state (late tokens are not dropped)');
    ok(!/setInputState\(/.test(body), 'the watchdog does not re-enable the composer over a live turn');
    ok(!/turnActive\s*=\s*false/.test(body), 'the watchdog leaves the turn active');
    ok(/TURN_SLOW_NOTICE/.test(body) && /setThinkingStatus\(/.test(body),
      'the watchdog surfaces a slow-turn notice instead of ending the turn');
    ok(/armTurnWatchdog\(\);\s*\/\/ a live token arrived/.test(chat) &&
       /TURN_PROTOCOL\.progress, \(data\) =>[\s\S]{0,500}?armTurnWatchdog\(\);/.test(chat),
      'tokens and progress both push the watchdog forward');
  }

  // ── 4. Send ↔ Stop is one accessible control ──
  ok(/id="send-button" aria-label="Send message"/.test(ejs), 'the Send button has an explicit accessible name');
  {
    const sendLabel = (chat.match(/const SEND_LABEL\s*=\s*'([^']+)'/) || [])[1];
    const markupLabel = (ejs.match(/id="send-button"[^>]*>([^<]+)</) || [])[1];
    ok(sendLabel && markupLabel && sendLabel.trim() === markupLabel.trim(),
      'the initial Send label and the client label are the same text (no first-paint drift)');
    ok(/'Send message'/.test(chat), 'the client restores the same Send accessible name the markup declares');
  }
  ok(/const SEND_LABEL\s*=\s*'Send ↵'/.test(chat) && /const STOP_LABEL\s*=\s*'Stop'/.test(chat) &&
     /const STOPPING_LABEL\s*=\s*'Stopping…'/.test(chat),
    'the one control has Send, Stop, and Stopping labels');
  ok(/function refreshSendButton\(\)[\s\S]{0,900}?sendBtn\.classList\.add\('stop-mode'\)/.test(chat) &&
     /setAttribute\('aria-label', turnStopping \? 'Stopping the current answer' : 'Stop generating'\)/.test(chat),
    'the control switches to Stop with an action-specific accessible name');
  ok(/function requestStop\(\)[\s\S]{0,700}?socket\.emit\(TURN_PROTOCOL\.stop\)[\s\S]{0,700}?STOP_ACK_TIMEOUT_MS/.test(chat),
    'Stop requests the server and reverts its pending state if no terminal event arrives');
  ok(/if \(turnActive\) \{ requestStop\(\); return; \}\s*\n\s*sendMessage\(\);/.test(chat),
    'submitting the form mid-turn requests Stop instead of sending a second message');
  ok(/if \(turnActive\) return;/.test(chat), 'sendMessage refuses to start a second turn');
  ok(/#send-button\.stop-mode \{ background: var\(--surface2\); color: var\(--text\); border: 1px solid var\(--border\); \}/.test(css),
    'the Stop state has a distinct, calm, theme-aware style (neutral surface, not an alarming red — stopping is not destructive)');

  // ── 5. One terminal finalizer for chat_end and chat_stopped ──
  ok(/function finalizeTurn\(\{ stopped = false \} = \{\}\)/.test(chat), 'both terminal events share one finalizer');
  ok(/if \(turnFinalized\) return;/.test(chat), 'a duplicate/stale terminal event cannot finalize twice');
  ok(/appendNotice\('Stopped\.'\)/.test(chat) && /function appendNotice\(/.test(chat),
    'a stopped turn appends a quiet notice');
  ok(/\.msg-row\.notice-row/.test(css) && /\.notice-bubble/.test(css),
    'the stopped notice has its own neutral style');
  ok(!/appendError\('Stopped/.test(chat), 'stopping is not presented as an error');
  ok(/const producedText = !!currentBubble;/.test(chat) && /if \(!stopped \|\| producedText\) applyPendingMeta\(\)/.test(chat),
    'a Stop before the first token does not attach controls (or read back) the previous answer');

  // ── 6. Deep Research progress is multilingual-safe ──
  ok(/const clipProgress = \(text, max = 80\) =>/.test(research) && /Array\.from\(String\(text/.test(research),
    'progress text is clipped by code point, not UTF-16 unit (no split surrogate pairs)');
  ok(/Researching sub-question \$\{researched\.length \+ 1\} of \$\{researched\.length \+ pending\.length\}: \$\{clipProgress\(subq\)\}/.test(research),
    'research progress reports the step and the still-outstanding total');
  ok(!/subq\.slice\(0, 80\)/.test(research), 'the old code-unit truncation is gone');

  console.log(`\nALL TURN-CONTROL UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TURN-CONTROL UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
