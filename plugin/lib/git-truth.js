// SPDX-License-Identifier: Apache-2.0
// lib/git-truth.js — post-session ground truth from the repo itself.
//
// SENDER-SIDE ONLY: runs `git` inside the session's cwd (which exists only on
// the contributor's machine) and reduces everything to NUMBERS — how many of
// the lines committed during the session still exist in HEAD, and whether any
// session commit was later reverted. No code, paths, or messages leave.
//
// This is the strongest outcome signal there is: "did the work survive?"
// beats any in-session heuristic. Run it on sessions that are at least a few
// days old so the verdict is about survival, not recency.

const { execFileSync } = require('child_process');

const MAX_COMMITS = 10;       // cap work per session
const MAX_FILES = 25;         // cap blamed files per session
const SLACK_MS = 60 * 60 * 1000;  // commits up to 1h after session end count

function nowIso() { return new Date().toISOString(); }

function defaultExec(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// analyzeGitTruth({ cwd, startedAt, endedAt, exec }) -> numbers only.
// Returns { analyzed:false } when there's no repo / no window / git fails.
function analyzeGitTruth({ cwd, startedAt, endedAt, exec = defaultExec } = {}) {
  const none = { analyzed: false, commitsInWindow: 0, linesAdded: 0, linesSurviving: 0,
    linesSuperseded: 0, survivalRate: null, reverts: 0, analyzedAt: null };
  if (!cwd || !startedAt || !endedAt) return none;
  const t0 = Date.parse(startedAt), t1 = Date.parse(endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return none;

  const run = (args) => { try { return exec(cwd, args); } catch { return null; } };

  if (run(['rev-parse', '--is-inside-work-tree']) === null) return none;

  const since = new Date(t0).toISOString();
  const until = new Date(t1 + SLACK_MS).toISOString();
  const log = run(['log', `--since=${since}`, `--until=${until}`, '--no-merges', '--format=%H%x09%s']);
  if (log === null) return none;

  const commits = log.split('\n').filter(Boolean).slice(0, MAX_COMMITS).map(l => {
    const [sha, ...rest] = l.split('\t');
    return { sha, subject: rest.join('\t') };
  });
  if (!commits.length) return { ...none, analyzed: true, analyzedAt: nowIso() };

  // Lines added per commit + the touched files (for survival blame).
  let linesAdded = 0;
  const files = new Set();
  for (const c of commits) {
    const numstat = run(['show', '--numstat', '--format=', c.sha]);
    if (numstat === null) continue;
    for (const line of numstat.split('\n')) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (!m) continue;                  // binary files show '-' — skip
      linesAdded += Number(m[1]);
      if (files.size < MAX_FILES) files.add(m[3]);
    }
  }

  // Survival: blame each touched file in HEAD and count lines still owned by
  // a session commit. Deleted files simply contribute zero.
  const shaSet = new Set(commits.map(c => c.sha));

  // Author of the session's own commits (they share one) — used to tell
  // "the same person kept iterating" (superseded) from "someone/something
  // else overwrote it" (lost). Cached per SHA.
  const metaCache = new Map();
  const shaMeta = (sha) => {
    if (metaCache.has(sha)) return metaCache.get(sha);
    const out = run(['show', '-s', '--format=%ae%x09%ct', sha]);
    const m = out && /^(.*)\t(\d+)/.exec(out.trim());
    const meta = m ? { email: m[1], time: Number(m[2]) * 1000 } : null;
    metaCache.set(sha, meta);
    return meta;
  };
  const sessionAuthor = commits.length ? (shaMeta(commits[0].sha) || {}).email : null;
  const endMs = t1;

  let surviving = 0, superseded = 0;
  for (const f of files) {
    const blame = run(['blame', '-w', '-M', '-C', '-l', '-s', 'HEAD', '--', f]);
    if (blame === null) continue;
    for (const line of blame.split('\n')) {
      const sha = line.slice(0, 40);
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;   // boundary/uncommitted markers
      if (shaSet.has(sha)) { surviving++; continue; }
      const meta = shaMeta(sha);
      if (meta && sessionAuthor && meta.email === sessionAuthor && meta.time > endMs) superseded++;
      // else: owned by another author, or an earlier commit — counts as lost (implicit)
    }
  }

  // Reverts: a later commit whose subject is `Revert "<session subject>"`,
  // or whose message mentions a session sha (git's default revert format).
  let reverts = 0;
  const after = run(['log', `--since=${until}`, '--format=%s%x09%b']);
  if (after) {
    const text = after.toLowerCase();
    for (const c of commits) {
      const bySubject = c.subject && text.includes(`revert "${c.subject.toLowerCase()}"`);
      const bySha = text.includes(c.sha.slice(0, 7).toLowerCase());
      if (bySubject || bySha) reverts++;
    }
  }

  const lost = Math.max(0, linesAdded - surviving - superseded);
  const denom = surviving + lost;
  const survivalRate = denom > 0 ? Math.round((surviving / denom) * 1000) / 1000 : null;
  return {
    analyzed: true,
    commitsInWindow: commits.length,
    linesAdded,
    linesSurviving: surviving,
    linesSuperseded: superseded,
    survivalRate,
    reverts,
    analyzedAt: nowIso(),
  };
}

module.exports = { analyzeGitTruth };
