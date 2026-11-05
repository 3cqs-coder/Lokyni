'use strict';
// Public API v1.
//
// A small, authenticated, read-mostly data plane for using Lokyni outside the web
// UI. Deliberately separate from the UI's control-plane /api/* routes (config,
// workspace delete, filesystem browse, logs) — an API key can NEVER reach those.
//
// Endpoints (all require a valid key):
//   POST /api/v1/search            { query, workspace?, k? }        → { passages: [...] }
//   POST /api/v1/summarize         { docId, workspace? }            → { summary } | SSE stream
//   POST /api/v1/synthesize        { workspace?, focus? }           → { overview } | SSE stream
//   POST /api/v1/chat/completions  OpenAI-compatible grounded chat  → completion | SSE stream
//   POST /api/v1/ingest-url        { url, title?, html?, text?, workspace? } → adds a web page (write scope)
//   GET  /api/v1/workspaces                                         → { workspaces: [...] }
//   GET  /api/v1/documents?workspace=<id>&limit=&offset=            → { documents: [...], total, offset, limit, nextOffset }
//
// Workspace targeting is independent of the UI. Each request may name a workspace;
// the API loads that workspace's index into its own bundle (via indexing/bundle),
// so an API call against workspace B does not disturb a browser sitting in
// workspace A. When omitted, the workspace defaults to 'default' (NOT the UI's
// active workspace — a programmatic caller shouldn't depend on UI state).

const { Router } = require('express');
const { OUT_OF_SCOPE_MESSAGE, MAX_QUERY_CHARS } = require('../constants');

const router = Router();

// ── Auth middleware ──────────────────────────────────────────────────────────
router.use((req, res, next) => {
  // CORS preflight requests carry no credentials by design, so they must not be
  // auth-gated — otherwise the browser clipper's cross-origin POST is blocked before
  // the real (authenticated) request is ever sent. Answer the preflight and stop.
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.set('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  const cfg = require('../config');
  const ak  = require('../apikeys');
  const record = ak.authenticate(cfg.DATA_DIR, ak.extractKey(req));
  if (!record) {
    require('../audit').auditAuthFail(req, 'api.auth_fail', `${req.method} ${req.path}`, 'invalid or missing API key');
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  // Per-key rate limiting. Sets standard RateLimit headers on every response and
  // returns 429 (with Retry-After) when the key exceeds its requests-per-minute.
  const rl = require('../ratelimit');
  const result = rl.check(record);
  if (result.limit !== 0) {
    res.set('RateLimit-Limit', String(result.limit));
    res.set('RateLimit-Remaining', String(result.remaining === Infinity ? result.limit : result.remaining));
    res.set('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
  }
  if (!result.allowed) {
    res.set('Retry-After', String(Math.ceil(result.resetMs / 1000)));
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit: result.limit,
      retryAfterSeconds: Math.ceil(result.resetMs / 1000),
    });
  }

  ak.touchLastUsed(cfg.DATA_DIR, record.id);
  req.apiKey = record;
  next();
});

// Resolve + authorize the target workspace for a request. Returns { id } on
// success or sends an error response and returns null.
const resolveWorkspace = (req, res, requested) => {
  const r = require('../workspaces').resolveAccess(require('../config').DATA_DIR, requested, req.apiKey);
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return null; }
  return { id: r.id };
};

const requireScope = (req, res, scope) => {
  const ak = require('../apikeys');
  if (!ak.hasScope(req.apiKey, scope)) {
    res.status(403).json({ error: `This key lacks the '${scope}' scope` });
    return false;
  }
  return true;
};

// The scope each route requires, declared in one reviewable place. Each handler still
// gates itself with requireScope(...); this is the CONTRACT the boot-time watchdog audits
// (lib/watchdog.js api_scope_coverage), so a newly-added state-changing route that forgot
// its gate — or one wired to a scope that doesn't exist — is caught at startup rather than
// shipping an ungated write. Attached to the router so the check can read it alongside the
// registered routes. Keep this in sync when adding a route.
router.ROUTE_SCOPES = {
  'POST /search': 'search',
  'POST /summarize': 'summarize',
  'POST /synthesize': 'summarize',
  'POST /ingest-url': 'write',
  'POST /chat/completions': 'search',
  'GET /workspaces': 'read',
  'GET /documents': 'read',
};

