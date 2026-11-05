'use strict';

// lib/vision.js — optional local vision-model image description.
//
// Lokyni's OCR extracts TEXT from images. But an image with no text — a photo, a
// diagram, a chart, a screenshot of a UI — yields nothing from OCR and indexes as
// an empty, unsearchable document. This module fills that gap: it asks a vision
// model to DESCRIBE what an image depicts (plus tags), so the image becomes
// findable by its content ("the whiteboard photo", "the auth-flow diagram").
//
// It is entirely OPTIONAL and OFF by default:
//   - Independent of the OCR engine — works alongside tesseract or vision OCR.
//   - Requires a vision model the user explicitly selects (config.visionModel).
//     No model set → isEnabled() is false and callers skip it cleanly.
//   - Vision models are heavy; a user without the processing power simply leaves
//     it off and OCR behaves exactly as before.
//
// Reuses Lokyni's existing provider plumbing (lib/llm.js) rather than a separate
// client, and the shared loose-JSON parser (lib/llm-json.js). Prompt design and the
// friendly error mapping follow a proven approach for describing image/media content.
//
//   describeImage(imgBufferOrPath, { model, prompt }) -> { description, tags[] }

const cfg = () => require('./config');

// Vision-describe is enabled only when the user has turned it on AND named a model.
function isEnabled() {
  const c = cfg();
  return c.VISION_DESCRIBE === true && !!(c.VISION_MODEL && String(c.VISION_MODEL).trim());
}
function getModel(override) {
  const m = (override && String(override).trim()) || (cfg().VISION_MODEL && String(cfg().VISION_MODEL).trim());
  return m || null;
}

// Read an image → base64 (raw, no data: prefix). Downscale large images first: a
// vision encoder resizes to a small fixed resolution anyway, so sending a full 4K
// image just wastes time and memory. sharp is available transitively (see below).
async function imageToBase64(imgBufferOrPath, maxEdge) {
  // Reuse the ONE sharp/libvips build the process already loaded (the single copy the
  // transformers dependency brings in) rather than requiring a second one here — two
  // libvips builds in one process risk linker clashes and crashes.
  let sharp, MAX_INPUT_PIXELS;
  try { const o = require('./ocr'); sharp = o.loadSharp(); MAX_INPUT_PIXELS = o.MAX_INPUT_PIXELS; } catch (_) { sharp = null; }
  const cap = maxEdge || cfg().VISION_INPUT_MAX_EDGE || 1024;
  const input = imgBufferOrPath;
  // Cap the raw decode of the UNTRUSTED image at the same pixel-bomb limit the OCR path uses — a crafted image
  // that declares huge dimensions (a few-KB file) would otherwise decode to ~1 GB of RGBA on the main process.
  const sharpOpts = { limitInputPixels: MAX_INPUT_PIXELS || 100_000_000 };
  if (!sharp) {
    // No sharp available — fall back to sending the bytes as-is. Read asynchronously (never block the event
    // loop) and skip a pathologically large file rather than base64-ing an unbounded buffer.
    const buf = Buffer.isBuffer(input) ? input : await require('fs').promises.readFile(input);
    if (buf.length > 32 * 1024 * 1024) throw new Error('Image too large to describe without image support');
    return buf.toString('base64');
  }
  const meta = await sharp(input, sharpOpts).metadata();
  const longSide = Math.max(meta.width || 0, meta.height || 0);
  const shortSide = Math.min(meta.width || 0, meta.height || 0);
  // rotate() with no argument applies any EXIF orientation (a sideways phone photo)
  // so the model sees the image upright; removeAlpha() flattens transparency.
  let pipe = sharp(input, sharpOpts).rotate().removeAlpha();
  if (longSide > cap) {
    // Too large — downscale to keep the payload small (the encoder shrinks it anyway).
    pipe = pipe.resize({ width: cap, height: cap, fit: 'inside' });
  } else if (shortSide > 0 && shortSide < 768) {
    // Too small — upscale so text/detail is large enough for the model to read. A
    // small phone photo or thumbnail otherwise reaches the encoder with detail too
    // fine to resolve. Cap the factor and don't exceed `cap` on the long edge.
    const factor = Math.min(768 / shortSide, 4);
    const longEdge = Math.min(Math.round(longSide * factor), cap);
    pipe = pipe.resize({ width: longEdge, height: longEdge, fit: 'inside', kernel: 'lanczos3' });
  }
  const buf = await pipe.jpeg({ quality: 90 }).toBuffer();
  return buf.toString('base64');
}

