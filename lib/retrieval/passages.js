'use strict';
const state = require('../state');
const { DEBUG } = require('../config');
const { extractKeywords, extractSpecificKeywords, scanWindowsMax } = require('./keywords');
const { KEYWORD_SCAN_MAX_CHARS } = require('./constants');

const TARGET_PASSAGE_CHARS = 6000;

// Build a sorted position index: parentId → [{childId, startChar}] ascending.
// Called after every delta update and on warm start. Replaces the O(childMap)
// linear scan in seedChunksForDoc with an O(log n) binary search.
const buildChunkIndexInto = (idx) => {
  idx.chunkIndex.clear();
  for (const [childId, parentId] of idx.childMap) {
    const pos = idx.passageMap.get(childId);
    if (!pos || pos.startChar < 0) continue;
    if (!idx.chunkIndex.has(parentId)) idx.chunkIndex.set(parentId, []);
    idx.chunkIndex.get(parentId).push({ childId, startChar: pos.startChar });
  }
  for (const chunks of idx.chunkIndex.values()) {
    chunks.sort((a, b) => a.startChar - b.startChar);
  }
  if (DEBUG) console.log(`✅ chunkIndex built — ${idx.chunkIndex.size} documents`);
};

// Build against global state (the active workspace). Existing callers use this.
const buildChunkIndex = () => buildChunkIndexInto(state);

const getPassageContext = (docId, matchedChunkIds, fullText, maxTotalChars = 12000, bundle = state) => {
  const ranges = [];
  for (const chunkId of matchedChunkIds) {
    const pos = bundle.passageMap.get(chunkId);
    if (!pos || pos.startChar < 0) continue;

    const center = Math.floor((pos.startChar + pos.endChar) / 2);
    const half   = Math.floor(TARGET_PASSAGE_CHARS / 2);
    let start = Math.max(0, center - half);
    let end   = Math.min(fullText.length, center + half);

    // Snap to a nearby paragraph break, but only look within the ±500 window the result is actually used in —
    // an unbounded lastIndexOf/indexOf would scan the whole (possibly hundreds-of-MB) document body backward or
    // forward on a document with sparse newlines, for a match that would then be rejected anyway.
    const backFrom = Math.max(0, start - 500);
    const relStart = fullText.slice(backFrom, start + 2).lastIndexOf('\n\n');
    const snapStart = relStart >= 0 ? backFrom + relStart : -1;
    if (snapStart > start - 500 && snapStart >= 0) start = snapStart + 2;
    const relEnd = fullText.slice(end, end + 501).indexOf('\n\n');
    const snapEnd = relEnd >= 0 ? end + relEnd : -1;
    if (snapEnd < end + 500 && snapEnd >= 0) end = snapEnd;

    ranges.push([start, end]);
  }

  if (ranges.length === 0) return null;

  // Merge and spend the character budget in document order. This is correct for how the caller supplies
  // anchors: either a SINGLE best anchor (the reranked/FAISS path caps at one anchor per parent, so there is
  // no contention) or POSITION-ORDERED seed chunks from one keyword-dense window (seedChunksForDoc returns them
  // ascending by start). Neither carries a separate relevance ranking across anchors, so ordering by position
  // here can't truncate a "more relevant" later anchor in favor of an earlier weaker one — there is no such
  // ordering to honor. If a rank-ordered multi-anchor source is ever added, revisit this to spend the budget in
  // rank order while still emitting in document order.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1] + 200) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  const passages = [];
  const emitted = [];   // the ranges ACTUALLY served (see below)
  let total = 0;
  for (const [start, end] of merged) {
    if (total >= maxTotalChars) break;
    const remaining = maxTotalChars - total;
    const clippedEnd = Math.min(end, start + remaining);
    const text = fullText.slice(start, clippedEnd);
    passages.push(text);
    emitted.push([start, clippedEnd]);
    total += text.length;
  }

  // Return the ranges that were actually EMITTED, not the full merged set. When the budget truncates,
  // trailing merged ranges are never served and the last served range is clipped — returning `merged`
  // there would overstate the served span, so the citation offsets and the raw /search re-slice (which
  // both read these ranges) would point at text the model never saw. `emitted` reflects exactly what is
  // in `text`.
  return { text: passages.join('\n\n---\n\n'), ranges: emitted };
};

