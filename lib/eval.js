'use strict';
// On-demand RAG quality evaluation: run a saved set of representative questions against a workspace,
// score each answer with the reference-free metrics in lib/evalmetrics.js, and report the averages plus
// a per-question breakdown and the change since the previous run — so a model swap, an embedding change,
// or a retrieval-setting tweak can be seen to help or hurt instead of guessed at. Entirely local (the
// user's own model and documents; nothing leaves the machine) and never on the answer hot path: it runs
// only when explicitly invoked. Best-effort throughout — a failed question is recorded with n/a metrics
// rather than aborting the run.
//
// Saved questions live in the workspace's own settings (like its connectors and automations); runs are kept
// in a bounded archive in the workspace cache dir, newest first. The archive is what makes an A/B comparison
// possible (any two recorded runs, not just the last one), and it is also the source of the last run. A
// legacy `eval-run.json` from an earlier version is read as a one-entry archive until the first new run.

const path = require('path');
const fsp = require('fs').promises;
const { DATA_DIR } = require('./config');
const wsm = require('./workspaces');
const metrics = require('./evalmetrics');

const MAX_QUESTIONS = 25;                 // a representative set, not a corpus — keeps a run bounded
const MAX_ANSWER_CHARS = 8000;            // cap the accumulated answer text per question
const RUN_FILE = 'eval-runs.json';        // bounded archive of full runs, newest first
const LEGACY_RUN_FILE = 'eval-run.json';  // read-only fallback from before the archive
const MAX_RUNS = 10;                      // full runs kept for A/B; older ones remain in the compact history
const HISTORY_FILE = 'eval-history.json'; // a compact trend log: one small summary per run
const MAX_HISTORY = 50;                   // keep the last N run summaries so the trend stays bounded on disk

const isValidText = (t) => typeof t === 'string' && t.trim().length >= 3 && t.length <= 2000;
const newId = () => 'q_' + require('crypto').randomBytes(6).toString('hex');

const listQuestions = (workspaceId) => {
  const s = wsm.loadSettings(DATA_DIR, workspaceId);
  return Array.isArray(s.evalQuestions) ? s.evalQuestions : [];
};

const addQuestion = (workspaceId, text) => {
  if (!isValidText(text)) return { ok: false, status: 400, error: 'A question must be 3–2000 characters.' };
  const t = text.trim();
  let created = null;
  wsm.updateSettings(DATA_DIR, workspaceId, (s) => {
    const list = Array.isArray(s.evalQuestions) ? s.evalQuestions : [];
    if (list.length >= MAX_QUESTIONS) { created = { ok: false, status: 400, error: `At most ${MAX_QUESTIONS} questions.` }; return s; }
    if (list.some(q => q.text === t)) { created = { ok: false, status: 400, error: 'That question is already saved.' }; return s; }
    created = { ok: true, question: { id: newId(), text: t } };
    s.evalQuestions = [...list, created.question];
    return s;
  });
  return created;
};

const removeQuestion = (workspaceId, id) => {
  wsm.updateSettings(DATA_DIR, workspaceId, (s) => {
    s.evalQuestions = (Array.isArray(s.evalQuestions) ? s.evalQuestions : []).filter(q => q.id !== id);
    return s;
  });
  return { ok: true };
};

const runPath = (workspaceId) => path.join(wsm.cacheDirFor(DATA_DIR, workspaceId), RUN_FILE);
const legacyRunPath = (workspaceId) => path.join(wsm.cacheDirFor(DATA_DIR, workspaceId), LEGACY_RUN_FILE);

// Async, non-blocking, and never throwing: these read on the GET /api/eval request path (every dashboard
// open), so a sync read would stall the event loop for all clients — worst over a network-mounted data dir.
// A size cap keeps a corrupt or hand-edited file from driving a huge parse/allocation; the archive's real
// bound is a few megabytes even at MAX_RUNS.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const readJson = async (file) => {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  } catch { return null; }
};

const isRun = (r) => !!r && typeof r === 'object' && typeof r.at === 'number' &&
  !!r.averages && typeof r.averages === 'object' && !Array.isArray(r.averages);

// A stable id for both new runs and legacy ones (which had no id). Derived only from stored data, so the
// compare endpoint can resolve a legacy run the same way the dashboard named it.
const runIdOf = (run) => (run && typeof run.id === 'string' && run.id)
  ? run.id
  : `r_at_${Math.max(0, Number(run && run.at) || 0)}`;

