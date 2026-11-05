'use strict';
// End-to-end reindex test for multimodal figure/table QA (visual ingest).
//
// Proves the whole pipeline over a figure-heavy workspace, across BOTH visual-ingest paths:
//   • an image-only PDF whose fact lives only in a rendered table (page-render path), and
//   • a DOCX whose only content is an embedded table image (office-doc image path).
// Both are indexed through the real pipeline with OCR turned OFF — so the ONLY way each fact
// can enter the index is the visual-ingest pass — then each is asked through the same
// grounded/cited path the API uses, checking the answer carries the value and cites the file.
//
// It never touches the user's ./data: it works entirely in a throwaway temp workspace, the
// same way the retrieval-honesty eval (run.js) does.
//
// Gated, so it is safe to run anywhere and never blocks CI: it SKIPS (exit 0) when the
// provider isn't a reachable local Ollama, when no vision-capable model is installed, or when
// sharp is unavailable to render the fixture. It only asserts when it can actually exercise
// the feature.
//
// Config is by the copied workspace config plus explicit overrides — never environment
// variables. Run: `npm run eval:visual`.
// Exit code: 0 pass or skipped; 1 on a real failure; 2 on a harness/setup error.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..', '..');   // lib/test/eval → repo root
const FIXTURE_NAME = 'zephyr-sensor.pdf';
// The distinctive fact that exists ONLY inside the rendered table image.
const FACT = '4271';
const QUERY = 'What is the Zephyr sensor throughput?';
// A DOCX whose ONLY content is an embedded table image — exercises the office-doc image path
// (there is no page renderer for DOCX/PPTX, so visual ingest describes embedded images).
const DOCX_NAME = 'quarterly.docx';
const DOCX_FACT = '8834';
const DOCX_QUERY = 'What was Q3 revenue?';

// Capture the real console up front and route our own output through it, so the harness's
// own lines always print even while the pipeline is muted below.
const _log = console.log.bind(console), _info = console.info.bind(console), _warn = console.warn.bind(console);
const mute = () => { console.log = console.info = console.warn = () => {}; };
const unmute = () => { console.log = _log; console.info = _info; console.warn = _warn; };
const log = (...a) => _log(...a);
// Exit after a short delay so buffered stdout flushes to a pipe before the process ends
// (a bare process.exit() truncates the tail), and so lingering keep-alive sockets from the
// provider client can't hold the event loop open indefinitely.
const finish = (code) => { try { cleanup(); } catch {} setTimeout(() => process.exit(code), 120); };
const skip = (why) => { log(`\n\u{1f5bc}️  Visual-ingest eval SKIPPED — ${why}`); finish(0); };

// ── Base config (host / provider / models) read WITHOUT requiring lib/config, so the config
// module isn't bound to the real project path before we chdir into the temp workspace. ──
let baseCfg = {};
try { baseCfg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'config', 'config.json'), 'utf-8')); } catch { baseCfg = {}; }
const provider = baseCfg.provider || 'ollama';
const host = baseCfg.ollamaHost || 'http://localhost:11434';

// Known vision-capable model families, best-at-tables first. minicpm-v and qwen2.5vl read
// dense tables well; llava and moondream are weaker and may return nothing for a plain table.
const VISION_PREF = ['minicpm-v', 'qwen2.5vl', 'llama3.2-vision', 'granite', 'gemma3', 'llava', 'moondream'];
// Pick the most preferred family actually installed, rather than the first in Ollama's list.
const pickVision = (models) => {
  for (const p of VISION_PREF) { const m = models.find(n => String(n).toLowerCase().includes(p)); if (m) return m; }
  return null;
};

// Load sharp the same way the pipeline does (one libvips build), for fixture generation.
let sharp = null;
try { sharp = require(path.join(PROJECT, 'lib', 'ocr')).loadSharp(); } catch { sharp = null; }

