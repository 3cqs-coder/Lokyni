'use strict';
// OCR for documents with no extractable text.
//
// A scanned PDF or a photographed page has no text layer, so `getText()` returns
// nothing and the document indexes as empty — searchable by nobody, and until now
// silently absent from the corpus. This module renders such pages to images and
// recognizes the text on them.
//
// Two recognizers, chosen by config:
//
//   'vision'    — a vision model through the configured provider (Ollama by
//                 default). Handles messy real-world scans, tables and multi-column
//                 layouts far better, and emits usable structure. Slower, and needs
//                 a model pulled.
//   'tesseract' — tesseract.js, pure WASM, no model download, fast on clean scans.
//                 Weak on skewed, low-contrast or complex pages, which is why the
//                 preprocessing below matters so much for it.
//
// Rendering is shared by both, so the recognizer is genuinely swappable.
//
// The preprocessing constants come from a working OCR pipeline rather than being
// guessed: render well above screen resolution then downsample, cap the width, and
// never hand a recognizer one very tall image — accuracy degrades and memory spikes.
const path = require('path');

// Render pages meaningfully above screen DPI; recognition accuracy tracks effective
// resolution closely, and downsampling afterwards is cheap.
const RENDER_SCALE = 2.5;
// Cap the width fed to the recognizer. Wider gains little and costs memory.
const MAX_WIDTH = 1600;
// Upscale images narrower than this so text is tall enough for Tesseract to read
// (it wants characters ~30px tall; small/low-DPI images fall well short). Enlarging
// adds no detail but gives the recognizer something it can segment.
const TARGET_WIDTH = 1500;
// Don't blow a tiny thumbnail up beyond this factor — past a point it's just blur.
const MAX_UPSCALE = 4;
// Slice tall images. A full page at 2.5x can be several thousand pixels tall, which
// is where Tesseract's accuracy falls apart.
const MAX_SLICE_HEIGHT = 1400;
// Below this, an image region can't hold readable text. Tesseract warns loudly about
// such slivers ("Image too small to scale"), so they're dropped before it sees them.
const MIN_RECOGNIZABLE = 40;

// A page with fewer than this many characters of extractable text is treated as a
// scan. Not zero: scanned PDFs often carry a stray header or page number in a real
// text layer, which would otherwise mask the fact that the body is an image.
const SCANNED_TEXT_THRESHOLD = 120;

const cfg = () => require('./config');

// Warn once rather than per page.
let _warnedNoSharp = false;
let _sharp = null;

// Resolve sharp, using the single copy the transformers dependency brings in.
//
// sharp links libvips natively, and loading two different libvips builds into one
// process produces "Class ... is implemented in both ..." warnings from the dynamic
// linker and, per its own message, risks spurious casting failures and crashes.
// @huggingface/transformers depends on sharp, which npm hoists to the top-level
// node_modules, so requiring 'sharp' resolves to that same one instance — declaring a
// second sharp in package.json would install a second libvips and cause exactly that
// clash, which is why we don't. Every operation used here (resize, grayscale,
// normalize, extract) has existed for many major versions.
const loadSharp = () => {
  if (_sharp !== null) return _sharp || null;
  try { _sharp = require('sharp'); return _sharp; } catch { /* unavailable — degrade below */ }
  _sharp = false;
  if (!_warnedNoSharp) {
    _warnedNoSharp = true;
    console.warn('⚠️  sharp is unavailable — OCR will run on unprocessed images, which reads noticeably worse.');
  }
  return null;
};

// ── Detection ───────────────────────────────────────────────────────────────
// Is this PDF effectively a scan? Judged per page rather than per document so a
// mixed PDF (a typed report with scanned exhibits appended) is handled correctly.
const looksScanned = (text, pageCount = 1) => {
  const chars = (text || '').replace(/\s+/g, '').length;
  return chars < SCANNED_TEXT_THRESHOLD * Math.max(1, pageCount);
};

// ── Rendering ───────────────────────────────────────────────────────────────
// Render PDF pages to PNG buffers. pdf-parse v2 can do this itself, so no canvas
// or rasterizer dependency is needed.
// Render PDF pages to PNG buffers, capped at `maxPages` from the START of the
// document. Both `first` and `last` must be given: pdf-parse treats `last` alone as
// "the last N pages", so passing it by itself would render the END of a long scan —
// pages 161-200 of a 200-page document rather than 1-40.
//
// Returns the page count as well as the images, so the caller can tell the user when
// a document was truncated instead of silently indexing part of it.
// Bound the untrusted PDF render with a wall-clock timeout. On the opt-in visual-ingest path this runs on
// the main process (the vision model client lives there), so a crafted PDF that makes the renderer spin
// must not hang it indefinitely; a timeout turns that into a clean skip. The renderer is promise-based
// (pdfjs I/O yields), so the timer fires. It also protects the OCR render path (which may run inline).
const RENDER_TIMEOUT_MS = 60000;
const withRenderTimeout = (p, label) => {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), RENDER_TIMEOUT_MS); if (t.unref) t.unref(); });
  // Clear the timer when the work settles first, so a long OCR run doesn't leave one dormant timer per
  // render call pending for the full timeout.
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

// Open a PDF once and read its page count, so pages can be rendered in bounded slices from the SAME
// parser without re-parsing the whole file per slice. Rendering every page up front held the entire
// document's bitmaps in memory at once, which on a large or high-resolution scan blew the parse child's
// RSS budget and got the document dropped; slicing keeps peak memory flat regardless of page count.
const openPdf = async (buffer) => {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  let totalPages = 0;
  try {
    const info = await withRenderTimeout(parser.getInfo(), 'PDF info read');
    // The page count is `info.total`; `info.pages` is an array that is empty until pages are rendered, so
    // reading it as the count gives 0 (or a truthy empty array). Coerce defensively — an unusable count
    // just means the slice loop stops when a render returns fewer pages than requested.
    const n = Number(info?.total ?? info?.numPages);
    totalPages = Number.isFinite(n) && n > 0 ? n : 0;
  } catch { /* not fatal — the caller renders until a slice comes back short/empty */ }
  return { parser, totalPages };
};

// Render pages [first..last] (1-based, inclusive) from an already-open parser to image buffers. `last`
// omitted renders to the end. Returns only the decodable page images.
const renderRange = async (parser, first, last) => {
  const opts = { scale: RENDER_SCALE, first };
  if (last) opts.last = last;
  const result = await withRenderTimeout(parser.getScreenshot(opts), 'PDF page render');
  return (result.pages || [])
    .map(p => p?.data || (p?.images && p.images[0]?.data))
    .filter(Boolean);
};

// One-shot render: open, render the capped range, close. Holds every rendered page at once, so it is
// for small, fixed ranges only. Callers that process many pages must iterate (iterPdfPages) or slice on
// an open parser (see ocrPdf) rather than hold the whole document's bitmaps in memory.
const renderPdfPages = async (buffer, { maxPages = null } = {}) => {
  const { parser, totalPages } = await openPdf(buffer);
  try {
    const images = await renderRange(parser, 1, maxPages || null);
    return { images, totalPages: totalPages || images.length };
  } finally {
    try { await parser.destroy(); } catch {}
  }
};

