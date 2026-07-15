// SPDX-License-Identifier: Apache-2.0
// lib/sharing-tiers.js — Task 24 (G3): named sharing tiers, ONE config
// surface. Pure; no I/O. Collapses what used to be three scattered consent
// knobs (BRAIN_SHARING/--sharing live-brain detail, BRAIN_USAGE usage-record
// on/off, and classify()'s session_facts) into five named tiers, each
// expanding to the same three concrete flags every shipping call site reads:
//
//   liveSharing — null | 'region' | 'tool' | 'full'
//                 fed straight into lib/redact.js's redactEvent() sharing
//                 param; null means "don't connect the live feed at all",
//                 not merely "redact everything" (redactEvent has no null
//                 case — it isn't reachable from a named tier, only from a
//                 legacy BRAIN_SHARING value with no tier of its own; see
//                 the legacy mapping table below).
//   usage       — bool: does the sender/plugin ship a usage record at all?
//   facts       — bool: if a usage record ships, does session_facts ride
//                 along, or is it forced to [] before the record leaves the
//                 machine? classify() may still run either way (its
//                 activity_category/domain and locally-logged cost are
//                 unaffected) — only the shipped session_facts field is
//                 gated by this flag.
//
// --- TIER -> FLAGS TABLE ---------------------------------------------------
//
//   tier      | liveSharing | usage | facts | meaning
//   ----------|-------------|-------|-------|--------------------------------
//   off       | null        | false | false | nothing leaves this machine
//   presence  | 'region'    | false | false | live brain: region pulses only
//   activity  | 'full'      | false | false | live brain: full task detail
//   metrics   | 'full'      | true  | false | + usage records, facts stripped
//   full      | 'full'      | true  | true  | + session facts (today's default)
//
// Each tier is a strict superset of the one before it (off < presence <
// activity < metrics < full) — there is exactly one dimension of "more
// sharing", so "the LESS-sharing tier" always has an unambiguous meaning
// wherever this module talks about resolving conservatively.
//
// --- DEFAULT ----------------------------------------------------------------
//
// DEFAULT_TIER is 'full', DELIBERATELY. Before this module existed, a sender
// with no env vars set at all shipped live 'full' detail (lib/redact.js's own
// fallback) AND usage records (BRAIN_USAGE unset -> on, sender.js) AND
// session facts (Task 16: classify()'s facts ship whenever classify runs,
// with no gate of their own). That combination IS this module's 'full' tier.
// Defaulting anywhere narrower would silently reduce what an existing,
// unconfigured install already shares — this module is an opt-in NAMING and
// NARROWING layer over existing consent, never a silent tightening (nor
// loosening) of it.
//
// --- LEGACY ENV MAPPING TABLE (conservative: ambiguity -> the LESS-sharing
//     tier — see resolveLegacyEnv below for the exact resolution logic) -----
//
//   BRAIN_SHARING | BRAIN_USAGE  | resolved tier | why
//   --------------|--------------|---------------|------------------------------
//   full          | unset or !=0 | full           | today's real default (see above)
//   full          | 0            | activity       | full live detail, no records
//   tool          | (either)     | presence       | no named tier ships 'tool'-level
//                 |              |                | detail; the nearest tier that
//                 |              |                | never ships MORE than 'tool'
//                 |              |                | reveals is 'presence' (region)
//   region        | (either)     | presence       | exact liveSharing match; a
//                 |              |                | requested usage=on is dropped
//                 |              |                | rather than upgraded past
//                 |              |                | 'presence' (never ship more
//                 |              |                | than what was asked)
//   (unrecognized)| unset or !=0 | full           | unknown BRAIN_SHARING values
//                 |              |                | fall back to 'full', mirroring
//                 |              |                | sender.js's own historical
//                 |              |                | fallback-with-warning behavior
//   (unrecognized)| 0            | activity       | same fallback, then usage off
//
// Notably, no legacy combination maps to 'off': the pre-tier system had no
// "disable everything" knob (a running sender always shared AT LEAST
// region-level live presence), so nothing already deployed can be silently
// pushed all the way to 'off' by this mapping — 'off' is reachable only by
// deliberately opting into it (config.tier: 'off' or TOKENOMICA_TIER=off), OR
// by an explicitly-provided tier value that ISN'T a valid tier name at all —
// see the "explicit-but-invalid" handling in resolveTier below, which fails
// CLOSED to 'off' rather than falling through to a less-restrictive source.

