'use strict';
// Decode a text-file buffer to a string, honoring a byte-order mark and falling back for non-UTF-8 bytes,
// instead of assuming UTF-8 everywhere. Reading everything as UTF-8 silently destroys two common real-world
// cases: a Windows "Unicode" .txt is UTF-16LE (every other byte is NUL, so as UTF-8 it becomes garbage),
// and a legacy Latin-1 / Windows-1252 export turns each accent or currency byte into U+FFFD. This is the one
// place that decision lives, so every text ingest path decodes the same way.
//
//   - UTF-8 BOM  (EF BB BF)  -> stripped, decoded UTF-8 (otherwise the first token carries an invisible ZWNBSP).
//   - UTF-16 LE  (FF FE)     -> decoded utf16le.
//   - UTF-16 BE  (FE FF)     -> byte-swapped then decoded (Node has only 'utf16le').
//   - no BOM                 -> UTF-8 when the bytes are valid UTF-8, else Latin-1 (a lossless 1:1 byte map
//                               that preserves accents/currency rather than emitting U+FFFD).

const { isUtf8 } = require('buffer');

const decodeTextBuffer = (buf) => {
  if (!Buffer.isBuffer(buf)) return buf == null ? '' : String(buf);
  const n = buf.length;
  if (n >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf-8', 3);
  if (n >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
  if (n >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    let body = Buffer.from(buf.subarray(2));        // copy so swap16 doesn't mutate the caller's buffer
    if (body.length % 2 === 1) body = body.subarray(0, body.length - 1);   // swap16 needs an even length
    body.swap16();                                  // BE -> LE
    return body.toString('utf16le');
  }
  try { if (isUtf8(buf)) return buf.toString('utf-8'); } catch { /* isUtf8 unavailable — fall through */ }
  return buf.toString('latin1');                    // legacy single-byte: lossless, keeps accents/currency
};

module.exports = { decodeTextBuffer };