// Concurrency gate for the model-backed endpoints (search, summarize, synthesize,
// chat/completions). Each drives the single local model plus the worker-thread rerankers; a
// script firing many in parallel would saturate that one model process and stall every caller —
// and with streaming, hold many generations open at once. Cap the number running concurrently and
// bound the wait queue so excess requests get a fast 429 with backpressure instead of piling up
// unbounded. The plain read routes (workspaces, documents) don't generate, so they aren't gated.
// Shared, process-wide generation gate (see lib/gengate.js) so the HTTP API and the MCP server draw from
// ONE concurrency budget for the single local model, rather than each capping itself independently.
const _genGate = require('../gengate');

// Take a generation slot, or answer 429 (with Retry-After) and return false when the queue is
// saturated. Callers must release() in a finally once the response is fully sent.
const acquireGen = async (res) => {
  try { await _genGate.acquire(); return true; }
  catch {
    res.set('Retry-After', '5');
    res.status(429).json({ error: 'The service is busy — too many requests are being processed. Retry shortly.' });
    return false;
  }
};

// An AbortController that fires when the client disconnects. Create it BEFORE acquireGen so a disconnect while
// the request is QUEUED behind the generation gate is still caught (res emits 'close' once; a listener attached
// only after the wait would miss it) — the handler then re-checks ac.signal.aborted after acquiring and bails
// without starting work. The signal is threaded into the model calls so a disconnect also aborts generation at
// the provider, not just the consumer loop.
const disconnectSignal = (res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  return ac;
};

// Drain a model answer stream into a string, stopping the moment the client disconnects (signal aborted).
// Returns the text, or null when aborted (the caller returns without sending). Because the signal is also
// threaded into the stream, stopping here aborts generation at the provider too.
const drain = async (stream, signal) => {
  let text = '';
  for await (const chunk of stream) { if (signal && signal.aborted) return null; if (chunk) text += chunk; }
  return (signal && signal.aborted) ? null : text;
};

// Collect a buffered model stream, run the finalize pass, and emit it as one SSE text event + a done event.
// Shared by the SSE summarize/synthesize paths (byte-identical before this) so the drain→finalize→emit
// sequence lives in one place — a new egress safeguard added to the finalizer then reaches both. Defaults to
// verify.finalize (strip exfil, decline a system-prompt leak, correct a stated arithmetic slip); the caller
// sets any SSE headers and leading events first. Returns false when the client disconnected mid-drain so the
// caller can return without writing. The grounded chat/completions paths finalize differently (finalizeGrounded
// + an out-of-scope fallback, OpenAI-shaped output), so they do not use this.
const emitFinalizedSSE = async (res, stream, signal, finalize) => {
  const collected = await drain(stream, signal);
  if (collected === null) return false;   // client disconnected
  const text = (finalize || require('../verify').finalize)(collected);
  if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
  res.write('event: done\ndata: {}\n\n');
  res.end();
  return true;
};

// MAX_QUERY_CHARS (the free-text input cap for /search and /synthesize) is single-sourced in constants.js and
// imported above, so the chat socket enforces the SAME limit.

// One SSE header block for every streaming endpoint, so they can't drift (summarize previously omitted the
// charset the others set).
const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };

// The invented-citation and numeric-grounding caveat helpers are single-sourced in lib/answerfinalize.js so the
// scheduled-automations egress applies the exact same safeguards as this API path (answer-safeguard parity).
const { finalizeGrounded } = require('../answerfinalize');

// Log the real error server-side; return a fixed, generic message to the remote key-holder so an
// internal detail (a filesystem path, a stack fragment, a dependency's error text) never leaks
// off-box to a caller who holds only an API key. A response whose headers already went out (a
// stream that failed mid-flight) is simply ended — it cannot carry a new status or body.
const fail = (res, e, label, { status = 500, message = 'Request failed', extra } = {}) => {
  console.error(`❌ /api/v1/${label} failed:`, (e && e.message) || e);
  if (!res.headersSent) res.status(status).json(extra ? { error: message, ...extra } : { error: message });
  else { try { res.end(); } catch {} }
};