const TIERS = Object.freeze({
  off:      Object.freeze({ liveSharing: null,     usage: false, facts: false }),
  presence: Object.freeze({ liveSharing: 'region', usage: false, facts: false }),
  activity: Object.freeze({ liveSharing: 'full',   usage: false, facts: false }),
  metrics:  Object.freeze({ liveSharing: 'full',   usage: true,  facts: false }),
  full:     Object.freeze({ liveSharing: 'full',   usage: true,  facts: true  }),
});

const TIER_NAMES = Object.freeze(['off', 'presence', 'activity', 'metrics', 'full']);

const DEFAULT_TIER = 'full';

const TIER_DESCRIPTIONS = Object.freeze({
  off: 'nothing leaves this machine',
  presence: 'live brain shows region pulses only (no task detail); no usage records',
  activity: 'live brain shows full task detail; no usage records',
  metrics: 'usage records ship (metrics only); session facts are stripped before shipping',
  full: 'usage records and session facts both ship (default)',
});

function isValidTier(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TIERS, name);
}

// Case-insensitive tier-name match — tried BEFORE anything is declared
// invalid, so 'Off'/'FULL'/'Metrics' etc. resolve to their canonical
// lowercase tier exactly like the exact spelling would (warning-free).
// Returns the canonical (lowercase) tier name, or null if `name` doesn't
// match any tier even case-insensitively.
function normalizeTierName(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  return TIER_NAMES.includes(lower) ? lower : null;
}

// One-line human-readable meaning of a tier, for /tokenomica:status and the
// sender boot log. An unrecognized name falls back to DEFAULT_TIER's
// description rather than throwing or returning something empty — status
// surfaces must always print SOMETHING sensible.
function describeTier(name) {
  return isValidTier(name) ? TIER_DESCRIPTIONS[name] : TIER_DESCRIPTIONS[DEFAULT_TIER];
}

const LEGACY_SHARING_LEVELS = ['full', 'tool', 'region'];

// Maps the legacy BRAIN_SHARING/BRAIN_USAGE env pair onto the nearest named
// tier, per the table in the file header. Returns null when NEITHER env var
// is present at all — i.e. there is no legacy signal in play, and resolution
// should fall through to DEFAULT_TIER without any warning (a bare install
// with nothing configured is not "using a deprecated legacy path", it's just
// using the default).
function resolveLegacyEnv(env) {
  const hasSharing = typeof env.BRAIN_SHARING === 'string';
  const hasUsage = typeof env.BRAIN_USAGE === 'string';
  if (!hasSharing && !hasUsage) return null;

  const sharingLevel = LEGACY_SHARING_LEVELS.includes(env.BRAIN_SHARING) ? env.BRAIN_SHARING : 'full';
  const usageOn = env.BRAIN_USAGE !== '0';

  let tier;
  if (sharingLevel === 'full') {
    tier = usageOn ? 'full' : 'activity';
  } else {
    // 'tool' or 'region': neither has an exact named-tier equivalent that
    // ships usage records without also upgrading liveSharing past what was
    // requested, so both conservatively downgrade to 'presence' regardless
    // of usageOn (never ship more detail — live or recorded — than the
    // legacy config asked for).
    tier = 'presence';
  }
  return { tier, sharingLevel, usageOn };
}

// An explicitly-provided tier value (env.TOKENOMICA_TIER or config.tier is a
// STRING, i.e. actually present) that doesn't match any tier name even
// case-insensitively is a typo/misconfiguration, not "no opinion" — Review
// fix (final whole-branch review, Important item 2): this fails CLOSED to
// 'off' (no data flows) rather than silently falling through to the next
// source in precedence, which could land on 'full' (maximal sharing) off a
// typo — the opposite of what "ambiguity resolves to the LESS-sharing tier"
// requires. Reuses the SAME legacyWarning field/mechanism every caller
// already checks-and-logs (sender.js's boot print, plugin/upload-session.js's
// runHook/runStatus), so the warning reaches a log line on every route with
// no call-site changes needed.
function invalidTierWarning(label, rawValue) {
  return `${label} "${rawValue}" is not a valid tier — resolved to "off" (fail closed: nothing shares) rather than risk shipping data on a typo. Valid tiers: ${TIER_NAMES.join(', ')}.`;
}

