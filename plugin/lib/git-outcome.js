// SPDX-License-Identifier: Apache-2.0
// lib/git-outcome.js — did a session's committed work LAND on the default
// branch, and did it HOLD? Pure engine over an injected `exec(cwd, args,
// input) -> stdout | null` (a failed git call is null, never a throw), so it
// is testable with real scratch repos and vendors into the plugin (Node
// builtins only).
//
// Everything here runs on the developer's machine. The only thing that ever
// leaves it is the numbers lib/git-manifest.js derives from these results:
// counts, enums and booleans. File paths, SHAs, line hashes and commit
// subjects stay local (the manifest, and this process's memory).
//
//   snapshotCommits  day 0: per commit, its -U0 --stable patch-id, the
//                    inverse patch-id, and a hash of every added line
//   findLanded       ancestor -> same patch-id (rebase) -> series patch-id
//                    (squash) -> >= 80% of its added lines in one commit
//   measure          follows each session line from the commit it landed in
//                    to the branch tip with `git blame --reverse`, and
//                    classifies the commit that replaced it
//
// The manifest keeps a hash of each commit's subject, never the subject or
// its author (the author is the session's, recorded once per manifest).
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DAY_MS = 86400000;
const SLACK_MS = 60 * 60 * 1000;          // commits up to 1h after the session count
const MAX_COMMITS = 30;
const MAX_FILES = 200;
const MAX_LINES_PER_COMMIT = 5000;
const MAX_CANDIDATES = 400;
const LINES_MATCH = 0.8;                  // share of a commit's lines one base commit must hold
const REPLACED = ['fix', 'revert', 'neutral', 'rework'];
const LANDED_VIA = ['ancestor', 'patch_id', 'squash', 'lines', 'none'];

// Lockfiles, build output, vendored code, minified bundles, maps, snapshots:
// machine-written, so their "survival" says nothing about the work.
const SKIP_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|bun\.lockb?)$|(^|\/)(dist|build|out|\.next|coverage|vendor|node_modules)\/|\.(min\.js|min\.css|map|snap)$/;
const BOT = /\[bot\]|dependabot|renovate|github-actions|noreply@github\.com$/i;

// A person's git config must not change what the engine parses: prefixes,
// quoting, colour and regex flavour are pinned per call; external diff
// drivers and textconv are disabled at each diff/blame call site
// (--no-ext-diff --no-textconv), and blame ignores any configured
// blame.ignoreRevsFile (--no-ignore-revs-file: a missing list makes blame
// fail, and a present one would hide the very commits that replaced lines). No prompts, no lazy fetches from
// a partial clone's promisor, and a 20s ceiling per call.
const GIT_CONFIG = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'core.quotePath=false',
  '-c', 'grep.patternType=basic', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];
// GIT_LITERAL_PATHSPECS: session paths are paths, not globs (Next.js route
// dirs like app/[id]/ would otherwise also match app/i/).
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' };

