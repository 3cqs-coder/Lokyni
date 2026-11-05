'use strict';
// Transport-agnostic core for the programmatic surface (search, summarize,
// workspace listing). Returns plain result objects — no HTTP, no MCP — so the same
// implementation backs both the /api/v1 HTTP routes and the MCP server. This is the
// one place the "how to run a search/summarize for an external caller" logic lives.
//
// Workspace authorization and scope checks stay in the transport layer (the HTTP
// route or the MCP server), because they depend on the caller's identity, which is
// transport-specific. This module assumes the caller is already authorized for the
// workspace it passes in.

const path = require('path');
const { stripInvisibleChars, MAX_QUERY_CHARS } = require('./constants');

// Sanitize a filename/source string on EGRESS — a document's NAME (not just its content) can carry a bidi
// override or zero-width payload (a crafted upload name, a connector-synced repo), and it reaches an MCP agent or
// API consumer that may render it. Mirrors the content strip; single-sourced here so REST and MCP both inherit it.
const safeName = (s) => stripInvisibleChars(String(s == null ? '' : s));

// Search-k bounds — the single source every search entrypoint clamps to (this core, and the REST/MCP
// schemas that call it). k is the number of passages retrieved; the cap keeps a caller from requesting an
// unboundedly large result set.
const DEFAULT_SEARCH_K = 5;
const MAX_SEARCH_K = 20;

// Run a retrieval search against a workspace. Returns one of:
//   { status: 'warming' }                          — cold workspace, retry shortly
//   { status: 'empty' }                            — workspace has no documents
//   { status: 'ok', passages: [...] }              — results (possibly empty)
// passages: [{ source, content, fileType, docId }]
const runSearch = async (workspaceId, query, k = 5, opts = {}) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const { searchDocuments } = require('./retrieval/search');

  const limit = Math.max(1, Math.min(parseInt(k, 10) || DEFAULT_SEARCH_K, MAX_SEARCH_K));
  // Bound the query length HERE — the one place every search entrypoint (REST, MCP, any future caller)
  // converges — so no transport can drive embedding and retrieval on an unbounded string. The REST route
  // still rejects an over-long query earlier for a clean 400; MCP and the rest inherit this clamp. One shared
  // bound (MAX_QUERY_CHARS), mirroring the k clamp above, not a per-transport copy that could drift.
  const q = String(query == null ? '' : query).slice(0, MAX_QUERY_CHARS);
  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx.liveVectorStore || idx.parentMap.size === 0) return { status: 'empty' };

  // opts.selectedDocIds restricts retrieval to those documents (focus mode is derived
  // from a non-empty selection inside searchDocuments) — used by focus-aware callers.
  const selected = Array.isArray(opts.selectedDocIds) && opts.selectedDocIds.length ? opts.selectedDocIds : null;
  const ctx = { history: [], docPassages: new Map(), docReadPos: new Map() };
  // Forward the caller's abort signal so a New/disconnect cancels retrieval promptly (deep research passes it).
  const result = await searchDocuments(q, null, null, ctx, false, selected, 1, { explainTrace: false, idx, signal: opts.signal });
  if (result.outOfScope) return { status: 'ok', passages: [] };

  const passages = [];
  for (const src of (result.sources || [])) {
    const entry = idx.parentMap.get(src.id);
    if (!entry) continue;
    const ranges = ctx.docPassages.get(src.id) || [{ start: src.passageStart || 0, end: src.passageEnd || 0 }];
    // Strip invisible/bidi "Trojan-Source" control characters before returning raw passage text, the same
    // single-sourced egress strip the answer path (verify.js) and the in-app citation snippet (snippet.js)
    // apply. Without it, a document carrying a bidi override or zero-width payload would reach an MCP agent or
    // API consumer that renders results as a spoofing/exfil construct. Markdown is left intact — this is the
    // document's genuine content, and the consumer decides how to render it.
    const text = stripInvisibleChars(
      ranges.map(({ start, end }) => entry.content.slice(start, end)).join('\n\n…\n\n')
    ).trim();
    if (!text) continue;
    passages.push({
      source: safeName(src.source || path.basename(entry.metadata?.source || '')),
      content: text, fileType: src.fileType, docId: src.id,
    });
    if (passages.length >= limit) break;
  }
  return { status: 'ok', passages };
};

