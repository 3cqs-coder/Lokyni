'use strict';
const fsSync = require('fs');
const fs     = require('fs').promises;
const path   = require('path');
const { CACHE_FILES } = require('../constants');   // single source for the index artifact filenames
const { fsyncFile } = require('../disk');   // shared durable-write fsync (single-sourced; see disk.js)
const { FaissStore } = require('@langchain/community/vectorstores/faiss');
const { DEBUG, BATCH_SIZE, CONCURRENCY, MIN_FILE_SIZE } = require('../config');
// Workspace-relative paths must be read live — destructuring would capture the
// directory of whichever workspace happened to be active at import time.
const cfgPaths = require('../config');
const state  = require('../state');
// Documents whose parse/OCR failed THIS session, keyed by path → the content hash at the failed attempt.
// A parse failure is environment-bound (memory pressure, a limit too low), so re-running the full, costly
// isolate → single-worker-OCR → text-only escalation on every unrelated file-change delta wastes minutes to
// no benefit. Retry only when the outcome could plausibly change: the file's bytes change (new hash here),
// a rebuild runs (clears this), or the process restarts (this is in-memory, so it starts empty — a fresh,
// possibly larger run). This never freezes a document: it stays indexed by name meanwhile and never loses
// its retry-pending manifest state. Provider-down (embed-deferred) files are intentionally NOT tracked here,
// so they still retry the moment the provider recovers.
const _parseFailedThisSession = new Map();
const clearParseBackoff = () => _parseFailedThisSession.clear();

// Decide whether a discovered file should be (re)indexed this pass. Pure (no module state) so it is
// directly unit-testable. A file unchanged since it was indexed (its stored hash equals the disk hash) is
// skipped. A retry-pending entry carries no fileHash, so it never matches and is re-selected — UNLESS its
// parse already failed this session on this exact content, in which case it waits for a byte change (a new
// hash), a rebuild (clears the backoff map), or a restart (the map starts empty). Nothing is ever frozen:
// the document stays indexed by name and keeps its retry-pending manifest state throughout.
const shouldIndexFile = (f, manifest, diskHashes, parseFailed) => {
  // A file that failed to hash this pass (diskHashes[f] === undefined) must NOT be re-added: we can't tell
  // whether it changed, and re-embedding a present, unchanged file would purge its still-good vectors. This
  // was previously only an accidental `undefined === undefined` coincidence in the parseFailed check below;
  // make it an explicit guard so a future sentinel/null hash or refactor can't silently re-select the file.
  if (diskHashes[f] === undefined) return false;
  if (manifest[f] && manifest[f].fileHash === diskHashes[f]) return false;   // unchanged, already indexed
  if (parseFailed.get(f) === diskHashes[f]) return false;                    // parse already failed this session
  return true;
};
const { makeEmbeddings, embedBounded } = require('../embeddings');
const { raceTimeout } = require('../llm');
// Bound a batch embed during indexing so a black-holed provider (accepts the connection but never
// responds) can't hang the whole index run forever. Generous vs. the query-time bound because a
// batch is heavier — scaled by batch size so no working provider ever trips it. On a timeout the
// caller falls back to embedding one chunk at a time (each bounded by embedBounded); a genuinely
// hung chunk is then skipped exactly as a provider error already is, so a stall causes no new data
// loss (a fully-down provider takes this same retry-then-skip path today).
const embedBatchBounded = (embeddings, texts) =>
  // Read EMBED_TIMEOUT_MS live (require the current config module), not from the import-time snapshot:
  // hot-reload replaces the config module object, so a captured value would stay at its boot value after a
  // Settings change. The per-chunk path already reads it live; this keeps the batch bound consistent.
  raceTimeout(embeddings.embedDocuments(texts), Math.max(require('../config').EMBED_TIMEOUT_MS, texts.length * 2000));
// The vector dimension an initialized FAISS store already holds, or null when it is empty/unreadable.
// A bank's dimension is fixed by the first vectors added to it; every later vector must match it (FAISS
// rejects a mismatch, which would otherwise throw mid-delta). Different embedding MODELS get different
// banks, so a mismatch here means the SAME model identity changed the dimension it emits — a re-quantized
// or swapped local model under an unchanged name. Guarded and best-effort: never throws.
const storeDimension = (store) => {
  try {
    if (!store || !store.index) return null;
    const n = typeof store.index.ntotal === 'function' ? store.index.ntotal() : store.index.ntotal;
    if (!n) return null;   // empty store — no dimension set yet
    const d = typeof store.index.getDimension === 'function' ? store.index.getDimension() : null;
    return (Number.isFinite(d) && d > 0) ? d : null;
  } catch { return null; }
};
const { buildOrReuseBM25Index }  = require('../retrieval/bm25');
const { buildChunkIndexInto } = require('../retrieval/passages');
const { loadManifest, saveManifest } = require('./manifest');
const commit = require('./commitmarker');
const { collectAllFiles, hashFile, loadSingleDocument, docIdFor } = require('./files');
const { hashForPass } = require('./hashcache');
const { semanticSplitDocument } = require('./chunking');

// Stamp the manifest with the versions warm start compares against to decide whether an
// existing index is still valid: the embedding model, the index-map format, and the OCR and
// visual-ingest pipeline versions. Kept in one place so the two manifest-write sites below
// can never drift apart, and so a new pipeline version is recorded automatically once and then
// enforced by init.js on the next bump.
const stampManifestVersions = (m) => {
  const cfg = require('../config');
  m._embeddingModel = cfg.EMBEDDINGS_MODEL;
  // One fingerprint for the full embedding identity (provider + model + endpoint). A provider or endpoint
  // change with the same model name is a different vector space, so the model name alone is not enough.
  // The manifest is the warm-start commit marker; this stamp is what init.js and the banks-off delta compare.
  m._embeddingIdentity = require('./banks').currentMeta(cfg).fp;
  m._indexFormat    = require('../constants').INDEX_FORMAT_VERSION;
  m._ocrPipeline    = require('../ocrcache').OCR_PIPELINE_VERSION;
  m._visualPipeline = require('../visualcache').VISUAL_PIPELINE_VERSION;
  // Whether OCR / vision-describe were enabled when this index was built, so turning them ON later
  // re-reads the scanned documents that were indexed by name only instead of leaving them name-only.
  m._ocrEnabled     = !!cfg.USE_OCR;
  m._visionEnabled  = !!cfg.VISION_DESCRIBE;
  // Whether the other content-affecting features were enabled when this index was built. Turning any of them
  // ON later must re-index the EXISTING corpus, not just documents edited afterward: summaries add a summary
  // block + chunk per doc, contextual retrieval changes every chunk's embedding vector, and visual ingest adds
  // image-derived content. Without these stamps the feature would silently half-work until a manual rebuild.
  m._summariesEnabled  = !!cfg.useDocumentSummaries;
  m._contextualEnabled = !!cfg.useContextualRetrieval;
  m._visualEnabled     = !!cfg.useVisualIngest;
  // The embedding context window changes how every document is chunked for embedding (chunking.js reads it), so
  // changing it must re-embed the corpus — otherwise existing documents keep vectors built at the old window.
  m._embeddingContextTokens = require('../config').EMBEDDING_CONTEXT_TOKENS;
  // The OCR settings that change the extracted TEXT for the same bytes. Raising the page cap, switching the
  // engine, or changing the vision model must re-OCR the scanned documents — otherwise a document scanned at
  // a lower page cap stays truncated forever, and the in-app "raise Max pages and re-index" remedy would do
  // nothing (the cached partial text is served). Stamped so contentRebuildReason can force a rebuild on change.
  m._ocrMaxPages    = cfg.USE_OCR ? cfg.OCR_MAX_PAGES : null;
  m._ocrEngine      = cfg.USE_OCR ? (cfg.OCR_ENGINE || 'tesseract') : null;
  m._ocrLanguages   = (cfg.USE_OCR && cfg.OCR_ENGINE === 'tesseract') ? (cfg.OCR_LANGUAGES || []).slice().sort().join('+') : null;
  m._ocrVisionModel = (cfg.USE_OCR && cfg.OCR_ENGINE === 'vision') ? (cfg.OCR_VISION_MODEL || '') : null;
  // Vision-describe output (stored in the OCR cache, keyed only on the image bytes + pipeline version) changes
  // when the describe MODEL or its generation params change. Stamp the single-sourced describe signature so
  // contentRebuildReason can re-describe unchanged images on such a change (otherwise the cache serves the old
  // model's text forever). null when describe is off — the on↔off case is handled by _visionEnabled above.
  m._visionDescribeSig = require('../vision').describeSignature(cfg);
  return m;
};