// Translate common Ollama vision failures into short, actionable guidance instead
// of dumping a raw llama-server crash into the logs.
function friendlyVisionError(err, model) {
  const msg = String((err && err.message) || err || '');
  const m = model || '(model)';
  if (/mllama|unknown model architecture/i.test(msg)) {
    return `Vision model "${m}" failed to load in Ollama (known "mllama" architecture issue affecting llama3.2-vision). ` +
           `Try a model that loads reliably — e.g. qwen2.5vl:7b, llava:13b, or moondream.`;
  }
  if (/not found|no such model|try pulling|pull the model/i.test(msg)) {
    return `Vision model "${m}" isn't installed in Ollama. Run: ollama pull ${m}`;
  }
  if (/does not support (images|vision)|image input is not supported|no vision|not a vision/i.test(msg)) {
    return `"${m}" is not a vision-capable model. Choose a multimodal model like qwen2.5vl:7b, llava:13b, or moondream.`;
  }
  if (/out of memory|oom|cudaMalloc|failed to allocate|insufficient memory/i.test(msg)) {
    return `Ollama ran out of memory loading "${m}". Try a smaller vision model (e.g. moondream) or free up memory.`;
  }
  if (/ECONNREFUSED|fetch failed|connect|socket hang up|network/i.test(msg)) {
    return `Couldn't reach Ollama for the vision request. Is Ollama running and reachable at the configured host?`;
  }
  if (/timeout|timed out|aborted/i.test(msg)) {
    return `Vision model "${m}" timed out. Large vision models can be slow on first load; retry, or try a smaller model.`;
  }
  return `Vision request failed for "${m}": ${msg.split('\n')[0].slice(0, 200)}`;
}

// Output-token ceiling for a vision call. Callers slice the result to at most 4000 characters, so ~1600
// tokens is more than enough to fill that while bounding a model that over-generates or loops.
const VISION_MAX_OUTPUT_TOKENS = 1600;

// Low-level call: run the vision model on one image with a prompt, reusing
// Lokyni's existing (cached) provider client from llm.js — only the model differs
// from normal chat, and that's passed per-call. Returns raw text.
async function ask(b64, prompt, override) {
  const model = getModel(override);
  if (!model) throw new Error('No vision model configured (set a model in Settings → Vision).');
  const c = cfg();
  const llm = require('./llm');
  const isOpenAI = llm.isOpenAICompatible(c.AI_PROVIDER);
  // A vision call is a single non-streaming request, and neither SDK sets a request timeout of its own, so a
  // wedged model or a black-holed endpoint would hang the caller forever (and, when this runs inline during
  // indexing, park the whole index run). Bound it AND actually CANCEL the underlying request on timeout, so a
  // stalled call doesn't leave a zombie request occupying the provider client — mirrors streamChat: OpenAI aborts
  // per-request via { signal }; Ollama uses a THROWAWAY per-call client so abort() cancels only THIS request,
  // never a concurrent OCR/answer on the shared singleton. The catch below turns any failure (incl. the abort)
  // into a normal vision error, which every caller already tolerates.
  const ac = new AbortController();
  const ollamaClient = isOpenAI ? null : llm.makeOllamaClient(c);
  const timer = setTimeout(() => {
    try { ac.abort(); } catch (_) { /* best-effort */ }
    try { if (ollamaClient && typeof ollamaClient.abort === 'function') ollamaClient.abort(); } catch (_) { /* best-effort */ }
  }, c.LLM_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  // Cap the generated length. Every vision caller slices the result to at most 4000 characters (~1300 tokens),
  // so without a cap a model that over-generates runs to the full idle deadline and, on OpenAI, bills the whole
  // length — only for the tail to be discarded. Generous enough to fill that slice with margin while still
  // bounding a runaway/looping model, matching the token caps every other auxiliary model call sets.
  const maxOut = VISION_MAX_OUTPUT_TOKENS;
  try {
    if (isOpenAI) {
      const client = llm.getOpenAIClient();
      if (!client) throw new Error('OpenAI-compatible client unavailable');
      const res = await client.chat.completions.create({
        model,
        max_tokens: maxOut,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        }],
      }, { signal: ac.signal });
      return String(res.choices?.[0]?.message?.content || '').trim();
    }
    const res = await ollamaClient.chat({
      model,
      messages: [{ role: 'user', content: prompt, images: [b64] }],
      stream: false,
      options: { temperature: c.VISION_TEMPERATURE == null ? 0.2 : c.VISION_TEMPERATURE, num_predict: maxOut },
    });
    return String(res?.message?.content || '').trim();
  } catch (e) {
    throw new Error(friendlyVisionError(e, model));
  } finally {
    clearTimeout(timer);
  }
}

