'use strict';

// ── statkey — one definition of "has this file changed since we cached it?" ─────────────────────────────
//
// Single source of truth for every stat-keyed read cache in the app (lib/jsonstore.js, lib/workspaces.js,
// lib/graphstore.js, lib/semanticcache.js, lib/outcomes.js, lib/indexing/manifest.js, and the bank-adapter cache
// in lib/indexing/banks.js), so they can't drift apart on this subtle decision.
//
// Why not mtime alone: filesystem mtime has a granularity. fs stat reports it in milliseconds, and some
// filesystems — notably some CI disks and network/overlay mounts — advance it coarsely, so two quick writes to a
// file can share an mtime. A cache keyed on mtime ALONE then keeps serving the stale parse and misses the change
// (this intermittently failed a workspace-cache test on CI, and is a latent correctness bug on a shared or
// scaled-out data directory where another node rewrites a file within the same tick). The fingerprint pairs the
// mtime with the byte size (any change that alters the length is caught — the overwhelmingly common case for a
// JSON store) and the inode (an atomic-rename replacement that kept the same size and mtime still gets a new
// inode). All three come from the single stat the caller already does, so detection stays one cheap stat, no
// extra read. Cross-platform: on Windows st.ino can be 0 for some filesystems, so it contributes nothing there —
// mtime + size still carry the signal, exactly as before this was centralized.
//
// Usage: the caller does its own fs.statSync / await fs.promises.stat (sync or async as it already is), catches a
// missing-file error, and passes the stat object — or nothing, when the file is absent. An absent file yields
// ABSENT, a sentinel that never equals a real file's key. A cache then re-reads for an absent file UNLESS it
// deliberately compares the sentinel on both sides (some advisory caches treat "absent" and "just written, flush
// pending" alike); that policy stays with each cache, only the fingerprint is shared here.

const ABSENT = '';

const statKey = (st) => (st && typeof st.mtimeMs === 'number') ? `${st.mtimeMs}:${st.size}:${st.ino}` : ABSENT;

// A file's modification time in milliseconds, or 0 when it can't be stat'd (absent/unreadable). This is for
// freshness/ordering GATES — "is this derived map older than the manifest that produced it?" — where a single
// comparable number is what's wanted, NOT for cache change-detection (that must use statKey above: a raw mtime
// alone misses a same-tick edit). One source for the "mtime or 0" default so it can't drift across the index-map
// freshness checks that each used to inline it.
const mtimeOf = (p) => require('fs').promises.stat(p).then((s) => s.mtimeMs).catch(() => 0);

module.exports = { statKey, ABSENT, mtimeOf };
