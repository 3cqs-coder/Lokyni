'use strict';
const { DEBUG } = require('./config');
const state = require('./state');
const { searchDocuments, ENDING_INTENT_RE } = require('./retrieval/search');
const { hasCjk } = require('./retrieval/keywords');
const { viewerLink } = require('./links');
const { isVagueContinuation } = require('./retrieval/expand');
const { updateConversationSummary, capHistory } = require('./history');
const { loadSession, saveSession, clearSession, isValidId, leanSources } = require('./sessions');
const { detectLanguage } = require('./langdetect');
const { answerFromWeb, isWebContinuation } = require('./retrieval/webanswer');
const { looksWebAnswerable, looksCurrentInfo } = require('./websearch');
const { clearConversationState } = require('./conversation');
const { TURN_PROTOCOL } = require('./turncontrol');
// The web-search and reranker toggles below are read fresh at call time (inside the
// handlers) rather than destructured here, so changing them in Settings takes effect
// without a restart — reloadConfig() re-requires ./config, and a value captured at
// import would be stale.

// The "still building the index" notice, in ONE place so every emit site stays in sync. When the active embedder
// is the bundled local model and it is still downloading on first run, append its live progress, so the user sees
// WHY indexing is waiting and how far along it is instead of a bare "try again" that looks stuck. Best-effort:
// any trouble falls back to the plain line.
const buildingIndexNotice = () => {
  const base = '⏳ Building the document index — please try again shortly.';
  try {
    const cfg = require('./config');
    if (cfg.EMBEDDINGS_PROVIDER !== 'local') return base;
    const le = require('./retrieval/localembed');
    const { toMB: mb } = require('./modelprogress');   // one bytes→MB source (shared with the progress tracker)
    const d = le.downloadProgress && le.downloadProgress();
    if (d && typeof d.pct === 'number') {
      // Show the MB breakdown only when it is meaningful (≥ 1 MB); a cache-served model reports only tiny files,
      // whose MB round to 0, so "(0 / 0 MB)" would read as broken.
      const detail = d.totalBytes >= 1024 * 1024 ? `, ${mb(d.bytes)} / ${mb(d.totalBytes)} MB` : '';
      return `⏳ Building the document index — downloading the embedding model (${d.pct}%${detail}, one time). Please try again shortly.`;
    }
    if (d && Number(d.bytes) > 0) {   // host sent no total — show bytes so far so it never looks stuck
      return `⏳ Building the document index — downloading the embedding model (${mb(d.bytes)} MB so far, one time). Please try again shortly.`;
    }
    if (le.lastDownloadError && le.lastDownloadError()) {
      return '⏳ Building the document index — the embedding model download didn’t finish (check the connection to the model host). It will retry; please try again shortly.';
    }
  } catch (_) { /* fall back to the plain notice */ }
  return base;
};

// When an answer fails because the LANGUAGE-MODEL PROVIDER is unreachable (Ollama not running, a wrong host, a
// bad/absent API key), emit the clear, actionable "no language model connected" chat message and return true;
// otherwise return false so the caller shows its own generic notice. One place, so every answer path (document
// answer, workspace synthesis, web, deep research) gives the user the SAME guidance for a missing model — and it
// reminds them that search still works, only the written answer needs a model. Best-effort; never throws.
const emitProviderDownIfApplicable = (client, error) => {
  try {
    const llm = require('./llm');
    if (llm.isProviderConnectionError(error)) {
      client.emit('message', llm.providerUnreachableMessage(require('./config')));
      return true;
    }
  } catch (_) { /* fall back to the caller's generic message */ }
  return false;
};

// Decide whether a failed, web-answerable query should offer a web search based on
// the best reranker score. When the reranker is on, only offer if no document was a
// genuine match (score ≤ threshold). When it's off, there's no score to gate on, so
// fall through to the heuristic (offer proceeds). null/undefined score = no match
// found = offer.
const webOfferRerankerOk = (score) => {
  const { USE_RERANKER, webOfferMaxRerankerScore } = require('./config');
  if (!USE_RERANKER) return true;         // no reranker signal available
  if (score === null || score === undefined) return true; // nothing matched at all
  return score <= webOfferMaxRerankerScore;
};
// Whether to offer a web search for a failed / miss query. Normally gated on the
// reranker score — don't offer if a document genuinely matched. But a "live" question
// (today's price, current weather, the latest release) cannot be answered by ANY
// static document, even one that reranks positively because it shares the topic. A
// strong current-info signal therefore bypasses the reranker gate, so e.g. "what is
// the current price of Bitcoin today?" offers a web search instead of burning three
// retries against a trading PDF and then flatly refusing.
const webOfferGateOk = (query, score) => looksCurrentInfo(query) || webOfferRerankerOk(score);
const fmtScore = (s) => (typeof s === 'number' ? s.toFixed(2) : 'n/a');

const NO_INFO_PATTERNS = [
  /i don.t have (that |this )?(information|info)/i,
  /not (found|available|present|mentioned|covered|stated|discussed) in (the |my |these )?documents?/i,
  /i can only answer questions (about|based on)/i,
  /that falls outside what i can help with/i,
  /no (relevant |useful )?(information|content|data) (found|available)/i,
];

const DEGENERATE_RE = /^(unfortunately|sorry|apologies|i am sorry|i'm sorry|i'm unable|i cannot)[,.\s]*$/i;
// Degenerate non-answers: a bare 1-4 char fragment ("It", "The", "Let", "No") or a
// lone hedging opener with no content. These usually mean the grounding rules were
// truncated out of the context window, so retry (the context-budget cap in
// buildMessages prevents this in the first place; this is the safety net).
const isDegenerate = (text) => {
  const t = (text || '').trim();
  if (DEGENERATE_RE.test(t)) return true;
  // Only a bare 1-2 char fragment is a degenerate non-answer. Legitimately-short factual
  // answers must never be flagged and retried: a proper noun ("Rome", "Ohio", "Cuba"), a
  // short common word ("red", "iron"), plain yes/no, or anything numeric/currency ("12",
  // "$5", "1999", "Q3") is a real answer to "where?" / "how many?" / "what year?". A spaceless
  // script (CJK) packs a COMPLETE word into one or two characters ("北京" = Beijing, "鉄" = iron),
  // so a short answer containing such a character is a real answer, never a truncated fragment —
  // exempt it too, keeping this heuristic language-agnostic rather than Latin-only.
  if (t.length < 3 && !/^(yes|no)\b/i.test(t) && !/[0-9]/.test(t) && !/^[$£€]/.test(t) && !hasCjk(t)) return true;
  return false;
};
// A response is a "failed" answer if it's degenerate, or essentially just a "no
// information" refusal. Crucially, a long substantive answer that merely CONTAINS a
// phrase like "…not mentioned in the documents" as one qualifying clause is NOT a
// failure — matching the pattern anywhere used to discard good answers and retry them.
const isFailedResponse = (text) => {
  const t = (text || '').trim();
  if (isDegenerate(t)) return true;
  if (!NO_INFO_PATTERNS.some(p => p.test(t))) return false;
  // Only a failure when the refusal dominates: a short response, or one that opens
  // with the refusal phrase.
  return t.length <= 200 || NO_INFO_PATTERNS.some(p => p.test(t.slice(0, 120)));
};

// Held so background work (indexing) can push notices to every connected client.
// Without this an indexing failure is invisible in the UI — it only reaches the log
// file, which is exactly the wrong place when Lokyni runs as a background service.
let _io = null;
// Workspace-aware broadcast. A payload carrying a `workspaceId` is sent ONLY to connected sockets whose
// principal may access that workspace — so a workspace-scoped event (e.g. an automation result, which carries
// answer content derived from that workspace's documents) can never reach a user who isn't a member of it.
// Each socket stashes its live `canUseWorkspace` check at connect (it re-reads membership, so a mid-connection
// membership change is honored). A payload with no workspaceId is a global/operational event and goes to all.
const broadcast = (event, payload) => {
  try {
    if (!_io) return;
    const wsId = payload && payload.workspaceId;
    if (!wsId) { _io.emit(event, payload); return; }
    for (const [, sock] of _io.sockets.sockets) {
      try {
        const canUse = sock.data && sock.data.canUseWorkspace;
        // No checker stashed yet (socket mid-handshake) → omit, rather than risk leaking to an unresolved
        // principal. Owner/single-user principals' check returns true for every workspace, so they still see all.
        if (canUse && canUse(wsId)) sock.emit(event, payload);
      } catch { /* skip a socket that errors */ }
    }
  } catch {}
};

