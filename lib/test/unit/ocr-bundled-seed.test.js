'use strict';
// Unit test for seedBundledLangs (lib/ocr.js) — the step that lets a packaged desktop app read scanned pages
// OFFLINE on first run by copying the bundled OCR language pack(s) into the writable tessdata directory instead of
// fetching them. It must: copy a bundled pack into an empty managed dir; never overwrite a pack already present (a
// prior download or a newer cached copy wins); do nothing when there is no bundled dir (the standalone/container
// modes, which fetch on demand); leave no temp file behind; and be language-agnostic (it copies whatever pinned
// packs the bundle ships, not a hard-coded 'eng'). Offline, synthetic, no model or network. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ocr = require(path.join(PROJECT, 'lib', 'ocr'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-seed-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  try {
    // A fake bundle directory holding two pinned packs (English floor + one more), so the language-agnostic copy
    // is exercised, not just a hard-coded English path. Contents are placeholders — the seed only copies; the
    // separate SHA-256 verify in ensureLang (covered by the engine's own path) is what trusts them later.
    const bundle = path.join(tmp, 'bundle', 'tessdata');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'eng.traineddata.gz'), 'ENG-PACK-BYTES');
    fs.writeFileSync(path.join(bundle, 'spa.traineddata.gz'), 'SPA-PACK-BYTES');

    // ── Seeds every bundled pinned pack into an empty managed dir ──
    {
      const dir = path.join(tmp, 'data1', 'tessdata');
      fs.mkdirSync(dir, { recursive: true });
      await ocr.seedBundledLangs(dir, bundle);
      ok(fs.readFileSync(path.join(dir, 'eng.traineddata.gz'), 'utf8') === 'ENG-PACK-BYTES', 'the English floor pack is seeded from the bundle');
      ok(fs.readFileSync(path.join(dir, 'spa.traineddata.gz'), 'utf8') === 'SPA-PACK-BYTES', 'a second bundled pack is seeded too (language-agnostic)');
      ok(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')), 'no temp file is left behind (atomic copy)');
    }

    // ── Never overwrites a pack already present (a prior download / newer cached copy wins) ──
    {
      const dir = path.join(tmp, 'data2', 'tessdata');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'eng.traineddata.gz'), 'ALREADY-HERE');
      await ocr.seedBundledLangs(dir, bundle);
      ok(fs.readFileSync(path.join(dir, 'eng.traineddata.gz'), 'utf8') === 'ALREADY-HERE', 'an existing pack is never overwritten by the bundled copy');
      ok(fs.readFileSync(path.join(dir, 'spa.traineddata.gz'), 'utf8') === 'SPA-PACK-BYTES', 'a missing pack is still seeded alongside an existing one');
    }

    // ── No bundled dir → no-op (standalone / container modes fetch on demand instead) ──
    {
      const dir = path.join(tmp, 'data3', 'tessdata');
      fs.mkdirSync(dir, { recursive: true });
      await ocr.seedBundledLangs(dir, null);
      ok(fs.readdirSync(dir).length === 0, 'with no bundled directory the seed does nothing (fetch-once path is used)');
    }

    // ── A bundled dir that lacks a given pack is not an error (that language just falls back to fetch) ──
    {
      const emptyBundle = path.join(tmp, 'emptybundle');
      fs.mkdirSync(emptyBundle, { recursive: true });
      const dir = path.join(tmp, 'data4', 'tessdata');
      fs.mkdirSync(dir, { recursive: true });
      await ocr.seedBundledLangs(dir, emptyBundle);   // must not throw
      ok(fs.readdirSync(dir).length === 0, 'a bundle missing the packs seeds nothing and does not throw');
    }

    console.log(`\nALL OCR-BUNDLED-SEED TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ OCR-BUNDLED-SEED TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
