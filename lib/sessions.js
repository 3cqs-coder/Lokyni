'use strict';
// Lightweight conversation persistence. Conversation context normally lives only
// in socket memory, so a page refresh or reconnect loses the thread. This module
// serializes the durable parts of conversationContext to data/sessions/<id>.json
// and restores them when a client reconnects with the same session id.
//
// Only the durable fields are persisted — the Maps used for passage bookkeeping
// (docReadPos, docPassages, windowScoreCache, docExcludePos) are transient and
// rebuilt on the next query, so they are intentionally NOT saved.
const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');
const { detectLanguage } = require('./langdetect');
const { writeFileAtomicAsync } = require('./disk');
const { DEBUG, DATA_DIR } = require('./config');
const { makeSnippet } = require('./snippet');
const { MAX_CONSULTED_DOCS, MAX_HISTORY_TURNS } = require('./conversation');

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MAX_AGE_MS   = 1000 * 60 * 60 * 24 * 30; // prune sessions older than 30 days

// A session id must be a filesystem-safe token. Reject anything else to prevent
// path traversal via a malicious client-supplied id.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isValidId = (id) => typeof id === 'string' && SAFE_ID_RE.test(id);

const ensureDir = () => { try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {} };
ensureDir();

// Sessions are namespaced on disk by a principal key (see lib/principal.js principalKey), so one user's
// session id can never address another user's session file — a client-supplied id resolves only within the
// caller's own namespace. The owner / single-operator install uses the fixed 'owner' bucket. The key is a
// safe, bounded token; coerce anything unexpected to the owner bucket rather than risk an odd path.
const DEFAULT_PRINCIPAL_KEY = 'owner';
const SAFE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const safeKey = (k) => (typeof k === 'string' && SAFE_KEY_RE.test(k)) ? k : DEFAULT_PRINCIPAL_KEY;
const filePathFor = (key, id) => path.join(SESSIONS_DIR, `${safeKey(key)}__${id}.json`);

// Cap stored web-page text so session files stay reasonable while retaining enough
// for a follow-up to stay grounded. Full fetched text can be several KB per page;
// 4000 chars is plenty for follow-up context.
const WEBPAGE_STORE_CAP = 4000;

// Cap the readable body persisted per web SOURCE (for the in-app reader), a little larger than the
// follow-up page cap since it is what the user actually reads back. Bounded so a long article can't
// bloat the session file.
const WEB_SOURCE_STORE_CAP = 8000;

// Cap how many conversation turns are persisted, so a single very long conversation cannot grow its
// session file without bound when summarization is off (summarization otherwise trims history). The
// most recent turns are kept — plenty for any real conversation — and the time-based prune still
// applies. Only affects the on-disk copy; the live in-memory history is unchanged.
const MAX_PERSISTED_TURNS = MAX_HISTORY_TURNS;   // single-sourced with the live cap (history.js) via conversation.js
// Most recent web pages to persist with a session (capped on both save and load, so neither can grow the
// stored/loaded context without bound).
const MAX_PERSISTED_WEBPAGES = 8;
// A generous ceiling on a session file before it is read into memory. Lokyni-written files are bounded
// (MAX_PERSISTED_TURNS turns plus per-source caps) to a few MB at most; a file far larger than this is
// hand-edited or externally grown, so treat it as a fresh session rather than read it whole and risk OOM.
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

// The readable body to persist for a web source: the fetched article text if present, otherwise the
// search snippet. Without this a reopened conversation whose search result had no snippet showed an
// empty "no readable text" reader, even though the live answer had shown the full article.
const webSourceBody = (s) => {
  const body = (typeof s.text === 'string' && s.text.trim()) ? s.text : (s.snippet || '');
  return body ? String(body).slice(0, WEB_SOURCE_STORE_CAP) : '';
};

