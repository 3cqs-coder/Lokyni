'use strict';
// Guards the non-active-workspace bundle LRU cache (lib/indexing/bundle.js) — the REAL memory bound for
// inactive corpora (workspaces.js has no cache). Two caps must hold together: at most MAX_CACHED bundles,
// and at most MAX_CACHED_BYTES of estimated text across them. The byte cap is what stops several LARGE
// non-active corpora from co-residing and exhausting memory (the count cap alone is size-blind), and the
// most-recently-used entry must survive even when it alone exceeds the byte cap. Exercised directly through
// the module's test hook — no index build needed. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { __test } = require(path.join(PROJECT, 'lib', 'indexing', 'bundle'));
const { cache, evictLru, approxBundleBytes, MAX_CACHED, MAX_CACHED_BYTES } = __test;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Insert a fake cache entry with a chosen size and recency (older lastUsed = evicted first).
const put = (id, bytes, lastUsed) => cache.set(id, { bundle: {}, loadedMtime: 0, lastUsed, bytes, generation: 0 });

try {
  ok(typeof evictLru === 'function' && cache instanceof Map, 'the LRU test hook is available');
  ok(MAX_CACHED >= 1 && MAX_CACHED_BYTES > 0, 'the caps are positive');

  // approxBundleBytes sums the parentMap content lengths (its estimate drives the byte cap).
  ok(approxBundleBytes({ parentMap: new Map([['a', { content: 'hello' }], ['b', { content: 'xyz' }]]) }) === 8,
    'approxBundleBytes sums parentMap content lengths');
  ok(approxBundleBytes({}) === 0, 'approxBundleBytes is 0 (not a throw) for a bundle without a parentMap');

  // ── count cap: one past MAX_CACHED evicts the least-recently-used ──
  cache.clear();
  for (let i = 0; i <= MAX_CACHED; i++) put(`ws${i}`, 1, 1000 + i);   // ws0 is the oldest
  evictLru();
  ok(cache.size === MAX_CACHED, `the count cap holds (size ${cache.size} === ${MAX_CACHED})`);
  ok(!cache.has('ws0'), 'the least-recently-used entry is evicted first');
  ok(cache.has(`ws${MAX_CACHED}`), 'the most-recently-used entry survives');

  // ── byte cap: large neighbors are dropped even when the count is within MAX_CACHED ──
  cache.clear();
  const big = Math.ceil(MAX_CACHED_BYTES * 0.6);   // two of these exceed the byte cap together
  put('old', big, 1000);   // least recently used
  put('new', big, 2000);   // most recently used
  ok(cache.size === 2 && cache.size <= MAX_CACHED, 'two large bundles fit the count cap but not the byte cap');
  evictLru();
  ok(cache.has('new') && !cache.has('old'), 'the byte cap evicts the LRU large bundle while the MRU survives');
  ok(cache.size === 1, 'eviction stops once the byte cap holds');

  // ── a single bundle larger than the byte cap is NOT evicted (the MRU is never dropped) ──
  cache.clear();
  put('huge', MAX_CACHED_BYTES * 2, 1000);
  evictLru();
  ok(cache.has('huge') && cache.size === 1, 'a lone over-cap bundle stays usable (the sole/MRU entry is never evicted)');

  cache.clear();
  console.log('✓ bundle-lru: both the count and byte caps are enforced, MRU preserved');
  console.log(`\nALL BUNDLE-LRU UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  try { cache.clear(); } catch { /* ignore */ }
  console.error('\n✗ BUNDLE-LRU UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
