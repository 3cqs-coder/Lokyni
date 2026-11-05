'use strict';
// Live web search — DuckDuckGo HTML scraping + readable-text page extraction.
//
// No API key required. Uses the DuckDuckGo "lite" HTML endpoint because its markup
// is minimal and stable. Each result URL is wrapped in a DDG tracking redirect
// (//duckduckgo.com/l/?uddg=<encoded real url>); we decode these to clean URLs.
//
// The DuckDuckGo search request uses the global fetch. The per-result PAGE fetch goes through the shared
// SSRF guard (lib/nethost), which pins the connection to the vetted IP with an undici dispatcher, so a
// result URL cannot be rebound to an internal address after it is checked. If DuckDuckGo blocks or
// rate-limits (which can happen under load), searches return an empty/failed result the caller surfaces
// honestly rather than guessing.
const { DEBUG } = require('./config');
const { decodeEntities } = require('./htmlstrip');
// webSearchMaxCharsPerPage and webSearchTimeoutMs are read fresh inside the functions
// below (not destructured here) so a Settings change takes effect without a restart —
// reloadConfig() re-requires ./config, and a value captured at import would be stale.

const SEARCH_URL = 'https://lite.duckduckgo.com/lite/';
// A real-browser UA avoids DDG's bot-blocker page. Not security — just avoids a
// service that explicitly allows search returning a blocker for a headless client.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Warn only once per process if the DuckDuckGo scrape suddenly parses nothing from a real page (a markup
// change), so the log isn't spammed on every query.
let _warnedDdgEmpty = false;

// fetch with an abort-based timeout and optional external-signal linking (the turn's AbortController), so a
// New/disconnect cancels an in-flight search or page fetch promptly instead of holding the serialized turn
// queue until timeout. Shared with the other network callers so the behavior (unref'd timer, prompt cancel,
// undici dispatcher honored for the SSRF-pinned page fetch) can't drift.
const { fetchWithTimeout } = require('./fetchtimeout');

// Read a response body only up to a byte cap, then stop and decode as UTF-8. A result URL is
// attacker-influenceable (any page that ranks into the user's search), and the fetch is time-bounded
// but not byte-bounded — so without a cap a host could serve a huge body within the timeout window and
// balloon memory, more so with several page fetches running in parallel. Streaming and stopping early
// keeps the read bounded regardless of the body's declared or actual length.
// Decode a body buffer using its declared charset, so a legacy-encoded page (windows-1252, ISO-8859-x,
// Shift_JIS, GBK, …) is read as real text instead of mojibake. The charset comes from the Content-Type
// header, else a sniff of a <meta charset> / http-equiv in the first 1 KB (read as latin1 so the bytes are
// preserved for the scan), else UTF-8. TextDecoder is built in (no dependency) and handles the legacy
// labels; an unknown label falls back to UTF-8. Never throws.
const decodeBuffer = (buf, contentType) => {
  let charset = '';
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''));
  if (m) charset = m[1];
  if (!charset) {
    const head = buf.subarray(0, 1024).toString('latin1');
    const m2 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || /charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (m2) charset = m2[1];
  }
  charset = (charset || 'utf-8').toLowerCase().trim();
  if (charset === 'utf8' || charset === 'utf-8' || charset === 'us-ascii' || charset === 'ascii') {
    return buf.toString('utf8');   // the common case — skip TextDecoder entirely
  }
  try { return new TextDecoder(charset, { fatal: false }).decode(buf); }
  catch { return buf.toString('utf8'); }   // unknown/unsupported label → UTF-8
};

