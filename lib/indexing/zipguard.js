'use strict';
// Decompression-bomb guard for ZIP-based documents (DOCX, XLSX/XLSM, EPUB). Those parsers
// inflate the whole archive and build a full in-memory DOM or row set before any size limit
// applies, so a few-kilobyte "zip bomb" can expand into gigabytes and take the process down —
// and a small bomb slips under the file-size threshold that routes large files to the isolated
// child, so it must be caught on the inline path too. This vets an archive BEFORE a reader
// touches it: it walks both the sequential local headers (what a streaming reader consumes)
// and the central directory (what a random-access reader consumes), inflates each entry with a
// hard output cap so a lying or bomb stream can never materialize more than the remaining
// budget, and bounds the total inflated bytes, the entry count, and the XML node density. It
// uses only Node's built-in zlib — no dependency, cross-platform. Returns true if the archive
// is within budget and safe to hand to the reader, false if it looks like a bomb (index by
// name instead). Never throws.

const zlib = require('zlib');

const MAX_UNCOMPRESSED = 128 * 1024 * 1024;  // total real inflated bytes across all entries
const MAX_NODES        = 12000000;           // total XML nodes ('<' + '=') — a density pre-filter
const MAX_ENTRIES      = 8192;               // a real document has tens of entries; thousands = a nested bomb

