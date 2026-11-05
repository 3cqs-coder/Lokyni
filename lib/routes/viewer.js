'use strict';
const fs   = require('fs').promises;
const path = require('path');
const MarkdownIt = require('markdown-it');
const { Router } = require('express');
const cfgPaths = require('../config');   // cfgPaths.DOCS_DIR read live
const { processFileContent } = require('../indexing/files');
const state = require('../state');

const router = Router();

// Which raw document types are SAFE to serve inline vs must force-download. A raw document is UNTRUSTED, so an
// `.html`/`.svg`/`.xml` served inline and same-origin could execute script against the app origin — only PDF
// (the viewer iframe) and raster images render inline; everything else downloads. Pure and exported so it is
// unit-tested directly: a source-only guard would survive a logic flip that moved a dangerous type into the
// inline set. Accepts an extension with or without a leading dot, any case.
const INLINE_SAFE_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const dispositionFor = (ext) => (INLINE_SAFE_EXTS.has(String(ext || '').toLowerCase().replace(/^\./, '')) ? 'inline' : 'attachment');

// SECURITY: a rendered document is UNTRUSTED content (uploaded, clipped from the web, or synced from a
// connector) and its HTML is emitted unescaped into the viewer page. `html: false` makes markdown-it
// escape any raw HTML in the source, and the default validateLink neutralizes javascript:/vbscript:/data:
// links, so a malicious document renders inert. These are the load-bearing defenses — never enable `html`
// (or add an HTML-emitting plugin) here without also running the output through a sanitizer first, or every
// uploaded .md file becomes stored XSS delivered to the viewer. `linkify: false` keeps bare URLs as plain
// text rather than auto-linking them.
const md = new MarkdownIt({ html: false, linkify: false });

// Decide whether the viewer may serve this path. Two conditions, either of which
// is sufficient — but both are strict:
//
//  1. The file lives under the curated documents directory, or under one of the
//     user's configured source folders (boundary-aware prefix match, so
//     "/data/documents-secret" doesn't match "/data/documents").
//  2. The file is present in the live index. This is the tighter check: only
//     documents Lokyni actually indexed can be viewed, which prevents a crafted or
//     symlinked path from reaching arbitrary files even inside an allowed folder.
//
// Requiring (2) alone would break viewing during a re-index, so (1) is kept as the
// boundary and (2) short-circuits it for anything already known.
const { isWithin, realWithin } = require('../paths');
const wsm = require('../workspaces');

// The workspace this request targets — the window's workspace (?workspace=<id>), validated (isValidId is
// the traversal guard), default active. Every allow-check is scoped to it, so a window viewing a
// non-active workspace can open ITS documents (which live outside the active workspace's folder) and only
// its own — never another workspace's files by omitting or spoofing the parameter.
const resolveWsId = (req) => {
  const w = req && req.query && req.query.workspace;
  // Require an EXISTING workspace, not merely a valid-format id, so an unknown-but-well-formed slug
  // falls back to the active workspace rather than resolving against a directory that was never created.
  // isValidId remains the traversal guard on the derived paths.
  return (w && wsm.exists(cfgPaths.DATA_DIR, w)) ? w : state.workspaceId;
};

// Reading a document requires at least viewer access to the workspace it belongs to, so a member can't open
// the raw bytes or rendered view of a workspace they are not a member of. Admins and the implicit single
// operator pass (see lib/authz); the login gate already ensures the request is authenticated.
const docRead = require('../authmiddleware').requireCapability('doc.read', { workspace: resolveWsId });

// The source folders configured for a workspace: the live config for the active one, its saved settings
// for a non-active one.
const sourcePathsFor = (wsId) => {
  try {
    if (wsId === state.workspaceId) return cfgPaths.SOURCE_PATHS.map(s => s.path);
    const ss = wsm.loadSettings(cfgPaths.DATA_DIR, wsId);
    if (!Array.isArray(ss.sourcePaths)) return [];
    return ss.sourcePaths
      .map(s => (typeof s === 'string' ? s : (s && s.path)))
      .filter(Boolean)
      .map(p => path.resolve(cfgPaths.expandHome(p)));
  } catch { return []; }
};

// Is abs an indexed document in the workspace? The live parentMap for the active one; the workspace's own
// manifest (a cheap JSON read) for a non-active one. Only used to gate files under a configured SOURCE
// folder (files under the workspace's own documents dir are always allowed), matching the prior rule.
const isIndexedIn = async (abs, wsId) => {
  if (wsId === state.workspaceId) {
    for (const [, entry] of state.parentMap) {
      if (entry?.metadata?.source && path.resolve(entry.metadata.source) === abs) return true;
    }
    return false;
  }
  try {
    const mfPath = path.join(wsm.cacheDirFor(cfgPaths.DATA_DIR, wsId), require('../constants').CACHE_FILES.manifest);
    const mf = await require('../indexing/manifest').loadManifestFrom(mfPath);
    for (const [p, e] of Object.entries(mf || {})) {
      if (p.startsWith('_') || !e || e.skipped) continue;
      if (path.resolve(p) === abs) return true;
    }
    return false;
  } catch { return false; }
};

