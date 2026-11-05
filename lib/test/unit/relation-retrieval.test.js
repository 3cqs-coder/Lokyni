'use strict';
// End-to-end guard for two-sided RELATIONAL retrieval. A question that asks how two subjects relate — "how does A
// relate to B?", "connect A with B", "the relationship between A and B" — must serve BOTH subjects' documents, the
// same way an explicit "compare A and B" does, or the model only sees one side and cannot connect them. This runs
// the REAL search orchestration over the deterministic, model-free embedder (lib/test/eval/retrieval-harness), so
// it is offline and identical on every platform. It is the end-to-end counterpart to relation-intent.test.js
// (which guards the routing decision alone). Everything is synthetic. Run: `npm run test:unit`.

const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(PROJECT, 'lib', 'test', 'eval', 'retrieval-harness'));

// Two distinct synthetic subjects that do NOT co-occur (so the entity graph has no bridge), one denser than the
// other, plus filler so the names are rare. The weaker subject (Qubblen) is the one that used to be dropped.
const DOCS = [
  { lang: 'en', name: 'vexmor.md',
    text: 'Vexmor is a settlement protocol. Vexmor settlement clears debt and equity on a shared ledger with '
      + 'automated finality. Vexmor settlement reduces intermediation. Vexmor keeps custody with the original '
      + 'holders. Regional exchanges use Vexmor for tokenized settlement.' },
  { lang: 'en', name: 'qubblen.md',
    text: 'Qubblen is a settlement and clearing network. Qubblen clears debt and equity for institutional '
      + 'participants through a central counterparty with automated finality. Qubblen delegates custody to agents.' },
  { lang: 'en', name: 'orchard.md', text: 'The orchard keeper pruned the pear trees before the first frost.' },
  { lang: 'en', name: 'river.md', text: 'The survey counted the herons along the north ridge at dawn.' },
  { lang: 'en', name: 'kiln.md', text: 'The potter trimmed the foot of each bowl when the clay was leather-hard.' },
];

const fails = [];
const served = (r) => (r.sources || []).map(s => s.source);
const both = (r) => served(r).includes('vexmor.md') && served(r).includes('qubblen.md');

(async () => {
  const { bundle } = await H.buildFixtureBundle(DOCS);
  await H.withRetrievalConfig(H.RETRIEVAL_OFF, async () => {
    // Two-sided relational questions must serve BOTH subjects (English + multilingual cue).
    const TWO_SIDED = [
      'how does Vexmor relate to Qubblen?',
      'connect Vexmor with Qubblen',
      'how is Vexmor linked to Qubblen?',
      'associate Vexmor with Qubblen',
      'what is the relationship between Vexmor and Qubblen?',
      '¿cómo se relaciona Vexmor con Qubblen?',
    ];
    for (const q of TWO_SIDED) {
      const r = await H.runRetrieval(bundle, q, H.makeConversation());
      if (!both(r)) fails.push(`  ✗ two-sided query served only [${served(r)}]: "${q}"`);
    }

    // An explicit comparison must serve both too (the behavior relational queries are aligned to).
    {
      const r = await H.runRetrieval(bundle, 'compare Vexmor and Qubblen', H.makeConversation());
      if (!both(r)) fails.push(`  ✗ comparison served only [${served(r)}]: "compare Vexmor and Qubblen"`);
    }

    // A SINGLE-subject question must NOT drag in the other subject — the two-sided handling is scoped to queries
    // that actually name two subjects (the precision guard, at the retrieval level).
    {
      const r = await H.runRetrieval(bundle, 'what did Vexmor establish about settlement?', H.makeConversation());
      if (served(r).includes('qubblen.md')) fails.push(`  ✗ single-subject query pulled in the other subject: [${served(r)}]`);
      if (!served(r).includes('vexmor.md')) fails.push(`  ✗ single-subject query did not serve its own subject: [${served(r)}]`);
    }
  });

  if (fails.length) {
    console.error(`\n✗ RELATION-RETRIEVAL — ${fails.length} failure(s):\n` + fails.join('\n'));
    process.exit(1);
  }
  console.log('✓ relation-retrieval: two-sided relational questions (English + multilingual) serve BOTH subjects, '
    + 'like an explicit comparison; a single-subject question stays on its one subject');
  console.log('\nALL RELATION-RETRIEVAL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('\n✗ RELATION-RETRIEVAL TEST ERROR:', e && e.stack || e); process.exit(1); });
