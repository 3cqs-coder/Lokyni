'use strict';
// MCP connectors — ingestion sources that pull documents INTO a Lokyni workspace
// via an MCP server (Direction B).
//
// A connector is a persisted config describing an MCP server to spawn and how to
// pull documents from it. Connectors are stored per-workspace in the workspace
// settings (settings.json → `connectors: []`), so each workspace can sync from its
// own sources.
//
// The first connector type is `filesystem`, backed by the official
// @modelcontextprotocol/server-filesystem: point it at a directory, and Lokyni walks
// the tree (directory_tree), reads each text file (read_text_file), and writes them
// as documents into the workspace — then indexes. This proves the whole MCP-client
// ingestion path end-to-end with a real, installable server and no auth.
//
// Adding another connector type (github, etc.) means adding a builder in
// SPEC_BUILDERS (how to spawn that server) and, if its tools differ, a puller in
// PULLERS. The client, registry, write path, and indexing are all shared.

const path = require('path');
const fsp  = require('fs').promises;
const crypto = require('crypto');
const wsm = require('../workspaces');
const mcpClient = require('./client');

// ── Registry (persisted per-workspace in settings.json) ──────────────────────

const listConnectors = (dataDir, workspaceId) => {
  const s = wsm.loadSettings(dataDir, workspaceId) || {};
  return Array.isArray(s.connectors) ? s.connectors : [];
};

// Connector access tokens (e.g. a GitHub personal access token) are reversible credentials, so they are
// sealed at rest with the same secretbox + master key the config store uses. One shared label binds every
// connector token's ciphertext to "a connector token" (so it can't be opened as a config secret). keySrc is
// a function to defer the config require (no load-order cycle).
const secretbox = require('../secretbox');
const CONNECTOR_SECRET_LABEL = 'connector.token';
const keySrc = () => require('../config').SECRET_KEY_SRC;
// Seal every connector's token before it is persisted; idempotent on already-sealed values, a no-op without a
// key (stays plaintext), and it never turns a token into something unrecoverable (sealVerified round-trips).
const sealTokens = (connectors, src = keySrc()) => {
  for (const c of connectors) {
    if (c && c.config && typeof c.config.token === 'string' && c.config.token) {
      c.config.token = secretbox.sealVerified(c.config.token, CONNECTOR_SECRET_LABEL, src);
    }
  }
  return connectors;
};
// A shallow clone of a stored config with its token OPENED for use (spawning the server / walking the API).
// Legacy plaintext passes through; an unopenable value is left verbatim so the connect fails cleanly.
const openConfig = (config, src = keySrc()) => {
  if (!config || typeof config.token !== 'string' || !config.token) return config;
  return { ...config, token: secretbox.readSecret(config.token, CONNECTOR_SECRET_LABEL, src) };
};

const saveConnectors = (dataDir, workspaceId, connectors) => {
  const s = wsm.loadSettings(dataDir, workspaceId) || {};
  s.connectors = sealTokens(connectors);
  wsm.saveSettings(dataDir, workspaceId, s);
};

// Add a connector. `def` = { type, name, config }. Returns the stored record.
const addConnector = (dataDir, workspaceId, def) => {
  if (!SPEC_BUILDERS[def.type]) throw new Error(`Unknown connector type: ${def.type}`);
  // Validate the config now (builder throws on bad input) so the user is told at
  // add-time, not after a failed sync.
  SPEC_BUILDERS[def.type](def.config || {});
  const connectors = listConnectors(dataDir, workspaceId);
  const record = {
    id: 'c_' + crypto.randomBytes(4).toString('hex'),
    type: def.type,
    name: (def.name || def.type).slice(0, 64),
    config: def.config || {},
    created: Date.now(),
    lastSync: null,
    lastResult: null,
  };
  connectors.push(record);
  saveConnectors(dataDir, workspaceId, connectors);
  return record;
};

