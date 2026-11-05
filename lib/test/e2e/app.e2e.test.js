'use strict';
// Browser regression suite. Uses the Puppeteer dependency the app already ships for URL ingestion,
// plus axe-core for accessibility. The harness starts the real server and a local stub provider, so
// there is no model, credential, or external network involved.
//
// Run: `npm run test:e2e`. First-time setup installs both browser runtimes; see docs/README.md.
// The suite automates Chromium and Firefox. Puppeteer cannot drive Safari; `npm run e2e:safari` covers the
// rendering engine through the WebDriver that ships with macOS.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test, before, after } = require('node:test');
const puppeteer = require('puppeteer');
const { startHarness } = require('./harness');
const { DOC_NAME, CODE, QUESTION, SLOW_QUESTION, SPANISH_QUESTION, SPANISH_ANSWER } = require('./fixtures');

const SCREENSHOT_DIR = path.join(process.cwd(), 'test-results');
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BROWSER = (process.env.E2E_BROWSER || 'chromium').toLowerCase();
const BROWSER_LABEL = BROWSER === 'firefox' ? 'Firefox' : 'Chromium';

let harness = null;
let browser = null;

const waitForReady = async (page) => {
  await page.waitForFunction(() => {
    const status = document.querySelector('#status-text');
    return !!status && /1\s*doc/i.test(status.textContent || '');
  }, { timeout: 30_000 });
};

const getText = (page, selector) => page.$eval(selector, (el) => el.textContent || '');

// Axe measures the computed (blended) colors, so a fade-in answer can look low-contrast mid-animation.
// Wait until every matched element's animations have finished before running the audit.
const waitForAnimations = async (page, selector, timeout = 5000) => {
  await page.waitForFunction((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.length > 0 && els.every((el) => el.getAnimations().every((a) => a.playState === 'finished'));
  }, { timeout }, selector);
};

const click = async (page, selector) => {
  await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
  await page.click(selector);
};

const waitForText = async (page, selector, needle, timeout = 40_000) => {
  await page.waitForFunction((sel, value) => {
    const el = document.querySelector(sel);
    return !!el && (el.textContent || '').includes(value);
  }, { timeout }, selector, needle);
};

const newConversation = async (page) => {
  await waitForReady(page);
  const button = await page.$('#new-convo');
  if (button) {
    await button.click();
    const confirm = await page.waitForSelector('#new-confirm-ok', { visible: true, timeout: 2000 }).catch(() => null);
    if (confirm) await confirm.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
};

const waitForSettingsReady = (page) => page.waitForFunction(() => {
  const save = document.querySelector('#settings-save');
  return !!save && !save.disabled;
});

// Configure read-aloud for Spanish and pin the test stub's alternate local voice. Leaves Settings open so a
// caller can preview or audit it before saving.
const openSpanishSystemVoiceSettings = async (page) => {
  await click(page, '#settings-btn');
  await page.waitForSelector('#settings-overlay', { visible: true });
  await waitForSettingsReady(page);
  await page.evaluate(() => {
    const cb = document.querySelector('#cfg-tts-enabled');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-language option').length > 5);
  await page.select('#cfg-tts-language', 'es');
  await page.waitForFunction(() => document.querySelector('#cfg-tts-system-language')?.value === 'es');
  await page.evaluate(() => {
    const cb = document.querySelector('#cfg-tts-online-voices');
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-system-voice option').length > 1);
  await page.evaluate(() => {
    const sel = document.querySelector('#cfg-tts-system-voice');
    const opt = [...sel.options].find((o) => /alternate/i.test(o.textContent));
    if (!opt) throw new Error('the test stub system voice is missing');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const saveSettings = async (page) => {
  await page.click('#settings-save');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#settings-status')?.textContent || ''));
  // A toast can sit above the bottom actions; dismiss it before clicking Cancel so a transient notice cannot
  // intercept the click (the same is true for a real user, who can click the toast away).
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  await page.evaluate(() => { document.getElementById('settings-cancel')?.click(); });
  await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
};

// Restore the temporary harness config: clear the pinned voice, return to Automatic, and turn read-aloud off.
// `browseLanguage` pins which language's saved voice is cleared, for a test that changed the browsing context.
const resetReadAloudSettings = async (page, browseLanguage = '') => {
  await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
  await click(page, '#settings-btn');
  await page.waitForSelector('#settings-overlay', { visible: true });
  await waitForSettingsReady(page);
  if (browseLanguage) {
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-system-language option').length > 5);
    await page.select('#cfg-tts-system-language', browseLanguage);
  }
  // Clear the pinned voice for the language the picker is browsing (read-aloud language may be Automatic).
  await page.evaluate(() => {
    const sel = document.querySelector('#cfg-tts-system-voice');
    if (sel) {
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.select('#cfg-tts-language', 'auto');
  await page.evaluate(() => {
    const tts = document.querySelector('#cfg-tts-enabled');
    if (tts.checked) { tts.checked = false; tts.dispatchEvent(new Event('change', { bubbles: true })); }
    const online = document.querySelector('#cfg-tts-online-voices');
    if (online.checked) { online.checked = false; online.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await saveSettings(page);
};

const runAxe = async (page, rootSelector = null) => {
  await page.evaluate(`${AXE_SOURCE}\n;0`);
  return page.evaluate(async (selector) => {
    const root = selector ? document.querySelector(selector) : document;
    if (!root) return [{ id: 'missing-root', impact: 'critical', help: `No element for ${selector}`, nodes: 1 }];
    const result = await window.axe.run(root, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
  }, rootSelector);
};

const withPage = async (t, viewport, fn, prepare = null, { resetStorage = true } = {}) => {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  let failure = null;
  try {
    await page.setViewport(viewport);
    // Each test starts with a clean theme, text scale, and conversation pointer. A restore test opts out so
    // its session id survives a reload (that is the behavior under test).
    if (resetStorage) {
      await page.evaluateOnNewDocument(() => {
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage unavailable */ }
      });
    }
    if (prepare) await page.evaluateOnNewDocument(prepare);
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForReady(page);
    await fn(page);
  } catch (error) {
    failure = error;
    try {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const safeName = String(t.name).replace(/[^\w.-]+/g, '-').slice(0, 120);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${safeName}.png`) });
    } catch { /* screenshot is diagnostic only */ }
  } finally {
    if (!failure) assert.deepStrictEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('; ')}`);
    await page.close().catch(() => {});
  }
  if (failure) throw failure;
};

before(async () => {
  harness = await startHarness();
  browser = await puppeteer.launch({
    browser: BROWSER === 'firefox' ? 'firefox' : undefined,
    headless: true,
    args: BROWSER === 'firefox' ? [] : ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    defaultViewport: null,
  });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (harness) await harness.stop();
}, { timeout: 30_000 });

test(`${BROWSER_LABEL}: choosing a composer option does not send the typed message`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await page.type('#message-input', 'keep this text');
    await click(page, '#tools-btn');
    await page.waitForSelector('#tools-menu', { visible: true });
    const rowsBefore = await page.$$eval('.msg-row', (rows) => rows.length);
    await click(page, '#why-toggle');
    assert.strictEqual(await page.$eval('#message-input', (el) => el.value), 'keep this text');
    assert.strictEqual(await page.$$eval('.msg-row', (rows) => rows.length), rowsBefore);
  });
});

test(`${BROWSER_LABEL}: Settings stays usable on a phone`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);

    await page.type('#settings-filter', 'voice');
    await page.waitForFunction(() => /matching setting/i.test(document.querySelector('#settings-filter-count')?.textContent || ''));
    // The focus ring is a 2px box-shadow outside the input. The sticky row must leave that much room inside
    // #settings-body, or the scroll container clips the ring at the top and sides.
    const focusRing = await page.evaluate(() => {
      const input = document.querySelector('#settings-filter');
      const row = input.closest('.settings-search-row');
      const body = document.querySelector('#settings-body');
      const ir = input.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      const cs = getComputedStyle(row);
      return {
        padTop: parseFloat(cs.paddingTop) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        padRight: parseFloat(cs.paddingRight) || 0,
        inputTop: ir.top - rr.top,
        inputLeft: ir.left - rr.left,
        inputRight: rr.right - ir.right,
        inside: ir.top >= br.top - 0.5 && ir.left >= br.left - 0.5 && ir.right <= br.right + 0.5,
      };
    });
    assert.ok(focusRing.padTop >= 2 && focusRing.padLeft >= 2 && focusRing.padRight >= 2,
      'the filter row leaves room for the 2px focus ring');
    assert.ok(focusRing.inputTop >= 2 && focusRing.inputLeft >= 2 && focusRing.inputRight >= 2,
      'the filter input is inset from the row edges');
    assert.strictEqual(focusRing.inside, true, 'the focused filter stays inside the scroll container');
    const phone = await page.evaluate(() => {
      const box = document.querySelector('#settings-overlay .modal-box');
      const rect = box ? box.getBoundingClientRect() : null;
      const row = [...document.querySelectorAll('#settings-body .settings-row')]
        .find((r) => !r.classList.contains('settings-filtered') && !r.classList.contains('hidden'));
      return {
        fits: !!rect && rect.left >= -1 && rect.right <= window.innerWidth + 1,
        overflow: !!box && box.scrollWidth > box.clientWidth + 1,
        rowVisible: !!row,
      };
    });
    assert.strictEqual(phone.fits, true, 'the Settings dialog fits the phone viewport');
    assert.strictEqual(phone.overflow, false, 'the Settings dialog does not overflow horizontally');
    assert.strictEqual(phone.rowVisible, true, 'the filter leaves a matching setting visible');

    await page.evaluate(() => { document.querySelector('#cfg-health-details').open = true; });
    await page.waitForFunction(() => {
      const note = document.querySelector('#cfg-health-note')?.textContent || '';
      return !!note && !/loading/i.test(note);
    });
    assert.deepStrictEqual(await runAxe(page, '#settings-overlay'), [], 'filtered Settings and health are accessible on a phone');

    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((el) => el.remove()); document.getElementById('settings-cancel')?.click(); });
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
  });
});

test(`${BROWSER_LABEL}: documents can be filtered and opened by name`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await click(page, '#docs-toggle');
    await page.waitForSelector('#doc-panel', { visible: true });
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length >= 1);

    // A partial name narrows the list and the status says exactly how much is shown.
    await page.type('#doc-search-input', 'orion');
    await page.waitForFunction(() => /Showing 1 of \d+/.test(document.querySelector('#doc-filter-label')?.textContent || ''));
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length === 1);
    assert.strictEqual(await page.$$eval('#doc-list-wrap .doc-item', (els) => els.length), 1);

    // "Select shown" focuses only the visible match; clearing the filter keeps that selection.
    await page.click('#doc-select-all');
    await page.waitForFunction(() => document.querySelector('.doc-item .di-check')?.checked === true);
    assert.ok(/Focused: 1 doc/.test(await getText(page, '#doc-filter-label')));
    await page.click('#doc-search-clear');
    await page.waitForFunction(() => /^Focused: 1 doc$/.test((document.querySelector('#doc-filter-label')?.textContent || '').trim()));
    assert.strictEqual(await page.$eval('.doc-item .di-check', (el) => el.checked), true,
      'a selection made under a filter survives clearing it');
    await page.click('#doc-select-all');   // Clear the focused selection
    await page.waitForFunction(() => document.querySelector('.doc-item .di-check')?.checked === false);

    // A non-match shows a clear empty state; the clear control restores the full list.
    await page.$eval('#doc-search-input', (el) => { el.value = 'zz-no-such-file'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => {
      const empty = document.querySelector('#doc-list-empty');
      return !!empty && /No documents match/.test(empty.textContent || '') && getComputedStyle(empty).display !== 'none';
    });
    assert.strictEqual(await page.$eval('#doc-select-all', (el) => el.disabled), true,
      'the bulk action is disabled when the filter hides everything');
    await page.click('#doc-search-clear');
    await page.waitForFunction(() => (document.querySelector('#doc-filter-label')?.textContent || '').trim() === 'All documents');
    assert.strictEqual(await page.$$eval('#doc-list-wrap .doc-item', (els) => els.length), 1);

    // The action row wraps at phone width without horizontal overflow, and the References action stays
    // reachable (it was added after the other workspace tools).
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel');
      const btn = document.querySelector('#cite-import-btn');
      const rect = btn ? btn.getBoundingClientRect() : null;
      return {
        overflow: !!panel && panel.scrollWidth > panel.clientWidth + 1,
        visible: !!rect && rect.width > 0 && rect.height > 0 && rect.right <= window.innerWidth + 1,
      };
    });
    assert.strictEqual(geometry.overflow, false, 'the document panel does not overflow horizontally on a phone');
    assert.strictEqual(geometry.visible, true, 'the References action is visible and inside the viewport');

    // The reference import dialog fits a phone screen, is accessible, and closes without disturbing the panel.
    await click(page, '#cite-import-btn');
    await page.waitForSelector('#cite-import-overlay', { visible: true });
    const dialog = await page.evaluate(() => {
      const box = document.querySelector('#cite-import-overlay .modal-box');
      const rect = box ? box.getBoundingClientRect() : null;
      return {
        fits: !!rect && rect.left >= -1 && rect.right <= window.innerWidth + 1,
        overflow: !!box && box.scrollWidth > box.clientWidth + 1,
      };
    });
    assert.strictEqual(dialog.fits, true, 'the import dialog fits the phone viewport');
    assert.strictEqual(dialog.overflow, false, 'the import dialog does not overflow horizontally');
    assert.deepStrictEqual(await runAxe(page, '#cite-import-overlay'), [], 'the import dialog is accessible on a phone');
    await page.evaluate(() => document.getElementById('cite-import-cancel').click());
    await page.waitForFunction(() => document.querySelector('#cite-import-overlay')?.classList.contains('hidden'));

    // The name is a link that opens the in-app viewer; opening does not focus the document.
    const beforeChecked = await page.$eval('.doc-item .di-check', (el) => el.checked);
    await page.click('.doc-item .di-open');
    await page.waitForSelector('#source-overlay', { visible: true });
    assert.ok((await page.$eval('#source-frame', (el) => el.getAttribute('src') || '')).includes('/document/view?path='),
      'the document name opens the shared viewer route');
    assert.strictEqual(await page.$eval('.doc-item .di-check', (el) => el.checked), beforeChecked,
      'opening a document does not change its focused-selection state');
    await click(page, '#source-close');
  });
});

