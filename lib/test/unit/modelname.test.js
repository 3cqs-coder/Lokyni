'use strict';
// Unit tests for the shared model-name helpers (lib/modelname.js): tag normalization so
// `foo` and `foo:latest` compare equal (avoiding a needless full re-embed), and the
// embedding-model classifier that keeps the Settings "Embeddings model" picker from offering a
// chat model. Pure and hermetic — no provider, no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { normalizeModelName, sameModel, isEmbeddingModel } = require(path.join(PROJECT, 'lib', 'modelname'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // ── normalizeModelName / sameModel: :latest is the implicit default tag ──
  ok(normalizeModelName('nomic-embed-text:latest') === 'nomic-embed-text', 'strips a trailing :latest');
  ok(normalizeModelName('nomic-embed-text') === 'nomic-embed-text', 'leaves an untagged name alone');
  ok(normalizeModelName('  llama3.2:latest  ') === 'llama3.2', 'trims surrounding whitespace');
  ok(normalizeModelName('bge-m3:567m') === 'bge-m3:567m', 'keeps an explicit non-latest tag (a different model)');
  ok(normalizeModelName('') === '' && normalizeModelName(null) === '' && normalizeModelName(undefined) === '', 'empty/null/undefined are safe');
  ok(sameModel('nomic-embed-text', 'nomic-embed-text:latest'), 'foo and foo:latest are the same model');
  ok(!sameModel('nomic-embed-text', 'mxbai-embed-large'), 'different models are not equal');
  ok(!sameModel('bge-m3', 'bge-m3:567m'), 'an explicit tag is a distinct model');
  console.log('✓ modelname: :latest normalization and same-model comparison');

  // ── isEmbeddingModel: recognizes embedding families across providers ──
  for (const m of [
    'nomic-embed-text', 'nomic-embed-text:latest', 'mxbai-embed-large', 'snowflake-arctic-embed',
    'granite-embedding', 'embeddinggemma', 'all-minilm', 'all-minilm:l6-v2',
    'text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002',
    'bge-large', 'bge-m3', 'gte-large', 'gte-qwen2', 'e5-mistral-7b', 'paraphrase-multilingual',
  ]) {
    ok(isEmbeddingModel(m) === true, `recognizes embedding model: ${m}`);
  }

  // ── isEmbeddingModel: rejects chat models (the mistake that caused the stuck rebuild) ──
  for (const m of [
    'llama3.2', 'llama3.2:latest', 'llama3.1:8b', 'qwen2.5:7b-instruct', 'gemma2:9b',
    'mistral', 'phi3.5', 'deepseek-r1', 'gpt-4o', 'gpt-4o-mini', 'o1-preview', '',
  ]) {
    ok(isEmbeddingModel(m) === false, `rejects non-embedding model: ${m || '(empty)'}`);
  }
  console.log('✓ modelname: embedding-model classifier accepts embedders, rejects chat models');

  console.log(`\nALL MODELNAME UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MODELNAME UNIT TEST FAILED:', e.message);
  process.exit(1);
}