// Run a full GROUNDED answer against a workspace — retrieval + generation — for the
// OpenAI-compatible chat endpoint. Unlike runSearch (which returns raw passages),
// this returns the model's answer as an async stream plus the sources it used, so an
// external caller gets exactly what the chat UI produces: an answer drawn only from
// the indexed documents, or a candid "not in your documents" when nothing matches.
//
// `messages` is an OpenAI-style array [{role, content}, ...]. The final user message
// is the question; earlier turns become conversation context so multi-turn callers
// get the same follow-up resolution the UI has. Returns one of:
//   { status: 'warming' }                          — cold workspace, retry shortly
//   { status: 'empty' }                            — workspace has no documents
//   { status: 'ok', stream, sources, outOfScope }  — stream yields answer text chunks
const runGroundedChat = async (workspaceId, messages, opts = {}) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const { searchDocuments } = require('./retrieval/search');

  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx.liveVectorStore || idx.parentMap.size === 0) return { status: 'empty' };

  // Split the OpenAI messages into prior turns (context) and the current question.
  // Only user/assistant turns form history; a leading system message is ignored here
  // because grounding rules are supplied by the retrieval pipeline itself, not the
  // caller — the endpoint is deliberately grounded-only.
  // Accept both a plain string `content` and OpenAI's multi-part array form
  // (`[{type:'text',text:'…'}, …]`) that modern/vision-capable SDKs send — joining the text parts —
  // instead of silently dropping any turn whose content is not a bare string.
  const contentToText = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join(' ');
    return '';
  };
  const turns = (Array.isArray(messages) ? messages : [])
    .map(m => (m && (m.role === 'user' || m.role === 'assistant')) ? { role: m.role, content: contentToText(m.content).trim() } : null)
    .filter(m => m && m.content);
  const lastUser = [...turns].reverse().find(m => m.role === 'user');
  const query = lastUser ? lastUser.content.trim() : '';
  if (!query) return { status: 'ok', stream: (async function* () {})(), sources: [], outOfScope: false, emptyQuery: true };

  // Prior turns (everything before the final user message) become conversation
  // history, mirroring how socket.js threads context so follow-ups resolve. Cap to the most recent
  // exchanges so a caller can't push an unbounded transcript into retrieval/prompt assembly; older turns
  // rarely affect the current answer and the prompt builder has its own budget below this.
  const MAX_HISTORY_TURNS = 40;
  const priorTurns = turns.slice(0, turns.lastIndexOf(lastUser)).slice(-MAX_HISTORY_TURNS);
  const ctx = {
    history: priorTurns.map(m => ({ role: m.role, content: m.content })),
    summary: '', summarizedUpTo: 0,
    docPassages: new Map(), docReadPos: new Map(),
  };

  // Forward the caller's abort signal so a client disconnect cancels retrieval AND the model generation
  // promptly (searchDocuments threads it into streamChat), instead of running on for a caller who left and
  // holding a concurrency slot until the next token or the idle timeout — parity with summarize/synthesize.
  const result = await searchDocuments(query, null, null, ctx, false, null, 1,
    { explainTrace: false, idx, signal: opts.signal });

  return {
    status: 'ok',
    stream: result.stream,
    sources: result.sources || [],
    outOfScope: !!result.outOfScope,
    idx,   // the resolved bundle, so the caller can run the deterministic numeric-grounding check (parity with the app)
  };
};

