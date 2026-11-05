'use strict';
// Local credibility flags for a source. Advisory only: a preprint is not wrong and a retraction notice is not a
// verdict on the user's question, so these are neutral labels the reader can weigh. Everything here is offline,
// pure, and bounded — no Crossref call, no network, no editorial ranking. The flags are computed once when a
// document is indexed and travel with its metadata to the source pills.

// Hosts that publish preprints (often before peer review). Matched on the registrable host with subdomains.
const PREPRINT_HOSTS = [
  'arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'papers.ssrn.com', 'researchsquare.com',
  'preprints.org', 'techrxiv.org', 'chemrxiv.org', 'eartharxiv.org', 'authorea.com', 'osf.io',
];
// DOI prefixes used by the same preprint servers. A DOI can appear in the captured text even when the host is a
// mirror or an aggregator.
const PREPRINT_DOI_RE = /\b10\.(?:1101|21203|2139|36227|26434|31219|22541)\//i;
// Withdrawal/retraction language. Deliberately phrase-based; a paper that merely studies retractions may match,
// which is why the labels are advisory and the panel says "found", not "invalid".
const RETRACTION_RE = /retracted article|article (?:has been|was) retracted|retraction notice|retraction of|withdrawn article|retractad[oa]|rétracté|rétractation|zurückgezogen|ritirato|retratado|撤回|取り下げ|철회|отозван/i;
const CONCERN_RE = /\bexpression of concern\b/i;
// The short pill text and the full explanation for each flag. Kept here, beside detection, so the client never
// needs its own flag→label map (which would drift when a flag is added).
const LABELS = Object.freeze({
  preprint:   Object.freeze({ short: 'preprint',  long: 'Preprint' }),
  retraction: Object.freeze({ short: 'retracted', long: 'Retraction notice found' }),
  concern:    Object.freeze({ short: 'concern',   long: 'Expression of concern found' }),
});

const hostOf = (value) => {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
};
const isPreprintHost = (host) => !!host && PREPRINT_HOSTS.some((h) => host === h || host.endsWith('.' + h));

// { flags: ['preprint'|'retraction'|'concern'], labels: [human labels] } or null when nothing applies.
// `source` may be a URL or a local path; `text` is capped before scanning so a huge document cannot stall.
const flagsFor = (input = {}) => {
  try {
    const { source, title, text, url } = (input && typeof input === 'object') ? input : {};
    const src = String(source || '');
    const urlStr = String(url || '') || (/^https?:/i.test(src) ? src : '');
    const host = hostOf(urlStr);
    const hay = `${String(title || '')}\n${src}\n${String(text || '').slice(0, 5000)}`;
    const retraction = RETRACTION_RE.test(hay);
    const concern = !retraction && CONCERN_RE.test(hay);
    const preprint = isPreprintHost(host) || PREPRINT_DOI_RE.test(hay);
    const flags = [];
    if (preprint) flags.push('preprint');
    if (retraction) flags.push('retraction');
    else if (concern) flags.push('concern');
    if (!flags.length) return null;
    return {
      flags,
      labels: flags.map((f) => LABELS[f].long),
      shortLabels: flags.map((f) => LABELS[f].short),
    };
  } catch { return null; }
};

module.exports = { flagsFor, isPreprintHost, hostOf, LABELS, PREPRINT_HOSTS };
