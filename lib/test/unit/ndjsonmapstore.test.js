'use strict';
// Guards the generic streaming NDJSON map store (lib/indexing/ndjsonmapstore.js) used for the passage and
// child index maps. It must: round-trip a map without ever building a whole-corpus string; FAIL CLOSED on
// a truncated/corrupt file (so a torn cache is rebuilt, never served as a silent partial map); and read +
// migrate a legacy whole-JSON file. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { writeMap, loadMap, isNdjson } = require(path.join(PROJECT, 'lib', 'indexing', 'ndjsonmapstore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-ndjson-'));
  const cleanup = (code) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };
  try {
    // ── round-trip: values of different shapes (passage {start,end}, child parentId string) ──
    const src = new Map([
      ['chunk-a', { start: 0, end: 120 }],
      ['chunk-b', { start: 121, end: 340 }],
      ['chunk-c', 'parent-xyz'],
    ]);
    const file = path.join(dir, 'passage-map.json');
    await writeMap(file, src);
    ok(await isNdjson(file), 'a written map is detected as NDJSON');
    const back = new Map();
    const r = await loadMap(file, back);
    ok(r.ok && r.present && !r.legacy, 'a complete map loads ok');
    eq(back.size, 3, 'every entry round-trips');
    eq(JSON.stringify(back.get('chunk-b')), JSON.stringify({ start: 121, end: 340 }), 'object values round-trip');
    eq(back.get('chunk-c'), 'parent-xyz', 'string values round-trip');

    // ── missing file → present:false, ok:true (caller rebuilds without treating it as corruption) ──
    const miss = new Map();
    const rm = await loadMap(path.join(dir, 'nope.json'), miss);
    ok(rm.ok && !rm.present && miss.size === 0, 'a missing cache is present:false, not an error');

    // ── fail closed: a file truncated at a line boundary (no sentinel) is rejected and cleared ──
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const truncated = path.join(dir, 'truncated.json');
    fs.writeFileSync(truncated, lines.slice(0, 2).join('\n') + '\n');   // drop the sentinel (and an entry)
    const tmap = new Map();
    const rt = await loadMap(truncated, tmap);
    ok(!rt.ok && tmap.size === 0, 'a file missing its completeness sentinel fails closed and clears the map');

    // ── fail closed: a corrupt line (with sentinel present) is also rejected ──
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{"k":"a","v":1}\n{ this is not json\n{"_end":1,"n":2}\n');
    const cmap = new Map();
    const rc = await loadMap(corrupt, cmap);
    ok(!rc.ok && cmap.size === 0, 'a corrupt line fails closed');

    // ── fail closed: a count mismatch (sentinel says more than were read) is rejected ──
    const mismatch = path.join(dir, 'mismatch.json');
    fs.writeFileSync(mismatch, '{"k":"a","v":1}\n{"_end":1,"n":5}\n');
    const mmap = new Map();
    const rmm = await loadMap(mismatch, mmap);
    ok(!rmm.ok && mmap.size === 0, 'a sentinel count mismatch fails closed');

    // ── legacy whole-JSON is read once and migrated to NDJSON ──
    const legacy = path.join(dir, 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify({ 'chunk-x': { start: 5, end: 9 }, 'chunk-y': 'p1' }));
    ok(!(await isNdjson(legacy)), 'a legacy whole-JSON file is not detected as NDJSON');
    const lmap = new Map();
    const rl = await loadMap(legacy, lmap);
    ok(rl.ok && rl.legacy && lmap.size === 2, 'a legacy whole-JSON map is read');
    ok(await isNdjson(legacy), 'the legacy file is rewritten as NDJSON after the first load');
    const lmap2 = new Map();
    const rl2 = await loadMap(legacy, lmap2);
    ok(rl2.ok && !rl2.legacy && lmap2.size === 2, 'the migrated file now loads via the streaming path');

    // ── migrate:false — a legacy file is read but NOT rewritten (a read-only, non-active caller must not
    //    bump the file's mtime, which would make dependent map freshness guards re-derive). ──
    const legacyRO = path.join(dir, 'legacy-ro.json');
    fs.writeFileSync(legacyRO, JSON.stringify({ 'chunk-z': 'p9' }));
    const roMap = new Map();
    const rro = await loadMap(legacyRO, roMap, { migrate: false });
    ok(rro.ok && rro.legacy && roMap.size === 1, 'migrate:false still reads a legacy file');
    ok(!(await isNdjson(legacyRO)), 'migrate:false leaves the legacy file un-rewritten (no mtime bump)');

    // ── OOM guard: a legacy file larger than the (here, tiny) bound is NOT parsed into memory; it fails
    //    closed so the caller re-derives from source instead of risking an out-of-memory whole-file parse. ──
    const big = path.join(dir, 'legacy-big.json');
    fs.writeFileSync(big, JSON.stringify({ 'chunk-q': 'x'.repeat(500) }));   // well over the 10-byte bound below
    const bigMap = new Map();
    const rb = await loadMap(big, bigMap, { maxLegacyBytes: 10 });
    ok(!rb.ok && bigMap.size === 0, 'an oversized legacy file fails closed (no OOM parse) so the caller re-derives');
    ok(!(await isNdjson(big)), 'the oversized legacy file is left untouched (not parsed, not rewritten)');

    console.log('✓ ndjsonmapstore: round-trips, fails closed on truncation/corruption/mismatch, migrates legacy JSON, guards legacy size (OOM-proof)');
    console.log(`\nALL NDJSON-MAP-STORE UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ NDJSON-MAP-STORE UNIT TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
