#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Tokenomica plugin — SessionEnd hook. Builds the privacy-scrubbed usage record
// for the session that just finished and POSTs it to Tokenomica Cloud. Raw
// transcripts never leave the machine — unconditionally: there is no
// transcript upload path at all (D1b/Task 17).
//
// CONTRACT: this process must NEVER disturb the user's session — every path
// exits 0; failures go to stderr only. Config: ~/.tokenomica/plugin.json
// { "url": "https://…", "token": "…" }
// (a stale "transcripts" key from an older config is silently ignored.)
//
// GRACE WINDOW: Claude Code aborts SessionEnd hooks — and their whole process
// tree — roughly 1.5s after session end, regardless of hooks.json's own
// timeout ("Hook cancelled"; verified against Claude Code 2.1.211; the
// CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS override exists but users won't set
// it). A hook that exits fast is never cancelled, and ONLY then does a
// detached child escape the tree kill. So runHook does nothing but read its
// stdin input and spawn plugin/finish-session.js fully detached; ALL real
// work (upload, enrich spawn, backfill notice, resurvey — runFinish below)
// happens in that child, after this process and the CLI are already gone.
//
// Self-contained: requires ONLY ./lib (vendored by scripts/build-plugin.js)
// and Node built-ins. No npm install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sessionize } = require('./lib/sessionize');
const { computeMetrics } = require('./lib/metrics');
const { fallbackAbstraction } = require('./lib/extract');
const { buildRecord } = require('./lib/record');
const { getProjectName } = require('./lib/parse');
const { loadSalt, loadOrgSalt, saveOrgSalt, loadOrgPolicy, saveOrgPolicy } = require('./lib/anonymize');
// Stable cross-machine project identity (lib/project-key.js) + the durable
// delivery queue and reconciliation ledger that together make "every session
// is tracked" a property of the system rather than a hope.
const { deriveProjectKey } = require('./lib/project-key');
const outbox = require('./lib/outbox');
const sessionLedger = require('./lib/session-ledger');
const { lastClassifyCost, lastClassifyError } = require('./lib/coach-ledger');
// D4 (final review, item 1b): backfillAll's walk descends into EVERY project
// dir under CLAUDE_DIR, including one derived from the classify() child's
// own cwd (~/.tokenomica/classify) — buildFor must skip it explicitly, the
// same way it skips subagent sidecars below. Shared (not duplicated)
// predicate — see lib/classify-path.js.
const { isClassifyProjectPath } = require('./lib/classify-path');
const { configDir } = require('./lib/config-dir');
// Task 24 (G3): named sharing tiers, one config surface — resolveTier is the
// SAME resolver the sender pipeline uses (lib/sharing-tiers.js, vendored
// here by scripts/build-plugin.js), so both routes read one `tier` key off
// the SAME plugin.json (loadConfig, below) and the SAME TOKENOMICA_TIER/legacy
// env precedence.
const { resolveTier, describeTier, TIERS } = require('./lib/sharing-tiers');
// Task 7: the deferred re-survey orchestrator (Task 5, vendored) — pure/
// dependency-free, injected with THIS file's own session enumeration, build,
// post, and ledger I/O so it runs identically here and on the sender route.
const { resurveyAged } = require('./lib/resurvey');
const gitManifest = require('./lib/git-manifest');

// Task 14 item 1: plugin/enrich-session.js is the fully detached
// classification child — a real separate node process, spawned by
// spawnEnrich below, requiring only ./lib (vendored) so it's vendor-safe
// exactly like this file.
const ENRICH_SCRIPT = path.join(__dirname, 'enrich-session.js');
// The detached SessionEnd finisher (see GRACE WINDOW above) — a thin shim
// that calls this file's own runFinish. Same vendor-safe contract.
const FINISH_SCRIPT = path.join(__dirname, 'finish-session.js');

// The version of THIS plugin build, stamped onto every record. Cost is
// derived from token counts by a price table, and knowing which build sent a
// row is how the server tells whether that row was priced by a table that
// knew about a given model — plus it turns "is the fleet upgraded?" into a
// query instead of a survey. Read once; an unreadable manifest degrades to ''
// ("unknown build"), never to a throw inside the session-end path.
const PLUGIN_VERSION = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof m.version === 'string' ? m.version : '';
  } catch { return ''; }
})();

const CONFIG_PATH = path.join(configDir(), 'plugin.json');
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
const MARKER_PATH = path.join(path.dirname(CONFIG_PATH), 'backfilled');
// A1: same directory as plugin.json/backfilled — this is where the
// per-machine HMAC salt (lib/anonymize.js's loadSalt) lives too.
const TOKENOMICA_DIR = path.dirname(CONFIG_PATH);

// Task 15 item 2: this is the ONE place the plugin route reads plugin.json —
// every config-derived value below (classify gate, project label overrides,
// the optional apiKey auth override) comes from this single parse. There is
// deliberately NO model-choice field anywhere in this config: the pinned
// model (lib/classify-headless.js's MODEL, 'claude-haiku-4-5') is what makes
// cross-org labels comparable — a per-user model knob would break that.
function loadConfig(p = CONFIG_PATH) {
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.token !== 'string') return null;
    const projectLabels = (cfg.project_labels && typeof cfg.project_labels === 'object') ? cfg.project_labels : {};
    // Task 14 item 5: classify() enrichment is on by default; only an
    // explicit "off" opts out.
    const classify = cfg.classify === 'off' ? 'off' : 'on';
    // Task 15 item 2: optional auth override — feeds classify()'s auth-ladder
    // apiKey rung ahead of any ambient ANTHROPIC_API_KEY (see spawnEnrich,
    // which threads this through to the detached enrichment child).
    const apiKey = typeof cfg.anthropic_api_key === 'string' ? cfg.anthropic_api_key : '';
    // D1b (Task 17): the transcript upload path is gone. A stale
    // "transcripts" key from an older config is simply never read here —
    // tolerated silently, never an error.
    // Task 24 (G3): resolve the named sharing tier from THIS SAME parsed
    // plugin.json (a `tier` key) plus process.env (TOKENOMICA_TIER, and the
    // legacy BRAIN_SHARING/BRAIN_USAGE envs, mapped conservatively — see
    // lib/sharing-tiers.js's resolveTier for the full precedence/mapping).
    const { tier, flags, legacyWarning } = resolveTier(cfg, process.env);
    return { url: cfg.url, token: cfg.token, projectLabels, classify, apiKey, tier, flags, legacyWarning };
  } catch { return null; }
}

