'use strict';
// Retrieval-honesty eval harness.
//
// Measures the behavior that IS Lokyni's differentiator: does it answer grounded
// questions correctly and with the right citation, and does it REFUSE (and never
// fabricate) when the corpus can't answer? It runs the real indexing + retrieval
// pipeline (initIndex + the same runGroundedChat/searchDocuments the API uses) over a
// small fixture corpus with labeled expectations (fixtures/ + cases.json).
//
// A fabrication oracle grades against the actual corpus, not a frozen answer key:
//   • every source an answer cites must be a real indexed document (no phantom sources);
//   • `forbid` terms (a real-world fact, or a specific a fabrication would invent) must
//     never appear;
//   • `nodata` traps (a document/entity that does not exist) must be declined or
//     clarified, never answered with invented content; a `nofab` follow-up must stay
//     non-fabricating.
// Failures are split HARD vs soft: any fabrication or a wrongly-answered out-of-corpus
// question is a HARD failure that fails the run (the honesty wedge); grounded content/
// citation shortfalls are soft and gated by --min-grounded.
//
// Modes:
//   (default)   Fixture mode — copies fixtures + config.json into a throwaway temp dir,
//               chdir's there, and builds a fresh index; never touches the user's ./data.
//   --corpus    Self-check mode — runs HONESTY invariants (fabrication traps + a
//               placeholder grounded query {A_TITLE} substituted from a real document)
//               against the user's REAL ./data, read-only. No specific-fact assertions,
//               since those vary by corpus. This is the seed of an in-app "AI self-check".
//
// Config is by CLI argument, never environment variables:
//   --min-grounded=<0..1>   grounded-accuracy gate (default 0.6; fixture mode only)
//   --corpus                 run the self-check against the real workspace
//
// Run: `npm run eval`. Requires the LLM provider (Ollama by default) to be reachable.
// Exit code: 0 pass; 1 on any HARD failure or grounded/conversation below the gate; 2 on
// a harness/setup error.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..', '..');   // lib/test/eval → repo root
const FIXTURES = path.join(__dirname, 'fixtures');
const { cases, conversations, corpusChecks } = require('./golden').load();   // hardened, fail-safe loader

const CORPUS_MODE = process.argv.includes('--corpus');
const _minArg = process.argv.find(a => a.startsWith('--min-grounded='));
const MIN_GROUNDED = Number((_minArg && _minArg.split('=')[1]) || 0.6);

// Keep the process alive for the whole run. The retrieval pipeline's worker RPCs (reranker/ColBERT/parse)
// arm their timeouts with unref'd timers — correct for the long-lived server (which always has live handles),
// but in this one-shot harness those timers are the ONLY thing pending while a worker RPC is awaited, so the
// event loop would drain and the process would exit 0 BEFORE the timeout fires — a silent false-pass that
// prints no results. A ref'd keep-alive timer prevents the premature drain so every RPC resolves or times out
// (and falls back) and the cases actually run to completion. Cleared in cleanupExit.
let _keepAlive = null;

// ── Workspace: temp fixtures (default) or the real ./data (--corpus) ──────────
let tmp = null;
if (!CORPUS_MODE) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-eval-'));
  const docsDir = path.join(tmp, 'data', 'workspaces', 'default', 'documents');
  fs.mkdirSync(docsDir, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(docsDir, f));
  try {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.copyFileSync(path.join(PROJECT, 'config', 'config.json'), path.join(tmp, 'config', 'config.json'));
  } catch { /* defaults are fine */ }
  process.chdir(tmp);   // './config/config.json' and './data' now resolve inside tmp
}
// In --corpus mode the cwd is left as-is (the real project), so ./data is the user's own.

const { initIndex } = require(path.join(PROJECT, 'lib', 'indexing', 'init'));
const { runGroundedChat } = require(path.join(PROJECT, 'lib', 'api-core'));
const { searchDocuments } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));
const { updateConversationSummary } = require(path.join(PROJECT, 'lib', 'history'));
const state = require(path.join(PROJECT, 'lib', 'state'));

