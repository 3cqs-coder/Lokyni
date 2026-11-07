'use strict';
// Semantic answer cache — return a stored answer instantly when the same question is asked
// again against an unchanged corpus, skipping retrieval and generation entirely.
//
// Correctness is the priority over hit rate, because a wrong cache hit would undermine the
// no-fabrication promise. So a hit is served ONLY when everything that could change the
// answer is identical:
//   • the workspace and its corpus (a "fingerprint" of document count + last-index time +
//     embedding model — any index change moves it and retires every prior entry),
//   • the answer-affecting configuration (provider, model, temperature, and the retrieval
//     toggles that change what is retrieved or how it is written — the "signature"),
//   • the normalized question text (exact match after lowercasing and whitespace collapse).
// The caller adds further guards (only fresh, standard questions are cached — never a
// follow-up, a web/research answer, a focused/attached query, or a date-filtered one), so a
// hit can only ever be a genuine repeat.
//
// Storage mirrors outcomes.js: one JSON file per workspace at <cacheDir>/semantic-cache.json,
// dependency-free and atomic. Off by default (opt-in via useSemanticCache).

const fsp  = require('fs').promises;
const path = require('path');
const { writeFileAtomicAsync } = require('./disk');
const { statKey, ABSENT } = require('./statkey');

const FILE = 'semantic-cache.json';
const MAX_ENTRIES = 200;                 // cap; oldest trimmed beyond this
const MAX_BYTES = 16 * 1024 * 1024;      // hard size cap — each entry stores its (fat) passage sources, so bound
                                         // the file AND the in-memory array by bytes too, not only by entry count
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // entries older than this are ignored and pruned

const filePathFor = (cacheDir) => path.join(cacheDir || require('./config').CACHE_DIR, FILE);

// Normalize a question so trivial differences (case, spacing) still hit.
const normalize = (q) => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');

// A string that changes whenever the corpus changes, so a stale answer is never served.
const fingerprint = (state, cfg) =>
  [state.workspaceId || '', state.parentMap ? state.parentMap.size : 0,
   state.lastIndexedAt || 0, (cfg || require('./config')).EMBEDDINGS_MODEL || ''].join('|');

// A string capturing every setting that changes WHICH documents are retrieved or HOW the
// answer is written. It must be exhaustive: a knob left out here could serve an answer
// computed under different settings. Includes the provider/model/temperature/output cap, the
// full retrieval stack (reranker on/off AND which model, fusion weights, the acceptance gate,
// embedding banks, the corrective threshold), and the answer-shaping toggles.
// `opts.persona` overrides the workspace persona folded into the signature, so a window answering
// from a NON-active workspace keys its cache on THAT workspace's persona rather than the active one.
// Absent, it falls back to the active workspace persona (the single-window case, unchanged).
const signature = (cfg, opts = {}) => {
  const c = cfg || require('./config');
  const persona = (typeof opts.persona === 'string') ? opts.persona : c.WORKSPACE_PERSONA;
  return [
    // The answer pipeline's own version: a prompt/safeguard change that no setting captures must retire old
    // cached answers, or an upgrade would replay text produced by the previous pipeline for up to the TTL.
    `pipeline:${require('./constants').ANSWER_PIPELINE_VERSION}`,
    c.AI_PROVIDER, c.LLM_MODEL, c.TEMPERATURE, c.MAX_TOKENS, c.numCtx, c.PASSAGE_SIZE,
    c.USE_RERANKER, c.RERANKER_MODEL,
    // The ColBERT late-interaction reranker RE-SORTS the served passages when on (search.js), and the
    // off-topic cutoff decides whether the whole query abstains — both change the answer and both are
    // query-time (no re-index), so a cached answer from before either changed must not be replayed. Enabling
    // "Late-interaction reranking" otherwise returned the pre-ColBERT answer until the corpus changed or the
    // entry expired — the same class of miss already fixed for RAG-Fusion / HyDE / the entity graph below.
    c.USE_COLBERT_RERANK, c.COLBERT_MODEL, c.RERANKER_DROP_BELOW,
    c.rrfFaissWeight, c.rrfBm25Weight, c.rrfK, c.MIN_COSINE_SCORE,
    c.useEmbeddingBanks, c.useContextualRetrieval,
    c.useCorrectiveRetrieval, c.correctiveCosineMax, c.usePartialMatchTier, c.useQueryRewrite,
    // Cross-lingual mode ranks dense-only and skips the keyword/cross-encoder gates when the multilingual
    // embedding reports a strong match with no keyword support — it changes which document answers a query,
    // so a cached answer from before it was toggled must not be replayed for the same question.
    c.useCrossLingual,
    // The recall-augmentation toggles change what a query retrieves, so a cached answer from
    // before one was enabled (or after one was disabled) must not be replayed for the same
    // question. Enabling RAG-Fusion / HyDE / the entity graph / adaptive retrieval otherwise
    // returned the pre-augmentation answer until the corpus changed or the entry expired. The
    // sub-models are folded in too, so changing which model does the augmentation also invalidates.
    c.useRagFusion, c.useHyde, c.useEntityGraph, c.useGraphRag, c.useAdaptiveRetrieval,
    c.ragFusionModel, c.hydeModel, c.GRAPH_RAG_MODEL, c.GRAPH_HOPS, c.ragFusionQueries, c.hydeMaxTokens,
    // Intent classification steers a first query to specific documents and can rewrite it, and the
    // meta-conversation toggle changes whether a meta turn is answered normally (and cached) — both
    // change a freshly-computed answer, so a cached entry must not survive toggling them or changing
    // the intent model.
    c.useIntentClassifier, c.intentModel, c.useMetaConversation,
    // Clarifying-questions gates whether an ambiguous (cacheable, no-history) query is answered directly or asked
    // back about — it changes the produced response, and the intent classifier runs on first queries too, so a
    // cached direct answer must not be replayed after the operator turns clarifying questions on.
    c.useClarifyingQuestions,
    // Answer wording: the workspace persona and the assistant role change how the answer reads and
    // are editable without a re-index, so a cached answer must not survive changing them.
    persona, c.ASSISTANT_ROLE,
  ].join('|');
};