// `cwd` is a working-tree path, or { gitDir } for a repository whose working
// tree is gone (a removed worktree: its commits live in the main repo's
// common dir, and every command the survey runs works bare).
function defaultExec(cwd, args, input) {
  const where = cwd && typeof cwd === 'object' && cwd.gitDir ? [`--git-dir=${cwd.gitDir}`] : ['-C', cwd];
  try {
    return execFileSync('git', [...GIT_CONFIG, ...where, ...args], {
      encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: 20000,
      env: { ...process.env, ...GIT_ENV },
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
  } catch { return null; }
}

// A line's identity ignores whitespace, so a reindent is not a change.
const squash = s => String(s).replace(/\s+/g, '');
// Brace-only and punctuation-only lines (`}`, `});`, `*/`) say nothing about
// the work and move around freely; they are not tracked.
function trivialLine(s) { const n = squash(s); return !n || /^[\W_]+$/.test(n); }
function lineHash(s) { return crypto.createHash('sha1').update(squash(s)).digest('hex').slice(0, 12); }
// A commit subject is kept only as this hash (for exact revert matching).
function subjectHash(s) { return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex').slice(0, 12); }

// Replacing-commit type from its subject (+ author for bots). First match wins.
function classifySubject(subject, authorEmail = '') {
  const s = String(subject || '').trim();
  if (/^revert\b/i.test(s)) return 'revert';
  if (/^(fix|hotfix)(\([^)]*\))?!?:/i.test(s) || /\b(fix|fixes|fixed|fixing|hotfix|bug|bugfix|broken|regression)\b/i.test(s)) return 'fix';
  if (BOT.test(authorEmail) || /^(refactor|style|chore|build|ci|docs|test|perf)(\([^)]*\))?!?:/i.test(s)) return 'neutral';
  return 'rework';
}

// `git log -p -U0` output -> [{ sha, at, author, subject, files, touched, truncated }]
// where files = { path: [lineHash, ...] } of ADDED, non-trivial lines and
// touched = every path the commit changed (added, modified, deleted, skipped
// or binary). A `+++ ` line is a file header only right after a `--- ` line,
// and both only in a file's header block (after `diff --git`, before its
// first `@@`); anywhere else they are a removed "-- ..." / added "++ ..."
// line of code.
function unquotePath(p) {
  const s = String(p || '').replace(/\t$/, '');
  if (!/^".*"$/.test(s)) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 })[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
function parseLog(text) {
  const out = [];
  let cur = null, file = null, prev = '', hdr = false;
  const touch = (p) => { if (p && p !== '/dev/null') cur.touched.add(p); };
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = /^commit ([0-9a-f]{40})$/.exec(line))) {
      cur = { sha: m[1], at: 0, author: '', subject: '', files: {}, touched: new Set(), lineCount: 0, capped: false };
      out.push(cur); file = null; hdr = false; prev = line; continue;
    }
    if (!cur) continue;
    if ((m = /^meta (\d+)\t([^\t]*)\t(.*)$/.exec(line))) { cur.at = Number(m[1]) * 1000; cur.author = m[2]; cur.subject = m[3]; prev = line; continue; }
    if (line.startsWith('diff --git ')) { file = null; hdr = true; prev = line; continue; }
    if (hdr && line.startsWith('@@')) hdr = false;
    if (hdr && line.startsWith('--- ') && !prev.startsWith('--- ')) {
      const a = unquotePath(line.slice(4));
      touch(a.startsWith('a/') ? a.slice(2) : a === '/dev/null' ? null : a);
      prev = line; continue;
    }
    if (hdr && line.startsWith('+++ ') && prev.startsWith('--- ')) {
      const b = unquotePath(line.slice(4));
      file = b.startsWith('b/') ? b.slice(2) : null;
      touch(file);
      prev = line; continue;
    }
    if (hdr && (m = /^Binary files (.+) and (.+) differ$/.exec(line))) {
      for (const x of [m[1], m[2]]) { const p = unquotePath(x); touch(/^[ab]\//.test(p) ? p.slice(2) : null); }
      prev = line; continue;
    }
    if (line.startsWith('+') && file && !SKIP_FILE.test(file) && !trivialLine(line.slice(1))) {
      if (cur.lineCount < MAX_LINES_PER_COMMIT) { (cur.files[file] ||= []).push(lineHash(line.slice(1))); cur.lineCount++; }
      else cur.capped = true;
    }
    prev = line;
  }
  return out.map(c => ({ sha: c.sha, at: c.at, author: c.author, subject: c.subject,
    files: c.files, touched: [...c.touched], truncated: c.capped }));
}

const LOG_FORMAT = '--format=commit %H%nmeta %at%x09%ae%x09%s';

// { sha: patchId } for every commit in one `git log -p` blob.
function patchIds(exec, top, logText) {
  const out = {};
  const r = exec(top, ['patch-id', '--stable'], logText);
  for (const line of String(r || '').split('\n')) { const [pid, sha] = line.trim().split(/\s+/); if (pid && sha) out[sha] = pid; }
  return out;
}

function repoTop(exec, cwd) { const t = exec(cwd, ['rev-parse', '--show-toplevel']); return t ? t.trim() : null; }

// The repository's shared git dir, absolute. A worktree's own .git is a file
// pointing into the main repo; its commits live in the common dir, which
// outlives the worktree.
function gitCommonDir(exec, top) {
  const gd = exec(top, ['rev-parse', '--git-common-dir']);
  return gd && gd.trim() ? require('path').resolve(top, gd.trim()) : null;
}

