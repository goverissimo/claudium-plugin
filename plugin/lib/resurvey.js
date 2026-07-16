// SPDX-License-Identifier: Apache-2.0
// lib/resurvey.js — deferred code-survival re-blame orchestrator.
//
// Survival (lib/git-truth.js) only means something DAYS after a session, once
// the code has had time to hold up or get rewritten. This picks aged local
// sessions, rebuilds them with git-truth enabled (via the host's injected
// buildOne), and re-POSTs — the hub upsert overwrites the day-0 record in
// place. Dependency-free (Node builtins only) so it vendors into the plugin;
// every side effect (session enumeration, record build, POST, ledger I/O) is
// injected so it runs identically under the sender and the plugin, and is
// unit-testable without a repo or network.
//
// A ledger of surveyed session ids (host-supplied load/save) means each aged
// session is re-blamed once, not on every trigger; a session is ledgered even
// when it had no commits, so it is never re-examined. The ledger is written
// after EACH session, not once at the end of the batch: the plugin route runs
// in a process that can be killed at any moment (the CLI aborts session-end
// work on shutdown), and an end-of-batch write would lose every finished
// session on such a kill — the backlog would never converge.

const DAY_MS = 86400000;

async function resurveyAged({ listSessions, buildOne, post, loadLedger, saveLedger,
  now, minAgeDays = 7, maxAgeDays = 30, maxPerRun = 3 }) {
  const ledger = loadLedger() || new Set();
  const lo = now - maxAgeDays * DAY_MS;   // older than this = too old
  const hi = now - minAgeDays * DAY_MS;   // newer than this = not yet mature
  const due = (listSessions() || [])
    .filter(s => s && s.id && !ledger.has(s.id))
    .map(s => ({ ...s, endMs: Date.parse(s.endedAt) }))
    .filter(s => Number.isFinite(s.endMs) && s.endMs >= lo && s.endMs <= hi)
    .sort((a, b) => a.endMs - b.endMs)   // oldest first — drain the backlog
    .slice(0, maxPerRun);

  let surveyed = 0, skipped = 0;
  for (const s of due) {
    try {
      const built = await buildOne(s.file);
      const record = built && built.record ? built.record : built;
      if (record) { await post(record); surveyed++; } else { skipped++; }
      // Persist immediately — ledger even a null build so a commit-less
      // session isn't retried, and never defer to end-of-batch (see header).
      saveLedger(new Set([s.id]));
    } catch { skipped++; /* transient (repo moved, git error) — retry next run, do not ledger */ }
  }
  return { surveyed, skipped };
}

module.exports = { resurveyAged };
