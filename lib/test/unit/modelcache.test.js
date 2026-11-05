'use strict';
// Guards the transformers.js model-cache completeness probe (lib/retrieval/modelcache.js). A PARTIAL cache —
// the ONNX weights present but the tokenizer/model config missing — must count as NOT cached, so the loader
// re-fetches the few missing files remotely instead of attempting a doomed offline load (which fails with an
// opaque "tokenizer_class" error and then poisons a cooldown that fails every following query). Regression
// guard for exactly that: a reranker that silently stopped working because an incomplete download was treated
// as complete. Pure fs probing in a temp dir — no model, no network. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const mc = require(path.resolve(__dirname, '..', '..', 'retrieval', 'modelcache'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const mk = (dir, files) => { fs.mkdirSync(dir, { recursive: true }); for (const f of files) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); } };

(async () => {
try {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-mc-'));
  const cacheDir = path.join(root, 'models');
  const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
  const modelDir = path.join(cacheDir, 'Xenova', 'ms-marco-MiniLM-L-6-v2');

  // ── a non-existent model is not cached ──
  ok(mc.modelFilesComplete(path.join(cacheDir, 'nope')) === false, 'a missing directory is not complete');
  ok(mc.isModelCached(cacheDir, MODEL) === false, 'an absent model is not cached');
  ok(mc.isModelCached('', MODEL) === false && mc.isModelCached(cacheDir, '') === false, 'empty inputs are not cached (never throws)');

  // ── the real failure: weights present but the configs missing → NOT complete (so it re-fetches) ──
  mk(modelDir, ['tokenizer.json', path.join('onnx', 'model_quantized.onnx')]);
  ok(mc.modelFilesComplete(modelDir) === false, 'weights + tokenizer.json but NO config files is a partial cache (the reranker bug)');
  ok(mc.isModelCached(cacheDir, MODEL) === false, 'a partial cache counts as not cached, so the loader re-fetches');

  // ── add one config but still no model config → still incomplete ──
  fs.writeFileSync(path.join(modelDir, 'tokenizer_config.json'), 'x');
  ok(mc.modelFilesComplete(modelDir) === false, 'tokenizer config alone is still incomplete (model config.json missing)');

  // ── complete set → cached ──
  fs.writeFileSync(path.join(modelDir, 'config.json'), 'x');
  ok(mc.modelFilesComplete(modelDir) === true, 'config.json + tokenizer_config.json + ONNX weights is complete');
  ok(mc.isModelCached(cacheDir, MODEL) === true, 'a complete flat-layout cache is cached');

  // ── configs present but weights missing → incomplete ──
  const noWeights = path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2');
  mk(noWeights, ['config.json', 'tokenizer_config.json', 'tokenizer.json']);
  ok(mc.modelFilesComplete(noWeights) === false, 'config files without ONNX weights is incomplete');

  // ── seq2seq (encoder-decoder) completeness: Whisper ships SEPARATE encoder/decoder graphs and needs BOTH. A
  //    download interrupted between them (encoder present, decoder missing) must NOT look complete, or the loader
  //    attempts a doomed offline load and poisons the cooldown — the same trap, uncovered for multi-graph models.
  const seq = path.join(cacheDir, 'onnx-community', 'whisper-base');
  mk(seq, ['config.json', 'tokenizer_config.json', path.join('onnx', 'encoder_model.onnx')]);
  ok(mc.modelFilesComplete(seq) === false, 'a seq2seq model with the encoder graph but NO decoder is incomplete (re-fetch)');
  ok((await mc.modelFilesCompleteAsync(seq)) === false, 'the async probe agrees: encoder-only seq2seq is incomplete');
  fs.writeFileSync(path.join(seq, 'onnx', 'decoder_model_merged.onnx'), 'x');
  ok(mc.modelFilesComplete(seq) === true, 'both encoder and decoder graphs present → complete');
  ok((await mc.modelFilesCompleteAsync(seq)) === true, 'the async probe agrees: encoder + decoder is complete');
  // A single-graph model (reranker/ColBERT/TTS, named model.onnx — no encoder/decoder in the name) is unchanged:
  // one weight file is enough. This is what keeps the seq2seq rule from over-reaching.
  const single = path.join(cacheDir, 'Xenova', 'bge-small');
  mk(single, ['config.json', 'tokenizer_config.json', path.join('onnx', 'model.onnx')]);
  ok(mc.modelFilesComplete(single) === true, 'a single-graph model needs only one ONNX weight (no decoder required)');

  // ── the HF-hub forward-compat layout stays a lenient non-empty check ──
  const hub = path.join(cacheDir, 'models--Xenova--some-model');
  mk(hub, ['snapshots/abc/config.json']);
  ok(mc.isModelCached(cacheDir, 'Xenova/some-model') === true, 'a non-empty hub-layout dir is treated as cached (forward-compat fallback)');

  // ── the required-files list is exported as the single source ──
  ok(Array.isArray(mc.REQUIRED_MODEL_FILES) && mc.REQUIRED_MODEL_FILES.includes('tokenizer_config.json') && mc.REQUIRED_MODEL_FILES.includes('config.json'),
    'the required-files list is exported (single source for the loader and the watchdog)');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nALL MODELCACHE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MODELCACHE TEST FAILED:', e && e.message);
  process.exit(1);
}
})();
