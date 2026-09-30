// SPDX-License-Identifier: Apache-2.0
// lib/git-manifest.js — the LOCAL day-0 record of which commits a session
// made, and the day-7 / day-30 survey that turns it into shippable numbers.
//
// Why a manifest: Claude Code deletes transcripts after `cleanupPeriodDays`
// (30 by default), and after a squash merge the session's own SHAs are no
// longer on the default branch. So at session end we write down, per
// commit, its SHA, the task that made it, its patch-ids and a hash of every
// added line. That file lives in <tokenomicaDir>/git/<session>.json, is NEVER
// uploaded, and is deleted after the day-30 survey.
//
// It also keeps a copy of the record that shipped at day 0 (already scrubbed:
// enums and numbers only), so the survey can re-POST without the transcript.
// Per commit it keeps a hash of the subject, never the subject itself, and
// no per-commit author (the session's author is recorded once). The file is
// private to the user (0600, directory 0700).
//
// v2 (2026-09-29): `touched` paths per commit, `subject_hash`, `git_dir`.
// A v1 file is discarded on load, like any foreign-version manifest.
const fs = require('fs');
const path = require('path');
const G = require('./git-outcome');
const { segmentTasks, taskAt } = require('./task-path');
const { validateRecord } = require('./record');

const MANIFEST_VERSION = 2;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const manifestDir = (tokenomicaDir) => path.join(tokenomicaDir, 'git');
const manifestFile = (tokenomicaDir, id) => path.join(manifestDir(tokenomicaDir), `${id}.json`);

function saveManifest(tokenomicaDir, m) {
  if (!ID_RE.test(String(m && m.id || ''))) return false;
  try {
    const dir = manifestDir(tokenomicaDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    const file = manifestFile(tokenomicaDir, m.id), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// A corrupt or foreign-version manifest is removed, so the session falls back
// to its transcript instead of failing every run.
function loadManifest(tokenomicaDir, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const file = manifestFile(tokenomicaDir, id);
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code !== 'ENOENT') { try { fs.unlinkSync(file); } catch {} }
    return null;
  }
  if (!m || m.v !== MANIFEST_VERSION || m.id !== id || !Array.isArray(m.commits)) { try { fs.unlinkSync(file); } catch {} return null; }
  return m;
}

function removeManifest(tokenomicaDir, id) {
  if (!ID_RE.test(String(id || ''))) return;
  try { fs.unlinkSync(manifestFile(tokenomicaDir, id)); } catch {}
}

// [{ id, endedAt }] for every manifest on disk (for the survey's work list).
function listManifests(tokenomicaDir) {
  let names = [];
  try { names = fs.readdirSync(manifestDir(tokenomicaDir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const m = loadManifest(tokenomicaDir, n.slice(0, -5));
    if (m) out.push({ id: m.id, endedAt: m.ended_at });
  }
  return out;
}

// Manifests whose session ended more than maxAgeDays ago are past the last
// checkpoint; delete them so the directory cannot grow without bound.
function pruneManifests(tokenomicaDir, { now = Date.now(), maxAgeDays = 120 } = {}) {
  let removed = 0;
  for (const m of listManifests(tokenomicaDir)) {
    const end = Date.parse(m.endedAt);
    if (!Number.isFinite(end) || now - end > maxAgeDays * G.DAY_MS) { removeManifest(tokenomicaDir, m.id); removed++; }
  }
  return removed;
}

// Commits made by the session's subagents live in their own transcripts:
// <dir of transcript>/<session id>/subagents/*.jsonl.
function subagentCommitEvents(transcriptPath) {
  if (!transcriptPath) return [];
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.includes('"gitOperation"')) continue;
      try {
        const o = JSON.parse(line);
        const c = o.toolUseResult && o.toolUseResult.gitOperation && o.toolUseResult.gitOperation.commit;
        if (c && typeof c.sha === 'string') out.push({ sha: c.sha, at: o.timestamp || null });
      } catch {}
    }
  }
  return out;
}

// Day 0. Returns the manifest (written to disk) or null when the session made
// no commits we can find in its repo. An existing manifest keeps its
// snapshot unless the session has since made commits it doesn't know.
// An `amended` commit event replaces the commit it amended: when it follows
// another event of the same task, the earlier SHA is dropped (only the
// latest of an amend chain is the session's commit).
function dropAmended(events, tasks, promptTimes) {
  const out = [];
  for (const e of events) {
    if (e.kind === 'amended' && out.length) {
      const t = taskAt(tasks, promptTimes, Date.parse(e.at));
      const prev = out[out.length - 1];
      if (prev && taskAt(tasks, promptTimes, Date.parse(prev.at)) === t) out.pop();
    }
    out.push(e);
  }
  return out;
}

