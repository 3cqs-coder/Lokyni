'use strict';
// Workspace backup and restore — streaming.
//
// A backup is a single `.lokb` file containing one workspace: its documents, its
// vector index, and its indexed-folder settings. That makes a workspace portable —
// move it to another machine, snapshot it before a risky change, or archive a
// finished project and delete it locally.
//
// Everything streams. An earlier version buffered the whole workspace, concatenated
// it, gzipped it, and held the result for the HTTP response — roughly four copies of
// the corpus in memory at peak, which a multi-gigabyte document set will not
// survive. Files are now read and written one at a time through a gzip stream, so
// memory use is bounded by the largest single file rather than the archive size.
//
// No new dependencies: Node's zlib and crypto provide streaming compression and
// encryption, and the container is a simple length-prefixed format. That avoids
// archiver (whose export shape changed in v8) and unzipper entirely.
//
// Wire format:
//   [8 bytes ] magic "LOKYNIBK"
//   [1 byte  ] format version (2)
//   [1 byte  ] flags — bit 0: encrypted
//   [4 bytes ] header length (uint32 BE)
//   [N bytes ] JSON header (workspace meta, entry list with sizes + checksums)
//   [16 bytes] scrypt salt   \  encrypted only
//   [12 bytes] GCM iv         |
//   [16 bytes] GCM auth tag  /   (written last — see note in createBackupStream)
//   [...     ] payload — gzip stream of every file's bytes, in header order
const fs     = require('fs');
const fsp    = fs.promises;
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { isWithin } = require('./paths');
const { renameSyncWithRetry } = require('./disk');
const { Readable, PassThrough } = require('stream');

const MAGIC   = Buffer.from('LOKYNIBK', 'ascii');
// v3 adds two things over v2: the cleartext header is authenticated as GCM additional-authenticated-data (so a
// tamper of its checksums/paths/kdf is detected, not just the payload), and the header is self-describing about
// the cipher. v2 archives are still read (their payload-only tag is verified, no header AAD), so existing
// encrypted backups keep restoring — a .lokb is a portable user artifact, not a disposable build output.
const VERSION = 3;
const CIPHER  = 'aes-256-gcm';
const EXT     = '.lokb';
// An absolute ceiling on the entry count read from an untrusted header — well above any real workspace, below
// what the 64 MB header cap implicitly allows — so a crafted archive can't drive millions of filesystem ops.
const MAX_ENTRIES = 200000;
// An absolute ceiling on the TOTAL declared bytes a restore will write, independent of the header's own declared
// sizes, so a malicious archive (a huge entry that gzips tiny yet checksum-matches) can't fill the disk. 50 GB
// is far above any realistic workspace; a free-space pre-check (below) is the dynamic guard.
const MAX_RESTORE_BYTES = 50 * 1024 * 1024 * 1024;

// Recursively list files under a directory, returning paths relative to it.
// List every file under a workspace dir, as paths relative to it, skipping OS junk (macOS/Windows) so a
// backup never carries noise the user didn't create. Dotfiles that ARE real documents are kept — the backup
// must never silently drop one. Uses the shared depth-first walker (lib/fswalk) so the traversal skeleton
// lives in one place; only this skip policy is local.
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// Async walk for the backup planning pass, which runs on a request path and must not block a large tree.
const walkAsync = (root) => require('./fswalk').listFilesAsync(root, (name) => OS_JUNK.has(name));

// scrypt work factor for a NEW encrypted archive. A .lokb is portable and shareable, so the threat is
// offline brute force of a stolen archive; N=2^17 is in line with current guidance (the old N=2^14 was
// light). The parameters are written into the archive header so an older archive still decrypts with the
// factor it was made with. scrypt's memory need is ~128*N*r bytes, so maxmem must be raised above the 32 MB
// default for N=131072.
const KDF_PARAMS = { N: 131072, r: 8, p: 1 };
const LEGACY_KDF = { N: 16384, r: 8, p: 1 };   // archives written before the header carried kdf params
// Hard upper bounds for scrypt params. On restore these come from the UNTRUSTED archive header, so they must be
// clamped: an unvalidated N drove maxmem (below) proportionally, letting a crafted .lokb request a ~1 TB scrypt
// allocation and OOM/freeze the process. Validate every header kdf against these (see validKdf / readHeader),
// and size maxmem from the FIXED upper bound, never from the header.
const MAX_KDF = { N: 1 << 18, r: 8, p: 4 };
// Fixed ceiling, independent of any header — sized from the FIXED upper bound via the shared scrypt helper so the
// password hasher and this KDF derive their `maxmem` the same way and can't drift (same value as before).
const KDF_MAXMEM = require('./scrypt').maxmemForBounds(MAX_KDF);
// A kdf params object is acceptable only if N is a power of two in [1024, MAX_KDF.N] and r/p are within bounds.
const validKdf = (p) => !!p && Number.isInteger(p.N) && p.N >= 1024 && p.N <= MAX_KDF.N && require('./scrypt').isPowerOfTwo(p.N)
  && Number.isInteger(p.r) && p.r >= 1 && p.r <= MAX_KDF.r
  && Number.isInteger(p.p) && p.p >= 1 && p.p <= MAX_KDF.p;