// Synthesize an overview across ALL documents in a workspace — the "brief me on this
// workspace / what are the common themes across these sources" research capability.
//
// Design: map-reduce, NOT "stuff every document into one prompt". Feeding a whole
// corpus to the model at once would blow the context window and, on a local model,
// be painfully slow. Instead we (1) summarize each document individually — small,
// bounded LLM calls, reusing the same summarizeToString the per-doc summary uses —
// then (2) run ONE final synthesis pass over those short summaries. Every call stays
// small, and the calls run sequentially so we never fire multiple requests at a local
// model at once (respecting the single-model responsiveness constraint).
//
// Returns one of:
//   { status: 'warming' }
//   { status: 'empty' }                              — no documents to synthesize
//   { status: 'ok', stream, docCount, totalDocs, omittedDocs, sampled, skippedNoise }
//     stream yields synthesis text; when sampled is true, docCount of totalDocs were
//     used (a representative cross-folder sample). totalDocs counts the content
//     documents synthesis considers — license/config/lock and text-free image files
//     are excluded and counted in skippedNoise, so totalDocs + skippedNoise reconciles
//     with the workspace's full document count shown elsewhere.
//
// `focus` (optional) is a natural-language angle ("focus on methodology", "themes
// about pricing"); when given it steers both the per-doc summaries and the synthesis.
// Files that are noise in a *research* synthesis: boilerplate legal text and project
// scaffolding. These have real text content (so the empty-content check below won't
// catch them), but summarizing them wastes a model call and dilutes the overview with
// "this is the MIT license" / "this is a package.json". Matched by specific filename,
// NOT by extension — a .json can be genuine data (e.g. exported records), so only
// known config/lock names are skipped, never the whole type. This affects synthesis
// only; retrieval still searches these files normally.
const SYNTHESIS_SKIP_NAMES = new Set([
  'license', 'license.txt', 'license.md', 'licence', 'licence.txt',
  'copying', 'copying.txt', 'notice', 'notice.txt', 'eula', 'eula.txt',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'tsconfig.json', 'jsconfig.json', 'babel.config.json', '.babelrc', 'eslintrc.json',
  '.eslintrc.json', '.prettierrc', 'jest.config.json', 'webpack.config.json',
  'cargo.lock', 'gemfile.lock', 'poetry.lock', 'go.sum', 'go.mod',
]);
const SYNTHESIS_SKIP_EXTS = new Set(['.lock', '.lockb']); // any *.lock file

// Image types: OCR gives them text, but an icon or decorative graphic may yield only
// a few stray characters — not a document worth summarizing. A genuine scanned page
// yields substantial text and is kept. The threshold is deliberately low so only
// clearly-trivial images are dropped.
const IMAGE_FILETYPES = new Set(['PNG', 'JPG', 'JPEG', 'WEBP', 'TIF', 'TIFF']);
const IMAGE_MIN_TEXT_CHARS = 200;

const isSynthesisNoise = (name) => {
  const lower = String(name || '').toLowerCase();
  if (SYNTHESIS_SKIP_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && SYNTHESIS_SKIP_EXTS.has(lower.slice(dot))) return true;
  return false;
};

// True when an image entry has too little OCR text to be a real document (an icon,
// a screenshot with no readable text). Non-images always return false here.
const isTrivialImage = (entry) => {
  const ft = String(entry?.metadata?.fileType || '').toUpperCase();
  if (!IMAGE_FILETYPES.has(ft)) return false;
  return (entry.content || '').trim().length < IMAGE_MIN_TEXT_CHARS;
};

// The one definition of "a document worth processing across the corpus": has real text, and is not synthesis
// noise (license/config/lock files) or a trivial image. Shared by workspace synthesis and Extraction Tables so
// the policy can never drift between them. Returns the kept entries (each tagged with its name and source
// folder) plus how many were skipped as noise. `selectedDocIds` optionally restricts to a pinned set; `sort`
// orders by filename. Pure and synchronous over the in-memory parentMap.
const collectContentEntries = (idx, opts = {}) => {
  const selected = Array.isArray(opts.selectedDocIds) && opts.selectedDocIds.length ? new Set(opts.selectedDocIds) : null;
  const entries = [];
  let skippedNoise = 0;
  for (const [docId, entry] of idx.parentMap) {
    if (selected && !selected.has(docId)) continue;
    if (!(entry.content || '').trim()) continue;
    const src = entry.metadata?.source || '';
    const name = path.basename(src);
    if (isSynthesisNoise(name) || isTrivialImage(entry)) { skippedNoise++; continue; }
    entries.push({ docId, entry, name, folder: path.dirname(src) });
  }
  if (opts.sort) entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, skippedNoise };
};