// Lazily render PDF pages one small slice at a time, yielding { pageNum, image, totalPages }. The next
// slice is not rendered until the consumer has drained the current one, so peak memory stays at one slice
// of bitmaps regardless of page count — unlike renderPdfPages, which materializes every page at once. Used
// by visual ingest, whose per-page vision calls are sequential, so holding every rendered page simultaneously
// risked OOM on a long or high-resolution document. The parser is always destroyed, even if the consumer
// stops early (a `break` in a `for await` runs the generator's `finally`).
const VISUAL_PAGES_PER_SLICE = 2;
async function* iterPdfPages(buffer, { maxPages = null, sliceSize = VISUAL_PAGES_PER_SLICE } = {}) {
  const { parser, totalPages } = await openPdf(buffer);
  const hardCap = (Number.isInteger(maxPages) && maxPages > 0) ? maxPages : Infinity;
  const limit = totalPages > 0 ? Math.min(totalPages, hardCap) : hardCap;
  const step = Math.max(1, sliceSize | 0);
  try {
    for (let start = 1; start <= limit; start += step) {
      const end = limit === Infinity ? start + step - 1 : Math.min(start + step - 1, limit);
      let images;
      try { images = await renderRange(parser, start, end); }
      catch { break; }                       // a render failure ends the walk rather than losing the doc
      if (!images.length) break;             // past the end (count unknown, slice came back empty)
      const want = end - start + 1;
      for (let i = 0; i < images.length; i++) {
        yield { pageNum: start + i, image: images[i], totalPages: totalPages || 0 };
      }
      if (images.length < want) break;       // short slice = end of document
    }
  } finally {
    try { await parser.destroy(); } catch {}
  }
}

// Normalize an image before recognition, and slice it if it's tall. Both matter for
// Tesseract; the vision model is fed the same input so behavior stays comparable
// between recognizers.
// ── Skew detection (projection profile) ──────────────────────────────────────
// Detect small text-line tilt (roughly ±10°) so it can be corrected before OCR.
// Method: on a small grayscale copy (skew angle is scale-invariant, so working
// small keeps this cheap), try a range of candidate angles; at each, sum the dark
// pixels in every row and measure the VARIANCE of those row-sums. When the text
// lines are horizontal, rows alternate sharply between "line" (dark) and "gap"
// (light), so the variance peaks. The angle of peak variance is the skew.
//
// This is the classic projection-profile method. Its known weakness is sparse text
// (few lines / lots of whitespace), where the signal is weak — so we only correct
// when the best angle is both non-trivial AND clearly better than no rotation,
// leaving well-aligned or low-signal pages untouched. Returns the degrees to rotate
// BY to straighten the page (0 = leave as-is); the caller applies it directly.
const SKEW_MAX_ANGLE = 10;        // search range: -10°..+10°
const SKEW_COARSE_STEP = 1;       // first pass, 1° steps
const SKEW_FINE_STEP = 0.25;      // refine around the coarse best
const SKEW_DETECT_WIDTH = 600;    // downscale width for detection (cheap)
const SKEW_MIN_ANGLE = 0.5;       // below this, not worth correcting
const SKEW_MIN_CONFIDENCE = 1.25; // peak variance must beat the 0° variance by this ×
const MAX_INPUT_PIXELS = 100_000_000;   // pixel-bomb guard for the raw image decode (see prepareImage)

const detectSkewAngle = async (sharpImg) => {
  const sharp = loadSharp();
  if (!sharp) return 0;

  // Small grayscale raw buffer. Rendering to PNG first detaches from the source
  // pipeline so we can safely resize a copy for detection.
  let width, height, data;
  try {
    const small = sharp(await sharpImg.clone().png().toBuffer())
      .resize({ width: SKEW_DETECT_WIDTH, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .normalize();
    const raw = await small.raw().toBuffer({ resolveWithObject: true });
    data = raw.data; width = raw.info.width; height = raw.info.height;
  } catch { return 0; }
  if (!width || !height || height < 40) return 0;

  // Variance of the horizontal projection (row darkness sums) for a given rotation,
  // computed by sampling the rotated coordinate of each pixel. Rotating the SAMPLING
  // rather than the image avoids allocating a new buffer per angle.
  const rowVarianceAt = (angleDeg) => {
    const rad = angleDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = width / 2, cy = height / 2;
    const rowSum = new Float64Array(height);
    // Sample every 2nd pixel for speed; darkness = 255 - gray.
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        // Rotate (x,y) around the center; the row it lands in is what we bin into.
        const dy = (x - cx) * sin + (y - cy) * cos + cy;
        const ry = dy | 0;
        if (ry < 0 || ry >= height) continue;
        rowSum[ry] += 255 - data[y * width + x];
      }
    }
    let mean = 0;
    for (let i = 0; i < height; i++) mean += rowSum[i];
    mean /= height;
    let varc = 0;
    for (let i = 0; i < height; i++) { const d = rowSum[i] - mean; varc += d * d; }
    return varc / height;
  };

  const base = rowVarianceAt(0);
  if (base <= 0) return 0;

  // Coarse search.
  let bestAngle = 0, bestVar = base;
  for (let a = -SKEW_MAX_ANGLE; a <= SKEW_MAX_ANGLE; a += SKEW_COARSE_STEP) {
    if (a === 0) continue;
    const v = rowVarianceAt(a);
    if (v > bestVar) { bestVar = v; bestAngle = a; }
  }
  // Fine search around the coarse winner.
  if (bestAngle !== 0) {
    for (let a = bestAngle - SKEW_COARSE_STEP; a <= bestAngle + SKEW_COARSE_STEP; a += SKEW_FINE_STEP) {
      const v = rowVarianceAt(a);
      if (v > bestVar) { bestVar = v; bestAngle = a; }
    }
  }

  // Only correct when the tilt is real and the peak is clearly better than 0°.
  if (Math.abs(bestAngle) < SKEW_MIN_ANGLE) return 0;
  if (bestVar < base * SKEW_MIN_CONFIDENCE) return 0;
  return bestAngle;
};

