'use strict';
// Guards the URL-ingest completion flow in lib/public/js/chat.js. Symptom: after adding a web page / YouTube
// URL, the status sat at 'Added "…" — indexing…' forever, and the new document only appeared after manually
// closing and reopening the Documents panel. Cause: indexing runs in the BACKGROUND after /api/documents/url
// responds, and nothing followed it to completion — the status line was never cleared, and the list refresh
// was gated on the panel being open (and could dedupe itself away via the status heartbeat). Fix: ingestUrl
// starts watchUrlIngestIndexed, which polls the documents list (it reports each document's indexed state) on a
// BOUNDED schedule, refreshes the visible list each time so the entry flips to indexed without a reopen, then
// clears the status — superseded by a newer add or a timeout so it can never leak. DOM/socket-coupled, so this
// source-guards the shipped client code. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const chat = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Isolate the ingest flow (from the button lookup to the end of the watch function).
  const start = chat.indexOf("const urlAddBtn  = document.getElementById('url-add-btn');");
  ok(start !== -1, 'the URL-ingest block exists');
  const body = chat.slice(start, start + 5200);

  // A successful add kicks off the completion watch (passing the saved file + title to match the document).
  ok(/watchUrlIngestIndexed\(data\.file, data\.title\);/.test(body),
    'a successful URL add starts the completion watch');
  ok(/async function watchUrlIngestIndexed\(file, title\)/.test(body),
    'watchUrlIngestIndexed is defined');

  // It is bounded (a deadline) and supersedable (a token compared against the shared urlIngestWatch), so it
  // can never run unbounded or have two watches fight over the status line.
  ok(/let urlIngestWatch = null;/.test(chat), 'a shared watch token guards against overlapping watches');
  ok(/const token = \(urlIngestWatch = \{\}\);/.test(body) && /if \(urlIngestWatch !== token\) return;/.test(body),
    'the watch supersedes any prior one and bails when a newer add takes over');
  ok(/const deadline = Date\.now\(\) \+ \d+;/.test(body) && /Date\.now\(\) < deadline/.test(body),
    'the watch is time-bounded (cannot poll forever)');

  // Each poll hits the CHEAP single-document check, NOT the full list — re-listing the whole corpus on every
  // tick re-paid an O(corpus) walk + stat-per-file + full-tree re-render. The list is refreshed ONCE, on
  // completion, so the entry flips to indexed without a manual reopen.
  ok(/'\/api\/documents\/indexed\?path='/.test(body), 'the watch polls the cheap per-document indexed endpoint');
  ok(!/await loadDocuments\(\);[\s\S]{0,40}if \(urlIngestWatch !== token\) return;[\s\S]{0,120}docsCache\.find/.test(body),
    'the watch no longer re-lists the whole corpus on every poll');
  ok(/if \(indexed\) \{[\s\S]{0,120}?await loadDocuments\(\);/.test(body),
    'the list is refreshed exactly once, when the document is confirmed indexed');

  // On completion the "indexing…" line is replaced and then auto-cleared (no stuck status), and a timeout
  // leaves an honest message rather than a frozen spinner.
  ok(/urlStatus\.textContent = done;/.test(body) && /urlStatus\.textContent === done[\s\S]{0,80}?urlStatus\.textContent = '';/.test(body),
    'on success the status shows "indexed" then auto-clears');
  ok(/It will be searchable once indexing finishes\./.test(body),
    'a timeout leaves an honest message instead of a stuck "indexing…" line');

  // ── The cheap server endpoint the watch polls exists and is workspace/path-traversal guarded ──
  const docsRoute = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'documents.js'), 'utf-8');
  ok(/router\.get\('\/indexed', docRead, async \(req, res\)/.test(docsRoute),
    'GET /api/documents/indexed exists (read-capability gated)');
  const idxBody = docsRoute.slice(docsRoute.indexOf("router.get('/indexed'"), docsRoute.indexOf('// POST /api/documents'));
  ok(/const real = await realWithin\(abs, \[docsRoot\]\);/.test(idxBody) && /if \(!real\) return res\.status\(403\)/.test(idxBody),
    'the indexed endpoint refuses a path that escapes the workspace documents dir');
  ok(/state\.parentMap\.has\(docId\)/.test(idxBody), 'it uses the live parentMap (O(1)) for the active workspace');
  ok(/catch \{ return res\.status\(400\)/.test(idxBody), 'a malformed percent-escape is a clean 400, not a 500');

  console.log(`\nALL URL-INGEST-STATUS TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ URL-INGEST-STATUS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
