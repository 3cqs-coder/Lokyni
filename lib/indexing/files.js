'use strict';
const fs      = require('fs').promises;
const path    = require('path');
const crypto  = require('crypto');
const { MIN_FILE_SIZE, MAX_FILE_SIZE } = require('../config');

// JSON at or below this size parses in well under a millisecond, so offloading it to a
// worker would cost more than it saves; a larger one is moved off the event loop.
const JSON_WORKER_THRESHOLD = 512 * 1024;

// Source-folder settings are read live rather than destructured at import time.
// The settings panel can add or remove folders while Lokyni is running, and
// reloadConfig() replaces the config module — a value captured at import would be a
// stale snapshot, so newly added folders would never be discovered.
const srcCfg = () => require('../config');

// Document identity. The id is a hash of the file's path, so the SAME file must
// always produce the same string — otherwise the index and the document list
// disagree and every file reads as unindexed. Callers hold a mix of relative paths
// (walkDirectory over a relative DOCS_DIR) and absolute ones (collectAllFiles
// resolves), so normalize here rather than trusting each caller to do it.
const docIdFor = (filePath) =>
  crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');

// Files discovered but not indexed, so the reason can be reported rather than the
// documents silently never appearing. Reset at the start of each index run.
// tooSmall/tooLarge are genuinely excluded; truncated read only part of a document; nameOnly are indexed
// but had no extractable text, so they are findable by file name only (never silently dropped).
const skipReport = { tooSmall: [], tooLarge: [], truncated: [], textTruncated: [], nameOnly: [] };
const resetSkipReport = () => { skipReport.tooSmall = []; skipReport.tooLarge = []; skipReport.truncated = []; skipReport.textTruncated = []; skipReport.nameOnly = []; };
const getSkipReport  = () => ({ tooSmall: [...skipReport.tooSmall], tooLarge: [...skipReport.tooLarge], truncated: [...skipReport.truncated], textTruncated: [...skipReport.textTruncated], nameOnly: [...skipReport.nameOnly] });
// OCR reports partially-read documents here so they surface with the other skips.
const reportTruncated = (name, read, total) => { skipReport.truncated.push(`${name} (${read}/${total} pages)`); };
// A large plain-text/log/CSV file read only in part (capped at MAX_TEXT_CHARS) is reported here so the
// cut surfaces in the run summary instead of being silent. `where` says which end was kept.
const reportTextTruncated = (name, where) => { skipReport.textTruncated.push(`${name} (kept the ${where})`); };
// Fold an isolated child's skip report (see extractchild.js) into this process's report. The child reads and
// parses a file in its own address space and dies, so any truncation IT recorded — most importantly a
// scanned-PDF page cap from ocrPdf — would be lost without this merge. Best-effort and tolerant of a missing
// or partial payload; only the categories a child can populate (truncated/textTruncated) actually carry data.
const CATS = ['tooSmall', 'tooLarge', 'truncated', 'textTruncated', 'nameOnly'];
const mergeSkipReport = (skips) => {
  if (!skips || typeof skips !== 'object') return;
  for (const c of CATS) if (Array.isArray(skips[c])) for (const e of skips[c]) skipReport[c].push(e);
};

const { SUPPORTED_EXTENSIONS, OCR_EXTENSIONS, MEDIA_EXTENSIONS, NAME_ONLY_EXTENSIONS } = require('../constants');
const { decodeTextBuffer } = require('../textdecode');   // BOM/UTF-16/latin1-aware text decode (not blind utf-8)
const { capText, MAX_TEXT_CHARS, TRUNC_MARK } = require('./parsecore');   // bound plain-text/HTML like every heavy format (16 MB, surrogate-safe)

// Plain-text formats are indexed as-is and are NOT parsed in the memory-capped isolation child, so a very
// large one would otherwise be read and decoded WHOLE on the main process before capText discards
// everything past MAX_TEXT_CHARS — a transient multi-hundred-MB spike plus a synchronous decode stall that
// blocks every concurrent query. Read only a bounded prefix instead: enough bytes to fill the character cap
// for any encoding decodeTextBuffer handles (UTF-8 up to 4 bytes/char, UTF-16 2, Latin-1 1), and no more.
const TEXT_PREFIX_EXTS = new Set(['.txt', '.md', '.log', '.csv', '.tsv', '.html', '.htm']);
const TEXT_READ_MAX_BYTES = MAX_TEXT_CHARS * 4;   // fills the char cap even for 4-byte UTF-8; capText trims the rest

// Drop a trailing incomplete UTF-8 sequence left by cutting a read at a fixed byte budget. Without this, a
// multi-byte character bisected at the cut makes isUtf8() reject the WHOLE buffer, so decodeTextBuffer falls
// back to Latin-1 and the entire document is mis-decoded as mojibake. The dropped 1-3 bytes are negligible
// (the text is capped far below this). Only applied when the read was truncated, so a complete file — which
// may legitimately be Latin-1 — is never altered.
const trimTrailingPartialUtf8 = (buf) => {
  const n = buf.length;
  if (n === 0) return buf;
  let i = n - 1;
  while (i >= 0 && (buf[i] & 0xC0) === 0x80) i--;        // back up over continuation bytes to the lead byte
  if (i < 0) return buf;                                 // all continuation bytes — not UTF-8, leave as-is
  const lead = buf[i];
  let need;
  if (lead < 0x80) need = 1;
  else if ((lead & 0xE0) === 0xC0) need = 2;
  else if ((lead & 0xF0) === 0xE0) need = 3;
  else if ((lead & 0xF8) === 0xF0) need = 4;
  else return buf;                                        // invalid lead byte — not UTF-8, leave for Latin-1
  return (n - i) < need ? buf.subarray(0, i) : buf;       // incomplete tail → drop just that partial char
};

