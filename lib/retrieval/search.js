'use strict';
const path = require('path');
const { DEBUG } = require('../config');
// passageSize is a runtime-writable Setting, so read it LIVE per call rather than freezing it at
// import: a Settings change must affect the very next query, and semanticcache.signature() already
// treats passageSize as answer-affecting, so a frozen value would drift from the cache key.
const passageSize = () => require('../config').PASSAGE_SIZE;
// NOTE: retrieval feature toggles (useReranker, useHyde, useRagFusion, useEntityGraph,
// useCorrectiveRetrieval, useAdaptiveRetrieval, usePartialMatchTier, useTopicSwitchAck, …) are
// read LIVE at the top of searchDocuments, not destructured here — a Settings change hot-reloads
// config, and a value captured at import would stay frozen for the whole process, so a user
// enabling a feature in Settings would see no effect until a restart.

// Upper bound on how much document text is injected WHOLE (without retrieval) —
// used both for Full-Context mode (a selected doc injected entire) and one-off
// attachments (a small file injected entire; a larger one is retrieved down to this
// budget). ~50k chars is roughly 12-15k tokens — safe within a typical 32k-token
// context window while leaving room for the conversation and the model's reply.
const WHOLE_INJECT_MAX_CHARS = 50000;
// Passage-window size for scanning a document's text. A very large document (over ~500k
// chars) uses a wider window — capped at 32k — so a single scan covers more ground and the
// keyword/passage search isn't sliced into hundreds of tiny windows on a huge file; a normal
// document uses the configured PASSAGE_SIZE. Single-sourced here so the four scan sites can't
// drift apart when this heuristic is tuned.
const largeDocWindow = (len) => { const ps = passageSize(); return len > 500_000 ? Math.min(ps * 4, 32000) : ps; };
const state = require('../state');
const { isQueryRelevant, denseSearch } = require('../embeddings');
const { streamChat, buildMessages } = require('../llm');
const { extractKeywords, extractSpecificKeywords, checkDate, escapeRegExp, scanWindowsMax, scanWindowsRanked, SPECIFIC_IDF_MIN, GENERIC_WORDS, docNameTokens } = require('./keywords');
const { reorderByReranker } = require('./rerankorder');
// Cap on how far the passage-location window scans below walk a document's full text, so a huge
// indexed file can't freeze the socket answer path. Single-sourced in retrieval/constants.js.
const { KEYWORD_SCAN_MAX_CHARS } = require('./constants');
const { OUT_OF_SCOPE_MESSAGE, NO_RELEVANT_INFO_MESSAGE } = require('../constants');
// A hard ceiling on the "full" document lowercase used for passage extraction on the few documents that
// survive all gates (where a follow-up may legitimately read past KEYWORD_SCAN_MAX_CHARS). Generous — well
// above the normal extracted-text cap, so it is a no-op in practice — but it keeps the lowercase + scan
// bounded and non-blocking even if that cap is ever raised. Content past this point is not scanned.
const FULL_LOWER_MAX_CHARS = 16 * 1024 * 1024;
// Lowercase only the first KEYWORD_SCAN_MAX_CHARS of a document for the keyword/entity scans, which never
// read past that bound anyway. Lowercasing a whole document (content can be hundreds of MB) synchronously
// on the answer path would stall every other connected client for the copy plus the scan; this keeps the
// cost flat regardless of document size, matching the bound BM25/IDF indexing already uses.
const boundedLower = (text) => (text.length > KEYWORD_SCAN_MAX_CHARS ? text.slice(0, KEYWORD_SCAN_MAX_CHARS) : text).toLowerCase();

