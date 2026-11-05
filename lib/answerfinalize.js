'use strict';
// Shared answer-finalize helpers, so the grounded-answer safeguards stay at parity across every surface — the
// one-string surfaces (the HTTP/MCP API and scheduled automations) and the streamed/evented chat socket. The
// ordered deterministic TEXT safeguards live in ONE place (groundedTextParts): the verify pass, then the
// invented-citation caveat. A one-string surface concatenates them (finalizeGrounded, which also appends the
// numeric-grounding caveat inline); the streamed surface gets the same parts back and emits each as its own
// event (finalizeGroundedStreamed), showing the numeric-grounding result as its own async badge instead. Each
// helper is deterministic, makes no model call, and never throws.

// The ordered deterministic TEXT safeguards every grounded surface applies — verify pass, then invented-
// citation caveat — returned as parts. Single-sourced here so the set and order can't drift between a surface
// that appends them to a string and one that emits them as stream events. `caveat` is '' when the answer cites
// nothing outside its sources (and for sources with no filenames, e.g. web results, where the guard is a no-op).
const groundedTextParts = (answer, sources, idx) => {
  const text = require('./verify').finalize(answer);
  let caveat = '';
  // caveatFor is itself total; this is belt-and-suspenders — if it ever threw, log under DEBUG rather than
  // drop the safeguard silently.
  try { caveat = require('./grounding').caveatFor(text, sources) || ''; }
  catch (e) { try { if (require('./config').DEBUG) console.log(`  [finalize] citation caveat skipped: ${e && e.message || e}`); } catch {} }
  // Deterministic quotation guard: a substantial quoted span that is absent from the served text gets a
  // neutral caveat. It resolves text from the same index the faithfulness checks use, and is a no-op when no
  // served text can be resolved (web-only answers, another workspace), so it cannot invent a warning.
  try {
    const qc = require('./faithfulness').quoteCaveatFor(text, sources, idx);
    if (qc) caveat += qc;
  } catch (e) { try { if (require('./config').DEBUG) console.log(`  [finalize] quotation caveat skipped: ${e && e.message || e}`); } catch {} }
  return { text, caveat };
};

// Append a numeric-grounding caveat: the app runs this deterministic check on EVERY document answer (not only
// when Verify is on) and surfaces it; a one-string surface gets it appended inline. No model call.
const appendFigureCaveat = (answer, sources, idx) => {
  try {
    const fr = require('./faithfulness').checkFigures(answer, sources, idx);
    const ungrounded = fr && fr.figures && Array.isArray(fr.figures.ungrounded) ? fr.figures.ungrounded : [];
    if (!ungrounded.length) return answer;
    const list = ungrounded.map(f => f.raw).filter(Boolean).slice(0, 8).join(', ');
    return answer + `\n\n⚠️ Note: these figures could not be verified against the cited documents: ${list}.`;
  } catch (e) { try { if (require('./config').DEBUG) console.log(`  [finalize] figure caveat skipped: ${e && e.message || e}`); } catch {} return answer; }
};

// The full finalize sequence for a grounded (document-cited) answer on a ONE-STRING surface (HTTP/MCP API,
// automations): the always-on verify pass (strip exfil vectors, decline a system-prompt leak, correct a stated
// arithmetic slip), then the invented-citation caveat, then the numeric-grounding caveat — concatenated into
// one returned string. `idx` is the index the cited sources resolve against (optional).
const finalizeGrounded = (answer, sources, idx) => {
  const { text, caveat } = groundedTextParts(answer, sources, idx);
  return appendFigureCaveat(text + caveat, sources, idx);
};

// The SAME grounded text sequence for a STREAMED/evented surface (the chat socket): it has already streamed the
// draft tokens, so instead of returning one finished string this returns the parts for the caller to emit in
// its own order — `text` (the verified answer, for history and the possible swap), `changed` (the verify pass
// altered the draft, so the surface should emit the swap) and `caveat` (the invented-citation note, emitted as
// a separate message kept out of stored history, '' when none). The numeric-grounding safeguard is delivered by
// the streamed surface as its own async, turn-tagged badge (see the socket's answer-meta emit), so it is not
// part of this synchronous text sequence. A pure function — it emits nothing itself, so the caller controls
// order — and never throws (groundedTextParts is total).
const finalizeGroundedStreamed = (answer, sources, idx) => {
  const { text, caveat } = groundedTextParts(answer, sources, idx);
  return { text, changed: text !== answer, caveat };
};

module.exports = { appendFigureCaveat, finalizeGrounded, finalizeGroundedStreamed, groundedTextParts };
