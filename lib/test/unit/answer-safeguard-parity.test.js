'use strict';
// Guards answer-safeguard PARITY across every answering surface. A grounded (document-cited) answer must get
// the same egress safeguards no matter which surface produced it — the chat socket (streamed + evented), the
// HTTP API / scheduled automations (one finished string), and the MCP surface (retrieval-only).
//
// The ordered deterministic TEXT safeguards — the verify pass, then the invented-citation caveat — live in ONE
// place: lib/answerfinalize.js `groundedTextParts`. Both finalizers build on it: `finalizeGrounded` (for a
// one-string surface) concatenates the parts and appends the numeric-grounding caveat; `finalizeGroundedStreamed`
// (for the streamed socket) returns the parts so the socket can emit each as its own event. Because BOTH go
// through groundedTextParts, a new TEXT safeguard added there reaches every surface at once — it is impossible
// to add it to one and miss the other. This test locks that structure in. The numeric-grounding safeguard is
// the one piece rendered differently per surface (an inline caveat on a one-string surface via appendFigureCaveat,
// an async turn-tagged badge on the socket), so it is checked on both surfaces separately. Pure/offline source
// guard. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, 'lib', p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const finalizeSrc = read('answerfinalize.js');
  const socketSrc   = read('socket.js');
  const apiSrc      = read('routes/apiv1.js');
  const autoSrc     = read('automations.js');

  // ── The ordered TEXT safeguards are single-sourced in groundedTextParts (verify → citation caveat) ──
  ok(/const groundedTextParts = \(answer, sources, idx\) => \{[\s\S]*?require\('\.\/verify'\)\.finalize\(answer\)[\s\S]*?require\('\.\/grounding'\)\.caveatFor\(text, sources\)[\s\S]*?quoteCaveatFor\(text, sources, idx\)/.test(finalizeSrc),
    'groundedTextParts applies the verify pass then the invented-citation caveat, in order, in one place');

  // ── BOTH finalizers build on groundedTextParts, so neither can carry a different TEXT sequence ──
  ok(/const finalizeGrounded = \(answer, sources, idx\) => \{[\s\S]*?groundedTextParts\(answer, sources, idx\)[\s\S]*?appendFigureCaveat\(text \+ caveat, sources, idx\)/.test(finalizeSrc),
    'finalizeGrounded (one-string surface) uses groundedTextParts and appends the numeric-grounding caveat');
  ok(/const finalizeGroundedStreamed = \(answer, sources, idx\) => \{[\s\S]*?groundedTextParts\(answer, sources, idx\)[\s\S]*?return \{ text, changed: text !== answer, caveat \}/.test(finalizeSrc),
    'finalizeGroundedStreamed (socket) uses the SAME groundedTextParts and returns the parts for the caller to emit');

  // ── The streamed finalizer is a PURE function (emits nothing itself) so a caller controls order and it can
  //    never block the event loop or throw mid-emit ──
  ok(!/finalizeGroundedStreamed = \(answer, sources, idx\) => \{[\s\S]*?client\.emit/.test(finalizeSrc) && !/finalizeGroundedStreamed[\s\S]*?\bemit\(/.test(finalizeSrc),
    'finalizeGroundedStreamed does not emit — it returns parts, keeping transport concerns in the caller');

  // ── PARITY: every grounded answer surface routes through the shared finalizers (no reimplemented sequence) ──
  ok(/finalizeGroundedStreamed\(/.test(socketSrc),
    'the socket grounded answer path routes through the shared finalizeGroundedStreamed');
  // The socket must NOT hand-wire the citation caveat itself anymore — that logic now lives only in the shared
  // finalizer, so the socket and the API can no longer drift on it.
  ok(!/require\('\.\/grounding'\)\.caveatFor/.test(socketSrc),
    'the socket no longer calls grounding.caveatFor directly (the citation safeguard is single-sourced in answerfinalize)');
  ok(/finalizeGrounded\(answer, r\.sources, r\.idx\)/.test(apiSrc),
    'the HTTP grounded-chat path finalizes via the shared finalizeGrounded');
  ok(/finalizeGrounded\(await drain\(r\.stream, signal\), r\.sources \|\| \[\], r\.idx\)/.test(autoSrc),
    'the scheduled-automations egress finalizes via the shared finalizeGrounded');

  // ── The numeric-grounding safeguard is applied on BOTH surfaces (rendered differently) ──
  ok(/require\('\.\/faithfulness'\)\.checkFigures\(answer, sources, idx\)/.test(finalizeSrc),
    'the one-string surface applies numeric grounding inline (appendFigureCaveat → faithfulness.checkFigures)');
  ok(/require\('\.\/faithfulness'\)/.test(socketSrc),
    'the socket applies numeric grounding too (as its async turn-tagged badge)');

  // ── The always-on verify pass still reaches the socket surfaces that are NOT grounded Q&A (web answer, a
  //    whole-workspace synthesis, a single-doc summary) — they use the verify-only finalizeAnswer helper ──
  ok(/const finalizeAnswer = \(answer\) => \{[\s\S]*?require\('\.\/verify'\)\.finalize\(answer\)/.test(socketSrc),
    'the socket keeps a verify-only finalizer for its non-grounded answer paths (web / synthesis / summary)');

  console.log(`\nALL ANSWER-SAFEGUARD-PARITY TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ANSWER-SAFEGUARD-PARITY UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
