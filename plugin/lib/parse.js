// lib/parse.js — turns Claude Code JSONL transcript lines into brain events.

const os = require('os');
const path = require('path');
const { toolToRegion } = require('./regions');

function shortPath(p) {
  if (!p) return '';
  const home = os.homedir();
  let s = p.replace(home, '~');
  const parts = s.split(/[/\\]/).filter(Boolean);
  if (parts.length > 3) return '…/' + parts.slice(-2).join('/');
  return s;
}

function describeTool(block) {
  const name = block.name;
  const input = block.input || {};
  switch (name) {
    case 'Read': return `Reading ${shortPath(input.file_path)}`;
    case 'Write': return `Writing ${shortPath(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Editing ${shortPath(input.file_path)}`;
    case 'NotebookEdit': return `Notebook edit ${shortPath(input.notebook_path)}`;
    case 'Glob': return `Glob ${input.pattern || ''}`;
    case 'Grep': return `Grep "${(input.pattern || '').slice(0, 28)}"`;
    case 'LS': return `Listing ${shortPath(input.path)}`;
    case 'Bash': return `$ ${(input.command || '').slice(0, 48)}`;
    case 'BashOutput': return 'Reading shell output';
    case 'WebSearch': return `Searching: ${(input.query || '').slice(0, 40)}`;
    case 'WebFetch': {
      try { return `Fetching ${new URL(input.url).hostname}`; }
      catch { return 'Web fetch'; }
    }
    case 'Task': return `Subagent: ${(input.description || input.subagent_type || 'task').slice(0, 40)}`;
    case 'TodoWrite': return 'Updating todo list';
    case 'ExitPlanMode': return 'Exiting plan mode';
    default:
      if (name && name.startsWith('mcp__')) {
        const parts = name.split('__');
        return `MCP · ${parts.slice(1).join('/')}`;
      }
      return name || 'tool';
  }
}

// Claude Code encodes project paths as folder names like "-Users-jesse-code-teleperson"
function getProjectName(filepath, claudeDir) {
  const rel = path.relative(claudeDir, filepath);
  const parts = rel.split(path.sep);
  let name = parts[0] || 'unknown';
  if (name.includes('-')) {
    const segs = name.split('-').filter(s => s && !['Users', 'home', 'mnt', 'c', 'C'].includes(s));
    if (segs.length) name = segs[segs.length - 1];
  }
  return name;
}

function parseLine(line, projectName) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return []; }
  if (parsed.type !== 'assistant') return [];
  const msg = parsed.message;
  if (!msg) return [];

  const events = [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  const usage = msg.usage || {};
  const outputTokens = usage.output_tokens || 0;

  const counted = content.filter(b =>
    b.type === 'tool_use' || b.type === 'text' || b.type === 'thinking'
  );
  const perBlock = counted.length > 0 ? Math.max(5, Math.ceil(outputTokens / counted.length)) : 10;
  const ts = parsed.timestamp || new Date().toISOString();

  for (const block of content) {
    if (block.type === 'tool_use') {
      events.push({
        agent: projectName,
        region: toolToRegion(block.name),
        tokens: perBlock,
        task: describeTool(block),
        tool: block.name,
        ts,
      });
    } else if (block.type === 'text') {
      const text = (block.text || '').trim();
      if (!text) continue;
      const hasCode = /```/.test(text) ||
        /^\s*(function|const|let|class|def|import|export|public|private|async|interface)\b/m.test(text);
      events.push({
        agent: projectName,
        region: hasCode ? 'broca' : 'wernicke',
        tokens: Math.max(5, Math.ceil(text.length / 4)),
        task: hasCode ? 'Generating code' : 'Composing response',
        ts,
      });
      if (text.length > 280) {
        events.push({
          agent: projectName,
          region: 'prefrontal',
          tokens: Math.max(5, Math.ceil(text.length / 10)),
          task: 'Reasoning through approach',
          ts,
        });
      }
    } else if (block.type === 'thinking') {
      const t = block.thinking || '';
      events.push({
        agent: projectName,
        region: 'prefrontal',
        tokens: Math.max(20, Math.ceil(t.length / 4)),
        task: 'Extended thinking',
        ts,
      });
    }
  }
  return events;
}

module.exports = { shortPath, describeTool, getProjectName, parseLine };
