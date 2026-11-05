'use strict';
// Lokyni as an MCP server — lets MCP-speaking clients (Claude Desktop, Cursor,
// agents) search and summarize a Lokyni corpus as tools, without the documents
// leaving the machine.
//
// Two transports:
//   - stdio: how Claude Desktop launches Lokyni as a subprocess. The caller is a
//     local process running AS THE USER, so it's trusted — no API key required.
//   - streamable HTTP (network): reachable over the network, so it REQUIRES an API
//     key (Bearer / x-api-key), authorized exactly like the /api/v1 routes.
//
// Tools are thin wrappers over lib/api-core (the same functions /api/v1 uses), so
// search/summarize behave identically across HTTP and MCP.

let McpServer, StdioServerTransport, StreamableHTTPServerTransport, z;
const loadSdk = () => {
  if (McpServer) return true;
  try {
    McpServer = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    StdioServerTransport = require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport;
    StreamableHTTPServerTransport = require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport;
    z = require('zod');
    return true;
  } catch (e) {
    console.error('[mcp] MCP SDK not installed — run `npm install`. MCP server disabled.', e.message);
    return false;
  }
};

const core = require('../api-core');
const wsm  = require('../workspaces');
// Model-backed tools (search, summarize) draw a slot from the shared, process-wide generation gate — the
// same one the HTTP API uses — so concurrent MCP calls can't saturate the single local model and stall
// every other caller. run() always releases; a full queue rejects fast and we answer "busy".
const genGate = require('../gengate');

// The one scope each tool requires — the MCP counterpart to apiv1's ROUTE_SCOPES, so the tool→scope contract
// is declarative and auditable (the boot-time watchdog validates these names against apikeys.ALL_SCOPES, and
// registerScopedTool below refuses to register a tool that has no entry here). Keep in sync with what the HTTP
// API requires for the equivalent operation.
const TOOL_SCOPES = {
  search_documents:   'search',
  summarize_document: 'summarize',
  list_documents:     'read',
  list_workspaces:    'read',
};

// Resolve + authorize a workspace for an MCP call. `apiKey` is the authenticated
// key record for network transport, or null for stdio (trusted local). Returns
// { ok: true, id } or { ok: false, error }.
// Shared with the HTTP API so the id / existence / key-permission checks stay identical.
const resolveWorkspace = (dataDir, requested, apiKey) => wsm.resolveAccess(dataDir, requested, apiKey);

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

// Map a thrown error to a client-safe tool result. A semaphore backpressure rejection is the only transient
// "busy" case; ANYTHING else (the embeddings/LLM provider down, a native-module error, a bug) is a real
// failure that must NOT be reported as transient "busy" (an agent would retry a permanent failure forever)
// and must NOT leak its raw message (a filesystem path, a stack fragment) to the MCP client. Log the real
// error with console.error so the operator can diagnose, and return a fixed generic message. console.error
// goes to STDERR — never stdout, which is the JSON-RPC protocol channel — in BOTH modes: in stdio mode it is
// the default stream (stdout is left for the protocol), and in the web server it also flows through the log
// capture into the in-app log viewer, so a desktop-app operator sees MCP tool failures too. Mirrors fail().
const failResult = (where, e) => {
  if (e && e.backpressure) return errorResult('The server is busy — please try again shortly.');
  try { console.error(`[mcp] ${where} failed: ${(e && e.message) || e}`); } catch (_) {}
  return errorResult('The request could not be completed.');
};

