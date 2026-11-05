'use strict';
// Guards the "warn before stopping Lokyni while work is in progress" behavior so a reload / tab-close / app-quit
// can't silently cut off an index build, a graph build, or an in-flight answer:
//   • the server's /status reports busy for ALL three (indexing, answering, AND building the knowledge graph),
//     plus a short busyReason, and a graph build is announced at its START (not only completion);
//   • the web app tracks those from the live socket events and warns on beforeunload — but only off the desktop
//     app (which has its own native quit dialog), so there's no double prompt;
//   • the desktop shell reads the reason and names what's running in the confirm dialog.
// Source guards (no network/process). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const server = read('lib', 'server.js');
  // /status busy covers indexing, active queries, AND a running graph build (a graph build used to be invisible).
  ok(/busy:\s*state\.indexing \|\| \(state\.activeQueries \|\| 0\) > 0 \|\| !!\(state\.graphBuild && state\.graphBuild\.running\)/.test(server),
    'a knowledge-graph build counts as "busy" (so closing warns during it)');
  ok(/busyReason:/.test(server) && /building the knowledge graph/.test(server) && /indexing your documents/.test(server),
    'the status reports WHAT is running, so the warning can name it');
  // The graph build announces its START too, so a client that didn't initiate it still knows one is running.
  ok(/function startGraphBuild\(\)[\s\S]*?running: true[\s\S]*?broadcast\('graph_build'/.test(server),
    'startGraphBuild broadcasts graph_build at the START (not only on completion)');

  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/let busyIndexing = false, busyGraphBuild = false;/.test(chat), 'the client tracks the two interruptible-work flags');
  ok(/busyIndexing = !!indexing/.test(chat), 'indexing status drives the busy flag');
  ok(/busyGraphBuild = !!\(parsePayload\(p\) \|\| \{\}\)\.running/.test(chat), 'the graph_build event drives the graph-build flag');
  ok(/if \(!IS_DESKTOP_APP\) \{[\s\S]*?addEventListener\('beforeunload'[\s\S]*?busyIndexing \|\| busyGraphBuild/.test(chat),
    'the web app warns on beforeunload only while busy, and only off the desktop app (no double prompt)');

  // The desktop shell names what's running in the quit confirmation.
  const shell = read('src-tauri', 'src', 'main.rs');
  ok(/fn server_busy_reason\(port: u16\) -> Option<String>/.test(shell), 'the shell reads the busy reason from /status');
  ok(/if let Some\(reason\) = server_busy_reason\(port\)/.test(shell) && /Lokyni is still \{reason\}/.test(shell),
    'the quit dialog names what is running (indexing / building the graph / answering)');

  console.log(`\nALL CLOSE-WARNING TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CLOSE-WARNING TEST FAILED:', e && e.message);
  process.exit(1);
}
