'use strict';
// Optional OUTBOUND (egress) proxy for Lokyni's web access — web search, result-page fetching, and headless
// URL ingestion. Off by default, preserving the local-first posture. Reasons to turn it on:
//   • Reachability — a network that requires all outbound HTTP to go through a proxy; without this, web
//     search and URL ingestion fail there.
//   • Rate limits / blocks — routing through one or more proxies avoids tying every request to one IP.
//
// A POOL of one or more proxies is supported, with automatic round-robin ROTATION across them: each request
// (and each headless launch) uses the next proxy in turn, so load and exit IPs spread across the pool and no
// single address is hammered. One proxy means no rotation; rotation can also be turned off to pin to the
// first. The pool comes from the `webProxyUrl` setting (one per line, or comma/space separated) or — when
// unset — the standard HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables. Empty means direct.
//
// Supported schemes: http:// and https:// (the near-universal corporate case) for every path; a bare
// "host:port" is treated as http://host:port. A socks:// entry applies to URL ingestion (Chromium handles
// it) but not the plain-fetch paths (those connect directly for it and warn once).
//
// Security note: an egress proxy is REMOTE, so it cannot reach THIS machine's own localhost or private
// network — routing through it neutralizes the local SSRF surface the direct path guards with IP pinning.
// The proxy can reach ITS network; configuring one is an explicit decision to trust it. Lazy, cached, and
// never throws.

// Normalize a proxy address to a full URL. A bare "host:port" (or "user:pass@host:port") gets an http://
// scheme — the conventional default — so the agent constructors don't choke on it. A value already carrying
// a scheme is returned trimmed and unchanged. '' for empty input.
const normalizeProxyUrl = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
};

// Parse a pool from a raw string: split on newlines, commas, or whitespace; normalize; drop blanks and
// duplicates (keeping order). A single URL yields a one-entry pool. Capped at MAX_POOL so a pathological
// setting (thousands of lines) can't bloat the per-URL agent cache or the per-call parse cost — a rotating
// pool only ever needs a handful.
const MAX_POOL = 64;
const parsePool = (raw) => {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(/[\s,]+/)) {
    const u = normalizeProxyUrl(part);
    if (u && !seen.has(u)) { seen.add(u); out.push(u); if (out.length >= MAX_POOL) break; }
  }
  return out;
};

// The configured proxy pool: the `webProxyUrl` setting if set, else the conventional environment variables.
// Read live each call (cheap) so a Settings change applies without a restart. [] = direct connections.
const getWebProxyUrls = () => {
  let raw = '';
  try { raw = String(require('./config').WEB_PROXY_URL || ''); } catch { /* config not ready */ }
  if (!raw.trim()) {
    const env = process.env;
    raw = String(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '');
  }
  return parsePool(raw);
};

// Back-compat / "is any proxy configured": the first proxy in the pool, or '' for none.
const getWebProxyUrl = () => getWebProxyUrls()[0] || '';

// Whether rotation is on. OPT-IN: off by default, so a configured pool uses its first proxy until the
// operator turns rotation on. With a single proxy it is moot either way.
const _rotateOn = () => { try { return require('./config').WEB_PROXY_ROTATE === true; } catch { return false; } };

// How many times to retry a BLOCKED/failed request through a DIFFERENT proxy. Tunable (0 = no retry). Proxies
// get rate-limited or blocked, so a retry walks to the next proxy in the pool and tries again.
const getProxyRetries = () => { try { const n = Number(require('./config').WEB_PROXY_RETRIES); return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 10) : 0; } catch { return 0; } };

// Strict no-leak mode. OPT-IN: when on, a request for which a proxy IS configured but no usable proxy
// dispatcher can be built (a bad URL, or a SOCKS proxy that failed to initialize) FAILS rather than
// falling back to a direct connection that would expose the real IP. Off by default, preserving the
// current behavior where such a request degrades to direct.
const _strictOn = () => { try { return require('./config').WEB_PROXY_STRICT === true; } catch { return false; } };

