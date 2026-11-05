'use strict';
// Behavioral guard for outcome-aware retrieval — outcomes.js (capture) and similarity.js (BM25 retrieval over
// past queries). Both are wired into production (socket.js records each answered turn and reads them back to
// surface "you asked something similar before" and to down-weight documents that led to 👎 answers), but the
// only prior coverage was a source-string wiring check — it would pass even if the whole subsystem were
// broken. This exercises the real logic over a synthetic corpus in a throwaway temp dir (never touching the
// user's ./data), passing an explicit cacheDir so nothing depends on the active workspace. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const outcomes = require(path.join(PROJECT, 'lib', 'outcomes'));
const similarity = require(path.join(PROJECT, 'lib', 'similarity'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-outcome-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  const dir = path.join(tmp, 'ws-a');

  // ── outcomes.record: validation and field caps ──
  eq(outcomes.record(dir, { query: '', docIds: ['d'] }), null, 'record() rejects an empty query (returns null)');
  eq(outcomes.record(dir, { query: 'q', docIds: 'not-an-array' }), null, 'record() rejects a non-array docIds (returns null)');
  const longQuery = 'x'.repeat(900);
  const manyDocs = Array.from({ length: 50 }, (_, i) => `doc-${i}`);
  const cappedId = outcomes.record(dir, { query: longQuery, docIds: manyDocs, topReranker: 0.9 });
  ok(typeof cappedId === 'string' && cappedId.length > 0, 'record() returns a string id for a valid record');
  const capped = outcomes.all(dir).find(r => r.id === cappedId);
  eq(capped.query.length, 500, 'record() caps the stored query at 500 chars');
  eq(capped.docIds.length, 20, 'record() caps the stored docIds at 20');
  console.log('✓ outcomes: record validates its inputs and caps query/docIds length');

  // ── outcomes.rate: guard + effect ──
  eq(outcomes.rate(dir, cappedId, 0), false, 'rate() rejects a rating that is not 1 or -1');
  eq(outcomes.rate(dir, 'no-such-id', 1), false, 'rate() returns false for an unknown record id');
  eq(outcomes.rate(dir, cappedId, 1), true, 'rate() applies a valid 👍 and returns true');
  eq(outcomes.stats(dir).up, 1, 'stats() counts the 👍');
  eq(outcomes.rate(dir, cappedId, -1), true, 'rate() can flip the rating to 👎');
  const s = outcomes.stats(dir);
  eq(s.down, 1, 'stats() reflects the flipped 👎');
  eq(s.up, 0, 'the prior 👍 is replaced, not added to');
  console.log('✓ outcomes: rate guards the value, updates an existing record, and stats tracks 👍/👎');

  // ── outcomes save-trim keeps the NEWEST records (a flipped sign would drop recent ones) ──
  {
    const trimDir = path.join(tmp, 'ws-trim');
    fs.mkdirSync(trimDir, { recursive: true });
    // Seed exactly MAX_RECORDS (5000) records directly, oldest first, then record one more.
    const seed = Array.from({ length: 5000 }, (_, i) => ({ id: `seed-${i}`, query: `seed query ${i}`, docIds: [], rating: null, ts: i }));
    fs.writeFileSync(path.join(trimDir, 'outcomes.json'), JSON.stringify(seed));
    const newId = outcomes.record(trimDir, { query: 'the newest query', docIds: ['new-doc'] });
    const after = outcomes.all(trimDir);
    eq(after.length, 5000, 'the store is trimmed back to the cap after exceeding it');
    ok(after.some(r => r.id === newId), 'the just-added (newest) record survives the trim');
    ok(!after.some(r => r.id === 'seed-0'), 'the oldest record is the one dropped (trim keeps the newest)');
    console.log('✓ outcomes: the cap trim keeps the newest records and drops the oldest');
  }

  // ── similarity: surfacing a 👍-rated past query, and the invalidate() drift the module warns about ──
  {
    const simDir = path.join(tmp, 'ws-sim');
    const Q_BACKUP = 'how do I configure the backup schedule';
    const Q_GEO    = 'what is the capital of france';
    const Q_PW     = 'reset my account password';
    const idBackup = outcomes.record(simDir, { query: Q_BACKUP, docIds: ['backup-doc'] });
    const idGeo    = outcomes.record(simDir, { query: Q_GEO,    docIds: ['geo-doc'] });
    const idPw     = outcomes.record(simDir, { query: Q_PW,     docIds: ['pw-doc'] });
    similarity.invalidate(simDir);   // start from a clean index

    // Nothing is 👍-rated yet, so there is no "you asked this before" match.
    eq(similarity.bestRatedUpMatch(simDir, Q_BACKUP), null, 'bestRatedUpMatch returns null before any record is 👍-rated');

    // Rate the backup query 👍. Because scores are rating-independent the record COUNT is unchanged, so the
    // cached index must be invalidated for the new rating to take effect — this is the keyFor drift the module
    // comment flags. Without invalidate the stale index still shows it unrated.
    outcomes.rate(simDir, idBackup, 1);
    eq(similarity.bestRatedUpMatch(simDir, Q_BACKUP), null, 'a rating change is NOT seen until the cached index is invalidated (count unchanged)');
    similarity.invalidate(simDir);
    const up = similarity.bestRatedUpMatch(simDir, Q_BACKUP);
    ok(up && up.id === idBackup && up.score >= 0.25, 'after invalidate, an identical 👍 past query surfaces above the threshold');

    // An unrelated query must not surface the backup match.
    eq(similarity.bestRatedUpMatch(simDir, Q_GEO), null, 'a dissimilar query does not surface the 👍 backup record');

    // Down-weighting: a 👎 on the geo query penalizes its docs for a similar query, but not for a dissimilar one.
    outcomes.rate(simDir, idGeo, -1);
    similarity.invalidate(simDir);
    const penGeo = similarity.downweightDocs(simDir, Q_GEO);
    ok(penGeo.get('geo-doc') > 0, 'downweightDocs penalizes the doc from a 👎 answer on a similar query');
    const penBackup = similarity.downweightDocs(simDir, Q_BACKUP);
    ok(!penBackup.has('geo-doc'), 'downweightDocs does not penalize the 👎 doc for a dissimilar query');
    ok(!penGeo.has('backup-doc'), 'a 👍-rated record never contributes a down-weight penalty');
    // The unrated password record never surfaces or penalizes.
    eq(similarity.bestRatedUpMatch(simDir, Q_PW), null, 'an unrated record is never surfaced as a 👍 match');
    void idPw;
    console.log('✓ similarity: 👍 past queries surface (after invalidate), 👎 docs down-weight only for similar queries');
  }

  console.log(`\nALL OUTCOME-RETRIEVAL UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ OUTCOME-RETRIEVAL UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
