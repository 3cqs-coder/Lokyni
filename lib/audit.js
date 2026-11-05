'use strict';

// ── audit — never-throwing, TAMPER-EVIDENT security trail ────────────────────
//
// audit(actor, action, target, detail, ip) records a security-relevant action (an API key
// created or revoked, a config change, an index rebuild, a failed authentication, an
// external ingest). It is deliberately fire-and-forget and swallows every error: an
// audit-write failure must NEVER break the request it is auditing, and nothing here ever
// touches the retrieval/answer path. `actor` may be an Express request (the acting key +
// client IP are derived from it), an api-key record, or a plain string. Actions are
// dot-namespaced ("apikey.create", "config.update", "api.auth_fail").
//
// TAMPER-EVIDENCE: each entry is a link in a SHA-256 hash chain — `hash = SHA-256(fields ||
// prev_hash)` with a monotonic `seq`. Editing a field, deleting a row, or reordering breaks
// the chain, which the `audit_chain_integrity` watchdog detects at boot (warn-only). This is
// DETECTION, not prevention — a hash chain makes tampering evident, not impossible. Writes
// are serialized through one in-process queue so seq/prev_hash are assigned in order without
// a race, but the caller never awaits.
//
// Storage is a single append-only JSON-lines file (data/audit.jsonl) — appending one sealed
// line is O(1), and the whole thing is off the hot path. It self-prunes to the newest
// MAX_ROWS entries, recording a checkpoint so a legitimate prune doesn't read as tampering.
// The feature can be turned off entirely with `"auditLog": false` in config.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const GENESIS_HASH = '0'.repeat(64);
const CHAIN_SEP = '\x1f';   // unit separator — will not appear in the free-text fields
const MAX_ROWS = 10000;     // keep the newest N; older entries are pruned behind a checkpoint
const PRUNE_EVERY = 250;    // amortize the prune scan over many writes

const dataDir = () => { try { return require('./config').DATA_DIR; } catch (e) { return './data'; } };

// A single node writes one shared chain, `audit.jsonl`. In CLUSTER mode the data dir is SHARED by several
// instances, and the chain is a single-writer structure (one in-memory tip, monotonic seq, prev_hash links):
// two nodes appending to one file would fork the seq space, break the links, and raise false tamper alarms.
// So each cluster node writes its OWN file, `audit.<nodeId>.jsonl`, with its own checkpoint — one clean
// single-writer chain per node — and the readers below verify every node's chain independently and merge the
// rows for display. The node id is derived from this instance's host name and port: no two nodes can share
// both (they could not bind the same port on the same host), and it is stable across restarts and needs no
// persisted file — so it works even when the config folder itself is on a shared volume.
let _nodeId;
const nodeId = () => {
  try { if (!require('./cluster').enabled()) return null; } catch (e) { return null; }   // single node → shared file
  if (_nodeId !== undefined) return _nodeId;
  try {
    const port = (() => { try { return require('./config').PORT; } catch (e) { return ''; } })();
    _nodeId = crypto.createHash('sha1').update(`${os.hostname()}:${port}`).digest('hex').slice(0, 8);
  } catch (e) { _nodeId = crypto.randomBytes(4).toString('hex'); }   // never share a chain — unique per process
  return _nodeId;
};
const auditBase = () => { const id = nodeId(); return id ? `audit.${id}` : 'audit'; };
const logPath = (dir) => path.join(dir || dataDir(), `${auditBase()}.jsonl`);
const checkpointPath = (dir) => path.join(dir || dataDir(), `${auditBase()}-checkpoint.json`);

// Every audit chain file in the data dir: this node's own file plus, in a cluster, the other nodes'. Matches
// both the single-node `audit.jsonl` and the per-node `audit.<id>.jsonl`. Each returned entry carries the
// matching checkpoint path so a reader can verify that file's chain on its own terms.
const AUDIT_FILE_RE = /^audit(?:\.[A-Za-z0-9_-]+)?\.jsonl$/;
const listAuditFiles = (dir) => {
  const d = dir || dataDir();
  try {
    return fs.readdirSync(d).filter(n => AUDIT_FILE_RE.test(n)).map(n => ({
      file: path.join(d, n),
      checkpoint: path.join(d, n.replace(/\.jsonl$/, '-checkpoint.json')),
    }));
  } catch (e) { return []; }
};