// Read a response body as (charset-decoded) text with a running byte cap. The read is also TIME-BOUNDED and
// ABORTABLE: fetchWithTimeout clears its own timer once the headers resolve, so without a timer here a peer that
// trickles the body could stall this read indefinitely, and a mid-body turn-cancel would not stop it. An armed
// timer and the external signal both cancel the reader (parity with fetchtimeout.fetchTextCapped's body-armed
// timeout), so the body phase stays bounded and promptly cancellable. Throws on timeout/abort (callers treat it
// as a failed fetch), so a stalled body never returns a half-read page as if it were complete.
const readCappedText = async (res, maxBytes, { timeoutMs = 15000, signal = null } = {}) => {
  const contentType = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : '';
  if (!res.body || typeof res.body.getReader !== 'function') {
    // No readable stream (shouldn't happen with Node's fetch) — fall back and cap the string.
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let cancelled = false;
  const cancel = () => { cancelled = true; try { reader.cancel(); } catch { /* already closed */ } };
  const timer = setTimeout(cancel, timeoutMs);
  if (timer.unref) timer.unref();
  const onAbort = () => cancel();
  if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();   // resolves done:true once cancel() fires, so the loop exits
      if (done) break;
      if (value && value.length) { chunks.push(value); total += value.length; }
    }
  } finally {
    clearTimeout(timer);
    if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* best-effort */ } }
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  if (cancelled) throw Object.assign(new Error('response body read timed out or was aborted'), { name: 'AbortError' });
  return decodeBuffer(Buffer.concat(chunks).subarray(0, maxBytes), contentType);
};

// Decode DDG's tracking redirect. The real URL lives in the `uddg` query param.
const decodeDdgRedirect = (href) => {
  let full = href;
  if (full.startsWith('//')) full = 'https:' + full;
  else if (full.startsWith('/')) full = 'https://duckduckgo.com' + full;
  try {
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get('uddg');
    if (!uddg) return null;
    // Accept ONLY http(s) targets. The decoded URL flows into a source pill's viewerLink/url shown to the user;
    // a file:/data:/javascript: target (fetchPageText already refuses to fetch it) must not reach the UI either.
    const target = new URL(uddg);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    return uddg;
  } catch { return null; }
};

