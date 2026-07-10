// SPDX-License-Identifier: Apache-2.0
// lib/prompt-quality.js — Tier-0 prompt antipattern detection. Pure, no LLM.
//
// This is the "coach the human" layer: it looks at HOW the user asked, not
// what Claude did. Raw prompt text is read LOCALLY only; what crosses the
// wire is an enum list + one score (see lib/scrub.js PROMPT_ANTIPATTERNS).
//
// Each antipattern is a measurable habit that correlates with worse sessions:
//   vague_goal           first prompt too short/abstract to act on
//   no_success_criteria  nothing checkable — Claude guesses what "done" means
//   missing_context      no file/code referent; Claude burns turns exploring
//   scope_creep          new unrelated asks injected mid-session
//   correction_loop      repeated "no, I meant..." re-steering
//   kitchen_sink         one prompt carrying 3+ distinct asks

const PROMPT_ANTIPATTERNS = [
  'vague_goal', 'no_success_criteria', 'missing_context',
  'scope_creep', 'correction_loop', 'kitchen_sink',
];

const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const IMPERATIVE = /\b(add|make|create|fix|implement|refactor|update|remove|delete|write|build|change|rename|move|deploy|test|install|set ?up|configure|improve|optimize|migrate|convert)\b/i;
const CRITERIA = /\b(should|must|so that|until|make sure|verify|expect|acceptance|passes?|tests? pass|when (?:i|the|a)|criteria|done when|looks? like)\b/i;
const CORRECTIVE = /^(no\b|not\b|nope\b|wrong\b|that'?s (?:not|wrong)|i meant\b|actually[, ]|again\b|still (?:broken|wrong|not))/i;
// A concrete referent grounds the request: a path, code, an error, a URL.
const CONCRETE = /[\\/]|`|\.(js|ts|tsx|jsx|py|rb|go|rs|java|css|html|md|json|sql|sh|yml|yaml)\b|error|exception|line \d|https?:/i;

const words = t => String(t).trim().split(/\s+/).filter(Boolean);

function wordSet(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// Count distinct asks inside one prompt: imperative sentences + numbered items.
function askCount(prompt) {
  const sentences = String(prompt).split(/[.!?\n]+/).filter(s => s.trim());
  const imperatives = sentences.filter(s => IMPERATIVE.test(s)).length;
  const numbered = (String(prompt).match(/^\s*(?:\d+[.)]|[-*])\s+/gm) || []).length;
  return Math.max(imperatives, numbered);
}

// detectPromptAntipatterns(session) -> { antipatterns, promptQualityScore, signals }
// Works from session.promptTexts (human-typed only) + toolCalls structure.
function detectPromptAntipatterns(session) {
  const prompts = (session && session.promptTexts) || [];
  const calls = (session && session.toolCalls) || [];
  const first = prompts[0] || '';
  const antipatterns = [];

  if (!first.trim()) {
    return { antipatterns: [], promptQualityScore: 0.5, signals: { prompts: 0 } };
  }

  const firstWords = words(first);
  const taskLike = IMPERATIVE.test(first);
  const isContinuation = !!(session && session.isContinuation);

  // vague_goal — short AND nothing concrete to anchor on.
  if (firstWords.length < 8 && !CONCRETE.test(first) && !isContinuation) {
    antipatterns.push('vague_goal');
  }

  // no_success_criteria — an implementation ask with nothing checkable.
  if (taskLike && firstWords.length >= 5 && !CRITERIA.test(first)) {
    antipatterns.push('no_success_criteria');
  }

  // missing_context — no concrete referent AND Claude had to explore a lot
  // before its first edit (>= 6 read/search calls).
  let preEditSearches = 0;
  for (const c of calls) {
    if (EDIT_TOOLS.has(c.name)) break;
    if (SEARCH_TOOLS.has(c.name)) preEditSearches++;
  }
  if (taskLike && !CONCRETE.test(first) && preEditSearches >= 6) {
    antipatterns.push('missing_context');
  }

  // correction_loop — repeated re-steering prompts.
  const corrections = prompts.slice(1).filter(p => CORRECTIVE.test(p.trim())).length;
  if (corrections >= 2) antipatterns.push('correction_loop');

  // scope_creep — later prompts that are NEW asks unrelated to the first one.
  const firstSet = wordSet(first);
  const newAsks = prompts.slice(1).filter(p => {
    if (CORRECTIVE.test(p.trim())) return false;
    if (words(p).length < 5) return false;
    return IMPERATIVE.test(p) && jaccard(firstSet, wordSet(p)) < 0.15;
  }).length;
  if (newAsks >= 2) antipatterns.push('scope_creep');

  // kitchen_sink — one prompt carrying many distinct asks.
  if (askCount(first) >= 3 && firstWords.length > 60) antipatterns.push('kitchen_sink');

  const WEIGHTS = {
    vague_goal: 0.25, no_success_criteria: 0.15, missing_context: 0.15,
    scope_creep: 0.15, correction_loop: 0.25, kitchen_sink: 0.10,
  };
  let score = 1;
  for (const a of antipatterns) score -= WEIGHTS[a] || 0.1;
  score = Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));

  return {
    antipatterns,
    promptQualityScore: score,
    signals: { prompts: prompts.length, corrections, newAsks, preEditSearches, firstAsks: askCount(first) },
  };
}

// Human-readable advice per antipattern — used by reports and the coach.
const ANTIPATTERN_ADVICE = {
  vague_goal: 'State what you want changed and where — name the file, feature, or error.',
  no_success_criteria: 'Say what "done" looks like (a passing test, a behavior, an output) so Claude can verify instead of guessing.',
  missing_context: 'Point at the code: paste the error, name the file or function. Claude spent many turns just finding it.',
  scope_creep: 'New unrelated asks mid-session dilute context. Finish the task, then /clear and start the next one fresh.',
  correction_loop: 'Several "no, I meant..." corrections — front-load constraints in the first prompt or use plan mode to agree on an approach first.',
  kitchen_sink: 'One prompt carried several distinct tasks. Split them: sequential focused asks finish faster than one mega-prompt.',
};

module.exports = { detectPromptAntipatterns, PROMPT_ANTIPATTERNS, ANTIPATTERN_ADVICE };
