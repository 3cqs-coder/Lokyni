'use strict';
// Guards the config live-reload contract for embeddings (audit pass 7). The embedding provider,
// model, host, and keys are all writable Settings keys. reloadConfig() re-requires ./config on a
// Settings save, so makeEmbeddings() must read those values LIVE at call time — a value captured
// at import would keep every embedding call on the boot-time provider, silently sending indexing
// and query embeddings to the wrong (or a dead) provider until a restart. This test mutates the
// live config object (the same effect reloadConfig has) and asserts the next makeEmbeddings()
// reflects it. No model or network — the clients are only constructed, never called.
//
// Run: `npm run test:unit` (or `node lib/test/unit/config-live.test.js`).

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const { makeEmbeddings } = require(path.join(PROJECT, 'lib', 'embeddings'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// Snapshot the keys we mutate so this test can't leak into any other (each test file is its own
// process, but restore anyway for hygiene).
const saved = {
  AI_PROVIDER: cfg.AI_PROVIDER, EMBEDDINGS_PROVIDER: cfg.EMBEDDINGS_PROVIDER, EMBEDDINGS_MODEL: cfg.EMBEDDINGS_MODEL,
  OLLAMA_HOST: cfg.OLLAMA_HOST, OLLAMA_KEY: cfg.OLLAMA_KEY,
  OPENAI_KEY: cfg.OPENAI_KEY, OPENAI_BASE: cfg.OPENAI_BASE,
};

try {
  // ── Boot-time provider ── (embeddings follow the EMBEDDING provider, independent of the chat provider)
  cfg.EMBEDDINGS_PROVIDER = 'ollama';
  cfg.EMBEDDINGS_MODEL = 'model-a';
  cfg.OLLAMA_HOST = 'http://host-a:11434';
  let e = makeEmbeddings();
  ok(e.model === 'model-a', 'makeEmbeddings uses the current model');
  ok(e.baseUrl === 'http://host-a:11434', 'makeEmbeddings uses the current Ollama host');

  // ── A Settings change (what reloadConfig produces) must be picked up on the NEXT call ──
  cfg.EMBEDDINGS_MODEL = 'model-b';
  cfg.OLLAMA_HOST = 'http://host-b:11434';
  e = makeEmbeddings();
  ok(e.model === 'model-b', 'a live model change reaches makeEmbeddings without a restart');
  ok(e.baseUrl === 'http://host-b:11434', 'a live host change reaches makeEmbeddings without a restart');

  // ── Switching the EMBEDDING provider (Ollama -> OpenAI) must also take effect live, independent of
  //    the chat provider (which can even be a chat-only one like Anthropic) ──
  cfg.AI_PROVIDER = 'anthropic';
  cfg.EMBEDDINGS_PROVIDER = 'openai';
  cfg.OPENAI_KEY = 'sk-test';
  cfg.EMBEDDINGS_MODEL = 'text-embed-c';
  e = makeEmbeddings();
  ok(e.constructor && /OpenAIEmbeddings/.test(e.constructor.name), 'switching the embedding provider to OpenAI builds an OpenAI client live (even while chat is Anthropic)');
  ok(e.model === 'text-embed-c', 'the OpenAI client uses the live embeddings model');

  // ── Explicit per-bank overrides still win over the live config (frozen-bank queries) ──
  cfg.EMBEDDINGS_PROVIDER = 'ollama';
  const over = makeEmbeddings({ provider: 'ollama', model: 'bank-model', baseUrl: 'http://bank-host:11434' });
  ok(over.model === 'bank-model' && over.baseUrl === 'http://bank-host:11434', 'explicit overrides still take precedence over live config');

  console.log('✓ config-live: makeEmbeddings reads provider/model/host live, honors overrides');

  // ── Drift guard: hot-path modules must NOT freeze a writable Setting at import ──
  // Several audit passes kept finding writable Settings destructured from ./config at module load,
  // which makes a Settings change silently need a restart. Assert the known hot-path keys are read
  // LIVE (require('../config').KEY at call time), i.e. they do NOT appear in a top-level
  // `const { … } = require('…/config')` destructure. This locks the fixes in and catches the class.
  const fs = require('fs');
  const frozenImport = (relFile, key) => {
    const src = fs.readFileSync(path.join(PROJECT, relFile), 'utf-8');
    // A TOP-LEVEL `const { … KEY … } = require('...config...')` destructure — the freeze. Anchored
    // to the start of a line (module scope, column 0); an indented in-function `const { … } =
    // require('../config')` is the CORRECT live read (re-required per call after reloadConfig) and
    // must NOT trip this.
    const re = new RegExp('^const\\s*\\{[^}]*\\b' + key + '\\b[^}]*\\}\\s*=\\s*require\\([\'"][^\'"]*config[\'"]\\)', 'm');
    return re.test(src);
  };
  for (const [file, key] of [
    ['lib/retrieval/search.js', 'PASSAGE_SIZE'],
    ['lib/retrieval/expand.js', 'maxHistory'],
    ['lib/retrieval/intent.js', 'useIntentClassifier'],
    ['lib/suggest.js', 'useSuggestedQuestions'],
    ['lib/retrieval/webanswer.js', 'useWebResultRanking'],
    ['lib/retrieval/deepresearch.js', 'numCtx'],
    ['lib/embeddings.js', 'EMBEDDINGS_MODEL'],
    ['lib/embeddings.js', 'EMBEDDINGS_PROVIDER'],
    ['lib/indexing/init.js', 'EMBEDDINGS_MODEL'],
  ]) {
    ok(!frozenImport(file, key), `${file} reads ${key} live, not frozen in an import destructure`);
  }
  console.log('✓ config-live: hot-path writable Settings are read live, not frozen at import');

  // ── semanticcache.signature() folds in the recall-augmentation toggles ──
  const { signature } = require(path.join(PROJECT, 'lib', 'semanticcache'));
  const base = { AI_PROVIDER: 'ollama', LLM_MODEL: 'm', useRagFusion: false, useHyde: false, useEntityGraph: false, useAdaptiveRetrieval: false, useIntentClassifier: false, useMetaConversation: false };
  // Each toggle that changes WHICH docs are retrieved or HOW the answer is written must flip the
  // signature, or the cache could replay an answer computed under different settings. Intent
  // classification (and its model) steer a first query; meta-conversation changes whether a meta turn
  // is answered normally and cached.
  for (const toggle of ['useRagFusion', 'useHyde', 'useEntityGraph', 'useAdaptiveRetrieval', 'useIntentClassifier', 'useMetaConversation']) {
    ok(signature(base) !== signature({ ...base, [toggle]: true }), `signature() changes when ${toggle} flips (no stale cached answer)`);
  }
  ok(signature(base) !== signature({ ...base, intentModel: 'other-model' }), 'signature() changes when the intent model changes');
  console.log('✓ config-live: semantic-cache signature includes retrieval + intent/meta routing toggles');

  console.log(`\nALL CONFIG-LIVE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CONFIG-LIVE UNIT TEST FAILED:', e.message);
  process.exit(1);
} finally {
  Object.assign(cfg, saved);
}