// Tiny per-path mem cache keyed by file path + the shared stat fingerprint (lib/statkey.js — mtime + size +
// inode, so a rewrite within one mtime tick is still seen; correctness never depends on it). All disk access is
// async so the message hot path never blocks the event loop.
const _mem = new Map();
async function load(cacheDir) {
  const fp = filePathFor(cacheDir);
  let stk = ABSENT;
  try { stk = statKey(await fsp.stat(fp)); } catch { /* no file yet */ }
  const cached = _mem.get(fp);
  if (cached && cached.stk === stk && stk !== ABSENT) return cached.entries;
  let entries = [];
  try { entries = JSON.parse(await fsp.readFile(fp, 'utf-8')); if (!Array.isArray(entries)) entries = []; }
  catch { entries = []; }
  _mem.set(fp, { entries, stk });
  return entries;
}
async function save(cacheDir, entries) {
  const fp = filePathFor(cacheDir);
  try {
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    let trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries.slice();
    // Then a byte cap: entries carry full passage text, so cap the serialized size and drop oldest-first until it
    // fits (keep at least the newest one). Bounds both the file and the in-memory array regardless of entry sizes.
    let json = JSON.stringify(trimmed);
    while (trimmed.length > 1 && Buffer.byteLength(json) > MAX_BYTES) { trimmed = trimmed.slice(1); json = JSON.stringify(trimmed); }
    // Atomic write through the shared helper: a unique temp per write so two answers finishing at once in
    // the same workspace can't clobber one temp before its rename, then an atomic replace. Correctness
    // never depends on the cache, so it skips fsync.
    await writeFileAtomicAsync(fp, json);
    let stk = ABSENT; try { stk = statKey(await fsp.stat(fp)); } catch {}
    _mem.set(fp, { entries: trimmed, stk });
  } catch { /* cache is best-effort — never break answering */ }
}

// Return a cached answer for this exact question under an unchanged corpus + config, or null.
async function lookup(cacheDir, { fingerprint: fpVal, signature: sig, query }) {
  const q = normalize(query);
  if (!q) return null;
  const now = Date.now();
  const entries = await load(cacheDir);
  for (let i = entries.length - 1; i >= 0; i--) {   // newest first
    const e = entries[i];
    if (e && e.q === q && e.fp === fpVal && e.sig === sig && (now - (e.ts || 0)) < TTL_MS) {
      return { answer: e.answer, sources: Array.isArray(e.sources) ? e.sources : [] };
    }
  }
  return null;
}

// Store an answer. Replaces any prior entry for the same question/config, drops entries from
// a superseded corpus (a different fingerprint) so the file self-cleans after a re-index, and
// caps the total.
async function store(cacheDir, { fingerprint: fpVal, signature: sig, query, answer, sources }) {
  const q = normalize(query);
  if (!q || !answer) return;
  // A read replica shares the data dir; populating this shared cache would race the primary's read-modify-write
  // and lose entries. A replica still READS the cache the primary built — it just never writes it.
  if (require('./cluster').isReplica()) return;
  const now = Date.now();
  const entries = (await load(cacheDir)).filter((e) =>
    e && e.fp === fpVal && (now - (e.ts || 0)) < TTL_MS && !(e.q === q && e.sig === sig));
  entries.push({ q, sig, fp: fpVal, answer, sources: Array.isArray(sources) ? sources : [], ts: now });
  await save(cacheDir, entries);
}

module.exports = { lookup, store, normalize, fingerprint, signature, filePathFor, MAX_ENTRIES, MAX_BYTES, TTL_MS };
