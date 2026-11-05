'use strict';
// Unit tests for the answer-confidence subsystem: the blend (lib/confidence.js), the English-gated
// overconfidence-wording check (lib/confidencewording.js), and the semantic-entropy clustering
// (lib/semanticentropy.js). All pure / dependency-injected, so no model or network is needed. The blend only
// ever downgrades, never inflates; the wording check is a mismatch detector, not a word ban; clustering groups
// by meaning. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const P = (f) => require(path.resolve(__dirname, '..', '..', f));
const conf = P('confidence');
const wording = P('confidencewording');
const se = P('semanticentropy');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── rerankBand: the single-sourced cross-encoder → band mapping ──
    eq(conf.rerankBand(9), 'high', 'a strong reranker score is high');
    eq(conf.rerankBand(conf.RERANK_HIGH), 'high', 'exactly the high cut is high');
    eq(conf.rerankBand(1), 'medium', 'a mid reranker score is medium');
    eq(conf.rerankBand(conf.RERANK_MEDIUM), 'medium', 'exactly the medium cut is medium');
    eq(conf.rerankBand(-3), 'low', 'a negative reranker score is low');
    eq(conf.rerankBand(null), null, 'no score → no band (null)');
    eq(conf.rerankBand(NaN), null, 'NaN → no band (null)');

    // ── assess: starting band from faithfulness, else reranker, else null ──
    eq(conf.assess({}), null, 'no signal at all → null (no chip)');
    eq(conf.assess({ faithfulness: { overall: 'high' } }).level, 'high', 'faithfulness high → high');
    eq(conf.assess({ topReranker: 6 }).level, 'high', 'reranker-only strong → high');
    eq(conf.assess({ faithfulness: { overall: null }, topReranker: -2 }).level, 'low', 'falls back to reranker when no faithfulness verdict');

    // ── cross-lingual: the cross-encoder is cross-lingual-weak, so its score is ignored for these answers ──
    // (the same weakness that makes it unusable for ranking a cross-lingual query — see lib/retrieval/search.js).
    eq(conf.assess({ topReranker: -5, crossLingual: true }), null,
      'cross-lingual: a low cross-encoder score does NOT produce a (misleading) low-confidence chip — no signal, no chip');
    eq(conf.assess({ faithfulness: { overall: 'high' }, topReranker: -5, crossLingual: true }).level, 'high',
      'cross-lingual: faithfulness (language-agnostic) still drives confidence, unaffected by a weak cross-encoder score');
    eq(conf.assess({ topReranker: -5, crossLingual: true, abstainEnabled: true }), null,
      'cross-lingual: a weak cross-encoder score never forces a thin-evidence abstention (no signal → null, so nothing to abstain on)');
    eq(conf.assess({ faithfulness: { overall: 'low' }, topReranker: -5, crossLingual: true, abstainEnabled: true }).abstain, true,
      'cross-lingual: a genuinely weak FAITHFULNESS verdict still abstains (the honest signal is kept; only the cross-encoder is dropped)');
    // The SAME inputs without the cross-lingual flag DO use the reranker — the flag is what gates the difference.
    eq(conf.assess({ topReranker: -5 }).level, 'low', 'same inputs, not cross-lingual: the reranker still bands as low');

    // ── only ever downgrades ──
    eq(conf.assess({ faithfulness: { overall: 'high', figures: { ungrounded: ['4.2 million'] } } }).level, 'medium',
      'an ungrounded figure caps a high answer at medium');
    // An ungrounded QUOTATION is the same class of fabrication as an invented figure — it must cap confidence too
    // (a fabricated quote with a "high" faithfulness verdict must not show a reassuring "High confidence" chip).
    const qc = conf.assess({ faithfulness: { overall: 'high', quotes: { total: 1, ungrounded: [{ raw: 'never said this' }] } } });
    eq(qc.level, 'medium', 'an ungrounded quotation caps a high answer at medium');
    ok(qc.reasons.some(r => /quotation/i.test(r)), 'the capped verdict says a quotation is not in the sources');
    // On the Verify-OFF path (no faithfulness verdict), a strong reranker + a fabricated quote is still capped.
    eq(conf.assess({ topReranker: 9, faithfulness: { overall: null, quotes: { total: 1, ungrounded: [{ raw: 'x' }] } } }).level, 'medium',
      'a fabricated quote caps even a reranker-driven high answer (Verify-off parity)');
    // A clean answer (quotes === null, the normal no-ungrounded case) is NOT capped.
    eq(conf.assess({ faithfulness: { overall: 'high', quotes: null } }).level, 'high', 'no ungrounded quote → no cap');
    eq(conf.assess({ faithfulness: { overall: 'high' }, semanticEntropy: { unstable: true } }).level, 'medium',
      'instability lowers a high answer one band');
    eq(conf.assess({ faithfulness: { overall: 'medium' }, semanticEntropy: { unstable: true }, topReranker: 9 }).level, 'low',
      'instability lowers medium to low (reranker cannot inflate it back)');
    // never inflates: a weak faithfulness verdict stays low even with a strong reranker score
    eq(conf.assess({ faithfulness: { overall: 'low' }, topReranker: 9 }).level, 'low',
      'a low support verdict is never raised by a strong reranker score');

    // ── wording is a reason, not a band change ──
    const over = conf.assess({ faithfulness: { overall: 'medium' }, overconfident: { overconfident: true, phrases: ['proves'] } });
    eq(over.level, 'medium', 'overconfident wording does not change the band');
    ok(over.reasons.some(r => /more certainly/.test(r)), 'overconfident wording adds a caveat reason');

    // ── thin-evidence abstention: opt-in, and only when evidence is genuinely weak ──
    eq(conf.assess({ faithfulness: { overall: 'low' } }).abstain, false, 'no abstention unless enabled');
    eq(conf.assess({ faithfulness: { overall: 'low' }, abstainEnabled: true }).abstain, true, 'weak support + enabled → abstain');
    eq(conf.assess({ faithfulness: { overall: 'high' }, abstainEnabled: true }).abstain, false, 'a confident answer never abstains');
    // a single strong source must NOT abstain (local corpus: one document is normal, not thin evidence)
    eq(conf.assess({ faithfulness: { overall: 'high' }, topReranker: 9, abstainEnabled: true }).abstain, false,
      'one strong source is a confident answer, never a thin-evidence abstention');

    // ── CONFIDENCE_LEVELS: the single-sourced label/class vocabulary ──
    ok(conf.CONFIDENCE_LEVELS.high && conf.CONFIDENCE_LEVELS.medium && conf.CONFIDENCE_LEVELS.low, 'three levels are defined');
    ok(['high', 'medium', 'low'].every(l => conf.CONFIDENCE_LEVELS[l].label && conf.CONFIDENCE_LEVELS[l].cls), 'each level has a label and a css class');

    // ── overconfidence wording: mismatch detector, English, ReDoS-safe ──
    eq(wording.check('This conclusively proves the result.', { belowBar: true }).overconfident, true, 'certainty markers flag below the bar');
    eq(wording.check('This conclusively proves the result.', { belowBar: false }).overconfident, false, 'the same wording is fine above the bar (not a word ban)');
    eq(wording.check('The report mentions a figure and a date.', { belowBar: true }).overconfident, false, 'ordinary prose is not flagged');
    ok(wording.check('It is clearly a nice day and certainly warm.', { belowBar: true }).overconfident === false,
      'bare "clearly"/"certainly" (too common) are not flagged on their own');
    // ReDoS / bound safety: a long adversarial string returns quickly without throwing. A marker within the
    // scanned window is found; one past the MAX_SCAN cap is simply not scanned (bounded cost by design).
    const t0 = Date.now();
    ok(wording.check('conclusively proves ' + 'a '.repeat(50000), { belowBar: true }).overconfident === true,
      'finds a marker within the bounded scan window of a very long input');
    ok(wording.check('a '.repeat(50000) + 'proves', { belowBar: true }).overconfident === false,
      'a marker beyond the MAX_SCAN cap is not scanned (cost stays bounded)');
    ok(Date.now() - t0 < 1000, 'the wording scan stays fast on a long input (no catastrophic backtracking)');

    // ── semantic-entropy clustering: by meaning, not string ──
    const near = se.clusterByMeaning([[1, 0], [0.99, 0.0141], [0, 1]], 0.9);
    eq(near.length, 2, 'two near-identical vectors cluster together, a distinct one stands alone');
    const allSame = se.clusterByMeaning([[1, 0], [1, 0], [1, 0]], 0.9);
    eq(allSame.length, 1, 'identical answers form a single cluster (full agreement)');

    // ── semantic-entropy assess: fail-open, dependency-injected, no model ──
    eq(await se.assess({ samples: 1 }), null, 'fewer than two samples → null (no signal)');
    eq(await se.assess({ generate: null, embed: null, samples: 3 }), null, 'missing generate/embed → null');
    const stable = await se.assess({
      generate: async () => 'The capital is Zephyr City.',
      embed: async () => [1, 0, 0], samples: 3, agreementFloor: 0.6,
    });
    ok(stable && stable.unstable === false && stable.agreement === 1, 'identical samples → stable, agreement 1');
    let i = 0;
    const unstable = await se.assess({
      generate: async () => ['A', 'B', 'C'][i++ % 3],
      embed: async (t) => (t === 'A' ? [1, 0, 0] : t === 'B' ? [0, 1, 0] : [0, 0, 1]),
      samples: 3, agreementFloor: 0.6, clusterThreshold: 0.9,
    });
    ok(unstable && unstable.unstable === true, 'three different-meaning samples → unstable');
    // Abort tolerance: once the turn is cancelled, completeChat returns undefined for every remaining sample,
    // so assess gathers fewer than two usable replies and yields null (no spurious penalty, no throw).
    let gi = 0;
    const aborted = await se.assess({
      generate: async () => (gi++ === 0 ? 'the one real answer' : undefined),   // sample 1 only; the rest are cancelled
      embed: async () => [1, 0, 0], samples: 4,
    });
    eq(aborted, null, 'a cancelled turn (later samples undefined) → null, never a crash or false penalty');

    // ── Wiring guards (source inspection): the module is pure and well-covered above, but the regression risk
    //    is the WIRING — the chip must be emitted on BOTH answer paths, respect its setting, gate the English-
    //    only wording refinement on language, and take its labels from ONE server-projected vocabulary. ──
    const fs = require('fs');
    const srcOf = (f) => fs.readFileSync(path.resolve(__dirname, '..', '..', f), 'utf-8');
    const socket = srcOf('socket.js');
    ok(/emitConfidence\(fr\)/.test(socket) && (socket.match(/emitConfidence\(fr\)/g) || []).length >= 2,
      'confidence is emitted on BOTH the Verify-on and Verify-off answer paths');
    ok(/if \(!cfg\.showAnswerConfidence\) return;/.test(socket), 'the chip respects the showAnswerConfidence setting');
    ok(/client\.emit\('answer_confidence', \{ query, turnId, \.\.\.result \}\)/.test(socket), 'the confidence payload carries the turn id (so it attaches to the right answer)');
    ok(/if \(!require\('\.\/langdetect'\)\.isLikelyNonEnglish\(answer\)\)/.test(socket), 'the overconfidence-wording refinement runs ONLY for a confidently-English answer (never misfires on another language)');
    ok(/cfg\.useSemanticEntropy && typeof getMessages === 'function'/.test(socket), 'the self-consistency pass is opt-in and reuses the captured prompt');
    // The opt-in resample runs (samples - 1) full generations AFTER the answer streamed, so a New/disconnect/Stop
    // must cancel them — otherwise the heaviest fire-and-forget work on the turn orphans server-side. Pin both the
    // start gate and that the turn's signal reaches completeChat.
    ok(/useSemanticEntropy && typeof getMessages === 'function' && !\(signal && signal\.aborted\)/.test(socket),
      'the self-consistency pass does not even start once the turn is aborted');
    ok(/completeChat\(messages, \{ temperature: 0\.5, maxTokens: cfg\.MAX_TOKENS, signal \}\)/.test(socket),
      'the resample passes the turn abort signal to completeChat so a disconnect cancels the extra generations');
    ok(/emitAnswerMeta\(\{[^}]*getMessages: lastGetMessages, signal: abort && abort\.signal, abortController: abort \}\)/.test(socket),
      'the document answer path hands emitAnswerMeta the turn abort signal AND its controller');
    // The fire-and-forget self-consistency generations outlive the turn's own release (which nulls activeAbort), so
    // the turn controller is tracked in bgAborts while they run and aborted by New / disconnect — otherwise those
    // heavy generations would run on against a cleared/gone conversation.
    ok(/bgAborts\.add\(abortController\)/.test(socket) && /bgAborts\.delete\(abortController\)/.test(socket),
      'the self-consistency pass registers and deregisters its controller in bgAborts');
    ok(/reset_conversation[\s\S]*abortBackgroundJobs\(\)/.test(socket) && /disconnect[\s\S]*abortBackgroundJobs\(\)/.test(socket),
      'New and disconnect abort any outstanding post-answer background generations');
    const chat = srcOf('public/js/chat.js');
    ok(/SETTINGS_META && SETTINGS_META\.confidenceLevels/.test(chat) && /socket\.on\('answer_confidence'/.test(chat),
      'the page renders the chip from the server-projected level vocabulary (no second copy of labels/classes)');
    const schema = srcOf('settings-schema.js');
    ok(/confidenceLevels: require\('\.\/confidence'\)\.CONFIDENCE_LEVELS/.test(schema),
      'the level vocabulary is projected to the client from confidence.js — one source of truth for frontend and backend');

    console.log(`\nALL CONFIDENCE TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ CONFIDENCE TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
