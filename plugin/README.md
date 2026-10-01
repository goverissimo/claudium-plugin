# Tokenomica — Claude Code usage plugin

Tokenomica is a team dashboard for Claude Code usage: sessions, costs, prompt
quality, burn rate, and coaching recommendations. This plugin uploads a
privacy-scrubbed usage record to your team’s Tokenomica dashboard as you work:
when a session ends, and every few minutes while sessions are open.

## Install

```
claude plugin marketplace add https://github.com/goverissimo/claudium-plugin.git
claude plugin install tokenomica@tokenomica
```

## Connect

```
/tokenomica:login https://your-dashboard.example.com
```

That opens a browser tab where you approve this machine, then writes
`~/.tokenomica/plugin.json` for you. Nothing to copy, no token in your shell
history. If no browser can open — over SSH, in a container, on a remote dev
box — it prints a short code you enter at `/activate` on any device instead.

The approval screen names the machine that asked (hostname, OS, plugin
version). If you didn't start it, deny it: nothing is shared.

Run it again any time to reconnect — after a revoked token, say. Everything
captured while you were disconnected is queued locally and uploads the moment
you do, and your existing settings (`tier`, `classify`, `project_labels`) are
preserved.

The config it writes looks like this, and you can still write it by hand for a
scripted or CI install (mint a token at **/connect**):

```
{ "url": "https://your-dashboard.example.com", "token": "<your token>" }
```

- `url` — your team’s dashboard origin.
- `token` — your personal sender token (revocable from /connect).
- `tier` — named sharing tier controlling what ships at all. See Sharing tier below.
- `classify` — set to `"off"` to disable session labeling entirely (default `"on"`). Independent of `tier`: even at tier `metrics` (which strips facts), classification still runs and still labels the session unless you also turn it off here. See Classification below.
- `anthropic_api_key` — optional; classify via the direct API instead of your Claude Code login. See Classification below.

Without this file the plugin does nothing — it never blocks or fails a session.

### Sharing tier

One knob controls what this machine ships: `"tier"` in `~/.tokenomica/plugin.json`
(or the `TOKENOMICA_TIER` environment variable, which overrides it). Five named
tiers, each a strict superset of the one before it:

| tier | usage records | session facts |
|---|---|---|
| `off` | none | none |
| `presence` | none | none |
| `activity` | none | none |
| `metrics` | yes | stripped |
| `full` (default) | yes | yes |

(`off`/`presence`/`activity` are equivalent on the plugin route — they only
differ for the sender's live-brain feed; see the main README's Sharing
detail section.) The default is `full`, matching what an unconfigured
install already shipped before this knob existed (Task 16 shipped session
facts by default) — nothing silently narrows or widens on upgrade.

Legacy config (no `tier` set, but you've historically relied on the sender's
`BRAIN_USAGE` env var) still resolves, conservatively, to the nearest tier
that ships no more than before, with a one-time warning naming the tier it
picked; set `tier` explicitly to silence it. `/tokenomica:status` shows the
resolved tier and its one-line meaning.

### Naming your projects

By default each project ships under a `p-<12hex>` pseudonym — a one-way hash of
the repo's git remote (see "Naming your projects across the team" below), or of
the local directory name when there is no remote. To ship a readable name
instead, add a `project_labels` map to `~/.tokenomica/plugin.json`, keyed by the
**repo name** (the last segment of the remote, e.g. `checkout` for
`git@github.com:acme/checkout.git`) and valued by the label you want it to ship
as. Because the repo name is identical on every machine, one config line can be
shared with the whole team. The old key — the local directory name — still
works as a fallback:

```
{ "url": "...", "token": "...", "project_labels": { "demo": "backend-team" } }
```

Each value is sanitized to lowercase `[a-z0-9._-]` and capped at 40
characters before it ships. A project with no matching entry, or whose
sanitized value ends up empty, still ships as the `p-<12hex>` pseudonym.

## Importing your existing history

Nothing about your past sessions ever uploads on its own. The first time the
plugin runs after setup with no import decision on record yet, it leaves a
one-time note (best-effort, on stderr — Claude Code doesn't surface a
SessionEnd hook's output to you, so don't expect to see it mid-session) and
otherwise does nothing; `/tokenomica:status` is where the pending state
actually shows up.

Run `/tokenomica:backfill` to import your existing session history now
(deterministic labels only — see Classification below — and subject to your
sharing tier: a tier below `metrics` ships nothing, and the command will say
so rather than import anything). Prefer not to import it at all? Run
`/tokenomica:backfill --skip` — that records your decision and stops the
notice for good, without uploading anything; you can still run
`/tokenomica:backfill` for real at any later time.

## Check it’s working

Run `/tokenomica:status` inside Claude Code — it shows your config target,
whether history has imported (pending / done / skipped by you), your plugin
version, how many sessions are waiting to upload, and whether the server
accepts your token. If anything is queued and you are online, running it
delivers the backlog then and there.

