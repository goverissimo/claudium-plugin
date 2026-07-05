// lib/transcript.js — opt-in redacted transcripts.
//
// buildTranscriptTurns (sender-side): merge a Session's human prompts and
// assistant text blocks into ordered turns, scrubbing every text through
// scrubTranscriptText so secrets/PII never leave the machine.
//
// validateTranscript (hub-side): shape-check an uploaded body. The hub does
// NOT inspect or re-scrub content — redaction is a sender responsibility.

const { scrubTranscriptText } = require('./scrub');

const TURN_TEXT_CAP = 8000;   // chars per turn
const MAX_TURNS = 500;
const ID_MAX = 80;

function buildTranscriptTurns(session) {
  const s = session || {};
  const turns = [];
  const push = (role, ts, raw) => {
    const text = scrubTranscriptText(raw).slice(0, TURN_TEXT_CAP);
    if (text) turns.push({ role, ts: ts || null, text });
  };
  (s.promptTexts || []).forEach((t, i) => push('user', (s.promptTimes || [])[i], t));
  (s.assistantTexts || []).forEach((t, i) => push('assistant', (s.assistantTimes || [])[i], t));
  turns.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return turns.slice(0, MAX_TURNS);
}

const isoOrNull = v => (v == null ? null : (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined));

function validateTranscript(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.claude_session_id || '').slice(0, ID_MAX);
  if (!id) return null;
  if (!Array.isArray(raw.turns) || !raw.turns.length || raw.turns.length > 2000) return null;
  const turns = [];
  for (const t of raw.turns) {
    if (!t || typeof t !== 'object') return null;
    if (t.role !== 'user' && t.role !== 'assistant') return null;
    const ts = isoOrNull(t.ts);
    if (ts === undefined) return null;
    if (typeof t.text !== 'string' || !t.text.trim()) return null;
    turns.push({ role: t.role, ts, text: t.text.slice(0, TURN_TEXT_CAP) });
  }
  return { claude_session_id: id, turns };
}

module.exports = { buildTranscriptTurns, validateTranscript, TURN_TEXT_CAP, MAX_TURNS };