// ── POST /api/v1/search ──────────────────────────────────────────────────────
router.post('/search', async (req, res) => {
  if (!requireScope(req, res, 'search')) return;
  const body  = req.body || {};
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > MAX_QUERY_CHARS) return res.status(400).json({ error: `query exceeds ${MAX_QUERY_CHARS} characters` });
  const { DEFAULT_SEARCH_K, MAX_SEARCH_K } = require('../api-core');
  const k = Math.max(1, Math.min(parseInt(body.k, 10) || DEFAULT_SEARCH_K, MAX_SEARCH_K));

  const ws = resolveWorkspace(req, res, body.workspace);
  if (!ws) return;

  const ac = disconnectSignal(res);   // before the gate, so a queue-wait disconnect is caught too
  if (!(await acquireGen(res))) return;
  try {
    if (ac.signal.aborted) return;   // client left while queued behind the gate — don't start retrieval
    const { runSearch } = require('../api-core');
    const r = await runSearch(ws.id, query, k, { signal: ac.signal });
    if (ac.signal.aborted) return;
    if (r.status === 'warming') {
      return res.status(202).json({ query, workspace: ws.id, status: 'warming',
        note: 'This workspace is being prepared for its first API query. Retry in a few seconds.' });
    }
    if (r.status === 'empty') {
      return res.json({ query, workspace: ws.id, passages: [], note: 'This workspace has no documents.' });
    }
    res.json({ query, workspace: ws.id, passages: r.passages });
  } catch (e) {
    fail(res, e, 'search', { message: 'Retrieval failed' });
  } finally {
    _genGate.release();
  }
});

// ── POST /api/v1/summarize ───────────────────────────────────────────────────
// One-shot JSON by default; set { stream: true } (or Accept: text/event-stream)
// for an SSE stream of the summary as it generates.
router.post('/summarize', async (req, res) => {
  if (!requireScope(req, res, 'summarize')) return;
  const body  = req.body || {};
  const docId = typeof body.docId === 'string' ? body.docId : '';
  if (!docId) return res.status(400).json({ error: 'docId is required' });

  const ws = resolveWorkspace(req, res, body.workspace);
  if (!ws) return;

  const wantsStream = body.stream === true || (req.get('accept') || '').includes('text/event-stream');

  const ac = disconnectSignal(res);   // before the gate, so a queue-wait disconnect is caught too
  if (!(await acquireGen(res))) return;
  try {
    if (ac.signal.aborted) return;   // client left while queued behind the gate — don't start work
    if (!wantsStream) {
      // Non-streaming: the shared core handles warming/not-found/empty uniformly. The disconnect signal aborts
      // the summary if the client leaves, so the model stops generating a summary nobody will read (which would
      // otherwise hold a concurrency slot until it finished).
      const { runSummarize } = require('../api-core');
      const r = await runSummarize(ws.id, docId, { signal: ac.signal });
      if (ac.signal.aborted) return;   // client disconnected — nothing to send
      if (r.status === 'warming') {
        return res.status(202).json({ docId, workspace: ws.id, status: 'warming',
          note: 'This workspace is being prepared for its first API query. Retry in a few seconds.' });
      }
      if (r.status === 'not_found') return res.status(404).json({ error: `No such document in workspace ${ws.id}: ${docId}` });
      if (r.status === 'empty')     return res.json({ docId, workspace: ws.id, source: r.source, summary: '', note: 'Document is empty.' });
      return res.json({ docId, workspace: ws.id, source: r.source, summary: r.summary, truncated: r.truncated });
    }

    // Streaming path needs the raw entry (buildSummaryRequest + live LLM stream), so
    // it acquires the bundle directly rather than through the one-shot core.
    const { getBundleNonBlocking } = require('../indexing/bundle');
    const acq = await getBundleNonBlocking(ws.id);
    if (acq.status === 'warming') {
      return res.status(202).json({ docId, workspace: ws.id, status: 'warming',
        note: 'This workspace is being prepared for its first API query. Retry in a few seconds.' });
    }
    const idx = acq.bundle;
    const entry = idx.parentMap.get(docId);
    if (!entry) return res.status(404).json({ error: `No such document in workspace ${ws.id}: ${docId}` });

    const { buildSummaryRequest } = require('../summarize');

    // SSE stream.
    const reqObj = buildSummaryRequest(entry);
    res.writeHead(200, SSE_HEADERS);
    if (reqObj.empty) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Document is empty' })}\n\n`);
      res.end();
      return;
    }
    const { streamChat } = require('../llm');
    // Collect the whole summary, THEN run the full finalize pass before sending — identical to the
    // non-streaming /summarize and the in-app summary. A summary of an untrusted document can echo control
    // characters or exfil markup, or be coaxed into leaking the fixed rules; because the output is buffered
    // here (not forwarded token by token), finalize can strip the exfil AND decline a leak AND correct a stated
    // arithmetic slip, with no streaming trade-off. The disconnect signal is threaded into streamChat so a
    // client that leaves aborts generation at the provider, not just the consumer loop (parity with non-stream).
    if (!(await emitFinalizedSSE(res, streamChat(reqObj.messages, { signal: ac.signal }), ac.signal))) return;
  } catch (e) {
    fail(res, e, 'summarize', { message: 'Summarize failed' });
  } finally {
    _genGate.release();
  }
});

