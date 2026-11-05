'use strict';
// Guards the "no unbounded provider network call on a hot path" invariant (audit pass 18).
//
// Every LLM *generation* call is idle-bounded by raceTimeout, but two classes of provider call
// were not: query EMBEDDINGS (the search hot path) and single-shot VISION/OCR requests. The SDKs
// set no request timeout of their own, so a reachable-but-stalled endpoint (a model reload stall, a
// proxy that holds the connection, a network black-hole) would hang forever — and because the
// socket message handler serializes per connection, a hung embed wedges every later message on that
// socket behind it. This test proves at runtime that a hanging embed degrades quickly to an empty
// result (a normal keyword-only miss) instead of hanging, and source-guards that the vision/OCR and
// embed sites all route through the shared bound so it can never drift.
//
// Run: `npm run test:unit` (or `node lib/test/unit/provider-timeout.test.js`).

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const embeddings = require(path.join(PROJECT, 'lib', 'embeddings'));
const read = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const savedTimeout = cfg.EMBED_TIMEOUT_MS;

// This test deliberately awaits promises whose only pending timer is raceTimeout's UNREF'd deadline.
// Without a ref'd handle, Node would judge the event loop idle and exit 0 mid-await — before any
// assertion ran — which would make the test pass vacuously. A ref'd interval keeps the loop alive
// until the assertions finish; it is cleared in finally.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  try {
    // ── The timeout knob exists and is floored ──
    ok(typeof cfg.EMBED_TIMEOUT_MS === 'number' && cfg.EMBED_TIMEOUT_MS >= 5000,
      `EMBED_TIMEOUT_MS is a number with a 5s floor (got ${cfg.EMBED_TIMEOUT_MS})`);

    // Override the live value the bound reads so the test is fast (embedBounded reads it per call).
    cfg.EMBED_TIMEOUT_MS = 60;

    const neverStore = { similaritySearchWithScore: () => new Promise(() => {}) };   // hangs forever

    // ── Single store: a hung embed degrades to [] quickly, it does NOT hang ──
    let start = Date.now();
    const res1 = await embeddings.denseSearch({ liveVectorStore: neverStore }, 'q', 5);
    ok(Array.isArray(res1) && res1.length === 0, 'a hung single-store embed degrades to an empty result');
    ok(Date.now() - start < 3000, 'the hung single-store embed returned promptly (did not hang the caller)');

    // ── Multiple banks: a hung bank is skipped, a healthy bank still contributes ──
    const goodDoc = { metadata: { source: '/doc.txt' }, pageContent: 'hello' };
    const goodStore = { similaritySearchWithScore: async () => [[goodDoc, 0.2]] };
    start = Date.now();
    const res2 = await embeddings.denseSearch({ vectorBanks: [{ store: neverStore }, { store: goodStore }] }, 'q', 5);
    ok(res2.length === 1 && res2[0][0] === goodDoc, 'a hung bank is skipped while a healthy bank still contributes');
    ok(Date.now() - start < 3000, 'the multi-bank path did not hang on the wedged bank');

    // ── embedBounded is exported and rejects a hung promise on the deadline ──
    ok(typeof embeddings.embedBounded === 'function', 'embedBounded is exported for reuse across embed sites');
    let rejected = false;
    await embeddings.embedBounded(new Promise(() => {})).catch(() => { rejected = true; });
    ok(rejected, 'embedBounded rejects a hung provider call rather than awaiting forever');

    console.log('✓ provider-timeout: embeddings degrade fast on a stalled provider (no hot-path hang)');

    // ── Source guards: the embed sites route through the shared bound ──
    const embSrc = read('lib/embeddings.js');
    ok(/const embedBounded = \(promise\) => raceTimeout\(promise, require\('\.\/config'\)\.EMBED_TIMEOUT_MS\)/.test(embSrc),
      'embedBounded races the live EMBED_TIMEOUT_MS (read at call time)');
    ok(/embedBounded\(store\.similaritySearchWithScore/.test(embSrc)
       && /embedBounded\(store\.similaritySearchVectorWithScore/.test(embSrc)
       && /embedBounded\(bank\.store\.similaritySearchVectorWithScore/.test(embSrc),
      'denseSearch bounds every similarity call — the own-embed path and the adapter-translated vector search');

    const searchSrc = read('lib/retrieval/search.js');
    ok(/embedBounded\(embedder\.embedQuery/.test(searchSrc) && /embedBounded\(embedder\.embedDocuments/.test(searchSrc),
      'ephemeralRetrieve bounds its query + document embeds');

    const apiCoreSrc = read('lib/api-core.js');
    ok(/embedBounded\(store\.similaritySearchWithScore/.test(apiCoreSrc),
      'the related-documents embed is bounded');

    // ── Source guards: the single-shot vision/OCR calls are bounded ──
    const visionSrc = read('lib/vision.js');
    // vision.ask bounds the call on LLM_TIMEOUT_MS AND cancels the underlying request on timeout (so a stalled
    // endpoint leaves no zombie request on the provider client): OpenAI via { signal }, Ollama via a per-call
    // client's abort(). Stronger than the old raceTimeout-only bound, which stopped waiting but not the request.
    ok(/setTimeout\(\(\) => \{[\s\S]*?ac\.abort\(\)[\s\S]*?ollamaClient\.abort\(\)[\s\S]*?\}, c\.LLM_TIMEOUT_MS\)/.test(visionSrc),
      'vision.ask arms an LLM_TIMEOUT_MS deadline that aborts the request (OpenAI signal + Ollama client)');
    ok(/create\(\{[\s\S]*?\}, \{ signal: ac\.signal \}\)/.test(visionSrc) && /llm\.makeOllamaClient\(c\)/.test(visionSrc),
      'vision.ask cancels BOTH the OpenAI (signal) and Ollama (per-call client) vision calls on timeout');

    const ocrSrc = read('lib/ocr.js');
    ok(/const bound = \(p\) => llm\.raceTimeout\(p, c\.LLM_TIMEOUT_MS\)/.test(ocrSrc), 'visionRecognize defines an idle bound');
    ok(/await bound\(client\.chat\.completions\.create\(/.test(ocrSrc) && /await bound\(client\.chat\(/.test(ocrSrc),
      'visionRecognize bounds BOTH the OpenAI and Ollama OCR calls');

    console.log('✓ provider-timeout: vision/OCR single-shot calls and every embed site route through an idle bound');

    // ── Source guards: warm-start defers "documents moved" to delta; delta holds vanished roots per-root ──
    const initSrc  = read('lib/indexing/init.js');
    const deltaSrc = read('lib/indexing/delta.js');

    // contentRebuildReason must NOT wipe the whole index on a "moved"/all-tracked-gone guess: that
    // wipe is global, so any single empty-mounted root would drop the entire corpus. It defers to the
    // delta pass (which reconciles per-root) instead, so the global moved-detection is gone from
    // warm start — including the old anyFilePresent/anyTrackedPathExists/existsSync probes.
    const rebuildFn = initSrc.slice(initSrc.indexOf('const contentRebuildReason'), initSrc.indexOf('const initIndex'));
    ok(!/return 'Indexed paths no longer exist/.test(rebuildFn), 'warm-start no longer returns a "documents moved" wipe reason');
    ok(!/anyFilePresent|anyTrackedPathExists|fsSync\.existsSync/.test(rebuildFn),
      'the global moved-detection probes are gone from warm start (delta reconciles per-root)');

    // The Settings-save source diagnostics must stat external source folders through the bounded async
    // helper, never a raw statSync: a source can be an offline/hung network mount, and a sync stat there
    // would freeze the event loop (and every concurrent query) until the OS times out.
    const refreshFn = initSrc.slice(initSrc.indexOf('SOURCE_PATHS.length > 0 && DEBUG'), initSrc.indexOf('SOURCE_PATHS.length > 0 && DEBUG') + 900);
    ok(/const st = await statWithTimeout\(s\.path\)/.test(refreshFn),
      'the source diagnostics use the bounded async statWithTimeout on external source paths');
    ok(!/fsSync\.statSync\(s\.path\)/.test(refreshFn),
      'the source diagnostics no longer statSync a possibly-hung network mount (no event-loop freeze)');

    // delta probes offline roots over the single-sourced indexedRoots set, then ALSO holds — per root
    // — any reachable root that still holds indexed docs but yielded zero indexable files this scan (an
    // empty-mounted/vanished share offlineRoots can't detect). Per-root so one vanished source among
    // several drops nothing; presence is judged from diskFiles (already filtered to indexable files),
    // so OS junk like a .DS_Store never counts as evidence.
    ok(/const roots = indexedRoots\(cfgPaths\.DOCS_DIR, SOURCE_PATHS\)/.test(deltaSrc) && /offlineRoots\(roots\)/.test(deltaSrc),
      'delta probes indexedRoots (DOCS_DIR included) for offline roots');
    ok(/const vanishedRoots = roots\.filter\(/.test(deltaSrc) && /rootHoldsTracked\(r\) && !rootHasDiskFile\(r\)/.test(deltaSrc),
      'delta holds a reachable-but-empty root that still holds indexed documents (per-root)');
    ok(/r !== cfgPaths\.DOCS_DIR/.test(deltaSrc),
      'the empty-mount hold excludes DOCS_DIR (co-located with the index; a genuine local deletion purges)');
    ok(/const heldRoots = \[\.\.\.offline, \.\.\.vanishedRoots, \.\.\.\(incompleteRoots/.test(deltaSrc),
      'vanished roots join offline and incomplete roots in the purge hold-back');
    ok(/const rootHasDiskFile\s+= \(root\) => diskFiles\.some/.test(deltaSrc),
      'presence is judged from the indexable-file scan (diskFiles), so OS junk never counts');

    // The boot L2-vs-cosine sanity probe embeds a query; bound it so an unreachable provider at boot
    // can't hang initIndex before indexReady (the catch skips the probe and keeps the loaded store).
    ok(/embedBounded\(state\.liveVectorStore\.similaritySearchWithScore/.test(initSrc),
      'the boot score-consistency probe is bounded');

    console.log('✓ provider-timeout: warm-start defers "moved" to delta, which holds vanished/empty-mounted roots per-root');

    // ── Source guards: the background indexer's embeds are bounded (a stalled provider can't hang a run) ──
    ok(/const embedBatchBounded = /.test(deltaSrc), 'delta defines a bounded batch embed');
    ok(/const vecs = await embedBatchBounded\(embeddings,/.test(deltaSrc), 'the batch embed path is bounded');
    ok(/const \[vec\] = await embedBounded\(embeddings\.embedDocuments/.test(deltaSrc), 'the one-by-one embed path is bounded');

    // The contextual-retrieval blurb call must carry the shared aux timeout, not fall back to the
    // 120s streamChat idle bound (which would stretch a per-chunk, per-document indexing loop).
    const contextSrc = read('lib/indexing/context.js');
    ok(/timeoutMs: AUX_LLM_TIMEOUT_MS/.test(contextSrc), 'the contextual-retrieval blurb call uses the shared aux timeout');

    console.log('✓ provider-timeout: indexing-path embeds and the contextual-retrieval call are all bounded');

    console.log(`\nALL PROVIDER-TIMEOUT UNIT TESTS PASSED (${checks} checks)`);
    // Set the code and return rather than process.exit(): in an async context with a piped stdout,
    // process.exit() can truncate the buffered log lines before they flush. Nothing keeps the event
    // loop alive here (the raceTimeout timers are unref'd; abandoned promises don't hold it), so the
    // process exits cleanly on its own with this code.
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ PROVIDER-TIMEOUT UNIT TEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    cfg.EMBED_TIMEOUT_MS = savedTimeout;
    clearInterval(keepAlive);
  }
})();
