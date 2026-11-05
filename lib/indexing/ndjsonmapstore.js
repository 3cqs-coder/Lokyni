'use strict';
// Streaming NDJSON persistence for a SMALL-valued index map — the passage-offset map ({start,end} per
// chunk) and the child→parent link map (a parent id per chunk). These hold one entry per chunk across the
// whole corpus, so on a large library the old whole-file JSON.parse froze the event loop for hundreds of
// milliseconds to seconds at warm start and on every non-active-workspace load. Storing them as NDJSON —
// one `{"k":<key>,"v":<value>}` record per line — means neither writing nor reading ever builds or parses
// a single string spanning the whole corpus; the peak transient is one entry at a time.
//
// This is the same discipline as parentmapstore.js, generalized for a plain key/value map (the parent map
// keeps its own store because its records carry document content and metadata). The writer streams with
// backpressure to a UNIQUE temp file, then atomically renames, so a crash mid-write can never truncate the
// live file and two concurrent writers can't interleave. A trailing sentinel (`{"_end":1,"n":<count>}`)
// proves the file is complete; the reader FAILS CLOSED — a missing/short sentinel, a count mismatch, a
// corrupt line, or a read error discards what was loaded and returns ok:false, so the caller re-derives
// the map from source (self-heal) rather than serving a silent partial map. A legacy whole-JSON file is
// detected, read once, and rewritten as NDJSON so the next load streams.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');

const SENTINEL_PREFIX = '{"_end":';

// Largest legacy whole-JSON file we will JSON.parse into memory during a one-time migration. Parsing builds
// the whole string AND the parsed object (a 2-3x peak), so a very large pre-NDJSON file could OOM the process
// — the exact thing the NDJSON format exists to avoid. Above this bound we skip the parse and fail closed so
// the caller re-derives from source and rewrites the file as streaming NDJSON (one re-derive, then every load
// streams). Shared with parentmapstore so the bound can't drift between the two legacy readers.
const MAX_LEGACY_PARSE_BYTES = 256 * 1024 * 1024;   // 256 MB

// Write `map` to `file` as NDJSON, atomically and with write backpressure. Each entry is one `{k,v}` line;
// a trailing sentinel records the count so a truncated file is detectable on read.
const writeMap = async (file, map) => {
  const tmp = require('../disk').uniqueTmp(file);   // shared collision-avoiding temp name (pid + crypto random)
  const out = fs.createWriteStream(tmp, { encoding: 'utf-8', flags: 'w' });
  const closed = new Promise((resolve, reject) => { out.on('error', reject); out.on('finish', resolve); });
  try {
    let count = 0;
    for (const [k, v] of map) {
      const line = JSON.stringify({ k, v }) + '\n';
      if (!out.write(line)) await Promise.race([once(out, 'drain'), closed]);   // closed rejects on I/O error
      count++;
    }
    out.write(`${SENTINEL_PREFIX}1,"n":${count}}\n`);   // proves the file is complete
    out.end();
    await closed;
    // fsync the bytes before the rename, matching the durability discipline of the other atomic writers
    // (disk.js, manifest.js, saveStoreAtomic): a power loss just after the rename could otherwise surface a
    // file whose contents the OS had not flushed. The fail-closed sentinel catches a torn file either way, so
    // this just avoids a needless full re-derive after an unlucky crash.
    await require('../disk').fsyncFile(tmp);
    await require('../disk').renameWithRetry(tmp, file);
  } catch (e) {
    out.destroy();
    try { await fs.promises.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
};

// True if `file` begins with an NDJSON record (`{"k":`) or the sentinel (an empty map is sentinel-only),
// reading only a small prefix so a large legacy file is never fully loaded just to classify it.
const isNdjson = async (file) => {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const head = buf.subarray(0, bytesRead).toString('utf-8').replace(/^﻿/, '').replace(/^\s+/, '');
    return head.startsWith('{"k":') || head.startsWith(SENTINEL_PREFIX);
  } catch { return false; } finally { try { await fh.close(); } catch {} }
};

// Read `file` into `targetMap` (a Map, expected empty). Handles the NDJSON form (streamed) and the legacy
// whole-JSON form (parsed once, then migrated to NDJSON). Returns { count, legacy, present, ok }; `ok` is
// false when the file is corrupt/truncated/unreadable, and the target map is cleared so the caller
// re-derives from source rather than serving a partial map. Never throws.
const loadMap = async (file, targetMap, opts = {}) => {
  const present = true;
  try { await fs.promises.access(file); } catch { return { count: 0, legacy: false, present: false, ok: true }; }

  if (await isNdjson(file)) {
    let count = 0, skipped = 0, sawEnd = false, endN = null, readErr = false;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try { rec = JSON.parse(s); } catch { skipped++; continue; }
        if (rec && rec._end) { sawEnd = true; endN = typeof rec.n === 'number' ? rec.n : null; continue; }
        if (rec && typeof rec.k === 'string') { targetMap.set(rec.k, rec.v); count++; }
        else { skipped++; }
      }
    } catch { readErr = true; }
    finally { rl.close(); }
    const ok = sawEnd && !skipped && !readErr && (endN === null || endN === count);
    if (!ok) {
      targetMap.clear();
      try { console.warn(`⚠️  index map cache ${path.basename(file)} for ${path.basename(path.dirname(file))} looks incomplete (loaded ${count}, sentinel ${endN}, skipped ${skipped}) — rebuilding`); } catch {}
      return { count: 0, legacy: false, present, ok: false };
    }
    return { count, legacy: false, present, ok: true };
  }

  // Legacy whole-JSON: parse once (no worse than the previous behavior), then migrate to NDJSON. A
  // truncated legacy file breaks JSON.parse and is treated as corrupt (ok:false → caller re-derives).
  // Guard the SIZE first so an oversized legacy file is re-derived rather than OOM'ing the parse.
  let legacySize = 0;
  try { legacySize = (await fs.promises.stat(file)).size; } catch {}
  const maxLegacy = Number.isFinite(opts.maxLegacyBytes) ? opts.maxLegacyBytes : MAX_LEGACY_PARSE_BYTES;
  if (legacySize > maxLegacy) {
    targetMap.clear();
    try { console.warn(`⚠️  legacy map cache ${path.basename(file)} is ${Math.round(legacySize / 1048576)} MB — too large to parse into memory; re-deriving from source (it will be rewritten as streaming NDJSON)`); } catch {}
    return { count: 0, legacy: true, present, ok: false };
  }
  let count = 0;
  try {
    const obj = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    for (const [k, v] of Object.entries(obj || {})) { targetMap.set(k, v); count++; }
  } catch { targetMap.clear(); return { count: 0, legacy: true, present, ok: false }; }
  // Rewrite as NDJSON so the next load streams — unless the caller suppressed it (a read-only, non-active
  // reader must not write, since bumping the file's mtime would make freshness guards re-derive dependent maps).
  if (count > 0 && opts.migrate !== false) { try { await writeMap(file, targetMap); } catch { /* migration is best-effort */ } }
  return { count, legacy: true, present, ok: true };
};

module.exports = { writeMap, loadMap, isNdjson, MAX_LEGACY_PARSE_BYTES };