// Study-output formats for workspace synthesis. The map step (per-document summaries)
// is identical for all of them; only the final reduce instruction differs — so the whole
// pack reuses the existing map-reduce machinery, adding just a prompt per format.
// Each format carries everything a UI needs — `label` (the dropdown text), `confirm` (a short plain-language
// phrase completing "Lokyni will read across every document in this workspace and …" in the pre-generate
// confirmation), `audio: true` for formats whose answer gets the two-voice podcast player, and `task` (the
// server-side prompt). This is the SINGLE source: the page renders the options AND these UI fields from it
// (as <option> data-attrs), so the client keeps no parallel label/description/flag map that could drift.
// The synthesis/Generate formats — their user-facing label, the confirm-dialog phrasing, the model task prompt,
// and (podcast only) `audio: true`. The prompt text lives in a data file (lib/ai/data/synthesis-formats.json)
// with the rest of the AI prompt wording, so it is auditable in one place and single-sourced for every consumer
// (this module, the server-rendered <option> data-attrs, and the client). Audio Overview is a two-host podcast
// DIALOGUE: `audio: true` tells the client to offer the two-voice player; the strict per-line speaker format
// ("**Alex:**" / "**Sam:**") reads well in chat AND lets lib/voice/podcast.js split it into turns and assign a
// voice to each host. Grounding is enforced by the shared wrapper below ("Draw only on what the summaries state").
const SYNTHESIS_FORMATS = require('./ai/data/synthesis-formats.json');

