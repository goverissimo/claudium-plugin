// lib/scrub.js — the privacy gate. Pure, no I/O.
//
// This is the hard boundary: it enforces that a record contains ONLY the
// schema-approved, privacy-safe fields, coerces enums, strips secrets/PII
// from any free-text field, and caps lengths. Anything not in the schema is
// dropped. It runs sender-side before a record is sent AND hub-side before a
// record is persisted (defense in depth — the hub trusts no sender).

const ACTIVITY_CATEGORIES = [
  'debugging', 'feature_implementation', 'refactoring', 'testing', 'code_review',
  'documentation', 'devops_deploy', 'data_analysis', 'research_learning',
  'writing_content', 'planning_design', 'other',
];
const DOMAINS = [
  'frontend', 'backend', 'fullstack', 'infra_devops', 'data_ml',
  'mobile', 'cli_tooling', 'docs_content', 'other',
];
const TECHNIQUES = [
  'plan_mode', 'subagents', 'skills', 'mcp_tools',
  'todo_tracking', 'web_research', 'extended_thinking', 'parallel_tools',
];
const OUTCOMES = ['success', 'partial', 'failed', 'abandoned'];
const FRICTION_REASONS = ['repeated_errors', 'build_test_failures', 'high_rework', 'abandoned_after_error', 'context_thrash', 'long_thinking_low_action', 'tool_denials', 'user_frustration'];
const SATISFACTIONS = ['positive', 'neutral', 'negative', 'unknown'];
const SERVICE_TIERS = ['standard', 'priority', 'batch', 'scale', 'unknown'];
const PROMPT_ANTIPATTERNS = [
  'vague_goal', 'no_success_criteria', 'missing_context',
  'scope_creep', 'correction_loop', 'kitchen_sink',
];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'unknown'];
const COACH_NUDGES = ['fail_streak', 'denials', 'frustration', 'correction_loop', 'rework', 'over_baseline'];

const INTENT_MAX = 120;
const LABEL_MAX = 80;

// Secrets — aggressive on purpose: a false positive only redacts harmless text.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g,                  // OpenAI/Anthropic-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,                        // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,             // Slack
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, // JWT
  /(?:api[_-]?key|secret|token|password|passwd|pwd|bearer|authorization)\s*[:=]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,                         // long hex (hashes/keys)
  /\b[A-Za-z0-9+/_\-]{40,}\b/g,                    // long high-entropy token
];

const PII_PATTERNS = [
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,  // email
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,                       // IPv4
  /\b(?:\+?\d[\d\-\s().]{7,}\d)\b/g,                    // phone-ish
];

const REDACTED = '[redacted]';

function scrubText(input) {
  let out = String(input == null ? '' : input);
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);
  return out.replace(/\s+/g, ' ').trim();
}

// Like scrubText, but for multi-line conversation text: same secret/PII
// patterns, but newlines survive (collapse only runs of spaces/tabs, and
// squeeze 3+ blank lines down to one).
function scrubTranscriptText(input) {
  let out = String(input == null ? '' : input);
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const clampInt = (v, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
};
const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};
const nonNegFloat = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) / 1e6 : 0;
};
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

// enforceRecord(raw) -> a clean record containing ONLY approved fields.
function enforceRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tools = Array.isArray(r.tools_used) ? r.tools_used : [];
  const techs = Array.isArray(r.techniques) ? r.techniques : [];
  return {
    claude_session_id: String(r.claude_session_id || '').slice(0, 80),
    project_label: scrubText(r.project_label).slice(0, LABEL_MAX),
    started_at: isoOrNull(r.started_at),
    ended_at: isoOrNull(r.ended_at),
    duration_s: clampInt(r.duration_s),
    turn_count: clampInt(r.turn_count),
    token_total: clampInt(r.token_total),
    activity_category: oneOf(r.activity_category, ACTIVITY_CATEGORIES, 'other'),
    domain: oneOf(r.domain, DOMAINS, 'other'),
    intent_summary: scrubText(r.intent_summary).slice(0, INTENT_MAX),
    tools_used: tools.filter(t => typeof t === 'string').map(t => t.slice(0, 80)).slice(0, 50),
    techniques: techs.filter(t => TECHNIQUES.includes(t)),
    error_rate: clamp01(r.error_rate),
    rework_score: clamp01(r.rework_score),
    friction_score: clamp01(r.friction_score),
    outcome: oneOf(r.outcome, OUTCOMES, 'partial'),
    outcome_score: clamp01(r.outcome_score),
    friction_reasons: (Array.isArray(r.friction_reasons) ? r.friction_reasons : []).filter(x => FRICTION_REASONS.includes(x)),
    satisfaction: oneOf(r.satisfaction, SATISFACTIONS, 'unknown'),
    // Token economics + deterministic outcomes (numeric/enum only — no raw content).
    input_tokens: clampInt(r.input_tokens),
    cache_read_tokens: clampInt(r.cache_read_tokens),
    cache_creation_tokens: clampInt(r.cache_creation_tokens),
    cache_hit_ratio: clamp01(r.cache_hit_ratio),
    est_cost_usd: nonNegFloat(r.est_cost_usd),
    service_tier: oneOf(r.service_tier, SERVICE_TIERS, 'unknown'),
    lines_added: clampInt(r.lines_added),
    lines_removed: clampInt(r.lines_removed),
    commits: clampInt(r.commits),
    user_edit_rate: clamp01(r.user_edit_rate),
    model: String(r.model || '').slice(0, 60),
    // Human-disagreement + frustration signals (numeric only).
    denials: clampInt(r.denials, 1000),
    denial_rate: clamp01(r.denial_rate),
    interruptions: clampInt(r.interruptions, 1000),
    frustration_score: clamp01(r.frustration_score),
    // Prompt quality (enum + score only — never the prompt text).
    prompt_antipatterns: (Array.isArray(r.prompt_antipatterns) ? r.prompt_antipatterns : [])
      .filter(x => PROMPT_ANTIPATTERNS.includes(x)),
    prompt_quality: clamp01(r.prompt_quality),
    // Task threading inputs.
    is_continuation: !!r.is_continuation,
    compactions: clampInt(r.compactions, 1000),
    // Orchestration shape.
    subagent_types: (Array.isArray(r.subagent_types) ? r.subagent_types : [])
      .filter(t => typeof t === 'string').map(t => scrubText(t).slice(0, 60)).slice(0, 10),
    max_parallel_tools: clampInt(r.max_parallel_tools, 100),
    permission_mode: oneOf(r.permission_mode, PERMISSION_MODES, 'unknown'),
    // Coach feedback loop: which live tips were SHOWN this session (enums).
    nudges_shown: (Array.isArray(r.nudges_shown) ? r.nudges_shown : [])
      .filter(x => COACH_NUDGES.includes(x)),
    // Git ground truth (sender-computed numbers; no paths/messages).
    git_analyzed: !!r.git_analyzed,
    survival_rate: clamp01(r.survival_rate),
    lines_surviving: clampInt(r.lines_surviving),
    reverts: clampInt(r.reverts, 1000),
    schema_version: 3,
  };
}

module.exports = {
  scrubText, scrubTranscriptText, enforceRecord,
  ACTIVITY_CATEGORIES, DOMAINS, TECHNIQUES, OUTCOMES,
  SECRET_PATTERNS, PII_PATTERNS, INTENT_MAX, FRICTION_REASONS, SATISFACTIONS, SERVICE_TIERS,
  PROMPT_ANTIPATTERNS, PERMISSION_MODES, COACH_NUDGES,
};
