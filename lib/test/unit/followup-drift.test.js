'use strict';
// MULTI-TURN CONTINUATION DRIFT — the end-to-end counterpart to followup-matrix.test.js.
//
// The matrix proves the CLASSIFIER never mislabels a follow-up. This proves the whole retrieval pipeline then
// SERVES the right thing across real multi-turn conversations: a vague continuation stays on the thread's
// document and never drifts onto (a) a co-retrieved document's unrelated later pages, or (b) a different-subject
// document that merely shares domain vocabulary — the two ways "tell me more" and "what else does it talk
// about" used to wander — while a genuine PIVOT still moves to the new subject.
//
// It runs the REAL orchestration (initial search + follow-up passage logic + ordering + drift gate) over a
// deterministic, model-free embedder (lib/test/eval/retrieval-harness), so it is fast, offline, and identical on
// every platform and in CI. Everything is synthetic, and one thread is non-English so the guarantee is shown to
// be language-agnostic. Run: `npm run test:unit`.

const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(PROJECT, 'lib', 'test', 'eval', 'retrieval-harness'));

// A marker that appears ONLY in the off-topic later pages of a large co-source. If a continuation serves a
// window containing it, the thread has drifted onto unrelated content.
const OFFTOPIC_MARKER = 'HERONRIDGE';
const PASSAGE = H.RETRIEVAL_OFF.PASSAGE_SIZE;   // the window width the harness serves at

// On-topic padding keeps a co-source's FIRST window on-topic; the off-topic body (with the marker) then lives
// only PAST that first window, so reaching it means a genuine sequential advance off the topic, not just a long
// opening window. n=90 lands the marker just past the 8000-char boundary — inside the next advance window.
const onTopicPad = (subject, phrase, n = 90) =>
  Array.from({ length: n }, (_, i) => `${subject} ${phrase} (clause ${i}).`).join(' ');
const offTopicBody = (phrase) =>
  Array.from({ length: 120 }, (_, i) => `At ${OFFTOPIC_MARKER} ${phrase}, entry ${i}.`).join('\n');

// Synthetic corpus. Subjects are invented; domain vocabulary (settlement, ledger, clearing) is shared across the
// finance documents so a naive expansion could pull a different-subject finance document into a vague follow-up.
const DOCS = [
  { lang: 'en', name: 'vexmor-core.md',
    text: 'Vexmor settlement brief, code VXR-9042. Vexmor established that tokenized settlement on a shared ledger '
      + 'lets regional exchanges clear debt and equity positions with automated finality, code VXR-9042. Vexmor '
      + 'settlement reduces intermediation while custody stays with the original holders.' },
  { lang: 'en', name: 'vexmor-saga.md',
    text: 'Vexmor settlement, chronicle edition. This record restates that Vexmor established tokenized settlement '
      + 'on a shared ledger for regional exchanges to clear debt and equity with automated finality.\n\n'
      + onTopicPad('Vexmor', 'restates tokenized settlement on a shared ledger for regional exchanges')
      + '\n\n' + offTopicBody('the orchard keeper counted the herons on the still water and pruned the pear trees') },
  { lang: 'en', name: 'qubblen-brief.md',
    text: 'Qubblen is a separate clearing network. Qubblen operates a settlement ledger for institutional '
      + 'participants, clearing debt and equity positions through a central counterparty with automated finality. '
      + 'Qubblen custody is delegated to approved agents.' },
  { lang: 'es', name: 'mirenza-core.md',
    text: 'Mirenza nota de liquidación, código MRZ-7731. Mirenza estableció que la liquidación tokenizada en un '
      + 'libro mayor compartido permite a las bolsas regionales compensar posiciones de deuda y capital con '
      + 'firmeza automática, código MRZ-7731. Mirenza reduce la intermediación.' },
  { lang: 'es', name: 'mirenza-saga.md',
    text: 'Mirenza liquidación, edición crónica. Este registro repite que Mirenza estableció la liquidación '
      + 'tokenizada en un libro mayor compartido para las bolsas regionales.\n\n'
      + onTopicPad('Mirenza', 'repite la liquidación tokenizada en un libro mayor compartido para las bolsas')
      + '\n\n' + offTopicBody('el jardinero contó las garzas sobre el agua tranquila y podó los perales') },
  { lang: 'en', name: 'orchard-notes.md',
    text: 'The orchard keeper pruned the pear trees and set the beehives before the first frost arrived this year.' },
  { lang: 'en', name: 'river-survey.md',
    text: 'The survey counted the herons along the north ridge at dawn across three quiet mornings by the ford.' },
  { lang: 'en', name: 'kiln-log.md',
    text: 'The potter centered the clay, pulled the walls thin, and trimmed the foot of each bowl when leather-hard.' },
];

const fails = [];
const note = (what, detail) => fails.push(`  ✗ ${what}  —  ${detail}`);
const docTextByName = new Map(DOCS.map(d => [d.name, d.text]));
// True if any served passage window overlaps the marker in its own document — by exact [start,end] range, so it
// reflects the content actually served, not a capped preview.
const servedContains = (result, marker) =>
  (result.sources || []).some(s => {
    const text = docTextByName.get(s.source);
    return text ? text.slice(s.passageStart || 0, s.passageEnd ?? text.length).includes(marker) : false;
  });
