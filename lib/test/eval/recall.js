'use strict';
// Retrieval-recall benchmark over the English golden set — the ranking-quality counterpart to run.js (which
// grades answer honesty). For every labeled "answer" case in cases.json it runs the REAL retrieval pipeline and
// checks whether the expected document (`expectDoc`) is among the SERVED sources, and at what rank. It isolates
// RETRIEVAL quality from the LLM, so it is exactly what you want when weighing a fusion/threshold/reranker change:
// apply the change, re-run this, and compare recall / MRR before shipping (a ranking tweak must never ship on
// intuition — measure it here first). The measurement itself lives in recall-core.js, shared with the
// multilingual eval so the two can never drift apart.
//
// Runs in a throwaway temp dir over lib/test/eval/fixtures; never touches ./data. Requires the embedding provider
// (Ollama by default) reachable. Run: `npm run eval:recall`. Exit code: 0 if recall@served meets the gate, 1 if
// below, 2 on a harness/setup error.

const path = require('path');
const { cases } = require('./golden').load();   // hardened, fail-safe loader
const { runRecallEval } = require('./recall-core');

const _gate = process.argv.find(a => a.startsWith('--min-recall='));
const MIN_RECALL = Number((_gate && _gate.split('=')[1]) || 0.9);

// Only the grounded "answer" cases that name an expected document exercise retrieval recall.
const recallCases = cases.filter(c => c.expect === 'answer' && c.expectDoc).map(c => ({ query: c.query, expectDoc: c.expectDoc }));

runRecallEval({
  fixturesDir: path.join(__dirname, 'fixtures'),
  cases: recallCases,
  minRecall: MIN_RECALL,
  title: 'RETRIEVAL RECALL',
});
