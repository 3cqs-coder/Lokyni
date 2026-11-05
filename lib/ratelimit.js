'use strict';
// Per-API-key rate limiting.
//
// A sliding-window limiter keyed by API key id. In-memory only: this is a
// single-process local tool, so counters live in a Map and reset on restart —
// which is fine and standard (a restart clearing rate state can't be abused, it
// only ever grants MORE allowance, never less). No Redis, no persistence, no new
// dependency.
//
// Limit resolution per key, in order:
//   1. record.rateLimit  — explicit per-key requests-per-minute (if set)
//   2. DEFAULT_RPM       — the fallback for keys without one
// A limit of 0 means "unlimited" (explicitly opt out).
//
// The window is a rolling 60s: we keep each key's recent request timestamps and
// count how many fall within the last 60s. Cheap at single-user API scale.

const WINDOW_MS = 60_000;
const DEFAULT_RPM = 120;   // generous default; a local tool, not a public API
// Hard cap on the number of tracked keys, so the map can never grow without bound — a backstop in case this
// is ever called with many distinct ids over a long-lived process (today the only caller keys it by the small
// set of configured API keys, checked AFTER auth, so this never binds in practice). When exceeded, the
// oldest-inserted entry is dropped; resetting a key's window only ever grants MORE allowance, never less, so
// evicting one is safe.
const MAX_KEYS = 10_000;

// keyId → number[] of request timestamps (ms), oldest first.
const _hits = new Map();

// Resolve a key's requests-per-minute limit. 0 = unlimited.
const limitFor = (record) => {
  if (record && typeof record.rateLimit === 'number' && record.rateLimit >= 0) return record.rateLimit;
  return DEFAULT_RPM;
};

// Prune timestamps older than the window for one key.
const prune = (arr, now) => {
  const cutoff = now - WINDOW_MS;
  // Timestamps are appended in order, so drop from the front.
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  return i > 0 ? arr.slice(i) : arr;
};

// Check + record one request for a key. Returns:
//   { allowed: true,  remaining, limit, resetMs }
//   { allowed: false, remaining: 0, limit, resetMs }  (retry after resetMs)
// resetMs is when the oldest in-window hit expires (i.e. when capacity frees up).
const check = (record) => {
  const limit = limitFor(record);
  const now = Date.now();
  if (limit === 0) return { allowed: true, remaining: Infinity, limit: 0, resetMs: 0 };

  const id = record.id;
  // Enforce the key cap before tracking a brand-new id, so the map stays bounded.
  if (!_hits.has(id) && _hits.size >= MAX_KEYS) {
    const oldest = _hits.keys().next().value;   // Map preserves insertion order
    if (oldest !== undefined) _hits.delete(oldest);
  }
  let arr = _hits.get(id) || [];
  arr = prune(arr, now);
  // A re-checked key whose window has fully expired leaves no timestamps to keep; on the allowed path below
  // it is re-added, but drop the stale empty now so an idle-then-rechecked key doesn't hold an empty array.
  if (arr.length === 0) _hits.delete(id);

  if (arr.length >= limit) {
    _hits.set(id, arr);
    const resetMs = Math.max(0, (arr[0] + WINDOW_MS) - now);
    return { allowed: false, remaining: 0, limit, resetMs };
  }

  arr.push(now);
  _hits.set(id, arr);
  return { allowed: true, remaining: Math.max(0, limit - arr.length), limit, resetMs: WINDOW_MS };
};

module.exports = {
  check,
  // Test-only: observe the tracked-key count and the cap so the memory bound can be exercised.
  __test: { size: () => _hits.size, MAX_KEYS },
};
