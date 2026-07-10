// SPDX-License-Identifier: Apache-2.0
// lib/pricing.js — rough USD cost estimate from token counts. Pure.
//
// List prices change over time and vary by tier — treat this as an ESTIMATE,
// not a bill. Update PRICES when Anthropic's published rates change. For the
// authoritative number, the org Admin cost API is the source of truth; this is
// the local, no-network approximation the sender can compute for free.
//
// Cache pricing model (approximate): cache *writes* cost ~1.25x input (5-minute
// tier), cache *reads* cost ~0.1x input. We aggregate creation tokens without
// splitting 5m/1h, so creation is approximated at 1.25x input.

// [inputPerMTok, outputPerMTok] in USD — current published rates (2026-05).
// Order matters: first regex match wins, so put the most specific first.
const MODEL_PRICES = [
  [/fable/, [10, 50]],
  [/opus-4-[678]/, [5, 25]],     // Opus 4.6 / 4.7 / 4.8
  [/opus/, [15, 75]],            // older Opus (4.5 and earlier)
  [/haiku/, [1, 5]],
  [/sonnet/, [3, 15]],
];

const DEFAULT_PRICE = [3, 15];   // unknown -> mid-tier (Sonnet) assumption

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, price] of MODEL_PRICES) {
    if (re.test(m)) return price;
  }
  return DEFAULT_PRICE;
}

function estimateCost({ model, inputTokens = 0, outputTokens = 0,
  cacheReadTokens = 0, cacheCreationTokens = 0 } = {}) {
  const [inP, outP] = priceFor(model);
  const usd = (
    inputTokens * inP +
    cacheCreationTokens * inP * 1.25 +
    cacheReadTokens * inP * 0.10 +
    outputTokens * outP
  ) / 1e6;
  return Math.max(0, Math.round(usd * 1e6) / 1e6);   // round to micro-USD
}

// What the same session WOULD have cost without prompt caching: every cached
// token re-billed at full input price. The delta is the user's cache savings —
// a concrete "you saved $X" number for the report.
function costWithoutCache({ model, inputTokens = 0, outputTokens = 0,
  cacheReadTokens = 0, cacheCreationTokens = 0 } = {}) {
  const [inP, outP] = priceFor(model);
  // node-postgres returns bigint columns as STRINGS — coerce before any
  // arithmetic so raw pg rows (e.g. via narrate() from /api/team/analytics)
  // don't silently string-concatenate into an absurd number.
  const iT = Number(inputTokens) || 0;
  const oT = Number(outputTokens) || 0;
  const rT = Number(cacheReadTokens) || 0;
  const cT = Number(cacheCreationTokens) || 0;
  const usd = (
    (iT + cT + rT) * inP +
    oT * outP
  ) / 1e6;
  return Math.max(0, Math.round(usd * 1e6) / 1e6);
}

module.exports = { estimateCost, costWithoutCache, priceFor, MODEL_PRICES };
