'use strict';
// Offline check for the tamper-evident audit trail (lib/audit): the pure chain primitives
// seal deterministically and the verifier catches EDIT / DELETION / REORDER / CLOCK-ROLLBACK,
// and a real round-trip (append to a temp data dir, then read + verify) chains cleanly and
// stays intact. No model or network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs'), os = require('os');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const audit = require(path.join(PROJECT, 'lib', 'audit'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// Seal a run of plain entries into a valid chain (mirrors what appendSealed does), so the
// verifier tests operate on a genuinely-valid chain we then tamper with.
const seal = (entries) => {
  let prev = audit.GENESIS_HASH;
  return entries.map((e, i) => {
    const row = Object.assign({ seq: i + 1, prev_hash: prev }, e);
    row.hash = audit.chainHash(row, prev);
    prev = row.hash;
    return row;
  });
};

(async () => {
  try {
    // ── chainHash is deterministic and prev-hash-sensitive ──
    const base = { seq: 1, ts: '2026-01-01T00:00:00.000Z', actor: 'local', action: 'config.update', target: '', detail: 'model', ip: '127.0.0.1' };
    ok(audit.chainHash(base, audit.GENESIS_HASH) === audit.chainHash(base, audit.GENESIS_HASH), 'chainHash is deterministic');
    ok(audit.chainHash(base, audit.GENESIS_HASH) !== audit.chainHash(base, 'ff'.repeat(32)), 'a different prev_hash changes the hash');
    ok(audit.chainHash(Object.assign({}, base, { detail: 'temperature' }), audit.GENESIS_HASH) !== audit.chainHash(base, audit.GENESIS_HASH), 'a changed field changes the hash');
    console.log('✓ audit: chainHash is deterministic and seals every field + prev_hash');

    // ── a valid chain verifies ──
    const rows = seal([
      { ts: '2026-01-01T00:00:00.000Z', actor: 'local', action: 'apikey.create', target: 'k_1', detail: 'name="ci"', ip: '127.0.0.1' },
      { ts: '2026-01-01T00:00:01.000Z', actor: 'apikey:k_1', action: 'api.ingest_url', target: 'default', detail: 'https://x', ip: '10.0.0.2' },
      { ts: '2026-01-01T00:00:02.000Z', actor: 'local', action: 'apikey.revoke', target: 'k_1', detail: '', ip: '127.0.0.1' },
    ]);
    ok(audit.verifyChainRows(rows, null).ok, 'an untampered chain verifies clean');

    // ── EDIT: altering a sealed field is detected ──
    const edited = rows.map(r => Object.assign({}, r));
    edited[1].detail = 'https://evil';
    ok(!audit.verifyChainRows(edited, null).ok, 'editing a field breaks the hash');

    // ── DELETION / REORDER: dropping a row breaks the link ──
    ok(!audit.verifyChainRows([rows[0], rows[2]], null).ok, 'deleting a middle row is detected (seq gap / prev_hash break)');
    ok(!audit.verifyChainRows([rows[1], rows[0], rows[2]], null).ok, 'reordering rows is detected');

    // ── CLOCK ROLLBACK: a backdated timestamp is flagged ──
    const rolled = seal([
      { ts: '2026-01-01T00:00:05.000Z', actor: 'local', action: 'a', target: '', detail: '', ip: '' },
      { ts: '2026-01-01T00:00:00.000Z', actor: 'local', action: 'b', target: '', detail: '', ip: '' },
    ]);
    ok(!audit.verifyChainRows(rolled, null).ok, 'a timestamp regression is flagged');

    // ── checkpoint: a chain that starts mid-sequence verifies against its checkpoint ──
    const full = seal([
      { ts: '2026-01-01T00:00:00.000Z', actor: 'local', action: 'a', target: '', detail: '', ip: '' },
      { ts: '2026-01-01T00:00:01.000Z', actor: 'local', action: 'b', target: '', detail: '', ip: '' },
      { ts: '2026-01-01T00:00:02.000Z', actor: 'local', action: 'c', target: '', detail: '', ip: '' },
    ]);
    const suffix = full.slice(1);   // pretend row 1 was pruned
    const checkpoint = { prunedThroughSeq: full[0].seq, prunedThroughHash: full[0].hash };
    ok(audit.verifyChainRows(suffix, checkpoint).ok, 'a pruned suffix verifies against its checkpoint');
    ok(!audit.verifyChainRows(suffix, null).ok, 'the same suffix without the checkpoint reads as a deletion');
    console.log('✓ audit: verifyChainRows catches edit / deletion / reorder / rollback, honors checkpoints');

    // ── real round-trip: audit() appends a sealed line and verifyChain() confirms it ──
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-audit-'));
    // Point the module's data dir at a throwaway directory via config (audit reads DATA_DIR live).
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    const origDataDir = cfg.DATA_DIR;
    cfg.DATA_DIR = tmp;
    try {
      audit.audit('local', 'apikey.create', 'k_x', 'name="rt"');
      audit.audit({ apiKey: { id: 'k_x' }, headers: { 'x-forwarded-for': '9.9.9.9' } }, 'api.ingest_url', 'default', 'https://round.trip');
      // A failed auth carries a request with no api key — it must read as anonymous, never "local".
      audit.audit({ headers: { 'x-forwarded-for': '8.8.8.8' } }, 'api.auth_fail', 'POST /search', 'bad key');
      // Control characters in a user-influenced field must be scrubbed (they'd tear the JSONL / shift the hash).
      audit.audit('local', 'config.update', '', 'a\x1fb\ncd');
      // audit() is fire-and-forget through an internal queue; give the microtask queue a tick to flush.
      await new Promise(r => setTimeout(r, 50));
      const v = audit.verifyChain(tmp);
      ok(v.ok && v.checked === 4, `round-tripped chain verifies (checked=${v.checked})`);
      const list = audit.list({ limit: 10 });   // newest-first
      ok(list.length === 4 && list[3].action === 'apikey.create', 'list() returns newest-first entries');
      const ingest = list.find(e => e.action === 'api.ingest_url');
      ok(ingest.actor === 'apikey:k_x' && ingest.ip === '9.9.9.9', 'actor + client IP are derived from the request');
      const authFail = list.find(e => e.action === 'api.auth_fail');
      ok(authFail.actor === 'anonymous' && authFail.ip === '8.8.8.8', 'a failed auth is actor=anonymous, not local');
      const cfg2 = list.find(e => e.action === 'config.update');
      ok(!/[\x00-\x1f]/.test(cfg2.detail) && cfg2.detail === 'a b cd', 'control characters are scrubbed from sealed fields');
    } finally {
      cfg.DATA_DIR = origDataDir;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    }
    console.log('✓ audit: a real append round-trips, seals a valid chain, and reads back newest-first');

    // ── report(): one async read yields both the verdict and the filtered entries ──
    {
      const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-auditrep-'));
      const cfg = require(path.join(PROJECT, 'lib', 'config'));
      const orig = cfg.DATA_DIR;
      cfg.DATA_DIR = tmpR;
      try {
        audit.audit('local', 'apikey.create', 'k_r', 'name="rep"');
        audit.audit('local', 'config.update', '', 'model');
        audit.audit({ headers: {} }, 'api.auth_fail', 'POST /search', 'bad key');
        await new Promise(r => setTimeout(r, 50));
        const all = await audit.report({ limit: 10 });
        // The chain verdict logic is covered by the verifyChainRows tests above; here we only need
        // report() to derive a verdict over the right number of rows and return the entries. (The
        // shared in-memory chain head across sub-tests makes this fresh-dir chain start mid-sequence,
        // so `ok` is legitimately false — assert on `checked`, not the verdict.)
        ok(all.integrity && typeof all.integrity.ok === 'boolean' && all.integrity.checked === 3, `report() verifies over all rows (checked=${all.integrity && all.integrity.checked})`);
        ok(Array.isArray(all.entries) && all.entries.length === 3, 'report() returns the entries');
        ok(all.entries[0].action === 'api.auth_fail', 'report() entries are newest-first');
        const filtered = await audit.report({ limit: 10, action: 'config' });
        ok(filtered.entries.length === 1 && filtered.entries[0].action === 'config.update', 'report() honors the action filter');
        ok(filtered.integrity.checked === 3, 'report() integrity still covers the whole chain even when entries are filtered');
      } finally {
        cfg.DATA_DIR = orig;
        try { fs.rmSync(tmpR, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
      }
      console.log('✓ audit: report() derives the verdict and filtered entries from a single async read');
    }

    // ── cluster: each node writes its own chain file; the readers verify each and merge them ──
    {
      const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-auditc-'));
      try {
        const a = seal([
          { ts: '2026-02-01T00:00:00.000Z', actor: 'user:alice', action: 'auth.login', target: '', detail: '', ip: '10.0.0.1' },
          { ts: '2026-02-01T00:00:05.000Z', actor: 'user:alice', action: 'auth.logout', target: '', detail: '', ip: '10.0.0.1' },
        ]);
        const b = seal([
          { ts: '2026-02-01T00:00:03.000Z', actor: 'user:bob', action: 'auth.login', target: '', detail: '', ip: '10.0.0.2' },
        ]);
        fs.writeFileSync(path.join(tmpC, 'audit.jsonl'), a.map(r => JSON.stringify(r)).join('\n') + '\n');
        fs.writeFileSync(path.join(tmpC, 'audit.node-b.jsonl'), b.map(r => JSON.stringify(r)).join('\n') + '\n');

        const v = audit.verifyChain(tmpC);
        ok(v.ok && v.checked === 3, `both per-node chains verify and are counted (checked=${v.checked})`);

        const rep = await audit.report({ limit: 10 }, tmpC);
        ok(rep.integrity.ok && rep.integrity.checked === 3, 'report() aggregates integrity across node files');
        ok(rep.entries.length === 3, 'report() merges entries from every node file');
        ok(rep.entries[0].action === 'auth.logout', 'merged entries are newest-first across files by timestamp');

        // Tamper ONE node's file: the combined verdict fails and names that file.
        const tampered = b.map(r => Object.assign({}, r)); tampered[0].detail = 'forged';
        fs.writeFileSync(path.join(tmpC, 'audit.node-b.jsonl'), tampered.map(r => JSON.stringify(r)).join('\n') + '\n');
        const v2 = audit.verifyChain(tmpC);
        ok(!v2.ok && v2.anomalies.some(x => x.includes('audit.node-b.jsonl')),
          'tampering one node chain fails the combined verdict and tags the offending file');
      } finally {
        try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
      }
      console.log('✓ audit: per-node chain files are each verified and merged (cluster-safe audit trail)');
    }

    // ── auditAuthFail: coalesce on the unspoofable peer, not a client header ──
    // A flood of unauthenticated requests must not each write a sealed line (synchronous append
    // + periodic full-log rewrite = a DoS amplifier). Coalescing keys on the TCP peer address, so
    // rotating X-Forwarded-For per request — the header an attacker controls — cannot defeat it.
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-authfail-'));
      const cfg = require(path.join(PROJECT, 'lib', 'config'));
      const origDataDir = cfg.DATA_DIR;
      cfg.DATA_DIR = tmp2;
      try {
        // 100 requests from ONE socket, each with a different spoofed X-Forwarded-For.
        for (let i = 0; i < 100; i++) {
          audit.auditAuthFail(
            { socket: { remoteAddress: '203.0.113.7' }, headers: { 'x-forwarded-for': `198.51.100.${i}` } },
            'api.auth_fail', 'POST /search', 'bad key');
        }
        await new Promise(r => setTimeout(r, 80));
        const rotated = audit.list({ action: 'api.auth_fail', limit: 1000 });
        ok(rotated.length === 1, `rotating X-Forwarded-For from one peer coalesces to a single entry (got ${rotated.length})`);

        // A distributed flood (many distinct peers, one request each) is capped by the global
        // token bucket rather than writing one line per source address.
        const before = rotated.length;
        for (let i = 0; i < 300; i++) {
          audit.auditAuthFail(
            { socket: { remoteAddress: `192.0.2.${i}` }, headers: {} },
            'api.auth_fail', 'POST /search', 'bad key');
        }
        await new Promise(r => setTimeout(r, 120));
        const flooded = audit.list({ action: 'api.auth_fail', limit: 2000 });
        const added = flooded.length - before;
        ok(added < 300, `a 300-peer flood does not write one entry per peer (added ${added})`);
        ok(added <= 30, `the global bucket caps recorded auth-fails per window (added ${added})`);

        // Hard LRU cap: flood well past the tracked-peer ceiling with distinct peers. Once the
        // global bucket is exhausted every new peer takes the insert-and-suppress branch, which
        // must still evict — otherwise the map grows without bound (a pre-authentication memory
        // DoS). Assert the tracked-peer set never exceeds its ceiling.
        const maxKeys = audit._authFailMaxKeys();
        for (let i = 0; i < maxKeys * 2 + 500; i++) {
          audit.auditAuthFail(
            { socket: { remoteAddress: `198.18.${(i >> 8) & 255}.${i & 255}` }, headers: {} },
            'api.auth_fail', 'POST /search', 'bad key');
        }
        ok(audit._authFailSeenSize() <= maxKeys, `the tracked-peer map stays hard-capped under a large distributed flood (size ${audit._authFailSeenSize()} <= ${maxKeys})`);
      } finally {
        cfg.DATA_DIR = origDataDir;
        try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
      }
    }
    console.log('✓ audit: auth-fail coalesces on the TCP peer (spoofed XFF cannot defeat it) and a distributed flood is bucket-capped');

    console.log(`\nALL AUDIT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ AUDIT UNIT TEST FAILED:', e.message);
    process.exit(1);
  }
})();
