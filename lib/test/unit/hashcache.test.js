'use strict';
// Guards the stat-validated hash cache used by a multi-batch bank re-embed. The cache must return the correct
// digest, re-hash a changed file, reject a vanished file (so the delta holds it), and be scoped to one run.
// Also guards the wiring so only the consolidation passes a cache. No model or network.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const { create, hashForPass, MAX_ENTRIES } = require(path.join(PROJECT, 'lib', 'indexing', 'hashcache'));
const { hashFile } = require(path.join(PROJECT, 'lib', 'indexing', 'files'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-hashcache-'));

(async () => {
  try {
    const file = path.join(tmp, 'doc.txt');
    fs.writeFileSync(file, 'first revision');
    const direct = await hashFile(file);
    const cache = create();
    eq(await hashForPass(file, cache), direct, 'an uncached pass matches a direct hash');
    eq(await hashForPass(file, cache), direct, 'a cached pass returns the same digest');
    eq(cache.size, 1, 'the digest is retained for the run');

    // A changed file changes the stat key and is re-hashed, not served stale.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, 'second revision');
    const changed = await hashForPass(file, cache);
    ok(changed !== direct, 'a changed file is re-hashed');
    eq(changed, await hashFile(file), 'the re-hash matches the file content');

    // A vanished file rejects, so the delta's per-file isolation holds it rather than indexing stale content.
    fs.unlinkSync(file);
    await assert.rejects(() => hashForPass(file, cache), /ENOENT/);

    // A non-Map falls back to a plain hash (the normal delta path passes no cache).
    fs.writeFileSync(file, 'third revision');
    eq(await hashForPass(file, null), await hashFile(file), 'no cache behaves exactly like a plain hash');

    ok(MAX_ENTRIES > 0 && MAX_ENTRIES <= 100000, 'the cache is bounded');

    // ── Wiring: only the migration passes a cache; normal deltas are unchanged ──
    const delta = read('lib/indexing/delta.js');
    ok(/const \{ hashForPass \} = require\('\.\/hashcache'\)/.test(delta), 'the delta uses the shared cache helper');
    ok(/diskHashes\[f\] = await hashForPass\(f, opts\.hashCache\)/.test(delta), 'the delta hashes through the cache only when one is supplied');
    const init = read('lib/indexing/init.js');
    ok(/const hashCache = require\('\.\/hashcache'\)\.create\(\)/.test(init), 'the consolidation creates one cache per run');
    ok(/runDeltaUpdate\(\{ reembedFp: meta\.fp, reembedLimit: BANK_REEMBED_BATCH, hashCache \}\)/.test(init),
      'the cache is passed to every migration batch');
    ok(/hashcache\.hashForPass/.test(read('lib/test/bench/consolidation.js')), 'the benchmark measures the same helper');

    console.log(`\nALL HASH-CACHE UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ HASH-CACHE UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})();
