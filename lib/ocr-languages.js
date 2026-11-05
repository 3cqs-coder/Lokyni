'use strict';
// The single catalog for built-in OCR languages: engine code, label, pinned data version, and the
// SHA-256 of each public Tesseract data pack. The OCR engine, the /api/config validation, and the
// Settings language picker all read this table, so a code can never be offered without a verified
// pack or accepted by the API without being in the catalog.
//
// English is the permanent floor. It is always part of the recognizer's language string, so even a
// document with a little English text keeps working, and a failed optional pack can never leave a
// run with no language at all. `ocrLanguages` stores only the ADDITIONAL codes.
//
// Packs are fetched once from the pinned version, checksum-verified, and cached under data/tessdata;
// recognition itself is fully offline. Pinning is version-specific: when OCR_LANGDATA_VERSION moves,
// refresh every hash in the same change.
const OCR_BASE_LANGUAGE = 'eng';
const OCR_LANGDATA_VERSION = '4.0.0';
const OCR_LANGDATA_BASE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
const OCR_LANGDATA_URL = (code) => `${OCR_LANGDATA_BASE}/${code}/${OCR_LANGDATA_VERSION}/${code}.traineddata.gz`;

// A curated set covering the major scripts and the most common scanned-document languages.
// `name` is the English label shown in Settings; the codes are Tesseract's engine codes.
const OCR_LANGUAGES = Object.freeze([
  { code: 'eng', name: 'English', base: true },
  { code: 'ara', name: 'Arabic' },
  { code: 'ben', name: 'Bengali' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'chi_tra', name: 'Chinese (Traditional)' },
  { code: 'nld', name: 'Dutch' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'ell', name: 'Greek' },
  { code: 'heb', name: 'Hebrew' },
  { code: 'hin', name: 'Hindi' },
  { code: 'ind', name: 'Indonesian' },
  { code: 'ita', name: 'Italian' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
  { code: 'pol', name: 'Polish' },
  { code: 'por', name: 'Portuguese' },
  { code: 'rus', name: 'Russian' },
  { code: 'spa', name: 'Spanish' },
  { code: 'tam', name: 'Tamil' },
  { code: 'tha', name: 'Thai' },
  { code: 'tur', name: 'Turkish' },
  { code: 'ukr', name: 'Ukrainian' },
  { code: 'urd', name: 'Urdu' },
  { code: 'vie', name: 'Vietnamese' },
]);

// SHA-256 of `<code>.traineddata.gz` at OCR_LANGDATA_VERSION. Every offered language is pinned, so a
// swapped or corrupted pack is rejected fail-closed. English's value also matches the previous
// single-language implementation, so an existing cache is reused rather than re-downloaded.
const OCR_LANGDATA_SHA256 = Object.freeze({
  eng:     'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',
  ara:     '400ab30fe4f4c4a03feeabe0779a7122cee6aa4fffb1629bb5b1671942859c9e',
  ben:     '87a41c6c0175b2d61311c0df6dd052906a74cbad2c93401c8b22166f3e933f44',
  chi_sim: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6',
  chi_tra: '67a4357a69810bf1596e801cd95299e073030cacb0899e78d9923d2fa1185704',
  nld:     '86a28c7acdeedd80cfae16ed4be5b0c54795c21748302bdb35065b607396a008',
  fra:     '1c0916fac2dbd6f121ca8a57a92f08e4a119227602c7c984da986222eab6cd3b',
  deu:     'f5618a8b8d07f6c7a633ce243bf075bb90f4145bb15c9264734c7cc63aa33205',
  ell:     '943623cc2a3a0aaf966f10170cb4ee91ed013251caf7c57be05e049822bb2fe3',
  heb:     'd18b4db5beccd16b41cfc7f38b53f6bf614d256696560444dc78753fbab54f1e',
  hin:     '1efb54e2f03bf8bebb695f4ce7d83d1b746f5c20d900792625da291472d14b22',
  ind:     '46130be88c603e5a38e2fe5420540d8712f177fbaf46c904aaacccddcc0bc308',
  ita:     '21c1bfde62571d76b923e270bb2cde583ccc18fa8bfd83454c021b28d8b5cb5a',
  jpn:     '70304835d33b4feacf5faa60f56176578b64a03de2eeb0801539a3f6e7807ccc',
  kor:     '9d454186b4e2556854b625c43e44d93783a5be7ee89eb1dc6702dfbddced3f4f',
  pol:     'a5c03eb3affa5cd8c5fbe89fc394240a8f1165f10ffb839c57f8117131f2f359',
  por:     '3f5feea9dfc39106c92348089097a39bec66e9d6d09ca49befebb0bb60947374',
  rus:     '63a48ae166be2bb9862839b6f75e11afbac5e3be5bd5fa9a155ea43d5cdf9575',
  spa:     '6cd52c545bceeacb2e43fad64fc0703a711c482ba20d1ca4b6915c09de9973e6',
  tam:     'a7cbfeb87f31cfc1b6b46a0d7e83176d907bb348a156cffa37766d956719d2ed',
  tha:     '578c50034028340f2558fafb55207347943a60f4f1a854e5326ac272c764f7c3',
  tur:     '1a151a9aee3fe92ab46a3d8ed859273da970e1ac60b469a20cd0144c15ae84c9',
  ukr:     '529eee0d1718ddbe775b993e4c7639a7d69afbf17501f4fee582b05133256ec6',
  urd:     'eba2157294166844945f80f82af36887179a9291149d604a7b4861f4b9a19dc5',
  vie:     'a2732b8e9f701e727dc7ad131581dad23b99c116465d2b5748416de26bde4c5e',
});

const OCR_LANGUAGE_CODES = new Set(OCR_LANGUAGES.map((l) => l.code));
const OCR_LANGUAGE_BY_CODE = new Map(OCR_LANGUAGES.map((l) => [l.code, l]));
// Common ISO 639-1 spellings are accepted from a hand-edited config or an API client and normalized
// to the engine codes. The Settings control always sends engine codes.
const ISO_TO_ENGINE = Object.freeze({
  en: 'eng', ar: 'ara', bn: 'ben', zh: 'chi_sim', nl: 'nld', fr: 'fra', de: 'deu', el: 'ell',
  he: 'heb', hi: 'hin', id: 'ind', it: 'ita', ja: 'jpn', ko: 'kor', pl: 'pol', pt: 'por',
  ru: 'rus', es: 'spa', ta: 'tam', th: 'tha', tr: 'tur', uk: 'ukr', ur: 'urd', vi: 'vie',
});
const MAX_OCR_LANGUAGES = 4;   // additional to English; bounds memory per worker

// Normalize `ocrLanguages` from config or an API request into a bounded, deduplicated list of known
// ADDITIONAL engine codes. Accepts an array or a string separated by '+', ',', or whitespace.
// Unknown codes are dropped (fail-open), English is dropped (it is always included by the engine),
// and the list is capped so one selection cannot make every worker load an unbounded set of packs.
const normalizeOcrLanguages = (raw, max = MAX_OCR_LANGUAGES) => {
  const parts = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    for (const piece of v.split(/[+,;\s]+/)) if (piece) parts.push(piece.trim().toLowerCase());
  };
  if (Array.isArray(raw)) raw.forEach(push); else push(raw);
  const out = [];
  for (const piece of parts) {
    const code = ISO_TO_ENGINE[piece] || piece;
    if (code === OCR_BASE_LANGUAGE) continue;
    if (!OCR_LANGUAGE_CODES.has(code) || !OCR_LANGDATA_SHA256[code]) continue;
    if (!out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
};

module.exports = {
  OCR_BASE_LANGUAGE,
  OCR_LANGDATA_VERSION,
  OCR_LANGDATA_URL,
  OCR_LANGDATA_SHA256,
  OCR_LANGUAGES,
  OCR_LANGUAGE_CODES,
  OCR_LANGUAGE_BY_CODE,
  MAX_OCR_LANGUAGES,
  normalizeOcrLanguages,
};
