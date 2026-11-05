'use strict';
// Guards the scheduled-digest corpus change-detection fingerprint (lib/automations.corpusFingerprint).
// It used to hash only the FIRST page of listDocuments (default 100 docs), so a digest on a workspace with
// more than 100 documents would silently report "corpus unchanged" and never notify when a later document was
// added, removed, or changed. It now pages through the WHOLE corpus and folds in the total count. This stubs
// api-core.listDocuments to serve a 250-doc corpus in pages and checks the fingerprint sees all of it. No
// model, no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const auto = require(path.join(PROJECT, 'lib', 'automations'));
const apiCore = require(path.join(PROJECT, 'lib', 'api-core'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// A paged listDocuments over a fixed doc array, honoring limit/offset the way api-core does (max 1000/page).
const makeCorpus = (docs) => async (_ws, opts = {}) => {
  const limit = Math.min(1000, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 100));
  const offset = Math.max(0, Number.isFinite(opts.offset) ? Math.floor(opts.offset) : 0);
  return { status: 'ok', documents: docs.slice(offset, offset + limit), total: docs.length, offset, limit };
};

(async () => {
  const savedList = apiCore.listDocuments;
  try {
    const fp = auto.__test.corpusFingerprint;
    ok(typeof fp === 'function', 'corpusFingerprint is exposed for testing');

    const corpusA = Array.from({ length: 250 }, (_, i) => ({ docId: 'd' + i, name: `doc${String(i).padStart(3, '0')}.md`, size: 100 + i }));
    apiCore.listDocuments = makeCorpus(corpusA);
    const fpA = await fp('default');
    ok(typeof fpA === 'string' && fpA.length === 64, 'returns a sha256 over the whole corpus');

    // The bug: a change to a document PAST the first page was invisible. It must now change the fingerprint.
    const corpusB = corpusA.map((d, i) => (i === 200 ? { ...d, size: d.size + 1 } : d));
    apiCore.listDocuments = makeCorpus(corpusB);
    ok(await fp('default') !== fpA, 'a change to the 201st document changes the fingerprint (pages past the first 100)');

    // An add past the first page is caught too (total changes).
    apiCore.listDocuments = makeCorpus([...corpusA, { docId: 'extra', name: 'zzz.md', size: 1 }]);
    ok(await fp('default') !== fpA, 'adding a document changes the fingerprint');

    // No change → stable fingerprint (so a digest doesn't notify on nothing).
    apiCore.listDocuments = makeCorpus(corpusA);
    ok(await fp('default') === fpA, 'an unchanged corpus yields the same fingerprint');

    // A workspace that cannot be read cleanly (e.g. still warming) fingerprints as null, so a partial read is
    // never mistaken for "unchanged".
    apiCore.listDocuments = async () => ({ status: 'warming' });
    ok(await fp('default') === null, 'an unreadable/warming workspace fingerprints as null');

    console.log('✓ corpus-fingerprint: digest change-detection covers the whole corpus, not just the first page');
    console.log(`\nALL CORPUS-FINGERPRINT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ CORPUS-FINGERPRINT UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    apiCore.listDocuments = savedList;
  }
})();
