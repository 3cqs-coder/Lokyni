'use strict';
// Deterministic retrieval fixtures and a model-free embedding stub for the regression test.
//
// The real pipeline embeds with a model, so its retrieval tests need a provider and a network.
// This harness replaces only the embedding transport with a deterministic lexical embedder while
// keeping the production tokenizer, chunker, BM25 engine, RRF, relevance gates, passage windowing,
// and search orchestration. Tests can therefore exercise the real retrieval path offline and on
// every platform.
//
// The lexical embedder is deliberately not a semantic model. It hashes the shared tokenizer's
// terms plus character trigrams into a fixed vector, weighted by corpus document frequency. Terms
// that are common across the corpus are dropped, so an off-corpus question cannot look relevant
// from shared filler words. Character trigrams keep scripts without word spaces and simple
// morphological variants searchable. Using the same tokenizer as the index means the test cannot
// drift from production tokenization.
//
// All names, documents, and questions are synthetic. No fixture is written to disk.

const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { tokenize } = require(path.join(ROOT, 'lib/retrieval/keywords'));
const { emptyBundle } = require(path.join(ROOT, 'lib/indexing/bundle'));
const { semanticSplitDocument } = require(path.join(ROOT, 'lib/indexing/chunking'));
const { buildBM25Index } = require(path.join(ROOT, 'lib/retrieval/bm25'));
const { buildChunkIndexInto } = require(path.join(ROOT, 'lib/retrieval/passages'));
const { FaissStore } = require('@langchain/community/vectorstores/faiss');

// A fixed width wide enough that a small multilingual corpus has negligible hash collisions.
// Kept in one place so the builder and the embedder cannot disagree.
const LEXICAL_DIM = 4096;

// One marker and one file name for the long-document citation case, shared by the fixture and the
// test so the location assertion cannot drift from the text it is looking for.
const LONG_DOCUMENT_MARKER = 'ORB-7781';
const LONG_DOCUMENT_NAME = 'orbis-long.md';

// Ten short documents in ten writing systems, plus one long document for citation offsets.
// They share a format but not their identifying names, so every query has one correct answer.
const LONG_DOCUMENT_BODY = (() => {
  const lines = Array.from(
    { length: 180 },
    (_, i) => `Archive entry ${i} records routine calibration metadata.`,
  );
  // The marker appears only in the final section, so a correct citation must serve a window that
  // starts past the beginning of the document.
  for (let i = 160; i < 170; i++) lines[i] = `Access phrase ${LONG_DOCUMENT_MARKER} is recorded in ledger ${i}.`;
  return lines.join('\n');
})();

