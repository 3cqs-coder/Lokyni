'use strict';
// Guards that every path which ADDS content the index must observe uses reindexNow, not a bare
// runDeltaUpdate. runDeltaUpdate dedupes onto an in-flight delta whose file scan was fixed before the
// new content existed, so a new source folder / uploaded file / ingested page added while a delta is
// already running would silently never be indexed until something inside it later changed. reindexNow
// drains the in-flight delta first, then runs one guaranteed fresh scan that sees the new content.
// This is the recurring "silent zero-result indexing" class the codebase guards against. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // reindexNow's contract: await any in-flight delta, THEN run a fresh scan.
  const delta = read('lib/indexing/delta.js');
  ok(/const reindexNow = async \(\) => \{[\s\S]*?await state\.indexPromise;[\s\S]*?return runDeltaUpdate\(\);/.test(delta),
    'reindexNow drains the in-flight delta before running a fresh scan');

  // The Settings-save / add-source-folder path (refreshSources) uses reindexNow, so a folder added
  // during an active delta is still indexed. This was the pass-32 fix.
  const init = read('lib/indexing/init.js');
  const refreshFn = init.slice(init.indexOf('const refreshSources'), init.indexOf('const refreshSources') + 2000);
  ok(refreshFn.includes('const refreshSources') || init.includes('refreshSources'), 'refreshSources exists');
  const refreshBody = init.slice(init.indexOf('Settings saved'), init.indexOf('const doSwitchWorkspace') > 0 ? init.indexOf('const doSwitchWorkspace') : undefined);
  ok(/await reindexNow\(\);/.test(refreshBody) && !/await runDeltaUpdate\(\);/.test(refreshBody),
    'refreshSources uses reindexNow (drain-then-scan), not a bare runDeltaUpdate that would miss a folder added mid-delta');
  ok(/const \{[^}]*\breindexNow\b[^}]*\} = require\('\.\/delta'\)/.test(init),
    'init.js imports reindexNow from the delta module');

  // Every new-content mutation path routes through the shared reflectWorkspaceMutation helper, which
  // reindexes the ACTIVE workspace (drain-then-scan via reindexNow) and reconciles/invalidates a NON-active
  // one's on-disk cache so the change takes effect on its next open — all under the lifecycle lock. A drift
  // guard so a future path can't regress to a bare reindexNow (the silent-skip bug AND the lifecycle race).
  ok(/const reflectWorkspaceMutation = async \(wsId, onNonActive\) =>[\s\S]*?reindexNow\(\)/.test(init),
    'the shared helper reindexes the active workspace through reindexNow, under the lifecycle lock');
  {
    const docsSrc = read('lib/routes/documents.js');
    ok(/const reflectDocChange = \(wsId\) =>/.test(docsSrc) && /reflectWorkspaceMutation\(wsId,/.test(docsSrc),
      'documents.js centralizes post-change indexing in reflectDocChange via the shared helper');
    ok(/reconcileWorkspaceDocsChange\(id\)/.test(docsSrc), 'reflectDocChange reconciles a non-active workspace on-disk index');
    ok((docsSrc.match(/reflectDocChange\(/g) || []).length >= 3,
      'upload, URL ingest, and delete all route through reflectDocChange');
  }
  ok(/reflectWorkspaceMutation\(/.test(read('lib/routes/apiv1.js')), 'the API ingest path routes through the shared lock helper');
  ok((read('lib/mcp/connectors.js').match(/reflectWorkspaceMutation\(/g) || []).length >= 2,
    'connector removal and sync route through the shared lock helper');

  console.log(`\nALL REINDEX-NEW-CONTENT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ REINDEX-NEW-CONTENT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
