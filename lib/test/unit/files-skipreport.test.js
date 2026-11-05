'use strict';
// Unit test for the indexing skip-report (lib/indexing/files.js). When loadSingleDocument drops a
// file it must record WHY in the right bucket, because a silent drop otherwise looks like a clean
// index that quietly contributes nothing. The buckets drive the "these files were skipped" notice in
// the UI, so a misfiled or missing classification hides real data loss from the user. This drives the
// real classifier with tiny on-disk fixtures (no model, no network) and checks each bucket, plus the
// reset and the defensive copy getSkipReport returns. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const files = require(path.join(PROJECT, 'lib', 'indexing', 'files'));
const { MIN_FILE_SIZE, MAX_FILE_SIZE, SOURCE_MAX_FILE_BYTES } = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-skip-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
const write = (name, contents) => { const p = path.join(tmp, name); fs.writeFileSync(p, contents); return p; };

(async () => {
  try {
    files.resetSkipReport();

    // ── tooSmall: below MIN_FILE_SIZE is dropped and recorded (a folder of one-line notes otherwise
    //    looks indexed but contributes nothing) ──
    {
      const p = write('tiny.txt', 'x'.repeat(Math.max(1, MIN_FILE_SIZE - 40)));   // well under the floor
      const r = await files.loadSingleDocument(p, new Map());
      eq(r, null, 'a too-small file is not indexed');
      ok(files.getSkipReport().tooSmall.includes('tiny.txt'), 'the too-small file is recorded in tooSmall');
    }

    // ── tooLarge: above MAX_FILE_SIZE is refused BEFORE being read into memory (OOM guard) and
    //    recorded with its size. A sparse file gives the large logical size without using the disk;
    //    the tooLarge branch returns on the stat alone, never reading the bytes. ──
    {
      const p = path.join(tmp, 'huge.txt');
      const fd = fs.openSync(p, 'w');
      try { fs.ftruncateSync(fd, MAX_FILE_SIZE + 1024); } finally { fs.closeSync(fd); }
      const r = await files.loadSingleDocument(p, new Map());
      eq(r, null, 'an oversized file is not indexed (never read into memory)');
      const entry = files.getSkipReport().tooLarge.find(s => s.startsWith('huge.txt'));
      ok(entry && /MB\)/.test(entry), 'the oversized file is recorded in tooLarge with its size in MB');
    }

    // ── walkSource oversized SOURCE file: a file above SOURCE_MAX_FILE_BYTES in a user-added source folder is
    //    skipped at DISCOVERY (never read), but it must be RECORDED in tooLarge — not dropped silently — so the
    //    run summary tells the user it was not indexed instead of letting them believe it is searchable. Mirrors
    //    the documents-folder tooLarge above, through the same shared report. ──
    {
      const srcDir = path.join(tmp, 'src-folder');
      fs.mkdirSync(srcDir, { recursive: true });
      // A sparse oversized file (large logical size, no disk use), plus a normal one that must still be found.
      const big = path.join(srcDir, 'oversized-report.txt');
      const fd = fs.openSync(big, 'w');
      try { fs.ftruncateSync(fd, SOURCE_MAX_FILE_BYTES + 1024); } finally { fs.closeSync(fd); }
      fs.writeFileSync(path.join(srcDir, 'normal-note.txt'), 'x'.repeat(Math.max(MIN_FILE_SIZE + 10, 100)));
      const found = await files.walkSource(srcDir, { recursive: false, maxDepth: 1 }, {});
      ok(found.some(p => p.endsWith('normal-note.txt')), 'walkSource still discovers the normal-sized source file');
      ok(!found.some(p => p.endsWith('oversized-report.txt')), 'the oversized source file is not discovered');
      const entry = files.getSkipReport().tooLarge.find(s => s.startsWith('oversized-report.txt'));
      ok(entry && /MB\)/.test(entry), 'the oversized source file is recorded in tooLarge with its size (not skipped silently)');
    }

    // ── nameOnly: a file that passes the size gate but yields no extractable text (a scanned PDF with no
    //    text layer; here a whitespace-only text file) is NOT dropped. It is indexed by its file name so it
    //    stays findable, openable, and summarizable, and recorded as name-only — the "never give up on a
    //    document" guarantee. ──
    {
      const p = write('blank.txt', ' \n\t '.repeat(Math.max(16, MIN_FILE_SIZE)));   // > floor, no real text
      const r = await files.loadSingleDocument(p, new Map());
      ok(r && r.docId, 'a file with no extractable text is still indexed (by name), not dropped');
      ok(r.metadata.indexedByName === true, 'the name-only document is marked indexedByName');
      ok(/blank/.test(r.content), 'the indexed content is derived from the file name');
      ok(files.getSkipReport().nameOnly.includes('blank.txt'), 'the empty-text file is recorded in nameOnly');
    }

    // ── name-only document TYPE: a real document format this build can't extract yet (.rtf and friends) is
    //    discovered and indexed by its file name — found, not silently ignored — while an arbitrary binary type
    //    is NOT discovered (the index is not flooded with non-documents). Guards the NAME_ONLY_EXTENSIONS path. ──
    {
      const dir = path.join(tmp, 'docs-mixed');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.rtf'), '{\\rtf1 ' + 'word '.repeat(Math.max(16, MIN_FILE_SIZE)) + '}');
      fs.writeFileSync(path.join(dir, 'tool.bin'), 'x'.repeat(Math.max(16, MIN_FILE_SIZE)));
      const found = await files.walkDirectory(dir);
      ok(found.some(p => p.endsWith('summary.rtf')), 'a real document type (.rtf) is discovered');
      ok(!found.some(p => p.endsWith('tool.bin')), 'an arbitrary binary type is NOT discovered (no index flooding)');
      files.resetSkipReport();
      const r = await files.loadSingleDocument(path.join(dir, 'summary.rtf'), new Map());
      ok(r && r.metadata.indexedByName === true, 'the unparsed document type is indexed by name, not dropped');
      ok(files.getSkipReport().nameOnly.includes('summary.rtf'), 'the name-only document type is recorded in nameOnly');
    }

    // ── reportTruncated: a directory walk that hit the file cap records the partial coverage ──
    {
      files.reportTruncated('big-folder', 5000, 12000);
      const t = files.getSkipReport().truncated;
      ok(t.some(s => s.startsWith('big-folder') && /5000\/12000/.test(s)), 'a truncated walk is recorded with its page/file counts');
    }

    // ── reportTextTruncated: a large text/log file cut to the character cap is recorded, with which
    //    end was kept (the tail for logs, the beginning for prose) so the cut surfaces in the run summary ──
    {
      files.reportTextTruncated('recent.log', 'most recent lines');
      files.reportTextTruncated('book.txt', 'beginning');
      const tt = files.getSkipReport().textTruncated;
      ok(tt.some(s => s.startsWith('recent.log') && /most recent lines/.test(s)), 'a truncated .log is recorded as keeping its most recent lines');
      ok(tt.some(s => s.startsWith('book.txt') && /beginning/.test(s)), 'a truncated prose file is recorded as keeping its beginning');
    }

    // ── getSkipReport returns a defensive copy: mutating it cannot corrupt the live report ──
    {
      const snap = files.getSkipReport();
      snap.tooSmall.push('__injected__');
      ok(!files.getSkipReport().tooSmall.includes('__injected__'), 'getSkipReport returns copies, not the live arrays');
    }

    // ── mergeSkipReport: an isolated child's truncation notes are folded into this process's report ──
    //    A scanned PDF is parsed in a child process whose own skipReport dies with it; the child sends its
    //    report back and the parent merges it, so a page-cap cut ("read 40 of 200 pages") is not silently
    //    lost for exactly the huge/scanned PDFs the product promises to handle.
    {
      files.resetSkipReport();
      files.mergeSkipReport({ truncated: ['scan.pdf (40/200 pages)'], textTruncated: ['big.docx (kept the beginning)'], tooSmall: [], tooLarge: [], nameOnly: [] });
      const r = files.getSkipReport();
      ok(r.truncated.some(s => s.startsWith('scan.pdf') && /40\/200 pages/.test(s)), 'a child-reported PDF page-cap truncation is merged into the parent report');
      ok(r.textTruncated.some(s => s.startsWith('big.docx')), 'a child-reported char-cap truncation is merged');
      // Tolerant of a missing/partial/invalid payload (the child may send null, e.g. on an error path).
      files.mergeSkipReport(null); files.mergeSkipReport(undefined); files.mergeSkipReport({}); files.mergeSkipReport({ truncated: 'not-an-array' });
      eq(files.getSkipReport().truncated.length, 1, 'merge ignores null/partial/invalid payloads without throwing or duplicating');
    }

    // ── Source guards: the child→parent truncation plumbing stays wired end to end ──
    {
      const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
      const child = read('lib/indexing/extractchild.js');
      ok(/skips = require\('\.\/files'\)\.getSkipReport\(\)/.test(child) && /out = \{ ok: true, result, skips \}/.test(child), 'the child harvests and sends back its skip report');
      const proc = read('lib/indexing/extractprocess.js');
      ok(/if \(msg\.skips\) r\._skips = msg\.skips/.test(proc), 'the parent supervisor attaches the child skips to the result');
      const f = read('lib/indexing/files.js');
      const merges = (f.match(/mergeSkipReport\(result && result\._skips\)/g) || []).length;
      eq(merges, 3, 'all three extractInChild call sites merge the child skips');
      ok(/content\.endsWith\(TRUNC_MARK\)\) reportTextTruncated\(path\.basename\(filePath\), 'beginning'\)/.test(f), 'a capText-trimmed heavy format surfaces its char-cap cut');
    }

    // ── resetSkipReport clears every bucket ──
    {
      files.resetSkipReport();
      const r = files.getSkipReport();
      eq(r.tooSmall.length + r.tooLarge.length + r.truncated.length + r.textTruncated.length + r.nameOnly.length, 0, 'reset empties all five buckets');
    }

    console.log('✓ files: skip-report classifies tooSmall / tooLarge / truncated / textTruncated / nameOnly, copies out, and resets');
    console.log(`\nALL FILES-SKIPREPORT UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ FILES-SKIPREPORT UNIT TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
