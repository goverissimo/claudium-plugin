// lib/coach-ledger.js — local record of which nudges the coach actually
// showed, per session. This is the missing half of the feedback loop: the
// hub sees the full session record, but only the coach knows a tip was
// DISPLAYED. The ledger rides along when the session record is built
// (`nudges_shown` enum list), so Claudium can measure tip adherence:
// "sessions nudged about fail-streaks recover N% of the time".
//
// JSONL, append-only, ~/.claudium/coach-log.jsonl. Statuslines re-run every
// few seconds, so logNudge dedupes per session+kind within a window.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEDUP_MS = 10 * 60 * 1000;   // same nudge for same session: log 1x/10min
const MAX_READ_BYTES = 2 * 1024 * 1024;

function defaultLedgerPath() {
  return path.join(os.homedir(), '.claudium', 'coach-log.jsonl');
}

function readEntries(file = defaultLedgerPath()) {
  let raw;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
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
function nudgesFor(sessionId, { file = defaultLedgerPath() } = {}) {
  const kinds = [];
  for (const e of readEntries(file)) {
    if (e.session_id === sessionId && e.kind && !kinds.includes(e.kind)) kinds.push(e.kind);
  }
  return kinds;
}

module.exports = { logNudge, nudgesFor, readEntries, defaultLedgerPath, DEDUP_MS };