const isSubagentPath = p => /[/\\]subagents[/\\]/.test(String(p || ''));

// Sessions in one repo share a cwd, and a backfill can walk hundreds of them,
// so the `git config` read behind deriveProjectKey is memoized for the life of
// this process. Keyed by cwd because that is exactly what the answer depends
// on.
const projectKeyCache = new Map();
function projectKeyFor(cwd) {
  if (!cwd) return '';
  if (projectKeyCache.has(cwd)) return projectKeyCache.get(cwd);
  let key = '';
  try { key = deriveProjectKey({ cwd }).key || ''; } catch { key = ''; }
  projectKeyCache.set(cwd, key);
  return key;
}

// Task 14 (C5): this build is ALWAYS deterministic — no network call, no
// added latency, so the SessionEnd hook can POST and exit 0 instantly. The
// richer classify() auth ladder (API key -> headless `claude -p` ->
// deterministic) runs ONLY in the detached enrichment child spawned by
// uploadAndEnrich below. Since backfill (backfillAll's walk AND
// maybeAutoBackfill) calls uploadOne -> buildFor directly and NEVER
// uploadAndEnrich, backfill never classifies, by construction.
// shipFacts (Task 24/G3, default true — see lib/sharing-tiers.js): tier
// 'metrics' forces session_facts to [] on the record this produces, even
// though this build is always deterministic (fallbackAbstraction never sets
// .facts) — threaded through here for parity with the sender pipeline's
// buildRecordForFile, and because the ENRICHED rebuild (plugin/enrich-session.js,
// where classify() actually runs) is a separate process that reads the same
// flag across its own env-var boundary (see spawnEnrich's
// TOKENOMICA_ENRICH_SHIP_FACTS below).
// gitTruth (Task 7): when true, and the session has a cwd and at least one
// commit, re-derive numbers-only code-survival stats (lib/git-truth.js's
// analyzeGitTruth — runs `git` INSIDE session.cwd, on the machine that still
// has that repo checked out) and thread them into buildRecord the same way
// lib/usage-pipeline.js's buildRecordForFile already does on the sender
// route. Day-0 SessionEnd calls never pass gitTruth (survival only means
// something once the code has had days to hold up or get rewritten) —
// runResurvey (below) is the only caller that does.
async function buildFor(filepath, claudeDir, { projectLabels, tokenomicaDir = TOKENOMICA_DIR, shipFacts = true, gitTruth = false } = {}) {
  if (isSubagentPath(filepath)) return null;
  if (isClassifyProjectPath(filepath)) return null;   // never ingest the classify() child's own transcript
  const raw = await fs.promises.readFile(filepath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  const session = sessionize(lines, {
    projectLabel: getProjectName(filepath, claudeDir),
    claudeSessionId: path.basename(filepath, '.jsonl'),
  });
  if (!session.turnCount) return null;
  const metrics = computeMetrics(session);
  const abstraction = fallbackAbstraction(session);
  let truth = null;
  if (gitTruth && session.cwd && session.commits > 0) {
    try { truth = require('./lib/git-truth').analyzeGitTruth({ cwd: session.cwd, startedAt: session.startedAt, endedAt: session.endedAt }); } catch {}
  }
  // Ledger read follows the same tokenomicaDir as the salt below (the real
  // TOKENOMICA_DIR on the shipping path; tests pass a temp dir).
  let coachNudges = [];
  try { coachNudges = require('./lib/coach-ledger').nudgesFor(session.claudeSessionId, { dir: tokenomicaDir }); } catch {}
  // A1: this is a SHIPPED path — always pseudonymize project_label
  // (per-machine salt, created on demand; user-assigned overrides win).
  const salt = loadSalt(tokenomicaDir);
  // The ORG salt (lib/anonymize.js loadOrgSalt) is what makes the same repo
  // hash identically on every teammate's machine — without it, team
  // cost-per-project is not computable at all. It is cached locally after one
  // authenticated fetch (ensureOrgSalt); until then this is '' and the label
  // falls back to the per-machine pseudonym. Deriving the project key costs a
  // `git config` read, so only pay it when something will actually use it:
  // the org salt (for the shared hash) or a project_labels map (whose keys are
  // now matched against the repo name first — see lib/record.js).
  const orgSalt = loadOrgSalt(tokenomicaDir);
  const wantsKey = !!orgSalt || !!(projectLabels && Object.keys(projectLabels).length);
  const projectKey = wantsKey ? projectKeyFor(session.cwd) : '';
  // Git refs ship only when the org opted in. Then the day-0 manifest (built
  // here, locally) supplies each task's commits, including the ones made with
  // a plain `git commit` that Claude Code did not record structurally.
  const orgPolicy = loadOrgPolicy(tokenomicaDir);
  let manifestChecked = false;
  if (orgPolicy.shareGitRefs) {
    manifestChecked = true;
    try {
      const m = gitManifest.ensureManifest({ tokenomicaDir, transcript: filepath, session, record: null });
      if (m) session.taskCommits = gitManifest.taskCommitsOf(m);
    } catch { /* refs are optional; the record still ships */ }
  }
  return { record: buildRecord({ session, metrics, abstraction, gitTruth: truth, coachNudges, salt, projectLabels, shipFacts, orgSalt, projectKey, pluginVersion: PLUGIN_VERSION, orgPolicy }), session, manifestChecked };
}

async function post(base, apiPath, token, body, fetchImpl) {
  return fetchImpl(base + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// Task 24 (G3): the usage flag gates record shipping — this is the ONE
// choke point every plugin-route caller funnels through (runHook's
// uploadAndEnrich, backfillAll, maybeAutoBackfill, runBackfill), so tier
// 'off'/'presence'/'activity' (usage: false) never ships a usage record
// from ANY of them, uniformly. A cfg with no .flags at all (a caller that
// built cfg directly rather than through loadConfig — this repo's own
// spawn/detach unit tests do exactly that) falls back to TIERS.full
// (today's default), never silently dropping an older caller's uploads.
function effectiveFlags(cfg) {
  return (cfg && cfg.flags) || TIERS.full;
}

// The tokenomica state directory this cfg is operating on. Tests inject a
// temp dir via cfg.tokenomicaDir; the shipping path uses the real one.
const stateDir = (cfg) => (cfg && cfg.tokenomicaDir) || TOKENOMICA_DIR;

// uploadOne is now BUILD-AND-PERSIST, not build-and-send. It returns true the
// moment the record is durable on disk (lib/outbox.js), because that — not a
// 200 from the dashboard — is the point after which the session can no longer
// be lost. Delivery is a separate, retried concern (flushOutbox below).
//
// This is the whole fix for the old failure mode: a single POST whose failure
// (offline, VPN, redeploy, expired token) destroyed the session and reported
// it to a stderr nobody reads. Loss like that is BIASED — it tracks travel and
// flaky networks — so it under-reported spend invisibly. Now the only way to
// lose a session is to fail to write a file.
//
// Returns 'skip' (nothing to ship: not a session, or the tier ships nothing),
// true (durable), or false (could not persist — a real, reportable failure).
async function uploadOne(filepath, claudeDir, cfg, fetchImpl = globalThis.fetch) {
  const flags = effectiveFlags(cfg);
  if (!flags.usage) return 'skip';
  const dir = stateDir(cfg);
  try {
    const built = await buildFor(filepath, claudeDir,
      { projectLabels: cfg.projectLabels, tokenomicaDir: cfg.tokenomicaDir, shipFacts: flags.facts });
    if (!built) return 'skip';
    const id = outbox.enqueue(built.record, { dir });
    if (!id) { console.error('tokenomica: could not persist record for delivery'); return false; }
    // Day-0 git manifest (lib/git-manifest.js): which commits this session
    // made, for the d7/d30 survey. Local only; best-effort — a git hiccup
    // must never cost the session its record.
    // When buildFor already looked (git refs on) and found no commits, the
    // git scan is not repeated: a session without commits saves nothing, so
    // ensureManifest would redo the whole terminal-commit search.
    const known = built.manifestChecked ? gitManifest.loadManifest(dir, built.session.claudeSessionId) : null;
    if (!built.manifestChecked || known) {
      try { gitManifest.ensureManifest({ tokenomicaDir: dir, transcript: filepath, session: built.session, record: built.record }); } catch {}
    }
    // Ledger at QUEUE time, not delivery time: the outbox already owns
    // delivery, and conflating the two would make a delivery backlog look
    // like a capture gap to the reconciliation sweep, which would then
    // re-build every pending session on every run.
    // Stamped with the transcript's mtime — the same clock the sweep selects
    // by — not the session's end time. The ledger prunes by this value, so a
    // session that ended more than LEDGER_RETAIN_DAYS ago but was touched
    // recently (a resumed session) used to be pruned the moment it was
    // ledgered and re-queued on every run. Not Date.now(): a history import
    // would then keep every old session in the ledger for 60 days.
    const endedMs = Date.parse(built.record.ended_at || built.record.started_at);
    let mtimeMs = NaN;
    try { mtimeMs = fs.statSync(filepath).mtimeMs; } catch { /* gone since the build */ }
    const stamp = Math.max(Number.isFinite(mtimeMs) ? mtimeMs : 0, Number.isFinite(endedMs) ? endedMs : 0);
    sessionLedger.markQueued(dir, id, stamp || Date.now());
    return true;
  } catch (e) { console.error(`tokenomica: record build failed: ${e.message}`); return false; }
}

// Delivery. Drains a bounded slice of the outbox, honouring each entry's
// backoff. Bounded so one session end stays fast even with a fortnight of
// backlog; the backlog then drains over the next few sessions instead of
// stalling this one.
async function flushOutbox(cfg, { fetchImpl = globalThis.fetch, max = 40 } = {}) {
  const dir = stateDir(cfg);
  const base = String(cfg.url).replace(/\/+$/, '');
  return outbox.drain({
    dir, max,
    post: async (rec) => {
      const r = await post(base, '/api/records', cfg.token, rec, fetchImpl);
      return { ok: !!(r && r.ok), status: r && r.status };
    },
  });
}

// Fetches the org's project salt once and caches it (lib/anonymize.js
// saveOrgSalt). This is the second half of stable project identity: the first
// (lib/project-key.js) makes the KEY identical across machines, this makes the
// HASH of that key identical too, which is what lets the dashboard add up what
// a repo costs the whole team.
//
// Deliberately never fatal and never blocking: no dashboard, an old server
// with no such route, or any error at all simply leaves the label falling back
// to the per-machine pseudonym. A cosmetic grouping field must never be able
// to cost us a session.
// The org salt is fetched once and cached forever; the org's sharing policy
// comes back on the same call and is refreshed every POLICY_TTL_MS, so an
// admin's change reaches every laptop within hours without a reinstall.
const POLICY_TTL_MS = 6 * 3600 * 1000;
async function ensureOrgSalt(cfg, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const dir = stateDir(cfg);
  const haveSalt = !!loadOrgSalt(dir);
  const pol = loadOrgPolicy(dir);
  const policyFresh = pol.fetchedAt && now - Date.parse(pol.fetchedAt) < POLICY_TTL_MS;
  if (haveSalt && policyFresh) return true;
  try {
    const base = String(cfg.url).replace(/\/+$/, '');
    const r = await fetchImpl(`${base}/api/connect/salt`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (!r || !r.ok) { expireStalePolicy(pol, dir, now); return haveSalt; }
    const body = await r.json();
    // A server that predates the setting doesn't send it: that means "off",
    // and caching it keeps this to one fetch per POLICY_TTL_MS either way.
    saveOrgPolicy({ share_git_refs: !!(body && body.share_git_refs === true) }, dir, now);
    return haveSalt || !!saveOrgSalt(body && body.project_salt, dir);
  } catch { expireStalePolicy(pol, dir, now); return haveSalt; }
}

// A sharing policy that could not be refreshed for a day falls back to "off":
// an admin who turned sharing off must not be outlasted by a laptop that
// cannot reach the server. Turning it back on only needs one good fetch.
const POLICY_MAX_STALE_MS = 24 * 3600 * 1000;
function expireStalePolicy(pol, dir, now) {
  if (pol.shareGitRefs && (!pol.fetchedAt || now - Date.parse(pol.fetchedAt) > POLICY_MAX_STALE_MS)) {
    saveOrgPolicy({ share_git_refs: false }, dir, Date.parse(pol.fetchedAt) || 0);
  }
}

// RECONCILIATION — the other half of "every session is tracked".
//
// The outbox guarantees delivery of records we managed to BUILD. It cannot
// help when the SessionEnd hook never ran at all: a force-quit, a dead
// battery, a CLI self-update, a closed lid, a finisher killed before it wrote.
// In every one of those the transcript is on disk, complete, and nothing ever
// told the dashboard about it.
//
// So each run also compares what exists locally against what this machine has
// already queued, and closes the difference. Bounded per run, and floored at
// the connection watermark (lib/session-ledger.js sweepSince) so it can never
// become a backdoor history import — history still moves only on an explicit
// /tokenomica:backfill.
async function runSweep(cfg, claudeDir = CLAUDE_DIR, { max = 15 } = {}) {
  const flags = effectiveFlags(cfg);
  if (!flags.usage) return { queued: 0, skipped: 0 };
  const dir = stateDir(cfg);
  const pending = outbox.pendingIds(dir);
  const missed = sessionLedger.findMissed({
    dir, claudeDir, max,
    // The SAME exclusions the upload path uses, so the sweep and the uploader
    // can never disagree about what counts as an ingestable session.
    skip: (fp) => isSubagentPath(fp) || isClassifyProjectPath(fp),
    isPending: (id) => pending.has(id),
  });
  let queued = 0, skipped = 0;
  for (const m of missed) {
    const out = await uploadOne(m.file, claudeDir, cfg);
    if (out === true) queued++;
    else {
      // 'skip' means this file will NEVER produce a record (empty, no turns).
      // Ledger it anyway, or every sweep for the next 30 days re-reads and
      // re-rejects the same file.
      if (out === 'skip') sessionLedger.markQueued(dir, m.id, m.endedAtMs);
      skipped++;
    }
  }
  return { queued, skipped };
}

// Task 14 item 1: spawns lib/classify-headless.js's classify() ladder in a
// FULLY DETACHED child process (plugin/enrich-session.js) so the SessionEnd
// hook never waits on an LLM call to exit. detached + stdio: 'ignore' +
// unref() together mean this process can exit the instant spawnImpl
// returns: the child is never attached to it, and re-POSTs the enriched
// record entirely on its own, after this process is already gone (see
// enrich-session.js's own file header for that side of the contract).
//
// Config/state cross the process boundary via env vars only (stdio is
// ignored, so no pipe is available) — TOKENOMICA_ENRICH_* below is the whole
// contract; plugin/enrich-session.js's optsFromEnv reads the same names.
//
// Recursion note: this is reachable ONLY from within runFinish (via
// uploadAndEnrich), and the finisher itself is only ever spawned by runHook,
// which has already returned early if TOKENOMICA_CLASSIFYING is set on ITS
// OWN env (see runHook below) — so this never fires from inside a classify
// child's own SessionEnd. The env passed to the CHILD here is never given
// TOKENOMICA_CLASSIFYING itself; only classifyHeadless()'s OWN spawned
// `claude -p` (a grandchild, deep inside the enrichment child) gets that.
function spawnEnrich(fp, claudeDir, cfg, { spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(process.execPath, [ENRICH_SCRIPT], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, {
        TOKENOMICA_ENRICH_FILE: fp,
        TOKENOMICA_ENRICH_CLAUDE_DIR: claudeDir,
        TOKENOMICA_ENRICH_URL: cfg.url,
        TOKENOMICA_ENRICH_TOKEN: cfg.token,
        TOKENOMICA_ENRICH_TOKENOMICA_DIR: cfg.tokenomicaDir || TOKENOMICA_DIR,
        TOKENOMICA_ENRICH_PROJECT_LABELS: JSON.stringify(cfg.projectLabels || {}),
        // Task 15 item 2: the optional plugin.json auth override, threaded
        // across the process boundary the same way every other cfg field is
        // (stdio is 'ignore' — env vars are the whole contract). Empty
        // string, never undefined, when no override is configured.
        TOKENOMICA_ENRICH_API_KEY: cfg.apiKey || '',
        // Task 24 (G3): the resolved tier's `facts` flag, threaded the same
        // way — '0' forces the enriched re-POST's session_facts to []
        // (tier 'metrics'); '1' (the default, matching TIERS.full) ships
        // them. A cfg with no .flags at all (direct-construction callers)
        // defaults to '1', same backward-compatible fallback as uploadOne's
        // effectiveFlags.
        TOKENOMICA_ENRICH_SHIP_FACTS: effectiveFlags(cfg).facts ? '1' : '0',
      }),
    });
    if (child && typeof child.unref === 'function') child.unref();
    return child;
  } catch (e) {
    console.error(`tokenomica: enrich spawn failed: ${e.message}`);
    return null;
  }
}

// uploadOne, then (only if it stored AND classify isn't turned off)
// spawnEnrich. This is the ONLY caller of spawnEnrich in this file —
// backfillAll/maybeAutoBackfill (below) call uploadOne directly, so backfill
// never enriches/classifies.
async function uploadAndEnrich(fp, claudeDir, cfg, { fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
  const stored = await uploadOne(fp, claudeDir, cfg, fetchImpl);
  if (stored === true && cfg.classify !== 'off') spawnEnrich(fp, claudeDir, cfg, { spawnImpl });
  return stored;
}

function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    process.stdin.on('error', () => resolve(null));
  });
}

