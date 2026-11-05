'use strict';
// Guards the HTTP delivery layer: response compression and its safety exclusions, the baseline
// security headers, and the JSON 404 for unknown API routes. These are easy to delete during an
// unrelated refactor, and the failure mode is silent (a streamed answer stalls, an archive is
// recompressed, a client receives an HTML error page, or a browser sniffs an uploaded file as
// script). Static source checks only. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const server = read('lib/server.js');
  const pkg = require(path.join(ROOT, 'package.json'));

  // ── Compression ──
  ok(!!pkg.dependencies.compression, 'the compression middleware is a declared runtime dependency');
  ok(/app\.use\(compression\(\{/.test(server), 'the server installs response compression');
  ok(/type\.includes\('text\/event-stream'\)/.test(server) && /return false/.test(server),
    'server-sent events are excluded from compression (no token buffering)');
  ok(/type\.includes\('application\/octet-stream'\)/.test(server),
    'octet-stream downloads are excluded from compression (already-compressed archives)');
  ok(/statusCode === 206/.test(server), 'partial (range) responses are not compressed (seeking keeps working)');
  ok(/Content-Disposition/.test(server) && /attachment/.test(server),
    'attachment downloads are excluded from compression');
  ok(/threshold: 1024/.test(server), 'tiny responses are not compressed');

  // ── Security headers ──
  ok(/app\.disable\('x-powered-by'\)/.test(server), 'the Express fingerprint header is disabled');
  for (const header of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) {
    ok(new RegExp(`res\\.setHeader\\('${header}'`).test(server), `the server sets ${header} on responses`);
  }

  // ── API 404 stays JSON ──
  ok(/app\.use\('\/api', \(req, res\) => res\.status\(404\)\.json\(\{ error: 'Not found' \}\)\);/.test(server),
    'an unknown /api route returns a JSON 404, not an HTML error page');

  console.log(`\nALL HTTP-DELIVERY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ HTTP-DELIVERY UNIT TEST FAILED:', e.message);
  process.exit(1);
}
