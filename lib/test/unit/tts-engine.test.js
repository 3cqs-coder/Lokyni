'use strict';
// Guards the local text-to-speech engine's PURE, offline parts — no model download, no worker, no network — so
// the suite stays fast and deterministic:
//   • encodeWav: produces a valid 16-bit mono WAV (RIFF/WAVE header, correct sizes, clamped samples);
//   • chunkText: splits at sentence boundaries, bounds every chunk to the token-safe char cap, hard-splits a
//     single over-long sentence, and is language-agnostic (CJK terminators too);
//   • the manager's voice contract (VOICES ids well-formed, DEFAULT_VOICE valid, isValidVoice strict);
//   • source guards: the route is gated on ttsEnabled, config single-sources the voice list, and the worker
//     is registered for orderly shutdown (no orphaned thread).
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { SETTINGS, WRITABLE_KEYS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const core = require(path.join(PROJECT, 'lib', 'voice', 'ttscore'));
const tts  = require(path.join(PROJECT, 'lib', 'voice', 'tts'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── encodeWav ──────────────────────────────────────────────────────────────────────────────────────────
  const sr = core.SAMPLE_RATE;
  const pcm = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);   // includes out-of-range samples to clamp
  const wav = core.encodeWav(pcm, sr);
  ok(Buffer.isBuffer(wav), 'encodeWav returns a Buffer');
  eq(wav.length, 44 + pcm.length * 2, 'WAV length = 44-byte header + 16-bit samples');
  eq(wav.slice(0, 4).toString('latin1'), 'RIFF', 'starts with the RIFF tag');
  eq(wav.slice(8, 12).toString('latin1'), 'WAVE', 'declares the WAVE format');
  eq(wav.slice(12, 16).toString('latin1'), 'fmt ', 'has a fmt chunk');
  eq(wav.slice(36, 40).toString('latin1'), 'data', 'has a data chunk');
  eq(wav.readUInt32LE(4), 36 + pcm.length * 2, 'RIFF chunk size is correct');
  eq(wav.readUInt16LE(20), 1, 'PCM format (1)');
  eq(wav.readUInt16LE(22), 1, 'mono (1 channel)');
  eq(wav.readUInt32LE(24), sr, 'sample rate in the header matches');
  eq(wav.readUInt32LE(28), sr * 2, 'byte rate = sampleRate * blockAlign');
  eq(wav.readUInt16LE(34), 16, '16 bits per sample');
  eq(wav.readUInt32LE(40), pcm.length * 2, 'data chunk size is correct');
  // Clamping: +2 → +32767, −2 → −32768 (never wraps/overflows).
  eq(wav.readInt16LE(44 + 5 * 2), 32767, 'a sample above +1 clamps to +32767');
  eq(wav.readInt16LE(44 + 6 * 2), -32768, 'a sample below −1 clamps to −32768');
  eq(wav.readInt16LE(44 + 0 * 2), 0, 'silence encodes to 0');
  eq(core.encodeWav(new Float32Array(0), sr).length, 44, 'an empty waveform still yields a valid header-only WAV');

  // ── chunkText ──────────────────────────────────────────────────────────────────────────────────────────
  const CAP = 300;   // MAX_CHUNK_CHARS (private) — the cap chunks must respect
  const within = (chunks) => chunks.every((c) => c.length <= CAP);

  const simple = core.chunkText('First sentence. Second sentence! Third one?');
  ok(simple.length >= 1 && within(simple), 'short multi-sentence text chunks within the cap');
  ok(simple.join(' ').includes('First sentence'), 'no sentence content is dropped');

  // Many short sentences pack together but never exceed the cap.
  const many = core.chunkText(Array.from({ length: 60 }, (_, i) => `Sentence number ${i} here.`).join(' '));
  ok(many.length > 1 && within(many), 'many sentences pack into multiple capped chunks');

  // A single over-long sentence (no terminators) is hard-split, still within the cap.
  const long = core.chunkText('word '.repeat(400).trim());
  ok(long.length > 1 && within(long), 'one over-long sentence is hard-split within the cap');

  // Language-agnostic: CJK full-width terminators split too (no Latin-only assumption).
  const cjk = core.chunkText('これは最初の文です。これは二番目の文です！三番目？');
  ok(cjk.length >= 1 && within(cjk), 'CJK sentence terminators are recognized');

  eq(core.chunkText('').length, 0, 'empty text yields no chunks');
  eq(core.chunkText('   ').length, 0, 'whitespace-only text yields no chunks');

  // ── voice contract (manager) ───────────────────────────────────────────────────────────────────────────
  ok(Array.isArray(tts.VOICES) && tts.VOICES.length >= 1, 'VOICES is a non-empty list');
  for (const v of tts.VOICES) {
    ok(/^[ab][fm]_[a-z]+$/.test(v.id), `voice id ${v.id} is well-formed (accent+gender_name)`);
    ok(typeof v.label === 'string' && v.label.length > 0, `voice ${v.id} has a human label`);
  }
  ok(tts.isValidVoice(tts.DEFAULT_VOICE), 'DEFAULT_VOICE is a valid voice');
  ok(tts.isValidVoice(tts.VOICES[0].id), 'isValidVoice accepts a known id');
  ok(!tts.isValidVoice('zz_nobody'), 'isValidVoice rejects an unknown id');
  ok(!tts.isValidVoice(''), 'isValidVoice rejects empty');
  ok(!tts.isValidVoice(null) && !tts.isValidVoice(undefined), 'isValidVoice rejects null/undefined');
  eq(typeof tts.isAvailable(), 'boolean', 'isAvailable returns a boolean without loading the model');

  // ── source guards ──────────────────────────────────────────────────────────────────────────────────────
  const routeSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'tts.js'), 'utf-8');
  const ttsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'voice', 'tts.js'), 'utf-8');
  ok(/cfg\.ttsEnabled !== true\) return res\.status\(403\)/.test(routeSrc), 'POST /api/tts is gated on ttsEnabled (403 when off)');
  ok(/audio\/wav/.test(routeSrc), 'the route returns audio/wav');
  ok(/resolveSpeed\(body\.speed, cfg\)/.test(routeSrc) && /synthesize\(text, \{ voice, speed \}\)/.test(routeSrc), 'the route applies a clamped playback speed');

  // Pre-warm + Web Audio playback + play icon: the first read-aloud is fast and plays reliably (browser + desktop).
  const bootWarmSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/ttsEnabled === true && \(liveCfg\.ttsLanguage === 'auto' \|\| liveCfg\.ttsLanguage === 'en'\)/.test(bootWarmSrc) &&
     /require\('\.\/voice\/tts'\)/.test(bootWarmSrc) && /tts\.warm\(\)/.test(bootWarmSrc),
    'the TTS model is pre-warmed at boot when enabled (fast first use), but not when a non-English language is forced');
  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  // Playback goes through Web Audio (decodeAudioData + a source node), NOT an <audio> element — the <audio> tag
  // reported "no supported source" for a WAV in some engines, breaking read-aloud and voice preview.
  ok(/decodeAudioData/.test(chatJs) && /createBufferSource/.test(chatJs) && /function playAudioBuffer/.test(chatJs), 'voice audio plays via Web Audio (reliable across browser + desktop)');
  ok(!/new Audio\(\)/.test(chatJs), 'no <audio> element is used for voice playback (the source of the "no supported source" failure)');
  ok(/function unlockAudio/.test(chatJs) && /\.resume\(\)/.test(chatJs), 'the AudioContext is unlocked within the user gesture');
  ok(/previewVoice/.test(chatJs) && /VOICE_PREVIEW_TEXT/.test(chatJs), 'Settings can preview a voice');
  ok(/audioBtnHTML\('ic-play'/.test(chatJs), 'the read-aloud control shows a play icon');
  // Streaming read-aloud: the answer is split into small chunks and played as they synthesize (fast first audio),
  // scheduled sample-accurately so it stays gapless — including a startup cushion so there's no gap right after
  // the first sentence, and a language-agnostic splitter so streaming works in any language.
  ok(/function splitForTTS/.test(chatJs) && /async function streamReadAloud/.test(chatJs), 'read-aloud streams in chunks (fast first audio)');
  ok(/function scheduleBuffer/.test(chatJs) && /audioNextTime/.test(chatJs), 'chunks are scheduled sample-accurately on the audio clock (gapless)');
  ok(/const LEAD =/.test(chatJs) && /cushion/.test(chatJs), 'a startup cushion is prebuffered (no gap after the first sentence, even at higher speed)');
  // The terminator set must span non-Latin scripts (CJK, Arabic/Urdu, Indic danda, …) so the splitter is language-agnostic.
  const termMatch = chatJs.match(/const TTS_TERMINATORS = '([^']*)'/);
  ok(termMatch && /[。！？]/.test(termMatch[1]) && /[।]/.test(termMatch[1]), 'the sentence splitter is language-agnostic (non-Latin terminators)');
  ok(/downloaded:\s*tts\.isModelDownloaded\(\)/.test(routeSrc), 'the status reports whether the voice model is downloaded (diagnostics)');
  ok(/warming:\s*tts\.isWarming\(\)/.test(routeSrc), 'the status reports an in-progress model warm (Settings progress)');
  ok(typeof tts.isWarming() === 'boolean', 'isWarming is a cheap boolean probe (no model load)');
  ok(/function pollVoiceWarm/.test(chatJs) && /stopTtsWarmPoll/.test(chatJs) && /preparing the voice model/.test(chatJs),
    'Settings shows and refreshes a bounded preparing state while the model warms');
  // The download is visible, not a silent spinner: the status serves a { pct, bytes, totalBytes } snapshot and a
  // failure reason, computed in one shared aggregator, and the status line renders a live percentage.
  ok(/download:\s*tts\.downloadProgress\(\)/.test(routeSrc) && /downloadError:\s*tts\.lastDownloadError\(\)/.test(routeSrc),
    'the status serves live download progress and the last failure reason');
  ok(typeof tts.downloadProgress === 'function' && typeof tts.lastDownloadError === 'function'
    && tts.downloadProgress() === null && tts.lastDownloadError() === null,
    'downloadProgress/lastDownloadError are cheap probes, null before any download (no model load)');
  ok(/downloading the voice model… \$\{voiceProgressText\(d\)\}/.test(chatJs) && /function voiceProgressText\(d\)/.test(chatJs),
    'the Settings status line renders the download via the shared voiceProgressText helper (live percentage)');
  ok(/d\.totalBytes >= 1024 \* 1024/.test(chatJs),
    'the progress text shows the MB breakdown only when it is meaningful (no "0 / 0 MB" for a cache-served model)');
  // The one-time download is routed through warm() (generous budget + stall watchdog), never a synth whose short
  // timeout would kill it mid-download and restart from zero — the root cause of the "always downloading" loop.
  ok(/if \(!isModelDownloaded\(\)\) \{ warm\(\); throw Object\.assign\(new Error\('voice model is still downloading'\)/.test(ttsSrc),
    'synthesize never downloads: it starts warm() and reports "still downloading" instead of killing the worker');
  ok(/createDownloadManager\(\{[\s\S]*stalledReason: 'voice model download stalled'/.test(ttsSrc)
    && /require\('\.\.\/modeldownload'\)/.test(ttsSrc),
    'the one-time download + stall watchdog is delegated to the shared lib/modeldownload manager (single source, no drift)');
  const dlSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'modeldownload.js'), 'utf-8');
  ok(/DEFAULT_DOWNLOAD_TIMEOUT_MS\s*=/.test(dlSrc) && /DEFAULT_DOWNLOAD_STALL_MS\s*=/.test(dlSrc) && /rpc\.shutdown\(stalledReason\)/.test(dlSrc),
    'the shared manager holds the generous budget + the stall watchdog that drops a wedged download');
  ok(/status\(202\)\.json\(\{ error: 'The voice model is still downloading\.'/.test(routeSrc),
    'the synth route answers 202 (with progress) while the model downloads, so callers can show it and retry');
  ok(/const warmTtsModel =/.test(bootWarmSrc) && /warmTtsModel\(\)/.test(bootWarmSrc),
    'startup and the settings save share one background warm path');
  ok(/ttsEnabled === true && nowTtsLocal && \(before\.ttsEnabled !== true \|\| !beforeTtsLocal\)/.test(bootWarmSrc),
    'enabling read-aloud (or switching back to a local language) warms the model without re-warming unrelated saves');

  // Multilingual read-aloud: the status exposes the shared language catalog + settings, the client routes
  // non-English answers to a system voice, and online system voices stay behind an explicit opt-in.
  ok(/languages: READ_ALOUD_LANGUAGES/.test(routeSrc) && /allowOnlineVoices: cfg\.ttsAllowOnlineVoices === true/.test(routeSrc),
    'the status exposes the language catalog and the online-voice opt-in');
  ok(/language: isValidReadAloudLanguage\(cfg\.ttsLanguage\)/.test(routeSrc), 'the status reports the configured language');
  ok(/function readAloudMode/.test(chatJs) && /function resolveReadAloudLanguage/.test(chatJs),
    'the client resolves an answer language and chooses local vs. system playback');
  ok(/function speakSystemText/.test(chatJs) && /SpeechSynthesisUtterance/.test(chatJs) && /getVoices\(\)/.test(chatJs),
    'non-English answers are spoken with an installed system voice');
  ok(/localService === false/.test(chatJs) && /allowOnlineVoices === true/.test(chatJs),
    'system voices marked online are used only when the user opts in');
  ok(/systemVoices: Array\.isArray\(cfg\.ttsSystemVoices\)/.test(routeSrc),
    'the status exposes the saved per-language voice preferences');
  ok(/function populateSystemVoiceOptions/.test(chatJs) && /function previewSystemVoice/.test(chatJs),
    'the client offers a system-voice picker and a language-aware preview');
  ok(/preferredSystemVoice/.test(chatJs) && /findInstalledVoice/.test(chatJs),
    'a saved per-language voice is preferred, with the automatic choice as fallback');
  ok(/function attachAnswerReadAloud/.test(chatJs) && /data-answer="1"/.test(chatJs) &&
     /attachRestoredControls[\s\S]{0,500}attachAnswerReadAloud\(\)/.test(chatJs),
    'finalized answers on screen (live and restored) share one Read-aloud reattachment sweep');
  ok(!/attachReadAloudButton\(a\.text, row, a\.language\)/.test(chatJs),
    'restored answers do not keep a second, divergent Read-aloud attach path');
  ok(/answerRow\.dataset\.answerLang = pendingAnswerLang/.test(chatJs) && /row\.dataset\.answerLang = language/.test(chatJs),
    'the server-detected answer language travels with live and restored rows for later attachment');
  ok(/function noteOnlineVoice/.test(chatJs) && /online voice — uses a network service/.test(chatJs),
    'an online voice is called out in Settings and with a one-time notice when used');
  ok(/const localPool = localKnown\.concat\(localUnknown\)/.test(chatJs) && /localPool\.length \? localPool : onlinePool/.test(chatJs),
    'automatic voice choice prefers the local pool, even over an online default');
  ok(/function openReadAs/.test(chatJs) && /ans-readas/.test(chatJs) && /forceLanguage/.test(chatJs),
    'the per-answer Read as dialog re-reads one answer in a chosen language without changing Settings');
  ok(/function sortedLanguageList/.test(chatJs) && /sortedLanguageList\(s\.languages\)/.test(chatJs),
    'both language pickers sort the shared server catalog for scanning');
  ok(/const LANGUAGE_CODE_RE = \/\^\[a-z\]\{2,3\}\$\//.test(chatJs),
    'language codes accept two- or three-letter subtags consistently');
  ok(/populateSystemVoiceLanguageOptions/.test(chatJs) && /cfgTtsSystemLanguage/.test(chatJs),
    'the Settings voice picker browses a language independently of playback');
  ok(/readas-detected/.test(chatJs) && /Detected:/.test(chatJs),
    'the per-answer dialog reports the detected language');
  ok(/setAttribute\('aria-pressed'/.test(chatJs) && /Reading aloud with a \$\{languageName\(lang\)\} system voice/.test(chatJs),
    'the answer control exposes its playback state and announces the voice to assistive technology');
  ok(/handsfreeSpeechGen/.test(chatJs) && /speechGen !== handsfreeSpeechGen/.test(chatJs),
    'a stopped hands-free read invalidates its pending start guard (no stale interruption)');
  ok(/const chunks = splitForTTS\(text\)/.test(chatJs) && /function stopSystemSpeech/.test(chatJs),
    'system speech reuses the language-agnostic splitter and is cancellable');
  ok(/function stopReadAloud[\s\S]{0,600}stopSystemSpeech\(\)/.test(chatJs),
    'Stop cancels a system utterance as well as local audio');
  ok(/SYSTEM_START_TIMEOUT_MS/.test(chatJs) && /clearSystemStartTimer/.test(chatJs),
    'a silent system voice times out instead of leaving a stuck loading button');
  ok(/pendingAnswerLang/.test(chatJs) && /data\.language/.test(chatJs) && /payload\.language/.test(chatJs),
    'the client records the server-detected answer language');
  const socketSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
  ok(/detectLanguage\(answer\) \|\| \(failed \? '' : detectLanguage\(query\)\)/.test(socketSrc) && /answer_turn', \{ turnId, language/.test(socketSrc),
    'the server tags each answered turn with its language');
  ok(/detectLanguage\(responseText\)/.test(socketSrc), 'the summary path carries its language on chat_end');
  const sessionsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'sessions.js'), 'utf-8');
  ok(/detectLanguage\(m\.content\)/.test(sessionsSrc) && /base\.language = m\.language/.test(sessionsSrc),
    'saved sessions persist each answer language for restored read-aloud (detected once, cached on the entry)');
  ok(SETTINGS.ttsLanguage.default === 'auto' && SETTINGS.ttsAllowOnlineVoices.default === false,
    'the shared schema defaults read-aloud to automatic matching and offline voices');

  const cfgSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'config.js'), 'utf-8');
  ok(/isValidReadAloudLanguage\(providerConfig\.ttsLanguage\)/.test(cfgSrc) && /flag\('ttsAllowOnlineVoices'/.test(cfgSrc),
    'config reads both voice settings through the shared schema and language guard');
  ok(SETTINGS.ttsEnabled.default === false, 'ttsEnabled defaults OFF in the shared settings schema');
  ok(/flag\('ttsEnabled', providerConfig\.ttsEnabled\)/.test(cfgSrc), 'ttsEnabled is read through the shared schema');
  ok(/ttsEnabled, ttsVoice/.test(cfgSrc), 'ttsEnabled/ttsVoice are exported from config');

  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(WRITABLE_KEYS.includes('ttsEnabled') && WRITABLE_KEYS.includes('ttsVoice'), 'ttsEnabled/ttsVoice are in the shared writable schema');
  ok(/isValidVoice\(val\)/.test(serverSrc), 'ttsVoice is enum-guarded on save (only a known voice persists)');

  const bootSrc = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
  ok(/text-to-speech worker/.test(bootSrc) && /voice\/tts'\)\.shutdown\(\)/.test(bootSrc),
    'the TTS worker is registered for orderly shutdown (no orphaned thread)');

  console.log(`\nALL TTS-ENGINE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TTS-ENGINE TEST FAILED:', e && e.message);
  process.exit(1);
}
