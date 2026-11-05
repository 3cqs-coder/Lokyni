'use strict';

// The separate OpenAI-compatible EMBED credentials: a hosted embed endpoint can carry its own key/base
// independent of the chat provider, and each field falls back to the chat OpenAI key/base when left blank
// (so nothing regresses for anyone who does not set them). Pure/offline — the LangChain OpenAIEmbeddings
// constructor is stubbed to capture the client config, so no network and no real model are touched.

const { test } = require('node:test');
const assert = require('assert');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..', '..');
const langchainOpenai = require('@langchain/openai');
const OrigOpenAIEmbeddings = langchainOpenai.OpenAIEmbeddings;

test('openai embed client uses the separate embed key/base, and each falls back to the chat OpenAI key/base when blank', () => {
  const cfg = require(path.join(PROJECT, 'lib', 'config'));
  const { makeEmbeddings } = require(path.join(PROJECT, 'lib', 'embeddings'));
  const saved = {
    EMBEDDINGS_API_KEY: cfg.EMBEDDINGS_API_KEY, EMBEDDINGS_BASE_URL: cfg.EMBEDDINGS_BASE_URL,
    OPENAI_KEY: cfg.OPENAI_KEY, OPENAI_BASE: cfg.OPENAI_BASE,
  };
  const captured = [];
  // makeEmbeddings require()s @langchain/openai lazily, so replacing the cached export is enough to capture it.
  langchainOpenai.OpenAIEmbeddings = function (opts) { captured.push(opts); return { embedDocuments: async () => [], embedQuery: async () => [] }; };
  const last = () => captured[captured.length - 1];
  try {
    // (1) Separate embed credentials set → used as-is, distinct from the chat key/base.
    cfg.EMBEDDINGS_API_KEY = 'ek-embed'; cfg.EMBEDDINGS_BASE_URL = 'https://embed.test/v1';
    cfg.OPENAI_KEY = 'ck-chat'; cfg.OPENAI_BASE = 'https://chat.test/v1';
    makeEmbeddings({ provider: 'openai', model: 'bge-m3' });
    assert.equal(last().apiKey, 'ek-embed', 'the separate embed key is used');
    assert.equal(last().configuration.baseURL, 'https://embed.test/v1', 'the separate embed base is used');
    assert.notEqual(last().apiKey, cfg.OPENAI_KEY, 'the embed key is independent of the chat key');

    // (2) Blank embed credentials → fall back to the chat OpenAI key/base (no regression for existing setups).
    cfg.EMBEDDINGS_API_KEY = ''; cfg.EMBEDDINGS_BASE_URL = '';
    makeEmbeddings({ provider: 'openai', model: 'bge-m3' });
    assert.equal(last().apiKey, 'ck-chat', 'a blank embed key falls back to the chat key');
    assert.equal(last().configuration.baseURL, 'https://chat.test/v1', 'a blank embed base falls back to the chat base');

    // (3) A frozen bank's own stored baseUrl still wins over both, so it is queried with the exact endpoint that built it.
    cfg.EMBEDDINGS_BASE_URL = 'https://embed.test/v1';
    makeEmbeddings({ provider: 'openai', model: 'bge-m3', baseUrl: 'https://frozen.test/v1' });
    assert.equal(last().configuration.baseURL, 'https://frozen.test/v1', 'a frozen bank baseUrl overrides the configured embed base');
  } finally {
    langchainOpenai.OpenAIEmbeddings = OrigOpenAIEmbeddings;
    Object.assign(cfg, saved);
  }
});
