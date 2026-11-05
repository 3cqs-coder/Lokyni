'use strict';

// Pure, single-source comparison of TWO embedding configurations' OUTPUT VECTORS — the measured answer to
// "are these the same vector space?" (the same model served by two providers / endpoints / builds, or two
// genuinely different models). Given the vectors both configs produced for the SAME input texts, it decides,
// with ONE set of thresholds, whether they are close enough to share an embedding bank (so switching provider
// never needs a re-embed) or are a different space (so a switch needs a re-embed, or the old endpoint kept
// reachable for its own bank). Keeping that decision here means the bank-alias resolver and any future caller
// can never drift on what "equivalent" means.
//
// No I/O, no model calls — just float math on vectors the caller already has. Language- and script-agnostic
// (it never looks at the text, only the numbers), bounded, crash-proof (every public fn guards its inputs and
// returns a safe shape, never throws), OOM-safe (operates pairwise, allocates nothing proportional to the
// corpus). The companion PROBE_TEXTS below is the shared multilingual sample a caller embeds through both sides
// when it has no corpus sample of its own.

// A compact, SYNTHETIC, MULTILINGUAL probe set — several scripts (Latin / Arabic / CJK / Cyrillic / Devanagari),
// so a serving difference that only shows up on non-Latin text (a tokenizer or normalization quirk) is caught
// too. Synthetic subjects only (no real people or places). Kept small so the embed cost and wall-clock stay
// tiny. ONE source: the compatibility measurement and the adapter fit both draw their fallback sample from here.
const PROBE_TEXTS = Object.freeze([
  'Zorvex Dynamics announced a new research engine for connecting ideas across documents.',
  'The Mibbly Collective studies how small teams share knowledge without a central database.',
  'Keltan Brightwater mapped the rivers of the Vexhollow basin over three dry seasons.',
  '¿Cómo se relaciona la migración de Plindos con el clima de la región de Mogdin?',
  'Les ingénieurs de Thaloria ont comparé deux méthodes de recherche sémantique.',
  'Die Forscher von Vexhollow untersuchten, wie Belege über Quellen hinweg zusammenpassen.',
  'قارن فريق كيلتان بين طريقتين لاسترجاع المعلومات عبر عدة لغات.',
  '凯尔坦研究所比较了两种跨语言检索方法的准确性。',
  'Исследователи Зорвекса изучали, как связаны темы в большом архиве документов.',
  'मोगडिन घाटी में शोधकर्ताओं ने दस्तावेज़ों के बीच संबंधों का अध्ययन किया।',
  'The Vexhollow protocol links a claim to the exact passage that supports it.',
  'A short query: Mibbly research methods.',
]);

// Cosine similarity of two equal-length numeric arrays. 0 when either is a zero vector or the lengths differ.
// A tiny, dependency-free local copy kept here so this module is pure and testable in isolation. Guards
// NaN / Infinity so one bad component can't poison it.
function cosine(a, b) {
  if (!Array.isArray(a) && !ArrayBuffer.isView(a)) return 0;
  if (!Array.isArray(b) && !ArrayBuffer.isView(b)) return 0;
  const n = Math.min(a.length, b.length);
  if (!n || a.length !== b.length) return 0; // different dimensionality → not comparable (caller flags it)
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = +a[i], y = +b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0; // a poisoned vector is treated as non-matching
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : 0;
}

