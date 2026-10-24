'use strict';
const $=id=>document.getElementById(id);
const state={connected:false,connecting:false,sessions:[],selected:'',messages:[],hasMore:false,loading:false,loadId:0,pending:null,busy:new Map(),drafts:new Map(),draftSessions:new Set(),approvals:[],renderId:0};
async function call(name,...args){const r=await window.muse[name](...args);if(!r.ok)throw new Error(r.error);return r.value;}
function notice(message){$('noticeText').textContent=message;$('notice').hidden=false;}
function safely(fn){return async(...args)=>{try{return await fn(...args);}catch(e){notice(e.message);}};}
function isCurrent(payload){return payload?.is_thread?payload.session_id===state.selected:state.selected==='';}
function busy(){return state.busy.get(state.selected)===true;}
function controls(){
  const connected=state.connected;
  $('send').disabled=!connected||state.loading||state.connecting||busy()||!!state.pending||!$('prompt').value.trim();
  $('stop').hidden=!connected||!busy();
  $('thinking').hidden=!busy();
  $('refresh').disabled=!connected||state.loading;
  $('newChat').disabled=!connected||state.loading||state.connecting;
  $('loadMore').disabled=state.loading;
  $('footerStatus').textContent=state.pending?'送信を確認しています…':!connected?'接続すると送信できます':state.loading?'履歴を読み込んでいます…':busy()?'Muse が応答中です':'接続済み · 暗号化通信';
  $('sendHint').textContent=busy()?'応答中':state.pending?'送信中':'Enter で送信';
}
function setConnection(status,message){
  state.connected=status==='connected';state.connecting=status==='connecting';
  for(const id of ['connectionDot','sidebarDot'])$(''+id).className='status-dot '+status;
  $('connectionLabel').textContent=state.connected?'接続済み':state.connecting?'接続中…':'接続する';
  $('sidebarStatus').textContent=state.connected?'Muse に接続中':state.connecting?'接続しています…':'未接続';
  $('connect').disabled=state.connecting;
  $('welcomeTitle').textContent='今日は、何を進めよう。';
  $('welcomeDescription').textContent=state.connected?'考えたいこと、進めたいこと。ここから始めましょう。':'Muse に接続して、会話を続けましょう。';
  $('welcomeActions').hidden=state.connected;
  if(!state.connected){state.busy.clear();state.pending=null;}
  if(['error','auth_required'].includes(status)&&message)notice(message);
  controls();
}
function sessionTitle(s){return s?.title||s?.snippet?.slice(0,45)||(s?.is_primary?'Muse':'新しい会話');}
function renderSessions(){
  const host=$('sessions');host.replaceChildren();const search=$('search').value.toLocaleLowerCase();
  for(const s of state.sessions){
    const title=sessionTitle(s);if(search&&!title.toLocaleLowerCase().includes(search))continue;
    const id=s.is_primary?'':s.session_id;
    const button=document.createElement('button');button.className='session'+(state.selected===id?' active':'');button.title=title;button.setAttribute('aria-current',state.selected===id?'page':'false');
    if(state.selected===id){const dot=document.createElement('span');dot.className='session-dot';button.append(dot);}
    const label=document.createElement('span');label.className='session-text';label.textContent=title;button.append(label);button.addEventListener('click',safely(()=>select(id)));host.append(button);
  }
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent=search?'一致する会話がありません。':state.connected?'会話はまだありません。':'接続すると会話が表示されます。';host.append(p);}
  const s=state.sessions.find(s=>(s.is_primary?'':s.session_id)===state.selected);
  $('conversationTitle').textContent=s?sessionTitle(s):'Muse';
  $('conversationSubtitle').textContent=state.selected?'会話':'あなたの作業を、一つの会話から。';
}
async function refreshSessions(){const r=await call('sessions');state.sessions=r.sessions||[];for(const id of state.draftSessions)if(!state.sessions.some(s=>s.session_id===id))state.sessions.unshift({session_id:id,is_primary:false,title:'新しい会話'});renderSessions();}
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function messageNode(m){
  const article=document.createElement('article');article.dataset.messageId=m.id;
  const header=document.createElement('div');header.className='message-header';
  const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=m.role==='user'?'Y':'m';avatar.setAttribute('aria-hidden','true');
  const name=document.createElement('span');name.textContent=m.role==='user'?'???':'Muse';
  const time=document.createElement('time');header.append(avatar,name,time);
  const body=document.createElement('div');body.className='message-body';article.append(header,body);
  if(!m.pending){
    const actions=document.createElement('div');actions.className='message-actions';
    const copy=document.createElement('button');copy.className='icon-button';copy.title='???';copy.setAttribute('aria-label','?????????');copy.append(icon('copy'));
    copy.addEventListener('click',safely(async()=>{await navigator.clipboard.writeText(article.message.content);copy.title='???????';copy.setAttribute('aria-label','???????');}));
    actions.append(copy);article.append(actions);
  }
  return article;
}
async function renderMessages({forceBottom=false}={}){
  const version=++state.renderId,transcript=$('transcript'),nearBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<140;
  const messages=state.messages.slice();
  if(state.pending&&state.pending.sessionId===state.selected&&!messages.some(m=>m.role==='user'&&m.content===state.pending.text&&m.time>=state.pending.time-5000))messages.push({id:'pending',role:'user',content:state.pending.text,time:state.pending.time,pending:true});
  const host=$('messages'),existing=new Map([...host.children].map(n=>[n.dataset.messageId,n])),updates=[];
  for(const m of messages){
    const article=existing.get(m.id)||messageNode(m);
    let html;
    if(article.message?.content!==m.content&&m.role==='assistant'){
      try{html=await call('renderMarkdown',m.content);}catch{html=null;}
      if(version!==state.renderId)return;
    }
    updates.push({m,article,html});
  }
  if(version!==state.renderId)return;
  const keep=new Set(messages.map(m=>m.id));
  for(const node of [...host.children])if(!keep.has(node.dataset.messageId))node.remove();
  for(let i=0;i<updates.length;i++){
    const {m,article,html}=updates[i],body=article.querySelector('.message-body');
    if(article.message?.content!==m.content){
      if(m.role==='assistant'&&html!==null)body.innerHTML=html;
      else{body.textContent=m.content;body.style.whiteSpace='pre-wrap';}
    }
    article.className='message '+m.role+(m.pending?' pending':'');
    if(article.message?.time!==m.time){const time=article.querySelector('time');if(m.time){time.textContent=new Date(m.time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});time.dateTime=new Date(m.time).toISOString();}}
    article.message=m;
    if(host.children[i]!==article)host.insertBefore(article,host.children[i]||null);
  }
  $('welcome').hidden=messages.length>0||state.loading;$('loadMore').hidden=!state.hasMore;
  if(forceBottom||nearBottom)transcript.scrollTop=transcript.scrollHeight;
  controls();
}
async function loadHistory(append=false){
  if(state.draftSessions.has(state.selected)){state.loading=false;state.messages=[];state.hasMore=false;await renderMessages();return;}
  const id=state.selected,token=++state.loadId;state.loading=true;controls();
  const before=append&&state.messages.length?Math.min(...state.messages.map(m=>m.seq)):undefined;
  const oldHeight=$('transcript').scrollHeight,oldTop=$('transcript').scrollTop;
  try{
    const data=await call('history',id,before);
    if(token!==state.loadId||id!==state.selected)return;
    state.messages=mergeMessages(append?state.messages:[],data.chat_events||[]);state.hasMore=data.has_more===true;
    if(state.pending?.sessionId===id&&state.messages.some(m=>m.role==='user'&&m.content===state.pending.text&&m.time>=state.pending.time-5000))state.pending=null;
    state.loading=false;await renderMessages({forceBottom:!append});
    if(append)$('transcript').scrollTop=oldTop+$('transcript').scrollHeight-oldHeight;
  }finally{if(token===state.loadId){state.loading=false;controls();}}
}
async function select(id){
  if(id===state.selected&&state.messages.length)return;
  state.drafts.set(state.selected,$('prompt').value);state.selected=id;state.messages=[];state.hasMore=false;state.renderId++;$('messages').replaceChildren();
  $('prompt').value=state.drafts.get(id)||'';resizeInput();renderSessions();renderApprovals();
  if(window.innerWidth<=680)document.body.classList.add('sidebar-hidden');
  await call('subscribe',id);await loadHistory();$('prompt').focus();
}
let refreshTimer=null,renderTimer=null;
function scheduleHistory(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(state.connected&&!state.loading)loadHistory().catch(e=>notice(e.message));},300);}
function scheduleRender(){if(renderTimer)return;renderTimer=setTimeout(()=>{renderTimer=null;renderMessages().catch(e=>notice(e.message));},100);}
function renderApprovals(){
  const host=$('approvals');host.replaceChildren();
  const relevant=state.approvals.filter(a=>{const id=a.scope?.thread_id||a.scope?.session_scope_id;return !id||id===state.selected||(!state.selected&&!a.scope?.thread_id);});
  for(const approval of relevant){
    const div=document.createElement('div');div.className='approval-item';
    const title=document.createElement('strong');title.textContent=approval.display?.summary_title||approval.display?.display_name||'操作の確認';
    const text=document.createElement('p');text.textContent=[approval.display?.action_description,approval.display?.scope_summary,approval.display?.purpose_summary,approval.display?.short_explanation].filter(Boolean).join('\n')||'Muse がこの操作の許可を求めています。';
    const actions=document.createElement('div');actions.className='approval-buttons';
    for(const [label,value]of [['今回許可','allow_once'],['拒否','deny']]){const b=document.createElement('button');b.textContent=label;b.addEventListener('click',safely(async()=>{for(const c of actions.children)c.disabled=true;try{await call('decide',approval.approval_id,value);state.approvals=state.approvals.filter(a=>a.approval_id!==approval.approval_id);renderApprovals();}catch(e){for(const c of actions.children)c.disabled=false;throw e;}}));actions.append(b);}
    div.append(title,text,actions);host.append(div);
  }
  host.hidden=!relevant.length;
}
function gateway(event){
  const p=event.payload||{};
  if(event.event==='sessions.updated'){refreshSessions().catch(e=>notice(e.message));return;}
  if(event.event==='approvals.snapshot'){state.approvals=p.pending_approvals||[];renderApprovals();return;}
  if(!isCurrent(p))return;
  if(event.event==='task.status'){
    const running=['running','pending','queued','in_progress','started','waiting_for_approval'].includes(p.status);
    state.busy.set(state.selected,running);controls();if(!running)scheduleHistory();
  }
  if(event.event==='agent.status'&&p.activity_text)$('activity').textContent=p.activity_text;
  if(['delta.message_start','delta.text_append','delta.message_done'].includes(event.event)){
    state.messages=applyDelta(state.messages,event);scheduleRender();
    if(event.event==='delta.message_done'){state.busy.set(state.selected,false);controls();scheduleHistory();}
    return;
  }
  if(event.event==='message.user'||event.event==='message.assistant'||event.event==='delta.presentation'){
    const m=messageFromEvent(event);
    if(m){state.messages=mergeMessages(state.messages,[event]);if(m.role==='user'&&state.pending?.text===m.content)state.pending=null;scheduleRender();}
    else scheduleHistory();
  }
  if(/(?:message|delta|complete|cancel|error)/.test(event.event||'')&&!['message.user','message.assistant','delta.presentation'].includes(event.event))scheduleHistory();
}
window.muse.onEvent(value=>{
  if(value.type==='connection')setConnection(value.status,value.message);
  else if(value.type==='gateway')gateway(value.event);
  else if(value.type==='authenticated')safely(connect)();
  else if(value.type==='stream-error')notice(value.message);
  else if(value.type==='home')safely(()=>select(''))();
});
async function connect(){
  if(state.connecting)return;
  $('notice').hidden=true;
  await call('connect');setConnection('connected');await refreshSessions();await loadHistory();
  $('prompt').focus();
}
async function send(){
  const input=$('prompt'),text=input.value.trim(),id=state.selected;
  if(!text||$('send').disabled)return;
  state.pending={text,sessionId:id,time:Date.now()};state.busy.set(id,true);controls();
  input.value='';state.drafts.set(id,'');resizeInput();await renderMessages({forceBottom:true});
  try{const result=await call('send',text,id);state.draftSessions.delete(id);if(state.selected===id){if(result.session_id&&result.session_id!==id)state.selected=result.session_id;await call('subscribe',state.selected);scheduleHistory();await refreshSessions();}}
  catch(e){state.pending=null;state.busy.set(id,false);if(state.selected===id&&!input.value){input.value=text;resizeInput();}notice(e.message);await renderMessages();}
  finally{controls();}
}
function resizeInput(){const input=$('prompt');input.style.height='auto';input.style.height=Math.min(180,input.scrollHeight)+'px';controls();}
$('prompt').addEventListener('input',resizeInput);
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();safely(send)();}});
$('composerForm').addEventListener('submit',e=>{e.preventDefault();safely(send)();});
$('stop').addEventListener('click',safely(async()=>{await call('cancel',state.selected);notice('停止を要求しました。Muse の実行状態を確認しています。');scheduleHistory();}));
$('connect').addEventListener('click',safely(connect));$('welcomeConnect').addEventListener('click',safely(connect));
for(const id of ['login','welcomeLogin'])$(id).addEventListener('click',safely(()=>call('login')));
$('reconnect').addEventListener('click',safely(async()=>{$('settingsDialog').close();await connect();}));
$('importCapture').addEventListener('click',safely(async()=>{const result=await call('importCapture');if(!result.canceled){$('settingsDialog').close();await connect();}}));
$('refresh').addEventListener('click',safely(async()=>{await refreshSessions();await loadHistory();}));
$('loadMore').addEventListener('click',safely(()=>loadHistory(true)));
$('search').addEventListener('input',renderSessions);
$('newChat').addEventListener('click',safely(async()=>{const result=await call('startSession');const id=result.session_id;if(!id)throw new Error('新しい会話の ID を取得できませんでした。');state.draftSessions.add(id);await refreshSessions();await select(id);}));
$('tools').addEventListener('click',safely(()=>call('openTools')));
$('settings').addEventListener('click',()=>$('settingsDialog').showModal());
$('closeSettings').addEventListener('click',()=>$('settingsDialog').close());
$('settingsDialog').addEventListener('click',e=>{if(e.target===$('settingsDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('dismissNotice').addEventListener('click',()=>$('notice').hidden=true);
for(const id of ['showSidebar','collapseSidebar'])$(id).addEventListener('click',()=>document.body.classList.toggle('sidebar-hidden'));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.body.classList.remove('sidebar-hidden');$('search').focus();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();if(!$('newChat').disabled)$('newChat').click();}});
document.addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();safely(()=>call('openLink',a.href))();}});
if(window.innerWidth<=680)document.body.classList.add('sidebar-hidden');
safely(async()=>{const info=await call('info');$('version').textContent='v'+info.version;$('dialogVersion').textContent='v'+info.version;setConnection(info.status);if(info.hasSession)await connect();else $('settingsDialog').showModal();})();