const prepareImage = async (buf) => {
  const sharp = loadSharp();
  if (!sharp) return [buf];

  // Honor any EXIF orientation flag first: a phone photo taken sideways stores its
  // pixels unrotated with an orientation tag, so without this the recognizer reads it
  // rotated. rotate() with no argument applies the EXIF rotation and clears the tag.
  // (This does NOT fix a scan that is genuinely rotated with no EXIF hint — that's
  // handled by the confidence-gated rotation retry in the recognizer.)
  // Cap decoded pixels so a small "pixel bomb" image file (a few KB that declares e.g. 16000×16000) can't
  // decode to ~1 GB of RGBA on the main process. 100 MP covers even a large high-DPI scan; a larger one is
  // refused (sharp throws → caught by the caller → the file is skipped), which is safe. This is the raw
  // untrusted-buffer decode; the later sharp() calls operate on already-bounded, re-encoded buffers.
  const img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const meta = await img.metadata();
  // Width is read pre-deskew. A deskew rotation expands the canvas by at most ~10%
  // at the maximum skew angle, which doesn't meaningfully change the scaling decision
  // (the image is near-ideal width either way), and `fit: 'inside'` on the resize
  // below keeps the result bounded regardless. Not worth an extra encode to measure
  // the post-rotate width precisely.
  const w = meta.width || 0;

  // Correct small text-line tilt (a page scanned slightly crooked). Detected on a
  // cheap downscaled copy; only a confident, non-trivial angle is applied. Rotating
  // by a fractional angle needs a fill color for the exposed corners — white, so it
  // reads as page background rather than introducing dark edges the recognizer would
  // treat as content.
  let deskewed = img;
  try {
    const skew = await detectSkewAngle(img);
    if (skew !== 0) {
      // detectSkewAngle returns the rotation that STRAIGHTENS the page (verified: a
      // +5° tilt is detected as -5°, and rotating by that -5° restores it), so apply
      // it directly. White fill for the corners exposed by a fractional rotation.
      deskewed = sharp(await img.clone().png().toBuffer())
        .rotate(skew, { background: { r: 255, g: 255, b: 255 } });
    }
  } catch { /* detection failed — proceed without deskew */ }

  // Right-size the image for the recognizer. Tesseract reads text best when
  // characters are ~30px tall, which for a typical document scan means a width
  // around 1500-2000px. Two failure modes to correct:
  //   - Too WIDE: downscale to MAX_WIDTH (wider gains little, costs memory).
  //   - Too SMALL: UPSCALE to TARGET_WIDTH. A small or low-DPI image (e.g. a phone
  //     photo, or a small JPG of a document) otherwise reaches Tesseract with text
  //     only a few pixels tall, which reads poorly or not at all. Enlarging it — even
  //     though it adds no real detail — gives the recognizer characters big enough to
  //     segment, which measurably improves results.
  let pipeline = deskewed;
  if (w > MAX_WIDTH) {
    pipeline = deskewed.resize({ width: MAX_WIDTH, fit: 'inside' });
  } else if (w > 0 && w < TARGET_WIDTH) {
    // Cap the upscale factor so a genuinely tiny thumbnail isn't blown up absurdly.
    const factor = Math.min(TARGET_WIDTH / w, MAX_UPSCALE);
    pipeline = deskewed.resize({ width: Math.round(w * factor), fit: 'inside', kernel: 'lanczos3' });
  }
  const scaled = pipeline;

  // Grayscale and normalize contrast — this is most of what makes a marginal scan
  // legible to Tesseract.
  const base = await scaled.grayscale().normalize().png().toBuffer();

  const baseMeta = await sharp(base).metadata();
  // Skip anything too small to contain text. Tesseract logs a warning per
  // unrecognizable line on these, and they contribute nothing.
  if ((baseMeta.width || 0) < MIN_RECOGNIZABLE || (baseMeta.height || 0) < MIN_RECOGNIZABLE) return [];
  if (!baseMeta.height || baseMeta.height <= MAX_SLICE_HEIGHT) return [base];

  const slices = [];
  for (let top = 0; top < baseMeta.height; top += MAX_SLICE_HEIGHT) {
    const height = Math.min(MAX_SLICE_HEIGHT, baseMeta.height - top);
    // A final slice can be a few pixels tall; recognizing it is pointless and noisy.
    if (height < MIN_RECOGNIZABLE) continue;
    slices.push(
      await sharp(base)
        .extract({ left: 0, top, width: baseMeta.width, height })
        .png().toBuffer()
    );
  }
  return slices;
};

// ── Recognizers ─────────────────────────────────────────────────────────────

// tesseract.js — a small pool of workers, reused across the whole run.
//
// Recognition is CPU-bound and takes seconds per page, and a single worker leaves
// every other core idle: 39 pages took 160s sequentially on a multi-core machine.
// A pool processes pages concurrently and cuts that roughly by the worker count.
//
// The pool is deliberately small. Each worker holds its own WASM instance and
// language data (tens of MB), and indexing shares the machine with embedding and
// whatever else the user is doing — saturating every core would make the app feel
// worse even while finishing sooner.
const os = require('os');
// Roughly how much resident memory one Tesseract worker needs while recognizing a page — its own WASM heap
// (~400-600 MB observed) plus the page's working buffers. Used to size worker count against available memory
// so OCR never exceeds the parse child's budget (running too many at once is what got documents dropped).
const MB_PER_OCR_WORKER = 800;

// The recommended OCR worker count for THIS host: the smaller of a core-based tier (leaving headroom for the
// rest of the app) and a memory-based ceiling (a conservative quarter of total RAM, budgeted per worker).
// Single source of truth for "Automatic" — the parse child sizes its pool from it and the server reports it
// to the settings UI, so the number shown always matches what actually runs. Always at least one.
const recommendedWorkers = () => {
  const cores = os.cpus()?.length || 2;
  const byCore = cores <= 2 ? 1 : cores <= 4 ? 2 : Math.min(4, cores - 2);
  let totalMb = 0; try { totalMb = Math.floor(os.totalmem() / (1024 * 1024)); } catch { /* unknown — memory tier falls back to 1 */ }
  const byMem = totalMb ? Math.max(1, Math.floor((totalMb * 0.25) / MB_PER_OCR_WORKER)) : 1;
  return Math.max(1, Math.min(byCore, byMem, 8));
};

