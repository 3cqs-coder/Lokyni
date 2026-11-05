'use strict';
// Lightweight, dependency-free, FAIL-OPEN language / script detection.
//
// Two jobs: (1) tell what LANGUAGE a (usually short) query is, to keep English-only heuristics from
// misrouting non-English input and to localize web engines; (2) a coarse SCRIPT gate to tell whether a
// fetched web page is in a clearly different writing system than wanted. It is high-precision and
// fail-open: when it cannot tell, it returns '' / false, so the caller keeps its existing (English/default)
// behavior — adding it can only change the handling of a CONFIDENTLY non-English input, never an English
// or ambiguous one. Pure, synchronous, bounded (samples a prefix), and never throws.
//
// NOTE: this is NOT used to filter the document corpus — a user's own files may legitimately be in any mix
// of languages and must all be indexed. It is only for query routing and (optionally) web-result language.

// One representative character class per script. CJK groups kana + ideographs. Explicit code-point ranges
// (not \p{Script}) so behavior is identical on every engine/runtime.
const RANGES = {
  latin: /[A-Za-zÀ-ɏ]/g,
  cjk: /[぀-ヿ㐀-鿿豈-﫿]/g,
  hangul: /[가-힣ᄀ-ᇿ]/g,
  arabic: /[؀-ۿݐ-ݿ]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  greek: /[Ͱ-Ͽ]/g,
  hebrew: /[֐-׿]/g,
  devanagari: /[ऀ-ॿ]/g,
  thai: /[฀-๿]/g,
  // Additional scripts keep the detector useful for languages the original set did not cover. Explicit ranges
  // (not \p{Script}) preserve identical behavior across engines and runtimes.
  armenian: /[\u0530-\u058F]/g,
  bengali: /[\u0980-\u09FF]/g,
  gurmukhi: /[\u0A00-\u0A7F]/g,
  gujarati: /[\u0A80-\u0AFF]/g,
  tamil: /[\u0B80-\u0BFF]/g,
  telugu: /[\u0C00-\u0C7F]/g,
  kannada: /[\u0C80-\u0CFF]/g,
  malayalam: /[\u0D00-\u0D7F]/g,
  sinhala: /[\u0D80-\u0DFF]/g,
  lao: /[\u0E80-\u0EFF]/g,
  myanmar: /[\u1000-\u109F]/g,
  georgian: /[\u10A0-\u10FF]/g,
  ethiopic: /[\u1200-\u137F]/g,
  khmer: /[\u1780-\u17FF]/g,
};

// The script a 2-letter language code is written in. Unknown codes return '' (→ no filtering).
const LANG_SCRIPT = {
  en: 'latin', es: 'latin', fr: 'latin', de: 'latin', it: 'latin', pt: 'latin', nl: 'latin',
  sv: 'latin', no: 'latin', da: 'latin', fi: 'latin', pl: 'latin', cs: 'latin', ro: 'latin',
  tr: 'latin', id: 'latin', vi: 'latin', ca: 'latin', hu: 'latin',
  af: 'latin', az: 'latin', bs: 'latin', cy: 'latin', et: 'latin', eu: 'latin', fil: 'latin',
  ga: 'latin', gl: 'latin', hr: 'latin', is: 'latin', lt: 'latin', lv: 'latin', ms: 'latin',
  mt: 'latin', sk: 'latin', sl: 'latin', sq: 'latin', sw: 'latin',
  ja: 'cjk', zh: 'cjk', ko: 'hangul', ar: 'arabic', fa: 'arabic', ur: 'arabic',
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic', be: 'cyrillic', mk: 'cyrillic',
  el: 'greek', he: 'hebrew', hi: 'devanagari', mr: 'devanagari', th: 'thai',
  bn: 'bengali', pa: 'gurmukhi', gu: 'gujarati', ta: 'tamil', te: 'telugu', kn: 'kannada',
  ml: 'malayalam', si: 'sinhala', lo: 'lao', my: 'myanmar', ka: 'georgian', hy: 'armenian',
  am: 'ethiopic', km: 'khmer',
};

function scriptCounts(text) {
  const s = String(text == null ? '' : text).slice(0, 4000);   // sample — bounded, OOM-safe
  const counts = {};
  for (const name of Object.keys(RANGES)) { const m = s.match(RANGES[name]); counts[name] = m ? m.length : 0; }
  return counts;
}

