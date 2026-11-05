'use strict';
// Offline regression check for Lokyni's deterministic query-routing heuristics — the
// pure, no-model signals that decide whether a query looks web-answerable, is a live
// "current info" question, or is a vague continuation. These gate the web-search offer
// and the follow-up path, so a wording/regex change that breaks routing is caught here in
// milliseconds without touching the LLM. (The model-driven intent classifier is exercised
// by the retrieval eval, not here.) Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { looksWebAnswerable, looksCurrentInfo } = require(path.join(PROJECT, 'lib', 'websearch'));
const { VAGUE_CONTINUATION_RE } = require(path.join(PROJECT, 'lib', 'retrieval', 'expand'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // ── looksWebAnswerable: current-info cues, or a question-word question (>=3 words).
  // It's a permissive first gate (the reranker-score check decides whether to actually
  // offer web), so the contract is: real questions qualify; short/imperative asks don't.
  for (const q of ['who won the 2022 world cup', 'what is the current price of bitcoin',
                   'what is the weather in Paris today', 'when is the next full moon']) {
    ok(looksWebAnswerable(q), `should be web-answerable: "${q}"`);
  }
  // Imperatives / statements (no question word, no cue, no '?') and too-short asks don't.
  for (const q of ['summarize the attached contract', 'explain section 3 of the document',
                   'list the action items', 'wifi']) {
    ok(!looksWebAnswerable(q), `should NOT be web-answerable: "${q}"`);
  }
  // Language-agnostic: a non-English out-of-corpus question (which the English cue/question-word rules
  // can't match) is still a reasonable web candidate, via the non-Latin-script signal and the full-width
  // question mark. Synthetic placeholder topics; content spans scripts per the multilingual bar.
  for (const q of ['东京今天的天气怎么样', '현재 비트코인 가격은 얼마인가요', 'какая сейчас погода в Париже',
                   'ما هي أحدث الأخبار', '最新のニュースは何ですか？']) {
    ok(looksWebAnswerable(q), `a non-English question should be web-answerable: "${q}"`);
  }
  console.log('✓ routing: looksWebAnswerable qualifies real questions (English and non-English), not imperatives/short asks');

  // ── looksCurrentInfo: genuinely live questions (no static doc can answer) ──
  for (const q of ['what is the weather today', "today's stock price for AAPL",
                   'latest news on the election', 'what time is it right now']) {
    ok(looksCurrentInfo(q), `should be current-info: "${q}"`);
  }
  for (const q of ['what is a safety order', 'who wrote Moby Dick']) {
    ok(!looksCurrentInfo(q), `should NOT be current-info: "${q}"`);
  }
  console.log('✓ routing: looksCurrentInfo flags live questions, not evergreen ones');

  // ── VAGUE_CONTINUATION_RE: follow-ups that carry no new subject ──
  for (const q of ['tell me more', 'go on', 'continue', 'more', 'elaborate', 'go deeper']) {
    ok(VAGUE_CONTINUATION_RE.test(q), `should be a vague continuation: "${q}"`);
  }
  for (const q of ['tell me about the wifi password', 'what is the refund policy',
                   'who is Captain Ahab']) {
    ok(!VAGUE_CONTINUATION_RE.test(q), `should NOT be a vague continuation: "${q}"`);
  }
  console.log('✓ routing: VAGUE_CONTINUATION_RE matches continuations, not new-subject queries');

  console.log(`\nALL ROUTING UNIT TESTS PASSED (${checks} checks across 3 heuristics)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ROUTING UNIT TEST FAILED:', e.message);
  process.exit(1);
}