// On unless explicitly disabled. Read live so toggling in Settings takes effect without a restart.
function enabled() { try { return require('./config').auditLog !== false; } catch (e) { return true; } }

// ── Pure chain primitives (no I/O — exported for the watchdog + tests) ────────

// Deterministic hash of one entry sealed to the previous hash. Field order is fixed and the
// timestamp is normalized to ISO so the same logical entry always hashes identically.
function chainHash(entry, prevHash) {
  entry = entry || {};
  const iso = (function () { try { return new Date(entry.ts).toISOString(); } catch (e) { return ''; } })();
  const parts = [
    String(entry.seq == null ? '' : entry.seq), iso,
    String(entry.actor == null ? '' : entry.actor),
    String(entry.action == null ? '' : entry.action),
    String(entry.target == null ? '' : entry.target),
    String(entry.detail == null ? '' : entry.detail),
    String(entry.ip == null ? '' : entry.ip),
    String(prevHash == null ? '' : prevHash),
  ];
  return crypto.createHash('sha256').update(parts.join(CHAIN_SEP)).digest('hex');
}

// Verify a run of sealed rows (sorted by seq ascending), starting from `checkpoint`
// ({ prunedThroughSeq, prunedThroughHash } or null). Returns { ok, anomalies }. Detects:
// EDIT (recomputed hash ≠ stored), DELETION/REORDER (prev_hash break or seq gap), and CLOCK
// ROLLBACK (ts regresses vs seq order). Pure — exported for testing.
function verifyChainRows(rows, checkpoint) {
  const anomalies = [];
  rows = Array.isArray(rows) ? rows : [];
  if (rows.length) {
    let expectedPrev = (checkpoint && checkpoint.prunedThroughHash) ? String(checkpoint.prunedThroughHash) : GENESIS_HASH;
    let expectedSeq = (checkpoint && checkpoint.prunedThroughSeq != null)
      ? Number(checkpoint.prunedThroughSeq) + 1
      : Number(rows[0].seq);   // no checkpoint ⇒ the chain simply begins at the first sealed row
    let lastTs = 0;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== expectedSeq) {
        anomalies.push('sequence gap before seq ' + seq + ' (expected ' + expectedSeq + ') — row(s) may have been deleted');
        expectedSeq = seq;   // resync so a single deletion reports once, not a cascade
      }
      if (String(r.prev_hash) !== expectedPrev) {
        anomalies.push('broken chain link at seq ' + seq + ' — prev_hash does not match the preceding entry (deletion or reorder)');
      }
      if (String(r.hash) !== chainHash(r, r.prev_hash)) {
        anomalies.push('hash mismatch at seq ' + seq + ' — the entry was altered after it was written');
      }
      const ts = new Date(r.ts).getTime();
      if (isFinite(ts) && ts + 1000 < lastTs) {   // 1s grace for same-second ordering
        anomalies.push('timestamp regression at seq ' + seq + ' — clock rollback or a backdated entry');
      }
      if (isFinite(ts)) lastTs = ts;
      expectedPrev = String(r.hash);
      expectedSeq = seq + 1;
    }
  }
  return { ok: anomalies.length === 0, anomalies };
}

// ── Actor / IP resolution ────────────────────────────────────────────────────

// Normalize the caller into a short principal string. An Express request → its authenticated
// api-key ("apikey:<id>") or "local" for the trusted localhost control plane; an api-key
// record → "apikey:<id>"; a string → itself.
function resolveActor(actor) {
  if (typeof actor === 'string') return actor || 'system';
  if (actor && typeof actor === 'object') {
    // Per-user attribution: a resolved request principal names who acted.
    const p = actor.principal;
    if (p && p.kind === 'user' && p.username) return 'user:' + p.username;
    if (p && p.kind === 'apikey' && p.apiKeyId) return 'apikey:' + p.apiKeyId;
    if (p && p.kind === 'owner') return 'owner';
    const key = actor.apiKey || (actor.id && actor.hash ? actor : null);   // a req with .apiKey, or a key record
    if (key && key.id) return 'apikey:' + key.id;
    if (actor.headers || actor.method) return 'local';                     // a req with no identity = the local UI
  }
  return 'system';
}