// The script with the most characters in the sample, or '' when there is no scripted text. Pure.
function dominantScript(text) {
  const counts = scriptCounts(text);
  let best = '', n = 0;
  for (const k of Object.keys(counts)) { if (counts[k] > n) { n = counts[k]; best = k; } }
  return n > 0 ? best : '';
}

// Does the text contain a MEANINGFUL amount (>= `min` chars) of a given script? Unlike dominantScript this
// sees a minority script, so a mostly-Latin title that embeds a few native characters still "contains" them.
function containsScript(text, script, min = 2) {
  try { if (!script || !RANGES[script]) return false; return (scriptCounts(text)[script] || 0) >= min; }
  catch { return false; }
}

// High-frequency closed-class FUNCTION WORDS per language (articles, prepositions, conjunctions, pronouns,
// auxiliaries, interrogatives, discourse adverbs). These are grammar words, not content, so they separate
// same-script languages cheaply without a dictionary. Single-sourced as DATA in lib/ai/data/languages.json, so
// adding a language is a data edit with no code change (future-proof). Crash-proof: a missing/corrupt file
// degrades to an empty table (detection then fails open to the default language) with one loud warning instead
// of failing to boot — the syntax gate and languages.test.js guarantee the file in real builds.
let _langData = {};
try {
  _langData = require('./ai/data/languages.json');
} catch (e) {
  try { console.warn(`⚠️  Language data file lib/ai/data/languages.json could not be read (${e && e.message}). ` +
    `Language detection falls open to the default until it is restored — check that lib/ai/data/ shipped in this build.`); } catch (_) {}
}
const FUNCTION_WORDS = (_langData && _langData.functionWords) || {};
// Close relatives that short/noisy text cannot separate — never reject within a cluster.
const CLOSE = [['es', 'pt', 'ca', 'gl'], ['no', 'da'], ['cs', 'sk'], ['af', 'nl'], ['ms', 'id'], ['hr', 'bs', 'sr'], ['lt', 'lv']];
function clusterMates(code) { for (const c of CLOSE) if (c.includes(code)) return c; return [code]; }

// Count whole-word function-word hits per candidate language in a sample. Pure, bounded.
function functionWordScores(text) {
  const words = String(text == null ? '' : text).toLowerCase().slice(0, 8000).match(/[a-zÀ-ɏ]+/g) || [];
  if (!words.length) return {};
  const set = new Set(words);
  const scores = {};
  for (const lang of Object.keys(FUNCTION_WORDS)) {
    let hits = 0;
    for (const w of FUNCTION_WORDS[lang]) if (set.has(w)) hits += 1;
    scores[lang] = hits;
  }
  return scores;
}

// Does this text plausibly belong in a `langCode` corpus/result set? Conservative and FAIL-OPEN: true for an
// unknown/blank target, for too little signal, and whenever the text could be the target language. False ONLY
// when the text is CONFIDENTLY a different language — a clearly different SCRIPT, or (for same-script Latin,
// judged on enough text) another Latin language scoring far higher while the target barely appears.
function matchesLanguage(text, langCode) {
  try {
    const code = String(langCode || '').slice(0, 3).toLowerCase();
    const want = LANG_SCRIPT[code];
    if (!want) return true;
    const counts = scriptCounts(text);
    const total = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
    if (total < 20) return true;
    const dom = dominantScript(text);
    const wantFrac = (counts[want] || 0) / total;
    const domFrac = dom ? (counts[dom] || 0) / total : 0;
    if (dom && dom !== want && domFrac >= 0.5 && domFrac >= 1.5 * wantFrac) return false;
    if (want === 'latin' && dom === 'latin' && FUNCTION_WORDS[code] && (counts.latin || 0) >= 300) {
      const scores = functionWordScores(text);
      let best = '', bestScore = -1;
      for (const l of Object.keys(scores)) if (scores[l] > bestScore) { bestScore = scores[l]; best = l; }
      const targetScore = scores[code] || 0;
      const mates = clusterMates(code);
      if (best && best !== code && !mates.includes(best) && bestScore >= 3 && bestScore >= targetScore * 2 && targetScore <= 1) return false;
    }
    return true;
  } catch { return true; }   // never drop on an error
}