// Minimal HTML→text for snippets and titles.
const stripHtml = (s) => {
  if (!s) return '';
  return decodeEntities(String(s).replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
};

// Parse the DDG lite HTML into [{title, url, snippet}]. Pairs each result anchor
// with the nearest following snippet cell by document position — resilient to
// small markup changes as long as relative ordering holds.
const parseDdgLite = (html, limit) => {
  // Capture the href as a SINGLE [^"]* (no ambiguous re-partition) and let decodeDdgRedirect below do the
  // "is this a /l/?uddg= redirect" filtering. The older pattern (…[^"]*/l/?[^"]*uddg=…) had two [^"]* that could
  // re-partition at every "/l/?", an O(n²) backtracking shape on a crafted href. This form is strictly linear
  // and matches the same real links, since decodeDdgRedirect already rejects any non-redirect href.
  const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

  // Stop scanning once we have the `limit` results we need. Results appear in document order, so
  // the first `limit` links come from the top of the page — there is no reason to keep running the
  // regexes across the rest of the (capped, but still large) HTML. This bounds the synchronous work
  // to the region actually consumed, so a pathological or padded page can't stall the event loop.
  const links = [];
  let lm;
  while (links.length < limit && (lm = linkRegex.exec(html)) !== null) {
    const decoded = decodeDdgRedirect(lm[1]);
    if (!decoded) continue;
    const title = stripHtml(lm[2]).trim();
    if (!title) continue;
    links.push({ pos: lm.index, url: decoded, title });
  }
  if (!links.length) return [];   // no results — skip the snippet scan entirely

  // Each result's snippet cell follows its link in document order, so only snippets up to just past
  // the last link are ever paired. Collect that far and stop, rather than sweeping the whole page.
  const lastLinkPos = links[links.length - 1].pos;
  const snippets = [];
  let sm;
  while ((sm = snippetRegex.exec(html)) !== null) {
    snippets.push({ pos: sm.index, text: stripHtml(sm[1]).trim() });
    if (sm.index > lastLinkPos) break;   // we now have the snippet that follows the last link
  }

  const results = [];
  let snippetIdx = 0;
  for (const link of links) {
    while (snippetIdx < snippets.length && snippets[snippetIdx].pos <= link.pos) snippetIdx++;
    const snippet = snippetIdx < snippets.length ? snippets[snippetIdx].text : '';
    results.push({ title: link.title, url: link.url, snippet });
    if (results.length >= limit) break;
  }
  return results;
};

// Strip an HTML document to readable text: drop script/style/svg/etc., convert
// block tags to newlines, strip remaining tags, decode common entities, collapse
// whitespace.
const extractReadableText = (html) => {
  if (!html || typeof html !== 'string') return '';
  // Remove whole script/style/noscript/svg/iframe blocks with a single linear pass. A pair-matching
  // regex here is quadratic on adversarial markup with many unclosed opening tags (each lazy body
  // scans to end-of-string and backtracks), a remotely-triggerable event-loop stall on a fetched page.
  const htmlstrip = require('./htmlstrip');
  let text = htmlstrip.stripElements(html, ['script', 'style', 'noscript', 'svg', 'iframe']);
  // Remove comments and all remaining tags (block tags → newline) in one linear pass. The previous regex
  // trio here (comment strip, block-tag→newline, and /<[^>]+>/g) was O(n²) on adversarial markup with many
  // unclosed `<` or `<!--`, a hang on a fetched page AND — because HTML is extracted inline on the main
  // process — on a crafted .html/.epub dropped into a watched folder. stripTags does the same job in O(n).
  text = htmlstrip.stripTags(text);
  text = decodeEntities(text);   // shared decoder: named + numeric refs, astral-safe (fromCodePoint)
  text = text.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
};

// Run a DuckDuckGo search. Returns { results: [{title, url, snippet}], error? }.
const searchWeb = async (query, count = 5, signal = null) => {
  const { webSearchTimeoutMs } = require('./config');
  if (signal?.aborted) return { results: [], error: 'aborted' };
  const url = SEARCH_URL + '?q=' + encodeURIComponent(query);
  try {
    // Route the search query through the outbound proxy pool when configured, retrying a blocked proxy
    // through the next one (tunable retry count); direct and single-attempt otherwise. The body is read and
    // the bot-wall check runs INSIDE the attempt so a 200-served challenge page (Cloudflare, DataDome, …)
    // is reported as blocked — then runWithProxy rotates to the next exit and scores this one "blocked"
    // (the exit reached the target; the target refused), rather than treating the wall as a good result.
    const outcome = await require('./webproxy').runWithProxy(
      async (proxyAgent) => {
        const res = await fetchWithTimeout(url, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
          dispatcher: proxyAgent || undefined,
        }, webSearchTimeoutMs, signal);
        if (!res.ok) return { ok: false, status: res.status };
        // Cap the DDG results HTML read. The lite listing is small (tens of KB), so a 1 MB cap is ample
        // while keeping the worst-case synchronous parse well below the per-page content cap.
        const html = await readCappedText(res, 1024 * 1024, { timeoutMs: webSearchTimeoutMs, signal });
        return { ok: true, html, blocked: require('./blockdetect').looksBlocked(html) };
      },
      { isBlocked: (r) => r && (r.blocked || (!r.ok && (r.status === 403 || r.status === 429 || r.status === 503))) },
    );
    if (!outcome.ok) {
      if (DEBUG) console.log(`  🌐 Web search failed — HTTP ${outcome.status}`);
      return { results: [], error: `search returned HTTP ${outcome.status}` };
    }
    if (outcome.blocked) {
      if (DEBUG) console.log('  🌐 Web search hit a bot-check/challenge page');
      return { results: [], error: 'search blocked by a bot-check page' };
    }
    const html = outcome.html;
    const results = parseDdgLite(html, count);
    // A 200 response that yields zero parsed results, on a non-trivial HTML body, is the fingerprint of a
    // DuckDuckGo markup change breaking the scrape (the selectors track DDG's lite HTML). Warn once so the
    // silent "web search stopped returning anything" has a diagnosable cause, rather than only surfacing
    // under DEBUG. Web search degrades gracefully to empty either way.
    if (results.length === 0 && html.length > 500 && !_warnedDdgEmpty) {
      _warnedDdgEmpty = true;
      console.warn('⚠️  Web search returned a page but no parseable results — DuckDuckGo may have changed its markup.');
    }
    if (DEBUG) console.log(`  🌐 Web search "${query}" → ${results.length} result(s)`);
    return { results };
  } catch (e) {
    if (DEBUG) console.log(`  🌐 Web search error: ${e.message}`);
    return { results: [], error: e.name === 'AbortError' ? 'search timed out' : e.message };
  }
};

