'use strict';
// Guards the black-holed-provider short-circuit in lib/indexing/delta.js. When the embeddings provider
// stalls, a batch embed times out; grinding the file's chunks one-by-one (each with its own timeout) would
// waste minutes to embed nothing. embedChunks now surfaces a providerDown error on a batch TIMEOUT (instead
// of the per-chunk grind), while a NON-timeout batch error still falls back to per-chunk recovery. The file
// loop counts consecutive provider-down files and stops embedding the rest of the run, recording them
// retry-pending. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    const { embedChunks } = require(path.join(PROJECT, 'lib', 'indexing', 'delta'));
    const chunks = [{ pageContent: 'a', metadata: { source: '/x/a.txt' } }, { pageContent: 'b', metadata: { source: '/x/a.txt' } }];

    // ── a batch TIMEOUT surfaces providerDown (no per-chunk grind) ──
    const timeoutEmb = { embedDocuments: async () => { throw Object.assign(new Error('llm timed out'), { _lokTimeout: true }); } };
    let threw = null;
    try { await embedChunks(chunks, timeoutEmb); } catch (e) { threw = e; }
    ok(threw && threw.providerDown === true, 'a batch timeout throws a providerDown error rather than grinding chunk-by-chunk');

    // ── a NON-timeout batch error still recovers per-chunk (a single bad chunk must not lose the batch) ──
    const flakyEmb = { embedDocuments: async (texts) => { if (texts.length > 1) throw new Error('batch boom'); return [[0.1, 0.2, 0.3]]; } };
    const res = await embedChunks(chunks, flakyEmb);
    const vecs = res.flatMap(r => r.vecs);
    ok(vecs.length === 2, 'a non-timeout batch error falls back to per-chunk embedding and recovers both chunks');

    // ── source guards: the file loop stops after a streak of provider-down files, recording retry-pending ──
    const fs = require('fs');
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    ok(/let providerDownStreak = 0;/.test(src) && /providerDownStreak >= PROVIDER_DOWN_STREAK/.test(src),
      'the file loop tracks a provider-down streak and skips the rest of the run once it is reached');
    ok(/if \(e && e\.providerDown\) providerDownStreak\+\+; else providerDownStreak = 0;/.test(src),
      'a provider timeout increments the streak; any other error resets it');
    ok(/providerDownStreak = 0;\s*\/\/ a successful embed/.test(src), 'a successful embed resets the streak');
    // The skipped-ahead files are recorded retry-pending (no fileHash), so they re-embed on the next delta.
    ok(/providerDownStreak >= PROVIDER_DOWN_STREAK\) \{[\s\S]*?embedPending: true/.test(src), 'files skipped because the provider is down are recorded retry-pending');
    console.log('✓ delta-provider-down: a stalled provider short-circuits the grind and files retry later, while a bad chunk still recovers');

    console.log(`\nALL DELTA-PROVIDER-DOWN UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ DELTA-PROVIDER-DOWN UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