test(`${BROWSER_LABEL}: the mobile Tools sheet is a titled, dismissible dialog`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await click(page, '#tools-btn');
    await page.waitForSelector('#tools-menu', { visible: true });

    const opened = await page.evaluate(() => {
      const menu = document.querySelector('#tools-menu');
      const head = menu.querySelector('.sheet-head');
      const backdrop = document.querySelector('#sheet-backdrop');
      return {
        role: menu.getAttribute('role'),
        modal: menu.getAttribute('aria-modal'),
        labelledby: menu.getAttribute('aria-labelledby'),
        headDisplay: getComputedStyle(head).display,
        headText: head.textContent.trim(),
        closeVisible: document.querySelector('#tools-sheet-close').offsetParent !== null,
        haspopup: document.querySelector('#tools-btn').getAttribute('aria-haspopup'),
        backdropHidden: backdrop.hidden,
        backdropBelow: Number(getComputedStyle(backdrop).zIndex) < Number(getComputedStyle(menu).zIndex),
      };
    });
    assert.strictEqual(opened.role, 'dialog');
    assert.strictEqual(opened.modal, 'true');
    assert.strictEqual(opened.labelledby, 'tools-sheet-title');
    assert.strictEqual(opened.headDisplay, 'flex');
    assert.ok(opened.headText.includes('Answer options'), 'the sheet names itself');
    assert.strictEqual(opened.closeVisible, true, 'the sheet offers a close control');
    assert.strictEqual(opened.haspopup, 'dialog', 'the Tools trigger announces that it opens a dialog on a phone');
    assert.strictEqual(opened.backdropHidden, false, 'the sheet dims the page behind it');
    assert.strictEqual(opened.backdropBelow, true, 'the backdrop stays below the sheet');
    assert.strictEqual(await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#tools-menu') && document.activeElement.classList.contains('tool-row')),
      true, 'opening the sheet moves focus to its first visible option');
    assert.deepStrictEqual(await runAxe(page, '#tools-menu'), []);

    // Tab from the last control wraps to the first (the close button): focus stays in the sheet.
    await page.evaluate(() => {
      const menu = document.querySelector('#tools-menu');
      const items = [...menu.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
      items[items.length - 1].focus();
    });
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tools-sheet-close');

    // The close control dismisses the sheet, restores the popover semantics, and returns focus.
    await page.click('#tools-sheet-close');
    await page.waitForFunction(() => document.querySelector('#tools-menu').hidden === true);
    const closed = await page.evaluate(() => {
      const menu = document.querySelector('#tools-menu');
      return {
        role: menu.getAttribute('role'),
        label: menu.getAttribute('aria-label'),
        backdropHidden: document.querySelector('#sheet-backdrop').hidden,
        focus: document.activeElement && document.activeElement.id,
        haspopup: document.querySelector('#tools-btn').getAttribute('aria-haspopup'),
      };
    });
    assert.deepStrictEqual(closed, { role: 'group', label: 'Answer options', backdropHidden: true, focus: 'tools-btn', haspopup: null });

    // A backdrop click also dismisses it.
    await click(page, '#tools-btn');
    await page.waitForSelector('#tools-menu', { visible: true });
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => document.querySelector('#tools-menu').hidden === true);
    assert.strictEqual(await page.$eval('#sheet-backdrop', (el) => el.hidden), true);

    // Widening to desktop restores the compact popover (no dialog role, no header, no backdrop).
    await page.setViewport({ width: 1280, height: 800 });
    await click(page, '#tools-btn');
    await page.waitForSelector('#tools-menu', { visible: true });
    assert.strictEqual(await page.$eval('#tools-menu', (el) => el.getAttribute('role')), 'group');
    assert.strictEqual(await page.$eval('#tools-menu .sheet-head', (el) => getComputedStyle(el).display), 'none');
    assert.strictEqual(await page.$eval('#sheet-backdrop', (el) => el.hidden), true);
    assert.strictEqual(await page.$eval('#tools-btn', (el) => el.getAttribute('aria-haspopup')), null);
  });
});

