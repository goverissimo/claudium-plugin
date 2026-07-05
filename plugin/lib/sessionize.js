// lib/sessionize.js — turns a Claude Code session's JSONL lines into one
// ordered Session object. Pure: no I/O, no network.
//
// Unlike lib/parse.js (which emits per-block brain events from ONLY assistant
// lines), this reads BOTH assistant lines AND user/tool_result lines, because
// the outcome signal (did a command fail? did tests pass?) lives in the
// tool_result blocks the brain viz ignores.
//
// IMPORTANT: a Session keeps some raw-ish text (user prompts, assistant prose,
// tool-result snippets) for LOCAL analysis by lib/extract.js only. None of it
// is ever shipped — lib/record.js + lib/scrub.js decide what crosses the wire.

const TEXT_CAP = 4000;        // max chars kept per text bucket (local-only)
const RESULT_CAP = 2000;      // max chars kept per tool-result (local-only)

function hasCode(text) {
  return /```/.test(text) ||
    /^\s*(function|const|let|class|def|import|export|public|private|async|interface)\b/m.test(text);
}

// tool_result content may be a string, or an array of {type:'text',text}.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n');
  }
  return '';
}

function filePathOf(input) {
  if (!input || typeof input !== 'object') return '';
  return input.file_path || input.notebook_path || input.path || '';
}

const EDIT_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Markers Claude Code writes when the human rejects/interrupts Claude's action.
// A denial is the strongest "the human disagreed with Claude's plan" signal.
const DENIAL_RE = /doesn'?t want to proceed|user rejected/i;
const INTERRUPT_RE = /\[Request interrupted by user/;
const CONTINUATION_RE = /session is being continued from a previous conversation/i;

// User text blocks that are injected by the harness, not typed by the human.
function isInjectedText(text) {
  return /^\s*</.test(text) ||            // <system-reminder>, <command-name>, ...
    /^\s*Caveat:/.test(text) ||
    INTERRUPT_RE.test(text);
}

// Count +/- lines in a Claude Code structuredPatch (each hunk has a `lines`
// array of unified-diff strings prefixed with '+', '-', or ' ').
function patchLineDelta(structuredPatch) {
  let added = 0, removed = 0;
  for (const h of structuredPatch || []) {
    for (const ln of (h && h.lines) || []) {
      if (typeof ln !== 'string') continue;
      if (ln[0] === '+') added++;
      else if (ln[0] === '-') removed++;
    }
  }
  return { added, removed };
}

function toObjects(lines) {
  return lines.map(l => {
    if (l && typeof l === 'object') return l;
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// sessionize(lines, { claudeSessionId, projectLabel })
//   lines: array of JSONL strings OR already-parsed objects.
function sessionize(lines, { claudeSessionId = '', projectLabel = '' } = {}) {
  const objs = toObjects(lines);

  const events = [];            // ordered: {kind, name?, isError?, hasCode?}
  const toolCalls = [];         // {name, id, filePath}
  const toolResults = [];       // {id, isError, text}
  const callNameById = new Map();
  const userTexts = [];
  const assistantChunks = [];
  const assistantTexts = [];    // per text block, aligned with assistantTimes (local-only)
  const assistantTimes = [];
  let turnCount = 0;
  let tokenTotal = 0;            // output tokens (kept name for back-compat)
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let serviceTier = '';
  let thinkingChars = 0;
  let thinkingBlocks = 0;
  let model = '';
  // Structured-result accounting (from the top-level `toolUseResult`). LOCAL
  // only: raw patches/output are never shipped — only these derived counts are.
  let linesAdded = 0;
  let linesRemoved = 0;
  let editResults = 0;
  let userModifiedEdits = 0;
  let commits = 0;
  let pushed = false;
  let startedAt = null;
  let endedAt = null;
  let sessionId = claudeSessionId;
  // Environment + human-disagreement signals
  let cwd = '';
  let gitBranch = '';
  let permissionMode = '';
  let denials = 0;             // human rejected a proposed tool call
  let interruptions = 0;       // human hit Esc mid-action
  let isContinuation = false;  // resumed/compacted from a prior session
  let compactions = 0;
  const subagentTypes = [];    // Task tool subagent_type values, in order
  let maxParallelTools = 0;    // most tool_use blocks in one assistant MESSAGE
  const promptTexts = [];      // human-typed prompts only (injections filtered)
  const promptTimes = [];      // timestamps aligned with promptTexts
  // Claude Code writes each content block of one API response as its OWN
  // jsonl line, all sharing message.id — and repeats the same usage object on
  // every line. Dedupe by id or turns and tokens double-count (~2x observed).
  const seenMsgIds = new Set();
  const toolUseByMsg = new Map();
  let anonMsgSeq = 0;

  for (const o of objs) {
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.timestamp) {
      if (!startedAt) startedAt = o.timestamp;
      endedAt = o.timestamp;
    }
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (o.permissionMode) permissionMode = o.permissionMode;
    if (o.type === 'system' && /compact/i.test(o.subtype || '')) compactions++;
    const msg = o.message;
    if (!msg) continue;

    if (o.type === 'assistant') {
      const msgId = msg.id || `anon-${anonMsgSeq++}`;
      const firstLineOfMsg = !seenMsgIds.has(msgId);
      seenMsgIds.add(msgId);
      if (msg.model) model = msg.model;
      if (firstLineOfMsg) {
        turnCount++;                       // one API response = one turn
        const u = msg.usage || {};         // usage repeats per line: count once
        tokenTotal += u.output_tokens || 0;
        inputTokens += u.input_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        if (u.service_tier) serviceTier = u.service_tier;
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      const parallel = (toolUseByMsg.get(msgId) || 0) + content.filter(b => b && b.type === 'tool_use').length;
      toolUseByMsg.set(msgId, parallel);
      if (parallel > maxParallelTools) maxParallelTools = parallel;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const fp = filePathOf(block.input);
          toolCalls.push({ name: block.name, id: block.id || '', filePath: fp });
          if (block.id) callNameById.set(block.id, block.name);
          if ((block.name === 'Task' || block.name === 'Agent') && block.input && typeof block.input === 'object'
              && typeof block.input.subagent_type === 'string') {
            subagentTypes.push(block.input.subagent_type.slice(0, 60));
          }
          events.push({ kind: 'tool_use', name: block.name });
        } else if (block.type === 'text') {
          const text = (block.text || '').trim();
          if (!text) continue;
          if (assistantChunks.join('').length < TEXT_CAP) assistantChunks.push(text);
          assistantTexts.push(text.slice(0, TEXT_CAP));
          assistantTimes.push(o.timestamp || null);
          events.push({ kind: 'text', hasCode: hasCode(text) });
        } else if (block.type === 'thinking') {
          // newer models omit thinking TEXT (display:"omitted") but still emit
          // the blocks — count blocks, not just chars.
          thinkingChars += (block.thinking || '').length;
          thinkingBlocks++;
          events.push({ kind: 'thinking' });
        }
      }
    } else if (o.type === 'user') {
      const noteUserText = (raw) => {
        const text = raw.trim().slice(0, TEXT_CAP);
        if (!text) return;
        userTexts.push(text);
        if (INTERRUPT_RE.test(text)) interruptions++;
        if (CONTINUATION_RE.test(text)) isContinuation = true;
        if (!isInjectedText(text)) {
          promptTexts.push(text);
          promptTimes.push(o.timestamp || null);
        }
      };
      const content = msg.content;
      if (typeof content === 'string') {
        noteUserText(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text = resultText(block.content).slice(0, RESULT_CAP);
          const id = block.tool_use_id || '';
          const name = callNameById.get(id) || '';
          if (DENIAL_RE.test(text)) denials++;
          toolResults.push({ id, isError: !!block.is_error, text });
          events.push({ kind: 'tool_result', isError: !!block.is_error, name });
          // `toolUseResult` is a sibling top-level field on this same line and
          // carries the STRUCTURED result for this tool call.
          const tur = o.toolUseResult;
          if (tur && typeof tur === 'object') {
            if (tur.gitOperation && typeof tur.gitOperation === 'object') {
              if (tur.gitOperation.commit) commits++;
              if (tur.gitOperation.push) pushed = true;
            }
            if (EDIT_NAMES.has(name)) {
              editResults++;
              if (tur.userModified) userModifiedEdits++;
              if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) {
                const d = patchLineDelta(tur.structuredPatch);
                linesAdded += d.added;
                linesRemoved += d.removed;
              } else if (name === 'Write' && tur.file && typeof tur.file.content === 'string') {
                linesAdded += tur.file.content.split('\n').length;
              }
            }
          }
        } else if (block.type === 'text' && block.text && block.text.trim()) {
          noteUserText(block.text);
        }
      }
    }
  }

  const toolsUsed = [...new Set(toolCalls.map(t => t.name).filter(Boolean))];
  const durationS = startedAt && endedAt
    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
    : 0;

  return {
    claudeSessionId: sessionId,
    projectLabel,
    startedAt,
    endedAt,
    durationS,
    turnCount,
    tokenTotal,
    inputTokens,
    outputTokens: tokenTotal,
    cacheReadTokens,
    cacheCreationTokens,
    serviceTier,
    linesAdded,
    linesRemoved,
    editResults,
    userModifiedEdits,
    commits,
    pushed,
    model,
    toolCalls,
    toolResults,
    toolsUsed,
    thinkingChars,
    thinkingBlocks,
    events,
    // environment + human-disagreement signals
    cwd,
    gitBranch,
    permissionMode,
    denials,
    interruptions,
    isContinuation,
    compactions,
    subagentTypes,
    maxParallelTools,
    // local-only text (never shipped):
    userTexts,
    promptTexts,
    promptTimes,
    assistantTexts,
    assistantTimes,
    firstUserText: promptTexts[0] || userTexts[0] || '',
    assistantText: assistantChunks.join('\n').slice(0, TEXT_CAP),
  };
}

module.exports = { sessionize, hasCode, resultText, filePathOf, isInjectedText };
