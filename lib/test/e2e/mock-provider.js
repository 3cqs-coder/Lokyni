'use strict';
// A tiny OpenAI-compatible provider for the browser tests. It implements only the three endpoints the
// app uses — model listing, embeddings, and chat completions — with deterministic vectors and one fixed
// answer. Everything stays on 127.0.0.1; no model, network, or generation cost is involved.

const http = require('http');
const { ANSWER, SLOW_ANSWER, SLOW_MARKER, SPANISH_ANSWER, SPANISH_MARKER } = require('./fixtures');

const EMBED_DIM = 64;
const MODEL_CHAT = 'e2e-chat';
const MODEL_EMBED = 'e2e-embed';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hash32 = (s) => {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
};

// A unit-normalized bag-of-words vector. The fixture question and document share content words, so the
// dense path finds the document without a real embedding model.
const embed = (text) => {
  const v = new Array(EMBED_DIM).fill(0);
  for (const token of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    v[hash32(token) % EMBED_DIM] += 1;
  }
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  if (sumSq > 0) { const inv = 1 / Math.sqrt(sumSq); for (let i = 0; i < v.length; i++) v[i] *= inv; }
  return v;
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
  });
  req.on('error', reject);
});

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const createMockProvider = () => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: [
            { id: MODEL_CHAT, object: 'model', owned_by: 'e2e' },
            { id: MODEL_EMBED, object: 'model', owned_by: 'e2e' },
          ],
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = await readBody(req);
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
        return json(res, 200, {
          object: 'list',
          model: body.model || MODEL_EMBED,
          data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req);
        const id = 'chatcmpl-e2e';
        const created = Math.floor(Date.now() / 1000);
        if (body.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const base = { id, object: 'chat.completion.chunk', created, model: body.model || MODEL_CHAT };
          // The app aborts the HTTP request when the user presses Stop (or a New/disconnect lands).
          // Stop writing immediately so the stub does not keep a dead response alive or throw EPIPE.
          let closed = false;
          const markClosed = () => { closed = true; };
          res.on('close', markClosed);
          res.on('error', markClosed);
          const send = (value) => { if (!closed && !res.writableEnded) { try { res.write(value); } catch { markClosed(); } } };
          send(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          // A question carrying the slow marker streams a longer answer in small, spaced chunks, so a
          // browser test has a deterministic live stream to stop partway through. A Spanish marker answers
          // in Spanish instead, for the multilingual read-aloud test.
          const serialized = JSON.stringify(body.messages || []);
          const slow = serialized.includes(SLOW_MARKER);
          const spanish = serialized.includes(SPANISH_MARKER);
          const text = spanish ? SPANISH_ANSWER : (slow ? SLOW_ANSWER : ANSWER);
          const size = slow ? 12 : 24;
          // A short lead-in keeps the app's status bubble on screen long enough for a browser test to
          // observe Deep Research progress before the report begins to stream.
          if (slow) await sleep(500);
          for (const part of text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [text]) {
            if (closed) return;
            send(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
            if (slow) await sleep(120);
          }
          if (closed) return;
          send(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          send('data: [DONE]\n\n');
          return res.end();
        }
        return json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: body.model || MODEL_CHAT,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(body.messages || []).includes(SPANISH_MARKER) ? SPANISH_ANSWER : ANSWER }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      return json(res, 404, { error: { message: `No mock route for ${req.method} ${url.pathname}` } });
    } catch (e) {
      if (!res.headersSent) return json(res, 400, { error: { message: e && e.message ? e.message : 'Bad request' } });
      try { res.end(); } catch { /* already closed */ }
    }
  });

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
    get port() { const a = server.address(); return a && typeof a === 'object' ? a.port : null; },
    MODEL_CHAT,
    MODEL_EMBED,
  };
};

module.exports = { createMockProvider, MODEL_CHAT, MODEL_EMBED, ANSWER };