// Persist the three in-memory index maps to the cache dir. The parent map carries each document's full
// text + metadata so loading a NON-active workspace (which the public API does on demand) is a cheap read
// instead of re-deriving/OCRing every source file. All three stream to a unique temp file and rename
// atomically (via their stores), so a crash mid-write can't leave a truncated file that fails to load on
// next start and forces a full re-index. Streaming NDJSON (rather than one whole-corpus JSON string) also
// keeps peak memory to one entry at a time and never blocks the event loop on a giant serialize/parse.
const { writeParentMap } = require('./parentmapstore');
const { writeMap } = require('./ndjsonmapstore');
const persistIndexMaps = async (cacheDir, idx) => {
  await writeMap(path.join(cacheDir, CACHE_FILES.passageMap), idx.passageMap);
  await writeMap(path.join(cacheDir, CACHE_FILES.childMap),   idx.childMap);
  // The parent map holds every document's full text, so it uses the content-aware store; the two small
  // maps above use the generic key/value store — same crash-safe, fail-closed NDJSON discipline.
  await writeParentMap(path.join(cacheDir, CACHE_FILES.parentMap), idx.parentMap);
  if (DEBUG) console.log(`✅ index maps saved — ${idx.parentMap.size} docs, ${idx.childMap.size} chunks, ${idx.passageMap.size} passages`);
};

// Save a FAISS store atomically: write it into a temp dir, fsync both files, then rename them into place.
// FaissStore.save overwrites faiss.index/docstore.json IN PLACE, so a crash or full disk mid-write corrupts
// the live index; writing to a temp dir first keeps the last good copy intact until the rename.
//
// The two files are coupled: docstore.json holds the faiss-label → document mapping for the vectors in
// faiss.index. Rename docstore.json FIRST, then faiss.index. A crash between the renames then leaves the OLD
// (smaller) index beside the NEW (larger) mapping — every live label still resolves, so queries keep working
// and only the newest vectors are briefly missing until the next delta heals it. The reverse order would
// leave the NEW index beside the OLD mapping, where a query hitting a new label finds no mapping entry and
// THROWS, failing every query that touches a new vector. fsync before rename so a power loss can't leave a
// present-but-torn file the loader misreads (matching the manifest and the shared atomic writers). The fsync
// itself is the shared `disk.fsyncFile` (imported above) so this durable-write discipline stays single-sourced.
const saveStoreAtomic = async (store, dir) => {
  const tmp = path.join(dir, '_save_tmp');
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(tmp, { recursive: true });
  await store.save(tmp);
  for (const f of [CACHE_FILES.docstore, CACHE_FILES.faissIndex]) await fsyncFile(path.join(tmp, f));
  for (const f of [CACHE_FILES.docstore, CACHE_FILES.faissIndex]) {
    await require('../disk').renameWithRetry(path.join(tmp, f), path.join(dir, f));
  }
  await require('../disk').fsyncDir(dir);   // make both renames durable (not just the files' bytes)
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
};

const embedChunks = async (chunks, embeddings) => {
  const batches = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) batches.push(chunks.slice(i, i + BATCH_SIZE));
  const results = [];
  let skipped = 0;

  // A batch can fail for reasons specific to one chunk — most commonly a chunk that
  // exceeds the embedding model's context window. Previously that rejected the whole
  // Promise.all and aborted the entire index run, so one bad document meant nothing
  // got indexed. Instead, retry a failed batch one chunk at a time and skip only the
  // chunks that genuinely fail, so the rest of the corpus still indexes.
  const embedOneByOne = async (batch, batchNum) => {
    const okDocs = [], okVecs = [];
    for (const doc of batch) {
      try {
        const [vec] = await embedBounded(embeddings.embedDocuments([doc.pageContent]));
        okDocs.push(doc); okVecs.push(vec);
      } catch (e) {
        // A provider-level failure (timeout, provider down, or the local model still downloading) is NOT a bad
        // chunk — skipping chunks here would permanently lose them. Abort to the caller as provider-down so the
        // whole file is deferred (retry-pending) and retried once the provider is ready.
        if (e && (e._lokTimeout || e.providerDown || e.downloading)) throw Object.assign(new Error('embeddings provider unavailable'), { providerDown: true });
        skipped++;
        const src = doc.metadata?.source ? require('path').basename(doc.metadata.source) : 'unknown';
        if (DEBUG) console.warn(`  ⚠️  Skipped a chunk from ${src} (${doc.pageContent.length} chars): ${e.error || e.message}`);
      }
    }
    if (DEBUG) console.log(`  ↩️  Batch ${batchNum} recovered ${okDocs.length}/${batch.length} chunk(s)`);
    return { batch: okDocs, vecs: okVecs };
  };

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(slice.map(async (batch, j) => {
      const batchNum = i + j + 1;
      if (DEBUG) console.log(`  ➡️  Embedding batch ${batchNum}/${batches.length}`);
      try {
        const vecs = await embedBatchBounded(embeddings, batch.map(d => d.pageContent));
        // Vectors are paired to documents POSITIONALLY downstream, so a provider that returns
        // a different count (dropped/deduped/partial) would mis-attribute every vector after
        // the gap in the persisted index. Fall back to the 1:1 path, which pairs each chunk
        // with its own vector.
        if (!Array.isArray(vecs) || vecs.length !== batch.length) {
          if (DEBUG) console.warn(`  ⚠️  Batch ${batchNum} returned ${Array.isArray(vecs) ? vecs.length : 'non-array'} vectors for ${batch.length} chunks — re-embedding one by one to keep vector↔document alignment`);
          return embedOneByOne(batch, batchNum);
        }
        return { batch, vecs };
      } catch (e) {
        // A TIMEOUT means the provider is stalled/black-holed, not that a specific chunk is bad. Grinding
        // this file's chunks one-by-one (each with its own timeout) would waste minutes to embed nothing,
        // so surface a provider-down error: the caller records the file as retry-pending and, after a few
        // such files, stops the run early. A NON-timeout batch error may be a single bad chunk, so keep the
        // one-by-one recovery that salvages the rest of the batch.
        // A timeout, an explicit provider-down marker, or the bundled local model still downloading all mean the
        // provider — not a specific chunk — isn't ready. Surface provider-down so the caller records these files
        // as retry-pending (deferred, NEVER lost) and retries them once the provider is up / the model has
        // finished downloading, instead of grinding chunk-by-chunk and permanently skipping them.
        if (e && (e._lokTimeout || e.providerDown || e.downloading)) throw Object.assign(new Error('embeddings provider unavailable'), { providerDown: true });
        if (DEBUG) console.warn(`  ⚠️  Batch ${batchNum} failed (${e.error || e.message}) — retrying chunk by chunk`);
        return embedOneByOne(batch, batchNum);
      }
    }));
    results.push(...settled);
  }

  if (skipped > 0) {
    console.warn(`⚠️  ${skipped} chunk(s) could not be embedded and were skipped. The rest of the index is complete.`);
  }
  return results.filter(r => r.batch.length > 0);
};

