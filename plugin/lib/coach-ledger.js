// SPDX-License-Identifier: Apache-2.0
// lib/coach-ledger.js — local record of which nudges the coach actually
// showed, per session. This is the missing half of the feedback loop: the
// hub sees the full session record, but only the coach knows a tip was
// DISPLAYED. The ledger rides along when the session record is built
// (`nudges_shown` enum list), so Tokenomica can measure tip adherence:
// "sessions nudged about fail-streaks recover N% of the time".
//
// JSONL, append-only, ~/.tokenomica/coach-log.jsonl. Statuslines re-run every
// few seconds, so logNudge dedupes per session+kind within a window.

const fs = require('fs');
const path = require('path');
const { configDir } = require('./config-dir');

const DEDUP_MS = 10 * 60 * 1000;   // same nudge for same session: log 1x/10min
const MAX_READ_BYTES = 2 * 1024 * 1024;

// Task 15 item 1: classify_cost entries ride this SAME append-only ledger
// file (one local file for "what did the coach show" AND "what did
// classification cost" — /tokenomica:status reads the latter back). This
// reserved kind is NOT a nudge: nudgesFor (below) explicitly excludes it so
// cost bookkeeping can never end up in a session's nudges_shown.
const COST_KIND = 'classify_cost';

// dir is the tokenomica dir the ledger lives in. No dir means the real
// ~/.tokenomica — the shipping default. Callers that operate on an EXPLICIT
// tokenomica dir (hermetic tests with a temp dir; the sender/plugin paths,
// which already thread one for the salt) pass it through so the ledger read
// stays inside that same dir and never touches the real home as a side
// effect (Task 12 hermeticity fix).
function defaultLedgerPath(dir) {
  return path.join(dir || configDir(), 'coach-log.jsonl');
}

function readEntries(file = null, { dir = null } = {}) {
  const target = file || defaultLedgerPath(dir);
  let raw;
  try {
    const st = fs.statSync(target);
    const fd = fs.openSync(target, 'r');
    const start = Math.max(0, st.size - MAX_READ_BYTES);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch { return []; }
  const lines = raw.split('\n').filter(l => l.trim());
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* partial first line after seek */ }
  }
  return out;
}

// logNudge({ sessionId, kind, level, category }) -> true if written.
function logNudge({ sessionId, kind, level, category }, { file = defaultLedgerPath(), nowMs = Date.now() } = {}) {
  if (!sessionId || !kind) return false;
  const entries = readEntries(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.session_id !== sessionId || e.kind !== kind) continue;
    if (nowMs - Date.parse(e.ts) < DEDUP_MS) return false;   // recent duplicate
    break;
  }
  const entry = { ts: new Date(nowMs).toISOString(), session_id: sessionId, kind, level: level || '', category: category || '' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch { return false; }
}

// nudgesFor(sessionId) -> unique kinds shown during that session, in order.
// An explicit file wins; else dir picks the ledger inside that tokenomica dir;
// else the real ~/.tokenomica (unchanged shipping default). classify_cost
// entries (see logClassifyCost below) are deliberately excluded here — this
// function's contract is which NUDGES were shown, not every kind ever
// logged, so cost bookkeeping can never ride along as a nudge.
function nudgesFor(sessionId, { dir = null, file = null } = {}) {
  const kinds = [];
  for (const e of readEntries(file, { dir })) {
    if (e.session_id === sessionId && e.kind && e.kind !== COST_KIND && !kinds.includes(e.kind)) kinds.push(e.kind);
  }
  return kinds;
}

// logClassifyCost({ sessionId, costUsd, classifier, activityCategory, domain })
// -> true if written. Called once per successful NON-deterministic
// classification (classifier !== 'deterministic') by both capture routes
// (plugin/enrich-session.js, lib/usage-pipeline.js's enrichAndRepost) right
// after classify() resolves — a deterministic result costs nothing and is
// never logged here. No dedup window (unlike logNudge): each classification
// is its own real, billable event, not a statusline re-render.
function logClassifyCost({ sessionId, costUsd, classifier, activityCategory, domain },
  { dir = null, file = null, nowMs = Date.now() } = {}) {
  if (!sessionId) return false;
  const target = file || defaultLedgerPath(dir);
  const cost = Number.isFinite(Number(costUsd)) && Number(costUsd) > 0 ? Number(costUsd) : 0;
  const entry = {
    ts: new Date(nowMs).toISOString(), session_id: sessionId, kind: COST_KIND,
    cost_usd: cost, classifier: classifier || '',
    activity_category: activityCategory || '', domain: domain || '',
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(entry) + '\n');
    return true;
  } catch { return false; }
}

// lastClassifyCost({ dir, file }) -> the most recent classify_cost entry
// across the WHOLE ledger (every session, not just one) — /tokenomica:status
// (plugin/upload-session.js's runStatus) wants "the last classification that
// ran", not one scoped to a single session id. null when none logged yet.
function lastClassifyCost({ dir = null, file = null } = {}) {
  const entries = readEntries(file, { dir });
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i] && entries[i].kind === COST_KIND) return entries[i];
  }
  return null;
}

module.exports = { logNudge, nudgesFor, logClassifyCost, lastClassifyCost, readEntries, defaultLedgerPath, DEDUP_MS };
