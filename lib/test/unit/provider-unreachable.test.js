'use strict';
// Guards the "no language model connected" message: when a question can't be answered because the LANGUAGE-MODEL
// provider is unreachable (Ollama not running, a wrong host, a missing/invalid key), the chat must say so clearly
// and actionably — not a generic "processing failed" — while making clear that SEARCH still works (only writing
// the answer needs a model; the embedder is separate). If the detector misses a real connection error, the user
// is left staring at a useless error; if it false-positives on a content error, a real bug gets mislabeled.
// Pure and hermetic — no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const llm = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── recognizes a down provider across both transports and error shapes ──
  const connErrors = [
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),  // Ollama not running
    new TypeError('fetch failed'),                                                                // undici/Ollama fetch
    { name: 'APIConnectionError', message: 'Connection error.' },                                 // OpenAI SDK
    { name: 'APIConnectionTimeoutError', message: 'Request timed out.' },                         // OpenAI SDK
    Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }),      // bad host
    Object.assign(new Error('wrapped'), { cause: { code: 'ECONNRESET' } }),                        // wrapped cause
    new Error('could not connect to the server'),
    Object.assign(new Error('Incorrect API key provided'), { status: 401 }),                        // missing/invalid key
    { name: 'AuthenticationError', message: '401 Unauthorized' },                                   // OpenAI SDK auth
  ];
  for (const e of connErrors) ok(llm.isProviderConnectionError(e), `unusable-provider error recognized: ${e.code || e.name || e.message}`);

  // ── does NOT fire on content/model/rate errors or on nothing (those must keep the generic path) ──
  const notConn = [
    new Error('model produced invalid JSON'),
    new Error('context length exceeded'),
    Object.assign(new Error('rate limited'), { status: 429 }),
    Object.assign(new Error('model not found'), { status: 404 }),
    null, undefined, {},
  ];
  for (const e of notConn) ok(!llm.isProviderConnectionError(e), `non-connection error ignored: ${e && (e.message || 'empty')}`);

  // ── the message is clear, actionable, provider-specific, and always reassures that search still works ──
  const mOllama = llm.providerUnreachableMessage({ AI_PROVIDER: 'ollama', LLM_MODEL: 'llama3.2' });
  ok(/No language model is connected/.test(mOllama), 'ollama: states no model is connected');
  ok(/searchable/.test(mOllama), 'ollama: reassures that documents are still searchable (embedder is separate)');
  ok(/ollama pull llama3\.2/.test(mOllama) && /Settings/.test(mOllama), 'ollama: gives the exact fix and points to Settings');

  const mOpenAI = llm.providerUnreachableMessage({ AI_PROVIDER: 'openai' });
  ok(/API key/i.test(mOpenAI) && /Settings/.test(mOpenAI), 'openai: points at the key/base URL in Settings');
  const mAnthropic = llm.providerUnreachableMessage({ AI_PROVIDER: 'anthropic' });
  ok(/Anthropic/.test(mAnthropic), 'anthropic: names the provider');
  const mUnknown = llm.providerUnreachableMessage({ AI_PROVIDER: 'something-else' });
  ok(/Settings/.test(mUnknown) && /searchable/.test(mUnknown), 'unknown provider: still gives generic, reassuring guidance');

  // ── the answer paths actually USE it: every generic answer-failure catch routes through the helper first ──
  const socketSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
  ok(/const emitProviderDownIfApplicable = \(client, error\)/.test(socketSrc), 'socket defines the shared provider-down emitter');
  ok(/isProviderConnectionError\(error\)/.test(socketSrc) && /providerUnreachableMessage\(require\('\.\/config'\)\)/.test(socketSrc),
    'the emitter checks the detector and sends the clear message');
  ok((socketSrc.match(/emitProviderDownIfApplicable\(client, (error|e)\)/g) || []).length >= 4,
    'the document, synthesis, web, and deep-research failure paths all route through it (no generic-only path)');
  ok(/if \(!emitProviderDownIfApplicable\(client, error\)\) client\.emit\('error', 'Processing failed'\)/.test(socketSrc),
    'the main document-answer catch shows the clear message instead of a bare "Processing failed"');

  console.log('✓ provider-unreachable: detector covers both transports, message is actionable, all answer paths use it');
  console.log(`\nALL PROVIDER-UNREACHABLE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PROVIDER-UNREACHABLE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
