'use strict';
// Unit tests for the visual-ingest (figure/table QA) pure pieces. No model call, no PDF
// render, no vector store.
//   - visualdocs.buildBlock: turns per-page descriptions into one labeled, indexable block,
//     dropping empty pages and returning '' when nothing was described.
//   - visualdocs.describePdfVisuals: is a safe no-op ('') when the feature is off or the
//     input is unusable, without touching the renderer or the vision model.
//   - vision.describePageVisuals is exported (the ingest pass depends on it).
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const visualdocs = require(path.join(PROJECT, 'lib', 'indexing', 'visualdocs'));
const vision = require(path.join(PROJECT, 'lib', 'vision'));
let sharp = null; try { sharp = require(path.join(PROJECT, 'lib', 'ocr')).loadSharp(); } catch { sharp = null; }

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── buildBlock formats and filters ──
    eq(visualdocs.buildBlock([]), '', 'no pages -> empty block');
    eq(visualdocs.buildBlock([{ page: 2, text: '' }, { page: 3, text: null }]), '', 'only empty pages -> empty block');
    const block = visualdocs.buildBlock([
      { page: 1, text: 'A bar chart of quarterly revenue; Q3 is highest.' },
      { page: 2, text: '' },                                   // dropped
      { page: 4, text: '| Metric | Value |\n| --- | --- |' },
    ]);
    ok(block.startsWith('Figures, charts, and tables'), 'block has a recognizable header');
    ok(block.includes('[Page 1]') && block.includes('[Page 4]'), 'each described page is labeled');
    ok(!block.includes('[Page 2]'), 'an empty page is not labeled');
    ok(block.includes('| Metric | Value |'), 'a reproduced Markdown table is preserved');
    console.log('✓ visualdocs: buildBlock labels described pages, drops empty ones');

    // ── describePdfVisuals is a safe no-op when off / on bad input (no render, no model) ──
    // The feature defaults off, so this must return { text:'', figures:[] } without throwing.
    const off = await visualdocs.describePdfVisuals(Buffer.from('%PDF-1.4 fake'), 'x.pdf');
    eq(off.text, '', 'disabled feature -> empty text');
    ok(Array.isArray(off.figures) && off.figures.length === 0, 'disabled feature -> no figures');
    eq((await visualdocs.describePdfVisuals(null, 'x.pdf')).text, '', 'non-buffer input -> empty text');
    eq((await visualdocs.describePdfVisuals(Buffer.alloc(0), 'x.pdf')).text, '', 'empty buffer -> empty text');
    console.log('✓ visualdocs: describePdfVisuals is a safe no-op when disabled or given bad input');

    // ── the vision entry point the pass depends on is exported ──
    eq(typeof vision.describePageVisuals, 'function', 'vision.describePageVisuals is exported');
    console.log('✓ visualdocs: the vision page-describe entry point is wired');

    // ── normalizeBbox: rescaling and clamping (no model needed) ──
    const nb = vision.normalizeBbox;
    eq(nb(null), null, 'null bbox -> null');
    eq(nb([0, 0, 1]), null, 'wrong-length bbox -> null');
    assert.deepStrictEqual(nb([0, 0, 1, 0.5]), [0, 0, 1, 0.5]); checks++;                 // already 0..1
    assert.deepStrictEqual(nb([0, 0, 100, 50]), [0, 0, 1, 0.5]); checks++;                // 0..100 rescaled
    assert.deepStrictEqual(nb([0, 0, 1000, 500]), [0, 0, 1, 0.5]); checks++;              // 0..1000 rescaled
    { const b = nb([0.5, 0.5, 0.9, 0.9]); ok(b && b[0] + b[2] <= 1.0001 && b[1] + b[3] <= 1.0001, 'x+w and y+h clamped to <=1'); }
    eq(nb([0, 0, 0.01, 0.01]), null, 'degenerate tiny bbox -> null');
    console.log('✓ visualdocs: normalizeBbox rescales 0-100/0-1000 and clamps to bounds');

    // ── cropRegion: an edge-touching full-width bbox still yields a crop (guards the drop fix) ──
    if (sharp) {
      const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
      const full = await visualdocs.cropRegion(png, [0, 0, 1, 0.5]);   // touches the right/left edge
      ok(Buffer.isBuffer(full) && full.length > 0, 'a full-width (edge-touching) bbox is cropped, not dropped');
      eq(await visualdocs.cropRegion(png, [0, 0, 0.02, 0.02]), null, 'a sub-24px region returns null');
      console.log('✓ visualdocs: cropRegion clamps edge-touching boxes and rejects tiny ones');
    } else {
      console.log('… visualdocs: cropRegion test skipped (sharp unavailable)');
    }

    // ── source guards: a flaky FIGURES pass must not abandon a healthy TEXT pass; vision calls are abortable ──
    const vdSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'visualdocs.js'), 'utf-8');
    // The text pass resets the failure streak BEFORE the crop/figures block, and the figures block has its own
    // try/catch — so a figures/crop blip can't trip the "two text failures in a row → stop the document" guard.
    const textToCrop = vdSrc.slice(vdSrc.indexOf('describePageVisuals'), vdSrc.indexOf('describePageFigures'));
    ok(/consecutiveFailures = 0;/.test(textToCrop), 'the failure streak resets after the TEXT pass, before the figures pass');
    ok(/if \(crop\) \{\s*try \{/.test(vdSrc), 'the figures/crop pass is wrapped in its own try/catch (its failure never aborts the text extraction)');

    const visionSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'vision.js'), 'utf-8');
    // A vision call must CANCEL the request on timeout, not merely stop waiting — OpenAI via { signal }, Ollama via
    // a throwaway per-call client's abort() — so a stalled endpoint leaves no zombie request on the shared client.
    ok(/new AbortController\(\)/.test(visionSrc) && /\{ signal: ac\.signal \}/.test(visionSrc), 'the OpenAI vision call passes an abort signal');
    ok(/llm\.makeOllamaClient\(c\)/.test(visionSrc) && /ollamaClient\.abort\(\)/.test(visionSrc), 'the Ollama vision call uses a per-call client and aborts it on timeout');

    // ── vision-describe cache invalidation: a describe model/param change must re-describe unchanged images ──
    // describeSignature is the SINGLE source folding every setting that changes describeImage's output; delta.js
    // stamps it into the manifest and init.js rebuilds on a mismatch (the rebuild wipes the OCR cache that doubles
    // as the describe-output store). Without this, a VISION_MODEL change served the old model's text forever.
    const sig = (o) => vision.describeSignature(o);
    ok(sig({ VISION_DESCRIBE: false }) === null, 'describeSignature is null when describe is off (on↔off handled by _visionEnabled)');
    const vbase = { VISION_DESCRIBE: true, VISION_MODEL: 'm1', VISION_TEMPERATURE: 0.2, VISION_MAX_TAGS: 12, VISION_INPUT_MAX_EDGE: 1024 };
    ok(typeof sig(vbase) === 'string' && sig(vbase).length > 0 && sig(vbase) === sig({ ...vbase }), 'describeSignature is a stable string when on');
    ok(sig(vbase) !== sig({ ...vbase, VISION_MODEL: 'm2' }), 'a describe MODEL change changes the signature');
    ok(sig(vbase) !== sig({ ...vbase, VISION_TEMPERATURE: 0.7 }), 'a temperature change changes the signature');
    ok(sig(vbase) !== sig({ ...vbase, VISION_MAX_TAGS: 20 }) && sig(vbase) !== sig({ ...vbase, VISION_INPUT_MAX_EDGE: 768 }), 'a max-tags or max-edge change changes the signature');
    // Wiring: the stamp and the check both go through the one helper (no drift), and the rebuild reason exists.
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    const initSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
    ok(/_visionDescribeSig = require\('\.\.\/vision'\)\.describeSignature\(cfg\)/.test(deltaSrc), 'delta.js stamps the describe signature into the manifest');
    ok(/manifest\._visionDescribeSig !== undefined[\s\S]*?describeSignature\(cfg\)/.test(initSrc) && /Vision describe settings changed/.test(initSrc), 'init.js rebuilds when the stored describe signature no longer matches the config');

    console.log(`\nALL VISUALDOCS UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ VISUALDOCS UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
