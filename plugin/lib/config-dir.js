// SPDX-License-Identifier: Apache-2.0
// lib/config-dir.js — where Tokenomica keeps its per-machine state, and the
// ~/.claudium fallback that keeps pre-rename installs whole.
//
// The product was renamed Claudium -> Tokenomica. The config dir is not a
// cache: it holds state that CANNOT be regenerated without consequences.
// Chief among them is `salt` (lib/anonymize.js) — the per-machine HMAC key
// behind every project_label pseudonym. A fresh salt rehashes every project
// name, so an upgraded install would silently stop matching its own history
// in the usage_record table. budgets.json, baselines.json, coach-log.jsonl
// and rec-lifecycle.json are likewise cumulative, not derivable.
//
// So resolution ADOPTS a legacy dir in place rather than migrating it:
// nothing is copied, moved, or rewritten behind the user's back, and a
// half-finished migration can't strand the salt between two directories.
// Moving to the new name is a deliberate, separate act —
// `node scripts/migrate-config-dir.js`.
//
// Precedence:
//   1. TOKENOMICA_DIR   — explicit always wins
//   2. CLAUDIUM_DIR     — explicit, pre-rename spelling
//   3. ~/.tokenomica    — if it already exists
//   4. ~/.claudium      — if it already exists (pre-rename install, adopted in place)
//   5. ~/.tokenomica    — fresh install: the new name
//
// Dependency-free (Node builtins only) so it can be vendored into the plugin
// alongside anonymize.js / coach-ledger.js / classify-headless.js, which all
// resolve the dir through it. See scripts/build-plugin.js's PLUGIN_LIB_FILES.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NAME = '.tokenomica';
const LEGACY_DIR_NAME = '.claudium';

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// configDir(env, home) -> absolute path to the config dir. Never creates it —
// callers that write already mkdir -p their own target (loadSalt, the budgets
// writer, the coach ledger), and a resolver with a filesystem side effect
// would make merely READING config enough to litter a fresh machine.
function configDir(env, home) {
  const e = env || process.env;
  const explicit = e.TOKENOMICA_DIR || e.CLAUDIUM_DIR;
  if (explicit) return explicit;

  const h = home || os.homedir();
  const next = path.join(h, DIR_NAME);
  if (dirExists(next)) return next;

  const legacy = path.join(h, LEGACY_DIR_NAME);
  if (dirExists(legacy)) return legacy;

  return next;
}

// pickEnv(env, suffix) -> env.TOKENOMICA_<suffix>, else env.CLAUDIUM_<suffix>.
//
// The pre-rename spelling stays honored so a hub deployed with CLAUDIUM_TIER,
// or a plugin installed before the rename, keeps behaving exactly as it did.
// Presence is tested with typeof === 'string', not truthiness: '' is a REAL
// value at several of these call sites (an empty TOKENOMICA_TIER is an
// explicitly-provided invalid tier, which sharing-tiers.js fails CLOSED to
// 'off'), and must not silently fall through to the legacy var.
function pickEnv(env, suffix) {
  const e = env || {};
  const next = e['TOKENOMICA_' + suffix];
  if (typeof next === 'string') return next;
  return e['CLAUDIUM_' + suffix];
}

module.exports = { configDir, pickEnv, DIR_NAME, LEGACY_DIR_NAME };