## Every session is captured

Sessions don't have to close to show up. People keep sessions open for days,
so besides the session-end upload the plugin also wakes when a session starts
and after each Claude reply, at most once every 10 minutes per machine, and
sends whatever is new: sessions that started since, and open sessions that
have done more work since they were last sent. It runs in the background and
never slows a reply.

The plugin does not fire a single upload and hope. When a session ends the
record is written to a durable queue on your machine **before** any network
call, and only leaves the queue once the dashboard has confirmed it. If you
were offline, on a VPN, mid-flight, or the dashboard was being redeployed, the
session waits and goes out on a later session end — with backoff, so a laptop
that has been offline for a fortnight doesn't hammer a dead endpoint.

It also **reconciles**. Some sessions never get a SessionEnd hook at all — a
force-quit, a dead battery, a closed lid, a CLI self-update. Each run compares
the transcripts on disk against the ones this machine has already queued and
picks up the difference, so a session is captured because its transcript
exists, not because a hook happened to survive.

Reconciliation never reaches back past the moment you connected: your existing
history still only moves when you run `/tokenomica:backfill`.

`/tokenomica:status` shows the queue (`upload queue: 0 pending` is the healthy
state) and will drain it on the spot if anything is waiting.

## Naming your projects across the team

Projects are identified by their **git remote**, not by the folder they happen
to live in on your machine. That means `~/src/checkout`, `~/work/checkout-svc`
and a `checkout-hotfix` worktree are all one project, and — more importantly —
so is your teammate's clone. Without this, the same repo showed up as a
different project for every person on the team and "what does this repo cost
us?" could not be answered at all.

What ships is still only a one-way hash: your remote URL, and any credentials
embedded in it, never leave your machine. The hash is keyed with a salt shared
by your team, which the plugin fetches once from your dashboard — nothing for
you to configure, and existing installs pick it up automatically.

A session outside a git repo, or one whose only remote is a local path, falls
back to the per-machine pseudonym as before.

## What gets uploaded

- Always: per-session usage metrics — model, token counts, cost estimates,
  timing, tool-use counts, and prompt-quality signals. Never source code.
- Raw transcripts never leave your machine, full stop — there is no
  transcript upload path. If classification is on (see below), a small set of
  gated, scrubbed facts about the session (what worked, what failed, skills
  and tools observed) rides along with the usage record; free text is
  redacted before it ever leaves.
- The SessionEnd hook always exits 0 — an unreachable dashboard or bad config
  never breaks your Claude Code session, and never costs you the session's
  record either (see "Every session is captured" above).
- Which skills and MCP servers a session used, with call counts. Names from
  Anthropic's official plugin directory and Claude Code's own skills are sent
  as-is (e.g. `superpowers:brainstorming`, `figma`); any other name is sent
  only as a keyed hash, so a private skill can be counted but never named.
- Cache rebuilds (counts and tokens by likely cause) and how many times Claude
  Code showed a usage-limit notice. Numbers only.
- A keyed hash of your git branch, so sessions on the same branch can be
  grouped without the branch name leaving your machine.
- Only if an admin of your organization turns on **sharing git refs** (off by
  default; Team page on the dashboard): the branch name and each task's short
  commit ids, so a session links to the commits it produced. Commit messages,
  diffs and file contents never leave your machine either way.
- Cost estimates are recomputed by the dashboard from the token counts you
  send, using a price table it owns. That means a new model is never silently
  mispriced by an out-of-date plugin, and a pricing correction fixes your whole
  history rather than only what you send from then on.

## Classification

Each session is labeled with an activity category and domain (e.g.
"debugging · backend"). Auth ladder, in order: an explicit
`anthropic_api_key` (below) always wins first and classifies via the direct
API; otherwise labeling runs via your own Claude Code login — a pinned model
(`claude-haiku-4-5`) invoked headlessly through the `claude` CLI, billed to
whatever auth your CLI already resolves — we never read OAuth tokens or the
keychain directly. The model is pinned, not configurable, so labels stay
comparable across everyone on your team. If neither rung produces a usable
label (no key, no login, timeout, or CLI failure), the session falls back to
a deterministic tool-mix guess; that fallback is excluded from cross-session
benchmarks, since it isn't a real label. As of June 15, 2026, Anthropic's
subscription plans give print-mode/SDK usage — which is what this headless
call is — its own separate monthly credit, distinct from interactive Claude
Code usage.

Turn classification off entirely with `"classify": "off"` in
`~/.tokenomica/plugin.json`, or set `"anthropic_api_key": "sk-…"` there to
classify via the direct API instead of your login. Cost accounting covers
the headless (subscription) rung: each headless classification's cost is
recorded locally, and `/tokenomica:status` shows the current mode, the last
label produced, and the last classification's cost. API-key classification
does not report cost yet — status shows 0 for it.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
