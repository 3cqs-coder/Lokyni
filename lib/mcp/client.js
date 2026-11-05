'use strict';
// MCP client for ingestion (Direction B). Lokyni connects OUT to an MCP server
// (e.g. the official @modelcontextprotocol/server-filesystem), lists its tools, and
// calls them to pull documents in.
//
// This is a focused client, not a general agent tool-runner. The robustness pattern
// — spawn stdio transport, wire crash/error handlers before connecting, connect and
// listTools under a timeout, callTool under a timeout — is kept deliberately minimal:
// connect reliably, call a tool, get a result, disconnect. No agent-loop coupling.

let Client, StdioClientTransport;
const loadSdk = () => {
  if (Client) return true;
  try {
    Client = require('@modelcontextprotocol/sdk/client/index.js').Client;
    StdioClientTransport = require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
    return true;
  } catch (e) {
    console.error('[mcp-client] MCP SDK not installed — run `npm install`.', e.message);
    return false;
  }
};

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS     = 60_000;

// Every live connector transport, tracked so shutdown can tear its spawned child down. A connector server
// is an UNTRUSTED spawned OS process (see the env note below), so — exactly like the URL-ingestion browsers
// and the parse children — it must have an unconditional exit-kill backstop, not only the per-call finally
// in connectors.js. The normal path (a completed/failed/timed-out sync) closes via close() below; this set
// covers the abrupt paths — a crash, a bare process.exit(), or the shutdown hard-timeout firing while a sync
// is still awaiting a pull — where that finally never runs and the child would otherwise orphan.
const liveTransports = new Set();

// A spawned connector server is UNTRUSTED (and so is every transitive dependency it loads), so it must NOT
// inherit Lokyni's whole environment — which, depending on how the operator launched the app, can hold provider
// keys, cloud credentials, or other secrets. Pass only what npx/node need to resolve and run, plus the
// connector's own declared env (spec.env, e.g. its GitHub token). Anything else the operator's shell holds stays
// out of the child.
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'USER', 'LOGNAME', 'NODE_PATH', 'NODE_OPTIONS'];
const WIN_ENV_KEYS  = ['SystemRoot', 'windir', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
const minimalEnv = (extra) => {
  const out = {};
  const keys = process.platform === 'win32' ? [...BASE_ENV_KEYS, ...WIN_ENV_KEYS] : BASE_ENV_KEYS;
  for (const k of keys) if (process.env[k] !== undefined) out[k] = process.env[k];
  // npm/npx + node operational config (registry, cache, prefix, proxy…) so `npx -y` can resolve and run — but
  // not arbitrary secrets. These prefixes are operational, never credential stores.
  for (const k of Object.keys(process.env)) if (/^(npm_config_|npm_|NODE_|NPM_)/i.test(k) && out[k] === undefined) out[k] = process.env[k];
  return { ...out, ...(extra || {}) };
};

// Redact the connector's own secret values (e.g. its token, passed via spec.env) from captured stderr before it
// is embedded in an error, persisted to settings, or written to the audit log — in case a server ever echoes a
// credential in a usage/debug line. Only values long enough to be a real secret are scrubbed.
const scrubSecrets = (line, secrets) => {
  let s = String(line);
  for (const v of secrets) if (typeof v === 'string' && v.length >= 6) s = s.split(v).join('[redacted]');
  return s;
};

// Reject a promise if it doesn't settle within ms. Borrowed pattern — a hung MCP
// server must never hang Lokyni. `onTimeout` (optional) runs when the timer fires, before
// the rejection, so a cancellable operation can be actively aborted rather than abandoned.
const withTimeout = (promise, ms, message, onTimeout) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { try { if (onTimeout) onTimeout(); } catch { /* best-effort cancel */ } reject(new Error(message)); }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Run an SDK request under a timeout that actually CANCELS it. `fn` receives an AbortSignal to hand to
// the SDK call; if the timeout wins the race we abort, so the SDK rejects the pending request AND tells
// the server (notifications/cancelled) — instead of leaving the request in flight until the whole
// connection is torn down. Keeps a hung or slow server from tying up a request slot after we've moved on.
const withCancelTimeout = (fn, ms, message) => {
  const ac = new AbortController();
  return withTimeout(fn(ac.signal), ms, message, () => ac.abort(new Error(message)));
};

// Connect to an MCP server over stdio. `spec` = { command, args, env, cwd }.
// Returns a live { client, transport, tools, close() } or throws. Caller owns the
// connection and must call close() when done — for ingestion we connect, pull, and
// disconnect per run rather than holding a long-lived process.
const connect = async (spec) => {
  if (!loadSdk()) throw new Error('MCP SDK not available');

  const transport = new StdioClientTransport({
    command: spec.command,
    args:    spec.args || [],
    env:     minimalEnv(spec.env),
    cwd:     spec.cwd || undefined,
    stderr:  'pipe',
  });

  // Capture stderr for diagnostics — a misconfigured server (wrong path, missing package) usually explains
  // itself there — with the connector's own secret values scrubbed before they can reach an error/settings/audit.
  const secretVals = Object.values(spec.env || {});
  const stderrLines = [];
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) stderrLines.push(scrubSecrets(line, secretVals));
      if (stderrLines.length > 50) stderrLines.splice(0, stderrLines.length - 50);
    });
  }
  let closed = false;
  transport.onerror = (err) => console.error('[mcp-client] transport error:', err.message || err);

  const client = new Client({ name: 'lokyni-ingest', version: require('../../package.json').version });

  try {
    await withCancelTimeout((signal) => client.connect(transport, { signal }), CONNECT_TIMEOUT_MS,
      `MCP connect timed out after ${CONNECT_TIMEOUT_MS}ms` +
      (stderrLines.length ? ` — server said: ${stderrLines.slice(-3).join(' | ')}` : ''));

    const toolsRes = await withCancelTimeout((signal) => client.listTools(undefined, { signal }), CONNECT_TIMEOUT_MS, 'MCP tools/list timed out');

    // Connected: track the transport so an abrupt exit can still kill the spawned child.
    liveTransports.add(transport);
    return {
      client, transport,
      tools: toolsRes.tools || [],
      stderr: () => stderrLines.slice(),
      // Call a tool by name; result content is the raw MCP content array. The timeout cancels the
      // in-flight request (AbortSignal) so a slow tool can't keep a request slot after we give up.
      callTool: (name, args) => withCancelTimeout(
        (signal) => client.callTool({ name, arguments: args || {} }, undefined, { signal }),
        CALL_TIMEOUT_MS, `MCP call "${name}" timed out after ${CALL_TIMEOUT_MS}ms`),
      close: async () => { if (closed) return; closed = true; liveTransports.delete(transport); try { await client.close(); } catch {} try { await transport.close(); } catch {} },
    };
  } catch (e) {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    const detail = stderrLines.length ? ` (server stderr: ${stderrLines.slice(-3).join(' | ')})` : '';
    throw new Error((e.message || String(e)) + detail);
  }
};

