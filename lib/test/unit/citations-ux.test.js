'use strict';
// Guards the citation-experience features: the cited-passage snippet on each source, the
// "answered from N sources" strip above each answer, the hover/focus citation preview card, and the
// empty-state starter prompts. These make every answer traceable to the exact passage and help a
// first-time user start. The server must attach the snippet (and persist it), and the client markup,
// wiring, and styling must stay in sync — a regression then fails the build rather than silently
// dropping the preview. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // ── Server: the cited-passage snippet is attached and persisted via ONE shared helper ──
  // The cap and normalization live only in lib/snippet.js, so they cannot drift between the paths
  // that produce a snippet and the store that re-caps it. Every site must call makeSnippet, and none
  // may re-inline the old `.replace(/\s+/g,' ').slice(0, 320)` pattern.
  const search = read('lib/retrieval/search.js');
  const deep = read('lib/retrieval/deepresearch.js');
  const sessions = read('lib/sessions.js');
  ok((search.match(/snippet:\s*makeSnippet\(/g) || []).length >= 2, 'search.js builds the snippet via makeSnippet on the main and partial paths');
  ok(/snippet:\s*makeSnippet\(p\.content\)/.test(deep), 'deep research builds the snippet via makeSnippet');
  ok(/if \(s\.snippet\) out\.snippet = makeSnippet\(/.test(sessions), 'sessions persist the snippet via makeSnippet');
  for (const [name, src] of [['search.js', search], ['deepresearch.js', deep], ['sessions.js', sessions]]) {
    ok(/require\(['"][^'"]*snippet['"]\)/.test(src), `${name} imports the shared snippet helper`);
    ok(!/snippet[^\n]*replace\(\/\\s\+\/g/.test(src), `${name} does not re-inline the snippet pattern (no drift)`);
  }

  // ── Client: the reusable pieces exist and are wired ──
  const chatJs = read('lib/public/js/chat.js');
  ok(/function srcHref\(/.test(chatJs), 'the shared source-href helper exists (reused by every pill)');
  ok(/function attachSourcePreview\(/.test(chatJs) && /function showSourcePreview\(/.test(chatJs), 'the citation preview card is implemented');
  ok(/function positionSourcePreview\(/.test(chatJs) && /getBoundingClientRect\(/.test(chatJs), 'the preview positions itself relative to the viewport (cross-browser geometry)');
  // ONE source presentation: the numbered pills below the answer. The old duplicate "Answered from"
  // strip (and its chips) is gone, so sources are rendered and maintained in one place.
  ok(!/function renderAnsweredFrom\(/.test(chatJs), 'the duplicate "answered from" strip is removed');
  ok(/sources-label[\s\S]{0,160}?Sources \(\$\{total\}\)/.test(chatJs), 'the single source row labels itself with its count');
  ok(/sources-sub/.test(chatJs) && /\$\{independent\} independent/.test(chatJs),
    'the row adds the server-computed independent-source count when sources overlap');
  ok((chatJs.match(/attachSourcePreview\(/g) || []).length >= 3, 'the preview is attached to every cited pill');
  // Dismissal on Escape / scroll / resize so the card never floats detached from its citation.
  ok(/if \(e\.key === 'Escape'\) hideSourcePreview\(\)/.test(chatJs), 'Escape dismisses the preview');
  ok(/addEventListener\('scroll'[\s\S]*hidden/.test(chatJs), 'scrolling dismisses the preview');
  // Starter prompts fill the composer (they must not auto-send).
  const starterIdx = chatJs.indexOf("getElementById('starter-pills')");
  ok(starterIdx !== -1, 'the starter prompts are wired');
  const starterBody = chatJs.slice(starterIdx, starterIdx + 320);   // just this handler, not the whole file
  ok(/msgInput\.value =/.test(starterBody), 'a starter prompt fills the composer');
  ok(!/sendMessage\(/.test(starterBody), 'a starter prompt does not auto-send');

  // ── Hardening from the audit ──
  // Failure isolation: a citation-render error must never escape and leave the composer disabled.
  ok(/function appendSources\(sources, stats\) \{[\s\S]*?try \{[\s\S]*?\} catch \(e\) \{[^}]*\}\s*\}/.test(chatJs), 'appendSources contains its own try/catch (finalization is never broken by a render error)');
  // The confidence CSS class is a whitelist lookup, never raw interpolation (no attribute injection).
  ok(/const confClass =/.test(chatJs), 'a whitelisted confClass helper exists');
  ok(!/conf-\$\{src\.confidence\}/.test(chatJs), 'the confidence class is never built by raw interpolation');
  // The URL scheme guard rejects protocol-relative "//host".
  ok(/\\\/\(\?!\\\/\)/.test(chatJs), 'SAFE_URL_SCHEME rejects protocol-relative URLs');
  // The preview confidence badge uses a colored dot (::before), not small text on a saturated fill.
  ok(/\.src-preview-conf::before/.test(read('lib/public/css/app.css')), 'the confidence badge uses a colored dot (AA-safe in every theme)');
  // The menus cap their height and scroll, so rows never clip on a short viewport.
  ok(/\.tools-menu \{[\s\S]*?overflow-y: auto/.test(read('lib/public/css/app.css')), 'the Tools menu scrolls instead of clipping');

  // ── Markup ──
  const chatEjs = read('lib/views/chat.ejs');
  ok(/id="starter-pills"/.test(chatEjs), 'the empty state has the starter-prompts container');
  ok((chatEjs.match(/class="starter-pill"[^>]*data-q=/g) || []).length >= 3, 'there are at least three starter prompts with fill text');

  // ── Styling ──
  const css = read('lib/public/css/app.css');
  for (const sel of ['.src-preview', '.sources-row', '.source-pill', '.starter-pills', '.starter-pill']) {
    ok(css.includes(sel), `app.css styles ${sel}`);
  }
  // The empty state disables pointer events, so the pills must re-enable them or they can't be clicked.
  ok(/\.starter-pills \{[^}]*pointer-events: auto/.test(css), 'the starter pills re-enable pointer events');

  // ── Accessibility (audit pass 18) ──
  // The source pills keep the global focus ring on keyboard focus (WCAG 2.4.11); no rule suppresses it.
  ok(!/\.source-pill[^}]*outline:\s*none/.test(css), 'the source-pill keyboard focus ring is not suppressed');

  // Every modal close button has an accessible name, not just the raw ✕ glyph.
  for (const id of ['logs-close', 'inbox-close', 'why-close', 'picker-close', 'help-close', 'source-close']) {
    const re = new RegExp(`id="${id}"[^>]*aria-label="Close"`);
    ok(re.test(chatEjs), `the ${id} button has aria-label="Close"`);
  }

  // The two title-only selects also carry an aria-label (a name sighted keyboard users see on focus).
  ok(/id="workspace-select"[^>]*aria-label=/.test(read('lib/views/partials/header.ejs')),
    'the workspace select has an aria-label');
  ok(/id="synthesize-format"[^>]*aria-label=/.test(read('lib/views/partials/doc-panel.ejs')),
    'the synthesize-format select has an aria-label');

  // ── Accessibility / mobile (audit pass 19) ──
  // The four placeholder-only text inputs carry an aria-label (a placeholder is not an accessible name).
  for (const id of ['apikey-name', 'connector-name', 'template-name', 'automation-name']) {
    ok(new RegExp(`id="${id}"[^>]*aria-label=`).test(chatEjs), `the ${id} input has an aria-label`);
  }
  // A wide markdown table scrolls within the bubble instead of pushing the page into horizontal scroll.
  ok(/\.bot \.bubble table \{[^}]*overflow-x: auto/.test(css), 'bot-bubble tables get a horizontal scroll container');
  // The rating buttons and doc "select all" reach the 24px minimum tap size on ANY touch device (the
  // tap-target SIZE rules live in the pointer:coarse block, so a touch tablet wider than 640px gets
  // them too — not only phones). The max-width:640px block holds phone LAYOUT only.
  const coarseStart = css.indexOf('@media (pointer: coarse)');
  // The next @media AFTER the coarse block is the main mobile layout block (there is an earlier
  // max-width:640px rule for toasts, so search forward from the coarse block, not from the top).
  const coarseBlock = css.slice(coarseStart, css.indexOf('@media (max-width: 640px)', coarseStart));
  ok(/\.rate-btn[^{]*\{[^}]*min-height: 24px/.test(coarseBlock), 'the rating buttons hit 24px on touch (coarse pointer)');
  ok(/#doc-select-all \{[^}]*min-height: 24px/.test(coarseBlock), 'the doc select-all toggle hits 24px on touch (coarse pointer)');
  ok(/\.logs-tab, \.logs-refresh \{[^}]*min-height: 24px/.test(coarseBlock), 'the logs tabs/buttons hit 24px on touch (coarse pointer)');
  // The cited-passage scroll honors prefers-reduced-motion (the CSS override cannot reach the JS option).
  const vhSrc = read('lib/public/js/viewer-highlight.js');
  ok(/prefers-reduced-motion: reduce/.test(vhSrc) && /behavior: reduce \? 'auto' : 'smooth'/.test(vhSrc),
    'the cited-passage scroll respects reduced motion');

  // The in-app document viewer renders each paragraph in its own base direction, so an RTL-language
  // source file (Arabic, Hebrew) reads correctly instead of forced left-aligned LTR.
  ok(/\.viewer-body pre \{[^}]*unicode-bidi: plaintext/.test(css), 'the viewer <pre> uses unicode-bidi: plaintext (RTL-safe)');
  ok(/\.markdown \{[^}]*unicode-bidi: plaintext/.test(css), 'the viewer .markdown container uses unicode-bidi: plaintext (RTL-safe)');

  // Prose links are underlined at rest (not only on hover): accent vs body text is under 3:1 in every
  // theme, so color alone can't identify a link (WCAG 1.4.1). Covers answer bubbles and the Markdown
  // Guide/document viewer.
  ok(/\.bot \.bubble a \{[^}]*text-decoration: underline/.test(css), 'answer-bubble links are underlined at rest');
  ok(/\.markdown a[^{]*\{[^}]*text-decoration: underline/.test(css), 'Markdown (Guide/viewer) links are underlined at rest');

  // Editable fields stay >=16px on any touch device (not just <=640px), so iOS Safari never zooms the
  // viewport on focus — including a large phone in landscape, which is wider than the mobile breakpoint.
  ok(/@media \(pointer: coarse\) \{[\s\S]*?#message-input[\s\S]*?font-size: 16px/.test(css),
    'a pointer:coarse rule keeps inputs at 16px on touch devices of any width');
  // The Guide search field is covered too (it lives in the help modal, not settings/doc-panel).
  ok(/@media \(pointer: coarse\) \{[\s\S]*?\.help-search input[\s\S]*?font-size: 16px/.test(css),
    'the Guide search input is included in the 16px touch rule');
  // The document/folder checkboxes reach 24px on ANY touch device, not only phones ≤640px — the folder
  // select-all (.df-check) is the only way to select a whole folder and has no larger-target fallback,
  // so a touch tablet in landscape (coarse pointer, width > 640px) must still get a 24px target.
  ok(/@media \(pointer: coarse\) \{[\s\S]*?\.doc-item \.di-check, \.doc-folder \.df-check \{[^}]*width: 24px; height: 24px/.test(css),
    'a pointer:coarse rule sizes the doc/folder checkboxes to 24px on touch devices of any width');
  // Citation chips (the main way to open a cited source) reach the 24px minimum tap size on touch.
  ok(/@media \(pointer: coarse\) \{[\s\S]*?\.source-pill \{[^}]*min-height: 24px/.test(css),
    'a pointer:coarse rule gives the citation pills a 24px minimum tap target');

  // ── a modal inerts the page background (AT + focus can't reach content behind the dialog) ──
  // The Tab trap only keeps keyboard focus in; `inert` also removes the background from the a11y tree and
  // blocks pointer/focus. A depth counter handles nested dialogs (a confirm opened from inside Settings).
  ok(/function modalInertPush\(\)[\s\S]*?\+\+_modalInertDepth !== 1\) return;[\s\S]*?el\.inert = true/.test(chatJs),
    'modalInertPush inerts the background only on the first (outermost) open');
  ok(/function modalInertPop\(\)[\s\S]*?--_modalInertDepth !== 0\) return;[\s\S]*?el\.inert = false/.test(chatJs),
    'modalInertPop clears inert only when the last dialog closes');
  ok(/\['header', 'main'\]\.map\(/.test(chatJs),
    'only the background regions (#header, #main) are inerted — never a modal ancestor');
  // Both the static-overlay choke point and the dynamic confirm/prompt dialogs balance push/pop.
  ok(/stack\.push\(\{ overlay[\s\S]{0,120}?modalInertPush\(\)/.test(chatJs) && /modalInertPop\(\);[\s\S]{0,120}?removeEventListener\('keydown', onKeydown/.test(chatJs),
    'the static overlay stack pushes and pops the background inert state');
  ok(/modalInertPush\(\);\s*\/\/ inert the background while this dialog is up/.test(chatJs) && /mo\.disconnect\(\);[\s\S]{0,120}?modalInertPop\(\)/.test(chatJs),
    'dynamic confirm/prompt dialogs push inert on open and pop it when removed');

  // ── the Logs view switcher is a proper ARIA tablist (grouped, roving, named panel) ──
  ok(/<div class="logs-tablist" role="tablist" aria-label="Log view">/.test(chatEjs),
    'the three log tabs are grouped in a role="tablist" (not mixed with the other controls)');
  ok(/id="logs-tab-stdout"[^>]*role="tab"[^>]*tabindex="0"/.test(chatEjs) &&
     /id="logs-tab-stderr"[^>]*role="tab"[^>]*tabindex="-1"/.test(chatEjs),
    'the tabs start with roving tabindex (only the selected tab is in the Tab order)');
  ok(/<pre id="logs-body"[^>]*role="tabpanel"[^>]*aria-labelledby="logs-tab-stdout"/.test(chatEjs),
    'the log panel is named by the active tab (aria-labelledby)');
  // setLogStream maintains the roving tabindex and repoints the panel's name at the active tab.
  ok(/el\.tabIndex = on \? 0 : -1;/.test(chatJs),
    'setLogStream keeps the roving tabindex in sync with the selected tab');
  ok(/logsBody\.setAttribute\('aria-labelledby', activeTab\.id\)/.test(chatJs),
    'setLogStream repoints the panel aria-labelledby at the active tab');
  // Arrow/Home/End keys move across the tablist (the ARIA tablist keyboard pattern).
  ok(/wireLogsTablistKeys/.test(chatJs) && /ArrowRight' \|\| e\.key === 'ArrowDown'/.test(chatJs) && /e\.key === 'Home'/.test(chatJs),
    'the log tablist supports arrow-key and Home/End navigation');

  // The document-tree folder header uses a real <button> twisty (not a role="button" row that
  // contains a focusable checkbox), satisfying ARIA 4.1.2. Its select-all checkbox is a sibling.
  ok(/<button type="button" class="df-twisty" aria-label="Toggle folder: \$\{labelAttr\}" aria-expanded=/.test(chatJs),
    'the folder twisty is a real button whose accessible name includes the folder label');
  ok(/<input type="checkbox" class="df-check" aria-label="Select all documents in \$\{labelAttr\}"/.test(chatJs),
    'the folder select-all checkbox has an accessible name that names the folder');
  const folderFn = chatJs.slice(chatJs.indexOf("className = 'doc-folder'"), chatJs.indexOf("className = 'doc-folder'") + 1400);
  ok(!/setAttribute\('role', 'button'\)/.test(folderFn), 'the folder header row is not a role="button" wrapping a focusable checkbox');
  // Selecting a whole folder re-renders the tree; focus must be restored to the equivalent checkbox so a
  // keyboard/AT user isn't dropped to <body> (WCAG 2.4.3).
  ok(/header\.dataset\.folderPath = folder\.path;/.test(chatJs), 'the folder header records its path for focus restore');
  ok(/\.doc-folder\[data-folder-path="\$\{CSS\.escape\(fp\)\}"\] \.df-check/.test(chatJs) && /if \(again\) again\.focus\(\)/.test(chatJs),
    'the folder select-all restores focus to the equivalent checkbox after the re-render');

  // ── Per-document row controls name their document (pass 27, WCAG 2.4.6 / 4.1.2) ──
  // Without the name folded into each control's accessible name, a screen-reader user tabbing the
  // document tree hears the same generic label on every row and cannot tell which file each control
  // acts on — the delete case being the most dangerous. Mirrors the folder-control treatment. The
  // name is user-controlled, so it must stay escaped (via the shared nameAttr).
  ok(/<input type="checkbox" class="di-check" aria-label="Focus on \$\{nameAttr\}"/.test(chatJs),
    'the per-document focus checkbox names its document');
  ok(/<button class="di-summarize" aria-label="Summarize \$\{nameAttr\}"/.test(chatJs),
    'the per-document summarize button names its document');
  ok(/<button class="di-del" aria-label="Remove \$\{nameAttr\} from Lokyni"/.test(chatJs),
    'the per-document remove button names its document and says it removes from Lokyni (not the real file)');
  ok(/const nameAttr = escapeHtml\(doc\.name\);/.test(chatJs),
    'the document name in those accessible names is HTML-escaped (user-controlled)');

  // ── Bulk select/clear resyncs the folder-header checkboxes (pass 27) ──
  // The per-document change handler calls syncFolderChecks(); the bulk Select-all/Clear path must too,
  // or the folder rows keep a stale checked/indeterminate state until the next full render.
  const selAllIdx = chatJs.indexOf('docSelectAll.addEventListener');
  const selAllBody = chatJs.slice(selAllIdx, chatJs.indexOf('updateFilterBar();', selAllIdx) + 20);
  ok(selAllIdx !== -1 && /syncFolderChecks\(\);\s*\n\s*updateFilterBar\(\);/.test(selAllBody),
    'the bulk select-all/clear handler resyncs the folder checkboxes before updating the filter bar');

  // ── Attachment chip: a long unbroken filename truncates so the remove button stays reachable (pass 32) ──
  // The filename is wrapped in its own capped span (every other user-content chip truncates); a bare
  // filename made a single chip overflow the row and clipped the ✕ off-screen, stranding the attachment.
  ok(/<span class="attach-chip"><svg class="ico" aria-hidden="true"><use href="#ic-attach"\/><\/svg> <span class="attach-name">\$\{escapeHtml\(a\.name\)\}<\/span><button data-i="\$\{i\}" title="Remove" aria-label="Remove \$\{escapeHtml\(a\.name\)\}">/.test(chatJs),
    'the attachment chip shows the attach icon and wraps the filename in a capped span, its remove button naming the file');
  ok(/\.attach-chip \.attach-name \{[^}]*text-overflow: ellipsis[^}]*\}/.test(css) && /\.attach-chip button \{[^}]*flex-shrink: 0/.test(css),
    'the attachment name truncates and the remove button never shrinks away');

  // ── The Verify (faithfulness) badge is an accessible disclosure (pass 32, WCAG 4.1.2) ──
  ok(/badge\.setAttribute\('aria-controls', panelId\)/.test(chatJs) && /badge\.setAttribute\('aria-expanded', 'false'\)/.test(chatJs),
    'the Verify badge links to its panel and starts collapsed');
  ok(/badge\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/.test(chatJs),
    'the Verify badge keeps aria-expanded in sync with the panel');

  // ── Long-running synthesis progress is announced to screen readers (pass 32) ──
  // setThinkingStatus must drop the static aria-label so the role="status" live region announces the
  // changing per-document progress instead of staying pinned to "Generating an answer".
  ok(/function setThinkingStatus\(text\) \{[\s\S]*?bubble\.removeAttribute\('aria-label'\);[\s\S]*?bubble\.textContent = text;/.test(chatJs),
    'setThinkingStatus removes the static aria-label so progress updates are announced');

  // ── Audit pass: remaining a11y gaps closed ──
  // The two Automations inputs that sit outside a .settings-row (so associateSettingsLabels can't reach
  // them) carry their own aria-label, matching the sibling #automation-name.
  ok(/id="automation-query"[^>]*aria-label="Question to ask"/.test(chatEjs),
    'the automation question field has an accessible name');
  ok(/id="automation-schedule-custom"[^>]*aria-label="Custom cron schedule"/.test(chatEjs),
    'the automation custom-cron field has an accessible name');
  // Decorative leading glyphs in dialog titles are hidden from the accessible name.
  ok(/id="settings-title"><svg class="ico" aria-hidden="true"><use href="#ic-settings"\/><\/svg> Settings/.test(chatEjs),
    'the Settings dialog title hides its decorative icon from the accessible name');
  ok(/id="fr-title"><span aria-hidden="true">◈<\/span> Connect a model/.test(chatEjs),
    'the first-run dialog title hides its decorative glyph');
  // Static dialog titles and section dividers expose heading semantics (role=heading + level) at load.
  ok(/for \(const el of document\.querySelectorAll\('\.modal-title'\)\)[\s\S]*?setAttribute\('role', 'heading'\)[\s\S]*?setAttribute\('aria-level', '2'\)/.test(chatJs),
    'modal titles are marked as level-2 headings');
  ok(/for \(const el of document\.querySelectorAll\('\.settings-section'\)\)[\s\S]*?setAttribute\('aria-level', '3'\)/.test(chatJs),
    'settings sections are marked as level-3 headings');
  // The standalone document viewer exposes a main landmark on its content (both PDF and rendered paths).
  const viewerEjs = read('lib/views/document-viewer.ejs');
  ok(/<iframe[^\n]*role="main"/.test(viewerEjs) && /<div class="viewer-content" role="main"/.test(viewerEjs),
    'the document viewer marks its content region as the main landmark');

  console.log('✓ citations-ux: audit-pass a11y gaps closed (labels, heading semantics, viewer landmark)');

  // ── Audit pass (round 2): more a11y gaps closed ──
  // The Logs tabpanel must NOT be an aria-live region — its content is reached via the tab, and being live
  // made a screen reader re-read the whole log on every refresh / tab switch / 3s auto-refresh tick.
  ok(!/<pre id="logs-body"[^>]*aria-live/.test(chatEjs), 'the logs tabpanel is not an aria-live region (no full-log re-announce)');
  // Async status lines that are updated only via textContent must be live regions, or a screen reader never
  // hears the result. The first-run connection status (#fr-status) is the critical one — a brand-new user's
  // only feedback that the model connected — so each of these carries role="status" aria-live="polite".
  for (const id of ['fr-status', 'graph-rag-status', 'consolidate-banks-status', 'eval-status']) {
    const el = new RegExp(`id="${id}"[^>]*`).exec(chatEjs);
    ok(el && /role="status"/.test(el[0]) && /aria-live="polite"/.test(el[0]),
      `#${id} is a polite live region so its async result is announced`);
  }
  // Decorative emoji in dynamically built rows and the viewer title are hidden from the accessible name.
  ok(/<span class="di-icon" aria-hidden="true">/.test(chatJs) && /<span class="df-icon" aria-hidden="true">/.test(chatJs),
    'the document/folder row icons are aria-hidden');
  ok(/<h1><svg class="ico" aria-hidden="true"><use href="#<%= fileIcon %>"\/><\/svg>/.test(viewerEjs),
    'the viewer title shows its file-type icon as a themeable sprite (hidden from a11y)');
  // The composer attach button reaches the 24px touch target on coarse pointers.
  ok(/#attach-btn \{ min-height: 24px; \}/.test(coarseBlock) || /#attach-btn \{[^}]*min-height: 24px/.test(coarseBlock),
    'the attach button has a 24px touch target on coarse pointers');
  // Text fields get the consistent 2px keyboard focus ring (box-shadow, non-layout), not only a border recolor.
  ok(/#message-input:focus-visible,[\s\S]*?box-shadow: 0 0 0 2px var\(--accent\)/.test(css),
    'text fields show the 2px focus-visible ring via box-shadow');
  // The standalone viewer's Related modal inerts the page behind it.
  const viewerRelated = read('lib/public/js/viewer-related.js');
  ok(/function setBgInert\(on\)/.test(viewerRelated) && /setBgInert\(true\)/.test(viewerRelated) && /setBgInert\(false\)/.test(viewerRelated),
    'the viewer Related modal marks the background inert while open');
  console.log('✓ citations-ux: logs live-region, decorative glyphs, attach target, input focus ring, viewer modal inert');

  // ── Audit pass (round 4): robustness polish ──
  // Every safe-area inset carries a fallback value, so a pre-env() engine drops nothing and the convention
  // stays consistent (an undefined inset resolves to 0 on supporting browsers anyway).
  ok(!/env\(safe-area-inset-(?:top|bottom|left|right)\)(?!,)/.test(css.replace(/env\(safe-area-inset-\w+, 0px\)/g, '')),
    'every env(safe-area-inset-*) supplies a 0px fallback');
  // The viewer Related modal guards its list node like its siblings, so a missing element never throws mid-render.
  ok(/if \(!list\) return;/.test(viewerRelated), 'the viewer Related renderer guards the list node before appending');
  console.log('✓ citations-ux: safe-area insets carry fallbacks; the viewer Related renderer guards its list node');

  // ── Audit pass (chat/socket round): touch + download robustness ──
  // The web-search toggle locks on via long-press on touch. iOS Safari raises the selection callout on a
  // long-press (firing pointercancel, which aborts the long-press timer) unless the callout/selection is
  // suppressed; touch-action: manipulation also disables the double-tap zoom gesture on the control.
  const webToggleCss = (css.match(/#web-search-toggle \{[^}]*\}/) || [''])[0];
  ok(/-webkit-touch-callout: none/.test(webToggleCss) && /user-select: none/.test(webToggleCss) && /touch-action: manipulation/.test(webToggleCss),
    'the web-search toggle suppresses the iOS callout/selection and disables double-tap zoom (long-press lock works on touch)');

  // The backup download POSTs through a hidden iframe target, so an error response renders into the throwaway
  // frame instead of navigating the chat page away, and it STAYS a streamed form POST (never fetch()+blob(),
  // which would buffer a multi-GB archive in memory). It no longer claims "downloaded" unconditionally.
  {
    const dlIdx = chatJs.indexOf("backupDownBtn?.addEventListener('click'");
    // End at the next handler, so a later fetch (the restore drill) cannot be mistaken for the download path.
    const dlEnd = chatJs.indexOf('restoreVerify?.addEventListener', dlIdx);
    const dlBody = chatJs.slice(dlIdx, dlEnd === -1 ? dlIdx + 3000 : dlEnd);
    ok(/form\.target = frameName/.test(dlBody), 'the backup download form targets a hidden iframe (no top-window navigation on error)');
    ok(!/fetch\(.{0,20}\/api\/backup/.test(dlBody) && /form\.submit\(\)/.test(dlBody),
      'the backup download stays a streamed form POST (no fetch+blob buffering — OOM-safe for large archives)');
    ok(!/Backup downloaded\./.test(dlBody) && /download started/.test(dlBody),
      'the backup download reports that it started, not an unconditional success');
  }
  console.log('✓ citations-ux: the touch lock gesture and backup download are cross-browser robust');

  // ── Client network + host helpers are single-sourced (no re-inlined boilerplate to drift) ──
  // webHost(src) replaces the three copies of new URL(...).hostname.replace(/^www\./,'') (each try/caught);
  // sendJSON/getJSON replace the per-call verb/headers/stringify and (await fetch()).json() boilerplate.
  ok(/const webHost = \(src\) =>/.test(chatJs), 'a shared webHost(src) helper exists');
  ok(!/\.hostname\.replace\(\/\^www\\\.\//.test(chatJs.replace(/const webHost[^\n]*\n/, '')),
    'no caller re-inlines the www-stripped hostname extraction (all use webHost)');
  ok(/const getJSON = \(url\) =>/.test(chatJs) && /const sendJSON = \(url, body, method = 'POST', opts = \{\}\) =>/.test(chatJs),
    'shared getJSON / sendJSON fetch helpers exist');
  // Only the sendJSON definition itself may carry the inline JSON Content-Type header.
  ok((chatJs.match(/headers: \{ 'Content-Type': 'application\/json' \}/g) || []).length === 1,
    'no handler re-inlines the JSON Content-Type header (all mutating calls go through sendJSON)');
  ok(!/await \(await fetch\('[^']*'\)\)\.json\(\)/.test(chatJs),
    'no pure-GET call re-inlines (await fetch()).json() (all use getJSON)');
  console.log('✓ citations-ux: webHost and the getJSON/sendJSON fetch helpers are single-sourced');

  console.log(`\nALL CITATIONS-UX UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CITATIONS-UX UNIT TEST FAILED:', e.message);
  process.exit(1);
}
