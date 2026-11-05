'use strict';
// Guards the headless-browser launch used for URL ingestion. The Chromium sandbox must stay ON by
// default (only disabled as root / in a container), so a renderer exploit in a hostile page is
// confined; --disable-web-security must never be added (it would turn the structurally-blind SSRF
// into a readable one); and a system browser must be usable as a fallback so the packaged desktop
// app (which bundles no Chromium) can still ingest a URL when one is installed. Source guard, so the
// behavior can't be quietly regressed. No model, network, or browser launch. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'urlfetch.js'), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // The sandbox is gated, not unconditionally disabled.
  ok(/needsNoSandbox\(\) \?/.test(src), 'the --no-sandbox flags are applied only when needsNoSandbox() says so');
  ok(!/args: \[\s*'--no-sandbox'/.test(src), 'the launch args do not start with an unconditional --no-sandbox');
  ok(/process\.getuid.*=== 0/.test(src) && /\.dockerenv/.test(src), 'needsNoSandbox detects root and a container');

  // Never disable web security (keeps SSRF structurally blind).
  ok(!/--disable-web-security/.test(src) || /do NOT add --disable-web-security/.test(src), 'web security is not disabled');
  ok(!/'--disable-web-security'/.test(src), '--disable-web-security is not in the launch args');

  // Loopback is never silently bypassed: BOTH proxy modes (the local vetting proxy AND a configured egress proxy)
  // must carry --proxy-bypass-list=<-loopback>, so a hostile page's loopback subresource/WebSocket is routed to
  // the proxy (and refused / unreachable) instead of hitting this machine directly. The egress path previously
  // omitted it, leaving a loopback ws:// SSRF (CDP request-interception doesn't cover WebSocket handshakes).
  const proxyArgsLine = (src.match(/proxyUrl \? \[[^\]]*\]\s*\n?\s*:\s*proxyPort \? \[[^\]]*\]/) || [''])[0];
  ok((proxyArgsLine.match(/--proxy-bypass-list=<-loopback>/g) || []).length >= 2,
    'both the egress-proxy and loopback-vetting-proxy launch args set --proxy-bypass-list=<-loopback>');

  // System-browser fallback for the packaged desktop app (no bundled Chromium), degrading gracefully.
  ok(/findSystemBrowser\(/.test(src), 'a system-browser fallback exists');
  ok(/executablePath: exe/.test(src), 'the fallback launches an installed browser via executablePath');
  ok(/if \(!exe\) throw e/.test(src), 'with no browser found the launch error propagates (graceful degrade), not a crash');
  // Cross-platform discovery for all three desktop OSes.
  for (const p of ['darwin', 'win32']) ok(new RegExp(`'${p}'|process\\.platform === '${p}'`).test(src) || src.includes(p), `system-browser discovery covers ${p}`);

  // ── Robustness: bounded concurrency, bounded capture, non-stalling load ──
  // Each capture launches a full Chromium and holds the page string in memory, so a burst must be
  // gated or it OOMs the process.
  ok(/acquireBrowserSlot\(\)/.test(src) && /releaseBrowserSlot\(\)/.test(src), 'browser captures pass through a concurrency gate');
  ok(/await acquireBrowserSlot\(\);/.test(src), 'captureHtml acquires a slot before launching a browser');
  // The gate is the shared semaphore util (lib/semaphore.js), configured with a bounded wait queue
  // so excess captures fail fast (backpressure) rather than piling up unbounded.
  ok(/createSemaphore\(/.test(src) && /queueMax:/.test(src), 'the wait queue is bounded via the shared semaphore so excess captures fail fast (backpressure), not pile up');
  // The captured HTML is size-capped.
  ok(/MAX_CAPTURED_HTML/.test(src) && /html\.slice\(0, MAX_CAPTURED_HTML\)/.test(src), 'the captured HTML string is capped');
  // goto must not require full network idle, or ordinary pages with background traffic burn the timeout.
  ok(!/waitUntil:\s*\[[^\]]*networkidle/.test(src), 'goto does not wait for network idle in an AND-set (it would stall on busy pages)');
  ok(/waitUntil:\s*'domcontentloaded'/.test(src), 'goto waits for domcontentloaded');
  ok(/waitForNetworkIdle\(\{[^}]*timeout:/.test(src), 'a bounded network-idle settle replaces the unbounded wait');

  // ── The vetting proxy is mandatory: if it can't start, the capture FAILS CLOSED (no weak fallback) ──
  // The proxy is the only layer that pins AND re-vets every browser connection including WebSockets. The old
  // fallback (map only the main host + request interception) left WebSockets un-pinned and reopened a
  // DNS-rebinding window for non-main hosts. captureHtml now throws instead of fetching without the proxy.
  ok(/ensureProxy\(\)/.test(src), 'captureHtml starts the vetting proxy');
  ok(/could not start/.test(src) && /catch \(e\) \{[\s\S]*?throw new Error\([^)]*proxy could not start/.test(src),
    'a proxy that cannot start makes captureHtml throw (fail closed), not fall back to a weaker guard');
  ok(!/hostResolverRules = `MAP /.test(src), 'the weaker MAP-only fallback (WebSocket/rebinding gap) is gone');
  // The fallback's vestigial plumbing is fully removed, so it can't be silently re-wired: no host-resolver-rules
  // arg and no hostResolverRules option remain. The proxy is the single pinning boundary.
  ok(!/host-resolver-rules/.test(src) && !/hostResolverRules/.test(src),
    'no host-resolver-rules plumbing remains (the proxy is the only pinning path)');
  console.log('✓ urlfetch-hardening: the capture fails closed when the vetting proxy cannot start (no weak fallback)');

  // ── An HTTP error page is not a source. page.goto returns the final response; a 4xx/5xx must be rejected
  //    before extraction so a 404/403/login shell cannot be saved, indexed, and later cited. ──
  {
    const { captureHttpError } = require(path.join(ROOT, 'lib', 'urlfetch'));
    ok(captureHttpError(200) === null && captureHttpError(204) === null && captureHttpError(304) === null,
      'a successful or redirect response is not rejected');
    ok(captureHttpError(404) && /404/.test(captureHttpError(404).message), 'a 404 is rejected with its status');
    ok(captureHttpError(500) && /500/.test(captureHttpError(500).message), 'a 5xx is rejected with its status');
    ok(captureHttpError(0) === null && captureHttpError(undefined) === null,
      'a missing response falls through to the existing empty-content check');
    ok(/const statusError = captureHttpError\(response && typeof response\.status === 'function' \? response\.status\(\) : 0\);/.test(src)
      && /if \(statusError\) throw statusError;/.test(src),
      'the capture rejects an HTTP error before extracting or indexing');
    console.log('✓ urlfetch-hardening: an HTTP error page is rejected before extraction');
  }

  console.log(`\nALL URLFETCH-HARDENING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ URLFETCH-HARDENING UNIT TEST FAILED:', e.message);
  process.exit(1);
}