// Pull the text out of an MCP tool result's content array. `maxChars` (optional, 0 = unbounded) caps the joined
// string so one pathological response from an UNTRUSTED connector server can't be materialized unbounded here
// (and then copied again by a decode step) before the caller's size checks run — defense in depth over the
// aggregate per-file/total caps, which bound accumulation across files but not a single giant response.
const textOf = (result, maxChars = 0) => {
  const s = (result?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return (maxChars > 0 && s.length > maxChars) ? s.slice(0, maxChars) : s;
};

// Graceful shutdown: close every live transport (which terminates its spawned child). Async, so it runs
// in the ordered shutdown phase. A transport already closed by its own finally is simply not in the set.
const closeAllConnectors = async () => {
  await Promise.all([...liveTransports].map(async (transport) => {
    try { await transport.close(); } catch { /* best-effort */ }
    finally { liveTransports.delete(transport); }
  }));
};

// Last-ditch, synchronous, unconditional SIGKILL of every tracked connector child AND its descendants. Wired to
// the process 'exit' event: closeAllConnectors above is async and cannot complete on a synchronous exit (a
// process.exit() with no signal, or the shutdown hard timeout firing mid-sync), which would orphan the untrusted
// child. The connector is spawned by the MCP SDK WITHOUT `detached`, so it is not its own process-group leader —
// a group kill keyed on its pid is a no-op and would leave a grandchild (e.g. the `node` server a `npx` launcher
// forks) orphaned on Unix. killProcessTreeSync walks the descendants instead, mirroring Windows `taskkill /T`, so
// nothing is orphaned on any platform. Idempotent and safe after a graceful close — a dead pid is a harmless no-op.
const { killProcessTreeSync } = require('../killtree');
const killAllConnectorsSync = () => {
  for (const transport of liveTransports) {
    try { if (transport.pid != null) killProcessTreeSync(transport.pid); } catch { /* best-effort */ }
  }
  liveTransports.clear();
};

module.exports = { connect, textOf, loadSdk, closeAllConnectors, killAllConnectorsSync,
  // Internals exposed for tests (underscore convention).
  _withTimeout: withTimeout, _withCancelTimeout: withCancelTimeout, _liveTransports: liveTransports };
