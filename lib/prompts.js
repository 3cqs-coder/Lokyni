'use strict';
// Prompt / template library — reusable, parameterized prompts the user inserts into the
// composer with a "/" picker (mirroring the existing "#" document picker). Stored
// globally (install-wide, not per-workspace) since templates are reused everywhere.
//
// A template body may contain {variable} tokens. Built-in variables ({date}, {time},
// {workspace}) resolve automatically at insert time; any other {token} is a user-filled
// placeholder the composer selects for typing over. Deliberately small — a handful of
// good built-in starters, not a knob farm (the "sane defaults" posture).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const storePath = () => path.join(cfg.DATA_DIR, 'prompt-templates.json');

// Seeded on first run so the library isn't an empty box. These are ordinary templates
// once seeded (editable and removable); `builtin:true` only lets the UI label them.
const BUILTINS = [
  { name: 'Summarize',            body: 'Summarize the key points about {topic} in clear bullet points.' },
  { name: 'Action items',         body: 'List every action item, decision, and owner mentioned about {topic}.' },
  { name: 'Contract obligations', body: 'Extract each obligation, deadline, and responsible party regarding {topic}, and flag anything ambiguous.' },
  { name: 'Timeline',             body: 'Build a chronological timeline of the events related to {topic}, with dates.' },
  { name: 'Explain simply',       body: 'Explain {topic} in plain language, as if to someone new to the subject.' },
];

const load = () => {
  try {
    const arr = JSON.parse(fs.readFileSync(storePath(), 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return null;   // null distinguishes "file missing" (→ seed) from "empty list"
  }
};

const save = (templates) => {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  require('./disk').writeFileAtomic(storePath(), JSON.stringify(templates, null, 2));
};

const newId = () => 'p_' + crypto.randomBytes(4).toString('hex');

// Bound the store so an admin can't grow the prompts file without limit (keeps the JSON small and the Settings
// list manageable). A body is truncated to the cap (like the name); the count is capped on add.
const MAX_BODY_CHARS = 8000;
const MAX_TEMPLATES = 200;

// All templates. Seeds the built-in starters on the first ever call (missing file).
const list = () => {
  let templates = load();
  if (templates === null) {
    templates = BUILTINS.map(b => ({ id: newId(), name: b.name, body: b.body, builtin: true, created: Date.now() }));
    save(templates);
  }
  return templates;
};

const add = ({ name, body } = {}) => {
  name = String(name || '').trim().slice(0, 80);
  body = String(body || '').trim().slice(0, MAX_BODY_CHARS);
  if (!name) throw new Error('Template needs a name.');
  if (!body) throw new Error('Template needs a body.');
  const templates = list();
  if (templates.length >= MAX_TEMPLATES) throw new Error(`At most ${MAX_TEMPLATES} templates. Delete some first.`);
  const rec = { id: newId(), name, body, created: Date.now() };
  templates.push(rec);
  save(templates);
  return rec;
};

const update = (id, { name, body } = {}) => {
  const templates = list();
  const rec = templates.find(t => t.id === id);
  if (!rec) throw new Error('No such template.');
  if (name !== undefined) { const n = String(name).trim().slice(0, 80); if (n) rec.name = n; }
  if (body !== undefined) { const b = String(body).trim().slice(0, MAX_BODY_CHARS); if (b) rec.body = b; }
  save(templates);
  return rec;
};

const remove = (id) => {
  const templates = list();
  const next = templates.filter(t => t.id !== id);
  if (next.length === templates.length) return false;
  save(next);
  return true;
};

// Re-add any built-in starter that is currently missing (matched by name, case-insensitively), so deleting
// the built-ins is recoverable — the one-time seed in list() only runs when the file is absent. Never touches
// or duplicates the user's own templates or a still-present built-in. Returns how many were restored.
const restoreBuiltins = () => {
  const templates = list();
  const have = new Set(templates.map(t => String(t.name || '').trim().toLowerCase()));
  let added = 0;
  for (const b of BUILTINS) {
    if (have.has(b.name.toLowerCase())) continue;
    templates.push({ id: newId(), name: b.name, body: b.body, builtin: true, created: Date.now() });
    added++;
  }
  if (added) save(templates);
  return { added, templates };
};

module.exports = { list, add, update, remove, restoreBuiltins };
