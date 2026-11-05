'use strict';
// Guards the wiring that surfaces numeric grounding in the faithfulness pass (lib/faithfulness.js) and the
// badge (chat.js). The deterministic numeric check must run independently of the LLM claim judge — so an
// invented figure is still reported when the judge times out — and must NEVER rewrite the answer (a prior
// figure-flagging attempt that edited answer text was removed for corrupting correct answers; see
// verify.test.js). Source inspection — the live path needs a model and an index. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const faith = read('lib/faithfulness.js');
  const chat = read('lib/public/js/chat.js');

  // ── the numeric check runs deterministically, from the FULL served text, independent of the judge ──
  ok(/require\('\.\/numgrounding'\)\.ungroundedFigures\(answer, context\)/.test(faith),
    'faithfulness runs the deterministic numeric grounding check on the answer against the served context');
  ok(!/return ctx\.length > MAX_CONTEXT \? ctx\.slice/.test(faith),
    'contextFromSources no longer truncates — the numeric check reads all served text, so a figure past the judge cutoff is not falsely flagged');
  ok(/context\.length > MAX_CONTEXT \? context\.slice\(0, MAX_CONTEXT\) : context/.test(faith),
    'the judge prompt is truncated at its own call site, not in contextFromSources');

  // ── the judge is best-effort; the numeric signal survives a judge failure ──
  ok(/const judgeResult = await runClaimJudge\([^)]*\)\.catch\(\(\) => null\)/.test(faith),
    'a judge failure degrades to null without throwing');
  ok(/if \(!judgeResult && figures\.ungrounded\.length === 0 && !quotes\) return null;/.test(faith),
    'a result is returned only when the judge, the numeric check, or the quotation check has something to report');
  ok(/if \(!judgeResult\) \{[\s\S]*?overall: null, counts: null, claims: \[\][\s\S]*?figures, quotes \};/.test(faith),
    'when the judge is unavailable but a figure or quotation is ungrounded, a deterministic-only result is returned');
  ok(/return \{ \.\.\.judgeResult, selfJudged, figures, quotes \};/.test(faith),
    'the normal result carries the figures and quotation report alongside the claim verdicts');

  // ── the numeric check only ever FLAGS; it must not rewrite the answer (the trap that removed the old one) ──
  const ng = require(path.join(PROJECT, 'lib', 'numgrounding'));
  const report = ng.ungroundedFigures('It cost $28,000.', 'no figures here');
  ok(report && typeof report.checked === 'number' && Array.isArray(report.ungrounded),
    'the numeric check returns a REPORT ({ checked, ungrounded }), never a rewritten answer string');
  ok(!/\banswer\s*=[^=]/.test(faith),
    'faithfulness never reassigns the answer — it is read-only input to a reporting pass');

  // ── the badge surfaces ungrounded figures and does not claim "Grounded" when a figure is unverified ──
  ok(/fr\.figures && Array\.isArray\(fr\.figures\.ungrounded\)/.test(chat),
    'the badge reads the ungrounded figures from the result');
  ok(/ung\.length > 0 \|\| unq\.length > 0\) && \(meta\.cls === 'faith-high' \|\| meta\.cls === 'faith-selfcheck'\)/.test(chat),
    'an unverified figure or quotation pulls a confident "Grounded"/"Self-checked" verdict down to a warning');
  ok(/fr\.quotes && Array\.isArray\(fr\.quotes\.ungrounded\)/.test(chat),
    'the badge reads the ungrounded quotations from the result');
  ok(/not found in your sources/.test(chat),
    'the panel lists each ungrounded figure in plain language');

  // ── the cheap numeric check runs on EVERY answer (not only when Verify is on), and stays quiet unless
  //    it flags something — the tiered default the research supports (cheap always-on, expensive opt-in) ──
  const socket = read('lib/socket.js');
  ok(/if \(f\.checkFaithfulness\) \{[\s\S]*?scoreAnswer\(answer, src, metaIdx, query\)[\s\S]*?\} else \{[\s\S]*?checkFigures\(answer, src, metaIdx\)/.test(socket),
    'Verify ON runs the full judge (with the query, for abstention detection); Verify OFF still runs the deterministic numeric check (both against the turn index)');

  // ── functional: checkFigures flags an invented figure, stays quiet when grounded, and never throws ──
  const bundle = { parentMap: new Map([['doc1', { content: 'Revenue was 84,583 last year; the margin was 0.40 overall.' }]]) };
  const sources = [{ id: 'doc1', source: 'report.txt', passageStart: 0, passageEnd: 120 }];

  const flaggedRes = ng === undefined ? null : require(path.join(PROJECT, 'lib', 'faithfulness'))
    .checkFigures('The price jumped to $28,000 while revenue was about 85,000 and the margin 40%.', sources, bundle);
  ok(flaggedRes && flaggedRes.overall === null && Array.isArray(flaggedRes.claims) && flaggedRes.claims.length === 0,
    'checkFigures returns a figures-only result (no judge verdicts)');
  ok(flaggedRes.figures.ungrounded.some(f => f.raw === '$28,000'), 'the invented $28,000 is flagged');
  ok(!flaggedRes.figures.ungrounded.some(f => /85,000/.test(f.raw)), 'the rounded 85,000 (≈84,583) is not flagged');
  ok(!flaggedRes.figures.ungrounded.some(f => /40/.test(f.raw)), 'the 40% matching the source 0.40 is not flagged');

  const faithMod = require(path.join(PROJECT, 'lib', 'faithfulness'));
  ok(faithMod.checkFigures('Revenue was 84,583 and the margin was 40%.', sources, bundle) === null,
    'an answer whose figures are all grounded returns null — the badge stays quiet (no alert fatigue)');
  ok(faithMod.checkFigures('Any answer.', [], bundle) === null, 'no cited sources → null (web answers get no figure check)');
  ok(faithMod.checkFigures('Any answer.', sources, { parentMap: new Map() }) === null, 'an empty index → null, never a throw');

  // The faithfulness context cap is single-sourced from the numeric checker's own scan cap, so the context
  // it builds and the amount the checker reads can't drift apart.
  const fSrc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'faithfulness.js'), 'utf-8');
  ok(/const MAX_CONTEXT_SCAN = require\('\.\/numgrounding'\)\.MAX_SCAN_CHARS/.test(fSrc),
    'faithfulness sources its context cap from numgrounding.MAX_SCAN_CHARS (no drift)');
  ok(typeof require('../../numgrounding').MAX_SCAN_CHARS === 'number', 'numgrounding exports its scan cap');

  console.log('✓ faithfulness-figures: numeric grounding runs deterministically, surfaces in the badge, and never edits the answer');
  console.log(`\nALL FAITHFULNESS-FIGURES UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FAITHFULNESS-FIGURES UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
