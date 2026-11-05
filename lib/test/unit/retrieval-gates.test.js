'use strict';
// Guards the co-source relevance gates in the assembly loop of lib/retrieval/search.js. Several gates
// decide whether a second/third document tags along with the answer. They MUST all exempt two kinds of
// document, or answer quality regresses:
//   • an entity/knowledge-graph BRIDGE document (isBridgeDoc) — it answers "how are X and Y related"
//     through the graph, not by ranking high or repeating the query's keywords;
//   • a STRONG cross-encoder match (rerankByParent.get(docId) > 0) — a paraphrase/synonym co-source can
//     have low keyword overlap and a low fused score yet be exactly right.
// A prior bug left the RRF-score filter without these exemptions AND ended the loop (break) instead of
// skipping the doc (continue), silently dropping bridge/semantic co-sources ranked below a weaker doc.
// This is a source-level guard (the full gate needs a live index to exercise); it keeps the whole class
// of gates consistent so the fix can't silently regress. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Pull out the RRF co-source filter statement (the `if (...) { ... continue/break }` around the
// rrfFilterThreshold comparison) and assert its guard.
const sliceAround = (needle, before = 200, after = 200) => {
  const i = src.indexOf(needle);
  return i === -1 ? '' : src.slice(Math.max(0, i - before), i + after);
};

try {
  // ── The RRF co-source filter exempts bridge + strong-semantic and skips (continue), never break ──
  const rrfWindow = sliceAround('rrfScore < topRrfScore * rrfFilterThreshold', 260, 200);
  ok(rrfWindow.length > 0, 'the RRF co-source filter is present');
  ok(/isBridgeDoc/.test(rrfWindow), 'the RRF filter exempts entity-bridge documents');
  ok(/rerankByParent\.get\(docId\)\s*>\s*0/.test(rrfWindow), 'the RRF filter exempts a strong cross-encoder match');
  // The statement immediately after the RRF condition must be `continue`, not `break` — a break would
  // stop the score-sorted loop before reaching an exempt doc ranked lower.
  const afterRrf = src.slice(src.indexOf('rrfScore < topRrfScore * rrfFilterThreshold'), src.indexOf('rrfScore < topRrfScore * rrfFilterThreshold') + 320);
  ok(/\bcontinue;/.test(afterRrf) && !/\bbreak;/.test(afterRrf.slice(0, afterRrf.indexOf('continue;') + 9)),
    'the RRF filter skips the doc (continue), it does not end the loop (break)');
  console.log('✓ retrieval-gates: the RRF co-source filter exempts bridge/semantic docs and continues');

  // ── Every keyword/BM25 co-source gate keeps its bridge exemption (the shared invariant) ──
  // Each of these gate guards must reference isBridgeDoc so a bridge document is never dropped for
  // failing a keyword/BM25 test. Count the bridge exemptions in the assembly region.
  const assemblyStart = src.indexOf('for (const [docId, rrfScore] of rankedDocIds)');
  ok(assemblyStart !== -1, 'the assembly loop is present');
  const assembly = src.slice(assemblyStart, src.indexOf('\n  if (mergedDocs.length === 0)', assemblyStart) + 1 || undefined);
  const bridgeExemptions = (assembly.match(/isBridgeDoc/g) || []).length;
  ok(bridgeExemptions >= 4, `the co-source gates keep their bridge exemptions (found ${bridgeExemptions}, expected >= 4)`);
  console.log('✓ retrieval-gates: the co-source gates all keep the entity-bridge exemption');

  // ── The co-source filter references the GENUINE (pre-boost) top score, not a +0.05-promoted one ──
  // A flat +0.05 promotion is roughly three times the whole natural RRF range, so measuring the "within X% of
  // the top" bar against a boosted maximum silently drops legitimate co-sources. The reference must be the
  // pre-boost top score (captured after RRF + down-weight, before the promotions).
  ok(/const naturalTopRrfScore = fusedRanking\.length > 0 \? fusedRanking\[0\]\[1\] : 0;/.test(src),
    'the genuine pre-boost top fused score is captured before the +0.05 promotions');
  ok(/const topRrfScore = naturalTopRrfScore;/.test(src),
    'the co-source filter references the pre-boost top score, not the boosted maximum');
  console.log('✓ retrieval-gates: the co-source filter measures against the genuine pre-boost top score');

  // ── The BM25-dominant promotion reads the RRF winner from the UNFILTERED BM25 list ──
  // bm25Results is filtered to >=40% of the top keyword score, so a weak-keyword semantic RRF winner is absent
  // and would read 0 — firing the gate unconditionally and demoting the semantic winner. Use bm25AllResults.
  ok(/rrfTopBm25 = bm25AllResults\.find\(\(\[id\]\) => id === topRrf\)/.test(src),
    'the BM25-dominant gate reads the RRF winner score from the unfiltered bm25AllResults');
  console.log('✓ retrieval-gates: the BM25-dominant gate looks up the RRF winner in the unfiltered BM25 list');

  console.log(`\nALL RETRIEVAL-GATES UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ RETRIEVAL-GATES UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
