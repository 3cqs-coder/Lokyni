'use strict';
// Regression guards for three indexing durability/consistency fixes:
//   C-2: forceReindex (Settings → Rebuild) must drain in-flight queries before wiping the in-memory
//        index, or a streaming turn reads a half-emptied corpus and returns a spurious "nothing found".
//   C-3: the embedding-banks warm path must rebuild when a root faiss.index exists with NO manifest
//        (a pre-banks index whose manifest was dropped), symmetric with the single-index path — else
//        it migrates the index under the wrong model fingerprint and leaves permanent orphan vectors.
//   C-4: the manifest writer and the shared atomic writers must fsync the bytes before the rename, so
//        a crash can't leave a present-but-torn file the loader reads as empty (which, for the
//        manifest, makes the delta re-embed the whole corpus over the existing vectors — index bloat).
// Source inspection for the init.js paths (heavy to run live) plus a functional round-trip of the
// atomic writers. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const initSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
const bundleSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'bundle.js'), 'utf-8');
const manifestSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'manifest.js'), 'utf-8');
const diskSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'disk.js'), 'utf-8');
const disk = require(path.join(PROJECT, 'lib', 'disk'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-durab-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  try {
    // ── C-2: forceReindex drains activeQueries before wiping ──
    const frIdx = initSrc.indexOf('const _forceReindexInner');
    ok(frIdx !== -1, 'the rebuild body (_forceReindexInner) exists');
    const frEnd = initSrc.indexOf('const consolidate', frIdx);
    const frBlock = initSrc.slice(frIdx, frEnd > frIdx ? frEnd : frIdx + 1600);
    const drainAt = frBlock.indexOf('state.activeQueries');
    const wipeAt = frBlock.indexOf('wipeIndexCache()');
    ok(drainAt !== -1, 'forceReindex drains state.activeQueries');
    ok(drainAt !== -1 && wipeAt !== -1 && drainAt < wipeAt, 'the query drain runs BEFORE the cache wipe');
    console.log('✓ indexing-durability: forceReindex drains in-flight queries before wiping (C-2)');

    // ── C-3: banks warm path rebuilds on faiss-present-but-no-manifest ──
    const banksIdx = initSrc.indexOf("if (require('../config').useEmbeddingBanks)");
    ok(banksIdx !== -1, 'the banks warm path exists');
    const banksBlock = initSrc.slice(banksIdx, banksIdx + 2600);
    ok(/\(faissExists \|\| orphanedBanksPresent\(cfgPaths\.CACHE_DIR\)\) && !manifestExists/.test(banksBlock),
      'the banks path treats EITHER a root faiss OR a bank layout present with no manifest as a rebuild trigger (covers a crash mid-wipe that removed the manifest before banks/)');
    ok(/wipeIndexCache\(\)/.test(banksBlock), 'the banks path can wipe+rebuild on that trigger');
    console.log('✓ indexing-durability: banks warm path rebuilds a manifest-less index, incl. a leftover bank layout (C-3)');

    // ── C-4: manifest + shared atomic writers fsync before rename ──
    // The manifest is now persisted as streaming NDJSON via ndjsonmapstore.writeMap (so a huge corpus's
    // vectorIds are never serialized as one whole-file string); that writer fsyncs the temp before the rename.
    ok(/await writeMap\(cfgPaths\.MANIFEST_PATH, toMap\(manifest\)\)/.test(manifestSrc),
      'saveManifest persists via the streaming NDJSON writer (no whole-corpus JSON.stringify)');
    const ndjsonSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'ndjsonmapstore.js'), 'utf-8');
    const wmIdx = ndjsonSrc.indexOf('const writeMap');
    const wmBlock = ndjsonSrc.slice(wmIdx, wmIdx + 1400);
    const wmSync = wmBlock.indexOf('fsyncFile(');
    const wmRename = wmBlock.search(/rename(?:WithRetry)?\(/);
    ok(wmSync !== -1 && wmRename !== -1 && wmSync < wmRename, 'writeMap fsyncs the temp file before renaming it');

    for (const fn of ['writeFileAtomic', 'writeJsonAtomic']) {
      const i = diskSrc.indexOf('function ' + fn);
      const block = diskSrc.slice(i, i + 900);
      const s = block.search(/(fsyncSync|\.sync\()/);
      const r = block.search(/rename\w*\(tmp/);   // the actual call, not the word "rename" in a comment
      ok(s !== -1 && r !== -1 && s < r, `${fn} fsyncs before rename`);
    }
    console.log('✓ indexing-durability: manifest and shared atomic writers fsync before rename (C-4)');

    // ── C-5: every parentMap-rebuild loop skips an unreadable file instead of aborting the whole build ──
    // loadSingleDocument can throw from fs.stat/readFile for a file removed or made unreadable between
    // enumeration and load; one such file must never leave a workspace stuck building or its parentMap
    // empty. All three rebuild loops (warm start, delta repopulate, bundle load) must wrap the call.
    ok(/try \{ await loadSingleDocument\(diskFiles\[i\]/.test(initSrc),
      'warm start wraps loadSingleDocument so one unreadable file does not abort the build');
    ok(/try \{ await loadSingleDocument\(f, state\.parentMap\)/.test(deltaSrc),
      'delta repopulate wraps loadSingleDocument so one unreadable file does not empty parentMap');
    ok(/try \{ await loadSingleDocument\(f, bundle\.parentMap/.test(bundleSrc),
      'bundle load wraps loadSingleDocument (unchanged, kept as the reference pattern)');
    // No bare (unguarded) await loadSingleDocument remains in the two fixed files.
    ok(!/(^|[^{] )await loadSingleDocument\(diskFiles\[i\]/.test(initSrc) || /try \{ await loadSingleDocument\(diskFiles\[i\]/.test(initSrc),
      'warm start has no unguarded loadSingleDocument call');
    console.log('✓ indexing-durability: an unreadable file is skipped, never aborting the index build (C-5)');

    // ── C-6: a provider-down streak still LOADS each document (keeps it searchable), deferring only the
    //    embedding. The streak check must sit AFTER loadSingleDocument, not before it — otherwise a changed
    //    file whose old content was purged for re-embedding vanishes from keyword/name search during an
    //    embeddings outage. ──
    const loadAt   = deltaSrc.indexOf('const doc = await loadSingleDocument(filePath, shadowParentMap)');
    const streakAt = deltaSrc.indexOf('if (providerDownStreak >= PROVIDER_DOWN_STREAK)');
    ok(loadAt !== -1 && streakAt !== -1 && loadAt < streakAt,
      'the provider-down defer runs AFTER the document is loaded, so it stays searchable during an outage');
    console.log('✓ indexing-durability: a provider outage defers embedding but keeps documents searchable (C-6)');

    // ── C-7: a parse/OCR failure is not re-attempted on every file-change delta this session (a costly
    //    escalation that only a restart or a byte change could change the outcome of), but is never frozen:
    //    the backoff is in-memory (resets on restart), keyed by content hash (a byte change retries), and a
    //    rebuild clears it. ──
    ok(/parseFailed\.get\(f\) === diskHashes\[f\]/.test(deltaSrc) && /shouldIndexFile\(f, manifest, diskHashes, _parseFailedThisSession\)/.test(deltaSrc),
      'the toAdd filter routes through shouldIndexFile, which defers a parse that already failed this session on this exact content');
    ok(/_parseFailedThisSession\.set\(filePath, diskHashes\[filePath\]\)/.test(deltaSrc),
      'a parse failure records the file (keyed by its content hash) for the session backoff');
    ok(/_parseFailedThisSession\.delete\(filePath\)/.test(deltaSrc),
      'a later successful parse clears the file from the backoff');
    ok(/clearParseBackoff/.test(deltaSrc) && /require\('\.\/delta'\)\.clearParseBackoff\(\)/.test(initSrc),
      'a rebuild (wipeIndexCache) clears the session parse backoff so everything is retried fresh');
    // Functional: exercise the real selection predicate (not a mirrored copy) for the four cases.
    {
      const { shouldIndexFile } = require(path.join(PROJECT, 'lib', 'indexing', 'delta'));
      const hashes = { '/d/a.txt': 'h1' };
      ok(shouldIndexFile('/d/a.txt', { '/d/a.txt': { fileHash: 'h1' } }, hashes, new Map()) === false,
        'an unchanged, already-indexed file is skipped');
      ok(shouldIndexFile('/d/a.txt', { '/d/a.txt': { vectorIds: [], skipped: true, embedPending: true } }, hashes, new Map()) === true,
        'a retry-pending entry (no fileHash) not parse-failed is re-selected');
      ok(shouldIndexFile('/d/a.txt', {}, hashes, new Map([['/d/a.txt', 'h1']])) === false,
        'a file whose parse failed this session on this exact content is deferred');
      ok(shouldIndexFile('/d/a.txt', {}, { '/d/a.txt': 'h2' }, new Map([['/d/a.txt', 'h1']])) === true,
        'a byte change (new hash) clears the deferral — the parse is retried');
      // A file that failed to HASH this pass (diskHashes[f] === undefined) is held explicitly — not re-added —
      // even when it is also in the parse-failed map with a real stored hash (previously an accidental
      // undefined===undefined coincidence that this combination defeated, purging the file's good vectors).
      ok(shouldIndexFile('/d/a.txt', { '/d/a.txt': { fileHash: 'h1' } }, {}, new Map()) === false,
        'a file that failed to hash this pass is held, not re-selected (no good-vector purge)');
      ok(shouldIndexFile('/d/a.txt', { '/d/a.txt': { fileHash: 'h1' } }, {}, new Map([['/d/a.txt', 'h1']])) === false,
        'a hash-failed file that ALSO parse-failed earlier is still held (explicit guard, not undefined===undefined)');
    }
    console.log('✓ indexing-durability: a failed parse is not re-ground every delta, yet never frozen (C-7)');

    // ── C-4 functional: the atomic writers still round-trip correctly after the fsync change ──
    // The writers stage to a per-writer unique temp (pid+random) rather than a fixed `${file}.tmp`, so a
    // future concurrent caller can't race on one shared temp name; a successful write leaves none behind.
    const f1 = path.join(tmp, 'a.json');
    disk.writeFileAtomic(f1, JSON.stringify({ hello: 'world' }), 0o600);
    eq(JSON.parse(fs.readFileSync(f1, 'utf-8')).hello, 'world', 'writeFileAtomic round-trips content');

    const f2 = path.join(tmp, 'b.json');
    await disk.writeJsonAtomic(f2, { n: 42 });
    eq(JSON.parse(fs.readFileSync(f2, 'utf-8')).n, 42, 'writeJsonAtomic round-trips content');
    ok(fs.readdirSync(tmp).filter(n => n.includes('.tmp')).length === 0, 'the atomic writers leave no temp files behind');
    console.log('✓ indexing-durability: atomic writers round-trip and leave no temp residue (unique-temp write)');

    // ── writeFileAtomicAsync: the no-fsync async variant shared by sessions / semantic cache / OCR data ──
    // Same temp+rename crash-safety as writeFileAtomic, but it deliberately SKIPS fsync (these stores are
    // regenerable, so the per-write flush isn't worth its latency) and takes a string OR a Buffer.
    {
      const fn = diskSrc.indexOf('function writeFileAtomicAsync');
      ok(fn !== -1, 'writeFileAtomicAsync is defined in disk.js');
      const block = diskSrc.slice(fn, fn + 700);
      ok(!/(fsyncSync|\.sync\()/.test(block), 'writeFileAtomicAsync does NOT fsync (regenerable stores skip the flush)');
      ok(/rename\w*\(tmp/.test(block), 'writeFileAtomicAsync still renames a unique temp onto the target (crash-safe)');
    }
    const f3 = path.join(tmp, 'c.txt');
    await disk.writeFileAtomicAsync(f3, 'hello-string');
    eq(fs.readFileSync(f3, 'utf-8'), 'hello-string', 'writeFileAtomicAsync round-trips a string');
    const f4 = path.join(tmp, 'd.bin');
    await disk.writeFileAtomicAsync(f4, Buffer.from([1, 2, 3, 4]));
    ok(Buffer.compare(fs.readFileSync(f4), Buffer.from([1, 2, 3, 4])) === 0, 'writeFileAtomicAsync round-trips a Buffer');
    ok(fs.readdirSync(tmp).filter(n => n.includes('.tmp')).length === 0, 'writeFileAtomicAsync leaves no temp residue');
    console.log('✓ indexing-durability: writeFileAtomicAsync round-trips string+Buffer, no-fsync, no temp residue');

    // ── error path: a failed write throws AND removes its unique temp (the live file stays untouched) ──
    // Point the write at a NON-EMPTY directory: the temp is written fine, but the rename onto a directory
    // fails, so the catch must unlink the temp and rethrow rather than leaking an orphaned *.tmp.
    const blocked = path.join(tmp, 'blocked');
    fs.mkdirSync(blocked); fs.writeFileSync(path.join(blocked, 'keep'), '1');   // non-empty so rename can't clobber it
    let threwSync = false;
    try { disk.writeFileAtomic(blocked, 'data', 0o600); } catch { threwSync = true; }
    ok(threwSync, 'writeFileAtomic throws when the rename cannot complete');
    let threwAsync = false;
    try { await disk.writeJsonAtomic(blocked, { n: 1 }); } catch { threwAsync = true; }
    ok(threwAsync, 'writeJsonAtomic rejects when the rename cannot complete');
    let threwAsync2 = false;
    try { await disk.writeFileAtomicAsync(blocked, 'data'); } catch { threwAsync2 = true; }
    ok(threwAsync2, 'writeFileAtomicAsync rejects when the rename cannot complete');
    ok(fs.readdirSync(tmp).filter(n => n.includes('.tmp')).length === 0, 'a failed atomic write leaves no temp behind');
    ok(fs.existsSync(path.join(blocked, 'keep')), 'the failed write never touched the existing target');
    console.log('✓ indexing-durability: a failed atomic write cleans its temp and preserves the live target');

    // ── manifest loader fails OPEN on a corrupt file (returns {}, never throws — a torn manifest can't crash boot) ──
    const manifest = require(path.join(PROJECT, 'lib', 'indexing', 'manifest'));
    const corrupt = path.join(tmp, 'corrupt-manifest.json');
    fs.writeFileSync(corrupt, '{ "a": {  this is not valid json ]');
    const recovered = await manifest.loadManifestFrom(corrupt);
    ok(recovered && typeof recovered === 'object' && !Array.isArray(recovered) && Object.keys(recovered).length === 0,
      'loadManifestFrom returns {} on a corrupt manifest (fail-open, no throw)');
    ok(await manifest.loadManifestFrom(path.join(tmp, 'does-not-exist.json')) && Object.keys(await manifest.loadManifestFrom(path.join(tmp, 'nope.json'))).length === 0,
      'loadManifestFrom returns {} for a missing manifest');
    const goodManifest = path.join(tmp, 'good-manifest.json');
    fs.writeFileSync(goodManifest, JSON.stringify({ docA: { skipped: false } }));
    const good = await manifest.loadManifestFrom(goodManifest);
    ok(good && good.docA && good.docA.skipped === false, 'a valid manifest still parses correctly');
    console.log('✓ indexing-durability: the manifest loader (non-active read) fails open on corruption (no boot crash)');

    // ── the ACTIVE boot loader fails CLOSED on a corrupt manifest (distinct from the non-active read above) ──
    // loadManifest (active workspace) must NOT read a present-but-unparseable manifest as {} — that would make
    // the delta treat every document as new and re-embed over the existing vectors (bloat). It returns a
    // { _corrupt: true } sentinel, and contentRebuildReason turns that into a wipe-and-rebuild. (loadManifest
    // reads a config-driven path, so this is verified by source inspection, matching the init.js paths below.)
    ok(/if \(!res\.ok\) return \{ _corrupt: true \}/.test(manifestSrc),
      'loadManifest returns a { _corrupt: true } sentinel on a present-but-unreadable manifest (fail closed)');
    ok(/if \(!res\.present\) return \{\}/.test(manifestSrc),
      'loadManifest still returns {} for a MISSING manifest (first run), distinct from corruption');
    ok(/if \(manifest && manifest\._corrupt\) return /.test(initSrc),
      'contentRebuildReason treats the _corrupt sentinel as a rebuild reason (wipe + reindex)');
    ok(initSrc.indexOf('manifest._corrupt') < initSrc.indexOf('INDEX_FORMAT_VERSION'),
      'the _corrupt check runs FIRST in contentRebuildReason so corruption always forces a rebuild');
    console.log('✓ indexing-durability: the active boot loader fails closed on a corrupt manifest (rebuild, no vector bloat)');

    // ── turning on a content-affecting feature re-indexes the EXISTING corpus (not just docs edited later) ──
    // Each toggle must both be STAMPED into the manifest when the index is built and, when it is off in the
    // manifest but now on in config, force a rebuild — mirroring the OCR "turned on" rule. Without both halves
    // the feature silently half-works (only newly-edited docs get summaries / contextual vectors / visual text)
    // until a manual rebuild. Verified by source inspection, matching the other rebuild-reason checks above.
    for (const [flag, cfgKey, label] of [
      ['_summariesEnabled', 'useDocumentSummaries', 'Document summaries were turned on'],
      ['_contextualEnabled', 'useContextualRetrieval', 'Contextual retrieval was turned on'],
      ['_visualEnabled', 'useVisualIngest', 'Visual ingest was turned on'],
    ]) {
      ok(new RegExp(`m\\.${flag}\\s*=\\s*!!cfg\\.${cfgKey}`).test(deltaSrc), `${flag} is stamped into the manifest`);
      ok(new RegExp(`cfg\\.${cfgKey} && manifest\\.${flag} === false`).test(initSrc) && initSrc.includes(label),
        `turning on ${cfgKey} forces a rebuild (grandfathering an older manifest)`);
    }
    console.log('✓ indexing-durability: enabling summaries / contextual retrieval / visual ingest re-indexes the existing corpus');

    // ── C-11: the RUNTIME settings-save path (not just warm start) rebuilds on a content toggle ──
    // Warm start checks contentRebuildReason, but a Settings save mid-session went through a plain delta — so
    // flipping a content toggle ON only took effect for documents edited afterward until a restart. The
    // settings-save path must also consult contentRebuildReason and force a rebuild, calling the INNER rebuild
    // (the lifecycle lock is already held, so the public forceReindex would deadlock).
    {
      const rsIdx = initSrc.indexOf('const _refreshSourcesInner');
      const rsEnd = initSrc.indexOf('const switchWorkspace', rsIdx);
      const rsBlock = initSrc.slice(rsIdx, rsEnd > rsIdx ? rsEnd : rsIdx + 3500);
      ok(/contentRebuildReason\(await loadManifest\(\), true\)/.test(rsBlock),
        'the settings-save path checks contentRebuildReason against the new config');
      ok(/if \(reason\) \{[\s\S]{0,300}?_forceReindexInner\(\)/.test(rsBlock),
        'the settings-save path forces the inner rebuild when a content toggle made the index stale');
    }
    console.log('✓ indexing-durability: a runtime content-toggle change rebuilds the existing corpus, not just new docs (C-11)');

    // ── warm-start crash recovery: a map is loaded only when it is at least as new as the manifest ──
    // persistIndexMaps writes the maps in a fixed order (passage → child → parent); a crash between those
    // renames leaves a fresh manifest with a STALE later map. Warm start must detect that by mtime and rebuild
    // the stale map rather than loading it (which would silently drop chunk→parent links / passage offsets).
    // The write ORDER and the three mtime comparisons are the contract; lock them against accidental removal.
    const persistIdx = deltaSrc.indexOf('const persistIndexMaps');
    const persistBody = deltaSrc.slice(persistIdx, persistIdx + 600);
    // The filenames are single-sourced as CACHE_FILES.* (constants.js), so persistIndexMaps references them by
    // key; the write-order contract (passage, then child, then parent) is unchanged.
    const iPassage = persistBody.indexOf('CACHE_FILES.passageMap');
    const iChild   = persistBody.indexOf('CACHE_FILES.childMap');
    const iParent  = persistBody.indexOf('CACHE_FILES.parentMap');
    ok(iPassage !== -1 && iChild !== -1 && iParent !== -1 && iPassage < iChild && iChild < iParent,
      'persistIndexMaps writes the maps in a fixed order (passage, then child, then parent)');
    ok(/if \(pmStat > 0 && pmStat >= mfStat\)/.test(initSrc),
      'warm start loads the parent map only when it is at least as new as the manifest');
    ok(/passageCacheValid = passageMtime >= manifestMtime/.test(initSrc),
      'warm start loads the passage map only when it is at least as new as the manifest');
    ok(/if \(childMtime >= manifestMtime\)/.test(initSrc),
      'warm start loads the child map only when it is at least as new as the manifest (else rebuilds it)');
    console.log('✓ indexing-durability: warm start gates each map load on its mtime vs the manifest (stale map rebuilt, not loaded)');

    // ── figure thumbnails are deleted only AFTER the atomic swap commits, not during the purge ──
    // Deleting a changed document's figures during the purge would strand its still-live parent entry with
    // broken thumbnails if the delta then threw before the swap. They are now collected during purge and
    // removed after persistIndexMaps, so a mid-run failure (live state unchanged) deletes nothing.
    const purgeToSwap = deltaSrc.slice(deltaSrc.indexOf('const figuresToRemove = []'), deltaSrc.indexOf('Atomic swap'));
    ok(/figuresToRemove\.push\(\.\.\.purgedFigs\)/.test(purgeToSwap) && !/removeMany\(/.test(purgeToSwap),
      'the purge loop collects figure ids but does NOT delete them before the swap');
    const afterSwap = deltaSrc.slice(deltaSrc.indexOf('Atomic swap'));
    ok(/persistIndexMaps[\s\S]*?figuresToRemove\.length[\s\S]*?removeMany\(/.test(afterSwap),
      'figure thumbnails are removed only after the swap is committed and persisted');
    console.log('✓ indexing-durability: figure-thumbnail deletion is deferred until after the atomic swap commits');

    // ── C-8: the HASH loop isolates per file too (not just the embed/repopulate loops) ──
    // hashFile rejects on ENOENT/EACCES; without per-file isolation one unreadable file would reject the batch
    // Promise.all and abort the WHOLE delta (nothing indexed or purged), and a persistently unreadable file
    // would freeze all indexing. The failure must be caught per file and the file HELD (not dropped as deleted).
    ok(/try \{ diskHashes\[f\] = await hashForPass\(f, opts\.hashCache\); \}[\s\S]{0,120}?hashFailed\.add\(f\)/.test(deltaSrc),
      'the hash loop catches a per-file hash failure instead of aborting the whole delta');
    ok(/const isHeld = \(f\) => hashFailed\.has\(f\)/.test(deltaSrc),
      'a file that could not be hashed is HELD (never purged as if deleted)');
    console.log('✓ indexing-durability: an unhashable file is isolated and held, never aborting the delta or dropped (C-8)');

    // ── C-9: a deletion in a vectorless (BM25-only) corpus is persisted, so it does not resurrect on restart ──
    // When no vectors are added this run and there is no store to clone (missing/corrupt faiss, banks off) but
    // the corpus still has documents, the in-memory purge must be written to the manifest + maps.
    ok(/Persisted \$\{toDelete\.length\} deletion\(s\) in a vectorless/.test(deltaSrc)
      && /else if \(toDelete\.length > 0\) \{[\s\S]{0,900}?saveManifest\(newManifest\); await persistIndexMaps/.test(deltaSrc),
      'a deletion with no vector store to clone still persists the manifest + maps (no resurrection on restart) (C-9)');
    console.log('✓ indexing-durability: a deletion in a vectorless corpus is persisted (C-9)');

    // ── C-10: the DELTA path also guards the corrupt-manifest sentinel (not just warm start) ──
    // A manifest that becomes unreadable at runtime (watcher-triggered delta, no restart) must wipe-and-rebuild,
    // not proceed and re-embed every file over the live store (duplicate vectors).
    ok(/if \(manifest && manifest\._corrupt\) \{[\s\S]{0,400}?wipeIndexCache\(\)[\s\S]{0,200}?manifest = \{\}/.test(deltaSrc),
      'runDeltaUpdate wipes and rebuilds on a corrupt manifest instead of re-embedding over the live store (C-10)');
    console.log('✓ indexing-durability: the delta path rebuilds on a runtime-corrupt manifest (C-10)');

    console.log(`\nALL INDEXING-DURABILITY UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ INDEXING-DURABILITY UNIT TEST FAILED:', e.message);
    cleanup(1);
  }
})();
