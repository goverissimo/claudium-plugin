#!/usr/bin/env node
// Claudium plugin — SessionEnd hook. Builds the privacy-scrubbed usage record
// for the session that just finished and POSTs it to Claudium Cloud; with the
// local transcripts opt-in, also uploads secret/PII-redacted turns.
//
// CONTRACT: this process must NEVER disturb the user's session — every path
// exits 0; failures go to stderr only. Config: ~/.claudium/plugin.json
// { "url": "https://…", "token": "…", "transcripts": false }
//
// Self-contained: requires ONLY ./lib (vendored by scripts/build-plugin.js)
// and Node built-ins. No npm install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionize } = require('./lib/sessionize');
const { computeMetrics } = require('./lib/metrics');
const { extractAbstraction } = require('./lib/extract');
const { buildRecord } = require('./lib/record');
const { buildTranscriptTurns } = require('./lib/transcript');
const { getProjectName } = require('./lib/parse');

const CONFIG_PATH = path.join(os.homedir(), '.claudium', 'plugin.json');
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
const MARKER_PATH = path.join(path.dirname(CONFIG_PATH), 'backfilled');

function loadConfig(p = CONFIG_PATH) {
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.token !== 'string') return null;
    return { url: cfg.url, token: cfg.token, transcripts: cfg.transcripts === true };
  } catch { return null; }
}

const isSubagentPath = p => /[/\\]subagents[/\\]/.test(String(p || ''));

async function buildFor(filepath, claudeDir, { apiKey } = {}) {
  if (isSubagentPath(filepath)) return null;
  const raw = await fs.promises.readFile(filepath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  const session = sessionize(lines, {
    projectLabel: getProjectName(filepath, claudeDir),
    claudeSessionId: path.basename(filepath, '.jsonl'),
  });
  if (!session.turnCount) return null;
  const metrics = computeMetrics(session);
  const abstraction = await extractAbstraction(session, { apiKey: apiKey || process.env.ANTHROPIC_API_KEY || '' });
  let coachNudges = [];
  try { coachNudges = require('./lib/coach-ledger').nudgesFor(session.claudeSessionId); } catch {}
  return { record: buildRecord({ session, metrics, abstraction, coachNudges }), session };
}

async function post(base, apiPath, token, body, fetchImpl) {
  return fetchImpl(base + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function uploadOne(filepath, claudeDir, cfg, fetchImpl = globalThis.fetch) {
  try {
    const built = await buildFor(filepath, claudeDir, {});
    if (!built) return 'skip';
    const base = String(cfg.url).replace(/\/+$/, '');
    const r = await post(base, '/api/records', cfg.token, built.record, fetchImpl);
    if (!r || !r.ok) { console.error(`claudium: record not stored (${r && r.status})`); return false; }
    if (cfg.transcripts) {
      const turns = buildTranscriptTurns(built.session);
      if (turns.length) {
        const t = await post(base, '/api/transcripts', cfg.token,
          { claude_session_id: built.record.claude_session_id, turns }, fetchImpl);
        if (!t || !t.ok) console.error(`claudium: transcript not stored (${t && t.status})`);
      }
    }
    return true;
  } catch (e) { console.error(`claudium: upload failed: ${e.message}`); return false; }
}

function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    process.stdin.on('error', () => resolve(null));
  });
}

async function runHook() {
  const cfg = loadConfig();
  if (!cfg) { console.error('claudium: no config — run the connect setup from /connect first'); return; }
  const input = await readStdinJson();
  const fp = input && input.transcript_path;
  if (fp) await uploadOne(fp, CLAUDE_DIR, cfg);
  else console.error('claudium: hook input had no transcript_path');
  try { await maybeAutoBackfill(cfg); }
  catch (e) { console.error(`claudium: auto-backfill: ${e.message}`); }
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
        process.stderr.write(`claudium: backfill ${e.name}\n`);
        const out = await uploadOne(fp, claudeDir, cfg, fetchImpl);
        if (out !== 'skip') { attempted++; if (out === true) stored++; }
      }
    }
  };
  await walk(claudeDir);
  return { attempted, stored };
}

// First-run auto-import: the marker makes this once-ever; a total failure
// writes no marker so the next session end retries (uploads are idempotent).
async function maybeAutoBackfill(cfg, { markerFile = MARKER_PATH, claudeDir = CLAUDE_DIR, fetchImpl = globalThis.fetch } = {}) {
  if (fs.existsSync(markerFile)) return false;
  const { attempted, stored } = await backfillAll(cfg, claudeDir, fetchImpl);
  if (attempted > 0 && stored === 0) return false;
  fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString() }) + '\n');
  return true;
}

async function runBackfill() {
  const cfg = loadConfig();
  if (!cfg) { console.error('claudium: no config — run the connect setup from /connect first'); return; }
  await backfillAll(cfg, CLAUDE_DIR, globalThis.fetch);
  try { fs.writeFileSync(MARKER_PATH, JSON.stringify({ at: new Date().toISOString() }) + '\n'); } catch {}
}

function classifyProbe(res) {
  if (res && res.threw) return `unreachable (${res.message})`;
  if (res && (res.status === 401 || res.status === 403)) return 'token rejected — mint a new one at /connect';
  return 'connected';
}

// /claudium:status — three lines, never prints the token, always exits 0.
async function runStatus(fetchImpl = globalThis.fetch) {
  const cfg = loadConfig();
  if (!cfg) { console.log('config: missing — set up at your dashboard’s /connect page'); return; }
  console.log(`config: ${cfg.url} · token set · transcripts ${cfg.transcripts ? 'on' : 'off'}`);
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); } catch {}
  console.log(marker && marker.at
    ? `history import: done ${marker.at}`
    : 'history import: pending — runs automatically after your next session ends');
  let res;
  try {
    const r = await post(String(cfg.url).replace(/\/+$/, ''), '/api/records', cfg.token, {}, fetchImpl);
    res = { status: r.status };
  } catch (e) { res = { threw: true, message: e.message }; }
  console.log(`server: ${classifyProbe(res)}`);
}

module.exports = { loadConfig, buildFor, uploadOne, runHook, runBackfill,
  backfillAll, maybeAutoBackfill, runStatus, classifyProbe, CONFIG_PATH, MARKER_PATH };

if (require.main === module) {
  const main = process.argv.includes('--backfill') ? runBackfill
    : process.argv.includes('--status') ? runStatus : runHook;
  main().then(() => process.exit(0)).catch(e => { console.error(`claudium: ${e.message}`); process.exit(0); });
}