// Letters that pin ONE Latin-script language with high precision (rare or absent in every sibling). Plain
// shared accents are deliberately excluded here and arbitrated by DIACRITIC_FAMILY below.
const DIACRITIC_LANG = [
  ['is', /[þð]/i],
  ['lt', /[ė]/i],
  ['lv', /[āēīģķļņ]/i],
  ['az', /[ə]/i],
  ['cy', /[ŵŷ]/i],
  ['mt', /[ħċ]/i],
  ['ca', /[·]/i],
  ['pl', /[ąęłńśźż]/i],
  ['tr', /[şğıİ]/i],
  ['ro', /[ășț]/i],
  ['hu', /[őű]/i],
  ['vi', /[Ạ-ỹđơư]/i],
  ['es', /[ñ¿¡]/i],
  ['pt', /[ã]/i],
  ['de', /[ß]/i],
  ['fr', /[œ]/i],
];
// Accents several catalog languages share. The accent alone cannot decide, so the family member with the
// strongest function-word evidence wins; only when no member has evidence does the family's most common
// language act as a last-resort guess. Every member is a catalog language that actually uses those letters,
// so Turkish or Albanian "ç" can never fall through to French when that language's words are present.
// Narrower families are checked first: ø/æ are not Swedish, while å is shared by all three Scandinavian entries.
const DIACRITIC_FAMILY = [
  { re: /[øæ]/i, fallback: 'no', members: ['no', 'da', 'is', 'sv'] },
  { re: /[å]/i, fallback: 'sv', members: ['sv', 'no', 'da'] },
  { re: /[äöü]/i, fallback: 'de', members: ['de', 'sv', 'fi', 'et', 'hu', 'sk', 'tr', 'az', 'is'] },
  { re: /[õ]/i, fallback: 'pt', members: ['pt', 'et'] },
  { re: /[àèêùûç]/i, fallback: 'fr', members: ['fr', 'it', 'ca', 'pt', 'tr', 'sq'] },
];

// Function words that are >= 3 chars AND unique to exactly one language's list — a single such hit is a
// reliable signal (a shared short article like "la"/"de" is not). Computed once so it stays in sync.
const CROSS_SHARED = new Set(['den', 'det', 'dos']);
const DISTINCTIVE_FW = (() => {
  const langs = Object.keys(FUNCTION_WORDS);
  const count = {};
  for (const l of langs) for (const w of FUNCTION_WORDS[l]) count[w] = (count[w] || 0) + 1;
  const map = {};
  for (const l of langs) map[l] = new Set(FUNCTION_WORDS[l].filter((w) => w.length >= 3 && count[w] === 1 && !CROSS_SHARED.has(w)));
  return map;
})();

// A safe "ll-CC" region for a language code, to localize engines that take a market. Unmapped → ''. Pure.
const REGION_FOR = {
  en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT', nl: 'nl-NL',
  pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU', uk: 'uk-UA', ja: 'ja-JP', zh: 'zh-CN',
  ko: 'ko-KR', ar: 'ar-SA', el: 'el-GR', he: 'he-IL', hi: 'hi-IN', th: 'th-TH',
  vi: 'vi-VN', sv: 'sv-SE', da: 'da-DK', no: 'nb-NO', fi: 'fi-FI', cs: 'cs-CZ',
  ro: 'ro-RO', id: 'id-ID', hu: 'hu-HU',
  am: 'am-ET', be: 'be-BY', bg: 'bg-BG', bn: 'bn-IN', fa: 'fa-IR', gu: 'gu-IN',
  hy: 'hy-AM', ka: 'ka-GE', km: 'km-KH', kn: 'kn-IN', lo: 'lo-LA', mk: 'mk-MK',
  ml: 'ml-IN', mr: 'mr-IN', my: 'my-MM', pa: 'pa-IN', si: 'si-LK', sr: 'sr-RS',
  ta: 'ta-IN', te: 'te-IN', ur: 'ur-PK',
  af: 'af-ZA', az: 'az-AZ', bs: 'bs-BA', ca: 'ca-ES', cy: 'cy-GB', et: 'et-EE',
  eu: 'eu-ES', fil: 'fil-PH', ga: 'ga-IE', gl: 'gl-ES', hr: 'hr-HR', is: 'is-IS',
  lt: 'lt-LT', lv: 'lv-LV', ms: 'ms-MY', mt: 'mt-MT', sk: 'sk-SK', sl: 'sl-SI',
  sq: 'sq-AL', sw: 'sw-KE',
};
function regionFor(lang) { return REGION_FOR[String(lang || '').toLowerCase()] || ''; }

