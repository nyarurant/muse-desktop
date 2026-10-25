'use strict';
// Local work page inside the main window: workspace folder, local commands, PC tasks and the run log.
(function(){
  const api=window.workspace;
  const byId=id=>document.getElementById(id);
  let commandBusy=false,workflowRunning=false,taskRunning=false;
  function append(data){
    const view=byId('wsOutput');
    view.textContent+=data;
    if(view.textContent.length>200000)view.textContent='[以前の出力は省略しました]\n'+view.textContent.slice(-150000);
    view.scrollTop=view.scrollHeight;
  }
  function setBusy(flag){
    commandBusy=flag;
    for(const id of ['wsRun','wsWorkflow','wsChoose','wsCommand'])byId(id).disabled=flag;
    byId('wsStop').disabled=!flag;
    renderStatus();
  }
  function setTask(running){
    taskRunning=running;
    byId('wsTaskRun').disabled=running;byId('wsTaskStop').disabled=!running;
    byId('wsTaskStatus').textContent=running?'実行中':'待機中';
    renderStatus();
  }
  function renderStatus(){
    const running=commandBusy||taskRunning;
    byId('wsStatus').dataset.running=String(running);byId('wsStatusText').textContent=running?'実行中':'待機中';
  }
  function renderPc(pc){
    const connected=pc?.connected===true;
    byId('wsPcDot').className='status-dot'+(connected?' connected':'');
    byId('wsPcText').textContent=connected?'接続中':'未接続';
    byId('wsPcMode').setAttribute('aria-checked',String(connected));
    byId('wsPcModeText').textContent=connected?'オン':'オフ';
    if(pc?.workspace)byId('wsFolder').textContent=pc.workspace;
  }
  async function refreshPc(){try{const r=await window.muse.pcState();if(r.ok)renderPc(r.value);}catch{}}
  async function refreshInfo(){
    const info=await api.info();
    byId('wsFolder').textContent=info.workspace;setBusy(workflowRunning||info.busy);
  }
  window.onWorkspaceShown=()=>{refreshInfo().catch(e=>append('\n[エラー] '+e.message+'\n'));refreshPc();};

  api.onOutput(append);
  api.onStatus(state=>{
    setBusy(workflowRunning||state.state==='running');
    if(state.state==='running')append('\n> '+state.command+'\n');
    else append('\n[終了: code='+(state.exitCode??'none')+', signal='+(state.signal??'none')+']\n');
  });
  api.onWorkflowStatus(state=>{
    workflowRunning=state.state==='running';setBusy(workflowRunning);
    if(!workflowRunning)append('\n[テスト → ビルド: '+({finished:'完了',failed:'失敗',stopped:'停止'}[state.state]||state.state)+']\n');
  });
  api.onAgentStatus(state=>setTask(state.state==='running'));
  window.muse.onEvent(value=>{if(value.type==='pc-connection')refreshPc();});

  byId('wsPcSetup').addEventListener('click',()=>window.openPcSetup?.());
  byId('wsPcMode').addEventListener('click',async()=>{const b=byId('wsPcMode');b.disabled=true;try{await window.togglePc?.();}finally{b.disabled=false;refreshPc();}});
  byId('wsChoose').addEventListener('click',async()=>{
    try{byId('wsFolder').textContent=await api.chooseFolder();}catch(e){append('\n[エラー] '+e.message+'\n');}
  });
  for(const button of document.querySelectorAll('[data-ws-cmd]'))button.addEventListener('click',()=>{byId('wsCommand').value=button.dataset.wsCmd;byId('wsCommand').focus();});
  byId('wsRun').addEventListener('click',async()=>{
    if(commandBusy)return;
    const cmd=byId('wsCommand').value.trim();
    if(!cmd){append('\n[コマンドを入力してください]\n');return;}
    try{const result=await api.run(cmd);if(!result.started)append('\n[開始できませんでした]\n');}catch(e){append('\n[エラー] '+e.message+'\n');}
  });
  for(const [input,button] of [['wsCommand','wsRun'],['wsTask','wsTaskRun']])byId(input).addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();byId(button).click();}});
  byId('wsWorkflow').addEventListener('click',async()=>{
    if(commandBusy)return;
    try{await api.runWorkflow();}catch(e){append('\n[テスト → ビルドのエラー] '+e.message+'\n');}
  });
  byId('wsStop').addEventListener('click',async()=>{try{await api.stop();}catch(e){append('\n[エラー] '+e.message+'\n');}});
  byId('wsClear').addEventListener('click',()=>{byId('wsOutput').textContent='';});
  byId('wsTaskRun').addEventListener('click',async()=>{
    if(taskRunning)return;
    const task=byId('wsTask').value.trim();
    if(!task){append('\n[タスクを入力してください]\n');return;}
    try{const result=await api.agentStart(task);if(result.started)setTask(true);}catch(e){append('\n[PC タスクのエラー] '+e.message+'\n');}
  });
  byId('wsTaskStop').addEventListener('click',async()=>{
    try{await api.agentStop();append('\n[PC タスクの停止を指示しました]\n');}catch(e){append('\n[PC タスクのエラー] '+e.message+'\n');}
  });
  refreshInfo().catch(()=>{});refreshPc();
})();
