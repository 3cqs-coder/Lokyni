'use strict';
// Guards the Verify abstention handling in lib/faithfulness.js. Two invariants, in priority order:
//   1. SAFETY (paramount for an anti-hallucination check): a claim that introduces ANY novel distinctive
//      content — a name, a number, OR a plain lowercase fact ("the factory shut down after a flood"), in any
//      script — must KEEP the judge's "unsupported" verdict. The abstention drop must never hide a fabrication.
//   2. An honest negative ("No, the document does not mention frogs") whose only distinctive term is the echoed
//      query term (its abstention meta-vocabulary is corpus-common, so IDF drops it) is neutralized, so the weak
//      local judge's spurious "unsupported" doesn't stamp a false "0/1 supported" on it.
// KNOWN RESIDUAL (documented, not a defect): a BARE false affirmation of the exact queried term with zero novel
// content ("Yes, it discusses frogs") is token-identical to the honest negative — only polarity separates them,
// which the local self-judge cannot label reliably — so it is neutralized like the honest negative. It is rare
// (the model rarely falsely affirms coverage) and introduces no invented fact; a stronger faithfulnessModel is
// the real fix. Deterministic (no model call) over a realistic corpus. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { buildIdf, tokenize } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
const { _internal } = require(path.join(PROJECT, 'lib', 'faithfulness'));
const { addsNoNovelContent, isHonestDecline } = _internal;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    // Realistic corpus: ordinary words (does/not/mention/discuss/document/anywhere/the/factory/flood…) recur, so
    // they are corpus-common (low IDF, non-distinctive). The fabricated name "Halvorsen" and the off-topic term
    // "frogs" appear NOWHERE, so they stay distinctive. Synthetic subjects only.
    const TARGET = 'The Meridian ledger records the quarterly budget for the branch office across the whole year, listing the rent and the payroll in detail.';
    // Each note contains the everyday function/meta words the claims use (this/it/no/does/not/discuss/mention/
    // document/anywhere/after/because) so they are corpus-common (low IDF, dropped) — as in any real workspace.
    const FILLER = Array.from({ length: 40 }, (_, i) =>
      `Note ${i}: this is a plain note, and it does not discuss or mention anything special; there is no document here that goes into the port, the factory, the flood, the lawsuit, the sales, or the equipment anywhere at all, and nothing closed after or because of them.`);
    const pm = new Map([['t', { content: TARGET }]]);
    FILLER.forEach((c, i) => pm.set('f' + i, { content: c }));
    const idf = await buildIdf(pm);
    const srcTokens = new Set(tokenize(TARGET));
    const q = (s) => new Set(tokenize(s));

    // ── SAFETY: any novel distinctive content keeps the verdict (never hide a fabrication) ──
    ok(addsNoNovelContent('The office was led by Director Halvorsen.', srcTokens, q('who led the office?'), idf) === false,
      'a novel NAME keeps the verdict (not neutralized)');
    ok(addsNoNovelContent('It was audited by the KPMG team.', srcTokens, q('who audited it?'), idf) === false,
      'a novel ACRONYM keeps the verdict');
    ok(addsNoNovelContent('The ledger mentions 田中太郎 as the approver.', srcTokens, q('who approved it?'), idf) === false,
      'a novel non-Latin (CJK) name keeps the verdict');
    // The critical regression this fix closes: a plain lowercase common-noun fabrication must NOT be hidden.
    const LOW = { content: TARGET };   // "Zephyria"/"embargo"/"recession" appear nowhere → distinctive + novel
    const idf2 = await buildIdf(new Map([['t', LOW], ...FILLER.map((c, i) => ['f' + i, { content: c }])]));
    ok(addsNoNovelContent('The port of Zephyria closed after an embargo and a recession.', srcTokens, q('what happened at the port?'), idf2) === false,
      'a LOWERCASE common-noun fabrication (novel content, no capital/number) keeps the verdict — the safety fix');
    ok(addsNoNovelContent('Sales collapsed because of a sudden embargo.', srcTokens, q('why did sales change?'), idf2) === false,
      'a lowercase novel content word blocks neutralization, whatever its shape');

    // ── Honest negatives: only the echoed query term is distinctive (meta-vocabulary is corpus-common) → drop ──
    ok(addsNoNovelContent('No, it does not mention frogs.', srcTokens, q('does it mention frogs?'), idf) === true,
      'an honest negative about an absent, queried term adds no novel content');
    ok(addsNoNovelContent('No, this document does not mention or discuss frogs anywhere.', srcTokens, q('does it talk about frogs?'), idf) === true,
      'abstention meta-vocabulary (corpus-common) does not count as novel content');
    ok(addsNoNovelContent('No, the ledger does not discuss 世界平和 at all.', srcTokens, q('does it cover 世界平和?'), idf) === true,
      'a non-Latin (CJK) queried term is echo-covered, so the negative is an abstention');

    // ── A figure-only claim is neutralized here BUT the always-on numeric check owns figures independently ──
    const { ungroundedFigures } = require(path.join(PROJECT, 'lib', 'numgrounding'));
    ok(ungroundedFigures('The reserve was 4.2 million dollars.', TARGET).ungrounded.some(f => /4\.2/.test(f.raw)),
      'an invented figure is caught by numeric grounding regardless of the abstention drop');

    // ── isHonestDecline: suppress an abstention-dominant answer, never one with a surviving unsupported claim ──
    ok(isHonestDecline(2, [{ verdict: 'partial' }]) === true,
      'more honest abstentions than scored claims, none unsupported → honest decline (suppress)');
    ok(isHonestDecline(2, [{ verdict: 'partial' }, { verdict: 'partial' }]) === false,
      'abstentions not outnumbering the scored claims → show the badge');
    ok(isHonestDecline(3, [{ verdict: 'partial' }, { verdict: 'unsupported' }]) === false,
      'a surviving unsupported (fabrication) is NEVER suppressed — and strict neutralization keeps it surviving');
    ok(isHonestDecline(0, [{ verdict: 'unsupported' }]) === false, 'a pure unsupported answer is not a decline');

    console.log(`\nALL FAITHFULNESS-ABSTENTION TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ FAITHFULNESS-ABSTENTION TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