// Spawns plugin/finish-session.js FULLY DETACHED (same mechanics as
// spawnEnrich above: detached + stdio 'ignore' + unref, env-var contract
// because no pipe exists). The hook exits the instant this returns; the
// finisher — reparented to init once the hook is gone — does all the real
// session-end work on its own, outside the CLI's ~1.5s grace window (see
// GRACE WINDOW in the file header). Only filepath/claudeDir cross the
// boundary: the finisher loads ~/.tokenomica/plugin.json itself, so config
// never rides through the environment.
function spawnFinish(fp, claudeDir, { spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(process.execPath, [FINISH_SCRIPT], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, {
        TOKENOMICA_FINISH_FILE: fp || '',
        TOKENOMICA_FINISH_CLAUDE_DIR: claudeDir,
      }),
    });
    if (child && typeof child.unref === 'function') child.unref();
    return child;
  } catch (e) {
    console.error(`tokenomica: finish spawn failed: ${e.message}`);
    return null;
  }
}

// THE TICK. SessionEnd only fires when a session closes, and people keep
// sessions open for days: on one real machine, ten sessions had been open for
// up to nine days, so the dashboard showed nothing new while the plugin was
// installed, enabled and connected. So the plugin also runs on SessionStart
// and Stop (after each Claude turn), throttled to once per TICK_MS per
// machine. A tick does no work in-process either: it spawns the same detached
// finisher with no transcript, whose reconciliation sweep picks up every
// session that is new or has grown since it was last queued, open ones
// included, and delivers the queue. Nothing is printed: SessionStart stdout
// would land in Claude's context, and a tick has nothing to say.
const TICK_FILE = 'last-tick';
const TICK_MS = 10 * 60 * 1000;
function claimTick(dir, now = Date.now()) {
  const file = path.join(dir, TICK_FILE);
  try {
    const last = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isFinite(last) && last <= now && now - last < TICK_MS) return false;
  } catch { /* first tick on this machine */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(now), { mode: 0o600 });
  } catch { return false; }   // can't record it: don't risk a tick on every turn
  return true;
}

