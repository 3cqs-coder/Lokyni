'use strict';
// Unit tests for the index write-ahead commit marker (lib/indexing/commitmarker.js) and its wiring.
// The marker closes the crash window between writing the FAISS vectors and finishing the manifest/maps:
// begin() before the first vector write, end() once every file is durable, and isPending() on warm start.
// A pending marker makes contentRebuildReason force a clean rebuild, dropping any duplicate/orphan vectors.
//
// Behavioral tests drive the real module in a temp dir; source-inspection guards (the codebase's self-
// auditing style) prove the three wiring points stay in place, since exercising them needs a full index boot.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const commit = require(path.join(PROJECT, 'lib', 'indexing', 'commitmarker'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-commit-'));
  const markerFp = path.join(dir, commit.FILE);
  try {
    // ── Round-trip: clean state is "not pending"; begin marks; end clears ──
    eq(commit.isPending(dir), false, 'a cache dir with no marker is not pending');
    commit.begin(dir);
    ok(fs.existsSync(markerFp), 'begin() writes the marker file');
    eq(commit.isPending(dir), true, 'a marker written by begin() reads as pending (crash would be caught)');
    commit.end(dir);
    ok(!fs.existsSync(markerFp), 'end() removes the marker file');
    eq(commit.isPending(dir), false, 'after end() the commit is no longer pending');

    // ── Crash injection: begin() with no end() leaves a pending marker for the next warm start ──
    commit.begin(dir);
    eq(commit.isPending(dir), true, 'a begin() never followed by end() (a crash) stays pending across a restart');
    // end() is idempotent and safe to call twice.
    commit.end(dir);
    commit.end(dir);
    eq(commit.isPending(dir), false, 'end() is idempotent');

    // ── Robustness: a missing, empty, or garbage marker reads as not-pending (never an endless rebuild loop) ──
    eq(commit.isPending(path.join(dir, 'does-not-exist')), false, 'a missing marker is not pending, never throws');
    fs.writeFileSync(markerFp, '');
    eq(commit.isPending(dir), false, 'an empty marker reads as not pending');
    fs.writeFileSync(markerFp, '{ not json');
    eq(commit.isPending(dir), false, 'a corrupt marker reads as not pending (no rebuild loop on a torn read)');
    fs.writeFileSync(markerFp, JSON.stringify({ pending: false }));
    eq(commit.isPending(dir), false, 'an explicit pending:false reads as not pending');
    commit.end(dir);

    // ── begin() reports success so the caller can refuse a commit it can't mark ──
    eq(commit.begin(dir), true, 'begin() returns true when the marker is written');
    commit.end(dir);
    const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
    eq(commit.begin(path.join(blocker, 'nope')), false, 'begin() returns false when the marker cannot be written (unwritable location), never throws');
    fs.rmSync(blocker, { force: true });
    console.log('✓ commitmarker: begin/end/isPending round-trip, crash injection, robust reads, and begin() success reporting');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // ── Wiring guards: the three integration points can't silently drift ──
  const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
  ok(/const commit = require\('\.\/commitmarker'\)/.test(deltaSrc), 'delta.js imports the commit marker');
  // begin() must precede the vector write, and end() must follow persistIndexMaps — in that order.
  const beginIdx = deltaSrc.indexOf('commit.begin(cfgPaths.CACHE_DIR)');
  const saveIdx  = deltaSrc.indexOf('saveStoreAtomic(state.liveVectorStore');
  const mapsIdx  = deltaSrc.indexOf('await persistIndexMaps(cfgPaths.CACHE_DIR, state)');
  const endIdx   = deltaSrc.indexOf('commit.end(cfgPaths.CACHE_DIR)');
  ok(beginIdx > 0 && saveIdx > 0 && mapsIdx > 0 && endIdx > 0, 'delta.js has the begin, vector-save, maps, and end sites');
  ok(beginIdx < saveIdx, 'begin() is marked BEFORE the vector store is written');
  ok(endIdx > mapsIdx, 'end() clears the marker AFTER the manifest and maps are durable');

  // In-process heal: a pending marker at the START of a delta (not only at warm start) forces a wipe+rebuild,
  // so a long-running process can't keep re-adding duplicate/orphan vectors after a persist failure.
  ok(/if \(commit\.isPending\(cfgPaths\.CACHE_DIR\)\) \{/.test(deltaSrc) &&
     /A previous index update did not finish writing[\s\S]{0,200}?wipeIndexCache\(\)/.test(deltaSrc),
    'delta.js heals a pending commit at the start of a delta (in-process), wiping and rebuilding');
  // begin() is checked (not fire-and-forget) BEFORE the in-memory swap, and aborts the update if it fails —
  // so a full disk never leaves the new index live in memory with no marker to heal an unpersistable disk.
  ok(/if \(!commit\.begin\(cfgPaths\.CACHE_DIR\)\) \{[\s\S]{0,260}?throw /.test(deltaSrc),
    'delta.js aborts the update when the commit marker cannot be written');
  const swapIdx = deltaSrc.indexOf('state.liveVectorStore = shadowStore');
  ok(beginIdx > 0 && swapIdx > 0 && beginIdx < swapIdx, 'begin() is checked BEFORE the in-memory swap (a failed marker aborts before swapping)');

  const initSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
  ok(/require\('\.\/commitmarker'\)\.isPending\(cfgPaths\.CACHE_DIR\)/.test(initSrc),
    'contentRebuildReason consults the commit marker on warm start');
  ok(/isPending[\s\S]{0,200}?return 'The previous index update did not finish/.test(initSrc),
    'a pending marker returns a rebuild reason (reusing the wipe-and-rebuild path)');
  ok(/require\('\.\/commitmarker'\)\.FILE/.test(initSrc), 'wipeIndexCache clears the commit marker when wiping the index');
  console.log('✓ commitmarker: delta brackets the commit (begin→save→maps→end); init rebuilds on a pending marker and clears it on wipe');

  console.log(`\nALL COMMITMARKER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ COMMITMARKER UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