const summaryOf = (run) => ({
  id: runIdOf(run),
  at: run.at,
  questionCount: run.questionCount || 0,
  averages: run.averages || {},
  pipeline: run.pipeline || null,
  setup: run.setup || null,
});

// The archive, newest first and capped. A missing/corrupt archive falls back to the pre-archive last run,
// so an upgrade keeps the run the dashboard was already showing.
const loadRuns = async (workspaceId) => {
  const archived = await readJson(runPath(workspaceId));
  if (Array.isArray(archived)) {
    return archived.filter(isRun).sort((a, b) => b.at - a.at).slice(0, MAX_RUNS);
  }
  const legacy = await readJson(legacyRunPath(workspaceId));
  return isRun(legacy) ? [legacy] : [];
};

const getRuns = async (workspaceId) => (await loadRuns(workspaceId)).map(summaryOf);
const getRun = async (workspaceId, id) => (await loadRuns(workspaceId)).find((r) => runIdOf(r) === id) || null;
const getLastRun = async (workspaceId) => (await loadRuns(workspaceId))[0] || null;

// One read of the archive for the dashboard, plus the trend history. Never throws.
const getDashboard = async (workspaceId) => {
  const [runs, history] = await Promise.all([loadRuns(workspaceId), getHistory(workspaceId)]);
  return { lastRun: runs[0] || null, runs: runs.map(summaryOf), history };
};

// Append a completed run to the archive, replacing any run with the same id (a retry) and trimming to
// MAX_RUNS. Best-effort: failure never fails the run, which is already returned to the caller.
const appendRun = async (workspaceId, run) => {
  try {
    const runs = await loadRuns(workspaceId);
    const id = runIdOf(run);
    const next = [run, ...runs.filter((r) => runIdOf(r) !== id)]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RUNS);
    wsm.ensureWorkspace(DATA_DIR, workspaceId);
    await require('./disk').writeFileAtomicAsync(runPath(workspaceId), JSON.stringify(next));
  } catch { /* the run is still returned even if it can't be persisted */ }
};

const historyPath = (workspaceId) => path.join(wsm.cacheDirFor(DATA_DIR, workspaceId), HISTORY_FILE);

// The bounded trend log: a compact summary per run (timestamp, question count, the metric averages), oldest
// first, so the dashboard can chart whether quality is moving as models/settings change. Never throws.
const getHistory = async (workspaceId) => {
  const h = await readJson(historyPath(workspaceId));
  return Array.isArray(h) ? h : [];
};

// Append one run's summary to the trend log, capped to the most recent MAX_HISTORY. Best-effort — a history
// write failure never fails the run (the run itself is already returned and persisted). Written non-blocking.
const appendHistory = async (workspaceId, run) => {
  try {
    const hist = await getHistory(workspaceId);
    // Include the pipeline stamp per point so the trend can mark a step change.
    hist.push({
      ...(run.id ? { id: run.id } : {}),
      at: run.at, questionCount: run.questionCount, averages: run.averages,
      ...(run.pipeline ? { pipeline: run.pipeline } : {}),
    });
    const trimmed = hist.slice(-MAX_HISTORY);
    wsm.ensureWorkspace(DATA_DIR, workspaceId);
    await require('./disk').writeFileAtomicAsync(historyPath(workspaceId), JSON.stringify(trimmed));
  } catch { /* trend history is best-effort */ }
};

// ── Run archive: setup snapshot and A/B comparison ──
const SETUP_FIELDS = Object.freeze([
  { key: 'provider', label: 'Provider' },
  { key: 'model', label: 'Chat model' },
  { key: 'embeddingsProvider', label: 'Embeddings provider' },
  { key: 'embeddingsModel', label: 'Embeddings model' },
  { key: 'reranker', label: 'Reranker', boolean: true },
  { key: 'queryRewrite', label: 'Query rewrite', boolean: true },
]);

// The settings that most change an answer, captured with each run so an A/B view can say what differed apart
// from the score. Names only — never a key, token, or endpoint.
const setupSnapshot = () => {
  const cfg = require('./config');
  return {
    provider: cfg.AI_PROVIDER,
    model: cfg.LLM_MODEL,
    embeddingsProvider: cfg.EMBEDDINGS_PROVIDER,
    embeddingsModel: cfg.EMBEDDINGS_MODEL,
    reranker: !!cfg.USE_RERANKER,
    queryRewrite: !!cfg.useQueryRewrite,
  };
};

