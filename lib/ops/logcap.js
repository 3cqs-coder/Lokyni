'use strict';
// Bound a supervisor-written log file that would otherwise grow forever on a long-running
// install. The service redirects the process's stdout/stderr into these files (launchd
// StandardOutPath, systemd `append:`, or a pm2 log), and the supervisor holds them open in
// append mode. That rules out rotating by rename — the supervisor would keep writing to the
// old, now-unlinked file, and the fresh file would stay empty. Instead, when a file passes the
// cap, we copy its current contents aside as one retained generation (`<file>.1`) and truncate
// the live file to zero IN PLACE. An append writer then simply continues at the new end
// (offset 0), with no sparse gap and no lost handle. The file is thus bounded to about twice
// the cap. All operations are async and best-effort, so this never blocks or throws.

const fsp = require('fs').promises;

// Rotate one file if it exceeds maxBytes. Returns true if it was rotated.
async function capFile(filePath, maxBytes) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size <= maxBytes) return false;
    try { await fsp.copyFile(filePath, `${filePath}.1`); } catch (_) { /* keep-one-generation is best-effort */ }
    await fsp.truncate(filePath, 0);
    return true;
  } catch (_) {
    return false;   // missing file (not running under a supervisor) or unwritable — nothing to do
  }
}

// Cap several files; returns how many were rotated.
async function capFiles(paths, maxBytes) {
  let n = 0;
  for (const p of paths) { if (p && await capFile(p, maxBytes)) n++; }
  return n;
}

module.exports = { capFile, capFiles };
