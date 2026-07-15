# Tokenomica — Claude Code usage plugin

Tokenomica is a team dashboard for Claude Code usage: sessions, costs, prompt
quality, burn rate, and coaching recommendations. This plugin uploads a
privacy-scrubbed usage record to your team’s Tokenomica dashboard every time a
Claude Code session ends.

## Install

```
claude plugin marketplace add goverissimo/claudium-plugin
claude plugin install tokenomica@tokenomica
```

## Configure

Sign in to your team’s Tokenomica dashboard, open **/connect**, claim your
display name, and generate a token. Then write the config exactly as the
page shows you:

```
mkdir -p ~/.tokenomica && cat > ~/.tokenomica/plugin.json <<'EOF'
{ "url": "https://your-dashboard.example.com", "token": "<your token>" }
EOF
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

By default each project ships under a `p-<12hex>` pseudonym: an HMAC of the
derived project name (the last path segment), unique per machine. To ship a readable name instead, add a
`project_labels` map to `~/.tokenomica/plugin.json`, keyed by the project name
Claude Code derives internally (usually the last path segment of the
project directory) and valued by the label you want it to ship as:

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
whether history has imported (pending / done / skipped by you), and whether
the server accepts your token.

## What gets uploaded

- Always: per-session usage metrics — model, token counts, cost estimates,
  timing, tool-use counts, and prompt-quality signals. Never source code.
- Raw transcripts never leave your machine, full stop — there is no
  transcript upload path. If classification is on (see below), a small set of
  gated, scrubbed facts about the session (what worked, what failed, skills
  and tools observed) rides along with the usage record; free text is
  redacted before it ever leaves.
- The SessionEnd hook always exits 0 — an unreachable dashboard or bad config
  never breaks your Claude Code session.

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
