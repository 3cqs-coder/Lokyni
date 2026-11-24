'use strict';
// Guards search availability during a startup index update. A warm start loads the cached index, then runs a
// delta for changed files. The delta stages into a shadow store and swaps atomically, so the loaded snapshot is
// safe to query while it runs. The embedding-banks path previously waited for the delta before setting
// indexReady, which made every query answer "Building the document index" during startup even though the cache
// was fully loaded. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const init = read('lib/indexing/init.js');
  const socket = read('lib/socket.js');

  ok(/const b = await bundleMod\.loadWorkspaceBundle\(state\.workspaceId\);[\s\S]{0,700}?if \(state\.liveVectorStore && state\.parentMap\.size > 0\) state\.indexReady = true;[\s\S]{0,200}?await runDeltaUpdate\(\)/.test(init),
    'the embedding-banks warm path opens the loaded cache before the startup delta');
  ok(/if \(state\.liveVectorStore && state\.parentMap\.size > 0\) state\.indexReady = true;/.test(init),
    'the early-ready gate requires a loaded store and a non-empty document map');
  ok(/await runDeltaUpdate\(\);\s*\n\s*state\.indexReady = true;\s*\n\s*return;/.test(init),
    'the warm path still marks the index ready after the delta finishes');
  ok(/Query served from live store while delta update runs in background/.test(socket),
    'the answer path explicitly supports serving from the live store during a delta');
  ok(/if \(!state\.liveVectorStore \|\| !state\.indexReady\)/.test(socket),
    'the query gate blocks only when the store is absent or the index is not ready');

  console.log(`\nALL WARM-SEARCH UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WARM-SEARCH UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
