'use strict';
// One shared fixture set for the browser suite. The document, the question, the citation code, and the
// stub answer all come from here so a change cannot make the test assert something the fixture no longer
// contains.

const DOC_NAME = 'orion-handbook.md';
const CODE = 'ZX-9042';
const QUESTION = 'What is the launch code for the Orion Project?';
// A marker the stub provider recognizes to stream slowly, so a browser test can stop a live turn.
// It rides in the question text (the only field both sides share) and is inert to retrieval.
const SLOW_MARKER = '[[slow]]';
const SLOW_QUESTION = `${QUESTION} ${SLOW_MARKER}`;
const ANSWER = `The Orion Project launch code is ${CODE}. The approved budget is 7.5 million dollars.`;
const SLOW_ANSWER = [ANSWER, ANSWER, ANSWER, ANSWER].join('\n\n');
// A marker the stub provider recognizes to answer in Spanish, so a browser test can exercise the multilingual
// read-aloud routing without a second model. The question stays in English so the keyword retrieval matches the
// English fixture document; the answer's language is what the read-aloud route follows. Inert to retrieval.
const SPANISH_MARKER = '[[es]]';
const SPANISH_QUESTION = `${QUESTION} ${SPANISH_MARKER}`;
const SPANISH_ANSWER = `El código de lanzamiento del Proyecto Orion es ${CODE}. El presupuesto aprobado es de 7,5 millones de dólares.`;
const DOC_TEXT =
  '# Orion Project Handbook\n\n' +
  `The Orion Project launch code is ${CODE}.\n\n` +
  'The approved budget is 7.5 million dollars for the 2026 fiscal year.\n\n' +
  'The project lead is Dr. Mara Voss.\n';

module.exports = {
  DOC_NAME, CODE, QUESTION, ANSWER, DOC_TEXT, SLOW_MARKER, SLOW_QUESTION, SLOW_ANSWER,
  SPANISH_MARKER, SPANISH_QUESTION, SPANISH_ANSWER,
};
