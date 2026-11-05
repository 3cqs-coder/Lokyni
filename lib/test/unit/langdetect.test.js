'use strict';
// Guards the fail-open language / script detector (lib/langdetect.js) and its routing uses. The contract is
// precision-first and FAIL-OPEN: a confidently non-English input is detected, but an English or ambiguous
// one returns '' / false so callers keep their English behavior (no regression). Content spans real
// languages with synthetic/placeholder subjects, per the multilingual test bar. Pure/offline.
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ld = require(path.join(PROJECT, 'lib', 'langdetect'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── Non-Latin scripts are decisive ──
  eq(ld.detectLanguage('東京の天気はどうですか'), 'ja', 'kana present → Japanese');
  eq(ld.detectLanguage('这是一个中文问题关于历史'), 'zh', 'Han without kana → Chinese');
  eq(ld.detectLanguage('현재 가격은 얼마인가요'), 'ko', 'Hangul → Korean');
  eq(ld.detectLanguage('какая сейчас погода'), 'ru', 'Cyrillic → Russian');
  eq(ld.detectLanguage('ما هي أحدث الأخبار'), 'ar', 'Arabic script → Arabic');
  eq(ld.detectLanguage('ποιος έγραψε την αναφορά'), 'el', 'Greek script → Greek');
  eq(ld.detectLanguage('मुख्य बिंदु क्या हैं'), 'hi', 'Devanagari → Hindi');

  // ── Multi-language scripts: a distinctive letter or grammatical word pins the language; plain sibling text
  //    still falls back to the script default. ──
  for (const [sample, want, label] of [
    ['Це український текст про проєкт Оріон.', 'uk', 'Ukrainian ї/є/ґ'],
    ['Гэта беларускі тэкст пра праект Арвіён.', 'be', 'Belarusian ў / grammatical words'],
    ['Това е български текст за проекта Орион.', 'bg', 'Bulgarian grammatical words'],
    ['Ово је српски текст о пројекту Орион, љубав и срећа.', 'sr', 'Serbian љ/њ/ђ/ћ/џ'],
    ['Ова е македонски текст за проектот Орион, ќе одиме.', 'mk', 'Macedonian ѓ/ќ/ѕ'],
    ['این یک متن فارسی درباره پروژه اوريون است.', 'fa', 'Persian پ/چ/ژ/گ'],
    ['یہ اردو متن ہے اور منصوبے کے بارے میں ہے۔', 'ur', 'Urdu ٹ/ڈ/ڑ/ں/ے/ھ'],
    ['मराठी मजकूर आहे आणि बाळ आहे.', 'mr', 'Marathi ळ'],
    ['இது தமிழ் உரை.', 'ta', 'Tamil script'],
    ['এটি বাংলা পাঠ।', 'bn', 'Bengali script'],
    ['ਇਹ ਪੰਜਾਬੀ ਪਾਠ ਹੈ।', 'pa', 'Gurmukhi script'],
    ['આ ગુજરાતી લખાણ છે.', 'gu', 'Gujarati script'],
    ['ఇది తెలుగు పాఠం.', 'te', 'Telugu script'],
    ['ಇದು ಕನ್ನಡ ಪಠ್ಯ.', 'kn', 'Kannada script'],
    ['ഇത് മലയാളം പാഠമാണ്.', 'ml', 'Malayalam script'],
    ['මෙය සිංහල පාඨයකි.', 'si', 'Sinhala script'],
    ['ນີ້ແມ່ນຂໍ້ຄວາມລາວ.', 'lo', 'Lao script'],
    ['ဤသည် မြန်မာ စာသား ဖြစ်သည်။', 'my', 'Myanmar script'],
    ['ეს არის ქართული ტექსტი.', 'ka', 'Georgian script'],
    ['Սա հայերեն տեքստ է։', 'hy', 'Armenian script'],
    ['ይህ የአማርኛ ጽሑፍ ነው።', 'am', 'Ethiopic script'],
    ['នេះជាអត្ថបទខ្មែរ។', 'km', 'Khmer script'],
  ]) eq(ld.detectLanguage(sample), want, `${label} → ${want}`);
  // The hints are evidence-based; ordinary sibling text still falls back to the script default.
  eq(ld.detectLanguage('Это русский текст о проекте Орион.'), 'ru', 'ordinary Cyrillic still defaults to Russian');
  eq(ld.detectLanguage('هذا نص عربي عن مشروع أوريون.'), 'ar', 'ordinary Arabic still defaults to Arabic');
  eq(ld.detectLanguage('यह हिंदी पाठ है और परियोजना के बारे में है।'), 'hi', 'ordinary Devanagari still defaults to Hindi');

  // ── Latin-script coverage: conservative function-word and distinctive-letter evidence. Close pairs are
  //    allowed to route to a plausible sibling; the per-answer Read as dialog covers residual ambiguity. ──
  for (const [sample, want, label] of [
    ["Hierdie is nie 'n eenvoudige projek nie.", 'af', 'Afrikaans function words'],
    ['Bu layihə üçün yeni büdcə ayrıldı.', 'az', 'Azerbaijani schwa / function words'],
    ['Ovo je novi projekat i šta je plan?', 'bs', 'Bosnian function words'],
    ['Aquest projecte té un pressupost amb un molt bon resultat.', 'ca', 'Catalan function words'],
    ['Tento projekt je nový a velmi důležitý.', 'cs', 'Czech function words'],
    ['Mae’r prosiect yn defnyddio gyda chyllideb newydd.', 'cy', 'Welsh function words'],
    ['See projekt on uus ja või suurem.', 'et', 'Estonian function words'],
    ['Proiektu hau berria da eta baina oso ona.', 'eu', 'Basque function words'],
    ['Ang proyekto ay may mga bagong plano.', 'fil', 'Filipino function words (three-letter code)'],
    ['Tá an tionscadal nua agus gan aon chost.', 'ga', 'Irish function words'],
    ['Este proxecto ten unha contía máis grande.', 'gl', 'Galician function words'],
    ['Ovaj projekt ima tko i zašto pitanje.', 'hr', 'Croatian function words'],
    ['Þetta verkefni er ekki með nýja áætlun.', 'is', 'Icelandic þ/ð'],
    ['Šis projektas yra naujas ir labai svarbus.', 'lt', 'Lithuanian function words'],
    ['Šis projekts ir jauns un ļoti svarīgs.', 'lv', 'Latvian distinctive letters'],
    ['Projek ini ialah satu cadangan yang beliau buat.', 'ms', 'Malay distinctive words'],
    ['Dan il-proġett għal budget ġdid.', 'mt', 'Maltese għ/ħ'],
    ['Tento projekt je nový a veľmi dôležitý.', 'sk', 'Slovak function words'],
    ['Ta projekt je nov in zelo pomemben.', 'sl', 'Slovenian function words'],
    ['Ky projekt është i ri dhe shumë i rëndësishëm.', 'sq', 'Albanian function words'],
    ['Mradi huu ni mpya na sana muhimu.', 'sw', 'Swahili function words'],
  ]) eq(ld.detectLanguage(sample), want, `${label} → ${want}`);

  // ── Shared accents are arbitrated by function words, never by the letter alone: Swedish must not become
  //    German, Danish must not become Swedish, and a Turkish ü must not become German. ──
  for (const [sample, want, label] of [
    ['Detta är en ny projektplan och vi ska inte vänta längre.', 'sv', 'Swedish ä with Swedish words'],
    ['Dette er en ny projektplan og vi skal ikke vente længere.', 'da', 'Danish æ with Danish words'],
    ['Dette er en ny prosjektplan og vi skal ikke vente lenger.', 'no', 'Norwegian lenger separates it from Danish'],
    ['Hva er den nye planen og hvor skal vi møtes?', 'no', 'Norwegian hva'],
    ['Tämä on uusi projekti ja se on erittäin tärkeä.', 'fi', 'Finnish ä/ö with Finnish words'],
    ['Ez az új projekt és nagyon fontos számunkra.', 'hu', 'Hungarian function words'],
    ['Türkiye güzel bir ülke', 'tr', 'Turkish ü with Turkish words'],
    ['Åsa och Lars ska inte vänta.', 'sv', 'Scandinavian å with Swedish words'],
  ]) eq(ld.detectLanguage(sample), want, `${label} → ${want}`);
  eq(ld.detectLanguage('As lições são importantes para todos nós.'), 'pt', 'Portuguese ã still pins Portuguese');
  eq(ld.detectLanguage('La città è molto grande e bella.'), 'it', 'Italian shared accents with Italian words');

  // ── Latin-script languages via distinctive diacritic / function words ──
  eq(ld.detectLanguage('¿cuál es el resumen del informe?'), 'es', 'Spanish eñe/inverted punctuation + words');
  eq(ld.detectLanguage('was ist der hauptunterschied zwischen den berichten'), 'de', 'German function words');
  eq(ld.detectLanguage('quais são os pontos principais do relatório'), 'pt', 'Portuguese tilde + words');

  // ── An English query that merely names a foreign place/loanword (distinctive diacritic) stays English:
  //    the English function-word guard applies to the diacritic tier, not just the function-word tier. ──
  eq(ld.detectLanguage('weather in Zürich'), '', 'a foreign place name with a diacritic in an English query stays English');
  eq(ld.detectLanguage('flights to São Paulo'), '', 'a foreign place name (São Paulo) in an English query stays English');
  eq(ld.detectLanguage('jalapeño recipe for dinner'), '', 'a loanword with a diacritic in an English query stays English');
  // …but a genuinely foreign query (no English function word beating it) is still detected.
  eq(ld.detectLanguage('Zürich Wetter heute'), 'de', 'a genuinely German query is still detected via its diacritic');

  // ── FAIL-OPEN: English and ambiguous inputs return '' (keep the default) ──
  eq(ld.detectLanguage('what are the main points of the report'), '', 'a clear English query is not flagged (stays default)');
  eq(ld.detectLanguage('budget'), '', 'a single ambiguous token returns uncertain');
  eq(ld.detectLanguage(''), '', 'empty returns uncertain');
  eq(ld.detectLanguage(null), '', 'null never throws, returns uncertain');
  ok(ld.isLikelyNonEnglish('东京今天的天气怎么样') === true, 'isLikelyNonEnglish true for Chinese');
  ok(ld.isLikelyNonEnglish('what is the current price') === false, 'isLikelyNonEnglish false for English (fail-open)');
  ok(ld.isLikelyNonEnglish('report') === false, 'isLikelyNonEnglish false for a short ambiguous token');

  // ── dominantScript + containsScript ──
  eq(ld.dominantScript('hello world'), 'latin', 'dominant script of English is latin');
  eq(ld.dominantScript('日本の歴史'), 'cjk', 'dominant script of Japanese text is cjk');
  ok(ld.containsScript('日本の歴史 - Wikipedia', 'cjk'), 'a mostly-Latin title containing CJK still reports containing cjk');
  ok(!ld.containsScript('hello', 'cjk'), 'plain English does not contain cjk');

  // ── matchesLanguage is fail-open (never used to filter the corpus, but must never wrongly reject) ──
  ok(ld.matchesLanguage('anything', ''), 'an unknown/blank target never filters');
  ok(ld.matchesLanguage('123 456 789', 'en'), 'too little scripted signal → kept');
  ok(ld.matchesLanguage('this is a normal english sentence with plenty of words to judge', 'en'), 'English text matches an English target');
  ok(!ld.matchesLanguage('これは日本語のページで歴史について書かれた長い文章です'.repeat(3), 'en'), 'a clearly Japanese page does not match an English target');
  ok(!ld.matchesLanguage('இது தமிழ் உரை. '.repeat(20), 'en'), 'a clearly Tamil page does not match an English target');

  // ── robustness: adversarial / mixed input never throws and stays bounded ──
  for (const bad of ['\u0000‮', '😀'.repeat(50), 'a'.repeat(100000), 42, {}, []]) {
    checks++; assert.doesNotThrow(() => { ld.detectLanguage(bad); ld.isLikelyNonEnglish(bad); ld.dominantScript(bad); }, 'never throws on adversarial input');
  }

  // ── Read-aloud catalog + guard: one list for the picker, the status route, and write validation ──
  ok(Array.isArray(ld.READ_ALOUD_LANGUAGES) && ld.READ_ALOUD_LANGUAGES.length >= 40,
    'the read-aloud catalog covers the expanded language set');
  ok(ld.READ_ALOUD_LANGUAGES.every((l) => /^[a-z]{2,3}$/.test(l.code) && !!l.name && !!l.region),
    'every read-aloud language has a code, a name, and a speech-region tag');
  for (const code of ['uk', 'be', 'bg', 'sr', 'mk', 'fa', 'ur', 'mr', 'ta', 'bn', 'am', 'hy', 'km',
    'af', 'az', 'bs', 'ca', 'cs', 'cy', 'et', 'eu', 'fil', 'ga', 'gl', 'hr', 'is', 'lt', 'lv', 'ms', 'mt', 'sk', 'sl', 'sq', 'sw']) {
    ok(!!ld.READ_ALOUD_LANGUAGES.find((l) => l.code === code), `${code} is offered in the read-aloud picker`);
  }
  ok(ld.READ_ALOUD_LANGUAGES.find((l) => l.code === 'es').region === 'es-ES',
    'a language carries the region tag a system voice expects');
  ok(ld.READ_ALOUD_LANGUAGES.find((l) => l.code === 'en').region === 'en-US',
    'English has an explicit speech-region tag for the system-voice fallback');
  ok(ld.READ_ALOUD_LANGUAGES.find((l) => l.code === 'fil').region === 'fil-PH',
    'a three-letter language keeps its full speech-region tag');
  ok(new Set(ld.SUPPORTED_LANGUAGES.map((l) => l.code)).size === ld.SUPPORTED_LANGUAGES.length,
    'the language catalog has no duplicate codes');
  ok(ld.isValidReadAloudLanguage('auto') && ld.isValidReadAloudLanguage('AUTO'), "'auto' is a valid read-aloud language in either case");
  ok(ld.isValidReadAloudLanguage('es') && ld.isValidReadAloudLanguage('ES') && ld.isValidReadAloudLanguage('uk') && ld.isValidReadAloudLanguage('fil'),
    'a supported code is valid in either case, including the expanded set');
  ok(!ld.isValidReadAloudLanguage('xx') && !ld.isValidReadAloudLanguage('') && !ld.isValidReadAloudLanguage(null),
    'an unknown or missing code is rejected');

  // ── SOURCE GUARD: routing uses the detector (web offer + the meta guard), and NOT to filter the corpus ──
  const ws = fs.readFileSync(path.join(PROJECT, 'lib', 'websearch.js'), 'utf-8');
  ok(/require\('\.\/langdetect'\)\.isLikelyNonEnglish\(q\)/.test(ws), 'the web-answerable gate uses the shared detector');
  const meta = fs.readFileSync(path.join(PROJECT, 'lib', 'meta.js'), 'utf-8');
  ok(/isLikelyNonEnglish\(q\)\) return false/.test(meta), 'the meta-question gate skips confidently non-English input');
  // No trigram bundle dependency (dropped as over-engineering for a local-first app).
  ok(!fs.existsSync(path.join(PROJECT, 'lib', 'trigram-profiles.json')), 'no bundled trigram profile data is required');

  console.log(`\nALL LANGDETECT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LANGDETECT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