function ensureManifest({ tokenomicaDir, transcript, session, record, exec = G.defaultExec, now = Date.now() }) {
  if (!session || !session.cwd || !ID_RE.test(String(session.claudeSessionId || ''))) return null;
  const id = session.claudeSessionId;
  const tasks = segmentTasks(session);
  const raw = [...(session.commitEvents || []), ...subagentCommitEvents(transcript)].filter(e => e && /^[0-9a-f]{7,40}$/.test(e.sha));
  const events = dropAmended(raw, tasks, session.promptTimes);
  const existing = loadManifest(tokenomicaDir, id);
  // A resumed session can add commits; only then is the snapshot redone.
  const known = existing ? existing.commits.map(c => c.sha) : [];
  if (existing && events.every(e => known.some(k => k.startsWith(e.sha) || e.sha.startsWith(k)))) {
    if (record) { existing.record = record; existing.ended_at = session.endedAt || existing.ended_at; saveManifest(tokenomicaDir, existing); }
    return existing;
  }
  const top = G.repoTop(exec, session.cwd);
  if (!top) return null;
  const authorEmail = (exec(top, ['config', 'user.email']) || '').trim();
  // Commits from the person's own terminal are only looked for when Claude
  // recorded none: people run several sessions in one repo at once, and a
  // time window alone would hand one session's commits to another.
  const edited = (session.toolCalls || []).filter(t => EDIT_TOOLS.has(t.name) && t.filePath).map(t => t.filePath);
  const terminal = events.length ? [] : G.terminalCommits(exec, top, { startedAt: session.startedAt, endedAt: session.endedAt, authorEmail, editedFiles: edited });
  const shas = [...events.map(e => e.sha), ...terminal.map(c => c.sha)];
  if (!shas.length) return null;
  const snap = G.snapshotCommits(exec, top, shas);
  if (!snap.commits.length) return null;
  const fromTranscript = (sha) => events.find(e => sha.startsWith(e.sha) || e.sha.startsWith(sha));
  const commits = snap.commits.map(c => {
    const e = fromTranscript(c.sha);
    const at = e && Number.isFinite(Date.parse(e.at)) ? Date.parse(e.at) : c.at;
    return { ...c, source: e ? 'transcript' : 'terminal', task: taskAt(tasks, session.promptTimes, at) };
  });
  const m = {
    v: MANIFEST_VERSION, id, transcript: transcript || null, top, git_dir: G.gitCommonDir(exec, top), author_email: authorEmail,
    started_at: session.startedAt, ended_at: session.endedAt,
    created_at: existing ? existing.created_at : new Date(now).toISOString(),
    commits, series_patch_id: snap.series_patch_id, truncated: !!snap.truncated, record: record || null,
  };
  return saveManifest(tokenomicaDir, m) ? m : null;
}

const EMPTY_MEASURE = () => ({ lines: 0, survived: 0, changed_self: 0, changed_other: 0,
  replaced_by: Object.fromEntries(G.REPLACED.map(k => [k, 0])), first_fix_at: null, files_skipped: 0, lines_unmapped: 0, perCommit: {} });

function mergeMeasure(a, b) {
  for (const k of ['lines', 'survived', 'changed_self', 'changed_other', 'files_skipped', 'lines_unmapped']) a[k] += b[k];
  for (const k of G.REPLACED) a.replaced_by[k] += b.replaced_by[k];
  if (b.first_fix_at != null && (a.first_fix_at == null || b.first_fix_at < a.first_fix_at)) a.first_fix_at = b.first_fix_at;
  Object.assign(a.perCommit, b.perCommit);
  return a;
}

// Where to run git for a manifest: its working tree when it still exists,
// else its shared git dir (a removed worktree's commits live on there). Every
// command the survey runs works on a bare git dir. Null when neither is
// there.
function repoFor(m, exec) {
  if (G.repoTop(exec, m.top)) return m.top;
  if (m.git_dir) { const bare = { gitDir: m.git_dir }; if (exec(bare, ['rev-parse', '--git-dir']) != null) return bare; }
  return null;
}

