'use strict';

// ── modelload — the shared one-time Transformers.js model loader for the reranker and colbert cores ──
//
// Both cores load a model once, cache it for the process lifetime, dedup concurrent loads, and are
// offline-first. The ONLY part that differs is how the model object is built (a sequence-classification model
// vs a feature-extraction pipeline), which the caller supplies as a `load(transformers, modelId)` callback.
// Single-sourcing the lifecycle here means the post-failure cooldown, the in-flight dedup, the offline-first
// cache probe, and the remote-retry fallback can't drift between the two cores.
//
// No config dependency (the cores run inside a worker thread, which must not load the config module and its
// heavy deps), and no I/O beyond the one-time model load — so a core built on this runs identically inside a
// worker or inline.

// A load failure (e.g. a network blip during the one-time download) must not wedge a stage forever, but nor
// should every query retry a broken download. Cache the error and fail fast for a cooldown, then allow one
// more attempt.
const LOAD_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

// Cap each input string's character length before tokenizing. The tokenizer already truncates to the model's
// token window, but it ingests the WHOLE string first, so a pathologically large input wastes memory and CPU
// tokenizing text the model then discards. This sits comfortably past a 512-token window, so nothing the model
// would actually use is lost. Shared by both cores so the bound can't drift.
const MAX_INPUT_CHARS = 4000;

// onnxruntime session options for a MEMORY-CONSTRAINED machine. By default onnxruntime keeps a growing CPU memory
// arena (BFCArena) and a memory-pattern pool per session, which is fast but HOLDS memory — and several resident
// model sessions (embedder + reranker + voice) alongside a large chat model (Ollama) can then exhaust a small
// machine and the OS kills the process. On a low-RAM box we disable both so onnxruntime frees memory between runs
// (a modest speed cost, well worth not crashing); a roomy machine keeps the fast default. Returns a `session_options`
// object to spread into a pipeline/from_pretrained call, or {} to change nothing. Worker-safe (no config module).
// LOKYNI_FRUGAL_ORT forces it on (1) or off (0) for tests. Threshold leaves a typical 16 GB dev box unaffected.
const LOW_MEMORY_BYTES = 12 * 1024 * 1024 * 1024;
const frugalSessionOptions = () => {
  try {
    const env = process.env.LOKYNI_FRUGAL_ORT;
    const frugal = env === '1' ? true : env === '0' ? false : (require('os').totalmem() < LOW_MEMORY_BYTES);
    return frugal ? { session_options: { enableCpuMemArena: false, enableMemPattern: false } } : {};
  } catch { return {}; }
};

// Build a one-time, offline-first loader. `opts`:
//   isLoaded()               -> boolean: is the model object already in place? (skip reload)
//   load(transformers, modelId, onProgress) -> async: build and store the model object(s) from the resolved
//                            module; onProgress (may be undefined) is transformers' progress_callback to pass on
//   reset()                  -> clear the stored model object(s) (before a remote retry and on failure)
// Returns an async init({ modelId, cacheDir, onProgress }) that throws on failure (and during the cooldown) so
// the caller can fall back to the unranked order. Concurrent callers share one in-flight load.
const makeLoader = ({ isLoaded, load, reset }) => {
  let _loading = null, _loadError = null, _loadErrorAt = 0;

  return async function init({ modelId, cacheDir, onProgress }) {
    if (isLoaded()) return;
    if (_loadError && Date.now() - _loadErrorAt < LOAD_RETRY_COOLDOWN_MS) throw _loadError;
    if (_loading) return _loading;

    const pc = typeof onProgress === 'function' ? onProgress : undefined;
    _loading = (async () => {
      const transformers = await import('@huggingface/transformers');
      // Cache the model where the caller asks (under the data directory) instead of the default inside
      // node_modules — so it survives an npm reinstall, persists in a container's data volume, and works when
      // the app's own filesystem is read-only. No-op if the caller passes nothing.
      if (cacheDir) { try { transformers.env.cacheDir = cacheDir; } catch { /* fall back to the default */ } }
      // Offline-first, mirroring the OCR language data: when the model is already cached (or pre-seeded) under
      // the data directory, load it with NO network call, so a machine where it is present works even when the
      // model host is blocked. Detect that up front from the cache layout rather than probing with a failing
      // offline load — a failed offline attempt is slow AND can poison the on-disk cache so a following
      // download also fails. Only a missing model reaches the network, once, after which it is read locally
      // forever. A partial/corrupt cache falls back to a clean remote fetch.
      const cached = require('./modelcache').isModelCached(cacheDir, modelId);
      try { transformers.env.allowRemoteModels = !cached; await load(transformers, modelId, pc); }
      catch (_) { transformers.env.allowRemoteModels = true; reset(); await load(transformers, modelId, pc); }
    })();

    try { await _loading; _loadError = null; }
    catch (e) { _loadError = e; _loadErrorAt = Date.now(); reset(); throw e; }
    finally { _loading = null; }
  };
};

module.exports = { makeLoader, LOAD_RETRY_COOLDOWN_MS, MAX_INPUT_CHARS, frugalSessionOptions };
