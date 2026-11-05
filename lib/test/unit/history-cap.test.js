'use strict';
// Guards the unconditional in-memory history cap (lib/history.capHistory). With the rolling summary off,
// nothing else trims the live history array, so a very long single conversation would grow it without
// bound; capHistory keeps the protected head plus the most recent turns regardless of the summary toggle.
// It must also be called on every turn (from updateConversationSummary, before its summary-off early return)
// and must not leave a stale summarizedUpTo pointing past the trimmed array. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { capHistory, MAX_LIVE_HISTORY, PROTECT_HEAD } = require(path.join(PROJECT, 'lib', 'history'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── under the cap: untouched ──
  const small = { history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })) };
  capHistory(small);
  ok(small.history.length === 10, 'a short history is left unchanged');

  // ── over the cap: trimmed to head + most recent, bounded ──
  const n = MAX_LIVE_HISTORY + 200;
  const big = { history: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })), summarizedUpTo: 0 };
  capHistory(big);
  ok(big.history.length === MAX_LIVE_HISTORY, `history is capped to MAX_LIVE_HISTORY (${MAX_LIVE_HISTORY}), got ${big.history.length}`);
  ok(big.history[0].content === 'm0' && big.history[1].content === `m1`, 'the protected head is preserved');
  ok(big.history[big.history.length - 1].content === `m${n - 1}`, 'the most recent turn is preserved');
  // The kept tail is the last (MAX_LIVE_HISTORY - PROTECT_HEAD) entries.
  ok(big.history[PROTECT_HEAD].content === `m${n - (MAX_LIVE_HISTORY - PROTECT_HEAD)}`, 'the middle is dropped, keeping head + recent tail');

  // ── a stale summarizedUpTo is clamped so it never points past the trimmed array ──
  const withPtr = { history: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })), summarizedUpTo: 300 };
  capHistory(withPtr);
  ok(withPtr.summarizedUpTo <= PROTECT_HEAD, 'summarizedUpTo is clamped to the head after a hard trim');
  console.log('✓ history-cap: capHistory bounds the live history, preserves head + recent, clamps the summary pointer');

  // ── capHistory runs on every turn, before the summary-off early return ──
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'history.js'), 'utf-8');
  ok(/capHistory\(ctx\);\s*\/\/[^\n]*\n\s*if \(!useConversationSummary\) return;/.test(src),
    'capHistory is called before the summary-off early return, so it bounds memory even when the summary is off');
  console.log('✓ history-cap: the cap is applied unconditionally, not only when the summary is on');

  // ── the socket paths that grow history WITHOUT updateConversationSummary still apply the cap ──
  // Most answer paths call updateConversationSummary (which caps), but the local-synthesis and cache-hit
  // paths push a turn and persist without it, so each must call capHistory directly or they'd grow unbounded.
  const sock = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
  ok(/const \{ updateConversationSummary, capHistory \} = require\('\.\/history'\)/.test(sock),
    'socket imports capHistory for the paths that bypass the summary');
  const capCalls = (sock.match(/capHistory\(conversationContext\)/g) || []).length;
  ok(capCalls >= 2, `every summary-bypassing history-growth path caps the live history (found ${capCalls} capHistory calls)`);
  console.log('✓ history-cap: the synthesis and cache-hit paths cap the live history too (no bypass)');

  // ── live history holds LEAN sources (bounded bytes, not just count) ──
  // capHistory bounds the entry COUNT; the per-turn sources must also be trimmed so an image/web-heavy session
  // (especially with the summary off) doesn't retain tens of MB of full source objects per connection.
  {
    const { leanSources } = require(path.join(PROJECT, 'lib', 'sessions'));
    const fat = [{
      id: 'd1', source: 'a.pdf', fileType: 'pdf', viewerLink: '/v', passageStart: 0, passageEnd: 10, docLength: 999,
      confidence: 0.9, rerankScore: 1.2, snippet: 'hello', content: 'X'.repeat(50000),   // fat field that must be dropped
      figures: [{ id: 'f1', page: 1, label: 'Fig', type: 'image', url: '/f', raw: 'Y'.repeat(50000) }],
      internalOffsets: [1, 2, 3],
    }];
    const lean = leanSources(fat);
    ok(lean.length === 1 && lean[0].content === undefined && lean[0].internalOffsets === undefined,
      'leanSources drops fat fields (full passage text, internal offsets)');
    ok(lean[0].figures[0].raw === undefined && lean[0].figures[0].id === 'f1',
      'figure objects are reduced to their lean shape (no embedded raw data)');
    ok(lean[0].id === 'd1' && lean[0].snippet === 'hello' && lean[0].confidence === 0.9,
      'the UI-rendered fields (id/snippet/confidence) are kept');
    ok(leanSources(null).length === 0 && leanSources([]).length === 0, 'leanSources handles empty/missing input');
    // The assistant-turn pushes in socket.js route their sources through leanSources (bounded live bytes).
    ok(/const \{ loadSession, saveSession, clearSession, isValidId, leanSources \} = require\('\.\/sessions'\)/.test(sock),
      'socket imports leanSources');
    const leanPushes = (sock.match(/sources: leanSources\(/g) || []).length;
    ok(leanPushes >= 4, `assistant-turn pushes trim their sources to the lean shape (found ${leanPushes})`);
    console.log('✓ history-cap: live-history sources are leaned on push (bytes bounded, not just entry count)');
  }

  console.log(`\nALL HISTORY-CAP UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ HISTORY-CAP UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
