'use strict';
// Guards the on-disk safety of a NON-ACTIVE workspace warm (lib/indexing/bundle.js). Warming a non-active
// workspace to answer a query must be side-effect-free on disk, and must never undo a concurrent
// delete/reindex/reconcile. The findings this locks in:
//   • a freshly re-derived parent map is persisted ONLY if the workspace's generation hasn't changed during
//     the (slow, possibly OCR) warm — and is removed if a reconcile landed during the write — so a deleted
//     document can't be resurrected past the freshness gate (survives restart);
//   • non-active map reads pass migrate:false, so they never rewrite a legacy cache and bump its mtime;
//   • a passage map loaded from cache is cleared before a child-map rebuild, so the two maps can't disagree;
//   • the warm-end BM25/chunk build is guarded, so a build failure degrades instead of wedging the workspace
//     in {status:'warming'} forever.
// The map-store behaviors themselves are covered by parentmapstore/ndjsonmapstore tests. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'bundle.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── generation-aware persistence (D-F1) ──
  ok(/const loadWorkspaceBundle = async \(workspaceId, stillCurrent = \(\) => true\) =>/.test(src),
    'loadWorkspaceBundle takes a stillCurrent() predicate (defaulting to true for active-path callers)');
  ok(/loadWorkspaceBundle\(workspaceId, \(\) => curGen\(workspaceId\) === genAtStart\)/.test(src),
    'getBundle passes the generation predicate so a raced warm will not persist stale content');
  ok(/bundle\.parentMap\.size > 0 && stillCurrent\(\)/.test(src),
    'the self-heal parent-map write is skipped when the generation changed mid-warm');
  ok(/if \(!stillCurrent\(\)\) \{ try \{ await fs\.unlink\(parentMapPath\)/.test(src),
    'a parent-map written just as a reconcile landed is removed again (no resurrected document on the next load)');

  // ── migrate:false on every non-active read (D-F2) ──
  ok(/loadParentMap\(parentMapPath, bundle\.parentMap, \{ migrate: false \}\)/.test(src), 'the parent map is read migrate:false');
  const noMigrateLoads = (src.match(/loadMap\([a-zA-Z]+MapPath, bundle\.[a-zA-Z]+, \{ migrate: false \}\)/g) || []).length;
  ok(noMigrateLoads === 2, 'both the passage map and the child map are read migrate:false');

  // ── passage map cleared before a child-map rebuild (D-F3) ──
  ok(/bundle\.passageMap\.clear\(\);\s*\n\s*for \(const \[, entry\] of bundle\.parentMap\)/.test(src),
    'the passage map is cleared before co-deriving it with the child map (no orphan passage entries)');

  // ── warm-end BM25/chunk build is guarded (D-F6) ──
  ok(/try \{\s*\n\s*bundle\.liveBM25 = await buildBM25Index\([\s\S]*?buildChunkIndexInto\(bundle\);\s*\n\s*\} catch/.test(src),
    'the warm-end BM25 + chunk-index build is wrapped so a failure degrades instead of wedging the workspace in "warming"');

  // ── the parent-map store honors migrate:false and fails closed on a dropped legacy entry (D-F2/D-F5) ──
  const pms = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'parentmapstore.js'), 'utf-8');
  ok(/count > 0 && opts\.migrate !== false/.test(pms), 'parentmapstore skips the migration write when migrate:false');
  ok(/if \(skipped\) \{[\s\S]*?targetMap\.clear\(\)[\s\S]*?ok: false/.test(pms),
    'the legacy parent-map reader fails closed when it drops any malformed entry (never a silent partial corpus)');

  console.log(`✓ bundle-warm-safety: a non-active warm is side-effect-free and cannot resurrect a deleted document (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('✗ bundle-warm-safety:', e && e.message);
  process.exit(1);
}