async function runTick(opts = {}) {
  if (process.env.TOKENOMICA_CLASSIFYING) return;   // never from the classifier's own `claude -p`
  const cfg = loadConfig(opts.configPath);
  if (!cfg) return;   // runs every turn: stay quiet; SessionEnd says "not connected"
  if (!claimTick(opts.tokenomicaDir || stateDir(cfg), opts.now)) return;
  spawnFinish('', CLAUDE_DIR, opts);
}

// The SessionEnd hook itself. It must finish in well under the CLI's ~1.5s
// grace window or it is cancelled AND its process tree is killed — so it
// does no network, git, or transcript work at all: guard, load config, read
// the hook input, spawn the detached finisher, exit. Testability seams
// (opts.configPath, opts.input, opts.spawnImpl) exist because stdin/config
// are otherwise process-global; production callers pass nothing.
async function runHook(opts = {}) {
  // D4 recursion guard: lib/classify-headless.js spawns `claude -p` as a
  // child with TOKENOMICA_CLASSIFYING=1 in its env (inherited down that
  // child's whole process tree). If THIS SessionEnd hook fires again for
  // that child's own session, bail out immediately — never sessionize or
  // classify the classifier's own transcript, or the recursion never ends.
  // The guard sits HERE, not in the finisher: the finisher inherits this
  // process's env, so a classify child's SessionEnd never spawns one at all.
  if (process.env.TOKENOMICA_CLASSIFYING) return;
  const cfg = loadConfig(opts.configPath);
  if (!cfg) { console.error('tokenomica: not connected — run /tokenomica:login <dashboard-url>'); return; }
  const input = opts.input !== undefined ? opts.input : await readStdinJson();
  const fp = (input && input.transcript_path) || '';
  spawnFinish(fp, CLAUDE_DIR, opts);
}

