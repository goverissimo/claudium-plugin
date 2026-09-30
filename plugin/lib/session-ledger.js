// SPDX-License-Identifier: Apache-2.0
// lib/session-ledger.js — the reconciliation half of "every session is
// tracked".
//
// lib/outbox.js guarantees that a record we MANAGED TO BUILD is eventually
// delivered. It cannot help with the other, quieter hole: sessions for which
// the SessionEnd hook never ran at all, so nothing was ever built. That
// happens more often than it sounds —
//   - the machine slept/lost power/was force-quit mid-session;
//   - Claude Code was killed (kill -9, a crashed terminal, a closed lid);
//   - the CLI updated itself and the old process tree went away;
//   - the plugin was installed or reconnected between sessions;
//   - the hook fired but the detached finisher was killed before it wrote.
// In every one of those cases the transcript is sitting on disk, complete and
// perfectly readable, and the dashboard simply never hears about it.
//
// So each run also RECONCILES: enumerate the transcripts that exist locally,
// subtract the ones this machine has already handed to the outbox, and queue
// the difference. That closes the loop — a session is captured if its
// transcript exists, regardless of whether any hook survived to notice.
//
// THE ONE THING THIS MUST NOT BECOME is a backdoor history import. The
// product promise is that existing history NEVER uploads on its own; only
// /tokenomica:backfill imports it. So the sweep is bounded BELOW by a
// `sweep-since` watermark stamped the first time this machine runs — sessions
// that predate the connection are invisible to it, forever, no matter how far
// back the window reaches.
//
// Pure except for fs. Node builtins only — vendors into the plugin as-is.

const fs = require('fs');
const path = require('path');

const LEDGER_FILE = 'queued-sessions.json';
const SINCE_FILE = 'sweep-since';

// How far back a sweep looks. Long enough to cover a two-week holiday plus a
// slow reconnect; short enough that the ledger stays small and a sweep is a
// directory stat walk rather than a project.
const DEFAULT_WINDOW_DAYS = 30;
// Ledger entries are pruned past this. Strictly wider than the window so an
// entry can never age out while its session is still sweepable — which would
// re-queue an already-delivered session on every run.
const LEDGER_RETAIN_DAYS = 60;
// Bound the work one run does; a large backlog drains over several sessions
// rather than stalling one.
const DEFAULT_MAX_PER_RUN = 15;

const DAY_MS = 86400000;

// ---- the "already queued" ledger -------------------------------------------
// Shape: { "<session id>": <endedAt ms> }. Values are timestamps purely so
// old entries can be pruned; nothing reads them as truth about the session.

function ledgerPathFor(dir) { return path.join(dir, LEDGER_FILE); }

function loadLedger(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPathFor(dir), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* missing or corrupt — an empty ledger is safe, just re-queues */ }
  return {};
}

function saveLedger(dir, ledger, { now = Date.now() } = {}) {
  const cutoff = now - LEDGER_RETAIN_DAYS * DAY_MS;
  const pruned = {};
  for (const [id, ts] of Object.entries(ledger)) {
    if (typeof ts === 'number' && ts >= cutoff) pruned[id] = ts;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${ledgerPathFor(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pruned), { mode: 0o600 });
    fs.renameSync(tmp, ledgerPathFor(dir));
  } catch { /* best-effort: a lost ledger costs a duplicate upsert, not data */ }
  return pruned;
}

// markQueued(dir, id, endedAtMs) — call this the moment a session is handed to
// the outbox, NOT when it is delivered. The outbox already owns delivery; this
// ledger only answers "have I ever built this one?", and conflating the two
// would make a delivery backlog look like a capture gap and re-queue it.
function markQueued(dir, id, endedAtMs, { now = Date.now() } = {}) {
  if (!id) return;
  const ledger = loadLedger(dir);
  ledger[id] = Number.isFinite(endedAtMs) ? endedAtMs : now;
  saveLedger(dir, ledger, { now });
}

// ---- the connection watermark ----------------------------------------------

// GRACE: the watermark is stamped when the first finisher RUNS, which is a
// moment AFTER the session that triggered it finished writing. Stamping at
// exactly `now` would therefore exclude that very session — and every session
// that ended in the same breath — from ever being reconciled. One hour back is
// enough to cover the triggering session comfortably while staying far away
// from anything a person would call "history": it can only ever admit sessions
// from the same hour in which this machine first connected.
const SWEEP_GRACE_MS = 60 * 60 * 1000;

