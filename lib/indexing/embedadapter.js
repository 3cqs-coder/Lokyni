'use strict';

// Pure, single-source core for a LEARNED LINEAR ADAPTER that bridges two embedding spaces (an old model's bank
// and a new model's), so a frozen bank stays searchable after its provider/model is dropped WITHOUT re-embedding
// the corpus. Given a paired sample — the same texts embedded by both models — it fits a linear map from one
// space to the other and measures, on HELD-OUT pairs, how well the mapped vectors preserve nearest-neighbour
// structure. That held-out retention is the honest gate: high ⇒ the adapter can translate a live query into the
// frozen bank's space (no re-embed); low ⇒ re-embed. The verdict thresholds live here so the fitting path and
// the query-time application can't drift on what "good enough" means.
//
// Method: DUAL (kernel) ridge regression with a linear kernel — mathematically the optimal L2-regularized linear
// map, but solved by inverting an N×N matrix (N = sample size), NOT a dim×dim one. So the cost and memory scale
// with the SAMPLE, not the embedding dimension: a 256-pair fit over 1024-dim vectors inverts a 256×256 matrix
// (fast, a few MB), never a 1024×1024 one. No linear-algebra dependency; Float64 for the solve (stability),
// bounded, crash-proof (guards singular / [] / NaN and returns a safe shape or null, never throws), OOM-safe
// (caps). Language- and script-agnostic: it never looks at the text, only the vectors.

const MAX_N = 2000;   // hard cap on fit-set size (the N×N solve is O(N^3); real samples are a few hundred)
const MAX_DIM = 8192; // hard cap on embedding dimension

function asVec(v) { return ArrayBuffer.isView(v) ? v : (Array.isArray(v) ? v : null); }

function dot(a, b) { let s = 0; const n = a.length; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosine(a, b) { const na = norm(a), nb = norm(b); if (!(na > 0) || !(nb > 0)) return 0; const c = dot(a, b) / (na * nb); return Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : 0; }

// Invert an N×N symmetric-positive-definite matrix (K + λI) by Gauss-Jordan with partial pivoting. Returns null
// on a singular / ill-posed matrix (the caller then declines rather than returning a garbage adapter). Pure.
function invertSPD(M, n) {
  try {
    // Build [M | I] as Float64 rows.
    const a = [];
    for (let i = 0; i < n; i++) { const row = new Float64Array(2 * n); for (let j = 0; j < n; j++) row[j] = M[i * n + j]; row[n + i] = 1; a.push(row); }
    for (let col = 0; col < n; col++) {
      // partial pivot
      let piv = col, best = Math.abs(a[col][col]);
      for (let r = col + 1; r < n; r++) { const v = Math.abs(a[r][col]); if (v > best) { best = v; piv = r; } }
      if (!(best > 1e-12)) return null; // singular
      if (piv !== col) { const t = a[piv]; a[piv] = a[col]; a[col] = t; }
      const prow = a[col]; const inv = 1 / prow[col];
      for (let j = 0; j < 2 * n; j++) prow[j] *= inv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = a[r][col];
        if (f === 0) continue;
        const rr = a[r];
        for (let j = 0; j < 2 * n; j++) rr[j] -= f * prow[j];
      }
    }
    // extract the right half
    const out = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = a[i][n + j];
    return out;
  } catch { return null; }
}