// The old runHook body — everything session end actually owes — now run by
// the detached finisher (plugin/finish-session.js), which nothing is
// waiting on: upload the deterministic day-0 record, spawn the enrichment
// child, surface the one-time backfill notice, drain a little resurvey
// backlog. Every injectable (configPath/tokenomicaDir/fetchImpl/spawnImpl/
// markerFile/noticeFile/ledgerPath) defaults to the real thing; tests pass
// temp paths so nothing here ever touches real state under test.
async function runFinish({ filepath = '', claudeDir = CLAUDE_DIR, configPath = CONFIG_PATH,
  tokenomicaDir, fetchImpl = globalThis.fetch, spawnImpl = spawn,
  markerFile, noticeFile, ledgerPath } = {}) {
  let cfg = loadConfig(configPath);
  if (!cfg) { console.error('tokenomica: not connected — run /tokenomica:login <dashboard-url>'); return; }
  if (tokenomicaDir) cfg = Object.assign({}, cfg, { tokenomicaDir });
  // Task 24 (G3): a legacy BRAIN_SHARING/BRAIN_USAGE env resolved the tier
  // conservatively rather than an explicit tier/TOKENOMICA_TIER — warn once.
  // Each finisher invocation is itself a fresh, short-lived process, so
  // printing here satisfies "once per boot" the same way the sender
  // daemon's single boot-time print does.
  if (cfg.legacyWarning) console.error(`tokenomica: ${cfg.legacyWarning}`);
  // FIRST: make sure this machine has the org project salt, so the record
  // built below gets the cross-machine project label rather than the
  // per-machine one. One authenticated fetch, cached forever after; a failure
  // here is silent and costs only label granularity, never a session.
  try { await ensureOrgSalt(cfg, { fetchImpl }); } catch {}
  // Task 14 item 1: build + persist immediately with deterministic labels
  // (uploadOne, inside uploadAndEnrich), then — only if that landed and
  // classify isn't turned off — spawn the fully detached enrichment child,
  // whose richer record replaces this one in the queue.
  if (filepath) await uploadAndEnrich(filepath, claudeDir, cfg, { fetchImpl, spawnImpl });
  // No transcript: a tick (see runTick), or a SessionEnd without one. The
  // sweep below still picks up every new or grown session.
  const backfillOpts = {};
  if (markerFile) backfillOpts.markerFile = markerFile;
  if (noticeFile) backfillOpts.noticeFile = noticeFile;
  try { await maybeAutoBackfill(cfg, backfillOpts); }
  catch (e) { console.error(`tokenomica: auto-backfill: ${e.message}`); }
  // Reconciliation: catch sessions whose SessionEnd hook never ran at all
  // (force-quit, dead battery, CLI self-update). Bounded, and floored at the
  // connection watermark so it is never a backdoor history import.
  try { await runSweep(cfg, claudeDir, { max: 15 }); } catch {}
  // Deferred code-survival: re-blame a few aged sessions. Best-effort and
  // capped — each finisher run stays short; the per-session ledger
  // (lib/resurvey.js) makes progress durable even if this process dies.
  const resurveyOpts = { maxPerRun: 3, fetchImpl };
  if (ledgerPath) resurveyOpts.ledgerPath = ledgerPath;
  try { await runResurvey(cfg, claudeDir, resurveyOpts); } catch {}
  // LAST: deliver. Everything above only ever writes to the durable queue, so
  // this is the single place the network is touched for records — and if it
  // fails or this process is killed here, nothing is lost; the next session
  // end (or /tokenomica:status) picks the backlog up exactly where it stopped.
  try { await flushOutbox(cfg, { fetchImpl, max: 40 }); } catch {}
}

async function backfillAll(cfg, claudeDir = CLAUDE_DIR, fetchImpl = globalThis.fetch) {
  let attempted = 0, stored = 0;
  const walk = async (dir) => {
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === 'subagents') continue; await walk(fp); }
      else if (e.name.endsWith('.jsonl')) {
        process.stderr.write(`tokenomica: backfill ${e.name}\n`);
        const out = await uploadOne(fp, claudeDir, cfg, fetchImpl);
        if (out !== 'skip') { attempted++; if (out === true) stored++; }
      }
    }
  };
  await walk(claudeDir);
  // uploadOne only queues; deliver the whole batch here with a generous cap so
  // an explicit import finishes in one command instead of trickling out over
  // the next twenty session ends. Anything that still fails stays queued and
  // retries on its own.
  const flushed = await flushOutbox(cfg, { fetchImpl, max: Math.max(50, attempted * 2) });
  return { attempted, stored, sent: flushed.sent, remaining: flushed.remaining };
}

