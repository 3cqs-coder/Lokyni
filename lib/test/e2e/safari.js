'use strict';
// Safari rendering-engine pass, driven through the WebDriver that ships with macOS.
//
// Safari cannot be driven by Puppeteer, so the main browser suite covers Chromium and Firefox while this
// script covers the same high-risk surfaces in Safari: the streamed answer, a non-English answer, the single
// source row, the answer menu, the document filter and viewer, theme and text size, the Guide, read-aloud
// controls, the phone Tools sheet, and an axe audit. It starts the same deterministic harness as the main
// suite, so no model or credential is involved.
//
// Safari only accepts a WebDriver session after a one-time setting is enabled:
//   Safari > Settings > Advanced > Show features for web developers
//   Develop > Allow Remote Automation
// This script detects the missing permission, prints those steps, and exits with code 2 instead of failing
// with a raw protocol error. When the permission is present, run `npm run e2e:safari`, or dispatch the
// "Safari pass" workflow on a macOS runner. `--probe` checks only whether a session can be created and used,
// so CI can skip the pass when the runner cannot be set up manually.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { startHarness, freePort } = require('./harness');
const { QUESTION, CODE, SPANISH_QUESTION, SPANISH_ANSWER } = require('./fixtures');

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const SAFARIDRIVER = fs.existsSync('/usr/bin/safaridriver') ? '/usr/bin/safaridriver' : 'safaridriver';
const RESULTS_DIR = path.join(process.cwd(), 'test-results');
const START_TIMEOUT_MS = 20_000;
const KEY = { enter: '\uE007', escape: '\uE00C', arrowDown: '\uE015' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WebDriverError extends Error {
  constructor(method, route, value) {
    super(`${method} ${route}: ${value && (value.message || value.error) ? (value.message || value.error) : 'unknown error'}`);
    this.error = (value && value.error) || 'unknown error';
    this.value = value;
  }
}

class Driver {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
    this.lastScreenshot = 0;
  }

  async request(method, route, body, timeoutMs = 90_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + route, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = {};
      if (text) {
        try { payload = JSON.parse(text); }
        catch { throw new Error(`${method} ${route} returned non-JSON: ${text.slice(0, 200)}`); }
      }
      if (!res.ok || (payload.value && payload.value.error)) {
        throw new WebDriverError(method, route, payload.value || {});
      }
      return payload.value;
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const value = await this.request('GET', '/status', undefined, 2000);
    return !!value && value.ready === true;
  }

  async createSession() {
    const value = await this.request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    this.sessionId = value.sessionId || (value.capabilities && value.capabilities.sessionId);
    if (!this.sessionId) throw new Error('Safari returned a session without an id.');
    await this.request('POST', `/session/${this.sessionId}/timeouts`, { script: 180_000, pageLoad: 60_000, implicit: 0 });
  }

  exec(script, ...args) {
    return this.request('POST', `/session/${this.sessionId}/execute/sync`, { script, args });
  }

  execAsync(script, ...args) {
    return this.request('POST', `/session/${this.sessionId}/execute/async`, { script, args });
  }

  async url(url) {
    await this.request('POST', `/session/${this.sessionId}/url`, { url });
  }

  async rect(width, height) {
    await this.request('POST', `/session/${this.sessionId}/window/rect`, { x: 20, y: 40, width, height });
  }

  async key(value) {
    await this.request('POST', `/session/${this.sessionId}/actions`, {
      actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
    });
    await this.request('DELETE', `/session/${this.sessionId}/actions`);
  }

  async screenshot(name) {
    const base64 = await this.request('GET', `/session/${this.sessionId}/screenshot`);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  }

  // Poll a JavaScript expression until it is truthy. Navigation can briefly make the document unavailable,
  // so a failed evaluation counts as "not yet" rather than a hard error.
  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.exec(`return (${expression});`);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${label}${last === null ? '' : ` (last result: ${JSON.stringify(last).slice(0, 300)})`}`);
  }

  async waitSettled(selector, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const done = await this.exec(`return (() => {
        const els = [...document.querySelectorAll(arguments[0])];
        return els.length > 0 && els.every((el) => el.getAnimations().every((a) => a.playState === 'finished'));
      })()`, selector).catch(() => false);
      if (done) return;
      await sleep(100);
    }
  }

  async click(selector) {
    const clicked = await this.exec(`return (() => {
      const el = document.querySelector(arguments[0]);
      if (!el) return false;
      // A real pointer press focuses the control before activating it. WebDriver's execute/sync does not,
      // and the app restores focus to whichever control opened a dialog, so mirror the browser here.
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
      el.click();
      return true;
    })()`, selector);
    assert.strictEqual(clicked, true, `no element to click for ${selector}`);
  }

  async setValue(selector, value) {
    const changed = await this.exec(`return (() => {
      const el = document.querySelector(arguments[0]);
      if (!el) return false;
      el.focus();
      el.value = arguments[1];
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, selector, value);
    assert.strictEqual(changed, true, `no field to fill for ${selector}`);
  }

  async setChecked(selector, checked) {
    const changed = await this.exec(`return (() => {
      const el = document.querySelector(arguments[0]);
      if (!el) return false;
      if (el.checked !== arguments[1]) {
        el.checked = arguments[1];
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return el.checked === arguments[1];
    })()`, selector, checked);
    assert.strictEqual(changed, true, `could not set ${selector} to ${checked}`);
  }

  async axe(rootSelector) {
    if (!(await this.exec('return typeof window.axe === "object" && typeof window.axe.run === "function";'))) {
      await this.exec(AXE_SOURCE);
    }
    const result = await this.execAsync(`const done = arguments[arguments.length - 1];
      const root = arguments[0] ? document.querySelector(arguments[0]) : document;
      if (!root) { done({ error: 'missing root ' + arguments[0] }); return; }
      window.axe.run(root, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        resultTypes: ['violations'],
      }).then((report) => done({ violations: report.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })) }))
        .catch((error) => done({ error: String(error && error.message ? error.message : error) }));`, rootSelector)
      .catch((error) => ({ error: error.message }));
    if (result.error) throw new Error(`axe could not audit ${rootSelector}: ${result.error}`);
    return result.violations;
  }

  async close() {
    if (this.sessionId) {
      await this.request('DELETE', `/session/${this.sessionId}`, undefined, 15_000).catch(() => {});
      this.sessionId = null;
    }
  }
}

