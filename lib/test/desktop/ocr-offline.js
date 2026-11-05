'use strict';
// Verify first-run OCR works OFFLINE from the bundled language pack the desktop installer ships.
// `verify:dmg` only asserts the pack FILE is present in the .app; this proves the shipped code can
// actually turn that file into OCR output with no network — the real risk the bundling closes.
//
// It drives the STAGED desktop bundle (src-tauri/app, produced by `npm run tauri:prepare` /
// `tauri:build`), the exact file set the installer packages, exactly as the shell launches it:
//   --data-dir <fresh temp>            a first-run install with an empty, writable data dir
//   --bundled-tessdata-dir app/tessdata the read-only pack the installer bundles
// Network is severed (global.fetch throws and counts calls) so any CDN reach-out fails the test
// rather than hiding behind a silent online fallback.
//
// Gates (hard): the language data is seeded from the bundle and verified with ZERO fetches; the
// English floor is available; a real tesseract worker initializes offline (its WASM core is bundled,
// not fetched); and an end-to-end recognize of a generated image runs offline, touches the network
// zero times, and emits glyph output. Whether tesseract reads the synthetic bitmap-font word exactly
// is reported but NOT gated — that is tesseract's own accuracy, tested upstream, and asserting it here
// would make an offline-capability check flaky. Workers are always terminated, so the test never
// orphans a recognition thread.
//
// Run after `npm run tauri:prepare` (or a full `tauri:build`):
//   node lib/test/desktop/ocr-offline.js
// Skips cleanly if the staged bundle or its pack is absent (e.g. CI leg that did not stage it).

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STAGED_APP = path.join(ROOT, 'src-tauri', 'app');
const STAGED_TESSDATA = path.join(STAGED_APP, 'tessdata');

let checks = 0;
const ok = (c, m) => { checks++; if (!c) throw new Error(m); };

// ── A self-contained PNG of the word "OFFLINE" (no image libraries) ──────────────────────────────
// A 5x7 bitmap font for just the letters we draw, scaled into solid blocks: black ink on white,
// large enough that the pre-processing step keeps it (a too-small image is dropped before recognition).
const FONT = {
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
};
const WORD = 'OFFLINE';

function renderWordPng(word, scale = 28, pad = 64) {
  const gw = 5, gh = 7, gap = 2;                       // glyph grid + inter-letter gap (cells)
  const cols = word.length * gw + (word.length - 1) * gap;
  const W = cols * scale + pad * 2;
  const H = gh * scale + pad * 2;
  const row = W + 1;                                   // +1 filter byte per scanline
  const raw = Buffer.alloc(row * H, 0xff);             // white background
  for (let y = 0; y < H; y++) raw[y * row] = 0;        // filter byte 0 (None) at each scanline start
  const setPx = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) raw[y * row + 1 + x] = 0x00; };
  let penX = pad;
  for (const ch of word) {
    const glyph = FONT[ch];
    ok(glyph, `the test font is missing a glyph for "${ch}"`);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        if (glyph[gy][gx] === '1') {
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
            setPx(penX + gx * scale + sx, pad + gy * scale + sy);
          }
        }
      }
    }
    penX += (gw + gap) * scale;
  }
  // Assemble a grayscale 8-bit PNG.
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;            // deflate / no filter / no interlace
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Minimal CRC-32 (PNG chunk checksum).
let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff);
}

async function main() {
  if (!fs.existsSync(STAGED_APP) || !fs.existsSync(path.join(STAGED_TESSDATA, 'eng.traineddata.gz'))) {
    console.log('Offline-OCR check skipped: no staged bundle at src-tauri/app/tessdata. Run `npm run tauri:prepare` first.');
    return 0;
  }

  // Launch the STAGED code exactly as the desktop shell does: fresh writable data dir + read-only bundled pack.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-ocr-offline-'));
  process.argv = [process.argv[0], process.argv[1], '--data-dir', dataDir, '--bundled-tessdata-dir', STAGED_TESSDATA];

  // Sever the network: any fetch is an offline-correctness failure. Count calls so we can assert zero.
  let fetchCalls = 0;
  global.fetch = async (...a) => { fetchCalls++; throw new Error(`network used in offline OCR test: ${a[0]}`); };

  const ocr = require(path.join(STAGED_APP, 'lib', 'ocr'));
  const { OCR_LANGDATA_SHA256, OCR_BASE_LANGUAGE } = require(path.join(STAGED_APP, 'lib', 'ocr-languages'));

  try {
    // ── Gate 1: language data is seeded from the bundle and verified, with no network ──
    const { dir, codes } = await ocr.ensureLangs();
    ok(codes.includes(OCR_BASE_LANGUAGE), `the English floor pack was not made available offline (got: ${codes.join(', ') || 'none'})`);
    ok(fetchCalls === 0, `OCR language setup reached the network ${fetchCalls} time(s); it must be fully offline from the bundle`);
    const seeded = path.join(dir, OCR_BASE_LANGUAGE + '.traineddata.gz');
    ok(fs.existsSync(seeded), 'the bundled pack was not seeded into the first-run data directory');
    const seededSha = crypto.createHash('sha256').update(fs.readFileSync(seeded)).digest('hex');
    ok(seededSha === OCR_LANGDATA_SHA256[OCR_BASE_LANGUAGE], 'the seeded pack failed its pinned checksum');
    ok(dir !== STAGED_TESSDATA, 'the writable language dir must be the data dir, not the read-only bundle');
    ok(fs.existsSync(path.join(STAGED_TESSDATA, OCR_BASE_LANGUAGE + '.traineddata.gz')), 'seeding must copy, not move, the bundled pack');

    // ── Gate 2 + 3: a real worker initializes offline and recognition runs offline on a generated image ──
    const png = renderWordPng(WORD);
    const text = await ocr.ocrImage(png, 'offline-test.png');
    ok(fetchCalls === 0, `OCR recognition reached the network ${fetchCalls} time(s); the engine core must be bundled, not fetched`);
    const norm = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
    // Hard gate: the engine actually processed the image offline and emitted glyphs (not a silent empty return).
    ok(norm.length > 0, 'offline OCR produced no output at all — the engine did not run');
    // Informational only (not a gate): did it read the exact synthetic word? That is tesseract's accuracy.
    const exact = norm.includes(WORD);

    console.log(`Offline OCR: seeded ${OCR_BASE_LANGUAGE} from bundle (verified, 0 fetches); worker initialized and recognized offline.`);
    console.log(`  Engine output offline: "${String(text).trim().replace(/\s+/g, ' ')}" ${exact ? '(read the test word exactly)' : '(ran offline; exact read is tesseract accuracy, not gated)'}`);
    console.log(`\nOFFLINE OCR CHECK PASSED (${checks} checks)`);
    return 0;
  } catch (e) {
    console.error(`\nOFFLINE OCR CHECK FAILED: ${e && e.message ? e.message : e}`);
    return 1;
  } finally {
    // Never orphan a recognition worker/thread.
    try { await ocr.releaseTesseract(); } catch { /* best-effort */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`\nOFFLINE OCR CHECK ERRORED: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