// Task 7: local session enumerator for the deferred re-survey pass. Reuses
// backfillAll's own mtime-based walk pattern (same subagents-dir skip) but
// only needs {file, id, endedAt} — resurveyAged does its own age filtering
// off endedAt, so mtime (not the transcript's own internal endedAt, which
// would require a full parse per file just to enumerate) is the cheap,
// good-enough proxy: a session's last jsonl write IS effectively when it
// ended.
async function listLocalSessions(claudeDir) {
  const out = [];
  const walk = async (dir) => {
    let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === 'subagents') continue; await walk(fp); }
      else if (e.name.endsWith('.jsonl')) {
        try { const st = await fs.promises.stat(fp); out.push({ file: fp, id: path.basename(fp, '.jsonl'), endedAt: st.mtime.toISOString() }); } catch {}
      }
    }
  };
  await walk(claudeDir);
  return out;
}

// Task 7: the ledger of already-resurveyed session ids — a plain JSON array
// under TOKENOMICA_DIR (same directory as plugin.json/backfilled/salt), read
// wholesale into a Set and written back merged (never overwritten) so a
// crash mid-run can't drop earlier progress. The ledger PATH is injectable
// (mirrors how runBackfill threads markerFile = MARKER_PATH in this same
// file): real callers use the default RESURVEY_LEDGER; tests point it at a
// throwaway temp file so the happy path is exercisable without ever touching
// the real ~/.tokenomica.
const RESURVEY_LEDGER = path.join(TOKENOMICA_DIR, 'resurvey.json');

function loadResurveyLedger(ledgerPath = RESURVEY_LEDGER) {
  try { return new Set(JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))); } catch { return new Set(); }
}
function saveResurveyLedger(ids, ledgerPath = RESURVEY_LEDGER) {
  const cur = loadResurveyLedger(ledgerPath);
  ids.forEach(x => cur.add(x));
  try { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.writeFileSync(ledgerPath, JSON.stringify([...cur])); } catch {}
}

// Task 7: drains a handful of aged local sessions through lib/resurvey.js's
// resurveyAged — surveys each through lib/git-manifest.js (the day-0
// manifest, or the transcript when there is none) and re-POSTs; the hub
// upserts over the day-0 record in place. Gated by the
// SAME usage flag every other shipping route funnels through (effectiveFlags)
// so a non-shipping tier never re-blames OR re-uploads anything.
// maxPerRun is small (3) from the session-end finisher (each run stays
// short) and large from the explicit /tokenomica:resurvey command (drains
// the backlog on demand). ledgerPath defaults to the real RESURVEY_LEDGER —
// tests override it (same injectable pattern as runBackfill's markerFile).
// Which local sessions this machine is allowed to re-survey.
//
// The rule (history never moves without an explicit /tokenomica:backfill,
// unless this machine has actually shipped it) lives in
// lib/session-ledger.js's resurveyFloor so the sender's runResurveyOnce
// enforces the exact same floor. This is a one-liner that keeps the name so
// existing callers/tests are unaffected.
function resurveyFloor(cfg) {
  return sessionLedger.resurveyFloor(stateDir(cfg));
}

async function runResurvey(cfg, claudeDir = CLAUDE_DIR, { maxPerRun = 3, fetchImpl = globalThis.fetch, ledgerPath = RESURVEY_LEDGER } = {}) {
  const flags = effectiveFlags(cfg);
  if (!flags.usage) return { surveyed: 0, skipped: 0 };
  const floor = resurveyFloor(cfg);
  const sessions = (await listLocalSessions(claudeDir))
    .filter(s => { const t = Date.parse(s.endedAt); return Number.isFinite(t) && t >= floor; });
  // Work list: every local transcript past the floor, plus sessions whose
  // transcript is gone but whose day-0 manifest remains (Claude Code deletes
  // transcripts after 30 days; the d30 survey still has to run).
  const dir = stateDir(cfg);
  try { gitManifest.pruneManifests(dir); } catch {}
  const byId = new Map(sessions.map(s => [s.id, s]));
  for (const m of gitManifest.listManifests(dir)) {
    const t = Date.parse(m.endedAt);
    if (!byId.has(m.id) && Number.isFinite(t) && t >= floor) byId.set(m.id, { id: m.id, file: null, endedAt: m.endedAt });
  }
  return resurveyAged({
    listSessions: () => [...byId.values()],
    survey: (item, checkpoint) => gitManifest.surveyItem({ tokenomicaDir: dir, id: item.id, file: item.file, checkpoint,
      build: (file) => buildFor(file, claudeDir, { projectLabels: cfg.projectLabels, tokenomicaDir: cfg.tokenomicaDir, shipFacts: flags.facts }) }),
    // Enqueue rather than POST: a re-survey is a record like any other and
    // must be as loss-proof as the day-0 one. Same upsert key, so it simply
    // replaces any still-pending copy of that session in the queue.
    post: (rec) => { if (!outbox.enqueue(rec, { dir: stateDir(cfg) })) throw new Error('could not persist re-surveyed record'); },
    loadLedger: () => loadResurveyLedger(ledgerPath),
    saveLedger: (ids) => saveResurveyLedger(ids, ledgerPath),
    now: Date.now(), maxPerRun,
  });
}

// /tokenomica:resurvey — the explicit, on-demand counterpart to the
// SessionEnd hook's own small (maxPerRun: 3) background pass above: drains
// the WHOLE backlog of aged sessions in one go. A thin CLI wrapper —
// runResurvey itself takes an already-loaded cfg, so this is the one place
// that loads it (mirrors runBackfill/runStatus's own configPath param) —
// lets the command doc's invocation (plugin/commands/resurvey.md) call this
// file with no arguments beyond --resurvey.
async function runResurveyCommand({ configPath = CONFIG_PATH, claudeDir = CLAUDE_DIR, fetchImpl = globalThis.fetch } = {}) {
  const cfg = loadConfig(configPath);
  if (!cfg) { console.log('Not connected — run /tokenomica:status'); return; }
  const { surveyed } = await runResurvey(cfg, claudeDir, { maxPerRun: 1000, fetchImpl });
  // runResurvey only queues; deliver what it produced (plus any pre-existing
  // backlog) before reporting, so the user sees the real outcome and not just
  // "queued".
  const flushed = await flushOutbox(cfg, { fetchImpl, max: 2000 });
  const tail = flushed.remaining ? ` ${flushed.remaining} still queued (will retry).` : '';
  console.log(`Re-surveyed ${surveyed} session(s); uploaded ${flushed.sent}.${tail}`);
}

