'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {app,ipcMain,dialog,powerMonitor,safeStorage,session,shell,WebContentsView}=require('electron');
const {createCompanionLink}=require('./companion-link');
const MarkdownIt=require('markdown-it');
const WebSocket=require('ws');
const {MuseClient}=require('./muse-client');
const {MODES:APPROVAL_MODES,decide:decideApproval}=require('./muse-approval-policy');
const {MESSAGE:RESUME_MESSAGE,RESUMABLE,plan:planResume,record:recordResume}=require('./auto-resume');
const {createWatcher: createLoginWatcher,MESSAGES: LOGIN_MESSAGES,timeoutMessage: loginTimeoutMessage}=require('./login-flow');
const {messageFromEvent}=require('./chat-model');
const {review:reviewPcCall}=require('./pc-safety');
const {waitForReply}=require('./agent-reply');
const {PcAuth}=require('./pc-auth');
const {createPcAuthStore}=require('./pc-auth-store');
const {NativeDevice}=require('./native-device');
const {createNativeExecutor}=require('./native-executor');
const markdown=new MarkdownIt({html:false,linkify:true,breaks:true});
const appUrl=pathToFileURL(path.join(__dirname,'app.html')).href;
function setupDesktop({getWindow,localBridge}) {
  const dataDir=app.getPath('userData');fs.mkdirSync(dataDir,{recursive:true});
  const authFile=path.join(dataDir,'muse-session.enc');
  const pinsFile=path.join(dataDir,'gateway-pins.json');
  let pins={};try{pins=JSON.parse(fs.readFileSync(pinsFile,'utf8'));}catch{}
  let credentials=null;try{if(safeStorage.isEncryptionAvailable())credentials=JSON.parse(safeStorage.decryptString(fs.readFileSync(authFile)));}catch{}
  if(credentials?.source!=='login')credentials=null; // captures (.har/.devtools) are no longer accepted; log in instead
  function saveCredentials(value) {
    if(!safeStorage.isEncryptionAvailable())throw new Error('Windows の暗号化ストレージを利用できません。');
    const temp=authFile+'.tmp';fs.writeFileSync(temp,safeStorage.encryptString(JSON.stringify(value)));fs.renameSync(temp,authFile);
  }
  function emit(type,value) {const w=getWindow();if(w&&!w.isDestroyed())w.webContents.send('muse:event',{type,...value});}
  async function fetchJson(route,body) {
    let response;
    try{response=await session.defaultSession.fetch('https://muse.ai'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Origin':'https://muse.ai'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});}
    catch{throw Object.assign(new Error('muse.ai に接続できません。'),{network:true});}
    if(!response.ok)throw new Error('Muse のログインが必要です。');return response.json();
  }
  // The VM's Noise key changes every time the VM restarts, and the web client does not pin it
  // (it trusts the authenticated gateway). Accept the new key like the web client, but keep a
  // record of every change and tell the user instead of failing silently or blocking.
  let keyChanged=false;
  const client=new MuseClient({credentials,fetchJson,requireLogin:true,locale:app.getLocale(),checkPin:(id,fingerprint)=>{
    if(pins[id]===fingerprint)return;
    if(pins[id]){
      keyChanged=true;
      const log=Array.isArray(pins._changes)?pins._changes:[];
      pins._changes=[...log,{vm:id,at:new Date().toISOString(),from:pins[id].slice(0,16),to:fingerprint.slice(0,16)}].slice(-20);
    }
    pins[id]=fingerprint;
    try{fs.writeFileSync(pinsFile,JSON.stringify(pins));}catch{}
  }});
  client.on('credentials',saveCredentials);
  client.on('status',value=>emit('connection',value));
  client.on('event',value=>emit('gateway',{event:value}));
  client.on('stream-error',message=>emit('stream-error',{message}));
  let subscribed=false,sendInFlight=false;
  const draftSessions=new Set();
  const nodeIdFile=path.join(dataDir,'device-id');
  let nodeId;try{nodeId=fs.readFileSync(nodeIdFile,'utf8');}catch{nodeId='muse-desktop-'+crypto.randomUUID();fs.writeFileSync(nodeIdFile,nodeId);}
  client.on('status',({status})=>{if(status!=='connected')subscribed=false;});
  async function connect() {
    await client.connect();if(!subscribed){await client.subscribe();subscribed=true;}
    autoConnectPc();
    const changed=keyChanged;keyChanged=false;
    return {status:client.status,keyChanged:changed};
  }
  // ---- Native PC authentication and structured device control ----
  let pcAuth=null,agentRun=null,nativeDevice=null,pcConnecting=null,pcGeneration=0,lastSentSession='';
  const nativeOwners=new Set();
  const nativeExecutor=createNativeExecutor({workspace:()=>localBridge.workspace(),run:(params,owner)=>localBridge.runNative(params,owner)});
  async function nativeRequest(scope,route,body,bearer) {
    const root=scope==='auth'?'https://hatch-api.meta.ai':'https://api.muse.ai';
    let response;
    try{response=await session.defaultSession.fetch(root+route,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json','X-API-Version':'1.0.0',...(bearer?{Authorization:'Bearer '+bearer}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});}
    catch{throw new Error('Muse の PC 認証サービスへ接続できません。自動で再送はしません。');}
    let result;try{result=await response.json();}catch{throw new Error('Muse の PC 認証応答を確認できません。');}
    if(!response.ok)throw Object.assign(new Error('PC の認証を完了できませんでした（HTTP '+response.status+'）。入力内容と認証コードを確認してください。'),{status:response.status});
    return result;
  }
  async function sdkRequest(method) {
    let response;
    try{response=await session.defaultSession.fetch('https://gadgets.muse.ai/api/sdk-tokens',{method,redirect:'error',headers:{'Content-Type':'application/json','Origin':'https://gadgets.muse.ai'},...(method==='POST'?{body:JSON.stringify({label:'Muse App Windows PC'})}:{}),signal:AbortSignal.timeout(20000)});}
    catch{throw new Error('SDK トークンの応答を確認できません。自動で再発行はしません。');}
    if(!response.ok)throw new Error('SDK トークンを準備できませんでした（HTTP '+response.status+'）。Muse へのログイン状態を確認してください。');
    return response.json();
  }
  function auth() {
    if(!pcAuth)pcAuth=new PcAuth({...createPcAuthStore({directory:dataDir,safeStorage}),request:nativeRequest,listSdk:()=>sdkRequest('GET'),issueSdk:()=>sdkRequest('POST'),expectedVm:async()=>{
      const website=await fetchJson('/api/session');return website?.vm_id;
    }});
    return pcAuth;
  }
  function agentState(run,state,extra={}) {
    const value={state,sessionId:run.viewSessionId,...extra};localBridge.agentStatus(value);emit('pc-agent',value);
  }
  // ---- Guard for risky PC operations (src/pc-safety.js): ask before they run. On by default. ----
  const guardFile=path.join(dataDir,'pc-guard.json');
  let pcGuard=true;try{pcGuard=JSON.parse(fs.readFileSync(guardFile,'utf8')).enabled!==false;}catch{}
  async function confirmPcCall(risk,command,params,timeout) {
    const w=getWindow(),win=w&&!w.isDestroyed()?w:null;
    if(win){if(win.isMinimized())win.restore();win.show();win.flashFrame(true);}
    const ms=Math.max(5000,Math.min(120000,(Number(timeout)||120000)-3000));
    const target=command==='system.run'?'コマンド:\n'+String(params.command).slice(0,800):'書き込み先:\n'+String(params.path).slice(0,400);
    const options={type:'warning',buttons:['実行しない','実行する'],defaultId:0,cancelId:0,noLink:true,title:'この PC での操作の確認',
      message:'Muse が「'+risk.reason+'」をしようとしています。実行しますか？',detail:target+'\n\n'+Math.round(ms/1000)+' 秒以内に答えないと、実行しません。',signal:AbortSignal.timeout(ms)};
    try{const r=win?await dialog.showMessageBox(win,options):await dialog.showMessageBox(options);return r.response===1;}
    catch{return false;}
    finally{win?.flashFrame(false);}
  }
  async function connectPc() {
    if(pcConnecting)return pcConnecting;
    pcConnecting=connectPcOnce().finally(()=>{pcConnecting=null;});return pcConnecting;
  }
  async function connectPcOnce() {
    const generation=pcGeneration;
    if(nativeDevice?.connected)return pcState();
    if(localBridge.isBusy())throw new Error('別のローカル操作が実行中です。');
    const deviceAuth=auth();const vm=await deviceAuth.vm();
    if(generation!==pcGeneration)throw new Error('PC の接続を中止しました。');
    nativeDevice?.disconnect();
    const device=new NativeDevice({commands:nativeExecutor.commands,displayName:require('node:os').hostname()+' (Windows PC)',execute:async(command,params,timeout,id)=>{
      const risk=pcGuard?reviewPcCall(command,params,localBridge.workspace()):null;
      if(risk&&!(await confirmPcCall(risk,command,params,timeout)))return {ok:false,error:'The user declined this operation on the PC ('+risk.reason+'). Do not retry it unless the user asks.'};
      const owner='pc-native-'+id;nativeOwners.add(owner);
      try{return await nativeExecutor.execute(command,params,timeout,owner);}finally{nativeOwners.delete(owner);}
    }});
    nativeDevice=device;
    device.on('status',value=>{
      if(nativeDevice!==device)return;
      const message=value.message==='connecting'?'PC に接続しています…':value.connected?'この PC は Muse に直接接続しています。':'PC の直接接続が切れました。設定画面で再接続できます。';
      // While auto-connect is on, drops and retries stay quiet; a manual connect reports its own error.
      emit('pc-connection',{...value,message:value.connected||!pcAutoConnect?message:undefined});
      if(value.connected)pcRetryDelay=0;
      else if(value.message!=='connecting')schedulePcRetry();
      if(!value.connected){
        for(const owner of nativeOwners)localBridge.stop(owner);nativeExecutor.dispose();
        const run=agentRun;
        if(run&&!run.stopped){run.stopped=true;run.controller.abort();userCancels[run.viewSessionId]=Date.now();userCancels[run.sessionId]=Date.now();client.cancel(run.sessionId).catch(()=>{});agentState(run,'idle',{result:'error',message:'PC の直接接続が切れたため、操作を停止しました。'});if(agentRun===run)agentRun=null;}
      }
    });
    device.on('invoke',value=>{
      if(nativeDevice!==device)return;
      const view=agentRun?.viewSessionId??lastSentSession;
      emit('pc-tool',{sessionId:view,phase:value.phase,tool:value.command,path:value.params?.path,command:value.params?.command,ok:!!value.result?.ok,output:value.result?JSON.stringify(value.result.payload??value.result.error).slice(0,32000):undefined});
      if(agentRun)agentState(agentRun,'running',{phase:value.phase==='running'?'executing':'thinking',tool:value.command});
    });
    await device.connect({vm,nodeId:deviceAuth.saved.nodeId});
    if(generation!==pcGeneration){device.disconnect();throw new Error('PC の接続を中止しました。');}
    return pcState();
  }
  // An authenticated PC connects by itself once Muse is connected, and again after a drop
  // (5 s -> 60 s backoff). Turning "このPC" off stops this until it is turned on again or the app restarts.
  let pcAutoConnect=true,pcRetryTimer=null,pcRetryDelay=0;
  function autoConnectPc() {
    clearTimeout(pcRetryTimer);pcRetryTimer=null;
    if(!pcAutoConnect||quitting||nativeDevice?.connected||pcConnecting||client.status!=='connected')return;
    let hasDevice=false;try{hasDevice=auth().snapshot().hasDevice;}catch{}
    if(!hasDevice)return;
    connectPc().then(()=>{pcRetryDelay=0;},()=>schedulePcRetry());
  }
  function schedulePcRetry() {
    if(!pcAutoConnect||pcRetryTimer||quitting)return;
    pcRetryDelay=Math.min(60000,pcRetryDelay?pcRetryDelay*2:5000);
    pcRetryTimer=setTimeout(()=>{pcRetryTimer=null;autoConnectPc();},pcRetryDelay);
  }
  function pcState() {return {workspace:localBridge.workspace(),running:!!agentRun||nativeOwners.size>0,sessionId:agentRun?.viewSessionId,connected:!!nativeDevice?.connected};}
  function authState() {const value=auth().snapshot();return nativeDevice?.connected?{...value,phase:'ready',message:'この PC は Muse に直接接続しています。'}:value;}
  async function startAgent(task,{sessionId,extra={}}={}) {
    if(typeof task!=='string'||!task.trim()||task.length>20000)throw new Error('タスクを入力してください（上限 20,000 文字）。');
    if(agentRun)throw new Error('この PC の操作が実行中です。');
    if(client.status!=='connected')throw new Error('Muse に接続してください。');
    if(!nativeDevice?.connected)throw new Error('先に「PC 接続の設定」でこの PC を認証して接続してください。');
    if(localBridge.isBusy())throw new Error('別のローカル操作が実行中です。');
    if(sessionId!==undefined)validId(sessionId);
    const run={sessionId:sessionId??crypto.randomUUID(),viewSessionId:sessionId,owner:crypto.randomUUID(),controller:new AbortController(),stopped:false};
    if(sessionId===undefined)draftSessions.add(run.sessionId);
    agentRun=run;
    let waiting;
    try{
      if(run.sessionId===''){
        const primary=(await client.sessions())?.sessions?.find(s=>s.is_primary);
        if(!primary?.session_id)throw new Error('メインチャットを取得できませんでした。');run.sessionId=primary.session_id;
      }
      if(run.viewSessionId===undefined)run.viewSessionId=run.sessionId;
      const baseline=new Set();
      if(!draftSessions.has(run.sessionId)){
        const detail=await client.request('GET','/api/session/list/'+encodeURIComponent(run.sessionId));
        if(['running','pending','queued','in_progress','started','waiting_for_approval'].includes(String((detail?.session||detail)?.status||'').toLowerCase()))throw new Error('この会話では Muse が作業中です。');
        const history=await client.history(run.sessionId);for(const event of history.chat_events||[]){const message=messageFromEvent(event);if(message)baseline.add(message.id);}
      }
      agentState(run,'running',{phase:'thinking'});
      // Only completion is observed in chat. Commands/results travel on /link-control.
      waiting=waitForReply({client,sessionId:run.sessionId,baseline,signal:run.controller.signal});
      waiting.promise.catch(()=>{});
      run.sentAttempted=true;
      const ack=await nativeDevice.send(task.trim(),run.sessionId,extra);waiting.accept(ack?.message_id);
      draftSessions.delete(run.sessionId);emit('pc-sent',{sessionId:run.viewSessionId,initial:true});
      await client.subscribeAgent(run.sessionId,run.owner);waiting.refresh();
      waiting.promise.then(()=>agentState(run,'idle',{result:'complete'})).catch(e=>{
        if(!run.stopped)agentState(run,'idle',{result:'error',message:e.message});
      }).finally(()=>{waiting.cancel();client.closeAgentSubscription(run.owner);if(agentRun===run)agentRun=null;});
      return {started:true,sessionId:run.sessionId,session_id:run.viewSessionId};
    }catch(e){waiting?.cancel();if(run.sentAttempted&&agentRun===run)stopAgent();client.closeAgentSubscription(run.owner);if(agentRun===run)agentRun=null;agentState(run,'idle',{result:'error'});throw e;}
  }
  function stopAgent() {
    const run=agentRun;
    pcGeneration++;
    if(run)run.stopped=true;
    for(const owner of nativeOwners)localBridge.stop(owner);
    nativeDevice?.disconnect();nativeExecutor.dispose();
    if(!run)return nativeOwners.size>0;
    run.controller.abort();client.closeAgentSubscription(run.owner);
    userCancels[run.viewSessionId]=Date.now();userCancels[run.sessionId]=Date.now();client.cancel(run.sessionId).catch(()=>{});
    agentState(run,'idle',{result:'stopped'});if(agentRun===run)agentRun=null;return true;
  }
  // Reconnect by itself after the connection drops (e.g. the VM restarted), so auto-approval and
  // auto-resume keep working. Stops when sign-in is needed; backs off 3 s -> 60 s.
  let reconnectTimer=null,reconnectDelay=0,quitting=false;
  function scheduleReconnect() {
    if(reconnectTimer||quitting)return;
    reconnectDelay=Math.min(60000,reconnectDelay?reconnectDelay*2:3000);
    reconnectTimer=setTimeout(async()=>{
      reconnectTimer=null;
      if(client.status==='connected'||client.connecting||quitting)return;
      try{const r=await connect();emit('reconnected',{keyChanged:r.keyChanged});}
      catch{if(!['auth_required','connected'].includes(client.status))scheduleReconnect();}
    },reconnectDelay);
  }
  client.on('status',({status})=>{
    if(status==='connected'){reconnectDelay=0;clearTimeout(reconnectTimer);reconnectTimer=null;}
    else if(status==='disconnected'||status==='error')scheduleReconnect();
  });
  function assertSender(event) {
    const w=getWindow();
    if(!w||w.isDestroyed()||event.sender!==w.webContents||event.senderFrame!==w.webContents.mainFrame||event.senderFrame.url!==appUrl)throw new Error('Local Muse app only');
  }
  function handle(name,fn){ipcMain.handle('muse:'+name,async(event,...args)=>{assertSender(event);try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:e.message};}});}
  const validId=id=>{if(typeof id!=='string'||id.length>255)throw new Error('会話 ID が正しくありません。');return id;};
  handle('info',()=>({version:app.getVersion(),status:client.status,hasSession:!!client.credentials,platform:process.platform}));
  // Recolor the window buttons on the app-drawn title bar when the theme changes.
  handle('title-bar',({color,symbol}={})=>{
    const hex=/^#[0-9a-f]{6}$/i;if(!hex.test(color||'')||!hex.test(symbol||''))throw new Error('色が正しくありません。');
    const w=getWindow();if(w&&!w.isDestroyed()&&typeof w.setTitleBarOverlay==='function')w.setTitleBarOverlay({color,symbolColor:symbol,height:32});
    return true;
  });
  handle('pc-state',pcState);
  handle('pc-guard',()=>pcGuard);
  handle('set-pc-guard',enabled=>{
    if(typeof enabled!=='boolean')throw new Error('設定が正しくありません。');
    pcGuard=enabled;try{fs.writeFileSync(guardFile,JSON.stringify({enabled}));}catch{}return pcGuard;
  });
  handle('pc-auth-state',authState);
  handle('pc-auth-start',accepted=>auth().start(accepted===true));
  handle('pc-auth-send',contact=>auth().send(contact));
  handle('pc-auth-confirm',code=>auth().confirm(code));
  handle('pc-auth-select',index=>auth().select(index));
  handle('pc-auth-two-factor-send',index=>auth().twoFactor(index));
  handle('pc-auth-two-factor-confirm',(index,code)=>auth().twoFactor(index,code));
  handle('pc-auth-cancel',()=>auth().cancel());
  handle('pc-connect',async()=>{pcAutoConnect=true;clearTimeout(pcRetryTimer);pcRetryTimer=null;await connectPc();pcRetryDelay=0;return authState();});
  handle('pc-disconnect',()=>{pcAutoConnect=false;clearTimeout(pcRetryTimer);pcRetryTimer=null;stopAgent();return pcState();});
  handle('pc-start',(text,id='',extra={})=>{
    validId(id);
    const attachments=attachmentItems(extra?.attachments);
    const replyTo=extra?.replyTo===undefined||extra?.replyTo===null?undefined:validId(extra.replyTo);
    return startAgent(text,{sessionId:id,extra:{attachments,replyTo}});
  });
  handle('connect',connect);
  handle('sessions',()=>client.sessions());
  handle('history',(id='',before)=>{validId(id);if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('履歴の位置が正しくありません。');return client.history(id,before);});
  handle('send',async(text,id='',extra={})=>{
    validId(id);
    if(agentRun&&(id===agentRun.viewSessionId||id===agentRun.sessionId))throw new Error('この会話では PC 操作が実行中です。停止してから送信してください。');
    const attachments=attachmentItems(extra?.attachments);
    if(typeof text!=='string'||text.length>100000||(!text.trim()&&!attachments.length))throw new Error('メッセージを入力してください（上限 100,000 文字）。');
    const replyTo=extra?.replyTo===undefined||extra?.replyTo===null?undefined:validId(extra.replyTo);
    if(sendInFlight)throw new Error('送信処理中です。');sendInFlight=true;
    try{const result=await client.send(text,id,nodeId,{replyTo,attachments});draftSessions.delete(id);lastSentSession=draftSessions.has(id)?id:(id?result?.session_id||id:'');return result;}finally{sendInFlight=false;}
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
  handle('cancel',id=>{validId(id);userCancels[id]=Date.now();if(agentRun&&(id===agentRun.viewSessionId||id===agentRun.sessionId))return stopAgent();for(const owner of nativeOwners)localBridge.stop(owner);return client.cancel(id);});
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
  // First part of a text file, for library card previews (markdown / html / plain text).
  const previewCache=new Map();
  handle('text-preview',async p=>{
    const route=vmPath(p);
    if(previewCache.has(route))return previewCache.get(route);
    const r=await client.request('GET',route,{},{raw:true});
    const type=String(r.contentType).split(';')[0].trim().toLowerCase();
    if(!/^(text\/|application\/(json|xml|javascript))/.test(type)&&!/\.(md|txt|html?|json|csv|js|ts|py|css)$/i.test(p))return null;
    const text=r.data.subarray(0,16384).toString('utf8');
    if(previewCache.size>=200)previewCache.delete(previewCache.keys().next().value);
    previewCache.set(route,text);return text;
  });
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
  // New installs start without automatic approvals; the user opts in under 設定 › アクセス許可.
  let approvalMode='manual';try{const m=JSON.parse(fs.readFileSync(modeFile,'utf8')).mode;if(APPROVAL_MODES.includes(m))approvalMode=m;}catch{}
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
        if(agentRun&&s.session_id===agentRun.sessionId)continue;
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
  // Muse's 3D desktop body (kaguya-companion): what happens to it goes to her side chat, and she moves it
  // herself with the companion.act / companion.info PC commands (src/companion-link.js).
  const companionUrl='http://127.0.0.1:38741';
  async function companionRequest(route,body,method='POST') {
    let response;
    try {
      const request={method,headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(3000)};
      if(method!=='GET')request.body=JSON.stringify(body||{});
      response=await session.defaultSession.fetch(companionUrl+route,request);
    } catch { throw new Error('companion unavailable'); }
    if(response.status===409)return {status:409};
    if(!response.ok)throw new Error('companion HTTP '+response.status);
    try{return await response.json();}catch{throw new Error('companion returned invalid JSON');}
  }
  const companionLink=createCompanionLink({dataDir,
    send:(text,id,extra)=>client.status==='connected'?client.send(text,id,nodeId,extra):Promise.reject(Object.assign(new Error('not connected'),{notSubmitted:true})),
    rename:(id,title)=>client.request('POST','/session/rename',{session_id:id,title}),
    sessions:()=>client.sessions(),
    history:id=>client.history(id),
    replyClient:client,
    waitForReply,
    subscribeAgent:(id,scope)=>client.subscribeAgent(id,scope),
    closeAgentSubscription:scope=>client.closeAgentSubscription(scope),
    captureGame:()=>companionRequest('/game-capture',{}),
    gameState:()=>companionRequest('/game',undefined,'GET'),
    say:(text,duration,speechId)=>companionRequest('/say',{text:String(text).slice(0,200),duration:Math.min(15,Math.max(1,Number(duration)||1)),speechId}),
    title:async()=>{const r=await client.request('GET','/identity');return (typeof r?.name==='string'&&r.name.trim()?r.name.trim().slice(0,40):'Muse')+' の身体';},
    idleSeconds:()=>powerMonitor.getSystemIdleTime(),
    log:(...args)=>console.warn(...args)});
  companionLink.start();
  handle('companion-link',()=>companionLink.status());
  handle('set-companion-link',on=>companionLink.setEnabled(on===true));
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
      imagePath:r?.avatar?.image_exists!==false&&typeof r?.avatar?.image_path==='string'?r.avatar.image_path:'',
      videos:avatarVideos(r?.avatar)};
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
  // Same resolution as the web (resolveHatchAvatarPaths): video_variants win, otherwise
  // workspace/avatars/<canonical>.mp4 while idle and <canonical>-working.mp4 while working.
  function avatarVideos(avatar) {
    if(!avatar||avatar.video_exists===false)return {};
    const v=avatar.video_variants&&typeof avatar.video_variants==='object'?avatar.video_variants:{};
    const canonical=typeof avatar.canonical_path==='string'&&/^[\w.-]{1,200}$/.test(avatar.canonical_path)?avatar.canonical_path:'';
    const pick=(value,fallback)=>typeof value==='string'&&value?value:canonical?fallback:'';
    return {idle:pick(v.idle,`workspace/avatars/${canonical}.mp4`),working:pick(v.working,`workspace/avatars/${canonical}-working.mp4`)};
  }
  const avatarVideoCache=new Map();
  handle('avatar-video',async videoPath=>{
    if(typeof videoPath!=='string'||!videoPath||videoPath.length>512)return null;
    const parts=videoPath.replace(/^\/+/,'').split('/');
    if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('アバター動画の場所が正しくありません。');
    if(avatarVideoCache.has(videoPath))return avatarVideoCache.get(videoPath);
    const r=await client.request('GET','/fs/raw/'+parts.map(encodeURIComponent).join('/'),{},{raw:true,timeout:60000});
    const type=String(r.contentType).split(';')[0].trim().toLowerCase();
    if(!/^video\/(mp4|webm|quicktime)$/.test(type)||r.data.length>40*1024*1024)throw new Error('アバター動画を表示できません。');
    const value={type,data:r.data};if(avatarVideoCache.size>=4)avatarVideoCache.clear();avatarVideoCache.set(videoPath,value);return value;
  });
  handle('themes',()=>client.request('GET','/api/chat/themes'));
  // ---- Settings shared with muse.ai web (same gateway routes, so changes show up in both) ----
  // Only display fields leave the main process; anything that looks like a credential is dropped.
  const SECRET_KEY=/token|secret|key|cert|signature|password|credential|cookie|auth/i;
  function displayFields(value,depth=0) {
    if(typeof value==='string')return value.slice(0,500);
    if(typeof value==='number'||typeof value==='boolean'||value===null)return value;
    if(depth>6||typeof value!=='object')return undefined;
    if(Array.isArray(value))return value.slice(0,100).map(v=>displayFields(v,depth+1));
    const out={};for(const [k,v] of Object.entries(value))if(!SECRET_KEY.test(k)){const x=displayFields(v,depth+1);if(x!==undefined)out[k]=x;}
    return out;
  }
  // Connector icons are Meta CDN images; the page CSP blocks remote images, so they come back as data: URLs.
  const connectorIconUrls=new Map(),connectorIcons=new Map();
  handle('connector-icon',async id=>{
    if(typeof id!=='string'||!connectorIconUrls.has(id))return null;
    if(connectorIcons.has(id))return connectorIcons.get(id);
    let url;try{url=new URL(connectorIconUrls.get(id));}catch{return null;}
    if(url.protocol!=='https:'||!/(^|\.)(fbcdn\.net|facebook\.com|meta\.com)$/.test(url.hostname))return null;
    try{
      const r=await session.defaultSession.fetch(url.href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
      const type=String(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(!r.ok||!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(type))return null;
      const data=Buffer.from(await r.arrayBuffer());if(data.length>512*1024)return null;
      const value='data:'+type+';base64,'+data.toString('base64');connectorIcons.set(id,value);return value;
    }catch{return null;}
  });
  async function settled(promise,pick=v=>v){try{return {ok:true,value:displayFields(pick(await promise))};}catch(e){return {ok:false,error:e.message};}}
  // Permission settings live on the "sentinel" service, like /approvals (service 1).
  const permissionRequest=(verb,params)=>client.request(verb,'/permissions/settings',params,{service:1});
  handle('settings-overview',async()=>{
    const [permissions,devices,connectors,channels]=await Promise.all([
      settled(permissionRequest('GET'),v=>({connector_default:v?.connector_default,network_default:v?.network_default,default_content:v?.default_content})),
      settled(client.request('POST','/api/nodes/list',{}),v=>(v?.nodes??v?.devices??[]).map(n=>({node_id:n.node_id,display_name:n.display_name,platform:n.platform,online:n.online===true,connection_state:n.connection_state,last_seen_at:n.last_seen_at}))),
      settled(client.request('GET','/connectors',{surface:'settings'}),v=>(Array.isArray(v?.connectors)?v.connectors:[]).map(c=>{if(typeof c.id==='string'&&typeof c.icon_url==='string')connectorIconUrls.set(c.id,c.icon_url);return {id:c.id,name:c.name,description:c.description,state:c.state};})),
      settled(client.request('GET','/channels/status'),v=>(Array.isArray(v?.channels)?v.channels:[]).map(c=>({provider:c.provider,status:c.status,linked:c.linked===true,enabled:c.enabled===true}))),
    ]);
    return {permissions,devices,connectors,channels};
  });
  // ---- Plan and usage: the web reads them from a Next.js server action ("fetchSubscriptionAction").
  // Its id is a build hash, so it is looked up from the signed-in page's scripts and refreshed on failure.
  let subscriptionAction=null;
  async function websiteText(route) {
    const r=await session.defaultSession.fetch('https://muse.ai'+route,{headers:{'Accept':route==='/'?'text/html':'*/*'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('HTTP '+r.status);return r.text();
  }
  async function findSubscriptionAction() {
    const html=await websiteText('/');
    const queue=[...new Set([...html.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m=>m[1]))],seen=new Set();
    while(queue.length&&seen.size<2000){
      const file=queue.shift();if(seen.has(file))continue;seen.add(file);
      let text;try{text=await websiteText('/_next/static/chunks/'+file);}catch{continue;}
      const found=text.includes('fetchSubscriptionAction')&&text.match(/createServerReference\)\("([0-9a-f]{40,44})"[^)]{0,160}"fetchSubscriptionAction"\)/);
      if(found)return found[1];
      for(const ref of text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g))if(!seen.has(ref[1]))queue.push(ref[1]);
    }
    throw new Error('利用状況を読み込めませんでした。時間をおいて、もう一度開いてください。');
  }
  async function fetchSubscription(retry=true) {
    subscriptionAction??=await findSubscriptionAction();
    let data=null,ok=false;
    try{
      const r=await session.defaultSession.fetch('https://muse.ai/',{method:'POST',headers:{'Next-Action':subscriptionAction,'Accept':'text/x-component','Content-Type':'text/plain;charset=UTF-8','Origin':'https://muse.ai'},body:JSON.stringify([{includeAgreement:true}]),signal:AbortSignal.timeout(15000)});
      ok=r.ok;
      // React Server Components lines look like `1:{...}`; the one with "subscription" is the answer.
      for(const line of (await r.text()).split('\n')){const m=line.match(/^[0-9a-f]+:(\{.*\})\s*$/);if(!m)continue;try{const v=JSON.parse(m[1]);if(v&&typeof v==='object'&&'subscription' in v){data=v;break;}}catch{}}
    }catch{}
    if(!ok||!data?.subscription){if(retry){subscriptionAction=null;return fetchSubscription(false);}throw new Error('利用状況を読み込めませんでした。時間をおいて、もう一度開いてください。');}
    const s=data.subscription,str=v=>typeof v==='string'?v.slice(0,200):null,num=v=>Number.isFinite(v)?v:null;
    return {plan:str(s.tier?.name),paid:s.tier?.isPaid===true,percentUsed:num(s.usage?.percentUsed),resetsAt:num(s.usage?.resetsAt),
      statusSubtitle:str(s.statusSubtitle),usageLabel:str(s.usageRowLabel),usageValue:str(s.usageRowValueLabel),
      topupLabel:str(s.topupRowLabel),topupValue:str(s.topupRowValueLabel),topupBalance:num(s.topupBalance),topupTotal:num(s.topupTotal),
      upgradeLabel:str(s.entryPointCtaLabel)};
  }
  handle('subscription',()=>fetchSubscription());
  // Settings > データコントロール: "help improve AI models" (product_improvements.get / .set on the daemon service).
  handle('training',async()=>{const v=await client.request('GET','/api/product-improvements');return {enabled:v?.training_enabled===true};});
  handle('set-training',async enabled=>{
    if(typeof enabled!=='boolean')throw new Error('設定が正しくありません。');
    const v=await client.request('POST','/api/product-improvements',{training_enabled:enabled});return {enabled:v?.training_enabled===true};
  });
  // ---- Dictation, like the web's microphone button: Meta's Voyager ASR over a duplex WebSocket.
  // The token and socket stay in the main process; the page only streams 16 kHz PCM and gets text back.
  const dictations=new Map();
  handle('dictation-start',async()=>{
    for(const d of dictations.values())d.close();
    let token;
    try{
      const r=await session.defaultSession.fetch('https://muse.ai/api/hatch/voice/voyager-token',{method:'POST',headers:{'Origin':'https://muse.ai'},signal:AbortSignal.timeout(15000)});
      if(r.ok)token=(await r.json())?.token;
    }catch{}
    if(typeof token!=='string'||!token)throw new Error('音声入力を開始できませんでした。Muse へのログイン状態を確認してください。');
    const id=crypto.randomUUID();
    const ws=new WebSocket('wss://shortwave.meta.ai/voyager/v1/asr/duplex?sessionId='+encodeURIComponent(id),{origin:'https://muse.ai',handshakeTimeout:15000,maxPayload:1024*1024});
    const d={ws,accepted:false,queued:[],queuedBytes:0,ending:false,timer:null};
    const send=value=>emit('dictation',{id,...value});
    d.close=()=>{clearTimeout(d.timer);try{ws.close();}catch{}};
    dictations.set(id,d);
    ws.on('open',()=>ws.send(JSON.stringify({mode:'DEFAULT',authorization:{accessToken:token},audioEncoding:'PCM_16KHZ',model:'prod'})));
    ws.on('message',(data,binary)=>{
      if(binary)return;let m;try{m=JSON.parse(String(data));}catch{return;}
      if(m?.error){send({kind:'error',message:'音声認識でエラーが起きました: '+String(m.error.message||'unknown').slice(0,120)});d.close();return;}
      if(!d.accepted){
        if(m?.sessionId!==id)return;
        d.accepted=true;for(const chunk of d.queued)ws.send(chunk);d.queued=[];d.queuedBytes=0;
        if(d.ending)ws.send(JSON.stringify({endStream:{}}));
        send({kind:'ready'});return;
      }
      if(m?.transcript)send({kind:m.transcript.final===true?'final':'partial',text:String(m.transcript.transcript??'').slice(0,4000)});
    });
    ws.on('error',()=>send({kind:'error',message:'音声認識に接続できませんでした。'}));
    ws.on('close',()=>{clearTimeout(d.timer);if(dictations.get(id)===d)dictations.delete(id);send({kind:'closed'});});
    return {id};
  });
  handle('dictation-audio',(id,chunk)=>{
    const d=dictations.get(id);if(!d||d.ending||d.ws.readyState>WebSocket.OPEN)return false;
    const data=Buffer.from(chunk instanceof ArrayBuffer?new Uint8Array(chunk):chunk);
    if(!data.length||data.length>65536)return false;
    if(d.accepted){d.ws.send(data);return true;}
    if(d.queuedBytes+data.length>128000)return false;
    d.queued.push(data);d.queuedBytes+=data.length;return true;
  });
  handle('dictation-stop',id=>{
    const d=dictations.get(id);if(!d)return false;
    d.ending=true;
    if(d.accepted&&d.ws.readyState===WebSocket.OPEN)d.ws.send(JSON.stringify({endStream:{}}));
    d.timer=setTimeout(()=>d.close(),8000);return true;
  });
  handle('set-theme',id=>{
    if(typeof id!=='string'||!/^[\w-]{1,64}$/.test(id))throw new Error('テーマカラーが正しくありません。');
    return client.request('POST','/api/chat/themes/set',{theme_id:id});
  });
  // Same body as the web's patchPermissionDefaults; protocols are left out so the server keeps them.
  handle('set-permission-defaults',async({connector,network}={})=>{
    const values=['auto_allow','always_ask'];
    if(!values.includes(connector)||!values.includes(network))throw new Error('アクセス許可の設定が正しくありません。');
    const v=await permissionRequest('PATCH',{connector_default:connector,network_default:network});
    return {connector_default:v?.connector_default,network_default:v?.network_default};
  });
  handle('activity',()=>client.request('GET','/activity',{limit:30,capabilities:['ACTIVITY_FEED_GOALS','ACTIVITY_FEED_PEER_CONVERSATIONS']}));
  handle('open-link',url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw new Error('このリンクは開けません。');return shell.openExternal(u.href);});
  handle('markdown',text=>{if(typeof text!=='string'||text.length>1000000)throw new Error('表示する文章が大きすぎます。');return markdown.render(text);});
  // ---- Login (required) ----
  // The muse.ai sign-in page is shown inside the main window, in the card of the app's own login
  // screen (app.html #loginScreen). The renderer reports where the card is; Meta's page runs in a
  // sandboxed view and the app never sees what is typed into it.
  let loginView=null,loginWatcher=null,loginBounds=null,loginStage=null;
  function applyLoginBounds() {
    const w=getWindow();if(!loginView||!w||w.isDestroyed())return;
    const r=loginBounds,z=w.webContents.getZoomFactor();
    loginView.setBounds(r?{x:Math.round(r.x*z),y:Math.round(r.y*z),width:Math.round(r.width*z),height:Math.round(r.height*z)}:{x:0,y:0,width:0,height:0});
  }
  function closeLogin() {
    loginWatcher?.stop();loginWatcher=null;loginStage=null;
    if(loginView){const w=getWindow();if(w&&!w.isDestroyed())w.contentView.removeChildView(loginView);loginView.webContents.close();loginView=null;}
  }
  function openLogin() {
    const w=getWindow();if(!w||w.isDestroyed())return false;
    emit('login-required',{stage:loginStage,message:LOGIN_MESSAGES[loginStage]||''});
    if(loginView){if(!loginWatcher.running)loginWatcher.start();return true;}
    loginView=new WebContentsView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}});
    loginView.setBorderRadius?.(20);
    loginView.webContents.setWindowOpenHandler(({url})=>{
      if(!url.startsWith('https://'))return {action:'deny'};
      return {action:'allow',overrideBrowserWindowOptions:{parent:getWindow(),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}}};
    });
    w.contentView.addChildView(loginView);applyLoginBounds();
    // Navigation events alone can miss a completed sign-in (popup-based auth, SPA transitions), so
    // poll the login probe while the login screen is up; events only nudge an immediate check.
    const watcher=loginWatcher=createLoginWatcher({
      probe:()=>client.probeLogin(),
      onStage:stage=>{loginStage=stage;emit('login-stage',{stage,message:LOGIN_MESSAGES[stage]||''});},
      onReady:async()=>{
        closeLogin();
        try {await connect();emit('authenticated',{});} catch { /* connect() already reported its status */ }
      },
      onTimeout:stage=>emit('login-stage',{stage:'timeout',message:loginTimeoutMessage(stage)}),
    });
    const nudge=()=>{if(!watcher.running)watcher.start();else void watcher.poll();};
    for(const name of ['did-finish-load','did-navigate','did-navigate-in-page'])loginView.webContents.on(name,nudge);
    watcher.start();
    loginView.webContents.loadURL('https://muse.ai/');return true;
  }
  handle('login',openLogin);
  handle('login-state',()=>({active:!!loginView,stage:loginStage,message:LOGIN_MESSAGES[loginStage]||''}));
  handle('login-reload',()=>{loginView?.webContents.loadURL('https://muse.ai/');return !!loginView;});
  handle('login-bounds',rect=>{
    const ok=rect&&['x','y','width','height'].every(k=>Number.isFinite(rect[k])&&rect[k]>=0&&rect[k]<100000);
    loginBounds=ok?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;applyLoginBounds();return true;
  });
  // A logged-out website session (or a rejected token) puts the whole app on the login screen.
  client.on('status',({status})=>{if(status==='auth_required')openLogin();});
  app.on('before-quit',()=>{quitting=true;clearTimeout(reconnectTimer);clearTimeout(pcRetryTimer);stopAgent();client.disconnect(false);});
  return {client,connect,startAgent,stopAgent,isAgentRunning:()=>!!agentRun||nativeOwners.size>0};
}
module.exports={setupDesktop};
