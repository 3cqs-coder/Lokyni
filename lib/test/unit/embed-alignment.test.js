'use strict';
// Guards the embed vector<->document alignment fallback in lib/indexing/delta.js (embedChunks). Vectors
// are paired to documents POSITIONALLY when persisted, so if the embedding provider returns a different
// number of vectors than texts (a dropped, deduped, or partial batch), every vector after the gap would
// be attributed to the WRONG document — silently producing wrong citations and wrong-document answers.
// embedChunks defends against this by falling back to a one-at-a-time path that pairs each chunk with its
// own vector. This test drives embedChunks with stub embedding clients (no model, no network) to assert
// that pairing stays correct across the good path, a count mismatch, and a batch failure. Run:
// `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { embedChunks } = require(path.join(PROJECT, 'lib', 'indexing', 'delta'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// A chunk carries a marker in both its text and metadata so we can verify each returned vector ended up
// paired with the SAME chunk it was produced from.
const chunkFor = (n) => ({ pageContent: `chunk-${n}`, metadata: { source: `/d/${n}.txt`, marker: n } });
// A deterministic "embedding" that encodes which text produced it, so a mispairing is detectable.
const vecFor = (text) => [text.length, text.charCodeAt(text.length - 1)];

(async () => {
  try {
    const chunks = Array.from({ length: 12 }, (_, i) => chunkFor(i));

    // ── Good path: provider returns one vector per text, in order ──
    {
      const emb = { embedDocuments: async (texts) => texts.map(vecFor) };
      const results = await embedChunks(chunks, emb);
      const pairs = results.flatMap(r => r.batch.map((d, i) => ({ d, v: r.vecs[i] })));
      eq(pairs.length, chunks.length, 'every chunk is embedded on the good path');
      ok(pairs.every(({ d, v }) => JSON.stringify(v) === JSON.stringify(vecFor(d.pageContent))),
        'each chunk is paired with the vector produced from its own text');
      console.log('✓ embed-alignment: good path pairs every chunk with its own vector');
    }

    // ── Count mismatch: a batch returns FEWER vectors than texts → must fall back to 1:1, not misalign ──
    {
      // Drop one vector on any multi-text batch (simulates a deduped/partial provider response). The
      // per-text path (single-text calls) returns the correct 1 vector, so the fallback recovers cleanly.
      const emb = { embedDocuments: async (texts) => (texts.length > 1 ? texts.slice(1).map(vecFor) : texts.map(vecFor)) };
      const results = await embedChunks(chunks, emb);
      const pairs = results.flatMap(r => r.batch.map((d, i) => ({ d, v: r.vecs[i] })));
      eq(pairs.length, chunks.length, 'the 1:1 fallback still embeds every chunk after a short batch');
      ok(pairs.every(({ d, v }) => JSON.stringify(v) === JSON.stringify(vecFor(d.pageContent))),
        'after a count mismatch, each chunk is still paired with ITS OWN vector (no positional drift)');
      console.log('✓ embed-alignment: a short batch falls back to 1:1 and never mis-attributes a vector');
    }

    // ── Batch failure: the batch call throws → 1:1 recovery embeds each chunk, skipping only true failures ──
    {
      const emb = {
        embedDocuments: async (texts) => {
          if (texts.length > 1) throw new Error('batch boom');   // whole-batch failure
          if (texts[0] === 'chunk-3') throw new Error('bad chunk');   // one genuinely unembeddable chunk
          return texts.map(vecFor);
        },
      };
      const results = await embedChunks(chunks, emb);
      const pairs = results.flatMap(r => r.batch.map((d, i) => ({ d, v: r.vecs[i] })));
      eq(pairs.length, chunks.length - 1, 'a whole-batch failure recovers every chunk except the one that genuinely fails');
      ok(!pairs.some(({ d }) => d.metadata.marker === 3), 'the unembeddable chunk is skipped, not mispaired');
      ok(pairs.every(({ d, v }) => JSON.stringify(v) === JSON.stringify(vecFor(d.pageContent))),
        'recovered chunks are each paired with their own vector');
      console.log('✓ embed-alignment: a batch failure recovers 1:1 and skips only the genuinely bad chunk');
    }

    console.log(`\nALL EMBED-ALIGNMENT UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ EMBED-ALIGNMENT UNIT TEST FAILED:', e && e.message, e && e.stack);
    process.exitCode = 1;
  }
})();
