'use strict';
// Guards the async workspace listing used by the HTTP and MCP surfaces. Counting a large non-active workspace
// must not block the event loop, metadata-only callers must skip the walk, and both variants must report the
// same numbers. Also guards the async file-count leaf it is built on. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));
const fswalk = require(path.join(PROJECT, 'lib', 'fswalk'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-wslist-'));

(async () => {
  try {
    // Two workspaces with nested documents; a dotfile must not count (it is not a document).
    const def = wsm.createWorkspace(tmp, 'Default');
    const alpha = wsm.createWorkspace(tmp, 'Alpha');
    const defDocs = wsm.docsDirFor(tmp, def.id);
    const alphaDocs = wsm.docsDirFor(tmp, alpha.id);
    fs.mkdirSync(path.join(defDocs, 'sub'), { recursive: true });
    fs.mkdirSync(alphaDocs, { recursive: true });
    fs.writeFileSync(path.join(defDocs, 'a.txt'), 'a');
    fs.writeFileSync(path.join(defDocs, 'sub', 'b.txt'), 'b');
    fs.writeFileSync(path.join(defDocs, '.hidden'), 'not a document');
    fs.writeFileSync(path.join(alphaDocs, 'c.txt'), 'c');

    // ── Async and sync listings agree ──
    const syncCounts = wsm.listWorkspaces(tmp).map((w) => [w.id, w.documents]).sort();
    const asyncList = await wsm.listWorkspacesAsync(tmp);
    eq(asyncList.map((w) => [w.id, w.documents]).sort(), syncCounts, 'the async listing reports the same counts');
    eq(asyncList.find((w) => w.id === def.id).documents, 2, 'nested files count and a dotfile does not');
    eq(asyncList.find((w) => w.id === alpha.id).documents, 1, 'a non-active workspace is counted from disk');

    // ── Metadata-only callers skip the walk entirely ──
    const bare = wsm.listWorkspaces(tmp, { withCounts: false });
    ok(bare.length === asyncList.length && bare.every((w) => !Object.prototype.hasOwnProperty.call(w, 'documents')),
      'metadata-only listing omits counts (no disk walk)');
    const bareAsync = await wsm.listWorkspacesAsync(tmp, { withCounts: false });
    ok(bareAsync.length === asyncList.length && bareAsync.every((w) => !Object.prototype.hasOwnProperty.call(w, 'documents')),
      'the async metadata-only listing also omits counts');

    // ── The async count leaf agrees with the sync one ──
    eq(await fswalk.countFilesAsync(defDocs, (n) => n.startsWith('.')), 2, 'countFilesAsync agrees with the sync count');

    // ── The request paths use the async listing; scheduling skips counts ──
    ok(/await wsm\.listWorkspacesAsync\(cfg\.DATA_DIR\)/.test(read('lib/server.js')), 'the workspaces API awaits the async listing');
    ok(/await wsm\.listWorkspacesAsync\(cfg\.DATA_DIR\)/.test(read('lib/routes/apiv1.js')), 'the public API awaits the async listing');
    ok(/await wsm\.listWorkspacesAsync\(cfg\.DATA_DIR, \{ withCounts: false \}\)/.test(read('lib/mcp/server.js')), 'the MCP tool lists names without walking documents');
    ok(/listWorkspaces\(cfg\.DATA_DIR, \{ withCounts: false \}\)/.test(read('lib/automations.js')),
      'the scheduler lists workspaces without counting documents');

    console.log(`\nALL WORKSPACE-LIST UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ WORKSPACE-LIST UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})();