// ── POST /api/v1/synthesize ──────────────────────────────────────────────────
// Whole-workspace synthesis: an overview across ALL documents in a workspace — the
// "brief me on this workspace / what are the common themes across these sources"
// research capability. Requires the 'summarize' scope (it's a summarization over the
// whole set). Body: { workspace?, focus? } where focus is an optional angle to steer
// the synthesis. Supports one-shot JSON or SSE streaming (stream:true or Accept:
// text/event-stream), mirroring /summarize.
//
// This can be slow on a large workspace — it summarizes each document, then
// synthesizes — so it runs those steps sequentially and never fires parallel model
// calls. Callers should expect a longer wait than a single query.
router.post('/synthesize', async (req, res) => {
  if (!requireScope(req, res, 'summarize')) return;
  const body = req.body || {};
  const focus = typeof body.focus === 'string' ? body.focus : '';
  if (focus.length > MAX_QUERY_CHARS) return res.status(400).json({ error: `focus exceeds ${MAX_QUERY_CHARS} characters` });

  const ws = resolveWorkspace(req, res, body.workspace);
  if (!ws) return;

  const wantsStream = body.stream === true || (req.get('accept') || '').includes('text/event-stream');

  // Cancel the expensive map-reduce when the client disconnects. Synthesis runs up to synthesisMaxDocs
  // sequential per-document model calls INSIDE this await, before the stream is returned — without a
  // signal a caller could fire many synthesize requests, disconnect, and leave them all running,
  // saturating the local model and stalling everyone else. runWorkspaceSynthesis honors the signal.
  const ac = disconnectSignal(res);
  if (!(await acquireGen(res))) return;
  try {
    if (ac.signal.aborted) return;   // client left while queued behind the gate — don't start work
    const { runWorkspaceSynthesis } = require('../api-core');
    const r = await runWorkspaceSynthesis(ws.id, focus, null, 'overview', ac.signal);

    if (r.status === 'warming') {
      return res.status(202).json({ workspace: ws.id, status: 'warming',
        note: 'This workspace is being prepared. Retry in a few seconds.' });
    }
    if (r.status === 'empty') {
      return res.status(409).json({ error: `Workspace '${ws.id}' has no documents to synthesize.` });
    }

    if (!wantsStream) {
      const collected = await drain(r.stream, ac.signal);
      if (collected === null) return;   // client disconnected
      const synthesis = require('../verify').finalize(collected);   // full pass: strip exfil, decline a leak, correct arithmetic
      return res.json({
        workspace: ws.id, synthesis,
        documentsSynthesized: r.docCount,
        totalDocuments: r.totalDocs,
        sampled: r.sampled,              // true when a representative sample was used
        documentsOmitted: r.omittedDocs,
        noiseFilesSkipped: r.skippedNoise, // license/config/image files excluded
      });
    }

    res.set(SSE_HEADERS);
    // Lead with a meta event so a streaming caller knows the scope and coverage.
    res.write(`event: meta\ndata: ${JSON.stringify({ workspace: ws.id, documentsSynthesized: r.docCount, totalDocuments: r.totalDocs, sampled: r.sampled, documentsOmitted: r.omittedDocs, noiseFilesSkipped: r.skippedNoise })}\n\n`);
    // Collect, then run the full finalize pass before sending (see /summarize for the rationale).
    if (!(await emitFinalizedSSE(res, r.stream, ac.signal))) return;
  } catch (e) {
    fail(res, e, 'synthesize', { message: 'Synthesis failed' });
  } finally {
    _genGate.release();
  }
});

