'use strict';
// COMPREHENSIVE MULTI-TURN CONVERSATION JOURNEYS — the systematic guard against the "one search, one patch" cycle
// at the whole-conversation level. Instead of testing one follow-up shape in isolation, each JOURNEY below is a
// full sequence the way a real user moves through a multi-topic corpus — ask about a topic, follow up, pivot to
// another, ask how two relate, continue, switch language — and asserts WHICH documents are served (and which are
// NOT) at every turn. It threads the conversation state (allowedDocIds + history) across turns exactly as the
// live caller does, so a regression in how one turn feeds the next is caught here, not in production.
//
// It runs the REAL search orchestration over the deterministic, model-free embedder (lib/test/eval/
// retrieval-harness), so it is offline, fast, and identical on every platform. Everything is synthetic, and some
// journeys are non-English so the behavior is shown to be language-agnostic. Every failing turn across every
// journey is reported together. Run: `npm run test:unit`.

const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(PROJECT, 'lib', 'test', 'eval', 'retrieval-harness'));

// A synthetic multi-topic corpus: two finance subjects that share domain vocabulary (so they can be compared and
// pivoted between), two unrelated subjects, and a non-English subject. Distinct enough that the model-free
// embedder separates them deterministically. (Drift onto a large co-source's off-topic pages is covered in depth
// by followup-drift.test.js; this harness focuses on multi-turn SEQUENCES across topics, so it carries no
// competing same-subject document that would make a "Vexmor" query ambiguous.)
const DOCS = [
  { lang: 'en', name: 'vexmor.md',
    text: 'Vexmor settlement brief, code VXR-9042. Vexmor is a settlement protocol. Vexmor settlement clears debt '
      + 'and equity on a shared ledger with automated finality, and keeps custody with the original holders.' },
  { lang: 'en', name: 'qubblen.md',
    text: 'Qubblen clearing brief, code QBL-3310. Qubblen is a settlement and clearing network. Qubblen clears '
      + 'debt and equity for institutional participants through a central counterparty with automated finality.' },
  { lang: 'en', name: 'thaloria.md',
    text: 'Thaloria almanac, code THL-7731. Thaloria is a weather forecasting service. Thaloria studies pressure, '
      + 'wind, and humidity to predict storms and warn harbors several days ahead of the season.' },
  { lang: 'en', name: 'kelthorn.md',
    text: 'Kelthorn handbook, code KTH-5520. Kelthorn is a beekeeping guide. Kelthorn covers tending the hives, '
      + 'harvesting honey, and protecting the bees from frost through the cold winter months.' },
  { lang: 'es', name: 'mirenza.md',
    text: 'Mirenza, código MRZ-1935. Mirenza es un protocolo de liquidación. Mirenza permite a las bolsas '
      + 'compensar posiciones de deuda y capital con firmeza automática en un libro mayor compartido.' },
  { lang: 'en', name: 'orchard.md', text: 'The orchard keeper pruned the pear trees before the first frost arrived.' },
  { lang: 'en', name: 'river.md', text: 'The survey counted the herons along the north ridge at dawn for three mornings.' },
];

const fails = [];
const served = (r) => (r.sources || []).map(s => s.source);
// Thread the conversation the way the live caller does: served docs become the allowed set, and the exchange is
// appended to history, so the next turn is a true follow-up.
const advance = (convo, r, q) => {
  const ids = (r.sources || []).map(s => s.id);
  if (ids.length) convo.allowedDocIds = ids;
  convo.history.push({ role: 'user', content: q });
  convo.history.push({ role: 'assistant', content: `Re: ${q}` });
};

