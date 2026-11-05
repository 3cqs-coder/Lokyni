'use strict';
// Shared retrieval-recall measurement, used by BOTH recall.js (the English golden set) and multilingual.js (the
// multilingual / cross-lingual set), so the way recall is measured lives in exactly ONE place and the two evals
// can never drift apart. It runs the REAL pipeline (initIndex + searchDocuments) over a fixture corpus in a
// throwaway temp dir, checks whether each case's expected document is among the SERVED sources and at what rank,
// and reports recall@served / top-1 / MRR — overall and per optional group. Retrieval-only (no generation), so it
// is a fast, low-noise signal that isolates ranking quality from the LLM. Never touches ./data.
//
// A case is { query, expectDoc, group? }. Requires the embedding provider (Ollama by default) reachable.
// Bounded and fail-safe: a per-search timeout and try/catch mean one bad case degrades to a MISS, never a hang or
// a crash of the whole run.

const fs = require('fs'), os = require('os'), path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

const _log = console.log, _warn = console.warn, _info = console.info;
const mute = () => { console.log = console.warn = console.info = () => {}; };   // keep console.error for real failures
const unmute = () => { console.log = _log; console.warn = _warn; console.info = _info; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('search timed out')), ms))]);

// Copy a fixture corpus into a temp workspace and build the real index over it. Returns { tmp, searchDocuments }.
const buildTempIndex = async (fixturesDir) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-recall-'));
  const docsDir = path.join(tmp, 'data', 'workspaces', 'default', 'documents');
  fs.mkdirSync(docsDir, { recursive: true });
  for (const f of fs.readdirSync(fixturesDir)) {
    const src = path.join(fixturesDir, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(docsDir, f));
  }
  try {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.copyFileSync(path.join(PROJECT, 'config', 'config.json'), path.join(tmp, 'config', 'config.json'));
  } catch { /* defaults are fine */ }
  process.chdir(tmp);
  const { initIndex } = require(path.join(PROJECT, 'lib', 'indexing', 'init'));
  const { searchDocuments } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));
  await initIndex({ forceRebuild: true });
  return { tmp, searchDocuments };
};

// Score one group of cases. Returns { n, served, top1, rrSum, rows }.
const scoreCases = async (searchDocuments, cases) => {
  let served = 0, top1 = 0, rrSum = 0;
  const rows = [];
  for (const c of cases) {
    let sources = [];
    try {
      const r = await withTimeout(searchDocuments(c.query, null, null, { history: [], allowedDocIds: null, docReadPos: new Map() }, false, null, 1, {}), 60000);
      sources = (r && r.sources || []).map(s => s.source);
    } catch (e) { sources = ['<' + (e && e.message) + '>']; }
    const rank = sources.indexOf(c.expectDoc);
    if (rank >= 0) { served++; rrSum += 1 / (rank + 1); if (rank === 0) top1++; }
    rows.push({ rank: rank < 0 ? 'MISS' : rank + 1, want: c.expectDoc, served: sources, q: c.query, group: c.group || '' });
  }
  return { n: cases.length, served, top1, rrSum, rows };
};

// Score a set of OFF-corpus "decline" cases: queries whose answer is NOT in the fixture corpus and that the
// pipeline must therefore decline (outOfScope). This is the honesty counterpart to recall — it guards that a
// recall feature (e.g. cross-lingual dense trust) does not start answering out-of-corpus questions from noise.
// Each case is { query, note? }. Returns { n, declined, rows }.
const scoreDeclines = async (searchDocuments, cases) => {
  let declined = 0;
  const rows = [];
  for (const c of cases) {
    let outOfScope = false, served = [];
    try {
      const r = await withTimeout(searchDocuments(c.query, null, null, { history: [], allowedDocIds: null, docReadPos: new Map() }, false, null, 1, {}), 60000);
      outOfScope = (r && r.outOfScope) === true;
      served = (r && r.sources || []).map(s => s.source);
    } catch (e) { served = ['<' + (e && e.message) + '>']; }
    if (outOfScope) declined++;
    rows.push({ ok: outOfScope, q: c.query, served });
  }
  return { n: cases.length, declined, rows };
};

