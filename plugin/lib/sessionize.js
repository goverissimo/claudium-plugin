// SPDX-License-Identifier: Apache-2.0
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
// "[Image #3]" — the marker Claude Code leaves where a pasted screenshot sat.
const IMAGE_PLACEHOLDER_RE = /\[Image(?:\s*#\d+)?(?::[^\]]*)?\]/g;

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
// Claude Code's own usage-limit notices, e.g. "You've hit your weekly limit ·
// resets 4pm". Matched on the synthetic (zero-token) assistant messages only.
const LIMIT_RE = /You(?:'|\u2019)ve hit your ([a-zA-Z ]{1,24}?) limit/;
function limitKind(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('weekly')) return 'weekly';
  if (s.includes('session')) return 'session';
  if (s.includes('spend')) return 'spend';
  if (s.includes('opus') || s.includes('sonnet') || s.includes('fable')) return 'model';
  return 'other';
}

function sessionize(lines, { claudeSessionId = '', projectLabel = '' } = {}) {
  const objs = toObjects(lines);

  const events = [];            // ordered: {kind, name?, isError?, hasCode?, at}
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
  let cacheCreation5mTokens = 0;
  let cacheCreation1hTokens = 0;
  // The share of the counters above that ran in fast mode. Fast mode bills the
  // SAME model at a premium, message by message, so one fast turn must not
  // reprice a 200-turn standard session (or the reverse). Pricing reads these.
  const fastTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
  let fastTurns = 0;
  let standardTurns = 0;
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
  // Which extensions the session leaned on, by name, with call counts:
  // skills (Skill tool input.skill, "plugin:skill" for plugin skills), MCP
  // servers (the server part of an mcp__<server>__<tool> name). LOCAL: names
  // are filtered/hashed in lib/record.js before anything ships.
  const skillCalls = new Map();
  const mcpServerCalls = new Map();
  // Cache economics per API call. A "rebuild" is a response that wrote most of
  // its context back to the cache (the prefix had expired or changed). Kept
  // with the idle gap before it, because the gap is the usual cause, and with
  // the model/effort of the call, because a switch is the other.
  const cacheRebuilds = [];    // [{ at, gapS, tokens, tier, model }]
  let lastAssistantAtMs = NaN;
  let lastCallModel = '';
  // Usage-limit notices Claude Code printed ("You've hit your … limit").
  const limitHits = [];        // [{ at, kind }]
  let maxParallelTools = 0;    // most tool_use blocks in one assistant MESSAGE
  const promptTexts = [];      // human-typed prompts only (injections filtered)
  const promptTimes = [];      // timestamps aligned with promptTexts
  // Commits Claude Code made in this session, from the structured
  // toolUseResult.gitOperation.commit on the tool_result line. LOCAL ONLY:
  // SHAs and branch names never ship — lib/git-manifest.js uses them to find
  // where the work landed.
  const commitEvents = [];
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
      // '<synthetic>' is Claude Code's own zero-token placeholder (a limit
      // notice, an interrupted turn), not a model. Letting it win the last-
      // model-seen race left the whole session unpriced.
      if (msg.model && msg.model !== '<synthetic>') model = msg.model;
      if (msg.model === '<synthetic>' && Array.isArray(msg.content)) {
        for (const blk of msg.content) {
          const m = blk && blk.type === 'text' && typeof blk.text === 'string' && LIMIT_RE.exec(blk.text);
          if (m) limitHits.push({ at: o.timestamp || null, kind: limitKind(m[1]) });
        }
      }
      if (firstLineOfMsg) {
        turnCount++;                       // one API response = one turn
        const u = msg.usage || {};         // usage repeats per line: count once
        tokenTotal += u.output_tokens || 0;
        inputTokens += u.input_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        // The 5-minute and 1-hour cache tiers are billed at DIFFERENT rates
        // (1.25x vs 2x the base input price), and the flat
        // cache_creation_input_tokens above collapses them. Claude Code writes
        // almost entirely to the 1h tier — measured across 42,345 assistant
        // messages on this machine, 99.4% of 320M cache-creation tokens were
        // 1h — so treating the flat total as 5m under-prices the single
        // largest cost component of a typical session by ~60%.
        const cc = u.cache_creation || {};
        cacheCreation5mTokens += cc.ephemeral_5m_input_tokens || 0;
        cacheCreation1hTokens += cc.ephemeral_1h_input_tokens || 0;
        {
          const w = u.cache_creation_input_tokens || 0;
          const ctx = w + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);
          const atMs = Date.parse(o.timestamp);
          // At least half of a 20k+ context re-written: the cached prefix was
          // gone. Small writes are the normal append of the latest turn.
          if (ctx >= 20000 && w >= 0.5 * ctx) {
            cacheRebuilds.push({
              at: o.timestamp || null,
              gapS: Number.isFinite(atMs) && Number.isFinite(lastAssistantAtMs) ? Math.round((atMs - lastAssistantAtMs) / 1000) : null,
              tokens: w,
              tier: (cc.ephemeral_1h_input_tokens || 0) > (cc.ephemeral_5m_input_tokens || 0) ? '1h' : ((cc.ephemeral_5m_input_tokens || 0) > 0 ? '5m' : 'unknown'),
              modelChanged: !!(lastCallModel && msg.model && msg.model !== '<synthetic>' && msg.model !== lastCallModel),
              model: msg.model || '',
            });
          }
          // Claude Code's own notices (a limit message, an interrupted turn)
          // are not API calls: they keep no cache warm, so they must not
          // reset the idle clock a later rebuild is timed against.
          if (msg.model !== '<synthetic>') {
            if (Number.isFinite(atMs)) lastAssistantAtMs = atMs;
            if (msg.model) lastCallModel = msg.model;
          }
        }
        if (u.service_tier) serviceTier = u.service_tier;
        // Fast mode is the same model at a premium rate (Opus 5: $10/$50 vs
        // $5/$25), so it is a pricing input, not a curiosity. The money is in
        // fastTokens; `speed` below is only 'fast' when every turn was.
        if (u.speed === 'fast') {
          fastTurns++;
          fastTokens.input += u.input_tokens || 0;
          fastTokens.output += u.output_tokens || 0;
          fastTokens.cacheRead += u.cache_read_input_tokens || 0;
          fastTokens.cacheCreation += u.cache_creation_input_tokens || 0;
          fastTokens.cacheCreation5m += cc.ephemeral_5m_input_tokens || 0;
          fastTokens.cacheCreation1h += cc.ephemeral_1h_input_tokens || 0;
        } else if (u.speed) standardTurns++;
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
          if (block.name === 'Skill' && block.input && typeof block.input.skill === 'string') {
            const k = block.input.skill.slice(0, 80);
            skillCalls.set(k, (skillCalls.get(k) || 0) + 1);
          }
          if (typeof block.name === 'string' && block.name.startsWith('mcp__')) {
            const server = block.name.slice(5).split('__')[0].slice(0, 60);
            if (server) mcpServerCalls.set(server, (mcpServerCalls.get(server) || 0) + 1);
          }
          if ((block.name === 'Task' || block.name === 'Agent') && block.input && typeof block.input === 'object'
              && typeof block.input.subagent_type === 'string') {
            subagentTypes.push(block.input.subagent_type.slice(0, 60));
          }
          events.push({ kind: 'tool_use', name: block.name, at: o.timestamp || null });
        } else if (block.type === 'text') {
          const text = (block.text || '').trim();
          if (!text) continue;
          if (assistantChunks.join('').length < TEXT_CAP) assistantChunks.push(text);
          assistantTexts.push(text.slice(0, TEXT_CAP));
          assistantTimes.push(o.timestamp || null);
          events.push({ kind: 'text', hasCode: hasCode(text), at: o.timestamp || null });
        } else if (block.type === 'thinking') {
          // newer models omit thinking TEXT (display:"omitted") but still emit
          // the blocks — count blocks, not just chars.
          thinkingChars += (block.thinking || '').length;
          thinkingBlocks++;
          events.push({ kind: 'thinking', at: o.timestamp || null });
        }
      }
    } else if (o.type === 'user') {
      // Claude Code flags the user lines it writes itself — stop-hook
      // feedback, skill instructions, image placeholders, "continue from
      // where you left off", compaction summaries — on the LINE, not in the
      // text. Trusting the flags catches what text patterns miss (a
      // re-invoked skill, a message relayed from another session): on one
      // machine 436 of 1,555 "prompts" were these, and every prompt-quality
      // number downstream was scored against them.
      const injectedLine = !!(o.isMeta || o.isCompactSummary);
      if (o.isCompactSummary) isContinuation = true;
      const noteUserText = (raw) => {
        const text = raw.trim().slice(0, TEXT_CAP);
        if (!text) return;
        userTexts.push(text);
        if (INTERRUPT_RE.test(text)) interruptions++;
        if (CONTINUATION_RE.test(text)) isContinuation = true;
        if (injectedLine || isInjectedText(text)) return;
        // A screenshot pasted into a typed prompt leaves an "[Image #n]"
        // placeholder in the text block; keep the person's words, drop the
        // marker, and skip the prompt entirely when the image was all of it.
        const typed = text.replace(IMAGE_PLACEHOLDER_RE, '').trim();
        if (!typed) return;
        promptTexts.push(typed);
        promptTimes.push(o.timestamp || null);
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
          events.push({ kind: 'tool_result', isError: !!block.is_error, name, at: o.timestamp || null });
          // `toolUseResult` is a sibling top-level field on this same line and
          // carries the STRUCTURED result for this tool call.
          const tur = o.toolUseResult;
          if (tur && typeof tur === 'object') {
            if (tur.gitOperation && typeof tur.gitOperation === 'object') {
              const gc = tur.gitOperation.commit;
              if (gc) {
                commits++;
                if (typeof gc.sha === 'string' && /^[0-9a-f]{7,40}$/.test(gc.sha)) {
                  commitEvents.push({ sha: gc.sha, kind: typeof gc.kind === 'string' ? gc.kind : '',
                    branch: typeof gc.branch === 'string' ? gc.branch : '', at: o.timestamp || null });
                }
              }
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
  // The session's billing-speed label: 'fast' or 'standard' only when every
  // turn that reported a speed agreed, 'mixed' otherwise. Records that ship it
  // (lib/record.js) map 'mixed' to 'unknown' and send fast_* counters instead.
  const speed = fastTurns && standardTurns ? 'mixed' : fastTurns ? 'fast' : standardTurns ? 'standard' : '';
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
    speed,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    fastTokens,
    linesAdded,
    linesRemoved,
    editResults,
    userModifiedEdits,
    commits,
    commitEvents,
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
    skillCalls: [...skillCalls].map(([name, calls]) => ({ name, calls })),
    mcpServerCalls: [...mcpServerCalls].map(([name, calls]) => ({ name, calls })),
    cacheRebuilds,
    limitHits,
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
