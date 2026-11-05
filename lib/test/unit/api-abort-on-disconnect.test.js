'use strict';
// Guards that a disconnecting HTTP client aborts the model work it started, so a caller who walks away
// never leaves a generation running to completion and holding one of the bounded generation-concurrency
// slots. The streaming endpoints already did this; this covers the NON-streaming JSON paths and the shared
// mechanism they rely on:
//   • streamChat honors an optional opts.signal — it stops between chunks, treats an abort-interrupted
//     chunk as a clean stop (not an error), and its finally aborts the underlying provider request.
//   • runSummarize forwards a caller signal down to that stream (via summarizeToString → completeChat).
//   • the non-streaming /chat/completions and /summarize handlers wire res 'close' to that abort and stop.
// The behavior needs a live model provider to exercise end to end, so these are source-inspection guards
// (the same approach provider-timeout.test.js uses for streamChat's timeout wiring). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

async function main() {
 try {
  // ── Functional: streamChat with an already-aborted signal yields nothing and never contacts a provider ──
  // Exercises the early-abort path directly (no live model needed): a caller who has already disconnected
  // gets an empty, clean generation rather than a thrown error or a started request.
  {
    const { streamChat } = require(path.join(PROJECT, 'lib', 'llm'));
    const ac = new AbortController();
    ac.abort();
    let chunks = 0, threw = false;
    try { for await (const c of streamChat([{ role: 'user', content: 'hi' }], { signal: ac.signal })) { void c; chunks++; } }
    catch { threw = true; }
    ok(chunks === 0 && !threw, 'streamChat with an already-aborted signal yields nothing and does not throw');
  }

  const llm = read('lib/llm.js');
  const core = read('lib/api-core.js');
  const summarize = read('lib/summarize.js');
  const apiv1 = read('lib/routes/apiv1.js');

  // ── streamChat honors an abort signal ──
  ok(/const signal = opts\.signal \|\| null;/.test(llm), 'streamChat reads an optional caller signal');
  ok(/if \(signal\?\.aborted\) \{ cleanup\(\); return; \}/.test(llm), 'streamChat returns immediately if already aborted, aborting the request');
  ok(/signal\.addEventListener\('abort', onAbort/.test(llm) && /signal\.removeEventListener\('abort', onAbort\)/.test(llm),
    'streamChat registers an abort listener and removes it in finally (no leaked listener)');
  ok(/if \(signal\?\.aborted\) break;/.test(llm), 'streamChat stops between chunks when the caller aborts');
  ok(/if \(signal\?\.aborted\) \{ cleanup\(\); break; \}/.test(llm), 'an abort-interrupted chunk is a clean stop, not a propagated error');
  ok(/if \(signal\?\.aborted\) \{ cleanup\(\); return; \}\s*\n\s*throw e;/.test(llm),
    'an abort during request establishment (outer catch) is a clean stop, not a propagated error');
  ok(/create\(\{ model, messages, stream: true, temperature, max_tokens: maxTokens, \.\.\.fmt \}, internalAbort \? \{ signal: internalAbort\.signal \} : undefined\)/.test(llm),
    'the OpenAI request receives an internal abort signal, so both a caller abort and an idle timeout cancel the HTTP request immediately');
  ok(/const internalAbort = isOpenAI \? new AbortController\(\) : null;/.test(llm) && /internalAbort && !internalAbort\.signal\.aborted\) internalAbort\.abort\(\)/.test(llm),
    'cleanup() aborts the OpenAI request too (idle timeout previously only aborted the Ollama client)');

  // ── the summarize core forwards a caller signal to the stream ──
  ok(/const runSummarize = async \(workspaceId, docId, opts = \{\}\) =>/.test(core), 'runSummarize accepts an options object with a signal');
  ok(/summarizeToString\(entry, \{ signal: opts\.signal \}\)/.test(core), 'runSummarize forwards the signal to summarizeToString');
  ok(/const summarizeToString = async \(entry, opts = \{\}\)/.test(summarize) && /completeChat\(req\.messages, opts/.test(summarize),
    'summarizeToString forwards its options (incl. signal) to completeChat, which drains streamChat');

  // ── shared disconnect/abort helpers, created BEFORE the generation gate (so a disconnect while QUEUED is
  //    caught) and threaded INTO the model calls (so generation aborts at the provider, not just the loop) ──
  ok(/const disconnectSignal = \(res\) => \{[\s\S]*?res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) ac\.abort\(\); \}\)/.test(apiv1),
    'a shared disconnectSignal(res) wires an AbortController to client disconnect');
  ok(/const drain = async \(stream, signal\) =>/.test(apiv1) && /if \(signal && signal\.aborted\) return null;/.test(apiv1),
    'a shared drain(stream, signal) stops consuming the moment the client disconnects');
  ok(/const ac = disconnectSignal\(res\);\s*\n\s*if \(!\(await acquireGen\(res\)\)\) return;/.test(apiv1),
    'the disconnect signal is created before the generation gate (a queue-wait disconnect is caught, then re-checked)');
  // /chat/completions: the signal is threaded into runGroundedChat (aborts the model at the provider) and both
  // branches drain through it; a client that left during retrieval skips generation.
  ok(/const r = await runGroundedChat\(ws\.id, messages, \{ signal: ac\.signal \}\);\s*\n\s*if \(ac\.signal\.aborted\) return;/.test(apiv1),
    'chat threads the disconnect signal into runGroundedChat and skips generation if the client already left');
  ok(/let answer = await drain\(r\.stream, ac\.signal\);/.test(apiv1),
    'the chat answer is drained through the disconnect signal (both branches)');
  // /summarize: the signal (from disconnectSignal, before the gate) is passed into runSummarize (non-stream) and
  // threaded into streamChat (stream) — previously the streaming path only had a consumer-loop flag.
  ok(/const r = await runSummarize\(ws\.id, docId, \{ signal: ac\.signal \}\)/.test(apiv1),
    'the non-streaming summarize handler aborts runSummarize on client disconnect');
  // The two SSE egress paths (summarize, synthesize) share emitFinalizedSSE; it must drain through the signal so
  // both still abort generation at the provider on client disconnect.
  ok(/const emitFinalizedSSE = async \(res, stream, signal, finalize\) => \{[\s\S]*?drain\(stream, signal\)/.test(apiv1),
    'the shared SSE finalizer drains through the disconnect signal (both SSE paths abort at the provider)');
  ok(/emitFinalizedSSE\(res, streamChat\(reqObj\.messages, \{ signal: ac\.signal \}\), ac\.signal\)/.test(apiv1),
    'the streaming summarize path threads the signal into streamChat and the shared SSE finalizer');
  ok(/if \(ac\.signal\.aborted\) return;/.test(apiv1), 'the summarize handler does not write to a closed response');

  // ── ingest-url aborts the browser-backed fetch on disconnect so the scarce browser slot frees early ──
  ok(/res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) ac\.abort\(\); \}\);[\s\S]*?fetchAndSaveArticle\(url, docsDir, ac\.signal\)/.test(apiv1),
    'ingest-url wires client disconnect to an abort and passes the signal into the fetch');
  const urlfetch = fs.readFileSync(path.join(PROJECT, 'lib', 'urlfetch.js'), 'utf-8');
  ok(/const captureHtml = async \(url, signal = null, proxyUrl = ''\)/.test(urlfetch) && /signal\?\.aborted\) return ''/.test(urlfetch),
    'captureHtml takes a signal and does not take a browser slot once aborted');
  ok(/signal\.addEventListener\('abort', onAbort, \{ once: true \}\)/.test(urlfetch) && /browser && browser\.close\(\)/.test(urlfetch),
    'an abort closes the browser so the in-flight page load ends and the slot frees immediately');

  // Every model-backed endpoint releases its concurrency slot in a finally regardless of abort (guarded
  // in detail by apiv1-hardening.test.js) — abort just releases it sooner by ending the work early.
  ok(/_genGate\.release\(\);/.test(apiv1), 'the generation slot is still released (in finally) on the abort path');

  console.log('✓ api-abort-on-disconnect: non-streaming chat + summarize abort the model on client disconnect; the slot frees early');
  console.log(`\nALL API-ABORT-ON-DISCONNECT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
 } catch (e) {
  console.error('\n✗ API-ABORT-ON-DISCONNECT UNIT TEST FAILED:', e.message);
  process.exit(1);
 }
}
main();
