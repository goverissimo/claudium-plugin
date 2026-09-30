// SPDX-License-Identifier: Apache-2.0
// lib/task-path.js — a session is not one task. Splits a sessionized session
// into TASKS (one per message that starts work or reports a bug) and records
// how each one ENDED (its path), from the transcript alone: no model, no I/O.
// Prompt text is read locally; only the enum and counts ship (lib/record.js
// -> lib/scrub.js). Pure and dependency-free so it vendors into the plugin.
//
//   path        rule (first match wins)
//   abandoned   last event is an error with no assistant text after it, or
//               Claude's last text asked the person something and nobody answered
//   clarified   Claude's FIRST reply asked the person something, they answered,
//               and no edit had happened yet
//   corrected   a bug report or a "no, I meant" steer arrived after the first edit
//   handed_off  Claude's last text asked the person to check something and the
//               next message was a go-ahead or a new task
//   first_try   none of the above
//
// Two more per-task signals (spec 2026-09-28-git-outcomes, D13/D14):
//   verification  did Claude check its own work after its last edit?
//                 no_edits | agent_checked | handed_to_person |
//                 claimed_unchecked | unchecked
//   target_hint   the task was corrected and the correction points at the
//                 wrong project / env / org / branch / database
// and commits are now credited to the task that made them, by timestamp.

const { classifyPromptKind } = require('./prompt-kind');

