'use strict';
// Unit tests for the shared fetch-with-timeout helper (lib/fetchtimeout.js). It is the single network-fetch
// primitive for OIDC, the Ollama/OpenAI probes, and web search, so its contract must hold: abort on timeout,
// abort promptly on an external signal (before and during the request), clean success, and no leaked listener.
// Drives the real helper with a stubbed global.fetch. Run: `npm run test:unit`.

const assert = require('assert'), path = require('path');
const { fetchWithTimeout, fetchTextCapped } = require(path.resolve(__dirname, '..', '..', 'fetchtimeout'));

// A minimal streamable body (web-ReadableStream-shaped) yielding the given byte chunks once.
const enc = (s) => new TextEncoder().encode(s);
const makeBody = (chunks) => { let i = 0; return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: async () => {} }) }; };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
// A fetch that only ever settles by rejecting when its signal aborts — models a hung endpoint.
const hangingFetch = (url, opts) => new Promise((_resolve, reject) => {
  if (opts.signal.aborted) return reject(abortErr());
  opts.signal.addEventListener('abort', () => reject(abortErr()), { once: true });
});

(async () => {
  const orig = global.fetch;
  try {
    // 1. Times out when the endpoint hangs past the deadline.
    global.fetch = hangingFetch;
    await assert.rejects(fetchWithTimeout('http://x', {}, 20), e => e.name === 'AbortError', 'a hung fetch aborts at the timeout');

    // 2. An already-aborted external signal aborts immediately.
    const pre = new AbortController(); pre.abort();
    await assert.rejects(fetchWithTimeout('http://x', {}, 10000, pre.signal), e => e.name === 'AbortError', 'a pre-aborted external signal aborts at once');

    // 3. An external signal that fires DURING the request aborts it promptly (not at the long timeout).
    const mid = new AbortController();
    const p = fetchWithTimeout('http://x', {}, 10000, mid.signal);
    setTimeout(() => mid.abort(), 10);
    const t0 = Date.now();
    await assert.rejects(p, e => e.name === 'AbortError', 'an external abort mid-flight rejects');
    ok(Date.now() - t0 < 5000, 'external abort is prompt (well under the timeout)');
    // The listener is removed in finally, so the controller holds no lingering abort listener.

    // 4. A fast success resolves normally and the timeout never fires.
    global.fetch = async () => ({ ok: true, status: 200 });
    const r = await fetchWithTimeout('http://x', {}, 1000);
    ok(r && r.ok && r.status === 200, 'a fast response resolves cleanly');

    // 5. The external signal's listener is cleaned up after a successful call (no accumulation).
    const live = new AbortController();
    await fetchWithTimeout('http://x', {}, 1000, live.signal);
    live.abort();   // must not throw or double-fire anything; the helper already removed its listener

    // ── fetchTextCapped: timeout stays armed across the body, and the body is byte-capped ──
    // 6. A streamed body exceeding maxBytes is rejected (a lying/absent content-length can't defeat the cap).
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody([enc('a'.repeat(100)), enc('b'.repeat(100))]) });
    await assert.rejects(fetchTextCapped('http://x', {}, { timeoutMs: 1000, maxBytes: 150 }), e => /exceeds cap/.test(e.message), 'a streamed body over the cap is rejected');

    // 7. A declared content-length over the cap is rejected up front.
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? '999999' : null) }, body: makeBody([enc('x')]) });
    await assert.rejects(fetchTextCapped('http://x', {}, { timeoutMs: 1000, maxBytes: 100 }), e => /exceeds cap/.test(e.message), 'a declared over-cap content-length is rejected');

    // 8. A streamed body under the cap is read fully.
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody([enc('hello '), enc('world')]) });
    const capped = await fetchTextCapped('http://x', {}, { timeoutMs: 1000, maxBytes: 100 });
    ok(capped.text === 'hello world' && capped.res.ok, 'a streamed body under the cap is read fully');

    // 9. A body-less (mocked) Response falls back to text() and is capped afterward.
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'plain' });
    const fb = await fetchTextCapped('http://x', {}, { timeoutMs: 1000, maxBytes: 100 });
    ok(fb.text === 'plain', 'a body-less Response falls back to text()');
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'z'.repeat(200) });
    await assert.rejects(fetchTextCapped('http://x', {}, { timeoutMs: 1000, maxBytes: 100 }), e => /exceeds cap/.test(e.message), 'a body-less over-cap text() is rejected');

    console.log(`\nALL FETCHTIMEOUT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ FETCHTIMEOUT UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    global.fetch = orig;
  }
})();