// ── Per-exit health ────────────────────────────────────────────────────────────────────────────────
// Track each proxy exit's recent outcomes so a flaky or dead exit is rested instead of hammered, while a
// healthy one that merely hit a site's rate limit is NOT penalized. The key distinction:
//   • "dead"    — the tunnel/connect itself failed or timed out: the EXIT is down. Consecutive deads
//                 accrue toward a cooldown (exponential backoff), during which selection skips the exit.
//   • "blocked" — the tunnel worked but the TARGET refused (HTTP 403/429/503): the exit is fine, the site
//                 said no. This clears the dead streak (the exit is reachable) and never cools it.
//   • "ok"      — a usable response: clears the dead streak.
// Selection prefers non-cooled exits but NEVER starves — if every exit is cooled, the full pool is used
// (a cooldown then becomes a half-open trial). Bounded in size, read-live-config-free, and never throws.
const DEAD_TO_COOLDOWN = 3;            // consecutive dead outcomes before an exit is cooled
const COOLDOWN_BASE_MS = 30 * 1000;    // first cooldown; doubles with each further dead, capped below
const COOLDOWN_MAX_MS  = 10 * 60 * 1000;
const MAX_EXITS        = 2000;         // bound the map so a huge rotating pool can't grow it without limit
const _exitHealth = new Map();         // normalizedUrl → { dead, cooledUntil }
const _isCooled = (url, now) => { const e = _exitHealth.get(url); return !!(e && e.cooledUntil > now); };
// Record one attempt's outcome for an exit. outcome ∈ 'ok' | 'blocked' | 'dead'. Best-effort; never throws.
const recordExit = (url, outcome) => {
  try {
    const key = normalizeProxyUrl(url);
    if (!key) return;
    let e = _exitHealth.get(key);
    if (!e) {
      if (_exitHealth.size >= MAX_EXITS) { const oldest = _exitHealth.keys().next().value; if (oldest !== undefined) _exitHealth.delete(oldest); }
      e = { dead: 0, cooledUntil: 0 };
      _exitHealth.set(key, e);
    }
    if (outcome === 'dead') {
      e.dead += 1;
      if (e.dead >= DEAD_TO_COOLDOWN) {
        const over = e.dead - DEAD_TO_COOLDOWN;   // 0 on the first cooldown, then grows
        e.cooledUntil = Date.now() + Math.min(COOLDOWN_BASE_MS * Math.pow(2, over), COOLDOWN_MAX_MS);
      }
    } else {
      // Any response — even a block — proves the exit is reachable, so the dead streak and cooldown clear.
      e.dead = 0;
      e.cooledUntil = 0;
    }
  } catch { /* health tracking must never break a request */ }
};
// A masked snapshot (credentials stripped) worst-first, for diagnostics / a future watchdog. Never throws.
const exitHealthSnapshot = () => {
  const now = Date.now();
  const out = [];
  for (const [url, e] of _exitHealth) {
    let masked = url;
    try { const u = new URL(url); if (u.username || u.password) { u.username = ''; u.password = ''; masked = u.toString(); } } catch { /* keep as-is */ }
    out.push({ exit: masked, dead: e.dead, cooledMsRemaining: Math.max(0, e.cooledUntil - now) });
  }
  return out.sort((a, b) => (b.cooledMsRemaining - a.cooledMsRemaining) || (b.dead - a.dead));
};

// The round-robin cursor, advanced once per fresh (logical) request when rotation is on.
let _rr = 0;
// A per-request proxy PICKER. It captures its OWN base index at creation, so concurrent requests never share
// cursor state: a retry always advances from the proxy this request started on, never one another request
// moved the cursor to. pick(attempt) returns the proxy URL for that attempt — attempt 0 is the base (rotating
// when rotation is on, else the pool's first); each further attempt advances to the NEXT proxy, regardless of
// the rotation setting, because the whole point of a retry is to try a different exit when one is blocked.
const makePicker = () => {
  const pool = getWebProxyUrls();
  // Prefer exits that are not in cooldown; if every exit is cooled, fall back to the whole pool so a dead
  // pool still gets a half-open retry rather than starving (returning no proxy, which would leak direct).
  const now = Date.now();
  const healthy = pool.filter(u => !_isCooled(u, now));
  const list = healthy.length ? healthy : pool;
  let base = 0;
  if (list.length > 1 && _rotateOn()) { base = _rr % list.length; _rr = (_rr + 1) % list.length; }
  return (attempt = 0) => (list.length ? list[(base + attempt) % list.length] : '');
};
// A single rotating pick — used where there is no retry loop (kept for callers that want one URL).
const nextProxyUrl = () => makePicker()(0);