const TASK_PATHS = ['abandoned', 'clarified', 'corrected', 'handed_off', 'first_try'];
const TASK_ENDINGS = ['summary', 'question_to_user', 'error', 'handoff', 'nothing'];
const VERIFICATIONS = ['no_edits', 'agent_checked', 'handed_to_person', 'claimed_unchecked', 'unchecked', 'unknown'];
const OPENERS = new Set(['start', 'bug']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// toolCalls/toolResults carry the tool NAME and the result TEXT, but never
// the Bash input string — so a "test run" is recognised from the result's
// own test-runner-shaped summary line, not from the command that produced it.
const TEST_RUN_OUTPUT = /\bTests?:\s*\d+|\b\d+\s+(?:passed|failed|passing|failing|tests?\s+run)\b/i;
// Same shape as lib/prompt-quality.js's CORRECTIVE — kept local so this file
// stays dependency-free beyond prompt-kind.
const CORRECTIVE = /^(no\b|not\b|nope\b|wrong\b|that'?s (?:not|wrong)|i meant\b|actually[, ]|again\b|still (?:broken|wrong|not))/i;
// Claude asking the person something.
const ASKS_PERSON = /\?\s*$|\b(which do you prefer|do you want|should i|would you like|let me know (?:which|if|whether))\b/i;
// Claude handing a check back: "open /checkout and try", "run it and tell me".
const HANDS_OFF = /\b(open|try|run|check|test|verify|reload|refresh|visit|confirm)\b[^.!?\n]{0,80}\b(and (?:tell|let) me|to confirm|to verify|to check|to see|whether|if it)\b|\blet me know (?:how|what|if|whether|once)\b/i;
// A bug report that prompt-kind's BROKEN regex misses because it reads as a
// steer instead (it refers back with "it"/"this" and has no imperative verb),
// e.g. "the button does nothing when I click it". Anchored to a subject that
// "does nothing", and applied ONLY to a steer: a go-ahead ("there is nothing
// more to do") or a question ("is nothing broken?") must never become a bug.
const BUG_LIKE = /\b(?:it|this|that|the\s+\w+)\s+(?:does|did)\s+(?:absolutely\s+)?nothing\b/i;
// A check Claude ran on its own work: a build, a type-check, a lint, an HTTP
// status line, or a test-runner summary in a Bash result...
const BUILD_OR_RUN_OUTPUT = /\b(compiled successfully|compiled with|build (?:succeeded|completed|successful|failed)|built in \d|webpack \d[\d.]* compiled|found \d+ errors?|no (?:type )?errors? found|\d+ problems? \(|lint(?:ing)? (?:passed|failed)|HTTP\/[\d.]+ \d{3}|\b[1-5]\d\d (?:OK|Created|No Content|Found|Moved|Bad Request|Unauthorized|Forbidden|Not Found|Internal Server Error)\b)/i;
// ...or a browser tool (Playwright, Chrome, a preview server) looking at it.
const BROWSER_TOOL = /^mcp__.*(playwright|browser|chrome|puppeteer|preview)|screenshot/i;
// Claude saying it is finished. Negated claims ("not done yet", "isn't
// fully deployed") don't count, and "ready" is excluded entirely — it's too
// generic ("let me know when you're ready") to signal a finished check.
const CLAIMS_DONE = /(?<!\b(?:not|n't|isn't|aren't|wasn't)\s+(?:yet\s+|quite\s+|fully\s+)?)\b(done|fixed|implemented|works now|now works|should (?:now )?work|is working|all set|completed?|deployed|pushed|merged|shipped|in place)\b/i;
// A correction that says the work landed on the wrong target. "I'm on
// it/that/this/my way" is excluded — it's not naming a wrong target.
const WRONG_TARGET = /\b(different (?:project|repo|repository|org|organi[sz]ation|account|branch|server|env(?:ironment)?)|wrong (?:project|repo|repository|org|organi[sz]ation|account|branch|server|env(?:ironment)?|database|db|region|domain|url)|(?:vercel|preview|staging) (?:link|url|deploy(?:ment)?)|not (?:the|an) actual|in the (?:eu|us) region|(?:relation|column|table) "?[\w.]+"? does not exist|not (?:migrated|deployed)|on (?:prod|production|staging|localhost)\b|i'?m on (?!it\b|that\b|this\b|my way\b))/i;

function kindsOf(session) {
  const prompts = session.promptTexts || [];
  return prompts.map((p, i) => {
    const kind = classifyPromptKind(p, { first: i === 0 });
    return kind === 'steer' && BUG_LIKE.test(p) ? 'bug' : kind;
  });
}

// Walk events once, tagging each with the index of the prompt it belongs to:
// the largest i with promptTimes[i] <= the event's own timestamp (events now
// carry `at`, stamped by sessionize from the transcript line's timestamp).
// An event with no timestamp inherits the previous event's prompt index (0
// before any timestamped event has been seen).
function eventsByPrompt(session) {
  const ev = session.events || [];
  const pt = session.promptTimes || [];
  const promptIndexAt = ts => {
    if (!ts) return null;
    let idx = 0;
    for (let i = 0; i < pt.length; i++) if (pt[i] && pt[i] <= ts) idx = i;
    return idx;
  };
  const out = [];
  let cur = 0;
  for (const e of ev) {
    const idx = promptIndexAt(e.at);
    if (idx !== null) cur = idx;
    out.push({ ...e, prompt: cur });
  }
  return out;
}

// Index of the task a moment belongs to: the last task whose opening
// message was sent at or before `atMs`. tasks carry prompt_index; times come
// from session.promptTimes. Before the first opener -> task 0.
function taskAt(tasks, promptTimes, atMs) {
  let idx = tasks.length ? tasks[0].index : 0;
  for (const t of tasks) {
    const ts = Date.parse((promptTimes || [])[t.prompt_index]);
    if (Number.isFinite(ts) && Number.isFinite(atMs) && ts <= atMs) idx = t.index;
  }
  return idx;
}

function segmentTasks(session) {
  const prompts = session.promptTexts || [];
  const kinds = kindsOf(session);
  const texts = session.assistantTexts || [];
  const tagged = eventsByPrompt(session);
  const results = session.toolResults || [];

  // Task boundaries: every opener starts a task; if none, one task spans all.
  let openers = kinds.map((k, i) => (OPENERS.has(k) ? i : -1)).filter(i => i >= 0);
  // The messages before the first real opener (e.g. a question) belong to the
  // first task; prompt_index still points at the opener itself. So when the
  // first real opener isn't message 0, it MERGES into the 0 boundary rather
  // than adding a second one.
  const firstOpener = openers.length ? openers[0] : -1;
  if (!openers.length) openers = [0];
  else if (openers[0] !== 0) openers = [0, ...openers.slice(1)];

  const tasks = [];
  for (let n = 0; n < openers.length; n++) {
    const from = openers[n];
    const to = n + 1 < openers.length ? openers[n + 1] : prompts.length;   // [from, to)
    // Task 0 may have merged a later first opener into the 0 boundary; its
    // kind is that opener's, not message 0's (which may be a question).
    const openedAt = n === 0 && firstOpener > 0 ? firstOpener : from;
    const kind = OPENERS.has(kinds[openedAt]) ? kinds[openedAt] : 'start';
    const messages = { start: 0, steer: 0, bug: 0, question: 0, go_ahead: 0 };
    for (let i = from; i < to; i++) messages[kinds[i]]++;

    // Events in this window.
    const win = tagged.filter(e => e.prompt >= from && e.prompt < to);
    let tests = 0, errors = 0, commits = 0, firstEditPos = -1, resultPos = 0;
    // toolResults are in the same order as tool_result events across the
    // whole session, so advance a cursor as we pass them.
    const resultsBefore = tagged.filter(e => e.kind === 'tool_result' && e.prompt < from).length;
    resultPos = resultsBefore;
    win.forEach((e, pos) => {
      if (e.kind === 'tool_use' && EDIT_TOOLS.has(e.name) && firstEditPos < 0) firstEditPos = pos;
      if (e.kind === 'tool_result') {
        const r = results[resultPos++];
        if (e.isError) errors++;
        if (e.name === 'Bash' && r && TEST_RUN_OUTPUT.test(r.text || '')) tests++;
      }
    });
    // Commits Claude made are credited to the task whose window holds the
    // commit's own timestamp. A session with commits but no commit events
    // (an older transcript format) keeps the old rule: all on the last task.
    const commitShas = [];
    const evs = session.commitEvents || [];
    if (evs.length) {
      const pt = session.promptTimes || [];
      const lo = n === 0 ? -Infinity : Date.parse(pt[from]);
      const hi = to < prompts.length ? Date.parse(pt[to]) : Infinity;
      for (const c of evs) {
        const t = Date.parse(c.at);
        if (Number.isFinite(t) ? (t >= lo && t < hi) : n === openers.length - 1) commitShas.push(c.sha);
      }
      commits = commitShas.length;
    } else if (n === openers.length - 1) commits = session.commits || 0;

    // Claude's texts in the window, in order.
    const textIdx = [];
    let seen = 0;
    for (const e of tagged) { if (e.kind === 'text') { if (e.prompt >= from && e.prompt < to) textIdx.push(seen); seen++; } }
    const firstText = textIdx.length ? texts[textIdx[0]] || '' : '';
    const lastText = textIdx.length ? texts[textIdx[textIdx.length - 1]] || '' : '';
    // Skip thinking blocks, like lib/metrics.js's lastMeaningful: an error
    // followed only by thinking still ended in that error.
    const last = [...win].reverse().find(e => e.kind !== 'thinking') || null;
    const nextKind = to < prompts.length ? kinds[to] : null;
    const personRepliedAfterLastText = textIdx.length > 0 && (() => {
      // Was there a prompt in [from, to) after the last text? Compare times.
      const lastTextTime = (session.assistantTimes || [])[textIdx[textIdx.length - 1]];
      const pt = session.promptTimes || [];
      for (let i = from + 1; i < to; i++) if (pt[i] && lastTextTime && pt[i] > lastTextTime) return true;
      return false;
    })();

    let ended_with = 'nothing';
    if (last && last.kind === 'tool_result' && last.isError) ended_with = 'error';
    else if (lastText && HANDS_OFF.test(lastText)) ended_with = 'handoff';
    else if (lastText && ASKS_PERSON.test(lastText)) ended_with = 'question_to_user';
    else if (lastText) ended_with = 'summary';

    const askedFirst = !!firstText && ASKS_PERSON.test(firstText);
    const firstTextPos = win.findIndex(e => e.kind === 'text');
    const answeredBeforeEdit = askedFirst && to - from > 1 && (firstEditPos < 0 || firstEditPos > firstTextPos);
    const correctedAfterEdit = firstEditPos >= 0 && (() => {
      // Any bug/corrective message in (from, to) that arrived after the first edit.
      const pt = session.promptTimes || [];
      // first edit's own timestamp, falling back to the opening prompt's time.
      const firstEditTime = win[firstEditPos].at || pt[from];
      for (let i = from + 1; i < to; i++) {
        const isBugOrCorrection = kinds[i] === 'bug' || (kinds[i] === 'steer' && CORRECTIVE.test(prompts[i].trim()));
        if (isBugOrCorrection && (!pt[i] || !firstEditTime || pt[i] >= firstEditTime)) return true;
      }
      return false;
    })();
    // A bug reported as the NEXT task also counts as a correction to this one.
    const nextIsBug = nextKind === 'bug';

    let path;
    if (ended_with === 'error' || (ended_with === 'question_to_user' && !personRepliedAfterLastText && nextKind === null)) path = 'abandoned';
    else if (answeredBeforeEdit) path = 'clarified';
    else if (correctedAfterEdit || (nextIsBug && firstEditPos >= 0)) path = 'corrected';
    else if (ended_with === 'handoff' && (nextKind === 'go_ahead' || nextKind === 'start' || nextKind === 'bug' || personRepliedAfterLastText)) path = 'handed_off';
    else path = 'first_try';

    // Verification (D13): look only at what happened AFTER the last edit.
    let lastEditPos = -1;
    win.forEach((e, pos) => { if (e.kind === 'tool_use' && EDIT_TOOLS.has(e.name)) lastEditPos = pos; });
    let checked = false;
    if (lastEditPos >= 0) {
      let rp = resultsBefore;
      win.forEach((e, pos) => {
        const r = e.kind === 'tool_result' ? results[rp++] : null;
        if (pos <= lastEditPos) return;
        if (e.kind === 'tool_use' && BROWSER_TOOL.test(e.name || '')) checked = true;
        if (r && e.name === 'Bash' && (TEST_RUN_OUTPUT.test(r.text || '') || BUILD_OR_RUN_OUTPUT.test(r.text || ''))) checked = true;
      });
    }
    let verification;
    if (lastEditPos < 0) verification = 'no_edits';
    else if (checked) verification = 'agent_checked';
    else if (lastText && HANDS_OFF.test(lastText)) verification = 'handed_to_person';
    else if (lastText && CLAIMS_DONE.test(lastText)) verification = 'claimed_unchecked';
    else verification = 'unchecked';

    // Wrong-target hint (D14): the message that corrected this task.
    let correction = '';
    if (path === 'corrected') {
      for (let i = from + 1; i < to && !correction; i++) {
        if (kinds[i] === 'bug' || (kinds[i] === 'steer' && CORRECTIVE.test(prompts[i].trim()))) correction = prompts[i];
      }
      if (!correction && nextIsBug) correction = prompts[to] || '';
    }
    const target_hint = !!correction && WRONG_TARGET.test(correction);

    tasks.push({ index: n, kind, prompt_index: openedAt, commit_shas: commitShas, messages, path, ended_with,
      tests, errors, commits, verification, target_hint });
  }
  return tasks;
}

module.exports = { segmentTasks, taskAt, TASK_PATHS, TASK_ENDINGS, VERIFICATIONS };
