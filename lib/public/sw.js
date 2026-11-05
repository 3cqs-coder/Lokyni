/* Lokyni service worker.
 *
 * Its only job is to make the app installable (a real standalone window and launcher icon).
 * It deliberately does NOT cache the app's own HTML, JavaScript, or CSS. Lokyni is a local
 * app whose server must be running to be useful at all — it needs the local model, the index,
 * and the document store — so a stale cached copy of the UI would have no offline value and
 * would risk the classic failure where the browser silently runs old code against a new
 * server. Every request therefore goes straight to the network (pass-through).
 *
 * For a top-level navigation that fails because the server is not running, we return a small,
 * self-contained page explaining that instead of the browser's generic error. Nothing else is
 * intercepted or stored.
 */

self.addEventListener('install', (event) => {
  // Activate this version immediately rather than waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove any caches a previous version may have created, so no old asset can linger.
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (_) { /* Cache API unavailable — nothing to clean */ }
    // Deliberately do NOT call clients.claim(). Claiming takes control while the first page's assets are
    // still in flight, and Firefox can cancel one of those requests mid-load ("ServiceWorker intercepted the
    // request and encountered an unexpected error"). The worker controls the next load, which is enough: it
    // stores nothing, so there is no stale code to flush and no value in an immediate takeover.
  })());
});

const OFFLINE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Lokyni is not running</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0f0f0f;color:#e2e2e2;font-family:system-ui,-apple-system,sans-serif}' +
  '.box{max-width:22rem;padding:2rem;text-align:center}.mark{font-size:2rem;color:#4f8ef7}' +
  'h1{font-size:1.1rem;font-weight:600;margin:.75rem 0 .5rem}p{color:#8a8a8a;font-size:.9rem;line-height:1.5}' +
  '.retry{display:inline-block;margin-top:1.25rem;padding:.5rem 1rem;border:1px solid #2a2a2a;border-radius:6px;' +
  'background:#171717;color:#e2e2e2;font-size:.9rem;cursor:pointer;text-decoration:none}' +
  '@media(prefers-color-scheme:light){body{background:#f0f0ee;color:#1a1a1a}p{color:#555}' +
  '.retry{background:#fff;border-color:#ccc;color:#1a1a1a}}</style></head>' +
  '<body><div class="box"><div class="mark">◈</div>' +
  '<h1>Lokyni is not running</h1>' +
  '<p>The app could not reach its local server. Start Lokyni, then try again.</p>' +
  // A plain link, not a button with an inline handler: it retries with no script at all, so the
  // page needs no inline JavaScript and stays safe under any Content-Security-Policy.
  '<a class="retry" href="/">Retry</a></div></body></html>';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only intercept top-level NAVIGATIONS, and only to serve the offline fallback when the local server is
  // unreachable. Everything else (assets, socket.io polls, media range/opaque requests, and all writes) is left
  // to the browser to fetch natively — the worker never caches, so routing them through it gains nothing and a
  // SW re-issuing range/opaque requests has browser-specific edge cases. This keeps the worker off the hot path.
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (err) {
      // A navigation that can't reach the local server → the offline page (never a cached/stale UI).
      return new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 });
    }
  })());
});
