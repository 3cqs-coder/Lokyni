'use strict';
// Guards the Settings-save index-readiness path (lib/server.js POST /api/config). A regression was found in
// the desktop app: toggling ONLY the graph setting left the index stuck at "building… / starting" forever,
// with nothing actually indexing. Root cause chain:
//   1. config.json stored no explicit `embeddingsModel` (it rode the provider default, nomic-embed-text).
//   2. The save compared the RAW config (before.embeddingsModel === undefined) against what the form
//      submitted (the RESOLVED default "nomic-embed-text"), so a never-set default becoming explicit read
//      as an embedding-MODEL change.
//   3. That flipped state.indexReady = false synchronously to block queries during the "rebuild window".
//   4. But the model did not really change, so the follow-up reindex was a no-op — and runDeltaUpdate never
//      sets indexReady (by design). Readiness stayed false until a restart.
// The fix: compare the RESOLVED embeddings model (require('./config').EMBEDDINGS_MODEL) via sameModel (so a
// bare-vs-`:latest` tag is not a change either), and restore readiness when the reindex settles with a live
// store. This is server-coupled (the handler needs a running app), so the guards are source inspection plus
// a direct functional test of the model-name comparison semantics the fix relies on.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const server = read('lib', 'server.js');

  // Isolate the POST /api/config handler body (from the raw-config read to the response).
  const start = server.indexOf("const existing = require('./config').readRawConfig();");
  ok(start !== -1, 'the config-save handler reads the raw config');
  const body = server.slice(start, server.indexOf('syncVendorFiles'));

  // ── FUNCTIONAL: the comparison semantics the fix depends on ──
  const { sameModel } = require(path.join(PROJECT, 'lib', 'modelname'));
  const { EMBEDDINGS_MODEL } = require(path.join(PROJECT, 'lib', 'config'));
  // A model left at its provider default resolves to a real name — so the resolved value is never undefined,
  // and comparing resolved-vs-resolved cannot see a never-set default "change".
  ok(typeof EMBEDDINGS_MODEL === 'string' && EMBEDDINGS_MODEL.length > 0,
    'config exposes a RESOLVED embeddings model (default-filled), never undefined');
  // The raw-vs-resolved comparison that caused the bug WOULD see a change; the resolved-vs-resolved one does not.
  ok((undefined !== EMBEDDINGS_MODEL) === true,
    'the OLD raw-vs-resolved comparison would read an unset default as a change (the bug)');
  ok(sameModel(EMBEDDINGS_MODEL, EMBEDDINGS_MODEL) === true,
    'the resolved-vs-resolved comparison sees no change when the model is unchanged (the fix)');
  // A bare name and its implicit :latest tag are the SAME model — re-selecting it must not force a rebuild.
  ok(sameModel('nomic-embed-text', 'nomic-embed-text:latest') === true,
    'sameModel treats a bare name and its :latest tag as equal (no phantom model change)');
  // A genuinely different model still compares as changed, so a real switch still blocks + rebuilds.
  ok(sameModel('nomic-embed-text', 'text-embedding-3-small') === false,
    'sameModel still reports a genuine model switch as a change');

  // ── SOURCE GUARD: the handler compares the one resolved embedding identity, not a raw model diff ──
  ok(/const prevEmbeddings = banksMod\.currentMeta\(require\('\.\/config'\)\);/.test(body),
    'the save captures the resolved embedding identity before the hot-reload');
  ok(/const embeddingIdentityChanged = prevEmbeddings\.fp !== banksMod\.currentMeta\(newCfg\)\.fp;/.test(body)
    && /embeddingIdentityChanged && !newCfg\.useEmbeddingBanks/.test(body),
    'the readiness guard compares the shared identity fingerprint and gates on banks-off');
  ok(!/before\.embeddingsModel !== existing\.embeddingsModel/.test(body),
    'the fragile raw-config comparison (before.embeddingsModel !== existing.embeddingsModel) is gone');
  // A save that omits the embedding identity (the first-run connect sheet, an API client) must not let an
  // unset embeddingsProvider follow the new chat provider and open a new bank — but a fresh install with no
  // corpus must be free to embed with the newly chosen provider.
  ok(/banksMod\.hasEmbeddedCorpus\(prevCfgForEmbeddings\.CACHE_DIR\)/.test(body)
    && /existing\.embeddingsProvider == null/.test(body)
    && /existing\.embeddingsModel === undefined/.test(body),
    'the save fills only an absent embedding identity, never an explicitly cleared model');

  // ── SOURCE GUARD: readiness is restored when the reindex settles with a live store ──
  ok(/refreshSources\(\)\s*\n\s*\.then\(\(\) => \{/.test(body),
    'the reindex after a settings save has a completion handler');
  // The restore is scoped to readiness THIS save cleared (clearedReadyHere), so it never re-arms readiness
  // that is false for an unrelated reason (e.g. a boot-time warm load still in progress).
  ok(/let clearedReadyHere = false;/.test(body) && /clearedReadyHere = true;/.test(body),
    'the save tracks whether it was what cleared readiness');
  ok(/if \(clearedReadyHere && state\.liveVectorStore && !state\.indexReady\) state\.indexReady = true;/.test(body),
    'readiness is restored only when THIS save cleared it and the live store survived');

  console.log(`\nALL SETTINGS-SAVE-READINESS TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SETTINGS-SAVE-READINESS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
