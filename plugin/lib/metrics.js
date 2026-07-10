// SPDX-License-Identifier: Apache-2.0
// lib/metrics.js — Tier-0 deterministic metrics from a Session. Pure.
//
// Everything here is derived from transcript STRUCTURE (counts, errors,
// sequence) — never from the meaning of the code. So it carries zero
// privacy risk and runs for free, no LLM. This is where most of "what
// results are they getting" comes from.
//
// The formulas are heuristic v1 — tune the weights against real sessions.

const { estimateCost } = require('./pricing');

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const TEST_PASS = /✓|\b(\d+\s+(?:passing|passed)|tests?\s+passed|build succeeded|all checks passed|0\s+failing)\b/i;
const TEST_FAIL = /✗|\b([1-9]\d*\s+(?:failing|failed)|tests?\s+failed|build failed|compilation error|command not found|segmentation fault)\b/i;

const clamp01 = n => Math.max(0, Math.min(1, n));
const round3 = n => Math.round(n * 1000) / 1000;

function detectTechniques(session) {
  const t = [];
  const used = session.toolsUsed || [];
  const has = n => used.includes(n);
  if (has('ExitPlanMode') || has('exit_plan_mode')) t.push('plan_mode');
  if (has('Task') || has('Agent')) t.push('subagents');   // tool renamed Task->Agent
  if (has('SlashCommand') || has('Skill')) t.push('skills');
  if (used.some(n => typeof n === 'string' && n.startsWith('mcp__'))) t.push('mcp_tools');
  if (has('TodoWrite') || has('TaskCreate') || has('TaskUpdate')) t.push('todo_tracking');
  if (has('WebSearch') || has('WebFetch')) t.push('web_research');
  if ((session.thinkingChars || 0) > 200 || (session.thinkingBlocks || 0) >= 3) t.push('extended_thinking');
  if ((session.maxParallelTools || 0) >= 2) t.push('parallel_tools');
  return t;
}

// --- Frustration: deterministic signals that the HUMAN is fighting the tool.
// Each is cheap and structural; none requires understanding the code.

const FRUSTRATION_WORDS = /\b(wtf|ffs|seriously|i (?:already )?(?:said|told you)|again\?|stop doing|why (?:do|did|are) you|no[,.!]+ (?:i|that)|listen)\b/i;

function wordSet(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// repeated near-identical consecutive prompts = the user re-asking because
// Claude didn't get it. Returns the number of such repeats.
function repeatedPromptCount(prompts) {
  let repeats = 0;
  for (let i = 1; i < prompts.length; i++) {
    const prev = prompts[i - 1], cur = prompts[i];
    if (cur.length < 12 || prev.length < 12) continue;
    if (jaccard(wordSet(prev), wordSet(cur)) >= 0.6) repeats++;
  }
  return repeats;
}

function frustrationSignals(session) {
  const prompts = session.promptTexts || [];
  const repeats = repeatedPromptCount(prompts);
  const sweary = prompts.filter(p => FRUSTRATION_WORDS.test(p)).length;
  const shouting = prompts.filter(p => {
    const letters = p.replace(/[^A-Za-z]/g, '');
    return letters.length >= 12 && letters === letters.toUpperCase();
  }).length;
  const interruptions = session.interruptions || 0;
  const denials = session.denials || 0;
  const score = clamp01(
    0.30 * Math.min(1, repeats / 2) +
    0.25 * Math.min(1, sweary / 2) +
    0.15 * Math.min(1, shouting) +
    0.15 * Math.min(1, interruptions / 2) +
    0.15 * Math.min(1, denials / 2)
  );
  return { repeats, sweary, shouting, score: round3(score) };
}

function reworkScore(session) {
  const counts = new Map();
  for (const c of session.toolCalls || []) {
    if (EDIT_TOOLS.has(c.name) && c.filePath) {
      counts.set(c.filePath, (counts.get(c.filePath) || 0) + 1);
    }
  }
  let maxEdits = 0;
  for (const v of counts.values()) if (v > maxEdits) maxEdits = v;
  // 2 edits to one file is normal iteration; 7+ is churn.
  return clamp01((maxEdits - 2) / 5);
}

// The LAST test/build signal wins: failing early then passing at the end is
// the normal shape of a healthy session, not a failure.
function scanOutcomeText(session) {
  let state = null;            // 'pass' | 'fail' | null
  let everFailed = false;
  for (const r of session.toolResults || []) {
    const fail = r.isError || TEST_FAIL.test(r.text);
    const pass = TEST_PASS.test(r.text);
    if (fail) { state = 'fail'; everFailed = true; }
    if (pass && !fail) state = 'pass';
  }
  return { testsPassed: state === 'pass', testsFailed: state === 'fail', everFailed };
}

// last "meaningful" event (ignore thinking) — used for abandonment + summary.
function lastMeaningful(session) {
  const ev = session.events || [];
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].kind !== 'thinking') return ev[i];
  }
  return null;
}