// Bound the per-conversation window-score cache. Its key includes the query tokens, so every differently
// worded follow-up against the same document adds an entry (each up to ~1000 [pos,score] pairs), and nothing
// evicts it between ordinary turns — a long single-topic conversation would grow it. Cap it with simple
// oldest-out eviction; cross-turn reuse only helps a retry of the SAME turn or an identical repeated
// follow-up, so dropping the oldest entry costs almost nothing.
const WINDOW_SCORE_CACHE_MAX = 64;
const setBoundedCache = (cache, key, value) => {
  if (cache.size >= WINDOW_SCORE_CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
};
const { makeSnippet } = require('../snippet');
const { viewerLink, figureUrl } = require('../links');
const { tokenize } = require('./keywords');
const { isVagueContinuation } = require('./expand');
const { getRetrievalQuery } = require('./rewrite');
const { classifyIntent } = require('./intent');
const { reciprocalRankFusion } = require('./rrf');
const { getPassageContext, seedChunksForDoc, pickAnchorsByParent } = require('./passages');
const { rerank } = require('./reranker');
const { isMetaQuestion, handleMeta, handleClarify } = require('../meta');
const { clearConversationState, MAX_CONSULTED_DOCS } = require('../conversation');
const { fuseDenseLists } = require('./rrf');
const { assessComplexity } = require('./complexity');

// A bare positional/anaphoric reference ("what about the second one?", "the first",
// "how about that one?") that has NO concrete subject of its own. When such a
// reference can't be grounded in the current conversation (e.g. there is no list to
// index into), the honest response is a clarifying question — not a topic reset that
// searches for the literal words "second one" and then offers a nonsensical web search.
const POSITIONAL_REFERENCE_RE = /^(what|how)?\s*(about|of)?\s*(the\s+)?(first|second|third|fourth|fifth|last|next|previous|other|another|that|this|it|those|these)\s*(one|ones|item|items|option|options|document|documents|file|files)?\??$/i;

const ENDING_INTENT_RE = /\b(end|ends|ended|ending|finale|conclusion|concludes?|finish|finished|final|last|outcome|result|epilogue|afterward|afterwards)\b/i;
const OVERVIEW_INTENT_RE = /\b(about|overview|describe|explain|what is|what are|summarize|introduction|intro)\b/i;
// Comparison intent — the user wants a cross-document comparison. Matches "compare",
// "vs"/"versus", "difference between", "how does X differ/compare", "contrast",
// "similarities/differences". Drives multi-document balanced assembly.
// How far above the bare relevance floor (MIN_COSINE_SCORE) a top cosine must sit to count as a STRONG semantic
// match — the gate on cross-lingual mode, so only a confident embedding match (never an out-of-corpus question
// grazing the floor) is ever trusted without keyword support. One multiple, so it tracks MIN_COSINE_SCORE.
const SEMANTIC_MATCH_MULT = 1.3;

const COMPARISON_INTENT_RE = /\b(compare|comparison|compared|contrast|versus|vs\.?|difference(s)? between|differ(s| )?from|how does .+ (compare|differ)|similarit(y|ies)|differ(ences)?|both .+ and)\b/i;

// Fixed word lists for retrieval decisions, single-sourced as data in lib/ai/data/lexicon.json via ./lexicon —
// each a SEPARATE decision, co-located there (not merged) so they cannot drift apart:
//   REQUEST_WORDS     topic-shift filter (request/style words that carry no topic signal, so a follow-up made
//                     only of them is a continuation, not a new topic)
//   STOP_WORDS_GATE   co-source raw-keyword gate
//   PROPER_NOUN_STOP  proper-noun heuristic
//   DEATH_TERMS       ending/recap detection — narrow whole-word death vocabulary, so a beginning passage never
//                     false-positives as "the ending was already shown" (general words like "ended"/"fate" would)
const { REQUEST_WORDS, STOP_WORDS_GATE, PROPER_NOUN_STOP, ENDING_DEATH_TERMS: DEATH_TERMS, CONNECTIVE_CUES } = require('./lexicon');

// A word whose first character is an uppercase letter (one with a distinct upper/lower form, so digits and
// punctuation don't count). Shared by the proper-noun heuristic and the named-token gate below so the two
// capitalization checks can never drift apart.
const startsCapitalized = (w) => !!w && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase();

// A capitalized word that isn't sentence-initial and isn't a common question word (PROPER_NOUN_STOP, from the
// shared lexicon) signals a named entity / new topic.
const hasProperNoun = (query) => {
  const words = query.trim().split(/\s+/);
  return words.slice(1).some(w =>
    w.length > 3 &&
    startsCapitalized(w) &&
    !PROPER_NOUN_STOP.has(w.toLowerCase().replace(/[^a-z]/g, ''))
  );
};

// ── Unknown named subject ────────────────────────────────────────────────────
// A question can name a subject the corpus does not contain while also using ordinary domain words.
// Keyword weights then look strong ("launch code", "budget"), and the relevance gate can let the
// question through even though every name in it is absent. The helpers below extract only name-like
// terms and check them against the same corpus vocabulary BM25 uses.
//
// Detection is intentionally conservative:
//   • Cased scripts use capitalization after the sentence-initial word. Short all-caps acronyms are
//     skipped because they often expand to a phrase the corpus does use ("AI" for "artificial
//     intelligence"); dense retrieval is the right tool for that, not a hard decline.
//   • Quoted phrases and letter-plus-digit identifiers work in any script, including scripts without
//     case. Unquoted names in those scripts remain the entity graph's job when it is enabled.
//   • A term is known when every token is in the corpus vocabulary, or when it appears in one of the
//     top retrieved chunks (covering a name indexed after the 50k head BM25 reads).
//   • The gate fires only when at least one name-like term is novel and none is known. A question that
//     mixes a known subject with an unknown one is left to the model, which can answer the known part
//     and state what is missing.
const NAME_TITLE_MIN_CHARS = 4;
const NAME_UPPER_MIN_CHARS = 5;
const NAME_ACRONYM_MAX_CHARS = 4;

const stripWordEdges = (w) => String(w || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// A letter-plus-digit token in any script: ZX-9042, ORB-7781, 型-42. This is a code or model name,
// not ordinary prose, so it is name-like even without capitalization.
const isIdentifierLike = (w) => {
  const s = stripWordEdges(w);
  return s.length >= 3 && /\p{L}/u.test(s) && /\p{N}/u.test(s);
};

// Extract the query's name-like terms as phrases. Consecutive capitalized words stay together so a
// two-word name is judged as a unit. Pure; exported for the cross-script unit test.
const extractNamedTerms = (query) => {
  const out = [];
  const add = (value) => {
    const term = String(value || '').trim();
    if (term.length >= 2) out.push(term);
  };

  const text = String(query || '');
  // Quoted names work in every script. Straight single quotes are omitted because they are commonly
  // apostrophes ("Zorvath's"), not a quoted name.
  for (const match of text.matchAll(/["“«]([^"”»]{2,80})["”»]/g)) add(match[1]);

  const words = text.split(/\s+/).map(stripWordEdges).filter(Boolean);
  // Identifiers can be the first word, so scan all words for them before the cased-name grouping.
  for (const word of words) if (isIdentifierLike(word)) add(word);

  // Cased names start after the sentence-initial word, matching hasProperNoun's convention. This
  // avoids treating an ordinary capitalized first word ("Launch the report") as a proper noun.
  let group = [];
  const flush = () => { if (group.length) { add(group.join(' ')); group = []; } };
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!word || REQUEST_WORDS.has(word.toLowerCase())) { flush(); continue; }
    if (isIdentifierLike(word) || !startsCapitalized(word)) { flush(); continue; }
    const allCaps = word === word.toUpperCase();
    if (allCaps && word.length <= NAME_ACRONYM_MAX_CHARS) { flush(); continue; }
    if (word.length < (allCaps ? NAME_UPPER_MIN_CHARS : NAME_TITLE_MIN_CHARS)) { flush(); continue; }
    group.push(word);
  }
  flush();

  const seen = new Set();
  return out.filter((term) => {
    const key = term.normalize('NFC').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// A two-sided RELATIONAL question — "how does A relate to B?", "connect A with B", "the relationship between A
// and B" — wants the same balanced, both-sides retrieval an explicit "compare A and B" gets; otherwise only the
// dominant subject is served and the answer cannot actually connect them. It is recognized by a connective cue
// word (relate / connect / link / tie / associate / relationship, across languages — single-sourced in
// lib/ai/data/lexicon.json) AND the query naming at least TWO distinct subjects. The second condition is what
// keeps it precise: "connect to the server" or a continuation like "how does that relate to B" names fewer than
// two subjects, so neither is mistaken for a comparison. Subject detection (extractNamedTerms) is language-
// agnostic for quoted and identifier names and works across cased scripts, so the pairing holds in any language
// whose connective cue is listed.
const isConnectiveTwoSided = (query) => {
  let hasCue = false;
  for (const t of tokenize(query)) { if (CONNECTIVE_CUES.has(t)) { hasCue = true; break; } }
  return hasCue && extractNamedTerms(query).length >= 2;
};

// Return { terms } when every name-like term in the query is absent from the corpus, or null when the
// query has no name-like term, no corpus vocabulary yet, or at least one known name. `faissResults` is
// the dense candidate list already computed; its top chunks are a cheap fallback for names that sit
// past the indexed head. Never throws: an unexpected shape degrades to "no gate".
const novelEntityGate = (query, idx, faissResults = []) => {
  try {
    if (!idx || !idx.corpusIdf || idx.corpusIdf.size === 0) return null;
    const checks = [];
    for (const term of extractNamedTerms(query)) {
      const tokens = [...new Set(tokenize(term))].filter((t) => t.length > 1);
      if (tokens.length) checks.push({ term, tokens });   // punctuation-only or one character: not judgeable
    }
    if (!checks.length) return null;
    // Every term is already in the indexed text: no candidate scan is needed.
    if (checks.every((c) => c.tokens.every((t) => idx.corpusIdf.has(t)))) return null;

    // A document can be named without that name appearing in its text. Its file-name tokens are a
    // known vocabulary too, cached on the index by docNameTokens so this is not a per-query corpus scan.
    const gen = `${idx.lastIndexedAt || 0}:${idx.parentMap ? idx.parentMap.size : 0}`;
    let docNameSet = idx._novelDocNameSet;
    if (!docNameSet || docNameSet.gen !== gen) {
      const set = new Set();
      try { for (const tokens of docNameTokens(idx).values()) for (const t of tokens) set.add(t); } catch { /* no names available */ }
      docNameSet = { gen, set };
      try { idx._novelDocNameSet = docNameSet; } catch { /* frozen index */ }
    }
    const isKnownToken = (t) => idx.corpusIdf.has(t) || docNameSet.set.has(t);
    if (checks.every((c) => c.tokens.every(isKnownToken))) return null;

    const candidateText = (Array.isArray(faissResults) ? faissResults : [])
      .slice(0, 10)
      .map((row) => (row && row[0] && typeof row[0].pageContent === 'string') ? row[0].pageContent : '')
      .join('\n')
      .normalize('NFC')
      .toLowerCase();

    let known = 0;
    const novel = [];
    for (const { term, tokens } of checks) {
      const allKnown = tokens.every(isKnownToken);
      const inCandidates = !!candidateText && candidateText.includes(term.normalize('NFC').toLowerCase());
      if (allKnown || inCandidates) known++; else novel.push(term);
    }
    if (!novel.length || known > 0) return null;
    return { terms: novel };
  } catch { return null; }
};

// STOP_WORDS_GATE (the co-source raw-keyword gate's stop list) comes from the shared lexicon. It is kept a
// SEPARATE list from the expansion/proper-noun lists on purpose — each gates a different decision, so they are
// co-located in lib/ai/data/lexicon.json rather than merged into one.

// Retrieve the most relevant passages from a large one-off attachment, so a question
// about a specific part of a long file finds that part instead of silently reading
// only the truncated head. Splits the text, embeds the chunks and the query in a
// THROWAWAY fashion (nothing touches the permanent index), cosine-ranks, and returns
// the top chunks concatenated up to `budget` characters. Used only when an attachment
// exceeds the whole-inject cap; small attachments still go in whole.
const ephemeralRetrieve = async (text, query, budget) => {
  try {
    const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
    const { makeEmbeddings, embedBounded } = require('../embeddings');
    // Chunk attachments at the SAME target the indexer uses (single-sourced from chunking.js), so an
    // on-the-fly attachment and an indexed document are split the same way rather than drifting apart.
    const { CHUNK_TARGET } = require('../indexing/chunking');
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_TARGET, chunkOverlap: Math.round(CHUNK_TARGET * 0.1) });
    // Bound the INPUT before chunking + embedding. embedBounded bounds the AWAIT, not the allocation, so a huge
    // attachment would otherwise split into tens of thousands of chunks and embed them all at once → OOM. Cap
    // the scanned text (and, belt-and-suspenders, the chunk count); anything beyond the cap is still covered by
    // the budget-clipped output below. Self-bounding here regardless of any upstream attachment-size limit.
    const EPHEMERAL_SCAN_MAX = 2 * 1024 * 1024;   // ~2 MB of attachment text considered for on-the-fly retrieval
    const MAX_EPHEMERAL_CHUNKS = 4000;
    const scanText = (typeof text === 'string' ? text : '').slice(0, EPHEMERAL_SCAN_MAX);
    let chunks = await splitter.splitText(scanText);
    if (chunks.length === 0) return { text: scanText.slice(0, budget), retrieved: false };
    if (chunks.length > MAX_EPHEMERAL_CHUNKS) chunks = chunks.slice(0, MAX_EPHEMERAL_CHUNKS);

    const embedder = makeEmbeddings();
    // Bound both embeds against the idle deadline; a stalled provider would otherwise hang the
    // whole attachment answer. On timeout the catch below falls back to a head slice.
    const [qVec, chunkVecs] = await Promise.all([
      embedBounded(embedder.embedQuery(query)),
      embedBounded(embedder.embedDocuments(chunks)),
    ]);
    const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
    const mag = (a) => Math.sqrt(dot(a, a));
    const qMag = mag(qVec) || 1;
    const ranked = chunks
      .map((c, i) => ({ c, score: dot(qVec, chunkVecs[i]) / (qMag * (mag(chunkVecs[i]) || 1)) }))
      .sort((a, b) => b.score - a.score);

    const parts = [];
    let used = 0;
    for (const { c } of ranked) {
      if (used >= budget) break;
      const slice = c.length > budget - used ? c.slice(0, budget - used) : c;
      parts.push(slice);
      used += slice.length;
    }
    return { text: parts.join('\n\n…\n\n'), retrieved: true, chunks: chunks.length, kept: parts.length };
  } catch (e) {
    // If ephemeral retrieval fails for any reason, fall back to a head slice so the
    // attachment still produces an answer rather than erroring.
    if (DEBUG) console.log(`  📎 Ephemeral retrieve failed (${e.message}) — using head slice`);
    return { text: text.slice(0, budget), retrieved: false };
  }
};

// Move the conversation's documents to the front of a ranking for a continuation
// follow-up. rankedDocIds is an array of [id, score]; allowedDocIds is the conversation's
// doc-id list, whose [0] is the primary source of the last answer. For a VAGUE
// continuation ("tell me more") the query has no topical signal, so ordering the allowed
// docs by this query's fused score would promote whichever co-source has the higher BASE
// relevance over the document the thread is actually about — so each "tell me more" drifts
// onto it and the model ends up contradicting its own earlier answer. Order by prior
// conversational primacy (allowedDocIds order) instead. A SPECIFIC follow-up keeps
// fused-score order, since its keywords legitimately reflect which allowed doc it targets.
const orderContinuationDocs = (rankedDocIds, allowedDocIds, vagueContinuation) => {
  if (!Array.isArray(allowedDocIds) || allowedDocIds.length === 0) return rankedDocIds;
  const allowedSet  = new Set(allowedDocIds);
  const othersAfter = rankedDocIds.filter(([id]) => !allowedSet.has(id));
  const allowedFirst = vagueContinuation
    ? (() => { const m = new Map(rankedDocIds.map(r => [r[0], r])); return allowedDocIds.filter(id => m.has(id)).map(id => m.get(id)); })()
    : rankedDocIds.filter(([id]) => allowedSet.has(id));
  return [...allowedFirst, ...othersAfter];
};

// A basename → docId map for a bundle's corpus, built once per index generation and cached on the bundle.
// Resolving intent target-document names to ids otherwise rescanned the whole parentMap on every query
// that named a document — O(corpus) synchronous work on the answer path. The cache key is the index
// generation (last-indexed time + document count), so a re-index rebuilds it and nothing goes stale.
// Duplicate basenames across folders collapse to the last one, matching the prior behavior.
function basenameIndexFor(idx) {
  const path = require('path');
  const gen = `${idx.lastIndexedAt || 0}:${idx.parentMap ? idx.parentMap.size : 0}`;
  if (idx._basenameIndex && idx._basenameIndex.gen === gen) return idx._basenameIndex.map;
  const map = new Map();
  if (idx.parentMap) {
    for (const [id, entry] of idx.parentMap) {
      const base = entry?.metadata?.source ? path.basename(entry.metadata.source).toLowerCase() : '';
      if (base) map.set(base, id);
    }
  }
  idx._basenameIndex = { gen, map };
  return map;
}

const searchDocuments = async (query, startDate, endDate, conversationContext, isRetry = false, selectedDocIds = null, attemptNumber = 1, options = {}) => {
  // Read the feature toggles LIVE from config each query, so enabling or disabling a retrieval
  // feature in Settings (which hot-reloads config) takes effect on the very next question rather
  // than only after a restart. require('../config') returns the freshly-reloaded module.
  const cfg = require('../config');
  const USE_RERANKER = cfg.USE_RERANKER;
  const useTopicSwitchAck = cfg.useTopicSwitchAck;
  const usePartialMatchTier = cfg.usePartialMatchTier;
  const useCorrectiveRetrieval = cfg.useCorrectiveRetrieval;
  const useCrossLingual = cfg.useCrossLingual;
  const correctiveCosineMax = cfg.correctiveCosineMax;
  const useRagFusion = cfg.useRagFusion;
  const ragFusionQueries = cfg.ragFusionQueries;
  const ragFusionModel = cfg.ragFusionModel;
  const useAdaptiveRetrieval = cfg.useAdaptiveRetrieval;
  const useHyde = cfg.useHyde;
  const hydeModel = cfg.hydeModel;
  const hydeMaxTokens = cfg.hydeMaxTokens;
  const useEntityGraph = cfg.useEntityGraph;
  const useGraphRag = cfg.useGraphRag;
  // Documents the user asked to inject WHOLE (Full-Context mode) rather than by
  // retrieved passages — bypasses chunking for small docs where windowed retrieval
  // dilutes the answer (e.g. a short ID/license whose one relevant line sinks below
  // the relevance gate). Passed via options to avoid churning the positional args.
  const fullContextDocIds = Array.isArray(options.fullContextDocIds) ? options.fullContextDocIds : [];
  const fullContextSet = new Set(fullContextDocIds);
  // One-off attachments: { name, text } the user attached for THIS message only.
  // Their text is injected as context directly, without being in the index — so a
  // question about an attached file works even though it was never permanently added.
  const attachments = Array.isArray(options.attachments)
    ? options.attachments.filter(a => a && typeof a.text === 'string' && a.text.trim())
    : [];
  const explainTrace = options.explainTrace === true;
  // Streaming pipeline status: an optional callback the caller passes to surface the retrieval phase live
  // (the UI shows it in the "thinking" bubble, so a local-model wait reads as progress rather than a freeze).
  // Best-effort and never throws into the pipeline — a status update must never affect the answer.
  const stage = (text) => { try { if (typeof options.onStage === 'function') options.onStage(text); } catch { /* status is cosmetic */ } };
  // The index this query runs against. Defaults to global `state` (the UI's active
  // workspace) so existing callers are unchanged; the API passes a workspace-scoped
  // bundle so it can query any workspace independently of the UI. Every read of an
  // index field below goes through `idx`, never `state` directly.
  const idx = options.idx || state;
  // Answer with the persona of the workspace THIS query targets (the bundle's own workspace), not the
  // globally-active one — so a window viewing a non-active workspace gets that workspace's tone/role.
  // Resolved once here and threaded to every buildMessages/docsBudget call so the header and the
  // document-budget math stay identical. For the active workspace this equals the current persona, so
  // that path is unchanged. Only persona is per-workspace; model/context/rules are global.
  const workspacePersona = require('../config').personaFor(idx.workspaceId);
  const FAISS_CANDIDATES = 30;
  const BM25_CANDIDATES  = 20;
  // How many passage anchors to keep per document after reranking. The reranker/ColBERT now score EVERY
  // candidate chunk (not one per document), so the anchor for a document is its best-scored chunk — the
  // passage that actually answers the query, not merely the top FAISS chunk. Kept at 1 so a document's
  // served window size is unchanged (one window, as before): the downstream budget trim drops whole
  // trailing documents once the total is exceeded, so enlarging per-document content would crowd out
  // other documents in a multi-source answer. Raise this only alongside a per-document budget.
  const MAX_ANCHORS_PER_PARENT = 1;

  if (!idx.liveVectorStore) throw new Error('Vector store not ready');

  // Records why this answer used the documents it did. Write-only — nothing here
  // feeds back into a retrieval decision.
  const traceMod = require('./trace');
  const trace = explainTrace ? traceMod.newTrace(query) : traceMod.newNoopTrace();

  // If the client disconnects or starts a new turn, options.signal aborts. Generation already honors it
  // (streamChat), but the retrieval PHASE before generation runs a sequence of provider round-trips
  // (intent, corrective rephrase, query expansion, HyDE) plus a cross-encoder/ColBERT rerank. Without a
  // check, an abandoned turn runs all of that to completion and — because turns are serialized — holds the
  // queue against the next real question. Bail at each phase boundary instead. The empty shape below is the
  // same one the out-of-scope and no-result paths already return, and both callers (socket and the API)
  // handle it: the socket re-checks the signal right after searchDocuments and returns without streaming.
  async function* _abortedStream() { /* nothing to stream — the turn was abandoned */ }
  const abortedResult = () => ({ stream: _abortedStream(), sources: [], outOfScope: false, aborted: true, canWebFallback: false, trace: trace.toJSON() });
  const bailIfAborted = () => options.signal && options.signal.aborted;

  const focusModeEarly = selectedDocIds && selectedDocIds.length > 0;

  // 0. Unified intent classification (optional, fail-safe). One LLM pass reads the
  // conversation and returns { intent, targetDocs, resolvedQuery, ambiguous, clarify }.
  // It consolidates topic-shift / comparison / continuation / rewrite into a single
  // decision. On null (disabled, error, or invalid output) we fall through to the
  // heuristic pipeline unchanged. Skipped on retries (the first attempt's decision
  // stands) and in focus mode (the user already scoped the docs).
  let intent = null;
  // When the user attached a file for this message, it is the intended source — skip
  // the meta ("what's this conversation about") and clarify paths entirely, so
  // "what's this about?" with a file attached is answered about the FILE, not the
  // conversation. The attachment block below handles it.
  const hasAttachment = attachments.length > 0;
  // Intent classification and query rewrite below are provider round-trips; bail before them too, so a
  // turn abandoned the instant it starts does not pay up to two aux-LLM calls before the first guard.
  if (bailIfAborted()) return abortedResult();
  if (!isRetry && !focusModeEarly && !hasAttachment) {
    // Fast local backstop for meta questions even when the classifier is disabled.
    if (isMetaQuestion(query)) {
      if (DEBUG) console.log('  🗣️  Meta-conversational turn — answering from conversation state');
      return handleMeta(conversationContext, query);
    }
    // Fast path for unambiguous continuations. A pure "tell me more" / "go on" /
    // "elaborate" is provably a continuation without asking a model — and these
    // content-free phrases are exactly the ones that made the local classifier
    // truncate its JSON (it would try to name documents or over-resolve the query
    // and blow the token budget). Detecting them with isVagueContinuation — the same
    // single-source test the rewrite/expand paths use — lets us synthesize the
    // classification directly, skip the LLM round-trip entirely (faster), and sidestep
    // the truncation. It also catches continuations phrased as a question ("what else
    // does it talk about?") structurally, so they take this path instead of an LLM guess
    // that may resolve them onto a tangential document. Only when there's an active
    // conversation to continue; with no prior turns a vague query falls through.
    if (conversationContext.history?.length > 0 &&
        conversationContext.allowedDocIds?.length > 0 &&
        isVagueContinuation(query, idx)) {
      if (DEBUG) console.log('  🧭 Intent: continue (fast path — vague continuation, no LLM call)');
      intent = { intent: 'continue', targetDocs: [], resolvedQuery: '', ambiguous: false, clarify: '' };
    } else {
      try { intent = await classifyIntent(conversationContext, query, idx); } catch { intent = null; }
    }

    if (intent) {
      // Meta: answer from conversation state, no retrieval.
      if (intent.intent === 'meta') {
        if (DEBUG) console.log('  🗣️  Intent=meta — answering from conversation state');
        return handleMeta(conversationContext, query);
      }
      // Ambiguous reference: ask one clarifying question instead of guessing.
      if (intent.ambiguous && intent.clarify) {
        const clar = handleClarify(intent.clarify);
        if (clar) return clar;
      }
    }
  }

  // Map intent target document names → docIds (used to steer retrieval below). Uses a lazily-built,
  // generation-cached basename index so a corpus of any size is scanned once per index build, not on every
  // query that names a document.
  let intentTargetIds = (() => {
    if (!intent || !intent.targetDocs || intent.targetDocs.length === 0) return null;
    const byName = basenameIndexFor(idx);
    const ids = intent.targetDocs.map(n => byName.get(n.toLowerCase())).filter(Boolean);
    return ids.length ? ids : null;
  })();

  // 1. Query rewrite / expansion — resolve follow-up references for retrieval.
  // Prefer the intent classifier's resolvedQuery when available (it read the whole
  // thread); otherwise fall back to the heuristic rewrite/expansion pipeline.
  let standaloneQuery;
  if (intent && intent.resolvedQuery && intent.resolvedQuery !== query) {
    standaloneQuery = intent.resolvedQuery;
    conversationContext._resolvedFor = query;
    conversationContext._resolved    = standaloneQuery;
    if (DEBUG) console.log(`Query: "${query}" → intent-resolved: "${standaloneQuery}"`);
  } else if (isRetry && conversationContext._resolvedFor === query && typeof conversationContext._resolved === 'string') {
    // Reuse the query resolved on attempt 1. The rewrite/expansion runs at temperature
    // 0, so re-running it on every retry only re-pays the LLM round-trip (up to ~12s)
    // to produce the identical string. Intent classification is already skipped on
    // retries (isRetry), but getRetrievalQuery had no such guard.
    standaloneQuery = conversationContext._resolved;
    if (DEBUG) console.log(`Query: "${query}" → retrieval (cached from attempt 1): "${standaloneQuery}"`);
  } else if (bailIfAborted()) {
    return abortedResult();
  } else {
    const r = await getRetrievalQuery(conversationContext, query, idx);
    standaloneQuery = r.standaloneQuery;
    conversationContext._resolvedFor = query;
    conversationContext._resolved    = standaloneQuery;
    if (DEBUG) console.log(`Query: "${query}" → retrieval: "${standaloneQuery}"`);
  }

  const isFirstQuery = conversationContext.history.length === 0;

  // Comparison intent — from the classifier when available, else the regex heuristic. A two-sided RELATIONAL
  // question ("how does A relate to B?", "connect A with B") wants the same balanced, both-sides retrieval, so it
  // is folded in here regardless of the classifier's label: a connective cue plus two named subjects is a
  // reliable signal the classifier can miss. These want balanced passages from MULTIPLE documents rather than one
  // dominant source, so we widen the doc cap and relax the single-doc filters below.
  const isComparison = (intent ? (intent.intent === 'compare') : COMPARISON_INTENT_RE.test(query))
    || isConnectiveTwoSided(query);
  const topDocsCount = isComparison ? 3 : 2;
  const finalTopDocs = topDocsCount;
  if (isComparison && DEBUG) console.log('  ⚖️  Comparison intent — assembling multiple documents for cross-comparison');

  // New-topic signal, computed early so it gates the allowed-doc injection (5a-i)
  // and topic-shift detection (6). When the intent classifier ran, its verdict is
  // authoritative; otherwise fall back to the heuristic signals (high-IDF terms /
  // proper nouns / request-word filtering) that the system used before.
  const focusMode          = selectedDocIds && selectedDocIds.length > 0;
  const querySpecificTerms = extractSpecificKeywords(query, 5, idx.corpusIdf);
  const topicShiftTerms    = querySpecificTerms.filter(t => !REQUEST_WORDS.has(t));

  // Intent-driven flags (authoritative when a classification exists):
  //  - continue / reference → stay on the conversation document(s)
  //  - new_topic            → a genuine subject change, allow topic shift
  const intentSaysContinueRaw = intent && (intent.intent === 'continue' || intent.intent === 'reference');
  const intentSaysNewTopic = intent && intent.intent === 'new_topic';

  // Guard: a "reference"/"continue" verdict must actually be grounded in the
  // conversation document(s). The classifier sometimes labels a question that names
  // a NEW subject as a reference (e.g. asking about a different document entirely
  // while the conversation was on a medical PDF), which would wrongly pin the stale
  // doc at the front and filter out the correctly-retrieved new document. If the
  // resolved query carries distinctive content terms and NONE of them appear in any
  // allowed doc's filename or content, this is not a real continuation — treat it as
  // a normal query so retrieval can route to the right document.
  let intentSaysContinue = intentSaysContinueRaw;
  // A 'continue' OR 'reference' verdict is re-checked here: does the resolved query actually touch the
  // conversation's own documents? A TRUE reference ("does it mention X?", "what does this have to do with X?")
  // keeps the CURRENT subject in its resolved query — the classifier builds "<current subject> + X" — so it
  // stays grounded in the anchor and remains anchored. That is what keeps the correct answer "they don't
  // mention X" instead of a switch to some document that merely contains X. But the classifier sometimes
  // MISLABELS a genuine new subject as a reference (or as a vague continuation): "What happened in the chess
  // game?" comes back as reference "chess game", whose resolved query touches NONE of the conversation's
  // documents. That is really a new topic, so route it as a new query (and, below, reset the stale context)
  // rather than pinning the wrong document. Grounding in ANY anchored doc is enough to stay (a true reference
  // keeps the subject, so it clears this easily); touching none is the unambiguous "the subject moved" signal.
  if (intent && (intent.intent === 'continue' || intent.intent === 'reference') && conversationContext.allowedDocIds?.length > 0) {
    const resolved = (intent.resolvedQuery || query);
    const resolvedTerms = extractSpecificKeywords(resolved, 6, idx.corpusIdf).filter(t => !REQUEST_WORDS.has(t));
    if (resolvedTerms.length > 0) {
      const grounded = conversationContext.allowedDocIds.some(id => {
        const entry = idx.parentMap.get(id);
        if (!entry) return false;
        const name = (entry.metadata?.source ? require('path').basename(entry.metadata.source) : '').toLowerCase();
        // Scan the WHOLE anchor document, not just its head. A reference term can sit deep in a long document,
        // and truncating the scan would falsely judge a genuine follow-up "ungrounded" and shift away from the
        // right document. A case-insensitive regex .test() scans in place — no multi-MB lowercase copy, so this
        // stays OOM-safe on a large document — and each term is escaped to a literal, so there is no ReDoS risk.
        // (This can only let a term that is genuinely IN the anchor count; a truly absent term still shifts.)
        const content = entry.content || '';
        return resolvedTerms.some(t => {
          if (name.includes(t)) return true;
          try { return new RegExp(escapeRegExp(t), 'i').test(content); } catch { return false; }
        });
      });
      if (!grounded) {
        intentSaysContinue = false;
        if (DEBUG) console.log(`  🧭 Follow-up rejected — resolved query term(s) [${resolvedTerms.join(', ')}] not in conversation doc(s); routing as new query`);
        trace.step('continuation-rejected',
          `This looked like a follow-up, but "${resolvedTerms.join(', ')}" doesn't appear in the document we'd been discussing — treated as a new question instead.`);
        // The classifier's target docs for a rejected continuation are the stale
        // conversation document(s) it wrongly wanted to stay on. Drop any target that
        // is a current conversation doc so target-promotion doesn't re-pin it at the
        // top and filter out the correctly-retrieved new document.
        if (intentTargetIds) {
          const allowed = new Set(conversationContext.allowedDocIds);
          const kept = intentTargetIds.filter(id => !allowed.has(id));
          if (kept.length !== intentTargetIds.length) {
            if (DEBUG) console.log(`  🧭 Dropped stale conversation target doc(s) after continuation rejection`);
            intentTargetIds = kept.length ? kept : null;
          }
        }
      }
    }
  }

  // An ungrounded positional reference ("what about the second one?") — a reference whose text is just an
  // ordinal with no subject, which the classifier couldn't tie to any conversation document (no target docs).
  // Searching for the literal words finds nothing and the pipeline would offer a nonsensical web search; ask
  // which one they mean instead. Independent of the continuation guard above (a reference is no longer re-checked
  // there), so it still fires: the signal is a bare positional phrase the classifier left with no target.
  if (intentSaysContinueRaw && POSITIONAL_REFERENCE_RE.test(query.trim()) && (!intentTargetIds || intentTargetIds.length === 0)) {
    const clar = handleClarify(
      "I'm not sure which one you mean — there isn't a list in view to number from. " +
      "Could you name the document or topic you'd like me to look at?");
    if (clar) {
      if (DEBUG) console.log('  ❓ Ungrounded positional reference — asking for clarification');
      return clar;
    }
  }

  const queryIsSpecific = intent
    ? (intentSaysNewTopic || isComparison || (intentSaysContinueRaw && !intentSaysContinue))
    : (topicShiftTerms.length > 0 || hasProperNoun(query));

  // A continuation follow-up (no new-topic signal) always stays on the conversation
  // document — never topic-shifts, never goes empty. `let`, not `const`: the retrieval-signal
  // safety net below can clear it when the current question clearly moved to a new document the
  // classifier mislabeled as a continuation (otherwise the conversation doc gets pinned over the
  // correct one).
  let isContinuation = intent
    ? (!focusMode && !isFirstQuery && intentSaysContinue && (conversationContext.allowedDocIds?.length > 0))
    : (!focusMode && !isFirstQuery && !queryIsSpecific && (conversationContext.allowedDocIds?.length > 0));

  // One-off attachments: the user attached a file for THIS question. Answer directly
  // from the attachment text (bypassing the relevance gate and corpus retrieval —
  // the attachment IS the intended source, and it isn't in the index). If the
  // attachment is very large, cap what we inject so it can't overflow the context.
  if (attachments.length > 0) {
    const ATTACH_MAX_CHARS = WHOLE_INJECT_MAX_CHARS;
    // Split the budget across attachments so several files share the window fairly.
    const perAttachBudget = Math.floor(ATTACH_MAX_CHARS / attachments.length);
    const parts = [];
    let anyRetrieved = false;
    for (const a of attachments) {
      if (a.text.length <= perAttachBudget) {
        // Small enough — inject whole.
        parts.push(`[${a.name || 'attachment'}]\n${a.text}`);
      } else {
        // Too big to inject whole — retrieve the passages relevant to the question so
        // an answer about any part of the file works, not just the head.
        const r = await ephemeralRetrieve(a.text, query, perAttachBudget);
        anyRetrieved = anyRetrieved || r.retrieved;
        const label = r.retrieved
          ? `[${a.name || 'attachment'} — most relevant excerpts of a large file]`
          : `[${a.name || 'attachment'} — first part of a large file]`;
        parts.push(`${label}\n${r.text}`);
        if (DEBUG) console.log(`  📎 Large attachment "${a.name}": ${r.retrieved ? `retrieved ${r.kept}/${r.chunks} relevant chunks` : 'head slice (retrieval unavailable)'}`);
      }
    }
    const attachContext = parts.join('\n\n');
    if (DEBUG) console.log(`  📎 Attachment answer: ${attachments.length} file(s), ${attachContext.length} chars injected`);
    trace.step('attachment', `Answered from ${attachments.length} attached file(s) provided for this message${anyRetrieved ? ' (large files: only the most relevant excerpts were used)' : ''}.`);
    // Thread the abort signal + shared truncation flag so a New/disconnect cancels the provider promptly and a
    // mid-stream stall surfaces the truncation notice instead of silently returning a partial answer.
    const genOpts = options.signal ? { signal: options.signal } : {};
    async function* attachStream() {
      // When we could only use part of a large file, tell the model so it can caveat
      // its answer rather than implying it read the whole thing.
      const note = anyRetrieved
        ? '\n\n[Note: one or more attached files were large, so only the excerpts most relevant to the question are included above. If the answer may lie elsewhere in the file, say so.]'
        : '';
      const messages = buildMessages(
        attachContext + note, conversationContext.history, query,
        conversationContext.summary || '', { persona: workspacePersona });
      yield* streamChat(messages, genOpts);
    }
    // Answering from an attachment is a definitive single-pass response — it must NOT
    // go through the retry/failure-detection loop (which could false-flag a valid
    // answer as "no info" and retry, or confuse the conversation topic). `handled`
    // tells socket.js to accept the stream as-is. We deliberately do NOT set
    // allowedDocIds here — the attachment isn't an indexed document, so leaving the
    // conversation's document focus untouched keeps the NEXT turn coherent.
    return {
      stream: attachStream(), genOpts, outOfScope: false, handled: true,
      sources: attachments.map(a => ({ source: a.name || 'attachment', fileType: 'ATTACHMENT', attachment: true })),
      trace: trace.toJSON(),
    };
  }

  // 2. FAISS search — unions every embedding bank (or the single store when banks are
  // off) and returns [doc, cosine] best-first.
  if (bailIfAborted()) return abortedResult();
  stage('Searching your documents…');
  let faissResults = await denseSearch(idx, standaloneQuery, FAISS_CANDIDATES);

  // Best cosine of the user's ACTUAL query against the corpus, captured BEFORE any recall
  // augmentation. The relevance gate and the corrective trigger below must use this, not a value
  // taken after fusion: HyDE's probe list scores similarity to a fabricated answer passage and the
  // entity-bridge list scores similarity to a bag of entity names — neither is similarity to the
  // user's query, so folding them in would inflate the score and let a genuinely out-of-corpus
  // query clear the gate (and suppress corrective retrieval) whenever HyDE/entity-graph is on.
  let topCosine = faissResults.reduce((m, r) => (r && typeof r[1] === 'number' && r[1] > m ? r[1] : m), 0);

  // The top dense (embedding) match's parent id — used just below to decide cross-lingual mode. faissResults is
  // ranked by cosine, so [0] is the strongest semantic match.
  const topDenseMeta = faissResults[0] && faissResults[0][0] && faissResults[0][0].metadata;
  const topDenseParentId = topDenseMeta && (topDenseMeta.parentId || topDenseMeta.docId);
  // A STRONG semantic match: the embedding is confident well ABOVE the bare relevance floor. This is the single
  // bar for trusting the embedding over keyword-PRESENCE signals that are blind across languages — the novel-
  // entity gate (a query term absent from the corpus TEXT) and cross-lingual mode both key off it, so they can
  // never disagree on what "strong" means. An out-of-corpus question stays below this bar (its cosine is low),
  // so these exemptions never let a genuinely unknown subject through — verified by the honesty eval cases.
  const strongDenseMatch = Number.isFinite(topCosine)
    && topCosine >= require('../config').MIN_COSINE_SCORE * SEMANTIC_MATCH_MULT;
  // Set once the BM25 results are in (just below): whether the pipeline is in CROSS-LINGUAL mode.
  let crossLingualMode = false;

  // 2b. Dense-recall augmentation (opt-in): RAG-Fusion and/or HyDE. Both widen dense recall
  // by running EXTRA dense searches and fusing their candidate lists with the original via
  // reciprocal rank fusion, so a passage the bare question vector missed is still available
  // to the reranker. RAG-Fusion probes with alternative PHRASINGS of the question; HyDE
  // probes with a hypothetical ANSWER passage (closer to how documents are worded). Both are
  // skipped on retries, focus mode, and attachment answers (not corpus-recall problems), are
  // best-effort (a failure leaves the original results untouched), and — when adaptive
  // routing is on — run only for an involved question so a simple lookup stays fast.
  // Set when the entity graph matched two or more of the CORPUS's own entities in the query —
  // a relationship question about the corpus, which the raw-query relevance gate can otherwise
  // reject for low single-document similarity. Used below to treat such a question as on-topic.
  let entityBridged = false;
  // Set when the query names even ONE of the corpus's own graph entities (e.g. the user clicked it in the
  // mind-map). One entity isn't enough to bridge (that needs two), but it proves the question is about
  // something the documents contain, so the relevance gate must not decline it as out-of-corpus.
  let namesCorpusEntity = false;
  let namedEntity = null;         // the single graph entity the query names, if any — used to tell the model the subject IS present
  let bridgeDocIds = new Set();   // docs carrying the query's entities/bridges — exempt from co-source keyword gates
  if (bailIfAborted()) return abortedResult();
  if ((useRagFusion || useHyde || useEntityGraph || useGraphRag) && !isRetry && !focusMode && !hasAttachment) {
    const extraLists = [];
    const notes = [];
    // Adaptive routing only governs the LLM-backed probes (RAG-Fusion, HyDE): those cost an
    // auxiliary model call, so a simple lookup skips them. The entity-graph bridge is not gated
    // by it — the graph is a cached, pure-JS lookup with no model call, and a relationship
    // question is often phrased simply and in lowercase ("how does acme relate to globex"),
    // which adaptive routing rates as simple. Gating the bridge on that rating silently
    // defeated it for exactly the questions it exists to answer.
    const complexity = useAdaptiveRetrieval ? assessComplexity(standaloneQuery) : null;
    const runAugment = !complexity || complexity.level === 'complex';
    if (complexity && !runAugment && DEBUG) {
      console.log('  🔀 LLM-backed augmentation skipped by adaptive routing — query rated simple');
    }
    // Entity graph — bridge entities that connect the query's named entities. Always runs.
    if (useEntityGraph) {
      try {
        const bridge = await require('./entitygraph').bridgeQuery(standaloneQuery, idx);
        if (bridge) {
          entityBridged = true;   // the question names 2+ of the corpus's own entities → on-topic
          bridgeDocIds = new Set(bridge.docIds || []);
          const list = await denseSearch(idx, bridge.query, FAISS_CANDIDATES).catch(() => []);
          if (list.length > 0) { extraLists.push(list); notes.push('related entities'); }
        }
      } catch (e) {
        if (DEBUG) console.log(`  🕸️  Entity graph skipped (${e.message})`);
      }
    }
    // Knowledge graph (LLM-extracted, opt-in) — a richer typed-relationship bridge over the same query
    // entities. It self-gates on the useGraphRag toggle and returns null when off or when the question
    // names fewer than two known entities, so it stays out of the way of ordinary questions. It runs
    // alongside the co-occurrence graph and merges its connecting documents into the same gate exemption.
    if (useGraphRag) {
      try {
        const kg = await require('./graphrag').bridge(standaloneQuery, idx);
        if (kg) {
          entityBridged = true;
          for (const d of (kg.docIds || [])) bridgeDocIds.add(d);
          const list = await denseSearch(idx, kg.query, FAISS_CANDIDATES).catch(() => []);
          if (list.length > 0) { extraLists.push(list); notes.push('knowledge graph'); }
        }
      } catch (e) {
        if (DEBUG) console.log(`  🕸️  Knowledge graph skipped (${e.message})`);
      }
    }
    // A SINGLE named entity (e.g. an entity clicked in the mind-map). Not enough to BRIDGE (that needs two),
    // but the entity's own document must still be retrieved: the raw "tell me about X" question often ranks it
    // low or off the list (its "tell me about" noise plus a lone rare token). Probe with the entity's name +
    // the model's short description (far better recall) and force-exempt the documents the entity was extracted
    // from, so "tell me about X" reliably surfaces the passages that actually mention X. Only when no
    // multi-entity bridge already fired. Pure graph lookup + one dense search; never removes context.
    if (useGraphRag && !entityBridged) {
      try {
        const probe = await require('./graphrag').entityProbe(standaloneQuery, idx);
        if (probe) {
          namesCorpusEntity = true;
          namedEntity = probe.name || namedEntity;
          for (const d of (probe.docIds || [])) bridgeDocIds.add(d);
          const list = await denseSearch(idx, probe.query, FAISS_CANDIDATES).catch(() => []);
          if (list.length > 0) { extraLists.push(list); notes.push('a named entity'); }
        }
      } catch (e) { if (DEBUG) console.log(`  🕸️  Entity probe skipped (${e.message})`); }
    }
    if (runAugment) {
      // RAG-Fusion — alternative phrasings.
      if (useRagFusion) {
        try {
          const { expandQueries } = require('./multiquery');
          const variants = await expandQueries(standaloneQuery, ragFusionQueries, { model: ragFusionModel });
          if (variants.length > 0) {
            const lists = await Promise.all(
              variants.map(v => denseSearch(idx, v, FAISS_CANDIDATES).catch(() => []))
            );
            extraLists.push(...lists);
            notes.push(`${variants.length} alternative phrasing(s)`);
          }
        } catch (e) {
          if (DEBUG) console.log(`  🔀 RAG-Fusion skipped (${e.message})`);
        }
      }
      // HyDE — a hypothetical answer passage.
      if (useHyde) {
        try {
          const { hypotheticalDoc } = require('./hyde');
          const hypo = await hypotheticalDoc(standaloneQuery, { model: hydeModel, maxTokens: hydeMaxTokens });
          if (hypo) {
            const list = await denseSearch(idx, hypo, FAISS_CANDIDATES).catch(() => []);
            if (list.length > 0) { extraLists.push(list); notes.push('a hypothetical answer'); }
          }
        } catch (e) {
          if (DEBUG) console.log(`  🧪 HyDE skipped (${e.message})`);
        }
      }
    }
    if (extraLists.length > 0) {
      const fused = fuseDenseLists([faissResults, ...extraLists]);
      if (fused.length > 0) {
        faissResults = fused.slice(0, FAISS_CANDIDATES);
        if (DEBUG) console.log(`  🔀 Dense-recall augmentation: fused ${extraLists.length + 1} candidate lists → ${faissResults.length} candidates`);
        trace.step('dense-augment', `Widened the search using ${notes.join(' and ')}, then merged the results.`);
      }
    }
  }

  // On-topic by a SINGLE named entity. The 2+-entity bridges above drive relationship recall and are skipped
  // on a retry; this cheap gate exemption must NOT be, or a retry could reject — as out-of-corpus — a question
  // attempt 1 answered. So it runs regardless of isRetry: "tell me about X" for a known X (e.g. an entity
  // clicked in the mind-map) stays on-topic across attempts. It only ever ADDS context, never removes it, and
  // is skipped when focus/attachment already supply context. getGraph is cached, so this is at most one cached
  // lookup plus an O(query-tokens) scan.
  if (!entityBridged && !namesCorpusEntity && !focusMode && !hasAttachment && (useGraphRag || useEntityGraph)) {
    try {
      const eg = require('./entitygraph');
      if (useGraphRag) {
        // On a retry (or when the augment section was skipped) the probe above didn't run; recover the named
        // entity here so the gate stays exempt and the model is still told the subject is present.
        const probe = await require('./graphrag').entityProbe(standaloneQuery, idx);
        if (probe) { namesCorpusEntity = true; namedEntity = probe.name || namedEntity; for (const d of (probe.docIds || [])) bridgeDocIds.add(d); }
      } else if (useEntityGraph) {
        const g = await eg.getGraph(idx);
        if (g && g.nodes && g.nodes.size && eg.matchQueryEntities(standaloneQuery, g).length >= 1) namesCorpusEntity = true;
      }
    } catch (e) { if (DEBUG) console.log(`  🕸️  Single-entity check skipped (${e.message})`); }
  }

  // (topCosine was captured from the real-query search above, before augmentation — see the note.)

  // Keyword (BM25) candidates, computed ONCE for this query. The relevance gate's keyword fast-path and the
  // main BM25 step (step 4) both need engine.search(standaloneQuery); sharing the one result avoids a second
  // synchronous scan of the corpus postings per query. Corrective retrieval below only widens the DENSE
  // results, so this keyword result stays valid through to step 4.
  let bm25Raw = null;
  if (idx.liveBM25?.engine) {
    try { bm25Raw = idx.liveBM25.engine.search(standaloneQuery, BM25_CANDIDATES) || []; }
    catch (err) { console.warn('BM25 search error:', err.message); bm25Raw = []; }
  }

  // 2e. Unknown named subject. Ordinary domain words can score well even when the question's actual
  // subject is absent ("launch code" matches, "Zephyria" does not). Decline before the statistical
  // gates so the score from the domain words cannot make an unknown subject look answerable. This runs
  // on a new subject raised mid-conversation too: a pronoun-only or positional follow-up carries no
  // name-like term and is therefore untouched, while "what about the Zephyria program?" is declined
  // instead of being answered from the previous document. Skipped whenever the user supplied context
  // deliberately (focus mode, an attachment, or a known entity bridge). A name that matches a document's
  // file name is treated as known by the gate itself, so a classifier's target document cannot hide a
  // different unknown subject in the same question.
  // Skipped under a strong cross-lingual dense match (only when that feature is on): this gate declines a query
  // whose named terms are absent from the corpus TEXT, but it reads presence by surface tokens, so a question in
  // another language than its document trips it — most sharply in a language that capitalizes common nouns (e.g.
  // German), where ordinary concept words ("Fresken", "Putzes") look like unknown named subjects. When the
  // embedding reports a STRONG match, the subject IS present (in another language), so the keyword-absence verdict
  // is wrong. An out-of-corpus question stays below the strong-match bar, so it is still declined here as before.
  if (!isRetry && !focusMode && !hasAttachment && !entityBridged && !namesCorpusEntity
      && !(useCrossLingual && strongDenseMatch)) {
    const unknown = novelEntityGate(query, idx, faissResults);
    if (unknown) {
      if (DEBUG) console.log(`🚫 Query rejected — unknown named subject: ${unknown.terms.join(', ')}`);
      trace.step('unknown-entity',
        'The question names a subject that does not appear in the documents, so there is no source to ground an answer.');
      async function* unknownEntityStream() { yield OUT_OF_SCOPE_MESSAGE; }
      return { stream: unknownEntityStream(), sources: [], outOfScope: true, canWebFallback: true, trace: trace.toJSON() };
    }
  }

  // 3. Relevance gate. Pass the cosine we already have so the gate doesn't re-embed and
  // re-search the same query just to recompute it, and the BM25 result we just computed so its keyword
  // fast-path reuses it rather than scanning again. Pass null — not the reduce seed 0 — for topCosine when
  // dense search produced nothing, so a transient embed outage degrades to keyword mode instead of refusing.
  let relevant = isQueryRelevant(idx, standaloneQuery, faissResults.length > 0 ? topCosine : null, bm25Raw);

  // 3a. Near-miss recall second-chance. The gate just failed, but there WERE candidate passages scored just
  // below the bar — the classic terminology mismatch, where the documents discuss the topic using a different
  // word than the question (a corpus that says "giants" for a question about "nephilim", or an org's own
  // wording for a concept the user phrased differently). Before declaring the corpus empty, improve the QUERY
  // once with a hypothetical-answer expansion (HyDE) and retrieve again, then re-check the gate. This RAISES
  // recall for a near-miss whose documents use different wording than the question. Trade-off, stated honestly:
  // the re-check measures the HyDE-expanded candidate set (a hypothetical ANSWER's similarity to the corpus),
  // which is the whole point of HyDE — a bare question vector that scored just under the bar can be rescued —
  // but it means a near-miss that is actually out-of-corpus yet SEMANTICALLY ADJACENT to the corpus can be
  // admitted. That residual is bounded: it only fires in the narrow near-miss band (0.6*MIN_COSINE..MIN_COSINE),
  // a truly unrelated topic's hypothetical answer still scores far below the bar, and the cross-encoder
  // off-topic abstention plus the faithfulness/grounding checks are downstream backstops. Band is corpus- and
  // model-relative (a fraction of MIN_COSINE_SCORE), only on a near-miss, only when always-on HyDE is OFF.
  // Gated on USE_RERANKER: the rescue admits a sub-bar near-miss to let the pipeline judge the HyDE-surfaced
  // candidates, and the cross-encoder off-topic abstention below is what actually validates them against the
  // REAL query (the research-backed mitigation for HyDE's false positives). Without the reranker there is no
  // precise signal to catch a tangential hypothetical match, so a near-miss stays declined (favor the honesty
  // wedge over recall) rather than be admitted on the HyDE-expanded cosine alone.
  if (!relevant && USE_RERANKER && !useHyde && !isRetry && !hasAttachment && !focusMode && faissResults.length > 0 && !bailIfAborted()) {
    const minCos = require('../config').MIN_COSINE_SCORE;
    const nearMiss = Number.isFinite(topCosine) && topCosine >= minCos * 0.6 && topCosine < minCos;
    if (nearMiss) {
      try {
        const { hypotheticalDoc } = require('./hyde');
        const hypo = await hypotheticalDoc(standaloneQuery, { model: hydeModel, maxTokens: hydeMaxTokens });
        if (hypo && !bailIfAborted()) {
          const more = await denseSearch(idx, hypo, FAISS_CANDIDATES).catch(() => []);
          if (more.length > 0) {
            faissResults = fuseDenseLists([faissResults, more]).slice(0, FAISS_CANDIDATES);
            // Use a LOCAL cosine for the rescue decision only. Do NOT overwrite the module-level topCosine:
            // it stays the real query's similarity, which the corrective-retrieval trigger below reads — an
            // inflated value there would wrongly suppress corrective retrieval.
            const rescueCosine = faissResults.reduce((m, r) => (r && typeof r[1] === 'number' && r[1] > m ? r[1] : m), 0);
            relevant = isQueryRelevant(idx, standaloneQuery, faissResults.length > 0 ? rescueCosine : null, bm25Raw);
            if (relevant) {
              trace.step('recall-expansion', 'The documents use different wording, so the question was re-expressed as a likely answer to surface the matching passages.');
              if (DEBUG) console.log(`  🔁 Near-miss recall: HyDE expansion cleared the gate (expanded cosine → ${rescueCosine.toFixed(3)}) — answering from documents`);
            }
          }
        }
      } catch (e) { if (DEBUG) console.log(`  🔁 Near-miss recall skipped (${e && e.message})`); }
    }
  }

  if (!relevant) {
    // Focus mode means the user explicitly hand-picked the document(s) to consult, so
    // a vague query like "what's this about?" should be answered FROM those docs, not
    // rejected as out-of-corpus — the selection is the context, even in a brand-new
    // conversation with no prior allowedDocIds yet.
    // A relationship question that names two or more of the corpus's OWN entities is on-topic
    // by construction (the entity graph matched them), so don't decline it for low single-doc
    // similarity — the bridge search above already pulled the connecting documents in.
    const hasContext = focusMode || entityBridged || namesCorpusEntity || conversationContext.allowedDocIds?.length > 0;
    if (!hasContext) {
      if (DEBUG) console.log('🚫 Query rejected — no meaningful match in corpus');
      async function* outOfScopeStream() {
        yield OUT_OF_SCOPE_MESSAGE;
      }
      return { stream: outOfScopeStream(), sources: [], outOfScope: true, canWebFallback: true, trace: trace.toJSON() };
    }
    if (DEBUG) console.log(focusMode
      ? '  🔍 Low relevance but focus mode active — answering from the selected document(s)'
      : '⚠️  Low relevance score but active conversation context — proceeding with topic search');
  }

  // 3b. Corrective retrieval (CRAG-style recover-gate, opt-in). The query matched, but only
  // weakly (top cosine below the confidence bar). Rephrase it once and retrieve again,
  // merging the new candidates in, so the downstream reranker can pick a better passage
  // than the mediocre one the first phrasing surfaced. Skipped on retries, focus mode, and
  // attachment answers (those aren't corpus-recall problems). Best-effort: a failed or
  // no-op rephrase leaves the original results untouched. Reuses topCosine computed above.
  if (useCorrectiveRetrieval && !isRetry && !focusMode && !hasAttachment
      && faissResults.length > 0 && topCosine < correctiveCosineMax && !bailIfAborted()) {
    try {
      const { correctiveQuery } = require('./corrective');
      const reformulated = await correctiveQuery(standaloneQuery);
      if (reformulated) {
        const more = await denseSearch(idx, reformulated, FAISS_CANDIDATES);
        // Count genuinely new chunks by their stable id (not text), then MERGE via the same
        // rank fusion the augmentation path uses — rather than a raw cosine re-sort, which
        // would throw away any RAG-Fusion ordering already in faissResults on exactly the
        // weak-match queries corrective retrieval is meant to help.
        const keyOf = ([d]) => (d.metadata && d.metadata.childId) || d.pageContent;
        const seen = new Set(faissResults.map(keyOf));
        let added = 0;
        for (const row of more) { if (!seen.has(keyOf(row))) { seen.add(keyOf(row)); added++; } }
        if (added > 0) {
          faissResults = fuseDenseLists([faissResults, more]).slice(0, FAISS_CANDIDATES);
          trace.step('corrective', `The first match was weak, so the query was rephrased ("${reformulated}") and searched again to find better passages.`);
        }
        if (DEBUG) console.log(`  🔧 Corrective retrieval (top cosine ${topCosine.toFixed(3)}): "${reformulated}" → +${added} candidate(s)`);
      }
    } catch (e) { if (DEBUG) console.log(`  🔧 Corrective retrieval skipped: ${e.message}`); }
  }

  // 4. BM25 search
  let bm25Results = [];
  let bm25AllResults = []; // unfiltered — used for second-doc gate score lookup
  let bm25DocIds = new Set();
  // Strength of the corpus keyword match for this query: top BM25 score / corpus
  // median. Exposed in the result so the caller (socket.js) can decide whether a
  // failed answer reflects a genuine corpus gap (weak) — and thus whether to offer
  // a web search — rather than a retrievable answer the model just fumbled (strong).
  let bm25Strength = null;
  // Best cross-encoder score across reranked chunks (null if reranker disabled/unused).
  // A strongly negative top score means no retrieved document genuinely matches — the
  // signal socket.js uses to gate the web-search auto-suggest. Computed AFTER assembly
  // from `rerankByParent`, scoped to the documents actually used (not every candidate).
  let topRerankerScore = null;
  // Best cross-encoder score per parent document, over its candidate chunks. Used to
  // (a) scope topRerankerScore to the used documents, and (b) let a genuinely-strong
  // semantic match survive the keyword (BM25) co-source gates below even with no
  // keyword overlap — the case pure-vector retrieval exists to catch (paraphrases,
  // synonyms). Empty on retries (reranker is skipped there), preserving prior behavior.
  const rerankByParent = new Map();
  if (idx.liveBM25?.engine && bm25Raw != null) {
    try {
      // Reuse the single engine.search(standaloneQuery) from step 3 — no second corpus scan.
      bm25AllResults = bm25Raw
        .map(([numId, score]) => [idx.liveBM25.idToDocId.get(Number(numId)), score])
        .filter(([docId]) => docId != null);

      bm25DocIds = new Set(bm25AllResults.map(([docId]) => docId));

      const topBm25Score = bm25AllResults.length > 0 ? bm25AllResults[0][1] : 0;
      bm25Results = bm25AllResults.filter(([, score]) => score >= topBm25Score * 0.40);

      if (DEBUG) {
        console.log(`BM25 presence: ${bm25DocIds.size} docs have keyword overlap`);
        if (bm25Results.length > 0) {
          console.log(`BM25 ranked (after filter): ${bm25Results.slice(0, 3).map(([id, s]) =>
            `${s.toFixed(3)} ${path.basename(idx.parentMap.get(id)?.metadata?.source || id)}`).join(', ')}`);
        }
      }
    } catch (err) {
      console.warn('BM25 mapping error:', err.message);
    }
  }

  // Cross-lingual retrieval signature (language-agnostic, no model call): the STRONGEST embedding match has
  // little or no keyword support. A question in a different language than its matching document shares no words
  // with it (BM25 ≈ 0 for that document), even when BM25 matches a WRONG same-script document on an incidental
  // token — exactly the case the keyword gates and rank fusion below mishandle. When this fires, the pipeline
  // trusts the multilingual embedding instead and bypasses EVERY signal that is itself cross-lingual-weak (each
  // is a keyword/surface-token test that a cross-language match cannot satisfy):
  //   • the novel-entity gate (above) — query terms absent from the corpus TEXT;
  //   • rank fusion — ranks dense-only, dropping BM25;
  //   • the BM25 median relevance gate and the per-document keyword/co-source gates;
  //   • the BM25-dominant promotion and the topic-shift winner promotion (both lift a keyword match to the top);
  //   • the cross-encoder document REORDER and off-topic ABSTENTION (an English-trained reranker under-scores a
  //     genuine match in another language the same way BM25 does), and the confidence chip / citation dot that
  //     read that cross-encoder score (see the result below and lib/confidence.js).
  // Gated on a STRONG dense match (the cosine relevance floor still rejects an out-of-corpus question — verified
  // by the multilingual eval's off-corpus honesty cases) and the useCrossLingual flag, so same-language retrieval
  // — where the top match DOES carry keyword overlap — is unchanged. A same-language paraphrase that happens to
  // share no words is correctly handled the same way: trust the embedding.
  // Weak-keyword signal, computed ONCE here and shared by the cross-lingual trust test (just below) and the BM25
  // median relevance gate (step 4b), so the gate and the condition that BYPASSES it can never disagree. "Weak"
  // means the best BM25 score for this query sits below the corpus median — the keyword search found nothing
  // strong. Null-safe when BM25 isn't functional (a 1-2 doc corpus where wink-bm25 won't build): the median is 0,
  // so there is simply no keyword verdict and the gate below is skipped too.
  const bm25Median = Number(idx.liveBM25?.medianScore) || 0;
  const queryTopBm25 = bm25AllResults.length > 0 ? bm25AllResults[0][1] : 0;
  const keywordSearchWeak = bm25Median > 0 && queryTopBm25 < bm25Median;

  if (useCrossLingual && topDenseParentId && strongDenseMatch) {
    // Fire when the DENSE top document's OWN keyword support is weak (its BM25 below the corpus median) while the
    // embedding is strongly confident. It must be the dense document's score, not the query's top BM25: for a
    // cross-lingual query the correct document is in another language and carries no (or only incidental cognate)
    // keyword score, yet a WRONG same-language document can be the query's strongest BM25 hit — so a query-level
    // test would miss exactly these cases. Below-median (not below-half-median) is deliberate: a question in a
    // language that shares cognates with its document (e.g. German → Italian) gives the correct document a small
    // but non-zero BM25, which a half-median bar would wrongly treat as real keyword support. The absolute cosine
    // bar above is what keeps an out-of-corpus question out (verified by the multilingual eval's honesty cases),
    // so widening this keyword test costs no honesty. No median (BM25 not functional) → require a zero keyword hit.
    const topDenseBm25 = bm25AllResults.find(([id]) => id === topDenseParentId)?.[1] ?? 0;
    crossLingualMode = bm25Median > 0 ? topDenseBm25 < bm25Median : topDenseBm25 === 0;
    if (crossLingualMode && DEBUG) console.log(`  🌐 Cross-lingual: strong embedding match (cos ${topCosine.toFixed(3)}) with weak keyword support (top-doc BM25 ${topDenseBm25.toFixed(2)} vs median ${bm25Median.toFixed(2)}) — trusting the embedding`);
  }

  // 4b. BM25 relevance gate — if the top BM25 score is below the corpus median,
  // the query has no strong keyword match. Two tiers:
  //   - well below median (< 50%): hard out-of-scope (genuinely nothing relevant)
  //   - in the soft band (50-100% of median): offer what the closest document DOES
  //     cover instead of a flat refusal — more honest and natural than "outside what
  //     I can help with" when there's a partial match. (usePartialMatchTier)
  //
  // BUT: skip this gate entirely when the BM25 engine couldn't consolidate. wink-bm25
  // refuses to build on a very small collection (1-2 docs), returning empty:true with
  // a null engine. In that state every query scores 0.00 — not because it's
  // irrelevant, but because BM25 isn't functioning. Gating on that false 0.00 would
  // reject every query against a freshly-ingested single document (the common case
  // right after adding one URL/file). The cosine relevance gate above still applies,
  // so an off-topic query is still caught; we're only declining to let a
  // non-functional BM25 veto an otherwise-relevant match.
  const bm25Usable = bm25Median > 0 && !idx.liveBM25.empty && idx.liveBM25.engine;
  if (bm25Usable) {
    const median  = bm25Median;      // shared weak-keyword inputs, computed once above (step 4a)
    const topBm25 = queryTopBm25;
    bm25Strength = median > 0 ? topBm25 / median : null;
    // Same context exemptions as the cosine gate above: focus mode, an active conversation
    // document, or a question that names the corpus's own entities (entity graph) is on-topic
    // and must not be hard-rejected here for a low keyword score.
    //
    // BUT a query that is about to SHIFT AWAY from the conversation document — a new_topic, or a
    // continue/reference the grounding guard rejected as off the current docs — must not borrow that
    // document's exemption: its anchor is irrelevant to the new subject and is reset below (step 6,
    // intentDrivenShift). Without this, a genuinely off-topic new question asked mid-conversation
    // ("Can pigs fly?") skips this gate on the stale anchor and gets answered from whatever document a
    // tangential keyword happens to match — the exact non-sequitur the same question is correctly declined
    // for when asked fresh. A legitimate switch to a real document is unaffected: it clears the gate on its
    // own strong keyword match (topBm25 ≥ median), and an entity/focus exemption still applies. Mirrors the
    // intentDrivenShift test used at the reset site, so the gate and the reset agree on what a shift is.
    const willShiftAway = intentSaysNewTopic || (intentSaysContinueRaw && !intentSaysContinue);
    const hasContext = focusMode || entityBridged || namesCorpusEntity ||
      (!willShiftAway && conversationContext.allowedDocIds?.length > 0);
    if (!hasContext && !crossLingualMode && keywordSearchWeak) {
      const hardFloor = median * 0.5;
      if (usePartialMatchTier && topBm25 >= hardFloor && bm25AllResults.length > 0) {
        // Soft partial match — hand the closest document to the LLM with an
        // instruction to answer what it can and be candid about the gap.
        const closestId = bm25AllResults[0][0];
        const entry = idx.parentMap.get(closestId);
        if (entry) {
          if (DEBUG) console.log(`  ≈ Partial match — closest doc ${path.basename(entry.metadata.source)} (BM25 ${topBm25.toFixed(2)} vs median ${median.toFixed(2)})`);
          const snippet = entry.content.slice(0, passageSize());
          // Thread the abort signal and the shared truncation flag, exactly like the main documentStream, so a
          // New/disconnect cancels the provider promptly and a mid-stream stall is surfaced to the caller —
          // otherwise a truncated partial answer shows no notice and can be cached as if it were complete.
          const genOpts = options.signal ? { signal: options.signal } : {};
          async function* partialStream() {
            const messages = buildMessages(
              `[${path.basename(entry.metadata.source)}]\n${snippet}`,
              conversationContext.history, query, conversationContext.summary || '',
              { isPartial: true, persona: workspacePersona });
            yield* streamChat(messages, genOpts);
          }
          conversationContext.allowedDocIds = [closestId];
          return {
            stream: partialStream(), genOpts, outOfScope: false, partial: true,
            sources: [{
              id: closestId, source: path.basename(entry.metadata.source),
              fileType: entry.metadata.fileType,
              viewerLink: viewerLink(entry.metadata.source),
              passageStart: 0, passageEnd: Math.min(snippet.length, entry.content.length),
              docLength: entry.metadata.docLength ?? 0,
              snippet: makeSnippet(snippet),
              ...(entry.metadata.credibility ? { credibility: entry.metadata.credibility } : {}),
            }],
          };
        }
      }
      if (DEBUG) console.log(`🚫 Query rejected — top BM25 score ${topBm25.toFixed(2)} below median ${median.toFixed(2)}`);
      trace.step('no-match',
        `No document matched strongly enough. The best keyword score was ${topBm25.toFixed(1)}, below the ${median.toFixed(1)} this corpus normally produces for a real match.`);
      async function* outOfScopeStream() {
        yield OUT_OF_SCOPE_MESSAGE;
      }
      return { stream: outOfScopeStream(), sources: [], outOfScope: true, canWebFallback: true, trace: trace.toJSON() };
    }
  }

  // 5. Deduplicate FAISS by parent
  const seenFaissParents = new Set();
  const faissDeduped = [];
  // Each parent's best dense cosine, captured while deduping (faissResults is best-first, so the first row seen
  // for a parent is its strongest chunk). Used by the cross-lingual co-source strength gate below: in
  // cross-lingual mode the keyword co-source gates are bypassed and the fused scores are flat, so a co-source is
  // admitted only when its OWN embedding match is strong — the single signal cross-lingual mode trusts.
  const parentTopCosine = new Map();
  for (const result of faissResults) {
    if (!result[0] || !result[0].metadata) continue;   // skip a malformed candidate row rather than throw out of the query (parity with the rrf.js guard)
    const parentId = result[0].metadata.parentId || result[0].metadata.docId;
    if (!parentId) continue;
    if (!parentTopCosine.has(parentId) && typeof result[1] === 'number') parentTopCosine.set(parentId, result[1]);
    if (seenFaissParents.has(parentId)) continue;
    seenFaissParents.add(parentId);
    faissDeduped.push(result);
  }

  // 5a. RRF
  // Cross-lingual: rank dense-only. BM25 scores a cross-lingual query against the wrong documents (incidental
  // shared tokens) and, fused in, outranks the correct dense match; the multilingual embedding already ranks the
  // right document first, so trust it alone here.
  let fusedRanking = reciprocalRankFusion(faissDeduped, crossLingualMode ? [] : bm25Results);

  // 5a-(-1). Outcome-based down-weighting. When passed a downweight map (docId →
  // penalty), gently lower the fused score of documents that led to 👎 answers on
  // queries similar to this one. Conservative by construction: the penalty is a
  // small fraction of the score and can only REORDER within the candidate set — it
  // never removes a document (no gate), so a wrongly-penalized doc still surfaces if
  // nothing better exists. The caller (socket.js) only supplies this map when there's
  // enough rating signal to trust; search.js just applies what it's given.
  const downweight = options.downweight instanceof Map ? options.downweight : null;
  // The per-document penalty factor (in [0, 0.15]), computed once here and reused by the reranker reorder below
  // so the down-weight survives that reorder instead of being erased by it. null when there is no signal.
  let downweightFactor = null;
  if (downweight && downweight.size > 0 && fusedRanking.length > 0) {
    downweightFactor = new Map();
    for (const [id, penalty] of downweight) {
      // Scale the penalty to at most ~15%, proportional to accumulated similarity-weighted 👎 evidence
      // (capped so one bad outcome can't bury a doc).
      if (penalty) downweightFactor.set(id, Math.min(0.15, penalty * 0.05));
    }
    fusedRanking = fusedRanking.map(([id, s]) => {
      const factor = downweightFactor.get(id);
      return factor ? [id, s * (1 - factor)] : [id, s];
    }).sort((a, b) => b[1] - a[1]);
    if (DEBUG) {
      const affected = [...downweight.keys()].map(id => path.basename(idx.parentMap.get(id)?.metadata?.source || id));
      console.log(`  📉 Outcome down-weight applied to: ${affected.join(', ')}`);
    }
  }

  // Capture the genuine top fused score now — after RRF and the small outcome down-weight, but BEFORE the
  // artificial +0.05 promotions below. The relative co-source filter (see topRrfScore, used far below) must
  // measure against THIS, not a promoted score: a flat +0.05 boost is roughly three times the entire natural
  // RRF range (the maximum natural fused score is about 1/(k+1)), so using a boosted maximum as the reference
  // would lift the "within X% of the top" bar above every genuine co-source and silently drop it. (The
  // post-topic-shift path already sidesteps this with a score swap rather than a boost.)
  const naturalTopRrfScore = fusedRanking.length > 0 ? fusedRanking[0][1] : 0;

  // 5a-0(-1). Validate classifier-named targets before force-promoting them. A weak
  // local classifier sometimes names documents unrelated to the resolved query — e.g.
  // naming two screenshot PNGs as the target for "install the software". Force-promoting
  // a hallucinated target buries the genuinely relevant document. Keep a target only if
  // it has real support: it appears in the fused candidate ranking, OR its filename
  // shares a distinctive term with the resolved query. Genuine targets satisfy one of
  // these; hallucinated ones satisfy neither and are dropped (retrieval then stands on
  // its own FAISS/BM25/reranker ranking, which is what rescued that case anyway).
  if (intentTargetIds && intentTargetIds.length > 0) {
    const rankedSet = new Set(fusedRanking.map(([id]) => id));
    const resolvedTerms = extractSpecificKeywords(standaloneQuery, 6, idx.corpusIdf)
      .filter(t => !REQUEST_WORDS.has(t));
    const validated = intentTargetIds.filter(id => {
      if (rankedSet.has(id)) return true;
      const src = idx.parentMap.get(id)?.metadata?.source || '';
      const nameToks = new Set(tokenize(path.basename(src).toLowerCase().replace(/[^a-z0-9]/g, ' ')));
      return resolvedTerms.some(t => nameToks.has(t));
    });
    if (validated.length !== intentTargetIds.length) {
      if (DEBUG) console.log(`  🎯 Dropped ${intentTargetIds.length - validated.length} unsupported intent target(s) — not in candidates and no query-term overlap`);
      intentTargetIds = validated.length ? validated : null;
    }
  }

  // 5a-0. Intent-targeted retrieval steering. When the classifier named specific
  // target documents (it read the whole thread and resolved the reference), make
  // sure those documents are present and ranked at the top — this is more reliable
  // than re-deriving the target from FAISS/BM25 on a resolved query. Skipped for
  // comparison (which wants natural multi-doc balance) so one target doesn't dominate.
  if (intentTargetIds && intentTargetIds.length > 0 && !isComparison) {
    const rankMap = new Map(fusedRanking.map(([id, s]) => [id, s]));
    const topScore = fusedRanking.length > 0 ? fusedRanking[0][1] : 0.02;
    intentTargetIds.forEach((tid, i) => {
      // Give each target a score just above the current top, preserving their order.
      rankMap.set(tid, topScore + 0.05 - i * 0.001);
    });
    fusedRanking = [...rankMap.entries()].sort((a, b) => b[1] - a[1]);
    if (DEBUG) console.log(`  🎯 Intent target docs promoted: ${intentTargetIds.map(id => path.basename(idx.parentMap.get(id)?.metadata?.source || id)).join(', ')}`);
  }

  // 5a-i. For vague continuation queries, ensure allowed docs appear in the ranking
  // even if FAISS and BM25 didn't rank them — "tell me more" won't match the
  // conversation document semantically, but it must still be served from it.
  if (isContinuation && conversationContext.allowedDocIds?.length > 0) {
    const alreadyRanked = new Set(fusedRanking.map(([id]) => id));
    const minScore = fusedRanking.length > 0 ? fusedRanking[fusedRanking.length - 1][1] : 0.01;
    for (const allowedId of conversationContext.allowedDocIds) {
      if (!alreadyRanked.has(allowedId)) {
        fusedRanking.push([allowedId, minScore]);
        if (DEBUG) console.log(`  📌 Injected conversation doc into ranking for continuation follow-up`);
      }
    }
  }

  // 5b. BM25-dominant rerank
  //
  // Skipped on a vague continuation ("tell me more", "go on"). Such a query has no
  // topic content of its own, so any BM25 "winner" is matching the continuation
  // phrase itself — e.g. "tell me more" scores high against a play that uses those
  // words in dialogue. Promoting that document hijacks the conversation away from the
  // document the user is actually reading, and because the promotion is written back
  // into allowedDocIds, each further "tell me more" drifts further until the original
  // document is dropped for having "no BM25 score" and the answer collapses. A vague
  // continuation must stay anchored to the conversation document, not chase keywords.
  const vagueContinuation = isContinuation && !queryIsSpecific;
  // Skipped in cross-lingual mode. This promotion lifts the strongest KEYWORD (BM25) match to the top, but a
  // cross-lingual query's only keyword hits are incidental matches on a WRONG same-language document (it shares
  // no words with its genuine cross-language answer). Promoting that here would override the dense-only ranking
  // that cross-lingual mode exists to trust, serving the same-language distractor instead of the correct
  // document — the exact failure seen for an "es → de" or "fr → zh" question. BM25 is noise for this query, so
  // no BM25-driven promotion runs.
  if (bm25Results.length >= 2 && !vagueContinuation && !crossLingualMode) {
    const bm25TopScore    = bm25Results[0][1];
    const bm25SecondScore = bm25Results[1][1];
    const bm25TopDocId    = bm25Results[0][0];
    const topRrf          = fusedRanking[0]?.[0];

    // Original trigger: the top keyword match dominates the field (>2x the runner-up).
    const dominatesField = bm25TopScore > bm25SecondScore * 2.0;

    // Additional trigger: the top keyword match isn't the RRF winner, yet it
    // outscores that winner on BM25. RRF can float a document to #1 on chunk
    // multiplicity (several passages each contributing a fusion term) even when a
    // different document is the single strongest keyword hit. When that strongest
    // hit then lands as doc #2, the second-document keyword gate can drop it, and
    // the answer that was actually in the corpus never reaches the model. Promoting
    // it to #1 makes it the primary document, which bypasses that gate. Guarded so
    // it only fires on a real BM25 lead over the RRF top, not a near-tie.
    let beatsRrfTopOnBm25 = false;
    if (!dominatesField && topRrf && topRrf !== bm25TopDocId) {
      // Look the RRF winner's BM25 score up in the UNFILTERED list: bm25Results is filtered to >=40% of the top
      // keyword score, so a semantic RRF winner with weak keyword overlap is absent from it and would read 0 —
      // making this gate fire almost unconditionally and demote the semantic winner. bm25AllResults has it.
      const rrfTopBm25 = bm25AllResults.find(([id]) => id === topRrf)?.[1] ?? 0;
      beatsRrfTopOnBm25 = bm25TopScore > rrfTopBm25 * 1.05;
    }

    if (dominatesField || beatsRrfTopOnBm25) {
      if (topRrf && topRrf !== bm25TopDocId) {
        const topRrfScore = fusedRanking[0][1];
        fusedRanking = fusedRanking.map(([id, score]) =>
          id === bm25TopDocId ? [id, topRrfScore + 0.05] : [id, score]
        ).sort((a, b) => b[1] - a[1]);
        if (DEBUG) console.log(`  🔝 BM25-dominant rerank: promoted ${path.basename(idx.parentMap.get(bm25TopDocId)?.metadata?.source || bm25TopDocId)} (BM25 ${bm25TopScore.toFixed(2)} vs runner-up ${bm25SecondScore.toFixed(2)}${beatsRrfTopOnBm25 ? '; leads RRF top on BM25' : ''})`);
      }
    }
  }

  if (DEBUG) {
    console.log('--- RRF RANKING ---');
    fusedRanking.slice(0, 5).forEach(([docId, score], i) => {
      const src = idx.parentMap.get(docId)?.metadata?.source || docId;
      console.log(`  ${i + 1}. ${score.toFixed(4)} ${path.basename(src)}`);
    });
  }

  // 6. Topic shift detection — skip entirely when user has manually selected docs
  // (queryIsSpecific / querySpecificTerms / focusMode computed above, before RRF)
  let topicShiftedThisQuery = false;

  // When the intent classifier ran, it decides shift vs stay directly:
  //  - continue / reference → never shift (stay on the conversation document)
  //  - new_topic            → shift, and steer to the intent's target document(s)
  //  - continue/reference REJECTED by the grounding guard → treat as a new topic:
  //    the classifier said "stay" but the query names a subject the conversation
  //    documents don't contain, so staying would pin the wrong document.
  // The heuristic BM25/RRF shift detection below only runs when there was no intent
  // classification (fallback path), preserving the previous behavior exactly.
  const intentDrivenShift = intentSaysNewTopic || (intentSaysContinueRaw && !intentSaysContinue);
  if (intentDrivenShift && !focusMode && !isFirstQuery && conversationContext.allowedDocIds?.length > 0) {
    if (DEBUG) console.log(`  🔀 Intent=${intentSaysNewTopic ? 'new_topic' : 'ungrounded ' + intent.intent} — resetting conversation context`);
    // Full reset (summary, consulted docs, passage maps too) — not just history/docs.
    // Leaving the previous topic's rolling summary in place made it bleed into the new
    // topic's answer for several turns.
    clearConversationState(conversationContext);
    topicShiftedThisQuery = true;
    // If the classifier named target docs, promote the first to the top so it wins.
    // (Ungrounded continuations have already had their stale targets dropped.)
    if (intentTargetIds && intentTargetIds.length > 0) {
      const winner = intentTargetIds[0];
      const topScore = fusedRanking[0]?.[1] ?? 0.02;
      fusedRanking = fusedRanking.map(([id, s]) => id === winner ? [id, topScore + 0.05] : [id, s])
        .sort((a, b) => b[1] - a[1]);
    }
  } else if (intent && intent.intent === 'continue' && intentSaysContinue && !focusMode && !isFirstQuery && (topicShiftTerms.length > 0 || hasProperNoun(query)) && conversationContext.allowedDocIds?.length > 0) {
    // Retrieval-signal safety net for the INTENT path. The classifier can mislabel a genuine topic
    // switch as "continue" (early in a thread the only context IS the prior topic, so a new question
    // looks like a follow-up), and — unlike the heuristic path below — there is otherwise NO fallback
    // on the intent path. The continuity boost and continuation pinning would then force the PREVIOUS
    // topic's document to the top, so the switched-to question answers "I don't have that information"
    // until it is asked a SECOND time (by which point the failed turn has cleared the pinned set). Trust
    // the retrieval: if BM25 strongly prefers a document OUTSIDE the conversation set (a strong
    // new-subject keyword signal) AND no allowed doc is near the top of the fused ranking, treat it as a
    // shift. Both signals are required (AND) to override an explicit classifier verdict, so a genuine
    // continuation — where the conversation doc stays near the top — is never falsely reset.
    //
    // GATE on the query carrying a specific new subject (a content term or a proper noun), exactly as the
    // heuristic path's raw-query shift does. A VAGUE continuation ("tell me more", "go on", "summarize")
    // has no such term, and its corpus-wide dense/BM25 retrieval scores high on unrelated documents on
    // common words — the more so with an embedding model whose similarities cluster high — so without this
    // gate a bare "tell me more" would be flipped into a topic switch and answered from an unrelated file.
    const allowedSet = new Set(conversationContext.allowedDocIds);
    const topRrfIds = fusedRanking.slice(0, topDocsCount).map(([id]) => id);
    const rrfTopInAllowed = topRrfIds.some(id => allowedSet.has(id));
    const bm25TopId = bm25Results.length > 0 ? bm25Results[0][0] : null;
    const bm25AllowedScore = bm25Results.find(([id]) => allowedSet.has(id))?.[1] ?? 0;
    const dynamicThreshold = (idx.liveBM25?.medianScore || 3.0) * 2.0;
    const bm25StronglyDisagrees = bm25TopId && !allowedSet.has(bm25TopId) &&
      bm25Results[0][1] >= dynamicThreshold &&
      bm25Results[0][1] > bm25AllowedScore * 1.3;
    if (!rrfTopInAllowed && bm25StronglyDisagrees) {
      if (DEBUG) console.log('  🔀 Intent said continue, but retrieval strongly prefers a new document — treating as a topic shift');
      trace.step('topic-shift',
        'The question moved to a different document than the one under discussion, so earlier context was set aside.');
      // Full reset (summary, consulted docs, passage maps) so the previous topic doesn't bleed in, and
      // clear isContinuation so the continuation pinning below cannot re-pin the stale document.
      clearConversationState(conversationContext);
      topicShiftedThisQuery = true;
      isContinuation = false;
    }
  }

  // Continuation follow-ups never reach here: queryIsSpecific is false for request-word
  // follow-ups ("give me an in-depth analysis", "elaborate on that") because REQUEST_WORDS
  // filtering empties topicShiftTerms, so they keep the conversation document.
  // Comparison queries also skip shift detection — they deliberately span multiple
  // documents, so a non-allowed doc appearing is expected, not a topic change.
  // Intent-driven runs skip the heuristic block entirely (intent already decided).
  if (!intent && !focusMode && !isComparison && queryIsSpecific && !isFirstQuery && conversationContext.allowedDocIds?.length > 0) {
    const allowedSet  = new Set(conversationContext.allowedDocIds);
    const topRrfIds   = fusedRanking.slice(0, topDocsCount).map(([id]) => id);
    const bm25TopId   = bm25Results.length > 0 ? bm25Results[0][0] : null;
    const rrfTopInAllowed = topRrfIds.some(id => allowedSet.has(id));
    const dynamicThreshold = (idx.liveBM25?.medianScore || 3.0) * 2.0;

    const bm25AllowedScore = bm25Results.find(([id]) => allowedSet.has(id))?.[1] ?? 0;
    const bm25StronglyDisagrees = bm25TopId && !allowedSet.has(bm25TopId) &&
      bm25Results[0][1] >= dynamicThreshold &&
      bm25Results[0][1] > bm25AllowedScore * 1.3;

    // Also check the RAW (unexpanded) query against BM25 — expansion can mask topic
    // shifts by injecting previous-topic terms that boost allowed docs artificially.
    // Only fire raw shift when the query itself has specific meaningful tokens —
    // vague queries like "tell me more" score high on random docs via common words.
    let rawQueryShift = false;
    let rawShiftWinnerId = null;   // captured here so we don't re-run the search later
    const rawQueryHasSpecific = topicShiftTerms.length > 0 || hasProperNoun(query);
    if (!bm25StronglyDisagrees && rawQueryHasSpecific && idx.liveBM25?.engine) {
      try {
        const rawBm25 = idx.liveBM25.engine.search(query, 5);
        if (rawBm25 && rawBm25.length > 0) {
          // Find the top non-allowed result in the raw BM25
          const rawTopEntry = rawBm25.find(([id]) => {
            const docId = idx.liveBM25.idToDocId.get(Number(id));
            return docId && !allowedSet.has(docId);
          });
          if (rawTopEntry) {
            const rawTopId    = idx.liveBM25.idToDocId.get(Number(rawTopEntry[0]));
            const rawTopScore = rawTopEntry[1];
            const rawAllowedScore = rawBm25.find(([id]) => allowedSet.has(idx.liveBM25.idToDocId.get(Number(id))))?.[1] ?? 0;
            rawQueryShift = rawTopScore >= dynamicThreshold;
            if (rawQueryShift) {
              rawShiftWinnerId = rawTopId;
              if (DEBUG) console.log(`🔀 Raw query shift: "${path.basename(idx.parentMap.get(rawTopId)?.metadata?.source || rawTopId)}" (${rawTopScore.toFixed(2)}) vs allowed (${rawAllowedScore.toFixed(2)})`);
            }
          }
        }
      } catch (_) {}
    }

    if (!rrfTopInAllowed || bm25StronglyDisagrees || rawQueryShift) {
      if (DEBUG) console.log(`🔀 Topic shift detected (rrf=${!rrfTopInAllowed}, bm25=${bm25StronglyDisagrees}, rawQuery=${rawQueryShift}) — resetting conversation context`);
      trace.step('topic-shift',
        'The question moved to a different document than the one under discussion, so earlier context was set aside.');

      // Winner: BM25-disagrees uses the filtered top; raw-shift reuses the id we
      // already found above (no second search). rrf-only shift has no explicit
      // winner and relies on the natural ranking. In cross-lingual mode there is NO
      // BM25-chosen winner: BM25 points at a wrong same-language document for a
      // cross-lingual query, so promoting it would override the dense-only ranking —
      // the dense (embedding) order already leads with the correct document, so let it stand.
      const shiftWinnerId = crossLingualMode ? null : (bm25StronglyDisagrees ? bm25TopId : rawShiftWinnerId);

      // Full reset (see the intent-driven branch above) so the previous topic's
      // rolling summary / consulted docs / passage maps don't carry into the new one.
      clearConversationState(conversationContext);
      topicShiftedThisQuery = true;

      if (shiftWinnerId) {
        // Move winner to rank 1 by swapping scores with current top, not boosting.
        // A large fixed boost (+0.05) crushes the natural score ratios and causes
        // other relevant docs to fail the RRF filter even at 50%.
        const currentTopScore  = fusedRanking[0]?.[1] ?? 0;
        const winnerScore      = fusedRanking.find(([id]) => id === shiftWinnerId)?.[1] ?? currentTopScore;
        if (winnerScore < currentTopScore) {
          // Swap: give winner the top score, give old top the winner's score
          const oldTopId = fusedRanking[0]?.[0];
          fusedRanking = fusedRanking.map(([id, score]) => {
            if (id === shiftWinnerId) return [id, currentTopScore];
            if (id === oldTopId)      return [id, winnerScore];
            return [id, score];
          }).sort((a, b) => b[1] - a[1]);
        }
        if (DEBUG) console.log(`  🔝 Post-shift rerank: promoted ${path.basename(idx.parentMap.get(shiftWinnerId)?.metadata?.source || shiftWinnerId)}`);
      }
    }
  }

  // 7. Boost allowed docs (skipped in focus mode — selection already constrains scope)
  let rankedDocIds = fusedRanking;
  // A 'reference' question points back to the CURRENT subject and must be answered from the conversation's own
  // document(s) — plus any document the classifier explicitly referenced — never a document that merely
  // contains the term the user asked about. Resolved below. (A reference is never a shift, so topicShiftedThis
  // Query is false here; focus mode, when on, takes precedence.)
  const refAnchorIds = (intent && intent.intent === 'reference' && !topicShiftedThisQuery && !focusMode)
    ? [...new Set([...(conversationContext.allowedDocIds || []), ...(intentTargetIds || [])])]
    : null;
  if (focusMode) {
    // Focus mode: restrict to selected docs only, preserving their RRF order
    const selectedSet = new Set(selectedDocIds);
    rankedDocIds = fusedRanking.filter(([docId]) => selectedSet.has(docId));
    // If no selected docs appear in the ranking (e.g. query totally unrelated),
    // fall back to all selected docs with equal score so retrieval still runs
    if (rankedDocIds.length === 0) {
      rankedDocIds = selectedDocIds.map(id => [id, 0.01]);
    }
    if (DEBUG) console.log(`  🔍 Focus mode: restricting to ${selectedDocIds.length} selected doc(s)`);
    trace.step('focus', `You selected ${selectedDocIds.length} document(s), so only those were searched.`);
  } else if (refAnchorIds && refAnchorIds.length > 0) {
    // Reference follow-up ("does it mention X?", "what about the second one?", "what does this have to do with
    // Y?"): RESTRICT serving to the anchored document(s), exactly like focus mode — not merely boost them.
    // The resolved query carries the term X, so an unrelated document that happens to contain X can otherwise
    // outrank the anchor and be served, leaking its contents — and only intermittently, as retrieval ties
    // break differently from run to run. Restricting makes the answer deterministically "that term isn't in
    // this document" instead of a flaky switch to the document that has it. The continuity branch below (a
    // gentle boost, for 'continue'/heuristic follow-ups where a clearly-stronger new match may still win) is
    // too weak for a reference, which is an explicit "stay on the current subject" signal.
    const anchorSet = new Set(refAnchorIds);
    rankedDocIds = fusedRanking.filter(([docId]) => anchorSet.has(docId));
    if (rankedDocIds.length === 0) rankedDocIds = refAnchorIds.map(id => [id, 0.01]);
    if (DEBUG) console.log(`  🔗 Reference — restricting to ${anchorSet.size} anchored doc(s) (stays on the current subject)`);
    trace.step('reference', 'This question refers back to the current subject, so it was answered from the document(s) already under discussion.');
  } else if (!isFirstQuery && !topicShiftedThisQuery && conversationContext.allowedDocIds?.length > 0) {
    // Gentle continuity preference: nudge documents already in the conversation UP by a FRACTION of their
    // own fused score, so on a genuine follow-up (scores close) the conversation's document wins ties —
    // but a document the new question matches clearly better on its own still outranks it. A flat additive
    // boost here (+0.05) dwarfed the small RRF scores (~0.01–0.03), pinning the conversation's document to
    // rank 1 even when the question had moved on, so a switched-to question retrieved the old topic and
    // answered "I don't have that information". A proportional nudge cannot override a clearly-stronger
    // match. (The shift detectors above catch an outright switch; this only breaks near-ties.)
    const allowedSet = new Set(conversationContext.allowedDocIds);
    const CONTINUITY_BOOST = 0.15;   // +15% of the doc's own score — a tie-breaker, not an override
    rankedDocIds = fusedRanking.map(([docId, score]) => [
      docId,
      allowedSet.has(docId) ? score * (1 + CONTINUITY_BOOST) : score
    ]).sort((a, b) => b[1] - a[1]);
  }

  // Build chunkIdsByParent from FAISS results — seed with all chunks first,
  // then rerank them so the best passage anchor is used per document.
  const chunkIdsByParent = new Map();

  if (USE_RERANKER && !isRetry) {
    // Collect ALL candidate chunks across the top FAISS results for reranking — NOT one per document.
    // Reranking the full set is what lets the cross-encoder (and the optional ColBERT refinement) pick
    // the best PASSAGE within a document, rather than only reordering documents by whichever chunk FAISS
    // happened to surface first. We pass chunk text (not the whole doc) to the cross-encoder — fast and
    // accurate — and dedup by chunk id so a chunk surfaced by more than one path isn't scored twice.
    // The set is bounded by FAISS_CANDIDATES, so this adds no unbounded work.
    const seenChunk = new Set();
    const candidateChunks = faissResults.slice(0, FAISS_CANDIDATES).flatMap(([doc]) => {
      const parentId = doc.metadata.parentId || doc.metadata.docId;
      const chunkId  = doc.metadata.childId;
      if (!parentId || !chunkId || seenChunk.has(chunkId)) return [];
      seenChunk.add(chunkId);
      return [{ id: chunkId, parentId, text: doc.pageContent, docName: path.basename(idx.parentMap.get(parentId)?.metadata?.source || '') }];
    });

    if (candidateChunks.length > 0) {
      if (bailIfAborted()) return abortedResult();
      stage(`Reranking the top ${candidateChunks.length} passages…`);
      const reranked = await rerank(standaloneQuery, candidateChunks);
      // Track the best cross-encoder score. The reranker cleanly separates genuine
      // matches (positive scores) from documents that merely share incidental words
      // (strongly negative) — a far better relevance signal than BM25 overlap, which
      // can be high for off-topic docs that share a generic token (e.g. a place name).
      // socket.js uses this to decide whether a failed answer is a true corpus gap
      // (offer web) or a retrievable answer the model fumbled (retry locally).
      for (const chunk of reranked) {
        // Record every candidate with its cross-encoder score. These include the
        // documents that lost — which are the whole point of the trace, since a
        // user can already see what was cited but never what was rejected.
        trace.candidate(chunk.parentId, chunk.docName, { rerank: chunk.rerankerScore });
        // Track the best score per parent. topRerankerScore is derived from this AFTER
        // assembly, over the used documents only — taking a global max here let an
        // off-topic document's stray positive chunk (a doc later dropped by the BM25/RRF
        // gates) masquerade as "a genuine match exists" and suppress a correct web offer.
        if (typeof chunk.rerankerScore === 'number') {
          const prev = rerankByParent.get(chunk.parentId);
          if (prev === undefined || chunk.rerankerScore > prev) rerankByParent.set(chunk.parentId, chunk.rerankerScore);
        }
      }
      // Optional late-interaction (ColBERT-style) refinement: re-sort the reranked candidates by
      // token-level MaxSim so the passage anchor picked per parent favors the chunk that best covers
      // the query token-for-token. Off by default and fail-open (returns the same order on any
      // failure), so it can sharpen anchor selection but never regress. Read live so the Settings
      // toggle applies without a restart. The cross-encoder scores captured above — the relevance and
      // web-offer gate signal — are untouched; only the ORDER used for anchor selection changes.
      let ranked = reranked;
      if (require('../config').USE_COLBERT_RERANK) {
        try { ranked = await require('./colbert').colbertRerank(standaloneQuery, reranked); }
        catch { ranked = reranked; }
      }
      // Build chunkIdsByParent from the (optionally refined) reranker order, keeping each document's
      // BEST-scored chunk(s) as its passage anchor — `ranked` is sorted best-first, so the first chunk
      // seen for a parent is its best. Capped at MAX_ANCHORS_PER_PARENT so a document's served window
      // size is unchanged (see the constant's note on the downstream budget).
      for (const [p, ids] of pickAnchorsByParent(ranked, MAX_ANCHORS_PER_PARENT)) chunkIdsByParent.set(p, ids);
    }
  } else {
    // No reranker — FAISS order is the only relevance signal, so a document's anchor is its top FAISS
    // chunk. Same shared grouping (best-first = FAISS order) as the reranked path.
    const faissOrdered = faissResults.map(([doc]) => ({ parentId: doc.metadata.parentId || doc.metadata.docId, id: doc.metadata.childId }));
    for (const [p, ids] of pickAnchorsByParent(faissOrdered, MAX_ANCHORS_PER_PARENT)) chunkIdsByParent.set(p, ids);
  }

  // Seed BM25-only docs with chunks near their keyword-dense region
  for (const [docId] of rankedDocIds.slice(0, topDocsCount * 2)) {
    if (chunkIdsByParent.has(docId)) continue;
    const parentEntry = idx.parentMap.get(docId);
    if (!parentEntry) continue;
    const seeds = seedChunksForDoc(docId, parentEntry.content, standaloneQuery, idx);
    if (seeds.length > 0) chunkIdsByParent.set(docId, seeds);
  }

  // Second-stage rerank of the DOCUMENTS themselves: reorder them by the cross-encoder's judgment so
  // the most relevant document is cited first and survives the context-budget trim below, rather than
  // staying wherever RRF placed it. A stable permutation of only the reranker-scored documents — RRF
  // order is preserved for BM25-only and tail documents (see rerankorder.js). Applied before the
  // continuation promotion, so an explicit "tell me more" about the conversation document still wins.
  //
  // SKIPPED in cross-lingual mode. A cross-encoder reranker scores a query against a passage by their
  // surface token interaction, so it is as cross-lingual-weak as BM25: for a question in one language and
  // the answering document in another it returns near-uniform, often negative scores and reorders the
  // correct document DOWN — the very failure cross-lingual mode exists to avoid. When the multilingual
  // embedding is the trusted signal (strong dense match, no keyword support), we keep the dense-only fused
  // order and do not let the reranker override it. The per-passage reranker scores are still recorded above
  // (rerankByParent) for anchor selection and the web-offer signal; only the document REORDER is bypassed.
  if (USE_RERANKER && !isRetry && !crossLingualMode && rerankByParent.size > 0) {
    rankedDocIds = reorderByReranker(rankedDocIds, rerankByParent, downweightFactor);
    if (DEBUG) console.log('  🎯 Documents reordered by cross-encoder score');
  }

  // 8. Assemble top documents
  const mergedDocs = [];
  // Best document rejected solely by the named-entity gate, kept as a last-resort
  // fallback so a single unmatched proper noun can't empty the whole result set.
  let namedGateRescue = null;
  let namedGateRescued = false;

  // For continuation queries with active context, promote allowed docs to the front of
  // the ranking — "tell me more" should always serve the conversation doc even if it
  // ranks low on the vague query's FAISS/BM25 signal (see orderContinuationDocs).
  if (isContinuation && conversationContext.allowedDocIds?.length > 0) {
    rankedDocIds = orderContinuationDocs(rankedDocIds, conversationContext.allowedDocIds, vagueContinuation);
    if (DEBUG) console.log(`  📌 Continuation follow-up: kept conversation doc(s) at front${vagueContinuation ? ' (by conversation primacy)' : ''}`);
  }

  // The best RRF score across the ranking, used as the reference for the relative co-source filter
  // below. Computed as the max rather than rankedDocIds[0] so it stays correct after the cross-encoder
  // reorder above moves a document with a lower RRF score to the front.
  // Use the genuine (pre-boost) top fused score as the relative filter reference, not the boosted maximum —
  // an artificial +0.05 promotion must not inflate the bar and drop legitimate co-sources (see the capture
  // of naturalTopRrfScore above). Promoted docs still pass easily on their own (boosted) scores.
  const topRrfScore = naturalTopRrfScore;

  // Pre-compute named tokens for the whole assembly loop.
  // Only treat a word as a named entity if it appears capitalized somewhere
  // other than the start of the query (to avoid "Give", "Tell", "What" etc.)
  const queryWords = query.trim().split(/\s+/);
  const queryNamedTokens = [...new Set(tokenize(query))]
    .filter(t => t.length > 3 && !STOP_WORDS_GATE.has(t) &&
      // Must appear capitalized at least once in a non-first position. Strip surrounding punctuation first
      // (the same way extractNamedTerms does) so a subject at a clause/sentence end — "…relate to Qubblen?",
      // "(Vexmor)" — is still recognized; comparing the RAW word dropped the second subject of a question-form
      // two-sided query, which then excluded its document at the named-entity gate below.
      queryWords.slice(1).some(w => { const s = stripWordEdges(w); return startsCapitalized(s) && s.toLowerCase() === t; }));
  // Precompile the whole-word regexes ONCE (query-only). They were rebuilt per candidate inside the
  // assembly loop's named-entity gate — identical every time, so up to k×candidates needless compiles.
  const queryNamedRes = queryNamedTokens.map(t => new RegExp(`\\b${escapeRegExp(t)}\\b`));
  // Co-source keyword-gate inputs are query-only (they depend on the query and the corpus IDF, not the
  // candidate), so compute them ONCE here rather than re-extracting/re-tokenizing per candidate inside
  // the assembly loop below.
  const coSourceSpecificKws = extractSpecificKeywords(standaloneQuery, 5, idx.corpusIdf);
  const coSourceRawKws = [...new Set(tokenize(query))].filter(t => t.length > 3 && !STOP_WORDS_GATE.has(t));
  const coSourceGateKws = coSourceSpecificKws.length > 0 ? coSourceSpecificKws :
    coSourceRawKws.length > 0 ? coSourceRawKws : extractKeywords(standaloneQuery, 5, idx.corpusIdf);

  if (!conversationContext.docReadPos)  conversationContext.docReadPos  = new Map();
  if (!conversationContext.docPassages) conversationContext.docPassages = new Map();

  for (const [docId, rrfScore] of rankedDocIds) {
    if (mergedDocs.length >= finalTopDocs) break;

    const parentEntry = idx.parentMap.get(docId);
    if (!parentEntry) { if (DEBUG) console.log(`  ⚠️  No parentMap entry for docId ${docId} — skipping`); continue; }
    if ((startDate || endDate) && !checkDate(parentEntry.metadata.timestamp, startDate, endDate)) continue;

    // Lowercase the whole document at most ONCE per candidate, and only when a gate or the passage
    // extractor below actually needs it. The named-entity gate, the co-source keyword gate, and passage
    // selection each used to recompute content.toLowerCase() independently — up to three full-document
    // copies per candidate, which on a large document (content can be hundreds of MB) allocates gigabytes
    // of transient strings per query. Memoizing keeps the exact same behavior while doing the work once,
    // and a candidate filtered out before any gate still never pays for it.
    let _fullLower = null;
    // Even the "full" lowercase is hard-bounded. Document text is normally capped at the extraction limit, so
    // this ceiling is a no-op today; it exists so a pathologically large document (if that cap is ever raised)
    // can't allocate a huge transient string and scan it synchronously on the answer path. A follow-up answer
    // that lives past the ceiling in a giant document is the accepted trade-off for staying non-blocking.
    const fullLowerOf = () => (_fullLower !== null ? _fullLower
      : (_fullLower = (parentEntry.content.length > FULL_LOWER_MAX_CHARS
          ? parentEntry.content.slice(0, FULL_LOWER_MAX_CHARS)
          : parentEntry.content).toLowerCase()));
    // The keyword GATES below only ever read the first KEYWORD_SCAN_MAX_CHARS — the same bound BM25/IDF
    // indexing and every sibling scan already use — so lowercase just that prefix for them. This matters
    // because those gates run for EVERY candidate, including the ones they reject: without the bound, a
    // single rejected candidate would lowercase and scan a whole document, which can be hundreds of MB,
    // synchronously on the answer path and stall every other connected client. The full lowercase above is
    // reserved for passage extraction of the 2-3 documents that survive all gates, where a follow-up can
    // legitimately read past the bound. A named entity that appears only past the bound is already outside
    // what retrieval indexes, so bounding the gate does not change which documents real queries surface.
    let _boundedLower = null;
    const boundedLowerOf = () => (_boundedLower !== null ? _boundedLower
      : (_boundedLower = parentEntry.content.length > KEYWORD_SCAN_MAX_CHARS
          ? parentEntry.content.slice(0, KEYWORD_SCAN_MAX_CHARS).toLowerCase()
          : fullLowerOf()));   // small docs: reuse the one full copy rather than make a second

    const isAllowedDoc = conversationContext.allowedDocIds?.includes(docId);
    // An entity-bridge document is relevant by ENTITY (it carries a name the query connects
    // through the graph), not by repeating the query's keywords — so it is exempt from every
    // keyword/BM25/named-token co-source gate below, whether it lands as the primary document
    // or a co-source. Otherwise the very document that answers "how are X and Y related" is
    // dropped for not echoing the query's words.
    const isBridgeDoc = bridgeDocIds.has(docId);

    // Cross-lingual co-source strength gate. In cross-lingual mode the keyword co-source gates below are bypassed
    // (keywords are unreliable across languages) and the fused scores are nearly flat, so a same-language but
    // OFF-TOPIC document that happens to rank in the dense tail could tag along after the correct primary. Admit a
    // co-source only when its OWN embedding match is strong (the same strong-dense bar that gates cross-lingual
    // mode). The primary document (mergedDocs.length === 0) is never filtered here — it already cleared that bar.
    // A bridge document is exempt, as it is from every co-source gate. This keeps a cross-lingual answer to the
    // genuinely relevant document(s) instead of padding it with an incidental same-language match.
    if (crossLingualMode && mergedDocs.length > 0 && !isBridgeDoc && !isAllowedDoc) {
      const coCos = parentTopCosine.get(docId);
      if (!(Number.isFinite(coCos) && coCos >= require('../config').MIN_COSINE_SCORE * SEMANTIC_MATCH_MULT)) {
        if (DEBUG) console.log(`  ⏭️  Cross-lingual: dropped weak co-source ${path.basename(parentEntry.metadata.source)} (cosine ${Number(coCos).toFixed(3)} < strong bar)`);
        continue;
      }
    }

    if (!bm25DocIds.has(docId)) {
      // Always allow the conversation's document through even with no BM25 overlap —
      // vague queries like "tell me more" match nothing in BM25 but should still
      // serve the active document. The same applies to focus mode: the user
      // hand-picked these docs, so a vague query like "what's this about?" must serve
      // them rather than filter them out for lacking keyword overlap.
      //
      // Also skip this filter entirely when BM25 didn't build (empty engine on a
      // 1-2 doc corpus): bm25DocIds is empty for EVERY doc then, not because of a
      // real overlap miss but because BM25 isn't functioning. A doc that reached
      // here already passed vector retrieval and the reranker, which is sufficient
      // signal on a tiny corpus. Without this, a freshly-ingested single document is
      // filtered out of its own workspace's results.
      const bm25Functional = !idx.liveBM25?.empty && idx.liveBM25?.engine;
      // Exempt a document the reranker scored as a genuine match (positive cross-encoder
      // score): a paraphrase/synonym answer can have zero keyword overlap yet be exactly
      // right, and filtering it here made pure-semantic matches unreachable.
      const strongSemantic = rerankByParent.get(docId) > 0 || crossLingualMode;
      if (!isAllowedDoc && !isBridgeDoc && !focusMode && bm25Functional && !strongSemantic) {
        if (DEBUG) console.log(`  ⏭️  Filtered ${path.basename(parentEntry.metadata.source)} — no BM25 keyword overlap`);
        continue;
      }
    }

    // Named entity check — prevents FAISS false-positives like CrackCode ranking
    // first for a named person or entity. Allowed docs always bypass this — they are the active
    // conversation document and must be served regardless of named token matching.
    // Uses WHOLE-WORD matching (not substring) so a short name doesn't match a longer one
    // or an incidental substring inside an unrelated word.
    // Skipped in cross-lingual mode: the "named tokens" are the query's own words, which are in the QUERY's
    // language and so cannot appear whole-word in a document written in another language — exactly the
    // confident cross-lingual match. Without this exemption such a match is excluded here and served only via
    // the last-resort named-gate rescue below, which flags it as a PARTIAL (hedged) answer. An out-of-corpus
    // named subject stays below the strong-dense bar that gates cross-lingual mode, so it is still excluded.
    // Whether this document whole-word matches a subject the query NAMED (set by the gate below; reused by the
    // comparison RRF exemption so each named subject survives — see there).
    let matchedNamedSubject = false;
    if (queryNamedTokens.length > 0 && !focusMode && !isAllowedDoc && !isBridgeDoc && !crossLingualMode) {
      const scanLower = boundedLowerOf();
      const hasNamed = queryNamedRes.some(re => re.test(scanLower));
      matchedNamedSubject = hasNamed;
      if (!hasNamed) {
        if (DEBUG) console.log(`  ⏭️  Excluded ${path.basename(parentEntry.metadata.source)} — named terms [${queryNamedTokens.join(', ')}] not found (whole-word)`);
        // Remember the best-ranked doc rejected *only* by this gate. If the gate ends
        // up eliminating every candidate (a misspelled name, an alias, or a name that
        // only appears in an unindexed image/scan), we serve this as a partial match
        // rather than returning a dead-end "no information found".
        if (!namedGateRescue) namedGateRescue = { docId, parentEntry };
        continue;
      }
    }

    // After a topic shift, use a looser RRF filter (60%) since the score swap
    // may slightly distort the natural ratios between the top two documents.
    // Allowed docs always bypass the RRF filter — they are the active conversation
    // document and must be served regardless of where they rank on vague queries.
    // Comparison queries use a much looser filter (35%) so a genuinely relevant
    // second/third document isn't dropped just for ranking below the top source.
    //
    // An entity-bridge document and a strong cross-encoder match are exempt here, exactly as they are
    // from every keyword/BM25 co-source gate below: a bridge document answers "how are X and Y related"
    // through the graph rather than by ranking high in RRF, and a paraphrase co-source can have a low
    // fused score yet a strongly positive reranker score. And this skips the doc (continue) rather than
    // ending the loop (break): because candidates are score-sorted, a break would never even reach an
    // exempt bridge/semantic document ranked below a non-exempt sub-threshold one.
    const rrfFilterThreshold = isComparison ? 0.35 : (topicShiftedThisQuery ? 0.6 : 0.8);
    // In a comparison / two-sided relational query, a document that whole-word matches a subject the user NAMED is
    // exempt from the RRF filter: the user explicitly asked about it, so it must be served even when the dominant
    // subject outranks it on the fused score. This is what guarantees BOTH sides of "how does A relate to B?" are
    // present, not just the stronger one. Capped by topDocsCount, and only in comparison mode, so ordinary single-
    // subject retrieval is unchanged.
    // A document that whole-word matches a subject the user NAMED in a comparison / two-sided relational query is
    // exempt from the co-source filters (this RRF one and the keyword/BM25 gate below), exactly like a bridge
    // document — single-sourced here so both gates stay in step. Defined once; used in both places.
    const namedSubjectCoSource = isComparison && matchedNamedSubject;
    const rrfExempt = isBridgeDoc || (rerankByParent.get(docId) > 0) || namedSubjectCoSource;
    if (!focusMode && mergedDocs.length > 0 && !isAllowedDoc && !rrfExempt && rrfScore < topRrfScore * rrfFilterThreshold) {
      if (DEBUG) console.log(`  ⏭️  Filtered ${path.basename(parentEntry.metadata.source)} — RRF score ${rrfScore.toFixed(4)} < ${Math.round(rrfFilterThreshold*100)}% of top (${topRrfScore.toFixed(4)})`);
      continue;
    }

    // Keyword relevance gate for second+ documents.
    // Hard rule: if the document has no BM25 score at all for this query,
    // it's irrelevant regardless of FAISS ranking — skip immediately.
    // (Only when BM25 is functional — on a tiny corpus where BM25 couldn't build,
    // every score is a meaningless 0, so this gate would wrongly exclude real
    // co-sources. Vector ranking carries relevance there.)
    const bm25FunctionalCoSource = !idx.liveBM25?.empty && idx.liveBM25?.engine;
    // Focus mode is exempt: every doc here was hand-picked by the user, so none of the
    // co-source keyword/BM25 gates below (which exist to keep weakly-matching EXTRA
    // docs from tagging along in normal retrieval) should ever drop one. A named-subject
    // co-source in a comparison (namedSubjectCoSource, set above) is exempt too, exactly like
    // a bridge document: these gates ask a co-source to echo the query's keywords, but the
    // second subject of "how does A relate to B?" often contains only its OWN name, not A's —
    // dropping it for that is the very failure this path exists to prevent.
    if (!focusMode && !isBridgeDoc && !namedSubjectCoSource && mergedDocs.length > 0 && bm25FunctionalCoSource) {
      const bm25Score = bm25AllResults.find(([id]) => id === docId)?.[1] ?? 0;
      // A strong reranker match (positive score) is a real co-source even with zero
      // keyword overlap — don't hard-exclude it (paraphrase/synonym answers).
      if (bm25Score === 0 && !(rerankByParent.get(docId) > 0)) {
        if (DEBUG) console.log(`  ⏭️  Excluded ${path.basename(parentEntry.metadata.source)} — no BM25 score for query`);
        continue;
      }

      // Relative BM25 gate: a genuine co-source must score a meaningful fraction of
      // the top document's BM25 score. A second doc that shares only a generic word
      // (e.g. "interview") scores far below the primary and should not tag along.
      // Comparison queries skip this — they intentionally want balanced co-sources.
      // A strong reranker match is exempt, exactly like the zero-BM25 gate above and the
      // primary-doc filter: a positive cross-encoder score is the authoritative "genuine match"
      // signal, so a paraphrase co-source with only partial keyword overlap must not be dropped
      // more harshly than one with none. Only affects FAISS-surfaced+reranked docs — a BM25-only
      // co-source has no reranker score, so this leaves its behavior unchanged.
      if (!isComparison && !isBridgeDoc && !(rerankByParent.get(docId) > 0)) {
        const topBm25 = bm25AllResults.length > 0 ? bm25AllResults[0][1] : 0;
        if (topBm25 > 0 && bm25Score < topBm25 * 0.5) {
          if (DEBUG) console.log(`  ⏭️  Excluded ${path.basename(parentEntry.metadata.source)} — BM25 ${bm25Score.toFixed(2)} < 50% of top ${topBm25.toFixed(2)}`);
          continue;
        }
      }

      const fullLower = boundedLowerOf();   // the gate loop below never reads past KEYWORD_SCAN_MAX_CHARS
      const gateKws = coSourceGateKws;   // hoisted above the loop (query-only)

      const WSIZE = passageSize();
      const isLargeDoc = parentEntry.content.length > 500_000;
      // Comparison queries deliberately want a second/third document, so use a lower
      // gate (2) — the doc just needs a real keyword footprint, not a dominant one.
      const gateThreshold = isComparison ? 2 : ((isLargeDoc && bm25Score > 3) ? 2 : 5);
      // Shared sliding-window scan, stopping as soon as a window clears the gate (no need for the max).
      const { score: maxScore } = scanWindowsMax(fullLower, gateKws, { window: WSIZE, stopAtScore: gateThreshold });
      if (maxScore < gateThreshold && !isBridgeDoc && !crossLingualMode) {
        if (DEBUG) console.log(`  ⏭️  Excluded ${path.basename(parentEntry.metadata.source)} — keyword score ${maxScore} < ${gateThreshold}`);
        continue;
      }
    }

    const isFollowUp      = !isFirstQuery && !topicShiftedThisQuery && (conversationContext.allowedDocIds || []).includes(docId);
    const fullText        = parentEntry.content;
    const matchedChunkIds = chunkIdsByParent.get(docId) || [];
    const hasPassageData  = matchedChunkIds.length > 0 && idx.passageMap.has(matchedChunkIds[0]);
    const docNameTokens   = new Set(tokenize(path.basename(parentEntry.metadata.source).toLowerCase().replace(/[^a-z0-9]/g, ' ')));

    if (!isFollowUp && querySpecificTerms.length > 0) {
      conversationContext.docPassages.delete(docId);
      conversationContext.docReadPos.delete(docId);
    }

    let content;

    // Full-Context mode: inject the WHOLE document instead of retrieved passages,
    // when the user flagged this doc for it AND it's small enough to fit safely. This
    // fixes small-doc dilution — a short document (an ID, a one-page form, a style
    // guide) whose single relevant line would otherwise be a low-scoring chunk. Guarded
    // by WHOLE_INJECT_MAX_CHARS so a large doc can't blow the context window; oversized
    // full-context docs fall through to normal passage retrieval.
    if (!isRetry && fullContextSet.has(docId) && fullText.length <= WHOLE_INJECT_MAX_CHARS) {
      content = fullText;
      if (DEBUG) console.log(`  📄 Full-Context: injecting all ${fullText.length} chars of ${path.basename(parentEntry.metadata.source)}`);
      trace.step('fullcontext', `${path.basename(parentEntry.metadata.source)} was injected in full (Full-Context mode).`);
      // Record the served span as the whole document, so the citation reports a real range (the viewer
      // highlight and "% through document" work) and faithfulness checks the exact text the model saw,
      // instead of falling back to a 0/0 span.
      conversationContext.docPassages.set(docId, [{ start: 0, end: fullText.length }]);
      mergedDocs.push({ content, metadata: { ...parentEntry.metadata, parentId: docId } });
      continue;
    }

    if (isRetry) {
      const retryResult = _retryContent(fullText, standaloneQuery, query, isFollowUp, docId, conversationContext, mergedDocs.length, attemptNumber, idx);
      if (retryResult === null) {
        if (DEBUG) console.log(`  ⏭️  Skipped ${path.basename(parentEntry.metadata.source)} on retry — best score < 5`);
        continue;
      }
      content = retryResult;
    } else if (hasPassageData) {
      // Pass the memoized lower-caser as a THUNK, not its result: the common focus-mode and
      // valid-passage paths return without ever needing it, so a large document (a 16 MB log) is not
      // needlessly lower-cased in full on every query — only the keyword-scan and follow-up paths force it.
      content = _passageContent(fullText, fullLowerOf, matchedChunkIds, docId,
        query, standaloneQuery, isFollowUp, docNameTokens, conversationContext, path.basename(parentEntry.metadata.source), focusMode, idx, mergedDocs.length);
    } else {
      content = _keywordLocationContent(fullText, query, docId, conversationContext, path.basename(parentEntry.metadata.source), idx);
    }

    // A null passage means the document had nothing to contribute (the drift gate skipped a co-source that
    // advanced off the thread's topic) — don't push it. Only null/undefined is skipped, so any existing path that
    // returned a string is pushed exactly as before.
    if (content != null) mergedDocs.push({ content, metadata: { ...parentEntry.metadata, parentId: docId } });
  }

  if (DEBUG) {
    console.log('--- MERGED PARENT DOCUMENTS ---');
    mergedDocs.forEach((r, i) => console.log(`  Document ${i + 1}:`, r.metadata.source));
  }

  if (mergedDocs.length === 0) {
    // Retrieval found nothing usable — often a bad/hallucinated rewrite with no BM25
    // overlap. If we still have an active conversation document, fall back to re-serving
    // its last shown passage instead of the dead-end "No relevant information found".
    // (A genuine new topic would have reset allowedDocIds via topic-shift, so this only
    // rescues same-topic follow-ups whose retrieval went wrong.)
    const allowed = conversationContext.allowedDocIds;
    if (allowed && allowed.length > 0) {
      for (const aDocId of allowed) {
        const entry = idx.parentMap.get(aDocId);
        const servedP = conversationContext.docPassages?.get(aDocId);
        if (!entry || !servedP || servedP.length === 0) continue;
        const rStart = Math.min(...servedP.map(r => r.start));
        const rEnd   = Math.max(...servedP.map(r => r.end));
        if (rEnd > rStart) {
          mergedDocs.push({ content: entry.content.slice(rStart, rEnd), metadata: { ...entry.metadata, parentId: aDocId } });
          // We re-serve ONE contiguous slice [rStart,rEnd] (gaps between the prior disjoint windows included), so
          // record THAT as the served range. Otherwise the citation/highlight would report the prior turn's
          // disjoint ranges while the model actually saw the contiguous slice — an under-covering highlight.
          try { conversationContext.docPassages.set(aDocId, [{ start: rStart, end: rEnd }]); } catch { /* best-effort */ }
          if (DEBUG) console.log(`\u{1f4d6} Empty retrieval — fell back to conversation doc ${path.basename(entry.metadata.source)} (${rStart}\u2013${rEnd})`);
          break;
        }
      }
    }
  }

  // Last resort: every candidate was rejected solely because the query's named
  // entity wasn't found verbatim. That happens with misspellings, aliases, or names
  // that only appear in scanned images — cases where the best-ranked document may
  // still be the right one. Serve it flagged as a partial match so the model is
  // candid about the mismatch rather than returning a dead end.
  if (mergedDocs.length === 0 && namedGateRescue) {
    const { docId, parentEntry } = namedGateRescue;
    const fullText = parentEntry.content;
    // Mirror the sizing rule used by passage selection: very large documents get a
    // proportionally larger window, everything else uses the configured passage size.
    const rescueSize = largeDocWindow(fullText.length);
    let content;
    if (fullText.length <= rescueSize) {
      content = fullText;
      // Record the served range so the citation highlight and "% through document" are correct — matching the
      // Full-Context and empty-retrieval fallbacks. Without this the whole-doc rescue reported passageStart=
      // passageEnd=0 (an empty highlight). The _keywordLocationContent branch sets its own range internally.
      try { conversationContext.docPassages.set(docId, [{ start: 0, end: fullText.length }]); } catch { /* best-effort */ }
    } else {
      content = _keywordLocationContent(fullText, query, docId, conversationContext, path.basename(parentEntry.metadata.source), idx);
    }
    mergedDocs.push({ content, metadata: { ...parentEntry.metadata, parentId: docId } });
    namedGateRescued = true;
    if (DEBUG) console.log(`  📖 Named-entity gate eliminated all candidates — serving best match ${path.basename(parentEntry.metadata.source)} as a partial match`);
  }

  if (mergedDocs.length === 0) {
    async function* emptyStream() { yield NO_RELEVANT_INFO_MESSAGE; }
    return { stream: emptyStream(), sources: [], outOfScope: true, canWebFallback: true, trace: trace.toJSON() };
  }

  // Trim the served set to what will actually fit the model's context window BEFORE anything downstream
  // reads it. buildMessages caps the concatenated DOCUMENTS block to a character budget and drops the
  // overflow, so without this a trailing document could be cited (and shown with a snippet and a
  // confidence badge) even though the model never saw it. Drop whole trailing documents whose content
  // would fall entirely past the budget, using the exact budget buildMessages will apply and the exact
  // block format documentStream builds below, so the citation list, the served/allowed ids, and the
  // trace all reflect what the model was actually given. The first document is always kept (the budget
  // floor exceeds any header), so a primary answer document is never dropped; a document only partially
  // truncated is kept, since the model did see part of it.
  {
    const CTX_SEP = '\n\n---\n\n';
    const budget = require('../llm').docsBudget(
      conversationContext.history, query, conversationContext.summary || '',
      { isComparison: isComparison && mergedDocs.length >= 2, isPartial: namedGateRescued, persona: workspacePersona });
    let used = 0, keep = 0;
    for (let i = 0; i < mergedDocs.length; i++) {
      const label = `[${path.basename(mergedDocs[i].metadata.source)}]\n`;
      const contentStart = used + (i > 0 ? CTX_SEP.length : 0) + label.length;
      if (i > 0 && contentStart >= budget) break;   // none of this document's content reaches the model
      keep = i + 1;
      used = used + (i > 0 ? CTX_SEP.length : 0) + label.length + mergedDocs[i].content.length;
    }
    if (keep < mergedDocs.length) {
      const dropped = mergedDocs.slice(keep);
      if (DEBUG) console.log(`  ✂️  ${dropped.length} document(s) dropped from the answer — beyond the model context budget (${budget} chars)`);
      for (const d of dropped) trace.drop(d.metadata.parentId, 'Left out — beyond the model context window this turn');
      mergedDocs.length = keep;
    }
  }

  // Scope the reranker signal to the documents actually used (see rerankByParent).
  // socket.js's web-offer gate asks "did any USED document genuinely match?"; scoping
  // here keeps a dropped candidate's stray positive chunk from answering that question.
  if (rerankByParent.size > 0) {
    let best = null;
    for (const r of mergedDocs) {
      const s = rerankByParent.get(r.metadata.parentId);
      if (typeof s === 'number' && (best === null || s > best)) best = s;
    }
    topRerankerScore = best;
  }

  // Model-agnostic off-topic abstention. The early relevance gate (above) uses the embedding cosine, whose
  // scale shifts with whichever embedding model the workspace is on — so no single cosine floor can keep
  // an off-topic question out across every model a user might pick. The cross-encoder reranker is a
  // SEPARATE model with a fixed score scale (ms-marco: ~-11 irrelevant to ~+9 relevant) that does not move
  // when the embedding model changes, so one absolute cutoff generalizes. When the reranker actually scored
  // and EVERY served document is below RERANKER_DROP_BELOW, the cross-encoder judged the whole served set
  // off-topic — the corpus has no genuinely relevant source, so abstain (with the web offer still open)
  // rather than cite noise. This closes the case where a query slips past the cheap cosine pre-filter yet
  // matches nothing real (worse with a high-similarity embedding model, where off-topic cosines run high).
  //
  // Guarded so it only tightens the clearly-off-topic case and never regresses a deliberate or language-
  // mismatched one:
  //   • Fail-open — fires only when the reranker scored (topRerankerScore finite). A disabled/absent/
  //     timed-out reranker, or a retry (which skips reranking), leaves behavior exactly as before.
  //   • The SAME context exceptions as the early gate — focus mode (hand-picked docs), an entity bridge, a
  //     query naming the corpus's own entities, an active conversation (allowedDocIds), or a named-entity
  //     rescue partial — are all intentional serves and are never abstained on a low cross-encoder score.
  //   • Skipped for a confidently non-English query: ms-marco MiniLM is English-trained and under-scores
  //     genuine non-English matches, so trusting it to abstain there would wrongly reject them. Fail-open
  //     (langdetect only flags CONFIDENT non-English; English/ambiguous still get the gate).
  //   • Skipped in cross-lingual mode. A cross-encoder scores query-passage relevance by their surface token
  //     interaction, so a question in one language and the answering document in another under-scores here the
  //     same way it does in the reranker REORDER above — and the non-English-QUERY guard does not catch it when
  //     the QUERY is English and only the DOCUMENT is in another language. Cross-lingual mode means the
  //     multilingual embedding already found a strong semantic match with no keyword support, which is exactly
  //     the case this English-trained cross-encoder gets wrong, so trust the dense signal and do not abstain.
  {
    const rerankerDropBelow = cfg.RERANKER_DROP_BELOW;
    const deliberateContext = focusMode || entityBridged || namesCorpusEntity || namedGateRescued
      || crossLingualMode
      || conversationContext.allowedDocIds?.length > 0;
    if (Number.isFinite(topRerankerScore) && topRerankerScore < rerankerDropBelow
        && !deliberateContext
        && !require('../langdetect').isLikelyNonEnglish(standaloneQuery)) {
      if (DEBUG) console.log(`🚫 Query rejected — cross-encoder judged every served document off-topic (best rerank ${topRerankerScore.toFixed(2)} < ${rerankerDropBelow})`);
      trace.step('off-topic', `The relevance model scored every retrieved passage as off-topic (best ${topRerankerScore.toFixed(1)}, below ${rerankerDropBelow}), so there is no genuinely matching source in the documents.`);
      async function* offTopicStream() {
        yield NO_RELEVANT_INFO_MESSAGE;
      }
      return { stream: offTopicStream(), sources: [], outOfScope: true, canWebFallback: true, topRerankerScore, trace: trace.toJSON() };
    }
  }

  // Single named-entity focus: the question is about ONE named subject (e.g. clicked in the mind-map), so the
  // answer should come only from documents that actually mention it. Drop co-sources that do NOT — an unrelated
  // co-source pulled in by the broadened recall adds noise that makes a small model over-refuse a subject that
  // IS present. Only trims when at least one document mentions the entity (never empties the context), and only
  // on the single-entity path (namedEntity set). Keeps citations honest too: we cite where the subject is
  // discussed, not an unrelated document. Case-insensitive surface-form match (the name came from these docs).
  if (namedEntity && mergedDocs.length > 1) {
    const nn = String(namedEntity).toLowerCase();
    const withEntity = mergedDocs.filter(r => (r.content || '').toLowerCase().includes(nn));
    if (withEntity.length > 0 && withEntity.length < mergedDocs.length) {
      const dropped = mergedDocs.length - withEntity.length;
      mergedDocs.length = 0; mergedDocs.push(...withEntity);
      if (DEBUG) console.log(`  🎯 Entity focus (“${namedEntity}”): kept ${withEntity.length} doc(s) that mention it, dropped ${dropped} unrelated co-source(s)`);
      trace.step('entity-focus', `The question is about “${namedEntity}”, so only the ${withEntity.length} document(s) that mention it were used.`);
    }
  }

  const servedIds = mergedDocs.map(r => r.metadata.parentId);
  if (isContinuation && Array.isArray(conversationContext.allowedDocIds) && conversationContext.allowedDocIds.length > 0) {
    // Preserve documents cited earlier in this SAME topic. A vague continuation ("tell
    // me more") often serves just one document; overwriting allowedDocIds with only
    // that one permanently drops a co-source cited on an earlier turn (e.g. the file
    // that named the creator), so a later specific follow-up ("who made it?") can no
    // longer reach it and contradicts the earlier answer. Union served-first with the
    // prior set, bounded so a long thread can't accrete an unbounded pinned set.
    const merged = [...servedIds];
    for (const id of conversationContext.allowedDocIds) if (!merged.includes(id)) merged.push(id);
    conversationContext.allowedDocIds = merged.slice(0, 4);
  } else {
    conversationContext.allowedDocIds = servedIds;
  }

  // Track which documents this conversation has consulted (for meta questions like
  // "which documents have we looked at?"). De-duplicated on read.
  if (!Array.isArray(conversationContext.consultedDocs)) conversationContext.consultedDocs = [];
  const consulted = conversationContext.consultedDocs;
  for (const r of mergedDocs) {
    const base = path.basename(r.metadata.source);
    if (!consulted.includes(base)) consulted.push(base);
  }
  // Bound the list to the most recent distinct documents, so a long-running conversation that touches
  // many files can't grow it without limit (in memory or when persisted with the session).
  if (consulted.length > MAX_CONSULTED_DOCS) consulted.splice(0, consulted.length - MAX_CONSULTED_DOCS);

  // Natural topic-switch acknowledgment. When the topic genuinely shifted to a new
  // primary document, open with a short spoken transition so the change feels
  // intentional rather than abrupt. Only on real shifts, never on continuations.
  let switchAck = '';
  if (useTopicSwitchAck && topicShiftedThisQuery && mergedDocs.length > 0) {
    const primary = path.basename(mergedDocs[0].metadata.source).replace(/\.[^.]+$/, '');
    switchAck = `Switching over to ${primary} —\n\n`;
  }

  // Shared options object passed into streamChat; it sets genOpts.truncated if the model stalls mid-answer,
  // which the caller reads after draining the stream to avoid caching/persisting a partial answer as complete.
  // The caller's abort signal is threaded through so a New/disconnect cancels the provider request
  // immediately, rather than waiting for the next token to reach the consumer loop's abort check — a
  // stalled model could otherwise hold the serialized generation queue for the full idle timeout.
  const genOpts = options.signal ? { signal: options.signal } : {};
  // Capture the exact messages used for THIS answer so an optional self-consistency pass (semantic entropy)
  // can re-ask the identical prompt at temperature, varying only generation. Set when the stream is first
  // consumed; read only AFTER the answer has drained (the post-answer meta pass), so it is populated by then.
  let capturedMessages = null;
  async function* documentStream() {
    // Generation is about to begin; the first token clears this status. Naming the number of sources that
    // locked in conveys "citations resolved" without reworking the (audited) sources-rendering flow.
    stage(mergedDocs.length ? `Writing the answer from ${mergedDocs.length} source${mergedDocs.length === 1 ? '' : 's'}…` : 'Writing the answer…');
    if (switchAck) yield switchAck;
    const mergedContext = mergedDocs.map((r) => {
      return `[${path.basename(r.metadata.source)}]\n${r.content}`;
    }).join('\n\n---\n\n');
    // When the question names a known graph entity AND that name is actually present in the assembled context,
    // tell the model so explicitly (small models over-refuse a briefly-mentioned subject). Gated on the name
    // being present so we never claim a subject is there when it isn't — that would invite fabrication.
    const aboutEntity = (namedEntity && mergedContext.toLowerCase().includes(String(namedEntity).toLowerCase()))
      ? namedEntity : undefined;
    const messages = buildMessages(mergedContext, conversationContext.history, query,
      conversationContext.summary || '', {
        isComparison: isComparison && mergedDocs.length >= 2,
        isPartial: namedGateRescued,
        isReference: !!(refAnchorIds && refAnchorIds.length > 0),
        persona: workspacePersona,
        aboutEntity,
      });
    capturedMessages = messages;
    // Document prompt-injection backstop. If a document in the context DEMANDS a specific output ("reply with
    // exactly X and nothing else"), a small model sometimes obeys despite the grounding rules + in-turn
    // reminder. Guard the stream: only when such a demand exists (rare) do we buffer — and only until the
    // answer is clearly longer than any demanded payload, then stream the rest normally. A short answer that
    // merely reproduces the payload is replaced with a safe decline. Precise (verify.answerObeysInjection
    // matches the DEMANDED string, not just "a short answer"), so a legitimate answer is never withheld.
    const verify = require('../verify');
    const demands = verify.injectionDemands(mergedContext);
    const raw = streamChat(messages, genOpts);
    if (!demands.length) { yield* raw; return; }
    const safeLen = Math.max(...demands.map(d => d.length)) + 24;   // beyond this the answer can't be a bare payload
    let buf = '', flushed = false;
    for await (const chunk of raw) {
      if (flushed) { yield chunk; continue; }
      buf += chunk;
      if (buf.trim().length > safeLen) { yield buf; flushed = true; }   // long enough to not be a pure payload
    }
    if (!flushed) {
      if (verify.answerObeysInjection(buf, demands)) { yield verify.INJECTION_REFUSAL; }
      else if (buf) { yield buf; }
    }
  }

  // Mark what actually reached the model, and explain anything that didn't.
  trace.used(mergedDocs.map(r => r.metadata.parentId));
  for (const c of trace.candidates) {
    if (c.used || c.dropped) continue;
    c.dropped = (typeof c.rerank === 'number' && c.rerank < 0)
      ? 'Scored as unrelated to the question'
      : 'Ranked below the documents that were used';
  }
  trace.step('answered',
    `Answered using ${mergedDocs.length} document(s) out of ${trace.candidates.length} considered.`);

  return {
    stream: documentStream(),
    genOpts,   // after draining the stream, genOpts.truncated is true if the model stalled mid-answer
    // The prompt behind this answer, available only after the stream drains — for the opt-in self-consistency
    // pass to re-ask the identical question. Returns null until then (and for non-document answers).
    getMessages: () => capturedMessages,
    outOfScope: false,
    bm25Strength,
    topRerankerScore,
    // Whether this answer came from the cross-lingual dense-trust path. The cross-encoder reranker is
    // cross-lingual-weak, so topRerankerScore is NOT a trustworthy confidence signal for these answers;
    // the caller passes this to the confidence blend so a correct cross-lingual answer is not mislabeled
    // low-confidence (or made to abstain) on an under-scored cross-encoder number.
    crossLingual: crossLingualMode,
    trace: trace.toJSON(),
    sources: mergedDocs.map(r => {
      const passages = conversationContext.docPassages?.get(r.metadata.parentId);
      // docPassages is appended in SERVE order, not document order, so a later-turn best-match window can sit
      // earlier in the document than an earlier-served one. Take the min start / max end over all served windows
      // so the viewer's highlight span (and the "% through document") can't invert (start > end). The exact
      // per-window ranges are carried separately in servedRanges below for faithfulness grading.
      const pStarts = (Array.isArray(passages) ? passages : []).map(p => p && p.start).filter(Number.isFinite);
      const pEnds   = (Array.isArray(passages) ? passages : []).map(p => p && p.end).filter(Number.isFinite);
      const passageStart = pStarts.length ? Math.min(...pStarts) : 0;
      const passageEnd   = pEnds.length ? Math.max(...pEnds) : 0;
      // When a document was served as MULTIPLE disjoint windows, the collapsed [start,end] span above
      // includes the gap between them — text the model never saw. Carry the exact served ranges so the
      // faithfulness check grades against only what the model read, not the gap. Omitted for the common
      // single-window case, where [start,end] already IS the served text.
      const servedRanges = (Array.isArray(passages) && passages.length > 1)
        ? passages.map(p => ({ start: p.start, end: p.end }))
        : null;
      // Per-citation confidence from the cross-encoder score already computed for this
      // document — the retrieval-honesty signal, surfaced so the reader can see how strongly
      // each source actually matched. null when the reranker didn't score it (disabled, or a
      // retry pass), so the UI simply shows no badge rather than a misleading one.
      const rr = rerankByParent.get(r.metadata.parentId);
      // Single-sourced band thresholds (shared with the answer-level confidence blend), so the per-citation
      // dot and the answer chip can never disagree on what a cross-encoder score means. Suppressed in
      // cross-lingual mode: the cross-encoder under-scores a genuine match in another language (the same
      // weakness that makes it unusable for ranking here), so its band would paint a correct citation as a
      // weak match — show no dot rather than a misleading one, exactly as when the reranker didn't score.
      const confidence = crossLingualMode ? null : require('../confidence').rerankBand(rr);
      // Cropped figures live on the PARENT document's metadata (chunk metadata doesn't carry
      // them). Surface a small, capped manifest with a serving URL so the UI can show the
      // actual figures on this cited source. Empty/absent when figure cropping is off.
      const parentMeta = idx.parentMap.get(r.metadata.parentId)?.metadata;
      const figList = Array.isArray(parentMeta?.figures) ? parentMeta.figures : [];
      const figures = figList.slice(0, 12).map(f => ({
        id: f.id, page: f.page ?? null, label: f.label || '', type: f.type || 'figure',
        url: figureUrl(f.id),
      }));
      return {
        id: r.metadata.parentId,
        source: path.basename(r.metadata.source),
        fileType: r.metadata.fileType,
        viewerLink: viewerLink(r.metadata.source),
        passageStart,
        passageEnd,
        docLength: r.metadata.docLength ?? 0,
        confidence,
        rerankScore: (typeof rr === 'number') ? Math.round(rr * 100) / 100 : null,
        // A short preview of the exact passage that grounded the answer, so the UI can show it on a
        // citation hover/tap without opening the full document. Whitespace-collapsed and capped.
        snippet: makeSnippet(r.content),
        ...(r.metadata.credibility ? { credibility: r.metadata.credibility } : {}),
        ...(servedRanges ? { servedRanges } : {}),
        ...(figures.length ? { figures } : {}),
      };
    })
  };
};

// ── Private content-assembly helpers ─────────────────────────────────────────

const _retryContent = (fullText, standaloneQuery, query, isFollowUp, docId, ctx, mergedDocsCount = 0, attemptNumber = 2, idx = state) => {
  const fullLower = boundedLower(fullText);   // the window loop below is bounded to KEYWORD_SCAN_MAX_CHARS
  // Scale window by document size — large documents need proportionally more context.
  // On attempt 3, also double the window as a last resort.
  const baseWindow = largeDocWindow(fullText.length);
  const WINDOW = attemptNumber >= 3 ? baseWindow * 2 : baseWindow;
  const STEP   = Math.floor(passageSize() / 4); // step always based on base size
  const expandedTokens = [...new Set(tokenize(standaloneQuery))]
    .filter(t => t.length > 2 && (idx.corpusIdf.get(t) ?? 0) > SPECIFIC_IDF_MIN);
  const excludePos = ctx.docExcludePos?.get(docId);

  const retryEndingIntent = ENDING_INTENT_RE.test(query);
  const retryStartPos = (retryEndingIntent && isFollowUp) ? Math.floor(fullText.length * 0.80) : 0;

  // Cache window scores — retry may be called twice (attempt 2 + attempt 3)
  // on the same document. Key includes startPos so ending-intent searches
  // (restricted to final 20%) don't collide with full-document searches.
  const retryCacheKey = `retry:${docId}:${retryStartPos}:${WINDOW}:${expandedTokens.slice().sort().join(',')}`;
  if (!ctx.windowScoreCache) ctx.windowScoreCache = new Map();

  let windowScores = ctx.windowScoreCache.get(retryCacheKey);
  if (!windowScores) {
    // IDF-weighted sliding-window scan from the (possibly offset) start, ranked best-first.
    windowScores = scanWindowsRanked(fullLower, expandedTokens, { window: WINDOW, step: STEP, start: retryStartPos, idf: idx.corpusIdf });
    setBoundedCache(ctx.windowScoreCache, retryCacheKey, windowScores);
  }

  const bestRetryScore = windowScores[0]?.[1] ?? 0;
  if (bestRetryScore < 5 && mergedDocsCount > 0) return null;

  const chosen = excludePos != null
    ? windowScores.find(([pos]) => Math.abs(pos - excludePos) > WINDOW) || windowScores[0]
    : windowScores[0];
  // windowScores is empty only for a doc with no extractable text (e.g. an image-only
  // PDF). If that doc is also the first candidate the < 5 early-return above doesn't
  // fire, so guard here rather than dereferencing an undefined window.
  if (!chosen) return null;

  if (!ctx.docExcludePos) ctx.docExcludePos = new Map();
  ctx.docExcludePos.set(docId, chosen[0]);
  // Clamp the recorded range to the real text length: the content returned is slice(start, start+WINDOW),
  // which String.slice already clamps, so an unclamped end would over-report the citation span (viewer
  // highlight past EOF, "% through document" over 100%) for a window that runs past the end of the document.
  const end = Math.min(fullText.length, chosen[0] + WINDOW);
  ctx.docPassages.set(docId, [{ start: chosen[0], end }]);
  ctx.docReadPos.set(docId, end);
  if (DEBUG) console.log(`  📖 Retry density-search: char ${chosen[0]} (score ${chosen[1].toFixed(1)})`);
  return fullText.slice(chosen[0], chosen[0] + WINDOW);
};

const _passageContent = (fullText, getFullLower, matchedChunkIds, docId,
  query, standaloneQuery, isFollowUp, docNameTokens, ctx, baseName, focusMode = false, idx = state, mergedDocsCount = 1) => {

  const served = ctx.docPassages.get(docId) || [];

  if (isFollowUp && served.length > 0) {
    return _followUpPassage(fullText, getFullLower(), served, passageSize(), query, standaloneQuery,
      docNameTokens, docId, ctx, baseName, focusMode, idx, mergedDocsCount);
  }

  const passageResult = getPassageContext(docId, matchedChunkIds, fullText, 12000, idx);

  // In focus mode the user has manually selected this document — trust the
  // FAISS chunk position directly without keyword validation. Validation was
  // designed to catch FAISS semantic drift across a large corpus; when the
  // user has already scoped the search to one document it only causes misses.
  if (focusMode && passageResult) {
    if (DEBUG) console.log(`  📖 Focus mode — serving passage at char ${passageResult.ranges[0]?.[0]} for ${baseName}`);
    ctx.docPassages.set(docId, passageResult.ranges.map(([s, e]) => ({ start: s, end: e })));
    ctx.docReadPos.set(docId, Math.max(...passageResult.ranges.map(([, e]) => e)));
    return passageResult.text;
  }

  // First query: validate passage contains query keywords.
  // Use only the top 2 highest-IDF terms — requiring ALL specific keywords
  // (e.g. "nextcloud", "detail", "great") causes valid passages to fail
  // when the query contains style words that happen to have high IDF.
  // Also include all meaningful query tokens as fallback validation keywords
  // so queries like "sons of light and darkness" aren't blocked by IDF filtering.
  const specificKws   = extractSpecificKeywords(standaloneQuery, 5, idx.corpusIdf);
  const allQueryKws   = [...new Set(tokenize(standaloneQuery))].filter(t => t.length > 2);
  const validationKws = (specificKws.length > 0 ? specificKws : allQueryKws).slice(0, 2);
  const passageLower  = passageResult?.text.toLowerCase() ?? '';
  const passageValid  = passageResult && validationKws.length > 0 &&
    validationKws.some(kw => passageLower.includes(kw));  // ANY match, not ALL

  if (passageValid) {
    const overviewIntent   = OVERVIEW_INTENT_RE.test(query);
    const hasOnlyDocNameTerms = validationKws.length > 0 && validationKws.every(kw => docNameTokens.has(kw));
    const logLabel = (overviewIntent && hasOnlyDocNameTerms && passageResult.ranges[0]?.[0] > fullText.length * 0.1)
      ? `📖 Overview query — serving dense passage at char ${passageResult.ranges[0][0]}`
      : `📖 Passage retrieval: ${passageResult.ranges.length} passage(s)`;
    if (DEBUG) console.log(`  ${logLabel} for ${baseName}`);

    ctx.docPassages.set(docId, passageResult.ranges.map(([s, e]) => ({ start: s, end: e })));
    ctx.docReadPos.set(docId, Math.max(...passageResult.ranges.map(([, e]) => e)));
    return passageResult.text;
  }

  // Validation failed — keyword-location fallback.
  // For very large documents, use a proportionally larger window so the LLM gets enough
  // context — a fixed small window is far too sparse a slice of a multi-hundred-KB document.
  const scanWindow = largeDocWindow(fullText.length);
  if (passageResult && DEBUG) console.log(`  📖 Passage validation failed — falling back to keyword-location for ${baseName}`);
  return _keywordScan(fullText, getFullLower(), validationKws, docId, ctx, baseName, scanWindow);
};

// Drift gate for a vague continuation ("tell me more"), which advances a document sequentially with no keyword
// target. When MORE THAN ONE document is in play, a CO-SOURCE (not the thread's primary document) that advances
// onto content sharing NONE of the conversation's specific-topic vocabulary has drifted off the thread — serving
// it lets an unrelated large document hijack the answer (the failure where "tell me more" about one topic
// returns an unrelated passage from a big co-retrieved document). Returns true to SKIP that document's forward
// content so the continuation stays on the primary. The primary document and single-document conversations are
// never gated (their forward content is the continuation the user asked for), and with no topic terms to judge
// (an un-rewritten vague query) it never gates — so it can only ever help. Pure and language-agnostic: it
// compares tokenized vocabulary by substring (the same test passage validation uses), not any one language.
const continuationDrifted = (chunkLower, specificTopicTerms, isPrimaryDoc, otherDocCount) => {
  if (isPrimaryDoc || !(otherDocCount > 0)) return false;   // never gate the primary, or when it is the only document in play
  if (!Array.isArray(specificTopicTerms) || specificTopicTerms.length === 0) return false;   // no topic to judge → don't gate
  for (const t of specificTopicTerms) if (t && chunkLower.includes(t)) return false;   // shares topic vocabulary → on-topic
  return true;                                                                         // off-topic co-source → drifted
};

const _followUpPassage = (fullText, fullLower, served, PASSAGE_SIZE, query, standaloneQuery,
  docNameTokens, docId, ctx, baseName, focusMode = false, idx = state, mergedDocsCount = 1) => {

  const lastEnd   = Math.max(...served.map(r => r.end));
  // Scale window for large documents so the LLM gets meaningful context.
  const effectivePassageSize = largeDocWindow(fullText.length);

  // Small documents that fit within one passage — always serve the full document.
  // Trying to advance sequentially through a 4K doc produces tiny tail fragments.
  if (fullText.length <= effectivePassageSize) {
    const content = fullText;
    served.push({ start: 0, end: fullText.length });
    ctx.docPassages.set(docId, served);
    ctx.docReadPos.set(docId, fullText.length);
    if (DEBUG) console.log(`  📖 Follow-up: small doc — serving full text (${fullText.length} chars) of ${baseName}`);
    return content;
  }

  // Specific (topic-bearing) terms of the follow-up, drawn the same way as extractSpecificKeywords: strip
  // GENERIC_WORDS first so function/meta words ("talk", "else", "about") never count as a locating or drift-gate
  // term, then keep only corpus-distinctive tokens. A truly vague continuation yields none on either query, which
  // is exactly what routes it to the sequential-advance path and leaves the drift gate nothing query-derived to
  // (mis)judge.
  const originalSpecific = [...new Set(tokenize(query))]
    .filter(t => t.length > 2 && !GENERIC_WORDS.has(t) && (idx.corpusIdf.get(t) ?? 0) > SPECIFIC_IDF_MIN);
  const expansionSpecific = [...new Set(tokenize(standaloneQuery))]
    .filter(t => t.length > 2 && !GENERIC_WORDS.has(t) && (idx.corpusIdf.get(t) ?? 0) > SPECIFIC_IDF_MIN && !docNameTokens.has(t));
  // Fallback: use all meaningful raw tokens when IDF filtering removes everything.
  // This matters in focus mode where the user asks about terms that are common
  // within the selected document (e.g. "sons", "light", "darkness" in the Bible).
  const rawQueryTokens = [...new Set(tokenize(query))].filter(t => t.length > 2 && !docNameTokens.has(t));
  const scanTokens = originalSpecific.length > 0 ? originalSpecific :
    expansionSpecific.length > 0 ? expansionSpecific :
    rawQueryTokens.length > 0 ? rawQueryTokens : [];
  const hasSpecificExpanded = scanTokens.length >= 1;

  // Reference follow-up — no genuine locating keywords (raw or rewritten), not a
  // vague continuation, and not focus-scoped to a single document. The topic is
  // already established in the conversation, so re-serve the previously shown
  // content for this document and let the model recap/continue from it. Without
  // this, follow-ups like "what happened in the end?" or "what about that?" fall
  // into a common-word best-match that lands on an irrelevant window and yield
  // "Unfortunately..." even when the answer was shown one turn earlier. Focus
  // mode is excluded because corpus-common terms (e.g. "sons"/"light" in the
  // Bible) are still meaningful locators within one selected document.
  const hasSpecific  = originalSpecific.length > 0 || expansionSpecific.length > 0;
  const endingIntent = ENDING_INTENT_RE.test(query);
  let endingAdvance  = false;   // ending-intent whose conclusion wasn't discussed yet -> advance sequentially

  // Reference/recap follow-up. Re-serve the previously shown content when the
  // follow-up carries no genuine new-topic signal (no specific keywords), or is an
  // ending-intent question whose conclusion was ALREADY discussed last turn. For an
  // ending-intent question whose conclusion has NOT yet been discussed (e.g. the
  // first question was about the beginning), advance sequentially toward the end
  // rather than re-serving a passage that doesn't contain it. Deciding recap vs
  // advance from the PRIOR ANSWER's content is reliable; locating the conclusion by
  // scanning the document's death language was not (multi-topic docs discuss death
  // throughout, not only at the ending).
  if (!focusMode && !isVagueContinuation(query, idx) &&
      (!hasSpecific || endingIntent)) {
    let doRecap = !endingIntent;                                  // no-keyword reference -> recap
    if (endingIntent) {
      // Did the passage we already showed contain the ending? Count DISTINCT
      // death-specific terms (whole-word) in the served content. "crash"/"ended"
      // appear throughout many narratives, so only death language counts; and
      // whole-word matching avoids substring noise (e.g. "dies" inside "studies").
      const servedTokens = new Set();
      for (const r of served) for (const x of tokenize(fullLower.slice(r.start, r.end))) servedTokens.add(x);
      let deathHits = 0;
      for (const dt of DEATH_TERMS) if (servedTokens.has(dt)) deathHits++;
      doRecap = deathHits >= 2;                                   // ending already shown -> recap; else advance
    }
    if (doRecap) {
      const rStart = served.length ? Math.min(...served.map(r => r.start)) : 0;
      const rEnd   = served.length ? Math.max(...served.map(r => r.end))   : 0;
      if (rEnd > rStart) {
        ctx.docPassages.set(docId, served);
        ctx.docReadPos.set(docId, rEnd);
        if (DEBUG) console.log(`  📖 Reference follow-up (${endingIntent ? 'ending intent' : 'no locating keywords'}) — re-serving shown content ${rStart}–${rEnd} of ${baseName}`);
        return fullText.slice(rStart, rEnd);
      }
    } else {
      endingAdvance = true;                                        // fall through to sequential advance
      if (DEBUG) console.log(`  📖 Ending-intent: conclusion not yet discussed — advancing sequentially from ${lastEnd} of ${baseName}`);
    }
  }

  let nextStart;
  let sequentialAdvance = false;   // true only on the blind vague-continuation advance below — the only path the drift gate judges

  if (hasSpecificExpanded && !isVagueContinuation(query, idx) && !endingAdvance) {
    // Best-match scan — cache window scores so repeated follow-ups on the
    // same document with the same token set skip the O(document_length) scan.
    // Include the window size in the key (parity with _retryContent): the cached scores are
    // computed at PASSAGE_SIZE, which is a live Setting, so changing passageSize mid-conversation
    // must not reuse scores computed at the old width off this persistent conversation cache.
    const cacheKey = `${docId}:${PASSAGE_SIZE}:${scanTokens.slice().sort().join(',')}`;
    if (!ctx.windowScoreCache) ctx.windowScoreCache = new Map();

    let windowScores = ctx.windowScoreCache.get(cacheKey);
    if (!windowScores) {
      // IDF-weighted sliding-window scan at the passage width, ranked best-first.
      windowScores = scanWindowsRanked(fullLower, scanTokens, { window: PASSAGE_SIZE, idf: idx.corpusIdf });
      setBoundedCache(ctx.windowScoreCache, cacheKey, windowScores);
      if (DEBUG) console.log(`  📖 Window scores computed and cached for ${baseName} (${windowScores.length} windows)`);
    } else {
      if (DEBUG) console.log(`  📖 Window scores cache hit for ${baseName}`);
    }

    // Pick best window not already served
    const best = windowScores.find(([pos]) =>
      !served.some(r => pos >= r.start - effectivePassageSize && pos <= r.end + effectivePassageSize)
    );
    if (best) {
      nextStart = best[0];
      if (DEBUG) console.log(`  📖 Best-match follow-up: char ${nextStart} (score ${best[1].toFixed(1)}) of ${baseName}`);
    } else {
      nextStart = lastEnd + 1;
    }
  } else {
    // Vague continuation ("tell me more", "go on"), an ending-intent question
    // whose conclusion wasn't discussed yet, or a no-keyword follow-up the recap
    // pre-check didn't catch — advance sequentially from the last read position so
    // the user gets the NEXT part of the document. Never best-match on raw common
    // words ("tell"/"more"): that jumps to wherever they cluster, unrelated to the
    // narrative.
    sequentialAdvance = true;   // the one path that advances blind — the drift gate judges only this
    if (lastEnd >= fullText.length - 200) {
      // Only loop once we've actually reached the end. The old 80% threshold looped
      // early and skipped the final ~20% of the document — exactly where an ending /
      // conclusion lives, so "how did it end?" style follow-ups never saw it.
      nextStart = 0;
      if (DEBUG) console.log(`  📖 Sequential follow-up: restart (reached end) of ${baseName}`);
    } else {
      nextStart = lastEnd + 1;
      if (DEBUG) console.log(`  📖 Sequential follow-up: advance from ${lastEnd} of ${baseName}`);
    }
  }

  let nextEnd = Math.min(fullText.length, nextStart + effectivePassageSize);
  const snapEnd = fullText.indexOf('\n\n', nextEnd);
  if (snapEnd > 0 && snapEnd < nextEnd + 500) nextEnd = snapEnd;
  // maxSafe prevents serving partial sentences at the very end — but for small
  // documents it can clip to near-zero content. Skip it when doc fits in one window.
  if (fullText.length > effectivePassageSize) {
    const maxSafe = Math.floor(fullText.length * 0.95);
    // Clip a mid-document window back from a partial trailing sentence — but NOT when the window already
    // reaches the true end (the final tail, which is what the user asked for), AND not when the window START is
    // already past maxSafe. Without the second guard, once sequential reading advances into the last ~5% the
    // clip pulls nextEnd back to maxSafe <= nextStart, the window collapses and restarts from 0, so the final
    // ~5% (where the ending/conclusion lives) is NEVER served. Serving [nextStart, len] there is correct.
    if (nextEnd > maxSafe && nextEnd < fullText.length && nextStart < maxSafe) nextEnd = maxSafe;
  }
  // If nextStart is at or past the end (tiny doc already fully served), restart from 0
  if (nextStart >= fullText.length - 100 || nextStart >= nextEnd) {
    nextStart = 0;
    nextEnd = Math.min(fullText.length, effectivePassageSize);
    if (DEBUG) console.log(`  📖 Document restart: fully served, looping from start`);
  }
  if (nextStart > nextEnd) nextStart = Math.max(0, nextEnd - effectivePassageSize);

  // A co-source that advanced BLINDLY past its on-topic region (only the sequential vague-continuation path, not a
  // best-match window that already scored for the topic) can land on unrelated content. When the thread has other
  // documents to continue, skip this one so it can't hijack the answer — the primary document stays, and if
  // nothing else remains the empty-retrieval fallback recaps it. The gate judges against the IDF-SPECIFIC topic
  // terms (GENERIC_WORDS already stripped, so never raw request-words like "tell"/"more"). A vague continuation
  // carries none of its own, so fall back to the CONVERSATION's established topic — the distinctive terms of the
  // recent turns — which is exactly what the user is continuing. That keeps the gate effective for "tell me more"
  // and "what else does it talk about" alike, instead of going dark whenever the query itself has no terms. The
  // primary and single-document cases are never gated.
  let gateTopicTerms = originalSpecific.length > 0 ? originalSpecific : expansionSpecific;
  if (gateTopicTerms.length === 0 && Array.isArray(ctx.history) && ctx.history.length > 0) {
    const recentThread = ctx.history.slice(-4).map(h => (h && h.content) || '').join(' ');
    gateTopicTerms = extractSpecificKeywords(recentThread, 6, idx.corpusIdf);
  }
  const isPrimaryDoc = docId === (ctx.allowedDocIds || [])[0];
  if (sequentialAdvance && continuationDrifted(fullLower.slice(nextStart, nextEnd), gateTopicTerms, isPrimaryDoc, mergedDocsCount)) {
    if (DEBUG) console.log(`  📖 Follow-up drift gate — ${baseName} advanced off the thread's topic; skipping so the continuation stays on the primary document`);
    return null;
  }

  const content = fullText.slice(nextStart, nextEnd);
  served.push({ start: nextStart, end: nextEnd });
  ctx.docPassages.set(docId, served);
  ctx.docReadPos.set(docId, nextEnd);
  if (DEBUG) console.log(`  📖 Follow-up passage: chars ${nextStart}–${nextEnd} of ${baseName}`);
  return content;
};

const _keywordScan = (fullText, fullLower, validationKws, docId, ctx, baseName, WINDOW = passageSize()) => {
  const { pos: bestPos, score: bestScore } = scanWindowsMax(fullLower, validationKws, { window: WINDOW });
  const snap = fullText.lastIndexOf('\n\n', bestPos);
  const startPos = (snap > bestPos - 500 && snap >= 0) ? snap + 2 : bestPos;
  // Clamp the recorded range to the real text length (the served content is already clamped by slice), so a
  // window running past EOF can't over-report the citation span or push "% through document" over 100%.
  const end = Math.min(fullText.length, startPos + WINDOW);
  ctx.docPassages.set(docId, [{ start: startPos, end }]);
  ctx.docReadPos.set(docId, end);
  if (DEBUG) console.log(`  📖 Keyword-location: char ${startPos} (score ${bestScore}) for ${baseName}`);
  return fullText.slice(startPos, startPos + WINDOW) || fullText.slice(0, WINDOW);
};

const _keywordLocationContent = (fullText, query, docId, ctx, baseName, idx = state) => {
  const fullLower   = boundedLower(fullText);   // the window loop below is bounded to KEYWORD_SCAN_MAX_CHARS
  const WINDOW      = passageSize();
  const specificKws = extractSpecificKeywords(query, 5, idx.corpusIdf);
  const allKws      = specificKws.length > 0 ? specificKws : extractKeywords(query, 8, idx.corpusIdf);
  const excludePos  = ctx.docExcludePos?.get(docId);
  // Shared ranked scan; it skips windows near excludePos and falls back to the unfiltered scan if that
  // would leave nothing, so a second pass on the same document lands on a different region.
  const windowScores = scanWindowsRanked(fullLower, allKws, { window: WINDOW, excludePos });
  const [bestPos, bestScore] = windowScores[0] || [0, 0];
  const snapStart = fullText.lastIndexOf('\n\n', bestPos);
  const startPos  = (snapStart > bestPos - 500 && snapStart >= 0) ? snapStart + 2 : bestPos;

  if (!ctx.docExcludePos) ctx.docExcludePos = new Map();
  ctx.docExcludePos.set(docId, bestPos);
  // Clamp the recorded range to the real text length (the served content is already clamped by slice), so a
  // window running past EOF can't over-report the citation span or push "% through document" over 100%.
  const end = Math.min(fullText.length, startPos + WINDOW);
  ctx.docPassages.set(docId, [{ start: startPos, end }]);
  ctx.docReadPos.set(docId, end);
  if (DEBUG) console.log(`  📄 Keyword-location: char ${startPos} (score ${bestScore}) of ${baseName}`);
  return fullText.slice(startPos, startPos + WINDOW);
};

module.exports = { searchDocuments, ENDING_INTENT_RE, orderContinuationDocs, continuationDrifted, extractNamedTerms, isConnectiveTwoSided, novelEntityGate };