// ── Fixture images: a bordered 2-column table drawn as an SVG (the borders matter — a
// borderless block reads as body text, which the visual-ingest prompt deliberately ignores).
// Used for both the image-only PDF and the DOCX embedded image. ──
function tableSvg(title, rows) {
  const W = 820, rowH = 64, x0 = 40, colW = [360, 360], y0 = 90, H = y0 + rows.length * rowH + 60;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white"/>`;
  s += `<text x="${x0}" y="55" font-size="30" font-family="sans-serif" font-weight="bold">${title}</text>`;
  let y = y0;
  rows.forEach((r, i) => {
    let x = x0;
    if (i === 0) s += `<rect x="${x0}" y="${y}" width="${colW[0] + colW[1]}" height="${rowH}" fill="#dddddd"/>`;
    r.forEach((cell, c) => {
      s += `<rect x="${x}" y="${y}" width="${colW[c]}" height="${rowH}" fill="none" stroke="black" stroke-width="2"/>`;
      s += `<text x="${x + 16}" y="${y + 42}" font-size="26" font-family="sans-serif"${i === 0 ? ' font-weight="bold"' : ''}>${cell}</text>`;
      x += colW[c];
    });
    y += rowH;
  });
  return s + '</svg>';
}
const PDF_ROWS  = [['Metric', 'Value'], ['Throughput', `${FACT} units/sec`], ['Latency', '12 ms'], ['Accuracy', '99.3 %'], ['Range', '80 meters']];
const DOCX_ROWS = [['Quarter', 'Revenue'], ['Q3', `$${DOCX_FACT}K`], ['Q2', '$7120K'], ['Q1', '$6050K']];

