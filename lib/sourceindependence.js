'use strict';
// Source-independence analysis for web answers. "Several sources agree" overstates corroboration when those
// sources are really one publisher under different paths, or the same article syndicated across outlets.
// This groups a set of sources into INDEPENDENT clusters using two content-based signals — never a topical
// one, so two genuinely independent sources on the same subject stay independent:
//   1. same registrable domain  → one publisher
//   2. near-duplicate text       → a syndicated or mirrored copy (word-shingle Jaccard overlap)
// Everything here is pure, synchronous, and bounded (input and per-text work are both capped), so a large
// result set can never block the event loop or grow memory without limit. Never throws.

// A small set of common multi-label public suffixes, so "news.bbc.co.uk" and "bbc.co.uk" register as one
// publisher. Deliberately not the full public-suffix list (that would be a dependency); an unknown
// multi-part suffix falls back to the last two labels, which is safe (it only ever over-merges two genuine
// siblings, never splits one publisher into several).
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in',
  'co.za', 'org.za', 'com.br', 'net.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.ua', 'co.il', 'com.pl',
]);

// The registrable domain of a URL ("www.a.example.co.uk" -> "example.co.uk"). Empty string when the URL
// can't be parsed, so callers treat it as an unknown (always-independent) domain.
const registrableDomain = (url) => {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
  host = host.replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  return MULTI_SUFFIXES.has(lastTwo) ? lastThree : lastTwo;
};

// Normalized token k-shingles of a text (bounded by maxChars), for near-duplicate detection. Tokenizing with
// the shared language-agnostic tokenizer (NFC, Unicode letters/numbers, CJK bigrams) — NOT an ASCII-only
// [^a-z0-9] strip — so a Cyrillic, Greek, Arabic, accented-Latin, or CJK page produces real shingles and its
// syndicated copies are detected as near-duplicates (an ASCII strip emptied them, overstating "independent
// sources"). One tokenizer shared with retrieval, so the two can't disagree. Lazy require: no load-order dep.
const shingles = (text, k = 5, maxChars = 4000) => {
  const { tokenize } = require('./retrieval/keywords');
  const words = tokenize(String(text || '').slice(0, maxChars));
  const set = new Set();
  if (words.length < k) { if (words.length) set.add(words.join(' ')); return set; }
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
};

// Jaccard overlap of two shingle sets (0..1).
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
};

// Union-find over `items` ([{ url, text? }, ...]) joining pairs that share a registrable domain or whose
// text is near-duplicate. Returns the parent array plus the per-item domain list. `dupThreshold` is the
// shingle-Jaccard above which two texts count as the same content. Bounded to MAX_ITEMS so the O(n^2) pair
// scan stays safe on a pathological result set.
const MAX_ITEMS = 200;
const _cluster = (items, dupThreshold) => {
  const list = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
  const n = list.length;
  const domains = list.map((it) => it.domain || registrableDomain(it.url));
  const haveText = list.some((it) => it.text);
  const shings = haveText ? list.map((it) => shingles(it.text)) : null;
  const parent = list.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (domains[i] && domains[i] === domains[j]) { parent[find(i)] = find(j); continue; }
      if (shings && jaccard(shings[i], shings[j]) >= dupThreshold) parent[find(i)] = find(j);
    }
  }
  return { list, n, domains, shings, find };
};

// Analyze independence. Returns { total, independent, dependent, clusters:[{ members:[url…], domain, size }] }.
// Clusters are sorted largest-first. Used for an honest "N sources, M independent" count.
const analyze = (items, opts = {}) => {
  const dupThreshold = opts.dupThreshold != null ? opts.dupThreshold : 0.8;
  const { list, n, domains, find } = _cluster(items, dupThreshold);
  const out = { total: n, independent: n, dependent: 0, clusters: [] };
  if (!n) return out;
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }
  const clusters = [];
  for (const [root, idxs] of byRoot) {
    clusters.push({ members: idxs.map((k) => list[k].url), domain: domains[idxs[0]] || null, size: idxs.length });
  }
  clusters.sort((a, b) => b.size - a.size);
  out.independent = clusters.length;
  out.dependent = n - clusters.length;
  out.clusters = clusters;
  return out;
};

// Collapse NEAR-DUPLICATE-TEXT copies (syndicated/mirrored pages) to a single representative, keeping the
// FIRST occurrence (callers pass results best-first, so the best-ranked copy survives). Deliberately does
// NOT collapse merely same-domain pages — two different pages on one site can carry different information,
// so only genuinely duplicated CONTENT is dropped (saving context budget and avoiding a page cited twice).
// Returns { kept:[item…], dropped:Number }. Input is never mutated.
const dedupeByContent = (items, opts = {}) => {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return { kept: list.slice(), dropped: 0 };
  const dupThreshold = opts.dupThreshold != null ? opts.dupThreshold : 0.9;
  const capped = list.slice(0, MAX_ITEMS);
  const shings = capped.map((it) => shingles(it && it.text));
  const kept = [];
  const keptShingles = [];
  let dropped = 0;
  for (let i = 0; i < capped.length; i++) {
    const s = shings[i];
    let isDup = false;
    if (s.size) {
      for (const ks of keptShingles) { if (jaccard(s, ks) >= dupThreshold) { isDup = true; break; } }
    }
    if (isDup) { dropped++; continue; }
    kept.push(capped[i]);
    keptShingles.push(s);
  }
  // Anything beyond the cap is kept as-is (never dropped) so a huge set never silently loses sources.
  for (let i = MAX_ITEMS; i < list.length; i++) kept.push(list[i]);
  return { kept, dropped };
};

// A short, honest one-liner for display, or '' when nothing is notable (every source independent).
const summarize = (report) => {
  if (!report || report.total <= 1 || report.independent >= report.total) return '';
  return `${report.total} sources, ${report.independent} independent`;
};

// A compact summary for a displayed answer's source list. Local documents have no URL and are treated as
// independent; web sources group by registrable domain, and near-duplicate text (when the caller supplies it)
// groups syndicated copies. Bounded by analyze(), pure, and never throws. Returns null when there is nothing
// useful to show (zero/one source), so the caller can omit the field entirely.
const statsFor = (sources) => {
  try {
    const list = Array.isArray(sources) ? sources : [];
    const report = analyze(list.map((s) => ({
      // Only a real external URL identifies a publisher. A local document's viewerLink is an in-app relative
      // path, and treating it as a domain would collapse every local document into one "publisher".
      url: (s && s.url) || '',
      text: (s && (s.text || s.snippet)) || '',
      domain: (s && s.domain) || '',
    })));
    if (report.total <= 1) return null;
    return { total: report.total, independent: report.independent, summary: summarize(report) };
  } catch { return null; }
};

module.exports = { registrableDomain, shingles, jaccard, analyze, dedupeByContent, summarize, statsFor, MAX_ITEMS };
