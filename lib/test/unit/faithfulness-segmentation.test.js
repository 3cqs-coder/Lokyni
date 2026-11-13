'use strict';
// Guards how lib/faithfulness.js splits an answer into checkable claims (segmentClaims). Two invariants:
//   1. A conversational LEAD-IN — a fragment that ends with a dangling connector (an em/en dash or a colon,
//      straight or fullwidth) and asserts nothing on its own — must NOT become a claim. Fed to the fact-checker
//      it is always graded "unsupported" (the sources never state the assistant's own aside), which is the
//      spurious flag this guards against: an answer like "Switching over to the other file —\n\nAda Lovelace."
//      must check only the real sentence, never the transition.
//   2. The substance floor is per-SCRIPT, so no language is held to a Latin character count: a spaced script
//      needs a short clause's worth of characters, a dense CJK script needs far fewer to carry the same, and a
//      claim written wholly in a non-Latin script is still a claim (the old Latin-only letter test dropped it).
// Deterministic — no model call. Synthetic subjects only. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { _internal } = require(path.join(PROJECT, 'lib', 'trust', 'faithfulness'));
const { segmentClaims, LEAD_IN_TAIL } = _internal;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const claimsOf = (answer) => segmentClaims(answer);
const has = (answer, sub) => claimsOf(answer).some((c) => c.includes(sub));
const none = (answer, sub) => !claimsOf(answer).some((c) => c.includes(sub));

try {
  // ── 1. Lead-in fragments are skipped; the real sentence they introduce is kept ──
  // The exact failure shape reported from the UI: a document-switch narration flagged "unsupported".
  const switched = 'Switching over to the other file —\n\nAda Lovelace is named as the mathematician.';
  ok(none(switched, 'Switching over'), 'an em-dash lead-in ("… —") is not emitted as a claim');
  ok(has(switched, 'Ada Lovelace'), 'the real sentence after the lead-in is still checked');

  ok(none('The three causes were:\n\nDrought cut the harvest sharply that year.', 'three causes were'),
    'a colon lead-in ("…:") is not emitted as a claim');
  ok(none('结论如下：\n\n产量在当年大幅下降并影响了收入。', '结论如下'),
    'a fullwidth-colon (CJK) lead-in is not emitted as a claim');
  ok(none('Now the budget -\n\nThe branch spent the full allowance that quarter.', 'Now the budget'),
    'a trailing spaced-hyphen lead-in (" -") is not emitted as a claim');

  // A dash used INSIDE a sentence (an aside) is not a trailing lead-in — the whole sentence stays a claim.
  const aside = 'The treaty — signed in 1920 — ended the war between the two states.';
  ok(has(aside, 'treaty'), 'an internal em-dash aside does not drop the sentence');
  ok(!LEAD_IN_TAIL.test(aside), 'LEAD_IN_TAIL matches only a TRAILING connector, not an internal one');
  // A normal sentence ending in a period is unaffected.
  ok(has('Ada Lovelace wrote the first published algorithm.', 'Ada Lovelace'), 'an ordinary sentence is kept');

  // ── 2. The substance floor is per-script (language-agnostic) ──
  // A wholly non-Latin claim is a claim — the previous Latin-only letter test dropped it entirely.
  const cjkClaim = '柯里尔·舍甫琴科是这份文件中提到的国际象棋选手。';
  ok(claimsOf(cjkClaim).length === 1, 'a wholly non-Latin (CJK) sentence is kept as a claim');
  // A dense CJK sentence far shorter than the Latin character floor is still substantial enough to check.
  ok(has('干旱导致当年的收成大幅下降。', '干旱'),
    'a short but real CJK claim clears the per-script floor (not held to the Latin character count)');
  // Noise is still dropped on both sides: a tiny fragment and a letter-free string are not claims.
  ok(claimsOf('是棋手').length === 0, 'a tiny CJK fragment is dropped');
  ok(claimsOf('1234567890 2345 6789').length === 0, 'a letter-free (digits/punctuation only) fragment is dropped');
  ok(claimsOf('Too short.').length === 0, 'a sub-floor Latin fragment is dropped (unchanged behavior)');

  // De-duplication and the bullet/heading stripping are preserved end to end.
  const bulleted = '- Ada Lovelace designed the algorithm clearly.\n- Ada Lovelace designed the algorithm clearly.';
  ok(claimsOf(bulleted).length === 1, 'bullet markers are stripped and identical claims de-duplicated');

  console.log(`\nALL FAITHFULNESS-SEGMENTATION TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FAITHFULNESS-SEGMENTATION TEST FAILED:', e && e.message);
  process.exit(1);
}