const servedNames = (result) => (result.sources || []).map(s => s.source);

// A two-document continuation set up the way turn 1 leaves it: `core` is the primary; the large `saga` co-source
// has been read through its on-topic first window (docReadPos = PASSAGE). This is the exact state in which a
// "tell me more" could advance the co-source onto its off-topic later pages — the drift the gate must stop.
const twoDocContinuation = (coreName, sagaName, q1, a1) => H.makeConversation({
  history: [{ role: 'user', content: q1 }, { role: 'assistant', content: a1 }],
  allowedDocIds: [H.docIdForName(coreName), H.docIdForName(sagaName)],
  docReadPos: new Map([[H.docIdForName(sagaName), PASSAGE]]),
  docPassages: new Map([[H.docIdForName(sagaName), [{ start: 0, end: PASSAGE }]]]),
});

(async () => {
  const { bundle } = await H.buildFixtureBundle(DOCS);

  // Sanity: the co-source's off-topic marker must be PAST the first window, or the drift cases are vacuous.
  for (const saga of ['vexmor-saga.md', 'mirenza-saga.md']) {
    const at = docTextByName.get(saga).indexOf(OFFTOPIC_MARKER);
    if (!(at > PASSAGE)) note('test setup: off-topic marker is not past the first window', `${saga} markerAt=${at}`);
  }

  await H.withRetrievalConfig(H.RETRIEVAL_OFF, async () => {
    const q1 = 'What did Vexmor establish about tokenized settlement, code VXR-9042?';
    const a1 = 'Vexmor (code VXR-9042) established tokenized settlement on a shared ledger for regional exchanges.';

    // Turn 1 must retrieve the subject document (precondition for the follow-up cases to be meaningful).
    {
      const r1 = await H.runRetrieval(bundle, q1, H.makeConversation());
      if (!servedNames(r1).includes('vexmor-core.md')) note('turn 1 did not retrieve the subject document', `served=[${servedNames(r1)}]`);
    }

    // Pattern 1 — co-source sequential drift: "tell me more" must advance the primary, not the co-source's
    // off-topic later pages (the drift gate).
    {
      const rMore = await H.runRetrieval(bundle, 'tell me more', twoDocContinuation('vexmor-core.md', 'vexmor-saga.md', q1, a1));
      if (servedContains(rMore, OFFTOPIC_MARKER)) note('"tell me more" drifted onto the off-topic co-source pages', `served=[${servedNames(rMore)}]`);
    }

    // Pattern 2 — expansion tangential drift: "what else does it talk about" must not pull in a different-subject
    // document that merely shares domain vocabulary, and must not drift onto off-topic pages.
    {
      const convo = H.makeConversation({ history: [{ role: 'user', content: q1 }, { role: 'assistant', content: a1 }],
        allowedDocIds: [H.docIdForName('vexmor-core.md')] });
      const rElse = await H.runRetrieval(bundle, 'what else does it talk about', convo);
      if (servedNames(rElse).includes('qubblen-brief.md')) note('"what else does it talk about" pulled in a different-subject document', `served=[${servedNames(rElse)}]`);
      if (servedContains(rElse, OFFTOPIC_MARKER)) note('"what else does it talk about" drifted onto off-topic pages', `served=[${servedNames(rElse)}]`);
    }

    // Pattern 3 — an explicit pivot must move to the new subject.
    {
      const convo = H.makeConversation({ history: [{ role: 'user', content: q1 }, { role: 'assistant', content: a1 }],
        allowedDocIds: [H.docIdForName('vexmor-core.md')] });
      const rPivot = await H.runRetrieval(bundle, 'what about Qubblen?', convo);
      if (!servedNames(rPivot).includes('qubblen-brief.md')) note('an explicit pivot did not move to the new subject', `served=[${servedNames(rPivot)}]`);
    }

    // Pattern 4 — the same co-source drift guarantee in a non-English thread (language-agnostic): a Spanish
    // continuation imperative absent from the corpus must still be recognized and gated.
    {
      const esQ = '¿Qué estableció Mirenza sobre la liquidación tokenizada, código MRZ-7731?';
      const esA = 'Mirenza estableció la liquidación tokenizada en un libro mayor compartido.';
      const rMore = await H.runRetrieval(bundle, 'cuéntame más', twoDocContinuation('mirenza-core.md', 'mirenza-saga.md', esQ, esA));
      if (servedContains(rMore, OFFTOPIC_MARKER)) note('a Spanish continuation drifted onto off-topic pages', `served=[${servedNames(rMore)}]`);
    }
  });

  if (fails.length) {
    console.error(`\n✗ MULTI-TURN DRIFT — ${fails.length} failure(s):\n` + fails.join('\n'));
    process.exit(1);
  }
  console.log('✓ follow-up drift: vague continuations stay on the thread (no co-source off-topic pages, no '
    + 'tangential same-domain document); explicit pivots move to the new subject; holds in a non-English thread');
  console.log('\nALL MULTI-TURN DRIFT TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('\n✗ MULTI-TURN DRIFT TEST ERROR:', e && e.stack || e); process.exit(1); });
