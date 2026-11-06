'use strict';
// ── stt — local speech-to-text manager ──────────────────────────────────────────────────────────────────
//
// Runs the Whisper transcription core (sttcore.js) in a worker thread through the shared supervisor
// (workerrpc.js), so all of its CPU work — the one-time model load and every transcription — stays off the
// server's event loop and never blocks a request or the live status stream. Best-effort and fully guarded: if
// @huggingface/transformers or the model is unavailable, isAvailable() is false and callers simply skip voice
// input. The model is released after an idle window and re-spawned on demand, so it does not sit in memory
// between uses.
//
// Everything is fully local: the model (~75 MB) downloads once from Hugging Face and then runs offline; nothing
// is ever sent to a cloud service. There is no online default and no API key.

const path = require('path');
const { WorkerRpc } = require('../workerrpc');
const { PROGRESS_FORWARDER_SRC, createDownloadManager } = require('../modeldownload');

const WORKER_HEAP_MB      = 1024;      // headroom for the model's buffers (ONNX itself allocates off the V8 heap)
const TRANSCRIBE_TIMEOUT_MS = 180000;  // a transcription, once the model is present, takes a second or two — never a download
const IDLE_RELEASE_MS     = 120000;    // free the model after this much idle; the next call re-spawns the worker
// The one-time model download goes through warm() alone (shared lib/modeldownload.js — a generous budget plus a
// stall watchdog), never a transcription's short timeout which would kill the worker mid-download.

// Languages Whisper transcribes well, curated (not all ~99) to keep the Settings picker calm — the sane-defaults
// posture, mirroring the TTS voice catalog. Codes are Whisper language codes. Transcription keeps the speaker's
// own language (task 'transcribe', never 'translate'); the answer pipeline already handles a non-English question.
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
];
const DEFAULT_LANGUAGE = 'en';
const isValidLanguage = (c) => LANGUAGES.some((x) => x.code === c);

// The worker body: require the core by its real on-disk path and transcribe one request at a time (the model is a
// single session — serialize so two transcriptions never run on it at once). Posts { id, ready, text } or
// { id, error }. The PCM is structured-cloned in; the transcript cloned back is tiny.
const WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  ${PROGRESS_FORWARDER_SRC}
  let chain = Promise.resolve();
  parentPort.on('message', (m) => {
    chain = chain.then(async () => {
      try {
        if (m.op === 'transcribe') {
          const text = await core.transcribe({ pcm: m.pcm, language: m.language, cacheDir: workerData.cacheDir, onProgress });
          parentPort.postMessage({ id: m.id, ready: true, text });
          return;
        }
        if (m.op === 'init') { await core.init({ modelId: core.MODEL_ID, cacheDir: workerData.cacheDir, onProgress }); parentPort.postMessage({ id: m.id, ready: true }); return; }
      } catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
    });
  });
