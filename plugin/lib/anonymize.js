// SPDX-License-Identifier: Apache-2.0
// lib/anonymize.js — per-machine HMAC pseudonymization.
//
// Raw, potentially-identifying names (project directory names today; MCP
// tool names and subagent types in a later pass) never leave this machine —
// only a stable, one-way hash of them does. The salt that makes the hash
// unforgeable ALSO never leaves this machine: it lives in a single file,
// `<dir>/salt` (default ~/.tokenomica/salt, or the adopted ~/.claudium of a
// pre-rename install — see lib/config-dir.js), created once with
// crypto.randomBytes and mode 0600, then reused forever. Same name + same
// machine salt => same hash every time (so downstream grouping/threading
// still works on the pseudonym) — but nobody without the salt can recover
// the raw name from the hash.
//
// Pure except for loadSalt, the one fs-touching helper here. Only Node
// builtins plus the sibling ./config-dir (also vendored into the plugin, see
// scripts/build-plugin.js), so this file can be vendored as-is.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { configDir } = require('./config-dir');

// hmac12(salt, value) -> first 12 lowercase hex chars of an HMAC-SHA256 of
// value, keyed by salt. 12 hex chars (48 bits) is plenty to dedupe/group
// within one machine's projects/tools without being a meaningfully
// reversible fingerprint.
function hmac12(salt, value) {
  return crypto.createHmac('sha256', String(salt || ''))
    .update(String(value == null ? '' : value))
    .digest('hex')
    .slice(0, 12)
    .toLowerCase();
}

// loadSalt(dir = configDir()) -> the per-machine salt, creating it on first
// use (32 random bytes -> 64 hex chars, file mode 0600). Never regenerated
// once a usable value is written, so hashes of the same raw name stay
// stable across runs. Creation is race-safe: the write uses the exclusive
// 'wx' flag, so if a concurrent process (the sender daemon and the plugin
// hook can both fire) wins the create between our read and our write, we
// adopt ITS salt instead of clobbering the file with a second, different one.
//
// A file's content counts as a salt only if it's non-empty after trim.
// Garbage-but-nonempty content is kept as-is — pseudonym stability matters
// more than format purity (someone may already have hashes keyed by it).
// An empty/whitespace-only file (e.g. left behind by an ENOSPC-interrupted
// first create) holds no salt worth preserving, so it is REPAIRED with a
// fresh salt via a plain clobbering write — loadSalt never returns a
// falsy/whitespace value.
function loadSalt(dir = configDir()) {
  const file = path.join(dir, 'salt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* missing/unreadable — create one below */ }
  const salt = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, salt, { flag: 'wx', mode: 0o600 });
    return salt;
  } catch {
    // The exclusive create collided: either a concurrent winner wrote a real
    // salt (adopt it), or the existing file is the empty husk we read above
    // (repair it — clobbering an empty file loses nothing).
    let winner = '';
    try { winner = fs.readFileSync(file, 'utf8').trim(); } catch {}
    if (winner) return winner;
    fs.writeFileSync(file, salt, { mode: 0o600 });
    return salt;
  }
}

// sanitizeLabel(v) -> a label made safe to ship AND readable locally:
// lowercased, whitespace runs become single dashes BEFORE the strip (so
// word boundaries survive: 'MyClient Corp' -> 'myclient-corp'), everything
// else outside [a-z0-9._-] is dropped, capped at 40 chars, and must start
// with an alphanumeric char after cleanup — '' if nothing valid survives
// (callers fall back to the HMAC pseudonym in that case).
//
// Accepted ambiguity: a user-assigned label may itself look exactly like
// the pseudonym shape (e.g. 'p-0123456789ab'). Both forms pass the same
// downstream gate and the hub never interprets either form, so nothing
// breaks — the label is simply indistinguishable from a hash on the wire.
const LABEL_SHAPE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
function sanitizeLabel(v) {
  const s = String(v == null ? '' : v).toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
  return LABEL_SHAPE_RE.test(s) ? s : '';
}

module.exports = { hmac12, loadSalt, sanitizeLabel };
