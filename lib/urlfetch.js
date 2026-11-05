'use strict';
// URL fetch + article extraction for ingestion.
//
// Fetches a web page with a real headless browser (puppeteer + stealth), cleans
// junk out of the live DOM, then runs @extractus/article-extractor to pull the
// article body, title, and lead image. Returns clean text ready to be written as a
// document and indexed. Puppeteer is required — it's what gets past bot detection,
// Cloudflare, and JS-rendered pages that a plain fetch can't read.
//
// Cache & cleanup:
//   - The per-run browser profile and disk cache live under DATA_DIR/puppeteer_cache, so they
//     travel with the app's data and can be wiped with it. (The Chromium binary itself is not here:
//     it comes from Puppeteer's own install cache, a system browser, or PUPPETEER_EXECUTABLE_PATH.)
//   - Each fetch runs in a throwaway per-run profile dir under that cache root, and
//     that profile is removed after the fetch (background rm, retried on EBUSY).
//   - On process shutdown, any live browsers are force-closed and stale run_* dirs
//     are swept.
//
// The capture/clean approach follows a proven article-capture scraper design.

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const cacheRoot = () => path.join(require('./config').DATA_DIR, 'puppeteer_cache');
const BROWSER_TIMEOUT_MS = 60000;
// Plain-HTTP capture budget. Bounded body and time: this path is the cheap tier, so it must fail fast and
// small before the headless fallback. In-memory per-host hints are bounded and expire, so no state file or
// cross-run migration is needed.
const HTTP_CAPTURE_TIMEOUT_MS = 15000;
const MAX_HTTP_HTML = 4 * 1024 * 1024;
const CAPTURE_HINT_TTL_MS = 6 * 60 * 60 * 1000;
const CAPTURE_HINT_MAX = 200;
const captureHints = new Map();
const captureHint = (host) => {
  const h = captureHints.get(host);
  if (h && h.until > Date.now()) return h.method;
  if (h) captureHints.delete(host);
  return '';
};
const rememberCapture = (host, method) => {
  if (!host) return;
  if (captureHints.size >= CAPTURE_HINT_MAX && !captureHints.has(host)) {
    const oldest = captureHints.keys().next().value;
    if (oldest) captureHints.delete(oldest);
  }
  captureHints.set(host, { method, until: Date.now() + CAPTURE_HINT_TTL_MS });
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// Elements stripped from the live DOM before serialization, so the extractor gets
// pre-cleaned input. Anchored to class fragments (case-insensitive) to avoid
// catching legitimate elements.
const JUNK_SELECTORS = [
  '[class*="audio-player" i]', '[class*="listen-to-article" i]', '[id*="audio-player" i]',
  '[class*="newsletter-signup" i]', '[class*="newsletter-promo" i]', '[class*="subscribe-prompt" i]', '[class*="signup-form" i]',
  '[class*="share-bar" i]', '[class*="social-share" i]', '[class*="share-buttons" i]',
  '[class*="comments-section" i]', '[id="comments"]',
  '[class*="ad-container" i]', '[class*="ad-wrapper" i]', '[id*="ad-container" i]', 'iframe[src*="ads" i]',
  'script', 'style', 'noscript',
];

// Text-level residue stripped after extraction (things DOM cleaning misses).
const NOISE_PATTERNS = [
  /NEW\s*You can now listen to Fox News articles[!.]?/gi,
  /^\s*\(CNN\)\s*[—–-]\s*/m,
  /A version of this article appears in print on[^.]*\.\s*/gi,
  /Sign up (?:for|to receive) (?:our|the)[^.\n]{0,80}(?:newsletter|email|alerts?)[^.\n]{0,40}\./gi,
  /Subscribe to (?:our|the)[^.\n]{0,80}(?:newsletter|email|alerts?)[^.\n]{0,40}\./gi,
  /Follow (?:us|me) on (?:Twitter|X|Facebook|Instagram|TikTok|Threads|Bluesky)[^.\n]*\./gi,
  /Click here to (?:read|subscribe|sign up|learn more)[^.\n]{0,60}\./gi,
  /Read more:?\s*$/gim,
];

// ── Browser lifecycle ────────────────────────────────────────────────────────
let _puppeteer = null;
let _stealthTried = false;
const activeBrowsers = new Set();
let isShuttingDown = false;

// Concurrency gate for page captures. Each capture launches a full throwaway Chromium (~150-300 MB
// plus a renderer) and holds a large page string in the main process, so an unbounded burst — a script
// firing many ingest-url requests at once — would spawn dozens of browsers and OOM the process. Cap the
// number running at once and bound the wait queue so excess requests fail fast with backpressure rather
// than piling up. A cap of 2 keeps ingestion responsive without starving the rest of the server.
const { createSemaphore } = require('./semaphore');
const _browserGate = createSemaphore({ max: 2, queueMax: 24, message: 'Too many page fetches in progress — try again shortly' });
const acquireBrowserSlot = () => _browserGate.acquire();
const releaseBrowserSlot = () => _browserGate.release();

// Hard cap on the captured HTML string. A hostile or huge page (giant DOM, data-URI-stuffed markup,
// auto-loaded infinite scroll) would otherwise balloon main-process memory and the extractor's work.
const MAX_CAPTURED_HTML = 5_000_000;   // ~5 MB of characters

// Resolve puppeteer, preferring puppeteer-extra + stealth. Required dependency, so
// a failure to load plain puppeteer is a hard error surfaced to the caller.
const resolvePuppeteer = () => {
  if (_puppeteer) return _puppeteer;
  try {
    const pe = require('puppeteer-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    pe.use(stealth());
    _puppeteer = pe;
    if (!_stealthTried) { console.log('[urlfetch] puppeteer stealth enabled'); _stealthTried = true; }
  } catch {
    _puppeteer = require('puppeteer');   // throws if puppeteer itself is missing
  }
  return _puppeteer;
};

const randomString = (n) => require('crypto').randomBytes(n).toString('hex').slice(0, n);
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const createProfileDir = () => {
  const root = cacheRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `run_${Date.now()}_${randomString(8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Remove a directory, retrying on the transient errors a just-closed Chromium
// profile tends to throw (EBUSY / ENOTEMPTY / EPERM).
const rmDirSafe = async (target, { maxRetries = 5, baseDelay = 150 } = {}) => {
  if (!fs.existsSync(target)) return;
  let attempt = 0;
  while (true) {
    try { await fsp.rm(target, { recursive: true, force: true }); return; }
    catch (err) {
      const transient = ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(err.code);
      if (!transient || attempt >= maxRetries) return;
      attempt++;
      await wait(baseDelay * attempt);
    }
  }
};

// The Chromium sandbox is the safe default and works on a normal desktop install, so keep it ON
// there — it confines a renderer/V8 exploit in a hostile page to the sandbox. It only needs
// disabling where the process cannot create it: running as root, or in a container without
// user-namespace support (the Docker image runs as non-root but typically lacks user namespaces).
// Detecting those keeps the flag OFF a normal desktop, where dropping the sandbox around the
// untrusted pages URL ingestion renders would be a real weakening.
const needsNoSandbox = () => {
  try { if (typeof process.getuid === 'function' && process.getuid() === 0) return true; } catch { /* not POSIX */ }
  try { if (fs.existsSync('/.dockerenv')) return true; } catch { /* ignore */ }
  try { if (require('./config').ENFORCE_HOST_GUARD) return true; } catch { /* config not ready */ }
  return false;
};

const buildLaunchOptions = (profileDir, { proxyPort = 0, proxyUrl = '' } = {}) => ({
  headless: true,   // the string 'new' is deprecated; `true` selects the new headless mode on current Puppeteer
  acceptInsecureCerts: true,   // tolerate a self-signed/expired cert on a user-requested page (Puppeteer v23+ name; was ignoreHTTPSErrors)
  protocolTimeout: BROWSER_TIMEOUT_MS * 2,
  handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  // NOTE: do NOT add --disable-web-security. Article extraction reads the DOM the page rendered
  // under its own origin, so it never needs cross-origin fetches to succeed. Disabling web security
  // would let a page being ingested read cross-origin responses (a loopback service, a LAN host, the
  // cloud-metadata endpoint) that its own JavaScript fetched and beacon them out — turning the
  // structurally-blind SSRF that nethost.js accepts into a readable one. Same-origin enforcement stays on.
  args: [
    ...(needsNoSandbox() ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--disable-dev-shm-usage',
    '--disk-cache-size=52428800',
    ...(profileDir ? ['--user-data-dir=' + profileDir] : []),
    // Pin every connection through the loopback vetting proxy, so the page load cannot reach an internal
    // address or be DNS-rebound after the check — for the main navigation, redirects, AND subresources.
    // <-loopback> keeps Chromium from bypassing the proxy for loopback targets (its default), so even a
    // 127.0.0.1 subresource is routed to the proxy and refused. The caller FAILS CLOSED when the proxy can't
    // start (it never launches the browser without one), so there is no weaker "map only the main host"
    // fallback — the proxy is the single pinning boundary for every connection the page makes.
    // An outbound (egress) proxy, when configured, takes precedence: the browser connects straight to it, so
    // a REMOTE proxy can't reach this machine's localhost/LAN and the loopback vetting proxy is unnecessary
    // (the operator has chosen to trust the proxy's network). Otherwise pin every connection through the
    // loopback vetting proxy, so the page load cannot reach an internal address or be DNS-rebound after the
    // check — for the main navigation, redirects, AND subresources. <-loopback> keeps Chromium from bypassing
    // it for loopback targets. The caller FAILS CLOSED when the vetting proxy can't start, so (without an
    // egress proxy) it never launches without one — the proxy is the single pinning boundary.
    // <-loopback> on BOTH proxy modes: Chromium's default bypass list sends loopback targets DIRECT (skipping the
    // proxy). On the egress path that would let a hostile page's loopback subresource — and, critically, a
    // ws://127.0.0.1 WebSocket, which CDP request-interception does not cover and which is NOT read-blocked by
    // same-origin — reach this machine's own services. Removing loopback from the bypass list routes even a
    // loopback target through the proxy (the remote egress proxy can't reach our localhost; the local vetting
    // proxy refuses it), so neither mode leaves a loopback SSRF hole.
    ...(proxyUrl ? ['--proxy-server=' + proxyUrl, '--proxy-bypass-list=<-loopback>']
      : proxyPort ? ['--proxy-server=127.0.0.1:' + proxyPort, '--proxy-bypass-list=<-loopback>']
      : []),
  ],
});

// Common system-browser locations, checked only as a fallback. The packaged desktop app bundles no
// Chromium and has no Puppeteer install cache, so URL ingestion would otherwise fail there even
// though standalone (install-time download) and Docker (system Chromium via PUPPETEER_EXECUTABLE_PATH)
// work. Using an installed browser closes that gap for the common case without bundling ~150 MB.
const systemBrowserPaths = () => {
  const env = process.env;
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  if (process.platform === 'win32') return [
    `${env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${env.PROGRAMFILES || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${env.LOCALAPPDATA || ''}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    `${env.PROGRAMFILES || 'C:\\Program Files'}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  ];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'];
};
const findSystemBrowser = () => {
  for (const p of systemBrowserPaths()) { try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return '';
};

const launchBrowser = async (profileDir, pinOpts = {}) => {
  if (isShuttingDown) throw new Error('Cannot launch browser during shutdown');
  const puppeteer = resolvePuppeteer();
  const opts = buildLaunchOptions(profileDir, pinOpts);
  let browser;
  try {
    browser = await puppeteer.launch(opts);
  } catch (e) {
    // Puppeteer couldn't resolve a browser (typical in the packaged desktop app). Retry once with an
    // installed system browser if there is one; otherwise let the error propagate so URL ingestion
    // degrades to a clear "couldn't fetch" rather than crashing.
    const exe = findSystemBrowser();
    if (!exe) throw e;
    browser = await puppeteer.launch({ ...opts, executablePath: exe });
  }
  activeBrowsers.add(browser);
  browser.on('disconnected', () => activeBrowsers.delete(browser));
  return browser;
};

// Close every tracked browser — graceful first, then SIGKILL. Called on shutdown.
const closeAllBrowsers = async () => {
  isShuttingDown = true;
  try { require('./pinproxy').stopProxy(); } catch { /* best-effort — the proxy is unref'd anyway */ }
  await Promise.all(Array.from(activeBrowsers).map(async (browser) => {
    try {
      const proc = browser.process();
      if (browser.isConnected()) {
        const pages = await browser.pages().catch(() => []);
        await Promise.all(pages.map(p => p.close().catch(() => {})));
        await browser.close().catch(() => {});
      }
      if (proc && !proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    } catch {} finally { activeBrowsers.delete(browser); }
  }));
};

// Synchronous, unconditional SIGKILL of every tracked browser process. This is the last-ditch
// backstop wired to the process 'exit' event: the graceful closeAllBrowsers above is async, so it
// cannot complete on a synchronous exit (a process.exit() with no signal, or the shutdown hard
// timeout firing mid-close), which would otherwise orphan a Chromium — the one spawned process that
// does not die with the parent (worker threads and the fork child do). Idempotent and safe to run
// after a graceful close: an already-dead process kill is a harmless no-op.
const killAllBrowsersSync = () => {
  isShuttingDown = true;
  try { require('./pinproxy').stopProxy(); } catch { /* best-effort */ }
  for (const browser of activeBrowsers) {
    try {
      const proc = browser.process();
      if (!proc || proc.killed || proc.pid == null) continue;
      if (process.platform === 'win32') {
        // On Windows proc.kill maps to TerminateProcess, which does NOT cascade to Chromium's
        // renderer/GPU helper children — they would orphan. taskkill /T kills the whole process tree
        // and /F forces it. Synchronous so it completes inside the 'exit' handler.
        try { require('child_process').spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best-effort */ }
      } else {
        // Best-effort process-group kill first (reaps the helper tree if Chromium leads its own group),
        // then the parent directly. Any helper that still reparents is reaped by the init process —
        // tini as PID 1 in Docker, launchd/systemd-user otherwise.
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* no such group — fall through to the parent kill */ }
        try { proc.kill('SIGKILL'); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }
  activeBrowsers.clear();
};

// Sweep any leftover run_* profile dirs (e.g. from a previous crash) plus the whole
// cache root on request. Called on shutdown and available for manual cleanup.
const sweepStaleProfiles = async () => {
  try {
    const root = cacheRoot();
    if (!fs.existsSync(root)) return;
    for (const name of await fsp.readdir(root)) {
      if (name.startsWith('run_')) await rmDirSafe(path.join(root, name));
    }
  } catch {}
};

// ── Text cleanup ─────────────────────────────────────────────────────────────
// Strip all tags from a short field (title, author) or already-structured content. Linear (see htmlstrip)
// rather than /<[^>]*>/g, which is O(n²) on adversarial markup with many unclosed `<`. block:false so no
// newlines are injected into an inline field; comments are removed correctly (including any inner `>`).
const removeTags = (s) => require('./htmlstrip').stripTags(String(s || ''), { block: false });

const cleanExtractedText = (text) => {
  if (!text) return '';
  let out = String(text);
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, ' ');
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
};

// ── Capture ──────────────────────────────────────────────────────────────────
// Fetch a URL and return its rendered, junk-stripped HTML (or '' on failure).
const captureHtml = async (url, signal = null, proxyUrl = '') => {
  if (signal?.aborted) return '';   // caller already gone — don't take a browser slot
  await acquireBrowserSlot();   // throws (fast) when too many captures are already in flight
  let browser = null, profileDir = null, html = '';
  let onAbort = null;
  try {
    // Vet the target host up front so a private/unresolvable main host fails fast before a browser is even
    // launched. Then route the browser through the loopback vetting proxy, which pins AND re-vets EVERY
    // connection (main navigation, redirects, every subresource, and ws/wss) to a freshly vetted address —
    // closing the DNS-rebinding window for all of them, not just the main host.
    const pinOpts = { proxyPort: 0, proxyUrl: '' };
    const mainHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    // An outbound proxy, when configured, routes the browser's traffic through it. A remote proxy can't reach
    // this machine's localhost/LAN, so the loopback vetting proxy (whose job is exactly to stop that) isn't
    // needed on this path; the operator trusts the proxy's network. Mirrors the fetch path.
    const webProxy = String(proxyUrl || '');
    if (webProxy) {
      pinOpts.proxyUrl = webProxy;
    } else if (mainHost) {
      await require('./nethost').resolvePublicHost(mainHost);   // throws (refuse) if private
      try {
        pinOpts.proxyPort = await require('./pinproxy').ensureProxy();
      } catch (e) {
        // FAIL CLOSED. The proxy is the security boundary for fetching an untrusted URL in a real browser:
        // it is the only layer that covers WebSockets and re-vets every non-main host at connect time. The
        // old fallback (map only the main host + per-request interception) left WebSockets un-pinned and
        // reopened a DNS-rebinding TOCTOU for redirect/subresource hosts — a hostile page could then reach a
        // loopback / LAN / cloud-metadata endpoint. If the proxy can't start, refuse the capture rather than
        // fetch without the guarantee. (ensureProxy binds an ephemeral loopback port, so this is rare.)
        throw new Error('URL fetch is unavailable: the request-vetting proxy could not start.');
      }
    }
    profileDir = createProfileDir();
    browser = await launchBrowser(profileDir, pinOpts);
    // If the client disconnects (the caller aborts), close the browser now so the in-flight page load
    // rejects and this browser slot frees immediately, instead of holding it until the navigation timeout.
    if (signal) {
      onAbort = () => { try { browser && browser.close(); } catch {} };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });
    await page.setUserAgent(pickRandom(USER_AGENTS));

    // Guard EVERY request the page makes — the main-frame navigation and each redirect hop, but also every
    // subresource (image, script, iframe, fetch/XHR, beacon) — against the private-address check BEFORE the
    // browser connects. page.goto follows 3xx transparently and a hostile page can also embed subresources
    // pointing at loopback, a LAN host, or the cloud metadata endpoint; either way the browser would issue
    // that internal request (a blind-SSRF gap — the response need not reach the model to probe or trigger an
    // internal endpoint). A legitimate public page has no private-address subresources, so nothing normal is
    // blocked. Verdicts are cached per host for the page's lifetime so this costs at most one DNS check per
    // distinct host, not one per request. With interception on, every request must be resolved, so any
    // unexpected error falls back to continue.
    const { assertPublicHost: _assertPublicHost } = require('./nethost');
    const _hostOk = new Map();   // hostname → boolean (public?), cached for this page load
    const hostAllowed = async (host) => {
      if (_hostOk.has(host)) return _hostOk.get(host);
      let ok = true;
      try { await _assertPublicHost(host); } catch { ok = false; }
      _hostOk.set(host, ok);
      return ok;
    };
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        let host = '';
        try { host = new URL(req.url()).hostname; } catch { /* non-http scheme (data:, blob:) — allow */ }
        if (host && !(await hostAllowed(host))) {
          try { return await req.abort('blockedbyclient'); } catch { return; }
        }
        return await req.continue();
      } catch { try { return await req.continue(); } catch { /* request already handled */ } }
    });

    // Wait only for DOMContentLoaded here, not full network idle. Requiring networkidle2 made pages
    // with persistent background traffic (ads, analytics, tickers, live sockets) burn the entire
    // BROWSER_TIMEOUT_MS and then fail even though the article was already rendered; a bounded
    // network-idle settle below gives lazy content a chance without the stall.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
    });
    const statusError = captureHttpError(response && typeof response.status === 'function' ? response.status() : 0);
    if (statusError) throw statusError;

    // Re-validate the FINAL URL after any redirects. page.goto transparently follows 3xx, so a
    // public URL that redirects to a loopback/LAN/cloud-metadata address would otherwise be
    // captured and ingested — the same defense the web-search fetch applies to its final URL.
    // Refuse the capture (rather than serialize the private page) when the final host is not public.
    const finalUrl = (response && response.url()) || page.url() || url;
    try { await require('./nethost').assertPublicHost(new URL(finalUrl).hostname); }
    catch (e) { throw new Error(`Blocked redirect to a non-public address: ${e.message}`); }

    // Bounded settle: let lazily-loaded content arrive, but never wait longer than a few seconds even
    // if the page keeps chattering in the background. Swallow the timeout — a busy page is still served.
    try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }); } catch {}

    // Strip known-junk elements from the live DOM before serializing, so the
    // article extractor gets pre-cleaned input.
    try {
      await page.evaluate((selectors) => {
        selectors.forEach((sel) => { try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch {} });
      }, JUNK_SELECTORS);
    } catch {}

    // Slice the serialized DOM INSIDE the page before it crosses the CDP boundary, so a runaway page (a
    // document.write loop building a huge DOM during the settle window) can only ever transfer a bounded
    // string into the main process. A post-hoc slice of page.content() would first pull the whole multi-
    // hundred-megabyte string across, which is the OOM the cap exists to prevent.
    try { html = await page.evaluate((cap) => document.documentElement.outerHTML.slice(0, cap), MAX_CAPTURED_HTML); }
    catch {
      // Fallback only when the in-page slice failed (e.g. the frame detached). response.text() pulls the whole
      // body into this process, so refuse one whose declared size is far above the cap rather than buffering it;
      // a body with no content-length is rare here and already resident in the browser, so we still read it.
      if (response) {
        try {
          const declared = Number(response.headers()['content-length'] || 0);
          if (!declared || declared <= MAX_CAPTURED_HTML * 4) html = (await response.text()).slice(0, MAX_CAPTURED_HTML);
        } catch {}
      }
    }
    // Belt-and-suspenders: ensure the bound holds even if the fallback path returned more.
    if (html && html.length > MAX_CAPTURED_HTML) html = html.slice(0, MAX_CAPTURED_HTML);
  } catch (err) {
    console.error(`[urlfetch] capture failed for ${url}: ${err.message}`);
  } finally {
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    if (browser) {
      // Bound the close: a wedged browser.close() would otherwise hang this finally and never reach
      // releaseBrowserSlot() below, stalling the small capture gate (two wedged closes would block all URL
      // ingestion until process exit). Race it against a timeout; on timeout force-kill the browser process so
      // the slot frees now. The exit-time killAllBrowsersSync sweep remains the last-resort orphan backstop.
      let closeTimer;
      try {
        await Promise.race([
          browser.close(),
          new Promise((_, rej) => { closeTimer = setTimeout(() => rej(new Error('browser close timed out')), 10000); if (closeTimer.unref) closeTimer.unref(); }),
        ]);
      } catch {
        try { const p = browser.process && browser.process(); if (p && typeof p.kill === 'function') p.kill('SIGKILL'); } catch {}
      } finally {
        // Clear the race timer on the common fast-close path so it doesn't keep the event loop alive (up to
        // 10s) or accumulate one pending timer per capture — matching the clear/unref discipline elsewhere.
        clearTimeout(closeTimer);
      }
    }
    // Background cleanup of the per-run profile — don't block the fetch on rm.
    if (profileDir) rmDirSafe(profileDir).catch(() => {});
    releaseBrowserSlot();
  }
  return html;
};

// SSRF guard: refuse to fetch loopback/LAN/metadata targets. The check lives in the shared
// lib/nethost.js so URL ingestion and web search enforce the exact same policy.
const { assertPublicHost } = require('./nethost');

// A capture that ended on an HTTP error is not a source. page.goto follows redirects and returns the FINAL
// response; reject 4xx/5xx before extracting, so a site's 404/403/login shell cannot be saved, indexed, and
// later cited as if it were real content. Pure and exported so the contract is unit-tested without launching
// a browser. A missing response (0/non-finite) is left to the existing empty-content check.
const captureHttpError = (status) => {
  const n = Number(status);
  return Number.isFinite(n) && n >= 400 ? new Error(`The page returned HTTP ${n}.`) : null;
};

// Assemble the final article from the extractor's data. Shared by the HTTP tier and the browser tier so the
// title fallback, HTML-to-text cleanup, and the completeness guard cannot drift between them.
const assembleArticle = (data, finalUrl, html) => {
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { host = String(finalUrl || ''); }
  const title = removeTags(data.title || '') || host;
  let content = String(data.content || '')
    .replace(/<\/?p[^>]*>/gi, '\n').replace(/<br[^>]*>/gi, '\n');
  let text = cleanExtractedText(removeTags(content));
  // The extractor sometimes keeps only the first section of a long article; a plain block-aware strip of the
  // captured HTML is mostly article text. Prefer the fuller strip when it is clearly larger (completeness over
  // tidiness), exactly as the browser path always has. Linear over already-capped HTML.
  try {
    const stripped = cleanExtractedText(require('./htmlstrip').stripTags(html, { block: true }));
    if (stripped.length > 1000 && text.length < stripped.length * 0.5) text = stripped;
  } catch { /* keep the extractor text */ }
  return {
    url: finalUrl,
    title,
    text,
    image: data.image || null,
    byline: removeTags(data.author || '') || null,
    published: data.published || null,
  };
};

// The cheap capture tier: one SSRF-safe plain request through the proxy pool, bounded body, off-thread
// extraction, and the existing block detector. Returns { article, html } or null. It never launches a browser.
const fetchHttpArticle = async (url, signal = null) => {
  try {
    const webproxy = require('./webproxy');
    const { fetchNoPrivateRedirect } = require('./nethost');
    const { fetchWithTimeout } = require('./fetchtimeout');
    const { _readCappedText } = require('./websearch');
    const outcome = await webproxy.runWithProxy(
      async (proxyAgent) => {
        const res = await fetchNoPrivateRedirect(url, (u, dispatcher) => fetchWithTimeout(u, {
          method: 'GET',
          headers: { 'User-Agent': pickRandom(USER_AGENTS), 'Accept': 'text/html,application/xhtml+xml' },
          redirect: 'manual',
          dispatcher,
        }, HTTP_CAPTURE_TIMEOUT_MS, signal), 5, proxyAgent);
        // Release the response body on every early return, so a rejected page cannot hold a pooled socket open
        // until garbage collection (the same discipline the redirect follower uses).
        const cancel = () => { try { res.body && res.body.cancel && res.body.cancel(); } catch { /* already closed */ } };
        if (!res.ok) { cancel(); return { ok: false, status: res.status }; }
        const contentType = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : '';
        if (!/^text\/html|application\/xhtml\+xml/i.test(contentType)) { cancel(); return { ok: true, nonHtml: true }; }
        const html = await _readCappedText(res, MAX_HTTP_HTML, { timeoutMs: HTTP_CAPTURE_TIMEOUT_MS, signal });
        if (require('./blockdetect').looksBlocked(html)) return { ok: true, blocked: true };
        return { ok: true, html, finalUrl: res.url || url };
      },
      { isBlocked: (r) => r && (r.blocked || (!r.ok && (r.status === 403 || r.status === 429 || r.status === 503))) },
    );
    if (!outcome || !outcome.ok || outcome.blocked || !outcome.html) return null;
    const data = await require('./articleextract').extractArticle(outcome.html, outcome.finalUrl);
    if (!data) return null;
    const article = assembleArticle(data, outcome.finalUrl, outcome.html);
    if (!article.text) return null;
    return { article, html: outcome.html };
  } catch {
    return null;
  }
};

// ── Public: fetch + extract ──────────────────────────────────────────────────
// Returns { url, title, text, image, byline, published } or throws with a clear
// message. `text` is clean article prose ready to index.
const fetchArticle = async (rawUrl, signal = null) => {
  let urlObj;
  try { urlObj = new URL(rawUrl); } catch { throw new Error(`Invalid URL: ${rawUrl}`); }
  if (!/^https?:$/.test(urlObj.protocol)) throw new Error('Only http(s) URLs are supported');
  await assertPublicHost(urlObj.hostname);

  // A YouTube video URL has no readable article body — its content is the spoken transcript. Fetch the
  // captions instead of running the page through the article extractor (which would capture only UI chrome).
  const youtube = require('./youtube');
  if (youtube.isYouTubeUrl(urlObj.href)) return youtube.fetchTranscript(urlObj.href, signal);

  // Capture ladder: plain HTTP first (cheap, works without a browser), then the headless renderer only when the
  // result is thin, walled, an error shell, or the user chose Browser mode. A per-host hint skips the cheap tier
  // for a while after it fails there, so a JavaScript-only site does not pay for a doomed request every time.
  const cfg = require('./config');
  const mode = cfg.urlCapture || 'auto';
  const host = urlObj.hostname;
  if (mode === 'http' || (mode === 'auto' && captureHint(host) !== 'browser')) {
    const plain = await fetchHttpArticle(urlObj.href, signal);
    if (plain) {
      const q = require('./contentquality').assessHttpArticle(plain.article, plain.html);
      if (q.ok) { rememberCapture(host, 'http'); return plain.article; }
      rememberCapture(host, 'browser');
      if (mode === 'http') throw new Error(`${q.reason} Switch “Web page capture” to Auto or Browser.`);
      if (cfg.DEBUG) console.log(`[urlfetch] HTTP tier not usable (${q.reason}) — rendering with the browser`);
    } else {
      rememberCapture(host, 'browser');
      if (mode === 'http') throw new Error('Could not read the page over HTTP. Switch “Web page capture” to Auto or Browser.');
      if (cfg.DEBUG) console.log('[urlfetch] HTTP tier failed — rendering with the browser');
    }
  }

  // Capture through the proxy pool with retry-on-block: if a proxy is configured and the capture comes back
  // empty (a blocked/failed exit), retry through the next proxy, up to the tunable retry count. Without a
  // proxy this is a single attempt (unchanged).
  // One picker per capture (its own base index, so concurrent captures don't share the rotation cursor): if a
  // proxy is set and the capture comes back empty (a blocked/failed exit), retry through the NEXT proxy, up
  // to the tunable retry count. Without a proxy this is a single attempt (unchanged).
  const webproxy = require('./webproxy');
  const pickProxy = webproxy.makePicker();
  const captureRetries = webproxy.getWebProxyUrls().length ? webproxy.getProxyRetries() : 0;
  let html = '';
  let blocked = false;
  for (let attempt = 0; attempt <= captureRetries; attempt++) {
    const proxyUrl = pickProxy(attempt);
    html = await captureHtml(urlObj.href, signal, proxyUrl);
    if (signal && signal.aborted) break;
    // A captured page can still be a bot-check wall served with HTTP 200 (Cloudflare, DataDome, …). Detect
    // it from content so a challenge page is never indexed as if it were the article.
    blocked = html ? require('./blockdetect').looksBlocked(html) : false;
    // Record the exit's health: a blocked page means the exit REACHED the target (the site refused), so it
    // is not a dead exit; an empty capture is a failed/unreachable exit; a clean page is ok. A user abort is
    // not the exit's fault, so it is not recorded.
    if (proxyUrl) webproxy.recordExit(proxyUrl, html ? (blocked ? 'blocked' : 'ok') : 'dead');
    if (html && !blocked) break;   // real content — done; otherwise try the next proxy (a different exit may not be walled)
  }
  if (!(signal && signal.aborted) && blocked) throw new Error('The page returned a bot-check / access wall instead of readable content');
  if (!html) throw new Error('Could not fetch the page (no HTML captured)');

  // Extract off the main thread so a huge or pathological DOM can be terminated on a timeout rather than
  // freezing the event loop (see articleextract.js). Returns the extractor's data object or null.
  const data = await require('./articleextract').extractArticle(html, urlObj.href);
  if (!data) throw new Error('No article content could be extracted from this page');
  const article = assembleArticle(data, urlObj.href, html);
  if (!article.text || article.text.length < 50) {
    throw new Error('The page had too little readable text to index');
  }
  // A rendered page can still be an access wall or an error shell; never index one as a source.
  const quality = require('./contentquality').assessCapturedArticle(article);
  if (!quality.ok) throw new Error(quality.reason);
  rememberCapture(host, 'browser');
  return article;
};

// Slugify a title/URL into a safe filename stem.
const slugForArticle = (title, url) => {
  const base = (title && title.trim()) || (() => { try { return new URL(url).hostname; } catch { return 'article'; } })();
  return base.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'article';
};

// Fetch an article and write it as a .txt document into `docsDir`, avoiding
// overwrite by suffixing on collision. Returns { article, rel } where `rel` is the
// filename written. Shared by the UI route (active workspace) and the API route
// (any target workspace) so the fetch → header → collision-suffixed-write logic
// lives in exactly one place.
// Write an extracted article ({ title, url, byline, published, text }) to the docs
// directory with a source header and a collision-free filename. Shared by both the
// server-fetch path and the clipper (client-provided content) path.
const writeArticle = async (article, docsDir) => {
  const fsp = require('fs').promises;
  const path = require('path');

  // A small header (title + source URL + optional byline/date) precedes the text so
  // the source is preserved and searchable alongside the content.
  const header = `${article.title}\n\nSource: ${article.url}` +
    (article.byline ? `\nBy: ${article.byline}` : '') +
    (article.published ? `\nPublished: ${article.published}` : '') + '\n\n';
  const body = header + article.text;

  const crypto = require('crypto');
  await fsp.mkdir(docsDir, { recursive: true });
  const stem = slugForArticle(article.title, article.url);
  // Stage the full content in a private temp first, so a crash mid-write can never leave a truncated .txt
  // that the next delta ingests as a partial document — the temp holds the whole body before any visible
  // name appears. The temp lives in docsDir so the follow-up link/rename stays on one filesystem; the
  // leading dot and .tmp extension keep it out of indexing, and the finally removes it on every path.
  const tmp = path.join(docsDir, `.${stem}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(body, 'utf-8'); await fh.sync(); }
    finally { await fh.close(); }

    if (article.url) {
      // Idempotent by source URL: the filename embeds a short hash of the URL, so re-ingesting the same
      // page (a manual retry, or a retry after a timeout) overwrites its existing document instead of
      // piling up url.txt, url-2.txt, url-3.txt — duplicates that would crowd out other sources in search.
      // rename is atomic and replaces any existing same-URL document; two concurrent same-URL ingests each
      // stage their own temp and the last rename wins, leaving exactly one document.
      const rel = `${stem}-${crypto.createHash('sha256').update(article.url).digest('hex').slice(0, 8)}.txt`;
      await require('./disk').renameWithRetry(tmp, path.join(docsDir, rel));
      return { article, rel };
    }

    // No source URL (rare — e.g. clipped content with no page URL): keep the collision-safe hard link so
    // two writes that slugify to the same stem don't clobber each other (link fails with EEXIST if taken).
    let rel = `${stem}.txt`, n = 2;
    for (;;) {
      try { await fsp.link(tmp, path.join(docsDir, rel)); break; }
      catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;   // a real error (permissions, disk) — surface it
        rel = `${stem}-${n}.txt`; n++;            // name taken — try the next suffix
      }
    }
    return { article, rel };
  } finally {
    try { await fsp.rm(tmp, { force: true }); } catch { /* best-effort temp cleanup (a no-op after rename) */ }
  }
};

const fetchAndSaveArticle = async (url, docsDir, signal = null) => {
  const article = await fetchArticle(url, signal);
  return writeArticle(article, docsDir);
};

// Save content the CLIENT already extracted (e.g. a browser bookmarklet reading the
// live, authenticated DOM), rather than fetching the URL server-side. This is what
// lets the clipper capture pages behind a login: the browser is already signed in,
// so it reads the rendered DOM and hands us the content — we never need the session.
//
// Accepts { url, title, html?, text? }. If html is given, it's run through the same
// article extractor used for server fetches; otherwise text is saved as-is. Returns
// { article, rel } shaped like fetchAndSaveArticle.
const saveProvidedContent = async ({ url, title, html, text }, docsDir) => {
  // Coerce each field to a string up front: these come straight from a request body, so a caller sending
  // e.g. {"title":{}} would otherwise reach a .trim() on a non-string and throw a confusing 502.
  url = typeof url === 'string' ? url : '';
  title = typeof title === 'string' ? title : '';
  html = typeof html === 'string' ? html : '';
  text = typeof text === 'string' ? text : '';
  let article;
  if (html && html.trim()) {
    // Off-thread extraction (null on failure/timeout) — falls back to the raw strip below.
    const data = await require('./articleextract').extractArticle(html, url);
    article = {
      title: (data?.title || title || url || 'Clipped page').trim(),
      url: url || '',
      byline: data?.author || '',
      published: data?.published || '',
      // article-extractor returns HTML content; strip tags to plain text. Fall back
      // to the caller's text, then to a naive strip of the provided html.
      text: (data?.content ? stripHtml(data.content) : (text || stripHtml(html))).trim(),
    };
  } else {
    article = { title: (title || url || 'Clipped page').trim(), url: url || '', byline: '', published: '', text: String(text || '').trim() };
  }

  if (!article.text) throw new Error('No usable content to save');
  return writeArticle(article, docsDir);
};

// Minimal HTML→text: drop scripts/styles, collapse tags to spaces, decode entities via the shared
// decoder (named + numeric, astral-safe), and tidy whitespace. Good enough for a clipped article body.
const { stripElements, stripTags, decodeEntities } = require('./htmlstrip');
// Remove scripts/styles, then comments + remaining tags (block → newline, inline → space) in one linear
// pass. The previous .replace(/<[^>]+>/g, ' ') was O(n²) on adversarial markup — a hang on caller-provided
// HTML through saveProvidedContent. stripTags does the same job in O(n).
const stripHtml = (html) => decodeEntities(
  stripTags(stripElements(String(html || ''), ['script', 'style']), { inline: ' ' }))
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

module.exports = {
  fetchArticle, fetchAndSaveArticle, saveProvidedContent, closeAllBrowsers, killAllBrowsersSync, sweepStaleProfiles,
  captureHttpError,
};