const _log = console.log, _info = console.info, _warn = console.warn;
const mute = () => { console.log = console.info = console.warn = () => {}; };
const unmute = () => { console.log = _log; console.info = _info; console.warn = _warn; };

const REFUSAL_RE = /\b(i (don'?t|do not) have|no (relevant |useful )?(information|answer|match)|can only answer|falls outside what i can help|not (found|available|present|mentioned|stated|discussed|covered) in (the |my |these )?documents?|couldn'?t find|nothing (in|on) (the |my |your )?documents?)\b/i;
// Asking the user to narrow an ambiguous request is a valid, non-fabricating response.
const CLARIFY_RE = /\b(which (document|file|one|of these|deal)|could you (clarify|specify|be more specific)|did you mean|do you mean|can you (clarify|specify)|please specify|not sure which|which one)\b/i;

const drain = async (stream) => { let s = ''; if (stream) for await (const c of stream) s += c; return s; };

const includesOk = (answer, spec) => {
  const a = answer.toLowerCase();
  return (spec || []).every(term =>
    Array.isArray(term) ? term.some(t => a.includes(String(t).toLowerCase()))
                        : a.includes(String(term).toLowerCase()));
};
// Forbidden terms must never appear (a real-world fact for a refuse case, or a specific a
// fabrication would invent). Any hit is a fabrication.
const forbidHit = (answer, forbid) => {
  const a = answer.toLowerCase();
  return (Array.isArray(forbid) ? forbid : forbid ? [forbid] : []).filter(t => a.includes(String(t).toLowerCase()));
};

let corpusDocs = new Set();   // real indexed document basenames — the grounding oracle
const phantomSources = (sources) => (sources || []).filter(s => s && !corpusDocs.has(s));

// Grade one answer. Returns { pass, hard, note }. `hard` marks a fabrication or a
// wrongly-answered out-of-corpus question — the failures that fail the run outright.
const judge = (expect, obs, spec) => {
  const { answer, sources, refusedLike, clarified, status } = obs;
  const phantom = phantomSources(sources);
  const forbidden = forbidHit(answer, spec.forbid);
  const fabricated = phantom.length > 0 || forbidden.length > 0;
  const fabNote = [phantom.length ? `PHANTOM SOURCE: ${phantom.join(', ')}` : '', forbidden.length ? `FABRICATED: leaked "${forbidden.join(', ')}"` : ''].filter(Boolean).join(' | ');

  if (expect === 'refuse') {
    const hard = !refusedLike || fabricated;
    return { pass: !hard, hard, note: hard ? (fabNote || `HALLUCINATED: ${answer.slice(0, 100).replace(/\s+/g, ' ')}`) : 'correctly declined' };
  }
  if (expect === 'nodata' || expect === 'nofab') {
    // Must not fabricate. Declining or asking to clarify passes; a non-fabricating but
    // non-declining answer is a soft warning (not a hard failure).
    const valid = refusedLike || clarified;
    const hard = fabricated;
    if (hard) return { pass: false, hard: true, note: fabNote };
    if (valid) return { pass: true, hard: false, note: clarified ? 'asked to clarify' : 'declined (no fabrication)' };
    return { pass: false, hard: false, note: 'did not clearly decline (but did not fabricate)' };
  }
  // expect === 'answer'
  const answered = !refusedLike && status === 'ok';
  if (fabricated) return { pass: false, hard: true, note: fabNote };
  const contentOk = answered && includesOk(answer, spec.mustInclude);
  const citeOk = !spec.expectDoc || (sources || []).includes(spec.expectDoc);
  // Corpus mode can't assert specific facts/citations; require a grounded answer with a
  // real (non-phantom) citation instead.
  if (spec.corpus) {
    const ok = answered && (sources || []).length > 0;
    return { pass: ok, hard: false, note: ok ? `cited ${sources.join(', ')}` : (!answered ? 'wrongly refused' : 'answered with no citation') };
  }
  const pass = answered && contentOk && citeOk;
  return {
    pass, hard: false,
    note: !answered ? 'refused a grounded question'
        : !contentOk ? `missing expected content ${JSON.stringify(spec.mustInclude)}`
        : !citeOk ? `wrong citation (got ${sources.join(', ') || 'none'}, wanted ${spec.expectDoc})`
        : `cited ${sources.join(', ')}`,
  };
};

(async () => {
  _log(`\n\u{1f9ea} Lokyni retrieval-honesty eval${CORPUS_MODE ? '  [--corpus self-check on real ./data]' : ''}`);
  _keepAlive = setInterval(() => {}, 1 << 30);   // ref'd: hold the loop open so unref'd worker-RPC timeouts fire

  mute();
  await initIndex({});
  unmute();

  if (!state.indexReady || state.parentMap.size === 0) {
    _log(`❌ Index did not build (ready=${state.indexReady}, docs=${state.parentMap.size}). Is the embeddings provider reachable${CORPUS_MODE ? ', and does your workspace have documents' : ''}?`);
    cleanupExit(2);
  }
  corpusDocs = new Set([...state.parentMap.values()].map(e => path.basename(e.metadata.source)));
  _log(`   indexed ${state.parentMap.size} documents\n`);

  // Ask a single-turn question through the same grounded path the API uses.
  const askSingle = async (query) => {
    mute();
    let answer = '', sources = [], outOfScope = false, status = 'ok';
    try {
      const r = await runGroundedChat('default', [{ role: 'user', content: query }]);
      status = r.status; outOfScope = !!r.outOfScope;
      sources = (r.sources || []).map(s => s.source);
      answer = await drain(r.stream);
    } catch (e) { status = 'error:' + e.message; }
    unmute();
    const refusedLike = outOfScope || REFUSAL_RE.test(answer) || !answer.trim();
    return { answer, sources, refusedLike, clarified: CLARIFY_RE.test(answer), status };
  };

  const rows = [];
  let hardFails = 0, softFlags = 0;
  const bump = (r) => { if (r.hard) hardFails++; else if (!r.pass) softFlags++; };

  // ── Single-turn cases ────────────────────────────────────────────────────────
  // Fixture mode runs the labeled cases; corpus mode runs the honesty invariants with
  // {A_TITLE} substituted from a real document so the grounded query is valid anywhere.
  // Corpus mode runs the corpus-independent honesty invariants (fabrication traps +
  // out-of-corpus refusals) against the real workspace; fixture mode runs the labeled
  // grounded/refuse/conversation cases.
  const singleCases = CORPUS_MODE
    ? (corpusChecks || []).map(c => ({ ...c, corpus: true }))
    : cases;

  let groundedTotal = 0, groundedContent = 0, citeCorrect = 0, groundedAnswered = 0;
  let refuseTotal = 0, refuseOk = 0;
  for (const c of singleCases) {
    const obs = await askSingle(c.query);
    const r = judge(c.expect, obs, c);
    bump(r);
    rows.push({ kind: c.expect, pass: r.pass, hard: r.hard, q: c.query, note: r.note });
    if (c.expect === 'answer') {
      groundedTotal++;
      if (!obs.refusedLike && obs.status === 'ok') groundedAnswered++;
      if (r.pass) { groundedContent++; }
      if (!c.corpus && (!c.expectDoc || obs.sources.includes(c.expectDoc))) citeCorrect++;
    } else { refuseTotal++; if (r.pass) refuseOk++; }
  }

  // ── Multi-turn conversation cases (fixture mode only) ─────────────────────────
  const runTurn = async (query, ctx) => {
    const r = await searchDocuments(query, null, null, ctx, false, null, 1, {});
    const answer = await drain(r.stream);
    const sources = (r.sources || []).map(s => s.source);
    const refusedLike = !!r.outOfScope || REFUSAL_RE.test(answer) || !answer.trim();
    const clarified = !!r.isClarification || CLARIFY_RE.test(answer);
    if (!refusedLike && !r.isClarification) {
      ctx.history.push({ role: 'user', content: query }, { role: 'assistant', content: answer, sources: r.sources || [] });
      await updateConversationSummary(ctx);
    }
    return { answer, sources, refusedLike, clarified, status: 'ok' };
  };

  const convRows = [];
  let convTurns = 0, convTurnsPass = 0;
  if (!CORPUS_MODE) for (const conv of (conversations || [])) {
    const ctx = { history: [], allowedDocIds: null, summary: '', summarizedUpTo: 0,
      docReadPos: new Map(), docExcludePos: new Map(), docPassages: new Map(), windowScoreCache: new Map() };
    const turns = [];
    for (const t of conv.turns) {
      mute();
      let obs;
      try { obs = await runTurn(t.query, ctx); } catch (e) { obs = { answer: '', sources: [], refusedLike: true, clarified: false, status: 'error' }; }
      unmute();
      convTurns++;
      const r = judge(t.expect, obs, t);
      bump(r);
      if (r.pass) convTurnsPass++;
      turns.push({ q: t.query, pass: r.pass, hard: r.hard, note: r.note });
    }
    convRows.push({ name: conv.name, turns, pass: turns.every(t => t.pass) });
  }

  // ── Scorecard ──────────────────────────────────────────────────────────────
  const mark = (r) => r.pass ? '✅' : (r.hard ? '❌' : '▲');
  _log('  Single-turn cases:');
  for (const r of rows) { _log(`   ${mark(r)} [${r.kind}] ${r.q}`); _log(`        ${r.note}`); }

  if (convRows.length) {
    _log('\n  Conversation cases (shared state across turns):');
    for (const conv of convRows) {
      _log(`   ${conv.turns.every(t => t.pass) ? '✅' : (conv.turns.some(t => t.hard) ? '❌' : '▲')} ${conv.name}`);
      for (const t of conv.turns) _log(`      ${mark(t)} "${t.q}" — ${t.note}`);
    }
  }

  const pct = (n, d) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
  const groundedContentRate = groundedTotal ? groundedContent / groundedTotal : 1;
  const refusalRate = refuseTotal ? refuseOk / refuseTotal : 1;
  const convTurnRate = convTurns ? convTurnsPass / convTurns : 1;

  _log('\n  Metrics:');
  _log(`   Honesty — no fabrication / correct refusal        ${hardFails === 0 ? '✅ clean' : '❌ ' + hardFails + ' hard failure(s)'}   ← the wedge`);
  _log(`   Out-of-corpus declined                            ${pct(refuseOk, refuseTotal)}  (${refuseOk}/${refuseTotal})`);
  if (groundedTotal) {
    _log(`   Grounded answered (didn't wrongly refuse)         ${pct(groundedAnswered, groundedTotal)}  (${groundedAnswered}/${groundedTotal})`);
    _log(`   Grounded content correct (expected facts)         ${pct(groundedContent, groundedTotal)}  (${groundedContent}/${groundedTotal})`);
    _log(`   Citation correct (cited the right document)       ${pct(citeCorrect, groundedTotal)}  (${citeCorrect}/${groundedTotal})`);
  }
  if (convTurns) _log(`   Conversation turns correct (follow-ups)           ${pct(convTurnsPass, convTurns)}  (${convTurnsPass}/${convTurns})`);
  if (softFlags) _log(`   Soft warnings (non-fabricating, sub-ideal)        ${softFlags}`);

  // HARD failure (any fabrication / wrong refusal) always fails. In fixture mode the
  // grounded + conversation accuracy gates apply too; corpus mode is honesty-only.
  const belowGate = !CORPUS_MODE && (groundedContentRate < MIN_GROUNDED || convTurnRate < MIN_GROUNDED);
  const failed = hardFails > 0 || belowGate;
  _log(`\n  ${failed ? '❌ FAIL' : '✅ PASS'} — ${hardFails} hard failure(s)`
     + (CORPUS_MODE ? '' : `, grounded ${pct(groundedContent, groundedTotal)}, conversation ${pct(convTurnsPass, convTurns)} (min ${Math.round(MIN_GROUNDED * 100)}%)`)
     + `\n`);
  cleanupExit(failed ? 1 : 0);
})().catch(e => { unmute(); _log('eval crashed:', e && e.stack || e); cleanupExit(2); });

function cleanupExit(code) {
  if (_keepAlive) { try { clearInterval(_keepAlive); } catch {} _keepAlive = null; }
  if (tmp) { try { process.chdir(PROJECT); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  process.exit(code);
}