// Per-URL undici ProxyAgent cache (a pool needs one agent per proxy, not a single slot). Rebuilt/closed when
// the configured pool changes, so a Settings edit can't leak sockets. Keyed by URL; value may be null (a bad
// URL or SOCKS → direct for the fetch path).
const _agents = new Map();
let _poolSig = '';
let _warnedSocks = false;
const _syncAgents = () => {
  const sig = getWebProxyUrls().join('|');
  if (sig === _poolSig) return;
  for (const a of _agents.values()) {
    // close() is async and GRACEFUL (drains in-flight requests). Swallow both a synchronous throw and a
    // rejected promise so a failing close can never surface as an unhandledRejection.
    try { const p = a && a.close && a.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* best-effort */ }
  }
  _agents.clear();
  _exitHealth.clear();   // a reconfigured pool starts with a clean health slate — old exits may be gone
  _poolSig = sig;
};
const _dispatcherFor = (url) => {
  if (!url) return null;
  if (_agents.has(url)) return _agents.get(url);
  let agent = null;
  if (/^socks/i.test(url)) {
    // SOCKS now works on the fetch paths too, via a custom undici connector (undici's own ProxyAgent is
    // HTTP-CONNECT only). A build failure leaves agent null; the warn fires once, and strict mode (below)
    // then fails the request closed rather than leaking a direct connection.
    agent = require('./socksdispatcher').makeSocksAgent(url);
    if (!agent && !_warnedSocks) { _warnedSocks = true; console.warn('⚠️  A SOCKS proxy is configured but could not be initialized for the fetch path.'); }
  } else {
    try { agent = new (require('undici').ProxyAgent)(url); } catch { agent = null; }  // bad URL → null (strict fails closed; otherwise direct)
  }
  _agents.set(url, agent);
  return agent;
};

// Run one network attempt through the proxy pool with automatic retry-on-block. `attempt(dispatcher)` does a
// single try with the given undici dispatcher (null = direct). When a pool is configured, it runs up to
// getProxyRetries()+1 times, advancing to the NEXT proxy each time the attempt THROWS or returns a result
// that `isBlocked(result)` flags (e.g. an HTTP 403/429/503). With no proxy configured it runs exactly once
// with a null dispatcher — identical to the direct path, so nothing changes when proxies are off. A blocked
// result's body is cancelled before the retry so its keep-alive socket is freed, not leaked. Returns the
// first good result; re-throws the last error if every attempt threw.
const runWithProxy = async (attempt, { isBlocked } = {}) => {
  const pick = makePicker();                 // per-request base, captured once (concurrency-safe)
  const pooled = !!pick(0);
  const tries = pooled ? getProxyRetries() + 1 : 1;
  _syncAgents();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = pooled ? pick(i) : '';
    const dispatcher = pooled ? _dispatcherFor(url) : null;
    // Strict no-leak: a proxy is configured but THIS exit has no usable dispatcher (bad URL, or a SOCKS
    // proxy that failed to initialize). Never fall back to a direct connection — record the exit dead,
    // move to the next, and fail closed if none works.
    if (pooled && !dispatcher && _strictOn()) {
      recordExit(url, 'dead');
      lastErr = Object.assign(new Error('strict proxy mode: no usable proxy exit (refusing a direct connection)'), { proxyRequired: true });
      if (i >= tries - 1) throw lastErr;
      continue;
    }
    try {
      const res = await attempt(dispatcher);
      const blocked = typeof isBlocked === 'function' && isBlocked(res);
      // A response — blocked or not — proves the exit is reachable (clears its dead streak); a block is the
      // target refusing, not the exit being down, so it never cools the exit.
      if (pooled) recordExit(url, blocked ? 'blocked' : 'ok');
      if (i < tries - 1 && blocked) {
        try { res && res.body && res.body.cancel && res.body.cancel(); } catch { /* free the socket before retrying */ }
        continue;   // blocked → next proxy
      }
      return res;
    } catch (e) {
      lastErr = e;
      // A throw is a transport/connect failure — the exit is dead — so it accrues toward a cooldown.
      if (pooled) recordExit(url, 'dead');
      if (i >= tries - 1) throw e;   // out of retries — surface the failure
    }
  }
  throw lastErr;
};

module.exports = {
  getWebProxyUrl, getWebProxyUrls, nextProxyUrl, makePicker,
  runWithProxy, getProxyRetries,
  normalizeProxyUrl, parsePool,
  recordExit, exitHealthSnapshot,
};
