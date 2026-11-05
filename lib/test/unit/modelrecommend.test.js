'use strict';
// Unit tests for hardware-aware model suggestions (lib/modelrecommend.js): the fit/rank
// logic on synthetic systems, and that detectSystem returns a sane shape on this host.
// Pure — no network, no Ollama. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { detectSystem, recommend } = require(path.join(PROJECT, 'lib', 'modelrecommend'));

const sys = (usableGB, extra = {}) => ({
  platform: 'linux', arch: 'x64', cpuCount: 8, totalRamGB: usableGB + 4,
  appleSilicon: false, gpu: null, mode: 'cpu', usableGB, label: `${usableGB} GB usable`, ...extra,
});

try {
  // ── Roomy machine: everything fits; the most capable is recommended ──
  {
    const r = recommend(sys(48));
    assert.ok(r.chat.every(m => m.fits), 'all chat models fit a large budget');
    const rec = r.chat.find(m => m.recommended);
    assert.ok(rec, 'a chat model is recommended');
    assert.strictEqual(rec.paramsB, Math.max(...r.chat.map(m => m.paramsB)), 'recommended is the most capable that fits');
    assert.strictEqual(r.embeddings.find(m => m.recommended).name, 'bge-m3', 'roomy machine recommends the portable multilingual default');
  }
  console.log('✓ modelrecommend: roomy machine recommends the most capable fitting model');

  // ── Very tight machine (below the smallest model): nothing fits, so the smallest is
  //    still recommended, the lightest embedder is picked, and a tight-memory note fires ──
  {
    const r = recommend(sys(1));   // 1 GB usable — under the smallest chat model
    assert.ok(r.chat.every(m => !m.fits), 'nothing fits a 1 GB budget');
    const rec = r.chat.find(m => m.recommended);
    assert.strictEqual(rec.paramsB, Math.min(...r.chat.map(m => m.paramsB)), 'recommended is the smallest when nothing fits');
    assert.strictEqual(r.embeddings.find(m => m.recommended).name, 'all-minilm', 'very tight memory → lightest embedder');
    assert.ok(r.notes.some(n => /tight|smallest|hosted/i.test(n)), 'a tight-memory note is surfaced');
  }
  console.log('✓ modelrecommend: very tight machine still recommends the smallest + lightest');

  // ── Moderate machine: some models fit, the largest fitting is recommended ──
  {
    const r = recommend(sys(4));   // fits llama3.2:1b (1.5) + 3b (3), not qwen 7b (5)
    const fits = r.chat.filter(m => m.fits);
    assert.ok(fits.length >= 1 && fits.length < r.chat.length, 'some fit, some do not');
    const rec = r.chat.find(m => m.recommended);
    assert.ok(rec.fits && rec.ramGB <= 4, 'recommended fits the 4 GB budget');
    assert.strictEqual(rec.ramGB, Math.max(...fits.map(m => m.ramGB)), 'largest fitting model is recommended');
    assert.strictEqual(r.embeddings.find(m => m.recommended).name, 'nomic-embed-text', 'default embedder when memory allows');
  }
  console.log('✓ modelrecommend: moderate machine picks the largest fitting model');

  // ── detectSystem shape on this host (async: it may probe the GPU off the event loop) ──
  detectSystem().then((s) => {
    assert.ok(typeof s.totalRamGB === 'number' && s.totalRamGB > 0, 'detects RAM');
    assert.ok(['gpu', 'apple', 'cpu'].includes(s.mode), 'a known memory mode');
    assert.ok(typeof s.label === 'string' && s.label.length > 0, 'has a human label');
    assert.ok(typeof s.usableGB === 'number' && s.usableGB > 0, 'positive usable budget');
    console.log('✓ modelrecommend: detectSystem returns a sane shape');
    console.log('\nALL MODELRECOMMEND UNIT TESTS PASSED');
    process.exit(0);
  }).catch((e) => {
    console.error('\n✗ MODELRECOMMEND UNIT TEST FAILED:', e.message);
    process.exit(1);
  });
} catch (e) {
  console.error('\n✗ MODELRECOMMEND UNIT TEST FAILED:', e.message);
  process.exit(1);
}
