'use strict';
// Offline check for the boot-integrity registry (lib/watchdog): registration is
// idempotent, run() executes every check, a check that throws is recorded (never fatal),
// and the built-in checks return the right shape on the real project. No model or network.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs'), os = require('os');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const wd = require(path.join(PROJECT, 'lib', 'watchdog'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // Idempotent registration — re-registering the same name replaces, never doubles.
    const before = wd.list().length;
    wd.register('__probe', () => null);
    wd.register('__probe', () => null);
    ok(wd.list().filter(n => n === '__probe').length === 1, 're-registering a name does not duplicate it');

    // A throwing check is caught and reported as a finding, never fatal.
    wd.register('__throws', () => { throw new Error('boom'); });
    let findings = await wd.run();
    ok(Array.isArray(findings), 'run() returns an array');
    ok(findings.some(f => f.check === '__throws' && /boom/.test(f.detail)), 'a throwing check becomes a finding, not a crash');

    // A finding-returning check surfaces its finding.
    wd.register('__finds', () => ({ action: 'watchdog.__finds', detail: 'x' }));
    findings = await wd.run();
    ok(findings.some(f => f.check === '__finds'), 'a check that returns a finding is surfaced');

    // A passing check contributes nothing.
    wd.register('__throws', () => null);
    wd.register('__finds', () => null);
    findings = await wd.run();
    ok(!findings.some(f => f.check === '__throws' || f.check === '__finds'), 'passing checks contribute no findings');
    console.log('✓ watchdog: idempotent register, throwing check caught, findings surfaced');

    // The built-in checks run clean on the real project (data dir writable, config sane,
    // every mutating /api/v1 route has a declared scope).
    for (const name of ['data_dir_writable', 'config_sane', 'api_scope_coverage', 'index_mapping_consistent', 'bm25_index_consistent', 'passage_offsets_valid', 'embedding_banks_loaded', 'disk_space', 'memory_headroom', 'event_loop_lag', 'audit_chain_integrity', 'network_exposure', 'automation_schedules', 'service_paths_valid', 'browser_profiles_stale', 'api_keys_parseable', 'stale_temp_writes', 'index_matches_documents', 'documents_dim_mismatched', 'web_egress_all_cooled', 'bank_migration_incomplete', 'automations_within_cap']) {
      ok(wd.list().includes(name), `${name} is registered`);
    }
    const apiv1 = require(path.join(PROJECT, 'lib', 'routes', 'apiv1'));
    ok(apiv1.ROUTE_SCOPES && Object.keys(apiv1.ROUTE_SCOPES).length > 0, 'apiv1 exposes a ROUTE_SCOPES contract');
    // network_exposure is clean on the default loopback bind; automation_schedules is clean
    // with no invalid crons — both return null (no finding) on a default project.
    ok(require(path.join(PROJECT, 'lib', 'automations')).invalidSchedules().length === 0, 'no invalid automation schedules on a default project');
    console.log('✓ watchdog: every built-in check is registered (including the resource sentinel); apiv1 exposes its scope contract');

    // ── embedding_banks_loaded fires on a corrupt (unreadable) frozen bank, stays quiet otherwise ──
    // A frozen bank whose index is present but unreadable is silently dropped from dense search with no
    // self-heal, so the check must surface it. Drive it by setting the state/config it reads, then
    // restore both so the shared singletons aren't left dirty for anything else in this process.
    {
      const state = require(path.join(PROJECT, 'lib', 'state'));
      const cfg   = require(path.join(PROJECT, 'lib', 'config'));
      const saved = { banks: cfg.useEmbeddingBanks, ready: state.indexReady, vb: state.vectorBanks };
      try {
        cfg.useEmbeddingBanks = true;
        state.indexReady = true;

        // Off → the check never runs even with a failed bank present.
        cfg.useEmbeddingBanks = false;
        state.vectorBanks = [{ fp: 'aaa', meta: { model: 'nomic-embed-text' }, store: null, failed: true }];
        let f = await wd.run();
        ok(!f.some(x => x.check === 'embedding_banks_loaded'), 'with banks OFF the bank check stays quiet');

        // On, with a healthy bank → quiet.
        cfg.useEmbeddingBanks = true;
        state.vectorBanks = [{ fp: 'aaa', meta: { model: 'nomic-embed-text' }, store: {}, failed: false }];
        f = await wd.run();
        ok(!f.some(x => x.check === 'embedding_banks_loaded'), 'a healthy loaded bank raises no finding');

        // On, with a corrupt frozen bank → finding that names the model and points to a rebuild.
        state.vectorBanks = [
          { fp: 'aaa', meta: { model: 'nomic-embed-text' }, store: {}, failed: false },
          { fp: 'bbb', meta: { model: 'all-minilm' }, store: null, failed: true },
        ];
        f = await wd.run();
        const finding = f.find(x => x.check === 'embedding_banks_loaded');
        ok(finding && /all-minilm/.test(finding.detail) && /[Rr]ebuild/.test(finding.detail),
          'a corrupt frozen bank is surfaced, naming the affected model and the rebuild remedy');

        // On, but bank list not yet populated → quiet (fresh/empty install, not an anomaly).
        state.vectorBanks = [];
        f = await wd.run();
        ok(!f.some(x => x.check === 'embedding_banks_loaded'), 'an unpopulated bank list is not treated as loss');
        console.log('✓ watchdog: embedding_banks_loaded surfaces a corrupt frozen bank and stays quiet otherwise');
      } finally {
        cfg.useEmbeddingBanks = saved.banks;
        state.indexReady = saved.ready;
        state.vectorBanks = saved.vb;
      }
    }

    // ── A cooled-down bank (its provider/endpoint is gone) is surfaced too, because its documents are now
    //    keyword-only. The search path cools it down after a failure; the watchdog turns that into a finding. ──
    {
      const state = require(path.join(PROJECT, 'lib', 'state'));
      const cfg   = require(path.join(PROJECT, 'lib', 'config'));
      const emb   = require(path.join(PROJECT, 'lib', 'embeddings'));
      const saved = { banks: cfg.useEmbeddingBanks, ready: state.indexReady, vb: state.vectorBanks };
      try {
        cfg.useEmbeddingBanks = true;
        state.indexReady = true;
        const store = {};
        emb.noteBankFailure(store);
        state.vectorBanks = [{ fp: 'ccc', meta: { model: 'bge-m3' }, store, failed: false }];
        let f = await wd.run();
        const finding = f.find(x => x.check === 'embedding_banks_loaded');
        ok(finding && /bge-m3/.test(finding.detail) && /keyword-only/.test(finding.detail) && /Consolidate/.test(finding.detail),
          'a cooled-down bank is surfaced with its model, the keyword-only effect, and the consolidate remedy');
        emb.noteBankSuccess(store);
        f = await wd.run();
        ok(!f.some(x => x.check === 'embedding_banks_loaded'), 'a recovered bank is quiet again');
        console.log('✓ watchdog: embedding_banks_loaded surfaces a cooled-down bank and clears when it recovers');
      } finally {
        cfg.useEmbeddingBanks = saved.banks;
        state.indexReady = saved.ready;
        state.vectorBanks = saved.vb;
      }
    }

    // ── automation_schedules surfaces an unavailable scheduler (node-cron failed to load) ──
    // When cron isn't available yet automations are enabled, none can ever fire and invalidSchedules()
    // can't report it (it returns [] with no cron). Stub the automations module to that state and assert
    // the check flags it; restore afterward so the shared module isn't left patched.
    {
      const auto = require(path.join(PROJECT, 'lib', 'automations'));
      const savedCron = auto.cronAvailable, savedCount = auto.enabledCount, savedInvalid = auto.invalidSchedules;
      try {
        auto.cronAvailable = () => false;
        auto.enabledCount = () => 3;
        auto.invalidSchedules = () => [];
        const f = await wd.run();
        const finding = f.find(x => x.check === 'automation_schedules' && /scheduler_unavailable/.test(x.action));
        ok(finding && /node-cron/.test(finding.detail) && /3/.test(finding.detail),
          'an unavailable scheduler with enabled automations is surfaced');

        // With cron available and nothing invalid, the check stays quiet.
        auto.cronAvailable = () => true;
        auto.enabledCount = () => 2;
        const f2 = await wd.run();
        ok(!f2.some(x => x.action === 'watchdog.scheduler_unavailable'), 'an available scheduler raises no scheduler finding');
        console.log('✓ watchdog: automation_schedules flags an unavailable scheduler, quiet when cron is present');
      } finally {
        auto.cronAvailable = savedCron;
        auto.enabledCount = savedCount;
        auto.invalidSchedules = savedInvalid;
      }
    }

    // ── Detection-branch coverage for the data-integrity / security checks ──────────────────────────────
    // The whole value of the watchdog is detection; these drive the anomaly branch of the highest-consequence
    // checks (silent corpus loss, degraded search, wrong-document resolution, every-API-key-rejected, an
    // ungated mutating route) by setting the exact state/config each reads, then restore the shared singletons.
    {
      const state = require(path.join(PROJECT, 'lib', 'state'));
      const cfg   = require(path.join(PROJECT, 'lib', 'config'));
      const findBy = (f, check) => f.find(x => x.check === check);

      // bm25_index_consistent — a ready index with documents but no BM25 engine = silent dense-only degrade.
      {
        const saved = { ready: state.indexReady, pm: state.parentMap, bm: state.liveBM25 };
        try {
          state.indexReady = true;
          state.parentMap = new Map([['d1', {}]]);
          state.liveBM25 = null;
          ok(findBy(await wd.run(), 'bm25_index_consistent'), 'bm25_index_consistent fires when documents exist but the BM25 engine is missing');
          state.liveBM25 = { engine: {} };
          ok(!findBy(await wd.run(), 'bm25_index_consistent'), 'bm25_index_consistent is quiet once the BM25 engine is present');
          // A corpus below the BM25 library's minimum is reported by buildBM25Index as { engine: null,
          // empty: true } — expected, and a rebuild would reproduce it. It must not warn.
          state.liveBM25 = { engine: null, empty: true };
          ok(!findBy(await wd.run(), 'bm25_index_consistent'), 'bm25_index_consistent is quiet for a corpus too small to build BM25');
        } finally { Object.assign(state, { indexReady: saved.ready, parentMap: saved.pm, liveBM25: saved.bm }); }
      }

      // passage_offsets_valid — more than a quarter of chunks with an unresolved (-1) source offset.
      {
        const saved = { ready: state.indexReady, cm: state.childMap, pmap: state.passageMap };
        try {
          state.indexReady = true;
          state.childMap = new Map([['c1', 'd'], ['c2', 'd'], ['c3', 'd'], ['c4', 'd']]);
          state.passageMap = new Map([['c1', { startChar: 0 }], ['c2', { startChar: -1 }], ['c3', { startChar: -1 }], ['c4', { startChar: -1 }]]);
          ok(findBy(await wd.run(), 'passage_offsets_valid'), 'passage_offsets_valid fires when most chunk offsets are unresolved');
          state.passageMap = new Map([['c1', { startChar: 0 }], ['c2', { startChar: 5 }], ['c3', { startChar: 9 }], ['c4', { startChar: -1 }]]);
          ok(!findBy(await wd.run(), 'passage_offsets_valid'), 'passage_offsets_valid is quiet when offsets mostly resolve');
        } finally { Object.assign(state, { indexReady: saved.ready, childMap: saved.cm, passageMap: saved.pmap }); }
      }

      // index_mapping_consistent — the position→id map disagrees with the vector count.
      {
        const saved = state.liveVectorStore;
        try {
          state.liveVectorStore = { index: { ntotal: () => 3 }, _mapping: { 0: 'a', 1: 'b' } };   // 2 entries for 3 vectors
          ok(findBy(await wd.run(), 'index_mapping_consistent'), 'index_mapping_consistent fires when the map and the index disagree');
          state.liveVectorStore = { index: { ntotal: () => 2 }, _mapping: { 0: 'a', 1: 'b' } };
          ok(!findBy(await wd.run(), 'index_mapping_consistent'), 'index_mapping_consistent is quiet when they match');
        } finally { state.liveVectorStore = saved; }
      }

      // config_sane — an out-of-range numeric knob (numCtx too small to hold the grounding rules).
      {
        const saved = cfg.numCtx;
        try {
          cfg.numCtx = 128;
          ok(findBy(await wd.run(), 'config_sane'), 'config_sane fires on an out-of-range numCtx');
          cfg.numCtx = saved;
          ok(!findBy(await wd.run(), 'config_sane'), 'config_sane is quiet with sane config');
          // maxTokens 0 means AUTO (sized to the model), not a misconfiguration — config_sane must stay quiet on
          // it, the same as numCtx 0. A negative value is still flagged.
          const savedMax = cfg.MAX_TOKENS;
          try {
            cfg.MAX_TOKENS = 0;
            ok(!findBy(await wd.run(), 'config_sane'), 'config_sane treats maxTokens=0 as Auto (stays quiet)');
            cfg.MAX_TOKENS = -5;
            ok(findBy(await wd.run(), 'config_sane'), 'config_sane still flags a negative maxTokens');
          } finally { cfg.MAX_TOKENS = savedMax; }
        } finally { cfg.numCtx = saved; }
      }

      // index_matches_documents — the manifest records real documents but the in-memory index is empty.
      {
        const manifest = require(path.join(PROJECT, 'lib', 'indexing', 'manifest'));
        const savedLoad = manifest.loadManifest;
        const saved = { ready: state.indexReady, indexing: state.indexing, pm: state.parentMap };
        try {
          state.indexReady = true; state.indexing = false; state.parentMap = new Map();
          manifest.loadManifest = async () => ({ docA: { skipped: false }, docB: { skipped: false }, _meta: 1 });
          ok(findBy(await wd.run(), 'index_matches_documents'), 'index_matches_documents fires when the manifest has docs but the index is empty');
          manifest.loadManifest = async () => ({});
          ok(!findBy(await wd.run(), 'index_matches_documents'), 'index_matches_documents is quiet when the manifest is empty too');
        } finally { manifest.loadManifest = savedLoad; Object.assign(state, { indexReady: saved.ready, indexing: saved.indexing, parentMap: saved.pm }); }
      }

      // api_scope_coverage — a mutating route with no declared scope, or an unknown scope name.
      {
        const apiv1 = require(path.join(PROJECT, 'lib', 'routes', 'apiv1'));
        const savedScopes = apiv1.ROUTE_SCOPES, savedStack = apiv1.stack;
        try {
          apiv1.ROUTE_SCOPES = { 'POST /x': 'not-a-real-scope' };
          apiv1.stack = [{ route: { path: '/x', methods: { post: true } } }];
          ok(findBy(await wd.run(), 'api_scope_coverage'), 'api_scope_coverage fires on an unknown scope / ungated mutating route');
        } finally { apiv1.ROUTE_SCOPES = savedScopes; apiv1.stack = savedStack; }
        ok(!findBy(await wd.run(), 'api_scope_coverage'), 'api_scope_coverage is quiet on the real, fully-gated contract');
      }

      // api_keys_parseable — a present-but-corrupt api-keys.json (every key would be rejected with no cause).
      {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-wd-'));
        const savedDir = cfg.DATA_DIR;
        try {
          cfg.DATA_DIR = tmp;
          fs.writeFileSync(path.join(tmp, 'api-keys.json'), '{ this is not json');
          ok(findBy(await wd.run(), 'api_keys_parseable'), 'api_keys_parseable fires on a corrupt api-keys.json');
          fs.writeFileSync(path.join(tmp, 'api-keys.json'), JSON.stringify({ keys: [] }));
          ok(!findBy(await wd.run(), 'api_keys_parseable'), 'api_keys_parseable is quiet on a valid api-keys.json');
        } finally { cfg.DATA_DIR = savedDir; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
      }

      // documents_dim_mismatched — the manifest records documents stranded keyword-only by the embedding
      // dimension guard; they are invisible otherwise, so the check must surface a count and the remedy.
      {
        const manifest = require(path.join(PROJECT, 'lib', 'indexing', 'manifest'));
        const savedLoad = manifest.loadManifest;
        const saved = { ready: state.indexReady, indexing: state.indexing };
        try {
          state.indexReady = true; state.indexing = false;
          manifest.loadManifest = async () => ({ 'a.pdf': { fileHash: 'h', dimMismatch: true }, 'b.pdf': { fileHash: 'h2', dimMismatch: true }, 'ok.pdf': { fileHash: 'h3' }, _meta: 1 });
          const f = findBy(await wd.run(), 'documents_dim_mismatched');
          ok(f && /2 document/.test(f.detail) && /[Rr]ebuild/.test(f.detail), 'documents_dim_mismatched counts mismatched docs and points to a rebuild');
          manifest.loadManifest = async () => ({ 'ok.pdf': { fileHash: 'h3' } });
          ok(!findBy(await wd.run(), 'documents_dim_mismatched'), 'documents_dim_mismatched is quiet when no document is mismatched');
        } finally { manifest.loadManifest = savedLoad; Object.assign(state, { indexReady: saved.ready, indexing: saved.indexing }); }
      }

      // web_egress_all_cooled — a configured proxy pool whose every exit is in cooldown = web egress down.
      // Synthetic placeholder exits; drive the health map through recordExit, then restore config.
      {
        const wp = require(path.join(PROJECT, 'lib', 'webproxy'));
        const saved = { url: cfg.WEB_PROXY_URL };
        try {
          // No pool configured → never fires, even if stale health exists.
          cfg.WEB_PROXY_URL = '';
          ok(!findBy(await wd.run(), 'web_egress_all_cooled'), 'web_egress_all_cooled is quiet with no proxy pool configured');
          // A two-exit pool with BOTH exits cooled (4 dead outcomes each crosses the cooldown threshold).
          const A = 'http://p1.example:8080', B = 'http://p2.example:8080';
          cfg.WEB_PROXY_URL = `${A}\n${B}`;
          for (const u of [A, B]) for (let i = 0; i < 4; i++) wp.recordExit(u, 'dead');
          const f = findBy(await wd.run(), 'web_egress_all_cooled');
          ok(f && /2/.test(f.detail), 'web_egress_all_cooled fires when every configured exit is resting');
          // One exit recovers (ok) → no longer all cooled → quiet.
          wp.recordExit(A, 'ok');
          ok(!findBy(await wd.run(), 'web_egress_all_cooled'), 'web_egress_all_cooled clears once an exit recovers');
        } finally { cfg.WEB_PROXY_URL = saved.url; }
      }

      console.log('✓ watchdog: detection branches fire for BM25, passage offsets, index mapping, config, empty-index, API scope, API keys, dim-mismatch, and egress health');
    }

    // ── Re-entrancy guard: a second run() while one is in flight returns [] immediately (no overlap) ──
    {
      // Register a slow check so the first run() is still in flight when we fire the second.
      wd.register('__slow', () => new Promise((r) => setTimeout(() => r(null), 150)));
      const p1 = wd.run();
      const r2 = await wd.run();   // fires while p1's slow check is pending
      assert.ok(Array.isArray(r2) && r2.length === 0, 're-entrant run() is skipped (returns empty) while a sweep is in flight'); checks++;
      await p1;   // let the first sweep finish so _running clears
      // After it clears, a fresh run() proceeds normally again.
      ok(Array.isArray(await wd.run()), 'run() works again after the in-flight sweep completes (guard self-clears)');
    }

    // ── Non-blocking + teardown source guards (the fs probes are async + timeout-bounded; stop() tears down) ──
    {
      const src = fs.readFileSync(path.join(PROJECT, 'lib', 'watchdog.js'), 'utf-8');
      ok(/const CHECK_TIMEOUT_MS = /.test(src) && /_withTimeout\(Promise\.resolve\(\)\.then/.test(src),
        'each check runs under a per-check wall-clock timeout');
      ok(/let _running = false;/.test(src) && /if \(_running\)/.test(src), 'a re-entrancy guard prevents overlapping sweeps');
      ok(/register\('disk_space', async function/.test(src) && /freeBytesAsync/.test(src), 'disk_space probes free space asynchronously');
      ok(/register\('cluster_storage', async function/.test(src) && /await fs\.access/.test(src), 'cluster_storage probes the shared mount asynchronously');
      ok(/require\('\.\/cluster'\)\.isReplica\(\)\) return null/.test(src), 'data_dir_writable skips the write-probe on a read replica (no false alarm)');
      ok(/function stop\(\)/.test(src) && /_eldHistogram\.disable\(\)/.test(src), 'stop() disables the event-loop histogram on shutdown');
      // freeBytesAsync behaves: a number for a real dir, null for an unmeasurable one.
      const free = await require(path.join(PROJECT, 'lib', 'disk')).freeBytesAsync(os.tmpdir());
      ok(free === null || (typeof free === 'number' && free >= 0), 'freeBytesAsync returns a non-negative number (or null when unmeasurable)');
      console.log('✓ watchdog: sweeps never overlap, fs probes are async + timeout-bounded, replica write-probe is skipped, histogram tears down');
    }

    // The latest sweep is available read-only for the Settings health panel, as a defensive copy.
    {
      const last = wd.lastFindings();
      ok(last && typeof last.at === 'number' && Array.isArray(last.findings),
        'lastFindings exposes the latest sweep timestamp and bounded findings');
      const n = last.findings.length;
      last.findings.push({ check: 'mutated' });
      ok(wd.lastFindings().findings.length === n, 'lastFindings returns a copy a caller cannot mutate');
      console.log('✓ watchdog: lastFindings exposes a read-only copy of the latest sweep');
    }

    console.log(`\nALL WATCHDOG UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ WATCHDOG UNIT TEST FAILED:', e.message);
    process.exit(1);
  }
})();
