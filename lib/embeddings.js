'use strict';
const { OllamaEmbeddings } = require('@langchain/ollama');
const { raceTimeout } = require('./llm');
const { DEBUG } = require('./config');

// Bound an embedding provider call against the idle deadline. An embed is a network call to the
// same Ollama/OpenAI host as generation, and the SDKs set no request timeout of their own, so a
// stalled endpoint would hang the search hot path forever (and, because the socket message handler
// serializes per connection, wedge every later message behind it). raceTimeout rejects on timeout;
// callers already degrade a rejection to an empty result (a normal keyword-only miss), so the
// contract is unchanged — we just stop waiting. Read the budget live so a Settings change applies
// without a restart. Reused by every embed site so the bound can never drift between them.
const embedBounded = (promise) => raceTimeout(promise, require('./config').EMBED_TIMEOUT_MS);

// A bank whose provider is unreachable (a retired endpoint, a deleted model, a changed dimension) would
// otherwise pay the full EMBED_TIMEOUT_MS on EVERY query. Remember the failure per store for a cooldown so
// one query pays for the discovery and later queries skip that bank; a success clears it. The cooldown starts
// short so a transient blip recovers quickly and backs off (capped) for a genuinely dead endpoint. Keyed
// weakly and bounded by the loaded bank count, so traffic cannot grow it. Shared by every dense-search site
// so the cooldown can never drift between the main search and the related-documents scan.
const BANK_COOLDOWN_BASE_MS = 30 * 1000;
const BANK_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const bankCooldowns = new WeakMap();
const bankIsCooling = (store) => {
  const state = bankCooldowns.get(store);
  return !!state && state.until > Date.now();
};
const noteBankFailure = (store) => {
  const state = bankCooldowns.get(store) || { fails: 0, until: 0 };
  const first = state.fails === 0;
  state.fails += 1;
  state.until = Date.now() + Math.min(BANK_COOLDOWN_MAX_MS, BANK_COOLDOWN_BASE_MS * (2 ** (state.fails - 1)));
  bankCooldowns.set(store, state);
  if (first) {
    try {
      console.warn('⚠️  An embedding bank could not be queried — skipping it while it backs off so searches stay fast. Check the embedding provider, or run Settings → Consolidate embedding banks.');
    } catch { /* logging must never break search */ }
  }
};
const noteBankSuccess = (store) => { bankCooldowns.delete(store); };
// The embedding provider, host, keys, and model are all writable Settings keys, so they must be
// read LIVE at call time — never destructured at import. reloadConfig() re-requires ./config on a
// Settings save; a value captured here would keep every embedding call on the boot-time provider,
// so switching Ollama<->OpenAI or changing the embeddings model/host would silently never reach
// indexing or query embeddings until a restart.

// faiss-node's IndexFlatL2 returns the SQUARED L2 distance (d²), and LangChain's FaissStore passes
// it through unchanged. For unit-normalized embeddings ||a−b||² = 2 − 2·cos, so cos = 1 − d²/2 — the
// argument is already squared and must NOT be squared again. Clamped at 0 so a below-orthogonal hit
// reads as "no similarity" rather than a negative score. Monotonic in d², so it never reorders hits;
// it only puts the relevance gate and the corrective-retrieval trigger in a true-cosine scale. The
// unit-normalization that makes this exact is ENFORCED below (withUnitNorm), not merely assumed, so the
// scale holds for any embedding model — not only the defaults, which happen to normalize their output.
const l2ToCosine = (l2) => Math.max(0, 1 - l2 / 2);

// Scale a vector to unit length. Returns a new array; a zero vector is returned unchanged (there is no
// direction to normalize, and dividing would produce NaN). Uses a plain loop rather than allocating
// intermediate arrays, so it adds negligible cost next to the network embed call it wraps.
const unitNormalize = (v) => {
  if (!Array.isArray(v) || v.length === 0) return v;
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  if (sumSq === 0) return v;
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
};