// Derive the 32-byte AES key. ASYNC (crypto.scrypt on the libuv pool, not scryptSync) so the ~0.5-1s derivation
// at N=2^17 never blocks the event loop — backup/restore are serialized by the lifecycle lock, so one runs at a
// time. maxmem is the fixed KDF_MAXMEM, so a hostile header can't inflate it (params are also validated upstream).
const deriveKey = (passphrase, salt, params = LEGACY_KDF) => new Promise((resolve, reject) => {
  const p = validKdf(params) ? params : LEGACY_KDF;
  crypto.scrypt(String(passphrase), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: KDF_MAXMEM },
    (err, dk) => (err ? reject(err) : resolve(dk)));
});

// Hash a file without loading it: stream it through the digest.
const hashFileStream = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file)
    .on('data', d => h.update(d))
    .on('error', reject)
    .on('end', () => resolve(h.digest('hex')));
});

// Plan what goes into the archive: the entry list with sizes and checksums. This is
// a separate pass so the header can be written before the payload, which is what
// lets a reader know the layout without buffering the whole file.
const planBackup = async (dataDir, workspaceId, opts = {}) => {
  const wsm = require('./workspaces');
  const { includeIndex = true } = opts;

  const wsDir = wsm.workspaceDir(dataDir, workspaceId);
  if (!fs.existsSync(wsDir)) throw new Error(`Workspace "${workspaceId}" not found`);

  const meta = wsm.loadRegistry(dataDir).find(w => w.id === workspaceId)
    || { id: workspaceId, name: workspaceId };

  const rel = (await walkAsync(wsDir)).filter(p => {
    const norm = p.replace(/\\/g, '/');
    // The shadow directory is transient and possibly mid-write during a delta swap.
    if (norm.includes('vector_store/_shadow/')) return false;
    if (!includeIndex && norm.startsWith('vector_store/')) return false;
    return true;
  });

  const entries = [];
  let planned = 0;
  for (const r of rel) {
    const full = path.join(wsDir, r);
    // Async stat/hash so a large workspace's planning pass never blocks other requests. Yield periodically:
    // the hash is already async, but a long run of resolved I/O could still starve timers.
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    entries.push({
      path: r.replace(/\\/g, '/'),
      size: st.size,
      sha256: await hashFileStream(full),
    });
    if ((++planned % 200) === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    wsDir,
    header: {
      version: VERSION,
      created: Date.now(),
      app: 'lokyni',
      workspace: { id: meta.id, name: meta.name },
      includeIndex,
      entries,
      totalBytes: entries.reduce((s, e) => s + e.size, 0),
      kdf: KDF_PARAMS,   // the scrypt parameters a reader must use to derive the key (encrypted archives)
      cipher: CIPHER,    // self-describing: the AEAD used, so a future cipher change is a header field, not a guess
    },
  };
};

// ── Create (streaming) ──────────────────────────────────────────────────────
// Writes the archive to `out` (a writable stream — an HTTP response or a file).
// Memory stays bounded by the stream's high-water mark regardless of corpus size.
//
// Encryption note: GCM produces its auth tag only after the final block, but the
// header must be written first. The tag is therefore written into a fixed 16-byte
// slot that is back-patched when `out` is a file; for a non-seekable stream (an HTTP
// response) the payload is staged to a temp file first so the tag can be placed
// correctly. Unencrypted archives stream straight through with no staging.
const writeBackup = async (dataDir, workspaceId, out, opts = {}) => {
  const { passphrase = '' } = opts;
  const { wsDir, header } = await planBackup(dataDir, workspaceId, opts);
  const encrypted = !!passphrase;

  const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);

  // Source: every file's bytes, concatenated, read lazily one file at a time.
  const fileStream = Readable.from((async function* () {
    for (const e of header.entries) {
      const full = path.join(wsDir, e.path);
      for await (const chunk of fs.createReadStream(full)) yield chunk;
    }
  })());

  if (!encrypted) {
    out.write(Buffer.concat([MAGIC, Buffer.from([VERSION, 0]), lenBuf, headerBuf]));
    await pipeline(fileStream, zlib.createGzip({ level: 6 }), out, { end: true });
    return header;
  }

  // Encrypted: stage the ciphertext so the auth tag can be written before it.
  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, await deriveKey(passphrase, salt, KDF_PARAMS), iv);
  // Authenticate the cleartext header (checksums, paths, sizes, kdf, workspace) as additional data, so the GCM
  // tag covers it too — any tamper of the header fails decryption, not just a tamper of the payload bytes.
  cipher.setAAD(headerBuf);

  // Stage under the data directory, NOT os.tmpdir(). In the Docker image the root filesystem is
  // read-only and /tmp is a RAM-backed tmpfs, so staging a large encrypted archive there would balloon
  // container memory (tmpfs does not spill to disk) and can OOM — defeating this module's streaming,
  // memory-bounded design. The data directory is a real writable volume in every mode (standalone,
  // Docker, desktop), so the ciphertext streams to actual disk there.
  const stageDir = path.join(dataDir, 'tmp');
  await fs.promises.mkdir(stageDir, { recursive: true });
  const tmp = path.join(stageDir, `lokyni-bk-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await pipeline(fileStream, zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(tmp));
    const tag = cipher.getAuthTag();
    out.write(Buffer.concat([MAGIC, Buffer.from([VERSION, 1]), lenBuf, headerBuf, salt, iv, tag]));
    await pipeline(fs.createReadStream(tmp), out, { end: true });
    return header;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
};

// ── Read the header (cheap) ─────────────────────────────────────────────────
// Reads only the leading bytes, so inspecting a large archive costs nothing.
const readHeader = async (file) => {
  const fd = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(14);
    const { bytesRead } = await fd.read(head, 0, 14, 0);
    if (bytesRead < 14 || !head.subarray(0, 8).equals(MAGIC)) {
      throw new Error('Not a Lokyni backup file');
    }
    const version = head[8];
    if (version > VERSION) throw new Error(`Unsupported backup version ${version}`);
    const encrypted = head[9] === 1;
    const headerLen = head.readUInt32BE(10);
    if (headerLen > 64 * 1024 * 1024) throw new Error('Backup header is corrupt');

    const hb = Buffer.alloc(headerLen);
    const hRead = await fd.read(hb, 0, headerLen, 14);
    if (hRead.bytesRead < headerLen) throw new Error('Backup is truncated');   // file ends inside the header
    let header;
    try { header = JSON.parse(hb.toString('utf-8')); }
    catch { throw new Error('Backup header is corrupt'); }
    // Validate the SHAPE, not just that it is valid JSON: a crafted or corrupt header that parses to null, an
    // array, or an object missing entries[]/workspace would otherwise throw a raw TypeError later (on
    // header.entries.filter / header.workspace.id) — AFTER restore has already made the staging dir and
    // registered the workspace, stranding both. Fail closed here, before any side effect.
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(header) || !Array.isArray(header.entries) || !isObj(header.workspace)) {
      throw new Error('Backup header is corrupt');
    }
    // Reject a hostile/corrupt entry table before ANY side effect. The archive is untrusted, so validate every
    // field the restore loop trusts: a non-string path, a non-integer/negative size (which would make the
    // splitter loop forever with remaining=NaN, hanging restore under the lifecycle lock), a non-string sha256,
    // or an absurd entry count (an inode/filesystem-op DoS).
    if (header.entries.length > MAX_ENTRIES) throw new Error('Backup header is corrupt');
    for (const e of header.entries) {
      if (!isObj(e) || typeof e.path !== 'string' || !Number.isInteger(e.size) || e.size < 0 || typeof e.sha256 !== 'string') {
        throw new Error('Backup header is corrupt');
      }
    }
    // scrypt params, when carried, come from the untrusted header — reject out-of-range values up front rather
    // than feed them to key derivation (deriveKey also clamps/falls back, but fail loudly and early here).
    if (header.kdf !== undefined && !validKdf(header.kdf)) throw new Error('Backup header is corrupt');
    // We only support one AEAD; a header that names a different cipher is from an unsupported/forged archive.
    if (encrypted && header.cipher !== undefined && header.cipher !== CIPHER) {
      throw new Error(`Unsupported backup cipher: ${header.cipher}`);
    }

    // Payload starts after the header, plus the crypto preamble when encrypted.
    const preamble = encrypted ? 44 : 0;   // 16 salt + 12 iv + 16 tag
    let salt = null, iv = null, tag = null;
    if (encrypted) {
      const cb = Buffer.alloc(44);
      const cRead = await fd.read(cb, 0, 44, 14 + headerLen);
      if (cRead.bytesRead < 44) throw new Error('Backup is truncated');   // file ends inside the crypto preamble
      salt = cb.subarray(0, 16); iv = cb.subarray(16, 28); tag = cb.subarray(28, 44);
    }
    // Return the raw header bytes too: v3 authenticates them as GCM AAD on restore (see restoreBackup).
    return { header, encrypted, salt, iv, tag, headerBuf: hb, payloadOffset: 14 + headerLen + preamble };
  } finally {
    await fd.close();
  }
};

const inspectBackup = async (file) => {
  const { header, encrypted } = await readHeader(file);
  const docs = header.entries.filter(e => e.path.startsWith('documents/'));
  return {
    workspace: header.workspace,
    created: header.created,
    encrypted,
    includeIndex: !!header.includeIndex,
    documentCount: docs.length,
    totalBytes: header.totalBytes,
    fileCount: header.entries.length,
  };
};

// ── Restore (streaming) ─────────────────────────────────────────────────────
// Reads the payload as one continuous stream and splits it into files using the
// header's sizes, writing each straight to disk. Nothing larger than a stream chunk
// is held in memory, and each file's checksum is verified as it is written.
const restoreBackup = async (dataDir, file, opts = {}) => {
  const wsm = require('./workspaces');
  const { passphrase = '', targetId = null, overwrite = false, dryRun = false, verify = false, beforeSwap = null } = opts;
  const startedAt = Date.now();

  const { header, encrypted, salt, iv, tag, headerBuf, payloadOffset } = await readHeader(file);
  if (encrypted && !passphrase) throw new Error('This backup is encrypted — a passphrase is required');

  let id = targetId || header.workspace.id;
  if (!wsm.isValidId(id)) id = wsm.slugify(header.workspace.name || 'restored');

  const exists = wsm.loadRegistry(dataDir).some(w => w.id === id);
  // A verify drill reports the archive's own workspace, not a free restore target: uniquifying here would
  // show an id that exists nowhere. The collision rule below applies only to a real restore.
  if (!verify && exists && !overwrite) {
    // Don't silently merge into an existing workspace — pick a free id instead.
    let n = 2;
    while (wsm.loadRegistry(dataDir).some(w => w.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }

  if (dryRun && !verify) {
    return {
      dryRun: true, workspaceId: id, willOverwrite: exists && overwrite,
      files: header.entries.length,
      documents: header.entries.filter(e => e.path.startsWith('documents/')).length,
    };
  }

  // `verify` is a restore DRILL: decrypt, decompress, and checksum every entry into a throwaway staging
  // directory, then discard it. It never registers, swaps, or touches a workspace, so it is safe to run against
  // live data and is the honest way to prove a backup is restorable before relying on it.
  const wsDir = verify
    ? path.join(dataDir, `.backup-verify-${crypto.randomBytes(6).toString('hex')}`)
    : wsm.workspaceDir(dataDir, id);
  // Restore into a staging directory beside the workspace, then swap it in only after the
  // ENTIRE archive has decrypted and every checksum has passed. This guarantees that a
  // wrong passphrase or a corrupt/truncated backup can never destroy the existing
  // workspace: the destructive step is a handful of fast, same-filesystem renames that run
  // last, not the up-front deletion it used to be.
  const stagingDir = `${wsDir}.restoring-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(stagingDir, { recursive: true });
  // Resolve the staging root. DATA_DIR is relative ("./data"), so comparing a resolved
  // absolute destination against a relative root never matches and every entry looks like
  // an escape attempt — which rejected perfectly ordinary files.
  const wsRoot = path.resolve(stagingDir);
  // Async removal: a verified multi-gigabyte staging copy must not block the event loop while it is deleted.
  const discardStaging = async () => { try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  // Validate every entry BEFORE writing anything — an archive is untrusted input, and discovering a bad entry
  // halfway through would leave a partial restore. (1) no entry escapes the staging root (zip-slip); (2) no two
  // entries collide case-insensitively — on a case-insensitive volume (Windows, default macOS APFS) they'd map
  // to one file, each passing its own checksum while one silently overwrote the other, a silent-data-loss
  // restore; (3) accumulate the declared total for the size + free-space checks below.
  const seenCaseFold = new Set();
  let declaredTotal = 0;
  for (const e of header.entries) {
    const dest = path.resolve(wsRoot, e.path);
    if (!isWithin(dest, wsRoot)) { await discardStaging(); throw new Error(`Refusing to write outside the workspace: ${e.path}`); }
    const foldKey = dest.toLowerCase();
    if (seenCaseFold.has(foldKey)) { await discardStaging(); throw new Error(`Refusing to restore: two entries differ only in letter case (${e.path})`); }
    seenCaseFold.add(foldKey);
    declaredTotal += e.size;
  }
  // Bound the total a hostile archive can write (a huge entry that gzips tiny yet checksum-matches could fill
  // the disk), and refuse up front if it won't fit rather than fill the volume mid-restore.
  if (declaredTotal > MAX_RESTORE_BYTES) { await discardStaging(); throw new Error('Backup is too large to restore'); }
  let freeSpace = 0;
  try { freeSpace = require('./disk').freeBytes(path.dirname(wsRoot)); } catch { freeSpace = 0; }
  if (freeSpace > 0 && freeSpace < declaredTotal + 64 * 1024 * 1024) { await discardStaging(); throw new Error('Not enough free disk space to restore this backup'); }
  // Ensure the workspace exists and is registered. Non-destructive for an existing one —
  // its data stays put until the verified swap below. Track whether we're CREATING it, so a
  // failed restore into a brand-new id doesn't leave a phantom empty workspace registered.
  // A verify drill registers nothing: it only needs its throwaway staging directory.
  const isNewWorkspace = !verify && !wsm.loadRegistry(dataDir).some(w => w.id === id);
  if (!verify) wsm.ensureWorkspace(dataDir, id);

  // Build the read pipeline: file → [decipher] → gunzip → splitter.
  let source = fs.createReadStream(file, { start: payloadOffset });
  const stages = [];
  if (encrypted) {
    const decipher = crypto.createDecipheriv(CIPHER, await deriveKey(passphrase, salt, header.kdf || LEGACY_KDF), iv);
    // v3 authenticated the header as AAD; feed the SAME bytes so the tag check covers it. v2 archives were sealed
    // without header AAD, so they verify on the payload alone — keeping existing encrypted backups restorable.
    if ((header.version || 0) >= 3) decipher.setAAD(headerBuf);
    decipher.setAuthTag(tag);
    stages.push(decipher);
  }
  stages.push(zlib.createGunzip());

  const out = new PassThrough();
  // Capture the pipeline's failure rather than letting it reject on its own. A wrong
  // passphrase surfaces here first (GCM auth or gzip header failure), and the read
  // loop below then ends early — so the error has to be stored and re-thrown, not
  // awaited afterwards, or it becomes an unhandled rejection that kills the process.
  let pipeError = null;
  const friendly = () => encrypted
    ? new Error('Wrong passphrase, or the backup file is damaged')
    : new Error('Backup payload is corrupt');
  const pipe = pipeline(source, ...stages, out).catch(() => { pipeError = friendly(); });

  let restored = 0;
  let pending = Buffer.alloc(0);
  let idx = 0;
  let handle = null;
  let remaining = 0;
  let hash = null;

  // Zip-bomb guard. The payload is gzip (optionally encrypted first), and a crafted archive can
  // declare a few small entries yet decompress to far more — the read loop below drains only up to
  // the declared entries, so without this the leftover would either grow `pending` without bound
  // (OOM) or burn CPU decompressing gigabytes of trailing junk. Stop as soon as the decompressed
  // stream exceeds what the declared entries legitimately need (their total plus a small slack for
  // gzip framing), and treat the excess as corruption. Backups are meant to be portable/shareable,
  // so restoring an attacker-supplied .lokb is a plausible flow.
  const DECOMPRESS_CEILING = declaredTotal + 1024 * 1024;   // 1 MB slack over the declared content (declaredTotal computed + bounded above)
  let seen = 0;

  const openNext = async () => {
    const e = header.entries[idx];
    const dest = path.resolve(wsRoot, e.path);
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      handle = await fs.promises.open(dest, 'w');
    } catch {
      // A filename legal on the OS that WROTE the backup can be illegal on THIS one (Windows reserves the
      // characters : * ? " < > | and the names CON/PRN/AUX/NUL/COM#/LPT#). Surface that specifically instead of
      // the misleading generic "corrupt" — the archive is fine, the filename just can't exist here.
      throw new Error(`Cannot restore "${e.path}" on this operating system (the filename is not allowed here)`);
    }
    remaining = e.size;
    hash = crypto.createHash('sha256');
  };

  const closeCurrent = async () => {
    const e = header.entries[idx];
    await handle.close();
    handle = null;
    if (hash.digest('hex') !== e.sha256) throw new Error(`Checksum mismatch: ${e.path}`);
    restored++;
    idx++;
  };

  try {
    // The stream may error mid-iteration (bad passphrase, corrupt payload); that
    // surfaces as a throw from the for-await, handled by the outer catch.
    for await (const chunk of out) {
      seen += chunk.length;
      if (seen > DECOMPRESS_CEILING) { source.destroy(); throw new Error('Backup payload is corrupt'); }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length > 0 && idx < header.entries.length) {
        if (!handle) {
          await openNext();
          // A zero-byte file has nothing to write, so close it immediately.
          if (remaining === 0) { await closeCurrent(); continue; }
        }
        const take = Math.min(remaining, pending.length);
        // Defensive: remaining is a validated non-negative integer, so take is >0 here; a non-positive take would
        // mean a corrupt state, so abort rather than risk a non-advancing loop.
        if (take <= 0) { source.destroy(); throw new Error('Backup payload is corrupt'); }
        const slice = pending.subarray(0, take);
        await handle.write(slice);
        hash.update(slice);
        remaining -= take;
        pending = pending.subarray(take);
        if (remaining === 0) await closeCurrent();
      }
    }
    await pipe;
    if (pipeError) throw pipeError;
    // Trailing zero-byte entries emit no payload, so the loop above (driven by payload chunks)
    // never opens them — drain them here before the truncation check, or a workspace whose last
    // walked file is empty would falsely fail to restore.
    while (idx < header.entries.length && header.entries[idx].size === 0) { await openNext(); await closeCurrent(); }
    if (idx < header.entries.length) throw new Error('Backup is truncated');
  } catch (err) {
    if (handle) { try { await handle.close(); } catch {} handle = null; }
    await pipe.catch(() => {});          // settle it so nothing rejects later
    // The restore failed before anything was swapped in — discard the staging dir so a
    // failed attempt leaves no partial copy behind, and the existing workspace intact. Async so a large
    // partial restore does not block the event loop while it is removed.
    try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
    // If this run CREATED the workspace, unregister and remove it so a failed restore into
    // a new id doesn't leave a phantom empty workspace in the picker.
    if (isNewWorkspace) {
      try { wsm.saveRegistry(dataDir, wsm.loadRegistry(dataDir).filter(w => w.id !== id)); } catch {}
      try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    }
    // A stream failure (bad passphrase, corrupt gzip) is reported as such; a
    // checksum mismatch or truncation is a real diagnosis and must not be masked.
    if (pipeError) throw pipeError;
    if (err && /Checksum mismatch|truncated|outside the workspace|not allowed here|letter case/.test(err.message)) throw err;
    throw friendly();
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
  }

  // A verify drill stops here: every entry decrypted, decompressed, and checksum-matched, so the archive is
  // provably restorable. Discard the staged copy and report; nothing registered, nothing swapped.
  if (verify) {
    await discardStaging();
    try { await fsp.rm(wsDir, { recursive: true, force: true }); } catch {}
    return {
      verified: true,
      workspace: { id: header.workspace.id, name: header.workspace.name || header.workspace.id },
      workspaceId: id,
      files: header.entries.length,
      documents: header.entries.filter(e => e.path.startsWith('documents/')).length,
      totalBytes: declaredTotal,
      encrypted,
      includeIndex: !!header.includeIndex,
      created: header.created,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Every file is staged and checksum-verified. Now perform the destructive swap: move
  // each staged top-level entry into the workspace, replacing any existing copy. These are
  // fast same-filesystem renames (the old copy is moved aside first, then removed on
  // success), so the window in which the workspace is inconsistent is minimal — and it only
  // opens after the archive has fully, verifiably restored.
  //
  // Let the caller quiesce the target first (only now, so a failed verification above never
  // disturbs a running workspace). When restoring OVER the active workspace, the caller stops
  // its watchers and waits out any in-flight re-index here, so a concurrent delta can't write
  // into the directory mid-swap and corrupt the just-restored index.
  if (typeof beforeSwap === 'function') {
    try { await beforeSwap(id); }
    catch {
      // Quiescing the target failed — do NOT proceed with the destructive swap: a still-live watcher/delta could
      // write into the directory mid-swap and corrupt the restore. Abort cleanly (staging discarded, a freshly
      // created workspace removed); the existing data is left exactly as it was.
      await discardStaging();
      if (isNewWorkspace) {
        try { wsm.saveRegistry(dataDir, wsm.loadRegistry(dataDir).filter(w => w.id !== id)); } catch {}
        try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
      }
      throw new Error('Could not prepare the workspace for the swap — restore aborted (existing data unchanged)');
    }
  }
  const swapTag  = crypto.randomBytes(6).toString('hex');
  const topNames = [...new Set(header.entries.map(e => e.path.split('/')[0]).filter(Boolean))];
  // Track every completed swap so a failure partway through rolls back ALL of them — an overwrite restore
  // must leave the existing workspace exactly as it was, never half-applied (e.g. new documents + stale index).
  // The moved-aside old copies are kept until EVERY entry has swapped in (the commit step), so any entry can
  // still be reverted; they are renames on the same filesystem, so holding them costs no extra disk.
  const done = [];
  try {
    for (const name of topNames) {
      const staged = path.join(stagingDir, name);
      const target = path.join(wsDir, name);
      const aside  = `${target}.old-${swapTag}`;
      if (!fs.existsSync(staged)) continue;
      let movedAside = false;
      try { if (fs.existsSync(target)) { renameSyncWithRetry(target, aside); movedAside = true; } } catch {}
      try {
        renameSyncWithRetry(staged, target);
      } catch (e) {
        // The staged→target rename failed after the old copy was moved aside. Restore the old
        // copy so the workspace isn't left missing this directory, then rethrow (the outer catch
        // rolls back the entries that already swapped).
        if (movedAside) { try { renameSyncWithRetry(aside, target); } catch {} }
        throw e;
      }
      done.push({ staged, target, aside, movedAside });
    }
    // Every entry swapped in — the restore is committed. Only now drop the old copies.
    for (const d of done) { if (d.movedAside) { try { fs.rmSync(d.aside, { recursive: true, force: true }); } catch {} } }
  } catch (e) {
    // A swap failure (a rare same-filesystem rename error). Roll back every entry already swapped, in reverse:
    // move the restored copy back to staging, then move the old copy back into place — so the existing
    // workspace is restored intact. Then clean up like the verify path: discard staging, and unregister+remove
    // a workspace this run created so it doesn't linger as a phantom.
    for (let i = done.length - 1; i >= 0; i--) {
      const d = done[i];
      try { if (fs.existsSync(d.target)) renameSyncWithRetry(d.target, d.staged); } catch {}
      try { if (d.movedAside && fs.existsSync(d.aside)) renameSyncWithRetry(d.aside, d.target); } catch {}
    }
    try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
    if (isNewWorkspace) {
      try { wsm.saveRegistry(dataDir, wsm.loadRegistry(dataDir).filter(w => w.id !== id)); } catch {}
      try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    }
    throw e;
  }
  // A documents-only restore over an existing workspace must invalidate the stale index so
  // it rebuilds against the restored documents rather than the ones it replaced. Safe to do
  // now — the restore has already succeeded.
  if (exists && overwrite && !topNames.includes('vector_store')) {
    try { fs.rmSync(path.join(wsDir, 'vector_store'), { recursive: true, force: true }); } catch {}
  }
  try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}

  // Register it if new. When the id had to be uniquified (restoring alongside an
  // existing workspace), the display name is disambiguated too — otherwise two
  // entries both read "Default" in the picker and there's no way to tell them apart.
  const list = wsm.loadRegistry(dataDir);
  if (!list.some(w => w.id === id)) {
    let name = header.workspace.name || id;
    if (list.some(w => w.name === name)) {
      const when = new Date(header.created || Date.now());
      name = `${name} (restored ${when.toISOString().slice(0, 10)})`;
    }
    list.push({ id, name, created: Date.now() });
    wsm.saveRegistry(dataDir, list);
  }

  // If the restore landed under a DIFFERENT id than the archive's original (a uniquified
  // restore-alongside), the restored document paths differ, so the archived outcome/rating "learning"
  // (records keyed by a hash of each document's absolute path) points at ids that no longer resolve.
  // Drop it so the restored workspace's learning is honestly empty rather than a dangling, inert set.
  // The semantic-answer cache needs no cleanup — its key already includes the workspace id, so its
  // entries self-retire.
  if (id !== header.workspace.id) {
    try { fs.rmSync(path.join(wsm.cacheDirFor(dataDir, id), 'outcomes.json'), { force: true }); } catch { /* best-effort */ }
  }

  return {
    workspaceId: id,
    restored,
    documents: header.entries.filter(e => e.path.startsWith('documents/')).length,
    includeIndex: !!header.includeIndex,
  };
};

