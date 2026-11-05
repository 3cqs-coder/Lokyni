'use strict';
// Hardware-aware model suggestions.
//
// Picking a local model is the main first-run friction: users don't know which chat or
// embedding model their machine can actually run well. This inspects the host's memory
// (and GPU, when detectable) and suggests models from a small curated catalog that fit
// comfortably, so the Settings panel can offer "models that suit this machine" rather
// than leaving the field blank. Everything here is best-effort and never throws — a
// detection failure just yields conservative suggestions.

const os = require('os');

const GB = 1073741824;
const round1 = (n) => Math.round(n * 10) / 10;

// Best-effort NVIDIA GPU probe (Linux/Windows with drivers). Returns { name, vramGB } or
// null. macOS has no nvidia-smi; Apple Silicon is handled as unified memory below.
const probeNvidia = async () => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    // ASYNC (not execFileSync): this runs on the /api/model-recommendations request path,
    // and a synchronous spawn would block the whole event loop until nvidia-smi returns
    // (up to the 2s timeout). execFile with an argument array also avoids any shell.
    const { stdout } = await promisify(execFile)('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000 });
    const out = String(stdout).trim();
    const line = out.split('\n')[0];
    if (!line) return null;
    const [name, mib] = line.split(',').map(s => s.trim());
    const vramGB = round1((parseFloat(mib) || 0) / 1024);
    return vramGB > 0 ? { name, vramGB } : null;
  } catch { return null; }
};

// Describe the host and how much memory is realistically usable for a model.
const detectSystem = async () => {
  const platform = os.platform();
  const arch = os.arch();
  const cpuCount = os.cpus()?.length || 0;
  const totalRamGB = round1(os.totalmem() / GB);
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const gpu = appleSilicon ? null : await probeNvidia();

  // Usable budget for the model, leaving room for the OS, Lokyni, the embedding model,
  // and the reranker. Apple Silicon shares one memory pool the GPU can use most of; a
  // discrete NVIDIA GPU is bounded by its VRAM; otherwise it's CPU RAM (slower).
  let mode, usableGB;
  if (gpu) { mode = 'gpu'; usableGB = round1(gpu.vramGB - 1); }
  else if (appleSilicon) { mode = 'apple'; usableGB = round1(totalRamGB * 0.7); }
  else { mode = 'cpu'; usableGB = round1(Math.max(totalRamGB - 4, 1)); }

  const label = gpu
    ? `${gpu.name} (${gpu.vramGB} GB VRAM), ${totalRamGB} GB RAM, ${cpuCount} cores`
    : appleSilicon
      ? `Apple Silicon, ${totalRamGB} GB unified memory, ${cpuCount} cores`
      : `${totalRamGB} GB RAM, ${cpuCount} cores (CPU inference)`;

  return { platform, arch, cpuCount, totalRamGB, appleSilicon, gpu, mode, usableGB, label };
};

// Curated Ollama models with approximate resident memory at their default quantization
// (weights + a working KV cache). Ordered small→large within each group. ramGB is a
// practical footprint, not an exact figure — it's used to gate "fits comfortably".
const CHAT = [
  { name: 'llama3.2:1b',          paramsB: 1,  ramGB: 1.5, note: 'Tiny and fastest; basic quality — for very constrained machines.' },
  { name: 'llama3.2:3b',          paramsB: 3,  ramGB: 3,   note: 'Small and fast; a solid default on modest hardware.' },
  { name: 'qwen2.5:7b-instruct',  paramsB: 7,  ramGB: 5,   note: 'Strong all-round 7B; great quality-for-size.' },
  { name: 'llama3.1:8b',          paramsB: 8,  ramGB: 6,   note: 'Well-rounded 8B general model.' },
  { name: 'gemma2:9b',            paramsB: 9,  ramGB: 7,   note: 'Capable 9B with good writing.' },
  { name: 'qwen2.5:14b',          paramsB: 14, ramGB: 10,  note: 'Higher quality; needs a roomier machine.' },
  { name: 'qwen2.5:32b',          paramsB: 32, ramGB: 20,  note: 'High quality; large — best with a GPU or lots of unified memory.' },
  { name: 'llama3.3:70b',         paramsB: 70, ramGB: 42,  note: 'Top quality; needs substantial memory or a big GPU.' },
];

const EMBED = [
  { name: 'all-minilm',         ramGB: 0.2, note: 'Very light and fast; lower recall — for tight memory.' },
  { name: 'nomic-embed-text',   ramGB: 0.5, note: 'Light and solid; English-focused.' },
  { name: 'mxbai-embed-large',  ramGB: 0.7, note: 'Higher-quality English embeddings; a little larger.' },
  { name: 'bge-m3',             ramGB: 2.5, note: 'Multilingual, strong retrieval, open and self-hostable — the default on a roomy machine.' },
];

// Produce ranked suggestions for a system descriptor (from detectSystem, or supplied by a
// caller/test). Pure and synchronous: each entry carries a `fits` flag and one
// `recommended: true` per group (the most capable that fits, or the smallest when nothing
// fits). Callers that want live detection do `recommend(await detectSystem())`.
const recommend = (system) => {
  const budget = system.usableGB;

  const chat = CHAT.map(m => ({ ...m, fits: m.ramGB <= budget }));
  const chatFits = chat.filter(m => m.fits);
  const bestChat = chatFits.length ? chatFits[chatFits.length - 1] : chat[0];   // largest that fits, else smallest
  bestChat.recommended = true;

  const embed = EMBED.map(m => ({ ...m, fits: m.ramGB <= budget }));
  // bge-m3 (the shipped default) is recommended only on a roomy machine, where it comfortably coexists
  // with a chat model; on a moderate machine nomic-embed-text is lighter, and on a very tight one
  // all-minilm. The threshold leaves headroom beside the chat model so a suggestion never risks an OOM.
  const embName = budget < 1.5 ? 'all-minilm' : (budget >= 6 ? 'bge-m3' : 'nomic-embed-text');
  const embRec = embed.find(m => m.name === embName);
  if (embRec) embRec.recommended = true;

  const notes = [];
  if (system.mode === 'cpu') notes.push('No GPU detected — models run on the CPU, which is slower. Smaller models will feel more responsive.');
  if (system.mode === 'apple') notes.push('Apple Silicon shares one memory pool between CPU and GPU, so larger models are viable than the RAM figure alone suggests.');
  if (!chatFits.length) notes.push('This machine is tight on memory for local chat models — the smallest option is suggested; consider a hosted provider for larger models.');

  return { system, chat, embeddings: embed, notes };
};

module.exports = { detectSystem, recommend };