// Remove a connector's config. `deleteDocs` also removes the COPIES Lokyni ingested
// under documents/_connectors/<id>/ and reindexes — it NEVER touches the connector's
// source folder (config.path), which Lokyni only ever reads. Without deleteDocs, the
// ingested copies remain as normal workspace documents.
const removeConnector = async (dataDir, workspaceId, id, deleteDocs = false) => {
  const connectors = listConnectors(dataDir, workspaceId);
  if (!connectors.some(c => c.id === id)) return false;

  if (deleteDocs) {
    // Delete ONLY Lokyni's ingested copies for this connector. This path is always
    // inside the workspace's own documents dir — never the user's source folder.
    const subdir = path.join(wsm.docsDirFor(dataDir, workspaceId), '_connectors', id);
    await fsp.rm(subdir, { recursive: true, force: true });
    console.log(`🗑️  Connector removed — deleted ingested copies, reindexing "${workspaceId}"…`);
    // Serialized through the shared lifecycle lock so removal can't race a switch/rebuild/restore.
    await require('../indexing/init').reflectWorkspaceMutation(workspaceId, (id) => require('../indexing/bundle').invalidateBundle(id));
  }

  // Read-modify-write the CURRENT settings (not the pre-await snapshot): a long reindex above leaves a wide
  // window in which another connector could be added, or a sync could record its result, and writing back a
  // stale list would silently drop that change. Filter the id out of the freshly-read list instead.
  wsm.updateSettings(dataDir, workspaceId, (s) => {
    s.connectors = (Array.isArray(s.connectors) ? s.connectors : []).filter(c => c.id !== id);
    return s;
  });
  return true;
};

// ── Spec builders: how to spawn the MCP server for each connector type ────────

// Which npm package (and, optionally, version) backs a connector. The default is the
// unpinned official server name — consistent with the project's caret-range dependency
// policy, which intentionally tracks upstream rather than freezing exact versions. An
// operator who wants supply-chain pinning, or who needs to repoint at a replacement
// package (see the GitHub wind-down caveat below), can set `config.package` to an exact
// spec like "@modelcontextprotocol/server-filesystem@2025.1.0". The spec is validated to
// a safe npm package-spec shape so it can't smuggle an npx flag (a leading "-"), a local
// path, or shell metacharacters into the spawned command.
const PKG_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.^~*-]+)?$/;
const connectorPackage = (config, defaultPkg) => {
  const raw = (config.package || '').trim();
  if (!raw) return defaultPkg;
  if (!PKG_SPEC_RE.test(raw)) throw new Error(`Invalid connector package spec: ${raw}. Use a name like "@scope/pkg" or a pinned "@scope/pkg@1.2.3".`);
  return raw;
};

// Normalize a GitHub connector's config into { owner, repo, branch?, subpath }.
// Shared by the spec builder (validation) and the puller (walking), so the two can't
// interpret the config differently. Tolerates "owner/repo" pasted into the owner field.
const githubTarget = (config) => {
  let owner = (config.owner || '').trim();
  let repo  = (config.repo  || '').trim();
  if (owner.includes('/')) { const [o, ...rest] = owner.split('/'); owner = o.trim(); if (!repo) repo = rest.join('/').trim(); }
  return {
    owner, repo,
    branch:  (config.branch  || '').trim() || undefined,
    subpath: (config.subpath || '').trim().replace(/^\/+|\/+$/g, ''),
  };
};

