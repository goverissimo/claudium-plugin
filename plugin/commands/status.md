---
description: Show Tokenomica upload status — config, history import, classification mode and last cost, server connectivity
---

Tokenomica upload status:

!`node "${CLAUDE_PLUGIN_ROOT}/upload-session.js" --status`

Relay the output above to the user verbatim. If it shows `missing`, `pending`,
`token rejected`, or `unreachable`, point them to their Tokenomica dashboard’s
/connect page for setup and token minting. Do not add interpretation beyond that.