// `signal` (optional): an AbortSignal so a caller can cancel the long map-reduce promptly. When a
// user clicks New during synthesis, the socket aborts it, but without a signal the per-document
// summary loop keeps running to completion — burning the provider and, because turns are serialized,
// blocking the user's next question for the full remaining duration. Checked at each loop boundary.
const runWorkspaceSynthesis = async (workspaceId, focus = '', onProgress = null, format = 'overview', signal = null) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const { summarizeToString } = require('./summarize');
  const { buildMessages, streamChat } = require('./llm');
  const { synthesisMaxDocs } = require('./config');

  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx.parentMap || idx.parentMap.size === 0) return { status: 'empty' };

  // Collect documents with content, tagging each with its top-level source folder so
  // the sample can be spread across folders rather than clustering on whichever files
  // happen to sort first. Two exclusions: empty content (e.g. an image OCR found no
  // text in), and research-synthesis noise (license/config/lock files) — both leave
  // retrieval untouched and only shape what synthesis reads.
  const { entries, skippedNoise } = collectContentEntries(idx);
  if (entries.length === 0) return { status: 'empty' };

  const cap = Math.max(1, synthesisMaxDocs);
  const totalDocs = entries.length;

  let use;
  let sampled = false;
  if (totalDocs <= cap) {
    // Everything fits — summarize all of it, in a stable order.
    use = entries.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // More documents than the cap. Taking the first N alphabetically would over-
    // represent whatever sorts first (e.g. a cluster of files sharing a common prefix)
    // and silently ignore entire folders. Instead, sample REPRESENTATIVELY: round-robin across folders,
    // and within each folder walk evenly across the sorted files rather than taking
    // the front. The result spans the whole collection, so the synthesis reflects
    // what's actually in the workspace, not just one corner of it.
    const byFolder = new Map();
    for (const e of entries) {
      if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
      byFolder.get(e.folder).push(e);
    }
    for (const list of byFolder.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    // Even stride within each folder so a folder's picks are spread across it, not
    // clustered at its start.
    const folderQueues = [...byFolder.values()].map((list) => {
      const stride = Math.max(1, Math.floor(list.length / Math.ceil(cap / byFolder.size || 1)) || 1);
      const picked = [];
      const seen = new Set();   // O(1) membership instead of O(n) Array.includes — the dedup below is O(n²) otherwise on a large flat folder
      for (let i = 0; i < list.length; i += stride) { picked.push(list[i]); seen.add(list[i]); }
      // include any not caught by the stride so we can still fill the cap if needed
      for (const item of list) if (!seen.has(item)) { picked.push(item); seen.add(item); }
      return picked;
    });

    // Round-robin across folders until the cap is filled — guarantees every folder is
    // represented before any folder is exhausted.
    use = [];
    let added = true;
    while (use.length < cap && added) {
      added = false;
      for (const q of folderQueues) {
        if (use.length >= cap) break;
        const next = q.shift();
        if (next) { use.push(next); added = true; }
      }
    }
    sampled = true;
  }

  const omittedDocs = Math.max(0, totalDocs - use.length);
  const focusText = (typeof focus === 'string' && focus.trim()) ? focus.trim() : '';

  // MAP: summarize each selected document. Sequential — never parallel against a local
  // model. One failing document is non-fatal; skip it and continue. Progress is
  // reported per document (if a callback was given) so a long run can show live status
  // rather than an opaque wait.
  const perDoc = [];
  const totalToSummarize = use.length;
  let processed = 0;
  for (const { entry, name } of use) {
    // Stop promptly if the turn was cancelled — the rest of this loop is the bulk of the runtime.
    if (signal?.aborted) return { status: 'aborted' };
    try {
      // Thread the turn's abort signal into the per-document summary call so a New/disconnect cancels a stalled
      // model promptly, rather than only being noticed at the next loop-boundary check above (the map phase is
      // the bulk of the runtime, and a single document can stall for the whole model idle timeout).
      const r = await summarizeToString(entry, { signal });
      if (r && !r.empty && r.summary) perDoc.push({ name, summary: r.summary.trim() });
    } catch {
      // skip this document; synthesis proceeds on the rest
    }
    processed++;
    if (typeof onProgress === 'function') {
      try { onProgress({ phase: 'summarizing', processed, total: totalToSummarize, current: name }); } catch { /* progress is best-effort */ }
    }
  }
  if (perDoc.length === 0) return { status: 'empty' };
  // Don't spend the REDUCE synthesis call on a cancelled turn.
  if (signal?.aborted) return { status: 'aborted' };

  if (typeof onProgress === 'function') {
    try { onProgress({ phase: 'synthesizing', processed: totalToSummarize, total: totalToSummarize }); } catch { /* ignore */ }
  }

  // REDUCE: one synthesis pass over the short per-document summaries. When the set was
  // sampled, tell the model so it frames the overview honestly as a sample rather than
  // implying it read the whole collection.
  const digest = perDoc.map((d, i) => `${i + 1}. ${d.name}\n${d.summary}`).join('\n\n');
  const scopeClause = sampled
    ? `Below are summaries of ${perDoc.length} documents — a representative sample drawn from across a larger collection of ${totalDocs} documents (spanning multiple folders).`
    : `Below are summaries of all ${perDoc.length} documents in a collection.`;
  const honesty = sampled
    ? ' Be clear that this overview is based on a sample, not the entire collection, and avoid over-generalizing from it.'
    : '';
  const fmt = SYNTHESIS_FORMATS[format] || SYNTHESIS_FORMATS.overview;
  const focusClause = focusText ? ` Focus specifically on: ${focusText}.` : '';
  const question = `${scopeClause} ${fmt.task}${focusClause} Draw only on what the summaries state; do not invent details.${honesty}`;

  // Use the persona of the workspace being synthesized (not the globally-active one), so a synthesis of
  // a non-active workspace reflects its own tone. Only persona is per-workspace; the model is global.
  const messages = buildMessages(digest, [], question, '', { persona: require('./config').personaFor(workspaceId) });
  // Thread the turn's abort signal into the reduce-phase stream too, so a New/disconnect during the final
  // synthesis cancels the model rather than letting it run to completion for a turn nobody is waiting on.
  const stream = streamChat(messages, { signal });

  return { status: 'ok', stream, docCount: perDoc.length, totalDocs, omittedDocs, sampled, skippedNoise, format: fmt.label };
};

// Summarize one document in a workspace. Returns:
//   { status: 'warming' }
//   { status: 'not_found' }
//   { status: 'empty', source }                    — document has no text
//   { status: 'ok', docId, source, summary, truncated }
const runSummarize = async (workspaceId, docId, opts = {}) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const { summarizeToString } = require('./summarize');

  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  const entry = idx.parentMap.get(docId);
  if (!entry) return { status: 'not_found' };

  // `opts.signal` (optional) lets a caller cancel the LLM summary promptly — an HTTP client that
  // disconnects should not leave the model generating a summary nobody will read.
  const out = await summarizeToString(entry, { signal: opts.signal });
  if (out.empty) return { status: 'empty', source: safeName(out.name) };
  return { status: 'ok', docId, source: safeName(out.name), summary: out.summary, truncated: out.truncated };
};

