'use strict';
// Guards the document-budget contract shared by lib/llm.js and lib/retrieval/search.js. buildMessages
// caps the concatenated DOCUMENTS block to a character budget and drops the overflow; search.js calls
// the exported docsBudget() to trim its served-document set to the SAME budget BEFORE building the
// answer, the citation list, and the served/allowed ids — so it never cites a document the model never
// saw. If the two ever computed a different budget, a trailing document could be truncated out of the
// prompt yet still cited. This asserts: docsBudget is exported and shrinks as the header grows, and — the
// invariant the fix depends on — buildMessages truncates a large context to EXACTLY docsBudget chars.
// It also source-guards that search.js trims before it builds sources. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { buildMessages, docsBudget } = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── docsBudget is exported and sane ──
  const plain = docsBudget([], 'What is X?', '', {});
  ok(typeof plain === 'number' && plain > 0, 'docsBudget returns a positive character budget');

  // A larger header (a conversation summary, or a per-mode note) leaves LESS room for documents.
  ok(docsBudget([], 'q', 'a long prior-conversation summary '.repeat(50), {}) < plain, 'a summary shrinks the doc budget');
  ok(docsBudget([], 'q', '', { isComparison: true }) < plain, 'comparison mode shrinks the doc budget');
  ok(docsBudget([], 'q', '', { isPartial: true }) < plain, 'partial mode shrinks the doc budget');
  // A longer verbatim history also reserves more, leaving a smaller doc budget.
  const longHist = []; for (let i = 0; i < 8; i++) longHist.push({ role: 'user', content: 'u'.repeat(800) }, { role: 'assistant', content: 'a'.repeat(800) });
  ok(docsBudget(longHist, 'q', '', {}) < plain, 'a longer history shrinks the doc budget');
  console.log('✓ docsbudget: docsBudget is exported and shrinks as the header/history grow');

  // ── The invariant the fix relies on: buildMessages truncates to EXACTLY docsBudget chars ──
  // A context built from a sentinel character that never appears in the header (a snowman): the kept
  // sentinel count must equal docsBudget, proving the trim math in search.js (which keeps documents whose
  // content starts before docsBudget) matches the cap buildMessages actually applies. Counting a
  // header-free character isolates the DOCUMENTS section from the rules/role text.
  const SENT = '☃';
  for (const opts of [{}, { isComparison: true }, { isPartial: true }]) {
    const budget = docsBudget([], 'q?', '', opts);
    const huge = SENT.repeat(budget + 50000);
    // The DOCUMENTS block rides in the final user turn (placement fix), so read it from there, not the system prompt.
    const built = buildMessages(huge, [], 'q?', '', opts);
    const docsTurn = built[built.length - 1].content;
    ok(docsTurn.includes('[...truncated]'), 'an oversized context is truncated');
    const kept = (docsTurn.match(new RegExp(SENT, 'g')) || []).length;
    eq(kept, budget, `buildMessages keeps exactly docsBudget chars (opts ${JSON.stringify(opts)}): kept ${kept}, budget ${budget}`);
  }
  console.log('✓ docsbudget: buildMessages truncates to exactly the budget docsBudget reports');

  // ── search.js trims the served set to the budget BEFORE building sources / served ids / trace.used ──
  const searchSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
  const trimAt    = searchSrc.indexOf("require('../llm').docsBudget(");
  const servedAt  = searchSrc.indexOf('const servedIds = mergedDocs.map');
  const usedAt    = searchSrc.indexOf('trace.used(mergedDocs.map');
  const sourcesAt = searchSrc.indexOf('sources: mergedDocs.map');
  ok(trimAt !== -1, 'search.js computes the doc budget via the shared docsBudget');
  ok(/mergedDocs\.length = keep/.test(searchSrc), 'search.js trims the served documents to what fits');
  ok(trimAt < servedAt && trimAt < usedAt && trimAt < sourcesAt,
    'the trim happens before served ids, trace.used, and the sources list are built');
  console.log('✓ docsbudget: search.js trims served documents before citing them');

  // ── The budget heuristics (chars/token, floor, reserve margin) are single-sourced in llm.js, so the
  //    deep-research report — which builds its OWN system header and can't call docsBudget — can never drift
  //    from buildMessages. Guard both the export and that deepresearch consumes the constants, not literals. ──
  const llm = require(path.join(PROJECT, 'lib', 'llm'));
  ok(llm.CHARS_PER_TOKEN > 0 && llm.MIN_DOCS_CHARS > 0 && llm.PROMPT_RESERVE_MARGIN > 0,
    'llm.js exports the prompt-budget heuristics (chars/token, floor, reserve margin)');
  const drSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'deepresearch.js'), 'utf-8');
  ok(/llm\.CHARS_PER_TOKEN/.test(drSrc) && /llm\.MIN_DOCS_CHARS/.test(drSrc) && /llm\.PROMPT_RESERVE_MARGIN/.test(drSrc),
    'deep-research derives its evidence budget from the shared llm.js constants');
  ok(!/numCtxTokens \* 3\b/.test(drSrc) && !/Math\.max\(2000,/.test(drSrc),
    'deep-research no longer hardcodes the chars/token ratio or the floor (no drift from buildMessages)');
  console.log('✓ docsbudget: deep-research shares the budget heuristics with buildMessages (no drift)');

  console.log(`\nALL DOCSBUDGET UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ DOCSBUDGET UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
