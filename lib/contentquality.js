'use strict';
// Content-quality gate for URL capture. A plain HTTP fetch is cheap, but a 200 response can still be a bot
// wall, a login screen, an error shell, or a mostly-script page with a few words of navigation. This module
// decides whether the extracted text is a real article, so the capture ladder only escalates to a headless
// browser when it must. Pure, synchronous, bounded, and language-agnostic: the signals are length, structure,
// a text-to-markup ratio, a small multilingual wall/not-found vocabulary, and a generic-title check.

const MAX_SCAN = 200000;
const textOf = (v) => String(v == null ? '' : v).slice(0, MAX_SCAN);

// Access walls and bot checks. Matched only on a short page, so an article that discusses a 403 or a cookie
// wall is not rejected.
const WALL_RE = /(enable|turn on) javascript|javascript (is )?(required|disabled)|verify (that )?you are (a )?human|checking your browser|just a moment|attention required|access denied|request (was )?blocked|sign in to (continue|read)|log in to (continue|read)|subscribe to (continue|read)|cookie (consent|wall) required|403 forbidden/i;
// Error pages served with HTTP 200. Matched on a short title/body.
const NOT_FOUND_RE = /(page|file|document|resource)?\s*(not found|does not exist|no longer available)|\b404\b|no encontrad[ao]|página no encontrada|page introuvable|seite nicht gefunden|nicht gefunden|página não encontrada|pagina non trovata|ページが見つかりません|找不到(页面|网页)|페이지를 찾을 수 없습니다|страница не найдена/i;
const GENERIC_TITLE_RE = /^(home|untitled|index|welcome|startseite|accueil|inicio|início|pagina iniziale|главная|首页|ホーム|홈)$/i;

const sentenceCount = (text) => (text.match(/[.!?。！？]+/g) || []).length;
const paragraphCount = (text) => text.split(/\n{2,}/).filter((p) => p.trim()).length;

// Is this extracted HTTP result a real article? `article` is { title, text }; `html` is the captured markup,
// used only for the text-to-markup ratio. Returns { ok, reason } and never throws.
const assessHttpArticle = (article, html = '') => {
  try {
    const title = textOf(article && article.title).trim();
    const text = textOf(article && article.text).trim();
    const chars = text.length;
    if (!chars) return { ok: false, reason: 'The page had no readable article text.' };
    if (WALL_RE.test(text.slice(0, 4000)) && chars < 2500) {
      return { ok: false, reason: 'The page is an access wall or bot check, not an article.' };
    }
    if (NOT_FOUND_RE.test(`${title}\n${text.slice(0, 800)}`) && chars < 1800) {
      return { ok: false, reason: 'The page looks like an error or “not found” page.' };
    }
    if (!title || GENERIC_TITLE_RE.test(title)) {
      return { ok: false, reason: 'The page has no article title.' };
    }
    const markup = String(html || '').length;
    if (markup > 20000 && chars / markup < 0.004) {
      return { ok: false, reason: 'The page is mostly scripts or navigation, not article text.' };
    }
    if (chars < 500 || (sentenceCount(text) < 2 && paragraphCount(text) < 2)) {
      return { ok: false, reason: 'The page has too little readable article text.' };
    }
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'The page could not be assessed.' };
  }
};

// Final gate for a page that was already rendered by the browser. The rendered path is allowed to accept a
// short article (the existing minimum-length check still applies), but it must not save a wall or an error
// shell. Returns { ok, reason }.
const assessCapturedArticle = (article) => {
  try {
    const title = textOf(article && article.title).trim();
    const text = textOf(article && article.text).trim();
    if (!text) return { ok: false, reason: 'The page had no readable text.' };
    if (WALL_RE.test(text.slice(0, 4000)) && text.length < 2500) {
      return { ok: false, reason: 'The page is an access wall or bot check, not an article.' };
    }
    if (NOT_FOUND_RE.test(`${title}\n${text.slice(0, 800)}`) && text.length < 1800) {
      return { ok: false, reason: 'The page looks like an error or “not found” page.' };
    }
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'The page could not be assessed.' };
  }
};

module.exports = { assessHttpArticle, assessCapturedArticle };
