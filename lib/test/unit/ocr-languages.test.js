'use strict';
// Guards the built-in OCR language catalog and its wiring:
//   • every offered code has a label and a pinned SHA-256 for the public data pack;
//   • English is the permanent floor, the additional list is bounded, and unknown/duplicate/ISO inputs
//     normalize safely;
//   • the recognizer builds its worker from the selected set and drops an unavailable optional pack
//     without losing English;
//   • the API validates the list, the page renders the picker from the same catalog, and a language
//     change is stamped so existing scans are re-read.
// No network, no model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const catalog = require(path.join(ROOT, 'lib', 'ocr-languages'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.deepStrictEqual(a, b, msg); };

try {
  const { OCR_LANGUAGES, OCR_LANGDATA_SHA256, OCR_LANGDATA_URL, OCR_BASE_LANGUAGE, MAX_OCR_LANGUAGES, normalizeOcrLanguages } = catalog;
  const config = read('lib/config.js');
  const ocr = read('lib/ocr.js');
  const server = read('lib/server.js');
  const chatEjs = read('lib/views/chat.ejs');
  const chatJs = read('lib/public/js/chat.js');
  const delta = read('lib/indexing/delta.js');
  const init = read('lib/indexing/init.js');
  const docs = read('docs/README.md');

  // ── 1. Catalog integrity ──
  ok(OCR_BASE_LANGUAGE === 'eng', 'English is the base language');
  ok(OCR_LANGUAGES.length >= 20, `the catalog covers the major languages (${OCR_LANGUAGES.length})`);
  ok(OCR_LANGUAGES.some((l) => l.base && l.code === 'eng'), 'the catalog marks English as the base');
  const codes = OCR_LANGUAGES.map((l) => l.code);
  ok(new Set(codes).size === codes.length, 'no duplicate language codes');
  for (const l of OCR_LANGUAGES) {
    ok(typeof l.name === 'string' && l.name.trim().length > 0, `${l.code} has a label`);
    ok(/^[a-z]{2,8}(?:_[a-z]+)?$/.test(l.code), `${l.code} is a valid engine code`);
    ok(/^[0-9a-f]{64}$/.test(OCR_LANGDATA_SHA256[l.code] || ''), `${l.code} has a pinned SHA-256`);
    ok(OCR_LANGDATA_URL(l.code).includes(`/@tesseract.js-data/${l.code}/4.0.0/${l.code}.traineddata.gz`),
      `${l.code} uses the pinned data URL`);
  }
  ok(codes.includes('spa') && codes.includes('deu') && codes.includes('chi_sim') && codes.includes('jpn') && codes.includes('ara'),
    'the catalog covers Latin, CJK, and RTL scripts');
  ok(MAX_OCR_LANGUAGES === 4, 'the additional-language cap bounds per-worker memory');

  // ── 2. Normalization ──
  eq(normalizeOcrLanguages(['spa', 'eng', 'unknown', 'spa', 'deu']), ['spa', 'deu'], 'dedupes, drops English and unknown codes');
  eq(normalizeOcrLanguages('spa+fra,deu deu'), ['spa', 'fra', 'deu'], 'splits a +/,/space-separated string');
  eq(normalizeOcrLanguages(['es', 'de']), ['spa', 'deu'], 'accepts ISO 639-1 aliases and maps them to engine codes');
  eq(normalizeOcrLanguages(['spa', 'fra', 'deu', 'ita', 'por']), ['spa', 'fra', 'deu', 'ita'], 'caps the additional list');
  eq(normalizeOcrLanguages([]), [], 'an empty list is valid');
  eq(normalizeOcrLanguages(null), [], 'a missing value is empty, never a throw');
  eq(normalizeOcrLanguages([42, {}, 'spa']), ['spa'], 'non-string entries are dropped');

  // ── 3. Recognizer wiring ──
  ok(/require\('\.\/ocr-languages'\)/.test(ocr), 'the recognizer imports the catalog');
  ok(/OCR_LANGDATA_SHA256/.test(ocr) && /OCR_LANGDATA_URL\(code\)/.test(ocr),
    'the recognizer verifies and fetches from the catalog');
  ok(/const selectedLangs = \(\) =>/.test(ocr) && /normalizeOcrLanguages\(cfg\(\)\.OCR_LANGUAGES\)/.test(ocr),
    'the recognizer reads the selected additional languages from config');
  ok(/Tesseract\.createWorker\(_tessLangs,/.test(ocr), 'the worker is created with the selected language set');
  ok(!/createWorker\('eng'/.test(ocr), 'the worker is not hardcoded to English');
  ok(/const ensureLangs = async \(\) =>/.test(ocr) && /const available = wanted\.filter\(\(code, i\) => results\[i\]\)/.test(ocr),
    'unavailable optional packs are dropped');
  ok(/if \(!available\.includes\(OCR_BASE_LANGUAGE\)\)[\s\S]{0,160}?ocrDataUnavailable/.test(ocr),
    'losing English fails closed so OCR is skipped, not fetched from a CDN at recognition time');
  ok(/MAX_LANG_BYTES/.test(ocr) && /not a gzip file/.test(ocr), 'a pack is size- and magic-checked before use');
  ok(/writeFileAtomicAsync/.test(ocr), 'a pack is cached atomically');
  ok(/_langCooldown/.test(ocr) && /_langInflight/.test(ocr),
    'a failed pack is not retried every page, and concurrent ensures are deduped');

  // ── 4. Config, API, and index stamps ──
  ok(/const OCR_LANGUAGES\s*=\s*Object\.freeze\(normalizeOcrLanguages\(providerConfig\.ocrLanguages\)\)/.test(config),
    'config normalizes the stored language list');
  ok(/OCR_LANGUAGES/.test(config.slice(config.indexOf('module.exports'))), 'config exports the normalized list');
  ok(/if \(key === 'ocrLanguages'\) \{ existing\[key\] = normalizeOcrLanguages\(val\); continue; \}/.test(server),
    'the API validates and stores only catalog codes');
  ok(/ocrLanguages:\s*cfg\.OCR_LANGUAGES/.test(server) && /ocrLanguageOptions:\s*OCR_LANGUAGES/.test(server),
    'GET /api/config returns the saved list and the catalog');
  ok(/releaseTesseract\(\)/.test(server) && /normalizeOcrLanguages\(before\.ocrLanguages\)/.test(server),
    'a language change releases the cached pool when no index run is active');
  ok(/_ocrLanguages\s*=\s*\(cfg\.USE_OCR && cfg\.OCR_ENGINE === 'tesseract'\)/.test(delta),
    'the index manifest stamps the OCR language set');
  ok(/manifest\._ocrLanguages !== undefined/.test(init) && /OCR languages changed/.test(init),
    'a language change forces a re-read so existing scans are re-OCR’d');

  // ── 5. Settings UI and client ──
  ok(/id="cfg-ocr-languages"/.test(chatEjs) && /role="group" aria-labelledby="cfg-ocr-languages-label"/.test(chatEjs),
    'the Settings OCR section has a labelled language group');
  ok(/English is always read/.test(chatEjs), 'the UI says English is the floor');
  ok(/renderOcrLanguages\(cfg\.ocrLanguageOptions \|\| \[\], cfg\.ocrLanguages \|\| \[\]\)/.test(chatJs),
    'the client renders the picker from the server catalog and saved list');
  ok(/const OCR_LANGUAGE_MAX = \(SETTINGS_META\.limits && SETTINGS_META\.limits\.ocrLanguages\) \|\| 4/.test(chatJs),
    'the client reads the same cap from the schema projection');
  ok(/ocrLanguages:\s*selectedOcrLanguages\(\)/.test(chatJs), 'the client saves the selected additional languages');
  ok(/English only/.test(chatJs), 'the picker explains the English floor');

  // ── 6. Docs ──
  ok(/Also read these languages|additional OCR languages|English is always read/i.test(docs),
    'the docs describe the OCR language setting');
  ok(/downloads once|works offline|pinned checksum/i.test(docs), 'the docs explain the on-demand, offline packs');

  console.log(`\nALL OCR-LANGUAGE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ OCR-LANGUAGE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