test(`${BROWSER_LABEL}: an answer has one source row and a keyboard-complete action strip`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await newConversation(page);
    await page.type('#message-input', QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .sources-row');

    // One source presentation: the numbered row below the answer; the old duplicate strip is gone.
    assert.strictEqual(await page.$$eval('#chat-box .answered-from', (els) => els.length), 0,
      'no duplicate "answered from" strip is rendered');
    assert.ok(/Sources \(\d+\)/.test(await getText(page, '#chat-box .sources-row .sources-label')),
      'the single source row carries its count');
    assert.strictEqual(await page.$$eval('#chat-box .sources-row .answer-menu, #chat-box .sources-row .rating-row', (els) => els.length), 0,
      'actions never attach inside the sources row');

    // The stable action strip exists and orders the rating control before the More menu.
    await page.waitForSelector('#chat-box .answer-actions');
    const strip = await page.evaluate(() => {
      const actions = [...document.querySelectorAll('#chat-box .answer-actions')].pop();
      const kids = [...actions.children].filter((el) => !el.classList.contains('hidden'));
      return kids.map((el) => ({
        cls: el.className,
        order: Number(getComputedStyle(el).order) || 0,
        left: el.getBoundingClientRect().left,
      }));
    });
    const rating = strip.find((x) => /rating-row/.test(x.cls));
    const menu = strip.find((x) => /answer-menu/.test(x.cls));
    assert.ok(rating && menu, 'the action strip contains the rating control and the More menu');
    assert.ok(rating.order < menu.order, 'the rating control is ordered before More');
    assert.ok(rating.left <= menu.left, 'the rating control sits left of More');

    // More is a real menu: it opens onto its first item, arrows move, Escape returns focus.
    const more = await page.$('#chat-box .answer-menu-btn');
    assert.strictEqual(await more.evaluate((b) => b.getAttribute('aria-haspopup')), 'menu');
    assert.strictEqual(await more.evaluate((b) => b.getAttribute('aria-expanded')), 'false');
    await more.click();
    await page.waitForFunction(() => {
      const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
      return !!list && !list.hidden && document.activeElement === list.querySelector('.answer-menu-item');
    });
    const first = await page.evaluate(() => document.activeElement.textContent.trim());
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement.textContent.trim());
    assert.notStrictEqual(second, first, 'ArrowDown moves to the next action');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
      return !!list && list.hidden;
    });
    assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.className), 'answer-menu-btn',
      'Escape closes the menu and returns focus to its trigger');
  });
});

test(`${BROWSER_LABEL}: a turn can be stopped without losing what already streamed`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await newConversation(page);
    // The server hands the event names to the page; the browser must be able to read the hand-off.
    const protocol = await page.$eval('meta[name="lokyni-turn-protocol"]', (el) => JSON.parse(el.getAttribute('content') || '{}'));
    assert.strictEqual(protocol.stop, 'chat_stop');
    assert.strictEqual(protocol.stopped, 'chat_stopped');
    assert.strictEqual(protocol.end, 'chat_end');
    await page.type('#message-input', SLOW_QUESTION);
    await page.keyboard.press('Enter');

    // One control, two roles: the Send button becomes a real Stop with an action-specific name.
    await page.waitForFunction(() => {
      const b = document.querySelector('#send-button');
      return !!b && b.classList.contains('stop-mode') && b.textContent.trim() === 'Stop' && !b.disabled;
    });
    assert.strictEqual(await page.$eval('#send-button', (b) => b.getAttribute('aria-label')), 'Stop generating');

    // Wait until the provider has actually streamed some answer text.
    await page.waitForFunction(() => {
      const b = document.querySelector('#chat-box .msg-row.bot .bubble.streaming');
      return !!b && (b.textContent || '').trim().length >= 20;
    }, { timeout: 30_000 });
    const before = await page.$eval('#chat-box .msg-row.bot .bubble.streaming', (b) => (b.textContent || '').trim());

    await click(page, '#send-button');

    // The server confirms the Stop, the turn ends, and the same control returns to Send.
    await page.waitForFunction(() => {
      const b = document.querySelector('#send-button');
      return !!b && !b.classList.contains('stop-mode') && b.textContent.trim().startsWith('Send') && !b.disabled;
    }, { timeout: 20_000 });
    assert.strictEqual(await page.$eval('#send-button', (b) => b.getAttribute('aria-label')), 'Send message');
    assert.strictEqual(await page.$eval('#message-input', (el) => el.disabled), false);

    // A stopped turn keeps the partial answer and marks it as stopped, not as an error.
    await waitForText(page, '.notice-row', 'Stopped.');
    const kept = await page.$$eval('#chat-box .msg-row.bot .bubble', (bubbles) => bubbles.map((b) => (b.textContent || '').trim()).join('\n'));
    assert.ok(kept.includes(before.slice(0, 20)), 'the text that had already streamed is preserved');
    const firstLength = kept.length;

    // No token may be appended after Stop, even though the stub was still generating.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const later = await page.$$eval('#chat-box .msg-row.bot .bubble', (bubbles) => bubbles.map((b) => (b.textContent || '').trim()).join('\n'));
    assert.strictEqual(later.length, firstLength, 'no token is appended after the turn was stopped');
    assert.ok(!/⚠/.test(later), 'a stop is not shown as an error');
  });
});

test(`${BROWSER_LABEL}: Deep Research shows its progress before the report streams`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await newConversation(page);
    await click(page, '#tools-btn');
    await click(page, '#research-toggle');
    await page.keyboard.press('Escape');   // close the Tools popover, restoring focus to its trigger
    await page.type('#message-input', SLOW_QUESTION);
    await page.keyboard.press('Enter');

    // The status bubble reports what the multi-step run is doing (planning, a sub-question, synthesis)
    // instead of leaving an opaque spinner. The stub holds its first report token briefly so this window
    // is observable in a headless browser.
    await page.waitForFunction(() => {
      const bubbles = [...document.querySelectorAll('#chat-box .msg-row.bot .bubble')];
      return bubbles.some((b) => /Planning the research|Researching sub-question|Synthesizing the report/.test(b.textContent || ''));
    }, { timeout: 30_000 });

    // Stop the (deliberately slow) report so the test ends promptly; the Stop path is covered above.
    await click(page, '#send-button');
    await waitForText(page, '.notice-row', 'Stopped.');
  });
});

test(`${BROWSER_LABEL}: a phone-sized question streams an answer with its source`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 320, height: 800 }, async (page) => {
    await newConversation(page);
    await page.type('#message-input', QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await waitForText(page, '#chat-box', DOC_NAME);
    assert.strictEqual(await page.$eval('#message-input', (el) => el.disabled), false);
    assert.strictEqual(await page.$eval('#send-button', (el) => el.disabled), false);
  });
});

test(`${BROWSER_LABEL}: the empty-state call to action is clickable and centered`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    await page.evaluate(() => {
      document.querySelector('#empty-onboard').style.display = '';
      document.querySelector('#empty-ask').style.display = 'none';
    });
    const cta = await page.$eval('#empty-add-doc', (el) => {
      const rect = el.getBoundingClientRect();
      const styles = getComputedStyle(el);
      const label = el.closest('#empty-onboard').querySelector('.label').getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height, pointerEvents: styles.pointerEvents, labelCenter: label.left + label.width / 2, ctaCenter: rect.left + rect.width / 2 };
    });
    assert.ok(cta.width > 80 && cta.height >= 36, 'the CTA has a usable button size');
    assert.strictEqual(cta.pointerEvents, 'auto', 'the empty-state container no longer disables the CTA');
    assert.ok(Math.abs(cta.labelCenter - cta.ctaCenter) < 3, 'the label and CTA share the same center');
    await page.click('#empty-add-doc');
    await page.waitForFunction(() => !document.querySelector('#doc-panel')?.classList.contains('collapsed'));
  });
});

