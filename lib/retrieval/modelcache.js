'use strict';

// Is a transformers.js model already present — and COMPLETE — in the local cache directory?
//
// Loading is offline-first: the reranker and ColBERT cores decide `allowRemoteModels` from this probe
// up front, so a fully-cached model is loaded WITHOUT any network attempt (and stays working fully offline),
// while a missing OR PARTIAL one is fetched once. "Partial" matters: a download interrupted after the ONNX
// weights but before the tokenizer config leaves a non-empty directory that cannot actually load — the
// tokenizer read fails with an opaque "tokenizer_class" error, and the loader's post-failure cooldown then
// makes EVERY following query fail fast for minutes. Treating a partial cache as "not cached" lets the loader
// fetch the few missing files remotely and heal itself, instead of retrying a doomed offline load.
//
// The probe reads the on-disk cache layout, which is an undocumented internal of @huggingface/transformers —
// so it tolerates BOTH known layouts:
//   • the flat FileCache layout used by v3/v4:    <cacheDir>/<org>/<model>/...
//   • the HF-hub style layout ("models--org--model"), in case a future major switches to it
// If neither is found (or the layout changes again), it returns false and the caller falls back to a
// remote fetch — a safe degradation (works online; only strict-offline first-run is affected), never a
// crash. Single-sourced here so the two cores (and the integrity watchdog) can't drift, and there is one
// place to update on an upgrade.

const fs = require('fs');
const path = require('path');

// The small config files transformers.js needs to load a tokenizer + model. A complete cache has BOTH, plus
// the ONNX weights (checked separately, since those live under onnx/ and have a model-specific name). Single
// source for "what "complete" means", reused by the loader and the model-integrity watchdog check.
const REQUIRED_MODEL_FILES = ['config.json', 'tokenizer_config.json'];

// The one place that decides where transformers.js caches models under the data dir. The reranker/ColBERT
// cores, the voice STT/TTS loaders, and the integrity watchdog all resolve the cache root through this, so
// the subdirectory name ('models') cannot drift across them — change it here and every caller follows.
const MODELS_SUBDIR = 'models';
const modelsRoot = (dataDir) => dataDir ? path.resolve(dataDir, MODELS_SUBDIR) : '';

// Collect the ONNX weight file names (lowercased) in `dir` and its `onnx/` subdir. transformers.js stores
// weights under `onnx/` (e.g. model.onnx, model_quantized.onnx); a flat weights file is tolerated too.
// Bounded to those two levels — no deep walk — so this stays cheap and cannot wander a large tree. Never throws.
const onnxNamesIn = (dir) => {
  const names = [];
  const scan = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile() && e.name.toLowerCase().endsWith('.onnx')) names.push(e.name.toLowerCase()); } catch { /* absent */ } };
  scan(dir); scan(path.join(dir, 'onnx'));
  return names;
};
// Are the ONNX weights present AND complete for the model's architecture? A single-graph model (cross-encoder
// reranker, ColBERT, Kokoro TTS — all named model.onnx) needs just one file. An encoder-decoder (seq2seq) model
// like Whisper ships SEPARATE encoder_*.onnx and decoder_*.onnx graphs and needs BOTH: a download interrupted
// between them would otherwise look "complete", be loaded offline, and fail a doomed load (the opaque cooldown
// trap this module exists to prevent). An encoder graph implies seq2seq, so if one is present a decoder must be
// too; models with no encoder-named graph (encoder-only or decoder-only) are judged complete on any one weight.
const onnxComplete = (names) => {
  if (!names.length) return false;
  if (names.some((n) => n.includes('encoder'))) return names.some((n) => n.includes('decoder'));
  return true;
};
const hasOnnxWeights = (dir) => onnxComplete(onnxNamesIn(dir));

// Is the model directory a COMPLETE, loadable cache: all required config files present AND the ONNX weights?
// A directory that exists but is missing any of these is a partial download and counts as NOT complete.
const modelFilesComplete = (dir) => {
  try {
    if (!fs.existsSync(dir)) return false;
    for (const f of REQUIRED_MODEL_FILES) if (!fs.existsSync(path.join(dir, f))) return false;
    return hasOnnxWeights(dir);
  } catch { return false; }
};

// Async twin of the two probes above. The loader must answer synchronously at model-load time (it sits on the
// query hot path), so modelFilesComplete stays sync. The integrity watchdog, by contrast, runs off the hot path
// and must never block the event loop — a hung or slow network mount under the data dir would freeze the whole
// process and defeat the per-check timeout — so it uses these fs.promises versions. Same constants, same rules.
const hasOnnxWeightsAsync = async (dir) => {
  const names = [];
  const scan = async (d) => { try { for (const e of await fs.promises.readdir(d, { withFileTypes: true })) if (e.isFile() && e.name.toLowerCase().endsWith('.onnx')) names.push(e.name.toLowerCase()); } catch { /* absent */ } };
  await scan(dir); await scan(path.join(dir, 'onnx'));
  return onnxComplete(names);   // same completeness rule as the sync probe (encoder ⇒ decoder required)
};
const fileExistsAsync = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
const modelFilesCompleteAsync = async (dir) => {
  try {
    if (!(await fileExistsAsync(dir))) return false;
    for (const f of REQUIRED_MODEL_FILES) if (!(await fileExistsAsync(path.join(dir, f)))) return false;
    return await hasOnnxWeightsAsync(dir);
  } catch { return false; }
};

// The flat-layout directory for a model id under a cache dir: <cacheDir>/<org>/<model>. Shared with the
// watchdog so it probes exactly where the loader looks. Returns '' on bad input.
const flatModelDir = (cacheDir, modelId) =>
  (cacheDir && modelId) ? path.join(cacheDir, ...String(modelId).split('/')) : '';

function isModelCached(cacheDir, modelId) {
  if (!cacheDir || !modelId) return false;
  // Flat layout: require a COMPLETE set of files, so a partial download is re-fetched rather than loaded.
  if (modelFilesComplete(flatModelDir(cacheDir, modelId))) return true;
  // HF-hub layout: <cacheDir>/models--<org>--<model>. Kept as a lenient non-empty check — it is a
  // forward-compat fallback for a layout the current library does not use, and its blob/snapshot structure
  // doesn't map cleanly to the file names above; a false "cached" here only costs a redundant offline attempt
  // that the loader already recovers from with a remote retry.
  const hubDir = path.join(cacheDir, 'models--' + String(modelId).replace(/\//g, '--'));
  try { if (fs.readdirSync(hubDir).length > 0) return true; } catch { /* absent */ }
  return false;
}

module.exports = { isModelCached, modelFilesComplete, modelFilesCompleteAsync, flatModelDir, modelsRoot, MODELS_SUBDIR, REQUIRED_MODEL_FILES };