const initSocket = (server) => {
  const io = require('socket.io')(server, {
    cors: { origin: false },
    // The chat socket carries private document content, so the handshake gets the SAME two guards
    // as the Express control plane, applied here because socket.io attaches to the raw HTTP server
    // and handles /ws BEFORE any Express middleware runs:
    //   1. isAllowedHost — the DNS-rebinding defense (a page on evil.com whose DNS is flipped to
    //      127.0.0.1 reaches the loopback server with a loopback Host).
    //   2. isSameOriginRequest — the cross-site-WebSocket-hijacking defense. Browsers do NOT apply
    //      the same-origin policy to WebSocket connections and ignore CORS on them, so without an
    //      Origin/Sec-Fetch-Site check any site the user has open could open ws://127.0.0.1/ws
    //      (a legitimate loopback Host, no rebinding needed) and read the documents. CORS does not
    //      stop this; only the explicit Origin check does. Both live in lib/hostguard.js so the
    //      HTTP and socket paths can never drift.
    allowRequest: (req, cb) => {
      const hg = require('./hostguard');
      const h = req.headers || {};
      if (!(hg.isAllowedHost(h.host) && hg.isSameOriginRequest(h))) return cb('origin not allowed', false);
      // Multi-user gate (same seam as the HTTP control plane): with no accounts, the implicit owner is
      // allowed (unchanged single-user behavior); once an account exists, the chat socket — which streams
      // private document content — requires a signed-in user. The resolved principal is stashed on the
      // handshake request so the connection handler can scope turns to the user's workspaces.
      const DATA_DIR = require('./config').DATA_DIR;
      const usersStore = require('./users');
      const principalMod = require('./principal');
      if (usersStore.isEmpty(DATA_DIR)) { req._principal = principalMod.ownerPrincipal(); return cb(null, true); }
      principalMod.fromRequest(DATA_DIR, req)
        .then((p) => { if (p && p.kind !== 'anonymous') { req._principal = p; cb(null, true); } else cb('authentication required', false); })
        .catch(() => cb('authentication required', false));
    },
    path: '/ws',
    serveClient: true,
    // Indexing or answering over a very large document can briefly peg the event loop (a big native
    // FAISS add, a garbage-collection pause after a large re-index). With the default 20s heartbeat
    // timeout, such a stall drops the client mid-answer and the in-flight turn is lost. This is a
    // local, single-user tool, so a genuinely dead connection taking a little longer to detect costs
    // nothing, while surviving a heavy-work stall matters a lot — so give the heartbeat more slack.
    pingInterval: 25000,
    pingTimeout: 60000,
    // Bound the inbound frame explicitly rather than inheriting socket.io's default. A `message` payload carries
    // the query plus any pasted attachment text and is JSON.parsed synchronously on the event loop, so an
    // oversized frame is both a memory and a latency vector. 8 MB leaves ample room for a large pasted document
    // while keeping the cap intentional and visible (a future larger-attachments feature must raise it knowingly).
    maxHttpBufferSize: 8 * 1024 * 1024,
  });
  _io = io;

  io.on('connect', (client) => {
    if (DEBUG) console.log('New client connected:', client.handshake.address);

    // The signed-in identity for this connection (set by allowRequest from the handshake cookie). Used to
    // scope each turn to workspaces the user may use. The implicit owner / global admin may use any workspace.
    const principal = (client.request && client.request._principal) || null;
    // Namespace this connection's persisted conversation sessions by the signed-in identity, so a session id
    // (client-supplied) can only ever address THIS principal's own session files — never another user's.
    const sessPrincipalKey = require('./principal').principalKey(principal);
    // Gate a turn on a workspace AND the capability the operation needs. `capability` defaults to the minimum
    // every data-plane turn requires (query.run / chat); summarize and synthesize pass 'doc.read'. For a human
    // member any workspace role already grants query.run + doc.read (the viewer bundle), so membership is the
    // check there. The apikey branch is belt-and-suspenders: in practice an API key cannot authenticate on the
    // socket at all — the handshake resolves a principal only from the session cookie, and extractKey needs an
    // Express req.get() that the raw upgrade request lacks, so a key yields anonymous and is rejected at connect.
    // It is kept so that IF a future change ever accepts a key on the socket, the SAME authz.can scope + allow-
    // list gate the HTTP API and MCP apply is enforced here too, never a bypass.
    const mayUseWorkspace = (wsId, capability = 'query.run') => {
      if (!principal || principal.kind === 'owner') return true;
      if (principal.kind === 'user') {
        // Re-validate the account live on every turn so disabling or deleting a user, or changing their
        // workspace roles, revokes an already-open socket on its next turn. The HTTP plane re-resolves the
        // principal on every request, but a socket captures it once at connect; both the user store and the
        // membership store are mtime-cached, so this is just a cheap stat unless something actually changed.
        try {
          const dir = require('./config').DATA_DIR;
          const u = require('./users').getById(dir, principal.userId);
          if (!u || u.status !== 'active') return false;
          if (u.role === 'admin') return true;
          return require('./members').rolesForUser(dir, principal.userId).has(wsId);
        } catch { return false; }
      }
      if (principal.kind === 'apikey') return require('./authz').can(principal, capability, { workspaceId: wsId });
      return false;
    };
    // Expose the live access check to the module-level broadcast() so a workspace-scoped event is delivered only
    // to sockets whose principal may access that workspace (see broadcast above). Stored per socket.
    client.data = client.data || {};
    client.data.canUseWorkspace = (wsId) => { try { return mayUseWorkspace(wsId); } catch { return false; } };

    let conversationContext = { history: [], allowedDocIds: null, docReadPos: new Map() };
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 2;
    let activeAbort = null; // AbortController for the current stream
    // Controllers for POST-ANSWER background work (the opt-in self-consistency re-generations) that outlives the
    // turn's own release. The turn's finally nulls activeAbort, so without tracking these a later New / Stop /
    // disconnect could not cancel those extra model generations — they would run on against a cleared or
    // gone conversation. Each is added while the background work runs and removed when it settles.
    const bgAborts = new Set();
    const abortBackgroundJobs = () => { for (const ac of bgAborts) { try { ac.abort(); } catch { /* best-effort */ } } bgAborts.clear(); };
    // Reset generation. reset_conversation (New) bumps resetEpoch. A turn captures the epoch when it is queued
    // (runExclusive) into turnEpoch; if they ever differ, a New has superseded this turn and it must discard
    // itself. This closes two windows the activeAbort alone can't: a turn still QUEUED when New fires (its
    // controller doesn't exist yet), and a running turn suspended in the pre-controller readiness/bundle await
    // (there is no signal for reset to abort). Without it a New during either window is lost and the turn
    // resurrects the just-cleared conversation (re-emits, re-pushes history, re-saves the deleted session).
    let resetEpoch = 0;
    let turnEpoch = 0;
    const turnSuperseded = () => turnEpoch !== resetEpoch;
    // User-stop generation. `chat_stop` bumps stopEpoch and aborts the running controller, so a turn
    // queued before the click is discarded (it never starts) and a running one unwinds promptly. The
    // controller that was actually aborted is tagged in abortReason so releaseTurn can tell a
    // user stop (which still owes the browser one terminal event) from a New/disconnect (which does
    // not). A WeakMap keeps no reference to a finished controller.
    let stopEpoch = 0;
    let stopPending = false;          // a stop landed while the active turn had no controller yet
    // Why a controller was aborted, when it was not a New/disconnect. A user Stop keeps the conversation
    // and owes the browser `chat_stopped`; an explicit Cancel (the extraction panel) keeps the conversation
    // and ends silently. A New/disconnect has no entry and clears the turn's scratch state, as before.
    const ABORT_STOP = 'stop', ABORT_CANCEL = 'cancel';
    const abortReason = new WeakMap();
    // Create the controller a generating handler will use and register it as the active turn's.
    // If a Stop arrived while the handler was still awaiting (before this point), the new controller is
    // aborted immediately — so the stop cannot be lost in that window. Every generating path creates
    // its controller through here, which keeps that behavior in one place.
    const beginTurnAbort = () => {
      const a = new AbortController();
      activeAbort = a;
      if (stopPending) {
        stopPending = false;
        abortReason.set(a, ABORT_STOP);
        try { a.abort(); } catch { /* best-effort */ }
      }
      return a;
    };
    let sessionId = null;   // set when the client restores/attaches a session
    let turnSeq = 0;        // monotonic per-connection answer counter — tags post-answer meta so a
                            // late result attaches to the RIGHT turn even across two identical queries
    let pendingWebQuery = null; // query awaiting a "yes, search the web" confirmation
    let pendingWebFlags = null; // the answer toggles in force when the web offer was made
    let pendingWebWs = null;    // the workspace the offer was made from, so a later accept records into it

    // Serialize the per-connection generation handlers so two never run at once for one
    // socket — a double-submit, a custom client, or a doc-panel action fired mid-stream —
    // which would otherwise interleave streams and corrupt the shared history and abort
    // state. Each queued call runs after the previous settles; a throw never breaks the
    // chain (every handler also try/catches internally), and the UI's input-disabling
    // already makes queuing the rare exception rather than the rule.
    let _genChain = Promise.resolve();
    let _genQueued = 0;
    // Hard cap on how many generations may be queued at once for ONE connection. The UI disables input while
    // a turn runs, so a real user never stacks more than a turn plus maybe a doc-panel action; anything deeper
    // is a double-submit storm or a misbehaving/custom client. Without a cap, each queued call appends a
    // closure that retains its message payload to the per-connection promise chain, so a client that emits
    // faster than generation drains grows memory unbounded. Beyond the cap the overflow is dropped (the chain
    // is never extended), so memory stays bounded regardless of client behavior.
    const GEN_QUEUE_MAX = 8;
    // `stoppable` is false for background plumbing that is not a chat turn (session restore, a panel
    // action with its own Cancel). A Stop click must never discard those.
    const runExclusive = (fn, { stoppable = true } = {}) => {
      if (_genQueued >= GEN_QUEUE_MAX) {
        if (DEBUG) console.log(`  ⛔ Dropping a queued generation — connection already has ${_genQueued} in flight (flood guard)`);
        // End this submit's turn on the client so its "generating" spinner clears, rather than leaving it
        // stuck forever waiting for a chat_end that the dropped turn will never send.
        try { endChat(); } catch { /* best-effort */ }
        return;
      }
      _genQueued++;
      const startEpoch = resetEpoch;   // the reset generation at the moment this turn was QUEUED
      const startStopEpoch = stopEpoch; // the stop generation at the moment this turn was QUEUED
      _genChain = _genChain.then(async () => {
        if (!client.connected) return undefined;
        // A New (reset_conversation) landed after this turn was queued but before it started — discard it, or it
        // would run on and persist a conversation the user asked to clear.
        if (startEpoch !== resetEpoch) { try { endChat(); } catch {} return undefined; }
        // A Stop landed after this turn was queued but before it started. Tell the browser the turn is
        // over (so its Stop state clears) without running any of its work. Anything queued after the
        // stop captured the newer epoch and is unaffected.
        if (stoppable && startStopEpoch !== stopEpoch) {
          try { client.emit(TURN_PROTOCOL.stopped); } catch {}
          return undefined;
        }
        // This turn owns the current stop generation. Clear a stop that was aimed at the previous turn
        // so it cannot leak into this one (turns are serialized, so the previous one has finished).
        stopPending = false;
        turnEpoch = startEpoch;   // this running turn's epoch, for the pre-controller re-checks (turnSuperseded)
        // Track in-flight generation/search so the desktop shell can warn before quitting
        // rather than killing the server mid-answer. Counted here because every generating
        // handler runs through this serializer. Always balanced in the finally, so an error
        // can never leave the count stuck above zero.
        state.activeQueries++;
        try { return await fn(); }
        finally { state.activeQueries = Math.max(0, state.activeQueries - 1); }
      }).catch(() => {}).finally(() => { _genQueued = Math.max(0, _genQueued - 1); });
    };

    // Emit the affordances that hang off a completed answer — the rating buttons (outcome
    // capture, "Learn"), the "Why this answer?" retrieval trace ("Explain"), and the
    // faithfulness badge ("Verify") — for whichever toggles are on. Shared by the document,
    // web, and research answer paths so every landed answer offers the same controls,
    // rather than each path re-emitting them: the web and research paths previously emitted
    // none, so their answers silently lost ratings, the trace, and Verify. `trace` is null
    // for paths that have no single retrieval decision (web, research). Best-effort — a
    // failure here must never break answering.
    // Attach the independence summary to restored answers too, so a reload does not silently drop the
    // "N sources · M independent" hint. The stored history is copied, never mutated (it is sent to the model).
    const withSourceStats = (history) => {
      if (!Array.isArray(history)) return history;
      return history.map((m) => {
        if (!m || !Array.isArray(m.sources) || m.sources.length < 2) return m;
        try {
          const stats = require('./sourceindependence').statsFor(m.sources);
          return stats ? { ...m, sourceStats: stats } : m;
        } catch { return m; }
      });
    };
    const emitAnswerMeta = async ({ query, answer, sources, trace, topReranker, crossLingual, failed, flags, idx, getMessages, signal, abortController }) => {
      const f = flags || {};
      // The index THIS turn answered from. For a window viewing a non-active workspace it is that
      // workspace's loaded bundle, not the global active one; the faithfulness and numeric-grounding checks
      // resolve each cited source's text from it, so passing it is what makes those checks run off the
      // active workspace at all (its source ids are not in the active corpus). Omitted → the active state.
      const metaIdx = idx || undefined;
      const src = Array.isArray(sources) ? sources : [];
      // One monotonic id per answered turn. The client pins it to this answer's row at chat_end and
      // matches the late (fire-and-forget) faithfulness/suggestion payloads on it, so two identical
      // consecutive queries can never cross-attach a badge (query text alone couldn't tell them apart).
      const turnId = ++turnSeq;
      // Tag the turn with the answer's language (falling back to the question's only for a landed answer) so the
      // client can route Read aloud to the matching voice: the bundled local model for English, a system voice
      // otherwise. A failed/refusal turn must not inherit the question's language. Fail-open: '' means "use the
      // configured read-aloud language".
      const language = detectLanguage(answer) || (failed ? '' : detectLanguage(query)) || '';
      const sourceStats = src.length > 1 ? require('./sourceindependence').statsFor(src) : null;
      client.emit('answer_turn', { turnId, language, ...(sourceStats ? { sourceStats } : {}) });
      try {
        if (f.outcomesEnabled && !failed) {
          const outcomes = require('./outcomes');
          const docIds = src.map(s => s.id).filter(Boolean);
          // Record into the workspace THIS turn targeted (wsCacheDir()), so a window viewing a non-active
          // workspace builds that workspace's learning, not the active one's. undefined = active (default).
          const outcomeId = outcomes.record(wsCacheDir(), {
            workspace: turnWs || null,
            query, docIds, topReranker: typeof topReranker === 'number' ? topReranker : null,
          });
          if (outcomeId) client.emit('outcome_id', { messageId: outcomeId });
        }
      } catch (e) { /* capture is best-effort */ }
      if (f.explainTrace && trace) client.emit('retrieval_trace', trace);
      // The faithfulness / numeric-grounding checks resolve each cited source's text from `metaIdx`, which is now
      // always an immutable index snapshot of this turn's workspace (see snapshotActiveIndex) — so a workspace
      // switch between the answer and this fire-and-forget check can no longer swap the corpus under it. The only
      // remaining stale case is when there is no index to resolve against (metaIdx absent) for a non-active turn;
      // the answer already streamed from the correct corpus, so only the badge is withheld there.
      const metaStale = !metaIdx && turnWs && turnWs !== state.workspaceId;
      // Answer confidence — one holistic high/medium/low verdict, blended from signals already computed: the
      // faithfulness verdict when Verify is on, else retrieval strength; the numeric-grounding figures; and,
      // for a confidently-English answer ONLY, a wording-vs-evidence check (certainty markers are language-
      // specific, so it never runs — and never misflags — on another language). Free on its own (no model
      // call), best-effort, fire-and-forget. The self-consistency signal, when on, arrives via its own later
      // event and updates the chip. `fr` is the faithfulness result (may be null → the reranker band is used).
      const emitConfidence = (fr) => {
        try {
          const cfg = require('./config');
          if (!cfg.showAnswerConfidence) return;
          const conf = require('./confidence');
          const base = conf.assess({ faithfulness: fr, topReranker, crossLingual });
          if (!base) return;   // no usable signal → no chip
          let overconfident = null;
          try {
            if (!require('./langdetect').isLikelyNonEnglish(answer)) {
              overconfident = require('./confidencewording').check(answer, { belowBar: base.level !== 'high' });
            }
          } catch { /* wording is best-effort */ }
          const emit = (semanticEntropy) => {
            const result = conf.assess({ faithfulness: fr, topReranker, crossLingual, overconfident, semanticEntropy, abstainEnabled: cfg.abstainOnWeakEvidence });
            if (result && client.connected) client.emit('answer_confidence', { query, turnId, ...result });
          };
          emit(null);   // show the chip now, from the signals already in hand
          // Opt-in self-consistency: re-ask the identical prompt a few times, cluster the replies by meaning,
          // and re-emit an updated (lower) chip if the answer proves unstable. Fire-and-forget — it runs after
          // the answer already streamed, never blocking it. The primary answer is reused as the first sample,
          // so this costs (samples - 1) extra generations, and only when the operator turned it on.
          if (cfg.useSemanticEntropy && typeof getMessages === 'function' && !(signal && signal.aborted)) {
            const messages = getMessages();
            if (Array.isArray(messages) && messages.length) {
              const { completeChat } = require('./llm');
              const embeddings = require('./embeddings').makeEmbeddings();
              const { embedBounded } = require('./embeddings');
              let first = true;
              const generate = () => {
                if (first) { first = false; return Promise.resolve(answer); }   // reuse the real answer as sample 1
                // Pass the turn's abort signal so a New/disconnect/Stop cancels the extra generations promptly
                // instead of orphaning (samples - 1) full completions that run server-side with nowhere to land.
                return completeChat(messages, { temperature: 0.5, maxTokens: cfg.MAX_TOKENS, signal });   // probe temperature so stability is actually tested
              };
              const embed = (text) => embedBounded(embeddings.embedQuery(text));
              // Keep this turn's controller reachable while the (fire-and-forget) extra generations run, so a
              // later New / Stop / disconnect can abort them — the turn's own finally has already nulled
              // activeAbort by the time this runs. Removed when the pass settles.
              if (abortController) bgAborts.add(abortController);
              Promise.resolve(require('./semanticentropy').assess({ generate, embed, samples: cfg.semanticEntropySamples }))
                .then((se) => { if (se && se.unstable && !(signal && signal.aborted)) emit(se); })   // only re-emit when it actually moves the verdict and the turn is still live
                .catch((e) => { if (DEBUG) console.log(`  🎯 Self-consistency failed: ${e.message}`); })
                .finally(() => { if (abortController) bgAborts.delete(abortController); });
            }
          }
        } catch (e) { if (DEBUG) console.log(`  🎯 Confidence emit failed: ${e.message}`); }
      };
      if (!failed && src.length > 0 && !metaStale) {
        if (f.checkFaithfulness) {
          // Verify is ON — run the FULL pass (the LLM claim judge plus numeric grounding). It uses the
          // main chat model and can take several seconds, so fire-and-forget, exactly like the
          // suggested-questions call below: awaiting it here would keep the turn — and the UI's
          // "generating" state — blocked after the answer had already fully streamed. The result is
          // emitted on its own event tagged with the turn id, so a late result attaches to the right answer.
          Promise.resolve(require('./faithfulness').scoreAnswer(answer, src, metaIdx, query))
            .then((fr) => { if (fr && client.connected) client.emit('faithfulness', { query, turnId, ...fr }); emitConfidence(fr); })
            .catch((e) => { if (DEBUG) console.log(`  🔎 Faithfulness emit failed: ${e.message}`); });
        } else {
          // Verify is OFF — still run the CHEAP, deterministic numeric-grounding check on every document
          // answer. It makes no model call (so it adds no latency and cannot block), and it stays quiet
          // unless it finds a number the sources don't contain, in which case it surfaces the same badge.
          // Catching an invented figure is high value and free, so it should not require a toggle.
          try {
            const fr = require('./faithfulness').checkFigures(answer, src, metaIdx);
            if (fr && client.connected) client.emit('faithfulness', { query, turnId, ...fr });
            emitConfidence(fr);
          } catch (e) { if (DEBUG) console.log(`  🔢 Numeric grounding emit failed: ${e.message}`); }
        }
      }
      // Suggested follow-up questions — proposed AFTER the answer, fire-and-forget so the
      // (small) extra LLM call never delays this turn or the next. The chips arrive on their
      // own event, tagged with the query so a late result attaches to the right answer.
      if (f.suggestQuestions && !failed && (answer || '').trim()) {
        Promise.resolve(require('./suggest').suggestQuestions({ query, answer, sources: src }))
          .then((questions) => {
            if (questions && questions.length && client.connected) {
              client.emit('suggested_questions', { query, turnId, questions });
            }
          })
          .catch(() => { /* suggestions are best-effort */ });
      }
    };

    // Run the always-on deterministic verification pass (lib/verify) over a completed answer:
    // strip exfil vectors, correct a stated arithmetic slip, and decline a system-prompt leak.
    // Returns the finalized text (stored in history and used for the meta pass) and, if it
    // changed, tells the client to swap the streamed text for it. Best-effort — never throws.
    const finalizeAnswer = (answer) => {
      const finalText = require('./verify').finalize(answer);
      if (finalText !== answer) client.emit('answer_final', finalText);
      return finalText;
    };

    const resetContext = (reason) => {
      // Clears history, allowed docs, rolling summary, consulted docs, and all
      // passage-tracking maps via the shared helper — the same reset a topic shift
      // now performs, so "New" and an in-search shift can't drift apart.
      clearConversationState(conversationContext);
      pendingWebQuery = null;
      pendingWebWs = null;
      pendingWebFlags = null;   // clear alongside the other pending-web fields so a stale toggle set can't leak into a later accepted search
      consecutiveFailures = 0;
      if (DEBUG) console.log(`🔄 Context reset: ${reason}`);
    };

    // A reset (New) runs unserialized so it can interrupt a turn, but the interrupted turn is
    // usually suspended at an await — inside searchDocuments, answerFromWeb, or the summary — and
    // resumes AFTER the reset's synchronous clear to write its own scratch state (web pages, allowed
    // docs, rolling summary, consulted docs) back onto the just-cleared conversation. The per-turn
    // abort guards stop the re-save and re-emit, but not that late in-memory write, so a stale web
    // page set could then feed a "tell me more" in a supposedly fresh conversation. Every turn's
    // finally therefore re-clears the context when its own controller was aborted: a single choke
    // point that runs after all late writers, is idempotent with the reset's own clear, and is
    // harmless on disconnect (the per-connection context is discarded regardless).
    const clearIfAborted = (a) => { if (a && a.signal.aborted) clearConversationState(conversationContext); };
    // Release a finished turn's abort controller on every exit path: first drop any scratch state a mid-turn
    // reset wrote after the clear (clearIfAborted), then clear activeAbort only if it is still THIS turn's — a
    // reset, or a newer turn, may have replaced or cleared it. Shared by every generation handler's finally so
    // the release logic can never drift between them.
    //
    // A USER STOP is different from a New. New clears the conversation itself, so the abort only needs to
    // discard leftover scratch state. A Stop keeps the conversation and only ends this turn, so clearing it
    // would wipe the whole thread. It also owes the browser one terminal event, emitted here (after the
    // handler has unwound) so a chunk the handler already wrote still lands first. Exactly one terminal
    // event per turn: the aborted handler returns without calling endChat.
    const releaseTurn = (a) => {
      const reason = a ? abortReason.get(a) : null;
      if (a) abortReason.delete(a);
      // A Stop or a panel Cancel ends only this action; clearing would wipe the live conversation. A
      // New/disconnect (no reason) still drops any scratch state its abort left behind.
      if (reason !== ABORT_STOP && reason !== ABORT_CANCEL) clearIfAborted(a);
      if (a && activeAbort === a) activeAbort = null;
      if (reason === ABORT_STOP) { try { client.emit(TURN_PROTOCOL.stopped); } catch { /* client went away */ } }
    };
    // Normalize a socket event payload: a client may send a JSON string or an already-parsed object. Throws on
    // malformed JSON, which the caller's try/catch turns into a user-facing error — shared so every handler
    // parses payloads identically.
    const parsePayload = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : (raw || {}));
    // Resolve the workspace a turn runs against from the client payload: the requested workspace only if it
    // actually EXISTS (a spoofed or stale valid-format id falls back to the active one, never creating an
    // orphan directory), else the connection's active workspace. Shared by every turn entry point.
    const resolveTurnWs = (parsed) => (parsed && parsed.workspaceId && require('./workspaces').exists(require('./config').DATA_DIR, parsed.workspaceId)) ? parsed.workspaceId : state.workspaceId;

    // Stream control signals travel on their OWN events, never inside the 'message'
    // stream. Earlier these were in-band sentinels ('END_OF_CHAT', '\x00RETRY') sent as
    // message chunks — which meant a document (or an answer quoting one) that contained
    // the literal text could prematurely end or blank the chat. Out-of-band events can't
    // be spoofed by content, so any text at all is safe to stream.
    const endChat   = (language) => client.emit(TURN_PROTOCOL.end, language ? { language } : undefined);
    const retryChat = () => client.emit('chat_retry');
    // Stall attribution: one tracker per turn (or per web/research job) that names the stage a long silence is
    // stuck in. It emits `turn_stall` once per stretch and logs the stage, so a slow turn is attributable to
    // the model, retrieval, or a web fetch without waiting for a failure. See lib/stallwatch.js.
    const turnStallHolder = { current: null };
    const newTurnStall = () => require('./stallwatch').create({
      onStall: ({ stage, elapsedMs }) => {
        try { console.warn(`⏳ A turn has been waiting in "${stage}" for ${Math.round(elapsedMs / 1000)}s`); } catch { /* logging is best-effort */ }
        try { client.emit('turn_stall', { stage, elapsedMs }); } catch { /* client gone */ }
      },
    });

    // ── Per-connection (per-window) workspace ────────────────────────────────────────────────────
    // Each window can view a DIFFERENT workspace at once. The server keeps the ACTIVE workspace's index
    // live in global state; any OTHER workspace a window asks for is served from a loaded bundle (the same
    // per-workspace bundle machinery the HTTP/MCP API uses), so a window's question is always answered
    // from the corpus it is viewing, never whichever workspace happens to be active. `turnWs` is the
    // workspace the current turn targets; turns are serialized per connection by runExclusive, so a single
    // turn-scoped value is safe. It defaults to the active workspace, so a window on the active workspace
    // (the common case) behaves exactly as before.
    let turnWs = state.workspaceId;
    // The cache dir for this turn's workspace — for per-workspace learning (outcomes/ratings). Returns
    // undefined for the active workspace so those stores resolve their default (active) path, unchanged.
    const wsCacheDir = () => (turnWs === state.workspaceId
      ? undefined
      : require('./workspaces').cacheDirFor(require('./config').DATA_DIR, turnWs));
    // Resolve the workspace + query-ready index for this turn from what the client says it is viewing.
    // Returns { idx, isActive, status }: 'ready' with a usable idx, or 'warming' when a non-active
    // workspace is still loading (the caller tells the user to retry). Sets turnWs as a side effect.
    // An IMMUTABLE snapshot of the ACTIVE workspace's query-ready index, for the lifetime of one turn. The global
    // active index (`state`) can be swapped out from under an in-flight turn by another user's workspace switch:
    // doSwitchWorkspace drains in-flight turns only for a bounded window, then REASSIGNS state's index fields
    // (parentMap, liveVectorStore, …) to the new workspace's. A turn that read `state` directly could then surface
    // another workspace's documents to a user who is not a member of it. Taking a snapshot copies the field
    // REFERENCES (not the maps), so the turn keeps reading the workspace it started on even after a switch — the
    // old index objects stay alive (GC-referenced by the snapshot) until the turn ends. Non-active turns already
    // run on an immutable per-workspace bundle; this gives active turns the same isolation. bundleOf is the one
    // definition of "the index fields," so this can't drift from the bundle/state shape.
    const snapshotActiveIndex = () => require('./indexing/bundle').bundleOf(state);
    const resolveTurn = async (parsed, capability = 'query.run') => {
      // Require an EXISTING workspace, not just a valid-format id, so a spoofed slug falls back to the
      // active workspace rather than creating an orphan directory + background load via ensureWorkspace.
      const req = resolveTurnWs(parsed);
      turnWs = req;
      if (!mayUseWorkspace(req, capability)) return { idx: null, isActive: false, status: 'forbidden' };
      if (req === state.workspaceId) return { idx: snapshotActiveIndex(), isActive: true, status: 'ready' };
      const acq = await require('./indexing/bundle').getBundleNonBlocking(req);
      // A New (reset) during the load supersedes this turn (its AbortController doesn't exist yet) — report it
      // so the caller discards the turn instead of answering into the just-cleared conversation.
      if (turnSuperseded()) return { idx: null, isActive: false, status: 'superseded' };
      if (acq.status === 'warming') return { idx: null, isActive: false, status: 'warming' };
      return { idx: acq.bundle, isActive: false, status: 'ready' };
    };

    // Run a web-grounded answer for `q`, streaming it and recording the turn. Shared
    // by the explicit 🌐 toggle and the accepted auto-suggest offer.
    const runWebAnswer = async (q, flags = {}) => {
      // Attribute a long web turn to the fetch/reading stage. Reuses the message turn's tracker when this was
      // reached from that turn; an accepted web offer runs on its own, so it creates and stops its own.
      const ownStall = !turnStallHolder.current;
      const stall = turnStallHolder.current || newTurnStall();
      if (ownStall) stall.start('the web');
      const abortW = beginTurnAbort();
      try {
        if (abortW.signal.aborted) return;   // a Stop landed before this turn's controller existed
        // Pass the turn's abort signal so a New/disconnect cancels the search + page fetches promptly
        // and frees the serialized turn queue, instead of leaving them to run out their timeouts.
        stall.note('Searching the web…');
        const result = await answerFromWeb(q, conversationContext, abortW.signal);
        let webText = '';
        for await (const chunk of result.stream) {
          if (abortW.signal.aborted) break;
          webText += chunk;
          client.emit('message', chunk);
          stall.note();
        }
        if (abortW.signal.aborted) return;   // finally releases activeAbort
        const landed = !result.outOfScope && !!webText.trim();
        if (landed) {
          webText = finalizeAnswer(webText);
          conversationContext.history.push(
            { role: 'user', content: q },
            // Sources ride along with the turn they belong to, so a restored
            // conversation can show its citations rather than losing them. They're
            // stripped before the history reaches the LLM (see buildMessages callers).
            { role: 'assistant', content: webText, sources: leanSources(result.sources) }
          );
          await updateConversationSummary(conversationContext, abortW.signal);
          // A reset during the (seconds-long) summary await must not re-save the just-cleared
          // conversation or leak sources/meta/chat_end into the cleared UI — mirror the main path.
          if (abortW.signal.aborted) return;
          if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);
        }
        // A mid-stream idle timeout cut this answer short: surface the caveat as a separate UI message,
        // kept OUT of stored history (so a follow-up doesn't re-send it to the model), exactly like the
        // document path. The notice text is single-sourced in llm.js.
        if (result.genOpts && result.genOpts.truncated) {
          try { client.emit('message', require('./llm').TRUNCATION_NOTICE); } catch {}
        }
        client.emit('sources', result.sources || []);
        // A web answer has no single retrieval trace, so no "Why this answer?" — but it
        // still gets the rating buttons and, where its sources allow, the Verify badge.
        await emitAnswerMeta({ query: q, answer: webText, sources: result.sources || [], trace: null, topReranker: null, failed: !landed, flags });
        endChat();
      } catch (e) {
        if (abortW.signal.aborted) return;   // a Stop/New aborted the turn — not a failure to report
        if (DEBUG) console.log(`  🌐 Web answer error: ${e.message}`);
        if (!emitProviderDownIfApplicable(client, e)) client.emit('message', 'Web search ran into a problem. Please try again.');
        endChat();
      } finally {
        // answerFromWeb writes conversationContext.webPages at the end of its (multi-second) run, so a
        // reset mid-fetch would otherwise leave the abandoned turn's pages to feed a later follow-up.
        releaseTurn(abortW);
        if (ownStall) stall.stop();
      }
    };

    // Run a multi-step Deep Research report for `q`, streaming it and recording the turn.
    // `useWeb` is true only when the user also has web search on for the message, so the
    // local-only posture is preserved unless they opted into the web. Progress lines reuse
    // the same `synth_progress` event the workspace synthesis uses.
    const runDeepResearch = async (q, useWeb, focusDocIds, flags = {}) => {
      // A web-augmented research turn skips the main readiness gate (it is web-oriented), so a non-active
      // workspace whose bundle is still warming would reach here and silently produce a web-only report
      // with no corpus. Detect that and ask the user to retry, so the corpus side is never dropped without
      // notice. The active workspace is always live, so this only affects a window on another workspace.
      if (turnWs !== state.workspaceId) {
        try {
          const acq = await require('./indexing/bundle').getBundleNonBlocking(turnWs);
          if (turnSuperseded()) return;   // a New landed during the load, before this turn's controller existed
          if (acq.status === 'warming') {
            client.emit('message', '⏳ Preparing that workspace for research — please try again shortly.');
            endChat();
            return;
          }
        } catch (e) { /* fall through — deepResearch guards a missing corpus itself */ }
      }
      const ownStall = !turnStallHolder.current;
      const stall = turnStallHolder.current || newTurnStall();
      if (ownStall) stall.start('deep research');
      const abortR = beginTurnAbort();
      try {
        if (abortR.signal.aborted) return;   // a Stop landed before this turn's controller existed
        const { deepResearch } = require('./retrieval/deepresearch');
        stall.note('Researching your documents…');
        const result = await deepResearch({
          query: q, workspaceId: turnWs, useWeb, focusDocIds,
          onProgress: (text) => { if (!abortR.signal.aborted) { stall.note(text); client.emit(TURN_PROTOCOL.progress, { text }); } },
          // So a New/disconnect during the (minutes-long) research rounds cancels the work promptly
          // and frees the serialized turn queue, instead of only stopping the final stream.
          signal: abortR.signal,
        });
        let text = '';
        for await (const chunk of result.stream) {
          if (abortR.signal.aborted) break;
          text += chunk;
          client.emit('message', chunk);
          stall.note();
        }
        if (abortR.signal.aborted) return;   // finally releases activeAbort
        const landed = !result.outOfScope && !!text.trim();
        let researchCaveat = '';
        if (landed) {
          // Verify pass + invented-citation caveat via the shared grounded finalizer (same sequence the API
          // applies, single-sourced in answerfinalize). It returns the parts; this path emits them in its order.
          const fin = require('./answerfinalize').finalizeGroundedStreamed(text, result.sources || [], result.idx);
          text = fin.text;
          if (fin.changed) client.emit('answer_final', text);
          researchCaveat = fin.caveat;
          conversationContext.history.push(
            { role: 'user', content: q },
            { role: 'assistant', content: text, sources: leanSources(result.sources) },
          );
          // A landed research report is a fresh, non-web turn, so a later "tell me more" must not be
          // hijacked back to stale web pages by the web-continuation gate. Mirrors the main path.
          conversationContext.webPages = null;
          await updateConversationSummary(conversationContext, abortR.signal);
          // A reset during the (seconds-long) summary await must not re-save the just-cleared
          // conversation or leak sources/meta/chat_end into the cleared UI — mirror the main path.
          if (abortR.signal.aborted) return;
          if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);
        }
        // A research report cites corpus documents by [name], so warn if it names one that was not among the
        // report's sources — the invented-citation guard computed above by the shared finalizer. A separate UI
        // message, kept out of history. (Web-only answers have no filenames, so the caveat is empty there.)
        if (landed && researchCaveat) client.emit('message', researchCaveat);
        // A cut-off report gets the truncation caveat as a separate UI message, kept out of history (mirrors
        // the document and web paths).
        if (result.genOpts && result.genOpts.truncated) {
          try { client.emit('message', require('./llm').TRUNCATION_NOTICE); } catch {}
        }
        client.emit('sources', result.sources || []);
        // A research report has no single retrieval trace, so no "Why this answer?" — but it gets the rating
        // buttons and the Verify badge. The sources are indexed docs from turnWs, so faithfulness must resolve
        // them against THAT workspace's index, not the active one — pass its bundle as idx (active → state),
        // or a research answer on a non-active workspace would silently never show the Verify/figures badge.
        // Snapshot the active index too (see snapshotActiveIndex), so the faithfulness/grounding checks resolve
        // cited source text from the workspace this answer came from even if the active workspace switches.
        let metaIdx = snapshotActiveIndex();
        if (turnWs && turnWs !== state.workspaceId) {
          try { const acq = await require('./indexing/bundle').getBundleNonBlocking(turnWs); if (acq && acq.bundle) metaIdx = acq.bundle; } catch { /* fall back to active state */ }
        }
        await emitAnswerMeta({ query: q, answer: text, sources: result.sources || [], trace: null, topReranker: null, failed: !landed, flags, idx: metaIdx });
        endChat();
      } catch (e) {
        if (abortR.signal.aborted) return;   // a Stop/New aborted the turn — not a failure to report
        if (DEBUG) console.log(`  🔬 Deep research error: ${e.message}`);
        if (!emitProviderDownIfApplicable(client, e)) client.emit('message', 'Deep research ran into a problem. Please try again.');
        endChat();
      } finally {
        // Drop any scratch state written after a mid-turn reset before releasing the controller.
        releaseTurn(abortR);
      }
    };

    // Run a whole-workspace synthesis (map-reduce across documents) and stream it to the chat,
    // recording the turn so a follow-up continues from it. Shared by the explicit ✦ Generate
    // action (synthesize_workspace) and the opt-in auto-route for broad corpus questions, so
    // the streaming, scope note, egress guard, and history handling live in exactly one place.
    // `userTurn` is the text recorded as the user's message (the real question when auto-routed,
    // a generic label for the button). Best-effort — never throws into its caller.
    const runWorkspaceSynthesisToChat = async ({ focus = '', format = 'overview', userTurn = null, flags = {} } = {}) => {
      let abort = null;
      try {
        // For the ACTIVE workspace, treat a mid-rebuild wipe (indexing with an empty corpus) as not-ready,
        // so synthesis shows "building" instead of "no documents". A NON-active workspace is synthesized
        // from its own loaded bundle — runWorkspaceSynthesis(turnWs) resolves and reports warming/empty
        // itself, so this active-only gate is skipped for it.
        if (turnWs === state.workspaceId && (!state.indexReady || (state.indexing && state.parentMap.size === 0))) {
          client.emit('message', buildingIndexNotice());
          endChat();
          return;
        }
        // Wire the abort BEFORE the slow map-reduce below, like the web and deep-research paths.
        // runWorkspaceSynthesis runs one LLM summary per document and can take minutes; if the user
        // clicks New (reset_conversation) during it, reset must be able to abort THIS turn. Creating
        // the controller only after the await — as this did before — left activeAbort null/stale
        // during the map phase, so the reset was a no-op and the finished answer then streamed into
        // the just-cleared conversation and re-saved the deleted session. The finally clears it.
        abort = beginTurnAbort();
        if (abort.signal.aborted) return;   // a Stop landed before this turn's controller existed
        const { runWorkspaceSynthesis } = require('./api-core');
        const onProgress = (p) => {
          if (p.phase === 'summarizing') client.emit(TURN_PROTOCOL.progress, { text: `Reading document ${p.processed} of ${p.total}…` });
          else if (p.phase === 'synthesizing') client.emit(TURN_PROTOCOL.progress, { text: 'Bringing it all together…' });
        };
        // Pass the turn's abort signal so a New/disconnect during the per-document map phase cancels
        // it promptly and frees the serialized turn queue, instead of only stopping the final stream.
        const r = await runWorkspaceSynthesis(turnWs, focus, onProgress, format, abort.signal);
        // If the user reset during the map-reduce, stop before emitting anything into the cleared chat.
        if (abort.signal.aborted) return;
        if (r.status === 'warming') { client.emit('message', '⏳ The workspace is still preparing — please try again shortly.'); endChat(); return; }
        if (r.status === 'empty')   { client.emit('message', 'There are no documents in this workspace to synthesize yet.'); endChat(); return; }

        const noiseNote = r.skippedNoise > 0
          ? ` (${r.skippedNoise} license/config/image file${r.skippedNoise === 1 ? '' : 's'} skipped)`
          : '';
        const what = r.format && r.format !== 'Overview' ? `${r.format} ` : '';
        const scopeNote = r.sampled
          ? `Building ${what || 'an overview '}across a representative sample of ${r.docCount} of your ${r.totalDocs} content documents${noiseNote} (spanning your folders)…\n\n`
          : `Building ${what || 'an overview '}across ${r.docCount} document${r.docCount === 1 ? '' : 's'}${noiseNote}…\n\n`;
        client.emit('message', scopeNote);

        let responseText = '';
        for await (const chunk of r.stream) {
          if (abort.signal.aborted) break;
          responseText += chunk;
          client.emit('message', chunk);
        }
        if (abort.signal.aborted) return;
        responseText = finalizeAnswer(responseText);   // same egress/leak guard as the main path

        const label = (r.format && r.format !== 'Overview') ? r.format.toLowerCase() : 'overview';
        conversationContext.history.push(
          { role: 'user', content: userTurn || `Workspace ${label}${focus ? ` (focus: ${focus})` : ''}` },
          { role: 'assistant', content: responseText, sources: [] },
        );
        conversationContext.allowedDocIds = null;
        // A landed local synthesis means we've moved off any prior web results, so a later "tell me
        // more" continues from the synthesis rather than re-answering from stale web pages. Mirrors the
        // main document-answer path.
        conversationContext.webPages = null;
        capHistory(conversationContext);   // this path skips updateConversationSummary, so bound the live history here
        if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);
        // A landed synthesis is a real persisted turn, so it gets the same post-answer affordances as
        // every other path — rating buttons and suggested follow-ups — via the shared helper. It has no
        // single retrieval trace and no sources, so Verify self-gates off (faithfulness needs sources)
        // and there is no "Why this answer?"; ratings and suggestions still fire.
        client.emit('sources', []);
        await emitAnswerMeta({ query: userTurn || focus || 'Workspace synthesis', answer: responseText, sources: [], trace: null, topReranker: null, failed: false, flags });
        endChat();
      } catch (error) {
        if (abort && abort.signal.aborted) return;   // a Stop/New aborted the turn — not a failure to report
        console.error('Error synthesizing workspace:', error);
        if (!emitProviderDownIfApplicable(client, error)) client.emit('message', 'Something went wrong synthesizing this workspace.');
        endChat();
      } finally {
        // Drop any scratch state written after a mid-turn reset, then release the abort only if it is
        // still ours — a turn started after a reset owns activeAbort now. (abort may be null if this threw
        // before the controller was created; releaseTurn guards that.)
        releaseTurn(abort);
      }
    };

    // The user accepted an offered web search. Run it for the stashed query.
    client.on('web_accept', () => runExclusive(async () => {
      const q = pendingWebQuery;
      const flags = pendingWebFlags || {};
      // Answer (and record the outcome) into the workspace the offer was made from — the window may have
      // switched what it is viewing since, which would otherwise attribute this turn to the wrong one.
      turnWs = pendingWebWs || state.workspaceId;
      pendingWebQuery = null;
      pendingWebFlags = null;
      pendingWebWs = null;
      if (!q) { endChat(); return; }
      // Re-check access per turn: web_accept IS a new turn, so a membership change or key-scope narrowing
      // between the offer and the accept must take effect (parity with message/summarize/synthesize). Otherwise
      // the answer runs and records a learning outcome into a workspace the principal may no longer use.
      if (!mayUseWorkspace(turnWs)) { client.emit('message', '🔒 You do not have access to this workspace.'); endChat(); return; }
      if (!require('./config').useWebSearch) { client.emit('message', 'Web search is disabled.'); endChat(); return; }
      if (DEBUG) console.log(`  🌐 User accepted web search for: "${q}"`);
      await runWebAnswer(q, flags);
    }));

    // The user declined the offered web search — just clear the pending query.
    client.on('web_decline', () => { pendingWebQuery = null; pendingWebFlags = null; pendingWebWs = null; });

    // Outcome-aware retrieval: apply a 👍/👎 to a past answer. The client sends the
    // outcome id it received via 'outcome_id' plus rating (1 | -1).
    client.on('rate_answer', (raw) => {
      try {
        const { messageId, rating, workspaceId } = parsePayload(raw);
        if (!messageId || ![1, -1].includes(rating)) return;
        // A rating writes into that workspace's learning store, so ALWAYS enforce access to the resolved target
        // — including the active workspace, which a signed-in non-member (or an out-of-scope key) must not be
        // able to write into. (Previously the check was skipped when the target was the active workspace.)
        const targetWs = resolveTurnWs({ workspaceId });
        if (!mayUseWorkspace(targetWs)) return;
        // Rate the outcome in the workspace where the answer was produced (the window that showed it),
        // which is where the record lives — not always the active workspace. undefined = active (default).
        const cacheDir = (targetWs !== state.workspaceId)
          ? require('./workspaces').cacheDirFor(require('./config').DATA_DIR, targetWs) : undefined;
        const ok = require('./outcomes').rate(cacheDir, messageId, rating);
        if (ok) { try { require('./similarity').invalidate(cacheDir || require('./config').CACHE_DIR); } catch {} }
        client.emit('rating_saved', { messageId, rating, ok });
      } catch (e) { /* best-effort */ }
    });

    // Restore a persisted conversation when the client reconnects with a session id.
    // The client sends { sessionId } on connect; we hydrate the durable fields and
    // replay the history + sources so the UI can rebuild the thread.
    // Serialized on the same chain as generation: a restore mutates conversationContext
    // (history/summary/allowedDocIds/…) wholesale, so running it while an answer is streaming
    // would let the in-flight turn push into a replaced array and re-save a mixed state. Routing
    // it through runExclusive makes the restore wait for any active turn to finish. (Restores
    // normally arrive at connect, before any turn, so this only matters for a misbehaving client.)
    client.on('restore_session', (raw) => runExclusive(async () => {
      try {
        const { sessionId: id } = parsePayload(raw);
        if (!isValidId(id)) { client.emit('session_restored', { history: [], found: false }); return; }
        sessionId = id;
        // A reconnect on a socket that already holds a live conversation must NOT be overwritten from disk:
        // the on-disk copy can be stale (another tab wrote it, or the persist cap trimmed it), so clobbering
        // live memory mid-thread would silently shift the conversation. Keep the live context and just
        // re-report it. A first connect has empty history and falls through to the normal disk restore.
        if (Array.isArray(conversationContext.history) && conversationContext.history.length > 0) {
          client.emit('session_restored', { history: withSourceStats(conversationContext.history), found: true });
          return;
        }
        const saved = await loadSession(id, sessPrincipalKey);
        if (saved) {
          // Start from a clean slate so the restored thread never inherits the previous thread's
          // transient retrieval bookkeeping (passage read-positions, exclusions, the passage map,
          // and the window-score cache). Restores normally arrive on a fresh connection, but a client
          // that restores after running queries would otherwise carry stale positions into the new
          // thread and skew follow-ups — the same drift clearConversationState exists to prevent.
          clearConversationState(conversationContext, { resetHistory: false });
          conversationContext.history        = saved.history || [];
          conversationContext.summary        = saved.summary || '';
          conversationContext.summarizedUpTo = saved.summarizedUpTo || 0;
          conversationContext.allowedDocIds  = saved.allowedDocIds || null;
          conversationContext.consultedDocs  = saved.consultedDocs || [];
          conversationContext.webPages       = saved.webPages || null;
          if (DEBUG) console.log(`  💾 Restored session ${id} (${conversationContext.history.length} msgs)`);
          client.emit('session_restored', { history: withSourceStats(conversationContext.history), found: true });
        } else {
          client.emit('session_restored', { history: [], found: false });
        }
      } catch (e) {
        if (DEBUG) console.log(`  ⚠️  restore_session failed: ${e.message}`);
        client.emit('session_restored', { history: [], found: false });
      }
    }, { stoppable: false }));

    // Status heartbeat. An empty workspace has no vector store by design, so
    // readiness is `indexReady` alone — requiring liveVectorStore made an empty
    // workspace report "not ready" forever even though it was perfectly usable.
    const emitStatus = () => {
      // Wrapped: this runs on a 2s timer, and a throw in a timer callback is fatal
      // (uncaughtException). Reading state + emitting should never throw, but guarding
      // keeps parity with the rest of the hot path and can't take the process down.
      try {
        client.emit('indexing_status', {
          indexing:  state.indexing,
          ready:     state.indexReady,
          empty:     state.indexReady && !state.indexing && state.parentMap.size === 0,
          documents: state.parentMap.size,
          workspace: state.workspaceId,
          progress:  state.indexProgress,   // { done, total, name, label } or null
        });
      } catch { /* client went away mid-emit — the disconnect handler clears the timer */ }
    };
    emitStatus();                                  // immediate, don't wait 2s
    const statusInterval = setInterval(emitStatus, 2000);

    client.on('reset_conversation', () => {
      // Wrapped so a disk error in clearSession is recovered locally rather than surfacing as an
      // uncaughtException (which would log but leave the reset half-applied).
      try {
        // Bump the epoch FIRST: this supersedes both the running turn (caught at its pre-controller await, where
        // activeAbort doesn't yet exist) and any turn still queued on _genChain, so neither can resurrect the
        // conversation we are about to clear.
        resetEpoch++;
        stopPending = false;   // New supersedes any Stop that was still waiting for a controller
        if (activeAbort) { activeAbort.abort(); activeAbort = null; }
        abortBackgroundJobs();   // cancel any post-answer self-consistency generations from the turn being cleared
        resetContext('user clicked New');
        if (sessionId) clearSession(sessionId, sessPrincipalKey);
      } catch (e) { if (DEBUG) console.log(`  reset_conversation failed: ${e && e.message}`); }
    });

    // Stop the turn that is generating right now. Registered unserialized (like reset_conversation) so
    // it can interrupt a handler instead of waiting behind it on the serialized queue. Three windows:
    //   - a controller exists: mark it and abort it; its handler unwinds and releaseTurn sends `stopped`;
    //   - no controller yet (a pre-generation await): set stopPending; beginTurnAbort aborts the new
    //     controller the moment it is created, so the stop cannot be lost in that window;
    //   - turn still queued: stopEpoch invalidates it when it would have started.
    // The click is idempotent: a second Stop while the first is unwinding finds an already-aborted
    // controller and does nothing.
    client.on(TURN_PROTOCOL.stop, () => {
      stopEpoch++;
      if (activeAbort && !activeAbort.signal.aborted) {
        abortReason.set(activeAbort, ABORT_STOP);
        stopPending = false;
        try { activeAbort.abort(); } catch { /* best-effort */ }
      } else if (!activeAbort) {
        stopPending = true;
      }
    });

    client.on('message', (data) => runExclusive(async () => {
      // Read fresh so a Settings toggle applies without a restart (see note at top).
      const { useWebSearch, webAutoSuggest } = require('./config');
      // This turn's abort controller, declared here so the finally can release activeAbort on EVERY
      // exit path — kept live through the post-answer persistence tail (summary + session save) so a
      // reset during that tail is detected and doesn't re-save the just-cleared conversation.
      let abort = null;
      try {
        const parsed = JSON.parse(data);
        const { content, startDate, endDate, selectedDocIds, fullContextDocIds, attachments, webSearch, explainTrace, checkFaithfulness, deepResearch, suggestQuestions } = parsed;
        // Validate the query up front: a malformed payload ({} or a non-string content) would otherwise reach
        // deep into the turn before a content.trim() threw (caught, but wasteful), and a client could run the
        // heuristics/retrieval on empty input. Reject non-string/blank content immediately.
        if (typeof content !== 'string' || !content.trim()) { endChat(); return; }
        // Cap an over-long question, matching the HTTP API's MAX_QUERY_CHARS (single-sourced in constants). A
        // multi-megabyte question is never legitimate and would needlessly load prompt assembly + retrieval;
        // reject it with a clear, friendly message instead of doing the work. Large pasted context belongs in
        // an attachment, which has its own, larger cap.
        const MAX_QUERY_CHARS = require('./constants').MAX_QUERY_CHARS;
        if (content.length > MAX_QUERY_CHARS) {
          client.emit('message', `That question is too long (${content.length.toLocaleString()} characters; the limit is ${MAX_QUERY_CHARS.toLocaleString()}). Please shorten it — or attach a file if you want me to work from a long document.`);
          endChat();
          return;
        }
        // This turn targets the workspace this window is viewing (default: the active one). Set early so
        // outcome recording and the answer persona use it even on the web path; the corpus index for a
        // non-active workspace is resolved after the web-oriented check below (web turns don't need it).
        // An existing workspace only (see resolveTurnWs) — a spoofed valid-format id falls back to active.
        turnWs = resolveTurnWs(parsed);
        // Workspace access: a member may only query workspaces they belong to (admins/owner: any). Defense in
        // depth — the UI only offers a member their own workspaces, but never trust the client's workspace id.
        if (!mayUseWorkspace(turnWs)) {
          client.emit('message', '🔒 You do not have access to this workspace.');
          endChat();
          return;
        }
        const turnIsActive = turnWs === state.workspaceId;
        let idx = state;   // the query-ready index for this turn; resolved to a loaded bundle when non-active
        if (DEBUG && Array.isArray(attachments) && attachments.length > 0) {
          console.log(`  📎 Received ${attachments.length} attachment(s): ${attachments.map(a => `${a.name || '?'} (${(a.text || '').length} chars)`).join(', ')}`);
        }
        // Outcome-aware retrieval is on unless the client explicitly sends outcomes:false.
        const outcomesEnabled = parsed.outcomes !== false;
        // The post-answer affordance toggles, bundled once so every answer path (document,
        // web, research) hands emitAnswerMeta the same shape.
        // Suggested follow-up chips are gated on BOTH the master switch (config) and the
        // per-session composer toggle the client sends, so the extra call never runs unasked.
        const answerFlags = { outcomesEnabled, explainTrace: explainTrace === true, checkFaithfulness: checkFaithfulness === true, suggestQuestions: suggestQuestions === true && require('./config').useSuggestedQuestions };
        // Stall attribution for this turn. Every path that can take a long time announces its stage below;
        // a silence longer than the threshold is reported as the stage it is stuck in (lib/stallwatch).
        turnStallHolder.current = newTurnStall();
        turnStallHolder.current.start('your documents');
        const stallThisTurn = turnStallHolder.current;

        // An empty workspace is ready, it just has nothing to search. Distinguish it
        // from a genuinely-still-building index so the user gets an actionable answer
        // instead of being told to wait for something that will never finish.
        // Web-oriented turns are exempt from BOTH readiness gates below — they don't
        // touch the local index, so an empty or still-building index must not block them
        // (an empty workspace permanently has no vector store, which would otherwise trap
        // a web search on "⏳ Building the document index" forever). "Web-oriented" = an
        // explicit web search, or a web continuation reusing already-fetched pages.
        // Deep research is covered implicitly: web-augmented research sets wantsWeb, while
        // corpus-only research genuinely needs the index and correctly stays gated.
        const wantsWeb = useWebSearch && webSearch === true;
        const webContinuation = useWebSearch && isWebContinuation(content, conversationContext);
        const webOriented = wantsWeb || webContinuation;
        // Readiness gate. A web-oriented turn skips it entirely (it doesn't touch the local index).
        // For the ACTIVE workspace the checks are exactly as before (live global state). For a NON-active
        // workspace the window is viewing, resolve a loaded bundle instead — the same per-workspace bundle
        // the HTTP/MCP API uses — so the answer comes from that corpus. A bundle that is still warming
        // (first load needs OCR) asks the user to retry; an empty one gets the no-documents message.
        if (!webOriented) {
          if (turnIsActive) {
            // `!state.indexing` guards a mid-rebuild window: a runtime embedding-model change or a
            // corrupt-bank self-heal wipes the index and re-embeds while the app is live, during which
            // indexReady stays true but parentMap is momentarily empty. Without this guard a query in that
            // window would be wrongly told the workspace is empty; instead it falls through to the
            // "building the index" message below. An empty workspace at rest (indexing false) still shows this.
            if (state.indexReady && !state.indexing && state.parentMap.size === 0) {
              client.emit('message',
                'This workspace has no documents yet. Add some with the Documents button, ' +
                'or point Lokyni at a folder in Settings → Indexed folders.');
              endChat();
              return;
            }
            if (!state.liveVectorStore || !state.indexReady) {
              client.emit('message', buildingIndexNotice());
              endChat();
              return;
            }
            // The index is ready: take an immutable snapshot so a concurrent active-workspace switch can't swap it
            // out mid-turn and surface another workspace's documents (see snapshotActiveIndex). Non-active turns
            // get their snapshot from the bundle below.
            idx = snapshotActiveIndex();
          } else {
            const acq = await require('./indexing/bundle').getBundleNonBlocking(turnWs);
            // A New (reset) may have landed during that load, when this turn had no AbortController yet for the
            // reset to signal. Discard the turn so it can't answer into — and re-save — the cleared conversation.
            if (turnSuperseded()) return;
            if (acq.status === 'warming') {
              client.emit('message', '⏳ Preparing that workspace — please try again shortly.');
              endChat();
              return;
            }
            idx = acq.bundle;
            if (!idx.liveVectorStore || idx.parentMap.size === 0) {
              client.emit('message',
                'That workspace has no documents yet. Add some with the Documents button, ' +
                'or point Lokyni at a folder in Settings → Indexed folders.');
              endChat();
              return;
            }
          }
        }

        // Outcome-aware retrieval: if this query closely matches a past one the user
        // rated 👍, surface it ("you asked something similar before") so they can see
        // the prior answer worked. Best-effort, non-blocking, document mode only.
        if (!wantsWeb && outcomesEnabled) {
          try {
            const similarity = require('./similarity');
            const match = similarity.bestRatedUpMatch(wsCacheDir(), content);
            if (match && match.score >= 0.35) {
              client.emit('similar_query', { id: match.id, score: Number(match.score.toFixed(3)) });
            }
          } catch (e) { /* surfacing is best-effort */ }
        }

        // Deep Research mode (opt-in per message). Multi-step, cited research over the
        // corpus — and the web too when the user also enabled web search for the message.
        // Takes precedence over plain web mode so "Research + Web" runs web-augmented
        // research rather than a single web answer.
        if (deepResearch === true) {
          // A document selection (focus mode) restricts the corpus side of research to
          // those documents; web (when on) is unaffected.
          await runDeepResearch(content, wantsWeb, Array.isArray(selectedDocIds) ? selectedDocIds : null, answerFlags);
          return;
        }

        // Web-search mode (opt-in per message). When the user turns on the web toggle
        // and the feature is enabled, answer from live web pages instead of the local
        // index — single pass, no retries, grounded + cited through the same flow.
        if (wantsWeb) {
          await runWebAnswer(content, answerFlags);
          return;
        }

        // Web continuation: if the previous answer came from the web and this message
        // is a follow-up that continues the same subject ("tell me more", "what date
        // is that from?") with no new subject of its own, keep it on the web results
        // rather than dropping back into document search. answerFromWeb reuses the
        // already-fetched pages (no new search) when it detects the continuation.
        if (webContinuation) {
          if (DEBUG) console.log('  🌐 Web continuation follow-up — staying on web results');
          await runWebAnswer(content, answerFlags);
          return;
        }

        // A vague continuation ("tell me more", "go on") with nothing to continue — a
        // fresh conversation, no selected docs, no attachment — would otherwise fall
        // into a keyword search where the bare words "tell"/"more" match an arbitrary
        // document (a play, a scripture) and Lokyni expounds on that. Ask what to
        // expand on instead of picking a random file.
        // Any prior answered turn (a document Q&A, a summary, or a workspace synthesis)
        // is something to continue — so gate on history, not allowedDocIds. Workspace
        // synthesis deliberately clears allowedDocIds while pushing to history, so keying
        // on allowedDocIds wrongly refused "tell me more" after a synthesis.
        const hasConvo = conversationContext.history?.length > 0;
        if (isVagueContinuation(content) && !hasConvo &&
            !(Array.isArray(selectedDocIds) && selectedDocIds.length) &&
            !(Array.isArray(attachments) && attachments.length)) {
          if (DEBUG) console.log('  🤔 Vague continuation with no context — asking what to expand on');
          client.emit('message', "I don't have anything to expand on yet — ask a question first, or open a document and I'll take it from there.");
          endChat();
          return;
        }

        // A new normal message supersedes any pending "search the web?" offer the user
        // left unanswered — otherwise a later stray web_accept would run a stale query.
        pendingWebQuery = null;
        pendingWebWs = null;

        // Auto workspace synthesis (opt-in): a genuinely whole-corpus question is answered by
        // the existing map-reduce synthesis (which reads across the collection) instead of
        // top-k passage retrieval (which only sees a few documents). Gated to a plain,
        // unfocused, non-web/research question over a multi-document workspace, and only for
        // unambiguous corpus phrasing — so ordinary questions and per-document follow-ups stay
        // on the fast retrieval path. Reuses the same synthesis path as the ✦ Generate action.
        if (require('./config').useAutoSynthesis && !webOriented && deepResearch !== true
            && !(Array.isArray(selectedDocIds)    && selectedDocIds.length)
            && !(Array.isArray(fullContextDocIds) && fullContextDocIds.length)
            && !(Array.isArray(attachments)       && attachments.length)
            // The turn's corpus, not whichever workspace is active — a window viewing a non-active
            // workspace routes on ITS document count (idx is the resolved bundle; state when active).
            && idx.parentMap.size > 1
            && require('./retrieval/overview').looksWorkspaceOverview(content)) {
          if (DEBUG) console.log('  🗂️  Corpus-overview question — routing to workspace synthesis');
          // Pass the turn's affordance flags so an auto-routed corpus question gets the same rating and
          // suggested-follow-up controls as a normal answer.
          await runWorkspaceSynthesisToChat({ focus: content, userTurn: content, flags: answerFlags });
          return;
        }

        if (state.indexing && DEBUG) {
          console.log('ℹ️  Query served from live store while delta update runs in background');
        }

        // Semantic answer cache: a fresh, standard question repeated against an unchanged
        // corpus returns instantly, skipping retrieval and generation. Guarded to a genuine
        // repeat (see lib/semanticcache.js) and only the plain document path — never a
        // follow-up, a web/research answer, a focused/attached query, or a date-filtered one,
        // each of which changes the answer for the same text.
        const scCfg = require('./config');
        const standardPath = !webOriented && !deepResearch
          && !(Array.isArray(selectedDocIds)   && selectedDocIds.length)
          && !(Array.isArray(fullContextDocIds) && fullContextDocIds.length)
          && !(Array.isArray(attachments)      && attachments.length)
          && !startDate && !endDate;
        const scCacheable = scCfg.useSemanticCache && !hasConvo && standardPath;
        let scSig = null, scFp = null;
        if (scCacheable) {
          const sc = require('./semanticcache');
          // Scope the cache to the workspace THIS turn is answering from, never whichever is active:
          // the signature keys on that workspace's persona, and the fingerprint on that workspace's
          // corpus (idx is the resolved bundle — state for the active workspace, unchanged).
          scSig = sc.signature(scCfg, { persona: require('./config').personaFor(turnWs) });
          scFp  = sc.fingerprint(idx, scCfg);
          // Guard the cache read against a reset during its disk I/O, like every other turn path.
          // reset_conversation runs unserialized (so it can interrupt), and sc.lookup does real async
          // file reads; without this, clicking New while the lookup awaits would let the stale hit
          // stream into the just-cleared conversation and re-save the deleted session.
          const scAbort = beginTurnAbort();
          const hit = await sc.lookup(wsCacheDir(), { fingerprint: scFp, signature: scSig, query: content });
          if (scAbort.signal.aborted) { releaseTurn(scAbort); return; }
          releaseTurn(scAbort);   // release: a hit completes below, a miss lets the main controller own the turn
          if (hit) {
            if (DEBUG) console.log('  ⚡ Semantic cache hit — returning the stored answer');
            const hitSources = hit.sources || [];
            // Re-run the deterministic grounded finalize (verify pass + invented-citation guard) so a cached
            // answer still gets the current egress/leak checks even after an upgrade added new ones — the same
            // shared sequence the live path and the API use.
            const fin = require('./answerfinalize').finalizeGroundedStreamed(hit.answer, hitSources, idx);
            const answer = fin.text;
            if (fin.changed) client.emit('answer_final', answer);
            client.emit('message', answer);
            // The invented-citation caution, exactly like the live path (a cached answer that cites a file not
            // among its sources must still warn), emitted AFTER the answer and kept out of stored history.
            if (fin.caveat) client.emit('message', fin.caveat);
            conversationContext.history.push(
              { role: 'user', content },
              { role: 'assistant', content: answer, sources: leanSources(hitSources) }
            );
            // Let a follow-up continue on the same documents.
            const ids = hitSources.map(s => s && s.id).filter(Boolean);
            if (ids.length) conversationContext.allowedDocIds = ids;
            capHistory(conversationContext);   // cache-hit path skips updateConversationSummary, so bound the live history here
            if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);
            client.emit('sources', hitSources);
            // Rateable like any answer; the LLM claim judge is skipped so the hit stays instant (it was
            // grounded when cached and the corpus is unchanged), but the cheap deterministic numeric check
            // still runs via checkFigures, since passing checkFaithfulness:false takes that always-on branch.
            await emitAnswerMeta({ query: content, answer, sources: hitSources, trace: null, topReranker: null, failed: false, idx, flags: { outcomesEnabled: answerFlags.outcomesEnabled, explainTrace: false, checkFaithfulness: false } });
            endChat();
            return;
          }
        }

        // Vague continuations ("tell me more") should never retry — the density
        // search on retry uses query keywords which don't exist in vague queries,
        // always scoring 0 and landing on wrong documents.
        const isVague        = isVagueContinuation(content);
        // Ending-intent caps retries to 1 only when it's actually a follow-up. On a
        // FIRST query, a substantive question that merely contains "final"/"outcome"/
        // "result" ("what were the final audit results?") is not a follow-up and should
        // get the normal retry budget rather than a single attempt.
        const isEndingIntent = hasConvo && ENDING_INTENT_RE.test(content.trim());
        // Vague/ending-intent follow-ups have no usable locating keywords — the first
        // (advance/recap) passage is the best shot, so don't retry into unrelated regions.
        const MAX_ATTEMPTS = (isVague || isEndingIntent) ? 1 : 3;
        let responseText = '', sources = [], outOfScope = false, failed = false, truncated = false;
        let lastRerankerScore = null; // best cross-encoder score seen across attempts
        let lastCrossLingual = false; // whether the last attempt answered via the cross-lingual dense-trust path
        let lastTrace = null;
        let lastGetMessages = null;   // the winning attempt's prompt accessor, for the opt-in self-consistency pass

        // Create a fresh abort controller for this request (assigned to the hoisted `abort`)
        abort = beginTurnAbort();
        if (abort.signal.aborted) return;   // a Stop landed before this turn's controller existed
        // If the client already went away while the workspace bundle was warming (the await before this
        // point), don't start an expensive generation for a dead socket — the disconnect fired before
        // this controller existed, so nothing else would cancel it. The finally still releases cleanly.
        if (!client.connected) return;

        // Outcome-aware retrieval (Phase B): down-weight documents that led to 👎 answers on similar
        // past queries. Conservative — only engage once there's enough rating signal to trust (a handful
        // of 👎 ratings), so a cold or lightly-rated corpus behaves exactly as before. The penalty only
        // reorders candidates; it never removes a document. Computed ONCE here (it depends only on the
        // query, not the attempt) rather than re-scoring the outcomes corpus on every retry.
        let downweight = null;
        try {
          if (outcomesEnabled) {
            const outcomes = require('./outcomes');
            const st = outcomes.stats(wsCacheDir());
            if (st.down >= 3) {   // signal threshold
              const map = require('./similarity').downweightDocs(wsCacheDir(), content);
              if (map && map.size > 0) downweight = map;
            }
          }
        } catch (e) { /* best-effort; retrieval proceeds unweighted */ }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (abort.signal.aborted) break;
          // No wrong-corpus stop is needed here any more: `idx` is an immutable snapshot of the workspace this turn
          // started on (active or not — see snapshotActiveIndex), so a concurrent active-workspace switch cannot
          // change what this turn reads. The turn correctly finishes answering from its own workspace's documents.
          if (attempt === 2) {
            conversationContext.docReadPos = new Map();
            if (DEBUG) console.log(`🔁 Retry attempt ${attempt} — reset docReadPos`);
          } else if (attempt === 3) {
            conversationContext.allowedDocIds = null;
            conversationContext.docReadPos    = new Map();
            if (DEBUG) console.log(`🔁 Retry attempt ${attempt} — full fresh retrieval (history preserved)`);
          }

          stallThisTurn.note('Searching your documents…');
          const result = await searchDocuments(content, startDate, endDate, conversationContext, attempt > 1, selectedDocIds || null, attempt, { explainTrace: explainTrace === true, downweight, fullContextDocIds: Array.isArray(fullContextDocIds) ? fullContextDocIds : [], attachments: Array.isArray(attachments) ? attachments : [], idx, signal: abort.signal,
            // Surface the retrieval phase live in the thinking bubble (reuses the synth_progress status
            // channel, which also pushes the no-response watchdog forward). Cosmetic and abort-guarded.
            onStage: (text) => { if (!abort.signal.aborted) { stallThisTurn.note(text); try { client.emit(TURN_PROTOCOL.progress, { text }); } catch {} } } });
          sources    = result.sources;
          outOfScope = result.outOfScope;
          // Kept for the "why this answer" panel, emitted after the answer so it
          // never delays the response.
          lastTrace  = result.trace || lastTrace;
          lastRerankerScore = (typeof result.topRerankerScore === 'number') ? result.topRerankerScore : lastRerankerScore;
          lastCrossLingual = result.crossLingual === true;
          if (typeof result.getMessages === 'function') lastGetMessages = result.getMessages;

          // A reset during the (seconds-long) searchDocuments await must not let this turn continue:
          // without this, the web-offer branch just below would emit a web_offer chip and re-arm
          // pendingWebQuery into the just-cleared conversation (a later web_accept would then run the
          // abandoned query). The finally re-clears any scratch state searchDocuments already wrote.
          if (abort.signal.aborted) return;

          // Ask-first web fallback: on the first attempt, if the corpus genuinely
          // has nothing (canWebFallback) and the question looks like something the
          // web could answer, OFFER a web search instead of streaming the refusal.
          // The user's local-only default is preserved — we ask, we don't auto-run.
          if (attempt === 1 && result.outOfScope && result.canWebFallback &&
              useWebSearch && webAutoSuggest && looksWebAnswerable(content)) {
            if (DEBUG) console.log('  🌐 Corpus miss + web-answerable — offering web search');
            pendingWebQuery = content;
            pendingWebFlags = answerFlags;
            pendingWebWs    = turnWs;
            client.emit('web_offer', {
              message: "I don't have anything on that in your documents. Want me to search the web for it?",
              query: content,
            });
            endChat();
            activeAbort = null;
            return;
          }

          let attemptText = '';
          for await (const chunk of result.stream) {
            if (abort.signal.aborted) break;
            attemptText += chunk;
            client.emit('message', chunk);
            stallThisTurn.note();
          }
          // True if the model stalled mid-answer (idle timeout), so this attempt's text is partial. Reflects
          // the CURRENT attempt; a retry overwrites it, so at the accepted answer it is that answer's value.
          truncated = !!(result.genOpts && result.genOpts.truncated);

          if (abort.signal.aborted) break;

          // Meta answers, clarifying questions, and partial-match answers are
          // definitive single-pass responses — never retry them.
          if (result.handled || result.isClarification || result.partial) {
            if (DEBUG) console.log(`  ✅ Definitive answer accepted (no retry)${result.handled ? ' [handled]' : ''}`);
            responseText = attemptText;
            failed = false;
            // A clarifying question isn't a real turn to persist as an answer, but
            // meta/partial responses are — record them below via the normal path.
            if (result.isClarification) {
              // Don't push clarify Q into history as an assistant "answer"; it's a
              // prompt back to the user. Skip history append but keep the UI clean.
              client.emit('sources', sources || []);
              endChat();
              activeAbort = null;
              return;
            }
            break;
          }

          failed = outOfScope || isFailedResponse(attemptText);
          // The regex above is English. A model can refuse IN THE QUESTION'S LANGUAGE ("Je n'ai pas cette
          // information…"), which the regex misses — the refusal would then be treated as a real answer, cached,
          // and never offered a web fallback. For a confidently non-English answer the regex didn't flag, confirm
          // by MEANING: embed it and compare to the refusal prototypes with the cross-lingual embedding model.
          // Bounded, fail-open (any failure leaves the regex result), and it only runs on the rare non-English
          // path — so the English answer path (and the eval) is completely unaffected.
          if (!failed && !outOfScope && require('./langdetect').isLikelyNonEnglish(attemptText)) {
            const emb = require('./embeddings').makeEmbeddings();
            const { embedBounded } = require('./embeddings');
            const rd = require('./refusaldetect');
            const sem = await rd.isSemanticRefusal({
              text: attemptText,
              embed: (t) => embedBounded(emb.embedQuery(t)),
              prototypes: rd.REFUSAL_PROTOTYPES,
              threshold: require('./config').REFUSAL_SIM_THRESHOLD,
            });
            if (sem) { failed = true; if (DEBUG) console.log('  🌐 Non-English answer read as a refusal by meaning — treating as failed (web offer eligible, not cached)'); }
          }
          responseText = attemptText;
          if (outOfScope) break;
          if (!failed) break;

          // If the very first document attempt failed AND no retrieved document is a
          // genuine match (top reranker score is weak/negative), don't burn retries
          // against documents that can't answer it — break out and let the post-loop
          // web offer handle it. But if the reranker found a real match (positive
          // score) and the answer still failed, the answer may be retrievable and the
          // model just fumbled it, so allow the normal retries instead of offering web.
          if (attempt === 1 && useWebSearch && webAutoSuggest && looksWebAnswerable(content) &&
              webOfferGateOk(content, result.topRerankerScore)) {
            if (DEBUG) console.log(`  🌐 First doc attempt failed + web-answerable + ${looksCurrentInfo(content) ? 'live-info query' : `weak match (rerank=${fmtScore(result.topRerankerScore)})`} — skipping further retries`);
            break;
          }

          if (attempt < MAX_ATTEMPTS) {
            if (DEBUG) console.log(`⚠️  Failed attempt ${attempt}/${MAX_ATTEMPTS} — retrying`);
            retryChat();
          }
        }

        // If aborted, don't update history or emit END_OF_CHAT — the reset handler already cleared
        // context and the UI is clean. activeAbort stays live (released in the finally) so a reset
        // during the post-answer persistence tail below is still detected.
        if (abort.signal.aborted) return;

        if (outOfScope) {
          // The refusal was already streamed during the attempt loop. Do NOT persist it
          // as an assistant turn — it isn't an answer, and recording it pollutes history
          // and the rolling summary (a later "recap" would list refusals). Leave the
          // conversation context untouched. (A web offer for an out-of-scope, web-
          // answerable query already happened inside the loop and returned early.)
          if (DEBUG) console.log('  🚫 Out-of-scope — streaming refusal without recording it as a turn');
          client.emit('sources', sources || []);
          if (explainTrace === true && lastTrace) client.emit('retrieval_trace', lastTrace);
          endChat();
          return;
        }

        if (failed) {
          // The query passed the relevance gate but no document actually answered it
          // (all retries failed). Offer a web search only when it looks web-answerable
          // AND either the question is a live/current-info one OR no retrieved document
          // was a genuine match (weak reranker score) — so a retrievable answer the
          // model merely fumbled doesn't get pushed to the web, but a "today's price"
          // question that a topical doc reranked positively still does.
          if (useWebSearch && webAutoSuggest && looksWebAnswerable(content) &&
              webOfferGateOk(content, lastRerankerScore)) {
            if (DEBUG) console.log(`  🌐 Document search exhausted + web-answerable + ${looksCurrentInfo(content) ? 'live-info query' : `weak match (rerank=${fmtScore(lastRerankerScore)})`} — offering web search`);
            retryChat(); // clear the failed attempt text from the UI
            pendingWebQuery = content;
            pendingWebFlags = answerFlags;
            pendingWebWs    = turnWs;
            client.emit('web_offer', {
              message: "I couldn't find anything on that in your documents. Want me to search the web for it?",
              query: content,
            });
            endChat();
            // Reset the doc-search scratch state so the next query starts clean.
            conversationContext.allowedDocIds = null;
            conversationContext.docReadPos    = new Map();
            conversationContext.docPassages   = new Map();
            return;
          }
          consecutiveFailures++;
          if (DEBUG) console.log(`⚠️  Failed after all attempts (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            resetContext(`${consecutiveFailures} consecutive failures`);
          } else {
            conversationContext.allowedDocIds = null;
            conversationContext.docReadPos    = new Map();
            conversationContext.docPassages   = new Map();
          }
        } else {
          consecutiveFailures = 0;
          conversationContext.docExcludePos = new Map();
          // A successful document answer means we've moved off any prior web results —
          // clear stored web pages so a later "tell me more" continues the document,
          // not the stale web context.
          conversationContext.webPages = null;
          // Verify pass + invented-citation caveat via the shared grounded finalizer (the single-sourced
          // sequence the API applies too). It returns the parts; this path emits them in its own order.
          const fin = require('./answerfinalize').finalizeGroundedStreamed(responseText, sources, idx);
          responseText = fin.text;
          if (fin.changed) client.emit('answer_final', responseText);
          conversationContext.history.push(
            { role: 'user', content },
            { role: 'assistant', content: responseText, sources: leanSources(sources) }
          );
          // Citation guard (computed above by the shared finalizer): if the answer names a document that was
          // not among the retrieved sources (an invented citation), show a short caveat on the bubble. Kept
          // out of stored history so it doesn't feed back into later turns.
          if (fin.caveat) {
            client.emit('message', fin.caveat);
            if (DEBUG) console.log('  ⚠️  Answer cited a document not in the retrieved sources — caveat appended');
          }
          // If the model stalled mid-answer, tell the user the answer may be incomplete (a UI-only caveat,
          // kept out of stored history), and do NOT cache it below — otherwise a partial answer would be
          // served instantly, as if complete, on a repeat of the same question.
          if (truncated) {
            try { client.emit('message', require('./llm').TRUNCATION_NOTICE); } catch {}
            if (DEBUG) console.log('  ⚠️  Answer was truncated by an LLM idle timeout — caveat appended, not cached');
          }
          // Compress older turns into a running summary (bounds memory and lets
          // follow-ups reference earlier discussion). Replaces the hard slice.
          await updateConversationSummary(conversationContext, abort && abort.signal);
          // The summary is the last long await before persistence. If the user hit New during it,
          // stop here: don't re-save the conversation the reset just cleared, and don't emit sources
          // or chat_end into the cleared UI. The finally releases activeAbort.
          if (abort.signal.aborted) return;
          // Persist the durable conversation so a refresh/reconnect can restore it.
          if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);
          // Store this fresh, standard answer for an instant repeat (semantic cache, opt-in).
          // Only reached for a landed answer; the guards were fixed at turn start.
          if (scCacheable && responseText && !truncated) {
            // Fire-and-forget: the async write must never delay the answer or throw into it. A truncated
            // (idle-timed-out) answer is never cached — it must not be replayed as if it were complete.
            Promise.resolve(require('./semanticcache').store(wsCacheDir(), { fingerprint: scFp, signature: scSig, query: content, answer: responseText, sources }))
              .catch(() => { /* cache is best-effort */ });
          }
        }

        client.emit('sources', sources);
        // Rating buttons (Learn), the "Why this answer?" trace (Explain), and the
        // faithfulness badge (Verify) — emitted after sources so they attach to this
        // answer's row, and shared with the web/research paths via emitAnswerMeta so no
        // path can silently drop them. lastTrace is null unless Explain was on (search.js
        // returns no trace otherwise) and the retrieval produced one; a failed answer is
        // gated inside the helper (no outcome record, no faithfulness).
        await emitAnswerMeta({ query: content, answer: responseText, sources, trace: lastTrace, topReranker: lastRerankerScore, crossLingual: lastCrossLingual, failed, idx, flags: answerFlags, getMessages: lastGetMessages, signal: abort && abort.signal, abortController: abort });
        endChat();
      } catch (error) {
        if (abort && abort.signal.aborted) return;   // a Stop/New aborted the turn — not a failure to report
        console.error('Error handling message:', error);
        // A provider that isn't reachable (Ollama not running, a bad/absent key) is the common real cause here —
        // say so clearly and actionably in the chat, rather than a generic error toast. Anything else keeps the
        // generic notice (details stay in the server log, never leaked to the client).
        if (!emitProviderDownIfApplicable(client, error)) client.emit('error', 'Processing failed');
        endChat();
      } finally {
        // Release this turn's controller on every exit path (dropping any scratch state a reset wrote after
        // the clear), but only if activeAbort is still ours — a reset or newer turn may have replaced it.
        releaseTurn(abort);
        if (turnStallHolder.current) { turnStallHolder.current.stop(); turnStallHolder.current = null; }
      }
    }));

    client.on('disconnect', () => {
      try {
        if (activeAbort) { activeAbort.abort(); activeAbort = null; }
        abortBackgroundJobs();   // the client is gone — cancel any post-answer background generations
        clearInterval(statusInterval);
        if (DEBUG) console.log('Client disconnected:', client.handshake.address);
      } catch (e) { if (DEBUG) console.log(`  disconnect cleanup failed: ${e && e.message}`); }
    });

    // Summarize a specific document — bypasses retrieval entirely. The user has
    // pointed at one document, so there's nothing to search for and no relevance
    // gate to apply: we load that document's content straight from parentMap and
    // stream a summary. This is what makes "what's this about?" work regardless of
    // corpus size or how keyword-sparse the document is — the earlier attempt to
    // solve that inside the retrieval gates was abandoned as too fragile.
    client.on('summarize_document', (raw) => runExclusive(async () => {
      // Hoisted so the finally can release activeAbort and re-clear on every exit path, exactly like
      // the other generating handlers — even though this path currently writes no scratch state before
      // its stream succeeds, keeping the contract uniform means a future persistence tail here can't
      // reintroduce a leak or a resurrected turn.
      let abort = null;
      try {
        const payload = parsePayload(raw);
        // Summarize a document from the workspace THIS window is viewing (a loaded bundle when non-active).
        // Summarizing exposes document content, so it needs doc.read — the same scope the HTTP /summarize
        // endpoint requires (an API key with only 'search' scope can chat but not summarize).
        const turn = await resolveTurn(payload, 'doc.read');
        if (turn.status === 'forbidden') {
          client.emit('message', '🔒 You do not have access to this workspace.');
          endChat();
          return;
        }
        if (turn.status === 'warming') {
          client.emit('message', '⏳ Preparing that workspace — please try again shortly.');
          endChat();
          return;
        }
        // A New (reset) landed during the workspace load — discard this turn quietly (the client already
        // cleared its own UI on New; emitting anything here would resurrect the cleared conversation).
        if (turn.status === 'superseded') return;
        const idx = turn.idx;
        const docId = payload.docId;
        if (!docId || !idx.parentMap.has(docId)) {
          // For the ACTIVE workspace a (re)build empties the maps momentarily (indexing true); show
          // "building" then rather than "couldn't find". A non-active bundle is a static ready snapshot,
          // so a missing doc there is genuinely missing.
          client.emit('message', (turn.isActive && state.indexing)
            ? buildingIndexNotice()
            : "I couldn't find that document to summarize.");
          endChat();
          return;
        }
        if (turn.isActive && !state.indexReady) {
          client.emit('message', buildingIndexNotice());
          endChat();
          return;
        }

        const { streamChat } = require('./llm');
        const path = require('path');
        const { buildSummaryRequest } = require('./summarize');

        const entry = idx.parentMap.get(docId);
        const req   = buildSummaryRequest(entry, { persona: require('./config').personaFor(turnWs) });
        const name  = req.name;

        if (req.empty) {
          client.emit('message', `**${name}** appears to be empty — there's no text to summarize.`);
          endChat();
          return;
        }

        abort = beginTurnAbort();
        if (abort.signal.aborted) return;   // a Stop landed before this turn's controller existed
        // The client may have disconnected while the workspace bundle warmed (the resolveTurn await
        // above). The disconnect fired before this controller existed, so bail rather than stream a full
        // summary to a dead socket and hold the serialized queue for it. The finally releases cleanly.
        if (!client.connected) return;
        let responseText = '';
        // Attribute a long summary to the model pass (naming the document), so a stall here is distinguishable
        // from retrieval or a web fetch.
        const summaryStall = newTurnStall();
        summaryStall.start(`summarizing ${name}`);
        // Thread the abort signal so a New/disconnect cancels the provider request immediately, instead
        // of waiting for the next token to reach this loop's abort check (a stalled model would otherwise
        // keep generating for the full idle timeout).
        try {
          for await (const chunk of streamChat(req.messages, { signal: abort.signal })) {
            if (abort.signal.aborted) break;
            responseText += chunk;
            client.emit('message', chunk);
            summaryStall.note();
          }
        } finally { summaryStall.stop(); }
        // If the user hit "New" mid-stream, reset already cleared history + the session;
        // don't resurrect them by pushing this (partial) turn and re-saving. The finally releases.
        if (abort.signal.aborted) return;
        // Same deterministic egress pass as the main answer path: strip exfil/invisible
        // controls and decline a system-prompt leak (a crafted document could otherwise
        // pass those straight through a summary). Swaps the rendered text if it changed.
        responseText = finalizeAnswer(responseText);

        // Record the exchange in history and scope follow-ups ("tell me more") to
        // this document, so a follow-up continues the summary instead of running a
        // fresh keyword search that might miss a sparse document.
        conversationContext.history.push(
          { role: 'user', content: `Summarize ${name}` },
          { role: 'assistant', content: responseText, sources: [{ id: docId, source: name }] }
        );
        conversationContext.allowedDocIds = [docId];
        // A landed local answer means we've moved off any prior web results, so a later "tell me more"
        // continues THIS document's summary rather than re-answering from stale web pages (the web-
        // continuation gate fires on any non-empty webPages). Mirrors the main document-answer path.
        conversationContext.webPages = null;
        // This path skips updateConversationSummary, so bound the live history here — the same invariant the
        // cache-hit and synthesis paths enforce, so repeated summarize clicks can't grow history past the cap.
        capHistory(conversationContext);
        if (sessionId) saveSession(sessionId, conversationContext, sessPrincipalKey);

        client.emit('sources', [{
          id: docId,
          source: name,
          fileType: entry.metadata?.fileType,
          viewerLink: viewerLink(entry.metadata?.source),
          passageStart: 0,
          passageEnd: (entry.content || '').length,
          docLength: entry.metadata?.docLength ?? (entry.content || '').length,
          ...(entry.metadata?.credibility ? { credibility: entry.metadata.credibility } : {}),
        }]);
        // This path has no answer_turn event, so carry the answer language on chat_end instead. The client
        // reads it before finalizing the turn, so Read aloud still picks the right voice for a summary.
        endChat(detectLanguage(responseText) || '');
      } catch (error) {
        if (abort && abort.signal.aborted) return;   // a Stop/New aborted the turn — not a failure to report
        console.error('Error summarizing document:', error);
        client.emit('message', 'Something went wrong summarizing that document.');
        endChat();
      } finally {
        // Release this turn's controller on every exit path (including the catch), and drop any scratch
        // state written after a mid-turn reset — uniform with the other generating handlers.
        releaseTurn(abort);
      }
    }));

    // Whole-workspace synthesis — "brief me on this workspace / common themes across
    // these documents". Map-reduce lives in api-core (summarize each doc, then one
    // synthesis pass); the handler streams the final synthesis to the chat and records
    // it so follow-ups ("tell me more") continue from it. Can be slow on a large
    // workspace — the user is told it's working across N documents up front.
    client.on('synthesize_workspace', (raw) => runExclusive(async () => {
      // Wrap the whole handler like its siblings: runExclusive swallows a rejection, so without this a
      // malformed payload (bad JSON) or a synthesis error would leave the "generating" spinner stuck with
      // no feedback. On any failure, tell the user and end the turn.
      try {
        const payload = parsePayload(raw);
        // Synthesize the workspace THIS window is viewing. Set turnWs so runWorkspaceSynthesisToChat (and
        // the outcome recording in emitAnswerMeta) target it; runWorkspaceSynthesis resolves that
        // workspace's own bundle, so a non-active workspace is synthesized from its correct corpus.
        // An existing workspace only (see resolveTurnWs) — a spoofed valid-format id falls back to active.
        turnWs = resolveTurnWs(payload);
        // Enforce per-workspace access, exactly as the `message` handler does: synthesis streams the whole
        // corpus of turnWs, so a member with no role there (or a key outside its allow-list) must be refused.
        // Synthesis reads across the whole corpus, so it needs doc.read — matching the HTTP /synthesize scope
        // (an API key with only 'search' scope can chat but not synthesize the workspace).
        if (!mayUseWorkspace(turnWs, 'doc.read')) { client.emit('message', '🔒 You do not have access to this workspace.'); endChat(); return; }
        const focus = typeof payload.focus === 'string' ? payload.focus : '';
        // Cap the free-text focus, matching the HTTP /synthesize endpoint (same shared MAX_QUERY_CHARS) so the
        // two surfaces enforce the same limit — an over-long focus is declined with a clear message, not run.
        const MAX_QUERY_CHARS = require('./constants').MAX_QUERY_CHARS;
        if (focus.length > MAX_QUERY_CHARS) {
          client.emit('message', `That focus is too long (${focus.length.toLocaleString()} characters; the limit is ${MAX_QUERY_CHARS.toLocaleString()}). Please shorten it.`);
          endChat();
          return;
        }
        const format = typeof payload.format === 'string' ? payload.format : 'overview';
        // The ✦ Generate button is a direct action with no composer toggles, so it gets outcome-aware
        // rating buttons by default (respecting an explicit opt-out if one is ever sent). Verify and
        // suggestions stay off — a synthesis has no sources to verify and the button isn't a question.
        await runWorkspaceSynthesisToChat({ focus, format, flags: { outcomesEnabled: payload.outcomes !== false } });
      } catch (error) {
        console.error('Error in synthesize_workspace handler:', error);
        try { client.emit('message', 'Something went wrong generating this workspace overview.'); } catch {}
        endChat();
      }
    }));

    // Extraction Tables — extract a user-defined set of fields from every document (or the selected ones)
    // into a cited matrix. This is a tool action, NOT a chat turn: it does not stream into the chat thread
    // or record history, so there is no endChat()/thinking bubble here — the extraction panel shows its own
    // live progress. It still runs under runExclusive (never two heavy local-model jobs at once) and under
    // an abort controller so New — or the panel's Cancel (extract_cancel) — stops a long run promptly.
    // Rows are emitted to the requesting client only (never broadcast), each one as it is computed, so the
    // table fills live; the client already has every row by the time 'extract_done' summarizes the run.
    client.on('extract_table', (raw) => runExclusive(async () => {
      let abort = null;
      try {
        const payload = parsePayload(raw);
        turnWs = resolveTurnWs(payload);
        // Reading across the workspace's documents needs doc.read — the same scope synthesis requires.
        if (!mayUseWorkspace(turnWs, 'doc.read')) { client.emit('extract_error', { error: 'You do not have access to this workspace.' }); return; }
        const columns = Array.isArray(payload.columns) ? payload.columns : [];
        const selectedDocIds = Array.isArray(payload.selectedDocIds) && payload.selectedDocIds.length ? payload.selectedDocIds : null;
        abort = beginTurnAbort();
        if (abort.signal.aborted) return;   // a Stop landed before this turn's controller existed
        const { runExtractionTable } = require('./api-core');
        const onColumns = (cols) => { if (!abort.signal.aborted) { try { client.emit('extract_columns', { columns: cols }); } catch {} } };
        const onProgress = (p) => { if (!abort.signal.aborted) { try { client.emit('extract_progress', { processed: p.processed, total: p.total, current: p.current }); } catch {} } };
        const onRow = (row) => { if (!abort.signal.aborted) { try { client.emit('extract_row', row); } catch {} } };
        const r = await runExtractionTable(turnWs, columns, { selectedDocIds, signal: abort.signal, onColumns, onProgress, onRow });
        if (abort.signal.aborted) return;
        if (r.status === 'no_columns') { client.emit('extract_error', { error: 'Add at least one column to extract.' }); return; }
        if (r.status === 'warming')    { client.emit('extract_error', { error: 'The workspace is still preparing — please try again shortly.' }); return; }
        if (r.status === 'empty')      { client.emit('extract_error', { error: 'There are no documents in this workspace to extract from yet.' }); return; }
        if (r.status === 'aborted')    return;
        client.emit('extract_done', { columns: r.columns, totalDocs: r.totalDocs, processed: r.processed, omittedDocs: r.omittedDocs, truncatedAny: r.truncatedAny });
      } catch (error) {
        if (abort && abort.signal.aborted) return;   // a Stop/New aborted the run — not a failure to report
        console.error('Error in extract_table handler:', error);
        try { client.emit('extract_error', { error: 'Something went wrong extracting the table.' }); } catch {}
      } finally {
        releaseTurn(abort);
      }
    }, { stoppable: false }));
    // Cancel a running extraction from the panel's Cancel button, without clearing the chat the way New does:
    // abort the active turn's controller (the extraction is the active turn while it runs).
    client.on('extract_cancel', () => {
      try {
        if (activeAbort && !activeAbort.signal.aborted) {
          // Canceling a table run must not clear the chat conversation, unlike New. Tag it, then abort.
          abortReason.set(activeAbort, ABORT_CANCEL);
          activeAbort.abort();
        }
      } catch { /* best-effort */ }
    });
  });
};

// Close the socket.io server on shutdown: disconnects every client (which fires each
// connection's `disconnect` handler, clearing its 2s status interval) and stops
// accepting new ones. Resolves once closed; a no-op if the server never started.
const closeSocket = () => new Promise((resolve) => {
  if (!_io) return resolve();
  try { _io.close(() => resolve()); } catch { resolve(); }
});

module.exports = { initSocket, broadcast, closeSocket,
  // Exported as a test seam: the degenerate-answer heuristic that decides whether to retry a reply.
  _isDegenerate: isDegenerate };