// Best-effort client IP from an Express request (honoring the usual proxy headers),
// normalized so loopback reads consistently.
function resolveIp(actor, ipArg) {
  let ip = ipArg || '';
  if (!ip && actor && typeof actor === 'object' && (actor.headers || actor.ip)) {
    const h = actor.headers || {};
    ip = h['cf-connecting-ip']
      || (h['x-forwarded-for'] || '').split(',')[0].trim()
      || actor.ip || (actor.connection && actor.connection.remoteAddress) || '';
  }
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.substring(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

// ── Serialized append (fire-and-forget) ──────────────────────────────────────

let tip = null;                       // { seq, hash } — in-memory head of the chain
let tipReady = null;                  // Promise loading the tip from disk exactly once
let writeQueue = Promise.resolve();   // the single serializer: assigns seq/prev_hash in order
let writeCount = 0;

const readLines = (dir) => {
  try {
    return fs.readFileSync(logPath(dir), 'utf-8').split('\n').filter(Boolean);
  } catch (e) { return []; }
};

// Load the current chain tip (highest sealed seq) from the last readable line, once.
function ensureTip(dir) {
  if (!tipReady) {
    tipReady = (async () => {
      const lines = readLines(dir);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const r = JSON.parse(lines[i]);
          if (r && r.seq != null && r.hash) { tip = { seq: Number(r.seq), hash: String(r.hash) }; return; }
        } catch (e) { /* skip a torn/legacy line */ }
      }
      tip = { seq: 0, hash: GENESIS_HASH };
    })();
  }
  return tipReady;
}

// Seal and append one entry, advancing the chain. Never throws — on any failure the action is
// still recorded UNCHAINED (no seq/hash), which the verifier treats as a benign coverage gap.
async function appendSealed(dir, doc) {
  try {
    await ensureTip(dir);
    const t = tip || { seq: 0, hash: GENESIS_HASH };
    doc.seq = t.seq + 1;
    doc.prev_hash = t.hash;
    doc.hash = chainHash(doc, t.hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath(dir), JSON.stringify(doc) + '\n');
    tip = { seq: doc.seq, hash: doc.hash };
  } catch (e) {
    try {
      const bare = { ts: doc.ts, actor: doc.actor, action: doc.action, target: doc.target, detail: doc.detail, ip: doc.ip };
      fs.appendFileSync(logPath(dir), JSON.stringify(bare) + '\n');
    } catch (_) { /* auditing must never break anything */ }
  }
}

// Keep the newest MAX_ROWS entries. Before dropping the oldest, record the newest SEALED row
// being pruned as a checkpoint so chain verification resumes from the surviving suffix instead
// of flagging every legitimate prune. Runs on the serializer so it never races an append.
async function prune(dir) {
  try {
    const lines = readLines(dir);
    if (lines.length <= MAX_ROWS) return;
    const rows = [];
    for (const l of lines) { try { rows.push(JSON.parse(l)); } catch (e) { /* drop torn line */ } }
    const keep = rows.slice(-MAX_ROWS);
    const dropped = rows.slice(0, rows.length - keep.length);
    // Replace the log FIRST (atomic rename), and only if that succeeds record the
    // checkpoint. Order matters: the log rewrite is the large write (megabytes), so it is
    // the one that can fail on a full disk. If the checkpoint were written first and the
    // rewrite then failed, the checkpoint would claim a prune that never happened — and the
    // next boot's verify would read the intact full log as a deletion and cry tampering.
    // This order means a failed prune leaves the full log with a stale/absent checkpoint (a
    // benign coverage gap), never a checkpoint ahead of the log.
    // Use the shared atomic writer so the rewritten log is fsync'd BEFORE the rename, matching every
    // other critical store. Without the flush, a crash right after the rename (before the bytes reach
    // disk) could leave audit.jsonl truncated or empty — silently discarding the whole tamper-evident
    // trail, and reading as a sequence gap (a false tamper alarm) on the next boot's integrity check.
    require('./disk').writeFileAtomic(logPath(dir), keep.map(r => JSON.stringify(r)).join('\n') + '\n');
    for (let i = dropped.length - 1; i >= 0; i--) {
      if (dropped[i] && dropped[i].seq != null && dropped[i].hash) {
        try {
          // Atomic like the log rewrite above: a torn checkpoint would read back as null, sending the next
          // boot's integrity check to verify the pruned log from genesis and cry a false "sequence gap" —
          // exactly the false alarm the checkpoint exists to prevent.
          require('./disk').writeFileAtomic(checkpointPath(dir), JSON.stringify({
            prunedThroughSeq: Number(dropped[i].seq), prunedThroughHash: String(dropped[i].hash), prunedAt: new Date().toISOString(),
          }, null, 2));
        } catch (e) { /* checkpoint best-effort */ }
        break;
      }
    }
  } catch (e) { /* pruning must never break anything */ }
}