test(`${BROWSER_LABEL}: settings actions stay visible above the scroll area`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 700 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await page.waitForFunction(() => {
      const save = document.querySelector('#settings-save');
      return !!save && !save.disabled;
    });
    const layout = await page.evaluate(() => {
      const save = document.querySelector('#settings-save').getBoundingClientRect();
      const cancel = document.querySelector('#settings-cancel').getBoundingClientRect();
      const viewport = window.innerHeight;
      return { saveTop: save.top, saveBottom: save.bottom, cancelBottom: cancel.bottom, viewport };
    });
    assert.ok(layout.saveTop >= 0 && layout.saveBottom <= layout.viewport + 1, 'Save is visible without scrolling');
    assert.ok(layout.cancelBottom <= layout.viewport + 1, 'Cancel is visible without scrolling');
  });
});

test(`${BROWSER_LABEL}: a phone header still shows connection status`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 320, height: 800 }, async (page) => {
    const status = await page.evaluate(() => {
      const badge = document.querySelector('#status-badge');
      const dot = badge.querySelector('.dot');
      const text = document.querySelector('#status-text');
      const rect = dot.getBoundingClientRect();
      return { display: getComputedStyle(badge).display, dotWidth: rect.width, textWidth: text.getBoundingClientRect().width, text: text.textContent };
    });
    assert.notStrictEqual(status.display, 'none', 'the status badge is visible on a phone');
    assert.ok(status.dotWidth >= 6, 'the status dot has a visible size');
    assert.ok(status.textWidth <= 1, 'the status text is visually hidden but remains in the live region');
    assert.ok(status.text && status.text.length > 0, 'the status text is still available to assistive technology');
  });
});

test(`${BROWSER_LABEL}: default-on modes do not inflate the Tools badge`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await page.waitForFunction(() => document.querySelector('#tools-badge')?.classList.contains('hidden'));
    const before = await page.$eval('#tools-badge', (el) => ({ hidden: el.classList.contains('hidden'), text: el.textContent }));
    assert.strictEqual(before.hidden, true);
    await click(page, '#tools-btn');
    await click(page, '#verify-toggle');
    await page.waitForFunction(() => {
      const badge = document.querySelector('#tools-badge');
      return badge && !badge.classList.contains('hidden') && badge.textContent === '1';
    });
    assert.strictEqual(await page.$eval('#tools-badge', (el) => el.textContent), '1');
  });
});

test(`${BROWSER_LABEL}: the upload hint comes from the supported-format list`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await click(page, '#docs-toggle');
    await page.waitForSelector('#doc-panel', { visible: true });
    const hint = await page.$eval('.dz-sub', (el) => el.textContent || '');
    assert.ok(hint.includes('.pptx'), 'the hint includes presentations');
    assert.ok(hint.includes('.json'), 'the hint includes structured data');
    assert.ok(hint.includes('.xlsx'), 'the hint includes spreadsheets');
  });
});

test(`${BROWSER_LABEL}: settings controls stay inside a narrow phone viewport`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 320, height: 700 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await page.evaluate(() => {
      document.querySelectorAll('#settings-body details').forEach((details) => { details.open = true; });
      document.querySelector('#cfg-podcast-voices-row')?.classList.remove('hidden');
      document.querySelector('#cfg-tts-voice-row')?.classList.remove('hidden');
      // The two-control system-voice row and its diagnostics wrapper are hidden while read-aloud is off.
      document.querySelector('#cfg-tts-system-voice-row')?.classList.remove('hidden');
      document.querySelector('#cfg-tts-voices-details')?.removeAttribute('hidden');
    });
    const overflow = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders = [];
      for (const element of document.querySelectorAll('.settings-box input, .settings-box select, .settings-box textarea, .settings-box button')) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && (rect.left < -1 || rect.right > viewport + 1)) {
          offenders.push({ id: element.id, tag: element.tagName, left: Math.round(rect.left), right: Math.round(rect.right) });
        }
      }
      return { viewport, scrollWidth: document.documentElement.scrollWidth, offenders };
    });
    assert.ok(overflow.scrollWidth <= overflow.viewport + 1, `page overflows by ${overflow.scrollWidth - overflow.viewport}px`);
    assert.deepStrictEqual(overflow.offenders, []);
  });
});

test(`${BROWSER_LABEL}: theme, text size, and Escape focus return work`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 390, height: 844 }, async (page) => {
    const before = await page.evaluate(() => localStorage.getItem('theme') || 'dark');
    await click(page, '#theme-toggle');
    await page.waitForFunction((previous) => (localStorage.getItem('theme') || 'dark') !== previous, {}, before);

    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await page.select('#cfg-read-scale', '1.5');
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--read-scale').trim() === '1.5');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
    assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'settings-btn');
  });
});

test(`${BROWSER_LABEL}: settings defaults, bounds, and the new conversation toggles round-trip`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await page.waitForFunction(() => {
      const save = document.querySelector('#settings-save');
      return !!save && !save.disabled;
    });

    // The schema projection supplies the defaults and the (narrower) form bounds. The harness config
    // deliberately turns the conversational extras off, so the loaded controls reflect the saved values;
    // the projection itself still carries the canonical defaults.
    const schema = await page.$eval('meta[name="lokyni-settings"]', (el) => JSON.parse(el.getAttribute('content')));
    assert.strictEqual(schema.defaults.useMetaConversation, true, 'the schema default for meta-conversation is on');
    assert.strictEqual(schema.defaults.useSuggestedQuestions, true, 'the schema default for follow-ups is on');
    assert.strictEqual(schema.defaults.useSemanticCache, false, 'the schema default for the semantic cache is off');
    await page.$eval('.settings-advanced', (el) => { el.open = true; });
    assert.strictEqual(await page.$eval('#cfg-semantic-cache', (el) => el.checked), false,
      'the loaded semantic cache matches the saved harness config');
    const bounds = await page.evaluate(() => {
      const pick = (id) => { const el = document.getElementById(id); return { min: el.min, max: el.max, step: el.step }; };
      return { temperature: pick('cfg-temperature'), maxHistory: pick('cfg-max-history') };
    });
    assert.deepStrictEqual(bounds.temperature, { min: '0', max: '2', step: '0.05' });
    assert.deepStrictEqual(bounds.maxHistory, { min: '1', max: '20', step: '1' },
      'the form uses its narrower schema bound, not the wider server clamp');

    // The OCR language catalog is rendered from the server's schema, even while OCR is off. Select one
    // additional language; it is stored now and its pack downloads only when a scan is next read.
    const langCount = await page.$$eval('#cfg-ocr-languages input[type="checkbox"]:not(:disabled)', (els) => els.length);
    assert.ok(langCount > 10, 'the OCR language catalog reaches the picker');
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-ocr-languages input[value="spa"]');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Change one newly exposed toggle, save, reopen, and confirm both changes persisted.
    await page.select('#cfg-url-capture', 'http');
    await page.click('#cfg-semantic-cache');
    await page.click('#settings-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#settings-status')?.textContent || ''));
    await click(page, '#settings-cancel');
    await click(page, '#settings-btn');
    await page.waitForFunction(() => {
      const save = document.querySelector('#settings-save');
      return !!save && !save.disabled;
    });
    assert.strictEqual(await page.$eval('#cfg-semantic-cache', (el) => el.checked), true,
      'the newly exposed toggle round-trips through the API');
    assert.strictEqual(await page.$eval('#cfg-ocr-languages input[value="spa"]', (el) => el.checked), true,
      'the additional OCR language round-trips through the API');
    assert.strictEqual(await page.$eval('#cfg-url-capture', (el) => el.value), 'http',
      'the web page capture mode round-trips through the API');

    // Restore the defaults so the temporary config ends where it started.
    await page.select('#cfg-url-capture', 'auto');
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-ocr-languages input[value="spa"]');
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#cfg-semantic-cache');
    await page.click('#settings-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#settings-status')?.textContent || ''));
  });
});

