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
const { loadSalt } = require('./lib/anonymize');
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

// Task 14 item 1: plugin/enrich-session.js is the fully detached
// classification child — a real separate node process, spawned by
// spawnEnrich below, requiring only ./lib (vendored) so it's vendor-safe
// exactly like this file.
const ENRICH_SCRIPT = path.join(__dirname, 'enrich-session.js');

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
  return { record: buildRecord({ session, metrics, abstraction, gitTruth: truth, coachNudges, salt, projectLabels, shipFacts }), session };
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

async function uploadOne(filepath, claudeDir, cfg, fetchImpl = globalThis.fetch) {
  const flags = effectiveFlags(cfg);
  if (!flags.usage) return 'skip';
  try {
    const built = await buildFor(filepath, claudeDir,
      { projectLabels: cfg.projectLabels, tokenomicaDir: cfg.tokenomicaDir, shipFacts: flags.facts });
    if (!built) return 'skip';
    const base = String(cfg.url).replace(/\/+$/, '');
    const r = await post(base, '/api/records', cfg.token, built.record, fetchImpl);
    if (!r || !r.ok) { console.error(`tokenomica: record not stored (${r && r.status})`); return false; }
    return true;
  } catch (e) { console.error(`tokenomica: upload failed: ${e.message}`); return false; }
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
// Recursion note: this is reachable ONLY from within runHook, which has
// already returned early if TOKENOMICA_CLASSIFYING is set on ITS OWN env (see
// runHook below) — so this never fires from inside a classify child's own
// SessionEnd. The env passed to the CHILD here is never given
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

async function runHook(opts = {}) {
  // D4 recursion guard: lib/classify-headless.js spawns `claude -p` as a
  // child with TOKENOMICA_CLASSIFYING=1 in its env (inherited down that
  // child's whole process tree). If THIS SessionEnd hook fires again for
  // that child's own session, bail out immediately — never sessionize or
  // classify the classifier's own transcript, or the recursion never ends.
  // This also means uploadAndEnrich/spawnEnrich below are NEVER reached from
  // inside a classify child's own SessionEnd — the guard is upstream of them.
  if (process.env.TOKENOMICA_CLASSIFYING) return;
  const cfg = loadConfig();
  if (!cfg) { console.error('tokenomica: no config — run the connect setup from /connect first'); return; }
  // Task 24 (G3): a legacy BRAIN_SHARING/BRAIN_USAGE env resolved the tier
  // conservatively rather than an explicit tier/TOKENOMICA_TIER — warn once.
  // Each SessionEnd hook invocation is itself a fresh, short-lived process,
  // so printing here satisfies "once per boot" the same way the sender
  // daemon's single boot-time print does.
  if (cfg.legacyWarning) console.error(`tokenomica: ${cfg.legacyWarning}`);
  const input = await readStdinJson();
  const fp = input && input.transcript_path;
  // Task 14 item 1: POST immediately with deterministic labels (uploadOne,
  // inside uploadAndEnrich), then — only if that landed and classify isn't
  // turned off — spawn the fully detached enrichment child. Either way this
  // hook exits 0 right after, never having waited on an LLM.
  if (fp) await uploadAndEnrich(fp, CLAUDE_DIR, cfg, opts);
  else console.error('tokenomica: hook input had no transcript_path');
  try { await maybeAutoBackfill(cfg); }
  catch (e) { console.error(`tokenomica: auto-backfill: ${e.message}`); }
  // Deferred code-survival: re-blame a few aged sessions. Best-effort and
  // capped — session end must never block on it.
  try { await runResurvey(cfg, CLAUDE_DIR, { maxPerRun: 3 }); } catch {}
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
  return { attempted, stored };
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
// resurveyAged — rebuilds each with gitTruth:true (buildFor, above) and
// re-POSTs; the hub upserts over the day-0 record in place. Gated by the
// SAME usage flag every other shipping route funnels through (effectiveFlags)
// so a non-shipping tier never re-blames OR re-uploads anything.
// maxPerRun is small (3) from the SessionEnd hook (never hang session end)
// and large from the explicit /tokenomica:resurvey command (drains the
// backlog on demand). ledgerPath defaults to the real RESURVEY_LEDGER —
// tests override it (same injectable pattern as runBackfill's markerFile).
async function runResurvey(cfg, claudeDir = CLAUDE_DIR, { maxPerRun = 3, fetchImpl = globalThis.fetch, ledgerPath = RESURVEY_LEDGER } = {}) {
  const flags = effectiveFlags(cfg);
  if (!flags.usage) return { surveyed: 0, skipped: 0 };
  const base = String(cfg.url).replace(/\/+$/, '');
  const sessions = await listLocalSessions(claudeDir);
  return resurveyAged({
    listSessions: () => sessions,
    buildOne: (file) => buildFor(file, claudeDir, { projectLabels: cfg.projectLabels, tokenomicaDir: cfg.tokenomicaDir, shipFacts: flags.facts, gitTruth: true }),
    post: (rec) => post(base, '/api/records', cfg.token, rec, fetchImpl),
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
  console.log(`Re-surveyed ${surveyed} session(s).`);
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
async function runBackfill({
  configPath = CONFIG_PATH,
  markerFile = MARKER_PATH,
  claudeDir = CLAUDE_DIR,
  fetchImpl = globalThis.fetch,
  skip = false,
} = {}) {
  const cfg = loadConfig(configPath);
  if (!cfg) { console.log('config: missing — set up at your dashboard’s /connect page'); return; }

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

  const { attempted, stored } = await backfillAll(cfg, claudeDir, fetchImpl);
  if (attempted > 0 && stored === 0) {
    console.log(`history import: failed — 0 of ${attempted} sessions stored; nothing marked done, try again later`);
    return;
  }
  fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString(), imported: stored }) + '\n');
  console.log(`history import: done — ${stored} session${stored === 1 ? '' : 's'} imported`);
}

function classifyProbe(res) {
  if (res && res.threw) return `unreachable (${res.message})`;
  if (res && (res.status === 401 || res.status === 403)) return 'token rejected — mint a new one at /connect';
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
  let res;
  try {
    const r = await post(String(cfg.url).replace(/\/+$/, ''), '/api/records', cfg.token, {}, fetchImpl);
    res = { status: r.status };
  } catch (e) { res = { threw: true, message: e.message }; }
  console.log(`server: ${classifyProbe(res)}`);
}

module.exports = { loadConfig, buildFor, uploadOne, uploadAndEnrich, spawnEnrich, runHook, runBackfill,
  backfillAll, maybeAutoBackfill, runStatus, classifyProbe, runResurvey, runResurveyCommand, CONFIG_PATH, MARKER_PATH };

if (require.main === module) {
  // Task 25 (G4): --skip travels alongside --backfill (the /tokenomica:backfill
  // command's `$ARGUMENTS` pass-through — see plugin/commands/backfill.md) —
  // e.g. `/tokenomica:backfill --skip` runs this file with both flags present.
  // Task 7: --resurvey is the /tokenomica:resurvey command's own invocation
  // (plugin/commands/resurvey.md) — same dispatch pattern.
  const main = process.argv.includes('--backfill') ? () => runBackfill({ skip: process.argv.includes('--skip') })
    : process.argv.includes('--status') ? runStatus
    : process.argv.includes('--resurvey') ? runResurveyCommand
    : runHook;
  main().then(() => process.exit(0)).catch(e => { console.error(`tokenomica: ${e.message}`); process.exit(0); });
}
