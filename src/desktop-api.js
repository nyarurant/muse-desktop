'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow,ipcMain,dialog,safeStorage,session,shell}=require('electron');
const MarkdownIt=require('markdown-it');
const {MuseClient,captureCredentials}=require('./muse-client');
const markdown=new MarkdownIt({html:false,linkify:true,breaks:true});
const appUrl=pathToFileURL(path.join(__dirname,'app.html')).href;
function setupDesktop({getWindow,openTools}) {
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
    if(pins[id]&&pins[id]!==fingerprint)throw new Error('Muse の VM キーが変わりました。接続先の変更を確認して、通信記録を読み込み直してください。');
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
  handle('send',async(text,id='')=>{
    validId(id);if(typeof text!=='string'||!text.trim()||text.length>100000)throw new Error('メッセージを入力してください（上限 100,000 文字）。');
    if(sendInFlight)throw new Error('送信処理中です。');sendInFlight=true;
    try{const result=await client.send(text,id,nodeId);draftSessions.delete(id);return result;}finally{sendInFlight=false;}
  });
  handle('cancel',id=>client.cancel(validId(id)));
  // The recorded web client allocates a draft UUID locally. Its first
  // chat.stream submission creates the thread; /session/start is a different API.
  handle('new-session',()=>{const id=crypto.randomUUID();draftSessions.add(id);return {session_id:id,draft:true};});
  handle('subscribe',id=>client.subscribe(draftSessions.has(validId(id))?'':id));
  handle('approvals',()=>client.request('GET','/approvals',{}, {service:1}));
  handle('decide',(id,decision)=>{
    if(!['allow_once','deny'].includes(decision))throw new Error('承認の指定が正しくありません。');
    return client.request('POST','/approvals/'+encodeURIComponent(validId(id))+'/decide',{decision},{service:1});
  });
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
    let checking=false;
    const check=async()=>{
      if(checking)return;checking=true;
      try {const auth=await fetchJson('/api/auth/check',{});if(auth?.ok){await client.refreshCredentials();if(client.credentials?.token){loginWindow?.close();await connect();emit('authenticated',{});}}}catch{}finally{checking=false;}
    };
    loginWindow.webContents.on('did-finish-load',check);
    loginWindow.webContents.on('did-navigate-in-page',check);
    loginWindow.on('closed',()=>{loginWindow=null;});loginWindow.loadURL('https://muse.ai/');return true;
  });
  app.on('before-quit',()=>client.disconnect(false));
  return {client,connect};
}
module.exports={setupDesktop};