// Read at most maxBytes from the start of a file, without buffering the whole thing into memory.
const readFilePrefix = async (filePath, maxBytes) => {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, len - off, off);
      if (bytesRead === 0) break;   // short file / EOF
      off += bytesRead;
    }
    const out = off === len ? buf : buf.subarray(0, off);
    // If we stopped at the byte budget (more file remains), the cut may bisect a multi-byte UTF-8 character;
    // drop the partial tail so the buffer still decodes as UTF-8 instead of mis-falling-back to Latin-1.
    return (off === len && len < size) ? trimTrailingPartialUtf8(out) : out;
  } finally {
    if (fh) await fh.close();
  }
};

// Read at most maxBytes from the END of a file. Logs and other append-only text put the newest,
// most-relevant lines last, so when such a file exceeds the content cap we keep its tail rather than
// its head. Sized to the CHARACTER cap (not the 4x prefix budget) so the tail we keep is exactly what
// survives capText — reading more would only let capText trim the newest lines back off.
const readFileSuffix = async (filePath, maxBytes) => {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    if (len <= 0) return { buffer: Buffer.alloc(0), truncated: false };
    const buf = Buffer.allocUnsafe(len);
    const start = size - len;
    let off = 0;
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, len - off, start + off);
      if (bytesRead === 0) break;   // short read / EOF
      off += bytesRead;
    }
    let out = off === len ? buf : buf.subarray(0, off);
    const truncated = start > 0;   // we began past byte 0, so earlier content was dropped
    // When the window starts mid-file it almost certainly starts mid-line (and possibly mid-character):
    // drop everything up to and including the first newline so the kept text begins at a clean line, which
    // for UTF-8/ASCII logs also lands on a valid character boundary (avoiding a latin1 misdecode).
    if (truncated) {
      const nl = out.indexOf(0x0A);
      if (nl !== -1 && nl < out.length - 1) {
        out = out.subarray(nl + 1);
      } else {
        // No newline in the whole window (one enormous single line): the window almost certainly begins
        // mid-character. Skip any leading UTF-8 continuation bytes (0x80–0xBF) so decoding starts on a real
        // character boundary instead of misdecoding the entire buffer as latin1.
        let i = 0;
        while (i < out.length && i < 3 && (out[i] & 0xC0) === 0x80) i++;
        if (i > 0) out = out.subarray(i);
      }
    }
    return { buffer: out, truncated };
  } finally {
    if (fh) await fh.close();
  }
};

