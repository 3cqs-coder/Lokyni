'use strict';
// Offline regression check for continuation-follow-up document ordering — the pure
// decision behind "tell me more". A vague continuation carries no topical signal, so the
// conversation's documents must be continued by prior PRIMACY (the order they were cited
// on the last answer), not by this query's fused retrieval score. Ordering by score let a
// higher-base-relevance co-source outrank the document the thread was actually about, so
// each "tell me more" drifted onto it and the model ended up disowning its earlier answer.
// This guards orderContinuationDocs deterministically, with no model or index. Run:
// `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { orderContinuationDocs } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const ids = (ranked) => ranked.map(([id]) => id);

try {
  // The reproduced bug: turn 1 cited [chess (primary, low score), crack (co-source, high
  // score)]; on "tell me more" the fused ranking scores crack above chess. A vague
  // continuation must still lead with chess (allowedDocIds[0] = the primary source).
  const ranked = [['crack', 49], ['chess', 5], ['other', 30]];
  const allowed = ['chess', 'crack'];

  const vague = orderContinuationDocs(ranked, allowed, true);
  ok(ids(vague)[0] === 'chess', `vague continuation must lead with the primary doc, got ${ids(vague)[0]}`);
  ok(ids(vague)[1] === 'crack', 'vague continuation keeps the co-source second (by primacy)');
  ok(ids(vague).includes('other'), 'non-conversation docs are retained after the allowed set');
  ok(ids(vague)[ids(vague).length - 1] === 'other', 'non-conversation docs come last');
  console.log('✓ continuation: vague "tell me more" orders allowed docs by conversation primacy, not score');

  // A specific follow-up has real keywords, so the fused score legitimately says which
  // allowed doc it targets — keep score order (crack ranked above chess here).
  const specific = orderContinuationDocs(ranked, allowed, false);
  ok(ids(specific)[0] === 'crack', 'specific follow-up keeps fused-score order for allowed docs');
  ok(ids(specific)[1] === 'chess', 'specific follow-up: lower-scoring allowed doc stays second');
  console.log('✓ continuation: specific follow-up keeps fused-score order among allowed docs');

  // Every allowed doc must survive the reordering — dropping one is how a co-source cited
  // earlier gets permanently lost, contradicting a later specific follow-up.
  ok(ids(vague).filter(id => id === 'chess' || id === 'crack').length === 2, 'no allowed doc dropped (vague)');
  ok(ids(specific).filter(id => id === 'chess' || id === 'crack').length === 2, 'no allowed doc dropped (specific)');

  // An allowed id that isn't in the ranking at all is simply skipped (no crash, no phantom).
  const withMissing = orderContinuationDocs([['a', 3]], ['zzz', 'a'], true);
  ok(ids(withMissing).length === 1 && ids(withMissing)[0] === 'a', 'missing allowed id is skipped, present one leads');

  // Empty / absent allowed set is a no-op passthrough.
  ok(orderContinuationDocs(ranked, [], true) === ranked, 'empty allowedDocIds returns the ranking unchanged');
  ok(orderContinuationDocs(ranked, null, true) === ranked, 'null allowedDocIds returns the ranking unchanged');
  console.log('✓ continuation: allowed docs preserved; missing/empty handled safely');

  // The drift gate behind "tell me more" not hijacking the thread with an off-topic co-source. ordering keeps
  // the primary first; this stops a co-source that advances onto unrelated content from being served at all.
  const { continuationDrifted } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));
  const topic = ['tokenization', 'defi', 'waller'];
  // The reproduced failure: a big co-source advances onto a passage with none of the topic words → skip it.
  ok(continuationDrifted('and micaiah said, as the lord liveth, what the lord saith', topic, false, 1) === true,
    'an off-topic co-source (other docs present) is gated out');
  // A co-source whose next content IS about the topic is kept.
  ok(continuationDrifted('more on tokenization of real-world assets', topic, false, 1) === false,
    'a co-source still on the topic is kept');
  // The primary document is NEVER gated — its forward content is the continuation the user asked for.
  ok(continuationDrifted('and micaiah said, as the lord liveth', topic, true, 1) === false,
    'the primary document is never gated, even off its last keywords');
  // A single-document conversation is never gated (no other doc to fall back to).
  ok(continuationDrifted('and micaiah said, as the lord liveth', topic, false, 0) === false,
    'a sole document is never gated');
  // No topic terms to judge (an un-rewritten vague query) → never gates, so it can only help.
  ok(continuationDrifted('anything at all', [], false, 1) === false, 'no topic terms → no gate');
  // Language-agnostic: a topic term in another script is matched by the same substring test.
  ok(continuationDrifted('исследование токенизации активов', ['токенизации'], false, 1) === false,
    'topic match works in any script (language-agnostic)');
  ok(continuationDrifted('完全无关的内容', ['токенизации'], false, 1) === true,
    'an off-topic chunk in another script is still gated');
  console.log('✓ continuation: drift gate skips off-topic co-sources, never the primary or a sole doc');

  console.log(`\nALL CONTINUATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CONTINUATION UNIT TEST FAILED:', e.message);
  process.exit(1);
}
