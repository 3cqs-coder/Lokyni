'use strict';
// Bundled ffmpeg — fetched once into the data directory so media decoding runs the SAME build on every install,
// never a system binary of unknown version/codecs.
//
// ffmpeg is the one genuinely-external spawn Lokyni uses for ingestion: no pure-Node library decodes arbitrary
// audio/video codecs, so decoding a compressed or container media file is a case where a spawn is necessary.
// This module downloads a static ffmpeg into `<data>/bin` on first use and reuses it forever after. A system
// ffmpeg on PATH is NEVER used — the whole point is a consistent, self-contained engine — so when the download
// is unavailable (offline, blocked), media simply degrades to name-only indexing and `.wav` still works through
// the native decoder (see audioingest.js). Every child is tracked and force-killed on timeout and on shutdown,
// so a decode can never orphan a process (mirroring the URL-ingestion browser and parse-child backstops).
//
// Download sources (static builds, extracted with the in-process zip reader — no system unzip):
//   macOS / Linux : ffmpeg.martin-riedl.de (native arm64 + amd64)
//   Windows       : github.com/BtbN/FFmpeg-Builds (latest gpl — ffmpeg.exe nested under bin/)

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const SAMPLE_RATE = 16000;   // decode target: what the STT core consumes

// Active ffmpeg children, so the shutdown orchestrator can SIGKILL any still running (never-orphan).
const _active = new Set();
const killAll = () => { for (const c of _active) { try { c.kill('SIGKILL'); } catch {} } _active.clear(); };

const isWin = () => process.platform === 'win32';
const binDir = () => path.join(require('../config').DATA_DIR, 'bin');
const bundledPath = () => path.join(binDir(), isWin() ? 'ffmpeg.exe' : 'ffmpeg');

// Does the binary at `p` exist AND run (`-version` exits 0)? Guards a truncated / half-extracted download being
// treated as usable. Bounded so a quarantined or stalled binary can't block (runs synchronously).
const works = (p) => {
  try {
    if (!p || !fs.existsSync(p)) return false;
    const r = spawnSync(p, ['-version'], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
};

// Resolve the bundled ffmpeg: the data/bin binary when present and working, else null. A system/PATH ffmpeg is
// deliberately never considered. Cheap (an fs stat + a memoized -version check), safe to call from a route.
let _okCache = null, _okCacheFor = null;
const resolvePath = () => {
  const p = bundledPath();
  if (_okCache !== null && _okCacheFor === p) return _okCache ? p : null;
  _okCacheFor = p; _okCache = works(p);
  return _okCache ? p : null;
};
// Forget the cached result (after a fresh download, or to force a re-probe).
const resetResolver = () => { _okCache = null; _okCacheFor = null; };
const isAvailable = () => !!resolvePath();

// Redirect-following HTTPS/HTTP download to a file, with a progress line. Ported from the proven setup used
// elsewhere: the martin-riedl 'redirect/latest' URLs 3xx to the real asset, and GitHub releases redirect to a
// CDN, so redirects must be followed. A stalled connection aborts after the timeout rather than hanging.
const download = (dlUrl, dest) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(dest);
  const mod = dlUrl.startsWith('https') ? https : http;
  const req = mod.get(dlUrl, { headers: { 'User-Agent': 'Lokyni' }, timeout: 30000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close(); try { fs.unlinkSync(dest); } catch {}
      let next = res.headers.location;
      if (next.startsWith('/')) { const u = new URL(dlUrl); next = u.protocol + '//' + u.host + next; }
      else if (!next.startsWith('http')) { next = dlUrl.replace(/[^/]+$/, '') + next; }
      return download(next, dest).then(resolve).catch(reject);
    }
    if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dest); } catch {} return reject(new Error('HTTP ' + res.statusCode)); }
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let got = 0, lastPct = -1;
    res.on('data', (c) => {
      got += c.length;
      if (total > 0) { const pct = Math.floor(got / total * 100); if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; try { require('../logbuffer').progress(`   ⬇️  Downloading ffmpeg… ${pct}%`); } catch {} } }
    });
    res.on('error', (e) => { try { file.close(); } catch {} try { fs.unlinkSync(dest); } catch {} reject(e); });
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('download timed out')));
  req.on('error', (e) => { try { file.close(); } catch {} try { fs.unlinkSync(dest); } catch {} reject(e); });
});

