'use strict';
// Guards the single source of truth for (1) the secret-clear sentinel and (2) the short free-text field-length
// caps. Both are decisions the FRONTEND and BACKEND must agree on exactly: the client sends the sentinel and the
// server compares against it (a mismatch would store the sentinel AS the secret instead of clearing it), and the
// view's input `maxlength` must match the server's enforced cap (a mismatch truncates silently with no feedback).
// They now live once in lib/settings-schema.js and are projected to the page via CLIENT_SETTINGS; this test fails
// if any site re-inlines its own literal and reintroduces the drift. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const schema = require(path.join(PROJECT, 'lib', 'settings-schema'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── The single source exists and is projected to the client unchanged ──
  ok(typeof schema.SECRET_CLEAR === 'string' && schema.SECRET_CLEAR.length > 0, 'SECRET_CLEAR is a non-empty string');
  ok(schema.CLIENT_SETTINGS.secretClear === schema.SECRET_CLEAR, 'the projected secretClear equals SECRET_CLEAR (client and server agree)');

  const CAPS = schema.FIELD_CAPS;
  const KEYS = ['apiKeyName', 'connectorName', 'promptName', 'automationName', 'displayName', 'evalQuestion'];
  for (const k of KEYS) ok(Number.isInteger(CAPS[k]) && CAPS[k] > 0, `FIELD_CAPS.${k} is a positive integer`);
  ok(JSON.stringify(schema.CLIENT_SETTINGS.fieldCaps) === JSON.stringify(CAPS), 'the projected fieldCaps equals FIELD_CAPS (views and server read one map)');

  // ── The server reads the sentinel from the schema, never a re-inlined literal ──
  const server = read('lib/server.js');
  ok(/\bSECRET_CLEAR\b/.test(server) && /require\(['"]\.\/settings-schema['"]\)/.test(server), 'server.js imports SECRET_CLEAR from settings-schema');
  ok(!/SECRET_CLEAR\s*=\s*['"][^'"]+['"]/.test(server), 'server.js does not re-define the SECRET_CLEAR literal (would drift from the client)');
  // The client reads it from the server-projected settings meta (not a second hardcoded copy as the primary source).
  ok(/SETTINGS_META\s*&&\s*SETTINGS_META\.secretClear/.test(read('lib/public/js/chat.js')), 'chat.js reads the sentinel from the projected schema');

  // ── Each server enforcement site references the shared cap, not a bare literal ──
  const SERVER_CAP = {
    'lib/apikeys.js': 'apiKeyName',
    'lib/mcp/connectors.js': 'connectorName',
    'lib/prompts.js': 'promptName',
    'lib/automations.js': 'automationName',
    'lib/users.js': 'displayName',
    'lib/eval.js': 'evalQuestion',
  };
  for (const [file, key] of Object.entries(SERVER_CAP)) {
    ok(read(file).includes(`FIELD_CAPS.${key}`), `${file} enforces its cap via FIELD_CAPS.${key} (single source)`);
  }

  // ── Each view's input renders its maxlength from the projected cap, never a hardcoded number ──
  // (field id, view file, caps key, the EJS object the view reads the map from)
  const VIEW_FIELDS = [
    ['apikey-name', 'lib/views/chat.ejs', 'apiKeyName', 'settingsSchema.fieldCaps'],
    ['connector-name', 'lib/views/chat.ejs', 'connectorName', 'settingsSchema.fieldCaps'],
    ['template-name', 'lib/views/chat.ejs', 'promptName', 'settingsSchema.fieldCaps'],
    ['automation-name', 'lib/views/chat.ejs', 'automationName', 'settingsSchema.fieldCaps'],
    ['eval-question-input', 'lib/views/chat.ejs', 'evalQuestion', 'settingsSchema.fieldCaps'],
    ['displayname', 'lib/views/login.ejs', 'displayName', 'fieldCaps'],
    ['dn', 'lib/views/account.ejs', 'displayName', 'fieldCaps'],
  ];
  for (const [id, file, key, obj] of VIEW_FIELDS) {
    const line = read(file).split('\n').find((l) => l.includes(`id="${id}"`));
    ok(line, `${file} still has the input #${id}`);
    ok(line.includes(`${obj}.${key}`), `${file} #${id} renders maxlength from ${obj}.${key} (single source)`);
    ok(!/maxlength="\d+"/.test(line), `${file} #${id} has no hardcoded numeric maxlength (would drift from the server cap)`);
  }

  console.log(`\nALL FIELD-CAPS SINGLE-SOURCE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FIELD-CAPS SINGLE-SOURCE TEST FAILED:', e && e.message);
  process.exit(1);
}
