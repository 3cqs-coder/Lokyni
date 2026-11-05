'use strict';
// Guards the bounded prefix read for the plain-text family in lib/indexing/files.js. Those formats
// (.txt/.md/.log/.csv/.tsv/.html/.htm) are indexed as-is and are NOT parsed in the memory-capped isolation
// child, so a very large one must not be read and decoded WHOLE on the main process before capText
// discards everything past MAX_TEXT_CHARS — that is a multi-hundred-MB transient spike plus a synchronous
// decode stall. readFilePrefix reads only a bounded prefix (enough to fill the character cap for any
// encoding, and no more). Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { readFilePrefix, readFileSuffix, TEXT_PREFIX_EXTS, TEXT_READ_MAX_BYTES } = require(path.join(PROJECT, 'lib', 'indexing', 'files'));
const { MAX_TEXT_CHARS } = require(path.join(PROJECT, 'lib', 'indexing', 'parsecore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-prefix-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

(async () => {
  try {
    // ── reads only up to maxBytes when the file is larger ──
    const big = path.join(tmp, 'big.txt');
    fs.writeFileSync(big, Buffer.alloc(20000, 0x61));   // 20 KB of 'a'
    const capped = await readFilePrefix(big, 4096);
    ok(capped.length === 4096, 'a file larger than maxBytes is read only up to maxBytes');
    ok(capped.every(b => b === 0x61), 'the prefix bytes are the real file contents');

    // ── returns the whole file when it is smaller than maxBytes ──
    const small = path.join(tmp, 'small.txt');
    fs.writeFileSync(small, 'hello world');
    const whole = await readFilePrefix(small, 1e9);
    ok(whole.toString() === 'hello world', 'a file smaller than maxBytes is returned in full');

    // ── an empty file yields an empty buffer, no throw ──
    const empty = path.join(tmp, 'empty.txt');
    fs.writeFileSync(empty, '');
    const none = await readFilePrefix(empty, 4096);
    ok(none.length === 0, 'an empty file yields an empty buffer');

    // ── the cap is large enough to fill the character budget even for multibyte text ──
    ok(TEXT_READ_MAX_BYTES >= MAX_TEXT_CHARS, 'the byte cap is at least the character cap');
    ok(TEXT_READ_MAX_BYTES === MAX_TEXT_CHARS * 4, 'the byte cap is 4x the char cap (fills the cap for 4-byte UTF-8)');

    // ── the plain-text family is wired to the bounded read, other formats read whole ──
    for (const ext of ['.txt', '.md', '.log', '.csv', '.tsv', '.html', '.htm']) {
      ok(TEXT_PREFIX_EXTS.has(ext), `${ext} is in the bounded-read text family`);
    }
    ok(!TEXT_PREFIX_EXTS.has('.pdf') && !TEXT_PREFIX_EXTS.has('.docx'), 'isolated formats are not in the text-prefix set');

    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'files.js'), 'utf-8');
    ok(/const buffer = await readFilePrefix\(filePath, TEXT_READ_MAX_BYTES\)/.test(src),
      'the inline extraction branch reads a bounded prefix for the head-read text family');
    ok(/if \(lcExtText === '\.log'\)[\s\S]*?await readFileSuffix\(filePath, MAX_TEXT_CHARS\)/.test(src),
      'a .log reads the bounded TAIL (newest lines survive the cap)');

    console.log('✓ text-prefix-read: large plain-text files are read as a bounded prefix, not whole');

    // ── a .log reads the TAIL: the newest lines survive, the oldest are dropped, and it starts clean ──
    const log = path.join(tmp, 'big.log');
    const fd = fs.openSync(log, 'w');
    let n = 0, wrote = 0;
    while (wrote < 300 * 1024) { const line = `line ${n++} entry\n`; fs.writeSync(fd, line); wrote += Buffer.byteLength(line); }
    fs.closeSync(fd);
    const tail = await readFileSuffix(log, 64 * 1024);   // ask for far less than the file: forces a tail window
    ok(tail.truncated === true, 'a file larger than the tail budget reports truncated');
    ok(tail.buffer.length <= 64 * 1024, 'the tail is bounded by the requested size');
    const ts = tail.buffer.toString('utf8');
    ok(/^line \d+ entry/.test(ts), 'the tail starts at a clean line boundary (no partial first line)');
    ok(ts.includes(`line ${n - 1} entry`), 'the tail keeps the newest line');
    ok(!/(^|\n)line 0 entry/.test(ts), 'the tail drops the oldest lines');
    const wholeTail = await readFileSuffix(small, 1e9);   // smaller than budget → whole file, not truncated
    ok(wholeTail.truncated === false && wholeTail.buffer.toString() === 'hello world', 'a small file tail-reads whole and is not flagged truncated');
    console.log('✓ text-prefix-read: a .log keeps its newest lines (tail read), reported when cut');

    // ── a prefix cut that bisects a multibyte UTF-8 char must not make the WHOLE buffer mis-decode ──
    // Without trimming the partial trailing char, isUtf8() rejects the entire buffer and decodeTextBuffer
    // falls back to Latin-1, turning every accent/currency/CJK byte into mojibake across the document.
    const { decodeTextBuffer } = require(path.join(PROJECT, 'lib', 'textdecode'));
    const { isUtf8 } = require('buffer');
    const utf8file = path.join(tmp, 'utf8.txt');
    // 10 ASCII bytes, then '€' (E2 82 AC), then more content so the file is larger than our cut.
    fs.writeFileSync(utf8file, Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from('€ and more text follows here', 'utf8')]));
    const cut = await readFilePrefix(utf8file, 11);   // 11 = 10 'a' + the FIRST byte (0xE2) of '€' → bisects it
    ok(isUtf8(cut), 'a prefix cut mid-character trims the partial tail so the buffer is valid UTF-8');
    ok(decodeTextBuffer(cut) === 'aaaaaaaaaa', 'the bisected char is dropped, not mis-decoded as Latin-1 mojibake');

    // A full multibyte char inside the budget is preserved (not over-trimmed).
    const cut2 = await readFilePrefix(utf8file, 13);   // 10 'a' + all 3 bytes of '€'
    ok(isUtf8(cut2) && decodeTextBuffer(cut2) === 'aaaaaaaaaa€', 'a complete multibyte char within the budget is kept');

    // A complete Latin-1 file whose last byte looks like a UTF-8 lead is NOT trimmed (len >= size guard).
    const latin1 = path.join(tmp, 'latin1.txt');
    fs.writeFileSync(latin1, Buffer.from([0x61, 0x62, 0xE9]));   // "ab" + é (0xE9) — valid Latin-1, not UTF-8
    const whole1 = await readFilePrefix(latin1, 1e9);
    ok(whole1.length === 3 && decodeTextBuffer(whole1) === 'abé', 'a complete Latin-1 file is returned whole, not trimmed');
    console.log('✓ text-prefix-read: a mid-character prefix cut is trimmed to a clean UTF-8 boundary (no mojibake)');

    console.log(`\nALL TEXT-PREFIX-READ UNIT TESTS PASSED (${checks} checks)`);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('\n✗ TEXT-PREFIX-READ UNIT TEST FAILED:', e && e.message);
    cleanup();
    process.exit(1);
  }
})();