// Extract the single ffmpeg binary from a downloaded zip with the in-process zip reader (jszip) — no dependency
// on a system `unzip`/PowerShell, which is absent from many minimal Linux/Docker/Windows images. martin-riedl's
// archive holds a bare `ffmpeg`; BtbN's nests it under `ffmpeg-*/bin/ffmpeg.exe`. Writes it to data/bin.
const extractFfmpeg = async (zipPath) => {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const want = isWin() ? 'ffmpeg.exe' : 'ffmpeg';
  let entry = null;
  zip.forEach((rel, f) => { if (!f.dir && path.posix.basename(rel).toLowerCase() === want) entry = f; });
  if (!entry) throw new Error('ffmpeg binary not found in archive');
  const out = bundledPath();
  fs.writeFileSync(out, await entry.async('nodebuffer'));
  try { fs.chmodSync(out, 0o755); } catch {}
};

// The static-build source(s) for this platform/arch, tried in order. Future-proof: adding or reordering a mirror
// is a one-line change here, and the download/extract/validate loop is source-agnostic.
const sourcesFor = (plat, arch) => {
  const a = arch === 'arm64' ? 'arm64' : 'amd64';   // martin-riedl uses amd64 for x64
  if (plat === 'darwin') return [`https://ffmpeg.martin-riedl.de/redirect/latest/macos/${a}/release/ffmpeg.zip`];
  if (plat === 'linux')  return [`https://ffmpeg.martin-riedl.de/redirect/latest/linux/${a}/release/ffmpeg.zip`];
  if (plat === 'win32')  return ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'];
  return [];
};

// Fetch ffmpeg into data/bin if it isn't already there and working. Concurrency-safe (an atomic mkdir lock, so
// two processes can't download into the shared dir at once), non-fatal, and NEVER falls back to a system ffmpeg.
// Returns the bundled path, or null when it couldn't be produced (the caller then degrades). One in-flight
// attempt is shared so concurrent callers don't each try.
let _ensuring = null;
const ensure = () => {
  const have = resolvePath();
  if (have) return Promise.resolve(have);
  if (_ensuring) return _ensuring;
  _ensuring = _ensure().finally(() => { _ensuring = null; });
  return _ensuring;
};
const _ensure = async () => {
  const dir = binDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const out = bundledPath();
  if (works(out)) { resetResolver(); return out; }

  const sources = sourcesFor(process.platform, process.arch);
  if (!sources.length) { try { require('../logbuffer').progress('   ⚠️  No bundled ffmpeg build for this platform — install it in the data/bin folder to enable compressed/video formats.'); } catch {} return null; }

  // Only one process downloads at a time. mkdir is atomic across processes: the winner downloads; a loser waits
  // for the binary to appear and reuses it (taking over if the winner dies without producing it).
  const lockDir = path.join(dir, '_ffmpeg.lock');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A process SIGKILLed mid-download leaves the lock dir behind; reclaim one older than the max download window so
  // it can't wedge setup for every later attempt. (A live download refreshes well within this.)
  const LOCK_STALE_MS = 240000;
  const reclaimIfStale = () => { try { if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockDir, { recursive: true, force: true }); } } catch {} };
  let haveLock = false;
  try { fs.mkdirSync(lockDir); haveLock = true; } catch { reclaimIfStale(); try { fs.mkdirSync(lockDir); haveLock = true; } catch { /* a live holder */ } }
  if (!haveLock) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (works(out)) { resetResolver(); return out; }
      reclaimIfStale();
      if (!fs.existsSync(lockDir)) { try { fs.mkdirSync(lockDir); haveLock = true; break; } catch {} }
    }
    if (!haveLock) { if (works(out)) { resetResolver(); return out; } return null; }
  }

  try {
    try { require('../logbuffer').progress('   ⬇️  Setting up ffmpeg (one-time download)…'); } catch {}
    for (const url of sources) {
      const tmp = path.join(dir, `_ffmpeg_dl.${process.pid}.${Date.now()}.zip`);
      try {
        await download(url, tmp);
        await extractFfmpeg(tmp);
        if (works(out)) { resetResolver(); try { require('../logbuffer').progress(`   ✓ ffmpeg ready (${process.platform} ${process.arch})`); } catch {} return out; }
      } catch (e) {
        try { require('../logbuffer').progress(`   ⚠️  ffmpeg source failed (${(e && e.message) || e}) — trying the next mirror if any`); } catch {}
      } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
    }
    return null;   // every source failed — degrade (WAV native still works; other media index by name)
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  }
};