const setupDisplay = (value, isBool) => {
  if (value === null || value === undefined || value === '') return '—';
  if (isBool) return value ? 'On' : 'Off';
  return String(value);
};

// Build the A/B view for two archived runs. Questions are matched by their stable saved id, so a question
// added or removed between runs is shown rather than silently dropped. `missing` is returned as a status
// (not thrown) so the route can answer 404.
const compareRuns = async (workspaceId, aId, bId) => {
  const runs = await loadRuns(workspaceId);
  const a = runs.find((r) => runIdOf(r) === aId) || null;
  const b = runs.find((r) => runIdOf(r) === bId) || null;
  if (!a || !b) return { status: 'missing' };

  const setup = SETUP_FIELDS.map((field) => {
    const av = setupDisplay(a.setup && a.setup[field.key], field.boolean);
    const bv = setupDisplay(b.setup && b.setup[field.key], field.boolean);
    return { label: field.label, a: av, b: bv, different: av !== bv };
  });

  const metricRows = metrics.compareAverages(a.averages, b.averages).map((row) => ({
    ...row,
    label: metrics.METRIC_LABELS[row.key],
    higherIsBetter: metrics.METRIC_HIGHER_IS_BETTER[row.key] !== false,
  }));

  const byId = new Map();
  const aQuestions = Array.isArray(a.questions) ? a.questions : [];
  const bQuestions = Array.isArray(b.questions) ? b.questions : [];
  for (const q of aQuestions) {
    if (q && q.id) byId.set(q.id, { a: q, b: null });
  }
  for (const q of bQuestions) {
    if (!q || !q.id) continue;
    const entry = byId.get(q.id);
    if (entry) entry.b = q; else byId.set(q.id, { a: null, b: q });
  }
  const questions = [...byId.values()].map(({ a: qa, b: qb }) => {
    const base = qa || qb;
    return {
      id: base.id,
      text: String(base.text || '').slice(0, 2000),
      a: qa ? { metrics: qa.metrics || {}, status: qa.status || null, outOfScope: !!qa.outOfScope } : null,
      b: qb ? { metrics: qb.metrics || {}, status: qb.status || null, outOfScope: !!qb.outOfScope } : null,
      metrics: metrics.compareAverages(qa && qa.metrics, qb && qb.metrics),
    };
  });

  const pa = a.pipeline || {}, pb = b.pipeline || {};
  return {
    status: 'ok',
    a: summaryOf(a),
    b: summaryOf(b),
    setup,
    metrics: metricRows,
    questions,
    pipelineChanged: !!((pa.answer && pb.answer && pa.answer !== pb.answer) ||
      (pa.indexFormat && pb.indexFormat && pa.indexFormat !== pb.indexFormat)),
  };
};

// Drain a runGroundedChat stream into a single answer string, capped so a runaway generation can't grow
// memory during a batch. Never throws.
const drain = async (stream) => {
  let text = '';
  try {
    for await (const chunk of stream) {
      text += chunk;
      if (text.length >= MAX_ANSWER_CHARS) break;
    }
  } catch { /* keep whatever was produced */ }
  return text;
};

// Run every saved question, score it, and persist the run. Returns the run object, or a status object
// when the workspace can't be evaluated yet. `onProgress(done, total)` is optional.
// One evaluation run per workspace at a time. Each run does a full answer plus three judge calls (and one
// deterministic attribution pass) per question against a local model that serializes requests, so two concurrent runs (a double-click, two
// tabs) would double the load and the latency added to the user's live queries. A second request is
// refused while one is in flight rather than piling on.
const _evalRunning = new Set();
const runEval = async (workspaceId, onProgress) => {
  if (_evalRunning.has(workspaceId)) return { status: 'busy' };
  _evalRunning.add(workspaceId);
  try { return await _runEvalInner(workspaceId, onProgress); }
  finally { _evalRunning.delete(workspaceId); }
};
// Acquire a query-ready bundle for a workspace, or a status object when it can't be evaluated yet.
// Shared by runEval and seedQuestions so the warming/empty handling can't drift between them. Never throws.
const acquireBundle = async (workspaceId) => {
  const { getBundleNonBlocking } = require('./indexing/bundle');
  const acq = await getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx || !idx.parentMap || idx.parentMap.size === 0) return { status: 'empty' };
  return { idx };
};

