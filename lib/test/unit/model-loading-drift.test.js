'use strict';
// Drift guard for how the local models (the cross-encoder reranker and the ColBERT feature extractor)
// are loaded. These behaviors break SILENTLY if a refactor drops them — a query still returns, just with
// a worse model path or a needless network dependency — so functional tests can't catch a regression.
// This is a source-inspection guard (the same style as the other *-drift tests). It asserts, for both
// lib/retrieval/rerankcore.js and lib/retrieval/colbertcore.js:
//   1. the model comes from @huggingface/transformers (Transformers.js), never the retired @xenova one;
//   2. precision is set explicitly — quantized 'q8' with an 'fp32' fallback (the library no longer
//      quantizes by default, so relying on the default would silently change vectors);
//   3. loading is offline-first — it decides allowRemoteModels from a cache probe up front (so a cached
//      or pre-seeded model loads with no network, resilient to a blocked model host) rather than probing
//      with a failing offline load, and falls back to a remote fetch on a cache miss;
//   4. inputs are length-capped before tokenizing (MAX_INPUT_CHARS) so a pathologically large passage
//      can't blow up tokenization memory/CPU.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
try {
  for (const file of ['rerankcore.js', 'colbertcore.js']) {
    const src = read(file);

    ok(!/@xenova\/transformers/.test(src), `${file}: no reference to the retired @xenova/transformers`);

    // Explicit precision with a fallback (in the core's model-build callback).
    ok(/dtype:\s*'q8'/.test(src), `${file}: requests the 8-bit quantized weights (dtype q8)`);
    ok(/dtype:\s*'fp32'/.test(src), `${file}: falls back to full precision (dtype fp32)`);

    // The one-time, offline-first load lifecycle is single-sourced in modelload.makeLoader (asserted below),
    // so both cores share it and the cooldown / cache-probe / remote-retry can't drift between them.
    ok(/require\('\.\/modelload'\)/.test(src) && /makeLoader\(\{/.test(src),
      `${file}: loads through the shared offline-first loader (modelload.makeLoader)`);

    // Input length cap before tokenizing (the shared constant comes from modelload).
    ok(/MAX_INPUT_CHARS/.test(src), `${file}: uses the input length cap`);
    ok(/\.slice\(0,\s*MAX_INPUT_CHARS\)/.test(src), `${file}: clips inputs to the cap before tokenizing`);
  }

  // The shared loader: Transformers.js (never the retired @xenova), offline-first from a cache probe, with a
  // remote-fetch fallback. These behaviors moved here from the two cores, so they are asserted once.
  const ml = read('modelload.js');
  ok(/@huggingface\/transformers/.test(ml), 'modelload: loads from @huggingface/transformers');
  ok(!/@xenova\/transformers/.test(ml), 'modelload: no reference to the retired @xenova/transformers');
  ok(/require\('\.\/modelcache'\)\.isModelCached\(/.test(ml),
    'modelload: detects the cached model via the shared isModelCached probe');
  ok(/allowRemoteModels\s*=\s*!cached/.test(ml),
    'modelload: sets allowRemoteModels from the cache probe (offline when cached)');
  ok(/allowRemoteModels\s*=\s*true/.test(ml),
    'modelload: falls back to a remote fetch when the model is not cached / cache is partial');

  // The shared probe tolerates BOTH transformers cache layouts (flat <org>/<model> and hub
  // models--org--model), and for the flat layout it now requires a COMPLETE file set, so a PARTIAL download
  // (weights present, config missing) is re-fetched instead of failing a doomed offline load. (Thorough
  // behavioral coverage lives in modelcache.test.js; this guards the drift-prone probe + loader wiring.)
  const mc = read('modelcache.js');
  ok(/\.split\('\/'\)/.test(mc) && /modelFilesComplete\(/.test(mc), 'modelcache probes the flat <org>/<model> layout and requires a complete file set');
  ok(/models--/.test(mc) && /\.replace\(/.test(mc), 'modelcache also probes the hub models--org--model layout');
  // Functional: a COMPLETE flat cache is detected; a PARTIAL one is not (the reranker-bug fix); hub is lenient.
  {
    const os = require('os');
    const { isModelCached } = require(path.join(PROJECT, 'lib', 'retrieval', 'modelcache'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-mc-'));
    try {
      ok(isModelCached(dir, 'Org/Model') === false, 'no cache dir → not cached');
      const md = path.join(dir, 'Org', 'Model');
      fs.mkdirSync(path.join(md, 'onnx'), { recursive: true });
      fs.writeFileSync(path.join(md, 'onnx', 'model.onnx'), '1');
      fs.writeFileSync(path.join(md, 'tokenizer.json'), '1');
      ok(isModelCached(dir, 'Org/Model') === false, 'a PARTIAL flat cache (weights, no config) is NOT cached → re-fetch');
      fs.writeFileSync(path.join(md, 'config.json'), '1');
      fs.writeFileSync(path.join(md, 'tokenizer_config.json'), '1');
      ok(isModelCached(dir, 'Org/Model') === true, 'a COMPLETE flat cache is detected');
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-mc2-'));
      fs.mkdirSync(path.join(dir2, 'models--Org--Model'), { recursive: true });
      fs.writeFileSync(path.join(dir2, 'models--Org--Model', 'x'), '1');
      ok(isModelCached(dir2, 'Org/Model') === true, 'hub models--org--model layout is detected (lenient non-empty)');
      fs.rmSync(dir2, { recursive: true, force: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // Single source for the model cache ROOT (DATA_DIR/models). The reranker worker, the voice STT/TTS loaders,
  // and the integrity watchdog must all resolve it through modelcache.modelsRoot — never re-literalize the
  // 'models' subdir — so the directory name cannot drift across them. Guards against re-introducing a copy.
  {
    const { modelsRoot, modelFilesComplete, modelFilesCompleteAsync } = require(path.join(PROJECT, 'lib', 'retrieval', 'modelcache'));
    ok(typeof modelsRoot === 'function' && modelsRoot('/data').endsWith(path.join('/data', 'models')),
      'modelcache.modelsRoot is the single resolver for the cache root');
    ok(modelsRoot('') === '' && modelsRoot(null) === '', 'modelsRoot returns empty on bad input (no crash)');
    // No file under lib/ (outside tests) may re-literalize the DATA_DIR/models join — they must call modelsRoot.
    const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|[\\/]test$/.test(p)) walk(p, out); }
      else if (e.name.endsWith('.js') && !/[\\/]test[\\/]/.test(p)) out.push(p);
    } return out; };
    const offenders = walk(path.join(PROJECT, 'lib'), []).filter((p) =>
      p !== path.join(PROJECT, 'lib', 'retrieval', 'modelcache.js') &&
      /DATA_DIR\s*,\s*['"]models['"]/.test(fs.readFileSync(p, 'utf-8')));
    ok(offenders.length === 0, `no file re-literalizes DATA_DIR/models — all use modelcache.modelsRoot (offenders: ${offenders.map((p) => path.relative(PROJECT, p)).join(', ')})`);

    // The watchdog uses the async completeness twin so a hung mount can't block the event loop. It must agree
    // with the sync probe the loader uses (same constants, same rules), or the two surfaces would disagree.
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-mcasync-'));
    try {
      const md = path.join(dir, 'Org', 'Model');
      fs.mkdirSync(path.join(md, 'onnx'), { recursive: true });
      fs.writeFileSync(path.join(md, 'onnx', 'model.onnx'), '1');
      fs.writeFileSync(path.join(md, 'config.json'), '1');
      ok(modelFilesComplete(md) === false && (await modelFilesCompleteAsync(md)) === false,
        'async completeness agrees with sync: a partial cache (no tokenizer_config) is incomplete on both');
      fs.writeFileSync(path.join(md, 'tokenizer_config.json'), '1');
      ok(modelFilesComplete(md) === true && (await modelFilesCompleteAsync(md)) === true,
        'async completeness agrees with sync: a complete cache is complete on both');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log(`\nALL MODEL-LOADING-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ MODEL-LOADING-DRIFT UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
})();