const backupFilename = (workspaceId) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `lokyni-${workspaceId}-${stamp}${EXT}`;
};

// Remove orphaned backup temp artifacts left by a hard crash mid-create or mid-upload: the create-staging
// `lokyni-bk-*.tmp` files and old multer uploads under `DATA_DIR/tmp`. Both are cleaned per-request on the
// normal path; this age-gated boot sweep catches only what a crash left behind (older than maxAgeMs, default
// 1 hour — so a concurrent in-flight backup, including on another cluster node, is never touched). Best-effort:
// never throws, so a sweep failure can't block boot.
const sweepStaleTemp = (dataDir, maxAgeMs = 3600 * 1000) => {
  const now = Date.now();
  let removed = 0;
  const sweepDir = (dir, match) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }   // absent dir → nothing to sweep
    for (const n of names) {
      if (!match(n)) continue;
      const p = path.join(dir, n);
      try {
        if (now - fs.statSync(p).mtimeMs <= maxAgeMs) continue;   // too fresh — may be in use
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch { /* best-effort per entry */ }
    }
  };
  const tmp = path.join(dataDir, 'tmp');
  sweepDir(tmp, (n) => n.startsWith('lokyni-bk-') && n.endsWith('.tmp'));   // crashed create staging
  sweepDir(path.join(tmp, 'uploads'), () => true);                         // crashed restore/inspect uploads
  // A restore drill (Verify file) stages into data/.backup-verify-* and removes it in its finally. A crash
  // mid-drill leaves that copy behind, so sweep abandoned ones at boot. Age-gated like the rest, so a drill
  // actually running in another process is never deleted.
  sweepDir(dataDir, (n) => n.startsWith('.backup-verify-'));
  return removed;
};

