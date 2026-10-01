// SPDX-License-Identifier: Apache-2.0
// lib/pricing.js — the one price table, and the local cost estimate. Pure.
//
// Every dollar figure in Tokenomica comes from RULES below: the plugin's local
// estimate (est_cost_usd, the usage report, the coach) and the server's price
// book (lib/price-book.js, which re-prices every record at ingest). There used
// to be two tables, one per side, and they drifted apart: on 43,510 real calls
// the client over-priced by 2.84x and the server by 1.6x against the published
// rates. One table cannot drift from itself.
//
// Source: platform.claude.com/docs/en/about-claude/pricing, checked line by
// line on 2026-09-30. test/pricing.test.js pins every row to that table.
// Treat the result as an ESTIMATE, not a bill: contracted rates, data-residency
// multipliers and batch discounts are not modelled.
//
// NEVER GUESS. An unrecognized model returns { known: false } and costs 0, so
// it shows up as "N sessions we could not price" instead of a confident, wrong
// total. When a new model ships, ADD IT HERE, rebuild the plugin
// (scripts/build-plugin.js) and re-run scripts/reprice.js.

// Cache economics, as multipliers on the model's input rate. Published rates:
//   5-minute cache write  1.25x
//   1-hour  cache write   2.00x
//   cache read            0.10x, unless the rule names its own (`read`)
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.00;
const CACHE_READ_MULT = 0.10;

// Records and sessions that carry only a flat cache_creation total (clients
// that predate the 5m/1h split) are priced at the 1-hour rate: measured over
// 320M cache-creation tokens, 99.4% of Claude Code's subscription-time cache
// writes were 1h. It is an approximation; the split, when present, wins.
const CACHE_WRITE_LEGACY_MULT = CACHE_WRITE_1H_MULT;

// The version must end here, optionally followed by a -YYYYMMDD snapshot date:
// opus-5 is not opus-5-5, and the NEXT release (opus-5-6, fable-5-2) is
// unpriced rather than inheriting a neighbour's rate. claude-haiku-4-5-20251001
// is haiku-4-5.
const GEN = '(?:-\\d{8})?(?![.-]?\\d)';
const gen = (s) => new RegExp(`${s}${GEN}`);

// Evaluated IN ORDER; first match wins. `from`/`to` are ISO dates bounding when
// a rule applied ('' = open-ended), so a rate change is a NEW entry and
// re-pricing old records still yields the old price. [inputPerMTok,
// outputPerMTok] in USD.
const RULES = [
  // Fable 5.1 / Mythos 5.1: same input/output as 5, but reads at 0.025x.
  { re: gen('(?:fable|mythos)-5-1'), from: '', to: '', price: [10, 50], read: 0.025 },
  { re: gen('(?:fable|mythos)-5'), from: '', to: '', price: [10, 50] },

  // Opus 5.5 is cheaper than Opus 5, and its cache reads are 0.05x.
  { re: gen('opus-5-5'), from: '', to: '', price: [4, 20], read: 0.05 },
  // Opus 5 and the 4.5–4.8 generation share a tier.
  { re: gen('opus-(?:5|4-[5-8])'), from: '', to: '', price: [5, 25] },
  // Opus 4 / 4.1 stayed on the original, higher tier (claude-opus-4-0 is the
  // alias for Opus 4).
  { re: gen('opus-4(?:-[01])?'), from: '', to: '', price: [15, 75] },

  // Sonnet 5 launched at $2/$10 as an introductory rate. The step up to $3/$15
  // scheduled for 2026-09-01 was cancelled, so this rule is open-ended.
  { re: gen('sonnet-5(?:-5)?'), from: '', to: '', price: [2, 10] },
  { re: gen('sonnet-4(?:-[056])?'), from: '', to: '', price: [3, 15] },

  { re: gen('haiku-4-5'), from: '', to: '', price: [1, 5] },

  // Claude 3.x, retired on the first-party API but still in old rows and on
  // some cloud providers. Kept so a re-price never turns a priced row into $0.
  { re: gen('3-[57]-sonnet'), from: '', to: '', price: [3, 15] },
  { re: gen('3-5-haiku'), from: '', to: '', price: [0.8, 4] },
  { re: gen('3-haiku'), from: '', to: '', price: [0.25, 1.25] },
  { re: gen('3-opus'), from: '', to: '', price: [15, 75] },
];