// Fit the adapter from paired vectors (aVecs[i] in the FROM space, bVecs[i] in the TO space). Returns a compact
// predictor { A, C, n, dimA, dimB, lambda } where a new from-space vector x maps to the to-space via applyAdapter:
// k = [x·A_1 … x·A_n]; mapped = k · C. (Kernel-ridge dual: C = (AAᵀ + λI)⁻¹ B.) Returns null when it can't be fit
// (too few pairs, a dim mismatch within a side, singular). Bounded + fail-safe.
function fitLinearAdapter(aVecs, bVecs, opts = {}) {
  try {
    const A = []; const B = [];
    const pairs = Math.min(Array.isArray(aVecs) ? aVecs.length : 0, Array.isArray(bVecs) ? bVecs.length : 0);
    let dimA = 0, dimB = 0;
    for (let i = 0; i < pairs && A.length < MAX_N; i++) {
      const a = asVec(aVecs[i]), b = asVec(bVecs[i]);
      if (!a || !b || !a.length || !b.length) continue;
      if (!dimA) dimA = a.length; if (!dimB) dimB = b.length;
      if (a.length !== dimA || b.length !== dimB) continue; // a side with inconsistent dim → skip the pair
      A.push(a); B.push(b);
    }
    const n = A.length;
    if (n < 8 || dimA < 1 || dimB < 1 || dimA > MAX_DIM || dimB > MAX_DIM) return null; // not enough signal
    // Gram matrix K (n×n), K_ij = a_i · a_j, then + λI. λ scales with the mean diagonal so it's unit-agnostic.
    const K = new Float64Array(n * n);
    let diagSum = 0;
    for (let i = 0; i < n; i++) { for (let j = i; j < n; j++) { const d = dot(A[i], A[j]); K[i * n + j] = d; K[j * n + i] = d; } diagSum += K[i * n + i]; }
    const lambda = (Number(opts.lambda) > 0 ? Number(opts.lambda) : 1e-2) * (diagSum / n || 1);
    for (let i = 0; i < n; i++) K[i * n + i] += lambda;
    const Kinv = invertSPD(K, n);
    if (!Kinv) return null;
    // C = Kinv · B  (n×dimB)
    const C = new Float32Array(n * dimB);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const w = Kinv[i * n + k]; if (w === 0) continue;
        const bk = B[k];
        for (let j = 0; j < dimB; j++) C[i * dimB + j] += w * bk[j];
      }
    }
    // Store the fit anchors A as Float32 rows for applyAdapter.
    const Af = A.map((a) => Float32Array.from(a));
    return { A: Af, C, n, dimA, dimB, lambda };
  } catch { return null; }
}

// Map a FROM-space vector into the TO space with a fitted adapter. Returns a UNIT-NORM Float32Array(dimB), or
// null on a dim mismatch / junk. Pure, bounded.
//
// The result is L2-normalized because the vectors it will be compared against (a bank's stored embeddings) are
// unit-norm and the retrieval cosine is a BARE DOT PRODUCT that assumes unit operands — a raw kernel-ridge
// prediction has arbitrary magnitude (ridge shrinkage pulls it below 1, overshoot above), which would mis-scale
// the absolute similarity that feeds the abstention / grounding / relevance floors. Normalizing is scale-invariant
// for ranking and for retentionScore's own cosine (which normalizes anyway), so it changes no measured verdict —
// it only makes the APPLIED score match the space it lands in.
function applyAdapter(adapter, x) {
  try {
    const v = asVec(x);
    if (!adapter || !v || v.length !== adapter.dimA) return null;
    const { A, C, n, dimB } = adapter;
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) k[i] = dot(A[i], v);
    const out = new Float32Array(dimB);
    for (let i = 0; i < n; i++) { const ki = k[i]; if (ki === 0) continue; const base = i * dimB; for (let j = 0; j < dimB; j++) out[j] += ki * C[base + j]; }
    const nrm = norm(out);
    if (nrm > 0) for (let j = 0; j < dimB; j++) out[j] /= nrm; // unit-norm to match the space it is scored in
    return out;
  } catch { return null; }
}