// Windows spawns need the .cmd shim; POSIX uses the bare binary. StdioClientTransport
// spawns without a shell, so a bare 'npx' fails to resolve on Windows.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const SPEC_BUILDERS = {
  // Filesystem: the official server, scoped to the configured root directory. The
  // server refuses any path outside the roots it's launched with, so the config's
  // `path` is both what we spawn with and the boundary.
  filesystem: (config) => {
    const p = (config.path || '').trim();
    if (!p) throw new Error('filesystem connector needs a "path"');
    // path.isAbsolute accepts both POSIX (/Users/…) and Windows (C:\…) absolute paths, so the
    // connector works cross-platform rather than rejecting every Windows path.
    if (!path.isAbsolute(p)) throw new Error(`Folder path must be absolute. Got: ${p}`);
    const norm = p.replace(/[/\\]+$/, '');
    if (norm === '' || /^[a-zA-Z]:$/.test(norm)) throw new Error('Refusing to sync a whole drive / filesystem root. Point the connector at a specific folder, e.g. /Users/you/Documents/notes');
    return { command: NPX, args: ['-y', connectorPackage(config, '@modelcontextprotocol/server-filesystem'), p] };
  },

  // GitHub: the official @modelcontextprotocol/server-github, which reads a repo's
  // files through the GitHub API. A public repo works with no token (rate-limited);
  // a private repo — or higher rate limits — needs a personal access token, passed to
  // the server via the GITHUB_PERSONAL_ACCESS_TOKEN env var (never on the command line,
  // so it can't leak into process listings).
  //
  // UPSTREAM CAVEAT: @modelcontextprotocol/server-github is being wound down in favor
  // of GitHub's own server (github/github-mcp-server, a Go binary / Docker image). This
  // npx-JS package was verified working against a live repo, and its get_file_contents
  // tool is what pullGithub below walks. If npx ever fails to resolve it, an operator can
  // repoint at a replacement npm package per-connector via config.package (no code change);
  // if the replacement's tool shape differs, repoint the command/args here and adjust
  // pullGithub — the rest of the framework is server-agnostic. GitHub's server isn't
  // npx-spawnable today, which is why this one is used.
  github: (config) => {
    const { owner, repo } = githubTarget(config);
    if (!owner || !repo) throw new Error('GitHub connector needs an owner and a repository (e.g. owner "octocat", repo "Hello-World").');
    if (/\s/.test(owner) || /\s/.test(repo) || repo.includes('/')) throw new Error('Owner and repository must be plain names without spaces or slashes — put each half of "owner/repo" in its own field.');
    const token = (config.token || '').trim();
    return {
      command: NPX,
      args: ['-y', connectorPackage(config, '@modelcontextprotocol/server-github')],
      env: token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {},
    };
  },
};

// ── Pullers: how to turn a connected server into a list of {name, text} docs ──

// Default puller for filesystem-style servers exposing directory_tree +
// read_text_file. Walks the tree, reads each file with a text-ish extension.
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml']);

// Directories that are almost never what someone means to ingest — dependency
// trees, VCS internals, build output, caches. Skipped entirely (we don't even
// descend into them), which also makes syncing a code project vastly faster. A
// connector can override with config.exclude (array of dir names) or add to these
// with config.excludeExtra.
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  'vendor', 'bower_components', '.gradle', '.terraform', 'coverage', '.pytest_cache',
  '.obsidian', '.trash',   // Obsidian vault config + trash — never real content
]);

