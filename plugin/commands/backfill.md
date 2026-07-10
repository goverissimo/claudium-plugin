---
description: Import your existing Claude Code session history into your Claudium dashboard (deterministic labels only, tier-gated), or decline with --skip
---

Claudium history backfill:

!`node "${CLAUDE_PLUGIN_ROOT}/upload-session.js" --backfill $ARGUMENTS`

Relay the output above to the user verbatim. If it shows `config: missing`,
point them to their Claudium dashboard’s /connect page. `--skip` (as in
`/claudium:backfill --skip`) records that the user declined without
importing anything, and stops the pending notice for good — the user can
still run `/claudium:backfill` again later to import. Do not add
interpretation beyond that.
