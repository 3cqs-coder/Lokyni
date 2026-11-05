'use strict';
// Web-result source prior.
//
// A web search returns results in the engine's own order, which mixes authoritative
// pages in with content farms, social re-posts, and stale copies. Before Lokyni fetches
// and grounds an answer on the top few, this reorders the raw results by a cheap,
// transparent prior so the pages it actually reads are the most trustworthy and on-topic
// ones. It changes ONLY the order — it never drops results — so nothing is hidden from
// the user, and it never throws (any failure returns the input order unchanged).
//
// The score blends four signals:
//   • title match     — how many query terms appear in the title (word-boundary),
//   • snippet quality — snippet term hits plus a mild length factor,
//   • domain authority — a TLD/known-source tier (.gov/.edu high, .org mid, trusted
//                        reference/news sources high, content-farm/social domains low),
//   • recency          — best-effort, from a date found in the snippet (0 when absent).
// The weights favor on-topic authoritative pages without letting any single signal
// dominate; tune them here if the ordering ever needs adjusting.

const { escapeRegExp } = require('./keywords');

const AUTHORITY = { title: 2.0, snippet: 1.0, domain: 1.5, recency: 1.0 };

// Domains that are usually low-value as a grounding source: social feeds, Q&A/forum
// aggregators, and content farms. Demoted, never removed.
const LOW_VALUE_DOMAINS = new Set([
  'facebook.com', 'm.facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'pinterest.com', 'reddit.com', 'quora.com', 'tiktok.com', 'medium.com',
  'msn.com', 'yahoo.com', 'answers.com', 'ehow.com', 'fandom.com',
]);

// A small set of widely-trusted reference and news sources. Not exhaustive — it exists
// to give a handful of high-signal domains a nudge, alongside the .gov/.edu/.org tiers.
const TRUSTED_DOMAINS = new Set([
  'wikipedia.org', 'en.wikipedia.org', 'britannica.com',
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'npr.org',
  'theguardian.com', 'nature.com', 'sciencedirect.com', 'arxiv.org',
  'nih.gov', 'who.int', 'nasa.gov', 'mayoclinic.org', 'stackoverflow.com',
]);

const _domain = (url) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch { return ''; }
};

// Query terms: lowercased word tokens, de-duplicated. Very short tokens are kept but
// only ever matched on word boundaries so "us" can't match "business".
const queryTerms = (query) => {
  const seen = new Set();
  for (const t of String(query || '').toLowerCase().match(/\b\w+\b/g) || []) seen.add(t);
  return [...seen];
};

const hasWord = (text, term) => {
  try { return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(text); }
  catch { return text.includes(term); }
};

const titleScore = (title, terms) => {
  if (!title || terms.length === 0) return 0;
  const lc = title.toLowerCase();
  return terms.filter(t => hasWord(lc, t)).length / terms.length;
};

const snippetScore = (snippet, terms) => {
  if (!snippet) return 0;
  const lc = snippet.toLowerCase();
  const lengthFactor = Math.min(snippet.length, 200) / 200;
  const termFactor = terms.length ? terms.filter(t => hasWord(lc, t)).length / terms.length : 0;
  return (lengthFactor + termFactor) / 2;
};

const domainScore = (url) => {
  const d = _domain(url);
  if (!d) return 0;
  if (LOW_VALUE_DOMAINS.has(d)) return 0.1;
  if (TRUSTED_DOMAINS.has(d)) return 1.0;
  if (d.endsWith('.gov') || d.endsWith('.edu') || d.endsWith('.mil')) return 1.0;
  if (d.endsWith('.org')) return 0.7;
  if (d.endsWith('.ac.uk') || d.endsWith('.gov.uk')) return 1.0;
  return 0.4;
};

// A coarse, transparent credibility TIER for a web source, reusing the SAME domain signals the ranking
// prior already uses (this is not a truth judgment — just where a source structurally sits). Only the
// notably-high and notably-low tiers get a label so the UI stays uncluttered; the neutral majority returns
// '' (no badge). Surfacing it lets the reader weigh a cited page without changing what is retrieved.
const sourceTier = (url) => {
  const d = _domain(url);
  if (!d) return { tier: '', label: '' };
  if (d.endsWith('.gov') || d.endsWith('.edu') || d.endsWith('.mil') || d.endsWith('.gov.uk') || d.endsWith('.ac.uk')) {
    return { tier: 'official', label: 'official source' };
  }
  if (TRUSTED_DOMAINS.has(d)) return { tier: 'trusted', label: 'established source' };
  if (LOW_VALUE_DOMAINS.has(d)) return { tier: 'community', label: 'forum / social' };
  return { tier: '', label: '' };
};

// Best-effort recency: many snippets are prefixed with a publish date ("Jan 5, 2024 —",
// "2024-01-05", "3 days ago"). Score 1.0 for <=7 days old down to 0.0 at >=365 days;
// return 0 when no date is found rather than guessing.
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
const recencyScore = (snippet, now) => {
  if (!snippet) return 0;
  const s = snippet.slice(0, 40).toLowerCase();
  let dt = null;
  let m;
  if ((m = s.match(/(\d+)\s+(day|week|month|year)s?\s+ago/))) {
    const n = Number(m[1]);
    const mult = { day: 1, week: 7, month: 30, year: 365 }[m[2]];
    dt = new Date(now - n * mult * 86400000);
  } else if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) {
    dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else if ((m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
    dt = new Date(Number(m[3]), MONTHS[m[1]], Number(m[2]));
  }
  if (!dt || isNaN(dt.getTime())) return 0;
  const days = (now - dt.getTime()) / 86400000;
  if (days <= 7) return 1.0;
  if (days >= 365) return 0.0;
  return Math.max(0, (365 - days) / 358);
};

// Reorder web results by the source prior. Stable within equal scores (preserves the
// engine's original order as the tie-breaker). Returns a new array; input untouched.
const rankWebResults = (query, results, nowMs) => {
  if (!Array.isArray(results) || results.length <= 1) return results || [];
  try {
    const terms = queryTerms(query);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const scored = results.map((r, i) => {
      const score =
        AUTHORITY.title   * titleScore(r.title, terms) +
        AUTHORITY.snippet * snippetScore(r.snippet, terms) +
        AUTHORITY.domain  * domainScore(r.url) +
        AUTHORITY.recency * recencyScore(r.snippet, now);
      return { r, i, score };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));   // stable tie-break
    return scored.map(x => x.r);
  } catch {
    return results;   // any failure → engine order, never break the search
  }
};

module.exports = { rankWebResults, sourceTier, _domainScore: domainScore, _recencyScore: recencyScore };