const isTextFile = (fileName) => {
  const excluded = ['.DS_Store', 'Thumbs.db', '.gitkeep'];
  if (excluded.includes(fileName)) return false;
  const lower = fileName.toLowerCase();
  if (SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;
  // Real document types this build can't yet extract are still discovered, so they are indexed by name (findable
  // and openable) rather than silently ignored. They have no parser branch, so processFileContent returns null
  // and loadSingleDocument records them as name-only — the "never drop a document" rule at discovery time.
  if (NAME_ONLY_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;
  // Images are indexable with OCR on (text extraction) OR vision-describe on
  // (content description) — otherwise every one would extract to nothing and fill
  // the corpus with empty documents.
  try {
    const c = require('../config');
    if (c.USE_OCR || c.VISION_DESCRIBE) { if (OCR_EXTENSIONS.some(ext => lower.endsWith(ext))) return true; }
    // Audio/video is indexable only with ingestion on — otherwise each would transcribe to nothing. It is
    // transcribed to text (a spoken lecture/meeting/podcast becomes a searchable document).
    if (c.useAudioIngest && MEDIA_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;
  } catch { /* config unavailable — treat as off */ }
  return false;
};

// Recursively list the indexable files under `dir`. A subfolder that can't be read (a permission
// blip, a symlinked folder whose target unmounted, or a folder removed mid-scan) is SKIPPED rather
// than aborting the whole scan — otherwise one bad subfolder empties the Documents panel and stalls
// indexing for the entire tree. When a `report` object is passed, such a skip sets `report.incomplete`
// so the caller HOLDS the affected documents (never purges them: "missing from the scan" must not be
// read as "deleted"). Callers that just want a best-effort listing (the Documents panel, off-active
// bundles) omit `report` and get the readable subtrees without a throw. Mirrors walkSource's contract.
const walkDirectory = async (dir, report) => {
  let files = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    if (report) report.incomplete = true;
    return files;   // skip this unreadable subtree, keep what the rest of the scan found
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(await walkDirectory(fullPath, report));
    else if (entry.isFile() && isTextFile(entry.name)) files.push(fullPath);
  }
  return files;
};

// ── Extra source folders ────────────────────────────────────────────────────
// Files in user-configured folders are indexed IN PLACE. Unlike data/documents —
// which the user curates — these can be large, noisy directories, so discovery is
// bounded by depth, file size, file count, and an exclusion list. Hidden files and
// directories are always skipped.
// Is any path segment an excluded name? Segment-aware rather than a bare substring
// check: "venv" must not exclude a folder called "venvironment", and "Library/" must
// not exclude "MyLibrary/". A pattern containing a slash is still matched as a path
// fragment so entries like "/AppData/" keep working.
const isExcluded = (fullPath) => {
  const norm = fullPath.replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  return srcCfg().SOURCE_EXCLUDE.some(pat => {
    const p = pat.replace(/\\/g, '/');
    if (p.includes('/')) {
      // Fragment pattern — normalize the edges so "/AppData/" and "Library/" both
      // match a real path segment rather than any substring.
      const parts = p.split('/').filter(Boolean);
      for (let i = 0; i + parts.length <= segments.length; i++) {
        if (parts.every((seg, j) => segments[i + j] === seg)) return true;
      }
      return false;
    }
    return segments.includes(p);
  });
};

// `report` (optional) is an out-parameter: when passed, `report.incomplete` is set true if the
// scan could not see the whole tree (a read error or the file cap), so the caller can hold
// documents rather than purge them. Kept as an out-param so the many callers that just want the
// file array are unaffected.
const walkSource = async (root, { recursive, maxDepth }, report) => {
  const { SOURCE_MAX_FILES, SOURCE_MAX_FILE_BYTES } = srcCfg();
  const found = [];
  let truncated = false;
  let readError = false;   // a subtree we couldn't fully enumerate → the scan is incomplete

  const walk = async (dir, depth) => {
    if (found.length >= SOURCE_MAX_FILES) { truncated = true; return; }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // Permission denied is common on macOS for ~/Documents and ~/Downloads when
      // running as a background service without Full Disk Access. Report it once,
      // clearly, rather than failing the whole index run.
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        console.warn(`⚠️  No permission to read ${dir}`);
        if (process.platform === 'darwin') {
          console.warn('   Grant Full Disk Access to your terminal (or node) in');
          console.warn('   System Settings → Privacy & Security → Full Disk Access.');
        }
      } else if (e.code === 'ENOENT') {
        console.warn(`⚠️  Source folder not found: ${dir}`);
      }
      // We could not read this folder, so the file list for this root is INCOMPLETE. The
      // caller uses this to hold documents rather than purge them (a permission blip or a
      // vanished subfolder must not drop indexed docs that are still really there).
      readError = true;
      return;
    }

    for (const entry of entries) {
      if (found.length >= SOURCE_MAX_FILES) { truncated = true; return; }
      if (entry.name.startsWith('.')) continue;           // hidden files/dirs
      const fullPath = path.join(dir, entry.name);
      if (isExcluded(fullPath)) continue;

      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) await walk(fullPath, depth + 1);
      } else if (entry.isFile() && isTextFile(entry.name)) {
        try {
          const st = await fs.stat(fullPath);
          if (st.size > SOURCE_MAX_FILE_BYTES) {
            // Record the skip in the shared report (same channel the documents-folder size cap uses), so an
            // oversized file in a user-added source folder is surfaced in the run summary rather than dropped
            // silently — the user otherwise believes it is searchable. Discovery-time skip (the file is never
            // read), so it is cheap and never a drop of readable content.
            skipReport.tooLarge.push(`${entry.name} (${Math.round(st.size / (1024 * 1024))} MB)`);
            continue;
          }
          found.push(fullPath);
        } catch { /* unreadable — skip */ }
      }
    }
  };

  await walk(root, 0);
  if (truncated) {
    console.warn(`⚠️  ${root}: stopped at ${SOURCE_MAX_FILES} files (sourceMaxFiles). Narrow the folder or raise the limit.`);
  }
  // When we hit the file cap or couldn't read part of the tree, the returned list may be
  // missing files that really exist, so a purge based on it would wrongly drop indexed docs.
  if (report) report.incomplete = truncated || readError;
  return found;
};

// All files to index: the curated documents directory plus every configured source.
// De-duplicated by absolute path so overlapping sources don't index a file twice.
const collectAllFiles = async (docsDir) => {
  const seen = new Set();
  const all = [];
  // Roots whose scan was INCOMPLETE this pass (a read error or the file cap). The caller must
  // not purge indexed documents under these — the list may simply be missing files that exist.
  const incompleteRoots = [];

  const add = (list) => {
    for (const f of list) {
      const resolved = path.resolve(f);
      // On Windows the filesystem is case-insensitive, so two overlapping roots that differ only in
      // path/drive-letter case name the same file — fold the dedup KEY there so it isn't indexed twice
      // (mirrors the fold in lib/paths.js isWithin). The real path is kept for reading.
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (!seen.has(key)) { seen.add(key); all.push(resolved); }
    }
  };

  // Scan the curated documents directory. walkDirectory now skips any unreadable subtree (rather than
  // throwing), so the readable documents still index; `docsReport.incomplete` is set when any subtree
  // (or the root) couldn't be read, which marks docsDir incomplete so its documents are HELD, not purged.
  const docsReport = {};
  try {
    add(await walkDirectory(docsDir, docsReport));
  } catch {
    docsReport.incomplete = true;   // an unexpected error — hold rather than risk a purge
  }
  if (docsReport.incomplete) incompleteRoots.push(path.resolve(docsDir));

  const { SOURCE_PATHS, DEBUG } = srcCfg();
  for (const src of SOURCE_PATHS) {
    const report = {};
    const files = await walkSource(src.path, src, report);
    if (files.length > 0 && DEBUG) {
      console.log(`  📂 Source ${src.path} — ${files.length} file(s)${src.recursive ? ` (recursive, depth ${src.maxDepth})` : ''}`);
    }
    if (report.incomplete) incompleteRoots.push(path.resolve(require('../config').expandHome(src.path)));
    add(files);
  }

  return { files: all, incompleteRoots };
};

