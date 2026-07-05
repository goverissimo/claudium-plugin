// lib/extract.js — Tier-1 abstraction. Runs SENDER-SIDE using the
// contributor's OWN ANTHROPIC_API_KEY. The raw transcript is the model's
// input (locally, on the user's machine) but never its output: the model is
// forced to emit only an enum category/domain + a generic intent phrase, and
// that output is still scrubbed by lib/scrub.js before anything is shipped.
//
// With no API key it degrades to a deterministic guess from the tool mix —
// no LLM, no intent text — so the pipeline always produces a record.

const { ACTIVITY_CATEGORIES, DOMAINS } = require('./scrub');

function condense(session) {
  const toolSeq = (session.toolCalls || []).map(t => t.name).slice(0, 60).join(', ');
  const firstUser = (session.firstUserText || '').slice(0, 600);
  const asstHead = (session.assistantText || '').slice(0, 600);
  return [
    `Tools used (in order): ${toolSeq || 'none'}`,
    `Turn count: ${session.turnCount}`,
    `First user request (truncated): ${firstUser}`,
    `Assistant summary (truncated): ${asstHead}`,
  ].join('\n');
}

function domainFromFiles(session) {
  const exts = (session.toolCalls || [])
    .map(t => (t.filePath || '').split('.').pop().toLowerCase());
  const any = list => exts.some(e => list.includes(e));
  if (any(['tsx', 'jsx', 'css', 'scss', 'html', 'vue', 'svelte'])) return 'frontend';
  if (any(['py', 'rb', 'go', 'java', 'rs', 'php', 'cs'])) return 'backend';
  if (any(['sql', 'ipynb', 'csv', 'parquet'])) return 'data_ml';
  if (any(['yml', 'yaml', 'tf', 'dockerfile', 'sh'])) return 'infra_devops';
  if (any(['swift', 'kt', 'dart'])) return 'mobile';
  if (any(['md', 'mdx', 'txt', 'rst'])) return 'docs_content';
  if (any(['ts', 'js', 'mjs'])) return 'fullstack';
  return 'other';
}

function fallbackAbstraction(session) {
  const used = new Set(session.toolsUsed || []);
  const has = n => used.has(n);
  const editing = has('Edit') || has('MultiEdit');
  const writing = has('Write');
  const reading = has('Read') || has('Grep') || has('Glob');
  const web = has('WebSearch') || has('WebFetch');
  // What the human ASKED beats what tools fired — the tool mix of "fix a bug"
  // and "refactor" is identical (read, edit, bash). Local-only text.
  const ask = (session.firstUserText || '').slice(0, 400).toLowerCase();
  let cat = '';
  if (/\b(fix|bug|broken|error|fail|crash|doesn'?t work|not working|debug)\b/.test(ask)) cat = 'debugging';
  else if (/\b(test|tests|coverage|spec|tdd)\b/.test(ask)) cat = 'testing';
  else if (/\b(refactor|clean ?up|simplify|reorganize|rename|extract|restructure)\b/.test(ask)) cat = 'refactoring';
  else if (/\b(add|implement|create|build|make|feature|new page|new endpoint|support for)\b/.test(ask)) cat = 'feature_implementation';
  else if (/\b(deploy|release|docker|ci\b|pipeline|infra|kubernetes|server setup)\b/.test(ask)) cat = 'devops_deploy';
  else if (/\b(review|audit|look over|check (?:the|my|this) (?:code|pr|diff))\b/.test(ask)) cat = 'code_review';
  else if (/\b(document|readme|docs|changelog|comment)\b/.test(ask)) cat = 'documentation';
  else if (/\b(analy[sz]e|csv|dataset|chart|sql query|notebook)\b/.test(ask)) cat = 'data_analysis';
  else if (/\b(write|draft|blog|post|copy|article|email)\b/.test(ask) && !editing) cat = 'writing_content';
  else if (/^(what|how|why|where|when|explain|research|compare|overview)\b/.test(ask)) cat = 'research_learning';
  else if (/\b(plan|design|architect|spec out|roadmap)\b/.test(ask)) cat = 'planning_design';
  if (!cat) {
    if (web && !editing && !writing) cat = 'research_learning';
    else if (writing && !editing) cat = 'feature_implementation';
    else if (editing) cat = 'refactoring';
    else if (reading && !editing && !writing) cat = 'code_review';
    else if (has('Bash')) cat = 'devops_deploy';
    else cat = 'other';
  }
  return { activity_category: cat, domain: domainFromFiles(session), intent_summary: '', model: '' };
}

async function extractAbstraction(session, opts = {}) {
  const { apiKey, model = 'claude-haiku-4-5', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = opts;
  if (!apiKey || !fetchImpl) return fallbackAbstraction(session);

  const tool = {
    name: 'record_usage',
    description: 'Classify how an engineer used an AI coding assistant in this session.',
    input_schema: {
      type: 'object',
      properties: {
        activity_category: { type: 'string', enum: ACTIVITY_CATEGORIES },
        domain: { type: 'string', enum: DOMAINS },
        intent_summary: {
          type: 'string',
          description: 'One neutral phrase (<=120 chars) describing the GENERIC task. NO proper nouns, company/product names, file contents, code, paths, secrets, URLs, or PII. Generalize when unsure.',
        },
      },
      required: ['activity_category', 'domain', 'intent_summary'],
    },
  };
  const body = {
    model,
    max_tokens: 300,
    system: 'You label how an engineer used an AI coding assistant. Respond ONLY via the record_usage tool. intent_summary must be safe to share publicly: generic, abstracted, no proprietary detail, names, code, paths, secrets, or PII.',
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_usage' },
    messages: [{ role: 'user', content: condense(session) }],
  };

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!resp.ok) return fallbackAbstraction(session);
    const data = await resp.json();
    const block = Array.isArray(data.content) ? data.content.find(b => b.type === 'tool_use') : null;
    if (!block || !block.input) return fallbackAbstraction(session);
    return {
      activity_category: block.input.activity_category,
      domain: block.input.domain,
      intent_summary: block.input.intent_summary || '',
      model,
    };
  } catch {
    return fallbackAbstraction(session);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { extractAbstraction, fallbackAbstraction, condense, domainFromFiles };