const pullFilesystem = async (conn, config, onProgress) => {
  const root = config.path.replace(/[/\\]+$/, '') || '/';   // strip a trailing separator (/ or \ on Windows); keep bare "/"
  const excludeDirs = resolveExcludeDirs(config);

  const treeRes = await conn.callTool('directory_tree', { path: root });
  // Bound the materialized string to just over the max (so the size check below still fires with its helpful
  // message) — an untrusted server can't make us hold an unbounded tree listing in memory before that check.
  const treeText = mcpClient.textOf(treeRes, FS_TREE_MAX_CHARS + 1);

  // The server reports problems (access denied, no such dir) as an error result
  // whose text is a plain message, NOT JSON. Surface that message instead of a
  // confusing "did not return JSON".
  if (treeRes.isError) {
    throw new Error(treeText || `Could not read "${root}"`);
  }
  // Refuse an implausibly large tree before parsing, so a folder full of build/dependency junk can't
  // OOM the process on JSON.parse. Ask the user to narrow the folder or add excludes rather than crash.
  if (treeText && treeText.length > FS_TREE_MAX_CHARS) {
    throw new Error(`"${root}" has too many files/subfolders to scan safely (${Math.round(treeText.length / 1e6)} MB of listing). Point the connector at a narrower folder, or exclude large subfolders like node_modules, .git, and build.`);
  }
  let tree;
  try { tree = JSON.parse(treeText); }
  catch { throw new Error(`Unexpected response reading "${root}": ${treeText.slice(0, 200)}`); }

  // Flatten the recursive {name,type,children} tree into relative file paths,
  // skipping excluded directories entirely (never descend into node_modules etc.).
  const files = [];
  const WALK_MAX_DEPTH = 100;   // an untrusted server could return a pathologically deep tree; cap recursion
  const walk = (nodes, prefix, depth) => {
    if (depth > WALK_MAX_DEPTH) return;   // stop descending — don't risk a stack overflow on a malicious tree
    for (const node of nodes) {
      if (node.type === 'directory') {
        if (excludeDirs.has(node.name)) continue;   // skip junk dirs wholesale
        const rel = prefix ? `${prefix}/${node.name}` : node.name;
        if (Array.isArray(node.children)) walk(node.children, rel, depth + 1);
      } else if (node.type === 'file') {
        files.push(prefix ? `${prefix}/${node.name}` : node.name);
      }
    }
  };
  walk(Array.isArray(tree) ? tree : [], '', 0);

  // Only text files are candidates; count them up front so progress has a total. Bound the pull the way
  // the github connector does: cap the file COUNT and each file's SIZE, since every file's text is
  // buffered in memory before it is written — an uncapped sync against a huge tree (or one with giant
  // log/CSV files) would otherwise exhaust memory. The count cap is config-overridable.
  const allCandidates = files.filter(rel => TEXT_EXT.has(path.extname(rel).toLowerCase()));
  const maxFiles = (Number.isFinite(config.maxFiles) && config.maxFiles > 0) ? config.maxFiles : FS_MAX_FILES;
  const candidates = allCandidates.slice(0, maxFiles);
  const docs = [];
  let done = 0;
  let totalChars = 0;
  let hitBudget = false;
  let readErrors = 0;   // files that were listed but could not be read this pass (transient degradation)
  for (const rel of candidates) {
    const abs = path.join(root, rel);   // native separators (the filesystem MCP server is local)
    try {
      const res = await conn.callTool('read_text_file', { path: abs });
      if (res.isError) { readErrors++; console.error(`[connectors] skipped ${rel}: ${mcpClient.textOf(res)}`); }
      else {
        const text = mcpClient.textOf(res, FS_MAX_FILE_CHARS);   // cap at read — never materialize a giant single file
        if (text && text.trim()) {
          docs.push({ name: rel.replace(/[\\/]/g, '_'), text });
          totalChars += text.length;
          // Cap the TOTAL text buffered across the whole sync, not just per file. The per-file and
          // per-count caps still allow a large product (~4 GB worst case) to accumulate before anything
          // is written; this total budget keeps peak memory bounded regardless of how many files match.
          if (totalChars >= FS_TOTAL_MAX_CHARS) { hitBudget = true; done++; break; }
        }
      }
    } catch (e) {
      readErrors++;
      console.error(`[connectors] skipped ${rel}: ${e.message}`);
    }
    done++;
    if (onProgress && (done % 5 === 0 || done === candidates.length)) {
      onProgress({ phase: 'pull', done, total: candidates.length });
    }
  }
  const capped = hitBudget || allCandidates.length > maxFiles;
  if (hitBudget) console.log(`[connectors] filesystem: reached the total-size budget (${Math.round(FS_TOTAL_MAX_CHARS / 1e6)} MB) for "${root}" — remaining files were not pulled this sync`);
  else if (allCandidates.length > maxFiles) console.log(`[connectors] filesystem: reached maxFiles cap (${maxFiles}) for "${root}" — some files were not pulled`);
  return { docs, readErrors, capped };
};
const FS_MAX_FILES = 2000;         // bound the number of files a single filesystem sync buffers
const FS_MAX_FILE_CHARS = 2_000_000;   // and the size of any one file held in memory (~2 MB)
const FS_TOTAL_MAX_CHARS = 128_000_000;   // and the TOTAL text buffered across one sync (~128 MB) — OOM guard
// Bound the directory-tree JSON before it is parsed. The filesystem MCP server walks the WHOLE tree
// (excludes are applied by us AFTER parsing), so pointing a connector at a folder containing a large
// node_modules/.git/build serializes hundreds of thousands of paths into one string; JSON.parse then
// doubles it, a spike that can exhaust memory. 20 MB of tree JSON is far more than a real document
// folder needs; beyond it, fail with actionable guidance instead of risking an OOM.
const FS_TREE_MAX_CHARS = 20_000_000;