// Each journey is a named list of turns. A turn asserts some docs are served (`serves`) and/or that some are NOT
// (`notServes`). These are the DETERMINISTIC multi-turn behaviors — continuation and two-sided relation — which
// are decided by the heuristic/regex layer and so are faithfully reproducible over the model-free embedder. A
// genuine PIVOT / topic switch to a new subject ("what about Thaloria?") is decided by the LLM intent classifier
// in production (it is off in this offline config), so it is validated by the real-model conversation eval
// (lib/test/eval/run.js), not asserted here where only the heuristic fallback runs.
const JOURNEYS = [
  { name: 'continuation stays on its topic, never leaks to another', turns: [
    { q: 'What did Vexmor establish about settlement, code VXR-9042?', serves: ['vexmor.md'] },
    { q: 'tell me more',              serves: ['vexmor.md'], notServes: ['thaloria.md', 'kelthorn.md', 'qubblen.md'] },
    { q: 'what else does it cover?',  notServes: ['thaloria.md', 'kelthorn.md', 'qubblen.md'] },
    { q: 'go on',                     notServes: ['thaloria.md', 'kelthorn.md', 'qubblen.md'] },
  ] },
  { name: 'relate two subjects serves both, then a continuation stays on them', turns: [
    { q: 'What is Vexmor settlement, code VXR-9042?',          serves: ['vexmor.md'] },
    { q: 'how does Vexmor relate to Qubblen?',                 serves: ['vexmor.md', 'qubblen.md'] },
    { q: 'tell me more',                                        notServes: ['thaloria.md', 'kelthorn.md'] },
  ] },
  { name: 'a second, unrelated topic can be the whole thread', turns: [
    { q: 'What does Kelthorn cover about beekeeping, code KTH-5520?', serves: ['kelthorn.md'], notServes: ['vexmor.md', 'qubblen.md'] },
    { q: 'tell me more',  serves: ['kelthorn.md'], notServes: ['vexmor.md', 'qubblen.md', 'thaloria.md'] },
  ] },
  { name: 'non-English continuation stays on topic (language-agnostic)', turns: [
    { q: '¿Qué estableció Mirenza sobre la liquidación, código MRZ-1935?', serves: ['mirenza.md'] },
    { q: 'cuéntame más', serves: ['mirenza.md'], notServes: ['thaloria.md', 'kelthorn.md'] },
    { q: '¿qué más?',    notServes: ['thaloria.md', 'kelthorn.md', 'qubblen.md'] },
  ] },
  // Honesty across a PIVOT: raising a NOVEL off-corpus subject (a name-like code absent from every document) as a
  // follow-up must ABSTAIN, not inherit the prior turn's document — the novel-entity gate holds mid-conversation,
  // not only on a first query. (A bare off-corpus noun at the sentence start is the LLM intent classifier's job in
  // production — see the header note — so this asserts the name-like case the offline heuristic layer decides.)
  { name: 'off-corpus novel-entity follow-up abstains (honesty holds across a pivot)', turns: [
    { q: 'What did Vexmor establish about settlement, code VXR-9042?', serves: ['vexmor.md'] },
    { q: 'What about the Zentara-9 clearing network?', declines: true, notServes: ['vexmor.md', 'qubblen.md', 'thaloria.md'] },
  ] },
  { name: 'off-corpus novel-entity follow-up abstains in another language too', turns: [
    { q: '¿Qué estableció Mirenza sobre la liquidación, código MRZ-1935?', serves: ['mirenza.md'] },
    { q: '¿Y el protocolo Zentara-9?', declines: true, notServes: ['mirenza.md', 'qubblen.md'] },
  ] },
];

(async () => {
  const { bundle } = await H.buildFixtureBundle(DOCS);
  await H.withRetrievalConfig(H.RETRIEVAL_OFF, async () => {
    for (const journey of JOURNEYS) {
      const convo = H.makeConversation();
      let turnNo = 0;
      for (const turn of journey.turns) {
        turnNo++;
        const r = await H.runRetrieval(bundle, turn.q, convo);
        const got = served(r);
        const where = `[${journey.name}] turn ${turnNo} "${turn.q.slice(0, 42)}"`;
        for (const doc of (turn.serves || [])) {
          if (!got.includes(doc)) fails.push(`  ✗ ${where} — expected to serve ${doc}, served [${got}]`);
        }
        for (const doc of (turn.notServes || [])) {
          if (got.includes(doc)) fails.push(`  ✗ ${where} — should NOT serve ${doc}, served [${got}]`);
        }
        // `declines`: the turn must ABSTAIN (outOfScope) — an off-corpus subject raised mid-conversation must not
        // be answered from the prior turn's document. Honesty must hold across a pivot, not only on a first query.
        if (turn.declines && r.outOfScope !== true) fails.push(`  ✗ ${where} — expected to DECLINE (outOfScope), served [${got}]`);
        advance(convo, r, turn.q);
      }
    }
  });

  if (fails.length) {
    console.error(`\n✗ CONVERSATION JOURNEYS — ${fails.length} failing turn(s):\n` + fails.join('\n'));
    process.exit(1);
  }
  const turns = JOURNEYS.reduce((n, j) => n + j.turns.length, 0);
  console.log(`✓ conversation journeys: ${JOURNEYS.length} multi-turn journeys, ${turns} turns ` +
    `(continuation, relate-both, second-topic, non-English, off-corpus-pivot-abstains) all serve the right documents / decline`);
  console.log('\nALL CONVERSATION JOURNEY TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('\n✗ CONVERSATION JOURNEYS TEST ERROR:', e && e.stack || e); process.exit(1); });