// Extraction Tables — extract a user-defined set of fields from every document into a cited matrix.
// Mirrors runWorkspaceSynthesis's bounded, cancellable, progress-reporting map loop, but there is NO
// reduce step: each document yields exactly one row. The loop is sequential (never parallel against a
// local model), checks the abort signal at every boundary, caps the document count, and reports progress
// (and optionally streams each row via opts.onRow) so a long run fills the table live rather than blocking.
// Returns one of:
//   { status: 'no_columns' }                                    — nothing to extract
//   { status: 'warming' } | { status: 'empty' } | { status: 'aborted' }
//   { status: 'ok', columns:[{key,label}], rows:[{docId,name,cells}], totalDocs, processed, omittedDocs, truncatedAny }
const runExtractionTable = async (workspaceId, columns, opts = {}) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const { normalizeColumns, extractRow } = require('./extracttable');
  const { extractionMaxDocs, personaFor } = require('./config');
  const signal = opts.signal || null;
  const onRow = typeof opts.onRow === 'function' ? opts.onRow : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const cols = normalizeColumns(columns);
  if (cols.length === 0) return { status: 'no_columns' };
  // Hand the normalized columns (with their stable keys) to the caller up front, so a streaming UI can
  // render the table header and key each incoming row's cells before the first row arrives.
  if (typeof opts.onColumns === 'function') { try { opts.onColumns(cols); } catch { /* best-effort */ } }

  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx.parentMap || idx.parentMap.size === 0) return { status: 'empty' };

  // Optional scope: only the user's pinned/selected documents. Same noise exclusions as synthesis
  // (empty content, license/config/lock files, trivial images) so the table isn't padded with junk rows.
  const { entries } = collectContentEntries(idx, { selectedDocIds: opts.selectedDocIds, sort: true });
  if (entries.length === 0) return { status: 'empty' };

  const cap = Math.max(1, extractionMaxDocs);
  const totalDocs = entries.length;
  const use = entries.slice(0, cap);
  const omittedDocs = Math.max(0, totalDocs - use.length);
  const persona = personaFor(workspaceId);

  // When the caller streams rows (onRow), do NOT also retain them: a row is ~24 KB and extractionMaxDocs can
  // be raised to 100000, so accumulating a matrix no consumer reads could hold gigabytes. Keep rows only when
  // there is no streaming consumer (e.g. a future non-streaming caller or a test).
  const rows = [];
  let processed = 0;
  let truncatedAny = false;
  for (const { docId, entry, name } of use) {
    if (signal?.aborted) return { status: 'aborted' };
    let row;
    try {
      const r = await extractRow(entry, cols, { signal, persona });
      if (r.truncated) truncatedAny = true;
      row = { docId, name, cells: r.cells || {} };
    } catch {
      row = { docId, name, cells: {} };   // one failing document is non-fatal — emit an empty row and continue
    }
    processed++;
    if (onRow) { try { onRow(row); } catch { /* streaming a row is best-effort */ } }
    else rows.push(row);
    if (onProgress) { try { onProgress({ processed, total: use.length, current: name }); } catch { /* best-effort */ } }
  }
  return { status: 'ok', columns: cols, rows, totalDocs, processed, omittedDocs, truncatedAny };
};

// List a workspace's documents. Returns [{ docId, name, fileType, size }].
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 1000;
const listDocuments = async (workspaceId, opts = {}) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  const documents = [];
  for (const [docId, entry] of idx.parentMap) {
    documents.push({
      docId,
      name: safeName(path.basename(entry.metadata?.source || '')),
      fileType: entry.metadata?.fileType,
      size: entry.metadata?.docLength ?? (entry.content || '').length,
    });
  }
  documents.sort((a, b) => a.name.localeCompare(b.name));
  // Paginate so the response can't grow unbounded with the corpus. limit/offset are coerced and clamped, so
  // a missing, NaN, negative, or oversized value yields a sane page rather than the whole corpus (or an
  // error). `total` and `nextOffset` let a caller page through deterministically.
  const total = documents.length;
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : LIST_DEFAULT_LIMIT));
  const offset = Math.max(0, Number.isFinite(opts.offset) ? Math.floor(opts.offset) : 0);
  const page = documents.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  return { status: 'ok', documents: page, total, offset, limit, nextOffset };
};

