'use strict';
// Guards the API-key workspace-scoping UI. The server has always supported per-key allowedWorkspaces (empty =
// every workspace), but the create form never exposed it, so every key was silently all-access. This verifies
// the UI now: offers a workspace picker, sends the checked ids as allowedWorkspaces (none checked = all), and
// shows each key's reach in the list so an all-access key is never a silent default. The enforcement itself is
// covered by apikeys.test.js / workspace-access.test.js. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── markup: the scoping control and the "defaults to every workspace" hint exist ──
  const ejs = read('lib', 'views', 'chat.ejs');
  ok(/id="apikey-ws-list"/.test(ejs), 'the key form has a workspace list container');
  ok(/Leave all unchecked to allow <strong>every<\/strong> workspace/.test(ejs), 'the form states that unchecked = every workspace (surfaces the all-access default)');

  // ── client: populate from the live workspace list, send checked ids, reset after create ──
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/async function populateKeyWorkspaces\(\)/.test(chat), 'populateKeyWorkspaces renders the per-key workspace options');
  ok(/getJSON\('\/api\/workspaces'\)/.test(chat), 'the picker is built from the live workspace list (new workspaces appear)');
  ok(/populateKeyWorkspaces\(\);/.test(chat) && /async function loadApiKeys\(\)/.test(chat), 'the picker is refreshed whenever the keys panel loads');
  ok(/document\.querySelectorAll\('\.apikey-ws'\)[\s\S]{0,120}filter\(cb => cb\.checked\)[\s\S]{0,60}map\(cb => cb\.value\)/.test(chat), 'checked workspace ids are collected');
  ok(/if \(allowedWorkspaces\.length\) body\.allowedWorkspaces = allowedWorkspaces;/.test(chat), 'checked ids are sent as allowedWorkspaces; none checked omits it (server default = all)');
  ok(/document\.querySelectorAll\('\.apikey-ws'\)\.forEach\(cb => \{ cb\.checked = false; \}\)/.test(chat), 'the picker is reset after a key is created');

  // ── list: each key's workspace reach is shown ("all workspaces" vs "N workspaces") ──
  ok(/const wsCount = Array\.isArray\(k\.allowedWorkspaces\)/.test(chat), 'the list reads each key\'s allowedWorkspaces');
  ok(/wsCount === 0 \? 'all workspaces'/.test(chat), 'an unscoped key is shown as "all workspaces" (never a silent default)');
  ok(/\$\{escapeHtml\(wsScope\)\}/.test(chat), 'the workspace reach is rendered in the key row');

  console.log(`✓ apikey-workspace-ui: keys can be scoped to workspaces in the UI, and each key's reach is shown (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('✗ apikey-workspace-ui:', e && e.message);
  process.exit(1);
}
