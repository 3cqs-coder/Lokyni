'use strict';
// Guards that destructive / redo-a-lot-of-work UI actions confirm before acting, through the shared themed
// confirm — never the native window.confirm() (unstyled, and suppressible in the desktop webview, which would
// let a destructive action run with NO prompt). These behaviors are DOM/socket-coupled, so — like
// frontend-reliability-guards.test.js — this source-guards the shipped client code so a later edit that drops
// a confirmation is caught by `npm run test:unit`. Each check below closes a concrete "one click destroys
// state the user must tediously rebuild" gap.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chat = read('lib', 'public', 'js', 'chat.js');
  const authpage = read('lib', 'public', 'js', 'authpage.js');
  const account = read('lib', 'views', 'account.ejs');
  const admin = read('lib', 'views', 'admin-users.ejs');

  // ── chat.js (main app, uses showConfirm) ──
  // Removing an evaluation question confirms before the DELETE — the explicit request that drove this work.
  ok(/showConfirm\(\{ title: 'Remove question\?'[\s\S]{0,180}?\}\)\)\) return;\s*\n\s*try \{ await fetch\(`\/api\/eval\//.test(chat),
    'removing an evaluation question confirms before DELETE /api/eval');
  // Clearing the per-workspace persona confirms (one click otherwise wipes the saved instruction).
  ok(/personaClear\.addEventListener\('click', async[\s\S]{0,400}?showConfirm\(\{ title: 'Clear workspace persona\?'/.test(chat),
    'clearing the workspace persona confirms (only when a persona is actually set)');

  // Deleting a document confirms AND the note accurately states the stored copy is deleted from disk — the
  // old "your original file on disk is not affected" wording was wrong (the server unlinks the copy) and left
  // people thinking deleted documents kept cluttering their disk.
  ok(/<h3>Delete this document\?<\/h3>/.test(chat), 'the document-delete dialog confirms before deleting');
  ok(/deletes Lokyni's stored copy from disk/.test(chat),
    'the document-delete note states the stored copy is deleted from disk (no clutter left behind)');
  ok(!/Your original file on disk is not affected\./.test(chat),
    'the misleading "file on disk is not affected" wording is gone');

  // ── authpage.js: the shared themed confirm the standalone pages reuse ──
  ok(/function confirmDialog\(opts\)/.test(authpage) && /return new Promise\(function \(resolve\)/.test(authpage),
    'authpage.js defines a Promise-based themed confirm (confirmDialog)');
  ok(/window\.AuthPage = \{[\s\S]*?confirm: confirmDialog\s*\};/.test(authpage),
    'confirmDialog is exported as AuthPage.confirm');
  ok(/overlay\.className = 'del-confirm';/.test(authpage) && /del-confirm-box msg-modal/.test(authpage),
    'the shared confirm reuses the app.css del-confirm/msg-modal markup (no new CSS, theme-correct)');
  // Escape and click-outside cancel, and focus defaults to Cancel so a destructive action is never one Enter away.
  ok(/e\.key === 'Escape'[\s\S]{0,60}?done\(false\)/.test(authpage) && /if \(e\.target === overlay\) done\(false\)/.test(authpage),
    'the shared confirm cancels on Escape and click-outside');
  ok(/cancelBtn\.focus\(\)/.test(authpage),
    'the shared confirm focuses Cancel by default (destructive action is not one stray Enter away)');
  // The dialog names itself for screen readers and traps Tab so focus can't walk onto the dimmed page.
  ok(/aria-labelledby="' \+ titleId \+ '"/.test(authpage) && /aria-describedby="' \+ msgId \+ '"/.test(authpage),
    'the shared confirm wires aria-labelledby/aria-describedby to its title/message');
  ok(/if \(e\.key === 'Tab'\)/.test(authpage) && /e\.preventDefault\(\);\s*\n\s*var next = e\.shiftKey/.test(authpage),
    'the shared confirm traps Tab focus within the dialog');

  // ── Native confirm() must not survive on the standalone pages ──
  ok(!/[^.]\bconfirm\(/.test(account.replace(/AuthPage\.confirm\(/g, 'AuthPage_CONFIRM(')),
    'account.ejs uses no native window.confirm() (all gates route through AuthPage.confirm)');
  ok(!/[^.]\bconfirm\(/.test(admin.replace(/AuthPage\.confirm\(/g, 'AuthPage_CONFIRM(')),
    'admin-users.ejs uses no native window.confirm() (all gates route through AuthPage.confirm)');

  // ── account.ejs: "sign out everywhere else" confirms (every other device must re-login) ──
  ok(/revoke-btn'\)\.addEventListener\('click', function[\s\S]{0,200}?AuthPage\.confirm\(\{ title: 'Sign out everywhere else\?'/.test(account),
    'account.ejs confirms before signing out all other sessions');

  // ── admin-users.ejs: delete user, demote/disable, remove member all confirm ──
  ok(/AuthPage\.confirm\(\{ title: 'Delete user "/.test(admin),
    'admin-users.ejs confirms before deleting a user (removes access, sessions, API keys)');
  ok(/var gate = warn \? AuthPage\.confirm\(\{ title: warn, okLabel: 'Yes', danger: true \}\) : Promise\.resolve\(true\);/.test(admin),
    'admin-users.ejs confirms demoting an admin / disabling an account, and reverts the picker on cancel');
  ok(/data-rm[\s\S]{0,260}?AuthPage\.confirm\(\{ title: 'Remove this member\?'/.test(admin),
    'admin-users.ejs confirms before removing a workspace member');

  console.log(`\nALL DESTRUCTIVE-CONFIRMATION TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DESTRUCTIVE-CONFIRMATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
