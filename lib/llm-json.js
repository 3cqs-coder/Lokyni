'use strict';
// Shared helpers for the small "LLM-as-judge" call sites — intent classification,
// query rewriting, and faithfulness scoring. Each wraps a completeChat() call the same
// two ways: bound it with a timeout, and pull a JSON object out of a response that may
// be wrapped in code fences or surrounded by prose. Kept in one place so the call sites
// share a single implementation instead of re-deriving it.

// Reject if `promise` doesn't settle within `ms`. `label` names the caller in the error.
const withTimeout = (promise, ms, label = 'operation') =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();   // never let a pending timeout hold the loop open
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });

// Best-effort repair of a JSON object truncated by the model's token-limit cutoff — the common aux-model
// failure: the model runs past its maxTokens mid-value, leaving an unterminated string and unclosed braces.
// Because the fields that DID complete come first in the object, closing the dangling string and balancing the
// open {}/[] recovers them. Walks the text once tracking string/escape state and a delimiter stack; pure,
// bounded by the input length, never throws. Returns a string to attempt parsing.
const closeTruncatedJson = (s) => {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = inStr ? s + '"' : s;                     // close a string cut mid-value
  out = out.replace(/\s*[,:]\s*$/, '');              // a cut right after a comma or colon
  out = out.replace(/,\s*"[^"\\]*"\s*$/, '');        // a cut right after a dangling key (no value yet)
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];   // balance open containers, innermost first
  return out;
};

// Pull the first JSON object out of a model response, tolerating code fences and surrounding prose. If the
// response was truncated by a token cutoff, recover the fields that completed before the cut. Returns null if
// nothing parseable can be recovered.
const extractJson = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  const end = s.lastIndexOf('}');
  if (end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch { /* fall through to repair */ } }
  try { return JSON.parse(closeTruncatedJson(s.slice(start))); } catch { return null; }
};

module.exports = { withTimeout, extractJson, closeTruncatedJson };