// Default language for a script that maps to one language, plus high-precision hints for scripts that carry
// several languages. A hint is a distinctive letter that is rare or absent in the sibling languages, or (for
// Bulgarian) a closed-class word Russian and Serbian do not use. This keeps routing deterministic and fail-open:
// an ordinary Russian, Arabic, or Hindi text still falls through to the script's default.
const SCRIPT_DEFAULT = {
  cjk: 'zh', hangul: 'ko', arabic: 'ar', cyrillic: 'ru', greek: 'el', hebrew: 'he',
  devanagari: 'hi', thai: 'th', bengali: 'bn', gurmukhi: 'pa', gujarati: 'gu', tamil: 'ta',
  telugu: 'te', kannada: 'kn', malayalam: 'ml', sinhala: 'si', lao: 'lo', myanmar: 'my',
  georgian: 'ka', ethiopic: 'am', khmer: 'km', armenian: 'hy',
};
const SCRIPT_HINTS = {
  cyrillic: [
    ['uk', /[їєґ]/i],
    ['be', /[ў]/i],
    ['sr', /[љњђћџ]/i],
    ['mk', /[ѓќѕ]/i],
  ],
  arabic: [
    ['ur', /[ٹڈڑںےھ]/],   // Urdu-specific letters; checked before Persian, which shares پ چ ژ گ
    ['fa', /[پچژگ]/],
  ],
  devanagari: [
    ['mr', /[ळ]/],
  ],
};
// Whole-word lists for languages that share an alphabet and most letters with a dominant sibling. These are
// grammatical words specific to the language; the default sibling does not use them as standalone words.
const SCRIPT_WORD_RE = {
  cyrillic: /[а-яёіїєґўљњђћџѓќѕ]+/g,
};
const SCRIPT_WORD_HINTS = {
  cyrillic: [
    ['be', ['гэта', 'што', 'які', 'якая', 'яны', 'пра', 'можна', 'трэба']],
    ['bg', ['това', 'като', 'ще', 'още', 'всички', 'също', 'защо', 'какво', 'къде', 'кога', 'тя', 'ние', 'вие']],
  ],
};
function scriptHint(script, text) {
  for (const [code, re] of (SCRIPT_HINTS[script] || [])) if (re.test(text)) return code;
  const rows = SCRIPT_WORD_HINTS[script];
  const wordRe = SCRIPT_WORD_RE[script];
  if (rows && rows.length && wordRe) {
    const words = new Set(text.toLowerCase().match(wordRe) || []);
    for (const [code, list] of rows) if (list.some((w) => words.has(w))) return code;
  }
  return '';
}

// Detect the language of a (usually short) query: a 2-letter code, or '' when UNCERTAIN. High precision and
// fail-open — '' means "keep the English/configured default", so an English or ambiguous query is never made
// worse. Tiers, strongest first: (1) a non-Latin SCRIPT is decisive; (2) a distinctive Latin DIACRITIC; (3) a
// distinctive function word (>= 3 chars, unique to one language), or a clear scorer winner (>= 2 hits, >= 2
// margin). A shared short article never decides. (No trigram tier here — an uncertain short Latin query
// simply returns '' and keeps the default, which is the conservative behavior we want with no bundled data.)
//
// The same detector also tags an ANSWER's language for read-aloud routing. There is deliberately one detector
// for queries, answers, and the language picker below, so the three can never drift.
function detectLanguage(text) {
  try {
    const s = String(text == null ? '' : text).slice(0, 200);
    if (!s.trim()) return '';
    const dom = dominantScript(s);
    if (dom && dom !== 'latin') {
      if (dom === 'cjk') return /[ぁ-ヿ]/.test(s) ? 'ja' : 'zh';   // kana ⇒ Japanese, else Chinese
      const hinted = scriptHint(dom, s);
      if (hinted) return hinted;
      return SCRIPT_DEFAULT[dom] || '';
    }
    const scores = functionWordScores(s);
    // English is the default, so a single foreign signal does NOT route when English is at least as present.
    // Shared by the diacritic and distinctive-word tiers so both behave consistently.
    const enBeats = (code) => (scores.en || 0) >= 1 && (scores.en || 0) >= (scores[code] || 0);
    // A distinctive Latin diacritic pins a language — but not when it is just a foreign place/person name or
    // loanword in an otherwise-English query ("weather in Zürich", "flights to São Paulo", "jalapeño recipe"),
    // where an English function word is present and at least as frequent. Then fall through to the default.
    for (const [code, re] of DIACRITIC_LANG) if (re.test(s) && !enBeats(code)) return code;
    // A shared accent is arbitrated by the family's function-word evidence, never by the letter alone.
    for (const family of DIACRITIC_FAMILY) {
      if (!family.re.test(s)) continue;
      let best = '', bestN = 0;
      for (const l of family.members) {
        const n = scores[l] || 0;
        if (n > bestN) { bestN = n; best = l; }
      }
      const pick = bestN >= 1 ? best : family.fallback;
      if (pick && !enBeats(pick)) return pick;
    }
    const wset = new Set(s.toLowerCase().match(/[a-zÀ-ɏ]+/g) || []);
    const distinct = [];
    for (const l of Object.keys(DISTINCTIVE_FW)) {
      if (l === 'en') continue;
      for (const w of DISTINCTIVE_FW[l]) if (wset.has(w)) { distinct.push(l); break; }
    }
    // A single foreign distinctive word routes — unless English is at least as present (some English words
    // double as another language's function word, e.g. "come"=it, "die"=de).
    if (distinct.length === 1 && !enBeats(distinct[0])) return distinct[0];
    let best = '', bestN = 0, secondN = 0;
    for (const l of Object.keys(scores)) {
      const n = scores[l];
      if (n > bestN) { secondN = bestN; bestN = n; best = l; }
      else if (n > secondN) secondN = n;
    }
    if (best && best !== 'en' && bestN >= 2 && bestN - secondN >= 2) return best;
    return '';
  } catch { return ''; }
}

