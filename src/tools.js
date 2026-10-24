'use strict';
const api = window.workspaceAPI;
const $ = (id) => document.getElementById(id);
let busy = false;
let workflowRunning = false;
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
  $('status').textContent = flag ? 'Running' : 'Idle';
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
(async function init() {
  const info = await api.info();
  $('folder').textContent = info.workspace;
  setBusy(info.busy);
})().catch(error => append(`\n[Init error] ${error.message}\n`));
$('choose').addEventListener('click', async () => {
  try { $('folder').textContent = await api.chooseFolder(); }
  catch (error) { append(`\n[Error] ${error.message}\n`); }
});
document.querySelectorAll('[data-cmd]').forEach(button => {
  button.addEventListener('click', () => { $('command').value = button.dataset.cmd; });
});
$('run').addEventListener('click', async () => {
  if (busy) return;
  const cmd = $('command').value.trim();
  if (!cmd) { append('\n[Enter a command]\n'); return; }
  try { const result = await api.run(cmd); if (!result.started) append('\n[Not started]\n'); }
  catch (error) { append(`\n[Error] ${error.message}\n`); }
});
$('workflow').addEventListener('click', async () => {
  if (busy) return;
  try { await api.runWorkflow(); }
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
