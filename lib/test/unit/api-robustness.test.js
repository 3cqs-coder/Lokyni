'use strict';
// Guards two API-surface robustness properties that are awkward to exercise over real HTTP (they need the
// full server or a live model), so they are checked at the source level, matching the drift-guard style used
// for the rest of the data plane:
//   1. A terminal error handler turns a malformed or oversized request body into a JSON error with the right
//      status, instead of Express's default HTML page (which also leaks the error text off production).
//   2. The OpenAI-compatible chat endpoint accepts multi-part array `content`, not only a bare string, so a
//      modern client's message isn't silently dropped; conversation history is capped.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const server = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
const apiCore = fs.readFileSync(path.join(PROJECT, 'lib', 'api-core.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── 1. terminal JSON error handler for body-parser failures ──
  const handler = server.slice(server.indexOf('app.use((err, req, res, next)'));
  ok(/app\.use\(\(err, req, res, next\)/.test(server), 'a 4-arg terminal error handler is registered');
  ok(/entity\.parse\.failed[\s\S]*?status\(400\)[\s\S]*?json\(/.test(handler), 'malformed JSON returns 400 as JSON');
  ok(/entity\.too\.large|413[\s\S]*?json\(/.test(handler), 'an oversized body returns 413 as JSON');
  ok(/status\(500\)\.json\(\{ error: 'Request failed' \}\)/.test(handler), 'the fallback is a generic 500 JSON, not the raw error');
  ok(!/status\(500\)\.json\(\{ error: err/.test(handler), 'the handler never returns the raw error text to the caller');
  // It must be the LAST middleware, after the routers, or it would not catch route/body-parser errors.
  ok(server.indexOf('app.use((err, req, res, next)') > server.lastIndexOf("app.use('/api/"), 'the error handler is registered after the API routers');
  console.log('✓ api-robustness: a malformed/oversized body yields a JSON error, generic 500 fallback, registered last');

  // ── 2. chat/completions coerces multi-part content and caps history ──
  ok(/contentToText/.test(apiCore) && /Array\.isArray\(c\)/.test(apiCore), 'chat content coercion handles the array (multi-part) form');
  ok(/p\.type === 'text'/.test(apiCore), 'array content joins the text parts');
  ok(/MAX_HISTORY_TURNS/.test(apiCore) && /slice\(-MAX_HISTORY_TURNS\)/.test(apiCore), 'conversation history is capped to the most recent turns');
  console.log('✓ api-robustness: OpenAI-compatible chat accepts multi-part content and caps history');

  console.log(`\nALL API-ROBUSTNESS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ API-ROBUSTNESS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
