'use strict';
// Unit tests for the cropped-figure store (lib/indexing/figurestore.js). Pure filesystem, no
// vision — covers the strict id validation (the guard that keeps the serving route from
// reading outside the figures directory), a save → read round-trip, and clear(). Run:
// `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const store = require(path.join(PROJECT, 'lib', 'indexing', 'figurestore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmps = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-figs-')); tmps.push(d); return d; };
const cleanup = (code) => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } process.exitCode = code; };

(async () => {
  try {
    const KEY = 'a'.repeat(64);   // a 64-hex content key, as visualcache.keyFor produces

    // ── id validation ──
    ok(store.isValidId(store.makeId(KEY, 3, 0)), 'a well-formed id validates');
    ok(store.isValidId('deadbeefdeadbeef_p1_2'), 'a shorter hex key still validates');
    ok(!store.isValidId('../../etc/passwd'), 'a path-traversal id is rejected');
    ok(!store.isValidId(`${KEY}_p1_0.png`), 'an id with an extension is rejected');
    ok(!store.isValidId(`${KEY}_pX_0`), 'a non-numeric page is rejected');
    ok(!store.isValidId('ZZZZ_p1_0'), 'a non-hex key is rejected');
    ok(!store.isValidId(''), 'an empty id is rejected');
    ok(!store.isValidId(null), 'a null id is rejected');
    console.log('✓ figurestore: id validation accepts well-formed ids and rejects traversal/garbage');

    // ── save → read round-trip ──
    {
      const dir = mkTmp();
      const id = store.makeId(KEY, 2, 1);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);   // stand-in bytes
      ok(!store.hasCrop(dir, id), 'no crop before saving');
      eq(await store.saveCrop(dir, id, png), true, 'saveCrop reports success');
      ok(store.hasCrop(dir, id), 'hasCrop true after saving');
      const back = await store.readCrop(dir, id);
      ok(Buffer.isBuffer(back) && back.equals(png), 'readCrop returns the exact bytes');
      eq(await store.readCrop(dir, 'nope_p1_0'), null, 'reading an invalid id returns null');
      eq(await store.readCrop(dir, store.makeId(KEY, 9, 9)), null, 'reading a missing crop returns null');
      console.log('✓ figurestore: save → read round-trip, missing/invalid reads return null');

      // ── refuse to save an invalid id or empty buffer ──
      eq(await store.saveCrop(dir, '../x', png), false, 'saveCrop refuses an invalid id');
      eq(await store.saveCrop(dir, id, Buffer.alloc(0)), false, 'saveCrop refuses an empty buffer');
      console.log('✓ figurestore: saveCrop refuses invalid ids and empty buffers');

      // ── remove deletes a single crop (orphan pruning on delete/change) ──
      const id2 = store.makeId(KEY, 3, 0);
      await store.saveCrop(dir, id2, png);
      ok(store.hasCrop(dir, id2), 'second crop saved');
      store.removeMany(dir, [{ id: id2 }]);
      ok(!store.hasCrop(dir, id2), 'removeMany deletes the crop by manifest entry');
      ok(store.hasCrop(dir, id), 'removing one crop leaves the other');
      store.remove(dir, id);
      ok(!store.hasCrop(dir, id), 'remove deletes a single crop by id');
      console.log('✓ figurestore: remove/removeMany prune individual crops');

      // ── clear removes the whole figures directory ──
      await store.saveCrop(dir, id, png);
      store.clear(dir);
      ok(!store.hasCrop(dir, id), 'clear removes stored crops');
      console.log('✓ figurestore: clear removes the figures directory');
    }

    console.log(`\nALL FIGURESTORE UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ FIGURESTORE UNIT TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
