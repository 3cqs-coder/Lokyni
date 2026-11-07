'use strict';
// Guards lib/statkey.js — the ONE fingerprint every stat-keyed read cache uses to decide "has this file changed?"
// Keying on mtime alone serves stale data when two writes share an mtime tick (coarse on some CI/network
// filesystems); the fingerprint pairs mtime with size and inode to close that gap. This pins the helper's
// contract AND guards that every cache actually routes through it, so none can quietly drift back to mtime-only.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { statKey, ABSENT } = require(path.join(PROJECT, 'lib', 'statkey'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── purity + the three dimensions of the fingerprint ──
  const base = { mtimeMs: 1000, size: 50, ino: 7 };
  ok(statKey(base) === statKey({ ...base }), 'same stat → same key (pure)');
  ok(statKey(base) === '1000:50:7', 'the key is mtime:size:inode');
  ok(statKey({ ...base, mtimeMs: 1001 }) !== statKey(base), 'a different mtime changes the key');
  ok(statKey({ ...base, size: 51 }) !== statKey(base), 'a different SIZE changes the key (the coarse-mtime guard)');
  ok(statKey({ ...base, ino: 8 }) !== statKey(base), 'a different inode changes the key (atomic-rename guard)');

  // ── absent: a missing stat yields ABSENT, which never collides with a real file's key ──
  ok(statKey(undefined) === ABSENT && statKey(null) === ABSENT, 'no stat → ABSENT');
  ok(statKey(base) !== ABSENT, 'a real stat never equals ABSENT (so a cache can distinguish present from absent)');

  // ── a REAL same-mtime, different-size pair (the exact CI condition) produces DIFFERENT keys ──
  const a = { mtimeMs: 1700000000000, size: 20, ino: 99 };
  const b = { mtimeMs: 1700000000000, size: 8,  ino: 99 };   // same mtime + inode, shorter content
  ok(statKey(a) !== statKey(b), 'two writes sharing an mtime (and inode) but differing in length get different keys');

  // ── drift guard: every stat-keyed cache routes through the shared helper, not a bare mtime compare ──
  const caches = [
    'jsonstore.js', 'workspaces.js', 'graphstore.js', 'semanticcache.js', 'outcomes.js',
    path.join('indexing', 'manifest.js'), path.join('indexing', 'banks.js'),
  ];
  for (const rel of caches) {
    const src = fs.readFileSync(path.join(PROJECT, 'lib', rel), 'utf-8');
    ok(/require\(['"]\.\.?\/(?:\.\.\/)?statkey['"]\)/.test(src) || /require\(['"][.\/]*statkey['"]\)/.test(src),
      `${rel} imports the shared statkey helper`);
    ok(!/\.mtimeMs === [a-zA-Z]/.test(src),
      `${rel} has no bare "=== someMtime" compare left (would be a drift back to mtime-only)`);
  }

  console.log('✓ statkey: fingerprint is mtime+size+inode, absent is distinct, and every cache routes through it');
  console.log(`\nALL STATKEY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ STATKEY UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
