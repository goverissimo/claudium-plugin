// SPDX-License-Identifier: Apache-2.0
// lib/extensions.js — which skills, plugins and MCP servers a session used,
// in a form that can leave the machine.
//
// A skill or server name can identify a company ("acme-deploy", an internal
// MCP server). So a name ships readable only when it is PUBLIC:
//   - one of Claude Code's own built-in skills, or
//   - a skill, command or MCP server that actually exists inside a plugin
//     installed from Anthropic's official directory (claude-plugins-official),
//     matched by its FULL name, or
//   - a claude.ai directory connector on the known list below.
// Matching the plugin name alone is not enough: the official directory has
// generic plugin names ("data", "github", "slack"), and an internal plugin
// with the same name from another marketplace would otherwise ship its
// private skill names readable. Everything else ships as an HMAC of the name
// with the org's project salt, so a team can still count "the same internal
// skill" across people without anyone outside learning its name.
//
// Pure except for publicCatalog(), which reads the installed official plugins
// once per process. Node builtins only (this file ships in the plugin).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { hmac12 } = require('./anonymize');

// Claude Code's bundled skills. Public by construction: every Claude Code
// user has them.
const BUILTIN_SKILLS = new Set([
  'batch', 'code-review', 'doctor', 'fewer-permission-prompts', 'insights', 'run',
  'run-skill-generator', 'simplify', 'skill-doctor', 'team-onboarding', 'verify',
  'artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'dataviz', 'workshop',
  'workflow-authoring',
]);
// Servers Claude Code and the Claude apps provide themselves.
const BUILTIN_MCP = new Set(['claude-in-chrome', 'claude_browser', 'claude-browser']);
// claude.ai connectors show up as "claude_ai_<Connector_Name>". The public
// directory connectors are listed here (lowercased); a custom connector an
// org adds under its own name is not, so it hashes.
const CLAUDE_AI_CONNECTORS = new Set([
  'airtable', 'asana', 'atlassian', 'box', 'canva', 'claude_docs', 'clickup', 'cloudflare',
  'confluence', 'dropbox', 'figma', 'gamma', 'github', 'gmail', 'google_calendar', 'google_drive',
  'higgsfield', 'hubspot', 'intercom', 'jira', 'linear', 'monday', 'netlify', 'notion', 'paypal',
  'plaid', 'salesforce', 'sentry', 'slack', 'slack_beta', 'square', 'stripe', 'supabase', 'vercel',
  'webflow', 'zapier',
]);

const OFFICIAL = 'claude-plugins-official';
const WALK_MAX = 4000;   // directory entries per plugin; plugins are small

function frontmatterName(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(head);
    const n = m && /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(m[1]);
    return n ? n[1].trim().toLowerCase() : '';
  } catch { return ''; }
}

function mcpServerKeys(installPath) {
  const keys = new Set();
  const add = (obj) => { if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const k of Object.keys(obj)) keys.add(k.toLowerCase()); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const root = readJson(path.join(installPath, '.mcp.json'));
  if (root) add(root.mcpServers || root);
  const pj = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const decl = pj && pj.mcpServers;
  if (typeof decl === 'string') {
    const f = readJson(path.join(installPath, decl));
    if (f) add(f.mcpServers || f);
  } else add(decl);
  return keys;
}

// Every skill/command name inside one plugin: SKILL.md files (by frontmatter
// name and by folder name) and commands/*.md.
function skillNames(installPath) {
  const names = new Set();
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || seen > WALK_MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > WALK_MAX) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'SKILL.md') {
        names.add(path.basename(dir).toLowerCase());
        const fm = frontmatterName(p);
        if (fm) names.add(fm);
      }
    }
  };
  walk(installPath, 0);
  try {
    for (const f of fs.readdirSync(path.join(installPath, 'commands'))) {
      if (f.endsWith('.md')) names.add(f.slice(0, -3).toLowerCase());
    }
  } catch { /* no commands */ }
  return names;
}

// { skills: Set('plugin:skill'), servers: Set('plugin_<plugin>_<server>' and
// '<server>') } for every plugin installed from the official directory.
let cachedCatalog = null;
function publicCatalog({ home = os.homedir(), claudeDir } = {}) {
  if (cachedCatalog && !claudeDir) return cachedCatalog;
  const dir = claudeDir || path.join(home, '.claude');
  const skills = new Set(), servers = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, installs] of Object.entries((j && j.plugins) || {})) {
      const at = key.lastIndexOf('@');
      if (at < 1 || key.slice(at + 1) !== OFFICIAL) continue;
      const plugin = key.slice(0, at).toLowerCase();
      for (const inst of Array.isArray(installs) ? installs : []) {
        const p = inst && typeof inst.installPath === 'string' ? inst.installPath : '';
        if (!p) continue;
        for (const s of skillNames(p)) skills.add(`${plugin}:${s}`);
        for (const s of mcpServerKeys(p)) { servers.add(`plugin_${plugin}_${s}`); servers.add(s); }
      }
    }
  } catch { /* nothing installed or unreadable: nothing is public, everything hashes */ }
  const out = { skills, servers };
  if (!claudeDir) cachedCatalog = out;
  return out;
}

const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const EMPTY = { skills: new Set(), servers: new Set() };

function isPublicSkill(name, catalog = EMPTY) {
  const n = String(name || '').toLowerCase();
  if (!NAME_RE.test(n)) return false;
  if (!n.includes(':')) return BUILTIN_SKILLS.has(n);
  return catalog.skills.has(n);
}

function isPublicMcp(server, catalog = EMPTY) {
  const n = String(server || '').toLowerCase();
  if (!NAME_RE.test(n)) return false;
  if (BUILTIN_MCP.has(n)) return true;
  if (n.startsWith('claude_ai_')) return CLAUDE_AI_CONNECTORS.has(n.slice(10));
  return catalog.servers.has(n);
}

// [{ name, calls }] -> [{ name, calls }] where name is readable or 'h:<hash>'.
// Without a salt, private names are dropped rather than shipped raw.
function shipExtensionCalls(list, { salt, kind, catalog, cap = 20 } = {}) {
  const cat = catalog || publicCatalog();
  const isPublic = kind === 'mcp' ? isPublicMcp : isPublicSkill;
  const out = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.name !== 'string') continue;
    const calls = Number.isInteger(x.calls) && x.calls > 0 ? x.calls : 0;
    if (!calls) continue;
    const lower = x.name.toLowerCase();
    let key;
    if (isPublic(lower, cat)) key = lower;
    else if (salt) key = 'h:' + hmac12(salt, lower);
    else continue;
    out.set(key, (out.get(key) || 0) + calls);
  }
  return [...out].map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls).slice(0, cap);
}

module.exports = { shipExtensionCalls, isPublicSkill, isPublicMcp, publicCatalog, BUILTIN_SKILLS, CLAUDE_AI_CONNECTORS, NAME_RE };
