'use strict';
// ── modelprogress — one place that turns raw model-download events into a UI-ready snapshot ──────────────────
//
// Every optional local model (voice synthesis, voice input, and the rerankers) downloads once from the model
// host on first use via @huggingface/transformers, which emits a stream of per-file progress events while it
// fetches. This module aggregates those events — fired for several files, in any order, with only the bytes of
// the file currently in flight known at a time — into a single { pct, bytes, totalBytes } snapshot that a status
// route can hand straight to the client. Computing it in exactly one place keeps the "a model is downloading"
// experience identical across every feature and leaves the frontend nothing to recompute.
//
// It is pure, bounded (a handful of files, cleared on reset), language-agnostic (bytes and a percent — no
// localized text), and never throws: a malformed event is ignored, so a tracker can sit on a hot worker-message
// path without ever being able to crash it or leak memory.

// Bytes → whole megabytes (base-1024, matching how model sizes are quoted). Floor so a partial MB never reads as
// more than has arrived; the caller formats the unit so this stays number-only and locale-agnostic.
const toMB = (bytes) => Math.max(0, Math.floor((Number(bytes) || 0) / (1024 * 1024)));

// Create a download tracker. Options:
//   label  a short, already-localized noun for milestone logs (e.g. 'the voice model'); only used when `log` is set
//   log    optional (line) => void for occasional milestone lines (every 25%); omit to stay silent
// Returns { note, reset, snapshot, idleMs }. `note` is fed each raw progress event (from the worker); `snapshot`
// is read by the status route; `idleMs` lets a caller detect a stalled download without reaching into internals.
const createDownloadTracker = ({ label = 'the model', log = null } = {}) => {
  const files = new Map();   // file id -> { loaded, total } for every file seen this download
  let lastAdvanceAt = 0;     // epoch ms of the last forward progress, or 0 when nothing is downloading
  let loggedBucket = 0;      // highest 25% milestone already logged, so each is logged at most once

  // Overall snapshot across every file seen, or null when nothing has started. pct is 0..100 (floored, clamped).
  // Summing bytes across files means a small config/tokenizer file finishing first can briefly shrink the percent
  // when the large weights file then announces its full size — honest, and it only ever climbs from there.
  const snapshot = () => {
    if (files.size === 0) return null;
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
    if (total <= 0) return null;
    const pct = Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
    return { pct, bytes: loaded, totalBytes: total };
  };

  // Log one line when the download crosses the next 25% mark (25/50/75/100), never more than once each, so a long
  // download leaves a readable trail without flooding the log with per-chunk noise.
  const maybeLogMilestone = () => {
    if (!log) return;
    const s = snapshot();
    if (!s) return;
    const bucket = Math.floor(s.pct / 25) * 25;
    if (bucket > loggedBucket) {
      loggedBucket = bucket;
      // Only show the MB breakdown when it is meaningful (≥ 1 MB total). A model served mostly from an existing
      // cache reports only tiny metadata files, whose totals round to 0 MB — "(0 / 0 MB)" would read as broken.
      const detail = s.totalBytes >= 1024 * 1024 ? ` (${toMB(s.bytes)} / ${toMB(s.totalBytes)} MB)` : '';
      try { log(`⬇️  Downloading ${label}… ${s.pct}%${detail}`); } catch (_) { /* logging is best-effort */ }
    }
  };

  return {
    // Feed one raw transformers.js progress event. Guarded so it can never throw into the message handler.
    note(ev) {
      try {
        if (!ev) return;
        const file = ev.file || ev.name;
        if (!file) return;
        if (ev.status === 'progress' && Number(ev.total) > 0) {
          files.set(file, { loaded: Math.max(0, Number(ev.loaded) || 0), total: Number(ev.total) });
          lastAdvanceAt = Date.now();
          maybeLogMilestone();
        } else if (ev.status === 'done') {
          const prev = files.get(file);
          const total = (prev && prev.total) || Number(ev.total) || (prev && prev.loaded) || 0;
          if (total > 0) { files.set(file, { loaded: total, total }); lastAdvanceAt = Date.now(); maybeLogMilestone(); }
        }
      } catch (_) { /* a malformed event must never disturb the caller */ }
    },

    // Clear everything for a fresh download (e.g. before re-warming, or when the worker is released/replaced).
    reset() { files.clear(); lastAdvanceAt = 0; loggedBucket = 0; },

    snapshot,

    // Milliseconds since progress last advanced, or 0 when nothing is downloading. A stall watchdog uses this to
    // tell a slow-but-live download (keep waiting) from a wedged one (give up with a clear message).
    idleMs() { return lastAdvanceAt ? Date.now() - lastAdvanceAt : 0; },
  };
};

module.exports = { createDownloadTracker, toMB };