const prereqMessage = (detail) => [
  '',
  'Safari did not allow a WebDriver session.',
  '',
  'Enable it once:',
  '  1. Safari > Settings > Advanced > turn on "Show features for web developers"',
  '  2. In the Develop menu, turn on "Allow Remote Automation"',
  '  3. Run `npm run e2e:safari` again',
  '',
  `Driver said: ${detail}`,
  '',
].join('\n');

const startDriver = async () => {
  const port = await freePort();
  const child = spawn(SAFARIDRIVER, ['-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const collect = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const driver = new Driver(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`safaridriver exited (code ${child.exitCode}).\n${logs.join('')}`);
    if (await driver.status().catch(() => false)) return { driver, child, logs };
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`safaridriver did not become ready within ${START_TIMEOUT_MS} ms.\n${logs.join('')}`);
};

const stopDriver = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
};

// A capability probe for CI: start the driver and open/close one session, with no harness or app server. Exit 0
// only when Safari can actually be driven, so a workflow can skip the pass on a runner where remote automation
// has not been enabled manually instead of failing a build for an environment limitation. Once the probe passes,
// a failure in the real pass is a real failure.
const probe = async () => {
  let driver = null;
  let driverProcess = null;
  try {
    const started = await startDriver();
    driver = started.driver;
    driverProcess = started.child;
    await driver.createSession();
    // A session alone is not enough: confirm the browser can navigate and execute script. This separates a
    // usable Safari window from a driver that accepts a session but cannot render anything.
    await driver.url('about:blank');
    if (!(await driver.exec('return document.readyState === "complete";'))) {
      throw new Error('Safari WebDriver opened a session but could not execute script on about:blank.');
    }
    return 0;
  } catch (error) {
    if (/remote automation/i.test(error.message)) {
      console.error(prereqMessage(error.message));
    } else {
      console.error(`\nSafari WebDriver is not available on this runner: ${error.message}`);
      console.error('Enable it manually with Safari > Settings > Advanced > "Show features for web developers", then Develop > "Allow Remote Automation".');
    }
    return 1;
  } finally {
    if (driver) await driver.close();
    await stopDriver(driverProcess);
  }
};

