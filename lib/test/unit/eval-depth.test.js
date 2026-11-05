'use strict';
// Guards the depth of an evaluation result: each question keeps a bounded drill-down (unsupported claims,
// unverified figures and quotations, per-citation usage, and an answer preview) and the dashboard renders it
// in a native <details> row. Also guards that the judge runs once per question, not twice. Static contracts
// plus pure checks; no model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const engine = read('lib/eval.js');
  const chat = read('lib/public/js/chat.js');
  const css = read('lib/public/css/app.css');

  // ── One judge pass per question: the report supplies both the number and the detail ──
  ok(/const faithReport = await require\('\.\/faithfulness'\)\.scoreAnswer\(answer, sources, idx, q\.text\)\.catch\(\(\) => null\)/.test(engine),
    'the faithfulness report is obtained once per question');
  ok(/faithfulness: metrics\.faithfulnessFromCounts\(faithReport && faithReport\.counts\)/.test(engine),
    'the numeric faithfulness score comes from that report (no second judge call)');
  ok(!/metrics\.faithfulness\(answer/.test(engine),
    'the thin wrapper is not called in addition to the direct report');

  // ── The drill-down is bounded and carries no full answer/source text ──
  ok(/entry\.detail = \{/.test(engine), 'each run entry keeps a detail object');
  for (const [field, cap] of [['claims', 8], ['figures', 6], ['quotes', 3]]) {
    ok(new RegExp(`${field}:[\\s\\S]{0,420}?\\.slice\\(0, ${cap}\\)`).test(engine), `the ${field} list is capped at ${cap}`);
  }
  ok(/claims:[\s\S]{0,260}?\.filter\(\(c\) => c && c\.verdict && c\.verdict !== 'supported'\)/.test(engine),
    'only claims that were not fully supported are kept');
  ok(/text: String\(c\.text \|\| ''\)\.slice\(0, 180\)/.test(engine), 'each claim keeps a short excerpt, not the whole sentence set');
  ok(/quotes:[\s\S]{0,220}?\.slice\(0, 3\)\.map\(\(x\) => String\(x\.raw \|\| ''\)\.slice\(0, 140\)\)/.test(engine),
    'a quotation excerpt is short');
  ok(/attribution: attr \? attr\.perSource\.slice\(0, 6\) : \[\]/.test(engine), 'per-citation usage is bounded');

  // ── The dashboard renders a native, accessible drill-down ──
  ok(/<details class="eval-qrow eval-qdetail"><summary>\$\{head\}<\/summary>/.test(chat),
    'a question with detail is a native <details> row');
  ok(/if \(!bits\.length\) return `<div class="eval-qrow">\$\{head\}<\/div>`/.test(chat),
    'a row without detail stays a plain line');
  ok(/Not fully supported/.test(chat) && /Figures not in the sources/.test(chat) && /Quotations not in the sources/.test(chat),
    'the drill-down names each kind of problem');
  ok(/Citations used/.test(chat) && /sentence\$\{s\.matched === 1 \? '' : 's'\}/.test(chat),
    'per-citation usage is shown in sentences');
  ok(/Answer preview/.test(chat) && /eval-detail-preview/.test(css), 'the answer preview has its own treatment');

  // ── Styles keep the disclosure keyboard-usable and readable ──
  ok(/details\.eval-qrow > summary \{ cursor: pointer; list-style: none; display: block; \}/.test(css),
    'the summary is a real, marker-free disclosure control');
  ok(/details\.eval-qrow > summary::-webkit-details-marker \{ display: none; \}/.test(css),
    'the default marker is hidden consistently across engines');
  ok(/details\.eval-qrow\[open\] > summary::before \{ content: '▾'; \}/.test(css), 'the open state has a visible caret');

  // ── The CLI report includes the same depth ──
  const cli = read('lokyni.js');
  ok(/claim\(s\) not fully supported/.test(cli) && /figure\(s\) not in the sources/.test(cli) && /quotation\(s\) not in the sources/.test(cli),
    'the CLI prints the bounded detail counts');

  // ── Documented ──
  ok(/Open any question in that\s+breakdown for the deeper detail/.test(read('docs/README.md')),
    'the guide documents the drill-down');

  console.log(`\nALL EVAL-DEPTH UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EVAL-DEPTH UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
