'use strict';
const fs     = require('fs').promises;
const path   = require('path');
const multer = require('multer');
const { Router } = require('express');
const cfgPaths = require('../config');
const { realWithin } = require('../paths');
const state  = require('../state');
const { walkDirectory, docIdFor } = require('../indexing/files');
const { viewerLink } = require('../links');

const router = Router();

// Which workspace a request targets. Each window sends ?workspace=<id> for the workspace it is viewing;
// absent or invalid falls back to the active one, so an older client (or a window on the active
// workspace) behaves exactly as before. isValidId is the path-traversal guard for the docs/cache dirs
// derived from it. Reused by every document route so the panel manages the workspace its window shows.
const wsm = require('../workspaces');
const resolveWsId = (req) => {
  const w = req && req.query && req.query.workspace;
  // Require an EXISTING workspace, not merely a valid-format id, so a request carrying an
  // unknown-but-well-formed slug falls back to the active workspace instead of spawning an orphan
  // documents/cache directory. isValidId remains the traversal guard on the derived paths.
  return (w && wsm.exists(cfgPaths.DATA_DIR, w)) ? w : state.workspaceId;
};

// Per-workspace authorization for the document data plane. A caller must hold the right role IN THE TARGET
// workspace: viewer (doc.read) to list/attach/see related, editor (doc.write) to add, remove, or ingest a URL.
// Admins and the implicit single operator pass everything (see lib/authz). The login gate already guarantees
// the request is authenticated; these add the role check that the gate alone does not.
const authmw = require('../authmiddleware');
const docRead  = authmw.requireCapability('doc.read',  { workspace: resolveWsId });
const docWrite = authmw.requireCapability('doc.write', { workspace: resolveWsId });
// After a change to a workspace's documents: index now when it is the ACTIVE workspace (its index is
// live), otherwise reconcile that workspace's on-disk index so the change actually takes effect the next
// time it is opened/queried — a deleted document stops being retrieved and a new one becomes searchable,
// without running the active-only indexing pipeline. Never throws.
// Reflect a document mutation into the index through the shared, lock-serialized helper (see
// reflectWorkspaceMutation): it reindexes the active workspace or reconciles a non-active one's on-disk
// cache, deciding which at run time, and can never race a switch/rebuild/restore. The HTTP response is sent
// before this runs, so deferring behind a long lifecycle operation never blocks the request.
const reflectDocChange = (wsId) =>
  require('../indexing/init').reflectWorkspaceMutation(wsId, (id) => require('../indexing/bundle').reconcileWorkspaceDocsChange(id));

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      // Write into the TARGET workspace's documents dir (the window's workspace), not always the active
      // one. req.query is available here (it is parsed from the URL before the multipart body).
      const dir = wsm.docsDirFor(cfgPaths.DATA_DIR, resolveWsId(req));
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (_req, file, cb) => {
    cb(null, require('../paths').safeStoredFilename(file.originalname));
  },
});

const { CACHE_FILES } = require('../constants');   // single source for the index artifact filenames

