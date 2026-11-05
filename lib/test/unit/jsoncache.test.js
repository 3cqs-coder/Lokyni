'use strict';
// Unit tests for the shared versioned JSON cache (lib/jsoncache.js): key stability
// (bytewise-identical to the pre-refactor formula, so existing caches aren't
// invalidated), dir-scoped load, dirty-guarded flush + reload, size-cap eviction, and
// clear. Uses an injected temp dir — no config/CACHE_DIR, no LLM. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { createVersionedJsonCache } = require(path.join(PROJECT, 'lib', 'jsoncache'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-jc-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  // ── Key stability: must match the exact pre-refactor formulas ──
  const ocr = createVersionedJsonCache({ file: 'ocr-cache.json', prefix: 'ocrv', version: 2, dir: () => tmp });
  const buf = Buffer.from('scan bytes');
  assert.strictEqual(ocr.keyFor(buf), crypto.createHash('sha256').update('ocrv2:').update(buf).digest('hex'), 'ocr key matches old formula (no cache invalidation)');
  const ctx = createVersionedJsonCache({ file: 'context-cache.json', prefix: 'ctxv', version: 1, dir: () => tmp });
  assert.strictEqual(ctx.keyFor('a chunk'), crypto.createHash('sha256').update('ctxv1:').update('a chunk').digest('hex'), 'context key matches old formula');
  assert.notStrictEqual(ocr.keyFor(buf), createVersionedJsonCache({ file: 'x', prefix: 'ocrv', version: 3, dir: () => tmp }).keyFor(buf), 'version bump changes the key');

  // ── Discriminator (the model): a model-bearing cache invalidates on a model switch, and the no-discriminator
  //    key is byte-identical to the old formula so model-independent caches (OCR) are NOT invalidated on upgrade.
  assert.strictEqual(ocr.keyFor(buf), ocr.keyFor(buf, ''), 'an empty discriminator yields the exact old key (OCR cache is not invalidated)');
  assert.notStrictEqual(ocr.keyFor(buf, 'model-a'), ocr.keyFor(buf), 'folding in a model changes the key (so a model-bearing cache is distinct from the plain key)');
  assert.notStrictEqual(ocr.keyFor(buf, 'model-a'), ocr.keyFor(buf, 'model-b'), 'switching the folded-in model changes the key (stale cross-model entry is not reused)');
  assert.strictEqual(ocr.keyFor(buf, 'model-a'), ocr.keyFor(buf, 'model-a'), 'the same model yields the same key (a cache hit when nothing changed)');
  console.log('✓ jsoncache: key stability + version sensitivity + model discriminator');

  // ── load default + round-trip through flush/reload ──
  {
    const c = createVersionedJsonCache({ file: 'rt.json', prefix: 'v', version: 1, dir: () => tmp });
    assert.deepStrictEqual(c.load(), {}, 'missing file loads as {}');
    c.load()['k'] = { text: 'hello', at: 1 };
    c.flush();   // not dirty yet → should NOT write
    assert.ok(!fs.existsSync(c.path()), 'flush without markDirty writes nothing');
    c.markDirty(); c.flush();
    assert.ok(fs.existsSync(c.path()), 'flush after markDirty writes the file');
    // Fresh instance re-reads from disk.
    const c2 = createVersionedJsonCache({ file: 'rt.json', prefix: 'v', version: 1, dir: () => tmp });
    assert.strictEqual(c2.load()['k'].text, 'hello', 'value round-trips through disk');
    console.log('✓ jsoncache: default load + dirty-guarded flush + reload');
  }

  // ── size-cap eviction drops the oldest (by ageOf) first ──
  {
    const c = createVersionedJsonCache({ file: 'cap.json', prefix: 'v', version: 1, dir: () => tmp, maxBytes: 200 });
    const obj = c.load();
    for (let i = 0; i < 50; i++) obj['key' + i] = { text: 'x'.repeat(40), at: i };   // ascending age
    c.markDirty(); c.flush();
    const onDisk = JSON.parse(fs.readFileSync(c.path(), 'utf-8'));
    assert.ok(JSON.stringify(onDisk).length <= 200, 'flushed file respects the size cap');
    assert.ok(!('key0' in onDisk), 'oldest entry evicted');
    assert.ok('key49' in onDisk, 'newest entry kept');
    console.log('✓ jsoncache: size-cap eviction removes oldest first');
  }

  // ── flush merges keys another writer added after we loaded (no cross-process clobber) ──
  // The OCR cache is written by both the parent and the isolated extract child in one run. The
  // parent loads, the child then writes its own entry, and the parent's later flush must NOT drop
  // the child's entry. Simulate: instance A loads and adds its key; instance B (a second writer)
  // writes a different key to the same file; A flushes and must preserve BOTH.
  {
    const A = createVersionedJsonCache({ file: 'merge.json', prefix: 'v', version: 1, dir: () => tmp });
    A.load()['fromParent'] = { text: 'inline', at: 1 };
    A.markDirty();
    // A second writer (the "child") writes the file directly after A loaded.
    const B = createVersionedJsonCache({ file: 'merge.json', prefix: 'v', version: 1, dir: () => tmp });
    B.load()['fromChild'] = { text: 'scanned-pdf-ocr', at: 2 };
    B.markDirty(); B.flush();
    // A flushes last. Without the reload-merge this would overwrite the file with only A's key.
    A.flush();
    const onDisk = JSON.parse(fs.readFileSync(A.path(), 'utf-8'));
    assert.ok('fromParent' in onDisk, 'the later writer keeps its own entry');
    assert.ok('fromChild' in onDisk, "the later writer preserves the other writer's entry (no clobber)");
    console.log('✓ jsoncache: flush merges concurrent writers instead of clobbering');
  }

  // ── clear removes file + resets ──
  {
    const c = createVersionedJsonCache({ file: 'clr.json', prefix: 'v', version: 1, dir: () => tmp });
    c.load()['k'] = 1; c.markDirty(); c.flush();
    assert.ok(fs.existsSync(c.path()));
    c.clear();
    assert.ok(!fs.existsSync(c.path()), 'clear removes the file');
    assert.deepStrictEqual(c.load(), {}, 'clear resets in memory');
    console.log('✓ jsoncache: clear removes file and resets');
  }

  console.log('\nALL JSONCACHE UNIT TESTS PASSED');
  cleanup(0);
} catch (e) {
  console.error('\n✗ JSONCACHE UNIT TEST FAILED:', e.message);
  cleanup(1);
}
