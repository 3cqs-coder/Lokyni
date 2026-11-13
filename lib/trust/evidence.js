'use strict';
// Evidence snapshots for scheduled automations. A saved question that runs on a schedule is most useful when
// it says what changed since last time, not just what the answer is now. A snapshot records the identity of
// each cited source, a short content digest (so a source that changed is visible), and the answer's own hash.
// Comparing two snapshots yields added / removed / changed sources and whether the answer moved.
//
// Pure, synchronous, and bounded: source text is capped before hashing, the entry list is capped, and labels
// are shortened. Nothing here stores document text — only identities, a 16-character digest, and labels.

const crypto = require('crypto');
const { servedTextOf } = require('./attribution');

const MAX_ENTRIES = 50;
const MAX_LABEL = 160;
const MAX_DIGEST_CHARS = 8000;
const MAX_NOTE_ITEMS = 5;

const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

const labelOf = (source) => {
  const raw = String(source && (source.source || source.url || source.id) || 'source').replace(/\s+/g, ' ').trim();
  return raw.length > MAX_LABEL ? raw.slice(0, MAX_LABEL - 1) + '…' : raw;
};

// A stable identity for one cited source. A web page keys by URL (its per-answer `web-N` id is not stable
// across runs); a local document keeps its doc id even if its name changes. Never derived from a file path.
const keyOf = (source) => {
  if (!source) return '';
  if (source.isWeb && source.url) return `web:${String(source.url).slice(0, 300)}`;
  if (source.id) return `doc:${String(source.id).slice(0, 120)}`;
  if (source.url) return `web:${String(source.url).slice(0, 300)}`;
  return `name:${labelOf(source)}`;
};

// Build a snapshot from the sources a run cited. `idx` resolves each source's served text for its digest.
// Returns { at, answer, entries: [{ key, label, digest }] } with entries sorted by key for stable comparison.
const snapshot = (sources, idx, answer) => {
  const seen = new Map();
  for (const s of (Array.isArray(sources) ? sources : [])) {
    const key = keyOf(s);
    if (!key || seen.has(key)) continue;
    const text = servedTextOf(s, idx || {}).slice(0, MAX_DIGEST_CHARS);
    seen.set(key, { key, label: labelOf(s), digest: sha(text).slice(0, 16) });
    if (seen.size >= MAX_ENTRIES) break;
  }
  return {
    at: Date.now(),
    answer: sha(answer).slice(0, 16),
    entries: [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
};

// Compare two snapshots. `first` is true when there is no earlier snapshot (nothing to compare, so the caller
// adds no note). Lists are ordered by the next snapshot's entry order and capped for display.
const diff = (previous, next) => {
  if (!next) return { first: true, added: [], removed: [], changed: [], answerChanged: false, any: false };
  if (!previous || !Array.isArray(previous.entries)) {
    return { first: true, added: [], removed: [], changed: [], answerChanged: false, any: false };
  }
  const before = new Map(previous.entries.map((e) => [e.key, e]));
  const after = new Map(next.entries.map((e) => [e.key, e]));
  const added = [], changed = [];
  for (const e of next.entries) {
    const old = before.get(e.key);
    if (!old) added.push(e.label);
    else if (old.digest !== e.digest) changed.push(e.label);
  }
  const removed = previous.entries.filter((e) => !after.has(e.key)).map((e) => e.label);
  const answerChanged = !!previous.answer && previous.answer !== next.answer;
  return {
    first: false,
    added: added.slice(0, MAX_NOTE_ITEMS),
    removed: removed.slice(0, MAX_NOTE_ITEMS),
    changed: changed.slice(0, MAX_NOTE_ITEMS),
    answerChanged,
    any: !!(added.length || removed.length || changed.length || answerChanged),
  };
};

// A short plain-text header for the delivered result, or '' on a first run (nothing to compare yet). The
// inbox renders the body as text, so this uses simple lines rather than Markdown.
const note = (d) => {
  if (!d || d.first) return '';
  const lines = ['Evidence since the last run:'];
  if (d.added.length) lines.push(`- New source${d.added.length === 1 ? '' : 's'}: ${d.added.join(', ')}`);
  if (d.removed.length) lines.push(`- No longer cited: ${d.removed.join(', ')}`);
  if (d.changed.length) lines.push(`- Changed source${d.changed.length === 1 ? '' : 's'}: ${d.changed.join(', ')}`);
  if (d.answerChanged) lines.push('- The answer changed.');
  if (!d.any) lines.push('- No change in sources or answer.');
  return lines.join('\n') + '\n\n';
};

module.exports = { snapshot, diff, note, keyOf, labelOf, MAX_ENTRIES };
