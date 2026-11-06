'use strict';

// ── modeldownload — the shared one-time model-download lifecycle for every worker-run local model ───────────
//
// The voice synthesis (voice/tts.js), voice input (voice/stt.js), and local embedder (retrieval/localembed.js)
// managers each run a model in a worker thread that downloads once from the model host on first use. The DOWNLOAD
// half of that lifecycle is identical for all three: forward per-file progress out of the worker, aggregate it,
// warm on a generous budget with a stall watchdog, and expose { downloadProgress, lastDownloadError } for the
// status route. Single-sourcing it here means a fix to the watchdog, the throttle, or the progress contract
// reaches every model at once and the three managers can't drift. Pure plumbing — never blocks, never throws into
// the caller, and holds only a bounded tracker (see modelprogress.js).

const { createDownloadTracker } = require('./modelprogress');

// Worker-side source embedded into each manager's WORKER_CODE string. (A worker body is a string, so it can't
// `require` this module; it is spliced in after the worker's own `require('worker_threads')`.) Defines
// `onProgress`, a transformers `progress_callback` that forwards each event to the parent THROTTLED to one
// message per whole-percent-per-file — so a fast download can't flood the channel — as an id-less
// { progress:true, data } message the WorkerRpc supervisor routes to its onMessage hook. Guarded; never throws.
const PROGRESS_FORWARDER_SRC = `
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
`;

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;   // generous ceiling for a first-run download on a slow link
const DEFAULT_DOWNLOAD_STALL_MS   = 90 * 1000;        // no progress for this long mid-download ⇒ treat as wedged
const WATCHDOG_TICK_MS            = 15 * 1000;        // how often the stall watchdog checks for stalled progress

// Create the download/warm/progress half of a worker-run model manager. Params:
//   label          short, already-worded noun for milestone logs (e.g. 'the voice model')
//   stalledReason  the reason string the watchdog passes to rpc.shutdown() when a download wedges
//   getRpc()       returns the live WorkerRpc (a thunk, so the manager can define its rpc AFTER calling this)
//   onReady()      run after a successful warm (e.g. arm the idle-release timer); optional
//   log            milestone logger (default console.log, which is captured to the dated log + in-app viewer)
//   downloadTimeoutMs / stallMs   optional overrides of the defaults above
// Returns:
//   rpcHooks            { onMessage, onReset } to spread into the WorkerRpc options
//   warm()              share-one-in-flight download on the generous budget + stall watchdog; resolves true/false
//   isWarming()         boolean
//   downloadProgress()  { pct, bytes, totalBytes } while downloading, else null
//   lastDownloadError() 'stalled' | 'timeout' | a message | null — why the last warm failed
const createDownloadManager = ({ label, stalledReason, getRpc, onReady = null, log = console.log,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, stallMs = DEFAULT_DOWNLOAD_STALL_MS } = {}) => {
  const tracker = createDownloadTracker({ label, log });
  let warmPromise = null;
  let lastError = null;

  // Warm (download + load) the model in the background. The one-time download belongs here ALONE — never to a
  // synth/transcribe/embed whose short timeout would kill the worker mid-download and restart it from zero.
  const warm = () => {
    if (warmPromise) return warmPromise;
    tracker.reset();
    lastError = null;
    const rpc = getRpc();
    if (!rpc) return Promise.resolve(false);
    // Stall watchdog: once bytes are flowing, a long gap with no progress means a wedged download (a socket that
    // connected but then sent nothing). Drop the worker so the request rejects promptly with a clear reason rather
    // than hanging for the full ceiling. It never fires before the first byte (a slow connect keeps its budget) or
    // during the final in-memory model load (pct has reached 100, so there is nothing left to download).
    let stall = setInterval(() => {
      try {
        const s = tracker.snapshot();
        if (s && s.pct < 100 && tracker.idleMs() > stallMs) {
          lastError = 'stalled';
          rpc.shutdown(stalledReason);
        }
      } catch (_) { /* watchdog is best-effort */ }
    }, WATCHDOG_TICK_MS);
    if (stall.unref) stall.unref();
    const clearStall = () => { if (stall) { clearInterval(stall); stall = null; } };
    warmPromise = rpc.request({ op: 'init' }, { timeoutMs: downloadTimeoutMs })
      .then(() => { clearStall(); if (onReady) onReady(); return true; },
            (e) => { clearStall(); if (!lastError) lastError = (e && e.timeout) ? 'timeout' : ((e && e.message) || 'failed'); return false; })
      .finally(() => { warmPromise = null; });
    return warmPromise;
  };

  return {
    rpcHooks: {
      // Progress messages (no id) land here; feed them to the aggregator. Clear it when the worker is dropped
      // (idle release after a finished download, or a crash) so a stale snapshot never lingers.
      onMessage: (m) => { if (m && m.progress) tracker.note(m.data); },
      onReset:   () => tracker.reset(),
    },
    warm,
    isWarming: () => !!warmPromise,
    downloadProgress: () => { try { return tracker.snapshot(); } catch { return null; } },
    lastDownloadError: () => lastError,
  };
};

module.exports = { PROGRESS_FORWARDER_SRC, createDownloadManager, DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_STALL_MS };
