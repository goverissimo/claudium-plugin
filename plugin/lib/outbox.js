// SPDX-License-Identifier: Apache-2.0
// lib/outbox.js — the durable at-least-once queue every usage record ships
// through.
//
// WHY THIS EXISTS: uploads used to be a single fire-and-forget POST. If it
// failed — offline, VPN, dashboard mid-deploy, laptop asleep, token lapsed —
// the record was gone forever and the only trace was a line on a stderr that
// Claude Code never shows anyone. For a token tracker that is the worst
// possible failure mode, because the loss is BIASED: it correlates with
// travel, with flaky networks, with whoever's token expired. Spend is then
// under-reported by an unknown amount, in an unknown direction, and the
// dashboard looks perfectly healthy while being wrong.
//
// The contract here is simple and deliberately boring:
//   1. The record is written to disk BEFORE any network call. Once enqueue()
//      returns, the session is safe even if the process dies on the next line.
//   2. Delivery is retried with exponential backoff across later runs. The
//      SessionEnd finisher drains a bounded slice each time, so a two-week
//      offline backlog costs a few hundred ms per session rather than one
//      enormous stall.
//   3. Only genuinely permanent failures (malformed record, payload too big)
//      are given up on, and even those are moved to dead/ where they can be
//      inspected — never silently deleted.
//
// IDEMPOTENCY: the queue is keyed by claude_session_id, which is also the
// server's upsert key. That makes the two properties we need fall out for
// free — re-delivering a record is harmless, and enqueueing an ENRICHED
// version of a session that is still pending simply replaces the older,
// poorer copy in place instead of racing it.
//
// Pure except for fs. Node builtins only, so it vendors into the plugin as-is
// (scripts/build-plugin.js PLUGIN_LIB_FILES).

const fs = require('fs');
const path = require('path');

const ENTRY_VERSION = 1;

// Backoff schedule by attempt count, in ms. Front-loaded because the single
// most common failure is a brief blip (a redeploy, a tunnel reconnect) that
// the very next session end would clear; the long tail exists so a laptop
// that is genuinely offline for a fortnight doesn't hammer a dead endpoint.
const BACKOFF_MS = [
  60 * 1000,          // 1m
  5 * 60 * 1000,      // 5m
  15 * 60 * 1000,     // 15m
  60 * 60 * 1000,     // 1h
  6 * 60 * 60 * 1000, // 6h
  24 * 60 * 60 * 1000 // 24h, and every attempt after
];
const MAX_ATTEMPTS = 25;        // ~3 weeks at the tail rate before dead-lettering
const MAX_PENDING = 5000;       // hard cap; oldest spill to dead/ (see enqueue)

// Statuses that will NEVER succeed on retry: the record itself is the
// problem, so retrying just burns battery. Everything else — including 401/403
// — is treated as recoverable, because "token rejected" is fixed by the user
// minting a new one at /connect and we want the backlog waiting when they do.
const PERMANENT_STATUSES = new Set([400, 413, 422]);

const outboxDir = (dir) => path.join(dir, 'outbox');
const deadDir = (dir) => path.join(outboxDir(dir), 'dead');

// A session id is used directly as a filename, so it must not be able to
// escape the outbox directory. scrub.js already constrains the field to
// /^[0-9a-f-]{8,80}$/, but this queue must be safe on its own terms — it is
// the last thing standing between a hostile/buggy caller and an arbitrary
// file write.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const safeId = (id) => {
  const s = String(id == null ? '' : id);
  return SAFE_ID_RE.test(s) && !s.includes('..') ? s : '';
};

// attempts is the count AFTER the failure just recorded, so the first failure
// (attempts === 1) must wait BACKOFF_MS[0]. Indexing by `attempts` directly
// would skip the front-loaded 1-minute step and make the very first retry —
// the one that clears the common case of a brief blip — wait five minutes.
function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

// Atomic write: a half-written entry that a crash left behind would be parsed
// as corrupt and dropped, silently losing the very session this file exists to
// protect. Write to a temp name in the same directory, then rename (atomic on
// every platform we run on).
function writeEntryAtomic(file, entry) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readEntry(file) {
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!e || typeof e !== 'object' || !e.record) return null;
    return e;
  } catch { return null; }
}

function entryFiles(dir) {
  try {
    return fs.readdirSync(outboxDir(dir))
      .filter(f => f.endsWith('.json'))
      .sort();                       // stable, and ~chronological for uuid-v7-ish ids
  } catch { return []; }
}

// enqueue(record, { dir, now }) -> the entry's id, or '' if it could not be
// persisted. A FALSY RETURN IS A REAL FAILURE the caller must surface — it
// means this session is not yet safe on disk.
//
// Re-enqueueing a session id that is already pending REPLACES it: the newer
// record is by construction the better one (day-0 deterministic -> enriched
// with classification -> re-surveyed with git truth), and they all collapse
// to the same server-side upsert anyway. attempts/firstQueuedAt carry over so
// replacing a struggling entry can't reset its backoff into a hot loop.
function enqueue(record, { dir, now = Date.now() } = {}) {
  const id = safeId(record && record.claude_session_id);
  if (!id) return '';
  try {
    fs.mkdirSync(outboxDir(dir), { recursive: true });
    const file = path.join(outboxDir(dir), `${id}.json`);
    const prev = readEntry(file);
    writeEntryAtomic(file, {
      v: ENTRY_VERSION,
      id,
      record,
      attempts: prev ? (prev.attempts || 0) : 0,
      firstQueuedAt: prev ? (prev.firstQueuedAt || now) : now,
      nextAttemptAt: prev ? (prev.nextAttemptAt || 0) : 0,
      lastError: prev ? (prev.lastError || '') : '',
    });
    enforceCap(dir, now);
    return id;
  } catch { return ''; }
}

