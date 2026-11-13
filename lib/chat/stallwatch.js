'use strict';
// Stall attribution for a generation turn. A long silence is not actionable on its own — "still working" does
// not say whether the model, the reranker, embeddings, or a web fetch is the bottleneck. This tracker watches
// the stage a turn last announced and, when nothing has moved for a threshold, reports WHICH stage is stalled
// (and for how long) exactly once per silence stretch.
//
// Cheap by design: note() is O(1) and touches no timer (so it is safe to call for every streamed token); one
// timer guards the whole turn and re-arms itself only when it fires. Pure timing logic with injected clock and
// timer functions, so it is unit-tested without waiting in real time. Never throws.

const DEFAULT_THRESHOLD_MS = 45000;   // long enough to ignore a normal first-token wait; short enough to be useful

const create = ({ onStall, thresholdMs = DEFAULT_THRESHOLD_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) => {
  let active = false;
  let stage = '';
  let startedAt = 0;
  let lastSignalAt = 0;
  let timer = null;
  let armed = false;      // a timer is pending (so note() does not churn timers on every token)
  let reported = false;   // a stall was already reported for this silence stretch

  const arm = (delay) => {
    if (timer) { try { clearTimer(timer); } catch { /* already gone */ } }
    armed = true;
    timer = setTimer(() => {
      timer = null;
      armed = false;
      if (!active) return;
      const silent = now() - lastSignalAt;
      if (silent < thresholdMs) { arm(thresholdMs - silent); return; }   // a token arrived; wait out the rest
      if (reported) return;   // already surfaced this stretch
      reported = true;
      try {
        if (typeof onStall === 'function') onStall({ stage: stage || 'the model', elapsedMs: silent, totalMs: now() - startedAt });
      } catch { /* attribution is advisory — never break the turn */ }
    }, Math.max(0, delay));
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  return {
    // Begin watching a turn. `initialStage` names what is happening before any stage is announced.
    start(initialStage = '') {
      active = true;
      stage = String(initialStage || '');
      startedAt = lastSignalAt = now();
      reported = false;
      arm(thresholdMs);
    },
    // Liveness signal (a token, a progress line, or a new stage). Passing a stage names the phase; passing
    // nothing means "still moving in the current phase". No timer work, so per-token calls are free.
    note(nextStage) {
      if (!active) return;
      lastSignalAt = now();
      reported = false;
      if (nextStage) stage = String(nextStage);
      // Re-arm only when no timer is pending. This is what keeps per-token calls free: the pending timer will
      // itself notice the new signal and wait out the remainder.
      if (!armed) arm(thresholdMs);
    },
    stop() {
      active = false;
      if (timer) { try { clearTimer(timer); } catch { /* already gone */ } }
      timer = null;
      armed = false;
    },
    // Introspection for tests/diagnostics.
    get stage() { return stage; },
    get active() { return active; },
  };
};

module.exports = { create, DEFAULT_THRESHOLD_MS };
