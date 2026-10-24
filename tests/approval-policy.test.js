'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, RULES, getPlan, evaluate } = require('../src/approval-policy');

test('mode definitions exactly match user options', () => {
  assert.deepEqual(MODES, ['auto', 'important', 'bypass']);
});
test('Auto only approves low-risk exact commands', () => {
  assert.equal(evaluate('git status', 'auto').prompt, false);
  assert.equal(evaluate('npm test', 'auto').prompt, true);
  assert.equal(evaluate('npm install', 'auto').prompt, true);
  assert.equal(evaluate('git status && rm -rf .', 'auto').prompt, true);
  assert.equal(evaluate('git status; echo injected', 'auto').prompt, true);
});
test('Only important ones approves exact build/test but prompts on unknown', () => {
  assert.equal(evaluate('npm test', 'important').prompt, false);
  assert.equal(evaluate('npm run build', 'important').prompt, false);
  assert.equal(evaluate('python -m pytest', 'important').prompt, false);
  assert.equal(evaluate('git push --force', 'important').prompt, true);
  assert.equal(evaluate('rm -rf .', 'important').prompt, true);
});
test('Bypass suppresses local prompts but not platform prompts', () => {
  assert.equal(evaluate('rm -rf .', 'bypass').prompt, false);
  assert.equal(evaluate('npm install', 'bypass').prompt, false);
});
test('Allowlisted calls use static arguments; Windows npm uses fixed shell literal', () => {
  assert.deepEqual(getPlan('git status', 'win32').args, ['status']);
  assert.deepEqual(getPlan('npm test', 'win32').args, ['/d', '/s', '/c', 'npm test']);
  assert.equal(getPlan('npm test && whoami', 'win32'), null);
  assert.ok(RULES.every(x => ['low','medium'].includes(x.risk)));
});
test('Invalid modes are rejected', () => {
  assert.throws(() => evaluate('git status', 'unsafe'), /Invalid/);
});