// Fast mode runs the SAME model id at a premium rate, so the model string alone
// cannot price a session: usage.speed has to be read too. Offered on Opus 5.5,
// Opus 5 and Opus 4.8 only; anything else reporting "fast" is priced as
// standard rather than silently marked up. Cache multipliers apply on top.
const FAST_RULES = [
  { re: gen('opus-5-5'), price: [8, 40], read: 0.05 },
  { re: gen('opus-(?:5|4-8)'), price: [10, 50] },
];

// Cloud providers name the same model differently: Bedrock
// "us.anthropic.claude-opus-5-5-v1:0" (or a full ARN), Vertex
// "claude-opus-5-5@20260801", and Claude Code's "[1m]" context suffix. This
// reduces them to the first-party id, so the record ships a model the server
// can price and never an ARN, which carries the AWS account id. Anything that
// still is not a plain id is left for scrub to blank.
function canonicalModel(model) {
  return String(model || '').toLowerCase().trim()
    .replace(/^.*anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '');
}

const inWindow = (rule, atMs) => {
  if (rule.from) { const f = Date.parse(rule.from); if (Number.isFinite(f) && atMs < f) return false; }
  if (rule.to) { const t = Date.parse(rule.to); if (Number.isFinite(t) && atMs >= t) return false; }
  return true;
};

const UNKNOWN = { known: false, input: 0, output: 0, read: CACHE_READ_MULT, rule: '' };

// priceAt(model, at, speed) -> { known, input, output, read, rule }
// `at` is the session's own start (any Date-parseable value); it defaults to
// now only when absent, so historical re-pricing stays historical.
function priceAt(model, at, speed) {
  const m = String(model || '').toLowerCase();
  if (!m) return UNKNOWN;
  // pg hands back started_at as a Date; everything else passes an ISO string.
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  const atMs = at == null || !Number.isFinite(t) ? Date.now() : t;
  const hit = (rule, tag) => ({ known: true, input: rule.price[0], output: rule.price[1],
    read: rule.read || CACHE_READ_MULT, rule: tag + rule.re.source });
  if (String(speed || '').toLowerCase() === 'fast') {
    for (const rule of FAST_RULES) if (rule.re.test(m)) return hit(rule, 'fast:');
  }
  for (const rule of RULES) if (rule.re.test(m) && inWindow(rule, atMs)) return hit(rule, '');
  return UNKNOWN;
}

// node-postgres returns bigint columns as STRINGS, and a laptop can report
// garbage; either way a counter must never make a bill negative or NaN.
const num = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };

// The cost of one session's counters at price `p`. When the 5m/1h split is
// present it is used; otherwise the flat creation total is priced at the
// legacy (1h) rate.
function usdAt(p, { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  cacheCreation5mTokens, cacheCreation1hTokens }) {
  const w5 = num(cacheCreation5mTokens), w1 = num(cacheCreation1hTokens);
  const writeUsd = (w5 + w1) > 0
    ? w5 * p.input * CACHE_WRITE_5M_MULT + w1 * p.input * CACHE_WRITE_1H_MULT
    : num(cacheCreationTokens) * p.input * CACHE_WRITE_LEGACY_MULT;
  const usd = (num(inputTokens) * p.input + writeUsd + num(cacheReadTokens) * p.input * p.read
    + num(outputTokens) * p.output) / 1e6;
  return Math.max(0, Math.round(usd * 1e6) / 1e6);   // round to micro-USD
}

function estimateCost({ model, at, speed, ...counters } = {}) {
  const p = priceAt(model, at, speed);
  return p.known ? usdAt(p, counters) : 0;
}

const FAST_KEYS = [['inputTokens', 'input'], ['outputTokens', 'output'], ['cacheReadTokens', 'cacheRead'],
  ['cacheCreationTokens', 'cacheCreation'], ['cacheCreation5mTokens', 'cacheCreation5m'], ['cacheCreation1hTokens', 'cacheCreation1h']];

