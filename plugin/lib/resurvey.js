// SPDX-License-Identifier: Apache-2.0
// lib/resurvey.js — deferred git-outcome survey orchestrator.
//
// Whether committed work landed and held only means something DAYS after a
// session. Each session is surveyed twice: at day 7 (checkpoint 'd7', for
// ages in [7, 30) days) and at day 30 ('d30', ages in [30, 120)). A session
// first seen after day 30 gets d30 only. Each survey re-POSTs the session's
// record with the git fields filled in; the hub upsert overwrites the
// earlier copy in place.
//
// Dependency-free (Node builtins only) so it vendors into the plugin; every
// side effect (listing, surveying, POST, ledger I/O) is injected so it runs
// identically under the sender and the plugin, and is unit-testable without
// a repo or network.
//
// A ledger of surveyed keys (host-supplied load/save) means each checkpoint
// runs once: the d7 key is the bare session id (the same key the old
// single-survey ledger used, so upgrading never re-surveys old sessions at
// d7), the d30 key is `<id>@d30`. A session is ledgered per checkpoint even
// when it had no commits, so each checkpoint runs exactly once. The ledger
// is written after EACH session, not once at the end of the batch: the
// plugin route runs in a process that can be killed at any moment (the CLI
// aborts session-end work on shutdown), and an end-of-batch write would
// lose every finished session.
//
// A survey that throws (repo moved or deleted, git error) is retried on
// later runs; after MAX_FAILURES consecutive throws the checkpoint is given
// up, so one dead repo can't block the queue. Consecutive failures are
// tracked in the SAME ledger set, as `<key>!f<n>` entries (n = 1..
// MAX_FAILURES) — on a throw we count the existing `<key>!f*` entries and
// ledger the next one; once that count reaches MAX_FAILURES we also ledger
// the checkpoint key itself, so it is skipped by the ordinary
// already-surveyed check from then on.
//
// survey(item, checkpoint) -> { record, done? } | null. `done` runs after the
// POST (the manifest store deletes its file after the d30 survey). The old
// buildOne(file) -> record | { record } contract is still accepted.

const DAY_MS = 86400000;
const MAX_FAILURES = 5;
const CHECKPOINTS = [
  { name: 'd7', minAgeDays: 7, maxAgeDays: 30, key: id => id },
  { name: 'd30', minAgeDays: 30, maxAgeDays: 120, key: id => `${id}@d30` },
];

async function resurveyAged({ listSessions, survey, buildOne, post, loadLedger, saveLedger,
  now, maxPerRun = 3 }) {
  const ledger = loadLedger() || new Set();
  const run = survey || (async (item) => {
    const built = await buildOne(item.file);
    return built && built.record ? { record: built.record } : built ? { record: built } : null;
  });
  const due = [];
  for (const s of listSessions() || []) {
    if (!s || !s.id) continue;
    const endMs = Date.parse(s.endedAt);
    if (!Number.isFinite(endMs)) continue;
    const age = (now - endMs) / DAY_MS;
    const cp = CHECKPOINTS.find(c => age >= c.minAgeDays && age < c.maxAgeDays);
    if (!cp || ledger.has(cp.key(s.id))) continue;
    due.push({ ...s, endMs, checkpoint: cp });
  }
  due.sort((a, b) => a.endMs - b.endMs);   // oldest first — drain the backlog

  let surveyed = 0, skipped = 0;
  for (const s of due.slice(0, maxPerRun)) {
    try {
      const out = await run(s, s.checkpoint.name);
      if (out && out.record) {
        await post(out.record);
        if (typeof out.done === 'function') { try { out.done(); } catch {} }
        surveyed++;
      } else { skipped++; }
      // Persist immediately — ledger even a null result so a commit-less
      // session isn't retried, and never defer to end-of-batch (see header).
      saveLedger(new Set([s.checkpoint.key(s.id)]));
    } catch {
      // Transient (repo moved, git error) — retry next run, UNLESS this is
      // the MAX_FAILURESth consecutive throw for this checkpoint, in which
      // case give up so a dead repo can't occupy every slot forever.
      skipped++;
      const key = s.checkpoint.key(s.id);
      const prefix = `${key}!f`;
      let failures = 0;
      for (const k of ledger) if (k.startsWith(prefix)) failures++;
      const next = failures + 1;
      const toLedger = new Set([`${prefix}${next}`]);
      if (next >= MAX_FAILURES) toLedger.add(key);   // give up
      saveLedger(toLedger);
    }
  }
  return { surveyed, skipped };
}

module.exports = { resurveyAged, CHECKPOINTS, MAX_FAILURES };
