---
description: Connect this machine to your team's Tokenomica dashboard — opens a browser to approve, then writes your config automatically
---

Tokenomica sign-in:

!`node "${CLAUDE_PLUGIN_ROOT}/login.js" --login $ARGUMENTS`

Relay the output above to the user verbatim — the approval URL and the code
must reach them exactly as printed, since they may need to type the code on a
different device (this is the normal path when Claude Code is running over SSH
or in a container, where no browser can be opened locally).

If it printed `Usage:`, the user needs to pass their dashboard URL, e.g.
`/tokenomica:login https://tokenomica.your-company.com` — whoever set the team
up has that link. Once connected, a later `/tokenomica:login` needs no URL.

Do not add interpretation beyond that, and never repeat the token or config
contents back to the user — the command writes them itself.