const NEG_SENTIMENT = /\b(wrong|broke|broken|still (?:not|failing|fails|broken)|does ?n'?t work|not working|revert|undo|that'?s not it|nope)\b/i;
const POS_SENTIMENT = /\b(thanks|thank you|perfect|great|works now|it works|nice work|awesome|exactly|lgtm|ship it)\b/i;

function detectSatisfaction(session, frustration) {
  // Strong structural negatives first: a frustrated human is dissatisfied
  // whether or not they said "thanks" earlier.
  if (frustration && frustration.score >= 0.5) return 'negative';
  const texts = (session.userTexts || []).slice(-2).join(' ');
  if (!texts) return 'unknown';
  if (NEG_SENTIMENT.test(texts)) return 'negative';
  if (POS_SENTIMENT.test(texts)) return 'positive';
  if ((session.denials || 0) >= 2 || (session.interruptions || 0) >= 2) return 'negative';
  return 'neutral';
}

function frictionReasons(session, ctx) {
  const reasons = [];
  if (ctx.errorResults >= 3 && ctx.errFactor >= 0.6) reasons.push('repeated_errors');
  if (ctx.testsFailed) reasons.push('build_test_failures');
  if (ctx.rework >= 0.5) reasons.push('high_rework');
  if (ctx.outcome === 'abandoned') reasons.push('abandoned_after_error');
  if ((session.denials || 0) >= 2) reasons.push('tool_denials');
  if (ctx.frustration && ctx.frustration.score >= 0.5) reasons.push('user_frustration');
  const reads = {};
  for (const c of session.toolCalls || []) {
    if ((c.name === 'Read' || c.name === 'NotebookRead') && c.filePath) reads[c.filePath] = (reads[c.filePath] || 0) + 1;
  }
  if (Object.values(reads).some(v => v >= 4)) reasons.push('context_thrash');
  if ((session.thinkingChars || 0) > 3000 && (session.toolCalls || []).length < 3) reasons.push('long_thinking_low_action');
  return reasons;
}

