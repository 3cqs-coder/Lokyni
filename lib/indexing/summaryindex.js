'use strict';
// Document summaries — the first level of the collapsed-tree hierarchical index.
//
// At index time this writes a short summary of a document and returns it as a labeled block to
// append to the document's indexed text. Because it rides in the document's `content`, it flows
// through the existing chunk → embed → retrieve → cite path with no changes to any of them: a
// broad question ("what is this about", "what are the themes") matches the summary chunk by
// embedding, and the model then reads a coherent, grounded synthesis of the document rather
// than a stray fragment. It cites the same document, so no new source type appears.
//
// Reuses the existing summarizer (lib/summarize.summarizeToString) — no new model plumbing —
// and is bounded and safe: off by default, best-effort (any failure appends nothing and
// indexing proceeds on the raw text), and cached by content hash so an unchanged document is
// summarized once.

const cfg = () => require('../config');

// The label makes the block obvious in a retrieved passage and marks it as a generated
// synthesis (not verbatim source), keeping the grounding story honest.
const BLOCK_HEADER = 'Document summary (generated from this document):';
const MIN_USEFUL = 40;   // a one-liner isn't worth embedding as its own node

// Build the summary block for a document's extracted text. `content` is the text to summarize
// (extraction, plus any visual-ingest block), `fileName` names it in the prompt. Returns the
// labeled block, or '' when disabled, too short, unconfigured to summarize, or on any failure.
// `dir` (optional): the workspace cache directory to summarize into. Omitted for the active
// workspace; set when warming a NON-active workspace so its summary caches in that workspace's dir.
const summaryBlockFor = async (content, fileName = '', dir = null) => {
  const c = cfg();
  if (!c.useDocumentSummaries) return '';
  const text = typeof content === 'string' ? content : '';
  if (text.trim().length < MIN_USEFUL) return '';

  const cache = require('../summarycache');
  // Fold the EFFECTIVE summary model into the key so switching it re-summarizes rather than reusing an
  // unchanged document's summary from the previous model. Falls back to the default chat model, since an unset
  // documentSummaryModel means summaries use that — so changing it must invalidate too.
  const key = cache.keyFor(text, c.documentSummaryModel || c.LLM_MODEL || '');
  const cached = cache.get(key, dir);
  if (cached !== null) {
    if (c.DEBUG) console.log(`   ↩️  Summary cache hit: ${require('path').basename(fileName || 'document')}`);
    return cached;
  }

  try {
    const { summarizeToString } = require('./../summarize');
    const opts = c.documentSummaryModel ? { model: c.documentSummaryModel } : {};
    // summarizeToString reads entry.content and caps it internally to the context window.
    const r = await summarizeToString({ content: text, metadata: { source: fileName } }, opts);
    const summary = (r && r.summary ? String(r.summary) : '').trim();
    if (summary.length < MIN_USEFUL) return '';
    const block = `${BLOCK_HEADER}\n${summary}`;
    cache.set(key, block, dir);
    if (c.DEBUG) console.log(`   🧭 Summarized ${require('path').basename(fileName || 'document')} (${summary.length} chars)`);
    return block;
  } catch (e) {
    if (c.DEBUG) console.log(`   🧭 Summary skipped for ${require('path').basename(fileName || 'document')}: ${e.message}`);
    return '';
  }
};

module.exports = { summaryBlockFor, BLOCK_HEADER };
