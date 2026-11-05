'use strict';
// Unit tests for RAG-Fusion's pure pieces: the query-variant parser (multiquery.parseVariants)
// and the dense-list fusion (rrf.fuseDenseLists). No network, no model call, no vector store.
//   - parseVariants: strips bullets/numbering/quotes, excludes a restatement of the original,
//     de-duplicates, and caps the count.
//   - fuseDenseLists: unions candidate chunks across lists keyed by text, orders by reciprocal
//     rank fusion, and preserves each chunk's best (max) cosine so downstream gates still read
//     a real similarity value.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { parseVariants } = require(path.join(PROJECT, 'lib', 'retrieval', 'multiquery'));
const { fuseDenseLists } = require(path.join(PROJECT, 'lib', 'retrieval', 'rrf'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const doc = (text, parentId, childId) => ({ pageContent: text, metadata: { parentId, childId } });

try {
  // ── parseVariants ──
  {
    const v = parseVariants(
      '1. What is the budget?\n- how much money\n* "annual spend"\noriginal question',
      'original question', 5
    );
    eq(v.length, 3, 'three variants (the original is excluded)');
    eq(v[0], 'What is the budget?', 'numbering stripped');
    eq(v[1], 'how much money', 'bullet stripped');
    eq(v[2], 'annual spend', 'quotes stripped');
    ok(!v.some(x => x.toLowerCase() === 'original question'), 'original query excluded');
    console.log('✓ ragfusion: parseVariants cleans, excludes the original, caps');

    const capped = parseVariants('alpha query?\nbravo query?\ncharlie query?\ndelta query?', 'q', 2);
    eq(capped.length, 2, 'respects the max count');

    eq(parseVariants('', 'query', 3).length, 0, 'empty input -> []');
    eq(parseVariants('query\nQUERY\n  query  ', 'query', 3).length, 0, 'only restatements/dupes -> []');
    console.log('✓ ragfusion: parseVariants handles caps and empty input');
  }

  // ── fuseDenseLists ──
  {
    const A = doc('AAA', 'd1'), B = doc('BBB', 'd2'), C = doc('CCC', 'd3'), D = doc('DDD', 'd4');
    // A is rank 0 in both lists → should rank first. All four chunks should survive (union).
    const list1 = [[A, 0.50], [B, 0.80], [C, 0.70]];
    const list2 = [[A, 0.90], [D, 0.40]];
    const fused = fuseDenseLists([list1, list2]);
    eq(fused.length, 4, 'union of all distinct chunks');
    eq(fused[0][0].pageContent, 'AAA', 'the chunk ranked highly in both lists wins');
    eq(fused[0][1], 0.90, 'the max cosine across lists is preserved');
    const keys = fused.map(([d]) => d.pageContent).sort();
    assert.deepStrictEqual(keys, ['AAA', 'BBB', 'CCC', 'DDD']); checks++;
    console.log('✓ ragfusion: fuseDenseLists unions, RRF-orders, keeps the max cosine');

    // Robustness: empty/garbage lists never throw, chunks with no key are dropped.
    eq(fuseDenseLists([]).length, 0, 'no lists -> []');
    eq(fuseDenseLists([[], null, undefined]).length, 0, 'empty/garbage lists -> []');
    eq(fuseDenseLists([[[{ metadata: {} }, 0.5]]]).length, 0, 'a chunk with no key is dropped');
    console.log('✓ ragfusion: fuseDenseLists is robust to empty and malformed input');
  }

  // ── keyed by chunk id, not text: two parents sharing an identical chunk both survive ──
  {
    // A boilerplate header repeated verbatim in two different documents. Keying by text would
    // collapse them into one entry and silently drop a parent surfaced only via that chunk;
    // keying by childId keeps both.
    const shared1 = doc('CONFIDENTIAL — internal use only', 'docA', 'docA#0');
    const shared2 = doc('CONFIDENTIAL — internal use only', 'docB', 'docB#0');
    const unique  = doc('Q3 revenue rose twelve percent', 'docA', 'docA#1');
    const fused = fuseDenseLists([[[shared1, 0.62], [shared2, 0.61], [unique, 0.55]]]);
    eq(fused.length, 3, 'identical-text chunks from different parents are not collapsed');
    const parents = new Set(fused.map(([d]) => d.metadata.parentId));
    ok(parents.has('docA') && parents.has('docB'), 'both parents remain reachable through the fused set');
    console.log('✓ ragfusion: fuseDenseLists keys by chunk id so shared text does not drop a parent');
  }

  console.log(`\nALL RAG-FUSION UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ RAG-FUSION UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
