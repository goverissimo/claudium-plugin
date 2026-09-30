// SPDX-License-Identifier: Apache-2.0
// lib/prompt-kind.js — what a human-typed message DOES in the conversation.
// Pure, no LLM, no I/O. Prompt text is read locally; only the enum ships.
//
// A session is not one prompt. Hand-labelling 60 messages from one machine
// found 19 that started a task, 21 questions, 8 go-aheads, 7 bug reports and
// 5 steers — and scoring a question or a go-ahead against "did it state
// success criteria?" is noise. The kind decides which practices apply
// (lib/prompt-quality.js) and, later, where one task ends and the next
// begins. On those 60 labels these rules got 65% right; the untrained
// Laya decision model got 43%, so rules it is until there is training data.
//
//   start     hands over a fresh piece of work
//   steer     continues or adjusts what Claude is already doing
//   bug       reports that something is broken or not working
//   question  asks to understand, without asking for a change
//   go_ahead  approves / confirms / says continue, adds nothing new

const PROMPT_KINDS = ['start', 'steer', 'bug', 'question', 'go_ahead'];

const QUESTION_START = /^(why|what|where|when|who|which|how|is|are|was|were|can|could|does|do|did|should|would|will|has|have|explain|tell me|status of|any idea)\b/i;
const APPROVAL = /\b(go ahead|proceed|continue|do it|approve[ds]?|aproove|sounds good|looks good|lgtm|ok(?:ay)?|yes|yeah|yep|sure|perfect|great)\b/i;
// Words that only make sense against something Claude just said or did.
const REFERS_BACK = /\b(it|this|that|these|those|them|then|also|as well|too|same|again|instead|the other|both|option \d|the (?:first|second|last) one|remake|redo)\b/i;
const BROKEN = /\b(still|not working|doesn'?t work|isn'?t working|don'?t work|broken|breaks|crash(?:es|ed|ing)?|fail(?:s|ed|ing)?|error|exception|wrong|nothing (?:happens|showed|shows)|no (?:confirmation|response|output)|can'?t (?:see|find|open|login|log in)|cannot|undefined|null|shows? 0|missing|does ?n[o']t (?:reach|load|open|show|start|work)|status code|beeping|overheat(?:ed|ing)?|unable to|blocked|stuck|can'?t (?:complete|finish|continue|proceed)|won'?t (?:load|start|open|work))\b/i;
// Objects that name nothing new: "build it", "do that", "the spec", "the plan".
const GENERIC_OBJECT = /\b(it|that|this|them|the (?:spec|plan|proposal|changes?|fix|approach)|with (?:it|that|this))\b/gi;
const IMPERATIVE = /\b(add|make|create|fix|implement|refactor|update|remove|delete|write|build|change|rename|move|deploy|test|install|set ?up|configure|improve|optimize|migrate|convert|redo|remake|drop|check|run|open|show|use|apply|send|export|review)\b/i;

const words = t => String(t).trim().split(/\s+/).filter(Boolean);

// classifyPromptKind(text, { first }) -> one of PROMPT_KINDS
function classifyPromptKind(text, { first = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return 'go_ahead';
  const n = words(t).length;
  // Slash commands ("/reload-plugins --force") tell the harness, not Claude.
  if (/^\//.test(t) && n <= 4) return 'go_ahead';

  // A symptom report that ends by asking "what can it be" is a bug, not a
  // question; a question that opens with "what", "why", "is" or ends in "?"
  // is a question unless it is mostly a list of instructions.
  const symptomAsk = BROKEN.test(t) && /\b(what (?:can|could) it be|any idea|why)\b/i.test(t);
  const asksQuestion = !symptomAsk && (QUESTION_START.test(t) || (/\?/.test(t) && !(IMPERATIVE.test(t) && n > 25)));
  if (asksQuestion) return 'question';

  // An approval adds nothing new when, with the approval words and the
  // generic "build it / the spec / the plan" gone, no object of work is left.
  if (APPROVAL.test(t)) {
    const rest = t.replace(new RegExp(APPROVAL.source, 'gi'), ' ')
      .replace(GENERIC_OBJECT, ' ').replace(/[^a-z]/gi, ' ');
    if (!IMPERATIVE.test(rest) || words(rest).filter(w => w.length > 3).length <= 2) return 'go_ahead';
  }

  if (BROKEN.test(t) && !first) return 'bug';
  if (BROKEN.test(t) && first && !IMPERATIVE.test(t)) return 'bug';

  if (first) return 'start';
  if (REFERS_BACK.test(t)) return 'steer';
  // A later message that reads like a fresh, self-contained instruction.
  if (IMPERATIVE.test(t) && n >= 8) return 'start';
  return 'steer';
}

module.exports = { classifyPromptKind, PROMPT_KINDS };