// ── POST /api/v1/ingest-url ──────────────────────────────────────────────────
// Fetch a web page, extract its article, and add it as a document to a workspace.
// Requires the 'write' scope. Targets the named workspace (defaults to 'default'),
// independent of the UI. If that workspace is the UI's active one, the new document
// is indexed immediately; otherwise the file is written and the workspace's cached
// bundle is invalidated so the next query/load picks it up.
// The browser clipper POSTs from the page's own origin (e.g. example.com) to this
// local endpoint, which is cross-origin — so the response carries CORS headers (the
// preflight is handled by the router-level OPTIONS bypass above). The API key is
// still required, so opening this up doesn't let an anonymous site write; it only
// lets a key-holder's clipper reach Lokyni from any tab.
router.post('/ingest-url', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (!requireScope(req, res, 'write')) return;
  // Ingesting writes a document and reindexes the SHARED store, so it is a primary-only operation (the UI
  // document routes are all requirePrimary too). Refuse on a read replica rather than racing the primary.
  if (require('../cluster').isReplica()) return res.status(409).json({ ok: false, error: 'This instance is a read replica. Ingest on the primary.' });
  const body = req.body || {};
  const url  = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'url is required' });

  const ws = resolveWorkspace(req, res, body.workspace);
  if (!ws) return;

  // Abort the (browser-backed) fetch if the client walks away, so the scarce browser slot frees
  // immediately instead of being held until the navigation timeout — matching the disconnect-abort the
  // summarize/synthesize/chat endpoints already do.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const wsm  = require('../workspaces');
    const cfg  = require('../config');
    const state = require('../state');
    const { fetchAndSaveArticle, saveProvidedContent } = require('../urlfetch');

    // Write into the TARGET workspace's documents dir (not necessarily the active one).
    const docsDir = wsm.docsDirFor(cfg.DATA_DIR, ws.id);

    // If the caller provided page content (a browser clipper reading the live,
    // authenticated DOM), save that directly — it can capture pages behind a login
    // that a server-side fetch never could. Otherwise fetch the URL ourselves.
    // Bound the provided clip before the synchronous HTML strip/extract runs on the event loop. The
    // JSON body limit is generous (megabytes); processing that much markup through several regex passes
    // would stall the loop for other requests, so cap it well below the body limit (still ample for an
    // article).
    const CLIP_MAX_CHARS = 2_000_000;
    const clipHtml = typeof body.html === 'string' ? body.html.slice(0, CLIP_MAX_CHARS) : body.html;
    const clipText = typeof body.text === 'string' ? body.text.slice(0, CLIP_MAX_CHARS) : body.text;
    const hasContent = (typeof clipHtml === 'string' && clipHtml.trim())
                    || (typeof clipText === 'string' && clipText.trim());
    const { article, rel } = hasContent
      ? await saveProvidedContent({ url, title: body.title, html: clipHtml, text: clipText }, docsDir)
      : await fetchAndSaveArticle(url, docsDir, ac.signal);

    require('../audit').audit(req, 'api.ingest_url', ws.id, article.url || url);
    const isActive = ws.id === state.workspaceId;
    res.json({
      ok: true, workspace: ws.id, title: article.title, url: article.url,
      chars: article.text.length, file: rel,
      indexed: isActive ? 'immediate' : 'on-next-load',
      note: isActive ? undefined
        : 'Document saved. It will be indexed the next time this workspace is queried or opened.',
    });

    // Reflect the change through the shared, lock-serialized helper so this ingest can never race a
    // workspace switch, rebuild, or restore: it reindexes the active workspace or invalidates a non-active
    // one's cached bundle, deciding which at run time.
    await require('../indexing/init').reflectWorkspaceMutation(ws.id, (id) => require('../indexing/bundle').invalidateBundle(id));
  } catch (e) {
    fail(res, e, 'ingest-url', { status: 502, message: 'Could not ingest the URL', extra: { ok: false } });
  }
});