`;

// The shared download lifecycle (same module the voice-synthesis and local-embedder managers use, so the three
// can't drift): forwards + aggregates the worker's progress, warms on a generous budget with a stall watchdog,
// and exposes the progress / last-error probes the status route serves.
const _dl = createDownloadManager({
  label: 'the transcription model',
  stalledReason: 'transcription model download stalled',
  getRpc:  () => _getRpc(),
  onReady: () => _armIdle(),
});

// Models cache under the data directory (resolved absolute), not node_modules — survives a reinstall, lives in a
// container's data volume, and works on a read-only app filesystem. Read live so a --data-dir override applies.
const modelCacheDir = () => require('../retrieval/modelcache').modelsRoot(require('../config').DATA_DIR);

// Is local transcription even possible? @huggingface/transformers must be installed. No model load here (that is
// the worker's job on first use), so this is cheap and safe to call from a route.
let _availCache = null;
const isAvailable = () => {
  if (_availCache !== null) return _availCache;
  try { require.resolve('@huggingface/transformers'); _availCache = true; }
  catch { _availCache = false; }
  return _availCache;
};

let _rpc = null, _idleTimer = null;
const _getRpc = () => {
  if (_rpc) return _rpc;
  _rpc = new WorkerRpc({
    name: 'stt',
    code: WORKER_CODE,
    workerData: () => ({ coreModulePath: path.join(__dirname, 'sttcore.js'), cacheDir: modelCacheDir() }),
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    available: isAvailable,
    ..._dl.rpcHooks,   // onMessage feeds download progress to the shared aggregator; onReset clears it on worker drop
  });
  return _rpc;
};
// Release the resident model after an idle window; the next request re-spawns the worker. The timer is unref'd so
// it never holds the process open, is re-armed after each request settles, and DEFERS the release while a request
// is still in flight (re-arms instead of shutting down) so a release can never reject a transcription that is
// already running — important for a long ingestion segment that outlasts the idle window armed by a prior request.
const _armIdle = () => {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_rpc && _rpc.hasPending()) { _armIdle(); return; }   // busy — defer the release, don't kill in-flight work
    try { if (_rpc) _rpc.shutdown('stt idle'); } catch (_) {}
  }, IDLE_RELEASE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
};

// Transcribe 16 kHz mono Float32 PCM → the recognized text. Rejects when transcription is unavailable or fails,
// so the caller falls back to no transcript. Non-blocking (the work runs in the worker); bounded by the core.
const transcribe = async (pcm, { language = DEFAULT_LANGUAGE, timeoutMs } = {}) => {
  if (!isAvailable()) throw Object.assign(new Error('speech-to-text is not available on this install'), { unavailable: true });
  if (!(pcm instanceof Float32Array)) throw new Error('pcm must be a Float32Array');
  // The one-time download belongs to warm() (long budget + progress + stall watchdog), never to a transcription
  // whose short timeout would kill the worker mid-download. If the model isn't present yet, make sure warm is
  // running and tell the caller it is still downloading, so it degrades to no transcript and the UI shows progress.
  if (!isModelDownloaded()) { warm(); throw Object.assign(new Error('transcription model is still downloading'), { downloading: true }); }
  const lang = isValidLanguage(language) ? language : DEFAULT_LANGUAGE;
  // A longer per-request budget is allowed for ingestion (a multi-minute segment on a slow CPU) than the
  // push-to-talk default; the worker is still terminated if even that is blown (a genuinely wedged model).
  const opts = (typeof timeoutMs === 'number' && timeoutMs > 0) ? { timeoutMs } : undefined;
  const res = await _getRpc().request({ op: 'transcribe', pcm, language: lang }, opts);
  _armIdle();
  return (res && res.text) || '';
};

// Pre-warm: download (first time) and load the model in the background so the first transcription is fast and a
// one-time ~75 MB download can't surface as a mid-use failure. Best-effort; the download it does persists on disk.
// Delegates to the shared download manager (generous budget + stall watchdog + progress); the isAvailable guard
// keeps it a no-op where transformers isn't installed. Repeated calls share one in-flight preparation; on success
// the idle timer is armed (onReady), so the resident model is released after a while — the download persists.
const warm = () => isAvailable() ? _dl.warm() : Promise.resolve(false);
// Lets the status route report "preparing the voice model…" during the one-time ~75 MB Whisper download (parity
// with tts.isWarming), rather than starting a second load just to probe progress.
const isWarming = () => _dl.isWarming();

// For the status route: a live download snapshot ({ pct, bytes, totalBytes }) or null, and the last failure
// reason so the UI can say what went wrong instead of looping a vague "try again" (parity with tts).
const downloadProgress = () => _dl.downloadProgress();
const lastDownloadError = () => _dl.lastDownloadError();

// Has the transcription model already been downloaded to the data directory?
const isModelDownloaded = () => {
  try { return require('../retrieval/modelcache').isModelCached(modelCacheDir(), require('./sttcore').MODEL_ID); }
  catch { return false; }
};

// Stop the worker and cancel the idle timer — for the shutdown orchestrator, so nothing is left running.
const shutdown = () => {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  try { if (_rpc) _rpc.shutdown('stt shutdown'); } catch (_) {}
};

module.exports = { transcribe, warm, isWarming, downloadProgress, lastDownloadError, isAvailable, isModelDownloaded, shutdown, LANGUAGES, DEFAULT_LANGUAGE, isValidLanguage };
