'use strict';

// ── registry — a tiny self-registering check registry ────────────────────────
//
// Shared plumbing for the two check registries: the always-on answer verification
// (lib/verify.js) and the boot-integrity watchdog (lib/watchdog.js). Both let checks
// register themselves by name and run them all; only that registration/listing is common,
// so this factory owns it and each caller keeps its own runner — verify runs synchronously
// and composes violations onto an answer, the watchdog runs async and logs findings.
//
// makeRegistry() returns { items, register, list }:
//   • items    — the live [{ name, fn }] array the caller's runner iterates.
//   • register — idempotent by name (re-registering replaces), so requiring a module more
//                than once never double-runs a check; returns the new count.
//   • list     — the registered names, for introspection/tests.

function makeRegistry() {
  const items = [];
  return {
    items,
    register(name, fn) {
      if (name && typeof fn === 'function') {
        const i = items.findIndex(x => x.name === name);
        if (i >= 0) { items[i] = { name, fn }; } else { items.push({ name, fn }); }
      }
      return items.length;
    },
    list() { return items.map(x => x.name); },
  };
}

module.exports = { makeRegistry };