// Held-out retention — the HONEST retrieval test. For each held-out TO-space query b_t, we check whether its own
// mapped from-space vector ranks #1 against a CANDIDATE POOL that includes hard negatives: the mapped from-space
// vectors of a large set (pass `aPool` — the fit set — so the pool is the whole sample, mirroring production
// where a query ranks against the whole corpus of adapter-translated vectors). Ranking against only the handful
// of test items is trivially easy (top-1 ~100% even for unrelated spaces); a large pool makes top-1 meaningful.
// Also returns MRR and mean cosine to the true target. Pure; O((P+m)·m·dim), P = pool size (bounded by the
// caller's sample).
function retentionScore(adapter, aTest, bTest, aPool) {
  const out = { n: 0, pool: 0, top1: 0, mrr: 0, meanCos: 0 };
  try {
    const m = Math.min(Array.isArray(aTest) ? aTest.length : 0, Array.isArray(bTest) ? bTest.length : 0);
    const queries = []; const correct = [];
    for (let i = 0; i < m; i++) {
      const mp = applyAdapter(adapter, aTest[i]); const bt = asVec(bTest[i]);
      if (!mp || !bt || bt.length !== adapter.dimB) continue;
      correct.push(mp); queries.push(bt);
    }
    const M = correct.length;
    if (M < 2) return out;
    // Candidate pool = the hard negatives (mapped fit vectors) PLUS the correct held-out mapped vectors.
    const negatives = [];
    if (Array.isArray(aPool)) for (const a of aPool) { const mp = applyAdapter(adapter, a); if (mp) negatives.push(mp); }
    let top1 = 0, mrrSum = 0, cosSum = 0;
    for (let t = 0; t < M; t++) {
      const q = queries[t];
      const selfC = cosine(q, correct[t]);
      cosSum += selfC;
      let rank = 1;
      for (let s = 0; s < M; s++) { if (s !== t && cosine(q, correct[s]) > selfC) rank++; }
      for (let s = 0; s < negatives.length; s++) { if (cosine(q, negatives[s]) > selfC) rank++; }
      if (rank === 1) top1++;
      mrrSum += 1 / rank;
    }
    out.n = M; out.pool = M + negatives.length; out.top1 = top1 / M; out.mrr = mrrSum / M; out.meanCos = cosSum / M;
    return out;
  } catch { return out; }
}

// Thresholds — ONE place "good enough to skip a re-embed" is defined. Keyed on held-out top-1 self-retrieval and
// MRR. Conservative: a wrong "viable" silently degrades retrieval, a wrong "re-embed" only costs the re-embed.
const THRESHOLDS = Object.freeze({ strongTop1: 0.95, strongMrr: 0.97, partialTop1: 0.85 });

function alignmentVerdict(retention) {
  const r = retention || {};
  if (!r.n || r.n < 2) return { level: 'unknown', viable: false, message: 'Not enough held-out pairs to judge — gather a larger sample.' };
  if (r.top1 >= THRESHOLDS.strongTop1 && r.mrr >= THRESHOLDS.strongMrr) return { level: 'strong', viable: true, message: `A linear adapter preserves the structure (held-out top-1 ${(r.top1 * 100).toFixed(1)}%). The old bank's vectors can be served by translating the live query instead of re-embedding.` };
  if (r.top1 >= THRESHOLDS.partialTop1) return { level: 'partial', viable: false, message: `An adapter recovers most but not all of the structure (top-1 ${(r.top1 * 100).toFixed(1)}%). Usable for a soft migration, but re-embed for full fidelity.` };
  return { level: 'weak', viable: false, message: `An adapter does not bridge these spaces well (top-1 ${(r.top1 * 100).toFixed(1)}%). Re-embed — a learned map won't save the quality.` };
}

// Ridge-regularization candidates for fitBestAdapter's sweep. The default (1e-2) is in the set, so the chosen λ
// is never worse than the old single-λ fit ON THE VALIDATION SPLIT it is selected against. Small and fixed so
// the sweep stays bounded and cheap.
const LAMBDAS = Object.freeze([1e-3, 1e-2, 1e-1, 1]);

