'use strict';
const crypto  = require('crypto');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { Document } = require('@langchain/core/documents');
const state = require('../state');
const { isHighSurrogate } = require('../surrogate');

// Preferred chunk sizes, in characters. These are TARGETS the recursive splitter aims for; the true
// safety ceiling is derived per document from the embedding model's token window (see maxChunkChars).
const CHUNK_TARGET = 1500;
// Log files are the extreme case for chunk count: they are append-only, line-oriented, and often huge,
// so at the 1500-char target a single large log becomes tens of thousands of tiny chunks — minutes of
// embedding and a heavy memory/index footprint that can stall the event loop on later work. A log line
// carries little standalone meaning, so a coarser target groups many lines per chunk and cuts the chunk
// count several-fold with no real loss for log search: the reranker and the passage window still locate
// the exact lines within a hit.
const LOG_CHUNK_TARGET = 2500;

// Reserve a few tokens for the special tokens the model adds around the input (for example [CLS]/[SEP]),
// so a chunk plus those markers still fits the window.
const TOKEN_MARGIN = 64;

// The hard per-chunk character ceiling, derived from the configured embedding model's token window.
// A single oversized chunk is rejected by the embedder ("input length exceeds the context length") and
// would be dropped from dense search, so this must never let a chunk exceed the window for ANY content.
// The key guarantee: a token never spans fewer than one character, so a chunk of N characters is at most
// N tokens in every language and tokenizer. Capping the character count below (window − margin) therefore
// bounds the token count below the window even for the dense, space-free extremes — CJK (about one token
// per character), long numeric or base64 runs, and minified data. It is read live so switching the model
// (which hot-reloads config) resizes chunks on the next index without a restart.
const maxChunkChars = () => {
  const tokens = require('../config').EMBEDDING_CONTEXT_TOKENS || 2048;
  // The ceiling is (window − margin) characters; a floor must NEVER raise it above that, or the guarantee
  // breaks. A small configured window (the config minimum is 128 tokens) leaves only ~64 characters, and for
  // a one-token-per-character script (CJK) a 256-char floor would be 256 tokens — past the window — so the
  // chunk would be rejected by the embedder and dropped from dense search. Clamp to at least 1 instead.
  return Math.max(1, tokens - TOKEN_MARGIN);
};

// The splitter target for a document, never above the safety ceiling (a target larger than the ceiling
// would just be hard-cut back down, producing ragged pieces).
const chunkTargetForExt = (ext, ceiling) =>
  Math.min(ceiling, String(ext).toLowerCase() === 'log' ? LOG_CHUNK_TARGET : CHUNK_TARGET);

// Split any oversized chunk into smaller pieces, preferring paragraph then sentence then word
// boundaries so the split doesn't land mid-word. `maxChars` is the per-document safety ceiling.
const splitOversized = (text, maxChars) => {
  if (text.length <= maxChars) return [text];
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // Prefer the last paragraph break, then sentence end, then whitespace.
    let cut = window.lastIndexOf('\n\n');
    if (cut < maxChars * 0.5) cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('.\n'),
      window.lastIndexOf('! '), window.lastIndexOf('? '));
    if (cut < maxChars * 0.5) cut = window.lastIndexOf(' ');
    if (cut < maxChars * 0.5) cut = maxChars;   // no good boundary — hard cut
    // Never cut between a UTF-16 surrogate pair, or a hard cut on CJK/base64/minified text
    // with no break point would emit a lone surrogate into the embedded text.
    if (cut > 0 && cut < rest.length && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    // Structural safety: always advance by at least one character so the loop can never spin forever (which
    // would hang the lifecycle lock). Unreachable at the current token floor — this just makes the guarantee
    // self-contained rather than dependent on maxChunkChars()'s range being defined elsewhere.
    if (cut < 1) cut = 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter(s => s.length > 0);
};

const enforceChunkLimit = (chunks, maxChars) => chunks.flatMap(text => splitOversized(text, maxChars));

