'use strict';
// Multilingual / cross-lingual retrieval eval — the language-coverage counterpart to recall.js (which is English
// only). It runs the REAL pipeline (initIndex + searchDocuments, real multilingual embeddings) over a synthetic
// corpus of ten documents, each a DISTINCT subject in a different language and script (Latin, Cyrillic, CJK,
// Arabic, Devanagari), and measures retrieval recall for two case groups:
//
//   same-lang      — the question is in the document's own language. Tests that retrieval works natively in
//                    every script, not just English.
//   cross-lingual  — the question is in a DIFFERENT language and uses only the CONCEPT (not the shared subject
//                    name), so a correct hit depends on the embedding model aligning meaning ACROSS languages
//                    (e.g. English "beekeeping and hives" → the German "Imkerei"/"Bienenstöcke" document). This is
//                    the language-agnostic claim the rest of the system rests on, measured directly.
//
// Retrieval-only (no generation), so it is a fast, low-noise signal. The measurement machinery is shared with
// recall.js (recall-core.js), so the two evals can never drift. All names and subjects are synthetic. Requires
// a MULTILINGUAL embedding model (the default bge-m3) reachable. Run: `npm run eval:multilingual`.
// Exit code: 0 if recall@served meets the gate, 1 if below it, 2 on a harness/setup error.

const path = require('path');
const { runRecallEval } = require('./recall-core');

const _gate = process.argv.find(a => a.startsWith('--min-recall='));
const MIN_RECALL = Number((_gate && _gate.split('=')[1]) || 0.9);

// Each document's own-language question (concept words from that document, in that language).
const sameLang = [
  { query: '¿Qué protocolo gestiona la liquidación tokenizada en un libro mayor compartido?', expectDoc: 'mirenza-es.md' },
  { query: 'Quel système fait des prévisions météorologiques pour les tempêtes ?',             expectDoc: 'thaloria-fr.md' },
  { query: 'Welcher Leitfaden behandelt die Imkerei und die Pflege der Bienenstöcke?',         expectDoc: 'kaelthorn-de.md' },
  { query: '哪个网络负责地震监测并发出海啸预警？',                                                 expectDoc: 'vornaxis-zh.md' },
  { query: 'パン作りの手引きで、生地の発酵と焼成を説明しているのはどれですか？',                       expectDoc: 'zephyrin-ja.md' },
  { query: 'какое руководство описывает речное судоходство, фарватеры и шлюзы?',                 expectDoc: 'qubblen-ru.md' },
  { query: 'ما هو الدليل الذي يشرح ري الحدائق بالتنقيط؟',                                          expectDoc: 'drevani-ar.md' },
  { query: 'सौर पैनल को छत पर लगाने की मार्गदर्शिका कौन सी है?',                                    expectDoc: 'pyrelux-hi.md' },
  { query: 'Qual guia trata da reciclagem de vidro e da separação das cores?',                   expectDoc: 'oblivane-pt.md' },
  { query: 'Quale guida riguarda il restauro degli affreschi e il consolidamento dell’intonaco?', expectDoc: 'suvarek-it.md' },
].map(c => ({ ...c, group: 'same-lang' }));

// A question in a DIFFERENT language that names only the concept (never the subject), so a hit depends on
// cross-lingual meaning alignment. Most are asked in English; two are asked in another non-English language to
// confirm the alignment is not English-centric.
const crossLingual = [
  { query: 'Which document describes a protocol for tokenized settlement of debt and equity on a shared ledger?', expectDoc: 'mirenza-es.md' },
  { query: 'Which guide is about weather forecasting and warning ports about storms?',           expectDoc: 'thaloria-fr.md' },
  { query: 'Which guide covers beekeeping, caring for hives, and harvesting honey?',             expectDoc: 'kaelthorn-de.md' },
  { query: 'Which network does earthquake monitoring and issues tsunami warnings to coastal towns?', expectDoc: 'vornaxis-zh.md' },
  { query: 'Which guide explains bread baking — dough fermentation, shaping, and the oven?',      expectDoc: 'zephyrin-ja.md' },
  { query: 'Which guide is about river navigation, channels, and locks for boats?',              expectDoc: 'qubblen-ru.md' },
  { query: 'Which guide explains garden irrigation with drip watering during a dry season?',     expectDoc: 'drevani-ar.md' },
  { query: 'Which guide is about installing solar panels on a roof and storing energy in batteries?', expectDoc: 'pyrelux-hi.md' },
  { query: 'Which guide is about recycling glass — separating colors and preparing it for melting?', expectDoc: 'oblivane-pt.md' },
  { query: 'Which guide covers fresco restoration — cleaning, plaster consolidation, and retouching?', expectDoc: 'suvarek-it.md' },
  // Non-English → non-English, across diverse script pairs, to show the alignment is not English-centric and
  // holds between two non-Latin scripts, not just to/from English. Each asks in one language about ANOTHER
  // document's concept (never its subject name), so a hit depends purely on cross-lingual meaning alignment.
  { query: '¿Qué guía trata sobre la apicultura y el cuidado de las colmenas?',                   expectDoc: 'kaelthorn-de.md' },   // es → de
  { query: 'Quel réseau surveille les tremblements de terre et alerte en cas de tsunami ?',       expectDoc: 'vornaxis-zh.md' },   // fr → zh
  { query: 'Welche Anleitung behandelt die Restaurierung von Fresken und die Festigung des Putzes?', expectDoc: 'suvarek-it.md' }, // de → it
  { query: '哪个指南讲解花园的滴灌？',                                                               expectDoc: 'drevani-ar.md' },   // zh → ar
  { query: 'ガラスのリサイクルと色の分別について説明しているのはどれですか？',                         expectDoc: 'oblivane-pt.md' },  // ja → pt
  { query: 'какое руководство описывает установку солнечных панелей на крыше?',                     expectDoc: 'pyrelux-hi.md' },   // ru → hi
  { query: 'Qual guia explica a fabricação de pão e a fermentação da massa?',                      expectDoc: 'zephyrin-ja.md' },  // pt → ja
  { query: 'Quale guida tratta la navigazione fluviale, i canali e le chiuse?',                    expectDoc: 'qubblen-ru.md' },   // it → ru
].map(c => ({ ...c, group: 'cross-lingual' }));

