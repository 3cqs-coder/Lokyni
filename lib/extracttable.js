'use strict';
// Extraction Tables — pull a user-defined set of fields ("columns") from every document into a cited
// matrix. Each row is one document; each cell is the model's answer for that column, grounded in that
// document's own text, with a short verbatim evidence snippet so the value is checkable — and honestly
// empty when the document doesn't say. This module holds the per-document piece (prompt + schema + parse);
// api-core.runExtractionTable enumerates the workspace's documents and calls it in a bounded, cancellable,
// progress-reporting loop (the same shape as runWorkspaceSynthesis, minus the reduce step).

const path = require('path');

// Derive a stable, safe JSON key from a human column label, so an odd label ("Sample size (n)") can't
// break the response schema or collide. The index keeps keys unique even when two labels normalize alike.
const columnKey = (label, i) => {
  const base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (base ? `c${i}_${base}` : `c${i}`).slice(0, 48);
};

// Normalize + BOUND the user's column list: trim, collapse whitespace, drop blanks, cap the count and each
// label's length, and assign a unique key. Returns [{ key, label }]. The caps keep the prompt and the
// response schema bounded no matter what a client sends.
const MAX_COLUMNS = 12;
const MAX_LABEL_CHARS = 80;
const normalizeColumns = (columns) => {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(columns) ? columns : []) {
    const label = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
    if (!label) continue;
    const key = columnKey(label, out.length);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
    if (out.length >= MAX_COLUMNS) break;
  }
  return out;
};

// The JSON Schema the model is constrained to: an object with one property per column, each a
// { value, evidence } pair. strict:false is applied provider-side (see llm._formatOpts), so a model that
// adds or omits a key still parses — the per-cell normalization below fills any gap.
const buildSchema = (cols) => {
  const props = {};
  for (const c of cols) {
    props[c.key] = { type: 'object', properties: { value: { type: 'string' }, evidence: { type: 'string' } } };
  }
  return { type: 'object', properties: props };
};

// Build the extraction prompt for ONE document. The document text is fenced as UNTRUSTED (the same
// discipline every content-bearing prompt uses) so an instruction hidden inside a document can't redirect
// the extraction. The model is told to answer ONLY from this document and to leave a field empty rather
// than guess — the honesty posture the rest of the app enforces. Returns { name, messages, empty, truncated }.
const buildExtractRequest = (entry, cols, opts = {}) => {
  const { buildMessages } = require('./llm');
  const { extractionMaxCharsPerDoc } = require('./config');
  const name = path.basename(entry?.metadata?.source || 'document');
  const full = entry?.content || '';
  const cap = Math.max(500, extractionMaxCharsPerDoc);
  const content = full.slice(0, cap);
  const truncated = full.length > cap;
  if (!content.trim()) return { name, messages: null, empty: true, truncated: false };

  const fieldList = cols.map((c) => `- "${c.key}": ${c.label}`).join('\n');
  const question =
    'From the document above, extract the following fields. Return a JSON object whose keys are EXACTLY the ' +
    'field keys listed below. Each value is an object: { "value": the extracted text (or "" if the document ' +
    'does not state it), "evidence": a short verbatim quote from the document that supports the value (or "") }. ' +
    'Use ONLY what this document actually says — do not guess or draw on outside knowledge. Leave a field empty ' +
    'rather than inventing a value.\n\nFields:\n' + fieldList +
    (truncated ? '\n\n(Note: only the first part of a longer document is shown.)' : '');

  // Per-workspace persona is threaded through for tone parity with summarize/synthesize; it never changes
  // the grounding rules. buildMessages fences the document content itself.
  const messages = buildMessages(`[${name}]\n${content}`, [], question, '', { persona: opts.persona });
  return { name, messages, empty: false, truncated };
};

// Extract one document's row. Returns { name, cells: { <key>: { value, evidence } }, empty?, truncated }.
// Every cell is egress-sanitized (strip invisible/bidi control chars) and length-bounded so an untrusted
// document can't push huge or spoofing text into the table. Never throws for a content reason — a parse
// miss yields empty cells, not an error, so one odd document can't abort the whole run.
const MAX_CELL_CHARS = 2000;
const extractRow = async (entry, cols, opts = {}) => {
  const req = buildExtractRequest(entry, cols, opts);
  if (req.empty) return { name: req.name, cells: {}, empty: true, truncated: false };
  const { completeJson } = require('./llm');
  const { stripInvisibleChars } = require('./constants');
  const schema = buildSchema(cols);
  const obj = (await completeJson(req.messages, { schema, schemaName: 'extraction', signal: opts.signal })) || {};
  const clean = (s) => stripInvisibleChars(String(s == null ? '' : s)).trim().slice(0, MAX_CELL_CHARS);
  const cells = {};
  for (const c of cols) {
    const raw = obj[c.key];
    if (raw && typeof raw === 'object') cells[c.key] = { value: clean(raw.value), evidence: clean(raw.evidence) };
    else cells[c.key] = { value: clean(raw), evidence: '' };   // a model that returned a bare string for the field
  }
  return { name: req.name, cells, truncated: req.truncated };
};

module.exports = { normalizeColumns, columnKey, buildSchema, buildExtractRequest, extractRow, MAX_COLUMNS, MAX_LABEL_CHARS };