// Count files a source would contribute, without indexing. Used by the settings UI
// so the user sees the scale before committing to a folder.
// Count files a source would contribute, without indexing. Used by the settings UI
// so the user sees the scale before committing to a folder.
//
// Unreadable folders are reported rather than counted as zero: walkSource swallows
// errors by design (one bad folder shouldn't fail a whole index run), but here the
// difference between "no supported files" and "couldn't read this at all" is exactly
// what the user needs to know — otherwise a permission failure looks identical to an
// empty folder and Add appears to do nothing.
const previewSource = async (dirPath, opts = {}) => {
  const resolved = path.resolve(require('../config').expandHome(dirPath));

  // Probe the folder directly first so a real access problem becomes an error.
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) {
      const e = new Error('That path is a file, not a folder');
      e.code = 'ENOTDIR';
      throw e;
    }
    await fs.readdir(resolved);          // surfaces EACCES/EPERM/EIO
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'Folder not found'
      : (e.code === 'EACCES' || e.code === 'EPERM')
        ? (process.platform === 'darwin'
            ? 'No permission to read that folder — grant Full Disk Access in System Settings → Privacy & Security'
            : 'No permission to read that folder')
      : e.code === 'ENOTDIR' ? e.message
      : `Could not read that folder (${e.code || e.message})`;
    const err = new Error(msg);
    err.code = e.code;
    throw err;
  }

  const files = await walkSource(resolved, {
    recursive: opts.recursive === true,
    maxDepth: Number.isInteger(opts.maxDepth) ? opts.maxDepth : 3,
  });
  let bytes = 0;
  // Bound the concurrent stat() calls so a large source folder can't open thousands of file handles
  // at once (parity with the hash-concurrency window used during indexing).
  const statGate = require('../semaphore').createSemaphore({ max: 16 });
  await Promise.all(files.map(f => statGate.run(async () => { try { bytes += (await fs.stat(f)).size; } catch {} })));

  // When nothing is indexable, say what IS there. A folder full of media or archives
  // looks identical to an empty one from a bare count, and that ambiguity has been
  // the hardest part of diagnosing "I added a folder and nothing happened".
  let otherTypes = [];
  let otherCount = 0;
  if (files.length === 0) {
    try {
      const seen = new Map();
      const scan = async (dir, depth) => {
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) {
            if (opts.recursive === true && depth < 2) await scan(path.join(dir, e.name), depth + 1);
          } else {
            const ext = (path.extname(e.name) || '(no extension)').toLowerCase();
            seen.set(ext, (seen.get(ext) || 0) + 1);
            otherCount++;
          }
        }
      };
      await scan(resolved, 0);
      otherTypes = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([ext, n]) => `${n} ${ext}`);
    } catch { /* best effort — the count is what matters */ }
  }

  return {
    path: resolved, count: files.length, bytes,
    atLimit: files.length >= srcCfg().SOURCE_MAX_FILES,
    otherCount, otherTypes,
  };
};

// Hash a file by STREAMING it through SHA-256 rather than reading the whole thing into
// memory and hashing the buffer. On a large corpus the old approach held every file's
// bytes resident at once (the caller hashes many files together) and ran a synchronous
// hash over big buffers, spiking memory and stalling the event loop; streaming keeps only
// a chunk resident and yields between chunks.
const hashFile = (filePath) => new Promise((resolve, reject) => {
  const stream = require('fs').createReadStream(filePath);
  const h = crypto.createHash('sha256');
  stream.on('error', reject);
  stream.on('data', (chunk) => h.update(chunk));
  stream.on('end', () => resolve(h.digest('hex')));
});

// Turn a PDF's extracted text into the final content, running OCR when the PDF looks like a scan (no usable
// text layer). A thin wrapper over the shared ocr.ocrPdfCombined leaf — the single home for scan-detection, the
// content-hash OCR cache, and the combine — which the isolated-parse child (extractcore) calls too, so the logic
// genuinely lives in one place. `cacheDir` targets a non-active workspace's own cache when warming one; omitted,
// it follows the active workspace. Best-effort — any OCR failure returns whatever text there was.
const ocrPdfFallback = (buffer, baseText, pages, fileName = '', cacheDir = null) =>
  require('../ocr').ocrPdfCombined(buffer, baseText, pages, { fileName, cacheDir });

