// SPDX-License-Identifier: Apache-2.0
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
const OUTCOMES = ['success', 'partial', 'failed', 'abandoned', 'unknown'];
const FRICTION_REASONS = ['repeated_errors', 'build_test_failures', 'high_rework', 'abandoned_after_error', 'context_thrash', 'long_thinking_low_action', 'tool_denials', 'user_frustration'];
const SATISFACTIONS = ['positive', 'neutral', 'negative', 'unknown'];
const SERVICE_TIERS = ['standard', 'priority', 'batch', 'scale', 'unknown'];
const PROMPT_ANTIPATTERNS = [
  'vague_goal', 'no_success_criteria', 'missing_context',
  'scope_creep', 'correction_loop', 'kitchen_sink',
];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'unknown'];
const COACH_NUDGES = ['fail_streak', 'denials', 'frustration', 'correction_loop', 'rework', 'over_baseline'];

// A7/D2: which mechanism produced activity_category/domain for this record.
// 'haiku_headless' is stamped by PR2's local headless-model module (not built
// yet — the enum is just ready for it); 'haiku_api' is lib/extract.js's live
// Anthropic API path; 'deterministic' is the no-key/no-network tool-mix
// fallback (lib/extract.js's fallbackAbstraction) — also the fail-closed
// default here, since "we don't actually know" must never look like a model
// classified it.
const CLASSIFIERS = ['haiku_headless', 'haiku_api', 'deterministic'];
// How the record's signals were obtained. Only one tier exists today — every
// current field is self-reported by the sender's own machine, never
// independently verified. Future tiers (e.g. org-audited) arrive later.
const TRUST_TIERS = ['self_reported'];

// D1a (Task 16): the fixed vocabulary session_facts' `k` must belong to. The
// ONLY producer is lib/classify-headless.js's classify() call (sender-side,
// same single headless/API spawn that already produces
// activity_category/domain — no second model call) — it imports this list
// from here exactly like it already imports ACTIVITY_CATEGORIES/DOMAINS.
// Chosen to mirror what insights/llm-analyze.js's server-side reduce stage
// (MEMBER_PROMPT/TEAM_PROMPT) actually consumes from the old
// verdict/what_worked/what_failed/skills_observed/tools_prominent/
// prompting_notes/friction_moments shape, flattened into one value per key:
//   goal          — what the user was trying to accomplish this session
//   approach      — the technique/strategy used to pursue it
//   blocker       — what got in the way (friction/failure)
//   resolution    — how the session concluded
//   learning      — a takeaway or technique worth noting
//   verdict       — a short win/partial/loss-style read on the session
//   tool_highlight — a notably useful tool/capability observed
//   risk          — a quality/caution flag (e.g. rushed, untested)
const FACT_KEYS = [
  'goal', 'approach', 'blocker', 'resolution',
  'learning', 'verdict', 'tool_highlight', 'risk',
];

// Region taxonomy version stamp (D2): a fixed literal, not a real enum — no
// other value survives the gate. This isn't user input to validate so much
// as an assertion of which schema this record's region_counts keys belong
// to; bumping it is a deliberate schema change to this constant, never
// something a sender can opt into by sending a different string.
const REGION_TAXONOMY = 'functional-8.v1';

// Mirrors lib/regions.js's REGION_KEYS (the functional-8.v1 taxonomy)
// exactly. scrub.js must stay import-free (see file header), so this list is
// duplicated here rather than imported — keep both in sync if the region
// taxonomy version ever changes.
const REGION_KEYS = [
  'prefrontal', 'motor', 'parietal', 'visual',
  'broca', 'wernicke', 'temporal', 'cerebellum',
];

// tools_used is a FIXED enum (A2): every real Claude Code built-in tool name,
// plus 'other_tool' as the catch-all for anything else (local/custom tools —
// MCP tool names are split out upstream in lib/record.js and never reach
// this list at all; see mcp_tool_count/mcp_tool_hashes below). This is the
// exact list from the spec — do not add to it casually; a new built-in tool
// ships as 'other_tool' until this enum is deliberately updated.
const BUILTIN_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'Glob', 'Grep', 'LS', 'Bash', 'BashOutput', 'KillShell', 'KillBash',
  'SlashCommand', 'Skill', 'Task', 'TodoWrite', 'TodoRead',
  'ExitPlanMode', 'EnterPlanMode', 'WebSearch', 'WebFetch',
  'AskUserQuestion', 'StructuredOutput', 'Agent', 'other_tool',
];

// A stable per-machine HMAC pseudonym shape (see lib/anonymize.js's hmac12):
// exactly 12 lowercase hex chars. Used to gate mcp_tool_hashes and
// subagent_types — neither field may ever carry a raw name/type string.
const HASH12_RE = /^[a-f0-9]{12}$/;

// A3: intent_summary ships ONLY as this fixed template — never free text.
// Shape: the record's own two post-coercion enum tokens joined by ' · '
// (space + U+00B7 MIDDLE DOT + space). enforceRecord ALWAYS recomposes it
// from the record's own activity_category/domain and ignores any inbound
// value outright — so even a well-formed pair that disagrees with this
// record's own enums (hostile/non-standard sender) can never survive the
// gate. buildRecord never forwards a pre-formed value, so no legitimate
// sender loses anything.
const composeIntentSummary = (category, domain) => `${category} · ${domain}`;