// ── Public record + read ─────────────────────────────────────────────────────

// Record an action. Never throws, never blocks the caller — the seal + append run in the
// background serializer.
function audit(actor, action, target, detail, ip) {
  if (!enabled()) return true;
  try {
    const dir = dataDir();
    const act = String(action || '');
    let who = resolveActor(actor);
    // An *.auth_fail action means authentication was required and failed, so the caller is
    // by definition unauthenticated — never the trusted local control plane. Label it
    // honestly even though the (rejected) request object carries no api key to identify it.
    if (who === 'local' && act.endsWith('auth_fail')) who = 'anonymous';
    // Strip control characters (including the CHAIN_SEP unit separator and newlines) from the
    // user-influenced fields, so a crafted name/URL can't shift the hash's field boundaries or
    // tear the one-entry-per-line log.
    const clean = (s, n) => String(s || '').replace(/[\x00-\x1f]/g, ' ').slice(0, n);
    const doc = {
      ts: new Date().toISOString(),
      actor: who,
      action: act,
      target: clean(target, 200),
      detail: clean(detail, 500),
      ip: resolveIp(actor, ip),
    };
    writeQueue = writeQueue.then(() => appendSealed(dir, doc)).catch(() => {});
    if ((++writeCount % PRUNE_EVERY) === 0) writeQueue = writeQueue.then(() => prune(dir)).catch(() => {});
  } catch (e) { /* auditing must never break a request */ }
  return true;
}

// Coalesce high-frequency authentication failures per client IP. An *.auth_fail is recorded
// before any per-key rate limit can apply (the caller is unauthenticated), so a flood of bad
// keys would otherwise enqueue one synchronous append — plus a full-log rewrite every
// PRUNE_EVERY — per request, stalling the event loop for everyone: a DoS amplifier reachable
// without a key. This records at most one auth-fail entry per IP per window and folds the count
// of suppressed attempts into the next recorded entry, so the trail stays useful without the
// amplification. Use this (not audit) for auth_fail events.
const AUTHFAIL_WINDOW_MS = 10000;
const AUTHFAIL_MAX_KEYS  = 1024;   // hard ceiling on tracked peers (LRU-evicted, not expiry-only)
const AUTHFAIL_GLOBAL_MAX = 30;    // max recorded auth-fail entries per window across ALL peers
const _authFailSeen = new Map();   // peer-ip -> { until, suppressed }
let _authFailBucket = { until: 0, count: 0 };   // global token bucket, refilled each window

// Hard LRU cap on the tracked-peer map: always evict oldest-inserted keys once over the ceiling,
// not just expired ones. Expiry-only cleanup cannot bound the map when every entry is still
// within its window (exactly the flood case). Called after EVERY insert — including the
// bucket-exhausted branch — so a distributed flood past the global cap can't grow the map without
// bound (a Map preserves insertion order, so iterating keys() evicts oldest-first).
const capAuthFailSeen = () => {
  if (_authFailSeen.size <= AUTHFAIL_MAX_KEYS) return;
  let overflow = _authFailSeen.size - AUTHFAIL_MAX_KEYS;
  for (const k of _authFailSeen.keys()) { _authFailSeen.delete(k); if (--overflow <= 0) break; }
};

