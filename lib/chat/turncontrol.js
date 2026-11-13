'use strict';
// The turn-control protocol: the event names the browser and the server must agree on.
//
// A turn ends in exactly one of three ways. The server is the single source of truth for all
// three, and the browser only renders what the server reports:
//   - `end`      — the turn finished (an answer, a refusal, a notice, or a failure);
//   - `stopped`  — the turn ended because the user pressed Stop;
//   - disconnect — no event reaches the browser, which resets its own UI.
//
// The server requires this module directly; the chat page receives the same frozen object as
// JSON at render time (see views/chat.ejs and server.js). A rename therefore cannot update one
// side only. The browser keeps literal fallbacks so a page rendered without the hand-off still
// works; a unit test asserts those fallbacks are byte-for-byte what this module exports.
//
// Only the turn-ending protocol lives here, because losing one of these events strands a whole turn.
// The other chat events (sources, answer_confidence, web_offer, the extract_* family, and so on) stay
// plain string literals on both ends — centralizing all of them would churn two large files for little
// gain. They are kept from drifting instead by test/unit/socket-event-names.test.js, which checks that
// every server-emitted event has a browser listener and vice versa. Add a new event as a literal and that
// guard covers it; reach for this module only for a new turn-ending signal.
const TURN_PROTOCOL = Object.freeze({
  stop:     'chat_stop',      // browser → server: cancel the in-flight turn
  stopped:  'chat_stopped',   // server → browser: the turn ended because the user stopped it
  end:      'chat_end',       // server → browser: the turn ended (normal, refusal, or failure)
  progress: 'synth_progress', // server → browser: human-readable progress for a long-running turn
});

module.exports = { TURN_PROTOCOL };
