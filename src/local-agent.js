'use strict';
const path = require('node:path');

// A Claude Code / Codex style local agent loop, with Muse (reached
// through the normal gateway chat) as the brain and this module as the
// protocol between Muse's replies and the local tool executor.
//
// Protocol: Muse asks for local work by putting one JSON object per
// fenced block tagged `local-tool` in its reply:
//
//   ```local-tool
//   {"tool":"run","command":"npm test"}
//   ```
//
// Tools: run {command}, read {path,start?,end?}, list {path?},
// write {path,content}, edit {path,old,new}, done {summary?}.
// Everything else in the reply is ordinary prose for the user. Tool
// results are sent back as the next user message and the loop repeats,
// bounded by MAX_STEPS and MAX_CALLS_PER_REPLY. Nothing asks for
// confirmation and nothing is confined: commands run in the workspace
// folder, and file paths may be absolute or relative to it.

const MAX_STEPS = 16;
const MAX_CALLS_PER_REPLY = 4;
const MAX_COMMAND_LENGTH = 1500; // same limit as the tools window
const MAX_PATH_LENGTH = 512;
const MAX_CONTENT_LENGTH = 200 * 1024;
const RESULT_BUDGET = 32 * 1024; // per tool result sent back to Muse

const TOOLS = ['run', 'read', 'list', 'write', 'edit', 'done'];

function extractToolCalls(text) {
  const calls = [], errors = [];
  if (typeof text !== 'string') return {calls, errors};
  const fence = /```local-tool[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const body = match[1].trim();
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('ツール呼び出しは JSON オブジェクトにしてください。');
      else calls.push(value);
    } catch { errors.push('ツール呼び出しの JSON を読み取れませんでした。'); }
  }
  return {calls, errors};
}

// Returns a normalized call or a string describing what is wrong.
function validateCall(call) {
  if (!call || typeof call !== 'object') return 'ツール呼び出しがオブジェクトではありません。';
  if (!TOOLS.includes(call.tool)) return `不明なツールです: ${String(call.tool).slice(0, 40)}`;
  const out = {tool: call.tool};
  if (call.tool === 'run') {
    if (typeof call.command !== 'string' || !call.command.trim()) return 'run には command が必要です。';
    if (call.command.length > MAX_COMMAND_LENGTH) return `command が長すぎます（上限 ${MAX_COMMAND_LENGTH} 文字）。`;
    out.command = call.command;
  }
  // An empty list path means the workspace root.
  if (call.tool === 'list' && (call.path === undefined || call.path === '')) delete call.path;
  if (['read', 'write', 'edit'].includes(call.tool) || (call.tool === 'list' && call.path !== undefined)) {
    if (typeof call.path !== 'string' || !call.path.trim()) return `${call.tool} には path が必要です。`;
    if (call.path.length > MAX_PATH_LENGTH) return 'path が長すぎます。';
    out.path = call.path;
  }
  if (call.tool === 'read') {
    for (const key of ['start', 'end']) {
      if (call[key] !== undefined) {
        if (!Number.isSafeInteger(call[key]) || call[key] < 1) return `read の ${key} は 1 以上の整数にしてください。`;
        out[key] = call[key];
      }
    }
  }
  if (call.tool === 'write') {
    if (typeof call.content !== 'string') return 'write には content が必要です。';
    if (call.content.length > MAX_CONTENT_LENGTH) return 'write の content が大きすぎます。';
    out.content = call.content;
  }
  if (call.tool === 'edit') {
    if (typeof call.old !== 'string' || !call.old) return 'edit には置換前の old が必要です。';
    if (typeof call.new !== 'string') return 'edit には置換後の new が必要です。';
    if (call.old.length > MAX_CONTENT_LENGTH || call.new.length > MAX_CONTENT_LENGTH) return 'edit の old / new が大きすぎます。';
    out.old = call.old; out.new = call.new;
  }
  if (call.tool === 'done') {
    out.summary = typeof call.summary === 'string' ? call.summary.slice(0, 4000) : '';
  }
  return out;
}

// Absolute paths are used as they are; relative paths start at the workspace.
function resolveToolPath(workspace, p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  return path.resolve(path.resolve(workspace), p);
}

function buildTaskMessage({workspace, platform, task}) {
  return [
    '[Local agent task — sent by the Muse App on the user\'s PC, not typed by the user]',
    'You can work in a local folder on the user\'s computer through tools provided by the app. To use a tool, put one JSON object per fenced block tagged local-tool in your reply, and nothing else in that block:',
    '',
    '```local-tool',
    '{"tool":"run","command":"npm test"}',
    '```',
    '',
    'Tools:',
    '- {"tool":"run","command":"..."} — run a shell command in the workspace folder (non-interactive commands only)',
    '- {"tool":"read","path":"relative/path","start":1,"end":80} — read a UTF-8 text file (start/end optional)',
    '- {"tool":"list","path":"relative/dir"} — list a directory (path optional, default is the workspace root)',
    '- {"tool":"write","path":"relative/path","content":"..."} — create or overwrite a file',
    '- {"tool":"edit","path":"relative/path","old":"exact text","new":"replacement"} — replace one exact occurrence',
    '- {"tool":"done","summary":"what you did"} — finish the task',
    '',
    'Rules:',
    '- Paths may be absolute or relative to the workspace. Commands start in the workspace folder.',
    '- Calls run immediately without confirmation, so check before destructive commands. A failed call comes back as a failed result — adapt instead of repeating it.',
    `- At most ${MAX_CALLS_PER_REPLY} calls per reply and ${MAX_STEPS} rounds in total. Independent calls can be batched in one reply.`,
    '- After tool results come back, continue with the next calls, or finish with a done call (or a plain final answer with no tool calls).',
    '- Keep prose outside the blocks brief; the user watches the tool log live.',
    '',
    `Workspace: ${workspace}`,
    `Platform: ${platform}`,
    '',
    'Task from the user:',
    task,
  ].join('\n');
}