// Score multi-turn JOURNEYS over the real pipeline. Each journey is { name, turns:[{ query, expectDoc?,
// notExpectDoc?, decline? }] }. Conversation state (allowedDocIds + history) is threaded across turns EXACTLY as
// the live caller threads it, so a regression in how one turn feeds the next is caught here. A turn passes when it
// serves expectDoc (if given), does NOT serve notExpectDoc (if given), and is declined iff `decline` is set.
// Returns { turnsOk, turnsTotal, rows }. Deterministic: retrieval order is fixed for a given query+state, so this
// is a hard signal (it does not depend on generation, which is not run here).
const scoreJourneys = async (searchDocuments, journeys) => {
  let turnsOk = 0, turnsTotal = 0;
  const rows = [];
  for (const j of journeys) {
    // Fresh conversation per journey, shaped like the live caller's context object.
    const convo = { history: [], allowedDocIds: null, docReadPos: new Map(), docPassages: new Map() };
    let turnNo = 0;
    for (const turn of j.turns) {
      turnNo++; turnsTotal++;
      let sources = [], ids = [], outOfScope = false;
      try {
        const r = await withTimeout(searchDocuments(turn.query, null, null, convo, false, null, 1, {}), 60000);
        sources = (r && r.sources || []).map(s => s.source);
        ids = (r && r.sources || []).map(s => s.id);
        outOfScope = (r && r.outOfScope) === true;
      } catch (e) { sources = ['<' + (e && e.message) + '>']; }
      // Thread state the way the live caller does: served docs become the allowed set; the exchange is appended
      // to history so the next turn is a true follow-up.
      if (ids.length) convo.allowedDocIds = ids;
      convo.history.push({ role: 'user', content: turn.query });
      convo.history.push({ role: 'assistant', content: `Re: ${turn.query}` });
      let ok = true;
      if (turn.expectDoc && !sources.includes(turn.expectDoc)) ok = false;
      if (turn.notExpectDoc && sources.includes(turn.notExpectDoc)) ok = false;
      if (turn.decline && !outOfScope) ok = false;
      if (ok) turnsOk++;
      rows.push({ ok, journey: j.name, turnNo, query: turn.query, served: sources,
        want: turn.expectDoc || (turn.decline ? '(decline)' : ''), not: turn.notExpectDoc || '' });
    }
  }
  return { turnsOk, turnsTotal, rows };
};

