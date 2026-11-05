'use strict';
// Unit tests for the streaming parent-map store (lib/indexing/parentmapstore.js). The parent map holds
// every document's full text, so it is persisted as NDJSON (one record per line, plus a trailing sentinel
// proving the file is complete) instead of one whole-corpus JSON string — the memory ceiling for indexing
// a corpus of any size. Covers: an NDJSON round-trip preserves content and metadata; the on-disk form is
// line-delimited with a sentinel; write backpressure (a record larger than the stream high-water mark);
// CRLF and BOM tolerance; a legacy whole-JSON cache is read AND migrated in place; and — critically — the
// reader FAILS CLOSED: a truncated, sentinel-less, count-mismatched, or corrupt-line file discards what it
// loaded so the caller re-derives from source rather than serving a silent partial corpus. No index or
// model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const store = require(path.join(PROJECT, 'lib', 'indexing', 'parentmapstore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const mkmap = (obj) => new Map(Object.entries(obj));

(async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-pms-')));
  const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
  try {
    // ── NDJSON round-trip preserves content + metadata; on-disk form is line-delimited + sentinel ──
    {
      const file = path.join(tmp, 'pm1.json');
      const src = mkmap({
        d1: { content: 'Alpha content', metadata: { source: '/docs/a.txt', timestamp: 111 } },
        d2: { content: 'Beta content with \n newline and "quotes"', metadata: { source: '/docs/b.txt' } },
        d3: { content: 'x'.repeat(5000), metadata: { source: '/docs/c.txt' } },
      });
      await store.writeParentMap(file, src);

      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      eq(lines.length, 4, 'the file has one line per document plus a sentinel');
      for (let i = 0; i < 3; i++) { const r = JSON.parse(lines[i]); ok(r.id && typeof r.content === 'string', 'each document line is a self-contained record'); }
      const sentinel = JSON.parse(lines[3]);
      ok(sentinel._end && sentinel.n === 3, 'the last line is the sentinel recording the document count');
      ok(await store.isNdjson(file), 'isNdjson recognizes the streamed form');

      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.count, 3, 'loadParentMap reads every record');
      eq(res.ok, true, 'a complete file loads ok');
      eq(res.legacy, false, 'the NDJSON form is not flagged legacy');
      eq(back.get('d1').content, 'Alpha content', 'content round-trips');
      eq(back.get('d2').content, 'Beta content with \n newline and "quotes"', 'newlines and quotes in content survive');
      eq(back.get('d1').metadata.source, '/docs/a.txt', 'metadata round-trips');
      eq(back.get('d1').metadata.timestamp, 111, 'metadata fields round-trip');
      eq(back.get('d3').content.length, 5000, 'a large document round-trips');
      ok(fs.readdirSync(tmp).every(f => !f.includes('.tmp')), 'the atomic write leaves no temp residue');
      console.log('✓ parentmapstore: NDJSON round-trip preserves content and metadata, with a completeness sentinel');
    }

    // ── write backpressure: a record larger than the default 16 KB high-water mark exercises the drain path ──
    {
      const file = path.join(tmp, 'pm-big.json');
      const src = mkmap({
        b1: { content: 'y'.repeat(200000), metadata: { source: '/big/1.txt' } },   // >> highWaterMark
        b2: { content: 'z'.repeat(200000), metadata: { source: '/big/2.txt' } },
      });
      await store.writeParentMap(file, src);
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.count, 2, 'large records round-trip through the backpressure path');
      eq(back.get('b1').content.length, 200000, 'a record larger than the stream buffer survives intact');
      console.log('✓ parentmapstore: write backpressure (large records) round-trips');
    }

    // ── CRLF and BOM tolerance on read ──
    {
      const rec = (id, c) => JSON.stringify({ id, content: c, metadata: { source: `/x/${id}` } });
      const crlf = path.join(tmp, 'pm-crlf.json');
      fs.writeFileSync(crlf, '﻿' + rec('c1', 'one') + '\r\n' + rec('c2', 'two') + '\r\n' + '{"_end":1,"n":2}\r\n');
      const back = new Map();
      const res = await store.loadParentMap(crlf, back);
      eq(res.ok, true, 'a CRLF + BOM file loads ok');
      eq(res.count, 2, 'CRLF line endings and a leading BOM are tolerated');
      eq(back.get('c1').content, 'one', 'content is correct despite CRLF/BOM');
      console.log('✓ parentmapstore: CRLF line endings and a leading BOM are tolerated');
    }

    // ── a record whose metadata is absent round-trips (undefined metadata) ──
    {
      const file = path.join(tmp, 'pm-nometa.json');
      const src = new Map([['m1', { content: 'no metadata here' }]]);
      await store.writeParentMap(file, src);
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.count, 1, 'a metadata-less record still loads');
      ok(back.has('m1') && back.get('m1').content === 'no metadata here', 'content survives with undefined metadata');
      console.log('✓ parentmapstore: a record with no metadata round-trips');
    }

    // ── legacy whole-JSON is read AND migrated to NDJSON in place ──
    {
      const file = path.join(tmp, 'pm-legacy.json');
      const legacy = {
        abc123: { content: 'Legacy one', metadata: { source: '/x/1.txt' } },
        def456: { content: 'Legacy two', metadata: { source: '/x/2.txt' } },
      };
      fs.writeFileSync(file, JSON.stringify(legacy));
      ok(!(await store.isNdjson(file)), 'the legacy whole-JSON form is not mistaken for NDJSON');

      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.count, 2, 'the legacy cache is read');
      eq(res.legacy, true, 'it is flagged legacy');
      eq(res.ok, true, 'a well-formed legacy file loads ok');
      eq(back.get('abc123').content, 'Legacy one', 'legacy content is loaded');

      ok(await store.isNdjson(file), 'the legacy file is migrated to NDJSON after loading');
      const back2 = new Map();
      const res2 = await store.loadParentMap(file, back2);
      eq(res2.legacy, false, 'the migrated file now loads via the streaming path');
      eq(res2.ok, true, 'the migrated file is complete');
      eq(back2.get('def456').content, 'Legacy two', 'the migrated file preserves every document');
      console.log('✓ parentmapstore: legacy whole-JSON is read and migrated to NDJSON');
    }

    // ── migrate:false leaves a legacy file un-rewritten (a non-active, side-effect-free read) ──
    // A non-active workspace warm must not rewrite its cache: a fresh mtime would defeat the freshness gate
    // and could resurrect a concurrently-deleted document. The read still returns the content.
    {
      const file = path.join(tmp, 'pm-legacy-nomigrate.json');
      fs.writeFileSync(file, JSON.stringify({ k1: { content: 'keep me as legacy', metadata: {} } }));
      const before = fs.statSync(file).mtimeMs;
      const back = new Map();
      const res = await store.loadParentMap(file, back, { migrate: false });
      eq(res.ok, true, 'a well-formed legacy file loads ok with migrate:false');
      eq(back.get('k1').content, 'keep me as legacy', 'content is read without migrating');
      ok(!(await store.isNdjson(file)), 'migrate:false leaves the legacy whole-JSON form in place (not rewritten)');
      eq(fs.statSync(file).mtimeMs, before, 'migrate:false does not bump the file mtime (no resurrection of a deleted doc)');
    }

    // ── legacy file with a malformed (non-string-content) entry fails closed (never-drop) ──
    // The NDJSON path already fails closed on a dropped entry; the legacy path previously skipped such entries
    // silently and still returned ok:true, which could lose a document. It must now re-derive instead.
    {
      const file = path.join(tmp, 'pm-legacy-bad.json');
      fs.writeFileSync(file, JSON.stringify({ good: { content: 'ok', metadata: {} }, bad: { metadata: {} } }));   // 'bad' has no string content
      const back = new Map();
      const res = await store.loadParentMap(file, back, { migrate: false });
      eq(res.ok, false, 'a legacy file with a malformed entry fails closed (ok:false → re-derive)');
      eq(back.size, 0, 'the partial map is cleared, never served as a silent partial corpus');
    }

    // ── OOM guard: a legacy whole-JSON file larger than the bound is NOT parsed into memory ──
    // The parent map holds every document's full text, so a very large pre-NDJSON corpus's legacy file is the
    // most likely to OOM a whole-file parse. Above the bound it fails closed so the caller re-derives from
    // source (re-extract) and rewrites it as streaming NDJSON, instead of risking an out-of-memory crash.
    {
      const file = path.join(tmp, 'pm-legacy-big.json');
      fs.writeFileSync(file, JSON.stringify({ q1: { content: 'q'.repeat(2000), metadata: {} } }));   // over the tiny bound
      ok(!(await store.isNdjson(file)), 'the oversized legacy file is whole-JSON');
      const back = new Map();
      const res = await store.loadParentMap(file, back, { maxLegacyBytes: 10 });
      eq(res.ok, false, 'an oversized legacy parent-map fails closed (no OOM parse)');
      eq(back.size, 0, 'nothing is loaded; the caller re-derives from source');
      ok(!(await store.isNdjson(file)), 'the oversized legacy file is left untouched (not parsed, not migrated)');
      console.log('✓ parentmapstore: an oversized legacy file is re-derived, not parsed into memory (OOM-proof)');
    }

    // ── FAIL CLOSED: a truncated (sentinel-less) file discards its partial load ──
    {
      const file = path.join(tmp, 'pm-truncated.json');
      const rec = (id) => JSON.stringify({ id, content: 'c-' + id, metadata: {} });
      // Two valid records but NO sentinel — exactly what a power-loss / lost-rename truncation looks like.
      fs.writeFileSync(file, rec('t1') + '\n' + rec('t2') + '\n');
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.ok, false, 'a sentinel-less (truncated) file is reported not-ok');
      eq(res.count, 0, 'a truncated file loads nothing (fail closed)');
      eq(back.size, 0, 'the target map is cleared so the caller re-derives from source');
      console.log('✓ parentmapstore: a truncated (sentinel-less) file fails closed');
    }

    // ── FAIL CLOSED: a sentinel count that disagrees with the records is corruption ──
    {
      const file = path.join(tmp, 'pm-shortcount.json');
      const rec = (id) => JSON.stringify({ id, content: 'c-' + id, metadata: {} });
      fs.writeFileSync(file, rec('s1') + '\n' + rec('s2') + '\n' + '{"_end":1,"n":5}\n');   // claims 5, has 2
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.ok, false, 'a count mismatch is reported not-ok');
      eq(back.size, 0, 'a count-mismatched file is discarded');
      console.log('✓ parentmapstore: a sentinel count mismatch fails closed');
    }

    // ── FAIL CLOSED: a corrupt line discards the whole load (old behavior parsed-or-rebuilt too) ──
    {
      const file = path.join(tmp, 'pm-corrupt.json');
      const good1 = JSON.stringify({ id: 'g1', content: 'good one', metadata: {} });
      const good2 = JSON.stringify({ id: 'g2', content: 'good two', metadata: {} });
      fs.writeFileSync(file, good1 + '\n' + '{"id":"broken", not json\n' + good2 + '\n' + '{"_end":1,"n":2}\n');
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.ok, false, 'a corrupt line makes the whole load not-ok (fail closed)');
      eq(back.size, 0, 'a file with any corrupt line is discarded rather than served partial');
      console.log('✓ parentmapstore: a corrupt line fails closed (no silent partial corpus)');
    }

    // ── missing / empty files are safe; an empty map writes a sentinel-only file that reads as empty ──
    {
      const missing = new Map();
      const r1 = await store.loadParentMap(path.join(tmp, 'nope.json'), missing);
      eq(r1.present, false, 'a missing file reports not present');
      eq(r1.count, 0, 'a missing file loads nothing');

      const outFile = path.join(tmp, 'out-empty.json');
      await store.writeParentMap(outFile, new Map());
      ok(await store.isNdjson(outFile), 'an empty corpus writes a recognizable (sentinel-only) NDJSON file');
      const emptyBack = new Map();
      const rr = await store.loadParentMap(outFile, emptyBack);
      eq(rr.count, 0, 'the empty written file reads back as empty');
      eq(rr.ok, true, 'an empty corpus is a valid, complete file (not corruption)');
      console.log('✓ parentmapstore: missing and empty files are handled safely');
    }

    // ── concurrent writes to the same target do not corrupt it (unique temp names) ──
    {
      const file = path.join(tmp, 'pm-concurrent.json');
      const src = mkmap({ k1: { content: 'one', metadata: {} }, k2: { content: 'two', metadata: {} } });
      await Promise.all([store.writeParentMap(file, src), store.writeParentMap(file, src), store.writeParentMap(file, src)]);
      const back = new Map();
      const res = await store.loadParentMap(file, back);
      eq(res.ok, true, 'three concurrent writers leave a complete, valid file');
      eq(res.count, 2, 'the concurrently written file has exactly the expected records');
      console.log('✓ parentmapstore: concurrent writers use unique temp files and never corrupt the target');
    }

    console.log(`\nALL PARENTMAPSTORE UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ PARENTMAPSTORE UNIT TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