// Fit the best ridge adapter by SWEEPING the regularization λ and choosing the one with the highest held-out
// retention on an INTERNAL validation split. Why: a single fixed λ under- or over-regularizes depending on the
// model pair, and a hard pair the default λ would mark non-viable (forcing a full re-embed) can still be bridged
// when a better-regularized fit exists — measured, not assumed. Because the default λ is one of the candidates
// and selection takes the max retention, the chosen λ matches or beats the default on the validation split (a
// point estimate, not a guarantee on the independent gate split). Correctness does not rest on that: selection
// uses its OWN split of (aVecs,bVecs), so the caller's SEPARATE test split — the viability GATE — is never used
// for selection, stays an honest held-out estimate, and still decides shipping. At worst the sweep yields a
// marginally-different-but-still-gated adapter; it can never let a non-viable adapter through. All candidates are
// the SAME ridge kind, so there is one applyAdapter and one serialize format — no new transform, no drift.
// Returns { adapter, lambda, valTop1 } or null. Async so each candidate fit can YIELD the event loop between
// them: every fit is a bounded synchronous O(N^3) solve, and a few in a row would stall serving for too long, so
// `opts.yield` (an async hook, e.g. `() => new Promise(r => setImmediate(r))`) is awaited between fits — no single
// stall then exceeds one fit, while the total work is unchanged. Without a yield it runs straight through (tests,
// or a caller that does not mind). Bounded, fail-safe → null.
async function fitBestAdapter(aVecs, bVecs, opts = {}) {
  try {
    const doYield = typeof opts.yield === 'function' ? opts.yield : null;
    const A = Array.isArray(aVecs) ? aVecs : [], B = Array.isArray(bVecs) ? bVecs : [];
    const n = Math.min(A.length, B.length);
    // Too few pairs to split for selection: fall back to a single fit at the requested/default λ.
    if (n < 20) { const ad = fitLinearAdapter(A, B, opts); return ad ? { adapter: ad, lambda: Number(opts.lambda) > 0 ? Number(opts.lambda) : 1e-2, valTop1: null } : null; }
    // Internal fit/validation split (every 5th pair → validation) used ONLY to choose λ.
    const aFit = [], bFit = [], aVal = [], bVal = [];
    for (let i = 0; i < n; i++) (i % 5 === 0 ? (aVal.push(A[i]), bVal.push(B[i])) : (aFit.push(A[i]), bFit.push(B[i])));
    let best = null;
    for (const lam of LAMBDAS) {
      if (doYield) { try { await doYield(); } catch { /* a bad yield hook must not fail the fit */ } }
      const ad = fitLinearAdapter(aFit, bFit, { lambda: lam });
      if (!ad) continue;
      const ret = retentionScore(ad, aVal, bVal, aFit); // rank each val query against the fit set (hard negatives)
      const score = ret.top1 + 0.001 * ret.mrr;         // top-1 primary; MRR only breaks ties
      if (!best || score > best.score) best = { lambda: lam, score, valTop1: ret.top1 };
    }
    // Refit on ALL pairs with the chosen λ (the validation split was only for selection).
    if (doYield) { try { await doYield(); } catch { /* ignore */ } }
    const lambda = best ? best.lambda : (Number(opts.lambda) > 0 ? Number(opts.lambda) : 1e-2);
    const adapter = fitLinearAdapter(A, B, { lambda });
    return adapter ? { adapter, lambda, valTop1: best ? best.valTop1 : null } : null;
  } catch { return null; }
}

// --- Persistence ---------------------------------------------------------------------------------------
// A fitted adapter is STORED and applied at query time (translate a live-model query vector into a frozen bank's
// old space, so the old bank stays searchable after its provider is dropped — no re-embed). The on-disk form is a
// compact little-endian binary blob so the store holds bytes, not JSON of a million floats. ONE serializer /
// deserializer here is the single source of truth for the layout, so the fitting path that writes an adapter and
// the retriever that reads one can never drift. Both are pure, bounded and fail-safe (return null, never throw):
// a corrupt or oversized blob simply yields no adapter and retrieval falls back to the bank's lexical signal.
//
// Layout: magic | u8 version | 3 reserved | u32 n | u32 dimA | u32 dimB | f64 lambda | n·dimA f32 (A, row-major)
// | n·dimB f32 (C, row-major). Size = 28 + 4·n·(dimA+dimB).
const ADAPTER_MAGIC = 0x50444145; // little-endian
const ADAPTER_VERSION = 1;
const ADAPTER_HEADER = 28;
const MAX_ADAPTER_BYTES = 48 * 1024 * 1024; // refuse to serialize / accept a blob larger than this (OOM guard)