function zipWithinBudget(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 22) return false;
    const vetted = new Set();   // data offsets already charged, so an entry reached by both walks is done once
    const state = { budget: MAX_UNCOMPRESSED, entries: 0, nodes: 0 };

    // ── ZIP64 helpers ────────────────────────────────────────────────────────
    // ZIP64 archives store sizes/offsets that overflow 32 bits as 0xffffffff in the fixed header and keep the
    // real 64-bit values in a ZIP64 "extended information" extra field (header id 0x0001). Some writers emit
    // ZIP64 even for sub-4GB files, so refusing every ZIP64 archive (the old behavior) lost the real content of
    // valid Office/EPUB files. These helpers recover the real values so the entry can be located and vetted.
    // The bomb defense is unchanged: a recovered size only tells us WHERE data is; output is still bounded by
    // the budget (bounded inflate for deflate, slice+budget charge for stored), so a lying size can't allocate.
    //
    // Read a little-endian u64. Exact for values below 2^53 — every real size/offset here is bounded by the
    // buffer length (far smaller), and an absurd claimed value is caught by the budget/bounds checks downstream.
    const readU64 = (o) => {
      if (o < 0 || o + 8 > buf.length) return NaN;
      return buf.readUInt32LE(o + 4) * 0x100000000 + buf.readUInt32LE(o);
    };
    // Find the data region of extra field `wantId` within [start, start+len), or null. Each extra field is
    // (id u16, size u16, data[size]); the scan cursor only advances, so it is linear and bounded.
    const findExtra = (start, len, wantId) => {
      let o = start;
      const end = Math.min(start + len, buf.length);
      while (o + 4 <= end) {
        const id = buf.readUInt16LE(o);
        const sz = buf.readUInt16LE(o + 2);
        if (o + 4 + sz > end) return null;   // malformed/truncated extra block
        if (id === wantId) return { off: o + 4, size: sz };
        o += 4 + sz;
      }
      return null;
    };

    // Upper-bound the XML node count of an entry: every element opens with '<' and every
    // attribute has a '=', so counting both markers bounds the DOM/array the reader will build
    // (the amplification the byte budget can't see). Accumulates across entries; stops early.
    const countNodes = (content) => {
      for (const marker of [0x3c, 0x3d]) {   // '<' then '='
        let i = -1;
        while (state.nodes <= MAX_NODES && (i = content.indexOf(marker, i + 1)) !== -1) state.nodes++;
        if (state.nodes > MAX_NODES) return false;
      }
      return true;
    };

    // Vet the entry whose local header starts at `lho`: inflate its real content (bounded) or
    // take a stored slice, charge the real size to the shared budget, and node-count it, once
    // per unique data offset. Returns the compressed length to step over, null when it can't be
    // determined here (a data descriptor — the central-directory walk covers it), or false on
    // any anomaly or budget/node breach. `cdComp` is the compressed size from the central
    // directory (supplies the size when the local header omits it).
    const vet = (lho, cdComp) => {
      if (lho < 0 || lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return false;
      if (++state.entries > MAX_ENTRIES) return false;
      const flags = buf.readUInt16LE(lho + 6);
      const method = buf.readUInt16LE(lho + 8);
      const compSize32 = buf.readUInt32LE(lho + 18);
      const uncomp32 = buf.readUInt32LE(lho + 22);
      const nameLen = buf.readUInt16LE(lho + 26);
      const extraLen = buf.readUInt16LE(lho + 28);
      let compSize = compSize32, uncomp = uncomp32;
      // ZIP64 local header: the real sizes live in the 0x0001 extra field, in the fixed order uncompressed
      // then compressed, each present only when its fixed field is 0xffffffff. Recover them so the entry can be
      // vetted instead of refusing the whole (valid) archive.
      if (compSize32 === 0xffffffff || uncomp32 === 0xffffffff) {
        const z = findExtra(lho + 30 + nameLen, extraLen, 0x0001);
        if (!z) return false;   // claims ZIP64 but carries no extra field — can't locate the data, refuse
        let zo = z.off;
        if (uncomp32 === 0xffffffff) { uncomp = readU64(zo); zo += 8; }
        if (compSize32 === 0xffffffff) { compSize = readU64(zo); zo += 8; }
        if (zo > z.off + z.size || !Number.isFinite(compSize) || !Number.isFinite(uncomp) || compSize < 0 || uncomp < 0) return false;
      }
      const dataStart = lho + 30 + nameLen + extraLen;
      if (dataStart > buf.length) return false;
      const hasDataDescriptor = (flags & 0x08) !== 0;
      const step = hasDataDescriptor ? null : compSize;
      if (vetted.has(dataStart)) return step;
      let content;
      if (method === 8) {   // deflate: inflate to the stream's own end, bounded by the remaining budget
        try { content = zlib.inflateRawSync(buf.subarray(dataStart), { maxOutputLength: Math.max(1, state.budget) }); }
        catch (_) { return false; }
        state.budget -= content.length;
      } else if (method === 0) {   // stored: content == data (1:1)
        const storedLen = !hasDataDescriptor ? compSize : (cdComp > 0 ? cdComp : -1);
        if (storedLen < 0) return null;
        if (dataStart + storedLen > buf.length) return false;
        content = buf.subarray(dataStart, dataStart + storedLen);
        state.budget -= storedLen;
      } else { return false; }   // an unknown method we cannot vet -> refuse
      vetted.add(dataStart);
      if (state.budget < 0) return false;
      if (content.length && !countNodes(content)) return false;
      return step;
    };

    // 1) Sequential local-header walk — the entry set/order a streaming reader consumes.
    let p = 0, sawLocal = false;
    while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
      const step = vet(p, 0);
      if (step === false) return false;
      sawLocal = true;
      if (step === null) break;   // data descriptor: next offset unknown here; the CD walk covers the rest
      p = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28) + step;
    }

    // 2) Central-directory walk — the entry set a random-access reader consumes (deduped by data offset).
    let eocd = -1; const minPos = Math.max(0, buf.length - (22 + 0xffff));
    for (let i = buf.length - 22; i >= minPos; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd >= 0) {
      let cdEntries = buf.readUInt16LE(eocd + 10);
      let cdOffset = buf.readUInt32LE(eocd + 16);
      // ZIP64 EOCD: when the 16-bit entry count or 32-bit CD offset is saturated, the real values live in the
      // ZIP64 end-of-central-directory record, located via the ZIP64 EOCD locator (20 bytes before the EOCD).
      if (cdEntries === 0xffff || cdOffset === 0xffffffff) {
        const locPos = eocd - 20;
        if (locPos < 0 || buf.readUInt32LE(locPos) !== 0x07064b50) return false;   // no locator — can't trust the CD
        const z64Pos = readU64(locPos + 8);
        if (!Number.isFinite(z64Pos) || z64Pos < 0 || z64Pos + 56 > buf.length || buf.readUInt32LE(z64Pos) !== 0x06064b50) return false;
        cdEntries = readU64(z64Pos + 32);   // total entries
        cdOffset = readU64(z64Pos + 48);    // offset of the central directory
      }
      if (!Number.isFinite(cdEntries) || cdEntries > MAX_ENTRIES || !Number.isFinite(cdOffset) || cdOffset < 0 || cdOffset > buf.length) return false;
      let q = cdOffset, seenCd = 0;
      while (seenCd < cdEntries && q + 46 <= buf.length) {
        if (buf.readUInt32LE(q) !== 0x02014b50) break;
        const cdComp32 = buf.readUInt32LE(q + 20);
        const cdUncomp32 = buf.readUInt32LE(q + 24);
        const cdNameLen = buf.readUInt16LE(q + 28);
        const cdExtraLen = buf.readUInt16LE(q + 30);
        const cdDisk32 = buf.readUInt16LE(q + 34);
        const lho32 = buf.readUInt32LE(q + 42);
        let cdComp = cdComp32, lho = lho32;
        // ZIP64 CD entry: the 0x0001 extra field holds, in fixed order, only the fields saturated above —
        // uncompressed(8), compressed(8), local-header offset(8), disk(4). Recover compressed size and offset.
        if (cdComp32 === 0xffffffff || cdUncomp32 === 0xffffffff || lho32 === 0xffffffff || cdDisk32 === 0xffff) {
          const z = findExtra(q + 46 + cdNameLen, cdExtraLen, 0x0001);
          if (!z) return false;
          let zo = z.off;
          if (cdUncomp32 === 0xffffffff) { zo += 8; }                       // skip uncompressed (not needed here)
          if (cdComp32 === 0xffffffff) { cdComp = readU64(zo); zo += 8; }
          if (lho32 === 0xffffffff) { lho = readU64(zo); zo += 8; }
          if (zo > z.off + z.size || !Number.isFinite(cdComp) || cdComp < 0 || !Number.isFinite(lho) || lho < 0) return false;
        }
        if (vet(lho, cdComp) === false) return false;
        q += 46 + cdNameLen + cdExtraLen + buf.readUInt16LE(q + 32);
        seenCd++;
      }
    }
    return sawLocal || vetted.size > 0;
  } catch (_) {
    return false;   // any parse trouble -> be safe, don't hand it to the inflating reader
  }
}

module.exports = { zipWithinBudget };
