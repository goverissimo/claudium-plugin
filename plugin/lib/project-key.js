// SPDX-License-Identifier: Apache-2.0
// lib/project-key.js — the STABLE, cross-machine identity of a project.
//
// WHY THIS EXISTS: project_label used to be an HMAC of the session's project
// DIRECTORY NAME keyed by a PER-MACHINE salt (lib/anonymize.js's loadSalt).
// Both halves of that are machine-local, so the same repo checked out by five
// engineers produced five unrelated 'p-<12hex>' labels and "what did this repo
// cost the team?" was not computable at all — the single question a token
// tracker exists to answer.
//
// The fix has two halves; this file is the first:
//   1. (here) derive the project key from the git REMOTE, which is identical
//      on every machine that has the repo, instead of the local directory
//      name, which is not (~/src/checkout vs ~/work/checkout-svc vs a
//      worktree named 'checkout-hotfix' are all the same project).
//   2. (lib/anonymize.js loadOrgSalt + lib/record.js shipProjectLabel) key the
//      HMAC with an ORG-scoped salt fetched once from the dashboard, so the
//      hashes of that identical key actually collide across the team.
//
// The privacy property is unchanged: the remote URL never leaves the machine,
// only an HMAC of it does, and the org salt is only ever known to machines
// already authorized to upload to that org. Credentials embedded in a remote
// URL (https://user:token@host/...) are stripped before hashing so a leaked
// salt could never expose one.
//
// Pure except deriveProjectKey's one `git config` call (injectable). Only Node
// builtins, so this file vendors into the plugin as-is (see
// scripts/build-plugin.js PLUGIN_LIB_FILES).

const { execFileSync } = require('child_process');

// A local path is NOT a stable identity — /Users/ana/checkout and
// C:\src\checkout are the same project on two machines. Remotes that are
// really just filesystem paths are rejected so they fall back to the
// per-machine pseudonym rather than silently pretending to be stable.
const LOCAL_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/]|\.{1,2}[\\/]|file:)/;

// normalizeRemote(url) -> '<host>/<path>' lowercased, or '' if the URL is
// absent/local/unparseable. Every remote form git accepts collapses to the
// same key for the same repo:
//   git@github.com:acme/checkout.git         -> github.com/acme/checkout
//   https://github.com/Acme/Checkout.git     -> github.com/acme/checkout
//   ssh://git@github.com:22/acme/checkout    -> github.com/acme/checkout
//   https://x-token:abc123@gitlab.com/a/b.git-> gitlab.com/a/b   (creds dropped)
function normalizeRemote(url) {
  let s = String(url == null ? '' : url).trim();
  if (!s || LOCAL_PATH_RE.test(s)) return '';

  // scp-like syntax (git@host:path) has no '//' and must be rewritten before
  // any URL parsing, or the ':path' reads as a port.
  const scp = /^(?:([^@/]+)@)?([^@:/]+):(?!\/)(.+)$/.exec(s);
  if (scp && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `ssh://${scp[2]}/${scp[3]}`;
  }

  // Strip the scheme, then any embedded credentials — NEVER hash a token.
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const at = s.lastIndexOf('@');
  const firstSlash = s.indexOf('/');
  if (at > -1 && (firstSlash === -1 || at < firstSlash)) s = s.slice(at + 1);

  // Drop an explicit port: github.com:22/acme/x -> github.com/acme/x. A port
  // is a transport detail, not part of the repo's identity, so ssh:// and
  // https:// remotes for one repo must not diverge on it.
  s = s.replace(/^([^/]+?):\d+(?=\/|$)/, '$1');

  s = s.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  if (!s || !s.includes('/')) return '';
  return s;
}

// repoName(key) -> the last path segment of a normalized key ('checkout' from
// 'github.com/acme/checkout'). This is what a `project_labels` override in
// ~/.tokenomica/plugin.json is matched against FIRST, so one identical config
// line gives a whole team the same readable label — the old behavior matched
// the local directory name, which differs per machine and therefore could
// never be shared.
function repoName(key) {
  const parts = String(key || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function defaultExec(cwd, args) {
  // -C <cwd> so this works from a worktree/submodule exactly as git would.
  // 2s is generous for `git config` (a single file read); the cap only exists
  // so a hung filesystem can never stall the SessionEnd finisher.
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// deriveProjectKey({ cwd, exec }) -> { key, source }
//   key    — normalized remote ('github.com/acme/checkout'), or '' when the
//            session has no cwd / no repo / no usable remote.
//   source — 'remote' when key is stable across machines, 'none' otherwise.
// Callers treat source !== 'remote' as "fall back to the per-machine
// pseudonym": a key we cannot compute identically elsewhere is worse than
// useless, because it would collide two DIFFERENT projects that happen to
// share a directory name across two machines.
//
// Remote preference order: 'origin' first (the overwhelming default), then
// 'upstream' (fork workflows, where origin is the personal fork and upstream
// is the shared repo everyone else's origin also points at — teams that fork
// still want ONE project). Anything else is ignored on purpose; guessing at
// an arbitrary third remote would make the key machine-dependent again.
function deriveProjectKey({ cwd, exec = defaultExec } = {}) {
  if (!cwd) return { key: '', source: 'none' };
  const run = (args) => { try { return exec(cwd, args); } catch { return null; } };
  for (const remote of ['origin', 'upstream']) {
    const out = run(['config', '--get', `remote.${remote}.url`]);
    if (out == null) continue;
    const key = normalizeRemote(out.split('\n')[0]);
    if (key) return { key, source: 'remote' };
  }
  return { key: '', source: 'none' };
}

module.exports = { deriveProjectKey, normalizeRemote, repoName };
