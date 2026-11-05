'use strict';
// Starts a real Lokyni server and a deterministic OpenAI-compatible provider for the browser suite.
// The temporary config, data directory, and both child processes are always cleaned up.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createMockProvider, MODEL_CHAT, MODEL_EMBED } = require('./mock-provider');
const { DOC_NAME, DOC_TEXT } = require('./fixtures');

const REPO = path.resolve(__dirname, '..', '..', '..');
const START_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const getStatus = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); }
    setTimeout(() => {
      if (done) return;
      if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best-effort */ }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      setTimeout(finish, 1000);
    }, 8000);
  });
};

const writeFixture = (docsDir) => {
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, DOC_NAME), DOC_TEXT, 'utf8');
};

const writeConfig = (configDir, mockPort) => {
  const config = {
    provider: 'openai',
    model: MODEL_CHAT,
    embeddingsProvider: 'openai',
    embeddingsModel: MODEL_EMBED,
    openaiApiKey: 'e2e-test-key',
    openaiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
    temperature: 0,
    maxTokens: 512,
    maxHistory: 4,
    passageSize: 8000,
    numCtx: 4096,
    embeddingContextTokens: 2048,
    minCosineScore: 0.05,
    useReranker: false,
    useColbertRerank: false,
    useQueryRewrite: false,
    useIntentClassifier: false,
    useConversationSummary: false,
    useRagFusion: false,
    useHyde: false,
    useAdaptiveRetrieval: false,
    useEntityGraph: false,
    useGraphRag: false,
    useCorrectiveRetrieval: false,
    useCrossLingual: false,
    useSemanticCache: false,
    usePartialMatchTier: false,
    useTopicSwitchAck: false,
    useClarifyingQuestions: false,
    useMetaConversation: false,
    useSuggestedQuestions: false,
    useDocumentSummaries: false,
    useAutoSynthesis: false,
    useEmbeddingBanks: false,
    useOcr: false,
    visionDescribe: false,
    useVisualIngest: false,
    ttsEnabled: false,
    sttEnabled: false,
    useAudioIngest: false,
    useWebSearch: false,
    webAutoSuggest: false,
    useWebResultRanking: false,
    auditLog: false,
    fileLogging: false,
    allowSignups: false,
    allowNetworkAccess: false,
    sourcePaths: [],
    debug: false,
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
};

// Start both processes and resolve once the fixture document is indexed and searchable.
const startHarness = async () => {
  const mock = createMockProvider();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-e2e-'));
  let app = null;
  let stopped = false;
  const logs = [];

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    await stopChild(app);
    try { await mock.stop(); } catch { /* already closed */ }
    if (process.env.E2E_KEEP_TMP === '1') {
      console.error(`E2E temporary directory kept at ${tmpRoot}`);
    } else {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  try {
    const mockPort = await mock.start();
    const appPort = await freePort();
    writeConfig(path.join(tmpRoot, 'config'), mockPort);
    writeFixture(path.join(tmpRoot, 'data', 'workspaces', 'default', 'documents'));

    app = spawn(process.execPath, [
      path.join(REPO, 'lokyni.js'),
      '--port', String(appPort),
      '--bind', '127.0.0.1',
      '--data-dir', path.join(tmpRoot, 'data'),
    ], {
      cwd: tmpRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    const collect = (stream) => stream.on('data', (chunk) => {
      logs.push(String(chunk));
      if (logs.join('').length > 200_000) logs.splice(0, Math.max(1, logs.length - 40));
    });
    collect(app.stdout);
    collect(app.stderr);

    const url = `http://127.0.0.1:${appPort}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error(`Lokyni exited before it was ready (code ${app.exitCode}).\n${logs.join('')}`);
      const status = await getStatus(url);
      if (status && status.ready === true && Number(status.documents) >= 1) {
        return { url, tmpRoot, logs, stop: cleanup };
      }
      await sleep(250);
    }
    throw new Error(`Lokyni did not become ready within ${START_TIMEOUT_MS} ms.\n${logs.join('')}`);
  } catch (e) {
    await cleanup();
    throw e;
  }
};

module.exports = { startHarness, freePort };
