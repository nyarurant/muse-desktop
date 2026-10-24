'use strict';

// This is a convenience filter for LOCAL commands, not a security sandbox.
// Even "npm test" may execute arbitrary project scripts. Nothing here may be
// invoked by an untrusted web page.
const MODES = Object.freeze(['auto', 'important', 'bypass']);
const RULES = Object.freeze([
  {text: 'git status', bin: 'git', args: ['status'], risk: 'low'},
  {text: 'git status --short', bin: 'git', args: ['status', '--short'], risk: 'low'},
  {text: 'git diff --stat', bin: 'git', args: ['diff', '--stat'], risk: 'low'},
  {text: 'git diff --name-only', bin: 'git', args: ['diff', '--name-only'], risk: 'low'},
  {text: 'git branch --show-current', bin: 'git', args: ['branch', '--show-current'], risk: 'low'},
  {text: 'git log -1 --oneline', bin: 'git', args: ['log', '-1', '--oneline'], risk: 'low'},
  {text: 'node --version', bin: 'node', args: ['--version'], risk: 'low'},
  {text: 'npm --version', bin: 'npm', args: ['--version'], risk: 'low'},
  {text: 'npm test', bin: 'npm', args: ['test'], risk: 'medium'},
  {text: 'npm run build', bin: 'npm', args: ['run', 'build'], risk: 'medium'},
  {text: 'npm run lint', bin: 'npm', args: ['run', 'lint'], risk: 'medium'},
  {text: 'npm run typecheck', bin: 'npm', args: ['run', 'typecheck'], risk: 'medium'},
  {text: 'python -m pytest', bin: 'python', args: ['-m', 'pytest'], risk: 'medium'},
]);

function getPlan(command, platform = process.platform) {
  if (typeof command !== 'string' || command.length > 1500) return null;
  const normalized = command.trim().replace(/\s+/g, ' ');
  const rule = RULES.find(item => item.text === normalized);
  if (!rule) return null;
  // Windows .cmd launch uses a shell, but only with literal fixed rules.
  if (platform === 'win32' && rule.bin === 'npm') {
    return {
      command: 'cmd.exe', args: ['/d', '/s', '/c', rule.text],
      display: rule.text, risk: rule.risk,
    };
  }
  return {
    command: rule.bin, args: [...rule.args], display: rule.text, risk: rule.risk,
  };
}

function evaluate(command, mode, platform = process.platform) {
  if (!MODES.includes(mode)) throw new Error('Invalid approval mode');
  const plan = getPlan(command, platform);
  if (mode === 'bypass') {
    return {prompt: false, approved: true, plan, risk: plan?.risk || 'unclassified'};
  }
  if (plan && (plan.risk === 'low' || mode === 'important')) {
    return {prompt: false, approved: true, plan, risk: plan.risk};
  }
  return {prompt: true, approved: false, plan, risk: plan?.risk || 'unclassified'};
}
module.exports = {MODES, RULES, getPlan, evaluate};
