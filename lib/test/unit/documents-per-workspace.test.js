'use strict';
// Guards that document MANAGEMENT (the Documents panel) and the in-app VIEWER are per-window: a window
// viewing a non-active workspace lists, uploads, deletes, ingests, views, and finds-related documents in
// THAT workspace, not always the active one. The routes resolve the workspace from a validated
// ?workspace=<id> query param (isValidId is the traversal guard for the derived docs/cache dirs), and the
// client sends the workspace it is viewing. Source-inspection drift guard. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const docs = read('lib/routes/documents.js');
  const viewer = read('lib/routes/viewer.js');
  const chat = read('lib/public/js/chat.js');
  const related = read('lib/public/js/viewer-related.js');
  const viewerEjs = read('lib/views/document-viewer.ejs');

  // ── Documents routes resolve the target workspace and scope to it ──
  ok(/const resolveWsId = \(req\) =>/.test(docs) && /wsm\.exists\(cfgPaths\.DATA_DIR, w\)/.test(docs), 'documents.js resolves the target workspace and requires it to exist (not just a valid-format id)');
  ok(/wsm\.docsDirFor\(cfgPaths\.DATA_DIR, resolveWsId\(req\)\)/.test(docs), 'uploads write into the target workspace documents dir');
  ok(/wsm\.docsDirFor\(cfgPaths\.DATA_DIR, wsId\)/.test(docs), 'list and delete operate on the target workspace documents dir');
  ok(/relatedDocuments\(resolveWsId\(req\)/.test(docs), 'related documents are found in the target workspace');
  ok(/const reflectDocChange = \(wsId\) =>/.test(docs) && /reflectWorkspaceMutation\(wsId,[\s\S]*?reconcileWorkspaceDocsChange\(id\)/.test(docs), 'a non-active workspace change reconciles its on-disk index (via the shared lock helper) instead of reindexing the active one');
  // Non-active indexed status comes from that workspace's manifest, not the active parentMap.
  ok(/loadManifestFrom/.test(docs), 'non-active indexed status is read from the target workspace manifest');

  // ── Viewer is workspace-scoped (path containment per workspace) ──
  ok(/const resolveWsId = \(req\) =>/.test(viewer), 'the viewer resolves + validates the target workspace');
  ok(/isWithin\(abs, wsm\.docsDirFor\(cfgPaths\.DATA_DIR, wsId\)\)/.test(viewer), 'the viewer allow-check is scoped to the target workspace documents dir');
  ok(/await isAllowedPath\(abs, wsId\)/.test(viewer) && /resolveAllowed\(abs, wsId\)/.test(viewer), 'both /view and /raw pass the workspace through the allow + realpath re-check');
  ok(/const sourcePathsFor = \(wsId\)/.test(viewer) && /const isIndexedIn = async \(abs, wsId\)/.test(viewer), 'source-folder and indexed checks are per-workspace');
  ok(/workspaceId: wsId/.test(viewer), 'the viewer passes the workspace to its template');
  ok(/data-workspace="<%= workspaceId/.test(viewerEjs), 'the viewer template exposes the workspace to the related panel');
  ok(/data-workspace/.test(related) && /workspace=' \+ encodeURIComponent\(wsId\)/.test(related), 'the related panel scopes its query to that workspace');

  // ── Client sends the viewed workspace with every document request ──
  ok(/function wsQuery\(sep = '\?'\)/.test(chat), 'the client has a wsQuery() helper for the document routes');
  ok(/fetch\('\/api\/documents' \+ wsQuery\(\)\)/.test(chat), 'the document list request carries the viewed workspace');
  ok(/encodeURIComponent\(relPath\) \+ wsQuery\('&'\)/.test(chat), 'the delete request carries the viewed workspace');
  ok(/'\/api\/documents\/url' \+ wsQuery\(\)/.test(chat), 'the URL-ingest request carries the viewed workspace');
  ok(/xhr\.open\('POST', '\/api\/documents' \+ wsQuery\(\)\)/.test(chat), 'the upload request carries the viewed workspace');
  ok(/workspace=\$\{encodeURIComponent\(w\)\}/.test(chat), 'the viewer link carries the viewed workspace so a non-active source opens correctly');

  console.log('✓ documents-per-workspace: panel + viewer manage the window\'s workspace; older client / active workspace unchanged');
  console.log(`\nALL DOCUMENTS-PER-WORKSPACE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCUMENTS-PER-WORKSPACE UNIT TEST FAILED:', e.message);
  process.exit(1);
}
