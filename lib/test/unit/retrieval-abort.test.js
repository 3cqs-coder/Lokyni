'use strict';
// Functional guard for the retrieval-phase abort. When a turn is abandoned (the client disconnects or
// clicks New), searchDocuments must bail promptly and return the same empty shape the out-of-scope path
// uses — WITHOUT running the aux-LLM round-trips (intent, rewrite, corrective, expansion) or the rerank,
// which would otherwise hold the serialized turn queue against the next real question. This calls
// searchDocuments with an already-aborted signal and asserts it returns the aborted result immediately.
// A minimal index stub (just enough to pass the readiness check) is used so no real model/index is needed.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { searchDocuments } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const minimalContext = () => ({
  history: [], docPassages: new Map(), docReadPos: new Map(), docExcludePos: new Map(),
  allowedDocIds: null, windowScoreCache: new Map(), summary: '', summarizedUpTo: 0, webPages: [],
});

// Just enough of an index that searchDocuments passes its readiness check and reaches the abort guard.
const stubIndex = () => ({
  liveVectorStore: {}, workspaceId: 'default', parentMap: new Map(), childMap: new Map(),
  passageMap: new Map(), corpusIdf: new Map(), liveBM25: null,
});

(async () => {
  try {
    const ac = new AbortController();
    ac.abort();   // the turn was abandoned before retrieval even started

    const started = Date.now();
    const result = await searchDocuments('any query', null, null, minimalContext(), false, null, 1, {
      idx: stubIndex(), signal: ac.signal,
    });
    const elapsed = Date.now() - started;

    // ── returns the caller-safe aborted shape ──
    ok(result && typeof result === 'object', 'searchDocuments returns a result object');
    ok(result.aborted === true, 'the result is flagged aborted');
    ok(Array.isArray(result.sources) && result.sources.length === 0, 'no sources are returned');
    ok(result.outOfScope === false, 'aborted is not reported as out-of-scope (no spurious web offer)');
    ok(result.canWebFallback === false, 'aborted does not offer a web fallback');

    // ── the stream is a real async-iterable that yields nothing ──
    ok(result.stream && typeof result.stream[Symbol.asyncIterator] === 'function', 'stream is async-iterable');
    let chunks = 0;
    for await (const _ of result.stream) { chunks++; }
    ok(chunks === 0, 'the aborted stream yields no text');

    // ── it bailed fast: an aborted turn must not do heavy work ──
    ok(elapsed < 1000, `aborted retrieval returns promptly (${elapsed}ms)`);

    console.log('✓ retrieval-abort: an abandoned turn returns the empty aborted result without doing retrieval work');
    console.log(`\nALL RETRIEVAL-ABORT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ RETRIEVAL-ABORT UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