test(`${BROWSER_LABEL}: settings can be filtered and show the latest health sweep`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);

    // Filtering reveals a match inside a collapsed Advanced group and hides an unrelated section.
    await page.type('#settings-filter', 'temperature');
    await page.waitForFunction(() => /matching setting/i.test(document.querySelector('#settings-filter-count')?.textContent || ''));
    const filtered = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#settings-body .settings-row')]
        .find((r) => /Temperature/.test(r.textContent || ''));
      const adv = [...document.querySelectorAll('#settings-body details')]
        .find((d) => /Advanced/.test(d.querySelector('summary')?.textContent || ''));
      const appearance = [...document.querySelectorAll('#settings-body .settings-section')]
        .find((s) => s.textContent === 'Appearance');
      return {
        rowVisible: !!row && !row.classList.contains('settings-filtered') && !row.classList.contains('hidden'),
        advOpen: !!adv && adv.open,
        appearanceHidden: !!appearance && appearance.classList.contains('settings-filtered'),
      };
    });
    assert.ok(filtered.rowVisible && filtered.advOpen, 'a matching advanced setting is revealed and its group opens');
    assert.ok(filtered.appearanceHidden, 'a nonmatching section is hidden');

    // Escape clears the filter, restores the original collapsed state, and keeps Settings open.
    await page.focus('#settings-filter');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#settings-filter')?.value === '');
    assert.strictEqual(await page.$eval('#settings-filter-count', (el) => el.textContent), '', 'clearing resets the count');
    const restored = await page.evaluate(() => {
      const adv = [...document.querySelectorAll('#settings-body details')]
        .find((d) => /Advanced/.test(d.querySelector('summary')?.textContent || ''));
      return {
        open: !!adv && adv.open,
        filtered: document.querySelectorAll('#settings-body .settings-filtered').length,
        overlayOpen: !document.querySelector('#settings-overlay')?.classList.contains('hidden'),
      };
    });
    assert.strictEqual(restored.open, false, 'the Advanced group returns to its original collapsed state');
    assert.strictEqual(restored.filtered, 0, 'no filter markers remain');
    assert.strictEqual(restored.overlayOpen, true, 'Escape in the filter clears it instead of closing Settings');

    // A group the user opened BEFORE filtering must stay open after the filter is cleared, not snap back to a
    // stale snapshot from an earlier filtering session.
    await page.evaluate(() => {
      const adv = [...document.querySelectorAll('#settings-body details')]
        .find((d) => /Advanced/.test(d.querySelector('summary')?.textContent || ''));
      if (adv) adv.open = true;
    });
    await page.type('#settings-filter', 'temperature');
    await page.waitForFunction(() => /matching setting/i.test(document.querySelector('#settings-filter-count')?.textContent || ''));
    await page.focus('#settings-filter');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#settings-filter')?.value === '');
    assert.strictEqual(await page.evaluate(() => {
      const adv = [...document.querySelectorAll('#settings-body details')]
        .find((d) => /Advanced/.test(d.querySelector('summary')?.textContent || ''));
      return !!adv && adv.open;
    }), true, 'a group opened before filtering stays open after the filter is cleared');

    // The read-only health panel loads the latest sweep (or says it is unavailable, never a dead panel).
    await page.evaluate(() => { document.querySelector('#cfg-health-details').open = true; });
    await page.waitForFunction(() => {
      const note = document.querySelector('#cfg-health-note')?.textContent || '';
      return !!note && !/loading/i.test(note);
    });
    const health = await page.evaluate(() => ({
      role: document.querySelector('#cfg-health-list')?.getAttribute('role'),
      note: document.querySelector('#cfg-health-note')?.textContent || '',
    }));
    assert.strictEqual(health.role, 'list', 'the health findings are a labelled list');
    assert.ok(/sweep|unavailable/i.test(health.note), `the health panel reports its state (${health.note})`);
    assert.deepStrictEqual(await runAxe(page, '#settings-overlay'), [], 'filtered settings and the health panel are accessible');

    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((el) => el.remove()); document.getElementById('settings-cancel')?.click(); });
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
    assert.strictEqual(await page.$eval('#settings-filter', (el) => el.value), '', 'closing Settings clears the filter');
  });
});

test(`${BROWSER_LABEL}: two evaluation runs can be compared side by side`, { timeout: 180_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    // The Quality panel lives in the second Advanced block; open both so its controls are reachable.
    await page.$$eval('details.settings-advanced', (els) => els.forEach((el) => { el.open = true; }));
    await page.waitForSelector('#eval-run-btn', { visible: true });

    // A fresh workspace has no saved questions. Add one, then run the evaluation twice so there is an archive
    // to compare. The stub provider answers and judges deterministically, so no model is involved.
    if (await page.$$eval('#eval-question-list .apikey-row', (rows) => rows.length) === 0) {
      await page.type('#eval-question-input', QUESTION);
      await click(page, '#eval-add-btn');
      await page.waitForFunction(() => document.querySelectorAll('#eval-question-list .apikey-row').length === 1);
    }
    for (let i = 0; i < 2; i++) {
      await click(page, '#eval-run-btn');
      await page.waitForFunction(() => /Done\./.test(document.querySelector('#eval-status')?.textContent || ''), { timeout: 120_000 });
    }

    // Two archived runs appear, defaulting to the older one as A and the newest as B.
    await page.waitForSelector('#eval-compare-btn', { visible: true });
    const picks = await page.evaluate(() => ({
      a: document.querySelector('#eval-compare-a')?.value || '',
      b: document.querySelector('#eval-compare-b')?.value || '',
      options: document.querySelectorAll('#eval-compare-a option').length,
    }));
    assert.ok(picks.a && picks.b && picks.a !== picks.b, 'the picker defaults to two different runs');
    assert.ok(picks.options >= 2, 'both runs are offered');

    await click(page, '#eval-compare-btn');
    await page.waitForSelector('.eval-compare-table', { visible: true });
    const labels = await page.$$eval('.eval-compare-table tbody th', (els) => els.map((el) => el.textContent.trim()));
    assert.deepStrictEqual(labels, ['Faithfulness', 'Answer relevancy', 'Context precision', 'Citation attribution F1'],
      'the table renders every metric from the server catalog');
    assert.strictEqual(await page.$$eval('.eval-compare-table tbody tr', (rows) => rows.length), 4,
      'one row per metric');
    const table = await page.evaluate(() => {
      const wrap = document.querySelector('.eval-compare-table-wrap');
      return { overflow: !!wrap && wrap.scrollWidth > wrap.clientWidth + 1 };
    });
    assert.strictEqual(table.overflow, false, 'the comparison table fits the desktop panel');
    assert.deepStrictEqual(await runAxe(page, '#eval-compare'), [], 'the comparison is accessible');

    // The table must stay inside a phone-width Settings dialog. It may scroll inside its own wrapper, but it
    // must never widen the page or push its container past the viewport.
    await page.setViewport({ width: 320, height: 568 });
    await page.waitForFunction(() => window.innerWidth <= 480);
    const narrow = await page.evaluate(() => {
      const wrap = document.querySelector('.eval-compare-table-wrap');
      const modal = document.querySelector('#settings-overlay .modal-box');
      return {
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        tableInside: !!wrap && wrap.getBoundingClientRect().right <= window.innerWidth + 1,
        modalInside: !!modal && modal.getBoundingClientRect().right <= window.innerWidth + 1,
      };
    });
    assert.strictEqual(narrow.pageOverflow, 0, 'the comparison does not widen the page on a phone');
    assert.strictEqual(narrow.tableInside, true, 'the comparison table stays inside the phone viewport');
    assert.strictEqual(narrow.modalInside, true, 'the Settings dialog still fits the phone viewport');
  });
});

test(`${BROWSER_LABEL}: citations export from an answer and import as documents`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await newConversation(page);
    await page.type('#message-input', QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .sources-row');

    // The answer menu offers the export, and its dialog names the format without any network work.
    await click(page, '#chat-box .answer-menu-btn');
    await page.waitForSelector('#chat-box .answer-menu-list', { visible: true });
    await click(page, '#chat-box .ans-cite-export');
    await page.waitForSelector('#cite-export-overlay', { visible: true });
    assert.ok(/citation/i.test(await getText(page, '#cite-export-note')), 'the export dialog says what will be saved');
    assert.deepStrictEqual(await runAxe(page, '#cite-export-overlay'), [], 'the export dialog is accessible');
    await click(page, '#cite-export-cancel');
    await page.waitForFunction(() => document.querySelector('#cite-export-overlay')?.classList.contains('hidden'));

    // The export route returns a real RIS file built from the same mapping the import accepts.
    const exported = await page.evaluate(async () => {
      const res = await fetch('/api/documents/citations/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'ris', sources: [{ source: 'Round-trip source', isWeb: true, url: 'https://example.org/round-trip', snippet: 'Summary.' }] }),
      });
      return { ok: res.ok, type: res.headers.get('content-type') || '', text: await res.text() };
    });
    assert.strictEqual(exported.ok, true, 'the export route succeeds');
    assert.ok(/research-info-systems/.test(exported.type), 'the export has the RIS content type');
    assert.ok(/TY  - ELEC/.test(exported.text) && /https:\/\/example\.org\/round-trip/.test(exported.text),
      'the export carries the source as RIS');

    // Import the same shape through the panel; each entry becomes a listed document.
    await click(page, '#docs-toggle');
    await page.waitForSelector('#doc-panel', { visible: true });
    // Wait out the drawer's slide/fade so the click lands on the panel's final position.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#doc-panel')).opacity === '1');
    await click(page, '#cite-import-btn');
    await page.waitForSelector('#cite-import-overlay', { visible: true });
    await page.type('#cite-import-text', 'TY  - GEN\nTI  - Citation import check\nAU  - Doe, Jane\nPY  - 2026\nER  - \n');
    assert.deepStrictEqual(await runAxe(page, '#cite-import-overlay'), [], 'the import dialog is accessible');
    await click(page, '#cite-import-go');
    await page.waitForFunction(() => /Imported 1 reference/.test(document.querySelector('#cite-import-status')?.textContent || ''));
    await page.waitForFunction(() => document.querySelector('#cite-import-overlay')?.classList.contains('hidden'));
    await page.waitForFunction(() => [...document.querySelectorAll('#doc-list-wrap .doc-item')]
      .some((el) => /citation[- ]import[- ]check/i.test(el.textContent || '')));

    // Clean up so the imported reference cannot affect a later test.
    const relPath = await page.evaluate(() => {
      const item = [...document.querySelectorAll('#doc-list-wrap .doc-item')]
        .find((el) => /citation[- ]import[- ]check/i.test(el.textContent || ''));
      return item ? item.querySelector('.di-del')?.getAttribute('data-path') || '' : '';
    });
    assert.ok(relPath, 'the imported reference is a removable document');
    await page.evaluate(async (p) => {
      const res = await fetch('/api/documents?path=' + encodeURIComponent(p), { method: 'DELETE' });
      if (!res.ok) throw new Error('cleanup delete failed');
    }, relPath);
    await click(page, '#refresh-docs');
    await page.waitForFunction(() => ![...document.querySelectorAll('#doc-list-wrap .doc-item')]
      .some((el) => /citation[- ]import[- ]check/i.test(el.textContent || '')));
  });
});

