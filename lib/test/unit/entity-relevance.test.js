'use strict';
// Guards the "a question that names a corpus entity is on-topic" fix. Symptom: clicking an entity in the
// mind-map (e.g. a big "Zorptoken" node) filled "Tell me about Zorptoken based on my documents" and the
// answer was "That falls outside what I can help with…" — a false out-of-corpus refusal for a topic the
// documents clearly cover. Two causes:
//   1. The mind-map appended "based on my documents", which pulled the query embedding toward meta
//      "documents / knowledge base" wording and below the relevance gate's cosine floor.
//   2. The relevance gate had no notion that the query NAMES one of the corpus's own graph entities. The
//      2+-entity bridge marks relationship questions on-topic, but a plain one-entity "tell me about X" did
//      not qualify, so a low single-document similarity got it declined.
// Fixes: the mind-map asks "Tell me about <entity>." (no meta suffix), and graphrag.namesEntity matches the
// query against the knowledge graph's own node NAMES (single- AND multi-word — the capitalized-phrase entity
// extractor ignores a lone word like "Zorptoken", so names are matched directly) to mark such a query on-topic.
// namesEntity's matcher is pure given a graph, so it is tested directly with a stubbed graph; the wiring is
// source-guarded. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    // ── FUNCTIONAL: namesEntity detects a single- or multi-word entity, rejects off-topic + trivial names ──
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    const store = require(path.join(PROJECT, 'lib', 'graphstore'));
    const origGet = store.getGraph;
    const origFlag = Object.getOwnPropertyDescriptor(cfg, 'useGraphRag');
    try {
      Object.defineProperty(cfg, 'useGraphRag', { value: true, configurable: true });
      store.getGraph = async () => ({ nodes: new Map([
        ['zorptoken', { name: 'Zorptoken' }],
        ['helix protocol', { name: 'Helix Protocol' }],
        ['x', { name: 'X' }],   // too short — must be ignored so a stray "x" can't wave a query through
        // Multi-lingual / language-agnostic coverage (synthetic names across scripts):
        ['long-accented', { name: 'Óscar Bruno de Prado Rodríguez' }],   // 5 words + diacritics (the real-world miss)
        ['cjk', { name: '比特币协议' }],                                   // CJK (no word spaces → substring match)
        ['cyrillic', { name: 'Газпром Нефть' }],                          // Cyrillic (space-delimited → window match)
      ]) });
      // Fresh require so it picks up the stubbed store/config deterministically.
      delete require.cache[require.resolve(path.join(PROJECT, 'lib', 'retrieval', 'graphrag'))];
      const gr = require(path.join(PROJECT, 'lib', 'retrieval', 'graphrag'));
      const idx = { workspaceId: 'default' };
      ok((await gr.namesEntity('Tell me about Zorptoken.', idx)) === true, 'a single-word corpus entity (Zorptoken) is detected');
      ok((await gr.namesEntity('Tell me about Helix Protocol.', idx)) === true, 'a multi-word corpus entity is detected');
      ok((await gr.namesEntity('zorptoken price outlook', idx)) === true, 'the entity is detected mid-sentence, case-insensitively');
      ok((await gr.namesEntity('What is the weather today?', idx)) === false, 'an off-corpus question is NOT marked on-topic');
      ok((await gr.namesEntity('Tell me about X.', idx)) === false, 'a trivially short node name is ignored (no false positive)');
      // ── language-agnostic matching (the matcher must not be English-only) ──
      ok((await gr.namesEntity('Tell me about Óscar Bruno de Prado Rodríguez.', idx)) === true, 'a 5-word accented name is detected (any length, diacritics folded)');
      ok((await gr.namesEntity('tell me about oscar bruno de prado rodriguez', idx)) === true, 'the same name matches without the accents (diacritic folding is symmetric)');
      ok((await gr.namesEntity('比特币协议是什么？', idx)) === true, 'a CJK entity (no word spaces) is detected by substring');
      ok((await gr.namesEntity('расскажи про Газпром Нефть сегодня', idx)) === true, 'a Cyrillic multi-word entity is detected');
      ok((await gr.namesEntity('tell me about the weather in Prado', idx)) === false, 'a single word that is only PART of a longer name does not falsely match');
    } finally {
      store.getGraph = origGet;
      if (origFlag) Object.defineProperty(cfg, 'useGraphRag', origFlag);
      delete require.cache[require.resolve(path.join(PROJECT, 'lib', 'retrieval', 'graphrag'))];
    }

    // ── SOURCE GUARD: the mind-map no longer appends the meta suffix ──
    const chat = read('lib', 'public', 'js', 'chat.js');
    ok(/msgInput\.value = `Tell me about \$\{name\}\.`;/.test(chat),
      'the mind-map asks "Tell me about <entity>." with no meta suffix');
    ok(!/Tell me about \$\{name\} based on my documents/.test(chat),
      'the retrieval-diluting "based on my documents" suffix is gone from the mind-map query');

    // ── SOURCE GUARD: the relevance gate treats a named corpus entity as on-topic ──
    const gr = read('lib', 'retrieval', 'graphrag.js');
    ok(/const namesEntity = async \(query, idx\)/.test(gr) && /module\.exports = \{ bridge, namesEntity, entityProbe \};/.test(gr),
      'graphrag exports namesEntity and entityProbe');
    ok(/const entityProbe = async \(query, idx\)/.test(gr) && /return \{ name: node\.name, query: probe, docIds \};/.test(gr),
      'entityProbe returns the matched entity name, a focused probe query, and its source docIds');
    const search = read('lib', 'retrieval', 'search.js');
    ok(/let namesCorpusEntity = false;/.test(search), 'search.js tracks a single-named-entity on-topic flag');
    ok(/entityProbe\(standaloneQuery, idx\)/.test(search), 'search.js consults entityProbe for the single-entity case (surfaces the entity\'s own doc)');
    ok(/if \(namedEntity && mergedDocs\.length > 1\)/.test(search) && /withEntity = mergedDocs\.filter/.test(search),
      'search.js focuses a single-entity answer on the documents that actually mention the entity (drops noisy co-sources)');
    // Both relevance gates (cosine + BM25) treat a named corpus entity / focus / entity-bridge as on-topic.
    ok(/const hasContext = focusMode \|\| entityBridged \|\| namesCorpusEntity \|\| conversationContext\.allowedDocIds\?\.length > 0;/.test(search),
      'the cosine relevance gate context check includes namesCorpusEntity');
    ok(/const hasContext = focusMode \|\| entityBridged \|\| namesCorpusEntity \|\|\s*\(!willShiftAway && conversationContext\.allowedDocIds\?\.length > 0\);/.test(search),
      'the BM25 relevance gate context check includes namesCorpusEntity');
    // The BM25 gate must NOT borrow the conversation anchor's exemption when the intent is about to shift away
    // (new_topic, or a continue/reference the grounding guard rejected) — otherwise an off-corpus new subject
    // asked mid-conversation ("Can pigs fly?") skips the gate on a stale anchor and is answered from whatever
    // document a tangential keyword matches, instead of being declined as it is when asked fresh.
    ok(/const willShiftAway = intentSaysNewTopic \|\| \(intentSaysContinueRaw && !intentSaysContinue\);/.test(search),
      'the BM25 gate drops the stale-anchor exemption for a query that will shift to a new topic');
    // search.js tells the model the subject is present, but only when its name is actually in the context.
    ok(/aboutEntity = \(namedEntity && mergedContext\.toLowerCase\(\)\.includes/.test(search) && /aboutEntity,/.test(search),
      'search.js passes aboutEntity to the prompt only when the named subject is present in the context');

    // ── PROMPT: a briefly-mentioned named subject must be ANSWERED, not refused ──
    const rules = read('lib', 'ai', 'data', 'grounding-rules.txt');
    ok(/even a single sentence, a quote, a role, or a passing mention IS information about it/.test(rules) &&
       /ONLY when the name does not appear in the DOCUMENTS section at all/.test(rules),
      'the grounding rules treat a brief mention of a named subject as answerable (and still refuse when absent)');
    const llm = read('lib', 'llm.js');
    ok(/opts\.aboutEntity/.test(llm) && /entityBlock/.test(llm) && /replace\(\/\[\\r\\n\]\+\/g, ' '\)\.replace\(\/\["\\\\\]\/g, ''\)/.test(llm),
      'llm.js adds a sanitized, injection-safe named-subject instruction from opts.aboutEntity');

    console.log(`\nALL ENTITY-RELEVANCE TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ ENTITY-RELEVANCE UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