const FIXTURE_DOCS = [
  {
    lang: 'en',
    name: 'zorvath-en.md',
    text: 'Project Zorvath launch code is ZX-9042. The program lead is Dr. Mara Voss. The approved budget is 7.5 million credits. The calibration review is on 14 March 2026.',
  },
  {
    lang: 'es',
    name: 'quilla-es.md',
    text: 'El Proyecto Quilla tiene el código de lanzamiento QL-1187. La directora del programa es la Dra. Inés Rojas. El presupuesto aprobado es de 7,5 millones de créditos. La revisión de calibración es el 14 de marzo de 2026.',
  },
  {
    lang: 'fr',
    name: 'nyx-fr.md',
    text: 'Le Projet Nyx a pour code de lancement NY-3301. La responsable du programme est le Dr Luc Moreau. Le budget approuvé est de 7,5 millions de crédits. La revue de calibration est le 14 mars 2026.',
  },
  {
    lang: 'de',
    name: 'falke-de.md',
    text: 'Das Projekt Falke hat den Startcode FK-5520. Die Programmleiterin ist Dr. Anke Ritter. Das genehmigte Budget beträgt 7,5 Millionen Credits. Die Kalibrierungsprüfung ist am 14. März 2026.',
  },
  {
    lang: 'ar',
    name: 'saqr-ar.md',
    text: 'مشروع صقر يحمل رمز الإطلاق SK-7719. قائدة البرنامج هي الدكتورة ليلى حداد. الميزانية المعتمدة هي 7.5 مليون رصيد. مراجعة المعايرة يوم 14 مارس 2026.',
  },
  {
    lang: 'hi',
    name: 'megh-hi.md',
    text: 'परियोजना मेघ का लॉन्च कोड MG-2264 है। कार्यक्रम की प्रमुख डॉ. आशा राव हैं। स्वीकृत बजट 7.5 मिलियन क्रेडिट है। अंशांकन समीक्षा 14 मार्च 2026 को है।',
  },
  {
    lang: 'zh',
    name: 'qilin-zh.md',
    text: '麒麟计划的发射代码是 QL-8802。项目负责人是陈明博士。批准预算是 750 万信用点。校准评审在 2026 年 3 月 14 日。',
  },
  {
    lang: 'ja',
    name: 'kaminari-ja.md',
    text: 'プロジェクト雷の起動コードは RK-6410 です。プログラム責任者は佐藤花博士です。承認された予算は 750 万クレジットです。校正レビューは 2026 年 3 月 14 日です。',
  },
  {
    lang: 'ru',
    name: 'vektor-ru.md',
    text: 'Проект Вектор имеет код запуска VK-1935. Руководитель программы — доктор Иван Петров. Утверждённый бюджет составляет 7,5 миллиона кредитов. Проверка калибровки состоится 14 марта 2026 года.',
  },
  {
    lang: 'ko',
    name: 'hana-ko.md',
    text: '프로젝트 하나의 실행 코드는 HN-7028입니다. 프로그램 책임자는 김서연 박사입니다. 승인된 예산은 750만 크레딧입니다. 교정 검토는 2026년 3월 14일입니다.',
  },
  {
    lang: 'en',
    name: LONG_DOCUMENT_NAME,
    text: LONG_DOCUMENT_BODY,
  },
];

// One query per language. Each names its document's unique term (or shared code), so a pass
// proves tokenization, weighting, fusion, gating, and windowing all agree for that script.
const FIXTURE_QUERIES = [
  { lang: 'en', query: 'What is the launch code for Project Zorvath?', expect: 'zorvath-en.md' },
  { lang: 'es', query: '¿Cuál es el código de lanzamiento del Proyecto Quilla?', expect: 'quilla-es.md' },
  { lang: 'fr', query: 'Quel est le code de lancement du Projet Nyx ?', expect: 'nyx-fr.md' },
  { lang: 'de', query: 'Wie lautet der Startcode für Projekt Falke?', expect: 'falke-de.md' },
  { lang: 'ar', query: 'ما هو رمز الإطلاق لمشروع صقر؟', expect: 'saqr-ar.md' },
  { lang: 'hi', query: 'परियोजना मेघ का लॉन्च कोड क्या है?', expect: 'megh-hi.md' },
  { lang: 'zh', query: '麒麟计划的发射代码是什么？', expect: 'qilin-zh.md' },
  { lang: 'ja', query: 'プロジェクト雷の起動コードは何ですか？', expect: 'kaminari-ja.md' },
  { lang: 'ru', query: 'Какой код запуска у проекта Вектор?', expect: 'vektor-ru.md' },
  { lang: 'ko', query: '프로젝트 하나의 실행 코드는 무엇입니까?', expect: 'hana-ko.md' },
];

// A question with no term from the corpus. It must be declined, not answered from filler words.
const OFF_CORPUS_QUERY = 'Zephyria quasar lattice coordinates?';
// A pronoun-only follow-up: only the conversation's document makes this answerable.
const FOLLOW_UP_QUERY = 'How much does it cost?';
// An absent subject inside a familiar domain. The domain words match, but the name must prevent a
// confident answer from the wrong document.
const NOVEL_ENTITY_QUERY = 'What is the launch code for the Zephyria program?';
// The same case with a language-agnostic identifier and with a quoted name in Arabic.
const NOVEL_IDENTIFIER_QUERY = 'What is the ZZ-0000 access phrase?';
const NOVEL_QUOTED_QUERY = 'ما هو رمز "زفيريا"؟';
// A known subject alongside an unknown one must still be answerable from the known document.
const MIXED_ENTITY_QUERY = 'Compare Project Zorvath with the Zephyria program.';
// A new subject raised inside an existing conversation. The novel one is declined; the known one is not.
const NOVEL_ENTITY_FOLLOW_UP_QUERY = 'What about the Zephyria program?';
const KNOWN_ENTITY_FOLLOW_UP_QUERY = 'What about the Quilla program?';
// A distinctive phrase near the end of the long document, so the served window has to advance.
const LONG_DOCUMENT_QUERY = `${LONG_DOCUMENT_MARKER} access phrase`;
// A morphological variant absent from the index, matched through character n-grams.
const DENSE_VARIANT_QUERY = 'Zorvathian';
// A CJK bigram present only in the Chinese document.
const BM25_CJK_QUERY = '麒麟';

