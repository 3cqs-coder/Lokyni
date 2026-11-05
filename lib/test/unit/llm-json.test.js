'use strict';
// Guards extractJson's recovery of a JSON object truncated by the model's token-limit cutoff — the common
// aux-model failure (intent classification, rewrite, faithfulness all parse small JSON under a tight maxTokens).
// Because the completed fields come first, closing the dangling string and balancing the braces recovers them,
// so a rambling trailing field (e.g. a "clarify" the model filled past the limit) never discards the whole
// decision. Pure, bounded, never throws. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const { extractJson, closeTruncatedJson } = require(path.resolve(__dirname, '..', '..', 'llm-json'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

try {
  // The real failure class: a valid decision whose trailing "clarify" ran past maxTokens and was cut mid-string
  // (synthetic subject/term, matching how the harness keeps names synthetic).
  const truncated = '{\n  "intent": "reference",\n  "targetDocs": [],\n  "resolvedQuery": "water cycle taxes",\n  "ambiguous": false,\n  "clarify": "Does the water cycle relate to a specific tax polic';
  const d = extractJson(truncated);
  ok(d && d.intent === 'reference' && Array.isArray(d.targetDocs) && d.targetDocs.length === 0 && d.resolvedQuery === 'water cycle taxes' && d.ambiguous === false,
    'a decision truncated mid trailing-field is recovered with its completed fields intact');

  // Cut-point variants.
  eq(extractJson('{"a":1,"b":2,'), { a: 1, b: 2 }, 'a cut right after a comma recovers the prior fields');
  eq(extractJson('{"a":1,"b":'), { a: 1 }, 'a cut right after a colon drops the valueless key');
  eq(extractJson('{"a":[1,2,3'), { a: [1, 2, 3] }, 'a cut mid-array closes the array');
  eq(extractJson('{"a":{"b":"cut mid'), { a: { b: 'cut mid' } }, 'a cut inside a nested string closes string + objects');
  eq(extractJson('{"a":1,"bc'), { a: 1 }, 'a cut mid-key drops the dangling key');

  // Normal + fenced + prose still work, and garbage is null.
  eq(extractJson('{"ok":true}'), { ok: true }, 'a complete object parses unchanged');
  eq(extractJson('```json\n{"x":1}\n```'), { x: 1 }, 'a fenced object parses');
  eq(extractJson('Sure! {"x":1} done'), { x: 1 }, 'an object surrounded by prose parses');
  ok(extractJson('not json at all') === null, 'non-JSON returns null (never throws)');
  ok(extractJson('') === null && extractJson(null) === null, 'empty / null input returns null');

  // Pure + bounded: closeTruncatedJson never throws and leaves a complete object unchanged.
  ok(closeTruncatedJson('{"x":1}') === '{"x":1}', 'closeTruncatedJson is a no-op on a complete object');
  ok(typeof closeTruncatedJson('{"a":"' + 'z'.repeat(100000)) === 'string', 'handles a very long truncated string without throwing');

  console.log(`\nALL LLM-JSON TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LLM-JSON TEST FAILED:', e && e.message);
  process.exit(1);
}
