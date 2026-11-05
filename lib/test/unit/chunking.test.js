'use strict';
// Unit tests for semantic chunking (lib/indexing/chunking.js). Chunking decides retrieval granularity
// and citation offsets, so a regression here silently degrades answer quality and citations. These were
// undetected until an audit found three markdown bugs: a headingless doc collapsed to one mega-chunk,
// chunk offsets never resolved (passageMap start/end = -1) so citation windows were lost, and fenced
// code / HTML blocks were dropped from the embedded text. This guards all of that, for markdown and for
// plain text. No model or index. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { semanticSplitDocument, maxChunkChars } = require(path.join(PROJECT, 'lib', 'indexing', 'chunking'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
// Single-sourced from chunking.js (derived from the embedding model's token window), so the test can
// never drift from the real ceiling the way a hardcoded copy would.
const CHUNK_MAX = maxChunkChars();

// Split a document and return { docs, passages: Map(childId -> {startChar,endChar}) }.
const split = async (content, fileType) => {
  const childMap = new Map(), passageMap = new Map();
  const docs = await semanticSplitDocument({ content, metadata: { fileType, docId: 'doc1' } }, childMap, passageMap);
  return { docs, passageMap, childMap };
};
// Assert the invariants that must hold for EVERY chunk of a document.
const assertChunkInvariants = async (content, fileType, label) => {
  const { docs, passageMap, childMap } = await split(content, fileType);
  for (const d of docs) {
    const text = d.pageContent;
    ok(text && text.trim().length > 0, `${label}: no empty/whitespace-only chunk`);
    ok(text.length <= CHUNK_MAX, `${label}: chunk within the embedding size ceiling (${text.length} <= ${CHUNK_MAX})`);
    const off = passageMap.get(d.metadata.childId);
    ok(off && off.startChar >= 0, `${label}: chunk offset resolves (startChar >= 0) — citations depend on it`);
    eq(content.slice(off.startChar, off.endChar), text, `${label}: fullText.slice(start,end) round-trips to the chunk (offsets are exact)`);
    eq(childMap.get(d.metadata.childId), 'doc1', `${label}: child maps to its parent`);
  }
  return docs;
};

