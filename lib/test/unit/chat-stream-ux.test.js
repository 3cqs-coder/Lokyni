'use strict';
// Guards two chat client-JS behaviors (lib/public/js/chat.js):
//   UI-1: streamed renders must only auto-scroll when the user is already near the bottom, so a user
//         who scrolls up to re-read history mid-answer is not yanked back down on every frame.
//   UI-3: retained message rows must be capped, so a marathon conversation can't grow the DOM without
//         bound (progressively janky scrolling/rendering, worst on phones).
// Source inspection — this is browser code with no DOM test harness here. No model or network.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const chatJs = fs.readFileSync(path.join(ROOT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── UI-1: conditional auto-follow during streaming ──
  ok(/function isNearBottom\(/.test(chatJs), 'an isNearBottom() helper exists');
  ok(/scrollHeight - chatBox\.scrollTop - chatBox\.clientHeight/.test(chatJs), 'near-bottom is measured from the live scroll geometry');
  // The streamed render must gate its scroll on isNearBottom, not scroll unconditionally.
  const rafIdx = chatJs.indexOf('_streamRenderQueued = false;', chatJs.indexOf('function scheduleStreamRender'));
  ok(rafIdx !== -1, 'the streaming render callback is present');
  const rafBlock = chatJs.slice(rafIdx, rafIdx + 700);
  ok(/const stick = isNearBottom\(\)/.test(rafBlock), 'the streamed render captures near-bottom state before updating the DOM');
  ok(/if \(stick\) scrollToBottom\(\)/.test(rafBlock), 'the streamed render only auto-scrolls when the user was at the bottom');

  // ── UI-3: bounded retained rows ──
  ok(/MAX_MSG_ROWS/.test(chatJs), 'a retained-row cap constant exists');
  ok(/function capChatDom\(/.test(chatJs), 'a capChatDom() trimmer exists');
  ok(/capChatDom\(\);/.test(chatJs.slice(chatJs.indexOf('function appendUserMessage'))), 'a new user turn trims the oldest rows first');
  // capChatDom must trim whole turns (message rows AND their sibling source/answer-meta/similar
  // strips), not only .msg-row, or the cap is defeated and orphan strips pile up at the top.
  {
    const capBody = chatJs.slice(chatJs.indexOf('function capChatDom'), chatJs.indexOf('function appendUserMessage'));
    ok(/cutoff/.test(capBody) && /nextSibling/.test(capBody), 'capChatDom removes every child before the cutoff row, not just message rows');
    ok(/empty-state/.test(capBody), 'capChatDom preserves the empty-state placeholder while trimming');
  }

  // ── The status heartbeat never re-enables the composer mid-turn ──
  // The 2s indexing_status heartbeat re-enables input once the index is ready, to recover after a workspace
  // switch. Without a turn guard it also re-enabled it WHILE an answer was thinking/streaming (every answer that
  // takes >2s), letting a second message be submitted over the in-flight turn. A turnActive flag — set when a
  // turn starts (showThinking), cleared when it ends (chat_end / resetStreaming for error/disconnect/reset) —
  // gates the heartbeat so it only releases the composer between turns.
  ok(/let turnActive\s*=\s*false;/.test(chatJs), 'a turnActive flag tracks whether a turn is in flight');
  ok(/if \(ready && !indexing && !turnActive\) setInputState\(false\);/.test(chatJs),
    'the status heartbeat re-enables the composer only when no turn is active');
  ok(/function showThinking\(\) \{\s*turnActive = true;/.test(chatJs), 'a turn start (showThinking) marks the turn active');
  ok(/isStreaming = false; turnActive = false;/.test(chatJs), 'resetStreaming clears turnActive (error / disconnect / reset end the turn)');
  ok(/socket\.on\(TURN_PROTOCOL\.end, \(payload\) => \{[\s\S]{0,500}?finalizeTurn\(\{ stopped: false \}\)/.test(chatJs),
    'the shared turn protocol binds chat_end to the finalizer');
  ok(/function finalizeTurn\(\{[\s\S]{0,600}?turnActive = false;/.test(chatJs),
    'the finalizer clears turnActive (normal completion and Stop)');
  console.log('✓ chat-stream-ux: the status heartbeat re-enables the composer only between turns, never mid-turn');

  // ── chat_end re-enables the composer even if the final render / meta-attach throws ──
  // marked.parse and applyPendingMeta run in chat_end before the input is re-enabled. If either threw, the
  // composer stayed disabled (only the 2s heartbeat recovered it, without refocus). The handler now wraps its
  // body so setInputState runs in a finally — the same fault-isolated contract appendSources already has.
  {
    const ceIdx = chatJs.indexOf('function finalizeTurn(');
    const ceBody = chatJs.slice(ceIdx, chatJs.indexOf("socket.on(TURN_PROTOCOL.end"));
    ok(/\btry\s*\{/.test(ceBody) && /\}\s*finally\s*\{/.test(ceBody), 'the finalizer wraps its body in try/finally');
    const finallyAt = ceBody.indexOf('finally');
    ok(finallyAt !== -1 && ceBody.indexOf('setInputState(false, true)', finallyAt) !== -1,
      'the finalizer re-enables the composer in the finally (a render/meta throw cannot leave it stuck)');
  }
  console.log('✓ chat-stream-ux: chat_end always re-enables the composer, even if finalize throws');

  console.log('✓ chat-stream-ux: streamed renders auto-follow only near the bottom; retained rows are capped');
  console.log(`\nALL CHAT-STREAM-UX UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CHAT-STREAM-UX UNIT TEST FAILED:', e.message);
  process.exit(1);
}
