'use strict';
// Regression test for web-source persistence in a saved conversation. When a conversation is
// reopened, the in-app source reader must show the same readable content the live answer showed.
// The bug: only a web source's search snippet was persisted, so a result whose snippet was empty
// (a common case — a fetched article carries full text but no snippet) restored with nothing to
// read and the reader said "no readable text". The fix persists the readable body (the fetched
// article text, or the snippet as fallback), capped. This round-trips saveSession/loadSession
// through an isolated temp data dir. No model or network. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

// Isolate the on-disk sessions dir: sessions.js resolves DATA_DIR ('./data') relative to the
// process cwd, so chdir into a temp dir BEFORE requiring it.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-sessions-')));
process.chdir(tmp);
const { saveSession, loadSession, clearSession, isValidId } = require(path.join(PROJECT, 'lib', 'sessions'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const cleanup = (code) => { try { process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  try {
    const id = 'sesstest_' + Date.now().toString(36);
    ok(isValidId(id), 'the test session id is valid');

    await saveSession(id, {
      history: [
        { role: 'user', content: 'what is X?' },
        { role: 'assistant', content: 'here is X', sources: [
          // The failing case: a fetched article with full text but NO snippet.
          { id: 'web-0', source: 'Wikipedia — X', isWeb: true, url: 'https://en.wikipedia.org/wiki/X',
            text: 'The full readable article about X. '.repeat(20), snippet: '' },
          // A result that was not fetched — only a snippet is available.
          { id: 'web-1', source: 'Other', isWeb: true, url: 'https://example.com/x', text: '', snippet: 'a short snippet' },
          // A local document source — no web body, other fields must survive.
          { id: 'doc-1', source: 'notes.md', isWeb: false, viewerLink: '/document/view?path=notes.md',
            passageStart: 10, passageEnd: 40, docLength: 100 },
        ] },
      ],
    });

    const restored = await loadSession(id);
    ok(restored && Array.isArray(restored.history) && restored.history.length === 2, 'the session round-trips');
    const src = restored.history[1].sources;
    ok(Array.isArray(src) && src.length === 3, 'all three sources persist');

    // The bug fix: full text, empty snippet → the reader still has a body after restore.
    ok(typeof src[0].text === 'string' && src[0].text.length > 0, 'a web source with full text but no snippet keeps readable text after restore');
    ok(src[0].text.startsWith('The full readable article'), 'the persisted body is the fetched article text');
    // A snippet-only source falls back to the snippet as its readable body.
    ok(src[1].text === 'a short snippet', 'a web source with only a snippet keeps the snippet as its body');
    // Local document source: no web body added, its own fields intact.
    ok(src[2].isWeb === false && src[2].passageEnd === 40 && src[2].text === undefined, 'a local document source keeps its fields and gets no web body');

    // The persisted body is capped so a long article cannot bloat the session file.
    const id2 = 'sesstest2_' + Date.now().toString(36);
    await saveSession(id2, { history: [{ role: 'assistant', content: 'a', sources: [
      { id: 'web-0', source: 'Big', isWeb: true, url: 'https://e.com', text: 'y'.repeat(50000), snippet: '' }] }] });
    const r2 = await loadSession(id2);
    ok(r2.history[0].sources[0].text.length <= 8000, 'a long web article body is capped on persist');

    // Each answer's language is persisted so a restored conversation can route Read aloud to the same voice.
    // Detection is the shared fail-open detector; an explicitly supplied code wins, and English stays untagged
    // (the default voice) so a restored English answer needs no special case.
    const idL = 'sesslang_' + Date.now().toString(36);
    await saveSession(idL, { history: [
      { role: 'user', content: '¿cuál es el código de lanzamiento?' },
      { role: 'assistant', content: 'El código de lanzamiento del Proyecto Orion es ZX-9042.' },
      { role: 'user', content: 'et le budget ?' },
      { role: 'assistant', content: 'Le budget approuvé est de 7,5 millions de dollars.', language: 'fr' },
      { role: 'user', content: 'and the launch code?' },
      { role: 'assistant', content: 'The Orion Project launch code is ZX-9042.' },
    ] });
    const rl = await loadSession(idL);
    ok(rl.history[1].language === 'es', 'a Spanish answer is tagged es on persist');
    ok(rl.history[3].language === 'fr', 'an explicit language wins over detection');
    ok(rl.history[5].language === undefined, 'a clear English answer is not tagged (default voice)');
    ok(rl.history[0].language === undefined, 'only assistant turns carry a language');

    // Detection is cached back onto the LIVE entry so a long conversation is not re-detected on every save (O(n²)
    // → O(n)): after one save each assistant entry carries a string `language` — a code for non-English, '' for
    // English — so a second save short-circuits. (The '' is cached on the live object but never persisted/exposed.)
    const cacheCtx = { history: [
      { role: 'assistant', content: 'La respuesta está en el documento del proyecto.' },   // es → detected code
      { role: 'assistant', content: 'The answer is in the project document.' },            // en → '' (still cached)
    ] };
    await saveSession('sesscache_' + Date.now().toString(36), cacheCtx);
    ok(typeof cacheCtx.history[0].language === 'string' && cacheCtx.history[0].language.length > 0, 'a non-English turn caches its detected language on the live entry');
    ok(cacheCtx.history[1].language === '', 'an English turn caches an empty language on the live entry (so the next save does not re-detect it)');

    // A very long conversation is capped on persist so its session file cannot grow without bound
    // (the most recent turns are kept). The live in-memory history is not affected — only the file.
    const id3 = 'sesstest3_' + Date.now().toString(36);
    const many = [];
    for (let i = 0; i < 900; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: 'msg ' + i });
    await saveSession(id3, { history: many });
    const r3 = await loadSession(id3);
    ok(r3.history.length <= 400, 'a very long conversation is capped on persist');
    ok(r3.history[r3.history.length - 1].content === 'msg 899', 'the most recent turns are the ones kept');

    // When history is capped, summarizedUpTo (an index into history) is re-based by the dropped
    // count so it still points into the retained array — otherwise a restore would treat
    // unsummarized leading turns as summarized and drop them.
    const id4 = 'sesstest4_' + Date.now().toString(36);
    const hist = [];
    for (let i = 0; i < 450; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
    await saveSession(id4, { history: hist, summarizedUpTo: 60 });      // 450 - 400 = 50 dropped
    const r4 = await loadSession(id4);
    ok(r4.history.length === 400, 'history capped to 400');
    ok(r4.summarizedUpTo === 10, 'summarizedUpTo re-based by the dropped leading turns (60 - 50)');
    const id5 = 'sesstest5_' + Date.now().toString(36);
    await saveSession(id5, { history: hist, summarizedUpTo: 5 });
    const r5 = await loadSession(id5);
    ok(r5.summarizedUpTo === 0, 'summarizedUpTo clamps at 0 when smaller than the dropped count');

    // ── LOAD-side caps: a legacy / hand-grown file that slipped past the save caps (but is under the 64 MB
    // read gate) is re-capped on load too, so it can't pour an unbounded history or oversized web pages into
    // memory. Write a raw over-cap file directly (bypassing saveSession's own caps) and load it. ──
    const id6 = 'sesstest6_' + Date.now().toString(36);
    const rawMany = [];
    for (let i = 0; i < 900; i++) rawMany.push({ role: i % 2 ? 'assistant' : 'user', content: 'r' + i });
    const rawPages = [];
    for (let i = 0; i < 20; i++) rawPages.push({ title: 'p' + i, url: 'https://e/' + i, text: 'z'.repeat(50000) });
    fs.mkdirSync(path.join(tmp, 'data', 'sessions'), { recursive: true });
    // Sessions are namespaced on disk by principal key; a no-key call defaults to the 'owner' bucket.
    fs.writeFileSync(path.join(tmp, 'data', 'sessions', `owner__${id6}.json`),
      JSON.stringify({ history: rawMany, summarizedUpTo: 80, webPages: rawPages }));
    const r6 = await loadSession(id6);
    ok(r6.history.length === 400, 'an over-cap history is re-capped to 400 on load');
    ok(r6.history[r6.history.length - 1].content === 'r899', 'the most recent turns are kept on load');
    ok(r6.summarizedUpTo === 0, 'summarizedUpTo is rebased past the dropped turns on load (80 - 500 → 0)');
    ok(r6.webPages.length === 8, 'an over-cap web-page list is re-capped to 8 on load');
    ok(r6.webPages.every(p => p.text.length <= 4000), 'oversized web-page text is re-capped on load');

    // ── consultedDocs is bounded on persist AND load, so the meta-answer list ("which docs have we looked
    // at?") can't grow a session file (or memory on load) without bound. The most recent distinct docs win. ──
    const idC = 'sesscons_' + Date.now().toString(36);
    const manyDocs = [];
    for (let i = 0; i < 500; i++) manyDocs.push('doc' + i + '.md');
    await saveSession(idC, { history: [{ role: 'user', content: 'q' }], consultedDocs: manyDocs });
    const rc = await loadSession(idC);
    ok(rc.consultedDocs.length <= 200, 'consultedDocs is capped on persist');
    ok(rc.consultedDocs[rc.consultedDocs.length - 1] === 'doc499.md', 'the most recent consulted docs are kept on persist');
    // A raw file that slipped past the save cap is re-capped on load too.
    const idC2 = 'sesscons2_' + Date.now().toString(36);
    const rawDocs = []; for (let i = 0; i < 500; i++) rawDocs.push('rd' + i + '.md');
    fs.mkdirSync(path.join(tmp, 'data', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'sessions', `owner__${idC2}.json`), JSON.stringify({ history: [], consultedDocs: rawDocs }));
    const rc2 = await loadSession(idC2);
    ok(rc2.consultedDocs.length === 200, 'an over-cap consulted-docs list is re-capped on load');
    ok(rc2.consultedDocs[rc2.consultedDocs.length - 1] === 'rd499.md', 'the most recent consulted docs are kept on load');
    await clearSession(idC); await clearSession(idC2);

    // ── A save self-heals if the sessions dir was removed at runtime: there is no sync mkdir on the save
    // hot path (that would block the event loop every turn); the dir is made once at startup, and a save
    // that then hits ENOENT recreates it off-thread and retries once. ──
    const idH = 'sessheal_' + Date.now().toString(36);
    fs.rmSync(path.join(tmp, 'data', 'sessions'), { recursive: true, force: true });
    await saveSession(idH, { history: [{ role: 'user', content: 'reborn' }] });
    const rh = await loadSession(idH);
    ok(rh && rh.history[0] && rh.history[0].content === 'reborn', 'a save recreates the sessions dir if it was removed at runtime');
    await clearSession(idH);
    // Guard the hot path stays sync-mkdir-free (the fix is "no mkdirSync per save").
    const sessSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'sessions.js'), 'utf-8');
    const saveBody = sessSrc.slice(sessSrc.indexOf('const _saveSession'), sessSrc.indexOf('const clearSession'));
    ok(!/mkdirSync/.test(saveBody), 'the save path does not call mkdirSync (no synchronous dir creation per save)');

    // ── Per-session op ordering: save then clear (issued back-to-back, not awaited between) must end
    // deleted — the clear runs after the save, never leaving the just-cleared conversation on disk. This
    // is the "reset never resurrects a cleared conversation" guarantee under the save/clear file race.
    const idRace = 'sessrace_' + Date.now().toString(36);
    const sp = saveSession(idRace, { history: [{ role: 'user', content: 'hi' }] });
    const cp = clearSession(idRace);   // issued immediately after, without awaiting the save
    await Promise.all([sp, cp]);
    ok(!fs.existsSync(path.join(tmp, 'data', 'sessions', `owner__${idRace}.json`)), 'save-then-clear ends with the session file deleted (clear ordered after save)');
    ok(await loadSession(idRace) === null, 'a load after the ordered save+clear finds no session');

    // The reverse order (clear then save) must end with the file PRESENT — ordering is by call sequence.
    const idRace2 = 'sessrace2_' + Date.now().toString(36);
    const cp2 = clearSession(idRace2);
    const sp2 = saveSession(idRace2, { history: [{ role: 'user', content: 'kept' }] });
    await Promise.all([cp2, sp2]);
    const rr2 = await loadSession(idRace2);
    ok(rr2 && rr2.history.length === 1 && rr2.history[0].content === 'kept', 'clear-then-save ends with the saved session present (call-order preserved)');

    // Many rapid saves of one id resolve without corrupting the file (serialized, last write wins).
    const idBurst = 'sessburst_' + Date.now().toString(36);
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      saveSession(idBurst, { history: [{ role: 'user', content: 'v' + i }] })));
    const rb = await loadSession(idBurst);
    ok(rb && Array.isArray(rb.history) && rb.history.length === 1 && /^v\d+$/.test(rb.history[0].content),
      'a burst of concurrent saves leaves a valid (non-corrupt) session file');
    await clearSession(idBurst);
    await clearSession(idRace2);

    // ── Principal namespacing (S3): a session saved under one principal key is invisible under another, so a
    // (client-supplied) session id can only ever address the caller's OWN session files — defense in depth even
    // though ids are 128-bit random. The same id under two principals is two independent files. ──
    const idShared = 'sessns_' + Date.now().toString(36);
    await saveSession(idShared, { history: [{ role: 'user', content: 'alice-secret' }] }, 'keyAAAA');
    const asOwner = await loadSession(idShared, 'keyBBBB');
    ok(asOwner === null, 'a session saved under one principal key is not found under another key (no cross-user restore)');
    const asSelf = await loadSession(idShared, 'keyAAAA');
    ok(asSelf && asSelf.history[0].content === 'alice-secret', 'the owning principal restores its own session by the same id');
    // A clear under a different key does not delete another principal's session.
    await clearSession(idShared, 'keyBBBB');
    const stillThere = await loadSession(idShared, 'keyAAAA');
    ok(stillThere && stillThere.history[0].content === 'alice-secret', 'a clear under a different key cannot delete another principal\'s session');
    await clearSession(idShared, 'keyAAAA');

    await clearSession(id);
    await clearSession(id2);
    await clearSession(id3);
    await clearSession(id4);
    await clearSession(id5);
    console.log(`\nALL SESSIONS UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ SESSIONS UNIT TEST FAILED:', e.message);
    cleanup(1);
  }
})();