function computeMetrics(session) {
  const totalCalls = (session.toolCalls || []).length;
  const results = session.toolResults || [];
  const errorResults = results.filter(r => r.isError).length;
  const denom = results.length || totalCalls || 1;
  const errorRate = clamp01(errorResults / denom);
  const rework = reworkScore(session);
  const frustration = frustrationSignals(session);
  const denials = session.denials || 0;
  const denialRate = clamp01(denials / denom);
  const { testsPassed, testsFailed, everFailed } = scanOutcomeText(session);
  // Error pressure as a RATE, not an absolute count — a 300-turn agentic
  // session with 5 errors is healthier than a 6-turn session with 3.
  const errFactor = Math.min(1, errorResults / Math.max(3, results.length * 0.15));
  const last = lastMeaningful(session);
  const endsWithSummary = !!last && last.kind === 'text';
  const abandoned = (!!last && last.kind === 'tool_result' && last.isError)
    || (session.turnCount <= 1 && errorResults > 0 && !testsPassed);

  // Deterministic outcome signals from structured tool results.
  const commits = session.commits || 0;
  const shipped = commits > 0 || !!session.pushed;
  const editResults = session.editResults || 0;
  const userEditRate = editResults > 0 ? clamp01((session.userModifiedEdits || 0) / editResults) : 0;
  const interruptions = session.interruptions || 0;
  const satisfaction = detectSatisfaction(session, frustration);

  let score = 0.5;
  if (testsPassed && !testsFailed) score += 0.20;
  if (endsWithSummary) score += 0.10;
  if (shipped) score += 0.10;            // Claude landed a commit/push = real result
  score -= 0.30 * errorRate;
  score -= 0.15 * rework;
  score -= 0.15 * errFactor;
  score -= 0.15 * userEditRate;          // the human hand-fixed Claude's edits
  score -= 0.10 * Math.min(1, denials / 2);   // the human vetoed Claude's plan
  score -= 0.10 * frustration.score;          // the human was fighting the tool
  score = clamp01(score);

  // 'partial' must mean genuinely MIXED evidence, not the absence of any
  // evidence. With none of the signals below, score sits at its neutral
  // base (0.5, or 0.6 with only endsWithSummary) purely by construction —
  // that band is a fallthrough, not a verdict. Route it to 'unknown'
  // instead so 'partial' stays meaningful. (endsWithSummary/shipped-via-
  // score-boost-only cases aside, every real deduction/boost above is tied
  // to one of these signals, so 'failed'/'success' can never be reached
  // with hasEvidence === false.)
  const hasEvidence = errorResults > 0 || testsPassed || testsFailed
    || rework > 0 || shipped || userEditRate > 0
    || denials > 0 || interruptions > 0 || frustration.score > 0
    || satisfaction === 'positive' || satisfaction === 'negative';

  let outcome;
  if (abandoned) outcome = 'abandoned';
  else if (score < 0.45) outcome = 'failed';
  else if (score < 0.75) outcome = hasEvidence ? 'partial' : 'unknown';
  else outcome = 'success';

  const frictionScore = clamp01(
    0.40 * errorRate +
    0.25 * errFactor +
    0.15 * rework +
    0.20 * frustration.score
  );

  // Token economics (cost is an estimate — see lib/pricing.js).
  const cacheDenom = (session.cacheReadTokens || 0) + (session.cacheCreationTokens || 0);
  const cacheHitRatio = cacheDenom > 0 ? (session.cacheReadTokens || 0) / cacheDenom : 0;
  const estCostUsd = estimateCost({
    model: session.model,
    inputTokens: session.inputTokens || 0,
    outputTokens: session.outputTokens != null ? session.outputTokens : (session.tokenTotal || 0),
    cacheReadTokens: session.cacheReadTokens || 0,
    cacheCreationTokens: session.cacheCreationTokens || 0,
  });

  return {
    errorRate: round3(errorRate),
    reworkScore: round3(rework),
    frictionScore: round3(frictionScore),
    retryLoops: errorResults, // proxy: each error usually triggers a retry
    testsPassed,
    testsFailed,
    techniques: detectTechniques(session),
    outcome,
    outcomeScore: round3(score),
    frictionReasons: frictionReasons(session, { errorResults, errFactor, testsFailed, rework, outcome, frustration }),
    satisfaction,
    denials,
    denialRate: round3(denialRate),
    interruptions,
    frustrationScore: frustration.score,
    cacheHitRatio: round3(cacheHitRatio),
    estCostUsd,
    linesAdded: session.linesAdded || 0,
    linesRemoved: session.linesRemoved || 0,
    commits,
    userEditRate: round3(userEditRate),
  };
}

module.exports = { computeMetrics, detectTechniques, reworkScore, frustrationSignals, repeatedPromptCount, EDIT_TOOLS };
