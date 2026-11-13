'use strict';
// Build a correct, cross-browser Content-Disposition header value for a file download — including filenames in
// ANY language or script. ONE place, so every download route (the raw-document serve, the .docx export, the
// backup archive) encodes the name the same way and a non-Latin name survives the round trip instead of being
// mangled into percent-escapes. Per RFC 6266 / RFC 5987: a plain ASCII `filename=` fallback for older clients,
// plus a `filename*=UTF-8''<pct-encoded>` that every modern browser (and the desktop webview) prefers.

const path = require('path');

// Reduce a (possibly path-like) download name to its final component. A download filename is DATA for an HTTP
// header, not a host path, so forward slash is the only directory separator honored, on every platform — via
// path.posix.basename. The host's path.basename would, on Windows, additionally split on backslash and strip a
// leading "x:" as a drive letter, mangling a legitimate name and making the output host-dependent. A backslash is
// NOT a separator here: it is left in place for the sanitizers below to replace with '_'.
const lastComponent = (name) => path.posix.basename(String(name == null ? '' : name));

// A pure-ASCII fallback for the quoted `filename=` param: take the final component, drop characters that can't sit
// in a quoted HTTP value (control chars, quote, backslash), replace any non-ASCII with '_', and bound the length.
// The real (possibly non-Latin) name is carried losslessly by `filename*` below, so this is only the legacy fallback.
const asciiFallback = (name) => {
  const base = lastComponent(name).replace(/[\u0000-\u001f\u007f"\\]/g, '_');
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').trim();
  return (ascii || 'download').slice(0, 200);
};

// RFC 5987 ext-value: percent-encode the UTF-8 bytes, additionally encoding the few characters encodeURIComponent
// leaves literal that are NOT valid attr-chars (' ( ) *). The result is a valid ext-value for `filename*`.
const rfc5987 = (name) =>
  encodeURIComponent(lastComponent(name))
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// `<disposition>; filename="<ascii>"; filename*=UTF-8''<pct>` — disposition is 'attachment' (default) or 'inline'.
const contentDisposition = (filename, disposition = 'attachment') =>
  `${disposition}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${rfc5987(filename)}`;

module.exports = { contentDisposition, asciiFallback, rfc5987 };