// Describe an image: a 1-2 sentence description of what's actually visible, plus a
// handful of lowercase tags — both indexed so the image is searchable by content.
// imgBufferOrPath: a Buffer of image bytes, or a path to an image file.
async function describeImage(imgBufferOrPath, { model, max } = {}) {
  const cap = max || cfg().VISION_MAX_TAGS || 12;
  const b64 = await imageToBase64(imgBufferOrPath);
  const q =
    `Look at this image and respond ONLY with JSON: {"description": "...", "tags": ["...", "..."]}. ` +
    `description: 2-4 sentences describing what is actually visible — the subject, setting, any text or labels, notable details, and (for diagrams/charts/screenshots) what it depicts or conveys. ` +
    `tags: up to ${cap} concise lowercase tags (subjects, objects, type of image, setting, colors, style). ` +
    `No preamble, no markdown, JSON only.`;
  const raw = await ask(b64, q, model);
  const { extractJson } = require('./llm-json');
  const j = extractJson(raw);
  if (j && (j.description || Array.isArray(j.tags))) {
    let tags = Array.isArray(j.tags) ? j.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean) : [];
    tags = [...new Set(tags)].slice(0, cap);
    return { description: String(j.description || '').trim().slice(0, 1200), tags };
  }
  // Fallback: if JSON parsing failed but we got prose, use it as the description.
  if (raw) return { description: raw.slice(0, 1200), tags: [] };
  throw new Error('Vision describe returned nothing usable.');
}

// Describe the FIGURES, CHARTS, and TABLES on a rendered document page, for the
// visual-ingest pass (lib/indexing/visualdocs.js). Unlike describeImage (whole-image
// caption + tags) and OCR (verbatim text), this asks the model to explain what the visuals
// convey and to reproduce tables as Markdown, so a chart's takeaway or a table's data
// becomes searchable — content the plain text layer loses. Body text and headers/footers
// are deliberately ignored (already captured elsewhere). Returns the description text, or
// '' when the page has no figures/charts/tables (the model answers the sentinel "NONE") or
// on any empty result. `model` defaults to the configured VISION_MODEL. Never caches here;
// the caller owns caching.
const PAGE_VISUAL_SENTINEL = 'NONE';
const PAGE_VISUAL_PROMPT =
  'This is one page of a document. Describe ONLY its figures, charts, graphs, diagrams, and tables ' +
  'so someone who cannot see the page could understand and search for them.\n' +
  'List each one on its own line, starting with its label so it can be referred to precisely: ' +
  'use the number printed on the page if there is one (for example "Figure 3:" or "Table 2:"), ' +
  'otherwise number them in reading order ("Figure 1:", "Figure 2:", "Table 1:").\n' +
  '- For a figure, chart, graph, or diagram: after its label, say what it shows and its key ' +
  'takeaway (the trend, comparison, or labeled values it conveys).\n' +
  '- For a table: after its label, give a one-line caption, then reproduce it as GitHub-flavored ' +
  'Markdown with its headers and rows.\n' +
  'Ignore ordinary body text, headers, and footers — those are captured elsewhere. ' +
  `If the page has no figures, charts, graphs, diagrams, or tables, reply with exactly: ${PAGE_VISUAL_SENTINEL}`;

