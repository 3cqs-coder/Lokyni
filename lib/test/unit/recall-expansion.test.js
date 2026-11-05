'use strict';
// Guards the near-miss recall second-chance in lib/retrieval/search.js. Symptom it addresses: a question
// whose answer IS in the corpus is wrongly declined (and a web search offered) because the documents use a
// different word than the question — e.g. a corpus that says "giants" while the question asks about
// "titans" finds no keyword match and the dense similarity sits just below the relevance bar. The fix: when the gate
// fails but a candidate passage scored just below the bar, improve the QUERY once (HyDE) and retrieve again,
// then re-check the SAME gate at the SAME bar. The non-negotiable property is that it NEVER lowers the bar —
// it only improves recall — so accuracy is preserved and it generalizes to any corpus. Retrieval is
// index/model-coupled, so this source-guards the invariants. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Isolate the gate + recall block.
  const gateIdx = src.indexOf('let relevant = isQueryRelevant(');
  ok(gateIdx !== -1, 'the relevance gate result is captured so the recall pass can retry before declining');
  const body = src.slice(gateIdx, gateIdx + 4000);

  // Gated correctly: only on a failed gate, only when always-on HyDE is OFF (it already ran if on), not on a
  // retry, not for focus/attachment, and only when there were candidate passages.
  ok(/if \(!relevant && USE_RERANKER && !useHyde && !isRetry && !hasAttachment && !focusMode && faissResults\.length > 0 && !bailIfAborted\(\)\)/.test(body),
    'the recall pass is gated to a failed gate with candidates present, the reranker on (so the cross-encoder validates the rescue), no retry/focus/attachment, HyDE off');

  // Near-miss band is RELATIVE to the configured bar (not a magic number) — a candidate scored a fraction of
  // MIN_COSINE_SCORE but still below it. A clean miss (near-zero) and a genuine out-of-corpus query do NOT fire.
  ok(/const minCos = require\('\.\.\/config'\)\.MIN_COSINE_SCORE;/.test(body), 'the band is relative to the configured relevance bar');
  ok(/const nearMiss = Number\.isFinite\(topCosine\) && topCosine >= minCos \* 0\.6 && topCosine < minCos;/.test(body),
    'near-miss = a candidate just below the bar (corpus/model-relative), never a clean miss');

  // It improves the QUERY (HyDE), re-retrieves, fuses, and RE-CHECKS the SAME gate — never lowers the bar.
  ok(/hypotheticalDoc\(standaloneQuery/.test(body), 'the retry improves the query via a hypothetical answer (HyDE)');
  ok(/faissResults = fuseDenseLists\(\[faissResults, more\]\)\.slice\(0, FAISS_CANDIDATES\)/.test(body),
    'the new candidates are fused into the existing set (bounded)');
  // The rescue decision uses a LOCAL cosine over the expanded set; it must NOT overwrite the module-level
  // topCosine (which the corrective-retrieval trigger reads — an inflated value there would wrongly suppress it).
  ok(/const rescueCosine = faissResults\.reduce\(/.test(body),
    'the rescue computes a local cosine for its decision');
  ok(/relevant = isQueryRelevant\(idx, standaloneQuery, faissResults\.length > 0 \? rescueCosine : null, bm25Raw\)/.test(body),
    'it re-checks the relevance gate against the expanded candidate set (bar never lowered)');
  ok(!/\btopCosine = faissResults\.reduce\(/.test(body),
    'the near-miss rescue does NOT overwrite the module-level topCosine (keeps the corrective-retrieval trigger honest)');

  // Best-effort: a HyDE/search failure is swallowed and the query proceeds to the normal decline (web offer).
  ok(/Near-miss recall skipped/.test(src) && /\} catch \(e\) \{ if \(DEBUG\) console\.log/.test(src),
    'a failure in the recall pass is non-fatal — it falls through to the normal out-of-scope path');

  // The decline/out-of-scope path still runs when the retry did not clear the bar.
  ok(/if \(!relevant\) \{[\s\S]{0,800}?const hasContext = focusMode \|\| entityBridged \|\| namesCorpusEntity/.test(src),
    'a still-failing gate falls through to the unchanged out-of-scope / web-offer decision');

  console.log(`\nALL RECALL-EXPANSION TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RECALL-EXPANSION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
