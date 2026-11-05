'use strict';
// FOLLOW-UP RESOLUTION MATRIX — the systematic guard against the "one search, one patch" cycle.
//
// Continuation/drift bugs were being fixed one phrasing at a time ("tell me more" → patch; "what else does it
// talk about" → patch; the next phrasing → patch …). This matrix replaces that treadmill: it crosses many
// synthetic conversation threads against a TAXONOMY of follow-up shapes and runs every combination through the
// app's OWN deterministic classifier — isVagueContinuation() and extractSpecificKeywords(), no model, no live
// index — then reports EVERY failing shape at once. A new phrasing is a new row here, not a new patch in the
// engine.
//
// The invariant under test, in one line: a follow-up that names no new subject of its own must be recognized as
// a vague CONTINUATION (so it is never query-expanded onto a tangential document and never re-ranks off the
// thread), while a follow-up that DOES name a subject — present in the corpus or not — must NOT be, and a
// follow-up that asks a specific ATTRIBUTE of the current subject ("who owns it") must NOT be (so it can be
// resolved onto that subject rather than merely recapped).
//
// Language-agnostic by construction: the classifier reads corpus IDF through the shared Unicode tokenizer, so a
// continuation is recognized whenever its words are ordinary in the corpus's own language — proven below across
// Latin, Cyrillic, CJK, Arabic, Devanagari and Hangul with NO per-language word lists in the engine. Everything
// here is synthetic: invented proper nouns, invented subjects. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { isVagueContinuation } = require(path.join(PROJECT, 'lib', 'retrieval', 'expand'));
const { buildIdf, extractSpecificKeywords } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));

// ── Synthetic threads. Each is a conversation already under way about `subject`; `neo` is a disjoint subject a
// user might pivot to. Both are invented tokens, so each is genuinely rare in the corpus (a real distinctive
// term), while nothing about them is English — the same shapes work whatever the thread language.
const THREADS = [
  { subject: 'Vexmor',   neo: 'Qubblen'  },
  { subject: 'Zorvex',   neo: 'Thaloria' },
  { subject: 'Mirenza',  neo: 'Dolvik'   },
  { subject: 'Kelthorn', neo: 'Pyrandis' },
  { subject: 'Oblivane', neo: 'Suvarek'  },
];

// ── Follow-up taxonomy ───────────────────────────────────────────────────────────────────────────────────
// CONTINUATION — carries no subject of its own; MUST be vague. Includes the "what else does it talk about"
// family whose one-off miss started this harness.
const CONTINUATION = [
  'tell me more', 'tell me more about it', 'more', 'more please', 'go on', 'continue', 'keep going',
  'elaborate', 'can you elaborate', 'go deeper', 'dive deeper', 'what else', 'what else?', 'anything else',
  'anything else?', 'what more can you tell me', 'give me more detail', 'more details', 'summarize that',
  'what else does it talk about', 'what else does it talk about?', 'what else does it discuss',
  'what else does it cover', 'what else is mentioned', 'is there anything more', 'and then?',
];

// CONTINUATION, other languages — same shape, each paired with the corpus language it is asked in. These must be
// vague too, with NO language-specific code: the words are ordinary in that language, so corpus IDF discards
// them. Every token here is seeded into the matching-language corpus below so the test reflects a real library
// in that language (where "more"/"else"/"tell" words are, by nature, common).
const CONTINUATION_ML = [
  ['es', '¿qué más?'], ['es', 'cuéntame más'], ['es', '¿de qué más habla?'],
  ['fr', 'dis-moi en plus'], ['fr', 'quoi encore'],
  ['de', 'erzähl mir mehr'], ['de', 'was noch'],
  ['pt', 'me conte mais'], ['it', 'dimmi di più'], ['nl', 'vertel me meer'],
  ['ru', 'расскажи больше'], ['ru', 'что ещё'],
  ['ja', 'もっと教えて'], ['ja', '他に何がありますか'],
  ['zh', '还有什么'], ['zh', '多告诉我一些'],
  ['ar', 'أخبرني المزيد'], ['ko', '더 말해줘'],
  ['hi', 'और बताओ'], ['tr', 'daha fazla anlat'], ['pl', 'powiedz więcej'],
];

// PIVOT — names a different subject; MUST NOT be vague. `{neo}` is substituted per thread. A couple name a
// subject that is NOT in the corpus at all (a brand-new term), which must still read as a real subject.
const PIVOT = ['what about {neo}?', 'tell me about {neo}', 'now {neo}', '{neo}', 'how about {neo} instead'];
const PIVOT_OFF_CORPUS = ['what about Zephyrine?', 'tell me about Quorvantis'];   // subjects absent from the corpus