// Resolve the exclude-dir set for a connector: the shared defaults, replaced wholesale
// by config.exclude if present, plus any config.excludeExtra. Shared by both pullers so
// their exclusion behavior stays identical.
const resolveExcludeDirs = (config) => {
  const set = new Set(DEFAULT_EXCLUDE_DIRS);
  if (Array.isArray(config.exclude)) { set.clear(); config.exclude.forEach(d => set.add(d)); }
  if (Array.isArray(config.excludeExtra)) config.excludeExtra.forEach(d => set.add(d));
  return set;
};

// Fraction of characters that are printable text or common whitespace — used to tell
// decoded text from binary garbage.
const printableRatio = (s) => {
  if (!s) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) ok++;
  }
  return ok / s.length;
};

// A string that could genuinely be base64: only the base64 alphabet (+ line wraps),
// length a multiple of 4. Plain prose fails this (spaces, punctuation, odd length).
const looksBase64 = (s) => s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(s);

// Decode a file returned by the GitHub server's get_file_contents. It returns the
// GitHub contents-API JSON object; historically `content` is base64 with
// `encoding: "base64"`, but the current server already returns the DECODED text in
// `content` while STILL labeling it `encoding: "base64"` — so the encoding field can't
// be trusted. Only base64-decode when `content` actually looks like base64 and decoding
// yields more-readable text; otherwise it's already plain text. Also handles a `text`
// field or raw decoded text, for other server variants.
const decodeGithubFile = (raw) => {
  const t = (raw || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.content === 'string') {
        const c = obj.content;
        const compact = c.replace(/\s+/g, '');
        if (looksBase64(compact)) {
          const decoded = Buffer.from(compact, 'base64').toString('utf-8');
          if (printableRatio(decoded) >= printableRatio(c)) return decoded;
        }
        return c;   // already-decoded text (current server behavior)
      }
      if (obj && typeof obj.text === 'string') return obj.text;
    } catch { /* not JSON — fall through to raw */ }
  }
  return raw;
};

const GITHUB_MAX_FILES = 500;

