#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// plugin/finish-session.js — Tokenomica plugin — detached SessionEnd finisher.
//
// Claude Code aborts SessionEnd hooks — and their whole process tree —
// roughly 1.5s after session end, regardless of hooks.json's own timeout
// (see GRACE WINDOW in plugin/upload-session.js). The hook (runHook) can
// therefore do no real work itself: it spawns THIS script fully detached
// (detached: true, stdio: 'ignore', unref()'d — spawnFinish) and exits
// immediately. Because the hook exits inside the grace window, it is never
// cancelled, no tree kill ever fires, and this process — reparented to init
// once the hook is gone — runs the whole session-end body (upload the
// deterministic record, spawn the enrichment child, surface the backfill
// notice, drain a little resurvey backlog) entirely on its own.
//
// By the time this runs, nothing is listening on its stdout/stderr and
// nothing is waiting on it — it must tolerate running entirely alone: every
// failure is swallowed and the process always exits 0, the same contract as
// plugin/enrich-session.js.
//
// Only filepath/claudeDir cross the process boundary (TOKENOMICA_FINISH_*
// env vars — stdio is 'ignore', so no pipe exists); config is loaded from
// ~/.tokenomica/plugin.json by runFinish itself, never from the environment.
//
// Self-contained: requires ONLY ./upload-session.js (which requires only
// ./lib, vendored by scripts/build-plugin.js, and Node built-ins) — same
// vendor-safe contract as every other file in plugin/.

const { runFinish } = require('./upload-session');

// The read side of spawnFinish's TOKENOMICA_FINISH_* env-var contract
// (plugin/upload-session.js is the write side). An absent/empty FILE means
// "no transcript this session end" — runFinish still owes the backfill
// notice and the resurvey pass; an absent CLAUDE_DIR falls back to
// runFinish's own default (the real ~/.claude/projects).
function optsFromEnv(env = process.env) {
  const opts = { filepath: env.TOKENOMICA_FINISH_FILE || '' };
  if (env.TOKENOMICA_FINISH_CLAUDE_DIR) opts.claudeDir = env.TOKENOMICA_FINISH_CLAUDE_DIR;
  return opts;
}

module.exports = { optsFromEnv };

if (require.main === module) {
  runFinish(optsFromEnv(process.env))
    .then(() => process.exit(0))
    .catch(e => { try { console.error(`tokenomica: finish failed: ${e.message}`); } catch {} process.exit(0); });
}