// Task 25 (G4): first-run history import is CONSENTED to, never silent.
// SessionEnd used to auto-import history in the background the first time it
// ran (see git history for that version) — that's gone. maybeAutoBackfill
// now NEVER imports anything; it only ever writes a one-time
// "backfill-notice" marker (a sibling of MARKER_PATH, same directory) and
// prints a best-effort stderr line, so the pending state doesn't get
// re-announced every single session end. The actual import only ever
// happens through the explicit /tokenomica:backfill command (runBackfill,
// below), which is the ONE place any history now leaves the machine
// unprompted-by-a-live-session (still gated by uploadOne's normal record
// build, still deterministic-only — see buildFor's own header comment).
//
// SessionEnd hook output is a dead end for user-facing notices: per Claude
// Code's hooks reference, SessionEnd has no decision control (it cannot
// block or affect session behavior), stdout on exit 0 is never shown to the
// user, and the only output that surfaces at all is stderr's first line on
// a NON-ZERO exit — which this hook never uses (the file-header CONTRACT:
// every path exits 0, so nothing ever surfaces in-session). So the stderr
// line below is best-effort only (visible to someone tailing logs, never to
// the user in-session) — the notice that actually reaches the user is
// /tokenomica:status's "history import: pending — run /tokenomica:backfill"
// line (runStatus, below), which is why the notice marker's ONLY job is
// de-duplicating this function's own side effects across repeated
// SessionEnd invocations, not the user-visible state itself (that's just
// "does MARKER_PATH exist").
//
// Task 24 (G3): a tier with usage:false must not get nagged to run a command
// that can't do anything at that tier, AND must not permanently foreclose
// the pending notice — mirrors the same guard the old auto-import used, bail
// BEFORE touching either marker so the notice still surfaces the moment the
// tier allows usage records.
async function maybeAutoBackfill(cfg, {
  markerFile = MARKER_PATH,
  // Defaults to a sibling of markerFile — this means every existing caller
  // that already overrides markerFile alone (this file's own tests, and
  // plugin-enrich-gate.test.js) automatically gets a hermetic noticeFile too,
  // with no risk of ever touching the real ~/.tokenomica/backfill-notice.
  noticeFile = path.join(path.dirname(markerFile), 'backfill-notice'),
} = {}) {
  if (!effectiveFlags(cfg).usage) return false;
  if (fs.existsSync(markerFile)) return false;
  if (fs.existsSync(noticeFile)) return false;
  console.error('tokenomica: history import is pending — run /tokenomica:backfill to import your existing session history, or /tokenomica:backfill --skip to dismiss this notice');
  try { fs.writeFileSync(noticeFile, JSON.stringify({ at: new Date().toISOString() }) + '\n'); } catch {}
  return true;
}

// /tokenomica:backfill — the explicit, consensual counterpart to the notice
// above. Mirrors runStatus's injectable configPath/markerFile/claudeDir/
// fetchImpl pattern so tests never touch the real ~/.tokenomica or network.
// `skip` (the command's `--skip` flag) records an explicit decline WITHOUT
// importing anything — it writes the SAME marker file maybeAutoBackfill and
// this function both check, so declining stops the notice for good, exactly
// like a real import would; skip always succeeds regardless of tier, since
// declining doesn't ship anything at any tier.
// tokenomicaDir: the state-directory seam (salt, outbox, ledgers). Production
// callers omit it and get the real ~/.tokenomica; tests point it at a
// throwaway so an import never writes to the developer's own state — the same
// injectable pattern markerFile/ledgerPath already use in this file.
async function runBackfill({
  configPath = CONFIG_PATH,
  markerFile = MARKER_PATH,
  claudeDir = CLAUDE_DIR,
  fetchImpl = globalThis.fetch,
  tokenomicaDir,
  skip = false,
} = {}) {
  let cfg = loadConfig(configPath);
  if (!cfg) { console.log('config: missing — set up at your dashboard’s /connect page'); return; }
  if (tokenomicaDir) cfg = Object.assign({}, cfg, { tokenomicaDir });

  if (skip) {
    fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString(), skipped: true }) + '\n');
    console.log('history import: skipped by user — nothing imported; run /tokenomica:backfill any time to import later');
    return;
  }

  // Task 24 (G3): same guard as maybeAutoBackfill — a non-shipping tier
  // makes every uploadOne call inside backfillAll's walk return 'skip',
  // which backfillAll doesn't count as "attempted" at all, indistinguishable
  // from genuinely empty history. Bail BEFORE walking so no marker gets
  // written, and say so, rather than silently doing nothing.
  if (!effectiveFlags(cfg).usage) {
    console.log(`history import: skipped by tier "${cfg.tier}" — ${describeTier(cfg.tier)}; nothing imported, no marker written`);
    return;
  }

  // Give history the same cross-machine project labels a live session gets,
  // so an imported repo lands in the same bucket as the sessions that follow
  // it instead of forming a second, orphaned one.
  try { await ensureOrgSalt(cfg, { fetchImpl }); } catch {}

  const { attempted, stored, sent, remaining } = await backfillAll(cfg, claudeDir, fetchImpl);
  if (attempted > 0 && stored === 0) {
    console.log(`history import: failed — 0 of ${attempted} sessions could be prepared; nothing marked done, try again later`);
    return;
  }
  // The marker records that the DECISION was made and the sessions were
  // captured. Delivery is the outbox's job from here on, so a network failure
  // mid-import no longer means re-running the whole thing — and, crucially, no
  // longer means those sessions are lost.
  fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString(), imported: stored }) + '\n');
  const tail = remaining ? ` ${remaining} queued and will upload automatically.` : '';
  console.log(`history import: done — ${stored} session${stored === 1 ? '' : 's'} captured, ${sent} uploaded.${tail}`);
}

function classifyProbe(res) {
  if (res && res.threw) return `unreachable (${res.message})`;
  // Re-auth is now one command, and — because failed uploads sit in the
  // outbox rather than evaporating — everything captured while the token was
  // dead flushes the moment they run it. Say that, so a lapsed token reads as
  // a two-second fix rather than lost data.
  if (res && (res.status === 401 || res.status === 403)) return 'token rejected — run /tokenomica:login to reconnect';
  return 'connected';
}

