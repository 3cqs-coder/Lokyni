'use strict';
// Guards the document-panel and mobile-Tools UX pass:
//   • a real, language-agnostic name/folder filter over the already-loaded list;
//   • a document name that opens the in-app viewer instead of silently toggling selection;
//   • a mobile Tools sheet with a title, a close control, a backdrop, and dialog semantics,
//     while the same panel stays a compact popover on desktop;
//   • one server-side viewer-link builder (no route string duplicated in the client or route).
// These are static contracts, so a later edit that drops the filter, re-collapses open-vs-select, or
// leaves a sheet without a way out fails the build. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const chat = read('lib/public/js/chat.js');
  const chatEjs = read('lib/views/chat.ejs');
  const panelEjs = read('lib/views/partials/doc-panel.ejs');
  const css = read('lib/public/css/app.css');
  const docsRoute = read('lib/routes/documents.js');

  // ── 1. A real document filter, not just a status label ──
  ok(/id="doc-search-input"[^>]*type="search"/.test(panelEjs), 'the document panel has a search input');
  ok(/id="doc-search-input"[^>]*aria-label="Filter documents by name or folder"/.test(panelEjs),
    'the filter input has an explicit accessible name (a placeholder alone is not one)');
  ok(/id="doc-search-input"[^>]*aria-controls="doc-list-wrap"/.test(panelEjs),
    'the filter input declares the list it controls');
  ok(/id="doc-search-input"[^>]*dir="auto"/.test(panelEjs), 'the filter input takes the direction of the typed name');
  ok(/id="doc-search-clear"[^>]*aria-label="Clear document filter"/.test(panelEjs),
    'the filter has a named clear control');
  ok(/id="drop-zone"[^>]*aria-labelledby="dz-label dz-sub"/.test(panelEjs) &&
     /id="dz-label"/.test(panelEjs) && /id="dz-sub"/.test(panelEjs),
    'the drop zone is named by its visible label and format hint (no visible-text/name mismatch)');

  // Folding is Unicode-aware and locale-stable: accents, compatibility forms, and case all fold, and
  // scripts without spaces still match as plain substrings.
  ok(/function foldDocText\(text\)/.test(chat) && /\.normalize\('NFKD'\)/.test(chat),
    'the filter folds with NFKD (accents + compatibility forms)');
  ok(/\.replace\(\/\\p\{M\}\/gu, ''\)/.test(chat), 'the filter strips combining marks, so "cafe" matches "café"');
  ok(/\.toLowerCase\(\)/.test(chat) && !/\.toLocaleLowerCase\(\)/.test(chat),
    'the filter lowercases without locale-dependent behavior');
  ok(/function docSearchTokens\(\)[\s\S]{0,200}?split\(' '\)\.filter\(Boolean\)/.test(chat),
    'the query is split on whitespace and empty tokens are dropped');
  ok(/const clipCodePoints = \(text, max\) =>/.test(chat) &&
     /docSearchTokens\(\)[\s\S]{0,180}?clipCodePoints\(docFilterQuery, 256\)/.test(chat),
    'a pasted query is bounded by code points (never split mid-character)');
  ok(/const q = clipCodePoints\(qText, 80\);/.test(chat) &&
     /const qShown = q === qText \? q : `\$\{q\}…`;/.test(chat),
    'the no-match echo is bounded by code points too');
  ok(/tokens\.every\(\(token\) => doc\._searchText\.includes\(token\)\)/.test(chat),
    'every query token must match (AND), by substring (no word-boundary assumption)');
  ok(/doc\._searchText = foldDocText\(`\$\{doc\.name \|\| ''\} \$\{doc\.relPath \|\| ''\}`\)/.test(chat),
    'the filter searches both the file name and its folder path');
  ok(/renderDocList\(\);\s*\/\/ re-render to sync every child checkbox/.test(chat),
    'a folder selection re-renders through the filtered view');

  // Filtering must never unselect a hidden document, and the status must say what is visible.
  ok(/const currentIds = new Set\(all\.map\(d => d\.docId\)\);/.test(chat),
    'selection is pruned against the full list, not the filtered subset');
  ok(/const visible = tokens\.length \? all\.filter\(d => docMatchesFilter\(d, tokens\)\) : all;/.test(chat),
    'the visible list is the full list filtered by the current tokens');
  ok(/label\.textContent = filtering \? `Showing \$\{shown\} of \$\{total\}` : 'All documents';/.test(chat),
    'the status reports "Showing X of Y" while filtering, "All documents" otherwise');
  ok(/btn\.textContent = filtering \? 'Select shown' : 'Select all';/.test(chat),
    'the bulk action says "Select shown" so its scope is explicit under a filter');
  ok(/btn\.disabled = shown === 0;/.test(chat) && /#doc-select-all:disabled \{ opacity: 0\.4; cursor: not-allowed;/.test(css),
    'the bulk action is disabled when nothing is visible to select');
  ok(/No documents match “\$\{qShown\}”\./.test(chat), 'a non-matching filter has a clear, query-naming empty state');
  ok(/role="status" aria-live="polite">No documents loaded/.test(panelEjs),
    'the list empty state is a polite live region');
  ok(/id="doc-list-empty"[^>]*dir="auto"/.test(panelEjs), 'the empty state takes the direction of its text');
  ok(/function resetDocFilter\(\)/.test(chat) && /function refreshWorkspaceScopedPanel\(\) \{[\s\S]{0,500}?resetDocFilter\(\);/.test(chat),
    'a workspace switch clears the filter (the new corpus is never hidden by an old query)');
  ok(/docSearchInput\.addEventListener\('keydown'[\s\S]{0,220}?clearDocFilter\(\{ focus: true \}\)/.test(chat),
    'Escape in the filter clears it rather than closing the whole drawer');
  ok(/e\.target\.id === 'doc-search-input' && \(docFilterQuery \|\| e\.target\.value\)/.test(chat),
    'the mobile drawer defers Escape to the filter while a query is present');

  // ── 2. Open vs. select are separate actions ──
  ok(/class="di-name di-open" href="\$\{escapeHtml\(viewerHref\)\}"/.test(chat),
    'the document name is a real link with an escaped viewer href');
  ok(/aria-label="Open \$\{nameAttr\}"/.test(chat), 'the name link names the document it opens');
  ok(/doc\.viewerLink \? `\$\{doc\.viewerLink\}\$\{wsQuery\('&'\)\}` : ''/.test(chat),
    'the viewer link carries the window workspace, like citation links');
  ok(/openSourceViewer\(\{ source: doc\.name, viewerLink: openLink\.getAttribute\('href'\) \|\| '' \}\)/.test(chat),
    'a name click opens the shared in-app viewer');
  ok(/e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/.test(chat),
    'modified/middle clicks remain normal new-tab link behavior');
  ok(/e\.target\.closest && e\.target\.closest\('\.di-del, \.di-summarize, \.di-open, \.di-check'\)/.test(chat),
    'the row-selection click ignores the name, checkbox, summarize, and delete controls');
  ok(/<input type="checkbox" class="di-check" aria-label="Focus on \$\{nameAttr\}"/.test(chat),
    'selection keeps its own named checkbox');
  ok(/\.doc-item \.di-name\.di-open:hover/.test(css) && /\.doc-item \.di-name\.di-open:focus-visible/.test(css),
    'the name link has hover and keyboard-focus affordances');

  // The viewer route is built once on the server via the shared links module.
  ok(/const \{ viewerLink \} = require\('\.\.\/links'\);/.test(docsRoute),
    'the documents route imports the shared viewer-link builder');
  ok(/viewerLink: viewerLink\(filePath\)/.test(docsRoute),
    'the documents response carries the shared viewer link for each document');
  ok(!/\/document\/view\?path=/.test(docsRoute), 'the documents route does not hand-build the viewer path');
  ok(!/\/document\/view\?path=/.test(chat), 'the chat client does not hand-build the viewer path');

  // ── 3. Mobile Tools sheet ──
  ok(/id="tools-sheet-title">Answer options</.test(chatEjs), 'the Tools sheet has a visible title');
  ok(/id="tools-sheet-close"[^>]*aria-label="Close answer options"/.test(chatEjs),
    'the Tools sheet has a named close control');
  ok(/id="sheet-backdrop" class="sheet-backdrop" hidden aria-hidden="true"/.test(chatEjs),
    'a hidden backdrop exists for the sheet');
  ok(/wirePopover\(document\.getElementById\('tools-btn'\), document\.getElementById\('tools-menu'\), \{[\s\S]{0,200}?sheet: true,[\s\S]{0,120}?sheetTitleId: 'tools-sheet-title',[\s\S]{0,120}?sheetCloseId: 'tools-sheet-close'/.test(chat),
    'the Tools panel opts into the sheet presentation with its title and close ids');

  // Dialog semantics are applied only while the sheet presentation is active, then restored.
  ok(/panel\.setAttribute\('role', 'dialog'\)/.test(chat) &&
     /panel\.setAttribute\('aria-modal', 'true'\)/.test(chat) &&
     /panel\.setAttribute\('aria-labelledby', opts\.sheetTitleId\)/.test(chat),
    'the open mobile sheet is a labelled modal dialog');
  ok(/btn\.setAttribute\('aria-haspopup', 'dialog'\)/.test(chat) &&
     /btn\.removeAttribute\('aria-haspopup'\)/.test(chat),
    'the trigger advertises a dialog only while the sheet presentation is active');
  ok(/if \(baseRole\) panel\.setAttribute\('role', baseRole\); else panel\.removeAttribute\('role'\)/.test(chat) &&
     /if \(baseLabel\) panel\.setAttribute\('aria-label', baseLabel\); else panel\.removeAttribute\('aria-label'\)/.test(chat),
    'closing or widening restores the original group semantics');
  ok(/if \(backdrop\) backdrop\.hidden = false;/.test(chat) && /if \(backdrop\) backdrop\.hidden = true;/.test(chat),
    'the backdrop appears and disappears with the sheet');
  ok(/e\.key === 'Tab' && isSheet\(\)[\s\S]{0,350}?e\.preventDefault\(\); last\.focus\(\)[\s\S]{0,120}?e\.preventDefault\(\); first\.focus\(\)/.test(chat),
    'Tab is trapped inside the modal sheet (both directions)');
  ok(/else if \(wasSheet\) \{ try \{ btn\.focus\(\); \}/.test(chat),
    'dismissing the sheet returns focus to the Tools button');
  ok(/sheetMq\.addEventListener\('change', onChange\)|sheetMq\.addListener\(onChange\)/.test(chat),
    'crossing the breakpoint while open reconciles the sheet state');
  ok(/closeBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); api\.close\(\); \}\)/.test(chat),
    'the sheet close control dismisses it');

  // Styling: the header is desktop-hidden, the sheet/backdrop are mobile-only, and the backdrop sits below.
  ok(/\.sheet-head \{ display: none; \}/.test(css), 'the sheet header is hidden on desktop');
  ok(/\.sheet-backdrop \{ position: fixed; inset: 0; background: var\(--scrim\); z-index: 79; \}/.test(css),
    'the backdrop covers the page below the sheet');
  ok(/@media \(min-width: 641px\) \{ \.sheet-backdrop \{ display: none; \} \}/.test(css),
    'the backdrop can never appear on a wide viewport');
  const mobile = css.slice(css.indexOf('@media (max-width: 640px)'));
  ok(/\.tools-menu \.sheet-head \{[\s\S]{0,260}?display: flex;[\s\S]{0,260}?position: sticky;/.test(mobile),
    'the Tools header appears as a sticky title row in the mobile sheet');
  ok(/\.sheet-close \{[\s\S]{0,200}?width: 34px; height: 34px;/.test(mobile),
    'the close control is a comfortable touch target');
  ok(/\.sheet-close:focus-visible/.test(mobile), 'the close control has a visible keyboard focus ring');
  ok(/\.tools-menu \{ overscroll-behavior: contain; \}/.test(mobile),
    'scrolling the sheet does not chain to the page behind it');

  // The sheet must not regress the desktop contract: the markup stays a group of checkboxes.
  ok(/id="tools-menu"[^>]*role="group"/.test(chatEjs), 'the Tools panel is still a role=group in the markup');

  console.log(`\nALL DOCUMENT-PANEL / MOBILE-SHEET UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCUMENT-PANEL / MOBILE-SHEET UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