// `cacheDir` (optional): the workspace cache directory the OCR results belong in. Omitted for the
// active workspace (the caches follow the live CACHE_DIR); set when warming a NON-active workspace so
// its OCR is cached in that workspace's own directory rather than the active one's.
const processFileContent = async (buffer, ext, fileName = '', cacheDir = null) => {
  const extractcore = require('./extractcore');
  try {
    switch (ext.toLowerCase()) {
      case '.txt':
      case '.md':
      case '.log':
        // Cap like every heavy format, so a very large plain-text file can't explode into hundreds of
        // thousands of chunks or stall the event loop on the main process (it is not isolated). Log
        // files are plain text and index as-is — BM25 tokenizes their lines the same as prose.
        return capText(decodeTextBuffer(buffer));
      case '.html':
      case '.htm': {
        // Reuse the readable-text extractor built for web search — it already
        // strips scripts/styles, converts block tags to newlines, and decodes
        // entities, which is exactly what's needed for a saved HTML page. Cap the INPUT first, so its
        // several sequential full-string regex passes can't multiply a huge file into gigabytes of
        // transient strings and freeze the event loop (this runs inline, not in the isolation child).
        const { _extractReadableText } = require('../websearch');
        return _extractReadableText(capText(decodeTextBuffer(buffer)));
      }
      case '.pdf': {
        // Extract the text layer (shared with the isolated-parse path), then OCR if it's a scan.
        const { text, pages } = await extractcore.extractPdf(buffer);
        return await ocrPdfFallback(buffer, text, pages, fileName, cacheDir);
      }
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.webp':
      case '.tif':
      case '.tiff': {
        const cache = require('../ocrcache');
        const key = cache.keyFor(buffer);
        const cached = cache.get(key, cacheDir);
        if (cached !== null) return cached;
        const recognized = await require('../ocr').ocrImage(buffer, fileName);

        // Vision-describe (optional, off by default): if the image has little or no
        // extractable text, it would index as an empty, unsearchable document. When
        // enabled with a selected model, ask a vision model what the image depicts
        // so it becomes findable by content. Best-effort — any failure falls back to
        // whatever OCR produced (possibly nothing), never breaking indexing.
        let out = recognized || '';
        const vision = require('../vision');
        if (vision.isEnabled() && out.trim().length < 16) {
          try {
            const desc = await vision.describeImage(buffer);
            const block = vision.toIndexText(desc);
            if (block) out = out.trim() ? `${out}\n\n${block}` : block;
          } catch (e) {
            console.error(`   👁️  Vision describe skipped for ${fileName}: ${e.message}`);
          }
        }
        cache.set(key, out, cacheDir);
        return out;
      }
      case '.docx':
        return await extractcore.extractDocx(buffer);
      case '.pptx':
        // A PPTX is a ZIP of slide XML; the extractor pulls each slide's text runs (and
        // speaker notes) in order. Embedded images are described separately by visual ingest.
        return await extractcore.extractPptx(buffer);
      case '.epub':
        // An EPUB is a ZIP of XHTML chapters; the extractor reads the spine for
        // reading order and strips each chapter to text (reusing the HTML extractor).
        return await extractcore.extractEpub(buffer);
      case '.csv':
      case '.tsv':
        // Delimited text is already searchable as-is — the cell values are the
        // content, and BM25 tokenizes them the same as prose. No parsing needed. Capped like the rest so a
        // giant CSV/TSV can't balloon chunk count or stall the main process.
        return capText(decodeTextBuffer(buffer));
      case '.json': {
        // Indexed as raw text so keys and values are both searchable. Pretty-print if it
        // parses (so minified single-line JSON still chunks sensibly on newlines); fall
        // back to the raw bytes if it's malformed rather than dropping the document. A
        // large JSON is parsed in a worker so it can't stall the event loop.
        const text = decodeTextBuffer(buffer);
        if (buffer.length > JSON_WORKER_THRESHOLD) return await require('./parseworker').parseJson(text);
        // Small JSON: pretty-print inline through the shared helper, which caps the output length so a
        // re-indentation can't balloon memory (the worker path above caps the same way).
        return require('./parsecore').jsonToText(text);
      }
      case '.xlsx':
      case '.xlsm':
        // Each sheet is flattened to labeled CSV so a workbook becomes one searchable text
        // document. XLSX parsing is synchronous and can be heavy, so it runs in a worker
        // (falling back to an inline parse if the worker is unavailable).
        return await require('./parseworker').parseXlsx(buffer);
      default:
        return null;
    }
  } catch (e) {
    console.error(`Error processing ${ext}:`, e);
    return null;
  }
};

// Heavy formats whose parser can hang or OOM the main process on a crafted file. An uploaded attachment is
// untrusted, so these are parsed in the isolated child rather than inline. Derived from extractcore's ISOLATABLE
// set MINUS images, so a new heavy format added to the main pipeline's isolation list is isolated on the upload
// path too (rather than silently parsed inline). Images stay inline: their OCR runs in Tesseract's own workers
// and the inline path also does vision-describe, which the child's scrubbed environment cannot. Memoized on
// first use; required lazily (matching this file's other extractcore uses).
let _isolateOnUpload = null;
const isolateOnUpload = () => {
  if (!_isolateOnUpload) {
    const ec = require('./extractcore');
    _isolateOnUpload = new Set([...ec.ISOLATABLE].filter((e) => !ec.IMAGE_EXTS.has(e)));
  }
  return _isolateOnUpload;
};