// The real TCP peer address, which — unlike the X-Forwarded-For / CF-Connecting-IP headers
// resolveIp trusts for accurate logging — cannot be spoofed on the connection. Coalescing
// MUST key on this: keying on a client header would let an unauthenticated caller rotate the
// header per request to defeat the coalescer and flood the audit log with synchronous appends.
// Behind a legitimate reverse proxy every request shares the proxy's socket address, so they
// collapse to one recorded entry per window — the correct behavior for rate-limiting writes.
function peerIp(actor) {
  const raw = (actor && ((actor.socket && actor.socket.remoteAddress)
    || (actor.connection && actor.connection.remoteAddress))) || '';
  let ip = String(raw);
  if (ip.startsWith('::ffff:')) ip = ip.substring(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function auditAuthFail(actor, action, target, detail) {
  if (!enabled()) return true;
  try {
    const now = Date.now();
    // Coalesce on the unspoofable peer address; fall back to resolveIp only for non-request
    // actors that have no socket. The recorded audit entry still logs resolveIp's proxy-aware
    // address for accuracy — only the coalescing/rate-limit key is the connection peer.
    const key = peerIp(actor) || resolveIp(actor) || 'unknown';
    const seen = _authFailSeen.get(key);
    if (seen && now < seen.until) { seen.suppressed++; return true; }   // within window — coalesce per peer
    // Global backstop: even with per-peer coalescing, a distributed flood (many source IPs)
    // could still enqueue one append each. Cap the total recorded auth-fail entries per window;
    // once exhausted, suppress the write (folding it into the peer's suppressed count) so the
    // synchronous append + periodic full-log rewrite can never be driven without bound.
    if (now >= _authFailBucket.until) _authFailBucket = { until: now + AUTHFAIL_WINDOW_MS, count: 0 };
    if (_authFailBucket.count >= AUTHFAIL_GLOBAL_MAX) {
      if (seen) seen.suppressed++;
      else { _authFailSeen.set(key, { until: now + AUTHFAIL_WINDOW_MS, suppressed: 1 }); capAuthFailSeen(); }
      return true;
    }
    _authFailBucket.count++;
    const suppressed = seen ? seen.suppressed : 0;
    _authFailSeen.set(key, { until: now + AUTHFAIL_WINDOW_MS, suppressed: 0 });
    capAuthFailSeen();
    const note = suppressed > 0 ? `${detail || ''} (+${suppressed} more suppressed in the last ${AUTHFAIL_WINDOW_MS / 1000}s)` : detail;
    return audit(actor, action, target, note);
  } catch (e) { return true; }
}

// Parse every JSON-lines row from one audit file (torn lines skipped). Never throws.
const readRowsFrom = (file) => {
  const out = [];
  try { for (const l of fs.readFileSync(file, 'utf-8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (e) { /* torn line */ } } }
  catch (e) { /* unreadable file */ }
  return out;
};
const readCheckpointFrom = (cp) => { try { return JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch (e) { return null; } };

// Verify the audit chain(s). A single node has one file; a cluster has one single-writer chain file per node,
// each with its own seq space + checkpoint, so each is verified independently and the results are combined:
// OK only if every chain is intact, anomalies tagged by file when there is more than one. Never throws — if it
// cannot read, it reports OK (absence of a readable chain is not proof of tampering).
function verifyChain(dir) {
  dir = dir || dataDir();
  try {
    const files = listAuditFiles(dir);
    if (files.length === 0) return { ok: true, anomalies: [], checked: 0 };
    let ok = true, checked = 0; const anomalies = [];
    for (const f of files) {
      const rows = readRowsFrom(f.file).filter(r => r && r.seq != null).sort((a, b) => Number(a.seq) - Number(b.seq));
      const res = verifyChainRows(rows, readCheckpointFrom(f.checkpoint));
      checked += rows.length;
      if (!res.ok) ok = false;
      const tag = files.length > 1 ? `[${path.basename(f.file)}] ` : '';
      for (const a of (res.anomalies || [])) anomalies.push(tag + a);
    }
    return { ok, anomalies, checked };
  } catch (e) { return { ok: true, anomalies: [], checked: 0, error: e.message }; }
}

// Filterable read for the audit viewer. Options: { action, actor, since, limit }. Newest first.
// Never throws.
function list(opts) {
  opts = opts || {};
  try {
    const rows = collectRows(listAuditFiles());
    const filtered = filterRows(rows, opts);
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
    return newestFirst(filtered, limit);
  } catch (e) { return []; }
}

// Read every audit file into one array, tagging each row with its global append order so a merge can keep
// same-timestamp rows in a stable, reverse-append (newest-first) order even across several node files.
function collectRows(files) {
  const rows = []; let i = 0;
  for (const f of files) for (const r of readRowsFrom(f.file)) rows.push({ r, i: i++, t: new Date(r.ts).getTime() });
  return rows;
}
function filterRows(rows, opts) {
  let out = rows;
  if (opts.action) out = out.filter(x => String(x.r.action || '').startsWith(opts.action));
  if (opts.actor)  out = out.filter(x => String(x.r.actor || '').includes(opts.actor));
  if (opts.since)  { const s = new Date(opts.since).getTime(); out = out.filter(x => x.t >= s); }
  return out;
}
// Newest-first: by timestamp descending, and for an equal timestamp the later-appended row first (so entries
// written in the same millisecond still read newest-first, matching a single append-only file reversed).
function newestFirst(rows, limit) {
  return rows.slice().sort((a, b) => (b.t - a.t) || (b.i - a.i)).slice(0, limit)
    .map(x => ({ ts: x.r.ts, actor: x.r.actor, action: x.r.action, target: x.r.target, detail: x.r.detail, ip: x.r.ip }));
}

// Combined report for the audit viewer: read and parse the log ONCE, asynchronously, then derive
// BOTH the tamper verdict and the filtered newest-first entries from the same rows. The /api/audit
// route previously called verifyChain() and list() separately, each doing its own synchronous
// full-file read + parse — two O(log) synchronous passes (up to ~20k JSON.parse calls on a capped
// 10k-entry log) that could briefly stall the event loop. Never throws.
async function report(opts, dir) {
  opts = opts || {};
  dir = dir || dataDir();
  const fsp = require('fs').promises;
  const files = listAuditFiles(dir);
  const rows = []; let i = 0;
  let ok = true, checked = 0; const anomalies = [];
  for (const f of files) {
    let lines = [];
    try { lines = (await fsp.readFile(f.file, 'utf-8')).split('\n').filter(Boolean); } catch { lines = []; }
    const fileRows = [];
    for (const l of lines) { try { fileRows.push(JSON.parse(l)); } catch (e) { /* skip a torn line */ } }
    for (const r of fileRows) rows.push({ r, i: i++, t: new Date(r.ts).getTime() });
    // Each file is its own single-writer chain — verify it on its own seq space + checkpoint.
    try {
      const chainRows = fileRows.filter(r => r && r.seq != null).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
      let cp = null; try { cp = JSON.parse(await fsp.readFile(f.checkpoint, 'utf-8')); } catch { /* no checkpoint */ }
      const res = verifyChainRows(chainRows, cp);
      checked += chainRows.length;
      if (!res.ok) ok = false;
      const tag = files.length > 1 ? `[${path.basename(f.file)}] ` : '';
      for (const a of (res.anomalies || [])) anomalies.push(tag + a);
    } catch (e) { /* a single unverifiable file never fails the whole report */ }
  }
  const integrity = { ok, anomalies, checked };

  // Filtered, newest-first entries, merged across every node's file (same filters + ordering as list()).
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
  const entries = newestFirst(filterRows(rows, opts), limit);

  return { integrity, entries };
}

module.exports = {
  audit, auditAuthFail, list, verifyChain, report, chainHash, verifyChainRows, GENESIS_HASH,
  // The unspoofable TCP peer address (see peerIp). Shared so rate-limiters — e.g. the login throttle —
  // key on the connection peer, which a client cannot rotate via X-Forwarded-For, rather than a header.
  peerIp,
  // Test-only introspection: the number of tracked auth-fail peers, used to assert the hard LRU
  // cap holds under a flood. Not part of the public API.
  _authFailSeenSize: () => _authFailSeen.size, _authFailMaxKeys: () => AUTHFAIL_MAX_KEYS,
};