// The cost of a whole session whose counters may mix standard and fast turns.
// `fast` holds the fast share of each counter (lib/sessionize.js fastTokens);
// it is priced at the fast rate and the remainder at the standard rate. With no
// fast share this is exactly estimateCost at standard speed.
function sessionCost({ model, at, fast, ...counters } = {}) {
  const f = fast || {};
  const standard = {};
  const fastPart = {};
  let anyFast = false;
  for (const [k, fk] of FAST_KEYS) {
    const share = Math.min(num(f[fk]), num(counters[k]));
    if (share > 0) anyFast = true;
    standard[k] = num(counters[k]) - share;
    fastPart[k] = share;
  }
  const std = estimateCost({ model, at, speed: 'standard', ...standard });
  if (!anyFast) return std;
  return Math.round((std + estimateCost({ model, at, speed: 'fast', ...fastPart })) * 1e6) / 1e6;
}

// What avoidable cache rebuilds cost over reading the same tokens from the
// cache: the money a better habit or setting would have kept. Tokens ship;
// this turns them into dollars with the same table as every other cost, on
// the laptop and again on the server (lib/price-book.js), so a stale plugin
// can never pin a wrong number. A fast-mode session is priced at the fast rate.
function rebuildAvoidableUsd({ model, at, speed, tokens5m, tokens1h } = {}) {
  const p = priceAt(model, at, speed === 'fast' ? 'fast' : undefined);
  if (!p.known) return 0;
  const usd = (num(tokens5m) * (CACHE_WRITE_5M_MULT - p.read) + num(tokens1h) * (CACHE_WRITE_1H_MULT - p.read)) * p.input / 1e6;
  return Math.max(0, Math.round(usd * 100) / 100);
}

// What the same session WOULD have cost without prompt caching: every cached
// token re-billed at full input price. The delta is the user's cache savings —
// a concrete "you saved $X" number for the report.
function costWithoutCache({ model, at, speed, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = {}) {
  const p = priceAt(model, at, speed);
  if (!p.known) return 0;
  const usd = ((num(inputTokens) + num(cacheCreationTokens) + num(cacheReadTokens)) * p.input
    + num(outputTokens) * p.output) / 1e6;
  return Math.max(0, Math.round(usd * 1e6) / 1e6);
}

// What a stored record would have cost with no caching, for the "caching
// saved you" figures. A plugin-1.8 record carries its tokens per phase and per
// model (subagents included, often on a cheaper model), so each model's
// tokens are priced at that model; pricing them all at the session's model
// overstated the saving by hundreds of dollars on a real session. Older
// records use their flat counters, as before.
function recordWithoutCacheUsd(rec) {
  const pc = rec && rec.phase_costs && typeof rec.phase_costs === 'object' ? rec.phase_costs : null;
  const rows = pc ? Object.values(pc).flatMap(p => (p && Array.isArray(p.by_model) ? p.by_model : [])) : [];
  if (!rows.length) {
    return costWithoutCache({ model: rec && rec.model, at: rec && rec.started_at, speed: rec && rec.speed,
      inputTokens: rec && rec.input_tokens, outputTokens: rec && rec.token_total,
      cacheReadTokens: rec && rec.cache_read_tokens, cacheCreationTokens: rec && rec.cache_creation_tokens });
  }
  const usd = rows.reduce((a, m) => a + costWithoutCache({ model: m.model, at: rec.started_at, speed: rec.speed,
    inputTokens: m.input, outputTokens: m.output, cacheReadTokens: m.cache_read,
    cacheCreationTokens: (Number(m.cache_write_5m) || 0) + (Number(m.cache_write_1h) || 0) }), 0);
  return Math.round(usd * 1e6) / 1e6;
}

module.exports = {
  RULES, FAST_RULES, priceAt, estimateCost, sessionCost, costWithoutCache, recordWithoutCacheUsd, canonicalModel, rebuildAvoidableUsd,
  CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_LEGACY_MULT, CACHE_READ_MULT,
};