// Puller for the GitHub server. get_file_contents returns a JSON array of
// {type,name,path} entries for a directory and a JSON object with base64 content for a
// file, so we breadth-first walk directories (skipping the shared junk-dir set) to
// collect text-file paths, then read each. Reuses TEXT_EXT / DEFAULT_EXCLUDE_DIRS and
// the {name,text} doc shape so a GitHub-ingested repo behaves like any other source.
const pullGithub = async (conn, config, onProgress) => {
  const { owner, repo, branch, subpath } = githubTarget(config);
  if (!conn.tools.some(t => t.name === 'get_file_contents')) {
    throw new Error(`This GitHub MCP server doesn't expose "get_file_contents". Tools available: ${conn.tools.map(t => t.name).join(', ') || '(none)'}`);
  }
  const excludeDirs = resolveExcludeDirs(config);
  const maxFiles = (Number.isFinite(config.maxFiles) && config.maxFiles > 0) ? config.maxFiles : GITHUB_MAX_FILES;
  const get = (p) => conn.callTool('get_file_contents', branch ? { owner, repo, path: p, branch } : { owner, repo, path: p });

  // Pass 1 — walk directories, collecting text-file paths.
  const filePaths = [];
  const queue = [subpath || ''];
  const seen = new Set();
  let readErrors = 0;   // listing/read failures this pass — a dropped subtree or file is transient degradation
  while (queue.length && filePaths.length < maxFiles) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let res;
    try { res = await get(dir); }
    catch (e) { readErrors++; console.error(`[connectors] github list "${dir || '/'}" failed: ${e.message}`); continue; }
    if (res.isError) {
      const msg = mcpClient.textOf(res);
      // A failure at the starting path is fatal (bad repo / auth / rate limit); deeper
      // directory failures are skipped so one bad subtree doesn't abort the whole sync.
      if (dir === (subpath || '')) throw new Error(msg || `Could not read ${owner}/${repo}`);
      readErrors++;
      console.error(`[connectors] github list "${dir}" error: ${msg}`);
      continue;
    }
    let entries;
    try { entries = JSON.parse(mcpClient.textOf(res)); } catch { continue; }
    if (!Array.isArray(entries)) continue;   // a file path was walked as a dir — ignore
    for (const e of entries) {
      if (!e || !e.path || !e.type) continue;
      const base = e.name || e.path.split('/').pop();
      if (e.type === 'dir') { if (!excludeDirs.has(base)) queue.push(e.path); }
      else if (e.type === 'file' && TEXT_EXT.has(path.extname(base).toLowerCase())) filePaths.push(e.path);
    }
  }

  // Pass 2 — read each file, capping EACH file's size and the TOTAL buffered across the sync, mirroring the
  // filesystem puller. Every file's text is held in memory before it is written, so an untrusted or very large
  // repo (many big CSV/JSON/MD files) must not buffer unbounded text and drive the process into OOM.
  const capped = filePaths.slice(0, maxFiles);
  const docs = [];
  let done = 0, totalChars = 0, hitBudget = false;
  for (const fp of capped) {
    try {
      const res = await get(fp);
      if (res.isError) { readErrors++; console.error(`[connectors] github skipped ${fp}: ${mcpClient.textOf(res)}`); }
      else {
        // Bound the RAW response before decode (base64 is ~4/3 of the file, plus JSON overhead, so 2× the file cap
        // leaves room for a legitimate max-size file while stopping a malicious multi-hundred-MB response from being
        // JSON-parsed/whitespace-stripped/base64-decoded — several full-size copies — before the per-file cap.
        let text = decodeGithubFile(mcpClient.textOf(res, FS_MAX_FILE_CHARS * 2));
        if (text && text.length > FS_MAX_FILE_CHARS) text = text.slice(0, FS_MAX_FILE_CHARS);   // cap the decoded file
        if (text && text.trim()) {
          docs.push({ name: fp.replace(/[\\/]/g, '_'), text });
          totalChars += text.length;
          if (totalChars >= FS_TOTAL_MAX_CHARS) { hitBudget = true; done++; break; }   // OOM guard: stop the sync
        }
      }
    } catch (e) { readErrors++; console.error(`[connectors] github skipped ${fp}: ${e.message}`); }
    done++;
    if (onProgress && (done % 5 === 0 || done === capped.length)) onProgress({ phase: 'pull', done, total: capped.length });
  }
  if (hitBudget) console.log(`[connectors] github: reached the total-size budget (${Math.round(FS_TOTAL_MAX_CHARS / 1e6)} MB) for ${owner}/${repo} — remaining files were not pulled this sync`);
  if (filePaths.length >= maxFiles) console.log(`[connectors] github: reached maxFiles cap (${maxFiles}) for ${owner}/${repo} — some files were not pulled`);
  return { docs, readErrors, capped: filePaths.length >= maxFiles || hitBudget };
};

const PULLERS = { filesystem: pullFilesystem, github: pullGithub };

// ── Sync: connect, pull, write, index ────────────────────────────────────────

