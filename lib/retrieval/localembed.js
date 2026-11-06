'use strict';

// ── localembed — the bundled local embedder, run in a worker thread ─────────────────────────────────
//
// Manager for the zero-config local text-embedding model (localembedcore.js runs INSIDE the worker). Exposes an
// embeddings client ({ embedDocuments, embedQuery }) shaped EXACTLY like the Ollama/OpenAI clients, so
// makeEmbeddings can return it interchangeably and the rest of the pipeline (banks, indexing, search) is unaware
// which embedder produced a vector. All CPU work (tokenization + inference) runs in a WORKER THREAD, never on the
// event loop; the one-time ~110 MB model download reports live progress through the shared modelprogress
// aggregator (the same one the voice models use), so a first-run index build can show how far along it is
// instead of looking stuck. Best-effort and fully guarded — it never throws into the event loop and never blocks.
//
// Lifecycle mirrors the voice managers (tts.js/stt.js) so the three can't drift: the one-time download goes
// through warm() alone, on a generous budget with a stall watchdog, and an embed call never triggers a download
// under a short timeout (it reports the model is downloading and the caller DEFERS the file for a later retry).

const path = require('path');
const { WorkerRpc } = require('../workerrpc');
const { PROGRESS_FORWARDER_SRC, createDownloadManager } = require('../modeldownload');

const WORKER_HEAP_MB      = 1024;      // headroom for the model's buffers (ONNX allocates off the V8 heap)
const EMBED_TIMEOUT_MS    = 5 * 60 * 1000;   // a batch embed, once the model is present, is quick; generous so a big
                                             // batch on a slow CPU is never killed mid-inference (the index build's
                                             // own per-batch bound in delta.js is the effective wait).
const IDLE_RELEASE_MS     = 5 * 60 * 1000;   // free the model after this much idle; the next call re-spawns the worker
// The one-time model download goes through warm() alone (shared lib/modeldownload.js — a generous budget plus a
// stall watchdog), never an embed's short timeout which would kill the worker mid-download.

// The worker body: require the core, lazily load the model on first use, then answer init/embed requests —
// serialized so two overlapping requests never run inference on the one shared session at once. The shared
// progress forwarder (spliced below) posts throttled download-progress messages the supervisor routes to onMessage.
const WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  ${PROGRESS_FORWARDER_SRC}
  let inited = null;
  const ensure = () => (inited || (inited = core.init({ modelId: workerData.modelId, cacheDir: workerData.cacheDir, onProgress })));
  let chain = Promise.resolve();
  parentPort.on('message', (m) => {
    chain = chain.then(async () => {
      try {
        if (m.op === 'init')  { await ensure(); parentPort.postMessage({ id: m.id, ready: true }); return; }
        if (m.op === 'embed') {
          await ensure();
          const vectors = await core.embed({ texts: m.texts, isQuery: m.isQuery, modelId: workerData.modelId, cacheDir: workerData.cacheDir, onProgress });
          parentPort.postMessage({ id: m.id, ready: true, vectors });
          return;
        }
      } catch (e) {
        inited = null;   // let a later request retry init (the core enforces its own cooldown)
        parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) });
      }
    });
  });
