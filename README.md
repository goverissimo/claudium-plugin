# Claudium — Claude Code usage plugin

Claudium is a team dashboard for Claude Code usage: sessions, costs, prompt
quality, burn rate, and coaching recommendations. This plugin uploads a
privacy-scrubbed usage record to your team’s Claudium dashboard every time a
Claude Code session ends.

## Install

```
claude plugin marketplace add goverissimo/claudium-plugin
claude plugin install claudium@claudium
```

## Configure

Sign in to your team’s Claudium dashboard, open **/connect**, claim your
display name, and generate a token. Then write the config exactly as the
page shows you:

```
mkdir -p ~/.claudium && cat > ~/.claudium/plugin.json <<'EOF'
{ "url": "https://your-dashboard.example.com", "token": "<your token>", "transcripts": false }
EOF
```

- `url` — your team’s dashboard origin.
- `token` — your personal sender token (revocable from /connect).
- `transcripts` — set `true` to also upload redacted transcripts (opt-in).

Without this file the plugin does nothing — it never blocks or fails a session.

## Your history imports automatically

The first time the plugin runs after setup, it uploads your existing session
history in the background — nothing to run. To import immediately instead:

```
node "$(ls -d ~/.claude/plugins/cache/claudium/claudium/*/ 2>/dev/null | tail -1)upload-session.js" --backfill
```

## Check it’s working

Run `/claudium:status` inside Claude Code — it shows your config target,
whether history has imported, and whether the server accepts your token.

## What gets uploaded

- Always: per-session usage metrics — model, token counts, cost estimates,
  timing, tool-use counts, and prompt-quality signals. Never source code.
- Only when `transcripts: true`: session transcripts with secrets, keys, and
  e-mail addresses scrubbed before they leave your machine.
- The SessionEnd hook always exits 0 — an unreachable dashboard or bad config
  never breaks your Claude Code session.
