'use strict';
// Model-free retrieval regression over a fixed, synthetic multilingual corpus.
//
// This drives the real search orchestration: the shared Unicode tokenizer, the production chunker,
// BM25, dense search, rank fusion, relevance gates, follow-up handling, passage windows, and citation
// offsets. Only the embedding transport is replaced, by the deterministic lexical stub in
// lib/test/eval/retrieval-harness.js. No model, network, worker, or disk write is involved.
//
// It guards the behaviors that are easiest to break without noticing: exact-term lookup in scripts
// without spaces, off-corpus abstention, pronoun-only follow-ups, citation bounds on a long document,
// dense subword matching, and deterministic output. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(PROJECT, 'lib', 'test', 'eval', 'retrieval-harness'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.strictEqual(a, b, msg); };

const sourceSignature = (result) => JSON.stringify(
  (result.sources || []).map((s) => [s.id, s.source, s.passageStart, s.passageEnd]),
);

const checkSourceBounds = (result, label) => {
  for (const source of result.sources || []) {
    ok(Number.isInteger(source.passageStart) && source.passageStart >= 0,
      `${label}: ${source.source} has a non-negative passageStart`);
    ok(Number.isInteger(source.passageEnd) && source.passageEnd >= source.passageStart,
      `${label}: ${source.source} has a non-inverted passage span`);
    ok(Number.isInteger(source.docLength) && source.passageEnd <= source.docLength,
      `${label}: ${source.source} cites within the document length`);
    ok(typeof source.snippet === 'string' && source.snippet.length > 0,
      `${label}: ${source.source} carries a readable snippet`);
    if (Array.isArray(source.servedRanges)) {
      for (const range of source.servedRanges) {
        ok(Number.isInteger(range.start) && range.start >= 0 &&
          Number.isInteger(range.end) && range.end >= range.start && range.end <= source.docLength,
          `${label}: ${source.source} has a valid served range`);
      }
    }
  }
};