// sweepSince(dir, { now }) -> ms epoch before which sessions are off-limits.
// Stamped once, on first call, and never moved again. Stamping it at FIRST RUN
// (rather than at install) is what keeps the promise precise: everything from
// the moment this machine started talking to a dashboard is swept; everything
// before it is history, and history only moves on an explicit
// /tokenomica:backfill.
function sweepSince(dir, { now = Date.now() } = {}) {
  const stamp = now - SWEEP_GRACE_MS;
  const file = path.join(dir, SINCE_FILE);
  try {
    const v = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* not stamped yet */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(stamp), { flag: 'wx', mode: 0o600 });
    return stamp;
  } catch {
    // Lost the create race with a concurrent finisher — adopt whatever it
    // wrote rather than inventing a second, later watermark.
    try {
      const v = Number(String(fs.readFileSync(file, 'utf8')).trim());
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* fall through */ }
    return stamp;
  }
}

// ---- the resurvey consent floor --------------------------------------------

// resurveyFloor(dir) -> ms epoch before which a session may not be
// re-surveyed. Shared by the plugin's SessionEnd route and the sender's
// runResurveyOnce, so both enforce the SAME rule.
//
// BUG THIS FIXES: lib/resurvey.js's resurveyAged will re-POST a FULL record
// for any local transcript in its [7,120)-day checkpoint window. For a
// session that was never uploaded in the first place — history from before
// this machine ever connected — that re-POST is a FIRST upload, of exactly
// the history the product promises never moves without an explicit
// /tokenomica:backfill.
//
// So: re-survey only what this machine has actually shipped.
//   - History WAS imported (a real /tokenomica:backfill marker) -> everything
//     local is fair game; the user already consented to all of it.
//   - Otherwise -> nothing older than the connection watermark (sweepSince),
//     the same floor the reconciliation sweep uses. One floor, one promise.
function resurveyFloor(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'backfilled'), 'utf8'));
    // `skipped: true` is a DECLINE, not an import — it must not unlock history.
    if (marker && marker.at && !marker.skipped && Number(marker.imported) > 0) return 0;
  } catch { /* no marker: fall through to the watermark */ }
  return sweepSince(dir);
}

// ---- the sweep --------------------------------------------------------------

// listLocalSessions(claudeDir, { skip }) -> [{ id, file, endedAtMs }]
// A stat walk over the transcript tree. `skip(filepath)` lets the caller
// exclude the paths that must never be ingested (subagent sidecars, the
// classifier's own cwd) using the SAME predicates the upload path uses, so the
// two can never disagree about what counts as a session.
function listLocalSessions(claudeDir, { skip = () => false } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      if (skip(fp)) continue;
      try {
        const st = fs.statSync(fp);
        out.push({ id: path.basename(e.name, '.jsonl'), file: fp, endedAtMs: st.mtimeMs });
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(claudeDir, 0);
  return out;
}

// findMissed({ dir, claudeDir, skip, isPending, now, windowDays, max })
//   -> [{ id, file, endedAtMs }]
//
// The sessions that exist on disk, are inside the window, are newer than the
// connection watermark, are not already in the ledger, and are not already
// sitting in the outbox. Newest first: if the backlog is bigger than `max`,
// the most recent (most interesting, most likely to be asked about) go first.
function findMissed({ dir, claudeDir, skip, isPending = () => false,
  now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, max = DEFAULT_MAX_PER_RUN } = {}) {
  const since = Math.max(sweepSince(dir, { now }), now - windowDays * DAY_MS);
  const ledger = loadLedger(dir);
  return listLocalSessions(claudeDir, { skip })
    .filter(s => s.endedAtMs >= since)
    .filter(s => !(s.id in ledger))
    .filter(s => !isPending(s.id))
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .slice(0, max);
}

module.exports = {
  findMissed, listLocalSessions, markQueued, loadLedger, saveLedger, sweepSince, resurveyFloor,
  LEDGER_FILE, SINCE_FILE, DEFAULT_WINDOW_DAYS, LEDGER_RETAIN_DAYS, DEFAULT_MAX_PER_RUN,
  SWEEP_GRACE_MS,
};