// Decide whether a pull is too degraded to replace the last-good ingested set. A re-sync overwrites the
// previous copy, so a TRANSIENT failure (rate-limiting, a network blip, an unreadable subtree) that
// returns fewer documents than last time must NOT wipe the good copy — that is the standing "never
// overwrite good data on a degraded refresh" rule. Two cases are treated as degraded: an empty pull when
// we previously had documents, and a pull that both hit read errors AND came back smaller than the last
// set (files that existed before failed to read this time). A clean shrink with no read errors (files
// genuinely removed at the source) is allowed through, and a first sync (prevCount 0) always proceeds.
const pullIsDegraded = (newCount, prevCount, readErrors) => {
  if (prevCount <= 0) return false;                          // nothing to protect yet
  if (newCount === 0) return true;                           // wiped to empty — never trust this
  return readErrors > 0 && newCount < prevCount;             // dropped files with errors — likely transient
};

// Replace a connector's document folder atomically: write the new set into a staging dir, then swap it in
// by moving the current copy aside and renaming staging into place. This closes the window the old
// destroy-then-rewrite left open, where a crash or full disk between deleting the folder and finishing the
// writes left the connector's documents missing or half-written. Mirrors the stage-then-swap in backup.js.
const replaceConnectorDocsAtomic = async (subdir, docs) => {
  const staging = `${subdir}.syncing-${crypto.randomBytes(6).toString('hex')}`;
  const old     = `${subdir}.old-${crypto.randomBytes(6).toString('hex')}`;
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  for (const doc of docs) {
    await fsp.writeFile(path.join(staging, doc.name.endsWith('.txt') ? doc.name : `${doc.name}.txt`), doc.text, 'utf-8');
  }
  let movedAside = false;
  try {
    try { await require('../disk').renameWithRetry(subdir, old); movedAside = true; }
    catch (e) { if (e && e.code !== 'ENOENT') throw e; }     // no previous copy is fine
    await require('../disk').renameWithRetry(staging, subdir);                        // put the new set in place
  } catch (e) {
    if (movedAside) { try { await require('../disk').renameWithRetry(old, subdir); } catch { /* best-effort restore */ } }
    try { await fsp.rm(staging, { recursive: true, force: true }); } catch {}
    throw e;
  }
  if (movedAside) { try { await fsp.rm(old, { recursive: true, force: true }); } catch { /* best-effort */ } }
};

