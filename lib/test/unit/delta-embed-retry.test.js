'use strict';
// Guards the transient-embed-failure retry contract in lib/indexing/delta.js.
//
// When a file's chunks fail to embed (the embeddings provider is briefly down, the model is
// reloading, or the endpoint rejects the request), the delta path must record the file as
// RETRY-PENDING — with no fileHash — so the next delta's `toAdd` filter re-selects it and it
// re-embeds automatically once the provider recovers. The bug this guards against: stamping the
// current fileHash on an embed failure, which makes the file match disk forever so `toAdd` never
// revisits it, leaving it permanently keyword-only (BM25, no dense vectors) until its bytes change
// or the user runs a full Rebuild. The two skip paths for genuinely non-indexable files
// (empty/too-small, zero chunks) must STILL stamp the hash so they are not retried pointlessly.
// Pure source inspection plus a check of the toAdd predicate itself. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── The embed-failure path (allVecs.length === 0) records retry-pending, no fileHash ──
  const emptyVecsIdx = src.indexOf('if (allVecs.length === 0)');
  ok(emptyVecsIdx !== -1, 'the empty-vectors embed-failure branch exists');
  const emptyVecsBlock = src.slice(emptyVecsIdx, emptyVecsIdx + 400);
  ok(/embedPending: true/.test(emptyVecsBlock), 'an embed failure marks the entry embedPending');
  ok(!/fileHash: diskHashes/.test(emptyVecsBlock), 'an embed failure does NOT stamp the current fileHash (so toAdd retries it)');

  // ── The per-file catch (processing error, usually the provider throwing) also retry-pending ──
  const catchIdx = src.indexOf('} catch (e) {', emptyVecsIdx);
  ok(catchIdx !== -1, 'the per-file processing catch exists');
  const catchBlock = src.slice(catchIdx, catchIdx + 1800);
  ok(/embedPending: true/.test(catchBlock), 'a processing error marks the entry embedPending');
  ok(!/fileHash: diskHashes/.test(catchBlock), 'a processing error does NOT stamp the current fileHash');

  // ── The genuinely-non-indexable skips (empty/too-small, zero chunks) STILL stamp the hash so they
  //    are not retried every run — this is the deliberate opposite of the embed-failure case ──
  const notIndexable = src.match(/newManifest\[filePath\] = \{ fileHash: diskHashes\[filePath\], vectorIds: \[\], skipped: true \};/g) || [];
  ok(notIndexable.length >= 2, 'the non-indexable skip paths (empty/too-small, zero chunks) still stamp the fileHash');

  // ── The toAdd predicate re-selects an entry that lacks a fileHash ──
  // An unchanged, already-indexed entry is skipped only when its stored fileHash equals the disk hash; an
  // entry with no fileHash never matches, so a retry-pending entry re-enters toAdd. (A separate in-memory
  // parse-failure backoff can defer it within a session, guarded by delta-embed C-7 in indexing-durability.)
  ok(/if \(manifest\[f\] && manifest\[f\]\.fileHash === diskHashes\[f\]\) return false;\s*\/\/ unchanged/.test(src),
    'the toAdd filter keys on fileHash (a missing fileHash is treated as changed → retried)');
  // Mirror the predicate for a retry-pending entry that has NOT failed to parse this session.
  const manifest = { '/d/pending.txt': { vectorIds: [], skipped: true, embedPending: true } };   // no fileHash
  const diskHashes = { '/d/pending.txt': 'abc123' };
  const parseFailed = new Map();   // empty: this entry is embed-pending, not parse-failed
  const reselected = ['/d/pending.txt'].filter(f => {
    if (manifest[f] && manifest[f].fileHash === diskHashes[f]) return false;
    if (parseFailed.get(f) === diskHashes[f]) return false;
    return true;
  });
  ok(reselected.length === 1, 'a retry-pending entry (no fileHash, not parse-failed) is re-selected by the toAdd predicate');

  console.log('✓ delta-embed-retry: transient embed failures retry on the next delta; genuine skips do not');
  console.log(`\nALL DELTA-EMBED-RETRY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DELTA-EMBED-RETRY UNIT TEST FAILED:', e.message);
  process.exit(1);
}