// A hard ceiling on OCR worker concurrency for the current process. The isolated parse child sets this from
// its own RSS budget so OCR of a high-resolution scan stays within it: each Tesseract worker holds a WASM
// heap that grows during recognition, and running several at once on large pages is what pushed the child
// past its memory cap and got documents dropped. null means no extra ceiling (the main process).
let _workerCap = null;
const setWorkerCap = (n) => { _workerCap = (Number.isInteger(n) && n > 0) ? n : null; };
const poolSize = () => {
  const cap = _workerCap || Infinity;
  const configured = cfg().OCR_WORKERS;
  // A user override is honored but still bounded by the memory ceiling, so a too-high setting on a small
  // machine can't OOM the child and drop the document.
  if (Number.isInteger(configured) && configured > 0) return Math.max(1, Math.min(configured, 8, cap));
  return Math.max(1, Math.min(recommendedWorkers(), cap));
};
let _tessPool = null;      // { workers: [...], queue: [...] }
// Leptonica (Tesseract's C image library, compiled to WASM) writes warnings
// straight to process.stderr — beneath Node, so tesseract.js's errorHandler never
// sees them. They're per-region notices about slivers found during layout analysis
// ("Image too small to scale (2x36...)"), which can't be filtered beforehand
// because they don't exist until Tesseract has segmented the page. They're
// harmless — documents still produce text — but a wall of them looks like failure.
//
// So the write is intercepted for the duration of recognition. Only known-benign
// lines are dropped; anything else still reaches the console, so a real problem
// isn't hidden.
// Fragments of the above, for lines split across stderr writes.
const LEPTONICA_NOISE_FRAGMENTS = [
  /^(Image too small|Line cannot|Error in pix|Scaling pix|Bad pix)/,
  /^(too small to scale|cannot be recognized|recognized!!|made null pix)/,
  /^\(\d+x\d+ vs min width/,
  /^ ?recognized/,
  /^pix[a-z]* (not defined|too small)/i,
];

const LEPTONICA_NOISE = [
  /^Image too small to scale/,
  /^Line cannot be recognized/,
  /^Error in pix(ScaleAreaMap|Clone|CopyText|CopyInputFormat|GetDimensions)/,
  /^Scaling pix of size .* made null pix/,
  /^Bad pix from ImageData/,
  /^Warning[.:] Invalid resolution/,
  /^Estimating resolution as/,
  /^Detected \d+ diacritics/,
];

// Nesting-safe: the filter is installed once for a whole OCR run and reference
// counted, so wrapping each individual recognize() call can't split a message across
// two filters. That was leaking fragments — Emscripten writes stderr in arbitrary
// chunks, so "Line cannot be recognized!!" could arrive as two pieces either side of
// an image boundary, and neither piece matched a whole-line pattern.
let _stderrDepth = 0;
let _stderrOriginal = null;
let _stderrLeftover = '';

const isNoise = (line) => {
  const t = line.trim();
  if (!t) return true;
  if (LEPTONICA_NOISE.some(re => re.test(t))) return true;
  // Also drop trailing fragments of a known message — a partial line that is a
  // prefix of something we'd filter anyway.
  return LEPTONICA_NOISE_FRAGMENTS.some(re => re.test(t));
};

const withStderrFiltered = async (fn) => {
  if (_stderrDepth++ === 0) {
    _stderrOriginal = process.stderr.write.bind(process.stderr);
    _stderrLeftover = '';
    process.stderr.write = (chunk, enc, cb) => {
      // Writable.write has two forms: write(chunk, cb) and write(chunk, encoding, cb). Normalize so
      // the caller's completion callback is always invoked (a caller that awaits its write callback
      // would otherwise stall) and an encoding is only forwarded when it is actually a string.
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      const text = _stderrLeftover + (typeof chunk === 'string' ? chunk : String(chunk));
      const lines = text.split('\n');
      _stderrLeftover = lines.pop() ?? '';   // hold a partial line for the next write
      const kept = lines.filter(l => !isNoise(l));
      if (kept.length) _stderrOriginal(kept.join('\n') + '\n', typeof enc === 'string' ? enc : undefined);
      if (typeof cb === 'function') cb();
      return true;
    };
  }
  try {
    return await fn();
  } finally {
    if (--_stderrDepth === 0) {
      if (_stderrLeftover && !isNoise(_stderrLeftover)) _stderrOriginal(_stderrLeftover + '\n');
      process.stderr.write = _stderrOriginal;
      _stderrOriginal = null;
      _stderrLeftover = '';
    }
  }
};

// ── Offline, verified language data ──────────────────────────────────────────
// English is the permanent floor; each additional language selected in Settings is fetched once,
// checksummed against its pinned hash, cached in the data folder, and read locally forever after.
// Recognition itself is fully offline: the worker's langPath is that local folder, never a CDN. A
// language that cannot be made available is dropped and English carries on, so a failed optional pack
// can never leave a run with no recognizer language.
const {
  OCR_BASE_LANGUAGE,
  OCR_LANGDATA_URL,
  OCR_LANGDATA_SHA256,
  normalizeOcrLanguages,
} = require('./ocr-languages');
const TESSDATA_TIMEOUT_MS = 60 * 1000;
const ENSURE_COOLDOWN_MS  = 60 * 1000;   // after a failed download, don't retry the fetch for this long
const MAX_LANG_BYTES      = 80 * 1024 * 1024;   // one pack ceiling (abuse / OOM guard)
const sha256hex = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

let _langDir = null;              // the managed <data>/tessdata directory, created once
let _tessLangs = OCR_BASE_LANGUAGE;   // the current pool's engine language string (e.g. "eng+spa")
const _langReady = new Set();     // `${dir}|${code}` confirmed present this process
const _langCooldown = new Map();  // `${dir}|${code}` -> ts; don't re-fetch a just-failed pack every page
const _langInflight = new Map();  // `${dir}|${code}` -> promise; dedup concurrent ensures

// English plus the additional languages from Settings, in a stable order.
const selectedLangs = () => {
  const extra = normalizeOcrLanguages(cfg().OCR_LANGUAGES);
  return [OCR_BASE_LANGUAGE, ...extra];
};

// The managed language-data directory. Created once; every pack lives here.
const ensureLangDir = async () => {
  if (_langDir) return _langDir;
  const dir = require('path').join(cfg().DATA_DIR, 'tessdata');
  await require('fs').promises.mkdir(dir, { recursive: true });
  _langDir = dir;
  return dir;
};

// Ensure one language pack is present and verified. Returns true/false, never throws. A cached pack
// is re-checked against its pinned hash; a mismatched file is discarded and re-fetched. A failed fetch
// sets a short cooldown so an offline batch tries once, not once per page.
const ensureLang = async (dir, code) => {
  const pin = OCR_LANGDATA_SHA256[code];
  if (!pin) return false;
  const file = require('path').join(dir, code + '.traineddata.gz');
  const key = dir + '|' + code;
  if (_langReady.has(key)) return true;

  // Already downloaded before, pre-seeded, or cached from a previous run: verify it once.
  try {
    const buf = await require('fs').promises.readFile(file);
    if (sha256hex(buf) === pin) { _langReady.add(key); return true; }
    await require('fs').promises.unlink(file).catch(() => {});   // corrupt or wrong version — re-fetch
  } catch { /* not present — download below */ }

  if (Date.now() < (_langCooldown.get(key) || 0)) return false;
  if (_langInflight.has(key)) return _langInflight.get(key);

  const p = (async () => {
    try {
      let res;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TESSDATA_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      try { res = await fetch(OCR_LANGDATA_URL(code), { signal: ctrl.signal, redirect: 'follow' }); }
      finally { clearTimeout(timer); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty download');
      if (buf.length > MAX_LANG_BYTES) throw new Error('language pack too large');
      if (!(buf[0] === 0x1f && buf[1] === 0x8b)) throw new Error('not a gzip file');
      if (sha256hex(buf) !== pin) throw new Error('integrity check failed');
      // Atomic write (temp + rename) so a concurrent read never sees a half-written file; the data is
      // re-downloadable and integrity-checked, so it skips fsync.
      await require('./disk').writeFileAtomicAsync(file, buf);
      _langReady.add(key);
      require('./logbuffer').debug(`🔍 OCR: ${code} language data ready (${(buf.length / 1048576).toFixed(1)} MB, verified)`);
      return true;
    } catch (e) {
      _langCooldown.set(key, Date.now() + ENSURE_COOLDOWN_MS);
      require('./logbuffer').debug(`🔍 OCR: ${code} language data unavailable (${e && e.message ? e.message : e})`);
      return false;
    } finally { _langInflight.delete(key); }
  })();
  _langInflight.set(key, p);
  return p;
};

// Seed any BUNDLED language packs (shipped by the desktop build under --bundled-tessdata-dir) into the managed
// tessdata directory, so a fresh — possibly offline — install can OCR without a network fetch. Language-agnostic:
// it copies every pinned pack the bundle happens to ship (today just English, the always-on floor), and never a
// hard-coded 'eng'. It NEVER overwrites a pack already present (a prior download or a newer cached copy wins), and
// the copied file is still SHA-256-verified by ensureLang before use, so a wrong or corrupt bundled pack is caught
// and re-fetched exactly like a bad download. Best-effort and non-blocking: any failure simply falls through to
// the normal fetch-once path, so the standalone and container modes (no bundled dir) are unchanged. Idempotent —
// after the first seed every pack is present, so later runs copy nothing.
const seedBundledLangs = async (dir, src = cfg().BUNDLED_TESSDATA_DIR) => {
  if (!src) return;
  const fsp = require('fs').promises;
  const p = require('path');
  for (const code of Object.keys(OCR_LANGDATA_SHA256)) {
    const name = code + '.traineddata.gz';
    const to = p.join(dir, name);
    try { await fsp.access(to); continue; } catch { /* absent — seed it from the bundle if present */ }
    const from = p.join(src, name);
    const tmp = to + '.seed.tmp';
    try {
      await fsp.copyFile(from, tmp);     // the bundled pack may not exist for this code — that just throws, caught below
      await fsp.rename(tmp, to);         // atomic publish so a concurrent reader never sees a half-copied file
    } catch {
      try { await fsp.rm(tmp, { force: true }); } catch { /* no temp to clean */ }
    }
  }
};

// Ensure every selected language. Optional languages that cannot be made available are dropped; if
// English itself cannot be made available, throw so the caller skips OCR (fail-closed) rather than
// allowing tesseract.js to reach out to a CDN at recognition time.
const ensureLangs = async () => {
  const dir = await ensureLangDir();
  await seedBundledLangs(dir);   // place any bundled packs first, so the per-language ensure below finds them offline
  const wanted = selectedLangs();
  const results = await Promise.all(wanted.map((code) => ensureLang(dir, code)));
  const available = wanted.filter((code, i) => results[i]);
  if (!available.includes(OCR_BASE_LANGUAGE)) {
    throw Object.assign(new Error('OCR English language data unavailable — a download failed'), { ocrDataUnavailable: true });
  }
  return { dir, codes: available };
};

// Build the pool on first use. Workers are created in parallel — each one loads
// language data, so doing it sequentially would add seconds before any page starts.
// Cache the PROMISE, not the result. Pages start concurrently, so two callers can
// both reach this before the first has finished building — each would then create a
// full pool, and the first would be orphaned with its workers never terminated.
// Awaiting a shared promise means exactly one pool is ever built.
let _tessPoolPromise = null;

const getPool = async () => {
  if (_tessPool) return _tessPool;
  if (_tessPoolPromise) return _tessPoolPromise;
  _tessPoolPromise = buildPool().finally(() => { _tessPoolPromise = null; });
  return _tessPoolPromise;
};

// Build the worker options once (logger + a deterministic cache dir for the language data). Keep the
// downloaded language data (eng.traineddata.gz, ~10 MB compressed) inside the data folder. Without an explicit
// cachePath, tesseract.js writes it to the current working directory — so it lands wherever Lokyni
// happened to be launched from, which is surprising and litters the repo/home dir. mkdir first:
// tesseract.js assumes the directory exists and errors if it doesn't.
let _tessOpts = null;
const tessOpts = () => {
  if (_tessOpts) return _tessOpts;
  const opts = {
    logger:       (m) => { if (cfg().DEBUG && m?.status) console.log(`   tesseract: ${m.status}`); },
    errorHandler: (e) => { if (cfg().DEBUG) console.log(`   tesseract: ${e?.message || e}`); },
  };
  // Read the verified language data from the local folder rather than tesseract.js's default CDN, so
  // recognition is fully offline and integrity-checked. _langDir is set by ensureLangs, which
  // buildPool awaits before any worker is created; gzip:true because the pinned file is .gz.
  if (_langDir) { opts.langPath = _langDir; opts.cachePath = _langDir; opts.gzip = true; }
  _tessOpts = opts;
  return opts;
};

// Create one recognition worker. Shared by the initial pool build and by the mid-run replacement of a
// worker that had to be terminated (see replaceWorker), so the two can never construct workers
// differently.
const createTessWorker = async () => {
  let Tesseract;
  try { Tesseract = require('tesseract.js'); }
  catch {
    throw new Error('tesseract.js is not installed — run `npm install tesseract.js`, or set "ocrEngine": "vision"');
  }
  const worker = await Tesseract.createWorker(_tessLangs, undefined, tessOpts());
  // Redirect Tesseract/Leptonica's native debug output (e.g. "Line cannot be recognized", "Image too
  // small to scale") to the OS null device. Those lines are written from the recognition worker thread,
  // beneath the main-thread stderr filter, so silencing them at the source is the only reliable
  // suppression. Cross-platform null device (NUL on Windows). Best-effort — never fail worker creation.
  try { await worker.setParameters({ debug_file: process.platform === 'win32' ? 'NUL' : '/dev/null' }); } catch (_) {}
  return worker;
};

const buildPool = async () => {
  // Ensure the verified language data is present locally first (fail-closed for English): if it can't
  // be made available, this throws and the caller skips OCR rather than the engine fetching from a CDN.
  // Optional languages that failed to download are dropped, so English still carries on.
  const { dir, codes } = await ensureLangs();
  _langDir = dir;
  _tessLangs = codes.join('+');
  const workers = await Promise.all(Array.from({ length: poolSize() }, () => createTessWorker()));
  _tessPool = { workers, idle: [...workers], waiting: [] };
  require('./logbuffer').debug(`🔍 OCR: ${workers.length} recognition worker(s) ready`);
  return _tessPool;
};

// A queued wait for a worker is bounded, so the (non-isolated) inline OCR path can't hang forever if
// the pool were ever fully drained and unrecoverable (e.g. every worker lost and no replacement can
// be built). On timeout the waiter is removed and rejected; its page is then skipped, best-effort.
const ACQUIRE_TIMEOUT_MS = 2 * 60 * 1000;
// Hand out a worker, queueing when all are busy.
const acquire = async () => {
  const pool = await getPool();
  if (pool.idle.length) return pool.idle.pop();
  return new Promise((resolve, reject) => {
    let settled = false;
    const entry = (w) => { if (settled) return; settled = true; clearTimeout(t); resolve(w); };
    const t = setTimeout(() => {
      if (settled) return; settled = true;
      const i = pool.waiting.indexOf(entry); if (i >= 0) pool.waiting.splice(i, 1);
      reject(new Error('OCR worker did not become available in time'));
    }, ACQUIRE_TIMEOUT_MS);
    if (t.unref) t.unref();
    pool.waiting.push(entry);
  });
};
const release = (worker) => {
  if (!_tessPool) return;
  const next = _tessPool.waiting.shift();
  if (next) next(worker);              // hand straight to whoever is queued
  else _tessPool.idle.push(worker);
};

// A single page must never wedge a pool worker forever. Each page's recognition is bounded; a page
// that exceeds this is treated as unreadable (skipped). Generous — a real page recognizes in
// seconds — so it fires only on a genuinely stuck page, and stays under the isolated child's own
// 120s deadline so the page is skipped gracefully rather than the whole child being killed.
const PAGE_TIMEOUT_MS = 90 * 1000;

// Terminate a worker that can't be trusted back in the pool (e.g. one stuck inside the WASM engine
// after a timeout) and replace it with a fresh one, so a timeout never permanently shrinks the pool.
// Best-effort: if the replacement can't be created, the pool simply runs one worker lighter rather
// than throwing into the OCR batch.
const replaceWorker = async (dead) => {
  if (_tessPool) { const i = _tessPool.workers.indexOf(dead); if (i >= 0) _tessPool.workers.splice(i, 1); }
  try { await dead.terminate(); } catch { /* already gone */ }
  try {
    const w = await createTessWorker();
    if (_tessPool) { _tessPool.workers.push(w); release(w); }
    else { await w.terminate().catch(() => {}); }   // pool was torn down while we rebuilt
  } catch { /* keep going with a smaller pool */ }
};

// Confidence below which we suspect the page is rotated and worth retrying at other
// orientations. Tesseract mean confidence on well-oriented text is typically 70-90+;
// on sideways/upside-down text it collapses. 55 is a conservative floor that avoids
// retrying pages that are simply low-quality (already reading as well as they can).
const ROTATE_RETRY_CONFIDENCE = 55;

// Recognize one prepared image, correcting for genuine page rotation (no EXIF hint).
// Reads it as-is first; only if confidence is low does it try 90/180/270 and keep the
// orientation with the highest confidence. Well-oriented pages pay nothing extra —
// the rotations run solely on suspect pages.
const recognizeBestOrientation = async (img, worker) => {
  const first = await worker.recognize(img);
  let best = { text: first.data?.text || '', conf: first.data?.confidence ?? 0 };
  if (best.conf >= ROTATE_RETRY_CONFIDENCE) return best.text;

  const sharp = loadSharp();
  if (!sharp) return best.text;   // can't rotate without sharp

  for (const angle of [90, 180, 270]) {
    let rotated;
    try { rotated = await sharp(img).rotate(angle).png().toBuffer(); }
    catch { continue; }
    let res;
    try { res = await worker.recognize(rotated); }
    catch { continue; }
    const conf = res.data?.confidence ?? 0;
    if (conf > best.conf) best = { text: res.data?.text || '', conf };
    // Good enough — stop early once we clear the threshold.
    if (best.conf >= ROTATE_RETRY_CONFIDENCE) break;
  }
  return best.text;
};

const tesseractRecognize = async (images) => {
  // Recognize concurrently across the pool, preserving page order in the output.
  // Wrap the whole batch in the stderr filter so the Leptonica per-region warnings
  // ("Image too small to scale", "Line cannot be recognized", etc.) that the WASM
  // build writes straight to stderr are dropped rather than flooding the console.
  const { raceTimeout } = require('./llm');
  return withStderrFiltered(async () => {
    const results = await Promise.all(images.map(async (img) => {
      const worker = await acquire();
      // Swallow a late settle: if the timeout wins the race below, this promise may still reject
      // once its worker is terminated, and that must not surface as an unhandled rejection.
      const p = recognizeBestOrientation(img, worker);
      p.catch(() => {});
      try {
        const text = await raceTimeout(p, PAGE_TIMEOUT_MS);
        release(worker);
        return text;
      } catch (e) {
        // A timeout means the worker may be stuck in the engine, so replace it; any other error
        // leaves the worker usable, so return it to the pool. Either way the page is skipped, so a
        // single bad page never fails or stalls the batch.
        if (e && e._lokTimeout) await replaceWorker(worker);
        else release(worker);
        if (cfg().DEBUG) console.log(`   tesseract: page skipped (${e && e._lokTimeout ? `no result within ${PAGE_TIMEOUT_MS / 1000}s` : (e?.message || e)})`);
        return '';
      }
    }));
    return results.filter(Boolean).join('\n');
  });
};


// Terminate every worker. Un-terminated tesseract workers hold their WASM instance
// and language data for the life of the process, so a pool leaks proportionally more
// than a single worker did.
const releaseTesseract = async () => {
  if (!_tessPool) return;
  const { workers } = _tessPool;
  _tessPool = null;
  _tessPoolPromise = null;   // a build in flight must not resurrect the pool
  await Promise.all(workers.map(w => w.terminate().catch(() => {})));
};

// Vision model through the configured provider. Reuses the existing LLM plumbing,
// so no new client, transport or credentials are involved.
const visionRecognize = async (images) => {
  const c = cfg();
  const model = c.OCR_VISION_MODEL;
  const prompt =
    'Transcribe all text in this image exactly as it appears. ' +
    'Preserve headings, lists and table structure using markdown. ' +
    'Do not describe the image, summarize, or add commentary — output only the text. ' +
    'If the image contains no readable text, output nothing.';

  const out = [];
  const llm = require('./llm');
  // Bound each single-shot vision request against the idle deadline; the Ollama/OpenAI SDKs set no
  // request timeout, so a wedged model would otherwise hang the OCR call (and the index run that
  // awaits it) forever. A rejection propagates to the caller (ocrPdf's per-page circuit breaker, or
  // ocrImage which degrades to '') exactly as a provider error already does.
  const bound = (p) => llm.raceTimeout(p, c.LLM_TIMEOUT_MS);
  for (const img of images) {
    const b64 = Buffer.isBuffer(img) ? img.toString('base64') : img;
    if (llm.isOpenAICompatible(c.AI_PROVIDER)) {
      const client = llm.getOpenAIClient();
      if (!client) continue;
      const res = await bound(client.chat.completions.create({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        }],
      }));
      const text = res.choices?.[0]?.message?.content;
      if (text) out.push(text);
    } else {
      const client = llm.getOllamaClient() || llm.makeOllamaClient(c);
      const res = await bound(client.chat({
        model,
        messages: [{ role: 'user', content: prompt, images: [b64] }],
        stream: false,
      }));
      const text = res?.message?.content;
      if (text) out.push(text);
    }
  }
  return out.join('\n');
};