// The cap is a safety valve, not a normal path: it only trips if a machine
// has been unable to deliver for a very long time. Spilling to dead/ (rather
// than deleting) keeps the "nothing is ever silently discarded" promise.
function enforceCap(dir, now) {
  const files = entryFiles(dir);
  if (files.length <= MAX_PENDING) return;
  const excess = files
    .map(f => ({ f, e: readEntry(path.join(outboxDir(dir), f)) }))
    .sort((a, b) => ((a.e && a.e.firstQueuedAt) || 0) - ((b.e && b.e.firstQueuedAt) || 0))
    .slice(0, files.length - MAX_PENDING);
  for (const { f, e } of excess) {
    toDead(dir, path.join(outboxDir(dir), f), e, 'outbox_full', now);
  }
}

function toDead(dir, file, entry, reason, now) {
  try {
    fs.mkdirSync(deadDir(dir), { recursive: true });
    const name = path.basename(file);
    if (entry) {
      writeEntryAtomic(path.join(deadDir(dir), name),
        { ...entry, deadReason: reason, deadAt: new Date(now).toISOString() });
    }
    fs.unlinkSync(file);
  } catch { /* best-effort; a stuck entry simply retries next run */ }
}

// pendingCount(dir) -> how many sessions are still undelivered. This is the
// number /tokenomica:status surfaces: the whole point of the queue is that a
// backlog is VISIBLE rather than being silent data loss.
function pendingCount(dir) {
  return entryFiles(dir).length;
}

// remove(dir, id) -> true if an entry was deleted. For the caller that
// delivered a record itself rather than through drain(): it must be able to
// retire THAT specific entry. (drain() processes whichever entries are due, so
// using it to "clear the one I just sent" would retire an unrelated session.)
function remove(dir, id) {
  const safe = safeId(id);
  if (!safe) return false;
  try { fs.unlinkSync(path.join(outboxDir(dir), `${safe}.json`)); return true; }
  catch { return false; }
}

// pendingIds(dir) -> Set of session ids currently awaiting delivery. The
// reconciliation sweep (lib/session-ledger.js) needs this so it never
// re-queues a session that is already sitting here waiting on backoff — which
// would reset nothing but would make the "missed sessions" count lie.
function pendingIds(dir) {
  return new Set(entryFiles(dir).map(f => f.replace(/\.json$/, '')));
}

function deadCount(dir) {
  try { return fs.readdirSync(deadDir(dir)).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

// oldestPendingAt(dir) -> ISO time the oldest undelivered record was queued,
// or ''. Age is the honest health signal — "3 pending" is fine if they are
// from the last minute and alarming if the oldest is eleven days old.
function oldestPendingAt(dir) {
  let oldest = Infinity;
  for (const f of entryFiles(dir)) {
    const e = readEntry(path.join(outboxDir(dir), f));
    if (e && e.firstQueuedAt && e.firstQueuedAt < oldest) oldest = e.firstQueuedAt;
  }
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : '';
}

// drain({ dir, post, max, now }) -> { sent, retry, dead, remaining, lastError }
//
// post(record) must resolve to { ok, status } and must NOT throw for ordinary
// network failure — a throw is caught here and treated as retryable, which is
// the correct reading of ECONNREFUSED/ETIMEDOUT/DNS failure.
//
// `max` bounds the work one run does. Entries whose backoff has not elapsed
// are skipped without counting against it, so a large backlog of not-yet-due
// entries never starves the ones that are.
async function drain({ dir, post, max = 25, now = Date.now() } = {}) {
  const out = { sent: 0, retry: 0, dead: 0, remaining: 0, lastError: '' };
  if (typeof post !== 'function') { out.remaining = pendingCount(dir); return out; }
  let budget = max;
  for (const f of entryFiles(dir)) {
    const file = path.join(outboxDir(dir), f);
    const entry = readEntry(file);
    if (!entry) {                                  // corrupt/partial — not recoverable
      toDead(dir, file, { id: f.replace(/\.json$/, '') }, 'unreadable', now);
      out.dead++;
      continue;
    }
    if (budget <= 0) { out.remaining++; continue; }
    if (entry.nextAttemptAt && entry.nextAttemptAt > now) { out.remaining++; continue; }
    budget--;

    let res = null, threw = '';
    try { res = await post(entry.record); }
    catch (e) { threw = (e && e.message) || String(e); }

    if (res && res.ok) {
      try { fs.unlinkSync(file); } catch { /* delivered is delivered */ }
      out.sent++;
      continue;
    }

    const status = res && res.status;
    const reason = threw || (status ? `http ${status}` : 'no response');
    out.lastError = reason;

    if (status && PERMANENT_STATUSES.has(status)) {
      toDead(dir, file, entry, reason, now);
      out.dead++;
      continue;
    }

    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      toDead(dir, file, entry, `${reason} (gave up after ${attempts})`, now);
      out.dead++;
      continue;
    }
    try {
      writeEntryAtomic(file, {
        ...entry, attempts, lastError: reason, nextAttemptAt: now + backoffFor(attempts),
      });
    } catch { /* entry stays as-is and retries next run */ }
    out.retry++;
    out.remaining++;
  }
  return out;
}

module.exports = {
  enqueue, drain, remove, pendingCount, pendingIds, deadCount, oldestPendingAt,
  outboxDir, deadDir, BACKOFF_MS, MAX_ATTEMPTS, MAX_PENDING, PERMANENT_STATUSES,
};