`;

// Models cache under the data directory (resolved absolute), not node_modules — survives a reinstall, lives in a
// container's data volume, and works on a read-only app filesystem. Read live so a --data-dir override applies.
const modelCacheDir = () => require('./modelcache').modelsRoot(require('../config').DATA_DIR);

// The model id to load: whatever the live config resolves for the local provider, else the core's built-in
// default. Read live so a --data-dir or model override applies without re-requiring this module.
const resolvedModelId = () => {
  try {
    const cfg = require('../config');
    // Honor a configured model for the local provider ONLY when it looks like a model-host repo id (contains a
    // '/'), so a leftover Ollama/OpenAI model name (e.g. 'bge-m3') from a previously-selected provider can't be
    // handed to the local loader, which would fail. Anything else falls back to the bundled default.
    if (cfg.EMBEDDINGS_PROVIDER === 'local' && typeof cfg.EMBEDDINGS_MODEL === 'string' && cfg.EMBEDDINGS_MODEL.includes('/')) {
      return cfg.EMBEDDINGS_MODEL;
    }
  } catch (_) { /* fall through to the default */ }
  return require('./localembedcore').DEFAULT_MODEL_ID;
};

// Is local embedding possible on this install? @huggingface/transformers must be present (it is a core dep, so
// this is effectively always true, but guard anyway so a stripped build degrades instead of throwing).
let _availCache = null;
const isAvailable = () => {
  if (_availCache !== null) return _availCache;
  try { require.resolve('@huggingface/transformers'); _availCache = true; }
  catch { _availCache = false; }
  return _availCache;
};

// Has the model already been downloaded to the data directory? (So the index build can DEFER instead of trying to
// embed before the one-time download has landed.) Offline-first probe, cheap and safe.
const isModelDownloaded = () => {
  try { return require('./modelcache').isModelCached(modelCacheDir(), resolvedModelId()); }
  catch { return false; }
};

// The shared download lifecycle (same module the voice managers use, so the three can't drift): forwards +
// aggregates the worker's progress, warms on a generous budget with a stall watchdog, and exposes the progress /
// last-error probes the status + index-build notices read.
const _dl = createDownloadManager({
  label: 'the local embedding model',
  stalledReason: 'local embedding model download stalled',
  getRpc:  () => _getRpc(),
  onReady: () => _armIdle(),
});

let _rpc = null, _idleTimer = null;
const _getRpc = () => {
  if (_rpc) return _rpc;
  _rpc = new WorkerRpc({
    name: 'localembed',
    code: WORKER_CODE,
    workerData: () => ({ coreModulePath: path.join(__dirname, 'localembedcore.js'), modelId: resolvedModelId(), cacheDir: modelCacheDir() }),
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    timeoutMs: EMBED_TIMEOUT_MS,
    available: isAvailable,
    ..._dl.rpcHooks,   // onMessage feeds download progress to the shared aggregator; onReset clears it on worker drop
  });
  return _rpc;
};

// Release the resident model after an idle window; the next request re-spawns the worker. unref'd (never holds the
// process open), re-armed after each request settles, and DEFERS the release while a request is in flight — so a
// release can never reject an embed that is already running (identical to the voice managers).
const _armIdle = () => {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_rpc && _rpc.hasPending()) { _armIdle(); return; }
    try { if (_rpc) _rpc.shutdown('localembed idle'); } catch (_) {}
  }, IDLE_RELEASE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
};

// Pre-warm / download the model in the background. Delegates to the shared download manager (generous budget +
// stall watchdog + progress); the isAvailable guard keeps it a no-op where transformers isn't installed. Repeated
// calls share one in-flight preparation; on success the idle timer is armed (onReady).
const warm = () => isAvailable() ? _dl.warm() : Promise.resolve(false);
const isWarming = () => _dl.isWarming();
const downloadProgress = () => _dl.downloadProgress();
const lastDownloadError = () => _dl.lastDownloadError();

// Embed a batch of texts. `isQuery` selects the asymmetric prefix in the core. The one-time download belongs to
// warm() (long budget), never to an embed call whose timeout would kill the worker mid-download: when the model
// isn't present yet, start warm() and signal `providerDown` so the index build DEFERS these files for a later
// retry (never losing them) and search reports "still building" — exactly how a temporarily-down Ollama is
// handled. Returns number[][] aligned to the input order.
const _embed = async (texts, isQuery) => {
  if (!isAvailable()) throw Object.assign(new Error('local embedding is not available on this install'), { unavailable: true, providerDown: true });
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!isModelDownloaded()) {
    warm();
    throw Object.assign(new Error('local embedding model is still downloading'), { providerDown: true, downloading: true });
  }
  const reply = await _getRpc().request({ op: 'embed', texts, isQuery }, { timeoutMs: EMBED_TIMEOUT_MS });
  _armIdle();
  if (!reply || reply.error || !Array.isArray(reply.vectors) || reply.vectors.length !== texts.length) {
    throw Object.assign(new Error((reply && reply.error) || 'local embedding failed'), { providerDown: !!(reply && reply.error) });
  }
  return reply.vectors;
};

// The embeddings-client shape makeEmbeddings returns, identical to the LangChain clients. Documents use the
// passage prefix, a query uses the query prefix — the asymmetry the model was trained with.
const makeClient = () => ({
  embedDocuments: (texts) => _embed(Array.isArray(texts) ? texts : [], false),
  embedQuery:     async (text) => (await _embed([text == null ? '' : String(text)], true))[0],
});

// Warm the model at startup so the first index build / query is fast, and a one-time download can't surface as a
// mid-build failure. Fire-and-forget; never throws. Gated by the caller (only when the local provider is active).
const preload = async () => {
  if (!isAvailable()) return false;
  try {
    if (!isModelDownloaded()) console.log('🧠 Local embedder on — downloading the embedding model (~110 MB, one time)…');
    const ok = await warm();
    console.log(ok ? '🧠 Local embedding model ready.' : '⚠️  Local embedding model could not be prepared — it will be tried again on first use.');
    return ok;
  } catch { return false; }
};

// Stop the worker and cancel the idle timer — for the shutdown orchestrator, so nothing is left running.
const shutdown = () => {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  try { if (_rpc) _rpc.shutdown('localembed shutdown'); } catch (_) {}
};

module.exports = { makeClient, warm, isWarming, isAvailable, isModelDownloaded, downloadProgress, lastDownloadError, preload, shutdown, resolvedModelId };
