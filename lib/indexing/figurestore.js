'use strict';
// On-disk store for cropped figure/table images (the "pixel cropping" phase of visual ingest).
//
// When figure cropping is on, each detected figure/table is cropped into its own PNG and
// saved here, next to the workspace's index, so the UI can show the actual figure on a cited
// source. Crops are addressed by a deterministic id derived from the file's content hash plus
// the page and figure index, so an unchanged document reuses its crops across restarts and a
// re-index never orphans or regenerates them needlessly. The whole directory is derived data:
// it is wiped with the vector store and travels inside a workspace backup.
//
// Ids are the storage key AND the value referenced from document metadata and the serving
// route, so they are validated strictly on the way back in (see isValidId) — the id can never
// widen into a path and read outside the figures directory.

const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');

// A figure id is <64-hex content-key>_p<page>_<n> — hex, "_p", digits, "_", digits only.
const ID_RE = /^[a-f0-9]{16,80}_p\d{1,6}_\d{1,4}$/;
const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
const makeId = (contentKey, page, n) => `${contentKey}_p${page}_${n}`;

const figuresDir = (cacheDir) => path.join(cacheDir, 'figures');
const cropPath = (cacheDir, id) => path.join(figuresDir(cacheDir), `${id}.png`);

// Does a crop already exist on disk? Used so a cache hit can confirm its crops are present
// before trusting them (a wiped figures dir with a warm text cache should re-crop).
const hasCrop = (cacheDir, id) => { try { return isValidId(id) && fsSync.existsSync(cropPath(cacheDir, id)); } catch { return false; } };

const saveCrop = async (cacheDir, id, pngBuffer) => {
  if (!isValidId(id) || !Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) return false;
  const dir = figuresDir(cacheDir);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write so an interrupted save can't leave a truncated PNG the UI would fail to load. If the write
  // or rename throws (disk full, interrupted), remove the temp file so it can't accumulate in the figures dir
  // on a churning folder; then rethrow so the caller still treats the crop as failed. The shared uniqueTmp
  // carries pid + crypto random (not a fixed `.${id}.png.tmp`) so two writers of the same id — e.g. if cropping
  // ever moves into the isolated parse child alongside the parent, as OCR already has — can't collide on a temp.
  const tmp = require('../disk').uniqueTmp(cropPath(cacheDir, id));
  try {
    await fs.writeFile(tmp, pngBuffer);
    await require('../disk').renameWithRetry(tmp, cropPath(cacheDir, id));
  } catch (e) {
    try { await fs.rm(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
  return true;
};

// Read a crop for serving. Returns a Buffer, or null if the id is invalid or the file is
// missing. The strict id check is what keeps this from ever reading outside the figures dir.
const readCrop = async (cacheDir, id) => {
  if (!isValidId(id)) return null;
  try { return await fs.readFile(cropPath(cacheDir, id)); } catch { return null; }
};

// Remove a single crop (best-effort) — called when its document is deleted or changed, so
// the figures directory doesn't accumulate orphans on a churning watched folder.
const remove = (cacheDir, id) => {
  if (!isValidId(id)) return;
  try { fsSync.rmSync(cropPath(cacheDir, id), { force: true }); } catch { /* best-effort */ }
};
// Remove the crops for a document's figure manifest ([{ id }] or [id]).
const removeMany = (cacheDir, figures) => {
  for (const f of (Array.isArray(figures) ? figures : [])) remove(cacheDir, f && f.id ? f.id : f);
};

// Remove the whole figures directory — called when the vector store is wiped.
const clear = (cacheDir) => { try { fsSync.rmSync(figuresDir(cacheDir), { recursive: true, force: true }); } catch { /* best-effort */ } };

module.exports = { isValidId, makeId, figuresDir, cropPath, hasCrop, saveCrop, readCrop, remove, removeMany, clear };
