'use strict';
// Cluster mode — optional horizontal scale-out over a SHARED data directory.
//
// Off by default (a normal single node). When enabled, several Lokyni instances run against one shared data
// dir (a mounted volume): exactly one PRIMARY owns all indexing and writes, and any number of read REPLICAS
// serve search/chat/read from the shared index and refuse writes. Roles are STATIC — set per instance via
// config or a CLI flag — so there is no leader election and no split-brain: at most one writer by design.
//
// This is the local-first way to scale: the user/session/membership/API-key stores are plain files that work
// across instances on the shared volume already, and the read path loads the index read-only (auto-refreshing
// when the primary updates it). No external database, vector service, cache, or message bus is introduced.
//
// Pure and dependency-free: it only reads config + argv and returns the role. The decision is factored into a
// testable pure function so the policy is verified without a live cluster.

// resolveMode({ enabled, role, argv }) → 'off' | 'primary' | 'replica'. CLI flags win over config so one
// process can be pointed at a role without editing the shared config.json.
const resolveMode = ({ enabled = false, role = 'primary', argv = [] } = {}) => {
  const has = (f) => Array.isArray(argv) && argv.includes(f);
  const on = enabled === true || has('--cluster') || has('--primary') || has('--replica');
  if (!on) return 'off';
  if (has('--replica')) return 'replica';
  if (has('--primary')) return 'primary';
  return role === 'replica' ? 'replica' : 'primary';
};

const mode = () => {
  let c = {};
  try { c = require('./config').cluster || {}; } catch { /* config not loaded yet — treat as off */ }
  return resolveMode({ enabled: c.enabled, role: c.role, argv: process.argv.slice(2) });
};

const enabled = () => mode() !== 'off';
const isReplica = () => mode() === 'replica';
// May this instance perform index writes? The primary and a plain single node may; a read replica may not.
const isPrimary = () => mode() !== 'replica';
const label = () => { const m = mode(); return m === 'off' ? 'single node' : (m === 'replica' ? 'read replica' : 'primary'); };

module.exports = { resolveMode, mode, enabled, isReplica, isPrimary, label };
