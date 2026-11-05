'use strict';
// Guards the shared text-buffer decoder (lib/textdecode.js), which every text-ingest path uses instead of a
// blind buffer.toString('utf-8'). It must honor a byte-order mark (UTF-8 stripped, UTF-16 LE/BE decoded),
// preserve valid UTF-8 including astral characters, and fall back to Latin-1 for legacy single-byte bytes so
// accents/currency survive rather than becoming U+FFFD. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { decodeTextBuffer } = require(path.join(PROJECT, 'lib', 'textdecode'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  ok(decodeTextBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('héllo', 'utf-8')])) === 'héllo',
    'a UTF-8 BOM is stripped (no leading ZWNBSP)');
  ok(decodeTextBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('café', 'utf16le')])) === 'café',
    'a UTF-16 LE file (Windows "Unicode" .txt) decodes correctly');
  {
    const le = Buffer.from('café', 'utf16le'); const be = Buffer.from(le); be.swap16();
    ok(decodeTextBuffer(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])) === 'café', 'a UTF-16 BE file decodes correctly');
  }
  ok(decodeTextBuffer(Buffer.from('naïve 日本語 😀', 'utf-8')) === 'naïve 日本語 😀',
    'valid UTF-8 (accents, CJK, astral emoji) is preserved unchanged');
  ok(decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x20, 0xA3])) === 'café £',
    'invalid-UTF-8 bytes fall back to Latin-1, keeping the accent and currency symbol (not U+FFFD)');
  ok(decodeTextBuffer(Buffer.from('', 'utf-8')) === '' && decodeTextBuffer(null) === '',
    'empty and null inputs are handled without throwing');
  ok(!decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xE9])).includes('�'),
    'a Latin-1 file never yields a replacement character');
  console.log('✓ textdecode: BOM-aware, UTF-16 LE/BE, astral-safe UTF-8, Latin-1 fallback');

  console.log(`\nALL TEXTDECODE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TEXTDECODE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