// FACET — asks a specific ATTRIBUTE of the current subject via a back-reference; MUST NOT be vague, so it can be
// resolved onto the subject instead of merely recapped. The attribute word carries the signal; a bare pronoun
// reference with no attribute ("what about it") is a continuation and lives in CONTINUATION-style handling.
const FACET = ['who owns it', 'who founded it', 'when was it launched', 'what does it govern', 'who runs it'];

// ── Build one synthetic corpus whose IDF makes subjects distinctive and every continuation word (any language)
// ordinary — exactly the shape of a real library. Subjects/neos appear once each (rare); the continuation
// vocabulary is repeated across many documents (common); attribute words are left out entirely so they read as
// distinctive, as they tend to be in a focused library.
function buildCorpus() {
  const docs = [];
  const contWords = [...CONTINUATION, ...CONTINUATION_ML.map(([, p]) => p)].join(' ');
  const filler = 'the record notes the ledger and the entry and the report and the account and the register';
  for (let i = 0; i < 24; i++) docs.push(`${contWords} ${filler} document ${i}`);
  for (const { subject, neo } of THREADS) {
    docs.push(`A dossier on ${subject}. ${subject} is a regional settlement protocol in wide use.`);
    docs.push(`A dossier on ${neo}. ${neo} is a separate clearing network run independently.`);
  }
  return docs;
}

(async () => {
  const docs = buildCorpus();
  const pMap = new Map(docs.map((content, i) => [String(i), { content }]));
  const corpusIdf = await buildIdf(pMap);
  const idx = { corpusIdf };

  const fails = [];
  const note = (what, detail) => fails.push(`  ✗ ${what}  —  ${detail}`);
  let checks = 0;
  const vague = (q) => { checks++; return isVagueContinuation(q, idx); };

  // A — every CONTINUATION, across every thread, must be vague and yield no specific term.
  for (const t of THREADS) {
    for (const q of CONTINUATION) {
      if (!vague(q)) note('CONTINUATION not recognized as vague', `thread=${t.subject} query="${q}"`);
      const spec = extractSpecificKeywords(q, 5, corpusIdf);
      if (spec.length !== 0) note('CONTINUATION produced a specific term', `query="${q}" → [${spec}]`);
    }
  }

  // B — multilingual continuations must be vague in a corpus of their own language (script-agnostic, no tables).
  for (const [lang, q] of CONTINUATION_ML) {
    if (!vague(q)) note('multilingual CONTINUATION not recognized as vague', `lang=${lang} query="${q}"`);
  }

  // C — a PIVOT to another subject must NOT be vague, and the subject's term must survive as a specific keyword.
  for (const t of THREADS) {
    for (const tpl of PIVOT) {
      const q = tpl.replace('{neo}', t.neo);
      if (vague(q)) note('PIVOT wrongly recognized as vague', `thread=${t.subject} query="${q}"`);
      const spec = extractSpecificKeywords(q, 5, corpusIdf);
      if (!spec.includes(t.neo.toLowerCase())) note('PIVOT dropped its subject term', `query="${q}" → [${spec}]`);
    }
  }
  for (const q of PIVOT_OFF_CORPUS) {
    if (vague(q)) note('off-corpus PIVOT wrongly recognized as vague', `query="${q}"`);
  }

  // D — a FACET (attribute of the current subject) must NOT be vague, so it can be resolved, not just recapped.
  for (const q of FACET) {
    if (vague(q)) note('FACET wrongly recognized as vague', `query="${q}"`);
  }

  if (fails.length) {
    console.error(`\n✗ FOLLOW-UP MATRIX — ${fails.length} failing shape(s) of ${checks} classifications:\n` +
      fails.join('\n'));
    process.exit(1);
  }
  console.log(`✓ follow-up matrix: ${CONTINUATION.length} English + ${CONTINUATION_ML.length} multilingual ` +
    `continuations stay vague; ${PIVOT.length} pivots × ${THREADS.length} threads + ${PIVOT_OFF_CORPUS.length} ` +
    `off-corpus pivots + ${FACET.length} facets stay specific`);
  console.log(`\nALL FOLLOW-UP MATRIX TESTS PASSED (${checks} classifications)`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ FOLLOW-UP MATRIX TEST ERROR:', e && e.stack || e); process.exit(1); });
