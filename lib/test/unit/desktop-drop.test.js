'use strict';
// Guards desktop drag-and-drop ingestion (lib/desktopdrop.js + the shell/sidecar wiring). The Tauri shell takes
// the OS file drop NATIVELY and hands the paths to the sidecar over stdin, because recent WebKitGTK no longer
// exposes dropped files to the webview's HTML5 dataTransfer on Linux (CVE-2025-13947). This test runs the pure
// copy/skip logic against a temp data dir with the heavy reindex stubbed, and guards the Rust + sidecar wiring so
// the native-drop path can't silently revert to the broken DOM path. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

// Point config at a throwaway data dir BEFORE anything requires it (config reads --data-dir from argv at load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-drop-'));
process.argv.push('--data-dir', TMP);

const R = (p) => require(path.join(PROJECT, 'lib', p));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    const drop = R('desktopdrop');
    const wsm = R('workspaces');
    const cfg = R('config');

    // Stub the heavy reindex so the test stays hermetic (no embedder/model). ingestLocalPaths looks the method up
    // on the cached module at call time, so replacing it here intercepts the call and records the workspace.
    const initMod = R('indexing/init');
    let reflectedWs = null;
    initMod.reflectWorkspaceMutation = async (wsId) => { reflectedWs = wsId; return { ok: true }; };

    // ── allowedExtensions reflects the live Settings gating (base set always; OCR/media only when enabled) ──
    const allowed = drop.allowedExtensions();
    ok(allowed instanceof Set && allowed.has('.txt') && allowed.has('.pdf'), 'base document types are always accepted');

    // Shrink the size cap for the test so "oversized" is a few hundred bytes, not the real multi-GB limit
    // (ingestLocalPaths reads cfg.MAX_FILE_SIZE live at call time).
    cfg.MAX_FILE_SIZE = 64;

    // ── make three source files: a supported .txt, an unsupported .xyz, and an oversized .txt ──
    const srcDir = path.join(TMP, 'src'); fs.mkdirSync(srcDir, { recursive: true });
    const good = path.join(srcDir, 'synthetic-note.txt'); fs.writeFileSync(good, 'note\n');          // under the 64-byte cap
    const bad  = path.join(srcDir, 'synthetic.xyz');       fs.writeFileSync(bad, 'nope');
    const big  = path.join(srcDir, 'huge.txt');            fs.writeFileSync(big, 'x'.repeat(200));   // over the 64-byte cap

    const res = await drop.ingestLocalPaths([good, bad, big, path.join(srcDir, 'missing.txt')]);

    // ── the supported file is copied into the ACTIVE workspace's documents dir; the rest are skipped with reasons ──
    ok(res.added === 1, `exactly the one supported, in-size file is ingested (added=${res.added})`);
    const docsDir = wsm.docsDirFor(cfg.DATA_DIR, wsm.DEFAULT_ID);
    const listing = fs.existsSync(docsDir) ? fs.readdirSync(docsDir) : [];
    ok(listing.some(f => /synthetic-note/.test(f)), `the dropped .txt landed in the workspace docs dir (${listing.join(', ')})`);
    ok(!listing.some(f => /\.xyz$/.test(f)) && !listing.some(f => /huge/.test(f)), 'the unsupported and oversized files were NOT copied');
    const reasons = res.skipped.map(s => s.reason);
    ok(reasons.includes('unsupported type') && reasons.includes('too large') && reasons.includes('not a file'),
      `each skip records a reason (${reasons.join(', ')})`);

    // ── the reindex is triggered for the active workspace, so the UI refreshes like an upload ──
    ok(reflectedWs === wsm.DEFAULT_ID, `a successful drop reindexes the active workspace (reflected=${reflectedWs})`);

    // ── an empty / non-array drop is a no-op and never throws, and never reindexes ──
    reflectedWs = null;
    const empty = await drop.ingestLocalPaths([]);
    ok(empty.added === 0 && reflectedWs === null, 'an empty drop does nothing (no copy, no reindex)');

    // ── wiring guards: the shell takes the drop natively and the sidecar routes it here (not via the DOM) ──
    const mainRs = fs.readFileSync(path.join(PROJECT, 'src-tauri', 'src', 'main.rs'), 'utf-8');
    ok(!/\.disable_drag_drop_handler\(\)/.test(mainRs),
      'the native OS drag-drop handler is LEFT ENABLED (disable_drag_drop_handler removed) so the shell receives the drop');
    ok(/WindowEvent::DragDrop\(DragDropEvent::Drop \{ paths, \.\. \}\)/.test(mainRs) && /ingest_dropped\(/.test(mainRs),
      'main.rs handles the native DragDrop event and forwards the paths to the sidecar');
    ok(/write_all\(format!\("ingest\\t\{\}\\n"/.test(mainRs), 'the shell writes the dropped paths as an "ingest" stdin line');
    const boot = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
    ok(/line\.startsWith\('ingest\\t'\)/.test(boot) && /desktopdrop'\)\.ingestLocalPaths/.test(boot),
      'the sidecar parses the "ingest" stdin line and ingests the dropped paths');

    console.log('✓ desktop-drop: dropped files are copied into the active workspace and reindexed; native-drop wiring intact');
    console.log(`\nALL DESKTOP-DROP UNIT TESTS PASSED (${checks} checks)`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } catch (e) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    console.error('\n✗ DESKTOP-DROP UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
