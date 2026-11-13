'use strict';
// Answer confidence — the single source of truth for how sure Lokyni is about an answer, blended from
// signals it already computes. It is DISTINCT from the per-source "match strength" dot on each citation
// (that is one document's cross-encoder score); this is one holistic, answer-level verdict.
//
// Everything here is language-agnostic: the blend is numeric/enum only, so it works identically for an
// answer in any language. The labels are UI chrome (English, like the Verify badge) and are projected to
// the frontend from here so the backend and the page can never disagree on a level's wording or class.
//
// Post-hoc and fail-open, exactly like the faithfulness pass: it never blocks, alters, or delays an answer.
// `assess()` returns null when there is no usable signal (so no chip is shown) and never throws.

// Cross-encoder reranker score → confidence band. The reranker scores a passage on a fixed, model-independent
// scale (roughly -11 off-topic … +9 strong match). These two cut points are the SINGLE source for turning that
// score into high/medium/low — reused by the per-citation dot in retrieval/search.js and by the answer blend
// below, so the two can never drift. Tuning a cut point here moves both at once.
const RERANK_HIGH = 4;
const RERANK_MEDIUM = 0;
const rerankBand = (score) =>
  (typeof score === 'number' && Number.isFinite(score))
    ? (score >= RERANK_HIGH ? 'high' : score >= RERANK_MEDIUM ? 'medium' : 'low')
    : null;

// The level vocabulary, single-sourced and projected to the client (see server.js CLIENT_SETTINGS-style
// injection). `label` is the chip text, `cls` the CSS class, `rank` orders them for the downgrade math.
const CONFIDENCE_LEVELS = {
  high:   { label: 'High confidence',   cls: 'conf-high',   rank: 3 },
  medium: { label: 'Medium confidence', cls: 'conf-medium', rank: 2 },
  low:    { label: 'Low confidence',    cls: 'conf-low',    rank: 1 },
};
const ORDER = ['low', 'medium', 'high'];
// Lower a band by n steps (never raises). Safe on an unknown band (returns it unchanged).
const downgrade = (level, n = 1) => {
  const i = ORDER.indexOf(level);
  if (i < 0) return level;
  return ORDER[Math.max(0, i - n)];
};

// Blend the available signals into one answer-level verdict. Only ever DOWNGRADES from the starting band — a
// confident starting signal is tempered by weaker corroborating ones, never inflated. Returns
// { level, reasons:[...], abstain, abstainReason } or null when nothing usable was computed.
//
// signals:
//   faithfulness   { overall:'high'|'medium'|'low'|null, figures:{ungrounded:[...]}, quotes:{ungrounded:[...]}|null } | null  (Verify pass)
//   topReranker    number | null   (best cross-encoder score for this answer's documents)
//   semanticEntropy{ agreement:0..1, unstable:bool } | null   (self-consistency pass, opt-in)
//   overconfident  { overconfident:bool, phrases:[...] } | null  (wording-vs-evidence check)
//   abstainEnabled bool   (config: may a thin-evidence answer lead with an honest caveat?)
//   crossLingual   bool   (the answer came from the cross-lingual dense-trust path)
//
// Note on sources: a low source COUNT is deliberately NOT penalized. One grounded document is a perfectly
// normal, confident answer for a local corpus (unlike open-web search), so counting sources would wrongly
// punish the common case. Corroboration across many sources is a bonus signal, never a requirement.
//
// Note on cross-lingual answers: a cross-encoder reranker is cross-lingual-weak — it under-scores a genuine
// match when the question and the document are in different languages (the same weakness that makes it unusable
// for ranking a cross-lingual query). So when `crossLingual` is set, the cross-encoder score is NOT a trustworthy
// confidence signal and is ignored here: confidence then rests on faithfulness (language-agnostic) when present,
// and otherwise there is simply no chip — never a misleading "low confidence" or a thin-evidence abstention
// driven by an under-scored cross-encoder number.
const assess = (signals = {}) => {
  const { faithfulness, semanticEntropy, overconfident, abstainEnabled, crossLingual } = signals;
  // Drop the cross-encoder signal entirely for a cross-lingual answer (see the note above).
  const topReranker = crossLingual ? null : signals.topReranker;

  // Starting band: prefer the faithfulness verdict (it reflects whether the sources actually support the
  // answer); fall back to retrieval strength (the reranker). With neither, there is no signal — no chip.
  let level = (faithfulness && faithfulness.overall) ? faithfulness.overall : rerankBand(topReranker);
  if (!level) return null;

  const reasons = [];
  if (faithfulness && faithfulness.overall) {
    reasons.push(level === 'high' ? 'The sources support the answer.'
      : level === 'medium' ? 'The sources partly support the answer.'
      : 'Some of the answer is not backed by the sources.');
  } else {
    reasons.push(level === 'high' ? 'A document matched the question strongly.'
      : level === 'medium' ? 'A document matched the question moderately.'
      : 'No document matched the question strongly.');
  }

  // An invented figure OR an ungrounded quotation undercuts confidence regardless of the band above: a fabricated
  // number and a verbatim passage that no cited source contains are the same class of high-stakes fabrication, so
  // both cap confidence at medium and say which. The band guard keeps assess() from ever throwing on an unexpected
  // level (contract: it never throws — mirrors downgrade()'s unknown-band guard).
  const ungroundedCount = (part) => (faithfulness && faithfulness[part] && Array.isArray(faithfulness[part].ungrounded))
    ? faithfulness[part].ungrounded.length : 0;
  const capAtMedium = (reason) => {
    if (CONFIDENCE_LEVELS[level] && CONFIDENCE_LEVELS[level].rank > CONFIDENCE_LEVELS.medium.rank) {
      level = 'medium';
      reasons.push(reason);
    }
  };
  if (ungroundedCount('figures') > 0) capAtMedium('A figure in the answer is not in the sources.');
  if (ungroundedCount('quotes') > 0) capAtMedium('A quotation in the answer is not in the sources.');

  // The answer varied in meaning when re-checked (self-consistency) — a confabulation signal grounding
  // cannot catch. Lower one band.
  if (semanticEntropy && semanticEntropy.unstable) {
    level = downgrade(level, 1);
    reasons.push('The answer changed when it was re-checked.');
  }

  // Wording that sounds more certain than the evidence supports — a caveat, not a band change (the phrasing
  // is the model's, the evidence is what it is). Only set upstream for a confidently-detected language.
  if (overconfident && overconfident.overconfident) {
    reasons.push('Worded more certainly than the evidence supports.');
  }

  // Thin-evidence abstention (opt-in). Lead with an honest note ONLY when the evidence is genuinely weak —
  // a low band driven by weak support or instability — never merely because there is one source.
  let abstain = false, abstainReason = '';
  if (abstainEnabled && level === 'low') {
    const weakSupport = faithfulness && faithfulness.overall === 'low';
    const unstable = !!(semanticEntropy && semanticEntropy.unstable);
    const weakRetrieval = !faithfulness && rerankBand(topReranker) === 'low';
    if (weakSupport || unstable || weakRetrieval) {
      abstain = true;
      abstainReason = unstable ? 'The evidence is thin and the answer was not stable when re-checked.'
        : 'The documents only weakly support this, so treat the answer with caution.';
    }
  }

  return { level, reasons, abstain, abstainReason };
};

module.exports = { assess, rerankBand, RERANK_HIGH, RERANK_MEDIUM, CONFIDENCE_LEVELS };