// The survey itself. Throws when the repo is gone (the caller retries later
// rather than ledgering a session it could not look at).
function measureManifest(m, { exec = G.defaultExec, now = Date.now(), checkpoint }) {
  const repo = repoFor(m, exec);
  if (!repo) throw new Error('repo unavailable');
  const bases = G.resolveBases(exec, repo);
  const since = Date.parse(m.started_at);
  const endedMs = Date.parse(m.ended_at);
  const cands = G.candidatesByRef(exec, repo, m, bases, since);
  const landed = bases.length
    ? G.findLanded(exec, repo, m, bases, since, cands)
    : m.commits.map(c => ({ ...c, landed: null, via: 'none', ref: null }));
  // Every SHA that is the session's own work (made, or landed as): a line
  // one of these replaced was revised inside the session.
  const sessionShas = [...new Set(landed.flatMap(c => [c.sha, c.landed]).filter(Boolean))];
  const meas = EMPTY_MEASURE();
  for (const ref of new Set(landed.filter(c => c.ref).map(c => c.ref))) {
    mergeMeasure(meas, G.measure(exec, repo, landed.filter(c => c.ref === ref), { authorEmail: m.author_email, tipRef: ref, sessionShas, endedMs }));
  }
  const reverted = new Set(landed.filter(c => c.landed && G.revertedOn(exec, repo, c.ref, c, cands.get(c.ref))).map(c => c.sha));
  const byTask = new Map();
  for (const c of landed) {
    const t = byTask.get(c.task) || { index: c.task, commits: 0, commits_landed: 0, commits_reverted: 0, lines: 0, survived: 0, fixed: 0 };
    t.commits++;
    if (c.landed) t.commits_landed++;
    if (reverted.has(c.sha)) t.commits_reverted++;
    const p = meas.perCommit[c.sha];
    if (p) { t.lines += p.lines; t.survived += p.survived; t.fixed += p.fixed; }
    byTask.set(c.task, t);
  }
  return {
    v: 1, checkpoint, age_days: Math.max(0, Math.floor((now - endedMs) / G.DAY_MS)),
    base: bases.length ? bases[0].kind : 'none', fetched_after_session: G.fetchedAfter(exec, repo, endedMs),
    commits: landed.length, commits_from_transcript: landed.filter(c => c.source === 'transcript').length,
    commits_landed: landed.filter(c => c.landed).length, commits_reverted: reverted.size,
    landed_via: Object.fromEntries(G.LANDED_VIA.map(k => [k, landed.filter(c => c.via === k).length])),
    lines: meas.lines, survived: meas.survived, changed_self: meas.changed_self, changed_other: meas.changed_other,
    replaced_by: meas.replaced_by,
    first_fix_days: meas.first_fix_at == null ? null : Math.max(0, Math.round((meas.first_fix_at - endedMs) / G.DAY_MS)),
    files_skipped: meas.files_skipped, lines_unmapped: meas.lines_unmapped, truncated: !!m.truncated,
    tasks: [...byTask.values()].sort((a, b) => a.index - b.index),
  };
}

// The legacy survival fields, derived from the new measurement (spec D12).
function toRecordFields(o, now = Date.now()) {
  const judged = o.survived + o.changed_other;
  return {
    git_analyzed: true, git_analyzed_at: new Date(now).toISOString(),
    survival_rate: judged ? Math.round((o.survived / judged) * 1000) / 1000 : null,
    lines_surviving: o.survived, lines_superseded: o.changed_self, reverts: o.commits_reverted,
    git_outcome: o,
  };
}

// One survey step for the resurvey loop. build(file) -> { record, session }
// is only used when there is no manifest yet and the transcript still exists.
// Returns { record, done } or null (nothing to survey: no commits found).
async function surveyItem({ tokenomicaDir, id, file, checkpoint, build, exec = G.defaultExec, now = Date.now() }) {
  let m = loadManifest(tokenomicaDir, id);
  if ((!m || !m.record) && file && build) {
    const b = await build(file);
    if (b && b.session) m = ensureManifest({ tokenomicaDir, transcript: file, session: b.session, record: b.record, exec, now });
  }
  if (!m || !m.record) return null;
  const outcome = measureManifest(m, { exec, now, checkpoint });
  const record = validateRecord({ ...(m.record || {}), ...toRecordFields(outcome, now) });
  if (!record) return null;
  return { record, done: () => { if (checkpoint === 'd30') removeManifest(tokenomicaDir, id); } };
}

// { taskIndex: [sha, ...] } from a manifest: what the dashboard shows as "the
// commits this task made" when an org shares git refs.
function taskCommitsOf(m) {
  const out = {};
  for (const c of (m && m.commits) || []) {
    if (!Number.isInteger(c.task) || typeof c.sha !== 'string') continue;
    (out[c.task] = out[c.task] || []).push(c.sha);
  }
  return out;
}

module.exports = {
  taskCommitsOf,
  ensureManifest, loadManifest, saveManifest, removeManifest, listManifests, pruneManifests, subagentCommitEvents,
  measureManifest, toRecordFields, surveyItem, manifestDir, MANIFEST_VERSION,
};