// Wrap an embeddings client so every vector it returns — for indexing (embedDocuments) and for queries
// (embedQuery, which the FAISS store calls internally at search time) — is unit-normalized. The relevance
// gate and the corrective-retrieval trigger read a cosine derived from the FAISS L2 distance (l2ToCosine),
// which is only a true cosine when both stored and query vectors are unit length. The default models
// already emit normalized vectors (so this is a no-op for them), but a user-selected model may not, which
// would silently mis-calibrate the gate — declining valid queries or firing corrective retrieval on every
// turn. Normalizing here makes the scale correct for ANY model. Because both the index vectors and the
// query vectors go through the same wrapper, they stay consistent. (Switching the embeddings model already
// rebuilds the index, so a switch to a non-normalizing model re-embeds under this wrapper automatically.)
const withUnitNorm = (emb) => {
  const embedDocuments = emb.embedDocuments.bind(emb);
  const embedQuery     = emb.embedQuery.bind(emb);
  emb.embedDocuments = async (texts) => (await embedDocuments(texts)).map(unitNormalize);
  emb.embedQuery     = async (text)  => unitNormalize(await embedQuery(text));
  return emb;
};

// Build an embeddings client. Defaults to the current (live) config, but accepts explicit
// { provider, model, baseUrl } overrides so a frozen embedding bank can be queried with
// the exact model that built it rather than whatever the app is configured for now.
const makeEmbeddings = (overrides = {}) => {
  const cfg      = require('./config');
  // Default to the EMBEDDING provider, resolved independently of the chat provider, so the chat
  // provider can be a chat-only one (e.g. Anthropic) while embeddings keep running on Ollama/OpenAI.
  // A frozen bank still passes its own stored { provider, model, baseUrl } so it is queried with the
  // exact model that built it.
  const provider = overrides.provider || cfg.EMBEDDINGS_PROVIDER;
  const model    = overrides.model    || cfg.EMBEDDINGS_MODEL;
  if (provider === 'openai') {
    // Use OpenAI embeddings via LangChain's OpenAIEmbeddings wrapper. The embed key/base are resolved
    // independently of the chat provider (EMBEDDINGS_API_KEY/BASE_URL each fall back to the chat OpenAI
    // key/base when unset), so a hosted embed endpoint can carry its own credentials. A frozen bank's
    // own stored baseUrl still wins so it is queried with the exact endpoint that built it.
    const { OpenAIEmbeddings } = require('@langchain/openai');
    // A frozen bank's own stored baseUrl wins; else the configured embed base, else the chat OpenAI base — the
    // SAME resolver the bank fingerprint uses (config.embedBaseUrl), so the endpoint and the fingerprint agree.
    // The embed key likewise falls back to the chat OpenAI key when unset — the ONE place that fallback lives.
    const baseURL = cfg.embedBaseUrl(cfg, 'openai', overrides.baseUrl);
    return withUnitNorm(new OpenAIEmbeddings({
      model,
      apiKey: cfg.EMBEDDINGS_API_KEY || cfg.OPENAI_KEY,
      ...(baseURL ? { configuration: { baseURL } } : {}),
    }));
  }
  // Default: Ollama. The API key is optional — only needed for Ollama Cloud or an
  // authenticated proxy — and must be sent on embeddings requests too, not just chat.
  return withUnitNorm(new OllamaEmbeddings({
    model,
    baseUrl: cfg.embedBaseUrl(cfg, 'ollama', overrides.baseUrl),
    batchSize: 256,
    ...(cfg.OLLAMA_KEY ? { headers: { Authorization: `Bearer ${cfg.OLLAMA_KEY}` } } : {}),
  }));
};

// The vector stores to search for a bundle: every loaded embedding bank when banks are in
// use, otherwise the single live store. Frozen and active banks are all included — each
// carries its own embeddings client bound to the model that built it.
const denseStores = (idx) => {
  if (idx && Array.isArray(idx.vectorBanks) && idx.vectorBanks.length) {
    return idx.vectorBanks.map(b => b.store).filter(Boolean);
  }
  return idx && idx.liveVectorStore ? [idx.liveVectorStore] : [];
};

// Dense (vector) search across every store for a bundle, returned as [doc, cosine] sorted
// best-first and capped at k. With a single store this is exactly one similarity search;
// with multiple banks it unions their hits. Cross-model cosine scores aren't perfectly
// comparable, but the downstream rank-based fusion and cross-encoder reranker re-order the
// merged candidates, so the union only needs to surface each bank's best matches.
// Clamp the requested k to a store's vector count. Asking FAISS for more neighbors than the index holds is
// harmless (it returns what it has) but makes faiss-node print a "k is greater than the number of elements"
// warning to the console on every query against a small index/bank — noise that the quiet-by-default logging
// posture should not emit. Clamping avoids it entirely. Never throws; falls back to the requested k.
const clampK = (store, k) => {
  try {
    const n = store && store.index && (typeof store.index.ntotal === 'function' ? store.index.ntotal() : store.index.ntotal);
    return (Number.isFinite(n) && n > 0) ? Math.min(k, n) : k;
  } catch { return k; }
};