// Build an McpServer with Lokyni's tools registered. `apiKey` scopes/authorizes
// calls for network transport; pass null for trusted stdio.
const buildServer = (apiKey = null) => {
  if (!loadSdk()) throw new Error('MCP SDK not available');
  const cfg = require('../config');
  const ak  = require('../apikeys');
  const server = new McpServer({ name: 'lokyni', version: require('../../package.json').version });

  const hasScope = (scope) => !apiKey || ak.hasScope(apiKey, scope);

  // Register a tool with its scope check wired from TOOL_SCOPES, so no tool can ship without a declared scope:
  // a name missing from TOOL_SCOPES throws here at build time (loud), rather than silently exposing an ungated
  // tool. The scope gate runs before the handler; stdio (apiKey=null) satisfies hasScope by design.
  const registerScopedTool = (name, def, handler) => {
    const scope = TOOL_SCOPES[name];
    if (!scope) throw new Error(`MCP tool "${name}" has no scope declared in TOOL_SCOPES — refusing to register an ungated tool`);
    server.registerTool(name, def, async (args, extra) => {
      if (!hasScope(scope)) return errorResult(`This key lacks the "${scope}" scope.`);
      return handler(args, extra);
    });
  };

  registerScopedTool('search_documents', {
    title: 'Search documents',
    description: 'Search a Lokyni workspace for passages relevant to a query. Returns grounded passages from the user\'s private documents. Use this to answer questions from the user\'s own knowledge base.',
    inputSchema: {
      // min(1): reject an empty query, at parity with REST /search (which returns "query is required") — the
      // schema declares the bound so the SDK rejects it uniformly rather than the core quietly returning nothing.
      query: z.string().min(1, 'query is required').describe('The search query or question'),
      workspace: z.string().optional().describe('Workspace id to search (default: "default")'),
      k: z.number().int().min(1).optional().describe('Max passages to return (default 5; clamped to 20)'),
    },
  }, async ({ query, workspace, k }, extra) => {
    try {
      const ws = resolveWorkspace(cfg.DATA_DIR, workspace, apiKey);
      if (!ws.ok) return errorResult(ws.error);
      // extra.signal aborts when the MCP client cancels or its transport closes, so a walked-away caller
      // frees the shared generation slot instead of holding it until the work finishes on its own.
      const r = await genGate.run(() => core.runSearch(ws.id, query, k, { signal: extra?.signal }));
      if (r.status === 'warming') return textResult(`Workspace "${ws.id}" is warming up (first query builds its cache). Retry in a few seconds.`);
      if (r.status === 'empty')   return textResult(`Workspace "${ws.id}" has no documents.`);
      if (r.passages.length === 0) return textResult('No relevant passages found.');
      const body = r.passages.map((p, i) => `[${i + 1}] ${p.source}\n${p.content}`).join('\n\n');
      return textResult(body);
    } catch (e) { return failResult('search_documents', e); }
  });

  registerScopedTool('summarize_document', {
    title: 'Summarize a document',
    description: 'Summarize a single document in a Lokyni workspace, identified by its docId (from search_documents results or list_documents).',
    inputSchema: {
      docId: z.string().describe('The document id to summarize'),
      workspace: z.string().optional().describe('Workspace id (default: "default")'),
    },
  }, async ({ docId, workspace }, extra) => {
    try {
      const ws = resolveWorkspace(cfg.DATA_DIR, workspace, apiKey);
      if (!ws.ok) return errorResult(ws.error);
      // Forward the request's abort signal so a disconnecting client stops the LLM summarization and frees
      // the shared generation slot immediately (runSummarize threads it into the streamed completion).
      const r = await genGate.run(() => core.runSummarize(ws.id, docId, { signal: extra?.signal }));
      if (r.status === 'warming')   return textResult(`Workspace "${ws.id}" is warming up. Retry in a few seconds.`);
      if (r.status === 'not_found') return errorResult(`No document with id ${docId} in workspace ${ws.id}.`);
      if (r.status === 'empty')     return textResult(`${r.source} appears to be empty.`);
      return textResult(`Summary of ${r.source}:\n\n${r.summary}`);
    } catch (e) { return failResult('summarize_document', e); }
  });

  registerScopedTool('list_documents', {
    title: 'List documents',
    description: 'List the documents in a Lokyni workspace (name, id, type, size).',
    inputSchema: {
      workspace: z.string().optional().describe('Workspace id (default: "default")'),
      limit: z.number().int().min(1).max(core.LIST_MAX_LIMIT).optional().describe(`Max documents to return (default ${core.LIST_DEFAULT_LIMIT})`),
      offset: z.number().int().min(0).optional().describe('Number of documents to skip, for paging'),
    },
  }, async ({ workspace, limit, offset }) => {
    try {
      const ws = resolveWorkspace(cfg.DATA_DIR, workspace, apiKey);
      if (!ws.ok) return errorResult(ws.error);
      const r = await core.listDocuments(ws.id, { limit, offset });
      if (r.status === 'warming') return textResult(`Workspace "${ws.id}" is warming up. Retry in a few seconds.`);
      if (r.total === 0) return textResult(`Workspace "${ws.id}" has no documents.`);
      let body = r.documents.map(d => `- ${d.name} (${d.fileType || '?'}, ${d.size} chars) — id: ${d.docId}`).join('\n');
      // Bound the tool result: say what was shown and how to page, rather than emitting the whole corpus.
      if (r.nextOffset != null) body += `\n\nShowing ${r.offset + 1}-${r.offset + r.documents.length} of ${r.total}. For the next page, call again with offset: ${r.nextOffset}.`;
      return textResult(body);
    } catch (e) { return failResult('list_documents', e); }
  });

  registerScopedTool('list_workspaces', {
    title: 'List workspaces',
    description: 'List the available Lokyni workspaces (document collections).',
    inputSchema: {},
  }, async () => {
    try {
      let list = await wsm.listWorkspacesAsync(cfg.DATA_DIR, { withCounts: false });  // names only — skip the disk walk
      // A key restricted to specific workspaces only sees those — via the SHARED authz helper (the same one REST
      // /workspaces uses), so the filter can't drift from the policy if it ever gains a clause. For stdio (no key)
      // apiKey is null and the full list is returned (trusted local caller).
      if (apiKey) list = list.filter(w => ak.mayUseWorkspace(apiKey, w.id));
      if (!list.length) return textResult('No workspaces.');
      return textResult(list.map(w => `- ${w.id}${w.name && w.name !== w.id ? ` (${w.name})` : ''}`).join('\n'));
    } catch (e) { return failResult('list_workspaces', e); }
  });

  return server;
};

