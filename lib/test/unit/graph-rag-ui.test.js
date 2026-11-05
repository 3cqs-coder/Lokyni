'use strict';
// Guards the knowledge-graph (useGraphRag) control surface so it can't drift or regress: the Settings
// markup, the client wiring, the CSS classes it relies on, and the server routes and config plumbing.
// A regression that renames an id, uses an undefined button class, hides the actions row with an inline
// style instead of the shared .hidden class, or drops a route then fails the build rather than shipping
// a broken or unthemed control. No model or network — pure source inspection. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const chatEjs = read('lib/views/chat.ejs');
  const chatJs  = read('lib/public/js/chat.js');
  const css     = read('lib/public/css/app.css');
  const server  = read('lib/server.js');
  const config  = read('lib/config.js');

  // ── Markup: the toggle, the actions row, and the build button ──
  ok(/id="cfg-graph-rag"[^>]*type="checkbox"/.test(chatEjs), 'the Knowledge graph checkbox exists');
  ok(/<label\s+for="cfg-graph-rag"/.test(chatEjs), 'its label is associated with the checkbox via for= (click-to-toggle + a11y)');
  ok(/id="cfg-graph-rag-actions"[^>]*class="[^"]*\bhidden\b/.test(chatEjs) ||
     /class="[^"]*\bhidden\b[^"]*"[^>]*id="cfg-graph-rag-actions"/.test(chatEjs),
     'the actions row starts hidden via the shared .hidden class, not an inline style');
  ok(!/id="cfg-graph-rag-actions"[^>]*style=/.test(chatEjs), 'the actions row uses no inline style (theme-safe, matches the codebase pattern)');
  ok(/id="btn-build-graph"[^>]*class="danger-btn"/.test(chatEjs) || /class="danger-btn"[^>]*id="btn-build-graph"/.test(chatEjs),
     'the Build button uses the shared danger-btn maintenance-button class');
  ok(/id="graph-rag-status"/.test(chatEjs), 'the status line element exists');

  // ── The classes the markup relies on are actually defined (the undefined-class regression) ──
  ok(/\.danger-btn\s*\{/.test(css), 'danger-btn is defined in the stylesheet');
  ok(/\.danger-btn:disabled\s*\{/.test(css), 'danger-btn has a disabled style (the Build button is disabled mid-build)');
  ok(/\.settings-row\.hidden\s*\{[^}]*display:\s*none/.test(css), '.settings-row.hidden collapses the actions row');

  // ── Client wiring ──
  ok(/const cfgGraphRag\s*=\s*document\.getElementById\('cfg-graph-rag'\)/.test(chatJs), 'the checkbox is looked up');
  ok(/function updateGraphRagActions\(\)/.test(chatJs), 'the show/hide helper exists');
  ok(/classList\.toggle\('hidden'/.test(chatJs), 'the actions row is toggled by the .hidden class, not element.style');
  ok(/function refreshGraphStatus\(\)/.test(chatJs) || /refreshGraphStatus\s*=/.test(chatJs), 'the status refresh helper exists');
  // Status must be fetched on initial config load when the feature is already on (not only on re-toggle).
  ok(/cfg\.useGraphRag === true;[^\n]*refreshGraphStatus\(\)/.test(chatJs), 'the status is refreshed on load when the toggle is already enabled');
  ok(/fetch\('\/api\/graph\/build'/.test(chatJs), 'the Build button posts to /api/graph/build');
  // Rebuilding can take a long time on a large library, so it confirms first (and reassures it is safe to leave —
  // the build runs in the background, checkpoints its progress, and resumes on the next launch).
  ok(/showConfirm\(\{\s*title: 'Rebuild the knowledge graph\?'/.test(chatJs), 'the Rebuild button confirms before starting a long build');
  // The Build button must enable the graph server-side FIRST — otherwise ticking the box and clicking Build
  // without pressing Save would fail with "The knowledge graph is not enabled."
  ok(/sendJSON\('\/api\/config', \{ useGraphRag: true \}\)/.test(chatJs), 'Build enables the graph server-side before building (works without a separate Save)');
  ok(/fetch\('\/api\/graph\/status'/.test(chatJs), 'status is polled from /api/graph/status');
  ok(/socket\.on\('graph_build'/.test(chatJs), 'the build-complete broadcast is handled');
  ok(/useGraphRag:\s*cfgGraphRag\.checked/.test(chatJs), 'the toggle is included in the settings save payload');

  // ── Server routes + config plumbing ──
  ok(/app\.post\('\/api\/graph\/build'/.test(server), 'the build route is mounted');
  // Turning the graph ON auto-starts the build (no separate Build click): one shared orchestration, fired on the
  // off→on transition, so the graph "just works" once enabled and then self-maintains via the per-delta refresh.
  ok(/function startGraphBuild\(\)/.test(server), 'there is one shared build orchestration (startGraphBuild)');
  ok(/before\.useGraphRag !== true && existing\.useGraphRag === true\) startGraphBuild\(\)/.test(server),
    'enabling the graph (off→on) auto-starts the background build');
  ok(/app\.get\('\/api\/graph\/status'/.test(server), 'the status route is mounted');
  ok(/broadcast\('graph_build'/.test(server), 'the server broadcasts graph_build on completion');
  ok(/const CONFIG_WRITABLE_KEYS = WRITABLE_KEYS;/.test(server) && /require\('\.\/settings-schema'\)/.test(server), 'useGraphRag is API-writable via the shared schema allowlist');
  ok(/useGraphRag:\s*cfg\.useGraphRag/.test(server), 'useGraphRag round-trips through GET /api/config');
  ok(/const useGraphRag\s*=\s*flag\('useGraphRag', providerConfig\.useGraphRag\)/.test(config), 'useGraphRag is read through the shared schema default');
  ok(/GRAPH_RAG_MODEL\s*=\s*providerConfig\.graphRagModel/.test(config), 'the extraction model override is read from config');

  console.log(`\nALL GRAPH-RAG-UI UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ GRAPH-RAG-UI UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