const _runEvalInner = async (workspaceId, onProgress) => {
  const questions = listQuestions(workspaceId);
  if (questions.length === 0) return { status: 'no-questions' };

  const { runGroundedChat } = require('./api-core');
  const acq = await acquireBundle(workspaceId);
  if (acq.status) return { status: acq.status };
  const idx = acq.idx;
  // Snapshot the setup before the loop so every question in the run is described by the same settings, even
  // if the user changes a model while it is running.
  const setup = setupSnapshot();

  const prev = await getLastRun(workspaceId);
  const perQuestion = [];
  let done = 0;
  for (const q of questions) {
    let entry = { id: q.id, text: q.text, metrics: {}, sourceCount: 0, answerPreview: '' };
    try {
      const res = await runGroundedChat(workspaceId, [{ role: 'user', content: q.text }]);
      if (res && res.status === 'ok') {
        const answer = await drain(res.stream);
        const sources = res.sources || [];
        entry.sourceCount = sources.length;
        entry.answerPreview = answer.slice(0, 240);
        entry.outOfScope = !!res.outOfScope;
        // Score sequentially-ish; each metric is independently best-effort (null on failure). Citation
        // attribution is deterministic, so its detail (which citations were unused) is kept alongside the
        // number for the per-question breakdown. The faithfulness report is obtained once here (it already
        // contains the numeric result AND the claim/figure/quotation detail) rather than calling the thin
        // metric wrapper and then re-judging for the drill-down.
        const attr = require('./attribution').attribute(answer, sources, idx);
        const faithReport = await require('./faithfulness').scoreAnswer(answer, sources, idx, q.text).catch(() => null);
        const [rel, prec] = await Promise.all([
          metrics.answerRelevancy(q.text, answer),
          metrics.contextPrecision(q.text, sources, idx),
        ]);
        entry.metrics = {
          faithfulness: metrics.faithfulnessFromCounts(faithReport && faithReport.counts),
          answerRelevancy: rel, contextPrecision: prec,
          citationAttribution: attr ? attr.f1 : null,
        };
        if (attr) entry.citationAttribution = {
          f1: attr.f1, precision: attr.precision, recall: attr.recall,
          sourceCount: attr.sourceCount, usedCount: attr.usedCount,
          sentences: attr.sentences, attributed: attr.attributed,
          unused: attr.unused,
        };
        // Bounded drill-down so a changed score can be understood, not just observed: the claims the judge
        // could not fully support, deterministic figure/quotation flags, and per-source attribution counts.
        // Never stores the whole answer or source text — only short excerpts, capped.
        entry.detail = {
          claims: (faithReport && Array.isArray(faithReport.claims) ? faithReport.claims : [])
            .filter((c) => c && c.verdict && c.verdict !== 'supported')
            .slice(0, 8)
            .map((c) => ({ text: String(c.text || '').slice(0, 180), verdict: c.verdict })),
          figures: (faithReport && faithReport.figures && Array.isArray(faithReport.figures.ungrounded) ? faithReport.figures.ungrounded : [])
            .slice(0, 6).map((f) => String(f.raw || '').slice(0, 80)),
          quotes: (faithReport && faithReport.quotes && Array.isArray(faithReport.quotes.ungrounded) ? faithReport.quotes.ungrounded : [])
            .slice(0, 3).map((x) => String(x.raw || '').slice(0, 140)),
          attribution: attr ? attr.perSource.slice(0, 6) : [],
        };
      } else {
        entry.status = (res && res.status) || 'error';
      }
    } catch (e) {
      entry.status = 'error';
    }
    perQuestion.push(entry);
    done += 1;
    if (typeof onProgress === 'function') { try { onProgress(done, questions.length); } catch {} }
  }

  const averages = metrics.aggregate(perQuestion);
  const C = require('./constants');
  const run = {
    id: 'r_' + require('crypto').randomBytes(6).toString('hex'),
    at: Date.now(),
    workspaceId,
    questionCount: questions.length,
    averages,
    delta: metrics.deltaVs(prev && prev.averages, averages),
    // Stamp the pipeline this run used. A later trend can show when the numbers cross a pipeline change, so a
    // jump is not mistaken for a model/retrieval regression.
    pipeline: { answer: C.ANSWER_PIPELINE_VERSION, indexFormat: C.INDEX_FORMAT_VERSION },
    setup,
    questions: perQuestion,
  };
  await appendRun(workspaceId, run);   // archive the full run so the dashboard can compare any two runs
  await appendHistory(workspaceId, run);   // extend the bounded trend log so the dashboard can show quality over time
  try { require('./audit').audit(null, 'eval.run', workspaceId, { questions: questions.length, averages }); } catch {}
  return { status: 'ok', run };
};