// Recover from a crash DURING the final restore swap (see restoreBackup). The swap moves each live top-level
// workspace dir aside to "<name>.old-<tag>" inside the workspace, then renames the staged copy into "<name>"; a
// crash between those two renames leaves the live data ORPHANED in "<name>.old-<tag>" with "<name>" missing —
// and nothing else looks there, so the workspace would read as empty and the next delta would purge the index
// (effective data loss, even though the bytes physically survive). Run this ONCE at boot, on the primary, BEFORE
// the index/workspaces load and while nothing is serving (so there is no in-flight restore to race): for each
// "<name>.old-<tag>", rename it back when "<name>" is missing (recover the orphaned data), or remove it when
// "<name>" already exists (the swap completed; the aside copy is just a leftover). Also removes abandoned
// "<wsDir>.restoring-<tag>" staging dirs left by a crash before the swap. Returns the count recovered.
// Best-effort — never throws, so it can't block boot.
const OLD_SUFFIX_RE = /\.old-[0-9a-f]{6,}$/;
const recoverInterruptedRestores = (dataDir) => {
  const wsRoot = path.join(dataDir, 'workspaces');
  let recovered = 0;
  let top = [];
  try { top = fs.readdirSync(wsRoot, { withFileTypes: true }); } catch { return 0; }
  for (const d of top) {
    if (!d.isDirectory()) continue;
    const full = path.join(wsRoot, d.name);
    // Abandoned staging dir beside a workspace (crash during streaming/verify, before any swap began).
    if (d.name.includes('.restoring-')) { try { fs.rmSync(full, { recursive: true, force: true }); } catch {} continue; }
    // Interrupted swap: a "<name>.old-<tag>" aside inside a real workspace dir.
    let kids = [];
    try { kids = fs.readdirSync(full); } catch { continue; }
    for (const name of kids) {
      if (!OLD_SUFFIX_RE.test(name)) continue;
      const aside = path.join(full, name);
      const base = path.join(full, name.replace(OLD_SUFFIX_RE, ''));
      try {
        if (!fs.existsSync(base)) { renameSyncWithRetry(aside, base); recovered++; console.log(`  ↩️  Recovered interrupted restore: ${path.basename(base)} in workspace "${d.name}"`); }
        else { fs.rmSync(aside, { recursive: true, force: true }); }
      } catch { /* best-effort — leave it for the next boot */ }
    }
  }
  return recovered;
};

module.exports = { writeBackup, readHeader, inspectBackup, restoreBackup, backupFilename, sweepStaleTemp, recoverInterruptedRestores, EXT };
