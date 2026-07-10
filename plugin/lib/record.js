// SPDX-License-Identifier: Apache-2.0
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
// supplies only category/domain. intent_summary is NOT read from the
// abstraction at all: enforceRecord (lib/scrub.js) machine-composes it as
// `${activity_category} · ${domain}` from THIS record's own final enum
// values (A3) — the LLM's own rich sentence (abstraction.local_intent, see
// lib/extract.js) stays local and never reaches the shipped record.

const { computeMetrics } = require('./metrics');
const { enforceRecord, enforceRecordDetailed, REGION_TAXONOMY } = require('./scrub');
const { detectPromptAntipatterns } = require('./prompt-quality');
const { hmac12, sanitizeLabel } = require('./anonymize');
const { toolToRegion } = require('./regions');

// Turns the raw, filesystem-derived project label into the value that's safe
// to SHIP: a sanitized user-assigned override if one is configured for this
// derived name, else a stable per-machine HMAC pseudonym 'p-<12hex>'. Raw
// path-derived text never ships once a salt is present.
//
// With NO salt (the default — pure/test contexts and the LOCAL-only tools
// scripts/usage-report.js, scripts/usage-tui.js, scripts/demo-insights.js,
// which never pass one), the derived name is SANITIZED, not hashed:
// 'MyClient Corp' -> 'myclient-corp' — still human-readable for local
// display, but also conformant to enforceRecord's shape gate, so
// non-canonical derived names don't blank out locally.
function shipProjectLabel(rawLabel, salt, projectLabels) {
  if (!salt) return sanitizeLabel(rawLabel);
  const assigned = projectLabels && typeof projectLabels === 'object' ? projectLabels[rawLabel] : null;
  return sanitizeLabel(assigned) || ('p-' + hmac12(salt, rawLabel));
}

// A2/A5: MCP tool names (session.toolsUsed entries starting 'mcp__') and
// subagent types (session.subagentTypes) are potentially-identifying —
// server/org-specific names, not a small enum like the built-in tools. They
// never ship raw. This is the ONE place that splits/hashes them, right
// before enforceRecord's shape gate — enforceRecord itself stays pure and
// only re-validates the shape (defense in depth), it never hashes.
//
// mcp_tool_count always ships (a bare count carries no identity). The NAMES
// only ship as hmac12(salt, name) when a salt is available; with no salt
// (pure/test contexts, and any local-only caller that never opts into
// pseudonymization) they are dropped entirely — fail closed, never raw.
// mcpToolCount is the count of DISTINCT names (toolsUsed is already deduped
// by sessionize), so it may exceed mcpToolHashes.length once scrub.js caps
// mcp_tool_hashes at 20 entries.
function splitMcpTools(toolsUsed, salt) {
  const names = Array.isArray(toolsUsed) ? toolsUsed : [];
  const nonMcp = [];
  const mcpNames = [];
  for (const n of names) {
    if (typeof n !== 'string') continue;
    (n.startsWith('mcp__') ? mcpNames : nonMcp).push(n);
  }
  return {
    toolsUsed: nonMcp,
    mcpToolCount: mcpNames.length,
    mcpToolHashes: salt ? mcpNames.map(n => hmac12(salt, n)) : [],
  };
}

// Same treatment as splitMcpTools, for subagent_type values: hashed when a
// salt is available, dropped entirely (empty array — no count field exists
// for subagents) when it isn't.
function shipSubagentTypes(subagentTypes, salt) {
  if (!salt) return [];
  const types = Array.isArray(subagentTypes) ? subagentTypes : [];
  return types.filter(t => typeof t === 'string').map(t => hmac12(salt, t));
}

// D2: derives per-region tool-call counts (region_counts) by mapping each
// tool CALL through lib/regions.js's toolToRegion. Prefers TRUE per-call
// granularity via session.toolCalls (lib/sessionize.js pushes one entry per
// tool_use block, never deduped — so 3 Read calls count as 3, not 1). Falls
// back to session.toolsUsed (already deduped by sessionize) — counting each
// DISTINCT tool name once — only when toolCalls isn't present at all, e.g. a
// hand-built session object from an older/test caller. That fallback
// undercounts repeated tool use, but it's the best signal available without
// per-call data; enforceRecord's region_counts gate zero-fills/clamps
// regardless, so this never produces a malformed record.
function regionCounts(session) {
  const names = Array.isArray(session.toolCalls) && session.toolCalls.length
    ? session.toolCalls.map(c => c && c.name)
    : (Array.isArray(session.toolsUsed) ? session.toolsUsed : []);
  const counts = {};
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    const region = toolToRegion(name);
    counts[region] = (counts[region] || 0) + 1;
  }
  return counts;
}