// OCR output is whitespace-noisy regardless of recognizer — collapse runs of spaces
// and blank lines so chunking sees clean prose.
const tidy = (text) => (text || '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .split('\n').map(l => l.trimEnd()).join('\n')
  .trim();

// Choose the recognizer, verifying the vision model is actually available first.
// Selecting 'vision' without having pulled the model would otherwise fail on every
// single page — a wall of identical errors that doesn't say what's wrong. Checking
// once and degrading to tesseract keeps documents indexable either way.
let _engineChoice = null;
let _engineChoiceKey = null;   // the (engine + model) the cached choice was made for
const pickEngine = async () => {
  const c = cfg();
  if (c.OCR_ENGINE !== 'vision') return tesseractRecognize;

  // Re-evaluate whenever the OCR engine or vision model changes (e.g. the user edits
  // it in Settings), rather than caching the first decision for the life of the
  // process. Without this, switching from tesseract to a vision model — or changing
  // which vision model — has no effect until a full restart.
  const key = `${c.OCR_ENGINE}|${c.OCR_VISION_MODEL}|${c.AI_PROVIDER}`;
  if (_engineChoice && _engineChoiceKey === key) return _engineChoice;
  _engineChoiceKey = key;

  try {
    if (require('./llm').isOpenAICompatible(c.AI_PROVIDER)) { _engineChoice = visionRecognize; return _engineChoice; }
    const client = require('./llm').makeOllamaClient(c);
    const { models } = await client.list();
    const want = c.OCR_VISION_MODEL.split(':')[0];
    const have = (models || []).some(m => (m.name || m.model || '').split(':')[0] === want);
    if (have) {
      _engineChoice = visionRecognize;
      console.log(`🔍 OCR engine: vision (${c.OCR_VISION_MODEL})`);
    } else {
      const available = (models || []).map(m => (m.name || m.model || '')).filter(Boolean).join(', ') || 'none';
      console.warn(`⚠️  OCR vision model "${c.OCR_VISION_MODEL}" not found in Ollama — using tesseract instead.`);
      console.warn(`   Installed models: ${available}`);
      console.warn(`   Pull it with:  ollama pull ${c.OCR_VISION_MODEL}`);
      _engineChoice = tesseractRecognize;
    }
  } catch (e) {
    // Provider unreachable — tesseract needs nothing, so it's the safe choice.
    console.warn(`⚠️  Can't reach Ollama to use vision OCR (${e.message}) — using tesseract.`);
    _engineChoice = tesseractRecognize;
  }
  return _engineChoice;
};

// ── Entry point ─────────────────────────────────────────────────────────────
// Extract text from a scanned PDF. Returns '' when OCR is disabled or the document
// exceeds the configured page cap, so the caller can fall back cleanly.
// How many pages to render at once. Rendering every page up front held the whole document's bitmaps in
// memory, which on a large or high-resolution scan blew the parse child's RSS budget and got the document
// dropped. Rendering in small slices — render, OCR, release, repeat — keeps peak memory flat regardless of
// page count (the pattern large-scale document-OCR services use). The worker pool still bounds how many
// pages within a slice are recognized at once, so the pool stays saturated.
const OCR_PAGES_PER_SLICE = 4;

const ocrPdf = async (buffer, fileName = '') => {
  const c = cfg();
  if (!c.USE_OCR) return '';

  const engine = await pickEngine();
  const label = path.basename(fileName || 'document');
  // The vision engine is kept sequential: those requests hit a model server, and firing several at once on
  // a local Ollama just queues them while multiplying memory pressure. Tesseract pages recognize
  // concurrently, bounded by the worker pool.
  const parallel = engine !== visionRecognize;

  let parser, totalPages;
  try {
    ({ parser, totalPages } = await openPdf(buffer));
  } catch (e) {
    console.warn(`⚠️  Could not open ${label} for OCR: ${e.message}`);
    return '';
  }

  // Cap the pages read. When the page count could not be read (totalPages 0), the cap is Infinity and the
  // slice loop stops when a render comes back empty (past the end).
  const hardCap = (Number.isInteger(c.OCR_MAX_PAGES) && c.OCR_MAX_PAGES > 0) ? c.OCR_MAX_PAGES : Infinity;
  const limit = totalPages > 0 ? Math.min(totalPages, hardCap) : hardCap;

  const engineName = engine === visionRecognize ? 'vision' : 'tesseract';
  require('./logbuffer').progress(`🔍 OCR: ${label} — ${totalPages || '?'} page(s) via ${engineName}…`);
  const started = Date.now();
  const texts = [];
  let processed = 0;          // pages actually rendered and OCR'd
  let visionFailStreak = 0;   // persists across slices for the vision circuit breaker
  let stop = false;
  // Render as many pages per slice as will be recognized at once, so the resident rendered pages match the
  // concurrency and no more — capped by OCR_PAGES_PER_SLICE. In the memory-capped parse child the worker
  // cap shrinks poolSize, which shrinks the slice too, keeping peak memory within the child's budget.
  const sliceSize = Math.max(1, Math.min(poolSize(), OCR_PAGES_PER_SLICE));

  // OCR one already-rendered page image. onHardFail fires only when the engine/prepare THREW (a real
  // failure), not on an empty or too-small page — so the vision path can tell a broken engine from a blank.
  const ocrOnePage = async (img, pageNum, onHardFail) => {
    try {
      const slices = await prepareImage(img);
      if (slices.length === 0) return null;   // page too small to hold text
      const text = await engine(slices);
      if (c.DEBUG) console.log(`   page ${pageNum} — ${text ? text.length : 0} chars`);
      return text && text.trim() ? text : null;
    } catch (e) {
      // One bad page shouldn't lose the rest of the document.
      console.warn(`⚠️  OCR failed on page ${pageNum} of ${label}: ${e.message}`);
      if (onHardFail) onHardFail();
      return null;
    }
  };

  // One stderr filter for the whole document, so a Leptonica/Tesseract warning split across a page
  // boundary is still reassembled and suppressed. (withStderrFiltered is reference counted, so the
  // per-recognize wrapper inside nests harmlessly.)
  let reachedEnd = false;   // the loop consumed the whole document (as opposed to stopping at the page cap)
  try {
    await withStderrFiltered(async () => {
      for (let start = 1; start <= limit && !stop; start += sliceSize) {
        const end = limit === Infinity
          ? start + sliceSize - 1
          : Math.min(start + sliceSize - 1, limit);
        const want = end - start + 1;
        let images;
        try {
          images = await renderRange(parser, start, end);
        } catch (e) {
          // A render failure ends the document here rather than dropping everything already read.
          console.warn(`⚠️  Could not render pages ${start}-${end} of ${label} for OCR: ${e.message}`);
          reachedEnd = true;   // stopped for a reason of its own; don't also cry "page limit" below
          break;
        }
        if (images.length === 0) { reachedEnd = true; break; }   // past the last page (handles an unknown count)

        if (parallel) {
          // Recognize the slice's pages concurrently, bounded by the worker pool, collected in page order.
          const results = new Array(images.length);
          const width = Math.max(1, Math.min(poolSize(), images.length));
          let next = 0;
          const drainWorker = async () => {
            while (true) {
              const i = next++;
              if (i >= images.length) return;
              results[i] = await ocrOnePage(images[i], start + i);
            }
          };
          await Promise.all(Array.from({ length: width }, drainWorker));
          for (const t of results) if (t) texts.push(t);
        } else {
          // Vision path: sequential, with a consecutive-failure circuit breaker. pickEngine only verifies
          // the model is LISTED, not that it can run inference, so a model that loads but crashes on every
          // call would otherwise be hit for every page. Stop after two hard failures in a row; a lone empty
          // page does not count and resets the streak.
          for (let i = 0; i < images.length; i++) {
            let hardFail = false;
            const t = await ocrOnePage(images[i], start + i, () => { hardFail = true; });
            if (t) { texts.push(t); visionFailStreak = 0; }
            else if (hardFail && ++visionFailStreak >= 2) {
              console.warn(`⚠️  ${label}: stopping OCR after repeated vision failures — the model may be unable to run`);
              stop = true; break;
            } else if (!hardFail) { visionFailStreak = 0; }
          }
        }
        processed += images.length;
        if (images.length < want) { reachedEnd = true; break; }   // a short slice means the end was reached
      }
    });
  } finally {
    try { await parser.destroy(); } catch {}
  }

  // Say so when a document is cut short by the page cap. Silently indexing the first 40 pages of a
  // 200-page scan leaves the rest unsearchable with no indication why.
  if (totalPages > processed && processed > 0) {
    console.warn(`⚠️  ${label}: read ${processed} of ${totalPages} pages (ocrMaxPages limit)`);
    try { require('./indexing/files').reportTruncated(label, processed, totalPages); } catch {}
  } else if (!totalPages && !reachedEnd && !stop && processed > 0 && Number.isFinite(limit) && processed >= limit) {
    // The page count could not be read, and the run stopped at the page cap with a full final slice — so the
    // document may have more pages that were not read. Report it rather than silently cutting it short.
    console.warn(`⚠️  ${label}: read ${processed} page(s) — reached the page limit; the document may have more, raise "Max pages per document" to include them`);
    try { require('./indexing/files').reportTruncated(label, processed, `${processed}+`); } catch {}
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const out = tidy(texts.join('\n\n'));
  require('./logbuffer').progress(`🔍 OCR: ${label} — ${out.length} chars in ${secs}s`);
  return out;
};

// Recognize a standalone image file (.png/.jpg/...).
const ocrImage = async (buffer, fileName = '') => {
  const c = cfg();
  if (!c.USE_OCR) return '';
  const engine = await pickEngine();
  const label = path.basename(fileName || 'image');
  try {
    const slices = await prepareImage(buffer);
    if (slices.length === 0) return '';       // image too small to hold text
    // Wrap recognition in the stderr filter — like ocrPdf — so Tesseract/Leptonica's per-region
    // warnings ("Image too small to scale", "Line cannot be recognized") don't leak to the
    // terminal when indexing a folder of images. Without this, image OCR was the one recognition
    // path that bypassed the filter.
    const text = tidy(await withStderrFiltered(() => engine(slices)));
    if (c.DEBUG) console.log(`🔍 OCR: ${label} — ${text.length} chars`);
    return text;
  } catch (e) {
    console.warn(`⚠️  OCR failed for ${label}: ${e.message}`);
    return '';
  }
};

// Build the pool ahead of the first document. Otherwise document one pays the whole
// startup cost — four workers each loading language data — which made a 1-page scan
// appear slower than an 8-page one and looked like the pool was blocking.
const warmUp = async () => {
  const c = cfg();
  if (!c.USE_OCR || c.OCR_ENGINE !== 'tesseract') return;
  try { await getPool(); } catch { /* falls back to lazy construction */ }
};

// ── Shared OCR orchestration (scan-detect + content-hash cache + combine) ──────────────────────────────────
// The single home for "turn a file's bytes into OCR text, cached by content hash." Used by BOTH the inline
// parse path (files.js) AND the isolated child (extractcore.js) so the detection, caching, and combine logic
// can't drift between them. `cacheDir` targets a non-active workspace's own cache when warming one (omitted =
// the active workspace). Best-effort: any failure returns the base text, never throwing out of indexing.

// A scanned PDF: when it has no usable text layer, OCR it (cached) and combine with whatever text it did have.
const ocrPdfCombined = async (buffer, baseText, pageCount = 1, { fileName = '', cacheDir = null } = {}) => {
  if (!looksScanned(baseText, pageCount || 1)) return baseText;
  const cache = require('./ocrcache');
  const key = cache.keyFor(buffer);
  const cached = cache.get(key, cacheDir);
  const recognized = cached !== null ? cached : ((await ocrPdf(buffer, fileName)) || '');
  if (cached === null) cache.set(key, recognized, cacheDir);
  return recognized ? (baseText ? `${baseText}\n\n${recognized}` : recognized) : baseText;
};

// An image: OCR it, cached by content hash. (Vision-describe, which needs the model key, is NOT here — it
// stays on the inline path, so the scrubbed child can still reuse this for the OCR-text half.)
const ocrImageCached = async (buffer, { fileName = '', cacheDir = null } = {}) => {
  const cache = require('./ocrcache');
  const key = cache.keyFor(buffer);
  const cached = cache.get(key, cacheDir);
  if (cached !== null) return cached;
  const text = (await ocrImage(buffer, fileName)) || '';
  cache.set(key, text, cacheDir);
  return text;
};

module.exports = {
  ocrPdfCombined, ocrImageCached,
  ocrPdf, ocrImage, looksScanned, releaseTesseract, warmUp,
  SCANNED_TEXT_THRESHOLD,
  // The isolated parse child calls setWorkerCap to cap OCR worker concurrency to its memory budget;
  // recommendedWorkers is the single source of truth for the "Automatic" count (used by the child and,
  // for the settings UI, by the server). MB_PER_OCR_WORKER is the shared per-worker memory estimate the
  // child divides its budget by, kept in one place so the two never drift.
  setWorkerCap, recommendedWorkers, MB_PER_OCR_WORKER,
  // Exported so other image code (vision.js) loads the SAME single libvips build rather
  // than pulling a second copy of sharp into the process (see loadSharp's rationale), and
  // caps the raw untrusted decode at the SAME pixel-bomb limit this path uses.
  loadSharp, MAX_INPUT_PIXELS,
  // Exported so the visual-ingest pass (lib/indexing/visualdocs.js) renders PDF pages
  // through the SAME pdf-parse path used for OCR, rather than adding a second rasterizer.
  // iterPdfPages streams pages one slice at a time so visual ingest never holds the whole
  // document's bitmaps at once (OOM-proof on long / high-resolution scans).
  renderPdfPages, iterPdfPages,
  // Exported for the offline-seed unit test: copies bundled language packs into the managed tessdata dir, and
  // makes the selected languages available (seeding bundled packs first, then verifying/fetching as needed).
  seedBundledLangs, ensureLangs,
};