// Decode a media file to a temporary headerless PCM file: 16 kHz, mono, signed 16-bit little-endian — exactly
// what the STT core consumes (after an Int16->Float32 scale). ffmpeg reads the input itself (streaming) and
// writes the temp file, so neither the media nor its full decoded audio is ever held in this process's memory.
// Bounded: `-t` caps the decoded duration at the source, and a wall-clock timeout SIGKILLs a wedged child.
// Fetches ffmpeg first if needed. Resolves { pcmPath, cleanup } (caller MUST call cleanup) or rejects;
// `.unavailable` marks that no bundled ffmpeg could be produced.
const decodeToPcmFile = async (inputPath, { maxSeconds } = {}) => {
  const bin = await ensure();
  if (!bin) throw Object.assign(new Error('ffmpeg not available'), { unavailable: true });
  // Write the temp PCM on the DATA volume (disk-backed), not os.tmpdir(): in the hardened container /tmp is a
  // memory-backed tmpfs, where a long recording's hundreds of MB of PCM would consume RAM. A disk-backed temp
  // keeps the decode OOM-proof regardless of the recording's length, and it is on the one writable volume when
  // the root filesystem is read-only.
  const tmpDir = path.join(require('../config').DATA_DIR, 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  // Best-effort sweep of PCM temps left by a previous hard-killed decode (older than the max decode window, so a
  // concurrent decode's file is never touched), so they can't accumulate on the data volume.
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('media-') && f.endsWith('.pcm')) {
        const p = path.join(tmpDir, f);
        try { if (now - fs.statSync(p).mtimeMs > 3600000) fs.rmSync(p, { force: true }); } catch {}
      }
    }
  } catch { /* sweep is best-effort */ }
  const pcmPath = path.join(tmpDir, `media-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pcm`);
  const cleanup = () => { try { fs.rmSync(pcmPath, { force: true }); } catch {} };
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le'];
  if (maxSeconds && maxSeconds > 0) args.push('-t', String(Math.ceil(maxSeconds)));   // cap decoded duration at the source
  args.push('-y', pcmPath);
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { cleanup(); return reject(e); }
    _active.add(child);
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    const timeoutMs = Math.max(60000, Math.ceil((maxSeconds || 0) * 1000)) + 60000;   // duration + a minute of headroom
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); _active.delete(child); fn(); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(() => { cleanup(); reject(Object.assign(new Error('ffmpeg decode timed out'), { timeout: true })); }); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', (e) => finish(() => { cleanup(); reject(e); }));
    child.on('close', (code) => finish(() => {
      if (code === 0) resolve({ pcmPath, cleanup, sampleRate: SAMPLE_RATE });
      else { cleanup(); reject(new Error(`ffmpeg exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`)); }
    }));
  });
};

module.exports = { resolvePath, resetResolver, isAvailable, ensure, decodeToPcmFile, killAll, bundledPath, works, SAMPLE_RATE };
