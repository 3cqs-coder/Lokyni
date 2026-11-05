'use strict';
// Corpus-overview detection for adaptive synthesis routing (hierarchical index, stage 2).
//
// Top-k passage retrieval can only see a handful of documents, so a genuinely whole-corpus
// question ("what are the common themes across all my documents?", "give me an overview of
// this workspace", "how do these files connect?") is better answered by the existing
// map-reduce workspace synthesis, which reads across the collection. This is a cheap,
// deterministic (no-LLM) check that recognizes ONLY unambiguous whole-corpus phrasing, so an
// ordinary question — including "summarize this document" or a follow-up about one document —
// stays on the normal, fast retrieval path.
//
// Deliberately strict: each pattern requires an explicit corpus cue (all/every/entire/whole
// documents-workspace-corpus-collection-everything) or the strong "common themes" idiom. When
// in doubt it returns false, because wrongly launching a slow synthesis is worse than missing
// one broad question the user can rephrase or run with the Generate button.

const PATTERNS = [
  // "across/throughout/spanning ... documents/files/workspace/corpus"
  /\b(across|throughout|spanning|among)\b[\s\S]{0,24}\b(documents?|files?|notes?|sources?|workspace|corpus|collection|library)\b/i,
  // "all my documents", "every file", "all of the notes"
  /\b(all|every)\b[\s\S]{0,16}\b(documents?|files?|notes?|sources?)\b/i,
  // "the entire/whole workspace/corpus/collection/library"
  /\b(entire|whole)\b[\s\S]{0,16}\b(workspace|corpus|collection|library)\b/i,
  // "common/recurring/overarching/shared themes/threads/topics/patterns" — a strong
  // across-documents idiom on its own.
  /\b(common|recurring|overarching|shared|cross-cutting)\s+(themes?|threads?|topics?|patterns?|ideas?)\b/i,
  // "summarize/overview of/brief me on ... workspace/corpus/everything/all my documents"
  /\b(summari[sz]e|overview of|brief me on|synthesi[sz]e)\b[\s\S]{0,24}\b(workspace|corpus|collection|everything|all (my|the) (documents?|files?|notes?))\b/i,
  // "what's in my/the/this workspace/corpus/collection/library"
  /\bwhat('?s| is| are)\b[\s\S]{0,24}\bin (my|the|this) (workspace|corpus|collection|library)\b/i,
  // "how do these/the/my/all ... connect/relate/fit together/compare"
  /\bhow do (these|the|my|all)\b[\s\S]{0,40}\b(connect|relate|fit together|tie together|compare|overlap)\b/i,
];

const looksWorkspaceOverview = (query) => {
  const s = String(query || '').trim();
  if (!s || s.length < 6) return false;
  return PATTERNS.some(re => re.test(s));
};

module.exports = { looksWorkspaceOverview };
