'use strict';
// Notes: notes are stored as first-class markdown documents under the workspace's notes/ folder, so the
// normal pipeline indexes them (searchable, #-citable, related). This guards the security-critical wiring of
// the note routes — every path is confined to the notes/ subfolder (no arbitrary-file write/read), writes are
// atomic + non-blocking, and a save reflects into the index — plus the client editor wiring. Behavior is
// additionally verified live end-to-end. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const route = read('lib', 'routes', 'documents.js');

  // ── routes exist and are correctly gated ──
  ok(/router\.get\('\/notes', docRead,/.test(route), 'GET /notes is read-gated (docRead)');
  ok(/router\.get\('\/note', docRead,/.test(route), 'GET /note is read-gated (docRead)');
  ok(/router\.put\('\/note', authmw\.requirePrimary, docWrite,/.test(route), 'PUT /note is write-gated (docWrite + requirePrimary)');

  // ── every file path is confined to the notes/ subfolder — the key safety property ──
  // GET /note and editing an existing note both resolve through realWithin([notesDir]); creating a note
  // builds the path from a [a-z0-9-]-only slug, which has no path separators, so it stays inside notesDir.
  const noteBlock = route.slice(route.indexOf("const NOTES_SUBDIR"), route.indexOf("// DELETE /api/documents?path="));
  ok((noteBlock.match(/realWithin\(path\.resolve\(docsRoot, [^,]+\), \[notesDir\]\)/g) || []).length >= 2,
    'GET /note and PUT /note (edit path) both confine to the notes dir via realWithin([notesDir])');
  ok(/\.replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/.test(noteBlock), 'the create slug is restricted to [a-z0-9-] (no separators → cannot escape notesDir)');
  ok(/if \(rel\) \{/.test(noteBlock) && /abs = real;/.test(noteBlock) && /abs = await uniqueNotePath\(notesDir, noteSlug\(title\)\)/.test(noteBlock),
    'PUT writes to a confined existing path when editing, or a unique slugged path when creating');

  // ── durable, non-blocking write + index reflect ──
  ok(/writeFileAtomicAsync\(abs, text\)/.test(noteBlock), 'a note is written atomically and non-blocking (no half-written note on a crash)');
  ok(/await reflectDocChange\(wsId\)/.test(noteBlock), 'saving a note reflects the change into the index so it becomes retrievable + #-citable');
  ok(/uniqueNotePath = async \(dir, base\)/.test(route) && /fs\.open\(p, 'wx'\)/.test(route),
    'new-note filenames are reserved atomically (exclusive create) so a concurrent same-title save cannot overwrite');

  // ── delete reuses the existing confined document delete (no second deletion path) ──
  ok(!/router\.delete\('\/note'/.test(route), 'there is no separate note-delete route — deletion reuses the confined DELETE /api/documents');

  // ── client editor wiring ──
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/function initNotes\(\)/.test(chat), 'chat.js defines the notes editor module');
  ok(/method: 'PUT'[\s\S]{0,80}?JSON\.stringify\(payload\)/.test(chat), 'the editor saves via PUT with a JSON body (CSRF handled by the fetch wrapper)');
  ok(/nm\.textContent = n\.name/.test(chat) && /ex\.textContent = n\.excerpt/.test(chat), 'note list fields are rendered via textContent (no markup injection)');
  ok(/loadRelated\(/.test(chat) && /\/api\/documents\/related\?docId=/.test(chat), 'the editor shows related documents, reusing the similarity endpoint');
  ok(/await showConfirm\(\{ title: 'Delete this note\?'/.test(chat), 'deleting a note asks for confirmation via the themed showConfirm (destructive action)');

  console.log(`\nALL NOTES UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ NOTES UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