const fileFilter = (_req, file, cb) => {
  const c = require('../config');
  const constants = require('../constants');
  // Images are accepted on the same condition the folder-indexing path uses: OCR
  // reads text from them, or vision-describe describes them. Without either, they'd
  // index as empty, so they stay rejected.
  const allowed = [...constants.SUPPORTED_EXTENSIONS];
  // Images need OCR or vision-describe; without either they'd index as empty, so they stay rejected.
  if (c.USE_OCR || c.VISION_DESCRIBE) allowed.push(...constants.OCR_EXTENSIONS);
  // Audio/video need ingestion on (they're transcribed to text); otherwise they'd index as empty.
  if (c.useAudioIngest) allowed.push(...constants.MEDIA_EXTENSIONS);
  const ext = path.extname(file.originalname).toLowerCase();
  allowed.includes(ext) ? cb(null, true)
    : cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`), false);
};

// Derive the upload cap from the same MAX_FILE_SIZE the indexer enforces, so the limit can't drift
// from config (and follows a user's maxFileBytes on restart) instead of a hardcoded third copy.
const upload = multer({ storage, fileFilter, limits: { fileSize: cfgPaths.MAX_FILE_SIZE || require('../constants').DEFAULT_MAX_FILE_BYTES } });

// GET /api/documents?workspace=<id>
router.get('/', docRead, async (req, res) => {
  try {
    const wsId = resolveWsId(req);
    const isActive = wsId === state.workspaceId;
    const docsDir = wsm.docsDirFor(cfgPaths.DATA_DIR, wsId);
    const files = await walkDirectory(docsDir);

    // "indexed" status per file. For the ACTIVE workspace the live in-memory parentMap is authoritative.
    // For a NON-active workspace, read that workspace's manifest (a cheap JSON read) rather than loading
    // its whole bundle — a file is indexed when the manifest has a non-skipped entry for it. Absent
    // manifest (never indexed) → nothing indexed yet, which is correct.
    let isIndexed;
    if (isActive) {
      isIndexed = (docId) => state.parentMap.has(docId);
    } else {
      const indexedIds = new Set();
      try {
        const mfPath = path.join(wsm.cacheDirFor(cfgPaths.DATA_DIR, wsId), CACHE_FILES.manifest);
        const mf = await require('../indexing/manifest').loadManifestFrom(mfPath);
        for (const [p, e] of Object.entries(mf || {})) {
          if (p.startsWith('_') || !e || e.skipped) continue;
          indexedIds.add(docIdFor(p));
        }
      } catch { /* no manifest yet — nothing indexed */ }
      isIndexed = (docId) => indexedIds.has(docId);
    }

    // Bound the concurrent stat() calls. A documents folder can hold many thousands of files, and
    // issuing one fs.stat per file at once spikes open file handles (more impactful on Windows). The
    // shared semaphore caps how many run together while still overlapping enough for speed.
    const { createSemaphore } = require('../semaphore');
    const gate = createSemaphore({ max: 16 });
    const docs = await Promise.all(files.map((filePath) => gate.run(async () => {
      const stats  = await fs.stat(filePath);
      const docId  = docIdFor(filePath);
      // Build the in-app viewer link from the shared builder (the same one citations use), so a
      // document-name click and a citation click can never point at different routes. The client adds
      // the window's `workspace` parameter when it opens, like every other in-app document link.
      const relPath = path.relative(docsDir, filePath).split(path.sep).join('/');
      return {
        name: path.basename(filePath),
        path: filePath,
        // Normalize to forward slashes so the client's tree builder (which splits on '/') nests
        // subfolders on every OS — path.relative yields backslashes on Windows.
        relPath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        indexed: isIndexed(docId),
        docId,
        viewerLink: viewerLink(filePath),
      };
    })));
    docs.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, documents: docs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/documents/indexed?path=<relPath>&workspace=<id>
// Cheap single-document indexed check, so a client can poll ONE just-added document (e.g. after adding a URL
// or YouTube transcript) without re-listing the WHOLE corpus. The full list walks the documents folder and
// stats every file; polling it on a timer re-paid that O(corpus) cost on every tick. This is O(1) for the
// active workspace (a parentMap lookup) and a single bounded manifest read for a non-active one. Same
// workspace + path-traversal guards as the list and the raw/delete routes. Returns { ok, indexed }.
router.get('/indexed', docRead, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ ok: false, error: 'Missing file path' });
    const wsId = resolveWsId(req);
    const docsRoot = path.resolve(wsm.docsDirFor(cfgPaths.DATA_DIR, wsId));
    let abs;
    try { abs = path.resolve(docsRoot, decodeURIComponent(filePath)); }
    catch { return res.status(400).json({ ok: false, error: 'Bad path' }); }
    const real = await realWithin(abs, [docsRoot]);
    if (!real) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const docId = docIdFor(real);
    let indexed = false;
    if (wsId === state.workspaceId) {
      indexed = state.parentMap.has(docId);   // the live map is authoritative for the active workspace
    } else {
      // Non-active workspace: read its manifest (a cheap JSON read) — a file is indexed when a non-skipped
      // entry maps to the same doc id. Absent manifest (never indexed) → not indexed, which is correct.
      try {
        const mfPath = path.join(wsm.cacheDirFor(cfgPaths.DATA_DIR, wsId), CACHE_FILES.manifest);
        const mf = await require('../indexing/manifest').loadManifestFrom(mfPath);
        for (const [p, e] of Object.entries(mf || {})) {
          if (p.startsWith('_') || !e || e.skipped) continue;
          if (docIdFor(p) === docId) { indexed = true; break; }
        }
      } catch { /* no manifest yet — not indexed */ }
    }
    res.json({ ok: true, indexed });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/documents
router.post('/', authmw.requirePrimary, docWrite, (req, res) => {
  upload.array('files', 50)(req, res, async (err) => {
    if (err) {
      // Report the ACTUAL cap (which follows the configured maxFileBytes), not a hardcoded number
      // that would mislead when a user raises or lowers the limit.
      const capMB = Math.round((cfgPaths.MAX_FILE_SIZE || require('../constants').DEFAULT_MAX_FILE_BYTES) / (1024 * 1024));
      return err.code === 'LIMIT_FILE_SIZE'
        ? res.status(413).json({ ok: false, error: `File too large (max ${capMB} MB)` })
        : res.status(400).json({ ok: false, error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: 'No files received' });
    }
    // Respond immediately, then kick off indexing. We don't rely on the file
    // watcher here: chokidar with ignoreInitial can miss an `add` when the file
    // lands in a directory that was empty (or freshly created by a workspace
    // switch) at watch time, which left uploaded documents unindexed — present on
    // disk, absent from the index, and every query answering "nothing found".
    // Triggering the delta explicitly makes indexing deterministic. runDeltaUpdate
    // diffs disk against the manifest and is a no-op if the watcher already caught
    // the change, so a double-trigger is harmless.
    const wsId = resolveWsId(req);
    res.json({
      ok: true,
      workspace: wsId,
      indexed: wsId === state.workspaceId ? 'immediate' : 'on-next-open',
      uploaded: req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path })),
    });
    // Index now if this upload targeted the active workspace; otherwise reconcile that workspace's
    // on-disk index so the new files are picked up the next time it is opened or queried. (The files were
    // written into that workspace's own documents dir by the multer destination above.)
    await reflectDocChange(wsId);
  });
});

// POST /api/documents/attach — one-off attachment. Extracts text from an uploaded
// file IN MEMORY and returns it, WITHOUT saving to the library or indexing it. The
// client holds the text and sends it as full context for a single question — a
// "quick question about this file I don't want to keep" flow. Reuses the same
// extractor (incl. OCR) as permanent indexing. Uses memory storage so nothing is
// written to disk.
const memUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },   // 25 MB — one-off text extraction, not a library add
}).single('file');

router.post('/attach', docRead, (req, res) => {
  memUpload(req, res, async (err) => {
    if (err) {
      return err.code === 'LIMIT_FILE_SIZE'
        ? res.status(413).json({ ok: false, error: 'File too large for a one-off attachment (max 25 MB)' })
        : res.status(400).json({ ok: false, error: err.message });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file received' });
    try {
      const path = require('path');
      const { extractUploadText } = require('../indexing/files');
      const ext = path.extname(req.file.originalname).toLowerCase();
      // Untrusted upload: heavy parsers (PDF, Office, spreadsheet, JSON) run in the isolated,
      // resource-capped child so a crafted file cannot hang or exhaust the main process.
      const text = await extractUploadText(req.file.buffer, ext, req.file.originalname);
      if (!text || !text.trim()) {
        return res.status(422).json({ ok: false, error: 'No readable text could be extracted from that file' });
      }
      res.json({ ok: true, name: req.file.originalname, chars: text.length, text });
    } catch (e) {
      const status = e && e.safeParseFailure ? 422 : 500;
      res.status(status).json({ ok: false, error: e.message || 'Extraction failed' });
    }
  });
});

// POST /api/documents/url  { url }
// Fetch a web page, extract its article text, save it as a document in the active
// workspace, and trigger indexing. Uses the puppeteer-backed fetcher so it handles
// JS-rendered pages and bot-protected sites.
router.post('/url', authmw.requirePrimary, docWrite, async (req, res) => {
  const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ ok: false, error: 'No URL provided' });
  const wsId = resolveWsId(req);

  // Abort the capture if the client walks away before it finishes. A headless-browser capture holds one of
  // only two concurrent slots for up to the navigation timeout; without this, a closed tab leaves it running
  // to completion and two abandoned ingests can starve the gate. Mirrors the API ingest route.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const { fetchAndSaveArticle } = require('../urlfetch');
    // Save into the window's workspace, not always the active one.
    const { article, rel } = await fetchAndSaveArticle(url, wsm.docsDirFor(cfgPaths.DATA_DIR, wsId), ac.signal);

    res.json({ ok: true, workspace: wsId, title: article.title, url: article.url, chars: article.text.length, file: rel });
  } catch (e) {
    // Guard like the sibling handlers (DELETE, PUT /note): the only work before the response is the fetch, so
    // a failure here means the response was NOT sent — but headersSent-guard it anyway so this can never try
    // to send twice and surface as an unhandled rejection.
    if (!res.headersSent) res.status(502).json({ ok: false, error: e.message || 'Could not ingest the URL' });
    return;
  }

  // Index AFTER responding, and OUTSIDE the try above (mirroring the upload handler): a post-response
  // indexing error must never reach a catch that would re-send the already-sent response. reflectDocChange
  // reconciles the active workspace's index now, or a non-active one on its next open; it is best-effort.
  try { await reflectDocChange(wsId); }
  catch (e) { console.error('Index after URL ingest failed:', e && e.message); }
});

// GET /api/documents/related?docId=<id>&k=<n>
// Return documents semantically related to the given one, for the "Related" panel
// in the document viewer.
router.get('/related', docRead, async (req, res) => {
  try {
    const docId = (req.query.docId || '').trim();
    if (!docId) return res.status(400).json({ ok: false, error: 'Missing docId' });
    const k = Math.min(Math.max(parseInt(req.query.k, 10) || 6, 1), 20);
    // Related-documents embeds a query against the single local model, so it draws from the SAME
    // process-wide generation budget as search/summarize (one model, one gate) instead of opening
    // concurrent embeds that could saturate it behind the gated paths. The embed inside already has
    // its own duration bound; this adds the missing concurrency bound.
    const r = await require('../gengate').run(() => require('../api-core').relatedDocuments(resolveWsId(req), docId, k));
    if (r.status === 'warming')   return res.status(202).json({ ok: false, status: 'warming' });
    if (r.status === 'not_found') return res.status(404).json({ ok: false, error: 'No such document' });
    res.json({ ok: true, related: r.related });
  } catch (e) {
    // Transient backpressure (the gate's queue is full) is a "busy", not a failure — answer 429 with a
    // Retry-After so the panel can quietly retry, matching the HTTP API's gated endpoints.
    if (e && e.backpressure) { res.set('Retry-After', '5'); return res.status(429).json({ ok: false, error: 'The service is busy — retry shortly.' }); }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/documents/graph?workspace=<id>
// A BOUNDED node/edge view of the workspace's knowledge graph for the corpus mind-map. The full merged
// graph can hold tens of thousands of nodes (and is OOM-capped at that), far more than a browser can render
// or a person can read — so this returns only the most connected nodes (ranked by degree, then by how many
// documents mention them) and the edges among them. That keeps the payload and the client render small and
// fast regardless of corpus size. Workspace-scoped via docRead, so a member only ever sees a graph they may
// read. When the knowledge graph is off or not built yet, it returns enabled/empty so the UI can guide the user.
const GRAPH_VIZ_MAX_NODES = 150;
router.get('/graph', docRead, async (req, res) => {
  try {
    if (!require('../config').useGraphRag) return res.json({ ok: true, enabled: false, built: false, nodes: [], edges: [], total: { nodes: 0, edges: 0 }, shown: 0 });
    const gs = require('../graphstore');
    const graph = await gs.getGraph(resolveWsId(req));
    const viz = gs.vizSubgraph(graph, GRAPH_VIZ_MAX_NODES);
    res.json({ ok: true, enabled: true, built: graph.nodes.size > 0, ...viz });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Notes ────────────────────────────────────────────────────────────────────────
// A note is a first-class document: it is stored as a markdown file under <docsDir>/notes/, so the normal
// pipeline indexes it automatically and it becomes retrievable, #-citable, and surfaced by related-docs with
// no parallel store. These routes only create/read/list; delete reuses DELETE /api/documents?path=notes/…
// Editing is confined to the notes/ subfolder, so this route can never write or overwrite an arbitrary file.
const NOTES_SUBDIR = 'notes';
const noteSlug = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
// Reserve a free note filename ATOMICALLY: an exclusive create (`wx`) claims the name in one step, so two
// concurrent same-title saves can't both pick `foo.md` and have the second overwrite the first (a plain
// access-then-write has a TOCTOU window). The empty placeholder is then replaced by the atomic write below.
const uniqueNotePath = async (dir, base) => {
  let name = `${base}.md`, i = 2;
  for (;;) {
    const p = path.join(dir, name);
    try { const fh = await fs.open(p, 'wx'); await fh.close(); return p; }   // name claimed
    catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;   // a real error (perms/disk) — surface it
      name = `${base}-${i++}.md`;               // taken — try the next suffix
    }
  }
};

// GET /api/documents/notes?workspace=<id> — list this workspace's notes (name, excerpt, mtime, docId).
router.get('/notes', docRead, async (req, res) => {
  try {
    const wsId = resolveWsId(req);
    const notesDir = path.join(path.resolve(wsm.docsDirFor(cfgPaths.DATA_DIR, wsId)), NOTES_SUBDIR);
    let entries = [];
    try { entries = await fs.readdir(notesDir); } catch { entries = []; }   // no notes dir yet → empty list
    const notes = [];
    for (const f of entries.slice(0, 2000)) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      const abs = path.join(notesDir, f);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        // Read only a small prefix for the excerpt — never buffer a whole large note into memory just to
        // show its first ~160 characters in the list.
        let excerpt = '';
        const fh = await fs.open(abs, 'r');
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          excerpt = buf.toString('utf-8', 0, bytesRead).replace(/\s+/g, ' ').trim().slice(0, 160);
        } finally { await fh.close(); }
        notes.push({ name: f.replace(/\.md$/i, ''), relPath: `${NOTES_SUBDIR}/${f}`, modified: st.mtime.toISOString(), excerpt, docId: docIdFor(abs) });
      } catch { /* skip an unreadable note */ }
    }
    notes.sort((a, b) => (a.modified < b.modified ? 1 : -1));   // newest first
    res.json({ ok: true, notes });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/documents/note?path=notes/<file>.md&workspace=<id> — read one note's body.
router.get('/note', docRead, async (req, res) => {
  try {
    const wsId = resolveWsId(req);
    const docsRoot = path.resolve(wsm.docsDirFor(cfgPaths.DATA_DIR, wsId));
    const notesDir = path.join(docsRoot, NOTES_SUBDIR);
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string') return res.status(400).json({ ok: false, error: 'Missing path' });
    const real = await realWithin(path.resolve(docsRoot, decodeURIComponent(rel)), [notesDir]);   // confine to notes/
    if (!real) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const body = await fs.readFile(real, 'utf-8');
    res.json({ ok: true, name: path.basename(real).replace(/\.md$/i, ''), relPath: `${NOTES_SUBDIR}/${path.basename(real)}`, body, docId: docIdFor(real) });
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'No such note' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/documents/note?workspace=<id> — create a note ({ title, body }) or update one ({ path, body }).
router.put('/note', authmw.requirePrimary, docWrite, async (req, res) => {
  try {
    const wsId = resolveWsId(req);
    const docsRoot = path.resolve(wsm.docsDirFor(cfgPaths.DATA_DIR, wsId));
    const notesDir = path.join(docsRoot, NOTES_SUBDIR);
    await fs.mkdir(notesDir, { recursive: true });
    const { title, body, path: rel } = req.body || {};
    const text = typeof body === 'string' ? body : '';
    let abs;
    if (rel) {
      // Editing an existing note — confine to the notes dir so this can't overwrite an arbitrary document.
      const real = await realWithin(path.resolve(docsRoot, String(rel)), [notesDir]);
      if (!real) return res.status(403).json({ ok: false, error: 'Forbidden' });
      abs = real;
    } else {
      // Creating — the slug is [a-z0-9-] only (no separators), so the path stays inside notesDir by construction.
      abs = await uniqueNotePath(notesDir, noteSlug(title));
    }
    // Atomic + non-blocking write so a crash mid-save can't leave a half-written note (shared durable writer).
    await require('../disk').writeFileAtomicAsync(abs, text);
    res.json({ ok: true, name: path.basename(abs).replace(/\.md$/i, ''), relPath: `${NOTES_SUBDIR}/${path.basename(abs)}`, docId: docIdFor(abs) });
    await reflectDocChange(wsId);   // index the new/changed note so it becomes retrievable + #-citable
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/documents/citations/export  { sources, format }
// Format an answer's cited sources as a reference-manager file. One shared module owns every field mapping
// and escape rule, so the download cannot drift from what the import accepts. The response is the file text
// itself (not JSON), so the client saves exactly what the server formatted.
router.post('/citations/export', docRead, (req, res) => {
  try {
    const body = req.body || {};
    const cite = require('../citations');
    const format = cite.formatById(body.format).id;
    const refs = cite.sourcesToReferences(body.sources);
    if (!refs.length) return res.status(400).json({ ok: false, error: 'No citations to export' });
    const today = new Date().toISOString().slice(0, 10);
    const text = cite.formatReferences(refs, format, today);
    res.set('Content-Type', cite.mimeFor(format) + '; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="citations.${cite.extensionFor(format)}"`);
    res.send(text);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || 'Could not export citations' });
  }
});

