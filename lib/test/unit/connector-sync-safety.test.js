'use strict';
// Guards the connector re-sync fail-safe (lib/mcp/connectors.js). A re-sync overwrites the previously
// ingested copy, so two properties must hold or the user's synced corpus can be silently lost:
//   • a DEGRADED pull (empty, or smaller after read errors from a rate-limit / network blip) must NOT
//     replace the last-good set — it keeps the previous documents (the "never overwrite good data on a
//     degraded refresh" rule); a clean shrink with no read errors still replaces normally;
//   • the replace is ATOMIC — staged then swapped — so a crash mid-write can never leave the connector's
//     documents missing or half-written (the old destroy-then-rewrite left that window open).
// Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { _pullIsDegraded, _replaceConnectorDocsAtomic } = require(path.join(PROJECT, 'lib', 'mcp', 'connectors'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-connsync-'));
  const cleanup = (code) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };
  try {
    // ── pullIsDegraded decision table ──
    ok(_pullIsDegraded(5, 0, 0) === false, 'a first sync (no previous set) always proceeds');
    ok(_pullIsDegraded(0, 0, 0) === false, 'an empty first sync is not "degraded" (nothing to protect)');
    ok(_pullIsDegraded(0, 10, 0) === true, 'an empty pull when we had documents is degraded — keep the old set');
    ok(_pullIsDegraded(3, 10, 2) === true, 'a smaller pull WITH read errors is degraded (files failed to read)');
    ok(_pullIsDegraded(3, 10, 0) === false, 'a smaller pull with NO errors is a clean shrink — replace normally');
    ok(_pullIsDegraded(12, 10, 4) === false, 'a larger pull is fine even with some read errors (net growth)');
    ok(_pullIsDegraded(10, 10, 0) === false, 'an equal pull replaces normally');
    console.log('✓ connector-sync-safety: degraded pulls are detected and the last-good set is protected');

    // ── replaceConnectorDocsAtomic: replaces cleanly and leaves no staging/old residue ──
    const subdir = path.join(dir, '_connectors', 'c1');
    await _replaceConnectorDocsAtomic(subdir, [{ name: 'a', text: 'first-a' }, { name: 'b.txt', text: 'first-b' }]);
    ok(fs.readdirSync(subdir).sort().join(',') === 'a.txt,b.txt', 'first write lands both documents (adds .txt)');
    ok(fs.readFileSync(path.join(subdir, 'a.txt'), 'utf-8') === 'first-a', 'content is written correctly');

    // A second replace swaps the set in atomically and removes the previous file.
    await _replaceConnectorDocsAtomic(subdir, [{ name: 'a', text: 'second-a' }]);
    ok(fs.readdirSync(subdir).join(',') === 'a.txt', 'the swap replaces the whole set (b.txt is gone)');
    ok(fs.readFileSync(path.join(subdir, 'a.txt'), 'utf-8') === 'second-a', 'the new content replaced the old');

    // No staging (.syncing-*) or aside (.old-*) directories are left behind after a successful swap.
    const residue = fs.readdirSync(path.join(dir, '_connectors')).filter(n => n.includes('.syncing-') || n.includes('.old-'));
    ok(residue.length === 0, 'no staging or old-copy directories are left behind');
    console.log('✓ connector-sync-safety: the document set is replaced atomically with no residue');

    // ── Untrusted-connector hardening (source guards) ──
    const clientSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'client.js'), 'utf-8');
    const connSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'connectors.js'), 'utf-8');
    // A spawned connector gets a MINIMAL env (npx/node operational vars + its own spec.env), never the whole
    // process.env, so it can't harvest secrets the operator's shell may hold.
    ok(/env:\s*minimalEnv\(spec\.env\)/.test(clientSrc), 'connector spawn uses a minimal env, not the full process.env');
    ok(!/env:\s*\{ \.\.\.process\.env/.test(clientSrc), 'the full process.env is not spread into a connector child');
    // The connector's own secret values are scrubbed from captured stderr before it reaches errors/settings/audit.
    ok(/scrubSecrets\(line, secretVals\)/.test(clientSrc), 'connector stderr is scrubbed of the connector\'s secret values');
    // The github puller caps each file AND the total buffered text (OOM guard), like the filesystem puller.
    const ghBody = connSrc.slice(connSrc.indexOf('const pullGithub'), connSrc.indexOf('const pullGithub') + 4500);
    ok(/text\.length > FS_MAX_FILE_CHARS\) text = text\.slice\(0, FS_MAX_FILE_CHARS\)/.test(ghBody), 'pullGithub caps each file\'s size');
    ok(/totalChars >= FS_TOTAL_MAX_CHARS/.test(ghBody), 'pullGithub enforces a total-size budget (OOM guard)');
    // A SINGLE oversized response is bounded before the amplifying transforms, not only in aggregate: textOf caps
    // the materialized string so a malicious server can't force a few-hundred-MB JSON.parse/base64-decode chain.
    ok(/mcpClient\.textOf\(res, FS_MAX_FILE_CHARS \* 2\)/.test(ghBody), 'pullGithub bounds the raw response before base64 decode');
    ok(/mcpClient\.textOf\(treeRes, FS_TREE_MAX_CHARS \+ 1\)/.test(connSrc), 'the directory tree is bounded as it is read (one response can\'t be materialized unbounded)');
    const clientTextOf = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'client.js'), 'utf-8');
    ok(/const textOf = \(result, maxChars = 0\) =>/.test(clientTextOf) && /maxChars > 0 && s\.length > maxChars/.test(clientTextOf),
      'textOf takes an optional cap so callers can bound a single response');
    // The directory-tree walk of an untrusted server response is depth-bounded (no stack overflow).
    ok(/if \(depth > WALK_MAX_DEPTH\) return;/.test(connSrc), 'the remote directory-tree walk is depth-capped');
    console.log('✓ connector-sync-safety: minimal env, scrubbed stderr, size-capped github pull, depth-bounded walk');

    // ── Connector access tokens are sealed at rest and opened only for use ──
    const conn = require(path.join(PROJECT, 'lib', 'mcp', 'connectors'));
    const keyFile = path.join(dir, 'data', 'secret.key');   // hermetic key, created on first seal
    const list = [{ id: 'c1', type: 'github', config: { owner: 'o', repo: 'r', token: 'ghp_PLAINTEXT_TOKEN_123' } }, { id: 'c2', type: 'filesystem', config: { path: '/x' } }];
    conn._sealTokens(list, keyFile);
    ok(list[0].config.token.startsWith('sb1:'), 'a connector token is sealed before it is persisted');
    ok(!list[0].config.token.includes('PLAINTEXT'), 'the plaintext token does not survive in the stored record');
    ok(list[1].config.token === undefined, 'a tokenless connector is left alone');
    ok(conn._sealTokens([{ id: 'c1', config: { token: list[0].config.token } }], keyFile)[0].config.token === list[0].config.token, 'sealing an already-sealed token is idempotent');
    const opened = conn._openConfig(list[0].config, keyFile);
    ok(opened.token === 'ghp_PLAINTEXT_TOKEN_123', 'openConfig opens the sealed token for use (spawn/API)');
    ok(list[0].config.token.startsWith('sb1:'), 'openConfig does not mutate the stored (sealed) record');
    ok(conn._openConfig({ token: 'legacy-plaintext' }, keyFile).token === 'legacy-plaintext', 'a legacy plaintext token passes through (back-compat)');
    // The route redaction (never send a token to the browser) still applies to a sealed token.
    const routeSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'connectors.js'), 'utf-8');
    ok(/hasToken: !!token/.test(routeSrc) && /redactConnector\(record\)/.test(routeSrc), 'the add response and the list both redact the token to a hasToken flag');
    // Drift guard: the write path seals and the use sites open.
    ok(/s\.connectors = sealTokens\(connectors\)/.test(connSrc), 'saveConnectors seals every token before persisting');
    ok((connSrc.match(/openConfig\(record\.config\)/g) || []).length >= 1 && /builder\(useConfig\)/.test(connSrc), 'the spec-build/use sites open the token');
    console.log('✓ connector-sync-safety: access tokens are sealed at rest, opened only for use, redacted to the UI');

    console.log(`\nALL CONNECTOR-SYNC-SAFETY UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ CONNECTOR-SYNC-SAFETY UNIT TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
