'use strict';

// ── desktopdrop — ingest files DROPPED onto the desktop window ───────────────────────────────────────────
//
// The Tauri shell handles the OS file drop natively (src-tauri/src/main.rs) and hands the absolute paths to this
// process over its private stdin pipe — the same trusted channel used for the cooperative "quit" line. We do it
// this way, rather than the webview's HTML5 drag-and-drop, because recent WebKitGTK no longer exposes dropped
// files to the page's `dataTransfer` on Linux (a deliberate WebKit security change, CVE-2025-13947), so a DOM
// drop there silently delivers zero files. Taking the drop natively works on every platform.
//
// Each dropped path is copied into the ACTIVE workspace's documents directory — exactly where an HTTP upload
// lands (lib/routes/documents.js) — and then the workspace is reindexed, so the file becomes a searchable,
// citable document and the UI refreshes the same way an upload does. Unsupported types, oversized files, and
// anything that is not a readable file are skipped, never thrown — one bad drop must never break the server.

const fs = require('fs');
const path = require('path');

// The extensions accepted for a drop, matching the upload route's fileFilter exactly: the base supported set,
// plus images only when OCR or vision-describe can read them, plus audio/video only when media ingestion is on
// (otherwise those would index as empty). Read live so a Settings change is reflected on the next drop.
const allowedExtensions = () => {
  const c = require('./config');
  const k = require('./constants');
  const set = new Set(k.SUPPORTED_EXTENSIONS);
  if (c.USE_OCR || c.VISION_DESCRIBE) for (const e of k.OCR_EXTENSIONS) set.add(e);
  if (c.useAudioIngest) for (const e of k.MEDIA_EXTENSIONS) set.add(e);
  return set;
};

// Copy the supported dropped files into the active workspace and reindex. Returns { added, skipped:[{name,reason}] }.
// Never throws.
const ingestLocalPaths = async (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) return { added: 0, skipped: [] };
  const cfg = require('./config');
  const wsm = require('./workspaces');
  const state = require('./state');
  const { safeStoredFilename } = require('./paths');
  const maxBytes = cfg.MAX_FILE_SIZE || require('./constants').DEFAULT_MAX_FILE_BYTES;
  const allowed = allowedExtensions();
  // The workspace the desktop window is currently showing (the same value the upload route falls back to).
  const wsId = (state && state.workspaceId) || wsm.DEFAULT_ID;
  const dir = wsm.docsDirFor(cfg.DATA_DIR, wsId);

  const skipped = [];
  let added = 0;
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* reflected below as copy failures */ }

  for (const raw of paths) {
    const abs = String(raw || '').trim();
    if (!abs) continue;
    const name = path.basename(abs);
    try {
      const st = await fs.promises.stat(abs).catch(() => null);
      if (!st || !st.isFile()) { skipped.push({ name, reason: 'not a file' }); continue; }
      const ext = path.extname(abs).toLowerCase();
      if (!allowed.has(ext)) { skipped.push({ name, reason: 'unsupported type' }); continue; }
      if (st.size > maxBytes) { skipped.push({ name, reason: 'too large' }); continue; }
      // safeStoredFilename is the same sanitizer the upload route uses, so a dropped name can't escape the docs
      // dir or collide with an index artifact.
      await fs.promises.copyFile(abs, path.join(dir, safeStoredFilename(name)));
      added += 1;
    } catch {
      skipped.push({ name, reason: 'could not be read' });
    }
  }

  if (added > 0) {
    // Reindex the workspace (or reconcile it if it is not the active one) exactly as an upload does, which also
    // emits the index-update the UI listens for, so the new documents appear without a manual refresh.
    try {
      await require('./indexing/init').reflectWorkspaceMutation(
        wsId,
        (id) => require('./indexing/bundle').reconcileWorkspaceDocsChange(id),
      );
    } catch { /* the files are on disk; the next boot sweep / manual reindex will still pick them up */ }
  }
  return { added, skipped };
};

module.exports = { ingestLocalPaths, allowedExtensions };