const ask = async (driver) => {
  await driver.setValue('#message-input', QUESTION);
  await driver.key(KEY.enter);
  await driver.waitFor(`(document.querySelector('#chat-box')?.textContent || '').includes(${JSON.stringify(CODE)})`, 'the streamed answer', 90_000);
  await driver.waitFor(`!!document.querySelector('#chat-box .answer-actions')`, 'the answer action strip', 30_000);
  await driver.waitSettled('#chat-box .sources-row, #chat-box .answer-actions');
};

const main = async () => {
  let harness = null;
  let driverProcess = null;
  let driver = null;
  let failed = 0;
  const started = Date.now();

  try {
    harness = await startHarness();
    const startedDriver = await startDriver();
    driver = startedDriver.driver;
    driverProcess = startedDriver.child;

    try {
      await driver.createSession();
    } catch (error) {
      if (/remote automation/i.test(error.message)) {
        console.error(prereqMessage(error.message));
        return 2;
      }
      throw error;
    }

    const steps = [];
    const step = async (name, fn) => {
      const began = Date.now();
      process.stdout.write(`• ${name} … `);
      try {
        await fn();
        const ms = Date.now() - began;
        console.log(`ok (${ms} ms)`);
        steps.push({ name, ms });
      } catch (error) {
        console.log('FAILED');
        failed++;
        try {
          const file = await driver.screenshot(`safari-failure-${steps.length + 1}`);
          console.error(`  screenshot: ${file}`);
        } catch { /* the screenshot is diagnostic only */ }
        throw error;
      }
    };

    await driver.url(harness.url);
    await driver.waitFor(`document.readyState === 'complete'`, 'the first page load', 60_000);
    await driver.exec('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true;');
    await driver.url(harness.url);
    await driver.waitFor(`/1\\s*doc/i.test(document.querySelector('#status-text')?.textContent || '')`, 'the index', 60_000);

    await step('the page loads with one indexed document', async () => {
      const state = await driver.exec(`return (() => ({
        title: document.title,
        docs: document.querySelector('#status-text')?.textContent || '',
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        width: window.innerWidth,
      }))()`);
      assert.ok(/Lokyni/i.test(state.title), 'the document title names the app');
      assert.ok(/1\s*doc/i.test(state.docs), `the status reports one document, got ${state.docs}`);
      assert.strictEqual(state.overflow, false, `the desktop layout overflows at ${state.width}px`);
      await driver.rect(1280, 900);
      await driver.waitFor('window.innerWidth >= 900', 'the desktop window size', 10_000);
    });

    await step('an answer has one source row and a keyboard-complete menu', async () => {
      await ask(driver);
      const state = await driver.exec(`return (() => {
        const row = document.querySelector('#chat-box .sources-row');
        const menu = [...document.querySelectorAll('#chat-box .answer-menu-btn')].pop();
        return {
          rows: document.querySelectorAll('#chat-box .sources-row').length,
          label: row?.querySelector('.sources-label')?.textContent || '',
          legacy: document.querySelectorAll('#chat-box .answered-from').length,
          strip: !!document.querySelector('#chat-box .answer-actions'),
          haspopup: menu?.getAttribute('aria-haspopup'),
          answer: [...document.querySelectorAll('#chat-box .bubble')].map((b) => b.textContent).join(' '),
        };
      })()`);
      assert.strictEqual(state.rows, 1, 'the answer renders exactly one source row');
      assert.ok(/Sources \(\d+\)/.test(state.label), `the source row carries its count, got "${state.label}"`);
      assert.strictEqual(state.legacy, 0, 'the duplicate source strip is gone');
      assert.strictEqual(state.strip, true, 'the action strip is present');
      assert.strictEqual(state.haspopup, 'menu', 'the More control announces a menu');
      assert.ok(state.answer.includes(CODE), 'the answer carries the fixture fact');

      await driver.click('#chat-box .answer-menu-btn');
      await driver.waitFor(`(() => {
        const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
        return !!list && !list.hidden && document.activeElement === list.querySelector('.answer-menu-item');
      })()`, 'the open answer menu', 10_000);
      const first = await driver.exec('return document.activeElement.textContent.trim();');
      await driver.key(KEY.arrowDown);
      const second = await driver.exec('return document.activeElement.textContent.trim();');
      assert.notStrictEqual(second, first, 'ArrowDown moves to the next action');
      await driver.key(KEY.escape);
      await driver.waitFor(`(() => {
        const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
        return !!list && list.hidden && document.activeElement?.classList.contains('answer-menu-btn');
      })()`, 'Escape to close the menu and return focus', 10_000);

      await driver.click('#chat-box .answer-menu-btn');
      await driver.waitFor(`(() => {
        const list = [...document.querySelectorAll('#chat-box .answer-menu-list')].pop();
        return !!list && !list.hidden;
      })()`, 'the menu for the audit', 10_000);
      await driver.waitSettled('#chat-box .sources-row, #chat-box .answer-actions, #chat-box .answer-menu-list');
      assert.deepStrictEqual(await driver.axe('#chat-box'), [], 'the answer surface is accessible');
      await driver.key(KEY.escape);
      await driver.waitFor(`[...document.querySelectorAll('#chat-box .answer-menu-list')].pop()?.hidden === true`, 'the menu to close');
      await driver.screenshot('safari-answer');
    });

    await step('a non-English answer renders with its sources', async () => {
      const spanishPrefix = SPANISH_ANSWER.slice(0, 30);
      await driver.setValue('#message-input', SPANISH_QUESTION);
      await driver.key(KEY.enter);
      await driver.waitFor(`(document.querySelector('#chat-box')?.textContent || '').includes(${JSON.stringify(spanishPrefix)})`, 'the Spanish answer', 90_000);
      const state = await driver.exec(`return (() => {
        const rows = [...document.querySelectorAll('#chat-box .sources-row')];
        const last = rows[rows.length - 1];
        return {
          answer: [...document.querySelectorAll('#chat-box .bubble')].map((b) => b.textContent).join(' '),
          sources: rows.length,
          label: last?.querySelector('.sources-label')?.textContent || '',
        };
      })()`);
      assert.ok(state.answer.includes(spanishPrefix), 'the answer is rendered in the requested language');
      assert.strictEqual(state.sources, 2, 'each answer keeps its own source row');
      assert.ok(/Sources \(\d+\)/.test(state.label), 'the non-English source row carries its count');
      assert.deepStrictEqual(await driver.axe('#chat-box'), [], 'the non-English answer surface is accessible');
    });

    await step('documents can be filtered and opened by name', async () => {
      await driver.click('#docs-toggle');
      await driver.waitFor(`(() => {
        const panel = document.querySelector('#doc-panel');
        return !!panel && getComputedStyle(panel).opacity === '1';
      })()`, 'the document panel', 15_000);
      await driver.waitFor(`document.querySelectorAll('#doc-list-wrap .doc-item').length >= 1`, 'the document list', 15_000);

      await driver.setValue('#doc-search-input', 'orion');
      await driver.waitFor(`/Showing 1 of \\d+/.test(document.querySelector('#doc-filter-label')?.textContent || '')`, 'the filter count', 10_000);
      assert.strictEqual(await driver.exec(`return document.querySelectorAll('#doc-list-wrap .doc-item').length;`), 1,
        'a partial name narrows the list to one document');

      const geometry = await driver.exec(`return (() => {
        const panel = document.querySelector('#doc-panel');
        const btn = document.querySelector('#cite-import-btn');
        const rect = btn ? btn.getBoundingClientRect() : null;
        return {
          overflow: !!panel && panel.scrollWidth > panel.clientWidth + 1,
          visible: !!rect && rect.width > 0 && rect.right <= window.innerWidth + 1,
        };
      })()`);
      assert.strictEqual(geometry.overflow, false, 'the document panel does not overflow sideways');
      assert.strictEqual(geometry.visible, true, 'the References action stays reachable');

      await driver.click('.doc-item .di-open');
      await driver.waitFor(`!document.querySelector('#source-overlay')?.classList.contains('hidden')`, 'the document viewer', 15_000);
      const src = await driver.exec(`return document.querySelector('#source-frame')?.getAttribute('src') || '';`);
      assert.ok(src.includes('/document/view?path='), `the viewer loads the shared route, got "${src}"`);
      await driver.waitFor(`(() => {
        try {
          const frame = document.querySelector('#source-frame');
          const text = (frame?.contentDocument?.body?.textContent || '') + ' ' +
            (document.querySelector('#source-reader')?.textContent || '');
          return text.includes(${JSON.stringify(CODE)});
        } catch (e) { return false; }
      })()`, 'the document to render in the viewer', 20_000);
      await driver.screenshot('safari-document');
      await driver.click('#source-close');
      await driver.waitFor(`document.querySelector('#source-overlay')?.classList.contains('hidden')`, 'the viewer to close');
      await driver.click('#doc-search-clear');
      await driver.click('#docs-toggle');
    });

    await step('theme, text size, and Escape focus return work', async () => {
      const before = await driver.exec(`return localStorage.getItem('theme') || 'dark';`);
      await driver.click('#theme-toggle');
      await driver.waitFor(`(localStorage.getItem('theme') || 'dark') !== ${JSON.stringify(before)}`, 'the theme change', 10_000);

      await driver.click('#settings-btn');
      await driver.waitFor(`!document.querySelector('#settings-overlay')?.classList.contains('hidden')`, 'Settings', 15_000);
      await driver.waitFor(`(() => { const b = document.querySelector('#settings-save'); return !!b && !b.disabled; })()`, 'Settings to finish loading');
      await driver.setValue('#cfg-read-scale', '1.5');
      await driver.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--read-scale').trim() === '1.5'`, 'the text size change');

      // The sticky filter row must leave room for the 2px focus ring at the scroll container's edges.
      await driver.click('#settings-filter');
      const focusRing = await driver.exec(`return (() => {
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
      })()`);
      assert.ok(focusRing.padTop >= 2 && focusRing.padLeft >= 2 && focusRing.padRight >= 2,
        'the filter row leaves room for the 2px focus ring');
      assert.ok(focusRing.inputTop >= 2 && focusRing.inputLeft >= 2 && focusRing.inputRight >= 2,
        'the filter input is inset from the row edges');
      assert.strictEqual(focusRing.inside, true, 'the focused filter stays inside the scroll container');

      const layout = await driver.exec(`return (() => {
        const box = document.querySelector('#settings-overlay .modal-box');
        const rect = box ? box.getBoundingClientRect() : null;
        return {
          fits: !!rect && rect.left >= -1 && rect.right <= window.innerWidth + 1,
          overflow: !!box && box.scrollWidth > box.clientWidth + 1,
        };
      })()`);
      assert.strictEqual(layout.fits, true, 'Settings fits the window');
      assert.strictEqual(layout.overflow, false, 'Settings does not overflow sideways');
      assert.deepStrictEqual(await driver.axe('#settings-overlay'), [], 'Settings is accessible');

      await driver.key(KEY.escape);
      await driver.waitFor(`document.querySelector('#settings-overlay')?.classList.contains('hidden')`, 'Settings to close');
      await driver.waitFor(`document.activeElement?.id === 'settings-btn'`, 'Escape to return focus to the Settings trigger', 5000);
    });

    await step('the Guide opens, searches, and closes', async () => {
      await driver.click('#help-btn');
      await driver.waitFor(`!document.querySelector('#help-overlay')?.classList.contains('hidden') && !!document.querySelector('#help-body h1, #help-body h2')`, 'the Guide', 20_000);
      assert.deepStrictEqual(await driver.axe('#help-overlay'), [], 'the Guide is accessible');
      await driver.setValue('#help-search-input', 'OCR');
      await driver.waitFor(`/\\d+ \\/ \\d+/.test(document.querySelector('#help-count')?.textContent || '')`, 'the Guide search count', 10_000);
      assert.ok(await driver.exec(`return document.querySelectorAll('#help-body .help-hit').length;`) > 0,
        'Guide search highlights matches');
      await driver.click('#help-close');
      await driver.waitFor(`document.querySelector('#help-overlay')?.classList.contains('hidden')`, 'the Guide to close');
    });

    await step('read-aloud offers an accessible control', async () => {
      await driver.click('#settings-btn');
      await driver.waitFor(`(() => { const b = document.querySelector('#settings-save'); return !!b && !b.disabled; })()`, 'Settings to finish loading');
      await driver.setChecked('#cfg-tts-enabled', true);
      await driver.click('#settings-save');
      await driver.waitFor(`/Saved/.test(document.querySelector('#settings-status')?.textContent || '')`, 'the saved settings', 20_000);
      await driver.exec(`document.querySelectorAll('.toast').forEach((el) => el.remove()); document.getElementById('settings-cancel')?.click(); return true;`);
      await driver.waitFor(`document.querySelector('#settings-overlay')?.classList.contains('hidden')`, 'Settings to close');
      await driver.waitFor(`!!document.querySelector('#chat-box .readaloud-btn')`, 'the read-aloud control', 15_000);
      const control = await driver.exec(`return (() => {
        const btn = document.querySelector('#chat-box .readaloud-btn');
        return {
          text: btn?.textContent?.trim() || '',
          title: btn?.getAttribute('title') || btn?.getAttribute('aria-label') || '',
          disabled: !!btn?.disabled,
          pressed: btn?.getAttribute('aria-pressed'),
        };
      })()`);
      assert.ok(control.text.length > 0, 'the control has a visible label');
      assert.ok(control.title.length > 0, 'the control has an accessible description');
      assert.strictEqual(control.disabled, false, 'the control is available');
      assert.strictEqual(control.pressed, 'false', 'the control starts idle');
    });

    await step('two evaluation runs can be compared', async () => {
      await driver.click('#settings-btn');
      await driver.waitFor(`(() => { const b = document.querySelector('#settings-save'); return !!b && !b.disabled; })()`, 'Settings to finish loading');
      // The Quality panel is inside an Advanced block, so open every Advanced section before reaching it.
      await driver.exec(`document.querySelectorAll('details.settings-advanced').forEach((el) => { el.open = true; }); return true;`);
      await driver.waitFor(`!!document.querySelector('#eval-run-btn') && document.querySelector('#eval-run-btn').offsetParent !== null`, 'the evaluation panel');
      const empty = await driver.exec(`return document.querySelectorAll('#eval-question-list .apikey-row').length === 0;`);
      if (empty) {
        await driver.setValue('#eval-question-input', QUESTION);
        await driver.click('#eval-add-btn');
        await driver.waitFor(`document.querySelectorAll('#eval-question-list .apikey-row').length === 1`, 'the saved question');
      }
      for (let i = 0; i < 2; i++) {
        await driver.exec(`const s = document.getElementById('eval-status'); if (s) s.textContent = ''; return true;`);
        await driver.click('#eval-run-btn');
        await driver.waitFor(`(() => {
          const btn = document.querySelector('#eval-run-btn');
          return !!btn && !btn.disabled && /Done\\./.test(document.querySelector('#eval-status')?.textContent || '');
        })()`, 'the evaluation to finish', 120_000);
      }
      await driver.waitFor(`!!document.querySelector('#eval-compare-btn')`, 'the run picker', 15_000);
      const picks = await driver.exec(`return {
        a: document.querySelector('#eval-compare-a')?.value || '',
        b: document.querySelector('#eval-compare-b')?.value || '',
        options: document.querySelectorAll('#eval-compare-a option').length,
      };`);
      assert.ok(picks.a && picks.b && picks.a !== picks.b, 'the picker defaults to two different runs');
      assert.ok(picks.options >= 2, 'both archived runs are offered');
      await driver.click('#eval-compare-btn');
      await driver.waitFor(`!!document.querySelector('.eval-compare-table tbody tr')`, 'the comparison table', 15_000);
      const compare = await driver.exec(`return {
        labels: [...document.querySelectorAll('.eval-compare-table tbody th')].map((el) => el.textContent.trim()),
        rows: document.querySelectorAll('.eval-compare-table tbody tr').length,
        overflow: (() => { const w = document.querySelector('.eval-compare-table-wrap'); return !!w && w.scrollWidth > w.clientWidth + 1; })(),
      };`);
      assert.deepStrictEqual(compare.labels, ['Faithfulness', 'Answer relevancy', 'Context precision', 'Citation attribution F1'],
        'the comparison renders every metric from the server catalog');
      assert.strictEqual(compare.rows, 4, 'one row per metric');
      assert.strictEqual(compare.overflow, false, 'the comparison table fits the panel');
      assert.deepStrictEqual(await driver.axe('#eval-compare'), [], 'the comparison is accessible');
      await driver.key(KEY.escape);
      await driver.waitFor(`document.querySelector('#settings-overlay')?.classList.contains('hidden')`, 'Settings to close');
    });

    await step('the phone Tools sheet is a titled, dismissible dialog', async () => {
      await driver.rect(390, 844);
      await driver.waitFor(`window.innerWidth <= 480`, 'the phone width', 15_000);
      await driver.click('#tools-btn');
      await driver.waitFor(`(() => {
        const menu = document.querySelector('#tools-menu');
        return !!menu && menu.hidden === false;
      })()`, 'the Tools sheet', 15_000);
      await sleep(250);

      const opened = await driver.exec(`return (() => {
        const menu = document.querySelector('#tools-menu');
        const head = menu.querySelector('.sheet-head');
        return {
          role: menu.getAttribute('role'),
          modal: menu.getAttribute('aria-modal'),
          labelledby: menu.getAttribute('aria-labelledby'),
          headDisplay: getComputedStyle(head).display,
          headText: head.textContent.trim(),
          closeVisible: document.querySelector('#tools-sheet-close')?.offsetParent !== null,
          focused: document.activeElement?.classList.contains('tool-row') === true &&
            !!document.activeElement.closest('#tools-menu'),
          haspopup: document.querySelector('#tools-btn').getAttribute('aria-haspopup'),
          backdropHidden: document.querySelector('#sheet-backdrop').hidden,
        };
      })()`);
      assert.strictEqual(opened.role, 'dialog', 'the phone sheet is a dialog');
      assert.strictEqual(opened.modal, 'true', 'the phone sheet is modal');
      assert.strictEqual(opened.labelledby, 'tools-sheet-title', 'the sheet is labelled by its title');
      assert.strictEqual(opened.headDisplay, 'flex', 'the sheet shows its header');
      assert.ok(opened.headText.includes('Answer options'), 'the sheet names itself');
      assert.strictEqual(opened.closeVisible, true, 'the sheet offers a close control');
      assert.strictEqual(opened.focused, true, 'opening the sheet moves focus to its first option');
      assert.strictEqual(opened.haspopup, 'dialog', 'the trigger announces the dialog');
      assert.strictEqual(opened.backdropHidden, false, 'the sheet dims the page behind it');
      assert.deepStrictEqual(await driver.axe('#tools-menu'), [], 'the phone sheet is accessible');
      await driver.screenshot('safari-phone');

      await driver.click('#tools-sheet-close');
      await driver.waitFor(`document.querySelector('#tools-menu')?.hidden === true`, 'the sheet to close');
      await driver.waitFor(`document.activeElement?.id === 'tools-btn'`, 'focus to return to the Tools trigger', 5000);
      const closed = await driver.exec(`return (() => ({
        role: document.querySelector('#tools-menu').getAttribute('role'),
        backdropHidden: document.querySelector('#sheet-backdrop').hidden,
        focus: document.activeElement?.id || '',
      }))()`);
      assert.strictEqual(closed.role, 'group', 'the panel returns to popover semantics');
      assert.strictEqual(closed.backdropHidden, true, 'the backdrop is removed');
      assert.strictEqual(closed.focus, 'tools-btn', 'focus returns to the Tools trigger');
    });

    const total = steps.reduce((sum, item) => sum + item.ms, 0);
    console.log(`\nSafari pass complete: ${steps.length} checks in ${Math.round((Date.now() - started) / 1000)}s (${Math.round(total / 1000)}s in steps).`);
    console.log(`Screenshots: ${RESULTS_DIR}`);
    return 0;
  } catch (error) {
    console.error(`\nSafari pass failed: ${error.message}`);
    failed = 1;
    return 1;
  } finally {
    if (driver) await driver.close();
    await stopDriver(driverProcess).catch(() => {});
    if (harness) {
      await harness.stop().catch((error) => console.error(`Cleanup warning: ${error.message}`));
    }
    process.exitCode = failed;
  }
};

if (require.main === module) {
  const run = process.argv.includes('--probe') ? probe : main;
  run()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`\nSafari ${run === probe ? 'probe' : 'pass'} could not run: ${error.stack || error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main, probe };