(async () => {
  try {
    // ── Markdown with headings: offsets must resolve and round-trip (the A2 regression) ──
    const mdDoc = '# Intro Heading\n\nSome **bold** text about widgets and gadgets, described at length so the section is not trivially short.\n\n## Code Section\n\n```js\nfunction computeToken(x){ return x * 2; }\n```\n\n## Details\n\n' +
      Array.from({ length: 40 }, (_, i) => `Detail line ${i} explaining how the system fits together.`).join(' ');
    const mdDocs = await assertChunkInvariants(mdDoc, 'md', 'md-with-headings');
    ok(mdDocs.length >= 2, 'markdown with headings splits into multiple chunks');
    ok(mdDocs.some(d => d.pageContent.includes('computeToken')), 'fenced code text is embedded in a chunk (the A3 regression)');
    console.log('✓ chunking: markdown-with-headings resolves exact offsets and keeps fenced code');

    // ── Headingless markdown longer than the target must NOT collapse to one chunk (the A1 regression) ──
    const noHead = Array.from({ length: 120 }, (_, i) => `This is plain sentence number ${i} with some filler words to add length.`).join(' ');
    ok(noHead.length > 1500, 'the headingless fixture exceeds the chunk target');
    const noHeadDocs = await assertChunkInvariants(noHead, 'md', 'md-headingless');
    ok(noHeadDocs.length > 1, `headingless markdown over the target yields multiple chunks (got ${noHeadDocs.length})`);
    console.log('✓ chunking: headingless markdown is split, not collapsed into one mega-chunk');

    // ── Plain text: same offset/round-trip invariants ──
    const txt = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. It has a few sentences. Each adds a little length to the document.`).join('\n\n');
    const txtDocs = await assertChunkInvariants(txt, 'txt', 'plain-text');
    ok(txtDocs.length > 1, 'a long plain-text document splits into multiple chunks');
    console.log('✓ chunking: plain text resolves exact offsets and splits by size');

    // ── A single unbreakable line beyond the ceiling is still bounded (no oversized chunk) ──
    const longLine = 'x'.repeat(20000);   // no spaces/newlines — the hard-cut path
    const longDocs = await split(longLine, 'txt');
    ok(longDocs.docs.length >= 3, 'an unbreakable long line is split into several bounded pieces');
    ok(longDocs.docs.every(d => d.pageContent.length <= CHUNK_MAX), 'no piece exceeds the size ceiling');
    console.log('✓ chunking: an unbreakable long line is bounded to the size ceiling');

    // ── Token-dense, space-free content (CJK) is still bounded to the char ceiling, so it stays within
    //    the model's token window. This is the case a fixed dense-ratio ceiling missed: CJK tokenizes at
    //    roughly one token per character, so only a character ceiling below the token window is safe. ──
    const cjk = '文'.repeat(20000);   // no separators at all — worst case for the splitter
    const cjkDocs = await split(cjk, 'txt');
    ok(cjkDocs.docs.length >= 3, 'a long space-free CJK run is split into several pieces');
    ok(cjkDocs.docs.every(d => d.pageContent.length <= CHUNK_MAX),
      `every CJK piece is within the char ceiling (<= ${CHUNK_MAX}), so its token count cannot exceed the window`);
    console.log('✓ chunking: token-dense CJK content is bounded to the char ceiling (token-window safe)');

    // ── A smaller configured embedding window shrinks the ceiling, so chunks made for a 512-token model
    //    are correspondingly smaller. This is what protects a user who switches to a small-context model. ──
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    const savedCtx = cfg.EMBEDDING_CONTEXT_TOKENS;
    try {
      cfg.EMBEDDING_CONTEXT_TOKENS = 512;
      const smallCeiling = maxChunkChars();
      ok(smallCeiling <= 512 && smallCeiling < CHUNK_MAX, `a 512-token window yields a smaller ceiling (${smallCeiling})`);
      const smallDocs = await split('word '.repeat(4000), 'txt');
      ok(smallDocs.docs.every(d => d.pageContent.length <= smallCeiling),
        'chunks made for a 512-token model stay within the smaller ceiling');

      // ── a TINY window: the ceiling must track (window − margin) and never be raised by a floor above it,
      //    or a one-token-per-character script (CJK) would exceed the window and be dropped from dense search. ──
      cfg.EMBEDDING_CONTEXT_TOKENS = 128;   // the config minimum
      const tinyCeiling = maxChunkChars();
      ok(tinyCeiling <= 128 - 64, `a 128-token window yields a ceiling at or below window − margin (${tinyCeiling})`);
      ok(tinyCeiling >= 1, 'the ceiling stays positive');
      // A CJK chunk capped to tinyCeiling chars is at most tinyCeiling tokens — within the 128-token window.
      const cjk = '文'.repeat(4000);
      const tinyDocs = await split(cjk, 'txt');
      ok(tinyDocs.docs.every(d => d.pageContent.length <= tinyCeiling),
        'CJK chunks for a 128-token model stay within the window (no dropped chunk)');
    } finally {
      cfg.EMBEDDING_CONTEXT_TOKENS = savedCtx;
    }
    console.log('✓ chunking: the ceiling tracks the configured embedding context window (small-model safe)');

    // ── Logs use a coarser chunk target: the same content yields far fewer chunks than as .txt ──
    // A log is append-only and line-oriented, so grouping more lines per chunk cuts the chunk count
    // (and the embedding time and index memory) several-fold, while staying under the size ceiling.
    const logLines = Array.from({ length: 4000 }, (_, i) => `2026-09-29T00:00:${String(i % 60).padStart(2, '0')}.000Z Pair: SYM${i}/USD Last Price: $0.0${i} Profit: -1.2%`).join('\n');
    const asLog = await split(logLines, 'log');
    const asTxt = await split(logLines, 'txt');
    ok(asLog.docs.every(d => d.pageContent.length <= CHUNK_MAX), 'log chunks stay within the embedding size ceiling');
    ok(asLog.docs.length > 0 && asLog.docs.length < asTxt.docs.length * 0.85,
      `a .log yields fewer chunks than the same content as .txt (log ${asLog.docs.length} < 0.85 x txt ${asTxt.docs.length})`);
    // Offsets must still resolve — coarser chunks must not break citation/highlight positions.
    for (const d of asLog.docs.slice(0, 20)) {
      const { startChar, endChar } = asLog.passageMap.get(d.metadata.childId) || {};
      ok(startChar >= 0 && endChar > startChar, 'a log chunk resolves to a valid position range');
    }
    console.log('✓ chunking: logs use a coarser target (fewer chunks) while offsets still resolve');

    // ── Empty / whitespace-only documents yield zero chunks ──
    eq((await split('', 'md')).docs.length, 0, 'an empty document yields no chunks');
    eq((await split('   \n\n  \t ', 'txt')).docs.length, 0, 'a whitespace-only document yields no chunks');
    console.log('✓ chunking: empty and whitespace-only documents yield zero chunks');

    console.log(`\nALL CHUNKING UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ CHUNKING UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
