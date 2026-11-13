'use strict';
// Shared model-name helpers, used by both the server and (mirrored) the UI's intent.
//
// Two concerns live here so the rules can't drift across the places that compare or classify a
// model name:
//   - normalizeModelName: canonicalize an Ollama-style name so `foo` and `foo:latest` — which are
//     the SAME model in Ollama — compare equal. Only the implicit `:latest` tag is stripped; an
//     explicit tag like `foo:v1.5` is a genuinely different model and is kept. Without this, a
//     user re-selecting `nomic-embed-text:latest` when the index was built as `nomic-embed-text`
//     looks like a model change and forces a needless full re-embed.
//   - isEmbeddingModel: a provider-agnostic heuristic for whether a model produces embeddings, so
//     the Settings "Embeddings model" picker can offer only usable models. Choosing a chat model
//     there cannot embed and triggers a destructive, stalling rebuild.

// Strip a trailing implicit `:latest` tag (and surrounding whitespace). Leaves any other tag.
const normalizeModelName = (name) => {
  const s = String(name == null ? '' : name).trim();
  return s.toLowerCase().endsWith(':latest') ? s.slice(0, -':latest'.length) : s;
};

// True when two model names refer to the same model, treating `foo` and `foo:latest` as equal.
const sameModel = (a, b) => normalizeModelName(a) === normalizeModelName(b);

// Heuristic: does this name look like an embedding model? Covers the common families across
// Ollama and OpenAI without needing a live capability probe (which older Ollama can't answer and
// would cost one request per model). Inclusive by design — the picker still keeps a "Custom" entry
// and the currently-configured value, so an unrecognized embedding model is never lost, only
// un-suggested.
const isEmbeddingModel = (name) => {
  const n = normalizeModelName(name).toLowerCase();
  if (!n) return false;
  // nomic-embed-text, mxbai-embed-large, snowflake-arctic-embed, granite-embedding,
  // embeddinggemma, text-embedding-3-*, text-embedding-ada-002, …
  if (n.includes('embed')) return true;
  if (n.includes('minilm')) return true;                       // all-minilm
  if (n.includes('paraphrase')) return true;                   // paraphrase-multilingual-*
  // bge-*, gte-*, e5-* families, as whole tokens (not substrings of an unrelated name).
  if (/(?:^|[^a-z0-9])(?:bge|gte|e5)(?:[^a-z]|$)/.test(n)) return true;
  return false;
};

module.exports = { normalizeModelName, sameModel, isEmbeddingModel };
