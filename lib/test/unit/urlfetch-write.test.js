'use strict';
// Guards the atomic, collision-safe write behind URL ingestion and the clipper (lib/urlfetch writeArticle,
// reached here through saveProvidedContent with text-only content, so no network or browser is involved).
// Two properties matter and used to be missing:
//   • Concurrent captures that slugify to the SAME filename stem must each land as their own document,
//     never overwriting one another (the old access()-then-writeFile had a time-of-check/time-of-use gap).
//   • A finished write leaves exactly the .txt documents and no stray temp files (the content is staged in
//     a private temp and hard-linked into place, so a crash can't publish a truncated document).
// Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { saveProvidedContent } = require(path.join(PROJECT, 'lib', 'urlfetch'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-urlwrite-'));
  const cleanup = (code) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };
  try {
    // ── idempotent by source URL: re-ingesting the same URL overwrites its document, never duplicates ──
    const a = await saveProvidedContent({ url: 'https://example.com/x', title: 'Same Title', text: 'first body' }, dir);
    const b = await saveProvidedContent({ url: 'https://example.com/x', title: 'Same Title', text: 'second body' }, dir);
    ok(a.rel === b.rel, 'the same source URL maps to the same filename (idempotent, no duplicate)');
    ok(fs.readFileSync(path.join(dir, b.rel), 'utf-8').includes('second body'), 'a re-ingest overwrites with the new content');
    ok(fs.readdirSync(dir).filter(n => n.endsWith('.txt')).length === 1, 'only one document exists for the URL after two ingests');

    // ── different URLs that slugify to the same stem stay distinct (the URL hash disambiguates) ──
    const c = await saveProvidedContent({ url: 'https://example.com/other', title: 'Same Title', text: 'other body' }, dir);
    ok(c.rel !== a.rel, 'a different URL with the same title gets a distinct filename');

    // ── concurrent re-ingests of one URL converge to a single document (last write wins), none corrupt ──
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        saveProvidedContent({ url: 'https://example.com/race', title: 'Race', text: `body-${i}` }, dir))
    );
    ok(new Set(results.map(r => r.rel)).size === 1, 'concurrent same-URL ingests all target one filename');
    ok(fs.readdirSync(dir).filter(n => n.startsWith('race')).length === 1, 'exactly one document exists for the raced URL');
    ok(/body-\d+/.test(fs.readFileSync(path.join(dir, results[0].rel), 'utf-8')), 'the surviving document has a complete (uncorrupted) body');

    // ── no residue: no staged temp files remain ──
    const leftoverTemps = fs.readdirSync(dir).filter(n => n.includes('.tmp'));
    ok(leftoverTemps.length === 0, 'no staging temp files are left behind after successful writes');

    console.log('✓ urlfetch-write: article writes are atomic and idempotent by source URL, leaving no temp residue');
    console.log(`\nALL URLFETCH-WRITE UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ URLFETCH-WRITE UNIT TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