// Fetch a page and return its readable text (capped). Returns '' on failure.
const fetchPageText = async (url, signal = null) => {
  const { webSearchTimeoutMs, webSearchMaxCharsPerPage } = require('./config');
  const { fetchNoPrivateRedirect } = require('./nethost');
  if (signal?.aborted) return '';
  // Only ever fetch over http(s). A non-http scheme (file:, gopher:, data:) is already fail-safe downstream
  // (an empty/invalid host is refused by the SSRF guard), but reject it up front so the intent is explicit and
  // a future change can't widen it. A page URL comes from a search result and is never fully trusted.
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  try {
    // Refuse a result URL that points at the local machine or a private network — the same SSRF guard URL
    // ingestion uses. A page's readable text is fed to the model as grounding context, so this keeps a
    // malicious result from steering the fetch at loopback/LAN. Redirects are followed manually and the
    // host is re-checked at every hop BEFORE it is contacted, so a public URL that 3xx-redirects to a
    // private address is never even requested (not just discarded after the fact).
    // Fetch through the proxy pool with retry-on-block (a blocked/failed proxy is retried through the next
    // one, up to the tunable retry count); direct and single-attempt when no proxy is configured. The proxy
    // dispatcher (or null for direct) is handed to fetchNoPrivateRedirect for every hop.
    const webproxy = require('./webproxy');
    // Read the body and run the bot-wall check INSIDE the attempt so a 200-served challenge page is reported
    // as blocked — runWithProxy then rotates to the next exit and scores this one "blocked" (the exit reached
    // the target; the target refused) instead of accepting the wall as a good page. A non-text response is
    // not a block (retrying won't help), so it returns empty text without triggering a retry.
    let outcome;
    try {
      outcome = await webproxy.runWithProxy(
        async (proxyAgent) => {
          const res = await fetchNoPrivateRedirect(url, (u, dispatcher) => fetchWithTimeout(u, {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
            redirect: 'manual',
            dispatcher,   // pinned vetted address (direct) or the proxy agent (proxied) — see fetchNoPrivateRedirect
          }, webSearchTimeoutMs, signal), 5, proxyAgent);
          if (!res.ok) return { ok: false, status: res.status };
          const contentType = res.headers.get('content-type') || '';
          // Only ingest an EXPLICIT text-ish Content-Type; a PDF/image/binary would be decoded as garbage. A
          // missing content-type is treated as non-text. Not a block — nothing to ingest, no retry.
          if (!/^text\/|application\/(xhtml\+xml|json|xml)|\+xml/i.test(contentType)) return { ok: true, text: '' };
          // Cap the body read in BYTES before extraction; a generous multiple of the char cap leaves room for
          // markup and multi-byte characters while bounding a hostile or runaway body to a few MB.
          const raw = await readCappedText(res, Math.max(65536, webSearchMaxCharsPerPage * 8), { timeoutMs: webSearchTimeoutMs, signal });
          if (/^text\/html/i.test(contentType) && require('./blockdetect').looksBlocked(raw)) return { ok: true, blocked: true };
          let text = /^text\/html/i.test(contentType) ? extractReadableText(raw) : raw;
          if (text.length > webSearchMaxCharsPerPage) text = text.slice(0, webSearchMaxCharsPerPage) + '\n\n[...truncated...]';
          return { ok: true, text };
        },
        { isBlocked: (r) => r && (r.blocked || (!r.ok && (r.status === 403 || r.status === 429 || r.status === 503))) },
      );
    } catch { return ''; }
    return (outcome && outcome.ok && !outcome.blocked && outcome.text) ? outcome.text : '';
  } catch {
    return '';
  }
};

