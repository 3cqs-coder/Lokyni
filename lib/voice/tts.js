'use strict';
// ── tts — local text-to-speech manager ──────────────────────────────────────────────────────────────────
//
// Runs the Kokoro synthesis core (ttscore.js) in a worker thread through the shared supervisor (workerrpc.js),
// so all of its CPU work — the one-time model load and every synthesis — stays off the server's event loop and
// never blocks a request or the live status stream. Best-effort and fully guarded: if the optional `phonemizer`
// package or the model is unavailable, isAvailable() is false and callers simply skip read-aloud. The large
// model is released after an idle window and re-spawned on demand, so it does not sit in memory between uses.
//
// Everything is fully local: the model (~90 MB) and voice packs download once from Hugging Face and then run
// offline; nothing is ever sent to a cloud service. There is no online default and no API key.

const path = require('path');
const { WorkerRpc } = require('../workerrpc');
const { createDownloadTracker } = require('../modelprogress');

const WORKER_HEAP_MB      = 1024;      // headroom for the model's buffers (ONNX itself allocates off the V8 heap)
const SYNTH_TIMEOUT_MS    = 180000;    // a synth, once the model is present, takes a few seconds — never a download
const IDLE_RELEASE_MS     = 120000;    // free the large model after this much idle; the next call re-spawns the worker
// The one-time model download goes through warm() alone, on its own generous budget — never a synth's — so a slow
// link can finish instead of a short synth timeout killing the worker mid-download and restarting from zero. The
// stall watchdog then distinguishes a slow-but-live download (keep waiting) from a wedged one (fail with a reason).
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;  // hard ceiling for the first-run download; generous for a slow network
const DOWNLOAD_STALL_MS   = 90 * 1000;       // bytes stopped flowing for this long mid-download ⇒ treat as wedged

// A curated set of voices (Kokoro's highest-graded, with a male and British option), kept short per the
// sane-defaults posture. ids are `<accent><gender>_<name>`: a=American, b=British; f=female, m=male.
const VOICES = [
  { id: 'af_heart',   label: 'Heart (US, female)' },
  { id: 'af_bella',   label: 'Bella (US, female)' },
  { id: 'af_nicole',  label: 'Nicole (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir',  label: 'Fenrir (US, male)' },
  { id: 'bf_emma',    label: 'Emma (UK, female)' },
  { id: 'bm_george',  label: 'George (UK, male)' },
];
// The default voices are single-sourced from the settings schema (the one place ttsVoice / podcastVoiceB are
// defined and projected to both the frontend and config), so an engine fallback can never drift from the
// configured default. config.js — already loaded here — pulls in the schema, so this adds no new import cost.
const _SCHEMA = require('../settings-schema').SETTINGS;
const DEFAULT_VOICE   = _SCHEMA.ttsVoice.default;        // the read-aloud default (e.g. af_heart)
const DEFAULT_VOICE_A = _SCHEMA.podcastVoiceA.default;   // the podcast FIRST-host default (e.g. af_heart)
const DEFAULT_VOICE_B = _SCHEMA.podcastVoiceB.default;   // the podcast second-host default (e.g. am_michael)
const isValidVoice = (v) => VOICES.some((x) => x.id === v);