function serializeAdapter(adapter) {
  try {
    const a = adapter || {};
    const n = a.n | 0, dimA = a.dimA | 0, dimB = a.dimB | 0;
    if (n < 1 || dimA < 1 || dimB < 1 || n > MAX_N || dimA > MAX_DIM || dimB > MAX_DIM) return null;
    if (!Array.isArray(a.A) || a.A.length !== n || !ArrayBuffer.isView(a.C) || a.C.length !== n * dimB) return null;
    const bytes = ADAPTER_HEADER + 4 * (n * dimA + n * dimB);
    if (bytes > MAX_ADAPTER_BYTES) return null;
    const buf = Buffer.allocUnsafe(bytes);
    buf.writeUInt32LE(ADAPTER_MAGIC, 0);
    buf.writeUInt8(ADAPTER_VERSION, 4); buf.writeUInt8(0, 5); buf.writeUInt8(0, 6); buf.writeUInt8(0, 7);
    buf.writeUInt32LE(n, 8); buf.writeUInt32LE(dimA, 12); buf.writeUInt32LE(dimB, 16);
    buf.writeDoubleLE(Number(a.lambda) || 0, 20);
    let off = ADAPTER_HEADER;
    for (let i = 0; i < n; i++) {
      const row = a.A[i];
      if (!ArrayBuffer.isView(row) || row.length !== dimA) return null;
      for (let j = 0; j < dimA; j++) { buf.writeFloatLE(row[j], off); off += 4; }
    }
    for (let i = 0; i < n * dimB; i++) { buf.writeFloatLE(a.C[i], off); off += 4; }
    return buf;
  } catch { return null; }
}

function deserializeAdapter(blob) {
  try {
    const buf = Buffer.isBuffer(blob) ? blob : (blob && blob.buffer ? Buffer.from(blob.buffer, blob.byteOffset || 0, blob.byteLength) : (blob ? Buffer.from(blob) : null));
    if (!buf || buf.length < ADAPTER_HEADER || buf.length > MAX_ADAPTER_BYTES) return null;
    if (buf.readUInt32LE(0) !== ADAPTER_MAGIC || buf.readUInt8(4) !== ADAPTER_VERSION) return null;
    const n = buf.readUInt32LE(8), dimA = buf.readUInt32LE(12), dimB = buf.readUInt32LE(16);
    if (n < 1 || dimA < 1 || dimB < 1 || n > MAX_N || dimA > MAX_DIM || dimB > MAX_DIM) return null;
    const lambda = buf.readDoubleLE(20);
    const expect = ADAPTER_HEADER + 4 * (n * dimA + n * dimB);
    if (buf.length !== expect) return null;
    let off = ADAPTER_HEADER;
    const A = new Array(n);
    for (let i = 0; i < n; i++) { const row = new Float32Array(dimA); for (let j = 0; j < dimA; j++) { row[j] = buf.readFloatLE(off); off += 4; } A[i] = row; }
    const C = new Float32Array(n * dimB);
    for (let i = 0; i < n * dimB; i++) { C[i] = buf.readFloatLE(off); off += 4; }
    return { A, C, n, dimA, dimB, lambda };
  } catch { return null; }
}

module.exports = { fitLinearAdapter, fitBestAdapter, applyAdapter, retentionScore, alignmentVerdict, cosine, serializeAdapter, deserializeAdapter, THRESHOLDS, LAMBDAS, MAX_N, MAX_DIM, MAX_ADAPTER_BYTES };
