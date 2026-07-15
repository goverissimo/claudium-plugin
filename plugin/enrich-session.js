#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// plugin/enrich-session.js — Tokenomica plugin — SessionEnd enrichment child.
//
// plugin/upload-session.js's SessionEnd hook (runHook -> uploadAndEnrich)
// posts a fast, deterministic record and exits 0 immediately — it never
// waits on an LLM (Task 14 item 1: fire-and-forget, no added latency). This
// script is what it spawns to do the SLOW part: run lib/classify-headless.js's
// classify() auth ladder (API key -> headless `claude -p` -> deterministic)
// and re-POST the enriched record through the SAME claude_session_id, which
// the hub's existing upsert overwrites the deterministic record with.
//
// This is a REAL separate node process (spawned detached: true, stdio:
// 'ignore', unref()'d — see upload-session.js's spawnEnrich) — it is NOT a
// function call inside the hook. By the time this runs, the hook has
// already exited; nothing is listening on its stdout/stderr and nothing is
// waiting on it. It must therefore tolerate running entirely alone: every
// failure is swallowed (logged to stderr at most, when a terminal is even
// attached — stdio is 'ignore' in production) and the process always exits
// 0. The deterministic record already landed; enrichment is pure upside.
//
// Config crosses the process boundary via TOKENOMICA_ENRICH_* env vars only
// (spawnEnrich passes no stdin/pipe — stdio is fully ignored); optsFromEnv
// below is the read side of that same contract.
//
// Recursion note (inherits D4's design — see lib/classify-headless.js's
// file header): classify() may spawn `claude -p` with TOKENOMICA_CLASSIFYING=1
// set on THAT child's env — a grandchild relative to the original hook,
// never on THIS process's own env. This process itself is not given
// TOKENOMICA_CLASSIFYING (spawnEnrich never sets it, and runHook never spawns
// this script while that guard is active in the first place); if it
// somehow were set anyway, classifyHeadless's own belt-and-braces guard
// refuses to spawn again regardless (see lib/classify-headless.js).
//
// Self-contained: requires ONLY ./lib (vendored by scripts/build-plugin.js)
// and Node built-ins — same vendor-safe contract as plugin/upload-session.js.
// This file itself is plugin SOURCE (lives in plugin/ directly, not vendored).

const fs = require('fs');
const path = require('path');
const { sessionize } = require('./lib/sessionize');
const { computeMetrics } = require('./lib/metrics');
const { buildRecord } = require('./lib/record');
const { classify } = require('./lib/classify-headless');
const { getProjectName } = require('./lib/parse');
const { loadSalt } = require('./lib/anonymize');

const isSubagentPath = p => /[/\\]subagents[/\\]/.test(String(p || ''));

