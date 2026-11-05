'use strict';
// Crash-simulation guard for repairInterruptedConsolidation (lib/indexing/init.js). A consolidation re-embeds
// documents from frozen banks into the ACTIVE bank one batch at a time, each batch wrapped in a write-ahead commit
// marker. If the process dies inside a batch, the next boot sees a PENDING commit marker while a migration is
// still in progress. The default recovery would wipe EVERY bank and re-embed the whole corpus; the scoped repair
// instead rebuilds ONLY the active bank (where the torn write always is) and keeps the frozen banks and the
// resumable migration marker, so the move resumes. This test drives the repair with an injected temp cache dir
// (no model, no network) and asserts: the active bank's vectors are cleared and its documents stripped for
// re-embed, the frozen bank and name-only documents are untouched, the marker is cleared, the migration survives —
// and that the repair is FAIL-SAFE (returns false, touching nothing, whenever its preconditions do not hold, so
// the caller falls back to the safe full rebuild). Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));
const commit = require(path.join(PROJECT, 'lib', 'indexing', 'commitmarker'));
const init = require(path.join(PROJECT, 'lib', 'indexing', 'init'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-crash-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

// A deterministic test config so the active-bank fingerprint is reproducible (no live config dependency).
const cfg = {
  useEmbeddingBanks: true,
  EMBEDDINGS_PROVIDER: 'ollama', EMBEDDINGS_MODEL: 'nomic-embed-text',
  OLLAMA_HOST: 'http://localhost:11434', OPENAI_BASE: '', EMBEDDINGS_BASE_URL: '',
};
const activeFp = banks.currentMeta(cfg).fp;
const frozenFp = banks.fingerprint('ollama', 'older-model', 'http://localhost:11434');

const seedBank = (fp) => {
  const dir = banks.bankDir(tmp, fp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'faiss.index'), 'FAKEINDEX');
  fs.writeFileSync(path.join(dir, 'docstore.json'), '{}');
};
const bankStoreExists = (fp) => fs.existsSync(path.join(banks.bankDir(tmp, fp), 'faiss.index'));
const freshManifest = () => ({
  _embeddingModel: 'nomic-embed-text',
  'active-doc.txt':  { fileHash: 'h1', vectorIds: [1, 2], bank: activeFp },
  'frozen-doc.txt':  { fileHash: 'h2', vectorIds: [3, 4], bank: frozenFp },
  'nameonly-doc.txt': { fileHash: 'h3', vectorIds: [] },
});
const seedWorld = () => {
  fs.writeFileSync(banks.registryPath(tmp), JSON.stringify({
    active: activeFp, migratedFp: activeFp,
    banks: [
      { fp: activeFp, provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://localhost:11434', createdAt: 1 },
      { fp: frozenFp, provider: 'ollama', model: 'older-model', baseUrl: 'http://localhost:11434', createdAt: 1 },
    ],
  }));
  seedBank(activeFp); seedBank(frozenFp);
};

(async () => {
  try {
    // ── The repair: an interrupted consolidation rebuilds only the active bank, keeps the rest ──
    {
      seedWorld();
      banks.writeMigration(tmp, { target: activeFp, status: 'running', total: 2, remaining: 1, updatedAt: Date.now() });
      commit.begin(tmp);
      const manifest = freshManifest();
      let saved = null;
      const did = await init.repairInterruptedConsolidation(manifest, { cfg, cacheDir: tmp, saveManifest: async (m) => { saved = JSON.parse(JSON.stringify(m)); } });

      ok(did === true, 'the repair runs when a commit is pending during an in-progress migration');
      ok(!bankStoreExists(activeFp), 'the ACTIVE bank store (the torn write) is cleared');
      ok(bankStoreExists(frozenFp), 'the FROZEN bank store is preserved (not re-embedded)');
      ok(!('active-doc.txt' in manifest), 'the active-bank document is stripped so the delta re-embeds it');
      ok('frozen-doc.txt' in manifest, 'the frozen-bank document is kept (its vectors are intact)');
      ok('nameonly-doc.txt' in manifest, 'a name-only document (no vectors) is kept, not stripped');
      ok(saved && !('active-doc.txt' in saved) && ('frozen-doc.txt' in saved), 'the stripped manifest is persisted');
      ok(commit.isPending(tmp) === false, 'the commit marker is cleared after the repair');
      const mig = banks.readMigration(tmp);
      ok(mig && Number(mig.remaining) === 1, 'the resumable migration marker survives so the move resumes');
    }

    // ── Fail-safe: NO migration in progress → do nothing, leave the marker for the full rebuild ──
    {
      fs.rmSync(banks.bankDir(tmp, activeFp), { recursive: true, force: true });
      seedWorld();
      banks.clearMigration(tmp);
      commit.begin(tmp);
      const manifest = freshManifest();
      let saved = false;
      const did = await init.repairInterruptedConsolidation(manifest, { cfg, cacheDir: tmp, saveManifest: async () => { saved = true; } });
      ok(did === false, 'no migration in progress → the scoped repair declines (caller does the safe full rebuild)');
      ok(bankStoreExists(activeFp), 'with no migration, the active bank is left untouched');
      ok('active-doc.txt' in manifest && saved === false, 'with no migration, the manifest is not stripped or saved');
      ok(commit.isPending(tmp) === true, 'the pending commit marker is left in place for the full rebuild');
    }

    // ── Fail-safe: NO pending commit → nothing to recover ──
    {
      seedWorld();
      banks.writeMigration(tmp, { target: activeFp, status: 'running', total: 2, remaining: 1 });
      commit.end(tmp);
      const did = await init.repairInterruptedConsolidation(freshManifest(), { cfg, cacheDir: tmp, saveManifest: async () => {} });
      ok(did === false, 'no pending commit → nothing to recover');
    }

    // ── Fail-safe: banks OFF → never runs ──
    {
      seedWorld();
      banks.writeMigration(tmp, { target: activeFp, status: 'running', total: 2, remaining: 1 });
      commit.begin(tmp);
      const did = await init.repairInterruptedConsolidation(freshManifest(), { cfg: { ...cfg, useEmbeddingBanks: false }, cacheDir: tmp, saveManifest: async () => {} });
      ok(did === false, 'with embedding banks off, the scoped repair never runs');
      ok(bankStoreExists(activeFp), 'banks off → the active bank is untouched');
    }

    console.log(`\nALL CONSOLIDATION-CRASH-RECOVERY TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ CONSOLIDATION-CRASH-RECOVERY TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