test(`${BROWSER_LABEL}: the new answer, document, settings, and Guide surfaces are accessible`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await newConversation(page);
    await page.type('#message-input', QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .sources-row');
    await page.waitForSelector('#chat-box .answer-actions');
    await waitForAnimations(page, '#chat-box .sources-row, #chat-box .answer-actions');

    // The answer menu is a real menu; keep it open while axe inspects the answer surface.
    await click(page, '#chat-box .answer-menu-btn');
    await page.waitForSelector('#chat-box .answer-menu-list', { visible: true });
    assert.deepStrictEqual(await runAxe(page, '#chat-box'), [], 'answer surface');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
      return !!list && list.hidden;
    });

    // The document panel, with its filter and single source row.
    await click(page, '#docs-toggle');
    await page.waitForSelector('#doc-panel', { visible: true });
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length >= 1);
    // Wait out the drawer's 200 ms opacity transition; axe measures blended colors mid-transition.
    await page.waitForFunction(() => {
      const p = document.querySelector('#doc-panel');
      return !!p && getComputedStyle(p).opacity === '1';
    });
    assert.deepStrictEqual(await runAxe(page, '#doc-panel'), [], 'document panel');
    await page.type('#doc-search-input', 'zz-no-match');
    await page.waitForFunction(() => /No documents match/.test(document.querySelector('#doc-list-empty')?.textContent || ''));
    assert.deepStrictEqual(await runAxe(page, '#doc-panel'), [], 'document filter empty state');
    await click(page, '#doc-search-clear');

    // Settings with Advanced open and the OCR language grid visible.
    await click(page, '#settings-btn');
    await page.waitForFunction(() => {
      const save = document.querySelector('#settings-save');
      return !!save && !save.disabled;
    });
    await page.$eval('.settings-advanced', (el) => { el.open = true; });
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-use-ocr');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#cfg-ocr-languages input').length > 10);
    assert.deepStrictEqual(await runAxe(page, '#settings-overlay'), [], 'settings advanced + OCR languages');
    await click(page, '#settings-cancel');

    // The Guide (the shipped README) and its search/highlight path.
    await page.evaluate(() => document.getElementById('help-btn').click());
    await page.waitForSelector('#help-overlay', { visible: true });
    await page.waitForFunction(() => !!document.querySelector('#help-body h1, #help-body h2'));
    assert.deepStrictEqual(await runAxe(page, '#help-overlay'), [], 'guide');
    await page.type('#help-search-input', 'OCR');
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector('#help-count')?.textContent || ''));
    assert.ok((await page.$$eval('#help-body .help-hit', (els) => els.length)) > 0, 'Guide search highlights matches');
    assert.deepStrictEqual(await runAxe(page, '#help-overlay'), [], 'guide search results');
  });
});

test(`${BROWSER_LABEL}: a large document list stays responsive to filtering`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    // Replace only the document list with a large synthetic corpus, then reload so the panel renders it.
    // A page-level fetch override (rather than request interception) is used because the app's service
    // worker is a network pass-through and can bypass Puppeteer's request interception.
    await page.evaluateOnNewDocument(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        let u;
        try { u = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href); }
        catch { return originalFetch(input, init); }
        if (u.pathname !== '/api/documents') return originalFetch(input, init);
        const documents = Array.from({ length: 1500 }, (_, i) => {
          const n = String(i + 1).padStart(4, '0');
          const folder = `folder-${String(Math.floor(i / 50) + 1).padStart(2, '0')}`;
          return {
            name: `Report ${n}.pdf`,
            path: `/synthetic/${folder}/Report ${n}.pdf`,
            relPath: `${folder}/Report ${n}.pdf`,
            size: 1024,
            modified: new Date(0).toISOString(),
            indexed: true,
            docId: `synthetic-${n}`,
            viewerLink: `/document/view?path=${encodeURIComponent(`/synthetic/${folder}/Report ${n}.pdf`)}`,
          };
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, documents }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await click(page, '#docs-toggle');
    await page.waitForSelector('#doc-panel', { visible: true });
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length === 1500, { timeout: 30_000 });

    const started = Date.now();
    await page.type('#doc-search-input', 'Report 1499');
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length === 1, { timeout: 10_000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `filtering 1,500 documents responds promptly (${elapsed} ms)`);
    assert.ok((await page.$eval('#doc-search-input', (el) => el.value)) === 'Report 1499');
    // Let the drawer's opening transition settle before measuring the page width; a mid-transition frame is not
    // a layout overflow.
    await page.waitForFunction(() => {
      const p = document.querySelector('#doc-panel');
      return !!p && getComputedStyle(p).opacity === '1';
    });
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.strictEqual(noOverflow, true, 'the large list does not force horizontal page scroll');

    await click(page, '#doc-search-clear');
    await page.waitForFunction(() => document.querySelectorAll('#doc-list-wrap .doc-item').length === 1500, { timeout: 30_000 });
  });
});

test(`${BROWSER_LABEL}: the chat and settings surfaces have no serious accessibility violations`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    assert.deepStrictEqual(await runAxe(page), []);
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    assert.deepStrictEqual(await runAxe(page, '#settings-overlay'), [], 'settings advanced + OCR languages');
  });
});

// Install a deterministic Web Speech API before any page script runs. The browser's real voices differ per
// machine (and some engines have none), so the test supplies a local Spanish voice, an online Spanish voice,
// and a local English voice, then records what the app asks it to speak.
const installSpeechStub = () => {
  const state = { spoken: [], cancelled: 0, current: null, onlineOnly: false, silent: false, noVoices: false };
  window.__speech = state;
  const localSpanish = { name: 'System Spanish (local)', lang: 'es-ES', localService: true, default: true };
  const localSpanishAlt = { name: 'System Spanish (alternate)', lang: 'es-ES', localService: true, default: false };
  const onlineSpanish = { name: 'System Spanish (online)', lang: 'es-ES', localService: false, default: false };
  const english = { name: 'System English (local)', lang: 'en-US', localService: true, default: true };
  const french = { name: 'System French (local)', lang: 'fr-FR', localService: true, default: true };
  // Installed Norwegian voices are tagged nb-NO, never `no`. This guards the catalog alias that makes them
  // reachable for the `no` entry.
  const norwegian = { name: 'System Norwegian (local)', lang: 'nb-NO', localService: true, default: true };
  const voicesNow = () => state.noVoices ? [] : (state.onlineOnly ? [onlineSpanish, english, french, norwegian] : [localSpanish, localSpanishAlt, onlineSpanish, english, french, norwegian]);
  const fake = {
    getVoices: () => voicesNow(),
    speak(u) {
      state.spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate });
      state.current = u;
      if (state.silent) return;
      setTimeout(() => { try { if (u.onstart) u.onstart(); } catch { /* test stub */ } }, 0);
    },
    cancel() { state.cancelled++; state.current = null; },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
    get speaking() { return !!state.current; },
    get pending() { return false; },
    get paused() { return false; },
  };
  class Utterance {
    constructor(text) {
      this.text = text; this.lang = ''; this.voice = null;
      this.rate = 1; this.pitch = 1; this.volume = 1;
      this.onstart = null; this.onend = null; this.onerror = null;
    }
  }
  try { Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true }); }
  catch { window.speechSynthesis = fake; }
  try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true }); }
  catch { window.SpeechSynthesisUtterance = Utterance; }
  window.__finishSpeech = () => {
    const u = state.current; state.current = null;
    if (u && u.onend) { try { u.onend(); } catch { /* test stub */ } }
  };
};