const runDeltaUpdate = async (opts = {}) => {
  if (state.indexPromise) return state.indexPromise;

  state.indexPromise = (async () => {
    state.indexing = true;
    try {
      await fs.mkdir(cfgPaths.CACHE_DIR, { recursive: true });

      // Heal a prior delta whose persist began but never finished (commit marker present: begin written,
      // end not reached — e.g. a disk-full or I/O error after the in-memory swap at line ~690). The marker
      // was previously consulted ONLY at warm start, so a long-running process never self-healed: the live
      // in-memory store would hold the new vectors while the on-disk manifest still mapped the changed file
      // to its OLD ids, and the NEXT delta would purge ids that aren't in the store (a no-op) and re-embed —
      // leaving the file's vectors in the store twice plus permanently-orphaned ids. Detect it here and wipe
      // + rebuild from the documents (wipeIndexCache also nulls the in-memory store, so the rebuild starts
      // clean), exactly as the corrupt-manifest path below does. isPending reads false on any marker trouble,
      // so a flaky read can never force an endless rebuild loop.
      if (commit.isPending(cfgPaths.CACHE_DIR)) {
        // If the interrupted write was a consolidation batch (a migration is in progress), repair ONLY the active
        // bank and resume the move, instead of wiping every bank and re-embedding the whole corpus. Fail-safe: the
        // repair returns false on anything but that exact case, so a non-migration torn write still falls through
        // to the full rebuild. Lazy require avoids the init↔delta cycle.
        let repaired = false;
        try { repaired = await require('./init').repairInterruptedConsolidation(await loadManifest()); }
        catch (e) { if (DEBUG) console.log('  scoped consolidation repair skipped:', e.message); repaired = false; }
        if (!repaired) {
          console.warn('⚠️  A previous index update did not finish writing — rebuilding the index from your documents to stay consistent.');
          try { await require('./init').wipeIndexCache(); } catch (e) { if (DEBUG) console.log('  pending-commit wipe skipped:', e.message); }
        }
      }

      const embeddings = makeEmbeddings();

      // Embedding banks: new/changed documents are embedded into the ACTIVE bank; the
      // shadow store below clones that bank (state.liveVectorStore already points at it),
      // and documents that live in a frozen bank are left untouched. When banks are off,
      // `banks` is null and everything behaves exactly as the single-index path.
      const cfg = require('../config');
      const banks = cfg.useEmbeddingBanks ? require('./banks') : null;
      let activeFp = null, activeMeta = null;
      if (banks) {
        // Migrate a pre-banks single index into a bank BEFORE creating the active bank, so
        // enabling banks at RUNTIME doesn't orphan the existing corpus. Warm start does this,
        // but a live toggle reaches the delta path first. No-op once banks/ exists, so only read
        // the manifest (for the legacy model's fingerprint) on that one first migration.
        if (fsSync.existsSync(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.faissIndex)) && !fsSync.existsSync(banks.banksRoot(cfgPaths.CACHE_DIR))) {
          try { banks.migrateLegacy(cfgPaths.CACHE_DIR, (await loadManifest())._embeddingModel); }
          catch (e) { if (DEBUG) console.log('  bank migrate skipped:', e.message); }
        }
        // Reuse an equivalent existing bank when the live config is measured-compatible with the active bank
        // (the same model served by a different provider/endpoint), instead of forking a new bank — no re-embed.
        // Falls back to a normal switch on any measurement trouble. makeEmbeddings is injected (no require cycle).
        activeMeta = await banks.resolveActiveForWrite(cfgPaths.CACHE_DIR, { makeEmbeddings });
        const { changed: _bankChanged } = banks.ensureActive(cfgPaths.CACHE_DIR, activeMeta);   // idempotent; flips active bank on a model change
        activeFp = activeMeta.fp;
        // On a real switch (a new/different active bank), run post-switch maintenance fire-and-forget: fit query
        // adapters from the new active model into each frozen bank (while the old providers are typically still
        // reachable), then auto-consolidate in the background on a no-cost local embedder if a gap remains. It
        // reads only frozen banks (never the active bank this delta is about to write), so it can't race this run.
        if (_bankChanged) { try { require('./init').afterEmbeddingSwitch().catch(() => {}); } catch { /* best-effort */ } }
        // state.vectorBanks is normally populated by the warm-start banks path. But when banks
        // are enabled at RUNTIME (Settings toggle off→on), boot took the single-index warm path,
        // so state.vectorBanks is empty even though a bank now exists on disk (just migrated, or
        // frozen from a prior banks session). Cloning below reads the ACTIVE bank's store from
        // state.vectorBanks; if it's absent, cloneSource is null and saveActiveStore would
        // overwrite the whole active bank with only this delta's vectors — silently dropping the
        // existing corpus's dense vectors. Load the banks from disk first so the clone sees the
        // real active store. Disk is authoritative (every save is atomic), so a full reload here
        // is safe; this runs only when the active store isn't already in memory.
        if (!(state.vectorBanks || []).some(b => b.fp === activeFp && b.store)
            && fsSync.existsSync(banks.banksRoot(cfgPaths.CACHE_DIR))) {
          try { state.vectorBanks = await banks.loadBanks(cfgPaths.CACHE_DIR, { FaissStore, makeEmbeddings }); }
          catch (e) { if (DEBUG) console.log('  bank load skipped:', e.message); }
        }
        // Self-heal a CORRUPT active bank, mirroring the single-index path (init.js wipes+rebuilds a
        // bad faiss.index). If the active bank's index file is present but failed to load, cloneSource
        // below would resolve to null and the save would overwrite the bank with only this delta's
        // vectors — silently dropping the documents that lived in the unreadable bank (they stay in
        // the manifest, so a plain delta would never re-embed them). Instead wipe and rebuild the whole
        // index from documents: rare (needs a corrupt active bank), and safe — every document on disk
        // is re-embedded into a fresh active bank, leaving no inconsistency. A missing (never-saved)
        // active bank is NOT corrupt and is handled normally.
        const activeBankState = (state.vectorBanks || []).find(b => b.fp === activeFp);
        if (activeBankState && activeBankState.failed) {
          console.warn('⚠️  The active embedding bank could not be read (corrupt) — rebuilding the index from your documents.');
          try { await require('./init').wipeIndexCache(); } catch (e) { if (DEBUG) console.log('  corrupt-bank wipe skipped:', e.message); }
          state.vectorBanks = [];
          banks.ensureActive(cfgPaths.CACHE_DIR, activeMeta);   // recreate the registry the wipe cleared
        }
      } else {
        // Banks OFF: a runtime change that invalidates the existing single index must force a clean
        // rebuild here, not a plain delta. A delta only re-embeds files whose BYTES changed, so it
        // would otherwise keep serving vectors built with the OLD embedding model (meaningless
        // cosine scores after a model change), or — if banks were just turned off, leaving banks/
        // on disk — clone a single bank into the root index and drop the frozen banks' vectors.
        // This mirrors the warm-start rebuild in init.js for the runtime (no-restart) path; banks
        // ON handles a model change live (a new active bank), so it is gated to the banks-off path.
        // One-time: the rebuild re-stamps the manifest and clears banks/, so later deltas skip this.
        const { sameModel } = require('../modelname');
        const m = await loadManifest();
        const identityMeta = require('./banks').currentMeta(cfg);
        const identityChanged = m._embeddingIdentity
          ? m._embeddingIdentity !== identityMeta.fp
          : (m._embeddingModel && !sameModel(m._embeddingModel, cfg.EMBEDDINGS_MODEL));
        let orphanBanks = false;
        try { orphanBanks = require('./init').orphanedBanksPresent(cfgPaths.CACHE_DIR); } catch {}
        if (identityChanged || orphanBanks) {
          console.log(`🗑️  ${identityChanged
            ? `Embedding identity changed (now ${identityMeta.provider} · ${identityMeta.model})`
            : 'Embedding banks disabled'} — rebuilding the index from documents`);
          try { await require('./init').wipeIndexCache(); } catch (e) { if (DEBUG) console.log('  rebuild wipe skipped:', e.message); }
        }
      }

      const { resetSkipReport, getSkipReport } = require('./files');
      resetSkipReport();
      // Do NOT pre-warm a main-process OCR pool here. Scanned PDFs and large images are OCR'd inside the
      // isolated parse child, which builds its own memory-budgeted pool; a pool on the server would sit
      // idle holding worker WASM memory concurrently with the child's budget — double-counting the very
      // memory the child sizing bounds. The only OCR that runs in this process is a small inline image
      // (under the isolation threshold), and its pool is built lazily on first use.
      const { files: diskFiles, incompleteRoots } = await collectAllFiles(cfgPaths.DOCS_DIR);
      const diskHashes = {};
      // Hash in bounded batches rather than one giant Promise.all: opening every file at
      // once exhausts file descriptors and (before streaming hashes) spiked memory on a
      // large corpus. A small window keeps it fast without the resource blow-up.
      const HASH_CONCURRENCY = 8;
      const hashFailed = new Set();   // files that could not be hashed this pass — held, never dropped or aborted on
      for (let i = 0; i < diskFiles.length; i += HASH_CONCURRENCY) {
        const batch = diskFiles.slice(i, i + HASH_CONCURRENCY);
        // Per-file isolation (mirroring the embed loop): a single file that can't be hashed — deleted between
        // the scan and the hash, a permission blip (EACCES), a transient lock — must NOT reject this batch and
        // abort the WHOLE delta (which would index and purge NOTHING, and a persistently unreadable file would
        // freeze all indexing). Skip it: no hash means it isn't re-added this pass, and it is held below so it
        // isn't purged either (a genuinely-deleted file is purged on a later pass once the scan drops it).
        await Promise.all(batch.map(async (f) => {
          // A resumable migration passes a short-lived cache: the first batch reads every file, later batches
          // only stat it, so a multi-pass re-embed does not re-read the whole corpus for each batch.
          try { diskHashes[f] = await hashForPass(f, opts.hashCache); }
          catch (e) { hashFailed.add(f); if (DEBUG) console.warn(`  ⚠️  Could not hash ${path.basename(f)} (${e && e.message}) — holding it this pass`); }
        }));
      }

      let manifest    = await loadManifest();
      // A present-but-unreadable manifest ({ _corrupt }) must force a clean rebuild here too, not just at warm
      // start (contentRebuildReason). Proceeding with a corrupt manifest reads every file as new and re-embeds
      // it over the still-live store — duplicate vectors — while purging nothing. Wipe and rebuild from the
      // documents instead (same mechanism as the model-change path above).
      if (manifest && manifest._corrupt) {
        console.warn('⚠️  The file manifest is unreadable (corrupt) — rebuilding the index from your documents.');
        try { await require('./init').wipeIndexCache(); } catch (e) { if (DEBUG) console.log('  corrupt-manifest wipe skipped:', e.message); }
        manifest = {};   // post-wipe: treat as empty so every document is re-embedded cleanly, nothing is purged
      }
      const toAdd     = diskFiles.filter(f => shouldIndexFile(f, manifest, diskHashes, _parseFailedThisSession));
      // Incremental, resumable bank migration (the Consolidate action). Re-embed a BOUNDED slice of the
      // documents whose vectors live in a frozen (older-model) bank into the active bank. They join toAdd and
      // the purge list exactly like a changed file, so the normal stage→swap path does the work and commits
      // durably at the END of this run — which is what makes the migration resumable: an interrupted run
      // leaves the remaining documents tagged to their old bank, still searchable, for the next run to finish.
      // Only documents with real vectors are moved (a skipped entry has nothing to reclaim), and each batch is
      // capped so one run's clone/save cost stays bounded relative to the corpus.
      if (banks && opts.reembedFp && activeFp === opts.reembedFp && opts.reembedLimit > 0) {
        const toAddSet = new Set(toAdd);
        // Untagged (pre-banks) entries live in the bank migrateLegacy created; classify them with the same
        // helper the purge below uses, so "frozen" means the same thing in both places.
        const legacyFp = banks.migratedBankOf(banks.loadRegistry(cfgPaths.CACHE_DIR), activeMeta, manifest._embeddingModel);
        let selected = 0;
        for (const f of diskFiles) {
          if (selected >= opts.reembedLimit) break;
          if (toAddSet.has(f) || !diskHashes[f]) continue;
          if (!banks.entryIsFrozen(manifest[f], activeFp, legacyFp)) continue;
          toAdd.push(f);
          toAddSet.add(f);
          selected++;
        }
        if (selected > 0) console.log(`🏦 Re-embedding ${selected} document(s) into the active embedding bank (resumable)`);
      }
      // A file missing from disk normally means it was deleted — but if its whole
      // source folder is unreachable (an external drive unmounted, a network share
      // offline) the documents aren't gone, they're temporarily unavailable.
      // Purging them would drop the index and force a full re-embed on remount, so
      // instead we keep them and report it.
      const { SOURCE_PATHS } = require('../config');
      const { isWithin, offlineRoots, indexedRoots } = require('../paths');
      const roots = indexedRoots(cfgPaths.DOCS_DIR, SOURCE_PATHS);
      // Bounded async probe (never sync statSync, which a hung network mount could use to freeze
      // the event loop mid-delta while queries wait). Probe DOCS_DIR too, not just the external
      // source roots, so a truly unreachable (stat-throwing) docs folder is still held.
      const offline = await offlineRoots(roots);
      // Per-root vanished-corpus guard. offlineRoots can only flag a root as unreachable when a stat
      // throws, times out, or the path is not a directory — it CANNOT detect a docs volume that
      // presents as a cleanly-empty but statable directory (an automount placeholder, a bind mount
      // whose source vanished, some SMB drop states). So ALSO treat as unavailable any EXTERNAL source
      // root that still HOLDS indexed documents yet yielded ZERO indexable files in this scan: its
      // documents are almost certainly temporarily gone, not deleted. Reasoned PER ROOT so one
      // vanished source among several drops nothing, and a stray non-document entry (a .DS_Store) on
      // another root can't mask it. `diskFiles` is already filtered to indexable files, so OS junk
      // never counts as presence.
      //
      // DOCS_DIR is deliberately EXCLUDED from this empty-mount guard: it is the app's own per-user
      // data folder, co-located with the index (CACHE_DIR) on the same volume, so it cannot present
      // empty while its own manifest is still readable — the ambiguity simply can't arise. Guarding it
      // would only wrongly hold a genuine local deletion (the user emptying the curated folder), which
      // should purge. A truly unreachable DOCS_DIR is still caught by offlineRoots above. A genuine
      // "delete everything from a source" is cleared by an explicit Rebuild.
      const rootHoldsTracked = (root) => Object.keys(manifest).some(f => !f.startsWith('_') && isWithin(f, root));
      const rootHasDiskFile  = (root) => diskFiles.some(f => isWithin(f, root));
      const vanishedRoots = roots.filter(r => r !== cfgPaths.DOCS_DIR && !offline.includes(r) && rootHoldsTracked(r) && !rootHasDiskFile(r));
      // Hold a document back from purging when its folder is offline, empty-mounted/vanished, OR its
      // scan was incomplete this pass (a permission blip on a subtree, or the file cap truncating the
      // scan). In every case "missing from the scan" does NOT mean "deleted", so purging would wrongly
      // drop still-present documents and force a re-embed when they reappear.
      const heldRoots = [...offline, ...vanishedRoots, ...(incompleteRoots || [])];
      // A file whose hash could not be read this pass is held too: "couldn't hash" is not "deleted", so purging
      // it would wrongly drop a still-present (just temporarily unreadable) document and force a re-embed.
      const isHeld = (f) => hashFailed.has(f) || heldRoots.some(root => isWithin(f, root));

      const missing   = Object.keys(manifest).filter(f => !diskHashes[f] && !f.startsWith('_'));
      const toDelete  = missing.filter(f => !isHeld(f));
      const heldBack  = missing.length - toDelete.length;
      if (heldBack > 0) {
        console.warn(`⚠️  ${heldBack} document(s) are on an unavailable, empty-mounted, or incompletely-scanned folder — keeping them indexed rather than purging. They'll refresh once the folder is fully readable. Use Rebuild to clear them if you deliberately removed them.`);
      }

      if (toAdd.length === 0 && toDelete.length === 0 && state.liveVectorStore) {
        if (DEBUG) console.log('✅ No file changes — index is current');
        if (state.parentMap.size === 0) {
          // Skip a file that can't be read rather than aborting the repopulate. fs.stat/readFile can throw
          // for a file removed or made unreadable since enumeration; one bad file must not leave parentMap
          // empty and the corpus unsearchable. Matches the per-file guards on the add and bundle paths.
          for (const f of diskFiles) {
            try { await loadSingleDocument(f, state.parentMap); }
            catch (e) { if (DEBUG) console.log(`  ⚠️  Skipped unreadable file: ${path.basename(f)} (${e.message})`); }
          }
          if (DEBUG) console.log(`✅ parentMap populated with ${state.parentMap.size} documents`);
        }
        // corpusIdf and chunkIndex already built during warm start — skip rebuild
        return;
      }

      if (DEBUG) console.log(`🔄 Delta: +${toAdd.length} changed/added, -${toDelete.length} removed`);

      let shadowStore = null;
      const shadowParentMap = new Map(state.parentMap);
      const shadowChildMap  = new Map(state.childMap);
      // Shadow the passage map too and swap it atomically with the others. Writing new
      // passage offsets into the LIVE map during the delta would let a concurrent query hit
      // an OLD vector (still in the live store) and read a NEW offset against the old text —
      // a wrong/empty passage window while re-indexing an existing document.
      const shadowPassageMap = new Map(state.passageMap);
      const newManifest     = { ...manifest };

      // The shadow starts as a clone of the store new vectors will be added to — the
      // ACTIVE bank. With banks on, state.liveVectorStore can't be used as that source:
      // right after an embedding-model change bundle.js points it at a FROZEN bank so
      // retrieval still works, and cloning that would embed new-model vectors into an
      // old-model index (dimension mismatch, or silent cross-bank duplication). Pick the
      // active bank's store explicitly; when it has none yet (the normal post-switch
      // state) start from null so only new-model vectors land in the fresh active bank.
      const cloneSource = banks
        ? ((state.vectorBanks || []).find(b => b.fp === activeFp && b.store)?.store || null)
        : state.liveVectorStore;
      if (cloneSource) {
        const tmpDir = path.join(cfgPaths.CACHE_DIR, '_shadow');
        await cloneSource.save(tmpDir);
        shadowStore = await FaissStore.load(tmpDir, embeddings);
        if (DEBUG) console.log('🔀 Shadow store cloned from live index');
        // MEMORY CEILING (documented, accepted): this clones the WHOLE active-bank FAISS index to disk and back
        // into a second in-memory copy on every delta, so a single-file change on a multi-GB index transiently
        // holds two full copies of the index in RAM (live + shadow) and does a full serialize+deserialize. This
        // is the price of the atomic, crash-safe stage→swap (a query never sees a half-applied index). It scales
        // with the CORPUS, not the delta; the ceiling is the two-copies peak. With banks on, only the ACTIVE
        // bank is cloned (frozen banks are untouched), which bounds it to the active bank's size. A future
        // optimization could mutate under a short query-respected guard or clone in memory where the binding
        // allows; left as-is because correctness (never a torn index) outranks the peak here.
      }

      // Remove stale vectors
      const filesToPurge = [...toDelete, ...toAdd.filter(f => manifest[f])];
      // Index childIds by their parent ONCE so purging each file costs only its own chunks, not a full
      // rescan of every chunk per file. Without this, a mass change — a sync tool, a repo-wide reformat, or
      // a git checkout rewriting thousands of already-indexed files — makes the purge O(files × total-chunks),
      // billions of synchronous Map iterations that stall every query on the event loop. Built only when
      // there is something to purge.
      const childIdsByParent = new Map();
      if (filesToPurge.length) {
        let scanned = 0;
        for (const [childId, pid] of shadowChildMap) {
          let arr = childIdsByParent.get(pid);
          if (!arr) { arr = []; childIdsByParent.set(pid, arr); }
          arr.push(childId);
          // Yield periodically: this scans every chunk in the whole corpus and runs on any delta that
          // re-indexes or deletes a file (routine), so on a very large corpus it would otherwise stall every
          // live query for the duration. (Mirrors the cooperative BM25 build.)
          if ((++scanned % 50000) === 0) await new Promise((r) => setImmediate(r));
        }
      }
      // Cropped-figure thumbnails to delete. Collected during the purge but removed only AFTER the atomic
      // swap commits (below), so a delta that throws mid-run — leaving live state at the pre-delta version —
      // never deletes figures still referenced by a CHANGED document's live parent entry (which would show
      // broken thumbnails until the next successful index). On a delete the parent is gone either way.
      const figuresToRemove = [];
      // A migrated/legacy manifest entry has no `bank` tag: migrateLegacy moved the old root index into a bank
      // fingerprinted with the manifest's embedding model. That bank is the ACTIVE bank exactly when the model
      // is unchanged. Prefer the fingerprint recorded by the migration itself; a later save re-stamps the
      // manifest's model, so re-deriving from it would misattribute untagged entries to the new active bank.
      // Fall back to the derivation for registries created before the marker existed. Precompute once so the
      // delete below treats a migrated doc as in-active and removes its old vectors — otherwise a re-index
      // leaves a duplicate, and a delete an orphan, in the active bank, clearable only by Consolidate/Rebuild.
      const migratedBankFp = banks
        ? banks.migratedBankOf(banks.loadRegistry(cfgPaths.CACHE_DIR), activeMeta, manifest._embeddingModel)
        : null;
      for (const filePath of filesToPurge) {
        const entry = manifest[filePath];
        if (!entry) continue;
        const docId = docIdFor(filePath);
        const purgedFigs = shadowParentMap.get(docId)?.metadata?.figures;
        // Only discard crops when the CONTENT changed. A resumable bank re-embed re-processes an unchanged
        // document: its visual-ingest cache hit returns the SAME crop ids and leaves the crop files in place,
        // so deleting them afterward would break every figure thumbnail until a rebuild. (A changed file
        // generates new ids, so removing the old crops is correct.)
        const contentUnchanged = !!manifest[filePath] && !!diskHashes[filePath] && manifest[filePath].fileHash === diskHashes[filePath];
        if (purgedFigs && purgedFigs.length && !contentUnchanged) figuresToRemove.push(...purgedFigs);
        shadowParentMap.delete(docId);
        const kids = childIdsByParent.get(docId);
        if (kids) for (const childId of kids) { shadowChildMap.delete(childId); shadowPassageMap.delete(childId); }
        // Only remove vectors from the shadow (the active bank); a document embedded in a
        // frozen bank keeps its vectors there (removing them would target the wrong index).
        // For a DELETED file that's harmless — its parent is gone, so the orphaned vector
        // never resolves. For a CHANGED file the docId (sha256 of the path) is stable, so its
        // stale frozen-bank vector still resolves to the (now new-content) parent and can
        // surface in dense results until the banks are consolidated; the freshly re-embedded
        // active-bank vector is the one that should match. Run Settings → Consolidate embedding
        // banks periodically to clear these. (A deleted file's active-bank orphans are reclaimed
        // automatically at the next start by the orphaned-vector sweep in init.js.)
        const inActiveBank = !banks || entry.bank === activeFp || (entry.bank == null && migratedBankFp === activeFp);
        // Remove via the store's delete({ids}) using the STABLE document ids returned by
        // addVectors — NOT the low-level index.removeIds. removeIds compacts FAISS positions
        // without updating the store's position→id mapping, which desyncs it so later dense
        // hits resolve to the WRONG document. store.delete removes by id and re-sequences the
        // mapping, keeping it consistent. (Legacy manifests stored positional integers; those
        // can't be deleted safely, so they're left as harmless orphans — skipped at assembly
        // because their parentMap entry is gone — and cleaned by a rebuild/consolidate.)
        const idsAreStable = entry.vectorIds?.length && entry.vectorIds.every(id => typeof id === 'string');
        if (shadowStore && inActiveBank && idsAreStable) {
          try {
            await shadowStore.delete({ ids: entry.vectorIds });
            if (DEBUG) console.log(`  🗑️  Removed ${entry.vectorIds.length} vectors for ${path.basename(filePath)}`);
          } catch (e) {
            if (DEBUG) console.warn(`  ⚠️  Could not remove vectors for ${filePath}:`, e.message);
          }
        } else if (shadowStore && inActiveBank && entry.vectorIds?.length && DEBUG) {
          console.log(`  ⏭️  ${path.basename(filePath)} has legacy positional vector ids — leaving old vectors (a rebuild will clean them) rather than risk a mapping desync`);
        }
        delete newManifest[filePath];
      }

      // Embed new/changed files
      // Embedding is the slowest phase and logged nothing per document, so a large
      // batch looked like a hang. Reported on an interval rather than per file.
      const started = Date.now();
      let lastReport = 0;
      let processed = 0;
      // Count files in a row that failed because the embeddings provider timed out. After a few, treat the
      // provider as down and stop trying: record the remaining files as retry-pending immediately rather
      // than grinding each one (every batch times out, then every chunk times out again) for minutes. They
      // re-embed automatically on the next delta once the provider recovers — the same self-healing path a
      // single transient failure already uses.
      const PROVIDER_DOWN_STREAK = 3;
      let providerDownStreak = 0;
      // Warn only once per run if the embedding dimension stops matching the active bank's (see the guard
      // before addVectors) — a persistent misconfiguration, not a per-file event.
      let dimMismatchWarned = false;
      for (const filePath of toAdd) {
        processed++;
        // Publish progress to state so the browser status heartbeat can show it.
        // This is the slow phase (read + embed per document), so it's the one that
        // most needs to be visible — a silent multi-second index is what made an
        // unindexed upload look like a failure rather than work-in-progress.
        state.indexProgress = { done: processed, total: toAdd.length, name: path.basename(filePath), label: 'Indexing' };
        const now = Date.now();
        if (now - lastReport > 10000 && processed < toAdd.length) {
          lastReport = now;
          // Progress level: the browser status heartbeat already shows this live (state.indexProgress
          // above), so the terminal only needs it in DEBUG. The daily log file always records it.
          require('../logbuffer').progress(`   Indexing: ${processed}/${toAdd.length} — ${path.basename(filePath)}`);
        }
        // Isolate per-file failures. A single unreadable/corrupt file, a file that
        // vanished between the disk scan and this read (a real race on a churning watched
        // folder), or a parser/OCR error must not abort the whole delta and discard every
        // document already staged in the shadow maps. On failure, record the file as
        // skipped (so it isn't retried every run — a later edit changes its hash and
        // re-triggers it) and continue with the rest.
        try {
        const doc = await loadSingleDocument(filePath, shadowParentMap);
        if (!doc) {
          if (DEBUG) console.log(`  ⏭️  Skipped (empty/too small): ${path.basename(filePath)}`);
          // Record it with no vectors. Without this the file is absent from the
          // manifest, so every subsequent run sees it as new — re-reporting the same
          // skip warning forever and doing pointless work on each pass. The hash is
          // stored so a later edit that makes the file indexable is still detected.
          newManifest[filePath] = { fileHash: diskHashes[filePath], vectorIds: [], skipped: true };
          continue;
        }
        if (doc.parsePending) {
          // The document was indexed by NAME only because parsing/OCR could not finish this run (usually
          // memory pressure), not because it genuinely has no text. Record it retry-pending — WITHOUT a
          // fileHash — so the next delta re-attempts full extraction, which may now succeed on a machine
          // with more memory or with raised limits. This mirrors the transient embed-failure handling
          // below, and is the "never give up on a document because of memory" guarantee. The name-only
          // entry is already in the parent map, so the document is findable by its file name meanwhile;
          // its real content is not embedded as a dense vector — the successful re-parse should own that.
          if (DEBUG) console.log(`  ↻ Indexed by name, pending re-parse: ${path.basename(filePath)}`);
          newManifest[filePath] = { vectorIds: [], skipped: true, embedPending: true, ...(banks ? { bank: activeFp } : {}) };
          // Remember this parse failure so an unrelated file-change delta this session does not re-run the
          // full escalation on it again; a byte change or a restart still retries it.
          if (diskHashes[filePath]) _parseFailedThisSession.set(filePath, diskHashes[filePath]);
          continue;
        }
        // The parse succeeded (we did not take the parsePending branch), so clear any earlier failure note
        // for this file — a later change must not stay deferred once it parses cleanly.
        _parseFailedThisSession.delete(filePath);
        // The embeddings provider looks down (several consecutive embed timeouts). The document is already
        // loaded into the shadow parent map above, so it stays searchable by keyword and name; defer ONLY
        // the dense embedding to the next delta rather than dropping the document from search entirely (its
        // old content was purged for re-embedding, so skipping the load would make a changed file vanish).
        // The load is a local parse, never the down provider, so this cannot re-trigger the timeout grind.
        // It re-embeds automatically once the provider recovers — the same self-healing path a single
        // transient failure uses.
        if (providerDownStreak >= PROVIDER_DOWN_STREAK) {
          newManifest[filePath] = { vectorIds: [], skipped: true, embedPending: true, ...(banks ? { bank: activeFp } : {}) };
          continue;
        }

        const chunks = await semanticSplitDocument(doc, shadowChildMap, shadowPassageMap);
        if (chunks.length === 0) {
          newManifest[filePath] = { fileHash: diskHashes[filePath], vectorIds: [], skipped: true };
          continue;
        }
        // Contextual Retrieval (opt-in): prepend a per-chunk "where this sits in the
        // doc" blurb to the text that gets embedded, so the vector carries global
        // context. Only the embedded text changes — passage offsets and served text
        // stay raw. Cached by chunk content, so a re-index is cheap.
        if (require('../config').useContextualRetrieval) {
          try { await require('./context').contextualizeChunks(doc, chunks); }
          catch (e) { if (DEBUG) console.warn(`  ⚠️  Contextualize failed for ${path.basename(filePath)}: ${e.message}`); }
        }
        if (DEBUG) console.log(`  📄 Indexing ${path.basename(filePath)} → ${chunks.length} chunks`);

        const batchResults = await embedChunks(chunks, embeddings);
        const allVecs = batchResults.flatMap(r => r.vecs);
        const allDocs = batchResults.flatMap(r => r.batch);

        // Every chunk failed to embed (e.g. the endpoint was briefly down, the model was
        // reloading, or the configured model doesn't support embeddings). This is usually a
        // TRANSIENT provider problem, so record the file as retry-pending — WITHOUT a fileHash —
        // rather than stamping the current hash. A stamped hash would match disk on the next run
        // and the toAdd filter would never revisit the file, leaving it permanently keyword-only
        // (BM25) with no dense vectors until its bytes changed or the user ran a full Rebuild. With
        // no fileHash the entry re-enters toAdd on the next delta, so it re-embeds automatically
        // once the provider recovers. (Creating a FaissStore from an empty vector set leaves it
        // uninitialized and the ntotal read below would throw, so we must still skip the add here.)
        if (allVecs.length === 0) {
          if (DEBUG) console.warn(`  ⚠️  No embeddable chunks for ${path.basename(filePath)} — will retry on the next index (provider may be down)`);
          newManifest[filePath] = { vectorIds: [], skipped: true, embedPending: true, ...(banks ? { bank: activeFp } : {}) };
          continue;
        }

        // Dimension guard: if the active bank already holds vectors of a different length than the model
        // now emits, adding these would make FAISS throw (aborting the whole file with a cryptic error) or,
        // worse, if it didn't, a cross-dimension vector scores as noise. Since different models already get
        // different banks, this only happens when the SAME model identity changed its output dimension (a
        // re-quantized/swapped local model under an unchanged name). Skip the dense add and keep the file
        // searchable by keyword (BM25) and name instead of failing it, stamp the hash so it does not grind
        // a doomed re-embed every delta, and tell the operator how to recover. (Checked against the CURRENT
        // shadowStore — before a fresh empty store is created below, which legitimately sets the dimension.)
        const existingDim = storeDimension(shadowStore);
        const newDim = allVecs[0] && allVecs[0].length;
        if (existingDim && newDim && existingDim !== newDim) {
          if (!dimMismatchWarned) {
            dimMismatchWarned = true;
            console.warn(`⚠️  Embedding dimension changed for the current model (bank holds ${existingDim}-dim vectors, the model now returns ${newDim}). These documents are a different vector space and are NOT being mixed in — they stay searchable by keyword only. Point the model at a distinct name/endpoint, or run Settings → Rebuild index to re-embed everything at the new dimension.`);
          }
          newManifest[filePath] = { fileHash: diskHashes[filePath], vectorIds: [], skipped: true, dimMismatch: true, ...(banks ? { bank: activeFp } : {}) };
          continue;
        }

        if (!shadowStore) { shadowStore = new FaissStore(embeddings, {}); }
        // Keep the STABLE document ids addVectors returns and record THEM as this file's
        // vectorIds — they are what store.delete() removes by. (The old code stored FAISS
        // positions, which shift on every delete; see the removal note above.)
        const addedIds = await shadowStore.addVectors(allVecs, allDocs);
        newManifest[filePath] = {
          fileHash: diskHashes[filePath],
          vectorIds: Array.isArray(addedIds) ? addedIds : [],
          ...(banks ? { bank: activeFp } : {}),   // which bank holds these vectors
        };
        providerDownStreak = 0;   // a successful embed means the provider is up — reset the down-streak
        } catch (e) {
          // A provider TIMEOUT (black-holed/stalled endpoint) counts toward the down-streak so the run can
          // stop grinding; any other error is a per-file problem and resets it.
          if (e && e.providerDown) providerDownStreak++; else providerDownStreak = 0;
          // A processing error mid-file (most often the embed/provider call throwing, but also a
          // parse/chunk error). Treat it as retry-pending — no fileHash — so a transient failure
          // (provider down, model reloading) re-embeds on the next delta instead of being frozen
          // as keyword-only forever. An EDITED file's old vectors were already purged above, so
          // without this it would also lose its prior good vectors with no path back short of a
          // Rebuild. A genuinely unprocessable file simply retries each delta (bounded, one file)
          // and logs — acceptable next to silently abandoning a file that a retry would recover.
          console.warn(`  ⚠️  Could not index ${path.basename(filePath)} — will retry next time — ${e && e.message ? e.message : e}`);
          newManifest[filePath] = { vectorIds: [], skipped: true, embedPending: true, ...(banks ? { bank: activeFp } : {}) };
        }
      }

      if (!shadowStore) {
        // No indexable documents. This is the normal state of a brand-new workspace,
        // not a failure — but leaving liveVectorStore null made the app report
        // "still building the index" forever and reject every query. Mark the index
        // ready with an empty corpus so queries get an honest "no documents" answer.
        // Build BM25 + chunk index into a shadow first, then swap every field in one synchronous run —
        // same atomicity discipline as the main path (a query never sees new maps with an old BM25/chunk
        // index while the build yields). Pin to the baseline (see note on the atomic-swap path below); an
        // empty corpus has no meaningful median, so don't let it replace a real one.
        // Swapping the passage map matters even here: without it the purge loop's deletions to the shadow
        // passage map are discarded and persistIndexMaps writes a stale passage-map.json — the deleted
        // document's passage entries would linger and re-clone into every later delta (a slow leak).
        const shadowIdx = { parentMap: shadowParentMap, childMap: shadowChildMap, passageMap: shadowPassageMap, chunkIndex: new Map() };
        // Reuse the live BM25/IDF when the shadow's text is unchanged (the normal consolidation batch: the
        // same documents move to a new embedding bank, with identical text). This keeps each batch proportional
        // to the documents it re-embeds instead of rebuilding the whole corpus index.
        const shadowBM25 = await buildOrReuseBM25Index(shadowParentMap, manifest._bm25Median ?? null, shadowIdx,
          { bm25: state.liveBM25, idf: state.corpusIdf, map: state.parentMap });
        buildChunkIndexInto(shadowIdx);
        state.parentMap    = shadowParentMap;
        state.childMap     = shadowChildMap;
        state.passageMap   = shadowPassageMap;
        state.liveBM25     = shadowBM25;
        state.corpusIdf    = shadowIdx.corpusIdf;
        state.chunkIndex   = shadowIdx.chunkIndex;
        state.vectorCount  = 0;
        state.lastIndexedAt = Date.now();
        state.lastDelta    = { added: 0, removed: toDelete.length, at: state.lastIndexedAt };
        // With banks, an empty ACTIVE bank doesn't mean an empty corpus — frozen banks
        // may hold everything. Persist the (possibly deletion-updated) manifest and text
        // maps so removals stick, and don't claim the workspace is empty.
        if (banks && state.parentMap.size > 0) {
          // The active bank is empty (e.g. just after a model change with no new docs),
          // but frozen banks hold the corpus. Point liveVectorStore at a loaded bank so
          // the readiness guards don't treat the searchable corpus as empty.
          if (!state.liveVectorStore) {
            const anyStore = (state.vectorBanks || []).map(b => b.store).find(Boolean);
            if (anyStore) state.liveVectorStore = anyStore;
          }
          stampManifestVersions(newManifest);
          newManifest._bm25Median     = manifest._bm25Median ?? state.liveBM25.medianScore;
          await saveManifest(newManifest);
          await persistIndexMaps(cfgPaths.CACHE_DIR, state);
          if (DEBUG) console.log('🏦 No new documents to embed — existing corpus served from frozen bank(s)');
        } else if (state.parentMap.size === 0) {
          console.log('📭 No documents in this workspace yet — add some to get started.');
          // Persist the manifest even when the corpus is now empty, so a deletion that emptied
          // it is recorded — otherwise the removed file keeps reappearing as "missing" on every
          // subsequent run because the manifest still lists it.
          if (toDelete.length > 0) {
            stampManifestVersions(newManifest);
            try { await saveManifest(newManifest); await persistIndexMaps(cfgPaths.CACHE_DIR, state); }
            catch { /* best-effort */ }
          }
        } else if (toDelete.length > 0) {
          // Banks off, no vectors added this run, but the corpus still has documents — e.g. a deletion when the
          // live store is missing/corrupt, so no clone/shadow was built. The in-memory maps were updated above;
          // persist them so the deletion sticks. Without this the old manifest + parent/passage/child maps
          // resurrect the removed document (as a stale BM25-only orphan) on the next restart.
          stampManifestVersions(newManifest);
          newManifest._bm25Median = manifest._bm25Median ?? state.liveBM25.medianScore;
          try { await saveManifest(newManifest); await persistIndexMaps(cfgPaths.CACHE_DIR, state); }
          catch { /* best-effort */ }
          if (DEBUG) console.log(`🗑️  Persisted ${toDelete.length} deletion(s) in a vectorless (BM25-only) corpus`);
        } else {
          console.warn('⚠️  No indexable documents found');
        }
        return;
      }

      const ntotalFinal = typeof shadowStore.index.ntotal === 'function'
        ? shadowStore.index.ntotal() : shadowStore.index.ntotal;
      if (DEBUG) console.log(`✅ Shadow store ready — ${ntotalFinal} vectors`);

      // Build BM25 + the chunk index into a SHADOW before touching any live field, so the whole index
      // swaps in one synchronous run below. buildBM25Index now yields the event loop while it builds, so
      // assigning the new maps first and awaiting the build would briefly pair the new maps with the old
      // BM25/chunk index for any query that snapshots state during the build.
      // Pin the median to the baseline computed at first index. The out-of-scope /
      // topic-shift gates compare a query's top BM25 score against this median, so it
      // has to stay stable across re-indexes — recomputing it here lets it drift on
      // every delta (and on every restart re-index), which silently raises the bar
      // and makes previously-answerable queries fall through to the web-fallback
      // prompt. Recompute only when there is no baseline yet (first-ever index).
      const shadowIdx = { parentMap: shadowParentMap, childMap: shadowChildMap, passageMap: shadowPassageMap, chunkIndex: new Map() };
      // Reuse the live BM25/IDF when the shadow's document text is unchanged. A bank-consolidation batch moves
      // documents between vector stores without changing their text, so every batch after the first would
      // otherwise re-tokenize and re-consolidate the entire corpus. If any text changed, this rebuilds as before.
      const shadowBM25 = await buildOrReuseBM25Index(shadowParentMap, manifest._bm25Median ?? null, shadowIdx,
        { bm25: state.liveBM25, idf: state.corpusIdf, map: state.parentMap });
      buildChunkIndexInto(shadowIdx);
      if (DEBUG) console.log(`✅ BM25 index built — ${shadowParentMap.size} documents`);

      // Write-ahead marker: the vector store, the manifest, and the index maps are separate files, so a crash
      // after the vectors are written but before the manifest catches up would leave the next delta to re-embed
      // an already-stored file (duplicate vectors) or orphan old ones. Mark the commit as pending BEFORE the
      // swap-and-persist and clear it only once every file below is durable; a marker still present on the next
      // warm start — or at the top of the next in-process delta (see isPending above) — forces a clean rebuild
      // that drops any such duplicates. Written BEFORE the in-memory swap on purpose: if the marker can't be
      // written (a full/unwritable disk), persisting will fail too, so swapping the new index into memory would
      // leave memory ahead of an unpersistable disk with NO marker to heal it. Defer the whole update instead —
      // the committed on-disk index stays live and this delta is retried on the next trigger.
      if (!commit.begin(cfgPaths.CACHE_DIR)) {
        throw new Error('could not write the index commit marker (disk full or unwritable) — deferring this index update');
      }

      // Atomic swap — one synchronous run, no await between assignments, so a query sees the whole new
      // index (maps + vector store + BM25 + IDF + chunk index) at once, never a mix of old and new.
      state.liveVectorStore = shadowStore;
      state.parentMap  = shadowParentMap;
      state.childMap   = shadowChildMap;
      state.passageMap = shadowPassageMap;
      state.liveBM25   = shadowBM25;
      state.corpusIdf  = shadowIdx.corpusIdf;
      state.chunkIndex = shadowIdx.chunkIndex;
      // Stamp the generation INSIDE the atomic swap, not after the awaited persist below. Per-generation
      // caches (semantic cache, search/keyword candidate caches, the entity graph) key on lastIndexedAt; if it
      // only advanced after the multi-second persist, those caches would serve pre-delta answers computed
      // against the already-swapped new content for the whole persist window. vectorCount (a health stat) is
      // set here too, from the value computed before the swap.
      state.lastIndexedAt = Date.now();
      state.vectorCount = ntotalFinal;

      // Persist. With banks on, the store is the ACTIVE bank — save it into its bank
      // directory and reflect the new store object in state.vectorBanks so subsequent
      // queries union the fresh active bank alongside the frozen ones.
      if (banks) {
        await banks.saveActiveStore(cfgPaths.CACHE_DIR, state.liveVectorStore, activeFp);
        let entry = state.vectorBanks.find(b => b.fp === activeFp);
        if (!entry) {
          entry = { fp: activeFp, meta: activeMeta, store: null, embeddings, active: true };
          state.vectorBanks.push(entry);
        }
        for (const b of state.vectorBanks) b.active = (b.fp === activeFp);
        entry.store = state.liveVectorStore;
      } else {
        await saveStoreAtomic(state.liveVectorStore, cfgPaths.CACHE_DIR);
      }
      // Persist any contextual-retrieval blurbs generated this pass so the next index
      // reuses them (each is an LLM call). No-op when contextual retrieval is off.
      try { require('./context').flush(); } catch {}
      stampManifestVersions(newManifest);
      // Carry the pinned baseline forward; never overwrite it with a recomputed value.
      newManifest._bm25Median     = manifest._bm25Median ?? state.liveBM25.medianScore;
      await saveManifest(newManifest);

      await persistIndexMaps(cfgPaths.CACHE_DIR, state);
      // Every index file is now durable — the commit is complete, so drop the write-ahead marker. A crash
      // before this point leaves the marker in place and the next warm start rebuilds cleanly.
      commit.end(cfgPaths.CACHE_DIR);

      // The swap is committed and durable — now it is safe to delete the purged documents' figure
      // thumbnails. Deferred to here (not the purge loop) so a mid-run failure never strands a changed
      // document's live figures. Best-effort; a failure here only leaves recoverable orphan thumbnails.
      if (figuresToRemove.length) {
        try { require('./figurestore').removeMany(cfgPaths.CACHE_DIR, figuresToRemove); } catch { /* orphan thumbnails are cleaned by a later rebuild */ }
      }

      try { await fs.rm(path.join(cfgPaths.CACHE_DIR, '_shadow'), { recursive: true, force: true }); } catch {}

      // Record lifecycle/health stats (surfaced via /api/health). lastIndexedAt/vectorCount were already
      // stamped inside the atomic swap above so the generation moves with the content.
      // Surface files that were found but produced no document, so a folder that
      // "indexed fine" yet contributed nothing has a visible explanation.
      const skipped = getSkipReport();
      if (skipped.tooSmall.length > 0) {
        console.warn(`⚠️  ${skipped.tooSmall.length} file(s) skipped as too small (under ${MIN_FILE_SIZE} bytes): ${skipped.tooSmall.slice(0, 5).join(', ')}${skipped.tooSmall.length > 5 ? '…' : ''}`);
      }
      if (skipped.tooLarge && skipped.tooLarge.length > 0) {
        console.warn(`⚠️  ${skipped.tooLarge.length} file(s) skipped as too large to index safely — raise "maxFileBytes" in config.json to include them: ${skipped.tooLarge.slice(0, 5).join(', ')}${skipped.tooLarge.length > 5 ? '…' : ''}`);
      }
      if (skipped.truncated.length > 0) {
        console.warn(`⚠️  ${skipped.truncated.length} scanned document(s) were only partly read — raise "Max pages per document" in Settings to include the rest: ${skipped.truncated.slice(0, 5).join(', ')}${skipped.truncated.length > 5 ? '…' : ''}`);
      }
      if (skipped.textTruncated && skipped.textTruncated.length > 0) {
        console.warn(`⚠️  ${skipped.textTruncated.length} large text file(s) exceeded the ${Math.round(require('./parsecore').MAX_TEXT_CHARS / (1024 * 1024))} MB per-document limit and were indexed in part: ${skipped.textTruncated.slice(0, 5).join(', ')}${skipped.textTruncated.length > 5 ? '…' : ''}`);
      }
      if (skipped.nameOnly.length > 0) {
        console.warn(`⚠️  ${skipped.nameOnly.length} file(s) had no extractable text and were indexed by name only (findable by file name, not by content — often a scanned PDF with no text layer): ${skipped.nameOnly.slice(0, 5).join(', ')}${skipped.nameOnly.length > 5 ? '…' : ''}`);
      }

      // Always print a completion line when a delta index finishes — not only when it
      // ran long. A fast index (a file or two, done in seconds) previously printed the
      // starting "Indexing: 1/2" line but no "done" line, because both completion logs
      // were gated (one on >10s elapsed, the other on DEBUG) — so a quick index looked
      // like it had stalled mid-way. Printing unconditionally makes "finished quickly"
      // distinguishable from "stuck".
      if (toAdd.length > 0) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`✅ Indexing complete — ${toAdd.length} file(s) in ${secs}s`);
      }

      // Release the OCR worker once the run is done. tesseract.js workers hold
      // memory for the life of the process if never terminated.
      try { await require('../ocr').releaseTesseract(); } catch {}
      // Persist the OCR, visual-ingest, and summary caches once per run rather than per document.
      try { require('../ocrcache').flush(); } catch {}
      try { require('../visualcache').flush(); } catch {}
      try { require('../summarycache').flush(); } catch {}
      try { require('../transcriptcache').flush(); } catch {}

      state.lastDelta = { added: toAdd.length, removed: toDelete.length, at: state.lastIndexedAt };

      if (DEBUG) console.log(`✅ Index updated — ${toAdd.length} added/modified, ${toDelete.length} removed`);

      // Refresh the LLM knowledge graph in the background when it is enabled. It is fully off the
      // indexing path: deferred to a later tick (after this run's bundle invalidation in `finally`, so
      // it reads the just-updated corpus), fire-and-forget, and incremental — it re-extracts only the
      // documents whose text changed and prunes removed ones, so a steady corpus costs nothing. Any
      // failure is swallowed inside buildGraph and can never affect indexing or queries.
      if (require('../config').useGraphRag) {
        const wsId = state.workspaceId || 'default';
        setImmediate(() => {
          Promise.resolve()
            .then(() => require('../graphstore').buildGraph(wsId))
            .catch((e) => { if (DEBUG) console.log(`  🕸️  Knowledge-graph refresh skipped (${e && e.message})`); });
        });
      }

    } catch (err) {
      console.error('❌ Delta index error:', err);
      // Surface it in the UI too — when Lokyni runs as a background service the
      // console isn't visible, so a silent console.error means the user just sees
      // documents that never appear.
      try {
        require('../socket').broadcast('index_error', {
          workspaceId: state.workspaceId,   // scope to members of the workspace being indexed (a message can name a file)
          message: err.error || err.message || String(err),
        });
      } catch {}
    } finally {
      // Always clean the shadow scratch dir, even if the delta threw mid-way.
      try { await fs.rm(path.join(cfgPaths.CACHE_DIR, '_shadow'), { recursive: true, force: true }); } catch {}
      // This workspace's index changed on disk, so any bundle the API cached for it
      // is now stale — drop it so the next API query reloads fresh data.
      try { require('./bundle').invalidateBundle(state.workspaceId); } catch {}
      state.indexing = false;
      state.indexPromise = null;
      state.indexProgress = null;   // stop the heartbeat reporting per-file progress
    }
  })();

  return state.indexPromise;
};

module.exports = { runDeltaUpdate, saveStoreAtomic, embedChunks, clearParseBackoff, shouldIndexFile, storeDimension };   // saveStoreAtomic + embedChunks + shouldIndexFile + storeDimension exported for their regression tests

// Guarantee a delta scan that begins AFTER this call returns. runDeltaUpdate
// dedupes via state.indexPromise — so if a scan is already in flight (e.g. the
// file watcher fired), calling runDeltaUpdate() returns that promise, which may
// have already read the disk before a just-uploaded file existed. For an explicit
// post-upload trigger we need a scan that observes the new file: wait for any
// in-flight run to finish, then run one more. If nothing is in flight, this is a
// single scan. Cheap either way — runDeltaUpdate is a no-op when disk matches the
// manifest.
const reindexNow = async () => {
  if (state.indexPromise) {
    try { await state.indexPromise; } catch { /* its own error handling applies */ }
  }
  return runDeltaUpdate();
};

module.exports.reindexNow = reindexNow;
