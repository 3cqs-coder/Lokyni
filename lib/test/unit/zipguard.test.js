'use strict';
// Regression tests for the decompression-bomb guard (lib/indexing/zipguard.js). A normal,
// well-formed archive passes; anything that isn't a real ZIP within budget is refused so it is
// never handed to a reader that would inflate it. Builds a valid ZIP with the bundled jszip —
// no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { zipWithinBudget } = require(path.join(PROJECT, 'lib', 'indexing', 'zipguard'));
const JSZip = require(path.join(PROJECT, 'node_modules', 'jszip'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // ── a normal archive passes ──
    const zip = new JSZip();
    zip.file('a.txt', 'hello world');
    zip.file('nested/b.xml', '<root><item>data</item></root>');
    const good = await zip.generateAsync({ type: 'nodebuffer' });
    ok(zipWithinBudget(good) === true, 'a normal, well-formed archive is within budget');
    console.log('✓ zipguard: a normal archive passes');

    // ── non-archives and junk are refused ──
    ok(zipWithinBudget(Buffer.from('this is not a zip at all')) === false, 'a non-ZIP buffer is refused');
    ok(zipWithinBudget(Buffer.alloc(4)) === false, 'a too-small buffer is refused');
    ok(zipWithinBudget(good.subarray(0, 40)) === false, 'a truncated archive is refused');
    ok(zipWithinBudget('not a buffer') === false, 'a non-buffer input is refused');
    console.log('✓ zipguard: non-archives, truncated, and junk inputs are refused');

    // ── decompression-bomb branches: each budget is actually enforced, not just declared ──
    // These are the real OOM guards; without exercising them a wrong comparison or a dropped
    // maxOutputLength would re-open the bomb on a crafted docx/xlsx/epub/pptx and ship undetected.

    // (a) too many entries — a nested/zip-bomb signature. One past the cap is refused.
    const manyZip = new JSZip();
    for (let i = 0; i < 8193; i++) manyZip.file(`f${i}.txt`, 'x');   // MAX_ENTRIES is 8192
    const many = await manyZip.generateAsync({ type: 'nodebuffer' });
    ok(zipWithinBudget(many) === false, 'an archive with more than MAX_ENTRIES entries is refused');

    // (b) one entry that inflates past the 128 MiB total budget (highly compressible zeros, so the
    //     archive on disk stays tiny — the classic bomb). inflateRawSync's maxOutputLength must throw.
    const bombZip = new JSZip();
    bombZip.file('big.bin', Buffer.alloc(129 * 1024 * 1024));   // > MAX_UNCOMPRESSED (128 MiB)
    const bomb = await bombZip.generateAsync({ type: 'nodebuffer' });
    ok(zipWithinBudget(bomb) === false, 'an entry inflating past the uncompressed budget is refused');

    // (c) XML node-density bomb: a small inflated payload with more than MAX_NODES '<'/'=' markers.
    const nodesZip = new JSZip();
    nodesZip.file('dense.xml', '<'.repeat(12000001));   // > MAX_NODES (12,000,000)
    const nodes = await nodesZip.generateAsync({ type: 'nodebuffer' });
    ok(zipWithinBudget(nodes) === false, 'an archive whose entry exceeds the XML node-density cap is refused');

    // (d) ZIP64 sentinel and (e) an unknown compression method — both beyond what the guard can vet,
    //     so both must fail closed. Patch a known-good single-entry archive's first local header
    //     (offset 0: PK\x03\x04; method at +8; uncompressed size at +22).
    const base = await (() => { const z = new JSZip(); z.file('a.txt', 'hello'); return z.generateAsync({ type: 'nodebuffer' }); })();
    ok(base.readUInt32LE(0) === 0x04034b50, 'the archive starts with a local file header (patch offsets valid)');
    const zip64 = Buffer.from(base); zip64.writeUInt32LE(0xffffffff, 22);   // uncompressed size = ZIP64 sentinel
    ok(zipWithinBudget(zip64) === false, 'a ZIP64 sentinel size is refused (beyond what the guard vets)');
    const badMethod = Buffer.from(base); badMethod.writeUInt16LE(99, 8);    // method 99 = unknown
    ok(zipWithinBudget(badMethod) === false, 'an unknown compression method is refused');
    // A ZIP64 SENTINEL with no 0x0001 extra field can't be located, so it is still refused (not a valid ZIP64).
    ok(zipWithinBudget(zip64) === false, 'a ZIP64 sentinel with no ZIP64 extra field is refused (unlocatable)');
    console.log('✓ zipguard: entry-count, inflated-size, node-density, bad-method, and unlocatable-ZIP64 inputs are refused');

    // ── Valid ZIP64 archives are ACCEPTED (their real sizes/offsets live in the 0x0001 extra field) ──
    // Some writers emit ZIP64 even for small files; refusing all ZIP64 lost valid documents' content. Build a
    // minimal, correct single-entry (stored) ZIP64 archive by hand and confirm the guard vets and accepts it.
    const U32 = 0xffffffff, U16 = 0xffff;
    const buildZip64 = ({ fullEocd = false, declaredSize = null } = {}) => {
      const name = Buffer.from('a.txt');
      const data = Buffer.from('hello zip64');
      const real = declaredSize == null ? data.length : declaredSize;   // declaredSize != real → a bomb claim
      const u64 = (v) => { const b = Buffer.alloc(8); b.writeUInt32LE(v >>> 0, 0); b.writeUInt32LE(Math.floor(v / 0x100000000), 4); return b; };

      // Local file header with saturated sizes + a ZIP64 extra field [uncomp(8), comp(8)].
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(45, 4); lfh.writeUInt16LE(0, 8);
      lfh.writeUInt32LE(U32, 18); lfh.writeUInt32LE(U32, 22);
      lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(20, 28);
      const lExtra = Buffer.concat([Buffer.from([0x01, 0x00, 16, 0x00]), u64(real), u64(real)]);
      const localBlock = Buffer.concat([lfh, name, lExtra, data]);
      const lho = 0;

      // Central-directory header with saturated sizes + offset + a ZIP64 extra [uncomp, comp, lho].
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(45, 6); cdh.writeUInt16LE(0, 10);
      cdh.writeUInt32LE(U32, 20); cdh.writeUInt32LE(U32, 24);
      cdh.writeUInt16LE(name.length, 28); cdh.writeUInt16LE(28, 30); cdh.writeUInt16LE(0, 32);
      cdh.writeUInt32LE(U32, 42);
      const cExtra = Buffer.concat([Buffer.from([0x01, 0x00, 24, 0x00]), u64(real), u64(real), u64(lho)]);
      const cdBlock = Buffer.concat([cdh, name, cExtra]);
      const cdOffset = localBlock.length;
      const cdSize = cdBlock.length;

      const parts = [localBlock, cdBlock];
      // EOCD (optionally fully ZIP64: a ZIP64 EOCD record + locator precede a saturated EOCD).
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      if (fullEocd) {
        const z64Pos = cdOffset + cdSize;
        const z64 = Buffer.alloc(56);
        z64.writeUInt32LE(0x06064b50, 0); u64(44).copy(z64, 4);
        u64(1).copy(z64, 24); u64(1).copy(z64, 32); u64(cdSize).copy(z64, 40); u64(cdOffset).copy(z64, 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0); u64(z64Pos).copy(loc, 8); loc.writeUInt32LE(1, 16);
        parts.push(z64, loc);
        eocd.writeUInt16LE(U16, 8); eocd.writeUInt16LE(U16, 10); eocd.writeUInt32LE(U32, 12); eocd.writeUInt32LE(U32, 16);
      } else {
        eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdOffset, 16);
      }
      parts.push(eocd);
      return Buffer.concat(parts);
    };

    ok(zipWithinBudget(buildZip64()) === true, 'a valid ZIP64 archive (sizes/offset in the 0x0001 extra) is accepted');
    ok(zipWithinBudget(buildZip64({ fullEocd: true })) === true, 'a valid ZIP64 archive with a ZIP64 EOCD record + locator is accepted');
    // A ZIP64 entry that CLAIMS a huge size it can't back (the extra field lies) must still be refused — the
    // recovered size only locates data; the bounds/budget checks stay in force, so ZIP64 is not a bomb bypass.
    ok(zipWithinBudget(buildZip64({ declaredSize: 200 * 1024 * 1024 })) === false, 'a ZIP64 entry claiming more than the archive holds is refused (no bomb bypass)');
    console.log('✓ zipguard: valid ZIP64 archives are accepted (content recovered); a lying ZIP64 size is still refused');

    // ── the XLSX parser vets the zip itself, so every parse path is guarded ──
    // A workbook is a ZIP; parsecore.xlsxToText must reject anything the guard refuses BEFORE
    // handing it to XLSX.read, whether it is called in the worker, inline, or the isolated child.
    const { xlsxToText } = require(path.join(PROJECT, 'lib', 'indexing', 'parsecore'));
    let threw = false;
    try { xlsxToText(Buffer.from('this is not a zip at all')); } catch (e) { threw = /zip bomb|decompress/i.test(e.message); }
    ok(threw, 'parsecore.xlsxToText refuses a buffer the zip guard rejects');
    console.log('✓ zipguard: the XLSX parser is guarded on every path');

    console.log(`\nALL ZIPGUARD UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ ZIPGUARD UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
