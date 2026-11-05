'use strict';
// Unit tests for the adaptive-routing complexity heuristic (lib/retrieval/complexity.js).
// It decides, with no LLM, whether a query is involved enough to justify the expensive
// multi-query (RAG-Fusion) path. Simple factual lookups must rate "simple" (fast path);
// comparative, multi-part, multi-entity, or long questions must rate "complex". Pure and
// deterministic. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { assessComplexity } = require(path.join(PROJECT, 'lib', 'retrieval', 'complexity'));

let checks = 0;
const isSimple  = (q) => { checks++; assert.strictEqual(assessComplexity(q).level, 'simple',  `expected simple: "${q}"`); };
const isComplex = (q) => { checks++; assert.strictEqual(assessComplexity(q).level, 'complex', `expected complex: "${q}"`); };

try {
  // ── simple factual lookups take the fast path ──
  isSimple('Who wrote the report?');
  isSimple('What is the budget?');
  isSimple('When was it approved?');
  isSimple('Define net revenue.');
  isSimple('cats and dogs');                 // a short noun pair is not multi-clause
  isSimple('Who was Matilda MacElroy?');      // a full name is ONE entity, not two
  isSimple('What did Acme Corp announce?');   // a multi-word company name is one entity
  console.log('✓ complexity: simple lookups rate simple');

  // ── comparative / analytic / multi-part questions rate complex ──
  isComplex('Compare the Q2 and Q3 findings.');
  isComplex('What is the difference between the two proposals?');
  isComplex('Analyze the causes of the decline.');
  isComplex('What happened, and who was responsible, and why did it take so long?');
  isComplex('Summarize the implications across all of the audit documents in depth.');
  isComplex('How did the Acme merger affect the Globex partnership?');   // two named entities
  isComplex('Give me a comprehensive overview of every policy change and its rationale this year');  // long
  console.log('✓ complexity: comparative, analytic, multi-part, multi-entity, and long rate complex');

  // ── language-agnostic length: a long space-free CJK question must rate complex, not "simple" ──
  // (Word count misreads space-free scripts as one word; the CJK-character length signal catches them.)
  // Synthetic placeholder subjects (not real entities); content spans languages per the multilingual bar.
  isComplex('请详细比较第二季度和第三季度的财务结果并说明造成差异的主要原因和影响');   // long Chinese comparative question
  isComplex('第二四半期と第三四半期の調査結果の違いとその原因について詳しく説明してください');   // long Japanese question
  isSimple('预算是多少？');        // a short CJK factual lookup stays on the fast path
  isSimple('누가 보고서를 썼나요?');  // a short Korean lookup stays simple
  console.log('✓ complexity: long CJK/Japanese questions rate complex; short ones stay simple (language-agnostic length)');

  // ── edge cases never throw ──
  checks++; assert.strictEqual(assessComplexity('').level, 'simple', 'empty -> simple');
  checks++; assert.strictEqual(assessComplexity(null).level, 'simple', 'null -> simple');
  checks++; assert.ok(Array.isArray(assessComplexity('Compare A and B').reasons), 'reasons is an array');
  console.log('✓ complexity: empty/null inputs are safe');

  console.log(`\nALL COMPLEXITY UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ COMPLEXITY UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