// gitTruth is optional: the output of lib/git-truth.js analyzeGitTruth(),
// computed sender-side where the repo exists. coachNudges is the list of
// live-coach tips shown during this session (lib/coach-ledger.js). salt +
// projectLabels are the sender/plugin paths' pseudonymization inputs (see
// shipProjectLabel above) — omit both for the readable local label.
//
// shipFacts (Task 24/G3, default true — see lib/sharing-tiers.js's tier
// table): the ONE choke point, shared by both the sender pipeline
// (lib/usage-pipeline.js) and the plugin route (plugin/upload-session.js,
// plugin/enrich-session.js), that enforces the 'metrics' tier's "facts
// stripped" rule. classify() may still run and produce abstraction.facts —
// activity_category/domain/classifier/cost still ship regardless — this
// flag ONLY decides whether session_facts itself is forced to [] before the
// record leaves the machine. Default true preserves every existing caller's
// behavior (today's default tier is 'full', which ships facts).
function buildRecord({ session, metrics, abstraction = {}, gitTruth = null, coachNudges = [], salt = null, projectLabels = null, shipFacts = true }) {
  const m = metrics || computeMetrics(session);
  const pq = detectPromptAntipatterns(session);
  const { toolsUsed, mcpToolCount, mcpToolHashes } = splitMcpTools(session.toolsUsed, salt);
  return enforceRecord({
    claude_session_id: session.claudeSessionId,
    project_label: shipProjectLabel(session.projectLabel, salt, projectLabels),
    started_at: session.startedAt,
    ended_at: session.endedAt,
    duration_s: session.durationS,
    turn_count: session.turnCount,
    token_total: session.tokenTotal,
    activity_category: abstraction.activity_category,
    domain: abstraction.domain,
    // intent_summary deliberately omitted: enforceRecord composes it from the
    // activity_category/domain above (see the file-header comment / A3).
    tools_used: toolsUsed,
    mcp_tool_count: mcpToolCount,
    mcp_tool_hashes: mcpToolHashes,
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
    model: session.model || abstraction.model,
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
    subagent_types: shipSubagentTypes(session.subagentTypes, salt),
    max_parallel_tools: session.maxParallelTools,
    permission_mode: session.permissionMode,
    // coach feedback loop
    nudges_shown: coachNudges,
    // git ground truth (numbers only)
    git_analyzed: !!(gitTruth && gitTruth.analyzed),
    survival_rate: gitTruth ? gitTruth.survivalRate : 0,
    lines_surviving: gitTruth ? gitTruth.linesSurviving : 0,
    reverts: gitTruth ? gitTruth.reverts : 0,
    // A7/D2: classification provenance + versioned region profile.
    // classifier/extractor_version come from the abstraction (lib/extract.js
    // stamps both on every path — API success and deterministic fallback
    // alike); a stale caller that never set them fails closed via
    // enforceRecord's own defaults ('deterministic' / '').
    classifier: abstraction.classifier,
    extractor_version: abstraction.extractor_version,
    // Only tier that exists today (see lib/scrub.js TRUST_TIERS) — every
    // signal here is self-reported by the sender's own machine.
    trust_tier: 'self_reported',
    // Task 14 (C5/C6): the enrichment re-POST's classify() result carries a
    // real cost_usd (haiku_headless: the CLI's own total_cost_usd; haiku_api:
    // currently always 0, see lib/classify-headless.js's file header) — pass
    // it through here. A stale/deterministic-only caller with no cost_usd at
    // all (the immediate build, every backfill record) falls through to 0,
    // same as before; enforceRecord's own gate re-clamps regardless.
    classify_cost_usd: abstraction.cost_usd || 0,
    // D1a (Task 16): reduce-grade session facts, produced by the SAME
    // classify() spawn as classifier/extractor_version above (one spawn, one
    // cost — see lib/classify-headless.js). A stale/deterministic-only
    // caller with no facts at all (the immediate build, every backfill
    // record) falls through to enforceRecord's own [] default. Task 24/G3:
    // shipFacts === false (tier 'metrics') forces this to [] regardless of
    // what classify() produced — see the shipFacts param comment above.
    session_facts: shipFacts ? (abstraction.facts || []) : [],
    region_counts: regionCounts(session),
    region_taxonomy: REGION_TAXONOMY,
    // This build of the sender always emits schema v4.
    schema_version: 4,
  });
}

function validateRecord(raw) {
  const v = validateRecordDetailed(raw);
  return v ? v.record : null;
}

// Task 9 (hub ingest coercion telemetry): same trust-nothing validation as
// validateRecord, but also surfaces enforceRecordDetailed's per-field
// coercion list so the hub can flag a sender sending mostly-garbage records
// (lib/usage-api.js's POST /api/records path) without ever rejecting a
// record for coercions alone — only missing identity/time still rejects.
function validateRecordDetailed(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { record, coerced } = enforceRecordDetailed(raw);
  if (!record.claude_session_id) return null;
  if (!record.started_at) return null;
  return { record, coerced };
}

module.exports = { buildRecord, validateRecord, validateRecordDetailed };
