'use strict';
// Unit test for index-time Contextual Retrieval (lib/indexing/context.js). Two invariants that,
// if broken, silently corrupt the index or degrade it forever:
//   1. A FAILED blurb (the aux LLM threw or returned nothing) is never cached. Caching '' as a hit
//      would permanently disable contextual embeddings for that chunk even after the model recovers,
//      so a failure must be retried on the next run (self-healing), not frozen.
//   2. Contextualizing a chunk changes ONLY its embedded text (pageContent). The passage offsets and
//      metadata come from the RAW document and drive citations/highlighting, so they must be left
//      byte-for-byte untouched — otherwise a blurb's length would shift every citation.
// The aux LLM is stubbed (no model, no network); the on-disk cache is never flushed, so nothing
// persists. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const llm = require(path.join(PROJECT, 'lib', 'llm'));
const ctx = require(path.join(PROJECT, 'lib', 'indexing', 'context'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// A unique document/chunk per run so the content-keyed cache always misses on disk (a stale hit
// from a real prior index would mask the behavior under test).
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const makeDoc = () => ({ content: `Full document body about widgets. ${nonce}`, metadata: { source: '/docs/widgets.md' } });
// A distinct `tag` per case gives each its own content-cache key, so a blurb cached by one case can
// never mask the behavior of another within this single process.
const makeChunk = (tag) => ({
  pageContent: `revenue grew 3% ${nonce}-${tag}`,
  metadata: { source: '/docs/widgets.md', startChar: 42, endChar: 61, parentId: 'p1' },
});

const origComplete = llm.completeChat;

(async () => {
  try {
    // ── 1. A failing blurb is never cached: two failing runs each re-call the LLM (no frozen empty) ──
    {
      let calls = 0;
      llm.completeChat = async () => { calls += 1; throw new Error('provider down'); };
      const doc = makeDoc();
      const chunk = makeChunk('fail-a');
      const raw = chunk.pageContent;
      await ctx.contextualizeChunks(doc, [chunk]);
      eq(calls, 1, 'the blurb LLM is called once');
      eq(chunk.pageContent, raw, 'on failure the chunk keeps its raw text (degrades to normal retrieval)');

      // Same chunk content again — if the empty result had been cached, this would NOT re-call.
      const chunk2 = makeChunk('fail-a');
      await ctx.contextualizeChunks(makeDoc(), [chunk2]);
      eq(calls, 2, 'a failed blurb is retried on the next run, not frozen as an empty cache hit');
      console.log('✓ context: a failed blurb is never cached (self-heals on the next run)');
    }

    // ── 2. A successful blurb is prepended to pageContent ONLY; offsets/metadata are untouched ──
    {
      const blurb = `In the widgets report (${nonce}), the Q3 figures.`;
      llm.completeChat = async () => blurb;
      const doc = makeDoc();
      const chunk = makeChunk('ok-b');
      const rawText = chunk.pageContent;
      const metaBefore = JSON.stringify(chunk.metadata);
      await ctx.contextualizeChunks(doc, [chunk]);
      eq(chunk.pageContent, `${blurb}\n\n${rawText}`, 'the blurb is prepended to the embedded text');
      eq(JSON.stringify(chunk.metadata), metaBefore, 'metadata (source, startChar, endChar, parentId) is byte-for-byte unchanged');
      console.log('✓ context: a blurb changes only pageContent; passage offsets and metadata are preserved');
    }

    // ── 3. An empty (non-throwing) LLM reply also degrades safely and is not cached ──
    {
      let calls = 0;
      llm.completeChat = async () => { calls += 1; return '   '; };   // whitespace-only → no usable sentence
      const chunk = makeChunk('empty-c');
      const raw = chunk.pageContent;
      await ctx.contextualizeChunks(makeDoc(), [chunk]);
      const chunkAgain = makeChunk('empty-c');
      await ctx.contextualizeChunks(makeDoc(), [chunkAgain]);
      eq(chunk.pageContent, raw, 'an empty reply leaves the chunk as raw text');
      eq(calls, 2, 'an empty reply is not cached either (retried next run)');
      console.log('✓ context: an empty LLM reply degrades safely and is not frozen in the cache');
    }

    console.log(`\nALL CONTEXT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ CONTEXT UNIT TEST FAILED:', e && e.message, e && e.stack);
    process.exit(1);
  } finally {
    llm.completeChat = origComplete;
  }
})();
