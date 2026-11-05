'use strict';
// Documentation and shipped-source hygiene. The project has two hard rules that are easy to break by accident:
// user-facing docs never mention a competing product, and they use American English. This scans the shipped
// README and code (excluding tests) for a small, explicit blocklist. It is intentionally narrow: it does not try
// to lint prose, only to catch the drift that reviewers and automated edits tend to reintroduce.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Competing or evaluation PRODUCTS that must not be named in shipped material. These are public
// third-party products, so naming them in this shipped file discloses nothing. Provider names (Ollama,
// OpenAI, Anthropic) and browser names are legitimate technical references and are deliberately NOT listed.
const BLOCKED_PRODUCTS = ['open\\s*webui', 'anythingllm', 'ragas', 'future\\s*agi', 'confident\\s*ai'];
// An optional, gitignored local list can extend the blocklist for a given environment. When it is absent
// only the product list above is enforced. The local file is the single source for any names it adds
// (escapeRegExp is shared from lib/retrieval/keywords, so the escape logic is not re-inlined here).
const { escapeRegExp } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
const loadLocalNames = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(PROJECT, 'config', 'blocked-names.local.json'), 'utf-8'));
    return Array.isArray(parsed.names) ? parsed.names.filter((n) => typeof n === 'string' && n.trim()) : [];
  } catch { return []; }
};
const BLOCKED_NAMES = new RegExp(
  '\\b(' + [...BLOCKED_PRODUCTS, ...loadLocalNames().map(escapeRegExp)].join('|') + ')\\b', 'i');
// British spellings the docs should not use. Kept to unambiguous forms so a technical word like "analysis" is
// never caught.
const BRITISH = /\b(behaviour|colour|organis(e|ed|ing|ation)|recognis(e|ed|ing)|analyse|centre|licence|defence|favour|honour|labour|modelling|travelling|enrolment|fulfil|catalogue)\b/i;
// A raw Google API key literal must never ship — not even a public constant such as the YouTube InnerTube key,
// which secret scanners misread as a leaked credential. Public key constants are kept split (joined at runtime)
// so no AIza… literal appears in the tree. The character class keeps this pattern itself from matching.
const GOOGLE_KEY_LITERAL = /AIza[0-9A-Za-z_-]{35}/;

const shippedDocs = ['docs/README.md'];
const shippedCode = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(PROJECT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (rel === path.join('lib', 'test') || rel.startsWith(path.join('lib', 'test') + path.sep)) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(rel);
    } else if (/\.(js|ejs|css)$/.test(e.name) && !/\.test\.js$/.test(e.name)) {
      shippedCode.push(rel);
    }
  }
};
walk('lib');
shippedCode.push('lokyni.js');

try {
  // ── No competing project names ──
  for (const f of [...shippedDocs, ...shippedCode]) {
    const text = read(f);
    const m = text.match(BLOCKED_NAMES);
    ok(!m, `${f} must not name another project${m ? ` (found “${m[0]}”)` : ''}`);
    ok(!GOOGLE_KEY_LITERAL.test(text), `${f} must not contain a raw Google API key literal (split public key constants instead)`);
  }

  // ── American English in the guide ──
  const docs = read('docs/README.md');
  const brit = docs.match(BRITISH);
  ok(!brit, `the guide uses American English${brit ? ` (found “${brit[0]}”)` : ''}`);

  // ── The guide stays readable: no pathologically long paragraphs in recently added sections ──
  const paragraphs = docs.split(/\n{2,}/);
  const listLines = (p) => (p.match(/^\s*(?:[-*]|\d+\.)\s/gm) || []).length;
  const giant = paragraphs.filter((p) => !p.startsWith('|') && !p.startsWith('```') && listLines(p) < 2 && p.length > 1800);
  ok(giant.length === 0, 'no prose paragraph is unreasonably long (split a run-on instead)');

  // ── The pages the app serves are the ones documented (a renamed view must not silently drop docs) ──
  ok(fs.existsSync(path.join(PROJECT, 'docs', 'README.md')), 'the guide that the app serves exists');
  ok(/Scheduled Automations and Digests/.test(docs), 'the automation section still exists for its anchor');

  console.log(`\nALL DOCS-HYGIENE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCS-HYGIENE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
