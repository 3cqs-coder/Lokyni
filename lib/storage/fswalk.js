'use strict';
// Depth-first file walker shared by the modules that enumerate a directory tree. It centralizes the
// readdir + recurse + error-swallow skeleton so each caller supplies only its own policy — which entries to
// skip, and what to do with each file — instead of re-implementing the traversal. A missing or unreadable
// directory is always treated the same way (skipped, never thrown), so a permission hiccup in one subfolder
// can't abort the whole walk.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Walk `root` depth-first, invoking onFile(fullPath, relPath) for each regular file (relPath is relative to
// `root`). `skipName(name)` (optional) drops a directory or file by its basename before descending into or
// reading it. Symlinks are treated as neither a directory nor a regular file (isDirectory/isFile are both
// false for a symlink entry), so the walk never follows one out of the tree.
const walkFiles = (root, onFile, skipName) => {
  const rec = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skipName && skipName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) onFile(full, path.relative(root, full));
    }
  };
  rec(root);
};

// Collect the relative paths of every file under `root` (optionally filtered by skipName).
const listFiles = (root, skipName) => {
  const out = [];
  walkFiles(root, (_full, rel) => out.push(rel), skipName);
  return out;
};

// Count the files under `root` (optionally filtered by skipName) without materializing the list.
const countFiles = (root, skipName) => {
  let n = 0;
  walkFiles(root, () => { n += 1; }, skipName);
  return n;
};

// Async variant for request paths that must never block the event loop (a large workspace backup, for
// example). The policy is identical to walkFiles: same skip rule, symlinks are neither directories nor files,
// and an unreadable directory is skipped. `onFile` may be async and is awaited.
const walkFilesAsync = async (root, onFile, skipName) => {
  const rec = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skipName && skipName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) await onFile(full, path.relative(root, full));
    }
  };
  await rec(root);
};

const listFilesAsync = async (root, skipName) => {
  const out = [];
  await walkFilesAsync(root, (_full, rel) => out.push(rel), skipName);
  return out;
};

const countFilesAsync = async (root, skipName) => {
  let n = 0;
  await walkFilesAsync(root, () => { n += 1; }, skipName);
  return n;
};

module.exports = { walkFiles, listFiles, countFiles, walkFilesAsync, listFilesAsync, countFilesAsync };
