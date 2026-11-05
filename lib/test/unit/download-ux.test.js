'use strict';
// Guards how the app saves generated files (answer exports, the extraction table) so the user ALWAYS gets to
// choose where the file goes — the same experience in the web app and the desktop app:
//   • the web/Chromium path opens a real "Save As" dialog (File System Access API) and streams to the chosen file;
//   • cancelling that dialog is a no-op (never a surprise second download);
//   • the fallback is a normal browser download, and in a plain browser it says WHERE the file landed;
//   • the desktop app (macOS/Linux WebKit, which has no File System Access API) intercepts that same download in
//     the shell and shows a NATIVE save panel — so the desktop app offers a location too, not a silent drop.
// These are source guards (no DOM), matching the other UI guards in this suite. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');

  // ── the shared download helper ───────────────────────────────────────────────────────────────────────────
  ok(/async function triggerDownload\(/.test(chatJs), 'triggerDownload is the one shared save helper');
  ok(/window\.showSaveFilePicker/.test(chatJs) && /createWritable\(\)/.test(chatJs),
    'it opens a real "Save As" dialog where the File System Access API exists (Chromium web + Windows desktop)');
  ok(/e\.name === 'AbortError'\) return/.test(chatJs),
    'cancelling the Save As dialog is a no-op (no surprise second download)');
  ok(/createObjectURL\(new Blob/.test(chatJs) && /revokeObjectURL/.test(chatJs),
    'the fallback is a normal browser download, and the object URL is revoked');
  ok(/!IS_DESKTOP_APP\) showToast\(/.test(chatJs),
    'in a plain browser the fallback says WHERE the file landed; in the desktop app the shell handles it');

  // The extraction-table export reuses the same helper (one Save As path, no bespoke anchor download).
  ok(/triggerDownload\('extraction\.csv'/.test(chatJs), 'the extraction CSV export reuses triggerDownload');

  // ── the desktop shell intercepts the download and shows a native panel ───────────────────────────────────
  const shell = fs.readFileSync(path.join(PROJECT, 'src-tauri', 'src', 'main.rs'), 'utf-8');
  ok(/\.on_download\(/.test(shell) && /DownloadEvent::Requested/.test(shell) && /DownloadEvent::Finished/.test(shell),
    'the desktop shell intercepts the frontend download (no File System Access API in the webview)');
  ok(/save_file\(move \|dest\|/.test(shell),
    'the shell shows a NON-blocking native save panel (off the synchronous callback, so the UI never freezes)');
  ok(/std::fs::rename\(&temp, &target\)/.test(shell) && /std::fs::copy\(&temp, &target\)/.test(shell),
    'the finished download is moved to the chosen path (copy fallback across volumes)');

  // The frontend must NOT depend on Tauri IPC for this (the app deliberately exposes none to the local-server page).
  ok(!/__TAURI__/.test(chatJs), 'the download path uses no frontend IPC (the shell intercepts the plain download instead)');

  console.log(`\nALL DOWNLOAD-UX TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOWNLOAD-UX TEST FAILED:', e && e.message);
  process.exit(1);
}
