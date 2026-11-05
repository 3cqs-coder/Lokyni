'use strict';
// Guards the turn-abort contract for the workspace-synthesis chat path (lib/socket.js). Synthesis
// runs one LLM summary per document and can take minutes; if the user clicks New (reset_conversation)
// during it, the reset must be able to abort THIS turn. The AbortController must therefore be created
// and assigned to activeAbort BEFORE the long runWorkspaceSynthesis await, with an aborted-guard
// right after it — otherwise the reset is a no-op during the map phase and the finished answer streams
// into the just-cleared conversation and re-saves the deleted session (a conversation-resurrection
// bug). This mirrors the web and deep-research paths. Source-guarded because exercising the socket
// handler end to end needs a full workspace/model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // Isolate the runWorkspaceSynthesisToChat function body.
  const start = src.indexOf('const runWorkspaceSynthesisToChat =');
  ok(start !== -1, 'runWorkspaceSynthesisToChat is present');
  // End at the next top-level handler declaration after it.
  const end = src.indexOf("client.on('web_accept'", start);
  const fn = src.slice(start, end > start ? end : undefined);

  const abortAssign = fn.indexOf('abort = beginTurnAbort()');
  const synthCall   = fn.indexOf('await runWorkspaceSynthesis(');
  ok(abortAssign !== -1, 'the synthesis path registers its controller through the shared begin-turn helper');
  ok(synthCall !== -1, 'the synthesis path awaits runWorkspaceSynthesis');
  ok(abortAssign < synthCall, 'the abort is wired BEFORE the slow synthesis await (so a reset during the map phase can cancel it)');

  // An aborted-guard must sit immediately after the synthesis await, before anything is emitted,
  // pushed to history, or saved.
  const guardAfter = fn.indexOf('if (abort.signal.aborted) return;', synthCall);
  const pushHistory = fn.indexOf('conversationContext.history.push');
  const saveSess    = fn.indexOf('saveSession(');
  ok(guardAfter !== -1 && guardAfter > synthCall, 'an aborted-guard follows the synthesis await');
  ok(guardAfter < pushHistory, 'the aborted-guard runs before history is pushed (no resurrection)');
  ok(guardAfter < saveSess, 'the aborted-guard runs before the session is saved (no resurrection)');

  // The controller is released (only if it is still ours) via the shared releaseTurn helper.
  ok(/releaseTurn\(abort\);/.test(fn), 'the synthesis finally releases the turn via the shared releaseTurn helper');

  // ── The semantic-cache-hit path must also guard its async lookup against a reset (audit pass 22) ──
  // reset_conversation runs unserialized, and sc.lookup does async disk I/O, so a New click during it
  // would otherwise let the stale hit stream into the cleared conversation and re-save the deleted
  // session. The controller must be wired before the lookup and guarded after.
  const scLookup = src.indexOf('await sc.lookup(');
  ok(scLookup !== -1, 'the semantic-cache lookup is present');
  const scWindow = src.slice(Math.max(0, scLookup - 400), scLookup + 400);
  ok(/const scAbort = beginTurnAbort\(\);?[ \t]*\n\s*const hit = await sc\.lookup\(/.test(scWindow),
    'the cache lookup registers its controller through the shared begin-turn helper before awaiting');
  ok(/if \(scAbort\.signal\.aborted\) \{ releaseTurn\(scAbort\); return; \}/.test(scWindow),
    'an aborted-guard follows the cache lookup, before the stale hit is emitted or saved');

  // The cache-hit path must also run the deterministic citation guard the live path runs, so a cached
  // answer that cites a non-retrieved file still shows the caution (not just the egress/leak finalize). It now
  // goes through the shared grounded finalizer (verify pass + citation guard, single-sourced in answerfinalize),
  // then emits the returned caveat — the same sequence the live document path uses.
  const hitWindow = src.slice(scLookup, scLookup + 1600);
  ok(/finalizeGroundedStreamed\(hit\.answer, hitSources, idx\)/.test(hitWindow),
    'the cache-hit path runs the shared grounded finalizer (verify pass + citation guard), like the live path');
  ok(/if \(fin\.caveat\) client\.emit\('message', fin\.caveat\)/.test(hitWindow),
    'the cache-hit path emits the invented-citation caveat (kept out of stored history)');

  // ── The main document path keeps its abort live through the post-answer persistence tail ──
  // A reset during updateConversationSummary must be caught before saveSession, or it re-saves the
  // just-cleared conversation and emits stray sources/chat_end. So the handler no longer nulls
  // activeAbort before the tail; it releases in a finally (identity-guarded), and guards after the
  // summary await.
  const msgStart = src.indexOf("client.on('message'");
  const msgBody  = src.slice(msgStart, src.indexOf("client.on('disconnect'", msgStart));
  const summaryAwait     = msgBody.indexOf('await updateConversationSummary(conversationContext');
  const saveAfterSummary = msgBody.indexOf('saveSession(sessionId, conversationContext', summaryAwait);
  const guardAfterSummary = msgBody.indexOf('if (abort.signal.aborted) return;', summaryAwait);
  ok(summaryAwait !== -1 && guardAfterSummary !== -1 && guardAfterSummary < saveAfterSummary,
    'the main path guards against a reset after the conversation-summary await, before saving the session');
  ok(/\} finally \{[\s\S]*?releaseTurn\(abort\);[\s\S]*?\}\s*\}\)\);/.test(msgBody),
    'the main path releases the turn in a finally (every exit path), not before the persistence tail');

  // ── Post-answer meta is matched on a monotonic turn id, not query text (pass "finish deferred") ──
  // Two identical consecutive queries can't be told apart by text, so the late faithfulness/suggestion
  // payloads carry a per-turn id assigned in emitAnswerMeta and echoed to the client via 'answer_turn'.
  const meta = src.slice(src.indexOf('const emitAnswerMeta'), src.indexOf('const emitAnswerMeta') + 14000);
  ok(/const turnId = \+\+turnSeq;/.test(meta) && /client\.emit\('answer_turn', \{ turnId, language/.test(meta),
    'emitAnswerMeta assigns a turn id and announces it to the client');
  ok(/client\.emit\('faithfulness', \{ query, turnId, \.\.\.fr \}\)/.test(meta), 'the faithfulness payload carries the turn id');
  ok(/client\.emit\('suggested_questions', \{ query, turnId, questions \}\)/.test(meta), 'the suggestions payload carries the turn id');
  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  // The guard rejects any payload whose turn id doesn't EXACTLY match the pinned turn — including when
  // the target is null (an unanswered turn). This is what stops a prior answered turn's late badge from
  // attaching under a later refusal/web-offer row.
  ok(/fr\.turnId == null \|\| fr\.turnId !== faithTargetTurn/.test(chatJs),
    'the Verify badge attaches only on an exact turn-id match (rejects a null/other target)');
  ok(/data\.turnId == null \|\| data\.turnId !== suggestTargetTurn/.test(chatJs),
    'suggestion chips attach only on an exact turn-id match (rejects a null/other target)');
  // pendingTurnId is reset per send, and the target is pinned ONLY when the turn was answered, so an
  // unanswered turn is un-targetable and can't inherit a prior turn's id.
  ok(/pendingTurnId = null;\s*\n\s*pendingAnswerLang = null;\s*\n\s*appendUserMessage/.test(chatJs), 'sendMessage resets pendingTurnId and the pending answer language (no stale value carries into an unanswered turn)');
  ok(/if \(!stopped && pendingTurnId != null\) \{[\s\S]*?faithTargetTurn   = pendingTurnId;[\s\S]*?\} else \{[\s\S]*?faithTargetTurn = null;/.test(chatJs),
    'a terminal event pins the target only on a normally answered turn; an unanswered or stopped turn clears it');

  // ── The web and Deep Research answer paths guard their post-answer tail like the main path (pass 25) ──
  // Both had the same reset race: a reset during the summary await re-saved the cleared conversation.
  const boundaries = {
    runWebAnswer:    ['const runWebAnswer =', 'const runDeepResearch ='],
    runDeepResearch: ['const runDeepResearch =', "client.on('message'"],
  };
  for (const [fn, [from, to]] of Object.entries(boundaries)) {
    const s = src.indexOf(from), e = src.indexOf(to, s + 1);
    ok(s !== -1 && e > s, `${fn} is present`);
    const body = src.slice(s, e);
    // No early `activeAbort = null` before the persistence tail — it stays live so a reset is detected.
    ok(!/activeAbort = null;/.test(body.slice(0, body.indexOf('updateConversationSummary'))),
      `${fn} keeps activeAbort live through its post-answer tail (no early null)`);
    const sumAt   = body.indexOf('await updateConversationSummary');
    const guardAt = body.indexOf('signal.aborted) return;', sumAt);
    const saveAt  = body.indexOf('saveSession(', sumAt);
    ok(sumAt !== -1 && guardAt !== -1 && saveAt !== -1 && guardAt < saveAt,
      `${fn} re-checks abort after the summary await, before saving the session`);
    ok(/\} finally \{[\s\S]*?releaseTurn\(abort[WR]\);/.test(body),
      `${fn} releases the turn in a finally via releaseTurn`);
  }

  // ── Long orchestrators are cancellable so a reset frees the serialized turn queue (pass 29) ──
  // Synthesis (a per-document map-reduce) and Deep Research (multi-round retrieval) run for minutes
  // BEFORE their stream is returned, so the socket's stream-loop abort check can't reach them. Without
  // an abort signal a New/disconnect leaves them grinding to completion, and because turns are
  // serialized the user's next question can't start until they finish. The socket passes its per-turn
  // signal into both, and both check it at their loop boundaries.
  ok(/runWorkspaceSynthesis\(turnWs, focus, onProgress, format, abort\.signal\)/.test(src),
    'the socket passes its abort signal into runWorkspaceSynthesis');
  ok(/deepResearch\(\{[\s\S]*?signal: abortR\.signal,[\s\S]*?\}\)/.test(src),
    'the socket passes its abort signal into deepResearch');
  const apiCore = fs.readFileSync(path.join(PROJECT, 'lib', 'api-core.js'), 'utf-8');
  ok(/const runWorkspaceSynthesis = async \(workspaceId, focus = '', onProgress = null, format = 'overview', signal = null\)/.test(apiCore),
    'runWorkspaceSynthesis accepts an optional abort signal');
  ok(/if \(signal\?\.aborted\) return \{ status: 'aborted' \};/.test(apiCore),
    'the synthesis map loop bails promptly when the signal is aborted');
  const deep = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'deepresearch.js'), 'utf-8');
  ok(/focusDocIds = null, onProgress = \(\) => \{\}, signal = null \}\) =>/.test(deep),
    'deepResearch accepts an optional abort signal');
  ok((deep.match(/if \(signal\?\.aborted\) break;/g) || []).length >= 2 && /if \(signal\?\.aborted\) return \{ stream:/.test(deep),
    'deepResearch checks the signal at its round and sub-question loops and before building the report');

  // ── A landed workspace synthesis gets the same post-answer affordances as every other path (pass 29) ──
  const synthFn = src.slice(src.indexOf('const runWorkspaceSynthesisToChat'), src.indexOf("client.on('web_accept'"));
  ok(/await emitAnswerMeta\(\{ query: userTurn \|\| focus \|\| 'Workspace synthesis'/.test(synthFn),
    'the synthesis path emits the rating/suggestion affordances via emitAnswerMeta');
  ok(/runWorkspaceSynthesisToChat = async \(\{ focus = '', format = 'overview', userTurn = null, flags = \{\} \}/.test(src),
    'runWorkspaceSynthesisToChat accepts affordance flags');
  ok(/runWorkspaceSynthesisToChat\(\{ focus: content, userTurn: content, flags: answerFlags \}\)/.test(src),
    'the auto-synthesis route forwards the turn affordance flags');
  ok(/runWorkspaceSynthesisToChat\(\{ focus, format, flags: \{ outcomesEnabled: payload\.outcomes !== false \} \}\)/.test(src),
    'the Generate button gives synthesis rating buttons by default');

  // ── A mid-rebuild wipe must not report the corpus as empty (pass 25) ──
  ok(/state\.indexReady && !state\.indexing && state\.parentMap\.size === 0/.test(src),
    'the "no documents" gate is suppressed while indexing (a live rebuild shows "building" instead)');

  // ── A reset while a turn is suspended must not let the turn resurrect scratch state (pass 27) ──
  // reset_conversation runs unserialized and clears the context synchronously, but the interrupted
  // turn resumes AFTER the clear and writes its own scratch state (webPages, allowedDocIds, rolling
  // summary, consultedDocs) back onto the just-cleared conversation. The abort guards stop the
  // re-save/re-emit but not that late in-memory write, so every turn's finally re-clears the context
  // when its own controller was aborted — a single choke point that runs after all late writers.
  ok(/const clearIfAborted = \(a\) => \{ if \(a && a\.signal\.aborted\) clearConversationState\(conversationContext\); \};/.test(src),
    'a shared clearIfAborted helper re-clears the conversation when a turn was aborted');
  // The whole release sequence (re-clear on abort, THEN identity-guarded controller release) is centralized
  // in one shared releaseTurn helper, so it cannot drift between handlers.
  ok(/const releaseTurn = \(a\) => \{[\s\S]{0,700}?if \(reason !== ABORT_STOP && reason !== ABORT_CANCEL\) clearIfAborted\(a\);[\s\S]{0,200}?if \(a && activeAbort === a\) activeAbort = null;/.test(src),
    'a shared releaseTurn helper re-clears a reset abort, spares a Stop/Cancel, then releases activeAbort (identity-guarded)');
  // Every turn handler's finally releases through it (main, web, deep-research, synthesis, summarize_document).
  ok((src.match(/releaseTurn\(abort[WR]?\)/g) || []).length >= 5,
    'all five generation finallys release the turn via releaseTurn');

  // ── Every landed non-web answer must clear webPages so "tell me more" isn't hijacked (pass 28) ──
  // The web-continuation gate fires whenever conversationContext.webPages is non-empty and the query
  // is vague, and it runs before the document-continuation logic. So a landed summary, synthesis, or
  // research report must null webPages — exactly as the main document-answer path does — or a follow-up
  // after one of them would silently re-answer from the prior turn's stale web pages (and make a web
  // call), contradicting the just-completed local action.
  ok((src.match(/conversationContext\.webPages = null;/g) || []).length >= 4,
    'the main, summarize, synthesis, and deep-research landed paths all clear webPages');
  // Anchor each of the three non-main paths to its own handler so a future refactor can't drop one.
  for (const [label, from, to] of [
    ['summarize', "client.on('summarize_document'", "client.on("],
    ['synthesis', 'const runWorkspaceSynthesisToChat', "client.on('web_accept'"],
    ['deep research', 'const runDeepResearch =', 'const runWorkspaceSynthesisToChat'],
  ]) {
    const s = src.indexOf(from);
    const e = src.indexOf(to, s + from.length);
    const body = src.slice(s, e > s ? e : undefined);
    ok(s !== -1 && /conversationContext\.webPages = null;/.test(body),
      `the ${label} landed path clears webPages (no stale-web "tell me more" hijack)`);
  }

  // ── summarize_document releases and re-clears in a finally, like the other handlers (pass 28) ──
  const sumStart = src.indexOf("client.on('summarize_document'");
  const sumBody  = src.slice(sumStart, src.indexOf('client.on(', sumStart + 20));
  ok(/\} finally \{[\s\S]*?releaseTurn\(abort\);[\s\S]*?\}/.test(sumBody),
    'summarize_document releases the turn via releaseTurn in a finally on every exit path (incl. the catch)');

  // ── The first-attempt web-offer branch must be guarded against a mid-search reset (pass 27) ──
  // If the user hits New during the first searchDocuments await, the branch that offers a web search
  // must not emit a web_offer chip or re-arm pendingWebQuery into the just-cleared conversation. A
  // single abort check right after searchDocuments returns covers this branch and the stream loop.
  const searchAt = src.indexOf('await searchDocuments(');
  const offerAt  = src.indexOf("client.emit('web_offer'", searchAt);
  const guardAfterSearch = src.indexOf('if (abort.signal.aborted) return;', searchAt);
  ok(searchAt !== -1 && guardAfterSearch !== -1 && guardAfterSearch < offerAt,
    'an abort guard follows the searchDocuments await, before the web-offer branch can emit or re-arm pendingWebQuery');

  // ── Reset epoch: a New during a PRE-CONTROLLER await, or on a QUEUED turn, still discards the turn ──
  // The abort controller doesn't exist until partway into a turn, so for a non-active-workspace turn suspended
  // in the readiness/bundle load (and for a turn still queued on _genChain when New fires) there is no signal to
  // abort. A per-connection reset epoch closes both windows: reset_conversation bumps it; runExclusive captures
  // it at enqueue and skips a superseded queued turn; each pre-controller bundle await re-checks it.
  ok(/let resetEpoch = 0;/.test(src) && /const turnSuperseded = \(\) => turnEpoch !== resetEpoch;/.test(src),
    'a reset epoch + turnSuperseded() helper exist');
  ok(/client\.on\('reset_conversation'[\s\S]{0,500}?resetEpoch\+\+;/.test(src),
    'reset_conversation bumps the reset epoch (supersedes the running + queued turns)');
  ok(/const startEpoch = resetEpoch;/.test(src) && /if \(startEpoch !== resetEpoch\) \{[\s\S]*?return undefined; \}/.test(src),
    'runExclusive captures the epoch at enqueue and discards a turn a New superseded before it started');
  // Each pre-controller bundle await re-checks turnSuperseded (message, research, resolveTurn → summarize).
  const supersedeChecks = (src.match(/if \(turnSuperseded\(\)\) return/g) || []).length;
  ok(supersedeChecks >= 3, `the pre-controller awaits re-check turnSuperseded (found ${supersedeChecks}, expect >= 3: message + research + resolveTurn)`);
  ok(/status: 'superseded'/.test(src) && /turn\.status === 'superseded'\) return;/.test(src),
    'resolveTurn reports superseded and summarize_document discards it quietly');
  // The flood-drop path ends the dropped submit on the client so its spinner clears.
  ok(/_genQueued >= GEN_QUEUE_MAX\)[\s\S]{0,600}?try \{ endChat\(\); \} catch/.test(src),
    'a flood-dropped turn still emits chat_end so the client spinner is not left spinning');
  console.log('✓ reset-safety: the reset epoch discards a superseded pre-controller / queued turn; flood-drop ends the turn');

  console.log(`\nALL RESET-SAFETY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RESET-SAFETY UNIT TEST FAILED:', e.message);
  process.exit(1);
}