test(`${BROWSER_LABEL}: a non-English answer reads aloud with the chosen system voice`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    // Turn read-aloud on and force Spanish. Forcing the language makes the route deterministic and avoids any
    // bundled English model work. The helper also pins the alternate local voice without saving yet.
    await openSpanishSystemVoiceSettings(page);
    const previewBefore = await page.evaluate(() => window.__speech.spoken.length);
    await page.click('#cfg-tts-system-preview');
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, previewBefore);
    const preview = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(preview.voice, 'System Spanish (alternate)', 'the preview uses the chosen system voice');
    assert.strictEqual(preview.lang, 'es-ES', 'the preview speaks in the selected language');
    await page.click('#cfg-tts-system-preview');
    await page.waitForFunction(() => {
      const b = document.querySelector('#cfg-tts-system-preview');
      return !!b && !b.classList.contains('playing') && !b.classList.contains('loading');
    });
    await page.evaluate(() => { document.querySelector('#cfg-tts-voices-details').open = true; });
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-voices-list .tts-voice-row').length > 10);
    // The one alias path a real device depends on: an nb-NO voice must count as Norwegian (`no`).
    const norwegianRow = await page.$$eval('#cfg-tts-voices-list .tts-voice-row', (rows) => {
      const row = rows.find((r) => (r.querySelector('.tts-voice-lang')?.textContent || '') === 'Norwegian');
      return row ? (row.querySelector('.tts-voice-detail')?.textContent || '') : '';
    });
    assert.ok(/System Norwegian \(local\)/.test(norwegianRow),
      'a voice tagged nb-NO is matched to the Norwegian catalog entry');
    const rowFit = await page.evaluate(() => {
      const fits = (el) => !!el && el.scrollWidth <= el.clientWidth + 1;
      const row = document.querySelector('#cfg-tts-system-voice-row');
      return fits(row) && fits(row && row.querySelector('label'));
    });
    assert.ok(rowFit, 'the system-voice row and its label fit without clipping');
    assert.deepStrictEqual(await runAxe(page, '#settings-overlay'), [], 'settings voice + language + diagnostics controls');

    // An empty voice list must not leave a dead preview button. It stays operable, explains the state, and
    // recovers as soon as a voice appears.
    await page.evaluate(() => { window.__speech.noVoices = true; refreshSystemVoiceList({ restart: true }); });
    await page.waitForFunction(() => document.querySelector('#cfg-tts-system-preview')?.classList.contains('unavailable'));
    assert.strictEqual(await page.$eval('#cfg-tts-system-preview', (el) => el.disabled), false,
      'the preview is not silently disabled when no voice is reported');
    assert.ok(/looking for installed voices/i.test(await getText(page, '#cfg-tts-system-status')),
      'the status says voices are still being looked up');
    const emptyState = await page.evaluate(() => {
      const status = document.querySelector('#cfg-tts-system-status');
      const none = [...document.querySelector('#cfg-tts-system-voice').options]
        .find((o) => /looking for installed voices/i.test(o.textContent));
      return {
        explained: !!none && none.disabled,
        statusFits: status.scrollWidth <= status.clientWidth + 1,
      };
    });
    assert.ok(emptyState.explained, 'the empty voice list explains that it is still loading');
    assert.ok(emptyState.statusFits, 'the status line fits its row without clipping');
    await page.evaluate(() => { window.__speech.noVoices = false; refreshSystemVoiceList({ restart: true }); });
    await page.waitForFunction(() => !document.querySelector('#cfg-tts-system-preview')?.classList.contains('unavailable'));
    await saveSettings(page);

    // Ask a Spanish question; the stub provider answers in Spanish and the server tags the answer `es`.
    await newConversation(page);
    await page.type('#message-input', SPANISH_QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .readaloud-btn');
    const title = await page.$eval('#chat-box .readaloud-btn', (el) => el.title);
    assert.ok(/Spanish system voice/i.test(title), `the button names the system voice path (title: ${title})`);

    // Start: the pinned local Spanish voice is chosen and the utterance carries a Spanish tag.
    const answerBefore = await page.evaluate(() => window.__speech.spoken.length);
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, answerBefore);
    const spoke = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(spoke.lang, 'es-ES', 'the utterance uses the Spanish speech region');
    assert.strictEqual(spoke.voice, 'System Spanish (alternate)', 'the saved per-language system voice is used');
    assert.ok(spoke.text.includes(CODE), 'the spoken text is the answer');
    await page.waitForFunction(() => /Stop/.test(document.querySelector('#chat-box .readaloud-btn')?.textContent || ''));
    assert.ok(/Stop/.test(await getText(page, '#chat-box .readaloud-btn')), 'the button switches to Stop while speaking');

    // Finishing one chunk advances to the next, so a long answer is spoken in full rather than clipped.
    await page.evaluate(() => window.__finishSpeech());
    await page.waitForFunction((n) => window.__speech.spoken.length > n + 1, {}, answerBefore);
    const second = await page.evaluate((n) => window.__speech.spoken[n + 1], answerBefore);
    assert.ok(/presupuesto/i.test(second.text), 'the next sentence is spoken after the first finishes');

    // Stop cancels the operating-system utterance and resets the button.
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => window.__speech.cancelled >= 1);
    await page.waitForFunction(() => /Read aloud/.test(document.querySelector('#chat-box .readaloud-btn')?.textContent || ''));

    // Hands-free read-back goes through the same language-aware route and pinned voice. Drive the read-back
    // directly (the microphone/transcription path is separate) so the test stays deterministic and offline.
    const hfBefore = await page.evaluate(() => window.__speech.spoken.length);
    await page.evaluate((text) => { HF.active = true; HF.busy = true; handsfreeSpeak(text, 'es'); }, SPANISH_ANSWER);
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, hfBefore);
    const hfSpoke = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(hfSpoke.lang, 'es-ES', 'hands-free read-back speaks the answer language');
    assert.strictEqual(hfSpoke.voice, 'System Spanish (alternate)', 'hands-free read-back uses the saved voice');
    await page.waitForFunction(() => HF.speakStart > 0);
    await page.evaluate(() => { stopHandsfree(); });

    // Per-answer override: choose French from the More menu. The dialog is a real modal and reads with the
    // French system voice without changing the saved Spanish preference.
    await click(page, '#chat-box .answer-menu-btn');
    await page.waitForSelector('#chat-box .answer-menu-list', { visible: true });
    await waitForAnimations(page, '#chat-box .sources-row, #chat-box .answer-actions, #chat-box .readaloud-btn, #chat-box .answer-menu-list');
    assert.deepStrictEqual(await runAxe(page, '#chat-box'), [], 'answer menu with the Read as action');
    await click(page, '#chat-box .answer-menu-list .ans-readas');
    await page.waitForSelector('#readas-overlay', { visible: true });
    await waitForAnimations(page, '#readas-overlay .readas-body');
    assert.ok(/Spanish/.test(await getText(page, '#readas-detected')), 'the dialog shows the detected language');
    assert.deepStrictEqual(await runAxe(page, '#readas-overlay'), [], 'read-as language dialog');
    await page.select('#readas-language', 'fr');
    const frBefore = await page.evaluate(() => window.__speech.spoken.length);
    await page.click('#readas-go');
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, frBefore);
    const frSpoke = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(frSpoke.lang, 'fr-FR', 'the per-answer override speaks the chosen language');
    assert.strictEqual(frSpoke.voice, 'System French (local)', 'the per-answer override uses that language’s voice');
    await page.waitForFunction(() => document.querySelector('#chat-box .readaloud-btn')?.getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => /French system voice/.test(document.querySelector('#a11y-live')?.textContent || ''));
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => document.querySelector('#chat-box .readaloud-btn')?.getAttribute('aria-pressed') === 'false');
    assert.ok(/Read aloud/.test(await getText(page, '#chat-box .readaloud-btn')), 'the answer control is idle again after the override');

    // A silent system engine (voices exist, but speak never starts) must time out and reset instead of leaving
    // a permanent loading button.
    await page.evaluate(() => { window.__speech.silent = true; });
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-error')].some((el) => /Could not start a .* system voice/.test(el.textContent || '')), { timeout: 7000 });
    await page.waitForFunction(() => document.querySelector('#chat-box .readaloud-btn')?.getAttribute('aria-pressed') === 'false');
    await page.evaluate(() => { window.__speech.silent = false; });

    // With only an online voice installed, read-aloud declines until the user opts in — it must not reach the
    // network silently.
    const before = await page.evaluate(() => window.__speech.spoken.length);
    await page.evaluate(() => { window.__speech.onlineOnly = true; });
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-error')].some((el) => /Only an online voice is available/.test(el.textContent || '')));
    assert.strictEqual(await page.evaluate(() => window.__speech.spoken.length), before,
      'an online-only voice is not used without the opt-in');

    // Explicitly allow online voices, save, and the same control now speaks with that voice.
    await click(page, '#settings-btn');
    await waitForSettingsReady(page);
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-tts-online-voices');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await saveSettings(page);
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, before);
    const online = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(online.voice, 'System Spanish (online)', 'the opted-in online voice is used when no local voice exists');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-info')].some((el) => /online .*voice/i.test(el.textContent || '')));
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => /Read aloud/.test(document.querySelector('#chat-box .readaloud-btn')?.textContent || ''));

    // The picker also names the network consequence before the next use.
    await click(page, '#settings-btn');
    await waitForSettingsReady(page);
    assert.ok(/online voice/i.test(await getText(page, '#cfg-tts-system-status')),
      'Settings marks a network-backed voice as online');
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
    await page.evaluate(() => { document.getElementById('settings-cancel')?.click(); });
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));

    // Leave the shared temporary config as it started, so later runs/tests are unaffected.
    await resetReadAloudSettings(page);
  }, installSpeechStub);
});

