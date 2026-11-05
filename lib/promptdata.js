'use strict';

// ── promptdata — loader for the AI prompt/text that ships with the code ───────
//
// The model-facing prompt wording (grounding rules, persona, per-mode notes) and the
// fixed user-facing strings the verification layer emits live as plain text files under
// lib/ai/data/, not buried in template literals across the code. Keeping them in one
// reviewable place makes the prompt auditable and editable without hunting through logic,
// and a stray backtick can't break a module. These files are part of the SHIPPED CODE
// (lib/ is read-only at runtime — never user data under data/), so a single operator's
// wording is the same for everyone and upgrades replace them cleanly.
//
// Files are read once and cached. The single trailing newline every text file carries is
// trimmed, so a loaded string equals the exact prose with no format drift.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'ai', 'data');
const cache = new Map();

// Read a prompt/text file by name (e.g. 'grounding-rules.txt'). Returns '' if it is missing or
// unreadable — a caller composing a prompt should never crash over a data file. But a silent '' is
// dangerous for a SHIPPED file: a packaging error that omits lib/ai/data/ from the desktop sidecar or the
// Docker image would otherwise make every answer lose its grounding rules AND disable the system-prompt-leak
// canary (both read grounding-rules.txt) with no operator-visible signal. So warn LOUDLY when an expected
// prompt file can't be read, rather than degrade in silence. Still never throws (degrade, don't die); the
// warning is the diagnosable signal. Logged once per file (the result is cached, so this runs on first read).
function read(name) {
  if (cache.has(name)) return cache.get(name);
  let text = '';
  try { text = fs.readFileSync(path.join(DIR, name), 'utf-8').replace(/\r?\n$/, ''); }
  catch (e) {
    text = '';
    try { console.warn(`⚠️  Prompt data file "${name}" could not be read (${e && e.message}). Grounding and safety prompts that rely on it are degraded — check that lib/ai/data/ shipped in this build.`); } catch (_) {}
  }
  cache.set(name, text);
  return text;
}

module.exports = { read };
