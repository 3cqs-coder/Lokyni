'use strict';
// Build a correct, cross-browser Content-Disposition header value for a file download — including filenames in
// ANY language or script. ONE place, so every download route (the raw-document serve, the .docx export, the
// backup archive) encodes the name the same way and a non-Latin name survives the round trip instead of being
// mangled into percent-escapes. Per RFC 6266 / RFC 5987: a plain ASCII `filename=` fallback for older clients,
// plus a `filename*=UTF-8''<pct-encoded>` that every modern browser (and the desktop webview) prefers.

const path = require('path');

// A pure-ASCII fallback for the quoted `filename=` param: take the basename, drop characters that can't sit in a
// quoted HTTP value (control chars, quote, backslash), replace any non-ASCII with '_', and bound the length. The
// real (possibly non-Latin) name is carried losslessly by `filename*` below, so this is only the legacy fallback.
const asciiFallback = (name) => {
  const base = path.basename(String(name == null ? '' : name)).replace(/[\u0000-\u001f\u007f"\\]/g, '_');
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').trim();
  return (ascii || 'download').slice(0, 200);
};

// RFC 5987 ext-value: percent-encode the UTF-8 bytes, additionally encoding the few characters encodeURIComponent
// leaves literal that are NOT valid attr-chars (' ( ) *). The result is a valid ext-value for `filename*`.
const rfc5987 = (name) =>
  encodeURIComponent(path.basename(String(name == null ? '' : name)))
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// `<disposition>; filename="<ascii>"; filename*=UTF-8''<pct>` — disposition is 'attachment' (default) or 'inline'.
const contentDisposition = (filename, disposition = 'attachment') =>
  `${disposition}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${rfc5987(filename)}`;

module.exports = { contentDisposition, asciiFallback, rfc5987 };
