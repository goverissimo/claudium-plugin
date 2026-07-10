// SPDX-License-Identifier: Apache-2.0
// lib/regions.js — maps Claude Code tool names to brain regions.

const TOOL_REGION = {
  Read: 'visual',
  Glob: 'visual',
  Grep: 'visual',
  LS: 'visual',
  NotebookRead: 'visual',

  Write: 'motor',
  Bash: 'motor',
  BashOutput: 'motor',
  KillShell: 'motor',
  KillBash: 'motor',
  SlashCommand: 'motor',

  Edit: 'cerebellum',
  MultiEdit: 'cerebellum',
  NotebookEdit: 'cerebellum',

  Task: 'prefrontal',
  TodoWrite: 'prefrontal',
  ExitPlanMode: 'prefrontal',

  WebSearch: 'temporal',
  WebFetch: 'temporal',
};

const REGION_KEYS = new Set([
  'prefrontal', 'motor', 'parietal', 'visual',
  'broca', 'wernicke', 'temporal', 'cerebellum',
]);

function toolToRegion(name) {
  if (TOOL_REGION[name]) return TOOL_REGION[name];
  return 'parietal'; // MCP tools and unknown integrations
}

module.exports = { TOOL_REGION, REGION_KEYS, toolToRegion };