// Extract text from an uploaded buffer (the one-off "attach" path, which does not go through
// loadSingleDocument). Heavy formats are isolated in the capped child by staging the buffer to a
// temp file; a fork failure falls back to inline parsing, while a child that starts and then dies or
// times out means the file is too heavy or crafted and is reported as unreadable rather than retried
// inline (which would reintroduce the very main-process hang the isolation prevents).
const extractUploadText = async (buffer, ext, fileName = '') => {
  const lc = String(ext || '').toLowerCase();
  if (!isolateOnUpload().has(lc)) return processFileContent(buffer, ext, fileName);
  // Stage into DATA_DIR/tmp/uploads with a .tmp suffix, NOT the OS temp dir with the document's own extension:
  // the stale-temp watchdog scans that directory for orphaned *.tmp files, so a hard crash between the write and
  // the unlink below is reclaimed (never-orphan), whereas a file in the OS temp dir with a .pdf/.docx name is
  // invisible to it. The child is handed the real extension (lc) explicitly, so the temp name needn't carry it.
  const uploadsTmp = path.join(require('../config').DATA_DIR, 'tmp', 'uploads');
  const tmp = path.join(uploadsTmp, `lokyni-attach-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.mkdir(uploadsTmp, { recursive: true });
    await fs.writeFile(tmp, buffer);
    const result = await require('./extractprocess').extractInChild(tmp, lc);
    return (result && result.text) || '';
  } catch (e) {
    if (e && e.forkFailed) return processFileContent(buffer, ext, fileName);
    const err = new Error('That file could not be processed safely — it was too large or too complex to parse.');
    err.safeParseFailure = true;
    throw err;
  } finally {
    try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
  }
};

// `opts.workspaceId` names the workspace this document is being loaded FOR. It matters only on
// the bundle-warm fallback that re-extracts a NON-active workspace (the API path): the isolated
// child otherwise defaults to the active workspace and would cache its OCR into the wrong
// workspace's directory. Omit it for the normal active-workspace path.
const loadSingleDocument = async (filePath, targetParentMap, opts = {}) => {
  const stats = await fs.stat(filePath);
  const ext = path.extname(filePath);
  const cfg = srcCfg();
  // Audio/video is transcribed by STREAMING the decode (ffmpeg / the native WAV reader never hold the file in
  // memory), so it is exempt from the in-memory size cap below — a long recording is bounded by its duration
  // cap and the per-segment transcription, not by fitting the whole file in RAM.
  const isMedia = cfg.useAudioIngest === true && require('./audioingest').isMediaExt(ext);
  // Very small files carry no useful signal and would pollute the index. This is a
  // silent drop, so it's reported — a folder of short notes otherwise looks like it
  // indexed fine while contributing nothing.
  if (stats.size < MIN_FILE_SIZE) {
    skipReport.tooSmall.push(path.basename(filePath));
    return null;
  }
  // Refuse to read an oversized file into memory — doing so could OOM and crash the whole
  // server. Reachable only by dropping a very large file straight into the documents folder
  // (uploads are capped upstream). Skipped with a report rather than risking the process.
  // Media is exempt: it is never read whole into memory (it streams through the decoder).
  if (stats.size > MAX_FILE_SIZE && !isMedia) {
    skipReport.tooLarge.push(`${path.basename(filePath)} (${Math.round(stats.size / (1024 * 1024))} MB)`);
    return null;
  }

  const extractcore = require('./extractcore');
  let content = null;

  // When warming a NON-active workspace (the bundle-fallback path passes opts.workspaceId), cache the
  // OCR, visual-ingest, and summary results into THAT workspace's own directory rather than the active
  // one's. Otherwise a background warm pollutes the active workspace's caches and — worse — saves the
  // figure crops into the active directory while the manifest that references them is persisted to the
  // target workspace, so those figures would never be found. Null for the normal active path, where the
  // caches follow the live CACHE_DIR as before.
  let cacheDir = null;
  if (opts.workspaceId) {
    try {
      const target = require('../workspaces').cacheDirFor(cfg.DATA_DIR, opts.workspaceId);
      if (target && target !== cfg.CACHE_DIR) cacheDir = target;
    } catch { /* fall back to the active cache dir */ }
  }

  // Large heavy-format documents are parsed in an isolated, memory-capped child process so a
  // huge or malformed file can never grow the server toward an out-of-memory crash (see
  // extractprocess.js). Small files parse inline — no child overhead. Non-blocking either way:
  // while the child parses, the server's event loop stays free.
  const lcExt = ext.toLowerCase();
  const isolate = cfg.useParseIsolation !== false
    && extractcore.ISOLATABLE.has(lcExt)
    // Most formats isolate only past the large-file threshold (their hazard is memory, which scales
    // with size); a few isolate at any size because their hazard is crafted content, not size.
    && (extractcore.ALWAYS_ISOLATE.has(lcExt) || stats.size >= (cfg.parseIsolationMinBytes || 0));

  // Set when the isolated parse and all its gentler retries failed (a crash, a timeout, or OCR that could
  // not fit memory even single-worker). Such a document may become fully parseable on a later run — a
  // bigger machine, more free memory, or raised limits — so if it ends up indexed by name it is marked
  // retry-pending rather than frozen, exactly like a transient embed failure. A document that simply has
  // no text to extract (OCR off, or OCR ran and found none) is NOT a failure and stays settled.
  let isolateFailed = false;
  if (isMedia) {
    // Transcribe the media to text — the transcript becomes the document's content, indexed by the normal
    // pipeline (chunked, embedded, cited) exactly like any text document. Streamed and bounded inside the
    // helper; a null result (ffmpeg unavailable, undecodable, or a silent recording) falls through to name-only
    // indexing below, so a media file is never dropped.
    const maxSeconds = (cfg.audioMaxMinutes || 180) * 60;
    content = await require('./audioingest').transcribeMediaFile(filePath, { language: cfg.sttLanguage, cacheDir, maxSeconds });
  } else if (isolate) {
    try {
      // The child does everything memory-heavy or native, including OCR for a scanned PDF or
      // an image, so its text is final here — no further parsing in the server process.
      const result = await require('./extractprocess').extractInChild(filePath, ext, { workspaceId: opts.workspaceId });
      content = result ? result.text : null;
      mergeSkipReport(result && result._skips);   // surface any truncation the child recorded (e.g. PDF page cap)
      if (cfg.DEBUG) console.log(`   🧩 Parsed ${path.basename(filePath)} in an isolated process`);
    } catch (e) {
      if (e && e.forkFailed) {
        // This environment can't fork a helper — parse inline rather than never index the file.
        if (cfg.DEBUG) console.log(`   ⚠️  Parse isolation unavailable (${e.message}) — parsing ${path.basename(filePath)} inline`);
        const buffer = await fs.readFile(filePath);
        content = await processFileContent(buffer, ext, filePath, cacheDir);
      } else {
        // The isolated parse started but couldn't finish — usually an OCR pass on a scanned PDF that
        // exceeded the child's memory budget, or a crash. Do NOT retry it inline (that could OOM the
        // server), and do NOT drop the document. Escalate through gentler attempts so a memory overrun
        // never costs the document's content: (1) retry OCR with a single worker, which needs the least
        // memory and reads the full scan just more slowly; (2) if that still fails, retry text-layer-only,
        // which is cheap and bounded and captures any embedded text; (3) a document with genuinely no
        // extractable text is indexed by name below. A file is only ever excluded when it is empty, too
        // small, or unreadable — never merely because one parse pass was too heavy.
        const extractInChild = require('./extractprocess').extractInChild;
        const base = path.basename(filePath);
        content = null;
        isolateFailed = true;   // a parse failure, not a genuine no-text document (see isolateFailed above)
        // (1) Single-worker OCR — the least memory, reads the full scan just more slowly. Skip it when this
        //     host already OCRs single-worker (a small/low-memory machine), because the first attempt was
        //     already single-worker and an identical retry would only burn another full timeout.
        let singleWorkerHost = false;
        try { singleWorkerHost = require('../ocr').recommendedWorkers() <= 1; } catch { /* assume multi */ }
        if (!singleWorkerHost) {
          if (cfg.DEBUG) console.log(`   ⚠️  Isolated parse failed for ${base} (${e.message}) — retrying OCR with a single worker`);
          try {
            const result = await extractInChild(filePath, ext, { workspaceId: opts.workspaceId, ocrMaxWorkers: 1 });
            content = result ? result.text : null;
            mergeSkipReport(result && result._skips);
          } catch (e2) {
            if (cfg.DEBUG) console.log(`   ⚠️  Single-worker OCR failed for ${base} (${e2.message})`);
            content = null;
          }
        }
        // (2) Text-layer-only — no OCR at all, so it cannot overrun memory. Captures any embedded text; a
        //     true image scan comes back empty and is indexed by name below.
        if (!content || !content.trim()) {
          if (cfg.DEBUG) console.log(`   ⚠️  ${base}: retrying text-layer only (no OCR)`);
          try {
            const result = await extractInChild(filePath, ext, { workspaceId: opts.workspaceId, ocr: false });
            content = result ? result.text : null;
            mergeSkipReport(result && result._skips);
          } catch (e3) {
            if (cfg.DEBUG) console.log(`   ⚠️  Text-only retry also failed for ${base} (${e3.message}) — will index by name`);
            content = null;
          }
        }
      }
    }
    // A heavy format (PDF/DOCX/PPTX/EPUB/XLSX/JSON) capped by capText's 16 MB char limit comes back with the
    // TRUNC_MARK appended. Surface it so a book-length document silently losing its tail is reported in the run
    // summary — parity with the plain-text branch below, which reports its own cut.
    if (typeof content === 'string' && content.endsWith(TRUNC_MARK)) reportTextTruncated(path.basename(filePath), 'beginning');
  } else {
    // A plain-text format reads only a bounded slice (it is capped to MAX_TEXT_CHARS anyway, and is not
    // isolated in a memory-capped child); any other format reaching here is an isolatable one below the
    // isolation threshold, so it is small and safe to read whole.
    const lcExtText = ext.toLowerCase();
    if (TEXT_PREFIX_EXTS.has(lcExtText)) {
      if (lcExtText === '.log') {
        // Logs are append-only: the newest lines (the ones a user searches for when hunting recent
        // errors) are at the END, so read the tail instead of the head when the file exceeds the cap.
        const { buffer, truncated } = await readFileSuffix(filePath, MAX_TEXT_CHARS);
        content = await processFileContent(buffer, ext, filePath, cacheDir);
        if (truncated) reportTextTruncated(path.basename(filePath), 'most recent lines');
      } else {
        // Prose and delimited data read top-down, so keep the head. Report the cut so it is never silent.
        // The cut happens two ways: the file is larger than the byte budget we read (buffer < file), OR
        // the decoded text exceeded the character cap and capText trimmed it (which appends TRUNC_MARK).
        // The byte-budget check alone misses a file between the character cap and the byte budget — read
        // whole, but still trimmed by capText — so check the marker too.
        const buffer = await readFilePrefix(filePath, TEXT_READ_MAX_BYTES);
        content = await processFileContent(buffer, ext, filePath, cacheDir);
        if (buffer.length < stats.size || (typeof content === 'string' && content.endsWith(TRUNC_MARK))) {
          reportTextTruncated(path.basename(filePath), 'beginning');
        }
      }
    } else {
      const buffer = await fs.readFile(filePath);
      content = await processFileContent(buffer, ext, filePath, cacheDir);
    }
  }

  // Visual ingest (opt-in): make a document's visual content searchable with the vision model.
  // For a PDF, each page is rendered and its figures/charts/tables described; for a DOCX or
  // PPTX (no page renderer), the images embedded in the file are described. Runs in this
  // (parent) process because vision needs the provider client, and covers both the isolated
  // and inline parse paths uniformly. Best-effort and size-capped inside the helper, so it can
  // neither break indexing nor risk the server's memory. Placed before the empty check so a
  // figure-only document with no text layer can still be indexed by its visuals.
  const lext = ext.toLowerCase();
  let figures = null;
  // Size-gate BEFORE reading the file, using the stat we already have — otherwise a large
  // isolated-parse file (kept out of the main process on purpose) would be read fully into
  // memory here just for the helper to reject it, reintroducing the OOM isolation prevents.
  const visualMaxBytes = Number.isFinite(cfg.visualIngestMaxBytes) ? cfg.visualIngestMaxBytes : Infinity;
  if (cfg.useVisualIngest && (lext === '.pdf' || lext === '.docx' || lext === '.pptx') && stats.size <= visualMaxBytes) {
    try {
      const buffer = await fs.readFile(filePath);
      const r = lext === '.pdf'
        ? await require('./visualdocs').describePdfVisuals(buffer, filePath, cacheDir)
        : await require('./officedocs').describeOfficeImages(buffer, filePath, cacheDir);
      const block = r && r.text;
      if (block) content = (content && content.trim()) ? `${content}\n\n${block}` : block;
      // The cropped-figure manifest rides on the document's metadata (persisted in
      // parent-map.json), so the UI can show each figure on a cited source without re-running
      // vision on a warm start.
      if (r && Array.isArray(r.figures) && r.figures.length) figures = r.figures;
    } catch (e) {
      if (cfg.DEBUG) console.log(`   🖼️  Visual ingest skipped for ${path.basename(filePath)}: ${e.message}`);
    }
  }

  // Isolated-image vision fallback. The isolation child runs OCR only — vision-describe needs
  // the provider client, which lives in this (parent) process — so a large image (>= the
  // isolation threshold) whose OCR text is empty would be dropped even with vision-describe on,
  // exactly the feature meant to make such an image searchable. Mirror the inline image path
  // here for the isolated case, size-gated by the same visual cap and cached so a later
  // reprocess of the same bytes is a hit. Best-effort — a failure just leaves the empty text.
  if (isolate && extractcore.IMAGE_EXTS.has(lext) && (!content || content.trim().length < 16)) {
    const vision = require('../vision');
    if (vision.isEnabled() && stats.size <= visualMaxBytes) {
      try {
        const buffer = await fs.readFile(filePath);
        const desc = await vision.describeImage(buffer);
        const block = vision.toIndexText(desc);
        if (block) {
          content = (content && content.trim()) ? `${content}\n\n${block}` : block;
          const cache = require('../ocrcache');
          try { cache.set(cache.keyFor(buffer), content, cacheDir); } catch { /* cache is best-effort */ }
        }
      } catch (e) {
        if (cfg.DEBUG) console.log(`   👁️  Vision describe skipped for ${path.basename(filePath)}: ${e.message}`);
      }
    }
  }

  // Document summary (collapsed-tree hierarchical index, opt-in): append a short, labeled,
  // model-written summary to the indexed text so a broad question retrieves it and the model
  // reads a coherent synthesis of the document. Generated from the extracted text (including
  // any visual-ingest block) so it reflects the whole document; cached by content hash and
  // best-effort, so it can never block or break indexing. Runs after visual ingest so figures
  // are reflected in the summary.
  if (cfg.useDocumentSummaries && content && content.trim()) {
    try {
      const block = await require('./summaryindex').summaryBlockFor(content, filePath, cacheDir);
      if (block) content = `${content}\n\n${block}`;
    } catch (e) {
      if (cfg.DEBUG) console.log(`   🧭 Summary skipped for ${path.basename(filePath)}: ${e.message}`);
    }
  }

  let indexedByName = false;
  if (!content || content.trim().length === 0) {
    // No extractable text — usually a pure image scan with no text layer, or a parse that could not
    // complete. Don't drop the document: index it by its file name so it still appears in the corpus and
    // can be opened, cited, and summarized. A humanized name gives keyword and vector search something real
    // to match instead of an empty document. Recorded as name-only so the end-of-run summary is accurate.
    const humanized = path.basename(filePath, path.extname(filePath)).replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
    content = humanized || path.basename(filePath);
    indexedByName = true;
    skipReport.nameOnly.push(path.basename(filePath));
  }

  const docId = docIdFor(filePath);
  const metadata = {
    docId,
    source: filePath,
    timestamp: stats.birthtime,
    fileType: ext.slice(1).toUpperCase(),
    docLength: content.length,
  };
  if (indexedByName) metadata.indexedByName = true;   // findable by name only; no extractable text
  if (figures) metadata.figures = figures;   // cropped-figure manifest for the UI (persisted)
  // Advisory credibility flags, computed once from the filename and indexed text: a preprint host/DOI or
  // retraction/concern language. Stored with the document so every citation shows the same neutral labels
  // without re-scanning the text on each answer. Local, bounded, and never a ranking or removal signal.
  try {
    const credibility = require('../credibility').flagsFor({ source: filePath, title: path.basename(filePath), text: content });
    if (credibility) metadata.credibility = credibility;
  } catch { /* advisory only — never block indexing */ }

  targetParentMap.set(docId, { content, metadata });
  // `parsePending` tells the caller this is a name-only entry that resulted from a parse/OCR FAILURE (not a
  // genuine no-text document), so it should be recorded retry-pending (no fileHash) and re-attempted on the
  // next index rather than frozen. It is a return-only signal, deliberately NOT stored in the parentMap
  // entry's metadata — the manifest drives the retry, and a stale persisted flag would be misleading.
  return { docId, content, metadata, parsePending: indexedByName && isolateFailed };
};

module.exports = { docIdFor, reportTruncated, reportTextTruncated, mergeSkipReport, walkDirectory, walkSource, collectAllFiles, previewSource, hashFile, processFileContent, extractUploadText, loadSingleDocument, resetSkipReport, getSkipReport, readFilePrefix, readFileSuffix, TEXT_PREFIX_EXTS, TEXT_READ_MAX_BYTES };