// ── GET /api/v1/workspaces ───────────────────────────────────────────────────
router.get('/workspaces', async (req, res) => {
  if (!requireScope(req, res, 'read')) return;
  try {
    const cfg = require('../config');
    const wsm = require('../workspaces');
    const ak  = require('../apikeys');
    // Only workspaces this key may use.
    const all = (await wsm.listWorkspacesAsync(cfg.DATA_DIR))
      .filter(w => ak.mayUseWorkspace(req.apiKey, w.id))
      .map(w => ({ id: w.id, name: w.name, documents: w.documents }));
    res.json({ workspaces: all });
  } catch (e) {
    fail(res, e, 'workspaces', { message: 'Could not list workspaces' });
  }
});

// ── GET /api/v1/documents?workspace=<id> ─────────────────────────────────────
router.get('/documents', async (req, res) => {
  if (!requireScope(req, res, 'read')) return;
  const ws = resolveWorkspace(req, res, req.query.workspace);
  if (!ws) return;
  try {
    const { listDocuments } = require('../api-core');
    // limit/offset are coerced to numbers; listDocuments clamps them, so a bad value can't return the whole
    // corpus or error. Number('') is 0 and Number(undefined) is NaN — both fall back to the default limit.
    const limit = req.query.limit != null && req.query.limit !== '' ? Number(req.query.limit) : undefined;
    const offset = req.query.offset != null && req.query.offset !== '' ? Number(req.query.offset) : undefined;
    const r = await listDocuments(ws.id, { limit, offset });
    if (r.status === 'warming') {
      return res.status(202).json({ workspace: ws.id, status: 'warming',
        note: 'This workspace is being prepared for its first API query. Retry in a few seconds.' });
    }
    res.json({ workspace: ws.id, documents: r.documents, total: r.total, offset: r.offset, limit: r.limit, nextOffset: r.nextOffset });
  } catch (e) {
    fail(res, e, 'documents', { message: 'Could not list documents' });
  }
});

