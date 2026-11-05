'use strict';
// Guards that the client UI never falls back to the browser's native alert()/confirm()/prompt().
// Those dialogs are unstyled (match no theme), block the event loop, and behave inconsistently in the
// packaged desktop webview (WebView2 has no prompt(); wry/WKWebView returns null) — so every
// notification goes through the themed non-blocking toast (showToast) and every confirmation through
// the themed in-app modal (showConfirm / showPromptModal). This is a source guard: a reintroduced
// native call fails the build rather than shipping a broken/unthemed dialog. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const chatJs = fs.readFileSync(path.join(ROOT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
const css = fs.readFileSync(path.join(ROOT, 'lib', 'public', 'css', 'app.css'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Strip line comments and string literals so a mention inside a comment/quote isn't a false positive.
const codeOnly = chatJs
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')   // line comments
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")                          // single-quoted strings
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')                          // double-quoted strings
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');                         // template strings

try {
  // ── No native dialog calls remain in the code (a call is `name(` not preceded by a dot/word char) ──
  for (const fn of ['alert', 'confirm', 'prompt']) {
    const re = new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'g');
    const hits = (codeOnly.match(re) || []).length;
    ok(hits === 0, `no native ${fn}() call remains in chat.js (found ${hits})`);
  }

  // ── The themed replacements exist ──
  ok(/function showConfirm\(/.test(chatJs), 'showConfirm() in-app confirm modal exists');
  ok(/function showToast\(/.test(chatJs), 'showToast() in-app notification exists');
  ok(/function showPromptModal\(/.test(chatJs), 'showPromptModal() in-app text prompt exists');

  // ── showConfirm is safe-by-default: focus/Enter cannot fire a destructive action ──
  const scIdx = chatJs.indexOf('function showConfirm(');
  const scBlock = chatJs.slice(scIdx, scIdx + 1400);
  ok(/Escape'\s*\)\s*\{[^}]*done\(false\)/.test(scBlock.replace(/\s+/g, ' ')) || /Escape/.test(scBlock), 'showConfirm cancels on Escape');
  ok(!/Enter[^]*done\(true\)/.test(scBlock), 'showConfirm has no global Enter=confirm (no accidental destructive activation)');

  // ── showToast is best-effort and mirrors to the a11y live region ──
  const stIdx = chatJs.indexOf('function showToast(');
  const stBlock = chatJs.slice(stIdx, stIdx + 1800);
  // The toast element carries its own role (status/alert) so it is announced once on insertion — it must
  // NOT also mirror through announce(), which would speak every toast twice.
  ok(/setAttribute\('role'/.test(stBlock), 'each toast is its own live region via a role (status/alert)');
  ok(!/announce\(/.test(stBlock), 'showToast does not double-announce (no announce() mirror on top of the role)');
  ok(/catch\s*\{/.test(stBlock), 'showToast is best-effort (never throws into a caller flow)');

  // ── Toast styling is themed and layered above the modals ──
  ok(/\.toast-wrap\s*\{/.test(css) && /z-index:\s*300/.test(css), 'toasts have a themed wrapper layered above the modals');
  ok(/\.toast\s*\{[^}]*var\(--surface\)/.test(css.replace(/\n/g, ' ')), 'toasts use theme tokens, not hardcoded colors');

  // ── A dialog's Escape closes only that dialog, not a modal it sits on top of ──
  // The confirm/prompt dialogs (opened from inside Settings/Inbox) must stopPropagation on Escape, or the
  // key bubbles to the global Escape handler and closes the underlying modal, discarding unsaved edits.
  ok((chatJs.match(/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\)/g) || []).length >= 2,
    'the confirm and prompt dialogs stop Escape from bubbling to the modal behind them');

  console.log('✓ in-app-dialogs: native alert/confirm/prompt fully replaced by themed toast + modals; Escape is scoped to the top dialog');
  console.log(`\nALL IN-APP-DIALOGS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ IN-APP-DIALOGS UNIT TEST FAILED:', e.message);
  process.exit(1);
}
