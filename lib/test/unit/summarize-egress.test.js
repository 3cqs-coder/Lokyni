'use strict';
// Guards egress sanitization on the non-streaming summarize path (lib/summarize.js summarizeToString),
// which feeds BOTH the /api/v1/summarize JSON response and the MCP summarize_document tool. A summary
// is written from an UNTRUSTED document, so the model can echo exfiltration markup or dangerous
// invisible characters (zero-width / bidi Trojan-Source) that a downstream client might render. The
// streaming API path sanitizes inline; this test proves the one-shot path does too, single-sourced in
// summarizeToString. The LLM is stubbed (no model, no network). Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const llm = require(path.join(PROJECT, 'lib', 'llm'));
const { summarizeToString } = require(path.join(PROJECT, 'lib', 'summarize'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const entry = { content: 'A perfectly ordinary document about widgets and their care.', metadata: { source: '/docs/widgets.md' } };
const orig = llm.completeChat;

(async () => {
  try {
    // The model echoes zero-width + bidi control characters embedded in the untrusted document.
    llm.completeChat = async () => 'Summary​‮ of the doc⁦ here.';
    let out = await summarizeToString(entry);
    ok(!/[​‮⁦]/.test(out.summary), 'dangerous invisible/bidi characters are stripped from the summary');
    ok(/Summary/.test(out.summary) && /doc/.test(out.summary), 'ordinary summary text survives sanitization');

    // A clean summary passes through unchanged (sanitizeEgress never declines).
    llm.completeChat = async () => 'This document explains widget care in three steps.';
    out = await summarizeToString(entry);
    ok(out.summary === 'This document explains widget care in three steps.', 'a clean summary is returned intact');

    // An empty document short-circuits without calling the model.
    let called = false;
    llm.completeChat = async () => { called = true; return 'x'; };
    const emptyOut = await summarizeToString({ content: '   ', metadata: { source: '/d/blank.txt' } });
    ok(emptyOut.empty === true && !called, 'an empty document returns empty without invoking the model');

    console.log('✓ summarize-egress: the one-shot summarize path sanitizes untrusted model output');
    console.log(`\nALL SUMMARIZE-EGRESS UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ SUMMARIZE-EGRESS UNIT TEST FAILED:', e && e.message, e && e.stack);
    process.exit(1);
  } finally {
    llm.completeChat = orig;
  }
})();