function truncate(text, budget = RESULT_BUDGET) {
  const s = String(text ?? '');
  return s.length > budget ? s.slice(0, budget) + `\n… (${s.length - budget} more characters truncated)` : s;
}

function formatToolResults(results) {
  const lines = ['[Local tool results — sent by the Muse App, not typed by the user]'];
  for (const r of results) {
    lines.push('', `## ${r.tool}: ${r.ok ? 'ok' : 'failed'}`, truncate(r.output));
  }
  return lines.join('\n');
}

// ask(text) -> Muse's reply text. execute(call) -> {ok, output}.
// onStep({step, calls, results}) is called after each executed round.
async function runLoop({initialMessage, ask, execute, shouldStop = () => false, onStep = () => {}, maxSteps = MAX_STEPS, maxCallsPerReply = MAX_CALLS_PER_REPLY}) {
  let message = initialMessage, steps = 0, finalText = '';
  while (steps < maxSteps) {
    if (shouldStop()) return {status: 'stopped', steps, finalText};
    const reply = await ask(message);
    steps++;
    finalText = typeof reply === 'string' ? reply : '';
    const {calls, errors} = extractToolCalls(finalText);
    if (!calls.length && !errors.length) return {status: 'completed', steps, finalText};
    const results = errors.map(e => ({tool: '(invalid call)', ok: false, output: e}));
    const batch = calls.slice(0, maxCallsPerReply);
    let done = null;
    for (const raw of batch) {
      const call = validateCall(raw);
      if (typeof call === 'string') { results.push({tool: String(raw?.tool || '(invalid call)'), ok: false, output: call}); continue; }
      if (call.tool === 'done') { done = call; break; }
      if (shouldStop()) break;
      const r = await execute(call);
      results.push({tool: call.tool, ok: !!r?.ok, output: truncate(r?.output ?? '')});
    }
    onStep({step: steps, calls: batch, results});
    if (done) return {status: 'done', steps, finalText: done.summary || finalText};
    if (shouldStop()) return {status: 'stopped', steps, finalText};
    if (calls.length > batch.length) {
      results.push({tool: '(note)', ok: true, output: `1回の応答で実行できるのは ${maxCallsPerReply} 件までです。残りの ${calls.length - batch.length} 件は次の応答で再提示してください。`});
    }
    message = formatToolResults(results);
  }
  return {status: 'max-steps', steps, finalText};
}

module.exports = {
  MAX_STEPS, MAX_CALLS_PER_REPLY, MAX_COMMAND_LENGTH, RESULT_BUDGET, TOOLS,
  extractToolCalls, validateCall, resolveToolPath,
  buildTaskMessage, formatToolResults, truncate, runLoop,
};
