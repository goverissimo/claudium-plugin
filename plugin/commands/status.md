---
description: Show Claudium upload status — config, history import, server connectivity
---

Claudium upload status:

!`node "${CLAUDE_PLUGIN_ROOT}/upload-session.js" --status`

Relay the output above to the user verbatim. If it shows `missing`, `pending`,
`token rejected`, or `unreachable`, point them to their Claudium dashboard’s
/connect page for setup and token minting. Do not add interpretation beyond that.
