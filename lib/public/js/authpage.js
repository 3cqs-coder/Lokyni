'use strict';
// Shared helpers for the small standalone auth pages (the account page and the admin users page). They are
// cookie-authenticated like the main app but deliberately do NOT load the chat bundle, so they each carried
// their own copy of the CSRF token, the request-header builder, and an HTML-escaper. Those identical copies
// are centralized here so a fix (say to the escaper) can't land in one page and be missed in the other.
(function () {
  var csrf = '';
  var _confirmSeq = 0;   // unique-id counter for a dialog's aria-labelledby/aria-describedby wiring

  // HTML-escape for safe interpolation into innerHTML. Escapes the single quote too, so this stays at
  // parity with chat.js's escapeHtml and is safe in single-quoted attributes as well as double-quoted
  // ones — the whole point of centralizing it here was to keep the two pages' escaper from diverging.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Headers for an authenticated request: the CSRF token always, plus a JSON content-type when sending a body.
  function hdrs(json) {
    var h = { accept: 'application/json', 'x-csrf-token': csrf };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  // Fetch the current session (/auth/me), stash its CSRF token for hdrs(), and hand the session to onReady.
  // Returns the promise so a caller can chain. onFail (optional) runs if the probe itself fails.
  function me(onReady, onFail) {
    return fetch('/auth/me', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (s) { csrf = (s && s.csrfToken) || ''; if (onReady) onReady(s || {}); return s; })
      .catch(function (e) { if (onFail) onFail(e); });
  }

  // Themed confirmation dialog — a Promise<boolean> replacement for the native window.confirm(), which is
  // unstyled and unreliable in the desktop webview (it can be suppressed entirely, letting a destructive
  // action run with no prompt at all). The markup mirrors the main app's showConfirm (del-confirm /
  // msg-modal), so app.css — already loaded by both auth pages — styles it identically with no new CSS.
  // Resolves true on confirm; false on cancel, click-outside, or Escape. Centralized here so every
  // destructive action on the account and admin pages gates through one accessible, theme-correct dialog.
  function confirmDialog(opts) {
    opts = opts || {};
    var title = opts.title || 'Are you sure?';
    var message = opts.message || '';
    var okLabel = opts.okLabel || 'OK';
    var cancelLabel = opts.cancelLabel || 'Cancel';
    var danger = !!opts.danger;
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var uid = 'ap-confirm-' + (++_confirmSeq);
      var titleId = uid + '-t';
      var msgId = uid + '-m';
      var overlay = document.createElement('div');
      overlay.className = 'del-confirm';
      // aria-labelledby/aria-describedby name the dialog for screen readers (parity with the chat app's
      // enhanceConfirmDialog, which this page cannot load).
      overlay.innerHTML =
        '<div class="del-confirm-box msg-modal" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '"' + (message ? ' aria-describedby="' + msgId + '"' : '') + '>' +
          '<h3 id="' + titleId + '">' + esc(title) + '</h3>' +
          (message ? '<p id="' + msgId + '">' + esc(message) + '</p>' : '') +
          '<div class="del-confirm-btns">' +
            '<button type="button" class="del-btn-cancel">' + esc(cancelLabel) + '</button>' +
            '<button type="button" class="confirm-ok ' + (danger ? 'del-btn-ok' : 'del-btn-primary') + '">' + esc(okLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var cancelBtn = overlay.querySelector('.del-btn-cancel');
      var okBtn = overlay.querySelector('.confirm-ok');
      var settled = false;
      function done(val) {
        if (settled) return; settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* focus restore is best-effort */ }
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
        // Trap Tab within the dialog's two buttons so keyboard focus can't walk onto the dimmed page behind
        // it (the chat app gets this from enhanceConfirmDialog; the standalone pages need it here).
        if (e.key === 'Tab') {
          var order = [cancelBtn, okBtn];
          var i = order.indexOf(document.activeElement);
          e.preventDefault();
          var next = e.shiftKey ? (i <= 0 ? order.length - 1 : i - 1) : (i === order.length - 1 ? 0 : i + 1);
          try { order[next].focus(); } catch (ignore) { /* best-effort */ }
        }
      }
      cancelBtn.addEventListener('click', function () { done(false); });
      okBtn.addEventListener('click', function () { done(true); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) done(false); });   // click-outside cancels
      document.addEventListener('keydown', onKey, true);
      // Focus the CANCEL button by default: a destructive action should never be one stray Enter away.
      try { cancelBtn.focus(); } catch (e) { /* best-effort */ }
    });
  }

  window.AuthPage = { esc: esc, hdrs: hdrs, me: me, token: function () { return csrf; }, confirm: confirmDialog };
})();
