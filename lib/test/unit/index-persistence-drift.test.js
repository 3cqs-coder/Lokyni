'use strict';
// Drift guards for how the index maps are persisted, so two recurring hazards can't silently return:
//
//  1. The parent map holds every document's FULL text and must be streamed as NDJSON (via
//     lib/indexing/parentmapstore.js), never built into one whole-corpus JSON string — that string was
//     the out-of-memory ceiling for indexing a large corpus. A future writer that reached for
//     writeJsonAtomic / JSON.stringify / fs.write* on parent-map.json would reintroduce the ceiling and
//     every functional test would still pass. This asserts every parent-map.json write goes through the
//     streaming module.
//  2. Every *-map.json that the delta commit WRITES must also be REMOVED by wipeIndexCache, or a rebuild
//     would leave a stale map file behind. This asserts the wipe set covers the written set.
//
// Pure source inspection, no index. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── 1. No writer bypasses the NDJSON streaming module for parent-map.json ──
  // Scan every module under lib/indexing for a line that both names parent-map.json and uses a
  // whole-file JSON writer. The one legitimate mention of parent-map.json next to a writer is the call
  // to parentmapstore.writeParentMap itself, which is allowed.
  const indexingDir = path.join(PROJECT, 'lib', 'indexing');
  const files = fs.readdirSync(indexingDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
  const offenders = [];
  const WHOLE_FILE_WRITERS = /(writeJsonAtomic|writeFileAtomic|fs\.writeFile|fs\.promises\.writeFile|writeFileSync|JSON\.stringify)/;
  for (const f of files) {
    const src = fs.readFileSync(path.join(indexingDir, f), 'utf-8');
    src.split('\n').forEach((line, i) => {
      if (/(parent-map\.json|CACHE_FILES\.parentMap)/.test(line) && WHOLE_FILE_WRITERS.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  ok(offenders.length === 0, `no parent-map.json write bypasses the NDJSON module (offenders: ${offenders.join(', ') || 'none'})`);

  // And the streaming module IS the one place that owns parent-map writes — writeParentMap exists and is
  // used by the delta commit and both self-heal writers.
  const delta = read('lib/indexing/delta.js');
  const bundle = read('lib/indexing/bundle.js');
  const init = read('lib/indexing/init.js');
  ok(/writeParentMap/.test(read('lib/indexing/parentmapstore.js')), 'parentmapstore exports the streaming writer');
  ok(/parentmapstore/.test(delta) && /writeParentMap/.test(delta), 'the delta commit streams the parent map');
  ok(/parentmapstore/.test(bundle), 'the bundle loader uses the streaming module');
  ok(/parentmapstore/.test(init), 'warm-start init uses the streaming module');
  console.log('✓ index-persistence-drift: every parent-map.json write goes through the NDJSON module');

  // ── 2. wipeIndexCache removes every *-map.json the delta commit writes ──
  // Written set: the map filenames persisted by persistIndexMaps (writeJsonAtomic + writeParentMap).
  // The map filenames are single-sourced in constants.js (CACHE_FILES), so the delta and wipe reference them
  // by key (CACHE_FILES.parentMap, …) rather than a literal — match the keys and compare the same way.
  const MAP_KEY_RE = /CACHE_FILES\.(parentMap|childMap|passageMap)\b/g;
  const written = new Set([...delta.matchAll(MAP_KEY_RE)].map(m => m[1]));
  ok(written.has('parentMap') && written.has('childMap') && written.has('passageMap'),
    `the delta writes the three known maps (found: ${[...written].join(', ')})`);
  // Wipe set: filenames removed inside wipeIndexCache.
  const wipeStart = init.indexOf('const wipeIndexCache');
  const wipeEnd = init.indexOf('\n};', wipeStart);
  ok(wipeStart !== -1 && wipeEnd > wipeStart, 'wipeIndexCache is present');
  const wipeBlock = init.slice(wipeStart, wipeEnd);
  const wiped = new Set([...wipeBlock.matchAll(MAP_KEY_RE)].map(m => m[1]));
  const notWiped = [...written].filter(f => !wiped.has(f));
  ok(notWiped.length === 0, `wipeIndexCache removes every map the delta writes (missing from wipe: ${notWiped.join(', ') || 'none'})`);
  console.log('✓ index-persistence-drift: the rebuild wipe set covers every persisted map file');

  // ── 3. The delta commit swaps the whole index atomically ──
  // The BM25 build yields the event loop while it runs, and a reuse returns the live engine, so the delta
  // must prepare both the text index and the chunk index in a SHADOW and then assign every live field in one
  // synchronous run — otherwise a query that runs during the build sees the new maps paired with the old
  // BM25/chunk index. Guard that the commit prepares the shadow and does not build the chunk index straight
  // onto live state after the map swap.
  ok(/buildChunkIndexInto\(shadowIdx\)/.test(delta) && /const shadowBM25 = await buildOrReuseBM25Index\(shadowParentMap/.test(delta),
    'the delta prepares BM25 (building or reusing) + chunk index in a shadow before swapping');
  ok(/state\.liveBM25   = shadowBM25;/.test(delta) && /state\.chunkIndex = shadowIdx\.chunkIndex;/.test(delta),
    'the delta assigns the live index fields from the prebuilt shadow (one synchronous swap)');
  ok(!/\bbuildChunkIndex\(\)/.test(delta),
    'the delta no longer builds the chunk index onto live state after the map swap');
  console.log('✓ index-persistence-drift: the delta commit swaps the whole index in one atomic run');

  console.log(`\nALL INDEX-PERSISTENCE-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ INDEX-PERSISTENCE-DRIFT UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