// Trim ONE source pill to the lean, durable shape the UI renders — dropping the fat fields a live source object
// carries (full passage text, raw figure objects, internal offsets) that neither a restored session nor an
// in-memory follow-up needs. Single-sourced so the persist path and the live-history trim (socket.js) can't
// drift: the bytes the session file holds and the bytes a long live conversation holds are bounded identically.
const leanSource = (s) => {
  const out = {
    id: s.id, source: s.source, fileType: s.fileType,
    viewerLink: s.viewerLink, isWeb: !!s.isWeb, url: s.url,
    passageStart: s.passageStart, passageEnd: s.passageEnd, docLength: s.docLength,
    confidence: s.confidence, rerankScore: s.rerankScore,
  };
  if (s.snippet) out.snippet = makeSnippet(s.snippet);
  if (s.credibility && Array.isArray(s.credibility.flags) && s.credibility.flags.length) {
    out.credibility = {
      flags: s.credibility.flags.slice(0, 3),
      labels: (s.credibility.labels || []).slice(0, 3),
      shortLabels: (s.credibility.shortLabels || []).slice(0, 3),
    };
  }
  if (s.isWeb) { const body = webSourceBody(s); if (body) out.text = body; }
  if (Array.isArray(s.figures) && s.figures.length) {
    out.figures = s.figures.slice(0, 12).map(f => ({ id: f.id, page: f.page, label: f.label, type: f.type, url: f.url }));
  }
  return out;
};
// Lean an assistant turn's source array (cap to 12, same as persistence). Returns a NEW array of NEW objects,
// so trimming the copy stored in history never mutates the full sources already emitted to the client.
const leanSources = (arr) => (Array.isArray(arr) && arr.length) ? arr.slice(0, 12).map(leanSource) : [];

// Bump when a breaking change to the on-disk session shape is made. Stamped on write and
// checked on read so a file written by a NEWER build isn't silently mis-read by an older one.
const SESSION_VERSION = 1;

// Extract only the durable, serializable fields from a live conversationContext.
const serialize = (ctx) => ({
  version: SESSION_VERSION,
  updatedAt: Date.now(),
  // History entries keep the source pills attached to each assistant turn so a
  // restored conversation shows its citations. Sources are trimmed to the fields
  // the UI renders — the full objects carry passage offsets and internal ids that
  // don't need persisting, and an unbounded list would bloat the session file.
  history: Array.isArray(ctx.history)
    ? ctx.history.slice(-MAX_PERSISTED_TURNS).map(m => {
        const base = { role: m.role, content: m.content };
        // Trim via the shared leanSources (also used for the LIVE history in socket.js) so persisted and live
        // source shapes can't drift. Harmless if the live array was already leaned on push.
        if (m.role === 'assistant' && Array.isArray(m.sources) && m.sources.length) base.sources = leanSources(m.sources);
        // Tag each answer with its language so a restored conversation routes Read aloud to the same voice it
        // would have used live. This is the single persistence point for every answer path; detection is the
        // same fail-open detector used for routing, and a missing tag simply means "use the configured default".
        if (m.role === 'assistant') {
          // Detect once, then cache the result back onto the live entry (slice keeps the same object references),
          // so a turn's language is computed at most ONCE ever — not re-detected for every assistant turn on every
          // save (which was O(n) per save → O(n²) over a long conversation). `typeof m.language !== 'string'`
          // distinguishes "not yet detected" from "detected as none" (English → ''), so even English is cached and
          // not re-detected; an explicit tag set upstream (a non-empty string) still wins and skips detection.
          if (typeof m.language !== 'string') m.language = detectLanguage(m.content) || '';
          if (m.language) base.language = m.language;
        }
        return base;
      })
    : [],
  summary: ctx.summary || '',
  // summarizedUpTo is an index into history. When the persisted history is capped to the most recent
  // turns, drop the same count off this pointer so it still lines up with the retained array — else a
  // restored conversation would treat unsummarized leading turns as already summarized and drop them.
  summarizedUpTo: Math.max(0, (ctx.summarizedUpTo || 0)
    - Math.max(0, (Array.isArray(ctx.history) ? ctx.history.length : 0) - MAX_PERSISTED_TURNS)),
  allowedDocIds: ctx.allowedDocIds || null,
  // Keep only the most recent distinct consulted docs (the producer already bounds this, but a legacy or
  // hand-grown context could carry more — cap on write so the session file stays bounded regardless).
  consultedDocs: Array.isArray(ctx.consultedDocs) ? ctx.consultedDocs.slice(-MAX_CONSULTED_DOCS) : [],
  // Persist fetched web pages so a web follow-up survives a reconnect and can reuse
  // them (no re-search). Text is capped per page to bound file size.
  webPages: Array.isArray(ctx.webPages)
    ? ctx.webPages.slice(0, MAX_PERSISTED_WEBPAGES).map(p => ({
        title: typeof p.title === 'string' ? p.title : '',
        url:   typeof p.url === 'string' ? p.url : '',
        text:  typeof p.text === 'string' ? p.text.slice(0, WEBPAGE_STORE_CAP) : '',
      }))
    : null,
});