// Heuristic: does this out-of-corpus query look like something the WEB could
// answer? Used to decide whether to offer a web-search fallback when the local
// documents have nothing. We want to offer for genuine factual / current-info
// questions ("weather in <city>", "latest node version", "who won the game")
// but NOT for nonsense, single stray tokens, or clearly personal/local requests
// the web can't help with. Deliberately conservative — a false "no" just means we
// show the normal out-of-scope message; a false "yes" wastes one offer the user
// can decline. Kept as a cheap heuristic (no LLM) so it works even with the intent
// classifier disabled.
const CURRENT_INFO_CUES = /\b(weather|forecast|temperature|news|latest|current|today|tonight|tomorrow|yesterday|now|recent|price|stock|score|game|who won|when is|when did|when was|what time|how much|how many|population|capital of|located|near me|directions|open now|hours|release date|released|version|update|schedule|results?)\b/i;

const looksWebAnswerable = (query) => {
  if (!query || typeof query !== 'string') return false;
  const q = query.trim();
  // A non-English query is checked FIRST, before the word-count guard below: a space-free script (CJK) is a
  // single "word" and would be rejected as too-short, and the English cue/question-word rules can't match it
  // either — so a non-English out-of-corpus query would silently get only the out-of-scope message, never a
  // web offer. The shared language detector (fail-open) covers both non-Latin scripts and Latin-script
  // non-English (Spanish, French, …). Offering is cheap (the user can decline), so err toward offering
  // rather than leaving non-English users with no fallback. English keeps the stricter rules below.
  if (require('./langdetect').isLikelyNonEnglish(q)) return true;
  // Too short / single token — likely a stray term, not a question.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  // Obvious current-info / factual cues → yes.
  if (CURRENT_INFO_CUES.test(q)) return true;
  // A question phrased as a question (ends in ? or the full-width ？, or starts with a question word)
  // with a few content words is a reasonable web candidate.
  const startsQuestion = /^(what|who|where|when|why|how|which|is|are|does|do|can|could|will|should)\b/i.test(q);
  if ((/[?？]$/.test(q) || startsQuestion) && words.length >= 3) return true;
  return false;
};

// Strong "live / time-sensitive" cues — questions no static document can answer
// because the answer changes over time (a current price, today's weather, the
// latest release). This is deliberately NARROWER than looksWebAnswerable: it exists
// so the web-offer gate can bypass the reranker-score check for these questions.
// Without it, a topically-adjacent document (e.g. a "Trading Strategies.pdf" scoring
// positively for "what is the current price of Bitcoin today?") would be mistaken for
// a genuine answer, suppressing the web offer AND burning the full retry budget on a
// corpus that structurally cannot answer a live question.
const CURRENT_INFO_STRONG = /\b(today|tonight|tomorrow|yesterday|right now|currently|current|latest|live|breaking|as of (today|now)|this (week|month|year|morning|afternoon|evening)|up[- ]?to[- ]?date|weather|forecast|temperature|stock price|share price|exchange rate|who won|final score)\b/i;
const PRICE_TERMS   = /\b(price|cost|worth|value|quote|rate)\b/i;
const NOW_TERMS     = /\b(today|now|current|currently|latest|live|right now|this (week|month|year))\b/i;

const looksCurrentInfo = (query) => {
  if (!query || typeof query !== 'string') return false;
  const q = query.trim();
  if (CURRENT_INFO_STRONG.test(q)) return true;
  // A price/value question with any "now"-ish cue is time-sensitive.
  if (PRICE_TERMS.test(q) && NOW_TERMS.test(q)) return true;
  return false;
};

module.exports = { searchWeb, fetchPageText, looksWebAnswerable, looksCurrentInfo, _extractReadableText: extractReadableText, _readCappedText: readCappedText, _parseDdgLite: parseDdgLite, _decodeBuffer: decodeBuffer };