// `opts` carries test-only dependency injection (a cacheDir and a live-query embed function); production callers
// pass none and the live config is used. It never changes behavior, only the source of the injected pieces.
const denseSearch = async (idx, query, k, opts = {}) => {
  const banksList = (idx && Array.isArray(idx.vectorBanks)) ? idx.vectorBanks.filter(b => b && b.store) : [];
  // Simple path ONLY when there is no bank layout at all (banks off → the single liveVectorStore). Any loaded
  // bank — even a single FROZEN one while the just-created active bank has no vectors yet — goes through the
  // adapter-aware path below, or a frozen bank whose provider just died would lose its adapter fallback. Degrade
  // to an empty result on error, uniformly with the multi-bank path, so a query-time embeddings failure is
  // handled the same whether banks are on or off.
  if (banksList.length === 0) {
    const stores = denseStores(idx);
    if (stores.length === 0) return [];
    const store = stores[0];
    if (bankIsCooling(store)) return [];
    try {
      const hits = await embedBounded(store.similaritySearchWithScore(query, clampK(store, k)));
      noteBankSuccess(store);
      return hits.map(([doc, l2]) => [doc, l2ToCosine(l2)]).sort((a, b) => b[1] - a[1]);
    } catch { noteBankFailure(store); return []; }
  }
  // Multiple banks: query each concurrently and union. The live query is embedded at most ONCE (memoized) and
  // reused by the active bank and by every frozen bank whose own provider is gone — then translated into that
  // bank's space with a stored, measured-viable adapter, so its existing vectors stay searchable WITHOUT
  // re-embedding and WITHOUT keeping the old provider running (the point of switching). The active bank is never
  // adapted — it has a live embedder. Each bank keeps its own catch, so one failing bank still degrades to empty
  // while the others contribute.
  const cacheDir = opts.cacheDir || require('./config').CACHE_DIR;
  const embedQuery = opts.embedQuery || ((q) => makeEmbeddings().embedQuery(q));
  const activeFp = (idx.vectorBanks.find(b => b && b.active) || {}).fp || null;
  let _aqv;   // undefined = not yet embedded, null = embed failed, else the live query vector (one embed per search)
  const getActiveQv = async () => {
    if (_aqv !== undefined) return _aqv;
    try { _aqv = await embedBounded(embedQuery(query)); } catch { _aqv = null; }
    return _aqv;
  };
  // Translate the live query into a FROZEN bank's space with its stored viable adapter and search by vector. The
  // mapped vector is already unit-norm, so the FAISS L2→cosine conversion is a true cosine against that bank's
  // unit-norm vectors. Returns [] (the bank's lexical signal still covers its docs) when there is no viable
  // adapter, the live embed failed, or anything throws.
  const adapterSearch = async (bank) => {
    if (bank.active || !activeFp || bank.fp === activeFp) return [];
    try {
      const adapter = require('./indexing/banks').loadViableAdapter(cacheDir, bank.fp, activeFp);
      if (!adapter) return [];
      const aqv = await getActiveQv();
      if (!aqv) return [];
      const mapped = require('./indexing/embedadapter').applyAdapter(adapter, aqv);
      if (!mapped) return [];
      const hits = await embedBounded(bank.store.similaritySearchVectorWithScore(Array.from(mapped), clampK(bank.store, k)));
      return hits.map(([doc, l2]) => [doc, l2ToCosine(l2)]);
    } catch { return []; }
  };
  const searchBank = async (bank) => {
    const store = bank.store;
    // Own provider is backing off: a frozen bank can still be served by its adapter (no provider needed); the
    // active bank cannot (nothing to translate into, and the live embed would be failing too).
    if (bankIsCooling(store)) return bank.active ? [] : adapterSearch(bank);
    if (bank.active) {
      // Reuse the ONE shared live query embed (no second embed call) — the active bank is bound to the live config.
      const aqv = await getActiveQv();
      if (!aqv) return [];
      try {
        const hits = await embedBounded(store.similaritySearchVectorWithScore(Array.from(aqv), clampK(store, k)));
        noteBankSuccess(store);
        return hits.map(([doc, l2]) => [doc, l2ToCosine(l2)]);
      } catch { noteBankFailure(store); return []; }
    }
    // Frozen bank: prefer its OWN embedder (true vectors). If its provider is gone, fall back to the adapter so
    // the existing vectors are reused with the live provider's translated query.
    try {
      const hits = await embedBounded(store.similaritySearchWithScore(query, clampK(store, k)));
      noteBankSuccess(store);
      return hits.map(([doc, l2]) => [doc, l2ToCosine(l2)]);
    } catch { noteBankFailure(store); return adapterSearch(bank); }
  };
  const perBank = await Promise.all(banksList.map(searchBank));
  // Dedup across banks before truncating to k. A CHANGED document is re-embedded into the active bank while
  // its stale vector can linger in a frozen bank until Consolidate, so the same passage can surface from two
  // banks and take two of the top-k candidate slots — pushing distinct documents out of the window before they
  // reach fusion. Keep the best cosine per chunk (same key as the retrieval fusion: childId, else pageContent)
  // so the k budget carries k DISTINCT passages.
  const best = new Map();
  let uniq = 0;
  for (const hits of perBank) for (const h of hits) {
    const doc = h[0];
    const key = (doc && doc.metadata && doc.metadata.childId) || (doc && doc.pageContent) || `__u${uniq++}`;
    const prev = best.get(key);
    if (!prev || h[1] > prev[1]) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b[1] - a[1]).slice(0, k);
};

