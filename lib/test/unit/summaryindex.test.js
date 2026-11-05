'use strict';
// Unit tests for the document-summary index guards (lib/indexing/summaryindex.js). The
// summary text itself needs a model, so this covers only the deterministic guards: the pass
// is a safe no-op (empty string, never throwing) when the feature is off or the input is too
// short to be worth summarizing, and the summary cache round-trips. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const summaryindex = require(path.join(PROJECT, 'lib', 'indexing', 'summaryindex'));
const summarycache = require(path.join(PROJECT, 'lib', 'summarycache'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── disabled by default: a no-op regardless of input ──
    eq(await summaryindex.summaryBlockFor('a fairly long piece of document text '.repeat(20), 'x.txt'), '',
      'feature off -> empty block');
    eq(await summaryindex.summaryBlockFor('', 'x.txt'), '', 'empty content -> empty block');
    eq(await summaryindex.summaryBlockFor('tiny', 'x.txt'), '', 'too-short content -> empty block');
    eq(await summaryindex.summaryBlockFor(null, 'x.txt'), '', 'non-string content -> empty block');
    console.log('✓ summaryindex: safe no-op when disabled or given short/invalid input');

    // ── summary cache round-trip (content-hash keyed, empty is a miss) ──
    const key = summarycache.keyFor('the original document text');
    eq(summarycache.get(key), null, 'unseen key -> miss');
    summarycache.set(key, '');                       // empty must not be stored
    eq(summarycache.get(key), null, 'empty value is never a hit');
    summarycache.set(key, 'Document summary (generated from this document):\nA concise overview.');
    ok(/A concise overview/.test(summarycache.get(key) || ''), 'a real summary round-trips');
    eq(summarycache.keyFor('different text') === key, false, 'the key is content-sensitive');
    console.log('✓ summaryindex: summary cache round-trips and is content-keyed');

    console.log(`\nALL SUMMARYINDEX UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ SUMMARYINDEX UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
