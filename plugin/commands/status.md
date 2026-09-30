---
description: Show Tokenomica upload status — config, history import, classification mode and last cost, server connectivity
---

Tokenomica upload status:

!`node "${CLAUDE_PLUGIN_ROOT}/upload-session.js" --status`

Relay the output above to the user verbatim.

- `config: missing` or `token rejected` → point them to
  `/tokenomica:login <dashboard-url>`, which connects the machine in one step.
- `history import: pending` → `/tokenomica:backfill` (or `--skip` to decline).
- `upload queue: N pending` with N > 0 → this is normal right after being
  offline; the queue drains on its own and running this command drains it now.
  Only flag it if the oldest entry is more than a few days old, which means
  something is persistently wrong.

Do not add interpretation beyond that.
