'use strict';
// Security guard for the MCP server surface (lib/mcp/server.js), which was entirely untested. The MCP
// tools are gated by the SAME scope/workspace model as the HTTP API, but through a different code path,
// and the watchdog's api_scope_coverage only audits the HTTP ROUTE_SCOPES contract — not these tool
// gates. The invariant that must never regress: over the NETWORK a key is required and its scopes are
// enforced; only trusted stdio (no key) is unrestricted. The tool handlers run inside the MCP SDK and
// aren't cleanly invokable in isolation, so this is a source-inspection guard (the codebase's drift-guard
// style) plus a functional check of the shared workspace-authorization the tools rely on. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'server.js'), 'utf-8');
const { hasScope } = require(path.join(PROJECT, 'lib', 'apikeys'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── The scope gate: trusted stdio (no key) is unrestricted; a network key is enforced ──
  ok(/const hasScope = \(scope\) => !apiKey \|\| ak\.hasScope\(apiKey, scope\)/.test(src),
    'the tool scope gate short-circuits ONLY for a null (stdio) key, else defers to the key scopes');

  // ── The tool→scope contract is declarative (TOOL_SCOPES) and enforced by a wrapper that refuses to register
  //    a tool with no scope, so no tool can ship ungated. The scope check lives once in registerScopedTool. ──
  const mcp = require(path.join(PROJECT, 'lib', 'mcp', 'server'));
  for (const [tool, scope] of [['search_documents', 'search'], ['summarize_document', 'summarize'], ['list_documents', 'read'], ['list_workspaces', 'read']]) {
    ok(new RegExp(`'${tool}'`).test(src), `${tool} is registered`);
    ok(mcp.TOOL_SCOPES[tool] === scope, `${tool} declares the '${scope}' scope in TOOL_SCOPES`);
    ok(new RegExp(`registerScopedTool\\('${tool}'`).test(src), `${tool} registers through the scope-enforcing wrapper`);
  }
  ok(/const scope = TOOL_SCOPES\[name\];\s*\n\s*if \(!scope\) throw/.test(src),
    'registerScopedTool refuses to register a tool with no declared scope (no ungated tool can ship)');
  ok(/if \(!hasScope\(scope\)\) return errorResult\(`This key lacks the "\$\{scope\}" scope\.`\)/.test(src),
    'the wrapper checks the declared scope and returns an error result when the key lacks it');
  // The boot-time watchdog validates the MCP scope names against the real scope set (parity with ROUTE_SCOPES).
  const wdSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'watchdog.js'), 'utf-8');
  ok(/require\('\.\/mcp\/server'\)\.TOOL_SCOPES/.test(wdSrc) && /MCP tool "\$\{tool\}" declares unknown scope/.test(wdSrc),
    'the api_scope_coverage watchdog audits the MCP TOOL_SCOPES names too');

  // ── list_workspaces restricts the listing to the key's allowed workspaces via the SHARED authz helper (same
  //    as REST /workspaces), so the filter can't drift from the policy — not an open-coded duplicate ──
  ok(/if \(apiKey\) list = list\.filter\(w => ak\.mayUseWorkspace\(apiKey, w\.id\)\)/.test(src),
    'list_workspaces filters to the key\'s allowed workspaces through the shared ak.mayUseWorkspace gate');

  // ── search_documents rejects an empty query, at parity with REST /search ──
  ok(/query: z\.string\(\)\.min\(1[^)]*\)/.test(src), 'search_documents requires a non-empty query (min(1)), matching REST');

  // ── The tools authorize the workspace through the shared resolveAccess gate ──
  ok(/wsm\.resolveAccess\(dataDir, requested, apiKey\)/.test(src), 'MCP workspace access goes through the shared resolveAccess gate');

  // ── The network transport requires a key: a missing/invalid key is 401 BEFORE the server is built ──
  const mountAt = src.indexOf('const mountHttp');
  const mountBlock = src.slice(mountAt, mountAt + 700);
  const authAt = mountBlock.indexOf('authenticate(');
  const status401At = mountBlock.indexOf('status(401)');
  const buildAt = mountBlock.indexOf('buildServer(record)');
  ok(authAt !== -1 && status401At !== -1, 'network MCP authenticates and can answer 401');
  ok(status401At < buildAt || buildAt === -1, 'the 401 is returned before the server is built for the request');
  ok(/auditAuthFail\(/.test(mountBlock), 'a failed network MCP auth is written to the audit trail');
  ok(/ratelimit/.test(src) && /status\(429\)/.test(src), 'network MCP is rate-limited like the HTTP API');

  // ── Functional cross-check: the scope helper the gate delegates to actually enforces scopes ──
  ok(hasScope({ scopes: ['search'] }, 'search') === true, 'hasScope grants a held scope');
  ok(hasScope({ scopes: ['read'] }, 'summarize') === false, 'hasScope denies a scope the key lacks');

  // ── the generation tools forward the request's abort signal so a disconnecting client frees the slot ──
  ok(/async \(\{ query, workspace, k \}, extra\)/.test(src) && /runSearch\(ws\.id, query, k, \{ signal: extra\?\.signal \}\)/.test(src),
    'search_documents forwards extra.signal into runSearch');
  ok(/async \(\{ docId, workspace \}, extra\)/.test(src) && /runSummarize\(ws\.id, docId, \{ signal: extra\?\.signal \}\)/.test(src),
    'summarize_document forwards extra.signal into runSummarize (which threads it into the completion)');
  console.log('✓ mcp-server: generation tools forward the client abort signal to free the gen slot on disconnect');

  // ── Errors are classified and never swallowed-as-busy or leaked raw ──
  // A bare `catch { return busy }` conflated a real failure (provider down, a bug) with transient
  // backpressure and logged nothing; a thrown error.message could also leak to the client. failResult maps
  // ONLY backpressure to "busy", logs anything else via console.error (stderr — never stdout, the JSON-RPC
  // channel — in both modes, and captured by the in-app log viewer in the web server), and returns a generic
  // message. Every tool handler is wrapped so no throw escapes unlogged/leaked.
  ok(/const failResult = \(where, e\) =>/.test(src), 'a shared failResult helper classifies errors');
  ok(/if \(e && e\.backpressure\) return errorResult\('The server is busy/.test(src), 'only a backpressure rejection maps to a transient "busy"');
  ok(/console\.error\(`\[mcp\] \$\{where\} failed:/.test(src), 'a real error is logged via console.error (stderr, never the stdout protocol channel; captured by the in-app viewer in the server)');
  ok(!/catch \{ return errorResult\('The server is busy/.test(src), 'the old bare catch that swallowed every error as "busy" is gone');
  const wrapped = (src.match(/\} catch \(e\) \{ return failResult\(/g) || []).length;
  ok(wrapped === 4, `all four tool handlers wrap their body and route a throw through failResult (found ${wrapped})`);
  console.log('✓ mcp-server: real errors are logged (stderr) and genericized, not swallowed as "busy" or leaked');

  // ── The stdio console redirect covers console.debug (a stray debug line would corrupt the JSON-RPC stream) ──
  const entry = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
  ok(/console\.debug = console\.log;/.test(entry), 'the --mcp path redirects console.debug to stderr, not just log/info');
  console.log('✓ mcp-server: the stdio path keeps stdout clean (console.debug redirected too)');

  console.log('✓ mcp-server: tools are scope-gated, workspace-authorized, and network access requires a key');
  console.log(`\nALL MCP-SERVER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MCP-SERVER UNIT TEST FAILED:', e.message);
  process.exit(1);
}