// Find documents related to a given one: use the document's own text as a query
// into the vector store, then return the nearest DISTINCT OTHER documents. Reuses
// the same FAISS store and parent-dedup logic retrieval uses, so "related" means
// the same semantic neighborhood the search already understands.
// Returns { status, related: [{ docId, name, fileType, score }] }.
const relatedDocuments = async (workspaceId, docId, k = 6) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  const entry = idx.parentMap.get(docId);
  if (!entry) return { status: 'not_found' };
  if (!idx.liveVectorStore) return { status: 'ok', related: [] };

  // Build a query that represents the document's actual content, not just its
  // opening — many documents (e.g. Project Gutenberg texts) begin with licensing
  // boilerplate that would otherwise dominate the query and match nothing useful.
  // Sample a few slices from across the document and concatenate them.
  const full = (entry.content || '').trim();
  let queryText;
  if (full.length <= 3000) {
    queryText = full;
  } else {
    // Skip a leading header region (Gutenberg-style license/boilerplate is often
    // 1-3k chars) and a trailing footer, then sample slices from the body so the
    // query reflects real content rather than licensing text.
    const headSkip = Math.min(2500, Math.floor(full.length * 0.1));
    const tailSkip = Math.min(2000, Math.floor(full.length * 0.1));
    const body = full.slice(headSkip, full.length - tailSkip);
    const at = (frac) => body.slice(Math.floor(body.length * frac), Math.floor(body.length * frac) + 1200);
    queryText = [at(0.05), at(0.5), at(0.9)].join('\n\n').trim() || body.slice(0, 3000);
  }
  if (!queryText) return { status: 'ok', related: [] };

  // Over-fetch chunks, then collapse to distinct parent documents, skipping the
  // source document itself. Uses the same l2ToCosine as the main retrieval path so the
  // reported scores are on the same scale.
  //
  // A large source document (e.g. a whole Bible) contributes thousands of chunks
  // that ALL rank near the top for a query drawn from itself. Those chunks are then
  // skipped by self-exclusion — so if we only fetch a fixed window, the source can
  // fill the entire window and no other document ever surfaces (this is why the
  // Bible showed zero related while smaller docs worked). The only robust fix is to
  // consider enough of the index that other documents' chunks are guaranteed to
  // appear. The corpus here is small (hundreds of docs), so we fetch up to the whole
  // index — a full scan is cheap and correct. Capped so a future huge corpus stays
  // bounded.
  // Search every embedding bank (or the single live store when banks are off) so related
  // documents are found across all of them, not just the active bank.
  const { denseStores, l2ToCosine, embedBounded, bankIsCooling, noteBankFailure, noteBankSuccess } = require('./embeddings');
  const stores = denseStores(idx);
  let ntotal = 0;
  for (const store of stores) {
    try {
      const nt = store.index?.ntotal;
      ntotal += typeof nt === 'function' ? nt.call(store.index) : (nt || 0);
    } catch { /* skip */ }
  }
  // Fetch enough nearby chunks to find k DISTINCT parent documents after dedup, but cap it: "related"
  // returns only a handful, and many chunks share a parent, so a few thousand candidates is ample. A high
  // ceiling (the old 20000) would transiently hold that many full chunk objects per bank in memory on a
  // large corpus. We also project each hit to just its metadata + score below, dropping the chunk text.
  const fetchN = Math.min(Math.max(ntotal, 500), 4000);
  let hits = [];
  try {
    for (const store of stores) {
      if (bankIsCooling(store)) continue;   // a dead bank already paid its timeout recently
      try {
        // Clamp to this store's vector count so faiss-node doesn't warn "k > elements" on a small bank (noise).
        let sn; try { sn = store.index && (typeof store.index.ntotal === 'function' ? store.index.ntotal() : store.index.ntotal); } catch {}
        const useN = (Number.isFinite(sn) && sn > 0) ? Math.min(fetchN, sn) : fetchN;
        // Bound the embed so a stalled provider can't hang the "related documents" request.
        const part = await embedBounded(store.similaritySearchWithScore(queryText, useN));
        noteBankSuccess(store);
        // Keep only the metadata and score — not the chunk's pageContent — so a large fetch doesn't retain
        // thousands of full chunk strings while we dedup down to k parents.
        for (const h of part) hits.push([{ metadata: h[0] && h[0].metadata }, h[1]]);
      } catch (e) {
        // One dead bank must not discard the other banks' hits. Record the cooldown and keep going.
        noteBankFailure(store);
        if (require('./config').DEBUG) console.log(`  [related] a bank failed, skipping it: ${e.message}`);
      }
    }
  } catch (e) {
    // Debug-gated: the related-documents panel degrades to empty on any failure, and a flaky/stalled
    // provider would otherwise repeat this line. Quiet by default; visible when debugging.
    if (require('./config').DEBUG) console.log(`  [related] similaritySearch threw or timed out: ${e.message}`);
    return { status: 'ok', related: [] };
  }
  // Merge banks by closeness (ascending L2) so the best chunks across ALL banks are
  // considered first — otherwise the first bank's hits could fill the top-k before the
  // others are seen. No-op with a single store.
  if (stores.length > 1) hits.sort((a, b) => a[1] - b[1]);

  // Resolve each chunk to a parentMap document. The chunk's parentId is a hash of
  // the file's absolute path AT INDEX TIME; if the index and the current parentMap
  // were built from different paths (e.g. files moved, or indexed via a watched
  // source vs. the workspace dir), that hash won't be a parentMap key. So we match
  // primarily by metadata.source (the file path), which is stable, and only use
  // parentId as a fast path when it happens to resolve.
  //
  // Build source(abs and basename) → docId lookups from parentMap once.
  const byAbs = new Map();
  const byBase = new Map();
  for (const [id, pe] of idx.parentMap) {
    const src = pe.metadata?.source;
    if (!src) continue;
    byAbs.set(src, id);
    byBase.set(path.basename(src), id);
  }
  const selfSource = entry.metadata?.source;
  const selfBase = selfSource ? path.basename(selfSource) : null;

  const resolveParent = (docMeta) => {
    // Prefer source-path resolution (stable); fall back to parentId if present in map.
    const src = docMeta?.source;
    if (src) {
      if (byAbs.has(src)) return byAbs.get(src);
      const b = path.basename(src);
      if (byBase.has(b)) return byBase.get(b);
    }
    const pid = docMeta?.parentId || docMeta?.docId;
    if (pid && idx.parentMap.has(pid)) return pid;
    return null;
  };

  const seen = new Set([docId]);
  const related = [];
  for (const [doc, l2] of hits) {
    const parentId = resolveParent(doc.metadata);
    if (!parentId || seen.has(parentId)) continue;
    // Also guard against matching the source doc by basename (path drift).
    const pe = idx.parentMap.get(parentId);
    if (!pe) continue;
    if (selfBase && path.basename(pe.metadata?.source || '') === selfBase) { seen.add(parentId); continue; }
    seen.add(parentId);
    related.push({
      docId: parentId,
      name: safeName(path.basename(pe.metadata?.source || '')),
      fileType: pe.metadata?.fileType,
      source: safeName(pe.metadata?.source),
      score: Number(l2ToCosine(l2).toFixed(4)),
    });
    if (related.length >= k) break;
  }
  return { status: 'ok', related };
};

module.exports = { runSearch, runGroundedChat, runWorkspaceSynthesis, runSummarize, runExtractionTable, listDocuments, relatedDocuments, collectContentEntries, SYNTHESIS_FORMATS,
  // The list paging bounds and the search-k bound own their numbers here, so every entrypoint (REST /api/v1
  // and the MCP tool schemas) clamps identically — no second literal that can drift from this one.
  LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, DEFAULT_SEARCH_K, MAX_SEARCH_K };