// Propose representative evaluation questions from the workspace's own documents, so the panel isn't an empty
// box the user must seed by hand. Samples a bounded slice of the corpus (reusing the synthesis content
// collector, so license/config/image noise is excluded the same way), asks the auxiliary model for a few
// genuinely-useful questions IN THE DOCUMENTS' OWN LANGUAGE (so it is language-agnostic), and adds the valid,
// non-duplicate ones through addQuestion (its 3–2000-char validation, dedup, and cap all apply). On-demand
// only (a button), never on the answer path. Best-effort: any failure returns a status, never throws.
const SEED_MAX_QUESTIONS = 5;      // propose at most this many in one pass
const SEED_SAMPLE_DOCS   = 8;      // documents to sample for context
const SEED_SNIPPET_CHARS = 600;    // per-document excerpt
const SEED_CONTEXT_CHARS = 6000;   // total prompt context cap (bounds cost + memory)
const SEED_SCHEMA = { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' } } }, required: ['questions'], additionalProperties: false };

const seedQuestions = async (workspaceId) => {
  if (listQuestions(workspaceId).length >= MAX_QUESTIONS) return { status: 'full' };

  const acq = await acquireBundle(workspaceId);
  if (acq.status) return { status: acq.status };

  const { collectContentEntries } = require('./api-core');
  const { entries } = collectContentEntries(acq.idx, { sort: true });
  if (entries.length === 0) return { status: 'empty' };

  // Build a bounded, noise-free excerpt context from a sample of documents.
  let ctx = '', used = 0;
  for (const e of entries.slice(0, SEED_SAMPLE_DOCS)) {
    const snippet = String(e.entry && e.entry.content || '').slice(0, SEED_SNIPPET_CHARS).trim();
    if (!snippet) continue;
    const block = `[${e.name}]\n${snippet}\n\n`;
    if (used + block.length > SEED_CONTEXT_CHARS) break;
    ctx += block; used += block.length;
  }
  if (!ctx.trim()) return { status: 'empty' };

  const { completeJson } = require('./llm');
  const { withTimeout } = require('./llm-json');
  const timeoutMs = require('./config').AUX_LLM_TIMEOUT_MS || 12000;
  let proposed = [];
  try {
    const obj = await withTimeout(completeJson(
      [{ role: 'system', content: `You propose representative questions a user might ask about THEIR OWN documents, to evaluate a document assistant. Rules:\n- Propose up to ${SEED_MAX_QUESTIONS} questions.\n- Each must be answerable from the document excerpts shown; never invent topics they do not cover.\n- Write each question in the SAME LANGUAGE as the documents.\n- Make them specific and genuinely useful; no generic filler like "tell me more".\nReply with ONLY a JSON object: {"questions": ["…", "…"]}.` },
       { role: 'user', content: `Document excerpts:\n\n${ctx}\n\nPropose up to ${SEED_MAX_QUESTIONS} representative evaluation questions.` }],
      { temperature: 0.3, maxTokens: 400, schema: SEED_SCHEMA, schemaName: 'seed_questions', timeoutMs },
    ), timeoutMs, 'eval-seed');
    if (obj && Array.isArray(obj.questions)) proposed = obj.questions;
  } catch { return { status: 'error' }; }

  const added = [];
  for (const q of proposed) {
    if (typeof q !== 'string' || !q.trim()) continue;
    const r = addQuestion(workspaceId, q.trim().slice(0, 2000));   // reuses validation + dedup + the cap
    if (r && r.ok) added.push(r.question);
    if (listQuestions(workspaceId).length >= MAX_QUESTIONS) break;
  }
  return { status: 'ok', added, questions: listQuestions(workspaceId) };
};

module.exports = { listQuestions, addQuestion, removeQuestion, getLastRun, getRuns, getRun, getDashboard, compareRuns, getHistory, appendHistory, runEval, seedQuestions, MAX_QUESTIONS, MAX_HISTORY, MAX_RUNS };