// Build a minimal DOCX (a ZIP) whose only meaningful content is one embedded PNG under
// word/media/ — so its indexed text can come only from describing that image.
async function makeDocx(png) {
  const zip = new (require(path.join(PROJECT, 'node_modules', 'jszip')))();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  zip.file('word/media/image1.png', png);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Assemble a one-page PDF that draws a single JPEG image full-page. Binary-safe (Buffers),
// with a correct xref table. No text operators, so the page has no extractable text layer.
function makeImagePdf(jpeg, w, h) {
  const parts = [], off = []; let pos = 0;
  const push = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'binary'); parts.push(b); pos += b.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const writeObj = (n, body) => { off[n] = pos; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  writeObj(1, '<</Type/Catalog/Pages 2 0 R>>');
  writeObj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  writeObj(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>`);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  off[4] = pos; push(`4 0 obj\n<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>\nstream\n`); push(jpeg); push('\nendstream\nendobj\n');
  off[5] = pos; push(`5 0 obj\n<</Length ${content.length}>>\nstream\n`); push(content); push('\nendstream\nendobj\n');
  const xrefPos = pos;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  push(xref); push(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`);
  return Buffer.concat(parts);
}

const drain = async (stream) => { let s = ''; if (stream) for await (const c of stream) s += c; return s; };

let tmp = null;
const cleanup = () => { if (tmp) { try { process.chdir(PROJECT); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } };

(async () => {
  log('\n\u{1f9ea} Lokyni visual-ingest (figure/table QA) end-to-end eval');

  if (provider !== 'ollama') skip(`provider is "${provider}" — this eval detects a vision model via local Ollama`);
  if (!sharp) skip('sharp is unavailable to render the fixture image');

  // Probe Ollama for a vision-capable model, without requiring lib/config/llm.
  let models = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${host}/api/tags`, { signal: ctrl.signal, ...(baseCfg.ollamaApiKey ? { headers: { Authorization: `Bearer ${baseCfg.ollamaApiKey}` } } : {}) });
    clearTimeout(t);
    if (r.ok) { const j = await r.json(); models = (j.models || []).map(m => m.name).filter(Boolean); }
  } catch (e) { skip(`could not reach Ollama at ${host} (${e.message})`); }
  if (!models.length) skip(`Ollama at ${host} has no models installed`);
  const visionModel = pickVision(models);
  if (!visionModel) skip('no vision-capable model installed (e.g. qwen2.5vl:7b, llava, moondream)');
  if (!baseCfg.embeddingsModel && provider === 'ollama' && !models.some(m => /embed/i.test(m))) {
    skip('no embeddings model available to build the index');
  }
  log(`   using vision model: ${visionModel}`);

  // ── Build the throwaway workspace: the fixture PDF + a config with OCR OFF and visual
  // ingest ON. OCR off is the crux — it removes the only other path by which the table's
  // text could enter the index, so a pass proves visual ingest did the work. ──
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-visual-'));
    const docsDir = path.join(tmp, 'data', 'workspaces', 'default', 'documents');
    fs.mkdirSync(docsDir, { recursive: true });
    // Image-only PDF (exercises the page-render path).
    const jpeg = await sharp(Buffer.from(tableSvg('Zephyr Sensor Performance', PDF_ROWS))).jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(jpeg).metadata();
    fs.writeFileSync(path.join(docsDir, FIXTURE_NAME), makeImagePdf(jpeg, meta.width, meta.height));
    // DOCX whose only content is an embedded table image (exercises the office-doc path).
    const docxPng = await sharp(Buffer.from(tableSvg('Quarterly Revenue', DOCX_ROWS))).png().toBuffer();
    fs.writeFileSync(path.join(docsDir, DOCX_NAME), await makeDocx(docxPng));

    const cfg = Object.assign({}, baseCfg, {
      provider: 'ollama',
      useOcr: false,           // isolate: the table's text can ONLY come from visual ingest
      useVisualIngest: true,
      visualIngestCropFigures: true,   // exercise the pixel-cropping path too
      visionModel,
      visualIngestMaxPages: 2,
      visualIngestMinImageEdge: 100,
      // Keep the run lean and deterministic on a one-document corpus.
      useSemanticCache: false, useRagFusion: false, useHyde: false, useAdaptiveRetrieval: false,
    });
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'config.json'), JSON.stringify(cfg, null, 2));
    process.chdir(tmp);   // './config/config.json' and './data' now resolve inside tmp
  } catch (e) {
    log(`❌ setup error: ${e.message}`); return finish(2);
  }

  // Require the pipeline only AFTER chdir, so lib/config binds to the temp workspace.
  const { initIndex } = require(path.join(PROJECT, 'lib', 'indexing', 'init'));
  const { runGroundedChat } = require(path.join(PROJECT, 'lib', 'api-core'));
  const state = require(path.join(PROJECT, 'lib', 'state'));

  log('   indexing the figure-heavy workspace (rendering + vision, this can take a few seconds)…');
  mute();
  try { await initIndex({}); } catch (e) { unmute(); log(`❌ index build threw: ${e.message}`); return finish(2); }
  unmute();

  if (!state.indexReady || state.parentMap.size === 0) {
    log(`❌ index did not build (ready=${state.indexReady}, docs=${state.parentMap.size}) — is the embeddings model available?`);
    return finish(2);
  }

  const store = require(path.join(PROJECT, 'lib', 'indexing', 'figurestore'));
  const cacheDir = require(path.join(PROJECT, 'lib', 'config')).CACHE_DIR;
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); log(`   ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
  const entryOf = (name) => [...state.parentMap.values()].find(x => path.basename(x.metadata.source) === name) || null;
  const contentOf = (name) => { const e = entryOf(name); return e ? (e.content || '') : null; };
  const figuresOf = (name) => { const e = entryOf(name); return (e && Array.isArray(e.metadata.figures)) ? e.metadata.figures : []; };

  // Ask one grounded question through the same path the API uses. Holds the event loop open
  // across the call: this is a headless script with no server keeping libuv handles alive, so
  // during an await gap in the async chain Node would otherwise decide the loop is empty and
  // exit before the answer streams back.
  const askSingle = async (query) => {
    const keepalive = setInterval(() => {}, 1000);
    mute();
    let answer = '', sources = [], rawSources = [], status = 'ok';
    try {
      const r = await runGroundedChat('default', [{ role: 'user', content: query }]);
      status = r.status;
      rawSources = r.sources || [];
      sources = rawSources.map(s => s.source);
      answer = await drain(r.stream);
    } catch (e) { status = 'error:' + e.message; }
    finally { clearInterval(keepalive); }
    unmute();
    return { answer, sources, rawSources, status };
  };

  // ── PDF page-render path ──
  const pdfContent = contentOf(FIXTURE_NAME);
  check('PDF fixture indexed (not dropped as empty)', pdfContent !== null, pdfContent === null ? 'not found in the index' : '');
  check('PDF visual-ingest block present', /Figures, charts, and tables/i.test(pdfContent || ''));
  check(`PDF table value "${FACT}" is in the indexed content (from the image only)`, (pdfContent || '').includes(FACT));
  const pdfAns = await askSingle(QUERY);
  check('PDF question answered with the table value', pdfAns.answer.includes(FACT), `status=${pdfAns.status}, answer="${pdfAns.answer.slice(0, 100).replace(/\s+/g, ' ')}"`);
  check('PDF answer cites the fixture', pdfAns.sources.includes(FIXTURE_NAME), `sources: ${pdfAns.sources.join(', ') || 'none'}`);
  // Pixel cropping: the figure was detected, cropped, and the thumbnail persisted on disk.
  const pdfFigs = figuresOf(FIXTURE_NAME);
  check('PDF figure cropped (manifest recorded)', pdfFigs.length > 0, `${pdfFigs.length} figure(s)`);
  check('PDF crop thumbnail exists on disk', pdfFigs.length > 0 && pdfFigs.every(f => store.hasCrop(cacheDir, f.id)));
  const pdfSrcFigs = (pdfAns.rawSources.find(s => s.source === FIXTURE_NAME) || {}).figures || [];
  check('PDF cited source carries a figure URL', pdfSrcFigs.some(f => /^\/api\/figure\//.test(f.url || '')), `${pdfSrcFigs.length} on the source`);

  // ── DOCX embedded-image path (no page renderer; the image is described) ──
  const docxContent = contentOf(DOCX_NAME);
  check('DOCX fixture indexed (not dropped as empty)', docxContent !== null, docxContent === null ? 'not found in the index' : '');
  check('DOCX image-description block present', /Images embedded in this document/i.test(docxContent || ''));
  check(`DOCX value "${DOCX_FACT}" is in the indexed content (from the embedded image only)`, (docxContent || '').includes(DOCX_FACT));
  const docxAns = await askSingle(DOCX_QUERY);
  check('DOCX question answered with the image value', docxAns.answer.includes(DOCX_FACT), `status=${docxAns.status}, answer="${docxAns.answer.slice(0, 100).replace(/\s+/g, ' ')}"`);
  check('DOCX answer cites the fixture', docxAns.sources.includes(DOCX_NAME), `sources: ${docxAns.sources.join(', ') || 'none'}`);
  // Pixel cropping for the office path: the embedded image is stored as a thumbnail.
  const docxFigs = figuresOf(DOCX_NAME);
  check('DOCX image cropped (manifest recorded)', docxFigs.length > 0, `${docxFigs.length} image(s)`);
  check('DOCX crop thumbnail exists on disk', docxFigs.length > 0 && docxFigs.every(f => store.hasCrop(cacheDir, f.id)));

  const failed = results.filter(r => !r.ok);
  if (failed.length) log(`\n❌ visual-ingest eval FAILED (${failed.length}/${results.length} checks)\n`);
  else log(`\n✅ visual-ingest eval PASSED (${results.length}/${results.length} checks)\n`);
  finish(failed.length ? 1 : 0);
})().catch((e) => { log(`❌ unexpected error: ${e && e.message}`); finish(2); });