// project_label ships ONLY as an HMAC pseudonym ('p-' + 12 hex chars, see
// lib/anonymize.js's hmac12) or a sanitized user-assigned label (lowercase
// alnum/._-, <=40 chars, must start alphanumeric) — never raw, path-derived
// text. Hashing/sanitizing happens upstream in record assembly (lib/record.js);
// this gate just enforces the shape and rejects anything else to ''.
const PROJECT_LABEL_RE = /^(p-[a-f0-9]{12}|[a-z0-9][a-z0-9._-]{0,39})$/;

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
  // Bare hex, 12+ chars (review fix, Task 16 Important 2a): was {32,}, which
  // let 12-31 char hex tokens (short hashes, trace/session ids) ship verbatim
  // through any scrubbed free-text surface. Lowered, not added-alongside —
  // {12,} strictly subsumes the old {32,}. Verified no legitimate SHIPPED
  // value is produced BY scrubbing: our own hash12/p-label/session-id values
  // are computed sender-side and placed on the record directly, never routed
  // through scrubText. English words can't false-positive (12+ chars all in
  // [a-f0-9] doesn't occur in prose); a redacted harmless hex is the
  // aggressive-on-purpose trade this whole table already makes.
  /\b[A-Fa-f0-9]{12,}\b/g,
  /\b[A-Za-z0-9+/_\-]{40,}\b/g,                    // long high-entropy token
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,   // Stripe-style keys (sk_/pk_/rk_ live/test)
  /\bASIA[0-9A-Z]{12,}\b/g,                        // AWS temporary access key id
  /\bglpat-[A-Za-z0-9_\-]{16,}\b/g,                // GitLab personal access token
];

