'use strict';
// Automatic per-model context-window (num_ctx) sizing.
//
// A single fixed context window is wrong for every model. Too small silently TRUNCATES the grounding prompt
// — the worst hidden hit to answer quality, because the model drops the system rules or the retrieved
// passages without any error. Too large wastes key/value-cache memory and slows generation. When the
// operator leaves the context window on "automatic" (0), the effective value is resolved FROM THE SELECTED
// MODEL: its real trained context window (read from the local model host), capped for memory safety, with a
// name-based estimate as the fallback when the real window cannot be read. An explicit positive setting
// always wins, so anyone who tuned it by hand keeps their value.
//
// This module is pure and synchronous — it never does I/O (the network probe lives in the LLM client, which
// owns the host connection) — so it is trivially testable and cannot block or throw on the hot path.

// A reasonable ceiling for an auto-resolved window. It bounds the key/value-cache memory on a modest machine
// (a 3B model can advertise a 128k window it cannot hold on a laptop), and keeps a huge advertised window
// from being requested wholesale. Anyone who genuinely wants more sets an explicit numCtx, which bypasses the
// cap entirely. Chosen to match the long-standing shipped default so auto is never a downgrade for a typical
// model, and is a safe upper bound across platforms.
const CONTEXT_CEILING = 32768;
// Never resolve below this: even a tiny model needs room for the grounding rules plus a passage or two.
const MIN_CONTEXT = 2048;

// Parse a parameter count, in billions, from a model name — e.g. "qwen2.5:14b-instruct-q4_K_M" -> 14. The
// trailing quantization tag is dropped first so its digits are not misread as a size. Returns null when the
// name carries no size hint (callers then use a safe mid estimate).
const paramCountB = (name) => {
  const s = String(name || '').toLowerCase().replace(/q\d[_a-z0-9]*$/i, '');
  const m = /(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

// Name-based estimate, used only when the model's real window cannot be read (host offline, or a provider
// that does not report it). Gives bigger models more room without being reckless; always within the ceiling.
const heuristicContextTokens = (name) => {
  const b = paramCountB(name);
  if (b == null) return 8192;   // unknown size: a safe middle
  if (b < 4)  return 8192;
  if (b < 20) return 16384;
  return CONTEXT_CEILING;
};

// Pull the model's trained context window out of a local model host's "show" response. The field is
// architecture-prefixed (for example "llama.context_length", "qwen2.context_length"), so match by suffix
// rather than a fixed key. Returns a positive number, or null when the block does not carry it.
const contextLengthFromInfo = (modelInfo) => {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  for (const k of Object.keys(modelInfo)) {
    if (/\.context_length$/.test(k)) {
      const v = Number(modelInfo[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
};

// Resolve the effective num_ctx. `explicit` is the operator's configured value (0 / absent = automatic);
// `realWindow` is the model's trained window when it could be read, else null; `model` is the model name
// for the fallback estimate. An explicit positive value is used as-is (never capped — a hand-tuned value is
// intentional). Otherwise use the real window, or the name estimate when it is unknown, bounded to
// [MIN_CONTEXT, CONTEXT_CEILING]. Always returns a positive integer, so every caller can use it directly.
const resolveNumCtx = ({ explicit, realWindow, model }) => {
  const e = Number(explicit);
  if (Number.isFinite(e) && e > 0) return Math.round(e);
  const base = (Number.isFinite(Number(realWindow)) && Number(realWindow) > 0)
    ? Number(realWindow)
    : heuristicContextTokens(model);
  return Math.max(MIN_CONTEXT, Math.min(Math.round(base), CONTEXT_CEILING));
};

module.exports = {
  CONTEXT_CEILING, MIN_CONTEXT,
  paramCountB, heuristicContextTokens, contextLengthFromInfo, resolveNumCtx,
};