async function describePageVisuals(imgBufferOrPath, { model } = {}) {
  const b64 = await imageToBase64(imgBufferOrPath);
  const raw = String(await ask(b64, PAGE_VISUAL_PROMPT, model) || '').trim();
  if (!raw) return '';
  // Treat a bare sentinel (possibly punctuated/quoted) as "nothing visual here".
  if (/^["'`]*NONE[."'`]*$/i.test(raw)) return '';
  return raw.slice(0, 4000);
}

// Like describePageVisuals, but also returns a BOUNDING BOX per figure/table so the caller
// can crop each into its own thumbnail (the pixel-cropping phase). Boxes are requested as
// fractions of the page (0..1), which are resolution-independent — so they apply to the
// full-resolution rendered page even though the model saw a downscaled copy. Returns an array
// of { type, label, description, bbox:[x,y,w,h] } (bbox omitted when the model didn't give a
// usable one — the figure is still described, just not croppable). Returns [] when the page
// has none, or on any failure. `model` defaults to VISION_MODEL. Never caches here.
const FIGURE_TYPES = new Set(['figure', 'chart', 'diagram', 'table']);
const PAGE_FIGURES_PROMPT =
  'This is one page of a document. Find each figure, chart, graph, diagram, and table on it. ' +
  'Respond with ONLY a JSON object: {"figures":[{"type","label","description","bbox"}]}.\n' +
  '- type: one of "figure", "chart", "diagram", "table".\n' +
  '- label: the number printed on the page if there is one ("Figure 3", "Table 2"), otherwise ' +
  'number them in reading order ("Figure 1", "Figure 2", "Table 1").\n' +
  '- description: a thorough, searchable description. For a figure/chart/diagram, say what it ' +
  'shows and its key takeaway (the trend, comparison, or labeled values). For a TABLE, give a ' +
  'short caption then list EVERY row with its values inline so no number is lost, e.g. ' +
  '"Throughput: 4271 units/sec; Latency: 12 ms; Accuracy: 99.3%".\n' +
  '- bbox: [x, y, w, h] as fractions of the page from 0 to 1, where x,y is the TOP-LEFT corner ' +
  'and w,h is the width and height, drawn tightly around the item.\n' +
  'Ignore ordinary body text, headers, and footers. If the page has none, respond {"figures":[]}.';

const clamp01 = (n) => (typeof n === 'number' && isFinite(n)) ? Math.min(1, Math.max(0, n)) : null;
const normalizeBbox = (b) => {
  if (!Array.isArray(b) || b.length !== 4) return null;
  let [x, y, w, h] = b.map(Number);
  // Tolerate a model that returns 0..100 or 0..1000 instead of 0..1.
  const max = Math.max(x, y, w, h);
  const scale = max > 1.5 ? (max > 100 ? 1000 : 100) : 1;
  x = clamp01(x / scale); y = clamp01(y / scale); w = clamp01(w / scale); h = clamp01(h / scale);
  if (x == null || y == null || !w || !h) return null;
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w <= 0.02 || h <= 0.02) return null;   // too small to be a real region
  return [x, y, w, h];
};

async function describePageFigures(imgBufferOrPath, { model } = {}) {
  const b64 = await imageToBase64(imgBufferOrPath);
  const raw = await ask(b64, PAGE_FIGURES_PROMPT, model);
  const { extractJson } = require('./llm-json');
  const j = extractJson(raw);
  const list = j && Array.isArray(j.figures) ? j.figures : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const description = String(f.description || '').trim().slice(0, 4000);
    if (!description) continue;
    const type = FIGURE_TYPES.has(String(f.type || '').toLowerCase()) ? String(f.type).toLowerCase() : 'figure';
    const label = String(f.label || '').trim().slice(0, 60);
    const bbox = normalizeBbox(f.bbox);
    out.push(bbox ? { type, label, description, bbox } : { type, label, description });
  }
  return out;
}

// Render a description + tags into an indexable text block appended to a document.
function toIndexText(result) {
  if (!result) return '';
  const parts = [];
  if (result.description) parts.push(result.description);
  if (result.tags && result.tags.length) parts.push('Tags: ' + result.tags.join(', '));
  return parts.join('\n');
}

// Single source for "would a stored image-describe result differ now?" — every setting that changes
// describeImage's output folded into one string. The OCR cache doubles as the describe-output store but keys only
// on the image bytes + pipeline version, so a VISION_MODEL (or other describe-param) change would otherwise serve
// a stale description for an unchanged image. This signature is STAMPED into the index manifest (indexing/delta.js)
// and COMPARED on warm start (indexing/init.js contentRebuildReason); a mismatch rebuilds, which wipes that cache.
// Both sites call this ONE function so the stamp and the check can never drift. null when describe is off (the
// on↔off transition is handled separately by the _visionEnabled flag). `c` is the config object (not cfg()).
const describeSignature = (c) => (c && c.VISION_DESCRIBE)
  ? [c.VISION_MODEL || '', c.VISION_TEMPERATURE, c.VISION_MAX_TAGS, c.VISION_INPUT_MAX_EDGE].join('|')
  : null;

module.exports = { isEnabled, describeImage, describePageVisuals, describePageFigures, toIndexText, friendlyVisionError, normalizeBbox, describeSignature };
