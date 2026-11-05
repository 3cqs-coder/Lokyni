'use strict';
// Guards that live web search is cancellable (lib/websearch.js + its callers). A New/disconnect during
// a web-grounded answer or a deep-research round must free the serialized turn queue promptly, not leave
// an abandoned search or page fetch running out its ~15s timeout while the user's next question waits.
// The turn's AbortController signal is threaded through answerFromWeb/researchWeb into searchWeb and
// fetchPageText, and fetchWithTimeout links it to the per-request controller. This test proves the
// early-bail happens with NO network (an already-aborted signal returns immediately) and source-guards
// the plumbing so a refactor can't quietly drop the signal. It also checks the response body is read
// with a byte cap, so an attacker-influenceable web result can't balloon memory. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ws = require(path.join(PROJECT, 'lib', 'websearch'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // ── Functional: an already-aborted signal short-circuits before any network call ──
    const aborted = AbortSignal.abort();
    const sr = await ws.searchWeb('anything at all', 3, aborted);
    ok(sr && Array.isArray(sr.results) && sr.results.length === 0 && sr.error === 'aborted',
      'searchWeb returns immediately with an aborted marker when the signal is already aborted (no network)');
    const txt = await ws.fetchPageText('https://example.com/', aborted);
    ok(txt === '', 'fetchPageText returns empty immediately when the signal is already aborted (no network)');

    // ── Source guard: the signal is threaded end to end ──
    const wsSrc   = fs.readFileSync(path.join(PROJECT, 'lib', 'websearch.js'), 'utf-8');
    const answer  = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'webanswer.js'), 'utf-8');
    const deep    = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'deepresearch.js'), 'utf-8');
    const socket  = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');

    // fetchWithTimeout is single-sourced in lib/fetchtimeout.js and imported by websearch (and the other
    // network callers), so the external-signal linking lives there now.
    const ftSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'fetchtimeout.js'), 'utf-8');
    ok(/const \{ fetchWithTimeout \} = require\('\.\/fetchtimeout'\)/.test(wsSrc),
      'websearch imports the shared fetchWithTimeout');
    ok(/const fetchWithTimeout = async \(url, opts = \{\}, timeoutMs = 15000, extSignal = null\)/.test(ftSrc),
      'fetchWithTimeout accepts an external signal');
    ok(/extSignal\.addEventListener\('abort', onExt, \{ once: true \}\)/.test(ftSrc) && /removeEventListener\('abort', onExt\)/.test(ftSrc),
      'fetchWithTimeout links and cleans up the external abort listener');
    ok(/const searchWeb = async \(query, count = 5, signal = null\)/.test(wsSrc) && /if \(signal\?\.aborted\) return \{ results: \[\], error: 'aborted' \};/.test(wsSrc),
      'searchWeb accepts a signal and early-bails when aborted');
    ok(/const fetchPageText = async \(url, signal = null\)/.test(wsSrc) && /if \(signal\?\.aborted\) return '';/.test(wsSrc),
      'fetchPageText accepts a signal and early-bails when aborted');

    ok(/const answerFromWeb = async \(query, conversationContext, signal = null\)/.test(answer)
      && /searchWeb\(query, webSearchResultCount, signal\)/.test(answer)
      && /fetchPageText\(r\.url, signal\)/.test(answer),
      'answerFromWeb threads the signal into searchWeb and fetchPageText');
    ok(/await answerFromWeb\(q, conversationContext, abortW\.signal\)/.test(socket),
      'the socket web path passes its turn abort signal into answerFromWeb');

    ok(/const researchWeb = async \(subq, signal = null\)/.test(deep)
      && /searchWeb\(subq, webSearchResultCount, signal\)/.test(deep)
      && /fetchPageText\(r\.url, signal\)/.test(deep)
      && /researchWeb\(subq, signal\)/.test(deep),
      'deep research threads the signal through researchWeb into searchWeb and fetchPageText');

    // ── Functional: the body read is byte-capped, so a huge/hostile page can't balloon memory ──
    // A result URL is attacker-influenceable and the fetch is time-bounded but not byte-bounded, so the
    // body is streamed and stopped at a cap rather than buffered whole. Feed a fake Response whose
    // stream would yield far more than the cap and confirm the read stops at the cap and cancels.
    const fakeStreamRes = (totalBytes, chunk = 64 * 1024) => {
      let served = 0, cancelled = false;
      return {
        get cancelled() { return cancelled; },
        body: { getReader() { return {
          async read() {
            if (served >= totalBytes) return { done: true };
            const n = Math.min(chunk, totalBytes - served); served += n;
            return { done: false, value: new Uint8Array(n).fill(65) }; // 'A'
          },
          async cancel() { cancelled = true; },
        }; } },
      };
    };
    const cap = 256 * 1024;
    const res = fakeStreamRes(8 * 1024 * 1024);   // 8 MB body, 256 KB cap
    const capped = await ws._readCappedText(res, cap);
    ok(Buffer.byteLength(capped) === cap, 'readCappedText returns exactly the byte cap for an over-long body');
    ok(res.cancelled === true, 'readCappedText cancels the stream once the cap is reached (no full drain)');
    // Fallback path: a Response with no readable stream still gets capped via text().
    const noStream = { async text() { return 'x'.repeat(cap * 4); } };
    const cappedFallback = await ws._readCappedText(noStream, cap);
    ok(cappedFallback.length === cap, 'readCappedText caps the fallback text() path too');

    // ── The body read is TIME-BOUNDED and ABORTABLE, not only byte-capped. fetchWithTimeout clears its own timer
    //    once the headers resolve, so without this a peer that trickles the body could stall the read forever and a
    //    mid-body turn-cancel wouldn't stop it. A stalled reader resolves done:true on cancel() (like a real stream). ──
    const stalledRes = () => {
      let resolveRead = null, cancelled = false;
      return { headers: { get: () => 'text/html' }, body: { getReader() { return {
        read: () => cancelled ? Promise.resolve({ done: true }) : new Promise((r) => { resolveRead = r; }),
        cancel: async () => { cancelled = true; if (resolveRead) { resolveRead({ done: true }); resolveRead = null; } },
      }; } } };
    };
    let timedOut = false;
    try { await ws._readCappedText(stalledRes(), cap, { timeoutMs: 40 }); } catch { timedOut = true; }
    ok(timedOut, 'readCappedText throws when a stalled body exceeds the timeout (no indefinite hang)');
    let abortedRead = false;
    const ac = new AbortController(); ac.abort();
    try { await ws._readCappedText(stalledRes(), cap, { timeoutMs: 5000, signal: ac.signal }); } catch { abortedRead = true; }
    ok(abortedRead, 'readCappedText throws immediately when its signal is already aborted (prompt mid-body cancel)');

    console.log(`\nALL WEBSEARCH-ABORT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ WEBSEARCH-ABORT UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
