// SPDX-License-Identifier: Apache-2.0
// lib/phase.js — which development phase each API call belongs to.
//
// The spend pipeline splits a session's tokens across the phases of
// development by what Claude did on each call: its tool calls. Bash is read by
// its verb. Pure; Node built-ins only (this file ships in the plugin).
const PHASES = ['explore', 'plan', 'build', 'verify', 'ship', 'operate', 'think', 'unclear'];
const MAIN_PHASES = PHASES.slice(0, 5);

const TOOL_PHASE = {
  Read: 'explore', Glob: 'explore', Grep: 'explore', LS: 'explore', NotebookRead: 'explore',
  WebSearch: 'explore', WebFetch: 'explore',
  Task: 'plan', Agent: 'plan', TodoWrite: 'plan', EnterPlanMode: 'plan', ExitPlanMode: 'plan',
  Skill: 'plan', AskUserQuestion: 'plan',
  Edit: 'build', MultiEdit: 'build', Write: 'build', NotebookEdit: 'build',
  // Claude Code's own coordination tools: steering agents, tasks, worktrees.
  SendMessage: 'plan', TaskStop: 'plan', ListAgents: 'plan', Monitor: 'plan',
  EnterWorktree: 'plan', ExitWorktree: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan',
  // Looking things up inside Claude Code itself.
  ToolSearch: 'explore', ReadNotifications: 'explore',
  // Reaching outside systems through Claude Code: MCP resources, artifacts,
  // files sent to the person.
  ReadMcpResourceTool: 'operate', ListMcpResourcesTool: 'operate', ReadMcpResourceDirTool: 'operate',
  Artifact: 'operate', SendUserFile: 'operate',
};

// Checked in this order; the first match wins. Anchored rules (^) look at the
// command's verb; unanchored ones match anywhere, so `npm test && git push`
// is a ship and `grep x && npx tsc` is a verify.
const BASH_RULES = [
  ['ship', /(^|[;&|]\s*)(git\s+(-C\s+\S+\s+)?(commit|push|merge|rebase|tag|cherry-pick)\b|gh\s+(pr|release)\b|vercel\b|npm\s+publish\b)|\bdeploy\b|publish/],
  ['verify', /\b(npm\s+(run\s+)?test|jest|vitest|pytest|mocha|playwright|tsc|eslint|lint|xcodebuild|swift\s+(build|test)|next\s+build|npm\s+run\s+build|cargo\s+(test|build)|node\s+--test)\b/],
  ['explore', /^(sed\s+-n|cat\b(?![^|;&]*>)|grep|rg|find|ls|head|tail|wc|jq|awk|tree|less|command\s+grep|git\s+(-C\s+\S+\s+)?(log|show|diff|status|blame))\b/],
  // No trailing \b here: `cat > f` and `python3 - <<EOF` end on symbols, where
  // a word boundary can never match.
  ['build', /^(sed\s+-i|cat\b[^|;&]*>|tee\b|python3?\s+-\s*<<|(mkdir|mv|cp|rm|touch|chmod|patch)\b|git\s+(-C\s+\S+\s+)?(add|checkout|stash|apply)\b)/],
  ['operate', /^(curl|psql|docker|ssh|xcrun|open|claude|npx)\b/],
];

const PREFIX = /^\s*((cd|export|set|umask|source|\.)\b[^;&|]*(&&|;)\s*|[A-Z_][A-Z0-9_]*=\S*\s+)+/;

function bashPhase(command) {
  const c = String(command || '').replace(PREFIX, '').trim();
  if (!c) return 'unclear';
  for (const [phase, re] of BASH_RULES) if (re.test(c)) return phase;
  return 'unclear';
}

function phaseOfTool(name, input) {
  const n = String(name || '');
  if (TOOL_PHASE[n]) return TOOL_PHASE[n];
  if (n === 'Bash') return bashPhase(input && input.command);
  if (n.startsWith('mcp__')) return 'operate';
  return 'unclear';
}

function phasesOfCall(toolUses) {
  const set = new Set();
  for (const t of Array.isArray(toolUses) ? toolUses : []) if (t) set.add(phaseOfTool(t.name, t.input));
  return set.size ? [...set] : ['think'];
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
const MAX_MODELS = 4;

// phaseCosts(calls) -> per phase: calls, ctx_avg (average context per call:
// what was re-sent), and the tokens per model. A call in N phases splits its
// TOKENS 1/N to each, so the totals add up to the session's own counters
// (integer rounding goes to the first phase, so nothing is lost). It counts as
// a whole call in each phase it touched, and its context is its context: a
// call that read and edited re-sent the same history either way.
function phaseCosts(calls) {
  const out = {};
  for (const p of PHASES) out[p] = { calls: 0, ctxSum: 0, models: new Map() };
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c) continue;
    const phases = (Array.isArray(c.phases) && c.phases.length ? c.phases : ['think']).filter(p => out[p]);
    if (!phases.length) continue;
    const ctx = (c.cache_read || 0) + (c.cache_write_5m || 0) + (c.cache_write_1h || 0) + (c.input || 0);
    phases.forEach((p, i) => {
      const o = out[p];
      o.calls += 1;
      o.ctxSum += ctx;
      const model = String(c.model || '');
      const m = o.models.get(model) || Object.fromEntries(TOKEN_KEYS.map(k => [k, 0]));
      for (const k of TOKEN_KEYS) {
        const v = c[k] || 0;
        const share = Math.floor(v / phases.length);
        m[k] += i === 0 ? v - share * (phases.length - 1) : share;
      }
      o.models.set(model, m);
    });
  }
  const res = {};
  for (const p of PHASES) {
    const o = out[p];
    let list = [...o.models].map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => (b.cache_read + b.input + b.output) - (a.cache_read + a.input + a.output));
    if (list.length > MAX_MODELS) {
      // Over the cap: fold the smallest into the largest so no token is lost.
      const keep = list.slice(0, MAX_MODELS);
      for (const extra of list.slice(MAX_MODELS)) for (const k of TOKEN_KEYS) keep[0][k] += extra[k];
      list = keep;
    }
    res[p] = { calls: o.calls, ctx_avg: o.calls ? Math.round(o.ctxSum / o.calls) : 0, by_model: list };
  }
  return res;
}

module.exports = { PHASES, MAIN_PHASES, phaseOfTool, phasesOfCall, bashPhase, phaseCosts, TOKEN_KEYS };