// Confident "this is not English" — a code that is neither '' (uncertain) nor 'en'. The fail-open convenience
// wrapper the query-routing heuristics use.
function isLikelyNonEnglish(text) {
  const code = detectLanguage(text);
  return code !== '' && code !== 'en';
}

// Every language the read-aloud picker offers and the config writer accepts. Most are also auto-detected by the
// script/word tiers above; a few (for example Serbian written in Latin script) are available for an explicit
// choice. This is the single catalog the UI, the status route, and the settings validator read.
// The detectable languages (code + display name), single-sourced as data in lib/ai/data/languages.json. Falls
// back to English-only if the data file is unavailable, so callers always have at least the default.
const SUPPORTED_LANGUAGES = (_langData && Array.isArray(_langData.supportedLanguages) && _langData.supportedLanguages.length)
  ? _langData.supportedLanguages
  : [{ code: 'en', name: 'English' }];
const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

// Browser voice tags that name the same speech language under a different subtag. `no` is the important one:
// installed Norwegian voices are tagged nb-NO (Bokmål) or nn-NO (Nynorsk), so matching a bare `no` prefix would
// never find them even though the catalog advertises nb-NO as its speech region. The legacy ISO codes keep older
// engines working. Detection and storage still use the catalog code; this table only widens voice matching.
const SPEECH_ALIASES = Object.freeze({
  no:  Object.freeze(['nb', 'nn']),
  he:  Object.freeze(['iw']),
  id:  Object.freeze(['in']),
  fil: Object.freeze(['tl']),
});
const NO_ALIASES = Object.freeze([]);

// Read-aloud's language catalog, with the speech-region tag a browser's Web Speech API expects. Built from the
// one table above plus `regionFor`, so the picker, the status route, and utterance tags share a source.
const READ_ALOUD_LANGUAGES = Object.freeze(SUPPORTED_LANGUAGES.map((l) => Object.freeze({
  code: l.code, name: l.name, region: regionFor(l.code) || l.code,
  aliases: SPEECH_ALIASES[l.code] || NO_ALIASES,
})));

// The read-aloud setting is either 'auto' (match each answer's detected language) or one supported code.
// One guard for config reads, the settings writer, and tests, so an unknown code can never reach playback.
const isValidReadAloudLanguage = (code) => {
  if (typeof code !== 'string') return false;
  const c = code.toLowerCase();
  return c === 'auto' || LANGUAGE_CODES.has(c);
};

module.exports = {
  isLikelyNonEnglish, detectLanguage, dominantScript, containsScript, matchesLanguage,
  functionWordScores, regionFor, LANG_SCRIPT, FUNCTION_WORDS, SUPPORTED_LANGUAGES,
  READ_ALOUD_LANGUAGES, SPEECH_ALIASES, DIACRITIC_LANG, DIACRITIC_FAMILY, isValidReadAloudLanguage,
};