// Mirrors buildFor's non-abstraction session assembly (plugin/upload-session.js)
// — duplicated, not imported, for the same vendor-safe-standalone reason above.
async function assembleSession(filepath, claudeDir) {
  if (isSubagentPath(filepath)) return null;
  const raw = await fs.promises.readFile(filepath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  const session = sessionize(lines, {
    projectLabel: getProjectName(filepath, claudeDir),
    claudeSessionId: path.basename(filepath, '.jsonl'),
  });
  if (!session.turnCount) return null;
  return session;
}

async function post(base, apiPath, token, body, fetchImpl) {
  return fetchImpl(base + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// enrich(opts) -> Promise<boolean> — true iff the enriched record was
// posted and stored. opts: filepath, claudeDir, url, token, tokenomicaDir,
// projectLabels (default {}), apiKey (default '' -> classify() itself falls
// through to process.env.ANTHROPIC_API_KEY), fetchImpl (default
// globalThis.fetch), classifyImpl (default lib/classify-headless.js's
// classify — inject a stub in tests; never spawns a real `claude -p` when
// injected).
// shipFacts (Task 24/G3, default true): tier 'metrics' allows classify() to
// run (activity_category/domain/cost still ship, still logged to the ledger
// below) but forces session_facts to [] on the record this re-POSTs — the
// SAME enforcement seam lib/record.js's buildRecord provides on the sender
// route (lib/usage-pipeline.js's enrichAndRepost). Threaded across the
// process boundary via TOKENOMICA_ENRICH_SHIP_FACTS (see optsFromEnv below;
// spawnEnrich in plugin/upload-session.js is the write side).
async function enrich({ filepath, claudeDir, url, token, tokenomicaDir, projectLabels = {},
  apiKey = '', fetchImpl = globalThis.fetch, classifyImpl = classify, shipFacts = true } = {}) {
  const session = await assembleSession(filepath, claudeDir);
  if (!session) return false;

  const metrics = computeMetrics(session);
  const result = await classifyImpl(session, metrics, { apiKey, fetchImpl, tokenomicaDir });

  // Task 15 item 5 (fold-forward, Task 14 review minor): classify() bottoming
  // out to the deterministic guess means the auth ladder produced NOTHING new
  // over the immediate SessionEnd build's own fallbackAbstraction — the
  // deterministic record already landed with THIS same classifier. Re-POSTing
  // an identical record wastes a network round trip for zero information
  // gain, so skip it entirely rather than rebuild+re-post.
  if (result.classifier === 'deterministic') return false;

  // Task 15 item 1: log cost for every successful NON-deterministic
  // classification (i.e. we got past the guard above) — one entry per
  // enrichment, in the SAME ~/.tokenomica/coach-log.jsonl the coach's nudges
  // live in. Never a nudge itself (lib/coach-ledger.js's nudgesFor
  // explicitly excludes this kind). Best-effort: a ledger write failure must
  // never block the re-POST that follows.
  try {
    require('./lib/coach-ledger').logClassifyCost({
      sessionId: session.claudeSessionId, costUsd: result.cost_usd,
      classifier: result.classifier, activityCategory: result.activity_category, domain: result.domain,
    }, { dir: tokenomicaDir });
  } catch { /* best-effort — never block enrichment on a ledger write failure */ }

  // Task 14 item 3: map the classify() result into the abstraction shape
  // buildRecord expects — cost_usd -> classify_cost_usd (lib/record.js),
  // classifier/extractor_version/activity_category/domain pass straight
  // through. Rebuilding through buildRecord re-runs the FULL privacy gate:
  // intent_summary is always machine-composed from THIS record's own final
  // enums (lib/scrub.js) — classify()'s local_intent free text never rides
  // along, exactly like the original deterministic build.
  const abstraction = {
    activity_category: result.activity_category,
    domain: result.domain,
    classifier: result.classifier,
    extractor_version: result.extractor_version,
    cost_usd: result.cost_usd,
    // D1a (Task 16): rides the SAME classify() call above through to
    // buildRecord's session_facts field (lib/scrub.js re-gates regardless).
    facts: result.facts,
  };

  let coachNudges = [];
  try { coachNudges = require('./lib/coach-ledger').nudgesFor(session.claudeSessionId, { dir: tokenomicaDir }); } catch {}
  const salt = loadSalt(tokenomicaDir);
  const record = buildRecord({ session, metrics, abstraction, coachNudges, salt, projectLabels, shipFacts });

  const base = String(url).replace(/\/+$/, '');
  const r = await post(base, '/api/records', token, record, fetchImpl);
  return !!(r && r.ok);
}

// optsFromEnv(env) -> enrich() opts. The read side of spawnEnrich's
// TOKENOMICA_ENRICH_* env-var contract (plugin/upload-session.js).
function optsFromEnv(env = process.env) {
  let projectLabels = {};
  try { projectLabels = JSON.parse(env.TOKENOMICA_ENRICH_PROJECT_LABELS || '{}'); } catch { projectLabels = {}; }
  return {
    filepath: env.TOKENOMICA_ENRICH_FILE,
    claudeDir: env.TOKENOMICA_ENRICH_CLAUDE_DIR,
    url: env.TOKENOMICA_ENRICH_URL,
    token: env.TOKENOMICA_ENRICH_TOKEN,
    tokenomicaDir: env.TOKENOMICA_ENRICH_TOKENOMICA_DIR,
    // Task 15 item 2: the plugin.json auth override (threaded through by
    // spawnEnrich as TOKENOMICA_ENRICH_API_KEY) wins over whatever ambient
    // ANTHROPIC_API_KEY this child inherited from process.env — a
    // deliberate in-config choice beats a leftover shell env var.
    apiKey: env.TOKENOMICA_ENRICH_API_KEY || env.ANTHROPIC_API_KEY || '',
    projectLabels,
    // Task 24 (G3): the resolved tier's facts flag (spawnEnrich's write
    // side lives in plugin/upload-session.js). Only a literal '0' turns it
    // off — absent (undefined, an older spawnEnrich) or '1' both ship facts,
    // matching every other TOKENOMICA_ENRICH_* field's backward-compatible
    // "missing means today's default" behavior.
    shipFacts: env.TOKENOMICA_ENRICH_SHIP_FACTS !== '0',
  };
}

module.exports = { enrich, assembleSession, optsFromEnv };

if (require.main === module) {
  enrich(optsFromEnv(process.env))
    .then(() => process.exit(0))
    .catch(e => { try { console.error(`tokenomica: enrich failed: ${e.message}`); } catch {} process.exit(0); });
}
