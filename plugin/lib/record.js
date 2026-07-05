// lib/record.js — assembles + validates the privacy-safe usage_record.
//
// buildRecord (sender-side): combine a Session, its Tier-0 metrics, and the
// Tier-1 abstraction into the record that gets shipped — then run it through
// the scrub gate so only approved fields leave the machine.
//
// validateRecord (hub-side): the hub trusts nothing. It re-runs the same gate
// on any inbound record and rejects ones missing required identity/time.
//
// The OUTCOME is taken from the DETERMINISTIC metrics, not the LLM — error
// counts and test results are firmer ground than a model's guess. The LLM
// supplies only category/domain/intent.

const { computeMetrics } = require('./metrics');
const { enforceRecord } = require('./scrub');
const { detectPromptAntipatterns } = require('./prompt-quality');

// gitTruth is optional: the output of lib/git-truth.js analyzeGitTruth(),
// computed sender-side where the repo exists. coachNudges is the list of
// live-coach tips shown during this session (lib/coach-ledger.js).
function buildRecord({ session, metrics, abstraction = {}, gitTruth = null, coachNudges = [] }) {
  const m = metrics || computeMetrics(session);
  const pq = detectPromptAntipatterns(session);
  return enforceRecord({
    claude_session_id: session.claudeSessionId,
    project_label: session.projectLabel,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    duration_s: session.durationS,
    turn_count: session.turnCount,
    token_total: session.tokenTotal,
    activity_category: abstraction.activity_category,
    domain: abstraction.domain,
    intent_summary: abstraction.intent_summary,
    tools_used: session.toolsUsed,
    techniques: m.techniques,
    error_rate: m.errorRate,
    rework_score: m.reworkScore,
    friction_score: m.frictionScore,
    outcome: m.outcome,
    outcome_score: m.outcomeScore,
    friction_reasons: m.frictionReasons,
    satisfaction: m.satisfaction,
    // token economics (sender-side counts) + deterministic outcomes
    input_tokens: session.inputTokens,
    cache_read_tokens: session.cacheReadTokens,
    cache_creation_tokens: session.cacheCreationTokens,
    cache_hit_ratio: m.cacheHitRatio,
    est_cost_usd: m.estCostUsd,
    service_tier: session.serviceTier,
    lines_added: m.linesAdded,
    lines_removed: m.linesRemoved,
    commits: m.commits,
    user_edit_rate: m.userEditRate,
    model: abstraction.model || session.model,
    // human-disagreement + frustration
    denials: m.denials,
    denial_rate: m.denialRate,
    interruptions: m.interruptions,
    frustration_score: m.frustrationScore,
    // prompt quality (enums + score only)
    prompt_antipatterns: pq.antipatterns,
    prompt_quality: pq.promptQualityScore,
    // threading + orchestration
    is_continuation: session.isContinuation,
    compactions: session.compactions,
    subagent_types: session.subagentTypes,
    max_parallel_tools: session.maxParallelTools,
    permission_mode: session.permissionMode,
    // coach feedback loop
    nudges_shown: coachNudges,
    // git ground truth (numbers only)
    git_analyzed: !!(gitTruth && gitTruth.analyzed),
    survival_rate: gitTruth ? gitTruth.survivalRate : 0,
    lines_surviving: gitTruth ? gitTruth.linesSurviving : 0,
    reverts: gitTruth ? gitTruth.reverts : 0,
  });
}

function validateRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = enforceRecord(raw);
  if (!rec.claude_session_id) return null;
  if (!rec.started_at) return null;
  return rec;
}

module.exports = { buildRecord, validateRecord };
