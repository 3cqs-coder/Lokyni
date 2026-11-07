'use strict';
// Guards the hardening applied to the per-connection (per-window) workspace feature after its first
// landing: each window views a workspace independently, so everything that reads or writes per-workspace
// state must target the WINDOW's workspace, never whichever one happens to be active. Specifically:
//   • the semantic answer cache is scoped to the turn's workspace (a cross-workspace answer leak fix),
//   • a workspace parameter must name an EXISTING workspace (a valid-format id alone can't create orphans),
//   • a non-active document/folder change reconciles that workspace's on-disk index so it takes effect,
//   • the bundle cache is memory-aware and its background warms are concurrency-bounded and never wedge,
//   • persona and indexed-folder editing are per-window, and the panel re-syncs on a workspace change.
//
// Functional where the code is pure/exported; source-inspection drift guards for the socket closure and
// the routes. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  const socketSrc = read('lib/socket.js');
  const bundleSrc = read('lib/indexing/bundle.js');
  const serverSrc = read('lib/server.js');
  const chatSrc   = read('lib/public/js/chat.js');
  const docsSrc   = read('lib/routes/documents.js');
  const viewerSrc = read('lib/routes/viewer.js');
  const relatedSrc = read('lib/public/js/viewer-related.js');

  // ── S1: the semantic answer cache is scoped to the turn's workspace (no cross-workspace leak) ──
  const sc = require(path.join(PROJECT, 'lib', 'semanticcache'));
  const baseCfg = { AI_PROVIDER: 'ollama', LLM_MODEL: 'm', WORKSPACE_PERSONA: 'ALPHA', ASSISTANT_ROLE: 'r' };
  const sigDefault = sc.signature(baseCfg);
  eq(sc.signature(baseCfg, { persona: 'ALPHA' }), sigDefault, 'signature persona override equal to the active persona matches the default');
  ok(sc.signature(baseCfg, { persona: 'BETA' }) !== sigDefault, 'a different workspace persona yields a different cache signature (no cross-persona reuse)');
  const fpA = sc.fingerprint({ workspaceId: 'wsA', parentMap: new Map([['a', 1]]), lastIndexedAt: 10 }, baseCfg);
  const fpB = sc.fingerprint({ workspaceId: 'wsB', parentMap: new Map([['a', 1]]), lastIndexedAt: 10 }, baseCfg);
  ok(fpA !== fpB && fpA.startsWith('wsA|'), 'the fingerprint is derived from the passed bundle (its workspace), not global state');
  // The socket uses the resolved bundle + the turn's cache dir + the turn's persona for the cache.
  ok(/scFp  = sc\.fingerprint\(idx, scCfg\)/.test(socketSrc), 'socket fingerprints the semantic cache from the turn bundle (idx), not global state');
  ok(/sc\.signature\(scCfg, \{ persona: require\('\.\/config'\)\.personaFor\(turnWs\) \}\)/.test(socketSrc), 'socket keys the semantic-cache signature on the turn workspace persona');
  ok(/sc\.lookup\(wsCacheDir\(\)/.test(socketSrc) && /semanticcache'\)\.store\(wsCacheDir\(\)/.test(socketSrc), 'the semantic cache reads and writes the turn workspace cache dir, never the active one');

  // ── Existence gating: a workspace parameter must name a real workspace, not just a valid-format id ──
  const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-ws-hardening-'));
  try {
    ok(typeof wsm.exists === 'function', 'workspaces exposes exists(dataDir, id)');
    ok(wsm.exists(tmp, wsm.DEFAULT_ID), 'the default workspace always exists');
    ok(!wsm.exists(tmp, 'never-created'), 'a well-formed but unregistered id does not exist (no orphan creation)');
    ok(!wsm.exists(tmp, '../escape'), 'a traversal id is rejected by the format guard before any lookup');
    const made = wsm.createWorkspace(tmp, 'Real One');
    ok(wsm.exists(tmp, made.id), 'a created workspace exists');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  // Window-workspace resolution is centralized in one resolveTurnWs helper that requires exists(), so a
  // spoofed slug falls back to active — and every turn entry point routes through it (no per-handler copy to
  // drift). This replaces the old per-handler inline `_wsm.exists(...)` checks.
  ok(/const resolveTurnWs = .*require\('\.\/workspaces'\)\.exists\(require\('\.\/config'\)\.DATA_DIR, parsed\.workspaceId\)/.test(socketSrc),
    'resolveTurnWs requires an existing workspace (a spoofed slug falls back to the active one)');
  ok((socketSrc.match(/resolveTurnWs\(/g) || []).length >= 3,
    'the message, synthesis, and resolveTurn entry points all resolve the workspace through resolveTurnWs');
  ok(/wsm\.exists\(cfgPaths\.DATA_DIR, w\)/.test(docsSrc) && /wsm\.exists\(cfgPaths\.DATA_DIR, w\)/.test(viewerSrc), 'the documents and viewer routes require an existing workspace');
  ok(/wsm\.exists\(cfg\.DATA_DIR, w\)/.test(serverSrc), 'the persona/config routes require an existing workspace');

  // ── C2/C3/C4: the turn's own corpus/workspace is used, not the active one ──
  ok(/idx\.parentMap\.size > 1/.test(socketSrc), 'auto-synthesis routing tests the turn corpus size, not the active one');
  ok(/pendingWebWs {4}= turnWs;/.test(socketSrc) && /turnWs = pendingWebWs \|\| state\.workspaceId;/.test(socketSrc), 'a deferred web answer records into the workspace the offer was made from');
  ok(/Preparing that workspace for research/.test(socketSrc), 'web-augmented deep research on a still-warming workspace tells the user to retry instead of dropping the corpus');

  // ── C1: a non-active document change reconciles that workspace's on-disk index ──
  ok(typeof require(path.join(PROJECT, 'lib', 'indexing', 'bundle')).reconcileWorkspaceDocsChange === 'function', 'bundle exposes reconcileWorkspaceDocsChange');
  ok(/const reconcileWorkspaceDocsChange = \(workspaceId\) =>/.test(bundleSrc), 'reconcile is defined');
  ok(/invalidateBundle\(workspaceId\);/.test(bundleSrc)
    && /CACHE_FILES\.parentMap, CACHE_FILES\.passageMap, CACHE_FILES\.childMap/.test(bundleSrc)
    && /rmSync\(path\.join\(dir, f\), \{ force: true \}\)/.test(bundleSrc),
    'reconcile drops the derived map caches so the next open re-derives from the true on-disk state');

  // ── A workspace generation counter closes the reconcile stale-recache race ──
  // reconcile deletes the derived caches but does not rewrite the manifest, so its mtime is unchanged. An
  // in-flight load that already read the old caches would otherwise re-cache stale content under that
  // unchanged mtime. The load captures the generation at its start; invalidate/reconcile bumps it; the
  // load only caches if the generation is still current.
  ok(/const _generation = new Map\(\)/.test(bundleSrc) && /const bumpGen =/.test(bundleSrc) && /const curGen =/.test(bundleSrc),
    'bundle keeps a per-workspace generation counter');
  ok(/const genAtStart = curGen\(workspaceId\)/.test(bundleSrc) && /if \(curGen\(workspaceId\) === genAtStart\)/.test(bundleSrc),
    'getBundle captures the generation before loading and only caches if it is still current');
  ok(/const invalidateBundle = \(workspaceId\) => \{ bumpGen\(workspaceId\)/.test(bundleSrc),
    'invalidateBundle bumps the generation so an in-flight load cannot re-cache stale content');

  // ── Bundle cache is memory-aware and warms are bounded and non-wedging ──
  ok(/const MAX_CACHED_BYTES =/.test(bundleSrc) && /const evictLru = \(\) =>/.test(bundleSrc) && /overBytes\(\)/.test(bundleSrc),
    'the bundle cache evicts on a memory ceiling, not just a count, so large corpora cannot co-reside');
  ok(/_cache\.size > 1 && overBytes\(\)/.test(bundleSrc), 'the most-recently-used bundle is never evicted below usability');
  ok(/const _warmGate = createSemaphore\(\{ max: 2 \}\)/.test(bundleSrc) && /_warmGate\.run\(\(\) => getBundle\(workspaceId\)\)/.test(bundleSrc),
    'concurrent first-loads of different workspaces are serialized through a small pool');
  ok(/const SYNC_LOAD_TIMEOUT_MS =/.test(bundleSrc) && /Promise\.race\(\[job\.then/.test(bundleSrc) && /clearTimeout\(timer\)/.test(bundleSrc),
    'a fast load is awaited only briefly (bounded) so a stalled load never wedges the turn, and the timer is cleared');

  // ── The non-active manifest read is cached by the shared stat fingerprint (bounded) ──
  const manifestSrc = read('lib/indexing/manifest.js');
  ok(/_manifestCache/.test(manifestSrc) && /hit\.stk === stk/.test(manifestSrc) && /_manifestCache\.size > 8/.test(manifestSrc),
    'loadManifestFrom caches by path+fingerprint with a bounded size');

  // ── Per-window persona and indexed folders (server honors ?workspace=, client sends it) ──
  ok(/const personaWsId = \(req\) =>/.test(serverSrc), 'the persona route resolves the window workspace');
  ok(/loadSettings\(cfg\.DATA_DIR, personaWsId\(req\)\)/.test(serverSrc) && /wsm\.updateSettings\(cfg\.DATA_DIR, wsId,/.test(serverSrc), 'persona reads and writes the window workspace settings');
  ok(/let foldersWsId = null;/.test(serverSrc) && /reconcileWorkspaceDocsChange\(foldersWsId\)/.test(serverSrc), 'a non-active folder change writes to and reconciles that workspace, not the active one');
  ok(/'\/api\/workspace\/persona' \+ wsQuery\(\)/.test(chatSrc), 'the client persona load/save carries the viewed workspace');
  ok(/'\/api\/config' \+ wsQuery\(\)/.test(chatSrc), 'the client folder load/save carries the viewed workspace');

  // ── The panel re-syncs every workspace-scoped field on a switch/delete/restore ──
  ok(/function refreshWorkspaceScopedPanel\(\)/.test(chatSrc)
    && /loadSourceFolders\(\);\s*\n\s*loadPersona\(\);\s*\n\s*updateDocPanelWorkspace\(\);/.test(chatSrc),
    'a single helper re-syncs documents, folders, persona, and the label together');
  eq((chatSrc.match(/refreshWorkspaceScopedPanel\(\)/g) || []).length, 4, 'the helper is defined once and called from switch, delete, and restore');

  // ── The in-app viewer's related links carry the workspace so a non-active source opens correctly ──
  ok(/'&workspace=' \+ encodeURIComponent\(wsId\)/.test(relatedSrc), 'a related-document link keeps the workspace of the document being viewed');
  ok(/const safeHref = srcHref\(src\)/.test(chatSrc), 'each source pill captures its viewer link at render time (stable across a later workspace change)');

  // ── An active turn now reads an IMMUTABLE per-turn index snapshot, so a workspace switch mid-turn can neither
  //    make it answer from the wrong corpus nor grade faithfulness against a swapped index. The snapshot is the
  //    mechanism; there is no longer a mid-loop "stop" (it would be dead code — idx is never the live state). ──
  ok(/const snapshotActiveIndex = \(\) => require\('\.\/indexing\/bundle'\)\.bundleOf\(state\);/.test(socketSrc),
    'an active turn takes an immutable index snapshot (bundleOf) so a mid-turn switch cannot swap the corpus');
  ok(!/if \(idx === state && turnWs !== state\.workspaceId\)/.test(socketSrc),
    'the old live-index identity stop is gone — the snapshot makes it unnecessary (no dead wrong-corpus guard)');
  ok(/let metaIdx = snapshotActiveIndex\(\)/.test(socketSrc) && /const metaStale = !metaIdx && turnWs && turnWs !== state\.workspaceId/.test(socketSrc)
    && /!failed && src\.length > 0 && !metaStale/.test(socketSrc),
    'faithfulness/grounding resolve against the turn snapshot; only an absent index for a non-active turn is treated as stale');
  console.log('✓ per-connection-workspace-hardening: a per-turn index snapshot prevents serving or grading against the wrong corpus');

  // ── The per-connection generation queue is bounded (a flooding client can't grow the promise chain) ──
  ok(/const GEN_QUEUE_MAX = \d+/.test(socketSrc) && /if \(_genQueued >= GEN_QUEUE_MAX\)/.test(socketSrc)
    && /_genQueued\+\+/.test(socketSrc) && /_genQueued = Math\.max\(0, _genQueued - 1\)/.test(socketSrc),
    'runExclusive caps the queued-generation depth per connection (overflow dropped, memory bounded)');

  // ── The post-answer conversation summary is abort-threaded, so a disconnect frees the slot immediately ──
  ok(/await updateConversationSummary\(conversationContext, abort && abort\.signal\)/.test(socketSrc),
    'the main path threads the turn abort signal into updateConversationSummary (disconnect cancels it)');
  const historySrc = read('lib/history.js');
  ok(/const updateConversationSummary = async \(ctx, signal = null\)/.test(historySrc)
    && /\.\.\.\(signal \? \{ signal \} : \{\}\)/.test(historySrc),
    'updateConversationSummary accepts and forwards an abort signal to the summary model call');
  console.log('✓ per-connection-workspace-hardening: generation queue bounded; summary call is abort-cancelable');

  console.log('✓ per-connection-workspace-hardening: cache/persona/folders/viewer are workspace-scoped; bundles are memory- and concurrency-bounded; non-active changes reconcile');

  // ── broadcast() is workspace-aware: a workspace-scoped event never reaches a non-member ──
  ok(/const canUse = sock\.data && sock\.data\.canUseWorkspace;/.test(socketSrc) && /canUse\(wsId\)\) sock\.emit/.test(socketSrc),
    'broadcast() emits a workspace-scoped payload only to sockets whose principal may access that workspace');
  ok(/client\.data\.canUseWorkspace = \(wsId\) =>/.test(socketSrc), 'each socket stashes its live workspace-access check for broadcast()');
  ok(/if \(!wsId\) \{ _io\.emit\(event, payload\); return; \}/.test(socketSrc), 'a payload with no workspaceId is still a global/operational broadcast');
  // The sensitive + operational emitters all carry a workspaceId so they scope.
  ok(/broadcast\('automation_result', \{ workspaceId,/.test(read('lib/automations.js')), 'automation_result carries workspaceId (answer content scoped to members)');
  ok(/broadcast\('index_error', \{\s*\n\s*workspaceId: state\.workspaceId/.test(read('lib/indexing/delta.js')), 'index_error carries workspaceId');
  ok(/broadcast\('sync_progress', \{ workspaceId,/.test(read('lib/mcp/connectors.js')), 'sync_progress carries workspaceId');
  ok(/broadcast\('graph_build', \{ \.\.\.state\.graphBuild, workspaceId: wsId \}\)/.test(read('lib/server.js')), 'graph_build carries workspaceId');

  // ── web_accept re-checks access per turn; payload + frame are bounded ──
  ok(/if \(!q\) \{ endChat\(\); return; \}\s*\n[\s\S]{0,400}?if \(!mayUseWorkspace\(turnWs\)\) \{[\s\S]*?endChat\(\); return; \}\s*\n\s*if \(!require\('\.\/config'\)\.useWebSearch\)/.test(socketSrc),
    'web_accept re-checks mayUseWorkspace before running the turn (per-turn authz parity)');
  ok(/maxHttpBufferSize: 8 \* 1024 \* 1024/.test(socketSrc), 'the inbound socket frame is explicitly size-capped');
  ok(/if \(typeof content !== 'string' \|\| !content\.trim\(\)\) \{ endChat\(\); return; \}/.test(socketSrc), 'the message handler validates content before heavy processing');
  console.log('✓ per-connection-workspace-hardening: broadcasts are workspace-scoped; web_accept re-authorizes; frame + content bounded');

  console.log(`\nALL PER-CONNECTION-WORKSPACE-HARDENING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PER-CONNECTION-WORKSPACE-HARDENING UNIT TEST FAILED:', e.message);
  process.exit(1);
}
