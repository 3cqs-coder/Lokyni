'use strict';
// Guards the shared citation-snippet helper. The retrieval paths that produce a snippet and the
// session store that re-caps it all go through makeSnippet, so its behavior — a hard length cap,
// whitespace collapse, and safe handling of empty/non-string input — must stay correct and stable.
// A change here would affect every citation preview. No model or network. Run: `npm run test:unit`.

const assert = require('assert');
const { makeSnippet, SNIPPET_MAX_CHARS } = require('../../snippet');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  ok(SNIPPET_MAX_CHARS === 320, 'the cap is the expected value');

  // Length cap: never longer than the cap, regardless of input size.
  const long = 'x'.repeat(5000);
  ok(makeSnippet(long).length === SNIPPET_MAX_CHARS, 'a long passage is capped');

  // Whitespace is collapsed to single spaces and trimmed.
  ok(makeSnippet('  a\n\n b\t\tc  ') === 'a b c', 'whitespace is collapsed and trimmed');

  // The cap counts the collapsed characters, so a passage that is mostly whitespace still yields a
  // full-length snippet of real content (the bounded prefix leaves room for the collapse).
  const spaced = Array.from({ length: 1000 }, (_, i) => `w${i}`).join('   ');
  ok(makeSnippet(spaced).length === SNIPPET_MAX_CHARS, 'whitespace-heavy input still fills the cap');
  ok(!/\s\s/.test(makeSnippet(spaced)), 'no double spaces survive the collapse');

  // Non-string / empty input is safe (never throws, returns '').
  ok(makeSnippet(null) === '', 'null is safe');
  ok(makeSnippet(undefined) === '', 'undefined is safe');
  ok(makeSnippet('') === '', 'empty string is safe');
  ok(makeSnippet(12345) === '12345', 'a number is coerced, not thrown on');

  console.log(`\nALL SNIPPET UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SNIPPET UNIT TEST FAILED:', e.message);
  process.exit(1);
}
