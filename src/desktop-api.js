'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow,ipcMain,dialog,safeStorage,session,shell}=require('electron');
const MarkdownIt=require('markdown-it');
const {MuseClient,captureCredentials}=require('./muse-client');
const {MODES:APPROVAL_MODES,decide:decideApproval}=require('./muse-approval-policy');
const {MESSAGE:RESUME_MESSAGE,RESUMABLE,plan:planResume,record:recordResume}=require('./auto-resume');
const {createWatcher: createLoginWatcher,MESSAGES: LOGIN_MESSAGES,timeoutMessage: loginTimeoutMessage}=require('./login-flow');
const {runLoop: runAgentLoop,buildTaskMessage}=require('./local-agent');
const {messageFromEvent}=require('./chat-model');
const markdown=new MarkdownIt({html:false,linkify:true,breaks:true});
const appUrl=pathToFileURL(path.join(__dirname,'app.html')).href;
function setupDesktop({getWindow,openTools,localBridge}) {
  const dataDir=app.getPath('userData');fs.mkdirSync(dataDir,{recursive:true});
  const authFile=path.join(dataDir,'muse-session.enc');
  const pinsFile=path.join(dataDir,'gateway-pins.json');
  let pins={};try{pins=JSON.parse(fs.readFileSync(pinsFile,'utf8'));}catch{}
  let credentials=null;try{if(safeStorage.isEncryptionAvailable())credentials=JSON.parse(safeStorage.decryptString(fs.readFileSync(authFile)));}catch{}
  function saveCredentials(value) {
    if(!safeStorage.isEncryptionAvailable())throw new Error('Windows の暗号化ストレージを利用できません。');
    const temp=authFile+'.tmp';fs.writeFileSync(temp,safeStorage.encryptString(JSON.stringify(value)));fs.renameSync(temp,authFile);
  }
  function emit(type,value) {const w=getWindow();if(w&&!w.isDestroyed())w.webContents.send('muse:event',{type,...value});}
  async function fetchJson(route,body) {
    const response=await session.defaultSession.fetch('https://muse.ai'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Origin':'https://muse.ai'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error('Muse のログインが必要です。');return response.json();
  }
  const client=new MuseClient({credentials,fetchJson,checkPin:(id,fingerprint)=>{
    if(pins[id]&&pins[id]!==fingerprint)throw new Error('Muse の VM キーが変わりました。接続先の変更を確認して、ログインし直すか通信記録を読み込み直してください。');
    if(!pins[id]){pins[id]=fingerprint;fs.writeFileSync(pinsFile,JSON.stringify(pins));}
  }});
  client.on('credentials',saveCredentials);
  client.on('status',value=>emit('connection',value));
  client.on('event',value=>emit('gateway',{event:value}));
  client.on('stream-error',message=>emit('stream-error',{message}));
  let subscribed=false,loginWindow=null,sendInFlight=false;
  const draftSessions=new Set();
  const nodeIdFile=path.join(dataDir,'device-id');
  let nodeId;try{nodeId=fs.readFileSync(nodeIdFile,'utf8');}catch{nodeId='muse-desktop-'+crypto.randomUUID();fs.writeFileSync(nodeIdFile,nodeId);}
  client.on('status',({status})=>{if(status!=='connected')subscribed=false;});
  async function connect() {await client.connect();if(!subscribed){await client.subscribe();subscribed=true;}return {status:client.status};}
  // ---- Local agent (Claude Code / Codex style) ----
  // The brain is Muse in a dedicated side chat; the local work goes
  // through main.js's bridge, which applies the tools window's approval
  // policy and workspace confinement. Replies are awaited via gateway
  // events, with a history poll as fallback (same message twice in a
  // row counts as settled).
  let agentRun=null;
  function waitAssistantReply(sessionId,baseline,timeoutMs=240000) {
    return new Promise((resolve,reject)=>{
      let lastCandidate=null;
      const cleanup=()=>{clearTimeout(timer);clearInterval(poll);client.off('event',onEvent);};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Muse の応答がタイムアウトしました。'));},timeoutMs);
      const onEvent=value=>{
        const m=messageFromEvent(value);
        if(m&&m.role==='assistant'&&m.sessionId===sessionId&&m.content){cleanup();resolve(m.content);return;}
        if(value?.event==='delta.message_done'){
          const p=value.payload||{};
          if(p.session_id===sessionId){const t=p.transcript;const text=t?.display_text??t?.content??t?.text;if(typeof text==='string'&&text){cleanup();resolve(text);}}
        }
      };
      client.on('event',onEvent);
      const poll=setInterval(async()=>{
        try {
          const data=await client.history(sessionId);
          const msgs=(data.chat_events||[]).map(messageFromEvent).filter(m=>m&&m.role==='assistant'&&m.content&&!baseline.has(m.id));
          const latest=msgs[msgs.length-1];
          if(latest){
            if(lastCandidate&&lastCandidate.id===latest.id&&lastCandidate.content===latest.content){cleanup();resolve(latest.content);}
            else lastCandidate=latest;
          }
        } catch { /* the thread may not exist until the first send lands */ }
      },3000);
      poll.unref?.();
    });
  }
  async function runAgentTask(run,task) {
    const baseline=new Set();
    const snapshot=async()=>{try{const data=await client.history(run.sessionId);for(const ev of data.chat_events||[]){const m=messageFromEvent(ev);if(m)baseline.add(m.id);}}catch{}};
    await snapshot();
    const ask=async text=>{
      const waiting=waitAssistantReply(run.sessionId,baseline);
      await client.send(text,run.sessionId,nodeId);
      const reply=await waiting;
      await snapshot();
      return reply;
    };
    const initial=buildTaskMessage({workspace:localBridge.workspace(),platform:localBridge.platform(),approvalMode:localBridge.approvalMode(),task});
    const result=await runAgentLoop({
      initialMessage:initial,ask,
      execute:async call=>{
        localBridge.report(`\n[Agent tool] ${call.tool}${call.command?' '+call.command:''}${call.path?' '+call.path:''}\n`);
        const r=await localBridge.executeCall(call);
        localBridge.report(`[${r.ok?'ok':'failed'}] ${String(r.output).slice(0,500)}\n`);
        return r;
      },
      shouldStop:()=>run.stopped,
      onStep:({step})=>localBridge.report(`\n[Agent step ${step} done]\n`),
    });
    localBridge.report(`\n[Agent ${result.status}] ${result.steps} step(s)\n${result.finalText||''}\n`);
    emit('agent-done',{status:result.status,sessionId:run.sessionId});
    return result;
  }
  function startAgent(task) {
    if(typeof task!=='string'||!task.trim()||task.length>20000)throw new Error('タスクを入力してください（上限 20,000 文字）。');
    if(agentRun)throw new Error('エージェントは既に実行中です。');
    if(!localBridge)throw new Error('ローカルブリッジが利用できません。');
    if(client.status!=='connected')throw new Error('Muse に接続してからエージェントを開始してください。');
    const run={sessionId:crypto.randomUUID(),stopped:false};
    agentRun=run;
    localBridge.agentStatus({state:'running'});
    localBridge.report(`\n[Agent started] session ${run.sessionId}\nTask: ${task.trim()}\n`);
    runAgentTask(run,task.trim())
      .catch(e=>localBridge.report(`\n[Agent error] ${e.message}\n`))
      .finally(()=>{if(agentRun===run)agentRun=null;localBridge.agentStatus({state:'idle'});});
    return {started:true,sessionId:run.sessionId};
  }
  function stopAgent() {
    if(!agentRun)return false;
    agentRun.stopped=true;
    client.cancel(agentRun.sessionId).catch(()=>{});
    return true;
  }
  function importFile(file) {
    const c=captureCredentials(file);client.disconnect();client.credentials=c;saveCredentials(c);return {imported:true};
  }
  const importArg=process.argv.find(a=>a.startsWith('--import-har='));
  if(importArg)try{importFile(importArg.slice('--import-har='.length));}catch{ /* UI shows reconnect/import controls if invalid. */ }
  function assertSender(event) {
    const w=getWindow();
    if(!w||w.isDestroyed()||event.sender!==w.webContents||event.senderFrame!==w.webContents.mainFrame||event.senderFrame.url!==appUrl)throw new Error('Local Muse app only');
  }
  function handle(name,fn){ipcMain.handle('muse:'+name,async(event,...args)=>{assertSender(event);try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:e.message};}});}
  const validId=id=>{if(typeof id!=='string'||id.length>255)throw new Error('会話 ID が正しくありません。');return id;};
  handle('info',()=>({version:app.getVersion(),status:client.status,hasSession:!!client.credentials,platform:process.platform}));
  handle('connect',connect);
  handle('sessions',()=>client.sessions());
  handle('history',(id='',before)=>{validId(id);if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('履歴の位置が正しくありません。');return client.history(id,before);});
  handle('send',async(text,id='',extra={})=>{
    validId(id);
    const attachments=attachmentItems(extra?.attachments);
    if(typeof text!=='string'||text.length>100000||(!text.trim()&&!attachments.length))throw new Error('メッセージを入力してください（上限 100,000 文字）。');
    const replyTo=extra?.replyTo===undefined||extra?.replyTo===null?undefined:validId(extra.replyTo);
    if(sendInFlight)throw new Error('送信処理中です。');sendInFlight=true;
    try{const result=await client.send(text,id,nodeId,{replyTo,attachments});draftSessions.delete(id);return result;}finally{sendInFlight=false;}
  });
  // Same parts the web client builds: images as `image`, other files inline as `file` (its 10 MB inline limit).
  function attachmentItems(list) {
    if(list===undefined||list===null)return [];
    if(!Array.isArray(list)||list.length>10)throw new Error('添付できるのは 10 個までです。');
    let total=0;
    return list.map(a=>{
      if(!a||typeof a.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))throw new Error('添付ファイルを読み込めませんでした。');
      const size=Math.floor(a.data.length*3/4);total+=size;
      if(size>10*1024*1024)throw new Error('添付できるファイルは 1 つ 10 MB までです。');
      if(total>12*1024*1024)throw new Error('添付ファイルは合計 12 MB までです。');
      const mime=typeof a.type==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(a.type)?a.type.toLowerCase():'application/octet-stream';
      const filename=typeof a.name==='string'&&a.name.trim()?a.name.trim().slice(0,255):'file';
      return {type:mime.startsWith('image/')?'image':'file',mime_type:mime,data_base64:a.data,filename};
    });
  }
  // A stop the user asked for is never auto-resumed.
  handle('cancel',id=>{validId(id);userCancels[id]=Date.now();return client.cancel(id);});
  // The recorded web client allocates a draft UUID locally. Its first
  // chat.stream submission creates the thread; /session/start is a different API.
  handle('new-session',()=>{const id=crypto.randomUUID();draftSessions.add(id);return {session_id:id,draft:true};});
  handle('subscribe',id=>client.subscribe(draftSessions.has(validId(id))?'':id));
  // サイドチャットの操作・検索・リアクション。Web 版と同じゲートウェイ API と引数。
  const SESSION_ACTIONS=['pin','unpin','archive','unarchive','delete'];
  const sessionId=id=>{validId(id);if(!id)throw new Error('メインチャットはこの操作に対応していません。');return id;};
  handle('archived-sessions',()=>client.request('GET','/api/session/list',{limit:100,view:'archived'}));
  handle('session-action',(id,action)=>{
    if(!SESSION_ACTIONS.includes(action))throw new Error('チャットの操作が正しくありません。');
    return client.request('POST','/session/'+action,{method:'/api/session/'+action,session_id:sessionId(id)});
  });
  handle('rename-session',(id,title)=>{
    if(typeof title!=='string'||!title.trim()||title.length>200)throw new Error('名前を入力してください（上限 200 文字）。');
    return client.request('POST','/session/rename',{session_id:sessionId(id),title:title.trim()});
  });
  handle('mark-seen',id=>client.request('POST','/api/chat/'+encodeURIComponent(sessionId(id))+'/seen',{}));
  handle('search',query=>{
    if(typeof query!=='string'||!query.trim()||query.length>500)throw new Error('検索する言葉を入力してください。');
    return client.request('GET','/chat/search',{query:query.trim(),limit:20,all_sessions:true});
  });
  handle('react',(messageId,emoji)=>{
    validId(messageId);if(typeof emoji!=='string'||!emoji||emoji.length>16)throw new Error('リアクションが正しくありません。');
    return client.request('POST','/reactions/toggle',{message_id:messageId,emoji});
  });
  handle('delete-message',messageId=>client.request('POST','/api/chat/delete-turn',{message_id:validId(messageId)}));
  handle('tasks',()=>client.request('GET','/tasks'));
  // フィード・アイデア・目標・ライブラリ（Web 版の左メニューと同じ API）。
  handle('feed',()=>client.request('GET','/api/feed'));
  handle('ideas',()=>client.request('GET','/api/ideas'));
  handle('goals',()=>client.request('GET','/goals'));
  handle('library',(preset,offset=0)=>{
    if(!['artifacts','media'].includes(preset)||!Number.isSafeInteger(offset)||offset<0)throw new Error('ライブラリの指定が正しくありません。');
    return client.request('POST','/fs/library',{preset,limit:40,offset});
  });
  const vmPath=p=>{
    if(typeof p!=='string'||!p||p.length>1024)throw new Error('ファイルの場所が正しくありません。');
    const parts=p.replace(/^\/+/,'').split('/');if(parts.some(x=>!x||x==='.'||x==='..'))throw new Error('ファイルの場所が正しくありません。');
    return '/fs/raw/'+parts.map(encodeURIComponent).join('/');
  };
  // Images shown in the feed, idea cards and library, returned as data: URLs (the page CSP allows no remote images).
  const imageCache=new Map();
  handle('image',async ref=>{
    const route=typeof ref==='string'&&/^\/api\/(?:feed\/units\/[\w-]+\/media\/[\w-]+|idea-cards\/media\/[\w-]+)(?:\?v=[\w-]+)?$/.test(ref)?ref:vmPath(ref);
    if(imageCache.has(route))return imageCache.get(route);
    const r=await client.request('GET',route,{},{raw:true});
    const type=String(r.contentType).split(';')[0].trim().toLowerCase();
    if(!/^image\/(png|jpeg|webp|gif)$/.test(type)||r.data.length>8*1024*1024)return null;
    const url='data:'+type+';base64,'+r.data.toString('base64');
    if(imageCache.size>=200)imageCache.delete(imageCache.keys().next().value);
    imageCache.set(route,url);return url;
  });
  handle('save-file',async p=>{
    const route=vmPath(p),name=p.split('/').pop();
    const target=await dialog.showSaveDialog(getWindow(),{title:'ファイルを保存',defaultPath:path.join(app.getPath('downloads'),name)});
    if(target.canceled||!target.filePath)return {saved:false};
    const r=await client.request('GET',route,{},{raw:true,timeout:120000});
    fs.writeFileSync(target.filePath,r.data);return {saved:true,path:target.filePath};
  });
  handle('approvals',()=>client.request('GET','/approvals',{}, {service:1}));
  handle('decide',(id,decision)=>{
    if(!['allow_once','deny'].includes(decision))throw new Error('承認の指定が正しくありません。');
    return client.request('POST','/approvals/'+encodeURIComponent(validId(id))+'/decide',{decision},{service:1});
  });
  // Muse 承認の自動処理。選んだモード（bypass を含む）は次回起動時も引き継ぐ。
  const modeFile=path.join(dataDir,'approval-mode.json');
  let approvalMode='auto';try{const m=JSON.parse(fs.readFileSync(modeFile,'utf8')).mode;if(APPROVAL_MODES.includes(m))approvalMode=m;}catch{}
  let lastPending=[];const autoTried=new Set();
  async function autoDecide() {
    const mode=approvalMode;
    for(const approval of lastPending) {
      const id=approval?.approval_id;
      if(typeof id!=='string'||autoTried.has(id)||decideApproval(approval,mode)!=='allow_once')continue;
      autoTried.add(id);
      try {
        await client.request('POST','/approvals/'+encodeURIComponent(id)+'/decide',{decision:'allow_once'},{service:1});
        emit('approval-auto',{id,title:approval.display?.summary_title||approval.display?.display_name||'',mode});
      } catch(e) {emit('stream-error',{message:'自動承認に失敗しました（手動で確認してください）: '+e.message});}
    }
  }
  client.on('event',value=>{
    if(value?.event!=='approvals.snapshot')return;
    lastPending=Array.isArray(value.payload?.pending_approvals)?value.payload.pending_approvals:[];
    autoDecide().catch(()=>{});
  });
  // 中断した会話への自動再開指示（auto-resume.js が判定）。設定と送信履歴は次回起動時も引き継ぐ。
  const resumeFile=path.join(dataDir,'auto-resume.json');
  let resume={enabled:true,history:{}};try{const r=JSON.parse(fs.readFileSync(resumeFile,'utf8'));resume={enabled:r.enabled!==false,history:r.history&&typeof r.history==='object'?r.history:{}};}catch{}
  const saveResume=()=>{try{fs.writeFileSync(resumeFile,JSON.stringify(resume));}catch{}};
  const userCancels={};let resumeTimer=null,resumeRunning=false;
  function scheduleResume(ms){clearTimeout(resumeTimer);resumeTimer=setTimeout(()=>checkResume().catch(()=>{}),Math.max(1000,ms));}
  async function checkResume() {
    if(!resume.enabled||client.status!=='connected'||resumeRunning)return;
    resumeRunning=true;
    try{
      const sessions=(await client.sessions())?.sessions||[];
      const cancels={};for(const s of sessions){const t=userCancels[s.is_primary?'':s.session_id];if(t)cancels[s.session_id]=t;}
      const {due,waitMs}=planResume(sessions,{now:Date.now(),cancels,history:resume.history});
      for(const s of due){
        if(sendInFlight){scheduleResume(10000);break;}
        resume.history=recordResume(resume.history,s,Date.now());saveResume();
        const id=s.is_primary?'':s.session_id;
        sendInFlight=true;
        try{await client.send(RESUME_MESSAGE,id,nodeId);emit('auto-resume',{id,title:s.is_primary?'メインチャット':s.title||''});}
        catch(e){emit('stream-error',{message:'自動再開の指示を送れませんでした: '+e.message});}
        finally{sendInFlight=false;}
      }
      if(waitMs!==null)scheduleResume(waitMs+500);
    }finally{resumeRunning=false;}
  }
  client.on('status',({status})=>{if(status==='connected')scheduleResume(3000);});
  client.on('event',value=>{
    const status=String(value?.payload?.status||'').toLowerCase();
    if(value?.event==='sessions.updated'||(['delta.message_done','task.status'].includes(value?.event)&&RESUMABLE.has(status)))scheduleResume(2000);
  });
  setInterval(()=>{if(resume.enabled&&client.status==='connected')checkResume().catch(()=>{});},2*60*1000).unref?.();
  handle('auto-resume',()=>resume.enabled);
  handle('set-auto-resume',enabled=>{resume.enabled=enabled===true;saveResume();if(resume.enabled)scheduleResume(1000);return resume.enabled;});
  handle('approval-mode',()=>approvalMode);
  handle('set-approval-mode',async mode=>{
    if(!APPROVAL_MODES.includes(mode))throw new Error('承認モードの指定が正しくありません。');
    if(mode==='bypass'&&approvalMode!=='bypass') {
      const r=await dialog.showMessageBox(getWindow(),{type:'warning',buttons:['キャンセル','Bypass にする'],defaultId:0,cancelId:0,noLink:true,
        title:'Bypass モード',message:'Muse の承認をすべて自動で許可しますか？',
        detail:'支払い・購入、メディアの送信、注意表示つきの操作も確認なしで許可されます。\nこの設定は次回起動時も引き継がれます。'});
      if(r.response!==1)return approvalMode;
    }
    approvalMode=mode;
    try{fs.writeFileSync(modeFile,JSON.stringify({mode}));}catch{}
    autoDecide().catch(()=>{});
    return approvalMode;
  });
  // Muse の名前・アバター・配色。Web 版と同じゲートウェイ API (/identity, /fs/raw, /api/chat/themes, /activity)。
  let avatarCache=null;
  handle('identity',async()=>{
    const r=await client.request('GET','/identity');
    return {name:typeof r?.name==='string'?r.name.slice(0,80):'',themeColor:typeof r?.avatar?.chat_theme_color==='string'?r.avatar.chat_theme_color:'',
      imagePath:r?.avatar?.image_exists!==false&&typeof r?.avatar?.image_path==='string'?r.avatar.image_path:''};
  });
  handle('avatar',async imagePath=>{
    if(typeof imagePath!=='string'||!imagePath||imagePath.length>512)return null;
    const parts=imagePath.replace(/^\/+/,'').split('/');
    if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('アバターの場所が正しくありません。');
    if(avatarCache?.path===imagePath)return avatarCache.url;
    const r=await client.request('GET','/fs/raw/'+parts.map(encodeURIComponent).join('/'),{},{raw:true});
    const type=String(r.contentType).split(';')[0].trim().toLowerCase();
    if(!/^image\/(png|jpeg|webp|gif)$/.test(type)||r.data.length>8*1024*1024)throw new Error('アバター画像を表示できません。');
    avatarCache={path:imagePath,url:'data:'+type+';base64,'+r.data.toString('base64')};return avatarCache.url;
  });
  handle('themes',()=>client.request('GET','/api/chat/themes'));
  handle('activity',()=>client.request('GET','/activity',{limit:30,capabilities:['ACTIVITY_FEED_GOALS','ACTIVITY_FEED_PEER_CONVERSATIONS']}));
  handle('tools',()=>{openTools();return true;});
  handle('open-link',url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw new Error('このリンクは開けません。');return shell.openExternal(u.href);});
  handle('markdown',text=>{if(typeof text!=='string'||text.length>1000000)throw new Error('表示する文章が大きすぎます。');return markdown.render(text);});
  handle('import',async()=>{const result=await dialog.showOpenDialog(getWindow(),{title:'Muse の通信記録を読み込む',filters:[{name:'DevTools / HAR',extensions:['devtools','har','json']}],properties:['openFile']});if(result.canceled)return {canceled:true};importFile(result.filePaths[0]);return connect();});
  handle('login',()=>{
    if(loginWindow&&!loginWindow.isDestroyed()){loginWindow.show();loginWindow.focus();return true;}
    loginWindow=new BrowserWindow({title:'Muse — ログイン',width:1060,height:780,parent:getWindow(),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}});
    loginWindow.webContents.setWindowOpenHandler(({url})=>{
      if(!url.startsWith('https://'))return {action:'deny'};
      return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}}};
    });
    // Navigation events alone can miss a completed sign-in (popup-based
    // auth, SPA transitions), so poll the login probe while the window is
    // open and surface the stage it is stuck at. Events stay as a nudge
    // to check immediately instead of waiting for the next poll.
    const watcher=createLoginWatcher({
      probe:()=>client.probeLogin(),
      onStage:stage=>emit('login-stage',{stage,message:LOGIN_MESSAGES[stage]||''}),
      onReady:async()=>{
        loginWindow?.close();
        try {await connect();emit('authenticated',{});} catch { /* connect() already reported its status */ }
      },
      onTimeout:stage=>emit('login-stage',{stage:'timeout',message:loginTimeoutMessage(stage)}),
    });
    const nudge=()=>{void watcher.poll();};
    loginWindow.webContents.on('did-finish-load',nudge);
    loginWindow.webContents.on('did-navigate',nudge);
    loginWindow.webContents.on('did-navigate-in-page',nudge);
    loginWindow.on('closed',()=>{watcher.stop();loginWindow=null;});
    watcher.start();
    loginWindow.loadURL('https://muse.ai/');return true;
  });
  app.on('before-quit',()=>client.disconnect(false));
  return {client,connect,startAgent,stopAgent};
}
module.exports={setupDesktop};
