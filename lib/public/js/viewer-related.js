// Load documents semantically related to the one being viewed, and surface them
// through a "Related" button in the (sticky, always-visible) toolbar rather than a
// panel buried at the bottom of a long document. The button appears only once the
// fetch resolves; clicking it opens a modal with the list. The docId comes from a
// data attribute the viewer template renders.
// Wire the toolbar Close button here (this script always loads), rather than an inline
// onclick handler, so the page works under a strict Content-Security-Policy that forbids
// inline event handlers.
(function () {
  var closeBtn = document.getElementById('viewer-close-btn');
  // window.close() only works for a script-opened tab; when the viewer was reached by an ordinary
  // navigation (e.g. following a Related link into a standalone tab) it is a no-op, leaving the user
  // stuck. Fall back to going back in history so Close always does something.
  if (closeBtn) closeBtn.addEventListener('click', function () {
    if (window.opener || window.history.length <= 1) { window.close(); }
    else { window.history.back(); }
  });
})();

(function () {
  var overlay = document.getElementById('viewer-related-overlay');
  var btn = document.getElementById('viewer-related-btn');
  if (!overlay || !btn) return;
  var docId = overlay.getAttribute('data-doc-id');
  if (!docId) return;
  // The workspace this viewed document belongs to, so "related" is found within that workspace (not
  // always the active one). Empty → the server falls back to the active workspace.
  var wsId = overlay.getAttribute('data-workspace') || '';

  var list = document.getElementById('viewer-related-list');
  var countEl = document.getElementById('viewer-related-count');
  var emptyEl = document.getElementById('viewer-related-empty');
  var closeBtn = document.getElementById('viewer-related-close');

  // Accessible dialog behavior: move focus into the modal on open, trap Tab within it, close on
  // Escape, and return focus to the opener on close (this page is standalone, so it doesn't share
  // the chat app's modal helper).
  var lastFocused = null;
  function focusables() {
    return Array.prototype.filter.call(
      overlay.querySelectorAll('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; });
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // The page content behind the dialog (toolbar + document). Marking it inert while the dialog is open
  // keeps assistive technology and pointer/Tab focus out of the background, not just the Tab trap — the same
  // treatment the main app's modals get. Everything outside the overlay qualifies.
  function bgRegions() {
    return Array.prototype.filter.call(
      document.querySelectorAll('.viewer-toolbar, .viewer-content, .viewer-cite-note, .viewer-body > iframe'),
      function (el) { return !overlay.contains(el); });
  }
  function setBgInert(on) {
    var els = bgRegions();
    for (var i = 0; i < els.length; i++) { try { els[i].inert = on; } catch (e) { /* unsupported */ } }
  }
  function openModal() {
    lastFocused = document.activeElement;
    overlay.classList.remove('hidden');
    setBgInert(true);
    document.addEventListener('keydown', onKeydown, true);
    try { (closeBtn || focusables()[0] || overlay).focus(); } catch (e) { /* best-effort */ }
  }
  function closeModal() {
    overlay.classList.add('hidden');
    setBgInert(false);
    document.removeEventListener('keydown', onKeydown, true);
    try { if (lastFocused && lastFocused.focus) lastFocused.focus(); } catch (e) { /* best-effort */ }
  }

  btn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

  // Fetch in the background; reveal the button when the fetch resolves.
  fetch('/api/documents/related?docId=' + encodeURIComponent(docId) + '&k=8' + (wsId ? '&workspace=' + encodeURIComponent(wsId) : ''))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.ok) return;
      var related = d.related || [];
      // Reveal the button once results are known, so the feature is discoverable
      // even when empty (the modal then explains there are none).
      btn.style.display = '';
      if (!related.length) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }
      if (countEl) countEl.textContent = '(' + related.length + ')';
      // Preserve embed mode across related-document navigation: in the in-app source overlay the
      // viewer loads with embed=1 (its toolbar hidden). Without carrying it forward, a related link
      // would load the full toolbar inside the iframe, whose Close button calls window.close() and
      // does nothing in an embed. Keeping embed=1 keeps that toolbar hidden and the overlay's own
      // close controls in charge.
      var isEmbed = /[?&]embed=1(?:&|$)/.test(location.search);
      if (!list) return;   // guard the list node like its siblings, so a missing element never throws mid-render
      related.forEach(function (item) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.className = 'viewer-related-link';
        // Carry the workspace so a related document that lives in a non-active workspace resolves
        // against ITS documents dir, not the active one (matching the /related fetch above).
        a.href = '/document/view?path=' + encodeURIComponent(item.source || '')
          + (wsId ? '&workspace=' + encodeURIComponent(wsId) : '')
          + (isEmbed ? '&embed=1' : '');
        a.textContent = item.name || '(untitled)';
        var pct = document.createElement('span');
        pct.className = 'viewer-related-score';
        pct.textContent = Math.round((item.score || 0) * 100) + '% match';
        li.appendChild(a);
        li.appendChild(pct);
        list.appendChild(li);
      });
    })
    .catch(function () { /* silent — related is a nice-to-have */ });
})();
