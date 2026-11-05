'use strict';
// Streaming persistence for the parent-document map (parent-map.json), which holds the FULL text of every
// indexed document and is therefore the largest cache. It is stored as NDJSON — one JSON record per line,
// `{"id":...,"content":...,"metadata":...}` — so neither writing nor reading ever builds a single string
// spanning the whole corpus. That single whole-corpus string was the memory ceiling for handling a
// corpus of any size: it made the corpus text exist twice during a commit (the Map plus the serialized
// string) and could exhaust memory on a very large library. With NDJSON the peak transient is one
// document at a time, which already has to be resident in the Map anyway.
//
// The writer streams with backpressure and uses the temp-file + atomic-rename discipline, so a process
// crash mid-write can never truncate the live file. The reader streams line by line. Both are async and
// never block the event loop on a giant serialize/parse.
//
// Fail CLOSED, not open. NDJSON has no global terminator, so a file truncated at a line boundary (power
// loss, a full disk, a lost concurrent-rename race) would otherwise read as valid NDJSON with fewer
// documents — a silent partial corpus that survives restarts, because the delta pass reconciles disk
// against the manifest, not against the parent map. To prevent that, the writer appends a trailing
// sentinel record (`{"_end":1,"n":<count>}`) proving the whole file was written, and the reader treats a
// missing/short sentinel, a count mismatch, a corrupt line, or a read error as corruption: it discards
// what it loaded and returns ok:false, so the caller re-derives the corpus from source (self-heal) —
// matching the old whole-JSON reader, where any truncation broke JSON.parse and forced a rebuild.
//
// Each write goes to a UNIQUE temp name, so two concurrent writers (e.g. two requests both migrating a
// legacy cache) can never interleave into one shared temp file; each writes a complete file and the last
// rename wins with valid content.
//
// Backward compatibility: an older parent-map.json written as one whole-corpus JSON object is detected
// and read (a one-time cost, no worse than the previous every-load behavior), then rewritten as NDJSON so
// the next load takes the streaming path. A document id is a hex hash, so the legacy object always starts
// `{"<hex>":{` and the NDJSON form always starts `{"id":"` or the sentinel `{"_end":` — unambiguous.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');

const SENTINEL_PREFIX = '{"_end":';