// Day 0. shas: commits believed to be the session's. Unknown SHAs (another
// repo, garbage-collected) are silently dropped and are not a truncation;
// hitting a cap (commit count, lines per commit) is. Returns commits
// oldest-first as { sha, at, subject_hash, patch_id, inverse_patch_id,
// files, touched } — no subject, no author.
function snapshotCommits(exec, top, shas) {
  const known = [...new Set(shas)].filter(s => /^[0-9a-f]{7,40}$/.test(s) && exec(top, ['cat-file', '-e', `${s}^{commit}`]) != null);
  const capped = known.length > MAX_COMMITS;
  const use = known.slice(0, MAX_COMMITS);
  if (!use.length) return { commits: [], series_patch_id: null, truncated: false };
  const logText = exec(top, ['log', '--no-walk=sorted', '--no-merges', '-p', '-U0', '--no-renames', '--no-color', ...NO_DRIVERS, LOG_FORMAT, ...use]) || '';
  const parsed = parseLog(logText);
  const pids = patchIds(exec, top, logText);
  const commits = parsed.reverse().map(c => {
    const inv = exec(top, ['diff', '-U0', '--no-renames', '--no-color', ...NO_DRIVERS, c.sha, `${c.sha}^`]);
    const invPid = inv ? (patchIds(exec, top, `commit ${c.sha}\n` + inv)[c.sha] || null) : null;
    return { sha: c.sha, at: c.at, subject_hash: subjectHash(c.subject), patch_id: pids[c.sha] || null, inverse_patch_id: invPid,
      files: c.files, touched: c.touched };
  });
  // Series patch-id: the combined diff from before the first commit to after
  // the last, which is what a squash merge of exactly this work produces.
  let series = null;
  if (commits.length > 1) {
    const first = commits[0].sha, last = commits[commits.length - 1].sha;
    const d = exec(top, ['diff', '-U0', '--no-renames', '--no-color', ...NO_DRIVERS, `${first}^`, last]);
    if (d) series = patchIds(exec, top, `commit ${last}\n` + d)[last] || null;
  }
  return { commits, series_patch_id: series, truncated: capped || parsed.some(c => c.truncated) };
}

// Commits the person made from their own terminal: same author email, author
// date in the session window, touching a file the session edited.
function terminalCommits(exec, top, { startedAt, endedAt, authorEmail, editedFiles }) {
  const t0 = Date.parse(startedAt), t1 = Date.parse(endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !authorEmail) return [];
  const out = exec(top, ['log', '--all', '--no-merges', '-F', `--author=${authorEmail}`, `--since=${new Date(t0 - DAY_MS).toISOString()}`,
    '--format=%H%x09%at%x09%ae', '--name-only', '-n', '200']);
  if (!out) return [];
  const edited = new Set((editedFiles || []).map(f => f.replace(/\\/g, '/')));
  const res = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40})\t(\d+)\t(.*)$/.exec(line);
    if (m) { cur = { sha: m[1], at: Number(m[2]) * 1000, email: m[3], hit: false }; if (cur.email.toLowerCase() === authorEmail.toLowerCase() && cur.at >= t0 && cur.at <= t1 + SLACK_MS) res.push(cur); continue; }
    if (cur && line.trim() && [...edited].some(e => e === line.trim() || e.endsWith('/' + line.trim()))) cur.hit = true;
  }
  return res.filter(c => c.hit).map(c => ({ sha: c.sha, at: c.at }));
}