// Run one connector: spawn its MCP server, pull documents, write them into the
// workspace's documents dir (namespaced under a per-connector subfolder so re-syncs
// replace cleanly and different connectors don't collide), then reindex.
// Returns { ok, count, error? }.
const syncConnector = async (dataDir, workspaceId, connectorId) => {
  const connectors = listConnectors(dataDir, workspaceId);
  const record = connectors.find(c => c.id === connectorId);
  if (!record) return { ok: false, error: 'No such connector' };

  const builder = SPEC_BUILDERS[record.type];
  const puller  = PULLERS[record.type];
  if (!builder || !puller) return { ok: false, error: `Unsupported connector type: ${record.type}` };

  let conn;
  const emit = (payload) => { try { require('../socket').broadcast('sync_progress', { workspaceId, connectorId, name: record.name, ...payload }); } catch {} };
  try {
    emit({ phase: 'connect' });
    const useConfig = openConfig(record.config);   // open the sealed token for use (spawn + API walk)
    const spec = builder(useConfig);
    conn = await mcpClient.connect(spec);

    const { docs, readErrors = 0 } = await puller(conn, useConfig, (p) => emit(p));

    // Write into a per-connector subfolder so a re-sync can replace the set and
    // connectors never overwrite each other's files or manually-added ones.
    const subdir = path.join(wsm.docsDirFor(dataDir, workspaceId), '_connectors', record.id);

    // Fail safe: if this pull came back degraded (empty, or smaller after read errors), keep the last-good
    // copy rather than overwriting it — a transient rate-limit or network blip must not wipe the ingested
    // corpus. A clean shrink with no read errors (files removed at the source) still replaces normally.
    let prevCount = 0;
    try { prevCount = (await fsp.readdir(subdir)).filter(n => n.endsWith('.txt')).length; } catch { /* no previous set */ }
    if (pullIsDegraded(docs.length, prevCount, readErrors)) {
      const detail = `sync returned ${docs.length} document(s) with ${readErrors} read error(s); kept the previous ${prevCount}`;
      console.error(`[connectors] ${record.name}: ${detail}`);
      wsm.updateSettings(dataDir, workspaceId, (s) => {
        const live = Array.isArray(s.connectors) && s.connectors.find(c => c.id === record.id);
        if (live) { live.lastSync = Date.now(); live.lastResult = { ok: false, degraded: true, count: docs.length, kept: prevCount, error: detail }; }
        return s;
      });
      emit({ phase: 'done', degraded: true, count: prevCount });
      return { ok: false, degraded: true, kept: prevCount, error: 'Sync incomplete — kept the previously synced documents.' };
    }

    emit({ phase: 'write', total: docs.length });
    await replaceConnectorDocsAtomic(subdir, docs);

    // Record result on the connector via a fresh read-modify-write: the pull above can
    // take a while, so patch this connector's fields onto current settings rather than
    // writing back the array read at entry (which would drop a connector added meanwhile).
    wsm.updateSettings(dataDir, workspaceId, (s) => {
      const live = Array.isArray(s.connectors) && s.connectors.find(c => c.id === record.id);
      if (live) { live.lastSync = Date.now(); live.lastResult = { ok: true, count: docs.length }; }
      return s;
    });

    // Index through the shared, lock-serialized helper so a background/scheduled sync can't race a
    // workspace switch, rebuild, or restore (reindex the active workspace, else invalidate its cache).
    emit({ phase: 'index', total: docs.length });
    await require('../indexing/init').reflectWorkspaceMutation(workspaceId, (id) => require('../indexing/bundle').invalidateBundle(id));

    emit({ phase: 'done', count: docs.length });
    return { ok: true, count: docs.length };
  } catch (e) {
    const msg = e.message || String(e);
    wsm.updateSettings(dataDir, workspaceId, (s) => {
      const live = Array.isArray(s.connectors) && s.connectors.find(c => c.id === connectorId);
      if (live) { live.lastSync = Date.now(); live.lastResult = { ok: false, error: msg }; }
      return s;
    });
    return { ok: false, error: msg };
  } finally {
    if (conn) await conn.close();
  }
};

// Test a connector without syncing: spawn its MCP server, connect, list tools,
// disconnect. Returns { ok, tools?, toolCount?, error? }. Verifies the config works
// before the user relies on it — reads nothing, writes nothing, indexes nothing.
const testConnector = async (dataDir, workspaceId, connectorId) => {
  const record = listConnectors(dataDir, workspaceId).find(c => c.id === connectorId);
  if (!record) return { ok: false, error: 'No such connector' };
  const builder = SPEC_BUILDERS[record.type];
  if (!builder) return { ok: false, error: `Unsupported connector type: ${record.type}` };

  let conn;
  try {
    const spec = builder(openConfig(record.config));   // open the sealed token for the test connect
    conn = await mcpClient.connect(spec);
    const tools = conn.tools.map(t => t.name);
    return { ok: true, toolCount: tools.length, tools };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    if (conn) await conn.close();
  }
};

module.exports = {
  listConnectors, addConnector, removeConnector, syncConnector, testConnector,
  CONNECTOR_TYPES: Object.keys(SPEC_BUILDERS),
  // Internals exposed for tests (underscore convention, as in websearch.js).
  _SPEC_BUILDERS: SPEC_BUILDERS, _PULLERS: PULLERS,
  _githubTarget: githubTarget, _decodeGithubFile: decodeGithubFile,
  _connectorPackage: connectorPackage,
  _pullIsDegraded: pullIsDegraded, _replaceConnectorDocsAtomic: replaceConnectorDocsAtomic,
  _sealTokens: sealTokens, _openConfig: openConfig, _CONNECTOR_SECRET_LABEL: CONNECTOR_SECRET_LABEL,
};