// Group chunk anchors by their parent document, keeping each parent's best-ranked chunk(s).
// `orderedItems` is a priority-ordered list of { parentId, id } (best first — e.g. reranker output, or
// FAISS order when no reranker is used); the first item seen for a parent is therefore that parent's
// best anchor. Returns Map(parentId -> [chunkId, ...]) capped at `maxPerParent` per parent, preserving
// the order in which each parent was first encountered. Pure and side-effect-free, so it is unit-tested
// directly; shared by the reranker and no-reranker paths in search.js so their anchor selection can't drift.
const pickAnchorsByParent = (orderedItems, maxPerParent = 1) => {
  const cap = Math.max(1, maxPerParent | 0);
  const byParent = new Map();
  for (const it of (orderedItems || [])) {
    if (!it || !it.parentId || !it.id) continue;
    const arr = byParent.get(it.parentId);
    if (arr) { if (arr.length < cap) arr.push(it.id); }
    else byParent.set(it.parentId, [it.id]);
  }
  return byParent;
};

// Binary search: find first index where startChar >= target
const lowerBound = (arr, target) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].startChar < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const seedChunksForDoc = (docId, fullText, standaloneQuery, bundle = state) => {
  // Bound before lowercasing: scanWindowsMax only scans the first KEYWORD_SCAN_MAX_CHARS anyway, so lowercasing
  // a whole multi-hundred-MB document body here would block the event loop and spike memory for nothing. The
  // densest-window position it returns is unchanged (it never looks past that bound). Mirrors boundedLower in
  // search.js, which guards every other full-text lowercase on the query path.
  const fullLower   = (fullText.length > KEYWORD_SCAN_MAX_CHARS ? fullText.slice(0, KEYWORD_SCAN_MAX_CHARS) : fullText).toLowerCase();
  const specificKws = extractSpecificKeywords(standaloneQuery, 5, bundle.corpusIdf);
  const allKws      = specificKws.length > 0 ? specificKws : extractKeywords(standaloneQuery, 8, bundle.corpusIdf);
  const WINDOW = 8000;
  // Locate the densest window via the shared sliding-window scan (bounded + allocation-free).
  const { pos: bestPos } = scanWindowsMax(fullLower, allKws, { window: WINDOW });

  // Binary search in chunkIndex for chunks overlapping [bestPos, bestPos+WINDOW]
  const chunks = bundle.chunkIndex.get(docId);
  if (chunks && chunks.length > 0) {
    const lo = lowerBound(chunks, bestPos);
    const hi = lowerBound(chunks, bestPos + WINDOW);
    const inWindow = chunks.slice(lo, Math.min(hi, lo + 3)).map(c => c.childId);
    if (inWindow.length > 0) return inWindow;
    // Fallback: nearest chunks to bestPos
    const nearest = chunks
      .slice(Math.max(0, lo - 1), Math.min(chunks.length, lo + 2))
      .map(c => c.childId);
    if (nearest.length > 0) return nearest.slice(0, 2);
  }

  // Final fallback: linear scan (chunkIndex not yet built)
  const seedChunks = [];
  for (const [childId, parentId] of bundle.childMap) {
    if (parentId !== docId) continue;
    const pos = bundle.passageMap.get(childId);
    if (!pos || pos.startChar < 0) continue;
    if (pos.startChar >= bestPos && pos.startChar <= bestPos + WINDOW) {
      seedChunks.push(childId);
      if (seedChunks.length >= 3) break;
    }
  }
  if (seedChunks.length === 0) {
    for (const [childId, parentId] of bundle.childMap) {
      if (parentId === docId && bundle.passageMap.has(childId)) {
        seedChunks.push(childId);
        if (seedChunks.length >= 2) break;
      }
    }
  }
  return seedChunks;
};

module.exports = { buildChunkIndex, buildChunkIndexInto, getPassageContext, seedChunksForDoc, pickAnchorsByParent };
