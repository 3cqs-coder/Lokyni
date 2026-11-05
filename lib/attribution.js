'use strict';
// Per-citation attribution scoring: a deterministic, reference-free proxy for whether a citation is doing
// real work. Each answer sentence is matched against the exact text each cited source served, by content-token
// containment. A sentence that no cited source supports is unattributed; a cited source that supports no
// sentence is unused. From those two counts:
//
//   precision = attributed sentences / scorable sentences   (how much of the answer is traceable to a citation)
//   recall    = cited sources that supported something / attributable sources   (how many citations earned their place)
//   F1        = harmonic mean of the two
//
// It is a heuristic, not a judge — word overlap can miss a paraphrase and can match boilerplate — so it is a
// TREND metric for the Quality evaluation panel, never a claim about truth and never shown on a live answer.
// Everything here is pure, synchronous, bounded, and language-agnostic (the shared tokenizer handles accents
// and scripts written without spaces). Never throws; returns null when there is nothing to attribute.

const { tokenize, isContentToken } = require('./retrieval/keywords');

const MAX_ANSWER_CHARS = 20000;
const MAX_SOURCE_CHARS = 20000;   // enough for the served passage(s); bounds the per-question tokenizing work
const MAX_SENTENCES = 400;
const MAX_SOURCE_TOKENS = 6000;
const MAX_SOURCES = 12;           // answers cite at most 12 sources, so extra context cannot change the score
const MIN_SENTENCE_TOKENS = 2;
const MIN_MATCHED_TOKENS = 2;
const SUPPORT_THRESHOLD = 0.35;   // share of a sentence's content tokens that must appear in the source

// The exact text a source served the model: its provided ranges when it was served in disjoint windows, else
// its passage span, else the whole document. Web sources have no document entry, so they use their own text.
// Bounded; returns '' when no text can be resolved.
const servedTextOf = (source, bundle) => {
  if (!source) return '';
  try {
    const entry = bundle && bundle.parentMap ? bundle.parentMap.get(source.id) : null;
    if (entry && entry.content) {
      if (Array.isArray(source.servedRanges) && source.servedRanges.length) {
        return source.servedRanges
          .map((r) => entry.content.slice(r.start, r.end))
          .join('\n\n')
          .slice(0, MAX_SOURCE_CHARS);
      }
      const start = Number.isFinite(source.passageStart) ? source.passageStart : 0;
      const end = (Number.isFinite(source.passageEnd) && source.passageEnd > start) ? source.passageEnd : entry.content.length;
      return entry.content.slice(start, end).slice(0, MAX_SOURCE_CHARS);
    }
    return String(source.text || source.snippet || '').slice(0, MAX_SOURCE_CHARS);
  } catch { return ''; }
};

// Split an answer into sentence-ish units. A blank line is always a boundary; terminal punctuation ends a
// sentence whether or not a space follows (CJK and other scripts do not require one). Bounded.
const sentencesOf = (answer) => {
  const text = String(answer || '').slice(0, MAX_ANSWER_CHARS);
  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    // A Latin sentence ends at . ! ? only when whitespace (or the end) follows, so "7.5" and "e.g." do not
    // split mid-token. CJK punctuation ends a sentence with no space required.
    const parts = para.split(/(?<=[。！？])\s*|(?<=[.!?])(?=\s|$)\s*|\n+/u);
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      out.push(s);
      if (out.length >= MAX_SENTENCES) return out;
    }
  }
  return out;
};

const contentTokens = (text) => {
  const set = new Set();
  for (const t of tokenize(text)) {
    if (!isContentToken(t)) continue;
    set.add(t);
    if (set.size >= MAX_SOURCE_TOKENS) break;
  }
  return set;
};

// Score one answer against its cited sources. Returns null when there is nothing to score (no scorable
// sentence or no attributable source). Otherwise:
//   { f1, precision, recall, sentences, attributed, sourceCount, usedCount, unused:[labels], perSource:[...] }
const attribute = (answer, sources, idx) => {
  try {
    const bundle = idx || require('./state');
    const list = (Array.isArray(sources) ? sources : []).slice(0, MAX_SOURCES)
      .map((s, i) => {
        const text = servedTextOf(s, bundle);
        // A stable per-source key: document id first, then URL, then position. Without this, two sources that
        // lack an id (an unusual web result) would share one counter and understate recall.
        const key = (s && (s.id || s.url)) || `#${i}`;
        return text ? { key, id: s && s.id, label: String((s && (s.source || s.url)) || 'source').slice(0, 160), tokens: contentTokens(text) } : null;
      })
      .filter((s) => s && s.tokens.size > 0);
    if (!list.length) return null;

    const sentences = sentencesOf(answer);
    const scorable = [];
    for (const text of sentences) {
      const tokens = [...contentTokens(text)];
      if (tokens.length >= MIN_SENTENCE_TOKENS) scorable.push(tokens);
    }
    if (!scorable.length) return null;

    const matched = new Map(list.map((s) => [s.key, 0]));
    let attributed = 0;
    for (const tokens of scorable) {
      let best = null, bestScore = 0, bestHits = 0;
      for (const s of list) {
        let hits = 0;
        for (const t of tokens) if (s.tokens.has(t)) hits++;
        const score = hits / tokens.length;
        if (score > bestScore) { best = s; bestScore = score; bestHits = hits; }
      }
      if (best && bestScore >= SUPPORT_THRESHOLD && bestHits >= MIN_MATCHED_TOKENS) {
        attributed++;
        matched.set(best.key, (matched.get(best.key) || 0) + 1);
      }
    }

    const precision = attributed / scorable.length;
    const usedCount = list.filter((s) => (matched.get(s.key) || 0) > 0).length;
    const recall = usedCount / list.length;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      f1: Math.round(f1 * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      sentences: scorable.length,
      attributed,
      sourceCount: list.length,
      usedCount,
      threshold: SUPPORT_THRESHOLD,
      unused: list.filter((s) => (matched.get(s.key) || 0) === 0).map((s) => s.label).slice(0, 6),
      perSource: list.slice(0, 12).map((s) => ({ id: s.id || s.key, source: s.label, matched: matched.get(s.key) || 0 })),
    };
  } catch { return null; }
};

module.exports = { attribute, servedTextOf, sentencesOf, SUPPORT_THRESHOLD };
