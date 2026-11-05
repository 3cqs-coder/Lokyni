'use strict';
// Numeric grounding (lib/numgrounding.js) — the deterministic check that an answer's figures appear in the
// cited sources. Correctness here is safety-critical: a false flag on a REAL number erodes trust, so the
// bar is precision-first — never flag a grounded figure, and only flag a figure that matches nothing. These
// tests pin both directions (invented → flagged, every grounded form → not flagged) and the noise/robustness
// rules. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { extractNumbers, ungroundedFigures } = require(path.join(PROJECT, 'lib', 'numgrounding'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const raws = (answer, source) => ungroundedFigures(answer, source).ungrounded.map(f => f.raw);
const flagged = (answer, source) => raws(answer, source).length > 0;

try {
  // ── a figure the source does not contain is flagged ──
  ok(flagged('The current price is $28,000 today.', 'The report discusses trading fees and volume.'),
    'an invented number with no source support is flagged');
  ok(flagged('Revenue grew 73% last quarter.', 'Revenue grew steadily last quarter.'),
    'an invented percentage with no source support is flagged');

  // ── every legitimately-grounded form is NOT flagged (precision — the important direction) ──
  ok(!flagged('Revenue was $5,000,000.', 'Revenue hit $5,000,000 last year.'), 'an exact match is not flagged');
  ok(!flagged('About 85,000 users signed up.', 'There were 84,583 users.'), 'a figure within the rounding tolerance is not flagged');
  ok(!flagged('Losses reached $5 billion.', 'a 5,000,000,000 shortfall was reported'), 'a magnitude word matches the digit form');
  ok(!flagged('Costs were $1.2M.', 'the 1,200,000 figure'), 'a currency + magnitude abbreviation matches the digits');
  ok(!flagged('It rose 40% this quarter.', 'a change of 0.40 over the period'), 'a percentage matches its fraction form in the source');
  ok(!flagged('It rose 40% this quarter.', 'revenue rose 40% year over year'), 'a percentage matches a percentage in the source');
  ok(!flagged('The total was 1,234,567.', 'exactly 1,234,567 records'), 'a comma-grouped integer matches');
  ok(!flagged('No numbers of interest here at all.', 'the source'), 'an answer with no significant figures is never flagged');

  // ── derived figures (sums/differences of source numbers) are grounded — the common summarization case ──
  ok(!flagged('The total was $25,000.', 'Costs were $10,000 and $15,000.'), 'a correct sum of two source figures is not flagged');
  ok(!flagged('The gap is $5,000.', 'Revenue was $15,000 against a $10,000 cost.'), 'a correct difference of two source figures is not flagged');
  // A derived match is exact arithmetic, so it is held to a TIGHT tolerance: a figure that merely lands within
  // the loose 2% window of a sum/difference (here $24,800 vs the $25,000 sum) is still flagged, closing the
  // "any fabricated number is near SOME pair in a number-dense passage" gap.
  ok(flagged('The total was $24,800.', 'Costs were $10,000 and $15,000.'),
    'a figure near a sum but outside the tight derived tolerance is flagged (no loose 2% pass on a derived value)');
  // A total of THREE or more consecutive source figures (a list of line items followed by its total — very
  // common in document Q&A) is grounded via the running-sum derived set, not just pairwise.
  ok(!flagged('The grand total is $4,500,000.', 'Line items: $1,000,000, $1,500,000, and $2,000,000.'),
    'a correct 3-term total of source figures is not flagged');
  ok(!flagged('Across the four years revenue was $100.', 'Yearly: $10, $20, $30, and $40.'),
    'a correct 4-term running total of source figures is not flagged');

  // ── the percent/fraction bridge is symmetric (neither direction is a false flag) ──
  ok(!flagged('The rate is 0.40 overall.', 'The margin rose 40% last year.'), 'a decimal fraction matches a source percentage');
  ok(!flagged('Up 40% this period.', 'a change of 0.40 was recorded'), 'a percentage matches a source decimal fraction');

  // ── identifiers are not fact-checked as quantities ──
  ok(!flagged('See invoice 4521 for the charge.', 'a document with no numbers'), 'an invoice number is skipped');
  ok(!flagged('Mail it to ZIP 90210.', 'a document with no numbers'), 'a ZIP/postcode is skipped');
  ok(!flagged('Call 5551234567 for support.', 'a document with no numbers'), 'a long unseparated digit run (phone/account) is skipped');
  ok(flagged('There were 50,000 users.', 'only a handful of users'), 'a comma-grouped quantity is still checked (identifiers are the exception, not all large numbers)');

  // ── noise classes are skipped, so they never cause a false flag ──
  ok(!flagged('In 2026 the policy changed.', 'a document with no numbers'), 'a bare four-digit year is treated as noise');
  ok(!flagged('There were 3 open issues and 5 closed.', 'a document with no numbers'), 'small bare counts are treated as noise');
  ok(!flagged('See page 12345 and section 42 for the rule.', 'a document with no numbers'), 'reference numbers (page/section) are skipped');
  ok(!flagged('Item 4 and step 7 explain it.', 'a document with no numbers'), 'list/step reference numbers are skipped');

  // ── extraction robustness ──
  ok(extractNumbers('the team has 5 members').every(n => n.value === 5),
    'a bare number before a word starting with a magnitude letter is not misread ("5 members" is 5, not 5 million)');
  {
    const n = extractNumbers('$5 billion', { significantOnly: true });
    ok(n.length === 1 && n[0].value === 5e9, 'a currency + magnitude parses to the full value');
  }
  {
    const n = extractNumbers('12000km of road');   // the magnitude letter is glued to a unit, so it is not a magnitude
    ok(n.some(x => x.value === 12000), 'a number glued to a unit keeps its full value (no truncation to 1200)');
  }

  // ── de-duplication, counts, and safety ──
  {
    const r = ungroundedFigures('$28,000 here and again $28,000 there.', 'no numbers');
    ok(r.ungrounded.length === 1, 'the same invented figure mentioned twice is reported once');
    ok(r.checked === 2, 'checked counts every significant figure, even duplicates');
  }
  ok(ungroundedFigures('', null).ungrounded.length === 0, 'empty answer and null source are handled without throwing');
  ok(ungroundedFigures(null, undefined).checked === 0, 'null inputs yield a zero result, never a throw');
  {
    // Bounded: a pathologically large source must not hang or throw.
    const huge = '1 '.repeat(500000);
    ok(Array.isArray(ungroundedFigures('The value is $77,777.', huge).ungrounded), 'a very large source is handled (scan is bounded)');
  }

  // ── Language-agnostic digits: a figure written in a non-ASCII digit script grounds against its ASCII
  //    form (and vice versa), so a document in Arabic-Indic / Devanagari / full-width numerals is not
  //    falsely flagged. A genuinely invented value is still caught. (Synthetic numbers, multi-script.) ──
  ok(raws('The total is 1,234 units.', 'الإجمالي ١٢٣٤ وحدة').length === 0, 'an ASCII figure grounds against an Arabic-Indic source figure (no false flag)');
  ok(raws('कुल राशि १२३४ है।', 'the total is 1,234').length === 0, 'a Devanagari-digit answer grounds against an ASCII source');
  ok(raws('The total is 1,234 units.', 'total: １２３４').length === 0, 'an ASCII figure grounds against a full-width-digit source');
  ok(raws('The total is 9,999 units.', 'الإجمالي ١٢٣٤ وحدة').length === 1, 'a fabricated figure is still flagged across digit scripts (no false negative)');

  console.log('✓ numgrounding: invented figures are flagged; every grounded/rounded/normalized/multi-script form and all noise are not');
  console.log(`\nALL NUMGROUNDING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ NUMGROUNDING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
