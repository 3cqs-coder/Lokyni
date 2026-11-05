'use strict';
// Regression tests for two LLM-path guards in lib/llm.js:
//   • raceTimeout — the idle-timeout primitive behind streamChat: a fast promise resolves
//     normally; a slow one rejects with the tagged _lokTimeout error the generator treats as
//     fail-open (end the answer) rather than a real failure.
//   • buildMessages context clamp — when the retrieved documents are far larger than the
//     context window, the DOCUMENTS section is truncated but the grounding rules (and the
//     question) always survive, so the model never loses its anti-fabrication instructions.
// Pure — no model, no network (requires lib/llm, which builds an idle Ollama client but makes
// no call). Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const llm = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // ── raceTimeout ──
    const fast = await llm.raceTimeout(Promise.resolve('done'), 1000);
    ok(fast === 'done', 'a promise that settles in time resolves normally');

    let timedOut = false, tag = false;
    // A ref'd timer keeps the loop alive so raceTimeout's own (unref'd) deadline can fire;
    // cleared right after so the test process exits promptly.
    let slowTimer;
    const slow = new Promise((res) => { slowTimer = setTimeout(res, 5000); });
    try {
      await llm.raceTimeout(slow, 20);
    } catch (e) { timedOut = true; tag = !!(e && e._lokTimeout); }
    clearTimeout(slowTimer);
    ok(timedOut && tag, 'a slow promise rejects with the fail-open _lokTimeout tag');
    console.log('✓ llmguards: raceTimeout resolves fast promises and times out slow ones');

    // ── buildMessages context clamp ──
    const hugeDocs = 'LOREM IPSUM DOLOR. '.repeat(200000);   // far larger than any num_ctx
    const msgs = llm.buildMessages(hugeDocs, [], 'What is the refund policy?', '');
    const system = msgs.find(m => m.role === 'system');
    ok(system, 'a system message is built');
    ok(system.content.includes(llm.GROUNDING_RULES.slice(0, 60)), 'the grounding rules survive the clamp (in the system prompt)');
    // The DOCUMENTS block (and the truncation) ride in the final user turn alongside the question (placement fix).
    const last = msgs[msgs.length - 1];
    ok(last.content.includes('[...truncated]'), 'the oversized documents section is truncated');
    ok(last.content.length < hugeDocs.length, 'the assembled document turn is far smaller than the raw documents');
    ok(last.role === 'user' && /QUESTION: What is the refund policy\?$/.test(last.content), 'the question is preserved intact at the end of the user turn');
    console.log('✓ llmguards: an oversized document context is clamped but the rules and question survive');

    console.log(`\nALL LLMGUARDS UNIT TESTS PASSED (${checks} checks)`);
    // Set the code and let the process exit naturally (all timers are unref'd) rather than
    // calling process.exit, which can truncate buffered stdout on a pipe.
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ LLMGUARDS UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