const isAllowedPath = async (abs, wsId) => {
  if (isWithin(abs, wsm.docsDirFor(cfgPaths.DATA_DIR, wsId))) return true;
  if (sourcePathsFor(wsId).some(sp => isWithin(abs, sp))) return await isIndexedIn(abs, wsId);
  return false;
};

// Resolve symlinks and re-check containment. The textual isAllowedPath() check can pass for a
// symlink that LIVES inside an allowed folder but POINTS outside it, and fs.readFile/sendFile
// would then follow it out. Returning the real path (and serving/reading that) closes the
// escape. Returns the real path when it is still inside an allowed folder, else null.
const resolveAllowed = async (abs, wsId) => {
  try {
    // Resolve symlinks and re-check containment with realWithin, which realpaths BOTH the file and the allowed
    // roots. Resolving only the file (and comparing it to textual roots) wrongly 403s every document when the
    // data dir itself traverses a symlink — a synced/symlinked folder, or macOS where /tmp is a firmlink to
    // /private/tmp. The docs dir is always allowed; a configured source folder is allowed only when the file is
    // indexed (the same gate isAllowedPath applies, on the textual path the index was built with).
    const inDocs = await realWithin(abs, [wsm.docsDirFor(cfgPaths.DATA_DIR, wsId)]);
    if (inDocs) return inDocs;
    const inSource = await realWithin(abs, sourcePathsFor(wsId));
    if (inSource && await isIndexedIn(abs, wsId)) return inSource;
    return null;
  } catch { return null; }
};

// /document/raw — serves the raw file bytes
router.get('/raw', docRead, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing file path');
  const wsId = resolveWsId(req);
  // A malformed percent-escape makes decodeURIComponent throw; answer a clean 400 rather than letting it
  // surface as a generic 500 (and a logged "unhandled request error").
  let abs;
  try { abs = path.resolve(decodeURIComponent(filePath)); }
  catch { return res.status(400).send('Invalid file path'); }
  if (!(await isAllowedPath(abs, wsId))) {
    console.warn('Blocked path traversal attempt:', abs);
    return res.status(403).send('Forbidden');
  }
  const real = await resolveAllowed(abs, wsId);
  if (!real) { console.warn('Blocked path traversal attempt:', abs); return res.status(403).send('Forbidden'); }
  // A raw document is UNTRUSTED content (a web clip, a connector sync, an upload), so never let the browser
  // RENDER it inline where it could execute script against the app origin — an `.html` or `.svg` served inline
  // and same-origin would run its scripts (and could pull in a companion same-origin script, bypassing the
  // nonce CSP). Serve only a safe inline set — PDF (the viewer's iframe) and raster images — inline; force
  // every other type to download. `nosniff` stops a mislabeled/extension-spoofed file from being MIME-sniffed
  // into an executable type. The normal viewer never renders raw HTML/SVG anyway (it shows extracted text), so
  // this only hardens a direct open of the raw URL.
  const disposition = dispositionFor(path.extname(real));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Shared helper → RFC 6266 encoding (ASCII fallback + filename*=UTF-8''…), so a non-Latin document name
  // downloads with its real name instead of a string of percent-escapes (encodeURIComponent is the wrong
  // transform for a quoted filename= value). `disposition` is 'inline' or 'attachment'.
  res.setHeader('Content-Disposition', require('../contentdisposition').contentDisposition(path.basename(real), disposition));
  res.sendFile(real, (err) => { if (err && !res.headersSent) res.status(err.status === 404 ? 404 : 500).send('Error serving file'); });
});