(async () => {
  const hydePath = require.resolve(path.join(PROJECT, 'lib', 'retrieval', 'hyde'));
  const previousHyde = require.cache[hydePath];
  const llm = require(path.join(PROJECT, 'lib', 'llm'));
  const realStreamChat = llm.streamChat;
  const realCompleteChat = llm.completeChat;
  const realFetch = globalThis.fetch;
  let hydeCalls = 0;
  let llmCalls = 0;
  const beforeMinCosine = cfg.MIN_COSINE_SCORE;
  const beforeReranker = cfg.USE_RERANKER;

  try {
    // No model or network may run during this test, even on an unexpected code path.
    globalThis.fetch = async () => { throw new Error('network disabled in the retrieval regression'); };
    llm.streamChat = () => { llmCalls++; throw new Error('model call disabled in the retrieval regression'); };
    llm.completeChat = () => { llmCalls++; throw new Error('model call disabled in the retrieval regression'); };
    require.cache[hydePath] = {
      id: hydePath,
      filename: hydePath,
      loaded: true,
      children: [],
      paths: [],
      exports: { hypotheticalDoc: async () => { hydeCalls++; return ''; } },
    };

    await H.withRetrievalConfig(H.RETRIEVAL_OFF, async () => {
      // ── Fixture shape is bounded, so the regression cannot become an accidental stress test ──
      const totalChars = H.FIXTURE_DOCS.reduce((sum, doc) => sum + doc.text.length, 0);
      ok(H.FIXTURE_DOCS.length >= 11, 'the fixture has all ten short documents plus the long document');
      ok(H.FIXTURE_QUERIES.length >= 10, 'the fixture covers at least ten languages');
      ok(new Set(H.FIXTURE_QUERIES.map((q) => q.lang)).size >= 10, 'every language in the fixture has one query');
      ok(totalChars > 10_000 && totalChars < 100_000, 'the fixture size is bounded');
      const fixtureNames = new Set(H.FIXTURE_DOCS.map((doc) => doc.name));
      eq(fixtureNames.size, H.FIXTURE_DOCS.length, 'every fixture document has a unique file name');
      for (const item of H.FIXTURE_QUERIES) ok(fixtureNames.has(item.expect), `${item.lang}: the expected document exists`);

      const { bundle, embeddings } = await H.buildFixtureBundle();
      eq(bundle.parentMap.size, H.FIXTURE_DOCS.length, 'every fixture document is in the parent map');
      ok(bundle.childMap.size > 0, 'the chunker produced child chunks');
      ok(bundle.passageMap.size === bundle.childMap.size, 'every child chunk has a passage position');
      ok([...bundle.passageMap.values()].every((p) => p.startChar >= 0), 'every chunk resolved to a source offset');
      ok(bundle.liveBM25 && bundle.liveBM25.engine && !bundle.liveBM25.empty, 'BM25 built for the multilingual corpus');
      ok(bundle.liveVectorStore && bundle.liveVectorStore.index &&
        Number(bundle.liveVectorStore.index.ntotal()) > 0, 'the dense index holds the fixture chunks');

      // ── One exact-term query per writing system ──
      for (const item of H.FIXTURE_QUERIES) {
        const result = await H.runRetrieval(bundle, item.query);
        ok(!result.outOfScope, `${item.lang}: the in-corpus query is not declined`);
        ok(result.sources.length >= 1, `${item.lang}: at least one source is returned`);
        eq(result.sources[0].source, item.expect, `${item.lang}: the query retrieves its own document`);
        ok(typeof result.stream?.[Symbol.asyncIterator] === 'function', `${item.lang}: the answer stream is lazy and untouched`);
        checkSourceBounds(result, item.lang);
      }

      // ── Off-corpus abstention ──
      const off = await H.runRetrieval(bundle, H.OFF_CORPUS_QUERY);
      ok(off.outOfScope === true, 'an off-corpus question is declined');
      eq(off.sources.length, 0, 'a declined question cites nothing');
      eq(hydeCalls, 0, 'no model-backed HyDE call happened');

      // ── Unknown named subjects are declined despite matching domain words ──
      for (const [label, query] of [
        ['novel named entity', H.NOVEL_ENTITY_QUERY],
        ['novel identifier', H.NOVEL_IDENTIFIER_QUERY],
        ['quoted novel name', H.NOVEL_QUOTED_QUERY],
      ]) {
        const result = await H.runRetrieval(bundle, query);
        ok(result.outOfScope === true, `${label}: the question is declined`);
        eq(result.sources.length, 0, `${label}: no document is cited`);
      }
      const mixed = await H.runRetrieval(bundle, H.MIXED_ENTITY_QUERY);
      ok(mixed.outOfScope !== true, 'a known subject alongside an unknown one is still answerable');
      ok(mixed.sources.some((source) => source.source === H.FIXTURE_QUERIES[0].expect),
        'the mixed question retrieves the known subject');

      // ── Pronoun-only follow-up uses the conversation document ──
      const first = await H.runRetrieval(bundle, H.FIXTURE_QUERIES[0].query);
      const conversation = H.makeConversation({
        history: [
          { role: 'user', content: H.FIXTURE_QUERIES[0].query },
          { role: 'assistant', content: 'The Zorvath launch code is ZX-9042.' },
        ],
        allowedDocIds: [first.sources[0].id],
      });
      const follow = await H.runRetrieval(bundle, H.FOLLOW_UP_QUERY, conversation);
      ok(!follow.outOfScope, 'a pronoun-only follow-up is not declined while the conversation has a document');
      eq(follow.sources[0].source, H.FIXTURE_QUERIES[0].expect, 'the follow-up stays on the conversation document');
      checkSourceBounds(follow, 'follow-up');

      // A new subject raised mid-conversation gets the same treatment as a first-turn one. A known
      // subject in the same position is not declined, so the gate does not break a topic switch to a
      // document that exists.
      const midConversation = () => H.makeConversation({
        history: [
          { role: 'user', content: H.FIXTURE_QUERIES[0].query },
          { role: 'assistant', content: 'The Zorvath launch code is ZX-9042.' },
        ],
        allowedDocIds: [first.sources[0].id],
      });
      const novelFollow = await H.runRetrieval(bundle, H.NOVEL_ENTITY_FOLLOW_UP_QUERY, midConversation());
      ok(novelFollow.outOfScope === true, 'a novel subject raised mid-conversation is declined');
      eq(novelFollow.sources.length, 0, 'the mid-conversation decline cites nothing');
      const knownFollow = await H.runRetrieval(bundle, H.KNOWN_ENTITY_FOLLOW_UP_QUERY, midConversation());
      ok(knownFollow.outOfScope !== true, 'a known subject raised mid-conversation is not declined');
      ok(knownFollow.sources.length > 0, 'the known mid-conversation subject still returns a source');

      // ── Long-document citation offsets ──
      const long = await H.runRetrieval(bundle, H.LONG_DOCUMENT_QUERY);
      ok(!long.outOfScope, 'the long-document phrase is retrievable');
      eq(long.sources[0].source, H.LONG_DOCUMENT_NAME, 'the long-document query retrieves the long document');
      ok(long.sources[0].passageStart > 0, 'the long document serves a window past its start');
      const longDoc = H.FIXTURE_DOCS.find((doc) => doc.name === H.LONG_DOCUMENT_NAME);
      const markerAt = longDoc.text.indexOf(H.LONG_DOCUMENT_MARKER);
      ok(long.sources[0].passageStart <= markerAt &&
        long.sources[0].passageEnd >= markerAt + H.LONG_DOCUMENT_MARKER.length,
        'the served window covers the requested phrase');
      checkSourceBounds(long, 'long document');

      // ── Determinism ──
      const repeatA = await H.runRetrieval(bundle, H.FIXTURE_QUERIES[2].query);
      const repeatB = await H.runRetrieval(bundle, H.FIXTURE_QUERIES[2].query);
      eq(sourceSignature(repeatA), sourceSignature(repeatB), 'identical queries produce identical sources and offsets');

      // ── Dense subword matching (no exact token in the index) ──
      const { denseSearch } = require(path.join(PROJECT, 'lib', 'embeddings'));
      const dense = await denseSearch(bundle, H.DENSE_VARIANT_QUERY, 5);
      ok(dense.length > 0, 'the dense path returns a variant match');
      eq(dense[0][0].metadata.parentId, H.docIdForName(H.FIXTURE_QUERIES[0].expect), 'character n-grams route the variant to the right document');
      ok(dense[0][1] > 0.05, 'the variant clears a meaningful dense similarity');

      // ── Language-agnostic BM25 term lookup ──
      const raw = bundle.liveBM25.engine.search(H.BM25_CJK_QUERY, 3);
      ok(raw.length > 0, 'the CJK bigram has a BM25 posting');
      eq(bundle.liveBM25.idToDocId.get(Number(raw[0][0])), H.docIdForName('qilin-zh.md'),
        'the CJK bigram resolves to its own document');

      // The stub is deterministic and covers the scripts the fixture claims.
      ok((await embeddings.embedQuery('')).every((n) => n === 0), 'an empty query embeds as a finite zero vector');
      eq(JSON.stringify(await embeddings.embedQuery('Zorvath')), JSON.stringify(await embeddings.embedQuery('Zorvath')),
        'the same query embeds identically twice');
    });

    eq(cfg.MIN_COSINE_SCORE, beforeMinCosine, 'the test restores the configured cosine floor');
    eq(cfg.USE_RERANKER, beforeReranker, 'the test restores the reranker setting');
    eq(hydeCalls, 0, 'the whole run stayed model-free');
    eq(llmCalls, 0, 'no streaming or auxiliary model call happened');

    console.log(`\nALL RETRIEVAL-REGRESSION UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ RETRIEVAL-REGRESSION UNIT TEST FAILED:', e && e.message, e && e.stack);
    process.exitCode = 1;
  } finally {
    if (previousHyde) require.cache[hydePath] = previousHyde;
    else delete require.cache[hydePath];
    llm.streamChat = realStreamChat;
    llm.completeChat = realCompleteChat;
    globalThis.fetch = realFetch;
  }
})();
