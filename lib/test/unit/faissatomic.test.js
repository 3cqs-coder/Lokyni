'use strict';
// Regression tests for the atomic FAISS save (lib/indexing/delta.js saveStoreAtomic) and
// the invariant the warm-start recovery relies on. FaissStore.save overwrites the index in
// place, so a crash mid-write would corrupt it; saveStoreAtomic writes to a temp dir and
// renames the two files into place instead. And init.js recovers a corrupt cache ONLY
// because FaissStore.load throws on a damaged index — if a future library change swallowed
// that, the recovery would silently break, so we assert it here. Uses fake embeddings — no
// model or network (but does load the faiss-node native module). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { saveStoreAtomic } = require(path.join(PROJECT, 'lib', 'indexing', 'delta'));
const { FaissStore } = require(path.join(PROJECT, 'node_modules', '@langchain', 'community', 'vectorstores', 'faiss'));

let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) throw new Error(msg); };

// Deterministic fake embeddings — no Ollama needed.
const emb = {
  embedDocuments: async (texts) => texts.map((_, i) => [Math.sin(i), Math.cos(i), 0.5]),
  embedQuery: async () => [0.1, 0.2, 0.3],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-faisstest-'));
  try {
    const store = new FaissStore(emb, {});
    await store.addVectors([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      [{ pageContent: 'a', metadata: { id: 1 } }, { pageContent: 'b', metadata: { id: 2 } }]);

    // A leftover temp dir from a previous interrupted save must be cleared, not appended to.
    fs.mkdirSync(path.join(dir, '_save_tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_save_tmp', 'stale'), 'x');

    await saveStoreAtomic(store, dir);
    ok(fs.existsSync(path.join(dir, 'faiss.index')) && fs.existsSync(path.join(dir, 'docstore.json')),
       'atomic save writes both faiss.index and docstore.json into place');
    ok(!fs.existsSync(path.join(dir, '_save_tmp')), 'the temp dir is cleaned up (and a stale one is cleared)');
    console.log('✓ faissatomic: saveStoreAtomic produces both files and cleans the temp dir');

    // The mapping file (docstore.json) must be renamed into place BEFORE the index (faiss.index), so a crash
    // between the two renames leaves old-index + new-mapping (queries keep working, newest vectors briefly
    // missing, next delta heals) instead of new-index + old-mapping (a query on a new label throws). Guard
    // the order and the fsync-before-rename against a regression.
    {
      const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
      const body = src.slice(src.indexOf('const saveStoreAtomic'), src.indexOf('const saveStoreAtomic') + 700);
      const renameList = (body.match(/for \(const f of \[([^\]]*)\]\) \{\s*await (?:fs\.rename|require\('\.\.\/disk'\)\.renameWithRetry)/) || [])[1] || '';
      // The filenames are single-sourced as CACHE_FILES.docstore / CACHE_FILES.faissIndex (constants.js), so
      // the rename list references those identifiers; the ordering invariant is unchanged.
      ok(renameList.indexOf('CACHE_FILES.docstore') !== -1 && renameList.indexOf('CACHE_FILES.faissIndex') !== -1
         && renameList.indexOf('CACHE_FILES.docstore') < renameList.indexOf('CACHE_FILES.faissIndex'),
        'saveStoreAtomic renames docstore.json before faiss.index (graceful crash ordering)');
      ok(/for \(const f of \[[^\]]*\]\) await fsyncFile/.test(body), 'saveStoreAtomic fsyncs the temp files before renaming');
    }

    const reloaded = await FaissStore.load(dir, emb);
    const res = await reloaded.similaritySearchVectorWithScore([0.1, 0.2, 0.3], 2);
    ok(res.length === 2, 'the atomically-saved store reloads and searches');
    console.log('✓ faissatomic: the saved store reloads and is searchable');

    // The recovery invariant: a corrupt faiss.index must make load throw, which is what
    // init.js catches to trigger a full rebuild. If this ever stops throwing, recovery
    // would silently serve an empty index.
    fs.writeFileSync(path.join(dir, 'faiss.index'), Buffer.from('CORRUPTED'));
    let threw = false;
    try { await FaissStore.load(dir, emb); } catch { threw = true; }
    ok(threw, 'a corrupt faiss.index makes FaissStore.load throw (so warm-start recovery fires)');
    console.log('✓ faissatomic: a corrupt index throws on load, so recovery can rebuild');

    console.log(`\nALL FAISSATOMIC UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ FAISSATOMIC UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