// Write a parent map to `file` as NDJSON, atomically (unique temp + rename) and with write backpressure
// so a huge corpus streams to disk without buffering the whole thing. Each record is one document; a
// trailing sentinel records the document count so a truncated file is detectable on read.
const writeParentMap = async (file, parentMap) => {
  const tmp = require('../disk').uniqueTmp(file);   // shared collision-avoiding temp name (pid + crypto random)
  const out = fs.createWriteStream(tmp, { encoding: 'utf-8', flags: 'w' });
  // A promise that settles on the stream's terminal events, so an I/O error (e.g. disk full) rejects the
  // write rather than hanging a pending drain.
  const closed = new Promise((resolve, reject) => { out.on('error', reject); out.on('finish', resolve); });
  try {
    let count = 0;
    for (const [id, v] of parentMap) {
      const line = JSON.stringify({ id, content: v.content, metadata: v.metadata }) + '\n';
      if (!out.write(line)) await Promise.race([once(out, 'drain'), closed]);   // closed rejects on error
      count++;
    }
    out.write(`${SENTINEL_PREFIX}1,"n":${count}}\n`);   // proves the file is complete
    out.end();
    await closed;
    // fsync before rename (same durability discipline as the other atomic writers) so a crash just after the
    // rename can't surface a file the OS had not yet flushed. The fail-closed sentinel catches a torn file
    // regardless; this avoids a needless full re-derive of the whole parent map after an unlucky crash.
    await require('../disk').fsyncFile(tmp);
    await require('../disk').renameWithRetry(tmp, file);
  } catch (e) {
    out.destroy();
    try { await fs.promises.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
};

// True if `file` begins with an NDJSON parent-map record (`{"id":"…`) or the sentinel (an empty corpus is
// sentinel-only), reading only a small prefix so a large legacy file is never loaded just to classify it.
// A missing/empty file returns false.
const isNdjson = async (file) => {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const head = buf.subarray(0, bytesRead).toString('utf-8').replace(/^﻿/, '').replace(/^\s+/, '');
    return head.startsWith('{"id":"') || head.startsWith(SENTINEL_PREFIX);
  } catch { return false; } finally { try { await fh.close(); } catch {} }
};

// Read a parent map from `file` into `targetMap` (a Map, expected empty). Handles both the NDJSON form
// (streamed line by line) and the legacy whole-JSON form (parsed once, then migrated to NDJSON so the
// next load streams). Returns { count, legacy, present, ok }. `ok` is false when the file is corrupt,
// truncated, or unreadable; in that case the target map is cleared so the caller re-derives from source
// rather than serving a silent partial corpus. Never throws.
const loadParentMap = async (file, targetMap, opts = {}) => {
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
        if (rec && typeof rec.id === 'string' && typeof rec.content === 'string') {
          targetMap.set(rec.id, { content: rec.content, metadata: rec.metadata });
          count++;
        } else { skipped++; }
      }
    } catch { readErr = true; }
    finally { rl.close(); }
    const ok = sawEnd && !skipped && !readErr && (endN === null || endN === count);
    if (!ok) {
      // Fail closed — a torn/short/corrupt cache must not be served as a partial corpus. Discard it so
      // the caller re-derives from source (self-heal), and say so rather than failing silently.
      targetMap.clear();
      try { console.warn(`⚠️  parent-map cache for ${path.basename(path.dirname(file))} looks incomplete (loaded ${count}, sentinel ${endN}, skipped ${skipped}) — rebuilding from documents`); } catch {}
      return { count: 0, legacy: false, present, ok: false };
    }
    return { count, legacy: false, present, ok: true };
  }

  // Legacy whole-JSON: parse once (no worse than the previous behavior), then migrate to NDJSON. A
  // truncated legacy file breaks JSON.parse and is treated as corrupt (ok:false → caller re-derives).
  // Guard the SIZE first: the parent map holds every document's FULL text, so a large pre-NDJSON corpus's
  // legacy file is the most likely to OOM a whole-file parse. Above the shared bound, re-derive from source
  // (re-extract) instead, which rewrites it as streaming NDJSON. Never trade an OOM crash for a migration.
  let legacySize = 0;
  try { legacySize = (await fs.promises.stat(file)).size; } catch {}
  const maxLegacy = Number.isFinite(opts.maxLegacyBytes) ? opts.maxLegacyBytes : require('./ndjsonmapstore').MAX_LEGACY_PARSE_BYTES;
  if (legacySize > maxLegacy) {
    targetMap.clear();
    try { console.warn(`⚠️  legacy parent-map for ${path.basename(path.dirname(file))} is ${Math.round(legacySize / 1048576)} MB — too large to parse into memory; re-deriving from source (it will be rewritten as streaming NDJSON)`); } catch {}
    return { count: 0, legacy: true, present, ok: false };
  }
  let count = 0, skipped = 0;
  try {
    const obj = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    for (const [id, entry] of Object.entries(obj || {})) {
      if (entry && typeof entry.content === 'string') { targetMap.set(id, { content: entry.content, metadata: entry.metadata }); count++; }
      else skipped++;
    }
  } catch { targetMap.clear(); return { count: 0, legacy: true, present, ok: false }; }
  // Fail closed on a dropped entry, matching the NDJSON path above — a legacy file with any non-string-content
  // entry is incomplete; serving the rest as ok would silently lose a document (never-drop). Re-derive instead.
  if (skipped) {
    targetMap.clear();
    try { console.warn(`⚠️  legacy parent-map for ${path.basename(path.dirname(file))} has ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'} — rebuilding from documents`); } catch {}
    return { count: 0, legacy: true, present, ok: false };
  }
  // Migrate to NDJSON so the next load streams — UNLESS the caller is a read-only, non-active loader
  // (migrate:false), which must not rewrite the file (a fresh mtime on a non-active workspace would defeat the
  // freshness gate and could resurrect a concurrently-deleted document). The active path migrates.
  if (count > 0 && opts.migrate !== false) { try { await writeParentMap(file, targetMap); } catch { /* migration is best-effort */ } }
  return { count, legacy: true, present, ok: true };
};

module.exports = { writeParentMap, loadParentMap, isNdjson };
