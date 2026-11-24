'use strict';
// Guards reference routing when the resolved query names a document outside the current thread. A true
// "does it mention X?" reference keeps the current document's name in its resolved query, so it stays anchored.
// A question like "what does his resume say?" resolves to the person's resume, which is a different document.
// The shared tokenizer and filenames decide this without language-specific rules. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { referenceForeignDocIds } = require(path.join(ROOT, 'lib', 'retrieval', 'search'));
const intentSrc = require('fs').readFileSync(path.join(ROOT, 'lib', 'retrieval', 'intent.js'), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const idx = {
    parentMap: new Map([
      ['tax', { metadata: { source: '/docs/2019 Northstar Tax Docs.pdf' } }],
      ['return', { metadata: { source: '/docs/2022-Return.pdf' } }],
      ['resume', { metadata: { source: '/docs/Avery_Quill_Resume.pdf' } }],
      ['resume2', { metadata: { source: '/docs/Resume Review — Avery Quill.docx' } }],
    ]),
    corpusIdf: new Map([
      ['avery', 3], ['quill', 3], ['resume', 3], ['tax', 3], ['return', 3], ['northstar', 3],
    ]),
  };
  const ranked = [['resume', 0.9], ['resume2', 0.8], ['return', 0.7], ['tax', 0.6]];

  assert.deepStrictEqual(
    referenceForeignDocIds('Avery Quill resume', ['tax', 'return'], ranked, idx),
    ['resume', 'resume2'],
    'a named resume outside the current thread is returned as the reference target'
  ); checks++;

  assert.deepStrictEqual(
    referenceForeignDocIds('2019 Northstar tax return budget', ['tax', 'return'], ranked, idx),
    [],
    'a true reference that keeps the current document name stays anchored'
  ); checks++;

  assert.deepStrictEqual(
    referenceForeignDocIds('Avery Quill resume', [], ranked, idx),
    [],
    'no current thread means no override'
  ); checks++;

  assert.deepStrictEqual(
    referenceForeignDocIds('Avery Quill resume', ['tax'], [], idx),
    [],
    'an empty ranking has nothing to prioritize'
  ); checks++;

  ok(/const docs = availableDocNames\(60, idx, query\);/.test(intentSrc),
    'the intent classifier receives the current question when building its document list');
  ok(/terms\.some\(t => base\.toLowerCase\(\)\.includes\(t\)\)/.test(intentSrc) &&
     /\[\.\.\.matching, \.\.\.rest\]/.test(intentSrc),
    'documents whose names match the question are shown before the generic list');

  console.log(`\nALL REFERENCE-ROUTING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ REFERENCE-ROUTING UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