// The worker body: require the core by its real on-disk path and synthesize one request at a time (the model is
// a single session — serialize so two syntheses never run on it at once). Posts { id, ready, wav, sampleRate }
// or { id, error }. The WAV bytes are cloned back to the parent (small — a short answer is well under a MB).
const WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  // Forward download progress to the parent, throttled to one message per whole-percent-per-file so a fast
  // download can't flood the channel (transformers fires its callback on every fetched chunk). The map is bounded
  // by the handful of files a model has. Progress messages carry no id, so the supervisor routes them to its
  // onMessage hook rather than any pending request.
  const _lastPct = new Map();
  const onProgress = (p) => {
    try {
      if (!p) return;
      const file = p.file || p.name || '';
      if (p.status === 'progress') {
        const pct = (p.total > 0) ? Math.floor((p.loaded / p.total) * 100) : -1;
        if (file && _lastPct.get(file) === pct) return;
        _lastPct.set(file, pct);
      } else if (p.status === 'done') {
        if (_lastPct.get(file) === 100) return;
        _lastPct.set(file, 100);
      } else { return; }  // ignore initiate/download/ready chatter — only progress/done carry byte counts
      parentPort.postMessage({ progress: true, data: { status: p.status, file, loaded: p.loaded, total: p.total } });
    } catch (_) { /* progress is best-effort — never disturb the work */ }
  };
  let chain = Promise.resolve();
  parentPort.on('message', (m) => {
    chain = chain.then(async () => {
      try {
        if (m.op === 'synth') {
          const { wav, sampleRate } = await core.synthesize({ text: m.text, voice: m.voice, speed: m.speed, cacheDir: workerData.cacheDir, onProgress });
          parentPort.postMessage({ id: m.id, ready: true, wav: new Uint8Array(wav), sampleRate });
          return;
        }
        if (m.op === 'init') { await core.init({ cacheDir: workerData.cacheDir, onProgress }); parentPort.postMessage({ id: m.id, ready: true }); return; }
      } catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
    });
  });
