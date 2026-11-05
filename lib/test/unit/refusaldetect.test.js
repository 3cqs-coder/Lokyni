'use strict';
// Language-agnostic semantic refusal detection (lib/refusaldetect.js). The invariants: a short answer whose
// embedding is near a refusal prototype is flagged (so a non-English model refusal the English regex misses is
// still treated as a failure → web offer, not cached), a real answer is NOT flagged (never suppress a good
// answer), and the whole thing is fail-open (long text, no embedder, an embed error → false, leaving the regex
// result in force). Dependency-injected embed, so no model is needed. The real bge-m3 cross-lingual separation
// (refusals ~0.80-0.92 vs real answers ~0.24-0.49 to the English prototypes) was measured when choosing the
// default threshold; this test exercises the logic with synthetic vectors. Run: `npm run test:unit`.

const assert = require('assert'), path = require('path');
const rd = require(path.resolve(__dirname, '..', '..', 'refusaldetect'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// A tiny fake embedding space: each text maps to a unit-ish vector. "Refusal-like" texts point one way,
// "answer-like" another, so cosine cleanly separates them — mirroring what bge-m3 does cross-lingually.
const REFUSE_VEC = [1, 0, 0];
const ANSWER_VEC = [0, 1, 0];
const fakeEmbed = (t) => Promise.resolve(/refus|no info|sais pas|keine|нет|ない|não/i.test(t) ? REFUSE_VEC.slice() : ANSWER_VEC.slice());
const PROTOS = ['no relevant information found', 'that falls outside what I can help with'];
// Note: prototypes must embed to the refusal vector for the test — make them match the refusal regex.
const PROTOS2 = ['refusal prototype one', 'refusal prototype two'];

(async () => {
  try {
    rd._reset();
    // A refusal (any language) embeds near the prototype → flagged.
    eq(await rd.isSemanticRefusal({ text: 'Je ne sais pas, pas dans les documents', embed: fakeEmbed, prototypes: PROTOS2, threshold: 0.72 }), true,
      'a refusal-like short answer is flagged (cosine near the prototype)');
    rd._reset();
    // A real answer embeds far from the prototype → not flagged.
    eq(await rd.isSemanticRefusal({ text: 'La capitale est Paris', embed: fakeEmbed, prototypes: PROTOS2, threshold: 0.72 }), false,
      'a real answer is NOT flagged (far from the refusal prototype) — never suppress a good answer');

    // ── fail-open: long answer, no embedder, empty prototypes, embed error → false ──
    rd._reset();
    eq(await rd.isSemanticRefusal({ text: 'x'.repeat(500), embed: fakeEmbed, prototypes: PROTOS2, threshold: 0.72, maxChars: 400 }), false,
      'a long answer is never a refusal (over maxChars)');
    eq(await rd.isSemanticRefusal({ text: 'short', embed: null, prototypes: PROTOS2 }), false, 'no embedder → false (fail-open to the regex result)');
    eq(await rd.isSemanticRefusal({ text: 'short', embed: fakeEmbed, prototypes: [] }), false, 'no prototypes → false');
    eq(await rd.isSemanticRefusal({ text: '', embed: fakeEmbed, prototypes: PROTOS2 }), false, 'empty text → false');
    const throwing = () => Promise.reject(new Error('embed down'));
    eq(await rd.isSemanticRefusal({ text: 'refusal', embed: throwing, prototypes: PROTOS2 }), false, 'an embed error → false (never throws)');

    // ── threshold is respected: a borderline cosine below the bar is not a refusal ──
    rd._reset();
    const borderline = (t) => Promise.resolve(/proto/i.test(t) ? [1, 0, 0] : [0.8, 0.6, 0]);   // answer cosine 0.8 to proto
    eq(await rd.isSemanticRefusal({ text: 'answer', embed: borderline, prototypes: ['proto'], threshold: 0.9 }), false,
      'a cosine below the threshold is not flagged');
    rd._reset();
    eq(await rd.isSemanticRefusal({ text: 'answer', embed: borderline, prototypes: ['proto'], threshold: 0.75 }), true,
      'a cosine at/above the threshold is flagged');

    // ── prototype vectors are memoized: the embed fn is called once per distinct prototype across calls ──
    rd._reset();
    let calls = 0;
    const counting = (t) => { calls++; return Promise.resolve(/proto/i.test(t) ? [1, 0, 0] : [0, 1, 0]); };
    await rd.isSemanticRefusal({ text: 'a', embed: counting, prototypes: ['proto-x'], threshold: 0.9 });
    await rd.isSemanticRefusal({ text: 'b', embed: counting, prototypes: ['proto-x'], threshold: 0.9 });
    eq(calls, 3, 'the prototype is embedded once (memoized); only the two answers are embedded again');

    console.log(`\nALL REFUSAL-DETECT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ REFUSAL-DETECT TEST FAILED:', e && (e.stack || e.message));
    process.exit(1);
  }
})();
