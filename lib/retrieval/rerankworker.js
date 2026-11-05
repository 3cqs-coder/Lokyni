'use strict';
// Shared factory for the two late-stage reranking managers — the cross-encoder reranker (reranker.js) and the
// ColBERT late-interaction reranker (colbert.js). Both run their model in a worker thread through the shared
// supervisor (workerrpc.js), serialize requests so two never run inference on the one shared session at once,
// and are best-effort: any failure (worker down, model missing, timeout, degenerate output) returns the chunks
// in their incoming order, so reranking can sharpen results but never block, stall, or empty a result.
//
// The two managers differ only in a handful of parameters (worker name, which core runs inside the worker, the
// model id, the live on/off config key, the score field written onto each chunk, the score timeout, and an
// optional post-load self-test). Single-sourcing the lifecycle here means a fix to the worker body, the
// request/validate/sort path, or the preload/shutdown reaches both and they can't drift.

const path = require('path');
const { DEBUG } = require('../config');
const { WorkerRpc } = require('../workerrpc');

const INIT_TIMEOUT_MS = 120000;   // the first run may download the model
const WORKER_HEAP_MB  = 512;      // safety cap on the worker's V8 heap

// Where the models are cached: under the data directory (resolved to an absolute path) rather than
// Transformers.js's default inside node_modules, so a download survives an npm reinstall, sits in the one
// persistent volume in a container, and works when the app's own filesystem is read-only. Read live so a
// data-dir override applies. The models are install-global, so they live beside workspaces/ and sessions/.
const modelCacheDir = () => require('./modelcache').modelsRoot(require('../config').DATA_DIR);

// The worker body: require the model core by its real on-disk path, lazily initialize the model on the first
// message, then answer init/score requests — serialized so two overlapping requests never run inference
// concurrently on the one shared session (which would spike memory). Posts { id, ready } for init,
// { id, ready, scores } for scoring, or { id, error } on failure.
const WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  let inited = null;
  const ensure = () => (inited || (inited = core.init({ modelId: workerData.modelId, cacheDir: workerData.cacheDir })));
  let chain = Promise.resolve();
  parentPort.on('message', (m) => {
    chain = chain.then(async () => {
      try {
        if (m.op === 'init')  { await ensure(); parentPort.postMessage({ id: m.id, ready: true }); return; }
        if (m.op === 'score') { await ensure(); const scores = await core.score(m.query, m.texts); parentPort.postMessage({ id: m.id, ready: true, scores }); return; }
      } catch (e) {
        inited = null; // let a later request retry init (the core enforces its own cooldown)
        parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) });
      }
    });
  });
`;

// Build a reranking manager. opts:
//   name           worker name, used in logs/telemetry
//   coreModule     core filename beside this one ('rerankcore.js' | 'colbertcore.js')
//   modelId        the model to load (the caller applies any legacy-name mapping first)
//   availableKey   config key read LIVE for the on/off toggle (so a config reload takes effect)
//   scoreField     property written onto each scored chunk ('rerankerScore' | 'colbertScore')
//   scoreTimeoutMs per-score wait before falling back to the incoming order
//   readyLog       message logged once (DEBUG) when the worker first reports ready
//   activeLabel    label for the "active"/"unavailable" preload log line
//   selfTest       optional async (rerank) => boolean run after preload init; false ⇒ warn, don't claim active
// Returns { rerank, preload, shutdown }.
const makeRerankWorker = (opts) => {
  const { name, coreModule, modelId, availableKey, scoreField, scoreTimeoutMs, readyLog, activeLabel, selfTest } = opts;
  let _ready = false;

  const _rpc = new WorkerRpc({
    name,
    code:           WORKER_CODE,
    workerData:     () => ({ coreModulePath: path.join(__dirname, coreModule), modelId, cacheDir: modelCacheDir() }),
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    timeoutMs:      scoreTimeoutMs,
    available:      () => require('../config')[availableKey],   // live, so it can't disagree with search.js's live read after a config reload
    onMessage:      (m) => { if (m && m.ready && !_ready) { _ready = true; if (DEBUG) console.log(readyLog); } },
    onReset:        () => { _ready = false; },
  });

  // Score each (query, passage) pair and return the chunks sorted descending by score, each with scoreField
  // added. On ANY failure the chunks are returned unchanged (no scores), which downstream code tolerates.
  const rerank = async (query, chunks) => {
    if (!chunks || chunks.length === 0) return chunks;
    let scores;
    try {
      // If the worker isn't warmed (first use, or a respawn after a mid-session crash/timeout-terminate),
      // initialize the model under the LONG init budget FIRST. Otherwise a cold model (re)load piggybacks on the
      // score request and is killed by the short score timeout — which terminates the "hung" worker and, because
      // preload() only runs once at startup, wedges reranking into a permanent degrade loop (each respawn
      // restarts the load from zero). A redundant init on an already-warm worker is a cheap no-op (ensure() is
      // cached). _ready resets to false on a worker reset (onReset), so a later re-load is covered too.
      if (!_ready) {
        const initReply = await _rpc.request({ op: 'init' }, { timeoutMs: INIT_TIMEOUT_MS });
        if (initReply && initReply.ready) _ready = true;
      }
      const reply = await _rpc.request({ op: 'score', query, texts: chunks.map(c => c.text) }, { timeoutMs: scoreTimeoutMs });
      if (!reply || reply.error || !Array.isArray(reply.scores) || reply.scores.length !== chunks.length) {
        if (DEBUG && reply && reply.error) console.log(`  ⚠️  ${name} scoring failed: ${reply.error} — using incoming order`);
        return chunks;
      }
      scores = reply.scores;
      if (!_ready && reply.ready) _ready = true;
    } catch {
      return chunks;   // worker unavailable, in post-crash cooldown, timed out, or crashed mid-request
    }
    if (scores.some(s => !Number.isFinite(s))) {   // NaN OR ±Infinity — a degenerate score sorts meaninglessly
      if (DEBUG) console.log(`  ⚠️  ${name} produced non-finite scores — keeping incoming order`);
      return chunks;
    }
    const scored = chunks.map((chunk, i) => ({ ...chunk, [scoreField]: scores[i] }));
    scored.sort((a, b) => b[scoreField] - a[scoreField]);
    if (DEBUG) {
      console.log(`  🔀 ${name} scores:`);
      scored.slice(0, 5).forEach(c => console.log(`    ${Number(c[scoreField]).toFixed(4)}  ${c.docName || (c.id && c.id.slice(0, 8))}`));
    }
    return scored;
  };

  // Warm the worker's model at startup so the first real query is fast; optionally run a self-test so a broken
  // model is surfaced up front. Fire-and-forget; never throws.
  const preload = async () => {
    if (!require('../config')[availableKey]) return;
    try {
      await _rpc.request({ op: 'init' }, { timeoutMs: INIT_TIMEOUT_MS });
      const passed = typeof selfTest === 'function' ? await selfTest(rerank) : true;
      if (passed) require('../logbuffer').debug(`✅ ${activeLabel} (${modelId})`);
      else console.warn(`⚠️  ${activeLabel} loaded but self-test looked off — continuing anyway`);
    } catch (e) {
      // The model keeps trying to warm on the next query; until it does, retrieval uses the prior order.
      console.warn(`⚠️  ${activeLabel} unavailable — retrieval falls back${e && e.message ? `: ${e.message}` : ''}`);
    }
  };

  const shutdown = () => { try { _rpc.shutdown('shutdown'); } catch {} };

  return { rerank, preload, shutdown };
};

module.exports = { makeRerankWorker };