const semanticSplitDocument = async (doc, targetChildMap, targetPassageMap = state.passageMap) => {
  const ext      = doc.metadata.fileType.toLowerCase();
  const fullText = doc.content;
  const parentId = doc.metadata.docId;

  // ── Split into chunks ──────────────────────────────────────────────────────
  // A recursive character splitter for every type. For Markdown it uses markdown-aware
  // separators (headings, code-fence ends, thematic breaks, then paragraph/line/word), so a
  // document is split on its structure while honoring the size target. Crucially the splitter
  // returns RAW substrings of the source, so a chunk's position resolves against the parent text
  // (for citation offsets) and fenced code / HTML blocks are embedded verbatim — unlike a
  // token-reconstruction approach, which strips heading and emphasis syntax (breaking offset
  // lookup) and drops non-inline blocks (code, HTML) from the embedded text.
  const ceiling  = maxChunkChars();
  const chunkSize = chunkTargetForExt(ext, ceiling);
  const overlap   = Math.min(200, Math.floor(chunkSize / 4));   // keep overlap sane for a small window
  const splitter = ext === 'md'
    ? RecursiveCharacterTextSplitter.fromLanguage('markdown', { chunkSize, chunkOverlap: overlap })
    : new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap: overlap });
  const splitDocs = await splitter.splitDocuments([new Document({ pageContent: fullText || '', metadata: doc.metadata })]);

  // ── Enforce the embedding size ceiling ─────────────────────────────────────
  // Applies to every path: one oversized chunk fails the entire embedding batch.
  const rawChunks = enforceChunkLimit(splitDocs.map(d => d.pageContent || ''), ceiling);

  // ── Locate each chunk in the parent document ───────────────────────────────
  // Scan forward from searchFrom so overlapping chunks (due to chunkOverlap) resolve to the
  // correct instance rather than always matching the first.
  let searchFrom = 0;

  // A for-loop (not .map) so a very large document — a 16 MB text layer can split into thousands of chunks —
  // can yield to the event loop periodically while locating each chunk, rather than running the whole loop as
  // one synchronous burst that starves concurrent live queries. `idx` is the index into the FILTERED list, so
  // the childId derivation sha256(parentId + idx) is unchanged.
  const filtered = rawChunks.filter(text => text && text.trim().length > 0);
  const out = [];
  for (let idx = 0; idx < filtered.length; idx++) {
    const text = filtered[idx];
    const childId = crypto.createHash('sha256').update(parentId + idx).digest('hex');
    targetChildMap.set(childId, parentId);

    // Primary: find the chunk starting from the current cursor position. This correctly
    // handles overlapping chunks and repeated text.
    let startChar = fullText.indexOf(text, searchFrom);

    // Fallback 1: search from start (handles cases where the cursor overshot).
    if (startChar === -1) startChar = fullText.indexOf(text);

    // Fallback 2: search by first 120 chars (handles whitespace-normalization differences
    // between the splitter output and the raw source text).
    if (startChar === -1) {
      const searchKey = text.slice(0, 120);
      startChar = fullText.indexOf(searchKey, searchFrom);
      if (startChar === -1) startChar = fullText.indexOf(searchKey);
    }

    const endChar = startChar >= 0 ? startChar + text.length : -1;
    // Advance the cursor by this chunk's NON-overlapping stride (its length minus the splitter overlap), so
    // the next search starts near where the next chunk actually begins — not 1 char in, which would let a
    // later chunk bind to an earlier identical passage when a document repeats chunk-sized text. The next
    // (overlapping) chunk still begins at or after this point, so it is found; if a short/sub-split chunk
    // ever makes this overshoot, the indexOf fallbacks above still resolve it. Never moves backwards.
    if (startChar >= 0) searchFrom = startChar + Math.max(1, text.length - overlap);

    targetPassageMap.set(childId, { startChar, endChar });
    out.push(new Document({ pageContent: text, metadata: { ...doc.metadata, childId, parentId } }));

    // Yield every 1024 chunks so a many-thousand-chunk document doesn't block the loop (no-op for small docs).
    if ((idx & 1023) === 1023) await new Promise((r) => setImmediate(r));
  }
  return out;
};

module.exports = { semanticSplitDocument, maxChunkChars, CHUNK_TARGET };
