'use strict';
// Guards the topic-switch retrieval fix in lib/retrieval/search.js. Symptom: after a conversation turn,
// asking a question that switches to a DIFFERENT document often retrieved the WRONG (previous-topic)
// document on the first attempt and answered "I don't have that information", while asking the identical
// question a second time retrieved the correct document. Two root causes, both guarded here:
//
//   1. The continuity preference for documents already in the conversation (conversationContext.allowedDocIds)
//      added a FLAT +0.05 to their fused RRF score. RRF scores are tiny (~0.01–0.03), so +0.05 pinned the
//      conversation's document to rank 1 even when the new question clearly matched a different document.
//      Fixed: a PROPORTIONAL nudge (score * (1 + CONTINUITY_BOOST)) that breaks near-ties without overriding
//      a clearly-stronger match.
//
//   2. On the intent-classifier path, a genuine topic switch mislabeled as "continue" had NO retrieval-signal
//      fallback (the heuristic path's BM25/RRF disagreement check runs only when the classifier did NOT run).
//      Fixed: a safety net that, when the classifier said "continue" but BM25 strongly prefers a document
//      outside the conversation set AND no allowed doc is near the top of the fused ranking, treats it as a
//      shift — resetting context and clearing isContinuation so the stale document is not re-pinned.
//
// Retrieval ranking is index/model-coupled, so — like retrieval-gates.test.js — this source-guards the
// shipped logic so a later edit that reinstates the flat boost or drops the safety net is caught by
// `npm run test:unit`. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── 1. The continuity boost is proportional, not a flat additive +0.05 ──
  ok(/const CONTINUITY_BOOST = 0\.15;/.test(src), 'a named, proportional continuity-boost fraction is defined');
  ok(/allowedSet\.has\(docId\) \? score \* \(1 \+ CONTINUITY_BOOST\) : score/.test(src),
    'the continuity preference multiplies the doc\'s own score (tie-breaker), not a flat add');
  // The specific fragile pattern that caused the bug must be gone from the continuity-boost branch.
  ok(!/allowedSet\.has\(docId\) \? score \+ 0\.05 : score/.test(src),
    'the flat +0.05 continuity boost (which dwarfed RRF scores and pinned the prior-topic doc) is gone');

  // ── 2. isContinuation is reassignable so a detected shift can clear it ──
  ok(/let isContinuation = intent/.test(src) && !/const isContinuation = intent/.test(src),
    'isContinuation is a let (clearable when the retrieval-signal net detects a shift)');

  // ── 3. The intent-path retrieval-signal safety net exists and resets on a strong disagreement ──
  ok(/else if \(intent && intent\.intent === 'continue' && intentSaysContinue && !focusMode && !isFirstQuery && \(topicShiftTerms\.length > 0 \|\| hasProperNoun\(query\)\) && conversationContext\.allowedDocIds\?\.length > 0\) \{/.test(src),
    'the retrieval safety net fires only for a classifier "continue" verdict (a "reference" is trusted and stays anchored)');
  // ── 3a. The safety net is GATED on a specific new subject, so a VAGUE continuation ("tell me more") whose
  //    corpus-wide retrieval scores high on an unrelated document (worse with a high-similarity embedding
  //    model) is never flipped into a topic switch — it stays on the conversation document. ──
  ok(/\(topicShiftTerms\.length > 0 \|\| hasProperNoun\(query\)\) && conversationContext\.allowedDocIds\?\.length > 0\) \{/.test(src),
    'the intent-path safety net only fires when the query carries a specific term or proper noun (never on a vague continuation)');
  // It requires BOTH signals (no allowed doc near the top of RRF AND BM25 strongly prefers a non-allowed doc)
  // before overriding the classifier — so a genuine continuation is never falsely reset.
  ok(/const bm25StronglyDisagrees = bm25TopId && !allowedSet\.has\(bm25TopId\) &&[\s\S]{0,160}?bm25Results\[0\]\[1\] > bm25AllowedScore \* 1\.3;/.test(src),
    'the safety net uses the strong BM25-disagreement test (above threshold and clearly beating the allowed doc)');
  // On a strong disagreement the net resets context, marks a shift, and clears isContinuation. These three
  // appear together inside the guard block; assert each and that they sit after the disagreement condition.
  const netIdx = src.indexOf('if (!rrfTopInAllowed && bm25StronglyDisagrees)');
  ok(netIdx !== -1, 'the safety net gates on the combined strong-disagreement condition');
  const netBody = src.slice(netIdx, netIdx + 900);
  ok(/clearConversationState\(conversationContext\);/.test(netBody) &&
     /topicShiftedThisQuery = true;/.test(netBody) &&
     /isContinuation = false;/.test(netBody),
    'on a strong disagreement the net resets context, marks a shift, and clears isContinuation (so the stale doc is not re-pinned)');

  // ── The grounding guard is UNIFIED across 'continue' AND 'reference': it asks one question — does the
  //    resolved query actually touch the conversation's own documents? A TRUE reference ("does it mention X?")
  //    keeps the current subject in its resolved query, so it stays grounded and anchored; a genuine new
  //    subject the classifier MISLABELS as a reference ("What happened in the chess game?" → reference "chess
  //    game") touches none of the anchor docs, so it is routed as a new query instead of being pinned to the
  //    wrong document. This single check prevents BOTH regressions: a reference leaking a doc it should not
  //    switch to, and a mislabeled new topic being stuck on the anchor. ──
  ok(/if \(intent && \(intent\.intent === 'continue' \|\| intent\.intent === 'reference'\) && conversationContext\.allowedDocIds\?\.length > 0\) \{/.test(src),
    'the grounding guard re-checks a "continue" OR a "reference" verdict against the anchor docs (one unified check)');
  // The grounding scan reads the WHOLE anchor document, not a truncated head. A reference term can sit deep in
  // a long document; a fixed-length head slice would falsely judge a genuine follow-up "ungrounded" and shift
  // away from the right document. Guards against re-introducing a truncation (which only causes FALSE shifts —
  // it can never make a truly-absent term appear, so it cannot help the mislabeled-new-topic direction either).
  {
    const guardStart = src.indexOf("const resolved = (intent.resolvedQuery || query);");
    const guardBody = src.slice(guardStart, src.indexOf("if (!grounded) {", guardStart));
    ok(!/\.slice\(0,\s*\d+\)/.test(guardBody), 'the grounding scan does not truncate the anchor content to a fixed head');
    ok(/new RegExp\(escapeRegExp\(t\), 'i'\)\.test\(content\)/.test(guardBody),
      'the grounding scan tests each term against the whole document in place (OOM-safe, ReDoS-safe)');
  }
  ok(/else if \(intent && intent\.intent === 'continue' && intentSaysContinue/.test(src),
    'the retrieval safety net (the BM25-disagreement net) still fires only for a "continue" verdict');
  // The positional-reference clarify is independent of the (reference-exempt) grounding guard now.
  ok(/if \(intentSaysContinueRaw && POSITIONAL_REFERENCE_RE\.test\(query\.trim\(\)\) && \(!intentTargetIds \|\| intentTargetIds\.length === 0\)\)/.test(src),
    'an ungrounded positional reference still asks for clarification, independent of the guard');
  // The classifier prompt teaches the "relates to / mentions X about the current subject = reference" rule.
  const intentPrompt = fs.readFileSync(path.join(PROJECT, 'lib', 'ai', 'data', 'intent-system.txt'), 'utf-8');
  ok(/relates to or mentions some term X/.test(intentPrompt) && /keep targetDocs \[\]/.test(intentPrompt),
    'the intent prompt classifies a relation/mention question about the current subject as a "reference" that stays anchored');

  // ── A 'reference' RESTRICTS serving to the anchored docs (like focus mode), not merely boosts them. The
  //    resolved query carries the term X the user asked about, so without a hard restriction an unrelated
  //    document that happens to contain X can outrank the anchor and be served — leaking its contents, and only
  //    intermittently (retrieval ties break differently run to run). This is what made "does it mention the
  //    guest wifi password?" flakily switch and leak the password. ──
  ok(/const refAnchorIds = \(intent && intent\.intent === 'reference' && !topicShiftedThisQuery && !focusMode\)/.test(src),
    'a reference resolves its anchored doc set (conversation docs + any explicitly referenced target)');
  ok(/\} else if \(refAnchorIds && refAnchorIds\.length > 0\) \{/.test(src) &&
     /rankedDocIds = fusedRanking\.filter\(\(\[docId\]\) => anchorSet\.has\(docId\)\);/.test(src),
    'a reference RESTRICTS the served documents to the anchored set (not a gentle continuity boost)');
  // The restriction takes precedence over the continuity-boost branch (ordered before it).
  ok(src.indexOf('} else if (refAnchorIds && refAnchorIds.length > 0) {') <
     src.indexOf('} else if (!isFirstQuery && !topicShiftedThisQuery && conversationContext.allowedDocIds?.length > 0) {'),
    'the reference restriction is checked before the gentler continuation boost');
  // A reference answers the NEGATIVE plainly ("not mentioned here" / "unrelated") instead of over-refusing —
  // the note rides in the USER turn (strong attention), gated on the restriction having been applied.
  ok(/isReference: !!\(refAnchorIds && refAnchorIds\.length > 0\)/.test(src),
    'the reference flag is passed to buildMessages only when the restriction was applied');
  const llm = fs.readFileSync(path.join(PROJECT, 'lib', 'llm.js'), 'utf-8');
  ok(/const REFERENCE_NOTE = promptData\.read\('mode-reference\.txt'\);/.test(llm) &&
     /const referenceNote = \(opts\.isReference && REFERENCE_NOTE\) \? `\\n\\n\$\{REFERENCE_NOTE\}` : '';/.test(llm) &&
     /\$\{DOC_INJECTION_REMINDER\}\$\{referenceNote\}\\n\\nQUESTION:/.test(llm),
    'the reference note is loaded and injected into the user turn (where a small model attends), between the injection reminder and the question');
  ok(fs.existsSync(path.join(PROJECT, 'lib', 'ai', 'data', 'mode-reference.txt')),
    'the reference-mode note lives in its own data file (no inline prompt drift)');

  console.log(`\nALL TOPIC-SWITCH-RETRIEVAL TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TOPIC-SWITCH-RETRIEVAL UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
