'use strict';
// Guards the single source of truth for which file types Lokyni accepts. The extension list is defined
// once in lib/constants.js and must reach every place that enumerates types — the two file pickers, the
// client's "supported types" hint, and the server's upload filter — so adding a format never requires
// touching several sites and a missed one never silently rejects a valid file. This asserts those ties.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const constants = require(path.join(PROJECT, 'lib', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── the accept attribute is exactly the documents plus the OCR image formats plus the media formats, in order ──
  const expected = [...constants.SUPPORTED_EXTENSIONS, ...constants.OCR_EXTENSIONS, ...constants.MEDIA_EXTENSIONS].join(',');
  ok(constants.SUPPORTED_ACCEPT_ATTR === expected,
    'SUPPORTED_ACCEPT_ATTR is SUPPORTED_EXTENSIONS + OCR_EXTENSIONS + MEDIA_EXTENSIONS (single-sourced)');
  ok(constants.SUPPORTED_ACCEPT_ATTR.includes('.mp3') && constants.SUPPORTED_ACCEPT_ATTR.includes('.mp4'),
    'the accept list includes media formats (so the picker offers them; the server filter gates on the toggle)');
  ok(constants.SUPPORTED_ACCEPT_ATTR.includes('.log'),
    'the accept list includes .log (a recently added format reaches every picker automatically)');

  // The human-facing hint is built from the same list, with optional groups only when enabled.
  const baseHint = constants.uploadFormatsLabel();
  ok(baseHint.includes('.pptx') && baseHint.includes('.json') && baseHint.includes('.xlsx'),
    'the upload hint includes every supported document and data format');
  ok(!baseHint.includes('images') && !baseHint.includes('audio/video'),
    'optional groups are absent from the hint until their features are enabled');
  ok(constants.uploadFormatsLabel({ ocr: true }).includes('images'),
    'images appear in the hint when OCR is on');
  ok(constants.uploadFormatsLabel({ audio: true }).includes('audio/video'),
    'audio and video appear in the hint when media ingestion is on');

  // ── both file pickers render the attribute from the server-provided value, not a hardcoded copy ──
  const docPanel = read('lib/views/partials/doc-panel.ejs');
  const chatEjs  = read('lib/views/chat.ejs');
  ok(/id="file-input"[^>]*accept="<%= acceptAttr %>"/.test(docPanel),
    'the library upload picker sources its accept list from acceptAttr');
  ok(/id="attach-input"[^>]*accept="<%= acceptAttr %>"/.test(chatEjs),
    'the one-off attach picker sources its accept list from acceptAttr');

  // ── the server passes the single constant into the page render ──
  const server = read('lib/server.js');
  ok(/acceptAttr:\s*SUPPORTED_ACCEPT_ATTR/.test(server), 'the chat render is given acceptAttr from the constant');
  ok(/extLabel:\s*SUPPORTED_EXT_LABEL/.test(server), 'the chat render is given the human-facing label from the constant');
  ok(/const uploadFormats = uploadFormatsLabel\(/.test(server) && /res\.render\('chat',[\s\S]*?uploadFormats/.test(server),
    'the chat render derives the upload hint from the shared helper');
  ok(/uploadFormats/.test(docPanel), 'the drop-zone hint consumes the server-provided upload formats');

  // ── the upload filter derives its allow-list from the same constants, never a separate copy ──
  const documents = read('lib/routes/documents.js');
  ok(/constants\.SUPPORTED_EXTENSIONS/.test(documents) && /constants\.OCR_EXTENSIONS/.test(documents) && /constants\.MEDIA_EXTENSIONS/.test(documents),
    'the upload filter builds its allow-list from the shared constants (documents + OCR images + media)');

  console.log('✓ supported-extensions: one list feeds both pickers, the client hint, and the upload filter');
  console.log(`\nALL SUPPORTED-EXTENSIONS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SUPPORTED-EXTENSIONS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
