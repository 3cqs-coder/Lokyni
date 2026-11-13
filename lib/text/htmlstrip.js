'use strict';

// ── htmlstrip — linear removal of whole HTML elements ─────────────────────────
//
// Removing an element and its content (a <script>…</script> or <style>…</style> block) with a
// pair-matching regex like /<script\b[^>]*>[\s\S]*?<\/script>/gi is quadratic on adversarial input:
// for every unclosed <script> the lazy body scans forward to end-of-string looking for a close that
// never comes, fails, and backtracks — O(n²) on markup with many unclosed opens. On the untrusted
// HTML this app strips (a fetched web page, capped at megabytes), that is a remotely-triggerable
// multi-second event-loop freeze. This helper does the same job in a single forward pass whose search
// cursors only ever advance, so the total work is O(n) no matter how the tags nest or fail to close.
//
// Behavior matches the old regex where it matters: a well-formed <tag …>…</tag> block (content and
// both tags) is replaced with a single space; an UNCLOSED opening tag drops only the tag itself and
// leaves the following content in place (exactly as the old code did — the generic tag strip that runs
// afterward removes the bare tag and keeps the text), so a single stray <script> can't swallow the
// rest of a page.

const isNameBoundary = (ch) =>
  ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

// Index of the next real opening tag `<tag` (name-boundary enforced) at or after `from`, or -1.
// The internal indexOf cursor only moves forward, so repeated calls with a non-decreasing `from`
// scan each region of the string at most once.
function findOpen(lower, tag, from) {
  const needle = '<' + tag;
  let i = lower.indexOf(needle, from);
  while (i !== -1) {
    if (isNameBoundary(lower[i + needle.length])) return i;
    i = lower.indexOf(needle, i + 1);   // "<scriptx" — keep looking
  }
  return -1;
}

// Remove each element in `tags` (name → its whole <name …>…</name> block) from `html`, case-insensitively.
// `tags` is an array of lowercase tag names, e.g. ['script', 'style', 'svg'].
function stripElements(html, tags) {
  const s = String(html || '');
  if (!s || !tags || !tags.length) return s;
  const lower = s.toLowerCase();
  const n = s.length;
  let out = '';
  let cursor = 0;

  // Per-tag caches, all keyed by tag name. nextOpen holds the last computed opening-tag index and is
  // only recomputed once the cursor passes it, so a tag's opens are scanned once end-to-end across the
  // whole run. openGone/closeGone latch true once a forward search has found nothing more — since the
  // cursor never rewinds, there can be nothing further ahead either, so we never scan to end-of-string
  // for that tag again. Together these turn the previously-quadratic unclosed-tag case into O(n).
  const nextOpen = new Map();
  const openGone = new Set();
  const closeGone = new Set();

  while (cursor < n) {
    let bestOpen = -1, bestTag = null;
    for (const tag of tags) {
      if (openGone.has(tag)) continue;
      let idx = nextOpen.has(tag) ? nextOpen.get(tag) : -2;
      if (idx === -2 || idx < cursor) { idx = findOpen(lower, tag, cursor); nextOpen.set(tag, idx); }
      if (idx === -1) { openGone.add(tag); continue; }
      if (bestOpen === -1 || idx < bestOpen) { bestOpen = idx; bestTag = tag; }
    }
    if (bestOpen === -1) { out += s.slice(cursor); break; }   // no more target elements anywhere

    const openGt = s.indexOf('>', bestOpen);
    if (openGt === -1) { out += s.slice(cursor); break; }      // malformed final tag — leave the rest as-is

    out += s.slice(cursor, bestOpen) + ' ';                    // keep text before the element, collapse the block to a space
    if (closeGone.has(bestTag)) {
      cursor = openGt + 1;                                     // known no more closes → unclosed: drop only the opening tag
    } else {
      const closeIdx = lower.indexOf('</' + bestTag, openGt + 1);
      if (closeIdx === -1) { closeGone.add(bestTag); cursor = openGt + 1; }
      else { const closeGt = s.indexOf('>', closeIdx); cursor = closeGt === -1 ? n : closeGt + 1; }
    }
  }
  return out;
}

// Remove HTML comments and all remaining tags in a single forward pass, converting block-level tags to a
// newline (so paragraph/list structure survives) and dropping every other tag while keeping the text between
// them. This replaces the regex trio /<!--[\s\S]*?-->/g, the block-tag→newline patterns, and /<[^>]+>/g —
// all of which are O(n²) on adversarial markup (many unclosed `<` or `<!--`, each scanning to end-of-string
// and backtracking) and a remotely- or locally-triggerable event-loop freeze on a fetched or indexed page.
// Every cursor here only advances, and a "no more comment closes ahead" latch prevents re-scanning, so the
// whole pass is O(n) no matter how the markup fails to close. Behavior matches the old regexes: an
// unterminated comment or a `<` with no following `>` leaves the remaining text in place rather than eating it.
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'article', 'section', 'header', 'footer', 'aside']);
// opts.inline — the string a non-block tag is replaced with (default '' to drop it; pass ' ' to keep a word
//   boundary where a tag sat). opts.block — when true (default) a block-level tag becomes '\n' so paragraph
//   and list structure survives; when false, block tags are treated like any other tag (useful for stripping
//   a short inline field where newlines are unwanted).
function stripTags(html, opts = {}) {
  const inlineRepl = typeof opts.inline === 'string' ? opts.inline : '';
  const blockNewline = opts.block !== false;
  const s = String(html || '');
  const n = s.length;
  let out = '';
  let cursor = 0;
  let noMoreComments = false;   // latched once no `-->` remains ahead, so we never re-scan to end for one
  while (cursor < n) {
    const lt = s.indexOf('<', cursor);
    if (lt === -1) { out += s.slice(cursor); break; }   // no more tags — keep the trailing text
    out += s.slice(cursor, lt);                         // text before this tag
    if (!noMoreComments && s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end !== -1) { cursor = end + 3; continue; }   // whole comment removed
      noMoreComments = true;                            // none ahead; fall through to treat `<!--` as a tag
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) { out += s.slice(lt); break; }        // no closing `>` — leave the remainder as literal text
    // Read the tag name (after an optional leading `/`) to decide block-vs-other.
    let j = lt + 1;
    if (s[j] === '/') j++;
    let name = '';
    for (; j < gt; j++) {
      const ch = s[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '/') break;
      name += ch;
    }
    out += (blockNewline && BLOCK_TAGS.has(name.toLowerCase())) ? '\n' : inlineRepl;
    cursor = gt + 1;
  }
  return out;
}

// Decode HTML character references to text. One shared decoder so every extraction path (web search, URL
// clipper, office/EPUB XML) behaves identically instead of each re-implementing a partial list. Numeric
// references use String.fromCodePoint, so astral characters (emoji, rare CJK, math symbols) decode
// correctly — String.fromCharCode truncates to 16 bits and turns 😀 (&#x1F600;) into a wrong glyph. An
// out-of-range or surrogate code point becomes U+FFFD, matching how a browser's parser handles it. An
// unknown named entity is left untouched rather than guessed at.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
  euro: '€', pound: '£', cent: '¢', times: '×', divide: '÷',
};
function decodeEntities(text) {
  return String(text || '').replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = (body[1] === 'x' || body[1] === 'X') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
      try { return String.fromCodePoint(cp); } catch { return '�'; }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : m;   // unknown named entity — leave it as written
  });
}

module.exports = { stripElements, stripTags, decodeEntities };
