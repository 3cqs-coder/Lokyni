'use strict';
// Hardened loader for the golden evaluation set (cases.json).
//
// The eval harnesses (run.js, recall.js) and the offline gate (lib/test/unit/eval-golden.test.js) all read
// the labeled cases through here, so loading is validated and FAIL-SAFE in one place instead of a bare
// require() that throws the whole run on a malformed or hand-edited file. A broken case is dropped (with a
// note), the count is capped, and an unreadable/garbage file yields empty sets rather than a crash — so a
// bad golden set can never take down the harness, only shrink what it measures. Pure, bounded, never throws.

const fs = require('fs');
const path = require('path');

const MAX_CASES = 2000;                                   // bound the set so a pathological file can't blow memory
// Every expectation the eval harness (run.js judge()) handles. MUST stay in step with run.js, or a loaded
// case would be silently dropped — 'refuse' in particular carries the strongest fabrication traps (an
// out-of-corpus question with a `forbid` term the model must never leak), so dropping it would quietly gut
// the honesty wedge the eval exists to protect. The offline gate asserts no case is dropped against the raw
// file, so this set can never drift out of sync again.
const VALID_EXPECT = new Set(['answer', 'nodata', 'nofab', 'refuse']);

// Coerce a value to an array of non-empty strings (mustInclude / forbid accept a string or an array).
const asStrArr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])).map((x) => String(x)).filter(Boolean);

// Normalize one labeled case, or null when it is unusable (no query, or an unknown expectation). Keeping the
// exact field set the harnesses read (query, expect, expectDoc, mustInclude, forbid) so nothing downstream
// changes.
const normalizeCase = (c) => {
  if (!c || typeof c !== 'object') return null;
  const query = typeof c.query === 'string' ? c.query.trim() : '';
  const expect = VALID_EXPECT.has(c.expect) ? c.expect : '';
  if (!query || !expect) return null;
  return {
    query,
    expect,
    expectDoc: typeof c.expectDoc === 'string' ? c.expectDoc.trim() : '',
    mustInclude: asStrArr(c.mustInclude),
    forbid: asStrArr(c.forbid),
  };
};

// Validate and bound an array of raw cases → clean cases (bad ones dropped, capped at MAX_CASES).
const validateCases = (arr) => {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const c of arr) {
    const n = normalizeCase(c);
    if (n) out.push(n);
    if (out.length >= MAX_CASES) break;
  }
  return out;
};

// Load the golden set from disk. Returns { cases, conversations, corpusChecks } — always well-formed arrays,
// even when the file is missing or corrupt (fail-safe to empty). conversations/corpusChecks are passed
// through as arrays (the harnesses validate their own fields); only `cases` is normalized here.
const load = (file = path.join(__dirname, 'cases.json')) => {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { cases: [], conversations: [], corpusChecks: [] }; }
  if (!raw || typeof raw !== 'object') return { cases: [], conversations: [], corpusChecks: [] };
  return {
    cases: validateCases(raw.cases),
    conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
    corpusChecks: Array.isArray(raw.corpusChecks) ? raw.corpusChecks : [],
  };
};

module.exports = { load, validateCases, normalizeCase, asStrArr, MAX_CASES, VALID_EXPECT };
