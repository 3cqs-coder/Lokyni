'use strict';
// Guards the cross-lingual answer behavior in buildMessages (lib/llm.js): a CONFIDENTLY non-English question
// gets an instruction to answer in that language (keeping names/numbers/quotes verbatim), while an English or
// ambiguous question does not (so the default English case never regresses). Gated on the fail-open language
// detector and language-agnostic (no per-language list). It lives in buildMessages, so the chat, API, and MCP
// paths all inherit it. Pure/offline — buildMessages takes the question directly. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { buildMessages } = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const NOTE = /SAME LANGUAGE as the user's question/;
const sysOf = (q) => { const m = buildMessages('Some grounded document text.', [], q, ''); return (m[0] && m[0].content) || ''; };

try {
  // Non-English questions (real languages, synthetic subjects) → the answer-language instruction is present.
  for (const [q, lang] of [
    ['¿cuál es el resumen del informe de Zyntar?', 'Spanish'],
    ['東京の会議の要点は何ですか', 'Japanese'],
    ['какова основная идея отчёта', 'Russian'],
    ['ما هي النقاط الرئيسية في التقرير', 'Arabic'],
  ]) ok(NOTE.test(sysOf(q)), `a ${lang} question asks the model to answer in that language`);

  // English / ambiguous → NO instruction (no regression for the default case; the detector is fail-open).
  ok(!NOTE.test(sysOf('what are the main points of the report')), 'a clear English question gets no language instruction');
  ok(!NOTE.test(sysOf('budget')), 'a short ambiguous token gets no language instruction');
  ok(!NOTE.test(sysOf('flights to São Paulo')), 'an English question naming a foreign place is not flipped');

  // Grounding is preserved: facts stay verbatim even when the prose is translated.
  ok(/keep names, numbers, dates, and any direct quotations exactly as they appear/.test(sysOf('ما هي أحدث الأخبار')),
    'the instruction keeps names/numbers/quotes verbatim (grounding stays safe)');

  // The instruction is part of the system message (where the grounding rules live). The DOCUMENTS block now
  // rides in the final user turn (placement fix), so it is NOT in the system prompt.
  const m = buildMessages('Some grounded document text.', [], '東京の会議の要点は何ですか', '');
  const sys = m[0].content;
  const userTurn = m[m.length - 1].content;
  ok(NOTE.test(sys) && !/DOCUMENTS \(untrusted data/.test(sys), 'the language instruction sits in the system prompt (and the documents do not)');
  ok(/DOCUMENTS \(untrusted data/.test(userTurn), 'the documents ride in the final user turn');

  // Source guard: gated on the fail-open detector inside buildMessages (shared by chat/API/MCP → parity).
  const llmSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'llm.js'), 'utf-8');
  ok(/require\('\.\/langdetect'\)\.isLikelyNonEnglish\(question\)/.test(llmSrc) && /langNote/.test(llmSrc),
    'the note is gated on isLikelyNonEnglish(question) in buildMessages (one shared path for every surface)');

  console.log(`\nALL CROSS-LINGUAL-ANSWER TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CROSS-LINGUAL-ANSWER TEST FAILED:', e && e.message);
  process.exit(1);
}
