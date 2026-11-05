'use strict';
// Guards the chat/embedding provider split and the Anthropic (OpenAI-compatible) chat transport.
//
// The contract:
//   • The embedding provider is independent of the chat provider, so switching the CHAT provider — even to
//     a chat-only provider like Anthropic — never changes the embedding bank fingerprint and so never
//     re-embeds the corpus. Only an EMBEDDING provider/model/endpoint change opens a new bank.
//   • Anthropic is reached through its OpenAI-compatible endpoint, reusing the whole OpenAI transport; the
//     compat mapping picks the Anthropic key + base, and OpenAI keeps its own (optional) base.
//   • Anthropic can never be the embedding provider (it cannot embed) — the single-source list excludes it.
//
// Pure/offline — no model, no network; clients and configs are only constructed/compared.
// Run: `npm run test:unit` (or `node lib/test/unit/provider-split.test.js`).

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));
const llm = require(path.join(PROJECT, 'lib', 'llm'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── Switching the CHAT provider does NOT change the embedding bank fingerprint (no re-embed) ──
  const base = { EMBEDDINGS_PROVIDER: 'ollama', EMBEDDINGS_MODEL: 'nomic-embed-text', OLLAMA_HOST: 'http://localhost:11434', OPENAI_BASE: '' };
  const fpOllamaChat    = banks.currentMeta({ ...base, AI_PROVIDER: 'ollama' }).fp;
  const fpOpenAIChat    = banks.currentMeta({ ...base, AI_PROVIDER: 'openai' }).fp;
  const fpAnthropicChat = banks.currentMeta({ ...base, AI_PROVIDER: 'anthropic' }).fp;
  eq(fpOllamaChat, fpOpenAIChat, 'changing the chat provider (ollama→openai) keeps the same embedding bank');
  eq(fpOllamaChat, fpAnthropicChat, 'using a chat-only provider (anthropic) keeps the same embedding bank — no re-embed');

  // ── Changing the EMBEDDING provider DOES change the bank (a genuinely different vector space) ──
  const fpEmbOpenAI = banks.currentMeta({ ...base, AI_PROVIDER: 'ollama', EMBEDDINGS_PROVIDER: 'openai', EMBEDDINGS_MODEL: 'text-embedding-3-small' }).fp;
  ok(fpEmbOpenAI !== fpOllamaChat, 'changing the embedding provider opens a different bank');
  // An endpoint change with the same provider/model is a different server (and often different weights), so it
  // must not reuse the old bank's vectors under the new endpoint.
  const fpMovedHost = banks.currentMeta({ ...base, OLLAMA_HOST: 'http://localhost:11435' }).fp;
  ok(fpMovedHost !== fpOllamaChat, 'changing the embedding endpoint opens a different bank');
  // currentMeta is keyed by the EMBEDDING provider, never the chat provider.
  eq(banks.currentMeta({ ...base, AI_PROVIDER: 'anthropic' }).provider, 'ollama', 'the bank records the embedding provider, not the chat provider');

  // ── Anthropic is routed through the OpenAI-compatible transport ──
  ok(llm.isOpenAICompatible('openai') && llm.isOpenAICompatible('anthropic'), 'openai and anthropic share the OpenAI-compatible transport');
  ok(!llm.isOpenAICompatible('ollama'), 'ollama is NOT on the OpenAI-compatible transport');

  // ── The compat options pick the right key + base per provider ──
  const an = llm.openAICompatOptions({ AI_PROVIDER: 'anthropic', ANTHROPIC_KEY: 'sk-ant-x', ANTHROPIC_BASE: 'https://api.anthropic.com/v1/' });
  eq(an.apiKey, 'sk-ant-x', 'anthropic uses its own key');
  eq(an.baseURL, 'https://api.anthropic.com/v1/', 'anthropic always has a base URL (its compat endpoint)');
  const oa = llm.openAICompatOptions({ AI_PROVIDER: 'openai', OPENAI_KEY: 'sk-oa', OPENAI_BASE: '' });
  eq(oa.apiKey, 'sk-oa', 'openai uses its own key');
  ok(!('baseURL' in oa), 'openai omits the base URL when none is set (uses the SDK default)');
  const oaBase = llm.openAICompatOptions({ AI_PROVIDER: 'openai', OPENAI_KEY: 'sk-oa', OPENAI_BASE: 'http://localhost:1234/v1' });
  eq(oaBase.baseURL, 'http://localhost:1234/v1', 'openai honors a self-hosted compatible base URL');

  // ── Anthropic can never be the embedding provider (single-source list excludes it) ──
  ok(Array.isArray(cfg.PROVIDERS_WITH_EMBEDDINGS), 'the embedding-capable provider list is exported');
  ok(cfg.PROVIDERS_WITH_EMBEDDINGS.includes('ollama') && cfg.PROVIDERS_WITH_EMBEDDINGS.includes('openai'), 'ollama and openai can embed');
  ok(!cfg.PROVIDERS_WITH_EMBEDDINGS.includes('anthropic'), 'anthropic is excluded from embedding providers (it has no embeddings endpoint)');

  // ── SOURCE GUARD: the Settings provider-row visibility shows a provider's rows when EITHER the chat or
  //    the embedding provider uses it, and Anthropic's rows follow the chat provider alone (it is chat-only).
  //    This is client JS (no DOM in unit tests), so the disjunction is asserted by source — dropping the
  //    `|| emb === 'openai'` term would hide the OpenAI key row when chatting on Claude + embedding on OpenAI.
  const fs = require('fs');
  const chatjs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/const needOllama\s*=\s*chat === 'ollama' \|\| emb === 'ollama';/.test(chatjs), 'Ollama rows show when chat OR embeddings use Ollama');
  ok(/const needOpenai\s*=\s*chat === 'openai' \|\| emb === 'openai';/.test(chatjs), 'OpenAI rows show when chat OR embeddings use OpenAI (key visible when embedding on OpenAI under Claude chat)');
  ok(/const needAnthropic\s*=\s*chat === 'anthropic';/.test(chatjs), 'Anthropic rows follow the chat provider alone (chat-only)');
  ok(/cfgEmbeddingsProvider\?\.addEventListener\('change'/.test(chatjs), 'changing the embeddings provider re-evaluates row visibility and the model pickers');

  console.log(`\nALL PROVIDER-SPLIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PROVIDER-SPLIT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
