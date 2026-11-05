'use strict';
// Guards the meta-question router (lib/meta.js), which routes a turn AWAY from retrieval and answers it from
// conversation state. The regex backstop META_RE is deliberately NARROW so real document questions are never
// captured — a regression that broadens it would silently answer document questions with no retrieval (wrong
// answers, no failing test). This covers both the positive phrasings and, importantly, the negative cases
// (ordinary document questions must not be treated as meta), plus each handleMeta branch and handleClarify.
// Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const meta = require(path.resolve(__dirname, '..', '..', 'meta'));
const cfg = require(path.resolve(__dirname, '..', '..', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const collect = async (envelope) => { let s = ''; for await (const c of envelope.stream) s += c; return s; };

(async () => {
  try {
    // ── isMetaQuestion: narrow positive set, and document questions must NOT match ──
    // isMetaQuestion is gated by the useMetaConversation toggle; only exercise the regex when it is on.
    if (cfg.useMetaConversation) {
      const metaPhrasings = [
        'what did I just ask?',
        'what was my last question',
        'what have we discussed',
        'summarize our conversation',
        'which documents have we looked at?',
        'what documents did we use',
        'recap our chat',
        'what are we talking about',
      ];
      for (const q of metaPhrasings) ok(meta.isMetaQuestion(q), `meta phrasing is recognized: "${q}"`);

      // Ordinary document questions must be left for retrieval — the critical anti-regression guard.
      const documentQuestions = [
        'what is the backup schedule',
        'summarize the quarterly report',           // "summarize the <doc>" is NOT "summarize the conversation"
        'what did the author say about pricing',    // "what did ..." but not "what did i ask"
        'which documents mention revenue',          // not "which documents have we looked at"
        'how do I reset my password',
        'what are the common themes across my files',
      ];
      for (const q of documentQuestions) eq(meta.isMetaQuestion(q), false, `document question is NOT treated as meta: "${q}"`);
      console.log('✓ meta: meta phrasings are recognized while ordinary document questions are left for retrieval');
    } else {
      ok(meta.isMetaQuestion('what did I just ask') === false, 'with useMetaConversation off, nothing is routed as meta');
    }

    // ── handleMeta: each branch answers from conversation state (no retrieval) ──
    const ctx = {
      history: [
        { role: 'user', content: 'How do I enable OCR?' },
        { role: 'assistant', content: 'Turn on useOcr in Settings.' },
        { role: 'user', content: 'And the backup schedule?' },
        { role: 'assistant', content: 'Configure it under Settings.' },
      ],
      consultedDocs: ['manual.pdf', 'manual.pdf', 'faq.md'],
      summary: 'We covered enabling OCR and configuring backups.',
    };

    const lastAsk = meta.handleMeta(ctx, 'what did I just ask?');
    ok(lastAsk.handled && lastAsk.outOfScope === false && Array.isArray(lastAsk.sources) && lastAsk.sources.length === 0,
      'handleMeta returns a handled, in-scope, source-less envelope');
    ok((await collect(lastAsk)).includes('And the backup schedule?'),
      'the "what did I just ask" branch quotes the previous user turn');

    const whichDocs = meta.handleMeta(ctx, 'which documents have we looked at?');
    const docsText = await collect(whichDocs);
    ok(docsText.includes('manual.pdf') && docsText.includes('faq.md'), 'the documents branch lists the consulted docs');
    ok(!/manual\.pdf.*manual\.pdf/.test(docsText), 'the documents branch de-duplicates the consulted-doc list');

    const recap = meta.handleMeta(ctx, 'summarize our conversation');
    ok((await collect(recap)).includes('We covered enabling OCR'), 'the recap branch uses the rolling summary when present');

    // Empty-history / first-turn degenerate cases must not crash and must say something sensible.
    const firstTurn = meta.handleMeta({ history: [] }, 'what did I just ask?');
    ok((await collect(firstTurn)).length > 0 && firstTurn.handled, 'a first-turn meta question degrades gracefully (no crash)');
    const noSummary = meta.handleMeta({ history: [{ role: 'user', content: 'hi there' }] }, 'recap our conversation');
    ok((await collect(noSummary)).includes('hi there'), 'with no rolling summary, recap falls back to the verbatim user turns');
    console.log('✓ meta: handleMeta answers each branch from conversation state and handles empty history without crashing');

    // ── handleClarify: returns a clarification envelope when enabled, null without text ──
    eq(meta.handleClarify(''), null, 'handleClarify returns null when there is no clarifying text');
    if (cfg.useClarifyingQuestions) {
      const clar = meta.handleClarify('Did you mean the 2023 or 2024 report?');
      ok(clar && clar.isClarification === true && clar.handled === true && clar.outOfScope === false,
        'handleClarify returns a handled clarification envelope when enabled');
      ok((await collect(clar)).includes('2023 or 2024'), 'the clarification envelope streams the clarifying question');
    }
    console.log('✓ meta: handleClarify streams a clarifying question when enabled and returns null without text');

    console.log(`\nALL META UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ META UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
