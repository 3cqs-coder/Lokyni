'use strict';
// Recognize a bot-check / access-denied "interstitial" that a server returns with HTTP 200, so a
// challenge wall (Cloudflare, DataDome, PerimeterX, Imperva/Incapsula, Akamai, a reCAPTCHA/hCaptcha/
// Turnstile gate) is caught from its CONTENT, not just its status code — a status check alone misses it.
//
// Only SHORT bodies are flagged. A real article runs to many kilobytes of readable text, while a
// challenge page has almost none, so the visible-text length gate makes a false positive on genuine
// content effectively impossible — an article that merely MENTIONS one of these vendors is never flagged.
// Pure, synchronous, CPU-bounded (the scan is capped), and never throws.

// Signatures are language-agnostic first — CSS classes, cookie names, and vendor script tokens are not
// localized — with a few English phrases as a backstop. All matched case-insensitively.
const MARKERS = [
  // Cloudflare challenge
  'cf-browser-verification', 'cf_chl_', 'cf-challenge', 'challenge-platform', '/cdn-cgi/challenge',
  'just a moment', 'checking your browser before',
  // Bot-wall vendors (class / cookie / script tokens)
  'datadome', 'perimeterx', 'px-captcha', 'incapsula', '_incap_', 'imperva', 'distil_r_captcha',
  'ak_bmsc', '__cf_bm',
  // CAPTCHA widgets
  'g-recaptcha', 'grecaptcha', 'h-captcha', 'hcaptcha', 'cf-turnstile',
  // English-language backstops
  'verify you are human', 'are you a robot', 'enable javascript and cookies', 'please enable cookies',
  'access denied', 'unusual traffic from your',
];

// Above this many characters of VISIBLE (post-strip) text, the page is real content and is never flagged.
const MAX_BLOCK_LEN = 2000;
// Cap how much of the body we scan: a wall page is small, so a page whose first chunk already has plenty
// of readable text is real. This bounds CPU/memory on a large page (OOM-safe) without missing a small wall.
const SCAN_BYTES = 256 * 1024;

// True when `html` looks like a bot-check / block interstitial rather than real content.
const looksBlocked = (html) => {
  const s = String(html || '');
  if (!s) return false;
  const head = s.length > SCAN_BYTES ? s.slice(0, SCAN_BYTES) : s;
  const lower = head.toLowerCase();
  // Rough visible-text length. Use the shared htmlstrip module, which removes elements and tags with LINEAR
  // indexOf walkers — a regex strip (`/<script[\s\S]*?<\/script>/g`, `/<[^>]+>/g`) is O(n^2) on adversarial
  // markup (many unterminated `<script`/`<`), and on a hostile 256 KB body it froze the event loop for tens
  // of seconds. The same callers already switched their own stripping to htmlstrip for exactly this reason.
  const hs = require('./htmlstrip');
  const textish = hs.stripTags(hs.stripElements(head, ['script', 'style']), { inline: ' ', block: false })
    .replace(/\s+/g, ' ').trim();
  if (textish.length > MAX_BLOCK_LEN) return false;   // enough readable text → a real page
  return MARKERS.some((m) => lower.includes(m));
};

module.exports = { looksBlocked, MARKERS, MAX_BLOCK_LEN };