test(`${BROWSER_LABEL}: voice preferences are independent of read-aloud playback`, { timeout: 60_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-tts-enabled');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-language option').length > 5);
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-system-language option').length > 5);
    // Keep read-aloud on Automatic, but browse French in the voice-language picker and pin its voice.
    await page.select('#cfg-tts-system-language', 'fr');
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-system-voice option').length > 1);
    await page.evaluate(() => {
      const sel = document.querySelector('#cfg-tts-system-voice');
      const opt = [...sel.options].find((o) => /French/i.test(o.textContent));
      if (!opt) throw new Error('the test stub French voice is missing');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await saveSettings(page);

    // Reopen: playback stays Automatic, the French browsing context and pinned voice are still there.
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    await page.waitForFunction(() => document.querySelector('#cfg-tts-system-language')?.value === 'fr');
    assert.strictEqual(await page.$eval('#cfg-tts-language', (el) => el.value), 'auto', 'playback stays Automatic');
    assert.ok(/French/i.test(await page.$eval('#cfg-tts-system-voice', (el) => el.selectedOptions[0]?.textContent || '')),
      'the French voice stays pinned while playback is Automatic');

    // A language with no saved preference shows Automatic; switching back restores the pinned French voice.
    await page.select('#cfg-tts-system-language', 'es');
    await page.waitForFunction(() => document.querySelector('#cfg-tts-system-voice')?.value === '');
    await page.select('#cfg-tts-system-language', 'fr');
    await page.waitForFunction(() => /French/i.test(document.querySelector('#cfg-tts-system-voice')?.selectedOptions?.[0]?.textContent || ''));

    // A cancelled edit must not stick: changing the read-aloud language (which also moves the browsing picker)
    // and closing with Cancel is discarded, so reopening shows the saved Automatic language and French voice.
    await page.select('#cfg-tts-language', 'es');
    await page.waitForFunction(() => document.querySelector('#cfg-tts-system-language')?.value === 'es');
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); document.getElementById('settings-cancel')?.click(); });
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));

    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    await page.waitForFunction(() => document.querySelector('#cfg-tts-system-language')?.value === 'fr');
    assert.strictEqual(await page.$eval('#cfg-tts-language', (el) => el.value), 'auto',
      'Cancel restores the saved read-aloud language');
    assert.ok(/French/i.test(await page.$eval('#cfg-tts-system-voice', (el) => el.selectedOptions[0]?.textContent || '')),
      'Cancel keeps the saved French voice');

    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); document.getElementById('settings-cancel')?.click(); });
    await page.waitForFunction(() => document.querySelector('#settings-overlay')?.classList.contains('hidden'));
    await resetReadAloudSettings(page);
  }, installSpeechStub);
});

test(`${BROWSER_LABEL}: enabling read-aloud updates live answers and restore keeps the voice`, { timeout: 90_000 }, async (t) => {
  // Storage is intentionally preserved across the reload: the tab's session id is what makes restore work.
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    // Start from a genuinely fresh tab once, then stop clearing storage so the session survives the reload below.
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage unavailable */ } });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForReady(page);
    // Establish a known starting point even if a prior test's cleanup was interrupted.
    await resetReadAloudSettings(page);

    // Start with read-aloud off, ask in Spanish, and confirm the answer has no audio control yet.
    await newConversation(page);
    await page.type('#message-input', SPANISH_QUESTION);
    await page.keyboard.press('Enter');
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .answer-actions');
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('#chat-box .readaloud-btn')), false,
      'no Read aloud control while the feature is off');

    // Enabling the feature must reach the answer already on screen — no reload required.
    await openSpanishSystemVoiceSettings(page);
    await saveSettings(page);
    await page.waitForSelector('#chat-box .readaloud-btn');
    const liveTitle = await page.$eval('#chat-box .readaloud-btn', (el) => el.title);
    assert.ok(/Spanish system voice/i.test(liveTitle), `the existing answer gets the language-aware control (title: ${liveTitle})`);

    // Give the fire-and-forget session save a moment, then reload. The restored answer must keep its language
    // and pinned voice, and play with that voice.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForReady(page);
    await waitForText(page, '#chat-box', CODE);
    await page.waitForSelector('#chat-box .readaloud-btn');
    const restoredTitle = await page.$eval('#chat-box .readaloud-btn', (el) => el.title);
    assert.ok(/Spanish system voice/i.test(restoredTitle), `the restored answer keeps its language (title: ${restoredTitle})`);

    const before = await page.evaluate(() => window.__speech.spoken.length);
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, before);
    const spoke = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(spoke.lang, 'es-ES', 'the restored answer speaks in its saved language');
    assert.strictEqual(spoke.voice, 'System Spanish (alternate)', 'the restored answer uses the saved system voice');
    await page.click('#chat-box .readaloud-btn');
    await page.waitForFunction(() => /Read aloud/.test(document.querySelector('#chat-box .readaloud-btn')?.textContent || ''));

    // Changing the read-aloud language re-labels the answer already on screen, with no reload and no re-ask.
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    await page.waitForFunction(() => document.querySelectorAll('#cfg-tts-language option').length > 5);
    await page.select('#cfg-tts-language', 'fr');
    await saveSettings(page);
    await page.waitForFunction(() => /French system voice/i.test(document.querySelector('#chat-box .readaloud-btn')?.title || ''));
    const frenchTitle = await page.$eval('#chat-box .readaloud-btn', (el) => el.title);
    assert.ok(/French system voice/i.test(frenchTitle), `a language change updates the live control (title: ${frenchTitle})`);

    // Turning the feature off removes both the control and its Read as menu entry, so no dead action remains.
    await click(page, '#settings-btn');
    await page.waitForSelector('#settings-overlay', { visible: true });
    await waitForSettingsReady(page);
    await page.evaluate(() => {
      const cb = document.querySelector('#cfg-tts-enabled');
      if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await saveSettings(page);
    await page.waitForFunction(() => !document.querySelector('#chat-box .readaloud-btn'));
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('#chat-box .ans-readas')), false,
      'the Read as menu entry goes with the removed control');

    await resetReadAloudSettings(page, 'es');
  }, installSpeechStub, { resetStorage: false });
});

test(`${BROWSER_LABEL}: a hands-free utterance answers and reads back in its language`, { timeout: 90_000 }, async (t) => {
  await withPage(t, { width: 1280, height: 800 }, async (page) => {
    await openSpanishSystemVoiceSettings(page);
    await saveSettings(page);
    await newConversation(page);

    // Drive the real hands-free utterance chain — synthetic PCM → local resampling → /api/stt → question →
    // answer → language-aware read-back — without a microphone or the VAD capture graph. The transcript stub is
    // the only substituted boundary; the rest is production code.
    await page.evaluate((transcript) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (u.startsWith('/api/stt')) {
          return Promise.resolve(new Response(JSON.stringify({ transcript }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        return originalFetch(input, init);
      };
      HF.active = true;
      HF.busy = true;
    }, SPANISH_QUESTION);

    const before = await page.evaluate(() => window.__speech.spoken.length);
    await page.evaluate(async () => {
      const rate = 48000;
      await finalizeHandsfreeUtterance([new Float32Array(rate * 0.5)], rate);
    });
    await waitForText(page, '#chat-box', CODE);
    await page.waitForFunction((n) => window.__speech.spoken.length > n, {}, before);
    const spoke = await page.evaluate(() => window.__speech.spoken[window.__speech.spoken.length - 1]);
    assert.strictEqual(spoke.lang, 'es-ES', 'the hands-free answer is read in its language');
    assert.strictEqual(spoke.voice, 'System Spanish (alternate)', 'the hands-free answer uses the saved voice');
    await page.evaluate(() => { stopHandsfree(); });

    await resetReadAloudSettings(page);
  }, installSpeechStub);
});