const PII_PATTERNS = [
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,  // email
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,                       // IPv4
  /\b(?:\+?\d[\d\-\s().]{7,}\d)\b/g,                    // phone-ish
  /\bhttps?:\/\/[^\s"'<>]+/g,                           // URLs
  /(?:\/(?:Users|home|root|var|etc|opt|srv|tmp|private)\/[^\s:"'<>]+)/g, // Unix filesystem paths
  /\b[A-Za-z]:\\[^\s:"'<>]+/g,                          // Windows drive-letter paths
  // UNC network paths, \\server\share\... (review fix, Task 16 Important 2b):
  // the drive-letter pattern above never matched these, so a UNC path shipped
  // verbatim through any scrubbed free-text surface. Server/share names are
  // exactly the kind of internal-infrastructure identifier this table exists
  // to strip.
  /\\\\[^\s"'<>]+/g,
  /\b[A-Z]{2}\d{2}[A-Za-z0-9]{10,30}\b/g,               // IBAN (PT/EU market)
];

const REDACTED = '[redacted]';

function scrubText(input) {
  let out = String(input == null ? '' : input);
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);
  return out.replace(/\s+/g, ' ').trim();
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
// Normalizes a parseable timestamp to ISO, truncated to the minute
// (seconds+ms zeroed) — e.g. '2026-05-29T10:15:42Z' -> '2026-05-29T10:15:00.000Z'.
// Anything unparseable (or non-string) becomes null; never thrown, never
// passed through verbatim.
const isoMinuteOrNull = (v) => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
};

// Real Claude Code session ids are UUIDs (hex digits + dashes). Anything that
// doesn't fit becomes '' so validateRecord rejects the record hub-side.
const SESSION_ID_RE = /^[0-9a-f-]{8,80}$/;
const sessionIdOrEmpty = (v) => {
  const s = String(v || '').slice(0, 80).toLowerCase();
  return SESSION_ID_RE.test(s) ? s : '';
};

// Model identifiers are lowercase alnum/dot/hyphen only (e.g. claude-opus-4-8).
const MODEL_RE = /^[a-z0-9.\-]{0,60}$/;
const modelOrEmpty = (v) => {
  const s = String(v || '').slice(0, 60).toLowerCase();
  return MODEL_RE.test(s) ? s : '';
};

const projectLabelOrEmpty = (v) => {
  const s = String(v || '');
  return PROJECT_LABEL_RE.test(s) ? s : '';
};

// extractor_version shape (A7): lowercase alnum/dot/hyphen/underscore,
// must start alnum, capped at 40 chars total (the regex anchors enforce the
// cap directly — a too-long string simply fails to match, same idiom as
// project_label/model above).
const EXTRACTOR_VERSION_RE = /^[a-z0-9][a-z0-9.\-_]{0,39}$/;
const extractorVersionOrEmpty = (v) => {
  const s = String(v || '');
  return EXTRACTOR_VERSION_RE.test(s) ? s : '';
};

// session_facts (D1a, Task 16): a model-produced array of {k, v} entries —
// k restricted to FACT_KEYS above, v either a finite number or short text.
// Text values are the ONE deliberate exception to this file's enum-only
// discipline (see the FACT_VALUE_RE/ALLOWED_SHAPES entry below): they still
// go through the SAME scrubText the rest of this file uses for any other
// free-text surface, THEN get capped — scrub-before-truncate, same ordering
// buildClassifyDigest (lib/classify-headless.js) already uses, so a secret
// straddling the cap boundary can never survive as an unredacted prefix.
const FACT_VALUE_MAX = 120;
const SESSION_FACTS_CAP = 12;

// Dedupe rule: LAST occurrence for a given k wins (a model that emits the
// same key twice in one array — the whole point of a fixed vocabulary is
// exactly one value per key — means the later entry is presumably the more
// deliberate/final one), but each key's FIRST-SEEN position is preserved
// (JS Map semantics: re-setting an existing key updates its value without
// moving it), then the whole list is capped at SESSION_FACTS_CAP entries.
//
// Verdict values (review fix, ATOMIC cloud-facts): the producer prompts
// (lib/classify-headless.js's buildPrompt, lib/extract.js's tool schema)
// instruct the model to OPEN a verdict with a canonical token —
// win/partial/loss — because the server-side aggregates (lib/db.js's
// factsAggregates) bucket sessions by the verdict's complete first word.
// This gate deliberately does NOT enforce or repair that opening: a
// non-canonical verdict ("successful, mostly") ships exactly as written and
// simply isn't counted into a bucket. Canonicalizing here would mean
// INVENTING an outcome the model never stated — scrubbing may redact, it
// never adds.
function sessionFactsOrEmpty(v) {
  const src = Array.isArray(v) ? v : [];
  const byKey = new Map();
  for (const entry of src) {
    if (!entry || typeof entry !== 'object') continue;
    if (!FACT_KEYS.includes(entry.k)) continue;
    let val;
    if (typeof entry.v === 'number' && Number.isFinite(entry.v)) {
      val = entry.v;
    } else if (entry.v == null) {
      continue;
    } else {
      val = scrubText(String(entry.v)).slice(0, FACT_VALUE_MAX);
      if (!val) continue; // nothing left after scrubbing/trim -> drop, never ship a blank fact
    }
    byKey.set(entry.k, { k: entry.k, v: val });
  }
  return [...byKey.values()].slice(0, SESSION_FACTS_CAP);
}

// region_counts (D2): keyed by EXACTLY the 8 functional regions, values run
// through clampInt, capped at 5000 (fold-forward from PR1's final review —
// a benchmark computation reading region_counts must never be handed an
// unbounded value from a hostile/malformed sender; 5000 tool calls in one
// region is already generous headroom over any real session). Unknown
// inbound keys are silently dropped (we only ever read the known keys off
// the input); keys missing from the input default to 0 (clampInt(undefined)
// is already 0). Non-object input can't throw — it's treated as "no counts
// at all".
const REGION_COUNT_MAX = 5000;
const regionCountsOrZeros = (v) => {
  const src = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of REGION_KEYS) out[k] = clampInt(src[k], REGION_COUNT_MAX);
  return out;
};

const SKEW_MS = 15 * 60 * 1000; // clock-skew tolerance for "now" bounds checks

// Fold-forward from PR1's final review (hub-side unbounded-past started_at
// guard): a record with a started_at far in the past (e.g. a multi-year-old
// session paired with a fresh ended_at) currently sails through
// enforceTimestampOrder untouched — it's a valid ordering, just an
// implausible one. Rejecting or nulling it would be wrong: legitimate
// backfills of a year+ of history are a real, wanted use case (Task 25/G4),
// so this must never reject or clamp the field. It's surfaced ONLY as a
// coercion-style SIGNAL (reason 'stale_started_at'), feeding the existing
// noisy-sender telemetry (Task 9) the hub/cloud ingest routes already watch —
// enough for an operator to notice a pattern, never enough to block a record.
const STALE_STARTED_AT_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days

// Ordering discipline: started_at <= ended_at <= now + skew. A violation
// nulls ONLY the offending field — never swaps or invents a value. A null
// started_at (unparseable or future-nulled) never blocks ended_at's own
// skew check; it just means there's nothing to order ended_at against.
function enforceTimestampOrder(rawStarted, rawEnded, now) {
  let startedAt = isoMinuteOrNull(rawStarted);
  let endedAt = isoMinuteOrNull(rawEnded);
  if (startedAt !== null && Date.parse(startedAt) > now + SKEW_MS) {
    startedAt = null;
  }
  if (endedAt !== null) {
    const endedMs = Date.parse(endedAt);
    const violatesSkew = endedMs > now + SKEW_MS;
    const violatesOrder = startedAt !== null && endedMs < Date.parse(startedAt);
    if (violatesSkew || violatesOrder) endedAt = null;
  }
  return { startedAt, endedAt };
}

// A value the sender never set at all (undefined/null) or explicitly left
// blank ('') carries no signal either way — coercion telemetry (Task 9)
// counts only a PROVIDED-but-wrong value as a coercion, never an absence.
const isProvided = (v) => v !== undefined && v !== null && v !== '';

// D1: assertShapes(record) is the FINAL, STRUCTURAL gate check. It does not
// know or care which field is "supposed" to hold a hash vs a label — it
// just walks every string the record carries (top-level string fields,
// strings inside arrays, and region_counts object KEYS) and asserts each
// one matches ONE of the shapes any legitimate value can ever take. A
// string matching none of them is replaced with '' (itself an allowed
// shape) and recorded; this never throws, it degrades. Belt-and-braces: with
// every per-field check above in place, this should never fire on a
// well-formed record (see the maximal-valid-record test in
// test/scrub.test.js) — it exists only to catch what a per-field check
// missed (see e.g. the extended-year-timestamp gap documented in
// test/scrub.test.js: isoMinuteOrNull accepts what Date.parse accepts,
// which is wider than the iso_minute shape).
const ENUM_MEMBERS = new Set([
  ...ACTIVITY_CATEGORIES, ...DOMAINS, ...TECHNIQUES, ...OUTCOMES,
  ...FRICTION_REASONS, ...SATISFACTIONS, ...SERVICE_TIERS, ...PROMPT_ANTIPATTERNS,
  ...PERMISSION_MODES, ...COACH_NUDGES, ...BUILTIN_TOOLS, ...CLASSIFIERS,
  ...TRUST_TIERS, ...REGION_KEYS, ...FACT_KEYS,
]);
// D1a (Task 16): session_facts[].v, when it's a string, is CONSTRAINED free
// text — the one deliberate exception to this file's enum-only shape
// discipline. By the time a value reaches this walk it has already been
// scrubText()'d and capped at FACT_VALUE_MAX chars (sessionFactsOrEmpty,
// above); this regex is a conservative BELT-AND-BRACES backstop catching
// what scrubText's own patterns might miss, mirroring the PII/secret shapes
// scrubText targets. EVERY lookahead is `.*`-unanchored — anywhere in the
// string, exactly like SECRET_PATTERNS/PII_PATTERNS' global matching, never
// just at the start (review fix, Task 16 Important 2): no '@' (email-shaped
// text), no '://' (URLs), no Unix path root (/Users/, /home/, ...), no
// Windows drive-letter path (C:\...), no UNC network path (\\server\...),
// no bare 12+ char hex token. It deliberately does NOT forbid ordinary
// prose — spaces, punctuation, digits — since allowing short free text at
// all is the entire point of this one exception.
const FACT_VALUE_RE = /^(?!.*@)(?!.*:\/\/)(?!.*\/(?:Users|home|root|var|etc|opt|srv|tmp|private)\/)(?!.*[A-Za-z]:\\)(?!.*\\\\)(?!.*\b[A-Fa-f0-9]{12,}\b).{0,120}$/;
// STANDARD_SHAPES is what every ordinary field/array-element/object-key is
// checked against. fact_value is DELIBERATELY excluded from this set — it is
// far more permissive than every other shape here (it accepts almost any
// short prose), so it must never become a generic escape hatch for fields
// that are supposed to be enum/id/hash-shaped only (e.g. it would otherwise
// mask the extended-year-timestamp gap this whole walk exists to catch —
// see test/scrub.test.js). It is wired in ONLY for session_facts[].v below.
const STANDARD_SHAPES = [
  { name: 'enum', test: (s) => ENUM_MEMBERS.has(s) }, // any exported enum list — incl. BUILTIN_TOOLS' uppercase names
  { name: 'id', regex: SESSION_ID_RE },                // /^[0-9a-f-]{8,80}$/
  { name: 'hash12', regex: HASH12_RE },                // /^[a-f0-9]{12}$/
  { name: 'label_pseudonym', regex: /^p-[a-f0-9]{12}$/ },
  { name: 'user_label', regex: EXTRACTOR_VERSION_RE }, // /^[a-z0-9][a-z0-9._-]{0,39}$/ — also extractor_version
  { name: 'model', regex: MODEL_RE },                  // /^[a-z0-9.\-]{0,60}$/ — pinned by spec A4; NOT the 40-char user_label shape
  { name: 'iso_minute', regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/ },
  { name: 'composed_intent', regex: /^[a-z_]+ · [a-z_]+$/ },
  { name: 'region_taxonomy', test: (s) => s === REGION_TAXONOMY },
  { name: 'empty', test: (s) => s === '' },
];
// Table-driven and exported: Task 11's schema dictionary consumes this FULL
// list (including fact_value) directly instead of re-deriving shape rules
// from scattered per-field regexes — it documents every shape ANY value in
// the record can ever take, even though fact_value is scoped narrower than
// the rest at runtime (see matchesFactValueShape below).
const ALLOWED_SHAPES = [...STANDARD_SHAPES, { name: 'fact_value', regex: FACT_VALUE_RE }];
const matchesAnyShape = (s) => STANDARD_SHAPES.some((sh) => (sh.test ? sh.test(s) : sh.regex.test(s)));
const matchesFactValueShape = (s) => matchesAnyShape(s) || FACT_VALUE_RE.test(s);

function assertShapes(record) {
  const dropped = [];
  const check = (field, s) => {
    if (matchesAnyShape(s)) return s;
    dropped.push({ field, shape: 'none' });
    return '';
  };
  const checkFactValue = (field, s) => {
    if (matchesFactValueShape(s)) return s;
    dropped.push({ field, shape: 'none' });
    return '';
  };
  const out = {};
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === 'string') out[field] = check(field, value);
    else if (Array.isArray(value)) {
      out[field] = value.map((v) => {
        if (typeof v === 'string') return check(field, v);
        // session_facts: array of {k, v} objects, not bare strings — walk
        // each entry's own string-valued properties. k is checked against
        // the STANDARD shapes (it must be a FACT_KEYS enum member); v gets
        // the widened fact_value-inclusive check. The widening is scoped by
        // FIELD NAME — `field === 'session_facts'` AND key === 'v' — never by
        // key name alone (review fix, Task 16 Important 1): otherwise any
        // future array-of-objects field whose entries happen to carry a 'v'
        // property would silently inherit the free-text exception. Exactly
        // ONE field in the whole record is permitted short constrained free
        // text, by name.
        if (v && typeof v === 'object') {
          const o = {};
          for (const [k, vv] of Object.entries(v)) {
            if (typeof vv !== 'string') { o[k] = vv; continue; }
            o[k] = (field === 'session_facts' && k === 'v')
              ? checkFactValue(`${field}.${k}`, vv)
              : check(`${field}.${k}`, vv);
          }
          return o;
        }
        return v;
      });
    }
    else if (value && typeof value === 'object') {
      // region_counts: only the KEYS are string surface (values are ints,
      // untouched). An invalid key is itself replaced with '' (per spec) —
      // two invalid keys in the same object would collide on that single ''
      // slot, but regionCountsOrZeros already restricts keys to REGION_KEYS
      // before this ever runs, so this never arises outside a direct,
      // deliberately-adversarial assertShapes() call.
      const obj = {};
      for (const [k, v] of Object.entries(value)) obj[check(`${field}.${k}`, k)] = v;
      out[field] = obj;
    } else out[field] = value;
  }
  return { record: out, dropped };
}

// enforceRecordDetailed(raw, opts) -> { record, coerced }. `record` is
// IDENTICAL to what enforceRecord has always returned (enforceRecord is now
// a thin wrapper around this — see below). `coerced` additionally lists
// every { field, reason } coercion EVENT this call made, for four kinds of
// event (Task 9's noisy-sender telemetry, extended by Task 27's fold-forward):
//   - 'enum_fallback':      a provided value missed its oneOf() list and
//                           fell back to the field's default.
//   - 'shape_rejected':     a provided value failed a shape regex
//                           (claude_session_id/model/project_label/extractor_version)
//                           and was rejected to ''.
//   - 'array_value_dropped': one array element was removed by an enum/hash
//                           shape filter. tools_used's builtin->'other_tool'
//                           REMAP doesn't count (the entry survives); cap/
//                           slice truncation of an otherwise-valid list
//                           doesn't count either (nothing was invalid).
//   - 'stale_started_at':   started_at survived ordering but is more than
//                           STALE_STARTED_AT_MS in the past — never rejected
//                           or clamped (legitimate history backfills are
//                           wanted), just flagged as a signal.
// Numeric clamps (other than the stale_started_at signal above), region_counts
// (an object, not an enum/array), and region_taxonomy (a forced literal, not
// a real enum — see its own comment above) are deliberately out of scope:
// none of them distinguish a malformed/hostile sender from an old-but-honest
// one the way enum/shape/array-drop/stale-timestamp coercions do.
function enforceRecordDetailed(raw, opts = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const coerced = [];

  const trackedOneOf = (field, list, dflt) => {
    const rv = r[field];
    const val = oneOf(rv, list, dflt);
    if (isProvided(rv) && val !== rv) coerced.push({ field, reason: 'enum_fallback' });
    return val;
  };
  const trackedShape = (field, fn) => {
    const rv = r[field];
    const val = fn(rv);
    if (isProvided(rv) && val === '') coerced.push({ field, reason: 'shape_rejected' });
    return val;
  };
  // Shared shape for techniques/friction_reasons/prompt_antipatterns/
  // nudges_shown: dedupe first (exactly matching the pre-Task-9 evaluation
  // order), THEN filter against the enum — so N duplicates of the SAME
  // invalid value count as exactly one dropped value, never N.
  const trackedEnumArray = (field, list) => {
    const src = Array.isArray(r[field]) ? r[field] : [];
    const deduped = [...new Set(src)];
    const kept = deduped.filter(x => list.includes(x));
    for (let i = 0; i < deduped.length - kept.length; i++) coerced.push({ field, reason: 'array_value_dropped' });
    return kept;
  };
  // Shared shape for mcp_tool_hashes/subagent_types: dedupe, filter to
  // hash-shaped strings (drops counted), THEN cap — the cap trims an
  // otherwise-valid list and is never itself a coercion.
  const trackedHashArray = (field, cap) => {
    const src = Array.isArray(r[field]) ? r[field] : [];
    const deduped = [...new Set(src)];
    const kept = deduped.filter(x => typeof x === 'string' && HASH12_RE.test(x));
    for (let i = 0; i < deduped.length - kept.length; i++) coerced.push({ field, reason: 'array_value_dropped' });
    return kept.slice(0, cap);
  };

  const tools = Array.isArray(r.tools_used) ? r.tools_used : [];
  // A2: tools_used is a fixed enum — every name is EITHER a real built-in
  // (BUILTIN_TOOLS) or the 'other_tool' catch-all. Non-string entries are
  // dropped outright (a genuine coercion); string entries always survive,
  // either unchanged or remapped to 'other_tool' (never dropped, so never
  // counted). Map before dedupe so e.g. 3 distinct unrecognized names
  // collapse to one 'other_tool' entry, not three. (MCP tool names never
  // reach here — see mcp_tool_count/mcp_tool_hashes; a raw 'mcp__*' string
  // arriving anyway, e.g. from a pre-A2 sender, still safely downgrades to
  // 'other_tool', never leaks.)
  //
  // Telemetry asymmetry, intentional: this counts drops PER OCCURRENCE on the
  // raw array, while trackedEnumArray/trackedHashArray count per DISTINCT
  // value post-dedupe. Each field's counting mirrors its own value pipeline —
  // tools_used filters non-strings BEFORE its dedupe (two `42`s are two
  // separate drops from the raw list), whereas the other arrays dedupe FIRST,
  // so their duplicates collapse before the filter ever sees them.
  for (const t of tools) if (typeof t !== 'string') coerced.push({ field: 'tools_used', reason: 'array_value_dropped' });

  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const { startedAt, endedAt } = enforceTimestampOrder(r.started_at, r.ended_at, now);
  // Fold-forward (unbounded-past started_at guard): flag, never reject or
  // clamp — see STALE_STARTED_AT_MS above. Only fires on a startedAt that
  // survived ordering (non-null); an unparseable/future-nulled started_at
  // has nothing to measure age from.
  if (startedAt !== null && Date.parse(startedAt) < now - STALE_STARTED_AT_MS) {
    coerced.push({ field: 'started_at', reason: 'stale_started_at' });
  }
  // A3: coerced FIRST so intent_summary can be composed/validated from the
  // FINAL (post-coercion) values, never the raw pre-coercion input.
  const activityCategory = trackedOneOf('activity_category', ACTIVITY_CATEGORIES, 'other');
  const domain = trackedOneOf('domain', DOMAINS, 'other');
  const record = {
    claude_session_id: trackedShape('claude_session_id', sessionIdOrEmpty),
    project_label: trackedShape('project_label', projectLabelOrEmpty),
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: clampInt(r.duration_s),
    turn_count: clampInt(r.turn_count),
    token_total: clampInt(r.token_total),
    activity_category: activityCategory,
    domain: domain,
    // A3: machine-composed template ONLY — ALWAYS recomposed from this
    // record's own post-coercion enums; any inbound r.intent_summary is
    // ignored entirely (free text, or a well-formed pair that disagrees
    // with this record's enums, can never ship). lib/extract.js's rich LLM
    // sentence stays local (see abstraction.local_intent); it never
    // reaches this gate.
    intent_summary: composeIntentSummary(activityCategory, domain),
    tools_used: [...new Set(
      tools.filter(t => typeof t === 'string').map(t => (BUILTIN_TOOLS.includes(t) ? t : 'other_tool'))
    )],
    techniques: trackedEnumArray('techniques', TECHNIQUES),
    // A5: MCP tool names ship ONLY as a count + capped/deduped HMAC hashes
    // (computed sender-side in lib/record.js, where the per-machine salt
    // lives). This gate just enforces shape — anything not hash-shaped is
    // dropped, never passed through raw.
    mcp_tool_count: clampInt(r.mcp_tool_count, 500),
    mcp_tool_hashes: trackedHashArray('mcp_tool_hashes', 20),
    error_rate: clamp01(r.error_rate),
    rework_score: clamp01(r.rework_score),
    friction_score: clamp01(r.friction_score),
    // 'unknown' means no evidence at all (see lib/metrics.js); 'partial' is
    // reserved for genuinely mixed evidence, so an unrecognized/missing
    // outcome must NOT default to 'partial' anymore.
    outcome: trackedOneOf('outcome', OUTCOMES, 'unknown'),
    outcome_score: clamp01(r.outcome_score),
    friction_reasons: trackedEnumArray('friction_reasons', FRICTION_REASONS),
    satisfaction: trackedOneOf('satisfaction', SATISFACTIONS, 'unknown'),
    // Token economics + deterministic outcomes (numeric/enum only — no raw content).
    input_tokens: clampInt(r.input_tokens),
    cache_read_tokens: clampInt(r.cache_read_tokens),
    cache_creation_tokens: clampInt(r.cache_creation_tokens),
    cache_hit_ratio: clamp01(r.cache_hit_ratio),
    est_cost_usd: nonNegFloat(r.est_cost_usd),
    service_tier: trackedOneOf('service_tier', SERVICE_TIERS, 'unknown'),
    lines_added: clampInt(r.lines_added),
    lines_removed: clampInt(r.lines_removed),
    commits: clampInt(r.commits),
    user_edit_rate: clamp01(r.user_edit_rate),
    model: trackedShape('model', modelOrEmpty),
    // Human-disagreement + frustration signals (numeric only).
    denials: clampInt(r.denials, 1000),
    denial_rate: clamp01(r.denial_rate),
    interruptions: clampInt(r.interruptions, 1000),
    frustration_score: clamp01(r.frustration_score),
    // Prompt quality (enum + score only — never the prompt text).
    prompt_antipatterns: trackedEnumArray('prompt_antipatterns', PROMPT_ANTIPATTERNS),
    prompt_quality: clamp01(r.prompt_quality),
    // Task threading inputs.
    is_continuation: !!r.is_continuation,
    compactions: clampInt(r.compactions, 1000),
    // Orchestration shape. A5: subagent types ship exactly like MCP names —
    // HMAC hashes only (hashed sender-side in lib/record.js), never the raw
    // subagent_type string. This gate enforces the hash shape.
    subagent_types: trackedHashArray('subagent_types', 10),
    max_parallel_tools: clampInt(r.max_parallel_tools, 100),
    permission_mode: trackedOneOf('permission_mode', PERMISSION_MODES, 'unknown'),
    // Coach feedback loop: which live tips were SHOWN this session (enums).
    nudges_shown: trackedEnumArray('nudges_shown', COACH_NUDGES),
    // Git ground truth (sender-computed numbers; no paths/messages).
    git_analyzed: !!r.git_analyzed,
    survival_rate: clamp01(r.survival_rate),
    lines_surviving: clampInt(r.lines_surviving),
    reverts: clampInt(r.reverts, 1000),
    // A7/D2: classification provenance, trust tier, cost, and the versioned
    // region profile. classifier/trust_tier fail closed to the
    // no-independent-evidence defaults ('deterministic'/'self_reported') —
    // see the CLASSIFIERS/TRUST_TIERS comments above.
    classifier: trackedOneOf('classifier', CLASSIFIERS, 'deterministic'),
    extractor_version: trackedShape('extractor_version', extractorVersionOrEmpty),
    trust_tier: trackedOneOf('trust_tier', TRUST_TIERS, 'self_reported'),
    classify_cost_usd: nonNegFloat(r.classify_cost_usd),
    // D1a (Task 16): model-produced session facts (empty when classifier is
    // 'deterministic' — no model ran, so there's nothing to report). Not
    // tracked in `coerced`: an unrecognized k or a non-string/non-number v is
    // silently dropped per-entry (see sessionFactsOrEmpty above), the same
    // "shape, not enum" treatment region_counts/region_taxonomy already get —
    // it doesn't distinguish a malformed sender from an old-but-honest one.
    session_facts: sessionFactsOrEmpty(r.session_facts),
    region_counts: regionCountsOrZeros(r.region_counts),
    // Fixed literal, not a real enum — any inbound value (even another
    // taxonomy-version-shaped string) coerces to THIS version. See the
    // REGION_TAXONOMY comment above. (Not tracked in `coerced`: this never
    // goes through oneOf(), and every record — even a perfectly honest one
    // — has this field "overwritten", so it carries no noisy-sender signal.)
    region_taxonomy: REGION_TAXONOMY,
    // Echo the inbound schema_version (capped at 99) rather than overwriting
    // it — the hub needs to know which sender build produced a record.
    // Absent/unparseable/zero all fall back to 3 (the version before
    // buildRecord started stamping it explicitly), so old v3 senders that
    // never set the field keep reporting 3.
    schema_version: clampInt(r.schema_version, 99) || 3,
  };
  // D1: the final structural check — belt-and-braces over every field check
  // above. Its drops merge into `coerced` under their own reason ('shape'),
  // distinguishable from Task 9's 'enum_fallback'/'shape_rejected'/
  // 'array_value_dropped' events.
  const shaped = assertShapes(record);
  for (const d of shaped.dropped) coerced.push({ field: d.field, reason: 'shape' });
  return { record: shaped.record, coerced };
}

// SCHEMA_FIELDS (Task 11): the public data dictionary, as data. One entry per
// field enforceRecordDetailed's `record` object emits above, SAME ORDER — this
// is the ONLY thing scripts/gen-data-dictionary.js reads to render
// docs/data-dictionary.md. It must never drift from the object literal above:
// see the anti-drift test in test/scrub.test.js, which asserts
// `Object.keys(enforceRecord({}))` sorted === `SCHEMA_FIELDS.map(f => f.name)`
// sorted. `shape` values are pulled from the SAME regex objects each field's
// own coercion function uses (or, for the two shapes with no standalone
// constant — iso_minute, composed_intent — from ALLOWED_SHAPES, itself the
// gate's own belt-and-braces check) so this can never quietly re-type a rule
// the gate doesn't actually enforce.
//
// type is one of: id, label, iso_minute, int, float01, usd, enum, enum_array,
// hash_array, bool, string, object, version.
const isoMinuteShape = ALLOWED_SHAPES.find((s) => s.name === 'iso_minute').regex.source;
const composedIntentShape = ALLOWED_SHAPES.find((s) => s.name === 'composed_intent').regex.source;

const SCHEMA_FIELDS = [
  { name: 'claude_session_id', type: 'id', shape: SESSION_ID_RE.source,
    note: 'Opaque per-session identifier used only to group records from the same Claude Code session; never resolvable to a person.' },
  { name: 'project_label', type: 'label', shape: PROJECT_LABEL_RE.source,
    note: 'Either an HMAC pseudonym for the project\'s filesystem path or a short user-assigned label; the raw path itself never leaves the machine.' },
  { name: 'started_at', type: 'iso_minute', shape: isoMinuteShape,
    note: 'Session start time truncated to the minute; null if unparseable or more than 15 minutes in the future. A value more than ~400 days in the past is accepted as-is (legitimate history backfills) but flagged as a stale_started_at coercion signal.' },
  { name: 'ended_at', type: 'iso_minute', shape: isoMinuteShape,
    note: 'Session end time truncated to the minute; null if unparseable, more than 15 minutes in the future, or earlier than started_at.' },
  { name: 'duration_s', type: 'int',
    note: 'Session duration in whole seconds, clamped to a non-negative integer.' },
  { name: 'turn_count', type: 'int',
    note: 'Number of conversational turns in the session, clamped to a non-negative integer.' },
  { name: 'token_total', type: 'int',
    note: 'Total tokens (input, output, and cache combined) reported for the session, clamped to a non-negative integer.' },
  { name: 'activity_category', type: 'enum', enumRef: 'ACTIVITY_CATEGORIES',
    note: 'Primary kind of work performed this session; falls back to \'other\' if absent or not one of the listed values.' },
  { name: 'domain', type: 'enum', enumRef: 'DOMAINS',
    note: 'Technical area the session\'s work falls under; falls back to \'other\' if absent or not one of the listed values.' },
  { name: 'intent_summary', type: 'string', shape: composedIntentShape,
    note: 'Machine-composed from this record\'s own post-coercion activity_category and domain; any value a sender supplies is ignored and it is always recomputed from the record\'s own fields.' },
  { name: 'tools_used', type: 'enum_array', enumRef: 'BUILTIN_TOOLS',
    note: 'Deduplicated list of built-in tool names invoked this session; any name outside the fixed list is remapped to \'other_tool\' rather than dropped (MCP tool names never appear here — see mcp_tool_hashes).' },
  { name: 'techniques', type: 'enum_array', enumRef: 'TECHNIQUES',
    note: 'Deduplicated list of higher-level working techniques detected in the session; unrecognized values are dropped.' },
  { name: 'mcp_tool_count', type: 'int',
    note: 'Count of DISTINCT MCP tool names used this session (sessionize dedupes before this count is taken, so repeat calls to the same tool count once), clamped to a non-negative integer capped at 500.' },
  { name: 'mcp_tool_hashes', type: 'hash_array', shape: HASH12_RE.source,
    note: 'Deduplicated list of HMAC-hashed MCP tool names, capped at 20 entries; the raw tool name is hashed on the sending machine and never transmitted.' },
  { name: 'error_rate', type: 'float01',
    note: 'Fraction of tool calls that errored during the session, 0 to 1.' },
  { name: 'rework_score', type: 'float01',
    note: 'Fraction of the session\'s activity classified as reworking prior output, 0 to 1.' },
  { name: 'friction_score', type: 'float01',
    note: 'Composite signal for how much friction the session encountered, 0 to 1.' },
  { name: 'outcome', type: 'enum', enumRef: 'OUTCOMES',
    note: 'Detected result of the session; falls back to \'unknown\' if absent or not one of the listed values, and never defaults to \'partial\'.' },
  { name: 'outcome_score', type: 'float01',
    note: 'Confidence in the detected outcome, 0 to 1.' },
  { name: 'friction_reasons', type: 'enum_array', enumRef: 'FRICTION_REASONS',
    note: 'Deduplicated list of reasons friction was detected this session; unrecognized values are dropped.' },
  { name: 'satisfaction', type: 'enum', enumRef: 'SATISFACTIONS',
    note: 'Detected user satisfaction for the session; falls back to \'unknown\' if absent or not one of the listed values.' },
  { name: 'input_tokens', type: 'int',
    note: 'Input tokens consumed this session, clamped to a non-negative integer.' },
  { name: 'cache_read_tokens', type: 'int',
    note: 'Tokens served from prompt cache reads this session, clamped to a non-negative integer.' },
  { name: 'cache_creation_tokens', type: 'int',
    note: 'Tokens spent writing to prompt cache this session, clamped to a non-negative integer.' },
  { name: 'cache_hit_ratio', type: 'float01',
    note: 'Fraction of tokens served from cache rather than freshly processed, 0 to 1.' },
  { name: 'est_cost_usd', type: 'usd',
    note: 'Estimated USD cost of the session\'s model usage, rounded to six decimal places; non-positive or non-finite input collapses to 0.' },
  { name: 'service_tier', type: 'enum', enumRef: 'SERVICE_TIERS',
    note: 'API service tier used for the session\'s requests; falls back to \'unknown\' if absent or not one of the listed values.' },
  { name: 'lines_added', type: 'int',
    note: 'Lines of code added during the session, clamped to a non-negative integer.' },
  { name: 'lines_removed', type: 'int',
    note: 'Lines of code removed during the session, clamped to a non-negative integer.' },
  { name: 'commits', type: 'int',
    note: 'Number of git commits made during the session, clamped to a non-negative integer.' },
  { name: 'user_edit_rate', type: 'float01',
    note: 'Fraction of assistant-authored lines the user subsequently edited by hand, 0 to 1.' },
  { name: 'model', type: 'string', shape: MODEL_RE.source,
    note: 'Model identifier used for the session\'s primary work, lowercase alphanumeric/dot/hyphen only, capped at 60 chars; empty if absent or non-conforming.' },
  { name: 'denials', type: 'int',
    note: 'Number of tool-permission prompts the user denied, clamped to a non-negative integer capped at 1000.' },
  { name: 'denial_rate', type: 'float01',
    note: 'Fraction of tool-permission prompts the user denied, 0 to 1.' },
  { name: 'interruptions', type: 'int',
    note: 'Number of times the user interrupted the assistant mid-turn, clamped to a non-negative integer capped at 1000.' },
  { name: 'frustration_score', type: 'float01',
    note: 'Composite signal for detected user frustration during the session, 0 to 1.' },
  { name: 'prompt_antipatterns', type: 'enum_array', enumRef: 'PROMPT_ANTIPATTERNS',
    note: 'Deduplicated list of prompt-quality antipatterns detected in the session\'s user prompts; unrecognized values are dropped.' },
  { name: 'prompt_quality', type: 'float01',
    note: 'Composite quality score for the session\'s user prompts, 0 to 1.' },
  { name: 'is_continuation', type: 'bool',
    note: 'Whether this session continued an earlier session (e.g. via --continue or --resume).' },
  { name: 'compactions', type: 'int',
    note: 'Number of context-window compactions that occurred during the session, clamped to a non-negative integer capped at 1000.' },
  { name: 'subagent_types', type: 'hash_array', shape: HASH12_RE.source,
    note: 'Deduplicated list of HMAC-hashed subagent types launched via the Task tool, capped at 10 entries; the raw subagent_type string is hashed on the sending machine and never transmitted.' },
  { name: 'max_parallel_tools', type: 'int',
    note: 'Highest number of tool calls the session ran in parallel at once, clamped to a non-negative integer capped at 100.' },
  { name: 'permission_mode', type: 'enum', enumRef: 'PERMISSION_MODES',
    note: 'Claude Code permission mode active during the session; falls back to \'unknown\' if absent or not one of the listed values.' },
  { name: 'nudges_shown', type: 'enum_array', enumRef: 'COACH_NUDGES',
    note: 'Deduplicated list of coach nudges shown to the user during the session; unrecognized values are dropped.' },
  { name: 'git_analyzed', type: 'bool',
    note: 'Whether git-based line-survival and revert analysis ran for this session; when false, survival_rate, lines_surviving, and reverts carry no meaningful signal.' },
  { name: 'survival_rate', type: 'float01',
    note: 'Fraction of lines added during the session that still existed at measurement time, 0 to 1.' },
  { name: 'lines_surviving', type: 'int',
    note: 'Count of added lines still present at measurement time, clamped to a non-negative integer.' },
  { name: 'reverts', type: 'int',
    note: 'Number of commits during the session that reverted prior work, clamped to a non-negative integer capped at 1000.' },
  { name: 'classifier', type: 'enum', enumRef: 'CLASSIFIERS',
    note: 'Which mechanism produced activity_category/domain for this record; falls back to \'deterministic\' if absent or not one of the listed values, since unknown provenance must never look like a model classified it.' },
  { name: 'extractor_version', type: 'string', shape: EXTRACTOR_VERSION_RE.source,
    note: 'Pinned identifier of the model-and-prompt version that produced activity_category/domain, lowercase alphanumeric/dot/hyphen/underscore, capped at 40 chars; empty if absent or non-conforming.' },
  { name: 'trust_tier', type: 'enum', enumRef: 'TRUST_TIERS',
    note: 'How this record\'s signals were obtained; today the only value is \'self_reported\' since every field is produced by the sender\'s own machine, never independently verified.' },
  { name: 'classify_cost_usd', type: 'usd',
    note: 'Estimated USD cost of the classification call itself, rounded to six decimal places; 0 when classification used the local deterministic fallback.' },
  { name: 'session_facts', type: 'object', enumRef: 'FACT_KEYS',
    note: 'At most 12 model-produced {k, v} facts about the session, k restricted to the listed keys and deduped (last write wins); v is either a finite number or scrubbed/redacted text capped at 120 characters. Always empty when classifier is \'deterministic\' — facts only exist when a model produced them.' },
  { name: 'region_counts', type: 'object', enumRef: 'REGION_KEYS',
    note: 'Per-region tool-call counts keyed by exactly the eight functional regions named in region_taxonomy; missing keys default to 0, unrecognized keys are dropped, and each value is clamped to a non-negative integer capped at 5000.' },
  { name: 'region_taxonomy', type: 'version',
    note: 'Fixed version stamp for the region taxonomy that region_counts\' keys belong to; always the literal \'functional-8.v1\' in schema_version 4 — any other value a sender sends is overwritten, since this is a schema assertion, not a client-chosen setting.' },
  { name: 'schema_version', type: 'int',
    note: 'Schema version the sending client believes it used, echoed back as given (numeric strings are accepted too); values above 99 clamp to 99 rather than falling back. Defaults to 3 (the version before this field was stamped explicitly) only when the value is absent, non-numeric, or 0.' },
];

// enforceRecord(raw, opts) -> a clean record containing ONLY approved fields.
// opts.now (ms epoch, default Date.now()) makes timestamp-ordering checks
// deterministic for tests. Thin wrapper over enforceRecordDetailed (Task 9) —
// this function's output is unchanged by that addition; see the
// enforceRecordDetailed/enforceRecord parity test in test/scrub.test.js.
function enforceRecord(raw, opts) {
  return enforceRecordDetailed(raw, opts).record;
}

module.exports = {
  scrubText, enforceRecord, enforceRecordDetailed,
  ACTIVITY_CATEGORIES, DOMAINS, TECHNIQUES, OUTCOMES,
  SECRET_PATTERNS, PII_PATTERNS, FRICTION_REASONS, SATISFACTIONS, SERVICE_TIERS,
  PROMPT_ANTIPATTERNS, PERMISSION_MODES, COACH_NUDGES, PROJECT_LABEL_RE,
  BUILTIN_TOOLS, CLASSIFIERS, TRUST_TIERS, REGION_TAXONOMY, REGION_KEYS,
  FACT_KEYS, FACT_VALUE_RE,
  assertShapes, ALLOWED_SHAPES, SCHEMA_FIELDS,
};