// POST /api/documents/citations/import  { text, format }
// Turn an RIS or CSL-JSON export into small, searchable text documents in this workspace. Each reference
// becomes an ordinary document, so it is indexed, listed, and citable like any uploaded file. Bounded by the
// shared parser (reference count, field length, input size) and written atomically.
router.post('/citations/import', authmw.requirePrimary, docWrite, async (req, res) => {
  const wsId = resolveWsId(req);
  try {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'No reference text given' });
    const docsDir = wsm.docsDirFor(cfgPaths.DATA_DIR, wsId);
    const result = await require('../citations').importReferences(text, body.format, docsDir);
    res.json({ ok: true, workspace: wsId, count: result.count, files: result.files });
  } catch (e) {
    if (!res.headersSent) res.status(422).json({ ok: false, error: e.message || 'Could not import references' });
    return;
  }
  // Index after responding: the references are already on disk, so the HTTP result is final. A non-active
  // workspace reconciles on its next open (same contract as upload/url/note).
  try { await reflectDocChange(wsId); }
  catch (e) { console.error('Index after citation import failed:', e && e.message); }
});

// DELETE /api/documents?path=<relPath>&workspace=<id>
router.delete('/', authmw.requirePrimary, docWrite, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ ok: false, error: 'Missing file path' });
    const wsId = resolveWsId(req);
    const docsRoot = path.resolve(wsm.docsDirFor(cfgPaths.DATA_DIR, wsId));
    const abs = path.resolve(docsRoot, decodeURIComponent(filePath));
    // Resolve symlinks before deleting so a symlinked component inside the documents dir can't make
    // unlink follow out of the tree (parity with the viewer's realpath re-check). realWithin
    // returns the resolved path only when it is still inside docsRoot, else null → refuse.
    const real = await realWithin(abs, [docsRoot]);
    if (!real) return res.status(403).json({ ok: false, error: 'Forbidden' });
    await fs.unlink(real);
    res.json({ ok: true, workspace: wsId });
    // Reflect the removal: the active workspace's watcher/delta purges it; a non-active workspace's
    // on-disk index is reconciled so the deleted document stops being retrieved on its next open.
    await reflectDocChange(wsId);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
