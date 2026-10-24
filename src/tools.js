'use strict';
const api = window.workspaceAPI;
const $ = (id) => document.getElementById(id);
let busy = false;
let workflowRunning = false;
let changingMode = false;
const modeDescriptions = {
  bypass: 'Bypass: このローカル画面から送った全コマンドを確認せずに実行。危険なコマンドにも確認は出ません。',
  auto: 'Auto: git status/diffなど、正確に一致する読み取りコマンドのみ自動承認。その他は確認。',
  important: 'Only the important ones: 読み取り・npm test/build/lint/typecheck・pytestを自動承認。未登録コマンド（npm installや削除など）は確認。',
};
function append(data) {
  const view = $('output');
  view.textContent += data;
  if (view.textContent.length > 200000) view.textContent = '[Earlier output truncated]\n' + view.textContent.slice(-150000);
  view.scrollTop = view.scrollHeight;
}
function setBusy(flag) {
  busy = flag;
  $('run').disabled = flag;
  $('workflow').disabled = flag;
  $('stop').disabled = !flag;
  $('choose').disabled = flag;
  $('command').disabled = flag;
  document.querySelectorAll('[data-mode]').forEach(b => {b.disabled = flag || changingMode;});
  $('status').textContent = flag ? 'Running' : 'Idle';
}
function applyMode(mode) {
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('mode-description').textContent = modeDescriptions[mode] ?? 'Unknown mode';
}
api.onOutput(append);
api.onStatus(state => {
  setBusy(workflowRunning || state.state === 'running');
  if (state.state === 'running') append(`\n> ${state.command}\n`);
  else append(`\n[Finished: code=${state.exitCode ?? 'none'}, signal=${state.signal ?? 'none'}]\n`);
});
api.onWorkflowStatus(state => {
  workflowRunning = state.state === 'running';
  setBusy(workflowRunning);
  if (!workflowRunning) append(`\n[Workflow: ${state.state}]\n`);
});
api.onApprovalState(state => applyMode(state.mode));
(async function init() {
  const info = await api.info();
  $('folder').textContent = info.workspace;
  applyMode(info.approvalMode);
  setBusy(info.busy);
})().catch(error => append(`\n[Init error] ${error.message}\n`));
$('choose').addEventListener('click', async () => {
  try { $('folder').textContent = await api.chooseFolder(); }
  catch (error) { append(`\n[Error] ${error.message}\n`); }
});
document.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', async () => {
    if (busy || changingMode) return;
    changingMode = true;
    setBusy(busy);
    try { const result = await api.setApprovalMode(button.dataset.mode); applyMode(result.mode); }
    catch (error) { append(`\n[Mode error] ${error.message}\n`); }
    finally { changingMode = false; setBusy(busy); }
  });
});
document.querySelectorAll('[data-cmd]').forEach(button => {
  button.addEventListener('click', () => { $('command').value = button.dataset.cmd; });
});
$('run').addEventListener('click', async () => {
  if (busy || changingMode) return;
  const cmd = $('command').value.trim();
  if (!cmd) { append('\n[Enter a command]\n'); return; }
  try { const result = await api.run(cmd); if (!result.started) append('\n[Not approved / canceled]\n'); }
  catch (error) { append(`\n[Error] ${error.message}\n`); }
});
$('workflow').addEventListener('click', async () => {
  if (busy || changingMode) return;
  try { const result = await api.runWorkflow(); if (result.state === 'canceled') append('\n[Workflow canceled]\n'); }
  catch (error) { append(`\n[Workflow error] ${error.message}\n`); }
});
$('stop').addEventListener('click', async () => {
  try { await api.stop(); } catch (error) { append(`\n[Error] ${error.message}\n`); }
});
$('clear').addEventListener('click', () => { $('output').textContent = ''; });
let agentRunning = false;
function setAgent(running) {
  agentRunning = running;
  $('agent-run').disabled = running;
  $('agent-stop').disabled = !running;
  $('agent-status').textContent = running ? 'Running' : 'Idle';
}
api.onAgentStatus(state => setAgent(state.state === 'running'));
$('agent-run').addEventListener('click', async () => {
  if (agentRunning) return;
  const task = $('agent-task').value.trim();
  if (!task) { append('\n[Enter an agent task]\n'); return; }
  try { const result = await api.agentStart(task); if (result.started) setAgent(true); }
  catch (error) { append(`\n[Agent error] ${error.message}\n`); }
});
$('agent-stop').addEventListener('click', async () => {
  try { await api.agentStop(); append('\n[Agent stop requested]\n'); }
  catch (error) { append(`\n[Agent error] ${error.message}\n`); }
});
