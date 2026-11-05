'use strict';
// gen-icons.js — generate the app icons used by the installable web app (PWA) and browser
// tabs. The mark is Lokyni's concentric-diamond glyph (◈) drawn procedurally, so the icons
// are produced with Node built-ins only — no image library and nothing spawned — and render
// identically on macOS, Windows, and Linux. This is a one-time developer tool: the PNG and
// SVG files it writes into lib/public/icons/ are committed and served directly. Re-run only
// to change the artwork.
//
// Run from the project root:  node lib/scripts/gen-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// Palette, matching the app's dark theme (see lib/public/css/app.css).
const BG = [0x0f, 0x0f, 0x0f];
const ACCENT = [0x4f, 0x8e, 0xf7];

// ── Minimal PNG encoder (RGBA, 8-bit) ─────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  // Prefix each scanline with filter byte 0.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Drawing ───────────────────────────────────────────────────────────────────
// Render at 4x then box-average down for smooth (anti-aliased) edges.
const SS = 4;

// Distance from a point to the center in the "diamond" metric (|dx| + |dy|).
const diamond = (x, y, cx, cy) => Math.abs(x - cx) + Math.abs(y - cy);

// Whether a point is inside a rounded square centered on the canvas.
function insideRounded(x, y, size, radius) {
  const min = radius, max = size - radius;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  const dx = x - cx, dy = y - cy;
  if (x >= min && x <= max) return y >= 0 && y <= size;
  if (y >= min && y <= max) return x >= 0 && x <= size;
  return dx * dx + dy * dy <= radius * radius;
}

function render(size, { maskable }) {
  const S = size * SS;
  const hi = Buffer.alloc(S * S * 4);
  const c = S / 2;
  const outer = S * 0.34;   // outer diamond half-diagonal
  const inner = S * 0.20;   // inner diamond (cut to background)
  const core = S * 0.075;   // center dot (accent)
  const radius = maskable ? 0 : S * 0.22;   // maskable fills to the edge

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let col, a = 255;
      const onBg = maskable ? true : insideRounded(x + 0.5, y + 0.5, S, radius);
      if (!onBg) { hi[i + 3] = 0; continue; }
      const d = diamond(x + 0.5, y + 0.5, c, c);
      if (d <= core) col = ACCENT;
      else if (d <= inner) col = BG;
      else if (d <= outer) col = ACCENT;
      else col = BG;
      hi[i] = col[0]; hi[i + 1] = col[1]; hi[i + 2] = col[2]; hi[i + 3] = a;
    }
  }

  // Downsample SSxSS → 1 by averaging (premultiplied by alpha so transparent edges are clean).
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const si = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          const sa = hi[si + 3];
          r += hi[si] * sa; g += hi[si + 1] * sa; b += hi[si + 2] * sa; a += sa;
        }
      }
      const oi = (y * size + x) * 4;
      const n = SS * SS;
      out[oi] = a ? Math.round(r / a) : 0;
      out[oi + 1] = a ? Math.round(g / a) : 0;
      out[oi + 2] = a ? Math.round(b / a) : 0;
      out[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}

// SVG version — crisp at any size, used for the tab favicon.
function svg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Lokyni">
  <rect width="100" height="100" rx="22" fill="${hex(BG)}"/>
  <path d="M50 16 L84 50 L50 84 L16 50 Z" fill="${hex(ACCENT)}"/>
  <path d="M50 30 L70 50 L50 70 L30 50 Z" fill="${hex(BG)}"/>
  <path d="M50 42.5 L57.5 50 L50 57.5 L42.5 50 Z" fill="${hex(ACCENT)}"/>
</svg>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, buf) => { fs.writeFileSync(path.join(OUT_DIR, name), buf); console.log(`  ${name} (${Math.round(buf.length / 1024)} KB)`); };

console.log('Generating icons…');
write('icon-192.png', encodePng(192, 192, render(192, { maskable: false })));
write('icon-512.png', encodePng(512, 512, render(512, { maskable: false })));
write('icon-maskable-512.png', encodePng(512, 512, render(512, { maskable: true })));
write('icon-180.png', encodePng(180, 180, render(180, { maskable: true })));   // apple-touch-icon
write('icon.svg', Buffer.from(svg(), 'utf-8'));
console.log(`\nWrote icons to ${OUT_DIR}`);