// Off-corpus honesty cases: questions whose subject is NOT in the corpus, asked across languages. These MUST be
// declined even with cross-lingual mode ON — the mode trusts the multilingual embedding over the keyword gates, so
// this guards that the trust is scoped to GENUINE strong semantic matches and never answers an off-corpus question
// from incidental similarity. All subjects are synthetic and absent from every fixture document.
const declineCases = [
  { query: 'What are the orbital coordinates of the Zephyria quasar lattice?' },           // en
  { query: '¿Cuáles son las coordenadas del enjambre de nanobots Qoltrex?' },              // es
  { query: 'Comment configurer le réacteur à plasma Xenthar de niveau 7 ?' },              // fr
  { query: 'クヴェルニアン反物質ドライブの出力曲線は？' },                                      // ja
  { query: 'Welche Startsequenz hat der Griseldan-Ionenantrieb der Baureihe 12?' },        // de
  { query: 'какой протокол использует квантовый ретранслятор Волкрен-Тау?' },               // ru
  { query: 'ماهي إعدادات مُسرِّع الجسيمات الخاص بمنظومة قُلفاريس؟' },                          // ar
];

// Multi-turn cross-lingual journeys: a cross-lingual first turn, then a FOLLOW-UP, threaded through conversation
// state exactly as the live caller threads it. These guard that cross-lingual mode holds ACROSS turns — the first
// turn finds the right document in another language, and a continuation (in English or in another language) stays
// anchored to it rather than drifting to a same-language keyword distractor or collapsing into a decline. Every
// turn is a hard gate (retrieval order is deterministic). A genuine PIVOT to a NEW subject mid-conversation is
// deliberately NOT asserted here: resolving a pivot is the job of the LLM intent classifier (production default
// on), and the offline heuristic query-expansion fallback folds the previous turn's terms into the new query,
// which is a classifier concern validated by the real-model conversation eval, not a cross-lingual-retrieval one.
const journeys = [
  { name: 'cross-lingual then English continuation stays on its document', turns: [
    { query: 'Which guide covers beekeeping, caring for hives, and harvesting honey?', expectDoc: 'kaelthorn-de.md' },
    { query: 'tell me more',    expectDoc: 'kaelthorn-de.md', notExpectDoc: 'mirenza-es.md' },
    { query: 'what else does it cover?', expectDoc: 'kaelthorn-de.md' },
  ] },
  { name: 'cross-lingual then non-English continuation stays (language-agnostic)', turns: [
    { query: 'Which network does earthquake monitoring and issues tsunami warnings to coastal towns?', expectDoc: 'vornaxis-zh.md' },
    { query: 'cuéntame más', expectDoc: 'vornaxis-zh.md', notExpectDoc: 'mirenza-es.md' },
  ] },
];

const FIXTURES_DIR = path.join(__dirname, 'fixtures-multilingual');
const CASES = [...sameLang, ...crossLingual];

// Only run the (model-backed) eval when invoked directly, so a unit test can import the case set and validate its
// structure offline without building an index.
//
// BOTH groups are hard gates now. same-lang (retrieval working natively in every script) and cross-lingual
// (a question in one language finding a document in another) are both implemented and must never regress —
// cross-lingual mode in search.js ranks dense-only and skips every cross-lingual-weak signal (the keyword
// gates, the BM25-dominant and topic-shift promotions, and the English-trained cross-encoder reorder and
// abstention) when the multilingual embedding reports a strong match with no keyword support. The off-corpus
// declineCases run alongside as a further HARD gate: neither recall group may rise by ever answering an
// out-of-corpus question. The gate threshold (default 0.9) leaves a one-case margin on each group so a single
// model hiccup is not a red build, while a real regression in either capability fails loudly.
if (require.main === module) {
  runRecallEval({ fixturesDir: FIXTURES_DIR, cases: CASES, minRecall: MIN_RECALL, title: 'MULTILINGUAL / CROSS-LINGUAL RETRIEVAL', hardGateGroup: ['same-lang', 'cross-lingual'], declineCases, journeys });
}

module.exports = { FIXTURES_DIR, CASES, declineCases, journeys };