// Run a full recall eval: build the index, score all cases, print overall + per-group metrics, clean up, and
// exit with 0 when recall@served >= minRecall, 1 when below, 2 on a setup error. `title` names the eval.
// `hardGateGroup`, when set, bases pass/fail on THAT group's recall instead of the overall number — used when one
// group is the must-not-regress capability and another is a tracked-but-aspirational metric reported alongside.
// `declineCases`, when given, are off-corpus queries that MUST be declined (an honesty gate run alongside recall):
// if any is answered, the whole run fails regardless of recall.
// `journeys`, when given, are multi-turn sequences scored by scoreJourneys and gated hard: EVERY turn must meet its
// expectation (serves/notServes/decline), since multi-turn retrieval ordering is deterministic.
const runRecallEval = async ({ fixturesDir, cases, minRecall = 0.9, title = 'RETRIEVAL RECALL', hardGateGroup = null, declineCases = null, journeys = null }) => {
  let tmp = null;
  const cleanup = (code) => { try { unmute(); } catch {} try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
  mute();
  let searchDocuments;
  try { ({ tmp, searchDocuments } = await buildTempIndex(fixturesDir)); }
  catch (e) { unmute(); console.error(`${title}: index build failed —`, e && e.message); cleanup(2); return; }

  const { n, served, top1, rrSum, rows } = await scoreCases(searchDocuments, cases);
  const declineResult = declineCases && declineCases.length ? await scoreDeclines(searchDocuments, declineCases) : null;
  const journeyResult = journeys && journeys.length ? await scoreJourneys(searchDocuments, journeys) : null;
  unmute();

  const denom = n || 1;
  const recall = served / denom;
  console.log(`\n=== ${title} (${n} cases, real pipeline) ===`);
  for (const r of rows) {
    console.log(`  ${String(r.rank).padEnd(5)}${r.group ? `[${r.group}] ` : ''}want=${r.want.padEnd(22)} served=[${r.served.join(', ')}]  "${r.q.slice(0, 48)}"`);
  }
  // Per-group breakdown when cases carry a group.
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))];
  if (groups.length > 1) {
    console.log('');
    for (const g of groups) {
      const gr = rows.filter(r => r.group === g);
      const gServed = gr.filter(r => r.rank !== 'MISS').length;
      const gTop1 = gr.filter(r => r.rank === 1).length;
      console.log(`  ${g.padEnd(16)} recall ${gServed}/${gr.length} = ${(gServed / gr.length).toFixed(3)}   top-1 ${gTop1}/${gr.length} = ${(gTop1 / gr.length).toFixed(3)}`);
    }
  }
  console.log(`\n  recall@served:      ${served}/${n} = ${recall.toFixed(3)}`);
  console.log(`  top-1 (served 1st): ${top1}/${n} = ${(top1 / denom).toFixed(3)}`);
  console.log(`  MRR:                ${(rrSum / denom).toFixed(4)}`);
  // Pass/fail: on the whole set by default, or — when hardGateGroup is named — on each named group's recall, so a
  // must-not-regress capability gates the run. hardGateGroup may be one group name or an array of them; EVERY
  // named group must meet minRecall (a group with no cases counts as 0, so a renamed/empty group fails loudly
  // rather than passing silently). A metric not listed here is reported but not gated.
  const gateGroups = hardGateGroup == null ? [] : (Array.isArray(hardGateGroup) ? hardGateGroup : [hardGateGroup]);
  let gateRecall = recall, gateLabel = 'recall@served', recallPass = recall >= minRecall;
  if (gateGroups.length) {
    const parts = [];
    recallPass = true;
    for (const g of gateGroups) {
      const gr = rows.filter(r => r.group === g);
      const gRecall = gr.length ? gr.filter(r => r.rank !== 'MISS').length / gr.length : 0;
      if (gRecall < minRecall) recallPass = false;
      parts.push(`"${g}" ${gRecall.toFixed(3)}`);
    }
    gateLabel = parts.join(' · ');
    gateRecall = NaN;   // per-group reporting below uses gateLabel; the overall number is not the gate here
  }
  // Honesty gate: every off-corpus decline case must be declined. A single one answered fails the run, since it
  // means a recall feature started fabricating from noise — the opposite of what any recall gain is worth.
  let honestyPass = true;
  if (declineResult) {
    console.log(`\n  off-corpus honesty: ${declineResult.declined}/${declineResult.n} declined`);
    for (const r of declineResult.rows) {
      console.log(`    ${r.ok ? '✓ declined' : `✗ ANSWERED [${r.served.join(', ')}]`}  "${r.q.slice(0, 56)}"`);
    }
    honestyPass = declineResult.declined === declineResult.n;
  }
  // Multi-turn journey gate: every turn must meet its expectation (deterministic, so a hard gate).
  let journeyPass = true;
  if (journeyResult) {
    console.log(`\n  multi-turn journeys: ${journeyResult.turnsOk}/${journeyResult.turnsTotal} turns correct`);
    for (const r of journeyResult.rows) {
      console.log(`    ${r.ok ? '✓' : '✗'} [${r.journey}] t${r.turnNo} want=${r.want || '-'}${r.not ? ` not=${r.not}` : ''} served=[${r.served.join(', ')}]  "${r.query.slice(0, 40)}"`);
    }
    journeyPass = journeyResult.turnsOk === journeyResult.turnsTotal;
  }
  const pass = recallPass && honestyPass && journeyPass;
  const gateMsg = gateGroups.length
    ? `${gateLabel} (each must be >= ${minRecall})`
    : `${gateLabel} ${gateRecall.toFixed(3)} ${recallPass ? '>=' : '<'} gate ${minRecall}`;
  const extra = [];
  if (declineResult && !honestyPass) extra.push('an off-corpus question was ANSWERED (honesty gate failed)');
  if (journeyResult && !journeyPass) extra.push('a multi-turn journey turn served the wrong document (journey gate failed)');
  console.log(`\n  ${pass ? '✓ PASS' : '✗ FAIL'} — ${gateMsg}${extra.length ? ' — but ' + extra.join('; ') : ''}`);
  cleanup(pass ? 0 : 1);
};

module.exports = { runRecallEval, buildTempIndex, scoreCases, scoreDeclines, scoreJourneys };
