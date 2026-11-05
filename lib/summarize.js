'use strict';
// Shared document-summarization core.
//
// Both the chat UI (socket 'summarize_document', streaming to the browser) and the
// public API (/api/v1/summarize, one-shot JSON or SSE) summarize a single document
// by handing its content directly to the model — no retrieval, no relevance gates.
// This module holds the one piece they share: turning a document into the prompt
// messages. The transport (stream-to-socket vs. return-JSON vs. SSE) stays with
// each caller.

const path = require('path');

// Build the summary prompt for a document entry (a parentMap value: { content,
// metadata }). Returns { name, messages, empty, truncated } — `empty` true means
// there's nothing to summarize and the caller should say so.
const buildSummaryRequest = (entry, opts = {}) => {
  const { buildMessages } = require('./llm');
  const { PASSAGE_SIZE } = require('./config');

  const name = path.basename(entry?.metadata?.source || 'document');
  const full = entry?.content || '';

  // Cap so a large document stays within the context window. The opening carries
  // the "what is this about" signal; summaries don't need the whole tail.
  const SUMMARY_MAX_CHARS = Math.max(PASSAGE_SIZE * 3, 24000);
  const content = full.slice(0, SUMMARY_MAX_CHARS);
  const truncated = full.length > SUMMARY_MAX_CHARS;

  if (!content.trim()) return { name, messages: null, empty: true, truncated: false };

  const question = truncated
    ? 'Summarize what this document is about. (Note: only the first part of a longer document is shown.)'
    : 'Summarize what this document is about.';

  // Thread a per-workspace persona through so a summary requested from a non-active workspace uses that
  // workspace's tone (opts.persona); omitted → buildMessages falls back to the active persona, unchanged.
  const messages = buildMessages(`[${name}]\n${content}`, [], question, '', { persona: opts.persona });
  return { name, messages, empty: false, truncated };
};

// One-shot summary: drains the model stream into a single string. Used by the API's
// non-streaming path. Returns { name, summary, truncated } or { name, empty:true }.
const summarizeToString = async (entry, opts = {}) => {
  // Forward opts (e.g. persona) so a one-shot summary from a non-active workspace uses that workspace's tone,
  // matching the streaming path — buildSummaryRequest reads opts.persona.
  const req = buildSummaryRequest(entry, opts);
  if (req.empty) return { name: req.name, empty: true };
  const { completeChat } = require('./llm');
  const raw = await completeChat(req.messages, opts || {});
  // Finalize before returning, so EVERY non-streaming consumer (the /api/v1/summarize JSON path and the MCP
  // summarize_document tool) gets the SAME post-answer pass the in-app streaming summary applies — egress
  // sanitize, the system-prompt-leak canary, and the arithmetic corrector — not just egress sanitize. A
  // summary is generated from an UNTRUSTED document and can echo dangerous invisibles (zero-width / bidi
  // Trojan-Source characters), exfiltration markup (a remote image whose URL carries leaked text), a leaked
  // untrusted-content fence marker, or coaxed-out rule text straight to a downstream client that — unlike
  // Lokyni's own renderer — may render it. finalize() is a superset of sanitizeEgress and never throws; it is
  // single-sourced here so a consumer can't forget it.
  const summary = require('./verify').finalize(raw || '');
  return { name: req.name, summary, truncated: req.truncated };
};

module.exports = { buildSummaryRequest, summarizeToString };
