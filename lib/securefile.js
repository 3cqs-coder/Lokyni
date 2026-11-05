'use strict';

// Best-effort: restrict a just-written secret file to its owner.
//
// POSIX: the caller already writes these files with mode 0o600, which the OS honors, so this is a
// deliberate no-op there.
//
// Windows: libuv silently ignores the `mode` argument, so a secret file (the master key) would land with
// the directory's inherited ACLs — potentially readable by other local accounts on a shared machine.
// Remove inherited entries and grant only the current user, via icacls. There is no Node-native way to set
// an NTFS ACL, so this one spawn is the standard approach; it is fully guarded — never throws, never blocks
// (fire-and-forget with a short timeout). If icacls is missing or fails, the data directory's own per-user
// ACLs remain the boundary (the recommended deployment keeps the data dir in a per-user location).

const { execFile } = require('child_process');
const os = require('os');

function restrictToOwner(filePath) {
  if (process.platform !== 'win32') return;   // POSIX: mode 0o600 at write time already did it
  if (!filePath) return;
  let user = '';
  try { user = os.userInfo().username; } catch { user = ''; }
  if (!user) return;   // can't name the grantee → leave the dir ACLs as the boundary
  try {
    execFile(
      'icacls', [String(filePath), '/inheritance:r', '/grant:r', `${user}:F`],
      { windowsHide: true, timeout: 5000 },
      () => { /* best effort — ignore success/failure */ }
    );
  } catch { /* spawn failed (icacls absent) — fall back to the data-dir ACLs */ }
}

module.exports = { restrictToOwner };
