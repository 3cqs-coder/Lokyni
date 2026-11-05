'use strict';
// Guards two correctness fixes from the audit round.
//
// 1. INDEX-LIFECYCLE SERIALIZATION. Workspace switch, rebuild, bank consolidation, and a backup restore's
//    quiesce-and-swap all mutate live index state and toggle the watcher gate. Running two at once let one
//    clear the other's gate mid-operation (a restore's files replaced while a switch re-armed the watcher
//    and started a delta into them) or redirect a rebuild onto a workspace a concurrent switch just changed.
//    They now all run through ONE serialization chain (runLifecycleExclusive). A caller that already holds
//    the lock must call the INNER function, never the public wrapper, or it would self-deadlock.
// 2. FAITHFULNESS grades only the text the model saw. When a document is served as multiple disjoint
//    windows, the collapsed [passageStart,passageEnd] span includes the gap between them; the judge now
//    reconstructs from the exact served ranges instead, so a claim can't be marked "supported" from gap
//    text. Full-Context mode records the whole-document span so its citation isn't a 0/0 no-highlight.
// Functional where cheap; source-inspection for the wiring (the live paths need a running index). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const init = read('lib/indexing/init.js');

  // ── one lifecycle lock, all mutators on it ──
  ok(/const runLifecycleExclusive = \(fn\) => \{[\s\S]*?_lifecycleChain = next\.catch/.test(init),
    'a single runLifecycleExclusive chain serializes lifecycle operations');
  ok(/const switchWorkspace = \(id\) => runLifecycleExclusive\(\(\) => doSwitchWorkspace\(id\)\)/.test(init),
    'switchWorkspace runs through the lifecycle lock');
  ok(/const forceReindex = \(\) => runLifecycleExclusive\(_forceReindexInner\)/.test(init),
    'forceReindex runs through the lifecycle lock');
  ok(/const consolidateBanks = \(\) => \{[\s\S]{0,800}?return runLifecycleExclusive\(_consolidateBanksInner\)/.test(init),
    'consolidateBanks runs through the lifecycle lock');
  {
    // Consolidation is additive: it moves documents through the delta batches and never wipes/rebuilds the index
    // while holding the lock (the old full rebuild would have self-deadlocked if it called the public wrapper).
    const cstart = init.indexOf('const _consolidateBanksInner');
    const cend = init.indexOf('const consolidateBanks', cstart);
    const cbody = init.slice(cstart, cend);
    ok(/await runDeltaUpdate\(\{ reembedFp: meta\.fp/.test(cbody), 'consolidate moves documents through the delta path');
    ok(!/_forceReindexInner|forceReindex\(|wipeIndexCache\(/.test(cbody), 'consolidate neither rebuilds nor wipes the index up front');
  }
  ok(/module\.exports = \{[^}]*runLifecycleExclusive/.test(init), 'runLifecycleExclusive is exported for the restore path');

  // ── the backup restore runs its destructive swap under the same lock ──
  const server = read('lib/server.js');
  ok(/runLifecycleExclusive\(\(\) => bk\.restoreBackup\(/.test(server),
    'the restore route wraps the quiesce-and-swap in the lifecycle lock');
  // A backup snapshot also runs under the lock and quiesces the active workspace, so a concurrent delta
  // can't rename an index file mid-snapshot and leave the archive internally inconsistent (unrestorable).
  ok(/app\.post\('\/api\/backup'[\s\S]*?runLifecycleExclusive\(async \(\) => \{[\s\S]*?beginQuiesce\(\)[\s\S]*?writeBackup\(/.test(server),
    'the backup route snapshots under the lifecycle lock and quiesces the active workspace');

  // ── EVERY document-mutation path reflects its change through the one shared, lock-serialized helper ──
  // Otherwise its delta races a concurrent rebuild/switch/restore. The helper decides active-vs-non-active
  // at RUN time, so a switch while it waited can't misplace the change. All four callers must use it so a
  // new path can't reintroduce the race (upload/delete, URL ingest, connector removal, connector sync).
  ok(/const reflectWorkspaceMutation = async \(wsId, onNonActive\) => \{[\s\S]*?runLifecycleExclusive\(async \(\) => \{[\s\S]*?wsId === state\.workspaceId[\s\S]*?reindexNow\(\)/.test(init),
    'the shared reflectWorkspaceMutation helper serializes the reindex through the lifecycle lock, deciding active-vs-non-active at run time');
  for (const f of ['lib/routes/documents.js', 'lib/routes/apiv1.js', 'lib/mcp/connectors.js']) {
    ok(/reflectWorkspaceMutation\(/.test(read(f)), `${f} routes its document mutation through reflectWorkspaceMutation`);
  }
  // No document-mutation path still calls reindexNow directly outside the helper (the race the helper closes).
  ok(!/reindexNow\(\)/.test(read('lib/routes/apiv1.js')) && !/reindexNow\(\)/.test(read('lib/mcp/connectors.js')),
    'no ingest/connector path bypasses the helper with a direct reindexNow call');

  // ── refreshSources defers during a rebuild too, not only a switch ──
  ok(/if \(switching \|\| initializing\) \{[\s\S]*?return;/.test(init),
    'a settings save defers while a switch OR a rebuild is mid-flight');

  // ── refreshSources runs through the lifecycle lock (no orphaned watcher from a settings-save race) ──
  // Two settings-saves (two tabs / a double-click) — or a save racing a switch — used to interleave on the
  // shared _watchers global and strand a live-but-untracked watcher. It now serializes on the same lock.
  ok(/const refreshSources = \(\) => runLifecycleExclusive\(_refreshSourcesInner\)/.test(init),
    'refreshSources serializes through the lifecycle lock (no watcher-state race with switch/rebuild/restore or another save)');

  // ── stopWatchers snapshots _watchers BEFORE awaiting the closes ──
  // Clearing the array AFTER the await dropped (orphaned) any watcher another path armed during the await.
  // Snapshotting and clearing first makes the swap atomic and closes exactly the captured set.
  ok(/const stopWatchers = async \(\) => \{[\s\S]*?const watchers = _watchers;\s*\n\s*_watchers = \[\];\s*\n\s*await Promise\.all\(watchers\.map/.test(init),
    'stopWatchers detaches and clears _watchers before awaiting the closes (a watcher armed mid-close is not orphaned)');

  // ── startWatcher is idempotent — it never stacks a second live watcher set over an existing one ──
  ok(/const startWatcher = \(\) => \{[\s\S]*?if \(_watchers\.length\) return;/.test(init),
    'startWatcher no-ops when watchers are already armed (a redundant re-arm on a failure path cannot orphan the first set)');

  // ── the `switching` gate is self-clearing on every failure path (auto-indexing never silently stuck off) ──
  // beginQuiesce clears the gate and re-arms watchers if quiescing throws (e.g. a chokidar close() rejects),
  // instead of leaving `switching` true forever (which disables all real-time auto-indexing until restart).
  ok(/const beginQuiesce = async \(\) => \{[\s\S]*?catch \(e\) \{[\s\S]*?switching = false;[\s\S]*?startWatcher\(\);[\s\S]*?throw e;/.test(init),
    'beginQuiesce self-clears the switching gate and re-arms watchers if quiescing fails');
  // doSwitchWorkspace sets the gate BEFORE validation and validates INSIDE the try, so a validation throw
  // (e.g. a restored id not yet in the registry) still falls through the finally that clears `switching`.
  ok(/const doSwitchWorkspace = async \(id\) => \{[\s\S]*?switching = true;\s*\n\s*try \{\s*\n\s*if \(!wsm\.isValidId\(id\)\) throw[\s\S]*?\} finally \{\s*\n\s*switching = false;/.test(init),
    'doSwitchWorkspace validates inside the try/finally so a validation throw cannot strand the switching gate');
  // A switch that nulls the old index then has initIndex THROW must not leave the workspace stuck not-ready
  // (runDeltaUpdate never sets indexReady, so queries would answer "still building" forever). The switch
  // catches the failure and marks the index ready so queries get an honest degraded/empty answer.
  ok(/await initIndex\(\{ keepWorkspace: true \}\);\s*\n\s*\} catch \(e\) \{[\s\S]*?state\.indexReady = true;/.test(init),
    'a failed initIndex during a switch degrades to ready (never leaves the workspace permanently not-ready)');

  console.log('✓ lifecycle-serialization: switch / rebuild / consolidate / restore are mutually serialized');
  console.log('✓ lifecycle-serialization: watcher teardown/arm is race-safe and the switching gate self-clears on failure');

  // ── Faithfulness reconstructs from the exact served ranges ──
  const search = read('lib/retrieval/search.js');
  ok(/const servedRanges = \(Array\.isArray\(passages\) && passages\.length > 1\)/.test(search),
    'multi-window documents carry their exact served ranges on the citation');
  ok(/conversationContext\.docPassages\.set\(docId, \[\{ start: 0, end: fullText\.length \}\]\)/.test(search),
    'Full-Context mode records the whole-document span (no 0/0 citation)');
  const faith = read('lib/faithfulness.js');
  ok(/Array\.isArray\(s\.servedRanges\) && s\.servedRanges\.length > 0/.test(faith) && /\.map\(r => entry\.content\.slice\(r\.start, r\.end\)\)/.test(faith),
    'faithfulness joins the exact served ranges (not the collapsed span with its gap)');

  console.log('✓ lifecycle-serialization: faithfulness grades only the text the model saw');

  console.log(`\nALL LIFECYCLE-SERIALIZATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LIFECYCLE-SERIALIZATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