// resolveTier(config, env) -> { tier, source, flags, legacyWarning }
//
// Precedence: env.TOKENOMICA_TIER > config.tier > legacy envs (conservative
// mapping, above) > DEFAULT_TIER. `config` is the parsed ~/.tokenomica/plugin.json
// object (or {}/null — tolerant of either); `env` is typically process.env,
// but callers (sender.js) may pass a merged object to fold in CLI flags
// (e.g. --sharing) ahead of the same-named env var.
//
// Each of TOKENOMICA_TIER/config.tier is matched case-insensitively against the
// five tier names BEFORE being declared invalid ('Off' -> 'off', warning-
// free) — only a value that matches NO tier name, in any case, is invalid.
//
// `source` is one of 'env' | 'config' | 'legacy-env' | 'default' |
// 'invalid-env' | 'invalid-config' — which input actually decided the tier;
// useful for logging/debugging, not load-bearing for the flags themselves.
// The 'invalid-*' sources always resolve to tier 'off' (see above).
//
// `legacyWarning` is a one-line string whenever the resolution owes the
// caller an explanation: the legacy env path decided the tier, OR an
// explicitly-provided tier value was invalid and got failed closed to 'off'.
// The caller prints it ONCE at its own boot (a long-lived sender daemon boots
// once; a short-lived plugin hook invocation IS its own boot, so printing
// here each time it fires still satisfies "once per boot"). null whenever
// TOKENOMICA_TIER, config.tier (both valid), or the pure default decided
// instead — none of those owe a warning.
function resolveTier(config, env) {
  const cfg = config || {};
  const e = env || {};

  // TOKENOMICA_TIER, falling back to the pre-rename CLAUDIUM_TIER so a hub or
  // shell that set the old name keeps resolving exactly as before. The label
  // in any warning names whichever var actually decided it.
  const tierEnvName = typeof e.TOKENOMICA_TIER === 'string' ? 'TOKENOMICA_TIER'
    : typeof e.CLAUDIUM_TIER === 'string' ? 'CLAUDIUM_TIER' : null;
  if (tierEnvName) {
    const raw = e[tierEnvName];
    const normalized = normalizeTierName(raw);
    if (normalized) {
      return { tier: normalized, source: 'env', flags: TIERS[normalized], legacyWarning: null };
    }
    return { tier: 'off', source: 'invalid-env', flags: TIERS.off, legacyWarning: invalidTierWarning(tierEnvName, raw) };
  }
  if (typeof cfg.tier === 'string') {
    const normalized = normalizeTierName(cfg.tier);
    if (normalized) {
      return { tier: normalized, source: 'config', flags: TIERS[normalized], legacyWarning: null };
    }
    return { tier: 'off', source: 'invalid-config', flags: TIERS.off, legacyWarning: invalidTierWarning('plugin.json "tier"', cfg.tier) };
  }
  const legacy = resolveLegacyEnv(e);
  if (legacy) {
    return {
      tier: legacy.tier,
      source: 'legacy-env',
      flags: TIERS[legacy.tier],
      legacyWarning: `legacy BRAIN_SHARING/BRAIN_USAGE env detected (sharing=${legacy.sharingLevel}, usage=${legacy.usageOn ? 'on' : 'off'}) — mapped conservatively to tier "${legacy.tier}". Set "tier" in ~/.tokenomica/plugin.json (or TOKENOMICA_TIER) to silence this warning.`,
    };
  }
  return { tier: DEFAULT_TIER, source: 'default', flags: TIERS[DEFAULT_TIER], legacyWarning: null };
}

module.exports = {
  TIERS, TIER_NAMES, DEFAULT_TIER, TIER_DESCRIPTIONS,
  isValidTier, describeTier, resolveTier,
};
