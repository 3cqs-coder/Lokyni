'use strict';
// Guards the bundled, zero-setup LOCAL embedder: a small multilingual model run in-process so documents are
// always searchable with NO Ollama and NO API key. This test covers the WIRING and pure contracts only — it never
// downloads the model or spawns the worker (the end-to-end embed, including a cross-lingual match, is verified
// out of band). If any of this drifts, a fresh install silently falls back to a provider it may not have and the
// index can never build. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const R = (p) => require(path.join(PROJECT, 'lib', p));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const core   = R('retrieval/localembedcore');
  const mgr     = R('retrieval/localembed');
  const cfg      = R('config');
  const schema   = R('settings-schema');
  const { makeEmbeddings } = R('embeddings');

  // ── the model id is single-sourced: the schema default MUST match the core's built-in default (no drift) ──
  ok(schema.EMBEDDINGS_DEFAULTS.local === core.DEFAULT_MODEL_ID,
    `EMBEDDINGS_DEFAULTS.local (${schema.EMBEDDINGS_DEFAULTS.local}) matches localembedcore.DEFAULT_MODEL_ID`);
  ok(typeof core.DEFAULT_MODEL_ID === 'string' && core.DEFAULT_MODEL_ID.length > 0, 'the core names a concrete model id');
  ok(core.DIMENSION === 1024, 'the core declares its output dimension (bge-m3: 1024)');
  ok(core.MAX_INPUT_TOKENS >= 8192, 'the default model has a large token window (no chunk truncation at the default chunk size)');
  ok(core.QUERY_PREFIX !== core.PASSAGE_PREFIX, 'the E5 asymmetric query/passage prefixes differ (recall depends on this when an E5 model is selected)');

  // ── local is an embedding-capable provider, it is the zero-config DEFAULT, and it has no endpoint ──
  ok(cfg.PROVIDERS_WITH_EMBEDDINGS.includes('local'), "'local' is in the embedding-capable provider set");
  ok(schema.settingDefault('embeddingsProvider') === 'local', 'the bundled local embedder is the default embeddings provider');
  ok(cfg.embedBaseUrl(cfg, 'local', '') === '', 'the local embedder reports no base URL (stable bank fingerprint)');
  ok(schema.CLIENT_SETTINGS.embeddingProviders.some((p) => p.id === 'local'), 'the Settings picker lists the local provider');

  // ── makeEmbeddings returns a usable client for the local provider, with the standard shape, lazily (no worker) ──
  const client = makeEmbeddings({ provider: 'local' });
  ok(client && typeof client.embedDocuments === 'function' && typeof client.embedQuery === 'function',
    'makeEmbeddings({provider:"local"}) returns an { embedDocuments, embedQuery } client');

  // ── the manager exposes the same download-progress probes as the voice managers, clean before any use ──
  for (const fn of ['makeClient', 'warm', 'isWarming', 'isAvailable', 'isModelDownloaded', 'downloadProgress', 'lastDownloadError', 'preload', 'shutdown', 'resolvedModelId']) {
    ok(typeof mgr[fn] === 'function', `localembed exposes ${fn}()`);
  }
  ok(mgr.downloadProgress() === null && mgr.lastDownloadError() === null && mgr.isWarming() === false,
    'the manager starts clean (no progress, no error, not warming) and probing it loads nothing');
  ok(typeof mgr.resolvedModelId() === 'string' && mgr.resolvedModelId().length > 0, 'resolvedModelId() names the model to load');
  ok(typeof mgr.isModelDownloaded() === 'boolean', 'isModelDownloaded() is a cheap boolean probe (no model load)');

  // ── an empty batch is a no-op that returns [] WITHOUT touching the worker or the network (hermetic) ──
  (async () => {
    const empty = await mgr.makeClient().embedDocuments([]);
    ok(Array.isArray(empty) && empty.length === 0, 'embedDocuments([]) returns [] without spawning the worker');

    // ── source guards: the integration points that make the index build survive a still-downloading model ──
    const embSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'embeddings.js'), 'utf-8');
    ok(/provider === 'local'[\s\S]*require\('\.\/retrieval\/localembed'\)\.makeClient/.test(embSrc),
      'makeEmbeddings routes the local provider to the local embedder, wrapped in withUnitNorm');

    // Honesty-critical: pooling and the prefix are MODEL-SPECIFIC. BGE pools [CLS] (mean-pooling bge-m3 shifts the
    // score scale and breaks the out-of-corpus decline gate); E5 mean-pools with an asymmetric prefix. A retrieval
    // eval confirmed bge-m3 (CLS) keeps cross-lingual recall AND declines, where e5-small does not.
    const coreSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'localembedcore.js'), 'utf-8');
    ok(/\/bge\/i\.test\(String\(modelId\)\) \? 'cls' : 'mean'/.test(coreSrc),
      'pooling is model-aware: BGE pools [CLS], others mean-pool');
    ok(/\/e5\/i\.test\(String\(modelId\)\) \? \(isQuery \? QUERY_PREFIX : PASSAGE_PREFIX\) : ''/.test(coreSrc),
      'the asymmetric query/passage prefix is applied only to E5-family models');

    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    ok((deltaSrc.match(/e\._lokTimeout \|\| e\.providerDown \|\| e\.downloading/g) || []).length >= 2,
      'both the batch and the one-by-one embed paths DEFER (never skip) when the provider/model isn\'t ready');

    const socketSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
    ok(/const buildingIndexNotice = \(\)/.test(socketSrc) && /localembed/.test(socketSrc) && /downloadProgress/.test(socketSrc),
      'the "Building the document index" notice shows the embedding-model download progress');

    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
    ok(/EMBEDDINGS_PROVIDER === 'local'[\s\S]*localembed\.preload\(\)[\s\S]*reindexNow/.test(serverSrc),
      'boot pre-warms the local embedder and re-runs a delta once it is ready (deferred docs become searchable)');

    const bootSrc = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
    ok(/localembed'\)\.shutdown\(\)/.test(bootSrc), 'the local-embedder worker is shut down cleanly (never orphaned)');

    // ── the Settings copy states the embedder-vs-LLM distinction the user must understand ──
    const ejs = fs.readFileSync(path.join(PROJECT, 'lib', 'views', 'chat.ejs'), 'utf-8');
    ok(/built-in model that runs on this computer/i.test(ejs) && /you still need a language model/i.test(ejs),
      'Settings states documents are embedded locally AND that written answers still need a language model');

    console.log('✓ local-embedder: zero-config default, single-sourced model id, deferring index build, clear copy');
    console.log(`\nALL LOCAL-EMBEDDER UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  })().catch((e) => { console.error('\n✗ LOCAL-EMBEDDER UNIT TEST FAILED:', e && e.message); process.exit(1); });
} catch (e) {
  console.error('\n✗ LOCAL-EMBEDDER UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