// ── POST /api/v1/chat/completions ────────────────────────────────────────────
// OpenAI-compatible grounded chat. Lets any tool that speaks the OpenAI
// /v1/chat/completions shape point at Lokyni and get answers drawn ONLY from the
// indexed documents — cited, and candid when nothing matches — instead of raw model
// output. This is Lokyni's honesty wedge exposed as a drop-in API: the same grounded
// behavior as the web UI, reachable by existing OpenAI clients with a base-URL swap.
//
// Deliberately grounded-only: there is no passthrough/plain-chat mode. A caller who
// wants ungrounded model output can point at Ollama's own /v1 endpoint; they point at
// Lokyni specifically to get retrieval grounding. A `model` field in the request is
// accepted and echoed for client compatibility but does not select behavior — the
// workspace's configured model answers.
//
// Auth: same key system as the rest of /api/v1; requires the 'search' scope. Target a
// workspace with a top-level `workspace` field (defaults to 'default').
router.post('/chat/completions', async (req, res) => {
  if (!requireScope(req, res, 'search')) return;
  const ws = resolveWorkspace(req, res, req.body && req.body.workspace);
  if (!ws) return;

  const messages = req.body && req.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required (an array of {role, content})' });
  }
  const wantStream = req.body.stream === true;
  const model = (typeof req.body.model === 'string' && req.body.model) ? req.body.model : 'lokyni';
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  // Track client disconnect from before the gate, so a disconnect while QUEUED behind the generation gate is
  // caught (not just one during retrieval/streaming), and thread the signal into retrieval + generation so the
  // model is aborted at the provider — not left running for a caller who walked away, holding a slot until the
  // next token or the idle timeout. Both branches consult ac.signal.
  const ac = disconnectSignal(res);
  if (!(await acquireGen(res))) return;
  try {
    if (ac.signal.aborted) return;   // client left while queued behind the gate — don't start work

    const { runGroundedChat } = require('../api-core');
    const r = await runGroundedChat(ws.id, messages, { signal: ac.signal });
    if (ac.signal.aborted) return;   // client left during retrieval — don't start generating

    if (r.status === 'warming') {
      return res.status(202).json({ workspace: ws.id, status: 'warming',
        note: 'This workspace is being prepared for its first API query. Retry in a few seconds.' });
    }
    if (r.status === 'empty') {
      return res.status(409).json({ error: `Workspace '${ws.id}' has no indexed documents to answer from.` });
    }

    if (wantStream) {
      // OpenAI-style Server-Sent Events: a sequence of chat.completion.chunk objects,
      // each carrying a delta, terminated by [DONE].
      res.set(SSE_HEADERS);
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id, object: 'chat.completion.chunk', created, model };

      // First chunk carries the role, per the OpenAI streaming convention.
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

      // Collect the full answer and run the SAME deterministic verification the
      // non-streaming path applies (strip exfil, decline a system-prompt leak, correct a
      // stated arithmetic slip) BEFORE sending any content — a live token stream cannot
      // retract a leak once it has been emitted, so a raw pass-through would defeat the
      // very grounding guarantee the browser path enforces. The trade-off is that with
      // stream:true the verified answer is delivered when generation completes rather than
      // token by token. The disconnect signal (threaded into generation) aborts the model at the
      // provider for a caller who walked away.
      let answer = await drain(r.stream, ac.signal);
      if (answer === null) return;   // connection gone — nothing left to flush
      // Grounded miss with no content: surface a clear, honest answer rather than an empty
      // completion, so a caller always gets something usable.
      if (!answer && r.outOfScope) answer = OUT_OF_SCOPE_MESSAGE;
      else if (answer) answer = finalizeGrounded(answer, r.sources, r.idx);
      if (answer) send({ ...base, choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      // Non-standard but useful: attach the sources Lokyni used as a trailing event.
      if (Array.isArray(r.sources) && r.sources.length) {
        send({ ...base, lokyni_sources: r.sources.map(s => ({ id: s.id, source: s.source })) });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Non-streaming: collect the full answer and return one chat.completion object. The disconnect signal
    // (threaded into generation) aborts the model at the provider when the client leaves, so a caller who walked
    // away doesn't leave a generation running and holding a concurrency slot.
    let answer = await drain(r.stream, ac.signal);
    if (answer === null) return;   // connection gone — nothing to return
    if (!answer && r.outOfScope) {
      answer = OUT_OF_SCOPE_MESSAGE;
    } else if (answer) {
      // Same deterministic verification the browser gets (strip exfil, correct a stated arithmetic slip,
      // decline a system-prompt leak), plus the invented-citation and numeric-grounding caveats — full parity
      // with the in-app answer path, via the single-sourced sequence so a new safeguard can't miss this egress.
      answer = finalizeGrounded(answer, r.sources, r.idx);
    }
    return res.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      // Lokyni extension: the documents the answer was grounded in (empty on a miss).
      lokyni_sources: (r.sources || []).map(s => ({ id: s.id, source: s.source })),
      lokyni_grounded: !r.outOfScope,
    });
  } catch (e) {
    fail(res, e, 'chat/completions', { message: 'Chat completion failed' });
  } finally {
    _genGate.release();
  }
});

module.exports = router;