function l2(a) {
  let s = 0; const n = a ? a.length : 0;
  for (let i = 0; i < n; i++) { const x = +a[i]; if (Number.isFinite(x)) s += x * x; }
  return Math.sqrt(s);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// Per-text cosine between A_i and B_i (the SAME input text embedded by each side), plus the distribution and the
// mean L2 norm each side produces (a sanity read on whether a side returns unit vectors). `vecsA`/`vecsB` are
// aligned arrays of equal length; mismatched / absent / odd-length pairs are skipped. Returns a plain stats
// object { n, dimA, dimB, comparable, cos:{min,p5,median,mean,max}|null, normA, normB }. comparable=false when
// the two sides disagree on dimensionality (then the spaces are trivially different and cos is null). Pure,
// bounded, never throws.
function cosineStats(vecsA, vecsB) {
  const out = { n: 0, dimA: 0, dimB: 0, comparable: false, cos: null, normA: 0, normB: 0 };
  try {
    const A = Array.isArray(vecsA) ? vecsA : [];
    const B = Array.isArray(vecsB) ? vecsB : [];
    const pairs = Math.min(A.length, B.length);
    const cosines = [];
    let sumNa = 0, sumNb = 0, countedNorms = 0;
    for (let i = 0; i < pairs; i++) {
      const a = A[i], b = B[i];
      if ((!Array.isArray(a) && !ArrayBuffer.isView(a)) || (!Array.isArray(b) && !ArrayBuffer.isView(b))) continue;
      if (!a.length || !b.length) continue;
      if (!out.dimA) out.dimA = a.length;
      if (!out.dimB) out.dimB = b.length;
      sumNa += l2(a); sumNb += l2(b); countedNorms++;
      if (a.length === b.length) cosines.push(cosine(a, b));
    }
    if (countedNorms) { out.normA = sumNa / countedNorms; out.normB = sumNb / countedNorms; }
    out.comparable = out.dimA > 0 && out.dimA === out.dimB && cosines.length > 0;
    out.n = cosines.length || countedNorms;
    if (out.comparable) {
      const sorted = cosines.slice().sort((x, y) => x - y);
      const mean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
      out.cos = { min: sorted[0], p5: percentile(sorted, 5), median: percentile(sorted, 50), mean, max: sorted[sorted.length - 1] };
    }
    return out;
  } catch { return out; }
}

// Thresholds — the ONE place "equivalent enough to share a bank" is defined. Grounded in what the vectors show:
// a quantization-level difference (e.g. a half-precision build vs full precision of the same weights) leaves
// cosine ~0.9999+, while a genuinely different build / version / model drops it materially. We require the WORST
// cases (p5) to stay high too, not just the median, so a long tail of divergent texts can't hide behind a good
// average. Conservative: when unsure, say "different" (a wrong "equivalent" would silently poison retrieval; a
// wrong "different" only costs an optional re-embed).
const THRESHOLDS = Object.freeze({
  identicalMedian: 0.99990,
  equivalentMedian: 0.99900, equivalentP5: 0.99500,
  closeMedian: 0.99000,
});

// A single-source verdict from the stats: a stable `level`, a `safeToShareBank` boolean, and a short human
// `message`. Pure; never throws. The bank-alias resolver gates on `safeToShareBank` (and only ever ADDS an alias
// on an explicit measured pass, never assumes one from a matching model name). `level` ∈
// 'incomparable' | 'different' | 'close' | 'equivalent' | 'identical'.
function compatibilityVerdict(stats) {
  const s = stats || {};
  if (!s.comparable || !s.cos) {
    const why = s.dimA && s.dimB && s.dimA !== s.dimB
      ? `different dimensionality (${s.dimA} vs ${s.dimB})`
      : 'no comparable vectors';
    return { level: 'incomparable', safeToShareBank: false, message: `Not the same vector space — ${why}. These must live in separate banks; switching requires a re-embed.` };
  }
  const { median, p5 } = s.cos;
  if (median >= THRESHOLDS.identicalMedian) return { level: 'identical', safeToShareBank: true, message: 'Effectively identical vectors — the two endpoints produce the same space. Switching needs no re-embed.' };
  if (median >= THRESHOLDS.equivalentMedian && p5 >= THRESHOLDS.equivalentP5) return { level: 'equivalent', safeToShareBank: true, message: 'Equivalent within quantization-level noise — safe to treat as one space (no re-embed). Re-validate if the build or quantization changes.' };
  if (median >= THRESHOLDS.closeMedian) return { level: 'close', safeToShareBank: false, message: 'Close but measurably different — the tail of texts diverges. Treat as separate banks (keep the old endpoint reachable, or re-embed); do not silently share.' };
  return { level: 'different', safeToShareBank: false, message: 'Different vector space — these are not interchangeable. A switch requires a re-embed (or keep each endpoint reachable for its own bank).' };
}

module.exports = { cosine, cosineStats, compatibilityVerdict, THRESHOLDS, PROBE_TEXTS };