// ── stdio entry ──────────────────────────────────────────────────────────────
// Run Lokyni as an MCP server over stdio (trusted local caller, no key). This is
// what Claude Desktop / Cursor launch. Invoked via `node lokyni.js --mcp`.
const runStdio = async () => {
  if (!loadSdk()) process.exit(1);
  const server = buildServer(null);   // stdio = trusted, no key
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to log to; stdout is the MCP protocol channel.
  console.error('[mcp] Lokyni MCP server running on stdio');
};

// ── network (streamable HTTP) entry ──────────────────────────────────────────
// Mount an authenticated MCP endpoint on the existing HTTP server. Every request
// must carry a valid API key (Bearer / x-api-key) — network transport is NOT
// trusted the way stdio is. Called from server.js with the Express app.
const mountHttp = (app, mountPath = '/mcp') => {
  if (!loadSdk()) return;
  const ak = require('../apikeys');
  const cfg = require('../config');

  app.post(mountPath, async (req, res) => {
    const record = ak.authenticate(cfg.DATA_DIR, ak.extractKey(req));
    if (!record) {
      require('../audit').auditAuthFail(req, 'mcp.auth_fail', mountPath, 'invalid or missing API key');
      return res.status(401).json({ error: 'Invalid or missing API key (network MCP requires a key)' });
    }

    // Per-key rate limiting, same as the HTTP API — including the advisory RateLimit-* headers on every
    // response (not just Retry-After on a 429), so a client sees its remaining budget exactly as on /api/v1.
    try {
      const rl = require('../ratelimit');
      const result = rl.check(record);
      if (result.limit !== 0) {
        res.set('RateLimit-Limit', String(result.limit));
        res.set('RateLimit-Remaining', String(result.remaining === Infinity ? result.limit : result.remaining));
        res.set('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
      }
      if (!result.allowed) {
        res.set('Retry-After', String(Math.ceil(result.resetMs / 1000)));
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
    } catch { /* limiter best-effort */ }

    // Record the key as used, exactly as the HTTP API does — otherwise a key used only through the
    // network MCP endpoint always shows "never used" in Settings and looks safe to revoke. The write
    // is throttled to about once a minute per key, so it adds no hot-path cost.
    try { ak.touchLastUsed(cfg.DATA_DIR, record.id); } catch { /* best-effort */ }

    try {
      const server = buildServer(record);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { try { transport.close(); server.close(); } catch {} });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] http request failed:', e.message || e);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  require('../logbuffer').debug(`🔌 MCP endpoint mounted at ${mountPath} (API key required)`);
};

module.exports = { runStdio, mountHttp, buildServer, TOOL_SCOPES };