// Decide whether a query is on-topic for the corpus. `topCosine` is the best cosine the caller
// already computed from the main dense search, so the gate never pays a second query embedding.
// Pass null when dense search produced nothing — an empty index, or a transient embed-provider
// outage: the gate then degrades to keyword presence rather than hard-refusing a question the BM25
// index can still answer, while a genuinely empty corpus (no keyword match either) is still declined.
// `precomputedBm25` lets the caller pass the BM25 engine result it is about to compute anyway (the main
// keyword step), so the gate reuses it instead of scanning the corpus postings a second time for the same
// query. Only the top score and "any match" are read here, so the caller's larger-k result works unchanged.
const isQueryRelevant = (idx, query, topCosine = null, precomputedBm25 = null) => {
  // Fast path: BM25 keyword presence. Remember whether there is ANY keyword match so a dense-search
  // outage can degrade to keyword mode below instead of refusing a valid question outright.
  let bm25HasMatch = false;
  if (idx.liveBM25?.engine) {
    try {
      const quickBm25 = precomputedBm25 != null ? precomputedBm25 : idx.liveBM25.engine.search(query, 3);
      if (quickBm25 && quickBm25.length > 0) {
        bm25HasMatch = true;
        const topScore = quickBm25[0][1];
        // Corpus-relative, not an absolute constant: a keyword hit that beats the corpus's typical
        // top-1 score is clearly on-topic. This matches the median-scaled BM25 gates used downstream,
        // so a low-scoring corpus isn't held to a fixed bar it can never clear (and a high-scoring one
        // can't wave an off-topic single-token match through). Falls through to the cosine check when
        // the keyword signal alone isn't decisive.
        const median = Number(idx.liveBM25.medianScore) || 3.0;
        if (topScore > median) {
          if (DEBUG) console.log(`  Relevance — BM25 quick check passed (top ${topScore.toFixed(3)} > median ${median.toFixed(2)})`);
          return true;
        }
      }
    } catch (_) {}
  }

  // No usable dense signal (empty index or a dense-search outage): fall back to keyword presence
  // rather than scoring the absent result as cosine 0 and refusing the query.
  if (!(typeof topCosine === 'number' && Number.isFinite(topCosine))) return bm25HasMatch;

  const minCosine = require('./config').MIN_COSINE_SCORE;
  if (DEBUG) console.log(`  Relevance — best cosine: ${topCosine.toFixed(4)} (min: ${minCosine})`);
  return topCosine >= minCosine;
};

module.exports = {
  l2ToCosine, unitNormalize, makeEmbeddings, isQueryRelevant, denseSearch, denseStores, embedBounded,
  bankIsCooling, noteBankFailure, noteBankSuccess,
};
