'use strict';
// Guards the additive, resumable embedding-bank re-embed (Settings → Consolidate). The important properties:
// older banks stay untouched and searchable until every document has moved, work commits in bounded batches,
// an interrupted run keeps a marker and resumes, and the old banks are deleted only after the manifest
// confirms nothing points at them. Also guards the unchanged-content figure guard (a re-embed must not delete
// the figure crops it just reused). Pure/bounded; uses a temp cache dir, no model or network.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-bankmig-'));
(async () => {
try {
  // ── The progress marker is atomic, tolerant of absence/corruption, and cleared on completion ──
  eq(banks.readMigration(tmp), null, 'no marker before a run');
  banks.writeMigration(tmp, { target: 'fp-new', status: 'running', total: 5, remaining: 2, updatedAt: Date.now() });
  const m = banks.readMigration(tmp);
  eq(m.target, 'fp-new', 'the marker names the target bank');
  eq(m.remaining, 2, 'the marker records what is left');
  fs.writeFileSync(banks.migrationPath(tmp), 'not json');
  eq(banks.readMigration(tmp), null, 'a corrupt marker is treated as absent, never a crash');
  banks.writeMigration(tmp, { target: 'fp-new', status: 'paused', total: 5, remaining: 1 });
  banks.clearMigration(tmp);
  eq(banks.readMigration(tmp), null, 'a completed run clears its marker');

  // ── A pathological registry file is treated as corrupt, not read into memory ──
  {
    const bigDir = path.join(tmp, 'bigreg');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(banks.registryPath(bigDir), Buffer.alloc(5 * 1024 * 1024, 65));
    eq(banks.loadRegistry(bigDir).banks.length, 0, 'an oversized registry falls back to a folder rescan');
  }

  // ── Old banks are removed only when asked, and the registry is left with one bank ──
  const keep = { fp: 'keep', provider: 'ollama', model: 'new', baseUrl: 'http://x', createdAt: 1 };
  const old  = { fp: 'old',  provider: 'ollama', model: 'old', baseUrl: 'http://x', createdAt: 1 };
  banks.writeBankMeta(tmp, keep);
  banks.writeBankMeta(tmp, old);
  for (const fp of ['keep', 'old']) fs.writeFileSync(path.join(banks.bankDir(tmp, fp), 'faiss.index'), 'x');
  banks.saveRegistry(tmp, { active: 'keep', migratedFp: 'old', banks: [keep, old] });
  ok(fs.existsSync(banks.bankDir(tmp, 'old')), 'the old bank exists before cleanup');
  const removed = await banks.removeBanksExcept(tmp, 'keep');
  eq(removed, ['old'], 'the old bank is reported as removed');
  ok(!fs.existsSync(banks.bankDir(tmp, 'old')), 'the old bank directory is gone');
  ok(fs.existsSync(banks.bankDir(tmp, 'keep')), 'the target bank is kept');
  const reg = banks.loadRegistry(tmp);
  eq(reg.banks.length, 1, 'one bank remains in the registry');
  eq(reg.active, 'keep', 'the target bank stays active');
  eq(reg.migratedFp, undefined, 'the one-time migration marker is cleared');

  // ── The delta path selects a BOUNDED slice of frozen-bank documents and only real vectors ──
  const delta = read('lib/indexing/delta.js');
  ok(/const runDeltaUpdate = async \(opts = \{\}\) =>/.test(delta), 'the delta accepts migration options');
  ok(/if \(banks && opts\.reembedFp && activeFp === opts\.reembedFp && opts\.reembedLimit > 0\)/.test(delta),
    'a re-embed batch runs only with banks on and a matching target');
  ok(/banks\.entryIsFrozen\(manifest\[f\], activeFp, legacyFp\)/.test(delta),
    'the shared classifier decides which documents are still in an older bank');
  ok(/const legacyFp = banks\.migratedBankOf\(banks\.loadRegistry\(cfgPaths\.CACHE_DIR\), activeMeta, manifest\._embeddingModel\)/.test(delta),
    'untagged (pre-banks) entries are classified against the bank they were migrated into');
  // The classifier itself: a vectorless entry is not work; a tagged entry counts only off the active bank;
  // an untagged entry is active only when the migration proves it.
  const b = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));
  ok(b.entryIsFrozen({ bank: 'old', vectorIds: ['a'] }, 'new', 'old') === true, 'a document in a frozen bank is work');
  ok(b.entryIsFrozen({ bank: 'new', vectorIds: ['a'] }, 'new', 'old') === false, 'a document already in the active bank is not');
  ok(b.entryIsFrozen({ bank: 'old', vectorIds: [] }, 'new', 'old') === false, 'a vectorless document is not work');
  ok(b.entryIsFrozen({ vectorIds: ['a'] }, 'new', 'old') === true, 'an untagged entry in a migrated-away bank is work');
  ok(b.entryIsFrozen({ vectorIds: ['a'] }, 'same', 'same') === false, 'an untagged entry proven active is not work');
  ok(/if \(selected >= opts\.reembedLimit\) break;/.test(delta), 'the batch is bounded');
  ok(/const contentUnchanged = [^;]*manifest\[filePath\]\.fileHash === diskHashes\[filePath\]/.test(delta)
    && /purgedFigs && purgedFigs\.length && !contentUnchanged/.test(delta),
    'an unchanged re-embed keeps the figure crops it reused');

  // ── Consolidate is additive and resumable, and never wipes the index up front ──
  const init = read('lib/indexing/init.js');
  const cstart = init.indexOf('const _consolidateBanksInner');
  const cend = init.indexOf('const consolidateBanks =', cstart);
  ok(cstart !== -1 && cend > cstart, 'the consolidate routine exists');
  const consolidate = init.slice(cstart, cend);
  ok(!/wipeIndexCache\(/.test(consolidate), 'consolidate never wipes the index before moving documents');
  ok(/probeEmbeddingProvider\(\)/.test(consolidate) && /const probeEmbeddingProvider = async/.test(init),
    'each batch probes the provider before purging any document');
  ok(/runDeltaUpdate\(\{ reembedFp: meta\.fp, reembedLimit: BANK_REEMBED_BATCH, hashCache \}\)/.test(consolidate),
    'each batch goes through the normal delta path with a bounded target and the shared hash cache');
  ok(/while \(marker\.remaining > 0\)/.test(consolidate), 'it loops until nothing is left in an old bank');
  ok(/if \(next >= before \|\| \(next < before && !genuinelyMoved\)\)[\s\S]{0,700}?status = 'paused'/.test(consolidate),
    'a batch that moves nothing pauses instead of spinning');
  ok(/const genuinelyMoved = activeAfter > activeBefore;/.test(consolidate) &&
     /const activeVectorCount = \(manifest, targetFp\) =>/.test(init),
    'a failed batch that only marks documents retry-pending is not mistaken for progress');
  ok(/await banks\.removeBanksExcept\(cacheDir, meta\.fp\)/.test(consolidate),
    'old banks are removed only after the loop completes');
  ok(/banks\.writeMigration\(cacheDir, marker\)/.test(consolidate) && /banks\.readMigration\(cacheDir\)/.test(consolidate),
    'progress is persisted and an earlier run is resumed');
  ok(/const BANK_REEMBED_BATCH = 250;/.test(init), 'the batch size is a shared constant');
  ok(/const banksMigrationRunning = \(\) => _consolidating;/.test(init) && /_consolidating = false/.test(init),
    'a live run is distinguishable from a stale marker');
  ok(/banksMigrationRunning\(\)\) return null/.test(read('lib/watchdog.js')),
    'the watchdog stays quiet while a re-embed is actively running');
  // ── The state is surfaced to the UI and the client treats the whole migration as running ──
  const server = read('lib/server.js');
  ok(/state\.indexing \|\| require\('\.\/indexing\/init'\)\.banksMigrationRunning\(\)/.test(server),
    'the Consolidate route refuses a second run even between batches');
  ok(/if \(_consolidating\) return Promise\.resolve\(\{ ok: false, skipped: true/.test(init),
    'a queued duplicate consolidation is skipped before it takes the lifecycle lock');
  ok(/bankMigration: require\('\.\/config'\)\.useEmbeddingBanks \? \(state\.bankMigration \|\| null\) : null/.test(server),
    '/status reports the in-memory migration state (no disk read on a hot endpoint)');
  ok(!/app\.get\('\/status'[\s\S]{0,900}?readMigration/.test(server),
    'the status endpoint never reads the marker file');
  ok(/bankMigration: cfg\.useEmbeddingBanks \? \(state\.bankMigration \|\| null\) : null/.test(server),
    '/api/health shares the same in-memory source');
  const initSrc = read('lib/indexing/init.js');
  ok(/const hydrateBankMigration = \(\) =>/.test(initSrc) && /hydrateBankMigration\(\);/.test(initSrc),
    'the marker is hydrated once per workspace load/switch');
  ok(/contentRebuildPending, hydrateBankMigration, banksMigrationRunning/.test(initSrc),
    'the hydrate helper is exported for the settings save');
  const chat = read('lib/public/js/chat.js');
  ok(/const migrating = bm\.status === 'running';/.test(chat) && /if \(!s\.indexing && !migrating\)/.test(chat),
    'the index-op poller waits for the whole migration, not one batch');
  ok(/Run Consolidate again to resume/.test(chat), 'a paused run tells the user how to resume');

  // ── An unfinished run is surfaced by the watchdog ──
  const watchdog = read('lib/watchdog.js');
  ok(/register\('bank_migration_incomplete'/.test(watchdog) && /watchdog\.bank_migration_incomplete/.test(watchdog),
    'the watchdog reports an unfinished re-embed');
  ok(/Date\.now\(\) - \(Number\(m\.updatedAt\) \|\| 0\) < 5 \* 60 \* 1000/.test(watchdog),
    'a freshly-updated marker is treated as in progress, not stale');

  console.log(`\nALL BANK-MIGRATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ BANK-MIGRATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
})();
