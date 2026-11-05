'use strict';
// Guards the per-connection (per-window) workspace behavior. The server keeps the ACTIVE workspace's
// index live in global state; any OTHER workspace a window asks for is served from a loaded bundle (the
// same per-workspace bundle machinery the HTTP/MCP API uses), so each window's question, summary, and
// synthesis come from the corpus it is viewing — simultaneously, in different windows — with that
// workspace's persona and its own outcome/rating learning. The ACTIVE-workspace path is unchanged.
//
// Most of this lives inside the per-connection socket closure (not exported), so this is a
// source-inspection drift guard plus a functional check of the one pure helper (config.personaFor).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const socketSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
const searchSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
const chatSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
const cfg = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── The turn resolves the window's workspace and, for a non-active one, a loaded bundle ──
  ok(/const resolveTurn = async \(parsed, capability = 'query\.run'\) =>/.test(socketSrc), 'the socket resolves each turn\'s workspace (with a capability for API-key scope enforcement)');
  ok(/getBundleNonBlocking\(req\)/.test(socketSrc), 'a non-active workspace is served from a loaded bundle');
  // The active workspace now resolves to an IMMUTABLE per-turn snapshot (not the live global `state`), so a
  // concurrent active-workspace switch cannot swap the index out mid-turn and leak another workspace's documents.
  ok(/return \{ idx: snapshotActiveIndex\(\), isActive: true, status: 'ready' \}/.test(socketSrc), 'the active workspace resolves to an immutable per-turn index snapshot');
  ok(/const snapshotActiveIndex = \(\) => require\('\.\/indexing\/bundle'\)\.bundleOf\(state\);/.test(socketSrc), 'the snapshot is taken via bundleOf (the single definition of the index fields)');
  ok(/let turnWs = state\.workspaceId;/.test(socketSrc), 'the turn defaults to the active workspace');

  // ── The message handler passes the resolved index to retrieval and branches readiness on active vs not ──
  ok(/attachments : \[\], idx, signal: abort\.signal,/.test(socketSrc), 'the message handler passes the turn index (and the turn abort signal) to searchDocuments');
  ok(/if \(turnIsActive\) \{/.test(socketSrc), 'the readiness gate keeps the active-workspace checks unchanged and adds a non-active branch');
  ok(/idx = acq\.bundle;/.test(socketSrc), 'a non-active turn queries its loaded bundle');

  // ── Per-workspace learning: outcomes/ratings/similarity target the turn's workspace, not always active ──
  ok(/outcomes\.record\(wsCacheDir\(\)/.test(socketSrc), 'outcomes are recorded into the turn\'s workspace');
  ok(/outcomes\.stats\(wsCacheDir\(\)\)/.test(socketSrc) && /downweightDocs\(wsCacheDir\(\)/.test(socketSrc), 'down-weight learning reads the turn\'s workspace');
  ok(/bestRatedUpMatch\(wsCacheDir\(\)/.test(socketSrc), 'the "asked before" surfacing reads the turn\'s workspace');
  ok(/const wsCacheDir = \(\) => \(turnWs === state\.workspaceId/.test(socketSrc), 'wsCacheDir is undefined (default active) for the active workspace — unchanged there');
  ok(/rate\(cacheDir, messageId, rating\)/.test(socketSrc), 'a rating is applied in the workspace where the answer was produced');

  // ── Summarize and synthesize also operate on the window's workspace ──
  ok(/const entry = idx\.parentMap\.get\(docId\)/.test(socketSrc), 'summarize reads the document from the turn\'s bundle');
  ok(/runWorkspaceSynthesis\(turnWs,/.test(socketSrc), 'synthesize runs against the turn\'s workspace');
  ok(/deepResearch\(\{[\s\S]*?workspaceId: turnWs/.test(socketSrc), 'deep research runs against the turn\'s workspace');

  // ── Persona is resolved per-workspace for the answer, summary, and synthesis ──
  ok(/const workspacePersona = require\('\.\.\/config'\)\.personaFor\(idx\.workspaceId\)/.test(searchSrc), 'search resolves the persona of the query\'s workspace');
  ok((searchSrc.match(/persona: workspacePersona/g) || []).length >= 3, 'the persona is threaded to every answer/budget build');
  ok(/personaFor\(workspaceId\)/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'api-core.js'), 'utf-8')), 'synthesis uses the target workspace persona');
  ok(/buildSummaryRequest\(entry, \{ persona:/.test(socketSrc), 'summarize uses the target workspace persona');

  // ── The client sends the workspace each window is viewing with every generating request ──
  ok(/payload\.workspaceId = viewedWs/.test(chatSrc), 'the message payload carries the viewed workspace');
  ok(/summarize_document', JSON\.stringify\(\{ docId, workspaceId:/.test(chatSrc), 'summarize sends the viewed workspace');
  ok(/synthesize_workspace', JSON\.stringify\(\{ format, workspaceId:/.test(chatSrc), 'synthesize sends the viewed workspace');
  ok(/rate_answer'[\s\S]{0,120}workspaceId:/.test(chatSrc), 'rate_answer sends the answer\'s workspace so the rating lands in the right one');

  // ── personaFor is a correct pure helper: resolves by id, falls back safely ──
  ok(typeof cfg.personaFor === 'function', 'config exposes personaFor(workspaceId)');
  eq(cfg.personaFor('nonexistent-ws'), '', 'an unknown workspace yields no persona (safe default), never a throw');
  eq(cfg.personaFor(undefined), '', 'an undefined id yields no persona (falls back safely)');

  console.log('✓ per-connection-workspace: each window answers/summarizes/synthesizes from its own workspace + persona + learning; active path unchanged');
  console.log(`\nALL PER-CONNECTION-WORKSPACE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PER-CONNECTION-WORKSPACE UNIT TEST FAILED:', e.message);
  process.exit(1);
}