// A stable parent id for a fixture file name. The test uses this to assert which document a
// source or a dense hit belongs to without reading ordinary file paths.
const docIdForName = (name) => crypto.createHash('sha256').update(String(name)).digest('hex');

// A 32-bit FNV-1a hash over Unicode code points. Math.imul and code-point iteration are
// deterministic on every platform, unlike locale-dependent sorting or locale lower-casing.
const hash32 = (s, seed = 0) => {
  let h = (2166136261 ^ seed) >>> 0;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

// Features are the shared tokenizer's terms plus overlapping character trigrams. Trigrams give
// scripts without spaces and simple inflections a dense signal without a language-specific stemmer.
const featuresOf = (text) => {
  const features = new Map();
  const add = (key, weight) => features.set(key, (features.get(key) || 0) + weight);
  for (const tok of tokenize(text)) {
    add(`w:${tok}`, 1);
    if (tok.length >= 3) {
      for (let i = 0; i + 3 <= tok.length; i++) add(`g:${tok.slice(i, i + 3)}`, 0.35);
    }
  }
  return features;
};

// Build the deterministic embedder from the corpus. Document frequency is measured over the
// fixtures; features present in more than 60% of documents are dropped as filler. A query term
// absent from the corpus is ignored, so an off-corpus question cannot borrow relevance from a
// shared stopword.
const createLexicalEmbeddings = (texts) => {
  const N = texts.length;
  const df = new Map();
  for (const text of texts) {
    for (const key of featuresOf(text).keys()) df.set(key, (df.get(key) || 0) + 1);
  }
  const maxDf = Math.max(2, Math.ceil(N * 0.6));
  const idf = new Map();
  for (const [key, count] of df) {
    if (count <= maxDf) idf.set(key, 1 + Math.log((N + 1) / (count + 1)));
  }
  const vectorFor = (text) => {
    const vector = new Array(LEXICAL_DIM).fill(0);
    for (const [key, count] of featuresOf(text)) {
      const weight = idf.get(key);
      if (!weight) continue;
      const index = hash32(key) % LEXICAL_DIM;
      const sign = (hash32(key, 0x9e3779b9) & 1) ? 1 : -1;
      vector[index] += sign * weight * count;
    }
    let sumSq = 0;
    for (const value of vector) sumSq += value * value;
    if (sumSq > 0) {
      const inv = 1 / Math.sqrt(sumSq);
      for (let i = 0; i < vector.length; i++) vector[i] *= inv;
    }
    return vector;
  };
  return {
    embedDocuments: async (documents) => documents.map(vectorFor),
    embedQuery: async (query) => vectorFor(query),
  };
};

// Build the same in-memory index a workspace warm start builds, without touching disk or a model.
const buildFixtureBundle = async (docs = FIXTURE_DOCS) => {
  const embeddings = createLexicalEmbeddings(docs.map((doc) => doc.text));
  const bundle = emptyBundle();
  bundle.workspaceId = 'default';
  bundle.lastIndexedAt = 1;

  const chunkDocs = [];
  for (const doc of docs) {
    const docId = docIdForName(doc.name);
    const metadata = {
      docId,
      source: `/corpus/${doc.name}`,
      fileName: doc.name,
      fileType: 'md',
      docLength: doc.text.length,
    };
    bundle.parentMap.set(docId, { content: doc.text, metadata });
    chunkDocs.push(...await semanticSplitDocument({ content: doc.text, metadata }, bundle.childMap, bundle.passageMap));
  }

  bundle.liveBM25 = await buildBM25Index(bundle.parentMap, null, bundle);
  buildChunkIndexInto(bundle);
  bundle.liveVectorStore = await FaissStore.fromDocuments(chunkDocs, embeddings);
  return { bundle, embeddings };
};

// The retrieval features that require a model, network, worker, or persisted workspace state.
// Every switch is explicitly off so the test exercises only the deterministic pipeline.
const RETRIEVAL_OFF = {
  USE_RERANKER: false,
  USE_COLBERT_RERANK: false,
  useQueryRewrite: false,
  useIntentClassifier: false,
  useConversationSummary: false,
  useRagFusion: false,
  useHyde: false,
  useAdaptiveRetrieval: false,
  useEntityGraph: false,
  useGraphRag: false,
  useCorrectiveRetrieval: false,
  // Cross-lingual mode trusts the multilingual embedding over the keyword gates when a query and its
  // answering document are in different languages. That premise requires a real semantic embedder: the
  // deterministic LEXICAL stub here has no cross-lingual capability (an English query and a German
  // document share almost no character n-grams, so the stub scores them low, not high), and its cosine
  // is a lexical-overlap number, not a semantic-relevance one. Leaving the mode on over the stub would
  // only let incidental n-gram overlap on an OFF-corpus query clear the (test-only, deliberately low)
  // cosine floor and wrongly bypass the keyword honesty gate. The feature is validated end-to-end over
  // the real embedder by the multilingual eval (lib/test/eval/multilingual.js), which also guards that
  // off-corpus questions stay declined with the mode ON.
  useCrossLingual: false,
  useSemanticCache: false,
  useTopicSwitchAck: false,
  useClarifyingQuestions: false,
  usePartialMatchTier: false,
  useDocumentSummaries: false,
  useAutoSynthesis: false,
  useEmbeddingBanks: false,
  PASSAGE_SIZE: 8000,
  // The lexical stub is not a semantic model, so its cosine scale differs from a real embedder.
  // This lower floor is test-only and is paired with the corpus-frequency filter above.
  MIN_COSINE_SCORE: 0.08,
  DEBUG: false,
};

// Temporarily apply test-only settings and restore every value on both success and failure.
// Throws if a key is not actually exported by config, so a renamed setting cannot silently make
// the harness stop disabling a model-backed path.
const withRetrievalConfig = async (overrides, fn) => {
  const cfg = require(path.join(ROOT, 'lib/config'));
  const saved = new Map();
  for (const key of Object.keys(overrides)) {
    if (!(key in cfg)) throw new Error(`retrieval harness: config has no "${key}" key`);
    saved.set(key, cfg[key]);
    cfg[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) cfg[key] = value;
  }
};

const makeConversation = (extra = {}) => ({
  history: [],
  allowedDocIds: [],
  docPassages: new Map(),
  docReadPos: new Map(),
  docExcludePos: new Map(),
  windowScoreCache: new Map(),
  summary: '',
  ...extra,
});

// Run the real search orchestration without consuming its answer stream. The stream is lazy;
// not reading it is what keeps the test model-free while `sources`, gates, and citations run.
const runRetrieval = (bundle, query, conversation = makeConversation()) => {
  const { searchDocuments } = require(path.join(ROOT, 'lib/retrieval/search'));
  return searchDocuments(query, null, null, conversation, false, null, 1, { idx: bundle });
};

module.exports = {
  LEXICAL_DIM,
  LONG_DOCUMENT_MARKER,
  LONG_DOCUMENT_NAME,
  FIXTURE_DOCS,
  FIXTURE_QUERIES,
  OFF_CORPUS_QUERY,
  FOLLOW_UP_QUERY,
  NOVEL_ENTITY_QUERY,
  NOVEL_IDENTIFIER_QUERY,
  NOVEL_QUOTED_QUERY,
  MIXED_ENTITY_QUERY,
  NOVEL_ENTITY_FOLLOW_UP_QUERY,
  KNOWN_ENTITY_FOLLOW_UP_QUERY,
  LONG_DOCUMENT_QUERY,
  DENSE_VARIANT_QUERY,
  BM25_CJK_QUERY,
  docIdForName,
  createLexicalEmbeddings,
  buildFixtureBundle,
  RETRIEVAL_OFF,
  withRetrievalConfig,
  makeConversation,
  runRetrieval,
};
