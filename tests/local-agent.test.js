'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  extractToolCalls, validateCall, resolveWorkspacePath,
  buildTaskMessage, formatToolResults, runLoop,
} = require('../src/local-agent');

test('tool calls are extracted from fenced blocks amid prose', () => {
  const text = 'まず確認します。\n```local-tool\n{"tool":"list"}\n```\nそれから:\n```local-tool\n{"tool":"read","path":"a.js"}\n```\n以上。';
  const {calls, errors} = extractToolCalls(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(calls.map(c => c.tool), ['list', 'read']);
  assert.deepEqual(extractToolCalls('ツールなしの回答'), {calls: [], errors: []});
  assert.deepEqual(extractToolCalls('```json\n{"tool":"run"}\n```').calls, []); // only local-tool fences count
});

test('a malformed block is reported, not silently dropped', () => {
  const {calls, errors} = extractToolCalls('```local-tool\n{not json}\n```');
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(extractToolCalls('```local-tool\n[1,2]\n```').errors.length, 1);
});

test('validateCall normalizes good calls and names bad ones', () => {
  assert.deepEqual(validateCall({tool: 'run', command: 'npm test'}), {tool: 'run', command: 'npm test'});
  assert.deepEqual(validateCall({tool: 'read', path: 'a.js', start: 2}), {tool: 'read', path: 'a.js', start: 2});
  assert.match(validateCall({tool: 'nope'}), /不明なツール/);
  assert.match(validateCall({tool: 'run'}), /command/);
  assert.match(validateCall({tool: 'run', command: 'x'.repeat(1501)}), /長すぎます/);
  assert.match(validateCall({tool: 'write', path: 'a.txt'}), /content/);
  assert.match(validateCall({tool: 'edit', path: 'a.txt', old: '', new: 'x'}), /old/);
  assert.match(validateCall({tool: 'read', path: 'a.js', start: 0}), /1 以上/);
});

test('file paths are confined to the workspace', () => {
  const ws = path.resolve('/work');
  assert.equal(resolveWorkspacePath(ws, 'src/a.js'), path.join(ws, 'src', 'a.js'));
  assert.equal(resolveWorkspacePath(ws, '.'), ws);
  assert.equal(resolveWorkspacePath(ws, '../outside.txt'), null);
  assert.equal(resolveWorkspacePath(ws, 'src/../../outside.txt'), null);
  assert.equal(resolveWorkspacePath(ws, '/etc/passwd'), null);
  assert.equal(resolveWorkspacePath(ws, ''), null);
});

test('the task message explains the protocol and carries the task', () => {
  const msg = buildTaskMessage({workspace: '/work', platform: 'win32', approvalMode: 'auto', task: 'テストを通して'});
  assert.match(msg, /local-tool/);
  assert.match(msg, /テストを通して/);
  assert.match(msg, /Workspace: \/work/);
});

test('results are formatted as one follow-up message', () => {
  const text = formatToolResults([{tool: 'run', ok: true, output: 'exit 0'}, {tool: 'read', ok: false, output: 'denied'}]);
  assert.match(text, /## run: ok/);
  assert.match(text, /## read: failed/);
});

// Loop behaviour with a scripted brain and a recording executor.
function harness(replies, executeImpl) {
  const asked = [], executed = [];
  let i = 0;
  return {
    asked, executed,
    ask: async text => { asked.push(text); return replies[Math.min(i++, replies.length - 1)]; },
    execute: async call => { executed.push(call); return executeImpl ? executeImpl(call) : {ok: true, output: 'did ' + call.tool}; },
  };
}
const call = obj => '```local-tool\n' + JSON.stringify(obj) + '\n```';

test('the loop runs calls, feeds results back, and ends on done', async () => {
  const h = harness([
    call({tool: 'run', command: 'npm test'}),
    '直しました。\n' + call({tool: 'done', summary: 'all green'}),
  ]);
  const r = await runLoop({initialMessage: 'task', ask: h.ask, execute: h.execute});
  assert.equal(r.status, 'done');
  assert.equal(r.finalText, 'all green');
  assert.equal(r.steps, 2);
  assert.deepEqual(h.executed.map(c => c.tool), ['run']);
  assert.match(h.asked[1], /## run: ok/);
});

test('a reply without calls completes the loop', async () => {
  const h = harness(['最終回答です。']);
  const r = await runLoop({initialMessage: 'task', ask: h.ask, execute: h.execute});
  assert.equal(r.status, 'completed');
  assert.equal(h.executed.length, 0);
});

test('denied and invalid calls come back as failed results', async () => {
  const h = harness([
    call({tool: 'write', path: 'a.txt', content: 'x'}) + '\n' + call({tool: 'bogus'}),
    '了解です。',
  ], async () => ({ok: false, output: 'User denied this call.'}));
  const r = await runLoop({initialMessage: 'task', ask: h.ask, execute: h.execute});
  assert.equal(r.status, 'completed');
  assert.match(h.asked[1], /## write: failed/);
  assert.match(h.asked[1], /User denied/);
  assert.match(h.asked[1], /不明なツール/);
});

test('the loop stops at maxSteps and when asked to stop', async () => {
  const h = harness([call({tool: 'list'})]);
  const r = await runLoop({initialMessage: 'task', ask: h.ask, execute: h.execute, maxSteps: 3});
  assert.equal(r.status, 'max-steps');
  assert.equal(r.steps, 3);
  const h2 = harness([call({tool: 'list'})]);
  const r2 = await runLoop({initialMessage: 'task', ask: h2.ask, execute: h2.execute, shouldStop: () => true});
  assert.equal(r2.status, 'stopped');
  assert.equal(h2.asked.length, 0);
});

test('calls beyond the per-reply cap are deferred with a note', async () => {
  const many = Array.from({length: 6}, () => call({tool: 'list'})).join('\n');
  const h = harness([many, '終わり']);
  const r = await runLoop({initialMessage: 'task', ask: h.ask, execute: h.execute});
  assert.equal(r.status, 'completed');
  assert.equal(h.executed.length, 4);
  assert.match(h.asked[1], /残りの 2 件/);
});