// Task 15 item 3: classification mode, in the SAME priority order
// classify()'s auth ladder itself uses (lib/classify-headless.js) — off
// beats everything (nothing runs at all); an explicit apiKey override beats
// the default headless tier.
function classificationMode(cfg) {
  if (cfg.classify === 'off') return 'off';
  if (cfg.apiKey) return 'on (api-key override)';
  return 'on (headless — your Claude Code login)';
}

// /tokenomica:status — never prints the token, always exits 0. configPath/
// markerPath/tokenomicaDir are injectable (mirrors loadConfig's own `p` param)
// so tests can point this at a throwaway dir instead of the real ~/.tokenomica.
async function runStatus(fetchImpl = globalThis.fetch, { configPath = CONFIG_PATH, markerPath = MARKER_PATH, tokenomicaDir = TOKENOMICA_DIR } = {}) {
  const cfg = loadConfig(configPath);
  if (!cfg) { console.log('config: missing — set up at your dashboard’s /connect page'); return; }
  console.log(`config: ${cfg.url} · token set`);
  // Task 25 (G4): three states off the SAME marker file runBackfill (the
  // /tokenomica:backfill command) and maybeAutoBackfill's notice both read —
  // no marker at all means the import is still pending (a plain "backfilled"
  // marker with skipped:true means the user explicitly declined, above the
  // marker.at check so a skip never reads as "done").
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
  console.log(marker && marker.skipped ? `history import: skipped by user (${marker.at})`
    : marker && marker.at ? `history import: done (${marker.at})`
    : 'history import: pending — run /tokenomica:backfill');
  console.log(`classification: ${classificationMode(cfg)}`);
  // Task 24 (G3): the resolved sharing tier + its one-line meaning — the
  // SAME tier lib/sharing-tiers.js's resolveTier computed inside loadConfig
  // above (TOKENOMICA_TIER > plugin.json "tier" > legacy env, conservatively >
  // default 'full'). If a legacy env resolved it, surface that too, so
  // status doubles as the "boot warning" surface for a one-off status check.
  console.log(`sharing tier: ${cfg.tier} — ${describeTier(cfg.tier)}`);
  if (cfg.legacyWarning) console.log(`note: ${cfg.legacyWarning}`);
  // Task 15 item 1/3: the coach ledger's last classify_cost entry — logged by
  // both capture routes (plugin/enrich-session.js, lib/usage-pipeline.js)
  // after every successful non-deterministic classification. Best-effort: a
  // ledger read failure must never break /tokenomica:status.
  let last = null;
  try { last = lastClassifyCost({ dir: tokenomicaDir }); } catch { /* status must always report something */ }
  console.log(last
    ? `last classification: ${last.activity_category || 'unknown'} · ${last.domain || 'unknown'} · $${Number(last.cost_usd || 0).toFixed(6)} (${last.classifier || 'unknown'})`
    : 'last classification: none yet');
  // Surface a classify FAILURE that is more recent than the last success (or
  // any failure if nothing has ever succeeded) — otherwise a broken classifier
  // (e.g. the Windows spawn issue) just reads as "none yet"/stale success.
  let err = null;
  try { err = lastClassifyError({ dir: tokenomicaDir }); } catch { /* best-effort */ }
  if (err && (!last || String(err.ts) > String(last.ts))) {
    console.log(`classification error: ${err.message} (${err.ts}) — sessions ship metrics-only until this is fixed`);
  }
  console.log(`plugin version: ${PLUGIN_VERSION || 'unknown'}`);
  // Delivery health. This is the line that turns what used to be SILENT data
  // loss into something a person can see and act on: a backlog is visible, its
  // age is visible, and anything permanently rejected is counted rather than
  // discarded. `pending: 0` is the only healthy steady state.
  let queue = null;
  try {
    queue = {
      pending: outbox.pendingCount(tokenomicaDir),
      dead: outbox.deadCount(tokenomicaDir),
      oldest: outbox.oldestPendingAt(tokenomicaDir),
    };
  } catch { /* status must always report something */ }
  if (queue) {
    const age = queue.oldest ? `, oldest ${queue.oldest}` : '';
    console.log(`upload queue: ${queue.pending} pending${age}`
      + (queue.dead ? ` · ${queue.dead} undeliverable (see ${outbox.deadDir(tokenomicaDir)})` : ''));
  }

  let res;
  try {
    const r = await post(String(cfg.url).replace(/\/+$/, ''), '/api/records', cfg.token, {}, fetchImpl);
    res = { status: r.status };
  } catch (e) { res = { threw: true, message: e.message }; }
  console.log(`server: ${classifyProbe(res)}`);

  // Status is also an OPPORTUNITY to deliver: someone running it is usually
  // online and usually asking precisely because they want to know the data
  // arrived. Draining here means "run /tokenomica:status" is a real fix for a
  // backlog, not just a report about one. Bounded, and silent on failure —
  // the backlog simply stays queued.
  if (queue && queue.pending) {
    try {
      const flushed = await flushOutbox(cfg, { fetchImpl, max: 200 });
      if (flushed.sent) console.log(`upload queue: delivered ${flushed.sent} now, ${flushed.remaining} left`);
      else if (flushed.lastError) console.log(`upload queue: still failing — ${flushed.lastError}`);
    } catch { /* report-only; never fail status */ }
  }
}

module.exports = { loadConfig, buildFor, uploadOne, uploadAndEnrich, spawnEnrich, spawnFinish, runHook, runTick, runFinish, TICK_MS,
  runBackfill, backfillAll, maybeAutoBackfill, runStatus, classifyProbe, runResurvey, runResurveyCommand,
  flushOutbox, ensureOrgSalt, runSweep, PLUGIN_VERSION, CONFIG_PATH, MARKER_PATH };

if (require.main === module) {
  // Task 25 (G4): --skip travels alongside --backfill (the /tokenomica:backfill
  // command's `$ARGUMENTS` pass-through — see plugin/commands/backfill.md) —
  // e.g. `/tokenomica:backfill --skip` runs this file with both flags present.
  // Task 7: --resurvey is the /tokenomica:resurvey command's own invocation
  // (plugin/commands/resurvey.md) — same dispatch pattern.
  const main = process.argv.includes('--backfill') ? () => runBackfill({ skip: process.argv.includes('--skip') })
    : process.argv.includes('--status') ? runStatus
    : process.argv.includes('--resurvey') ? runResurveyCommand
    : process.argv.includes('--tick') ? runTick
    : runHook;
  main().then(() => process.exit(0)).catch(e => { console.error(`tokenomica: ${e.message}`); process.exit(0); });
}