// /document/view — renders the document in the viewer template
router.get('/view', docRead, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing file path');
  const wsId = resolveWsId(req);
  let abs;
  try { abs = path.resolve(decodeURIComponent(filePath)); }
  catch { return res.status(400).send('Invalid file path'); }
  if (!(await isAllowedPath(abs, wsId))) {
    console.warn('Blocked path traversal attempt:', abs);
    return res.status(403).send('Forbidden');
  }
  let stats;
  try { stats = await fs.stat(abs); } catch { return res.status(404).send('Document not found'); }
  // Resolve symlinks and re-check containment before reading the bytes (see resolveAllowed).
  const real = await resolveAllowed(abs, wsId);
  if (!real) { console.warn('Blocked path traversal attempt:', abs); return res.status(403).send('Forbidden'); }

  const ext      = path.extname(abs).toLowerCase();
  const fileName = path.basename(abs);
  const fileType = ext.slice(1).toLowerCase();
  const fileSize = (stats.size / 1024).toFixed(1);
  // A sprite id (see views/partials/icons.ejs), so the viewer title shows the same themeable, cross-platform
  // file-type icon as the document list and source pills — not a per-OS color emoji. Text documents share one
  // doc icon; structurally-different kinds get their own.
  const fileIcon = {
    pdf: 'ic-file-text', docx: 'ic-file-text', txt: 'ic-file-text', md: 'ic-file-text', log: 'ic-file-text',
    pptx: 'ic-file-slides', csv: 'ic-file-sheet', tsv: 'ic-file-sheet', xlsx: 'ic-file-sheet', xlsm: 'ic-file-sheet',
    epub: 'ic-file-book', json: 'ic-file-code', html: 'ic-web', htm: 'ic-web',
  }[fileType] || 'ic-file';
  // Carry the workspace through to the raw-bytes URL and the related panel so both stay scoped to it.
  const wsParam  = `&workspace=${encodeURIComponent(wsId)}`;
  const rawUrl   = `/document/raw?path=${encodeURIComponent(filePath)}${wsParam}`;

  // Cap what the viewer will read into memory and render synchronously. isAllowedPath permits any file
  // under the documents folder even if indexing itself would reject it as too large, so without this a
  // big text/markdown file would be fully buffered here and md.render would block the event loop for
  // every client. Above the cap, point the user at the raw-bytes download instead of rendering inline.
  // The document's id, so the viewer can fetch related documents AND (below) resolve a highlight that lands in
  // an appended block against the exact indexed text.
  let docId = null;
  try { docId = require('../indexing/files').docIdFor(abs); } catch (_) {}

  // Optional passage highlight range (char offsets into the extracted text), passed through from a source
  // citation so the viewer can scroll to and mark the exact passage the answer was drawn from.
  const hlStart = Number.parseInt(req.query.start, 10);
  const hlEnd   = Number.parseInt(req.query.end, 10);
  const highlight = Number.isFinite(hlStart) && Number.isFinite(hlEnd) && hlEnd > hlStart
    ? { start: hlStart, end: hlEnd }
    : null;

  const VIEWER_MAX_BYTES = 8 * 1024 * 1024;   // 8 MB — generous for a document, small enough to render fast
  let renderedContent = '', rawContent = '';
  if (fileType !== 'pdf') {
    try {
      // Show the CURRENT document: a fresh extraction of the live file. This stays up to date and never shows
      // the model-written summary / figure-description blocks the index appends for retrieval.
      let content = null;
      if (stats.size <= VIEWER_MAX_BYTES) { const buffer = await fs.readFile(real); content = await processFileContent(buffer, ext) || ''; }
      // Exception: a citation whose highlight range falls BEYOND the extracted body points into one of those
      // appended blocks, which exists only in the indexed content. For that one case, render the indexed content
      // so the highlight resolves instead of being dropped (these blocks exist only when the summary / visual
      // features are on). Scoped to the active workspace; the file must be indexed and its indexed text long
      // enough to contain the range.
      if (highlight && content != null && highlight.end > content.length && docId && wsId === state.workspaceId) {
        try {
          const entry = state.parentMap.get(docId);
          if (entry && typeof entry.content === 'string' && entry.content.length >= highlight.end) content = entry.content;
        } catch { /* keep the fresh body */ }
      }
      if (content == null || content.length > VIEWER_MAX_BYTES) {
        // Too large to render inline — point the user at the raw download instead of blocking the event loop.
        rawContent = `This file is too large to preview in the viewer${content == null ? ` (${(stats.size / (1024 * 1024)).toFixed(1)} MB)` : ''}. Use "Open raw" to download it.`;
      } else if (fileType === 'md') {
        renderedContent = md.render(content);
      } else {
        rawContent = content;
      }
    } catch (e) {
      // Show a generic message rather than the raw error text, matching the no-internals-to-clients
      // discipline used elsewhere. The detail still goes to the server log for diagnosis.
      if (require('../config').DEBUG) console.log(`  ⚠️  Viewer could not read ${abs}: ${e.message}`);
      rawContent = 'This document could not be read. It may have been moved, or its format is not viewable here — try the download.';
    }
  }

  res.render('document-viewer', {
    fileName, rawUrl, fileType,
    extLabel: ext.slice(1).toUpperCase(),
    fileSize, fileIcon, renderedContent, rawContent,
    highlight, docId, workspaceId: wsId,
    nonce: res.locals.nonce,
    // Embedded in the in-app source viewer (an iframe): hide this page's own toolbar so the
    // overlay's header is the only chrome.
    embed: req.query.embed === '1',
  });
});

router.dispositionFor = dispositionFor;   // exported on the router for direct unit testing
module.exports = router;
