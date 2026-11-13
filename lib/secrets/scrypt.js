'use strict';
// Shared scrypt cost-parameter helpers — ONE place for "is this a sane work factor" and "how much memory may
// scrypt be allowed to use". scrypt's working set is ~128 * N * r bytes; the safety rule, in both places that
// derive a key, is to size `maxmem` from a FIXED upper bound on the parameters rather than from whatever
// parameters a single (possibly untrusted or corrupt) input carries — so no input can inflate the allocation
// into an OOM/freeze. Used by the human-password hasher (lib/password.js) and the backup-archive KDF
// (lib/backup.js) so the two can never drift apart.

// scrypt requires N to be a power of two; this is both a validity check and the guard that keeps a crafted N
// (e.g. one off by a bit) from being accepted. Integer, ≥ 1.
const isPowerOfTwo = (n) => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;

// The scrypt working-set size in bytes for given parameters. The dominant, memory-hard term is 128 * N * r;
// the small parallelism factor p adds a negligible buffer and is deliberately left out so the ceiling matches
// the standard scrypt sizing (and the long-standing value the backup KDF already used).
const workingSetBytes = ({ N, r }) => 128 * N * r;

// A `maxmem` ceiling (bytes) sized from the MAXIMUM parameters a caller will ever accept — twice the working set
// (comfortable headroom over scrypt's own requirement) plus a fixed slack. Because it is derived from the fixed
// upper bound, it is independent of any individual parameter set, so a single large/corrupt N can never drive it
// up: parameters beyond the bound are rejected by the caller before scrypt ever runs.
const maxmemForBounds = (maxParams, slackBytes = 16 * 1024 * 1024) => workingSetBytes(maxParams) * 2 + slackBytes;

module.exports = { isPowerOfTwo, workingSetBytes, maxmemForBounds };
