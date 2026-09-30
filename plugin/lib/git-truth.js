// SPDX-License-Identifier: Apache-2.0
// lib/git-truth.js — post-session ground truth from the repo itself, for the
// callers that only have a time window (scripts/usage-report.js,
// scripts/usage-tui.js, lib/usage-pipeline.js's gitTruth option, the
// plugin's buildFor).
//
// SENDER-SIDE ONLY: runs `git` inside the session's cwd and reduces
// everything to NUMBERS. It runs on lib/git-outcome.js, which fixes what the
// old version got wrong (docs/ai-team-success-and-git-attribution-research.md
// §2.1):
//   - only the person's own commits count (author = `git config user.email`),
//     selected by AUTHOR date, so a teammate's commit or a rebase can't move
//     work into or out of the window;
//   - "superseded" means the session's OWN lines later changed by the same
//     author — not every later line of theirs in the file;
//   - lines are followed from the commit they landed in (ancestor, rebase or
//     squash), so a squash merge no longer reads as "no commits".
// The per-session manifest (lib/git-manifest.js) is what the plugin and the
// sender survey with; this is the window-only fallback on the same engine.
const G = require('./git-outcome');

function nowIso() { return new Date().toISOString(); }

// analyzeGitTruth({ cwd, startedAt, endedAt, authorEmail, exec }) -> numbers only.
// Returns { analyzed:false } when there's no repo / no window / git fails.
function analyzeGitTruth({ cwd, startedAt, endedAt, authorEmail, exec = G.defaultExec } = {}) {
  const none = { analyzed: false, commitsInWindow: 0, linesAdded: 0, linesSurviving: 0,
    linesSuperseded: 0, survivalRate: null, reverts: 0, filesSkipped: 0, analyzedAt: null };
  if (!cwd || !startedAt || !endedAt) return none;
  const t0 = Date.parse(startedAt), t1 = Date.parse(endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return none;
  const top = G.repoTop(exec, cwd);
  if (!top) return none;
  const email = authorEmail || (exec(top, ['config', 'user.email']) || '').trim();
  const empty = { ...none, analyzed: true, analyzedAt: nowIso() };
  if (!email) return none;  // unknown author ≠ measured-and-empty; record stays pending
  const log = exec(top, ['log', '--all', '--no-merges', '-F', `--author=${email}`, `--since=${new Date(t0 - G.DAY_MS).toISOString()}`, '-n', '500', '--format=%H%x09%at']);
  if (log == null) return none;
  const shas = log.split('\n').map(l => l.split('\t'))
    .filter(([, at]) => at && Number(at) * 1000 >= t0 && Number(at) * 1000 <= t1 + G.SLACK_MS).map(([sha]) => sha);
  if (!shas.length) return empty;
  const snap = G.snapshotCommits(exec, top, shas);
  if (!snap.commits.length) return empty;
  let bases = G.resolveBases(exec, top);
  if (!bases.length) bases = [{ ref: 'HEAD', kind: 'local' }];
  const landed = G.findLanded(exec, top, snap, bases, t0);
  const sessionShas = [...new Set(landed.flatMap(c => [c.sha, c.landed]).filter(Boolean))];
  const m = G.measure(exec, top, landed.filter(c => c.ref === bases[0].ref || !c.ref), { authorEmail: email, tipRef: bases[0].ref, sessionShas, endedMs: t1 });
  const reverts = landed.filter(c => c.landed && G.revertedOn(exec, top, c.ref, c)).length;
  const linesAdded = snap.commits.reduce((a, c) => a + Object.values(c.files).reduce((x, h) => x + h.length, 0), 0);
  const judged = m.survived + m.changed_other;
  return {
    analyzed: true,
    commitsInWindow: snap.commits.length,
    linesAdded,
    linesSurviving: m.survived,
    linesSuperseded: m.changed_self,
    survivalRate: judged ? Math.round((m.survived / judged) * 1000) / 1000 : null,
    reverts,
    filesSkipped: m.files_skipped,
    analyzedAt: nowIso(),
  };
}

module.exports = { analyzeGitTruth };
