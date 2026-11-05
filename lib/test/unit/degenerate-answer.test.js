'use strict';
// Guards the degenerate-answer heuristic in lib/socket.js (_isDegenerate). A degenerate reply (a bare 1-2
// char Latin fragment like "It" / "Th", or a lone hedging opener) means the grounding rules were likely
// truncated out of the context window, so the turn is retried. The trap this guards: a LEGITIMATELY short
// answer must never be flagged and retried. In particular a spaceless-script (CJK) answer packs a COMPLETE
// word into one or two characters ("北京" = Beijing, "鉄" = iron), so it must be treated as a real answer, not
// a truncated fragment — keeping the heuristic language-agnostic rather than Latin-only. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const { _isDegenerate } = require(path.resolve(__dirname, '..', '..', 'socket'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── genuinely degenerate (should retry) ──
  ok(_isDegenerate('It') === true, 'a bare 2-char Latin fragment is degenerate');
  ok(_isDegenerate('Th') === true, 'a truncated Latin word is degenerate');
  ok(_isDegenerate('Unfortunately,') === true, 'a lone hedging opener is degenerate');
  ok(_isDegenerate('') === true || _isDegenerate('') === false, 'empty input never throws');

  // ── legitimately short, must NOT be flagged ──
  ok(_isDegenerate('Rome') === false, 'a short proper noun is a real answer');
  ok(_isDegenerate('yes') === false && _isDegenerate('No') === false, 'plain yes/no is a real answer');
  ok(_isDegenerate('12') === false && _isDegenerate('$5') === false, 'a numeric / currency answer is real');

  // ── language-agnostic: short CJK answers are complete words, not fragments ──
  ok(_isDegenerate('北京') === false, 'a 2-char CJK answer (a complete word) is NOT degenerate');
  ok(_isDegenerate('鉄') === false, 'a 1-char CJK answer (a complete word) is NOT degenerate');
  ok(_isDegenerate('赤') === false, 'a single Han character answer is NOT degenerate');
  ok(_isDegenerate('はい') === false, 'a 2-char Hiragana answer is NOT degenerate');
  ok(_isDegenerate('네') === false, 'a single Hangul-syllable answer is NOT degenerate');

  console.log(`\nALL DEGENERATE-ANSWER TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DEGENERATE-ANSWER TEST FAILED:', e && e.message);
  process.exit(1);
}
