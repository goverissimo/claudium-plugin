---
description: Re-check code survival for your aged Tokenomica sessions (git blame, numbers only) right now, instead of waiting for it to happen automatically a few at a time.
---

Tokenomica deferred re-survey:

!`node "${CLAUDE_PLUGIN_ROOT}/upload-session.js" --resurvey`

Relay the output above to the user verbatim. If it shows `Not connected — run
/tokenomica:status`, point them there first. This re-runs numbers-only git
blame (lines added, lines still surviving, reverts) for local sessions that
are at least 7 days old and re-uploads the updated counts — nothing but
counts ever leaves the machine. It normally happens automatically, a few
sessions at a time, whenever a session ends; use this to drain the whole
backlog on demand. Do not add interpretation beyond that.