// Serialize all file operations for a given session id through a per-id promise chain, so a save, a
// clear, and a load for the same session run strictly in call order and never overlap on the libuv
// thread pool. Without this, a completed turn's fire-and-forget saveSession (write→rename) could race
// a clearSession from a subsequent New: if the delete landed before the rename, the just-cleared
// session file would be recreated with the pre-New conversation, which a later restore would replay —
// a resurrected cleared conversation. The chain guarantees the clear always runs after the save it was
// issued after, so the file ends deleted. The map entry is dropped once its tail settles, so it never
// grows unbounded. fn never rejects (each operation swallows its own errors), but the chain proceeds
// on either outcome so one operation can't wedge the queue.
const _chains = new Map();   // lockKey -> Promise of the last queued op
const withSessionLock = (key, id, fn) => {
  const lockKey = `${safeKey(key)}__${id}`;   // per-file lock (namespaced), so two principals' same id don't share one
  const prev = _chains.get(lockKey) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tracked = run.finally(() => { if (_chains.get(lockKey) === tracked) _chains.delete(lockKey); });
  _chains.set(lockKey, tracked);
  return run;
};

// Load a session's durable context. Returns null if missing/invalid/corrupt.
const loadSession = (id, principalKey) => {
  if (!isValidId(id)) return Promise.resolve(null);
  return withSessionLock(principalKey, id, () => _loadSession(principalKey, id));
};
const _loadSession = async (principalKey, id) => {
  try {
    const p = filePathFor(principalKey, id);
    // Size-gate before reading: don't pull a runaway/hand-grown file entirely into memory + JSON.parse.
    try { const st = await fsp.stat(p); if (st.size > MAX_SESSION_BYTES) { console.warn(`⚠️  Session ${id} is ${Math.round(st.size / 1e6)} MB — too large to load; starting fresh`); return null; } }
    catch { return null; }   // missing — fresh session
    const raw = await fsp.readFile(p, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    // A file written by a newer build with a breaking shape change: don't risk mis-reading
    // it — start fresh (the same forward-compat guard the backup format uses).
    if (Number.isInteger(data.version) && data.version > SESSION_VERSION) return null;
    // Re-apply the SAVE-side caps on load too, so a legacy or hand-grown file (anything up to the 64 MB
    // read gate) can't load an unbounded history or oversized web pages into memory — symmetric with the
    // bounds the writer enforces. A Lokyni-written file is already within these, so this is a no-op for it.
    const rawHistory = Array.isArray(data.history) ? data.history : [];
    const dropped = Math.max(0, rawHistory.length - MAX_PERSISTED_TURNS);
    const history = dropped ? rawHistory.slice(-MAX_PERSISTED_TURNS) : rawHistory;
    return {
      history,
      summary:        typeof data.summary === 'string' ? data.summary : '',
      // Clamp to the (possibly capped) history length, rebasing by any turns dropped above (summarizedUpTo is
      // an index into history). A legacy file written before the persist-time rebase, or a transient
      // over-shoot, could otherwise point past the end and suppress rolling summarization until the thread
      // regrew. Clamping self-heals it.
      summarizedUpTo: Math.min(Math.max(0, (Number.isInteger(data.summarizedUpTo) ? data.summarizedUpTo : 0) - dropped), history.length),
      allowedDocIds:  Array.isArray(data.allowedDocIds) ? data.allowedDocIds : null,
      // Re-apply the cap on load too (symmetric with the writer), so a legacy/hand-grown file can't load an
      // unbounded consulted-docs list into memory.
      consultedDocs:  Array.isArray(data.consultedDocs) ? data.consultedDocs.slice(-MAX_CONSULTED_DOCS) : [],
      webPages:       Array.isArray(data.webPages)
        ? data.webPages
            .filter(p => p && typeof p === 'object' && typeof p.text === 'string' && p.text.length > 0)
            .slice(0, MAX_PERSISTED_WEBPAGES)
            .map(p => ({ title: p.title || '', url: p.url || '', text: p.text.slice(0, WEBPAGE_STORE_CAP) }))
        : null,
    };
  } catch {
    return null; // missing or corrupt — treat as a fresh session
  }
};

// Persist a session's durable context (fire-and-forget; errors are logged only). Serialized per id.
const saveSession = (id, ctx, principalKey) => {
  if (!isValidId(id)) return Promise.resolve();
  return withSessionLock(principalKey, id, () => _saveSession(principalKey, id, ctx));
};
const _saveSession = async (principalKey, id, ctx) => {
  try {
    const payload = JSON.stringify(serialize(ctx));
    const p = filePathFor(principalKey, id);
    // Write to a temp file then rename (atomic on the same filesystem), so a concurrent read (e.g. a second
    // tab restoring while this saves) never sees a half-written file and mis-reports the conversation as lost.
    // A unique temp (pid + random) lets two concurrent saves of the same session — two tabs, or overlapping
    // turns — not race one temp. No fsync: a session is best-effort and re-savable, not worth the latency.
    try {
      await writeFileAtomicAsync(p, payload);
    } catch (e) {
      // The sessions dir is created once at startup (not synchronously on every save, which would block the
      // event loop on the hot path). If it was removed at runtime the write fails with ENOENT — recreate it
      // off-thread and retry once; any other error propagates to the logger below.
      if (e && e.code === 'ENOENT') { await fsp.mkdir(SESSIONS_DIR, { recursive: true }); await writeFileAtomicAsync(p, payload); }
      else throw e;
    }
  } catch (e) {
    if (DEBUG) console.log(`  ⚠️  Session save failed (${id}): ${e.message}`);
  }
};

// Delete a session file (used when the user clicks New / clears the conversation). Serialized per id
// so it always runs after any save issued before it — never resurrecting a just-cleared conversation.
const clearSession = (id, principalKey) => {
  if (!isValidId(id)) return Promise.resolve();
  return withSessionLock(principalKey, id, () => _clearSession(principalKey, id));
};
const _clearSession = async (principalKey, id) => {
  try { await fsp.rm(filePathFor(principalKey, id), { force: true }); } catch {}
};

// Best-effort prune of stale session files. Called once at startup.
const pruneOldSessions = async () => {
  try {
    const files = await fsp.readdir(SESSIONS_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (f) => {
      if (!f.endsWith('.json')) return;
      try {
        const st = await fsp.stat(path.join(SESSIONS_DIR, f));
        if (now - st.mtimeMs > MAX_AGE_MS) await fsp.rm(path.join(SESSIONS_DIR, f), { force: true });
      } catch {}
    }));
  } catch {}
};

module.exports = { loadSession, saveSession, clearSession, pruneOldSessions, isValidId, leanSources };
