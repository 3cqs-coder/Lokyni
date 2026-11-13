'use strict';
// fetch() with an abort-based timeout, single-sourced so every network caller behaves the same:
//   • the timeout timer is unref'd, so a pending fetch never keeps the process alive at shutdown;
//   • an optional external abort signal (a request/turn controller) is linked, so a cancel or client
//     disconnect aborts the in-flight request promptly instead of letting it run to the timeout;
//   • a dispatcher is honored when supplied — the SSRF-pinned page fetch passes an undici dispatcher that
//     must be used, so this switches to undici's fetch for that case and uses the global fetch otherwise.
// Returns the Response, or throws (a timeout/cancel surfaces as an AbortError). This has no app dependencies
// so any module can require it without a cycle.

let _undiciFetch = null;

const fetchWithTimeout = async (url, opts = {}, timeoutMs = 15000, extSignal = null) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  const onExt = () => controller.abort();
  if (extSignal) {
    if (extSignal.aborted) controller.abort();
    else extSignal.addEventListener('abort', onExt, { once: true });
  }
  try {
    const doFetch = opts.dispatcher ? (_undiciFetch || (_undiciFetch = require('undici').fetch)) : fetch;
    return await doFetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (extSignal) { try { extSignal.removeEventListener('abort', onExt); } catch { /* best-effort */ } }
  }
};

// fetch + read the body as text under ONE timeout that stays armed across the body read, with a running byte
// cap. fetchWithTimeout clears its timer once the headers resolve, so a caller that then reads res.text()
// reads untimed and unbounded — a peer that lies about (or omits) content-length and trickles a huge body can
// hang the call or exhaust memory. This reads the body as a stream, aborts the moment it exceeds maxBytes, and
// only clears the timer after the body is fully consumed, so both the size cap and the timeout cover the body.
// Returns { res, text }. A mocked/body-less Response falls back to res.text() (still capped after the fact).
const fetchTextCapped = async (url, opts = {}, { timeoutMs = 15000, maxBytes = 1024 * 1024, extSignal = null } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  const onExt = () => controller.abort();
  if (extSignal) {
    if (extSignal.aborted) controller.abort();
    else extSignal.addEventListener('abort', onExt, { once: true });
  }
  try {
    const doFetch = opts.dispatcher ? (_undiciFetch || (_undiciFetch = require('undici').fetch)) : fetch;
    const res = await doFetch(url, { ...opts, signal: controller.signal });
    // Reject a declared over-cap length up front (cheap), then enforce the real cap while streaming so a
    // lying/absent content-length can't defeat it.
    const declared = Number(res.headers.get && res.headers.get('content-length')) || 0;
    if (declared && declared > maxBytes) { try { controller.abort(); } catch { /* best-effort */ } throw new Error('response body exceeds cap'); }
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) { try { await reader.cancel(); } catch { /* best-effort */ } controller.abort(); throw new Error('response body exceeds cap'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      // No streamable body (a mocked Response, or an engine without getReader) — read then cap.
      text = await res.text();
      if (text.length > maxBytes) throw new Error('response body exceeds cap');
    }
    return { res, text };
  } finally {
    clearTimeout(timer);
    if (extSignal) { try { extSignal.removeEventListener('abort', onExt); } catch { /* best-effort */ } }
  }
};

module.exports = { fetchWithTimeout, fetchTextCapped };