`;

// One aggregator turns the worker's raw progress messages into a { pct, bytes, totalBytes } snapshot the status
// route serves, and logs a milestone line every 25% (console is captured to the dated log + in-app viewer).
const _download = createDownloadTracker({ label: 'the voice model', log: console.log });
let _lastDownloadError = null;   // reason the last warm failed ('stalled' | 'timeout' | a message), for the UI

// Models cache under the data directory (resolved absolute), not node_modules — survives a reinstall, lives in a
// container's data volume, and works on a read-only app filesystem. Read live so a --data-dir override applies.
const modelCacheDir = () => require('../retrieval/modelcache').modelsRoot(require('../config').DATA_DIR);

// Is local synthesis even possible? The optional phonemizer package and transformers must both be installed. No
// model load here (that is the worker's job on first use), so this is cheap and safe to call from a route.
let _availCache = null;
const isAvailable = () => {
  if (_availCache !== null) return _availCache;
  try { require.resolve('phonemizer'); require.resolve('@huggingface/transformers'); _availCache = true; }
  catch { _availCache = false; }
  return _availCache;
};

let _rpc = null, _idleTimer = null;
const _getRpc = () => {
  if (_rpc) return _rpc;
  _rpc = new WorkerRpc({
    name: 'tts',
    code: WORKER_CODE,
    workerData: () => ({ coreModulePath: path.join(__dirname, 'ttscore.js'), cacheDir: modelCacheDir() }),
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    timeoutMs: SYNTH_TIMEOUT_MS,
    available: isAvailable,
    // Progress messages (no id) land here; feed them to the aggregator. Clear it when the worker is dropped
    // (idle release after a finished download, or a crash) so a stale snapshot never lingers.
    onMessage: (m) => { if (m && m.progress) _download.note(m.data); },
    onReset:   () => _download.reset(),
  });
  return _rpc;
};
// Release the resident model after an idle window (it is large); the next request re-spawns the worker. The
// timer is unref'd so it never holds the process open, is re-armed after each request settles, and — crucially —
// DEFERS the release while a request is still in flight (re-arms instead of shutting down), so a release can
// never reject a synthesis that is already running (which a bare "re-arm only after completion" timer could, when
// a new request started inside the previous request's idle window).
const _armIdle = () => {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_rpc && _rpc.hasPending()) { _armIdle(); return; }   // busy — defer the release, don't kill in-flight work
    try { if (_rpc) _rpc.shutdown('tts idle'); } catch (_) {}
  }, IDLE_RELEASE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
};

// Synthesize text → { wav: Buffer (WAV), sampleRate }. Rejects when synthesis is unavailable or fails, so the
// caller falls back to no audio. Non-blocking (the work runs in the worker); bounded by the core's caps.
const synthesize = async (text, { voice = DEFAULT_VOICE, speed = 1 } = {}) => {
  if (!isAvailable()) throw Object.assign(new Error('voice synthesis is not available on this install'), { unavailable: true });
  // The one-time download belongs to warm() (long budget + progress + stall watchdog), never to a synth whose
  // short timeout would kill the worker mid-download. If the model isn't present yet, make sure warm is running
  // and tell the caller it is still downloading, so it degrades to no audio and the UI shows real progress.
  if (!isModelDownloaded()) { warm(); throw Object.assign(new Error('voice model is still downloading'), { downloading: true }); }
  const v = isValidVoice(voice) ? voice : DEFAULT_VOICE;
  const res = await _getRpc().request({ op: 'synth', text, voice: v, speed });
  _armIdle();
  return { wav: Buffer.from(res.wav), sampleRate: res.sampleRate };
};

// Pre-warm: download (first time) and load the model in the background, so the first read-aloud is fast and a
// one-time ~90 MB download can't surface as a mid-answer failure. Best-effort — a failure just means the model
// loads on first real use instead. Repeated calls share one in-flight preparation, and `isWarming()` lets the
// status route report progress without starting another load. The idle timer is armed so the warmed model is
// released after a while; the download it did persists on disk regardless, which is the real win.
let _warmPromise = null;
const warm = () => {
  if (!isAvailable()) return Promise.resolve(false);
  if (_warmPromise) return _warmPromise;
  _download.reset();
  _lastDownloadError = null;
  const rpc = _getRpc();
  // Stall watchdog: once bytes are flowing, a long gap with no progress means a wedged download (a socket that
  // connected but then sent nothing). Drop the worker so the request rejects promptly with a clear reason rather
  // than hanging for the full ceiling. It never fires before the first byte (a slow connect keeps its budget) or
  // during the final in-memory model load (pct has reached 100, so there is nothing left to download).
  let stall = setInterval(() => {
    try {
      const s = _download.snapshot();
      if (s && s.pct < 100 && _download.idleMs() > DOWNLOAD_STALL_MS) {
        _lastDownloadError = 'stalled';
        rpc.shutdown('voice model download stalled');
      }
    } catch (_) { /* watchdog is best-effort */ }
  }, 15000);
  if (stall.unref) stall.unref();
  const clearStall = () => { if (stall) { clearInterval(stall); stall = null; } };
  _warmPromise = rpc.request({ op: 'init' }, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    .then(() => { clearStall(); _armIdle(); return true; },
          (e) => { clearStall(); if (!_lastDownloadError) _lastDownloadError = (e && e.timeout) ? 'timeout' : ((e && e.message) || 'failed'); return false; })
    .finally(() => { _warmPromise = null; });
  return _warmPromise;
};
const isWarming = () => !!_warmPromise;

// For the status route: a live download snapshot ({ pct, bytes, totalBytes }) or null, and the last failure
// reason so the UI can say what went wrong instead of looping a vague "try again".
const downloadProgress = () => { try { return _download.snapshot(); } catch { return null; } };
const lastDownloadError = () => _lastDownloadError;

// Has the voice model already been downloaded to the data directory? (So the UI/status can say whether the first
// use will need a one-time download.) Offline-first probe, cheap and safe.
const isModelDownloaded = () => {
  try { return require('../retrieval/modelcache').isModelCached(modelCacheDir(), require('./ttscore').MODEL_ID); }
  catch { return false; }
};

// Stop the worker and cancel the idle timer — for the shutdown orchestrator, so nothing is left running.
const shutdown = () => {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  try { if (_rpc) _rpc.shutdown('tts shutdown'); } catch (_) {}
};

module.exports = { synthesize, warm, isWarming, downloadProgress, lastDownloadError, isAvailable, isModelDownloaded, shutdown, VOICES, DEFAULT_VOICE, DEFAULT_VOICE_A, DEFAULT_VOICE_B, isValidVoice };