// Which refs count as "the default branch". origin/HEAD's target first, then
// local main/master. Each is checked; work landed if it reached any.
function resolveBases(exec, top) {
  const refs = [];
  const oh = (exec(top, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']) || '').trim();
  // origin/HEAD can point at a branch that was never fetched; skip it then.
  if (oh && exec(top, ['rev-parse', '-q', '--verify', oh]) != null) refs.push({ ref: oh, kind: 'origin' });
  for (const b of ['main', 'master']) if (exec(top, ['rev-parse', '-q', '--verify', `refs/heads/${b}`]) != null) { refs.push({ ref: `refs/heads/${b}`, kind: 'local' }); break; }
  return refs;
}

function fetchedAfter(exec, top, endedMs, fsImpl = require('fs')) {
  const gd = top && typeof top === 'object' && top.gitDir ? top.gitDir : gitCommonDir(exec, top);
  if (!gd) return false;
  const p = require('path').join(gd, 'FETCH_HEAD');
  try { return fsImpl.statSync(p).mtimeMs > endedMs; } catch { return false; }
}

// Non-merge commits on `ref` since the session started, with patch-ids and
// added-line hashes (for the squash / lines tests). The pathspec only picks
// WHICH commits are listed; --full-diff keeps each listed commit's whole
// patch, so its patch-id is the real one (a rename or a multi-file revert
// is not mistaken for a single-file deletion).
function candidates(exec, top, ref, sinceMs, files) {
  const args = ['log', ref, '--no-merges', '-p', '-U0', '--no-renames', '--no-color', ...NO_DRIVERS, '--full-diff', LOG_FORMAT,
    `--since=${new Date(sinceMs - DAY_MS).toISOString()}`, '-n', String(MAX_CANDIDATES)];
  if (files && files.length) args.push('--', ...files.slice(0, MAX_FILES));
  const logText = exec(top, args) || '';
  const parsed = parseLog(logText);
  const pids = patchIds(exec, top, logText);
  return parsed.map(c => ({ ...c, patch_id: pids[c.sha] || null }));
}

// Candidate commits per base ref, computed once and shared by findLanded and
// revertedOn: Map<ref, candidate[]>. The pathspec is every path any session
// commit touched (deletions and skipped files included), not only the files
// with tracked lines.
function candidatesByRef(exec, top, snapshot, bases, sinceMs) {
  const files = [...new Set(snapshot.commits.flatMap(c => (c.touched && c.touched.length ? c.touched : Object.keys(c.files))))];
  return new Map(bases.map(b => [b.ref, candidates(exec, top, b.ref, sinceMs, files)]));
}

// -> commits with { landed: sha|null, via, ref }
function findLanded(exec, top, snapshot, bases, sinceMs, cands = candidatesByRef(exec, top, snapshot, bases, sinceMs)) {
  const perBase = bases.map(b => ({ ...b, cands: cands.get(b.ref) || [] }));
  return snapshot.commits.map(c => {
    for (const b of perBase) if (exec(top, ['merge-base', '--is-ancestor', c.sha, b.ref]) != null) return { ...c, landed: c.sha, via: 'ancestor', ref: b.ref };
    for (const b of perBase) { const k = c.patch_id && b.cands.find(x => x.patch_id === c.patch_id && x.sha !== c.sha); if (k) return { ...c, landed: k.sha, via: 'patch_id', ref: b.ref }; }
    for (const b of perBase) { const k = snapshot.series_patch_id && b.cands.find(x => x.patch_id === snapshot.series_patch_id); if (k) return { ...c, landed: k.sha, via: 'squash', ref: b.ref }; }
    const mine = Object.values(c.files).flat();
    if (mine.length) for (const b of perBase) {
      let best = null, cov = 0;
      for (const k of b.cands) {
        if (k.sha === c.sha) continue;
        const pool = new Map(); for (const h of Object.values(k.files).flat()) pool.set(h, (pool.get(h) || 0) + 1);
        let hit = 0; for (const h of mine) if (pool.get(h) > 0) { hit++; pool.set(h, pool.get(h) - 1); }
        if (hit / mine.length > cov) { cov = hit / mine.length; best = k.sha; }
      }
      if (cov >= LINES_MATCH) return { ...c, landed: best, via: 'lines', ref: b.ref };
    }
    return { ...c, landed: null, via: 'none', ref: null };
  });
}

// Was commit c reverted on `ref` after it landed? git's own revert format
// (`Revert "<exact subject>"`, compared by subject hash), a body naming its
// SHA (or the landed SHA), or a later commit whose patch-id is c's inverse
// patch-id.
function revertedOn(exec, top, ref, c, cands = null) {
  const since = new Date(c.at - DAY_MS).toISOString();
  const log = exec(top, ['log', ref, '--no-merges', `--since=${since}`, '--format=%H%x1f%s%x1f%b%x1e', '-n', String(MAX_CANDIDATES)]) || '';
  for (const rec of log.split('\x1e')) {
    const [sha, s = '', b = ''] = rec.replace(/^\n/, '').split('\x1f');
    if (!sha) continue;
    const text = (s + '\n' + b).toLowerCase();
    const q = /^Revert "(.*)"$/.exec(s.trim());
    if (q && c.subject_hash && subjectHash(q[1]) === c.subject_hash) return true;
    if (text.includes(`reverts commit ${c.sha.slice(0, 12)}`) || (c.landed && c.landed !== c.sha && text.includes(`reverts commit ${c.landed.slice(0, 12)}`))) return true;
  }
  if (c.inverse_patch_id) {
    const list = cands || candidates(exec, top, ref, c.at, c.touched && c.touched.length ? c.touched : Object.keys(c.files));
    if (list.some(k => k.patch_id === c.inverse_patch_id && k.at >= c.at)) return true;
  }
  return false;
}

// `git blame --reverse --porcelain` -> Map<line of L:file, { sha, file }>:
// the line's last revision and its path there (it follows renames).
// A header is `<40hex> <line in the last revision> <line in L:file>[ <count>]`:
// with --reverse the blamed ("final") file is L:file itself, so the THIRD
// field numbers L's lines (verified on scratch repos: a line that stays at
// line 1 of L while three lines are prepended above it later reads
// `<sha> 4 1 1`, also across a rename). A header with a count starts a
// group; `filename` follows a group start only the first time a commit is
// shown (or when it has several paths), so a commit's path is remembered.
// `boundary` under a header means the line's last revision is L itself.
function parseReverseBlame(text, L, path0) {
  const out = new Map();
  const fileOf = new Map(), boundary = new Set();
  let group = null;
  for (const row of String(text || '').split('\n')) {
    const m = /^([0-9a-f]{40}) (\d+) (\d+)( \d+)?$/.exec(row);
    if (m) {
      if (m[4] || !group || group.sha !== m[1]) group = { sha: m[1], file: fileOf.get(m[1]) || null };
      out.set(Number(m[3]), group);
      continue;
    }
    if (!group) continue;
    if (row.startsWith('filename ')) { group.file = unquotePath(row.slice(9)); fileOf.set(group.sha, group.file); continue; }
    if (row === 'boundary') boundary.add(group.sha);
  }
  const res = new Map();
  for (const [line, g] of out) res.set(line, boundary.has(g.sha) ? { sha: L, file: path0 } : { sha: g.sha, file: g.file || fileOf.get(g.sha) || path0 });
  return res;
}

// Follow session lines from the commit they landed in (L) to the tip.
// sessionShas: every commit the session made and every commit its work
// landed as; endedMs: when the session ended. A line whose replacing commit
// is one of those, or is the session author's own within SLACK_MS of the
// end, was revised inside the session, not replaced after it: it counts in
// lines_unmapped only (the later commit's own lines are tracked on their
// own). A line with no parsed blame row is unmapped too: it is never
// assumed to have survived.
function measure(exec, top, landed, { authorEmail, tipRef, sessionShas = [], endedMs = NaN }) {
  const tip = (exec(top, ['rev-parse', tipRef]) || '').trim();
  const res = { lines: 0, survived: 0, changed_self: 0, changed_other: 0, replaced_by: Object.fromEntries(REPLACED.map(k => [k, 0])),
    first_fix_at: null, files_skipped: 0, lines_unmapped: 0, perCommit: {} };
  if (!tip) return res;
  const own = new Set(sessionShas.filter(Boolean));
  for (const c of landed) { own.add(c.sha); if (c.landed) own.add(c.landed); }
  const email = String(authorEmail || '').toLowerCase();
  // Group the session's line hashes by (landed commit, file); remember which
  // session commit each hash came from so per-task totals can be kept.
  const groups = new Map();
  for (const c of landed) {
    if (!c.landed) continue;
    for (const [f, hs] of Object.entries(c.files)) {
      const key = c.landed + '\0' + f;
      const g = groups.get(key) || { L: c.landed, f, want: [] };
      for (const h of hs) g.want.push({ h, from: c.sha });
      groups.set(key, g);
    }
  }
  const meta = new Map();
  const commitMeta = sha => {
    if (!meta.has(sha)) {
      const o = (exec(top, ['show', '-s', '--format=%ae%x1f%s%x1f%at%x1f%P', sha]) || '').trim().split('\x1f');
      meta.set(sha, { author: o[0] || '', subject: o[1] || '', at: Number(o[2]) * 1000 || 0, parents: (o[3] || '').split(' ').filter(Boolean) });
    }
    return meta.get(sha);
  };
  // A merge is not the change itself: classify the first non-merge commit
  // it brought in that touches the file.
  const resolveMerge = (r, f) => {
    const m = commitMeta(r);
    if (m.parents.length < 2) return r;
    const inner = (exec(top, ['rev-list', '--reverse', '--no-merges', `${r}^1..${r}`, '--', f]) || '').split('\n').filter(Boolean)[0];
    return inner || r;
  };
  const insideSession = (r) => {
    if (own.has(r)) return true;
    const m = commitMeta(r);
    return !!email && m.author.toLowerCase() === email && Number.isFinite(endedMs) && m.at > 0 && m.at <= endedMs + SLACK_MS;
  };
  const bump = (from, k) => { const p = res.perCommit[from] ||= { lines: 0, survived: 0, fixed: 0 }; p[k]++; };
  let fileCount = 0;
  for (const g of groups.values()) {
    if (++fileCount > MAX_FILES) { res.files_skipped++; continue; }
    const content = exec(top, ['cat-file', 'blob', `${g.L}:${g.f}`]);
    if (content == null) { res.files_skipped++; continue; }
    // Place each wanted hash on a line of L:f (first unused match).
    const byHash = new Map();
    for (const w of g.want) (byHash.get(w.h) || byHash.set(w.h, []).get(w.h)).push(w);
    const placed = [];
    content.split('\n').forEach((ln, i) => {
      const q = byHash.get(lineHash(ln));
      if (q && q.length && !trivialLine(ln)) placed.push({ line: i + 1, from: q.shift().from });
    });
    for (const q of byHash.values()) res.lines_unmapped += q.length;
    if (!placed.length) continue;
    let lastBy = null;
    if (g.L === tip) lastBy = new Map(placed.map(p => [p.line, { sha: tip, file: g.f }]));
    else {
      const bl = exec(top, ['blame', ...NO_DRIVERS, '--no-ignore-revs-file', '--reverse', '--porcelain', '-w', '-M', `${g.L}..${tip}`, '--', g.f]);
      if (bl == null) { res.files_skipped++; continue; }
      lastBy = parseReverseBlame(bl, g.L, g.f);
    }
    const replacer = new Map();
    for (const p of placed) {
      const lb = lastBy.get(p.line);
      if (!lb) { res.lines_unmapped++; continue; }                       // fail closed: never assumed survived
      const last = lb.sha;
      if (last === tip) { res.lines++; bump(p.from, 'lines'); res.survived++; bump(p.from, 'survived'); continue; }
      // The replacing commit is the first after `last` that touches the
      // file under the path it had at `last` (a rename is followed).
      const rk = last + '\0' + lb.file;
      if (!replacer.has(rk)) {
        const r = (exec(top, ['rev-list', '--reverse', '--ancestry-path', `${last}..${tip}`, '--', lb.file]) || '').split('\n').filter(Boolean)[0] || null;
        replacer.set(rk, r && resolveMerge(r, lb.file));
      }
      const r = replacer.get(rk);
      if (!r) { res.lines_unmapped++; continue; }                        // no replacing commit found: unknown, not survived
      if (insideSession(r)) { res.lines_unmapped++; continue; }          // revised inside the session
      res.lines++; bump(p.from, 'lines');
      const m = commitMeta(r);
      const kind = classifySubject(m.subject, m.author);
      res.replaced_by[kind]++;
      if (m.author && email && m.author.toLowerCase() === email) res.changed_self++; else res.changed_other++;
      if (kind === 'fix' || kind === 'revert') {
        bump(p.from, 'fixed');
        if (m.at && (res.first_fix_at == null || m.at < res.first_fix_at)) res.first_fix_at = m.at;
      }
    }
  }
  return res;
}

module.exports = {
  defaultExec, lineHash, subjectHash, trivialLine, classifySubject, parseLog, parseReverseBlame, repoTop, gitCommonDir,
  snapshotCommits, terminalCommits, resolveBases, fetchedAfter, candidatesByRef, findLanded, revertedOn, measure,
  SKIP_FILE, REPLACED, LANDED_VIA, MAX_COMMITS, SLACK_MS, DAY_MS,
};
