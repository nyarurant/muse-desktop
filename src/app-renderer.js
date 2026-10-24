'use strict';
const $=id=>document.getElementById(id);
const state={connected:false,connecting:false,sessions:[],selected:'',messages:[],hasMore:false,loading:false,loadId:0,pending:null,busy:new Map(),drafts:new Map(),draftSessions:new Set(),approvals:[],renderId:0,activityText:'',identity:null,themes:null,tab:'activity'};
const darkQuery=window.matchMedia('(prefers-color-scheme: dark)');
async function call(name,...args){const r=await window.muse[name](...args);if(!r.ok)throw new Error(r.error);return r.value;}
function notice(message){$('noticeText').textContent=message;$('notice').hidden=false;}
function safely(fn){return async(...args)=>{try{return await fn(...args);}catch(e){notice(e.message);}};}
function remember(key,value){try{localStorage.setItem(key,value);}catch{}}
function recall(key){try{return localStorage.getItem(key);}catch{return null;}}
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
  renderProfileStatus();
}
function renderProfileStatus(){
  $('activity').textContent=state.pending?'送信しています…':busy()&&state.activityText?state.activityText:busy()?'応答中':state.connected?'接続済み':state.connecting?'接続しています…':'未接続';
}
function setConnection(status,message){
  state.connected=status==='connected';state.connecting=status==='connecting';
  for(const id of ['connectionDot','sidebarDot'])$(id).className='status-dot '+status;
  $('connectionLabel').textContent=state.connected?'接続済み':state.connecting?'接続中…':'接続する';
  $('connect').disabled=state.connecting;
  $('welcomeDescription').textContent=state.connected?'何でも話しかけてください。':'Muse に接続して、会話を続けましょう。';
  $('welcomeActions').hidden=state.connected;
  if(!state.connected){state.busy.clear();state.pending=null;}
  if(['error','auth_required'].includes(status)&&message)notice(message);
  controls();
}

// ---- Theme and identity (same data the web client uses) ----
function mix(hex,base,amount){
  const p=h=>{const m=/^#?([0-9a-f]{6})$/i.exec(h||'');return m?[0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)):null;};
  const a=p(hex),b=p(base);if(!a||!b)return hex;
  return '#'+a.map((v,i)=>Math.round(v*amount+b[i]*(1-amount)).toString(16).padStart(2,'0')).join('');
}
function applyTheme(){
  const option=state.themes?.options?.[state.themes.selected_theme_id];
  const root=document.documentElement.style;
  const names=['--bg','--user-bubble','--user-text','--bot-bubble','--bot-text'];
  if(!option){for(const n of names)root.removeProperty(n);return;}
  const mode=effectiveMode();
  const pick=key=>{const v=option[key]?.[mode];return /^#[0-9a-f]{6}$/i.test(v||'')?v:null;};
  const bg=pick('background');
  // The web client draws the dark assistant bubble translucent over the background (#29292B -> #1F1F20).
  const bot=pick('botBubble');
  const values={'--bg':bg,'--user-bubble':pick('userBubble'),'--user-text':pick('userText'),'--bot-bubble':bot&&bg&&mode==='dark'?mix(bot,bg,.4):bot,'--bot-text':pick('botText')};
  for(const [n,v] of Object.entries(values)){if(v)root.setProperty(n,v);else root.removeProperty(n);}
}
function effectiveMode(){const t=document.documentElement.dataset.theme;return t==='light'||(t==='system'&&!darkQuery.matches)?'light':'dark';}
function setThemeMode(mode,persist=true){
  if(!['dark','light','system'].includes(mode))mode='dark';
  document.documentElement.dataset.theme=mode;$('themeMode').value=mode;if(persist)remember('museApp.theme',mode);applyTheme();
}
darkQuery.addEventListener('change',applyTheme);
async function loadIdentity(){
  const [identity,themes]=await Promise.all([call('identity').catch(()=>null),call('themes').catch(()=>null)]);
  if(themes){state.themes=themes;applyTheme();}
  if(!identity)return;
  state.identity=identity;
  const name=identity.name||'Muse';
  $('profileName').textContent=name;$('welcomeTitle').textContent=name;$('avatarFallback').textContent=name.slice(0,1).toUpperCase();
  document.title=name+' — Muse';
  if(identity.imagePath){
    try{const url=await call('avatar',identity.imagePath);if(url){for(const id of ['avatarImage','welcomeAvatar']){$(id).src=url;$(id).hidden=false;}$('avatarFallback').hidden=true;}}catch{}
  }
}

// ---- Conversation list ----
function sessionTitle(s){return s?.title||s?.snippet?.slice(0,45)||'新しいサイドチャット';}
function sessionButton(id,title,unread){
  const button=document.createElement('button');button.className='session'+(state.selected===id?' active':'');button.title=title;button.setAttribute('aria-current',state.selected===id?'page':'false');
  const label=document.createElement('span');label.className='session-text';label.textContent=title;button.append(label);
  if(unread&&state.selected!==id){const dot=document.createElement('span');dot.className='unread-dot';dot.setAttribute('aria-label','未読');button.append(dot);}
  button.addEventListener('click',safely(()=>select(id)));return button;
}
function renderSessions(){
  const search=$('search').value.toLocaleLowerCase(),matches=title=>!search||title.toLocaleLowerCase().includes(search);
  const primaryHost=$('primarySession');primaryHost.replaceChildren();
  const primary=state.sessions.find(s=>s.is_primary);
  if(matches('メインチャット')||(primary&&matches(sessionTitle(primary))))primaryHost.append(sessionButton('','メインチャット',primary?.unread_count>0));
  const host=$('sessions');host.replaceChildren();
  for(const s of state.sessions){
    if(s.is_primary||s.archived)continue;
    const title=sessionTitle(s);if(!matches(title))continue;
    host.append(sessionButton(s.session_id,title,s.unread_count>0));
  }
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent=search?'一致する会話がありません。':state.connected?'サイドチャットはまだありません。':'接続すると会話が表示されます。';host.append(p);}
}
async function refreshSessions(){const r=await call('sessions');state.sessions=r.sessions||[];for(const id of state.draftSessions)if(!state.sessions.some(s=>s.session_id===id))state.sessions.unshift({session_id:id,is_primary:false,title:'新しいサイドチャット'});renderSessions();}

// ---- Messages ----
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function messageNode(m){
  const article=document.createElement('article');article.dataset.messageId=m.id;
  const bubble=document.createElement('div');bubble.className='bubble';
  const body=document.createElement('div');body.className='message-body';bubble.append(body);article.append(bubble);
  if(!m.pending){
    const actions=document.createElement('div');actions.className='message-actions';
    const copy=document.createElement('button');copy.className='icon-button';copy.title='コピー';copy.setAttribute('aria-label',m.role==='assistant'?'回答をコピー':'メッセージをコピー');copy.append(icon('copy'));
    copy.addEventListener('click',safely(async()=>{await navigator.clipboard.writeText(article.message.content);copy.title='コピーしました';copy.setAttribute('aria-label','コピーしました');}));
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
    if(article.message?.time!==m.time&&m.time){const d=new Date(m.time);article.querySelector('.bubble').title=d.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
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
  if(window.innerWidth<=860)document.body.classList.add('sidebar-hidden');
  await call('subscribe',id);await loadHistory();$('prompt').focus();
}
let refreshTimer=null,renderTimer=null,activityTimer=null;
function scheduleHistory(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(state.connected&&!state.loading)loadHistory().catch(e=>notice(e.message));},300);}
function scheduleRender(){if(renderTimer)return;renderTimer=setTimeout(()=>{renderTimer=null;renderMessages().catch(e=>notice(e.message));},100);}
function scheduleActivity(delay=1500){clearTimeout(activityTimer);activityTimer=setTimeout(()=>{if(state.connected)loadActivity().catch(()=>{});},delay);}

// ---- Approvals (above the composer and in the panel's 承認 tab) ----
function approvalNode(approval){
  const div=document.createElement('div');div.className='approval-item';
  const title=document.createElement('strong');title.textContent=approval.display?.summary_title||approval.display?.display_name||'操作の確認';
  const text=document.createElement('p');text.textContent=[approval.display?.action_description,approval.display?.scope_summary,approval.display?.purpose_summary,approval.display?.short_explanation].filter(Boolean).join('\n')||'Muse がこの操作の許可を求めています。';
  const actions=document.createElement('div');actions.className='approval-buttons';
  for(const [label,value]of [['今回許可','allow_once'],['拒否','deny']]){const b=document.createElement('button');b.textContent=label;b.addEventListener('click',safely(async()=>{for(const c of document.querySelectorAll('.approval-buttons button'))c.disabled=true;try{await call('decide',approval.approval_id,value);state.approvals=state.approvals.filter(a=>a.approval_id!==approval.approval_id);renderApprovals();}catch(e){for(const c of document.querySelectorAll('.approval-buttons button'))c.disabled=false;throw e;}}));actions.append(b);}
  div.append(title,text,actions);return div;
}
function renderApprovals(){
  const host=$('approvals');host.replaceChildren();
  const relevant=state.approvals.filter(a=>{const id=a.scope?.thread_id||a.scope?.session_scope_id;return !id||id===state.selected||(!state.selected&&!a.scope?.thread_id);});
  for(const approval of relevant)host.append(approvalNode(approval));
  host.hidden=!relevant.length;
  const panel=$('panelApprovals');panel.replaceChildren();
  for(const approval of state.approvals)panel.append(approvalNode(approval));
  if(!state.approvals.length){const p=document.createElement('p');p.className='list-hint';p.textContent='確認待ちの操作はありません。';panel.append(p);}
  $('approvalBadge').hidden=!state.approvals.length;
}

// ---- Activity timeline (right panel) ----
const DONE=new Set(['success','completed','complete','done','succeeded']);
function dayLabel(d){
  const today=new Date();today.setHours(0,0,0,0);
  const diff=Math.round((today-d)/86400000);
  return diff===0?'今日':diff===1?'昨日':d.toLocaleDateString('ja-JP',{month:'long',day:'numeric'});
}
function activityNode(a){
  const item=document.createElement('div');item.className='activity-item';
  const done=!a.status||DONE.has(a.status);
  const iconBox=document.createElement('span');iconBox.className='activity-icon';iconBox.append(icon(/^file_/.test(a.type||'')?'file':done?'check':'spark'));
  const text=document.createElement('div');text.className='activity-text';
  const title=document.createElement('div');title.className='activity-title';title.textContent=a.title||a.status_title||a.type||'';
  text.append(title);
  const subtitle=typeof a.subtitle==='string'?a.subtitle:typeof a.subtitle?.text==='string'?a.subtitle.text:'';
  const subText=!done&&a.status_title?a.status_title:subtitle||(a.status_title!==a.title?a.status_title:'');
  if(subText){const sub=document.createElement('div');sub.className='activity-sub';sub.textContent=subText;text.append(sub);}
  const t=new Date(a.timestamp);
  if(!Number.isNaN(t.getTime())){const time=document.createElement('div');time.className='activity-time';time.textContent=t.getHours()+':'+String(t.getMinutes()).padStart(2,'0');text.append(time);}
  item.append(iconBox,text);return item;
}
async function loadActivity(){
  const data=await call('activity');
  // Group by the viewer's local day (the API's day keys are not in local time).
  const groups=new Map();
  for(const day of data.days||[])for(const a of Array.isArray(day.activities)?day.activities:[]){
    const t=new Date(a.timestamp);const d=Number.isNaN(t.getTime())?new Date(day.date+'T00:00:00'):new Date(t.getFullYear(),t.getMonth(),t.getDate());
    const key=d.getTime();if(!groups.has(key))groups.set(key,{date:d,items:[]});groups.get(key).items.push(a);
  }
  const host=$('activityList');host.replaceChildren();
  for(const g of [...groups.values()].sort((x,y)=>y.date-x.date)){
    const h=document.createElement('h3');h.className='day-heading';h.textContent=dayLabel(g.date);host.append(h);
    for(const a of g.items.sort((x,y)=>new Date(y.timestamp)-new Date(x.timestamp)))host.append(activityNode(a));
  }
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent='アクティビティはまだありません。';host.append(p);}
}
function setTab(tab){
  state.tab=tab;
  for(const [id,name] of [['tabActivity','activity'],['tabApprovals','approvals']]){$(id).classList.toggle('active',tab===name);$(id).setAttribute('aria-selected',String(tab===name));}
  $('activityList').hidden=tab!=='activity';$('panelApprovals').hidden=tab!=='approvals';
}
function setPanel(open,persist=true){document.body.classList.toggle('panel-hidden',!open);$('panelToggle').hidden=open;if(persist)remember('museApp.panel',open?'open':'closed');}

// ---- Gateway events ----
function gateway(event){
  const p=event.payload||{};
  if(event.event==='sessions.updated'){refreshSessions().catch(e=>notice(e.message));return;}
  if(event.event==='approvals.snapshot'){state.approvals=p.pending_approvals||[];renderApprovals();return;}
  if(/^(?:activity|task|file)\./.test(event.event||''))scheduleActivity();
  if(!isCurrent(p))return;
  if(event.event==='task.status'){
    const running=['running','pending','queued','in_progress','started','waiting_for_approval'].includes(p.status);
    state.busy.set(state.selected,running);if(!running)state.activityText='';controls();if(!running)scheduleHistory();
  }
  if(event.event==='agent.status'&&p.activity_text){state.activityText=p.activity_text;renderProfileStatus();}
  if(['delta.message_start','delta.text_append','delta.message_done'].includes(event.event)){
    state.messages=applyDelta(state.messages,event);scheduleRender();
    if(event.event==='delta.message_done'){state.busy.set(state.selected,false);state.activityText='';controls();scheduleHistory();scheduleActivity();}
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
  await call('connect');setConnection('connected');
  loadIdentity().catch(()=>{});
  await refreshSessions();await loadHistory();
  loadActivity().catch(()=>{});
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
function resizeInput(){const input=$('prompt');input.style.height='24px';input.style.height=Math.min(200,input.scrollHeight-8)+'px';controls();}
function showSidebar(){document.body.classList.remove('sidebar-hidden');}

$('prompt').addEventListener('input',resizeInput);
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();safely(send)();}});
$('composerForm').addEventListener('submit',e=>{e.preventDefault();safely(send)();});
$('stop').addEventListener('click',safely(async()=>{await call('cancel',state.selected);notice('停止を要求しました。Muse の実行状態を確認しています。');scheduleHistory();}));
$('connect').addEventListener('click',safely(async()=>{if(state.connected)$('settingsDialog').showModal();else await connect();}));
$('welcomeConnect').addEventListener('click',safely(connect));
for(const id of ['login','welcomeLogin'])$(id).addEventListener('click',safely(()=>call('login')));
$('reconnect').addEventListener('click',safely(async()=>{$('settingsDialog').close();await connect();}));
$('importCapture').addEventListener('click',safely(async()=>{const result=await call('importCapture');if(!result.canceled){$('settingsDialog').close();await connect();}}));
$('refresh').addEventListener('click',safely(async()=>{await refreshSessions();await loadHistory();loadActivity().catch(()=>{});}));
$('loadMore').addEventListener('click',safely(()=>loadHistory(true)));
$('search').addEventListener('input',renderSessions);
$('newChat').addEventListener('click',safely(async()=>{const result=await call('startSession');const id=result.session_id;if(!id)throw new Error('新しい会話の ID を取得できませんでした。');state.draftSessions.add(id);await refreshSessions();await select(id);}));
$('tools').addEventListener('click',safely(()=>call('openTools')));
$('settings').addEventListener('click',()=>$('settingsDialog').showModal());
$('closeSettings').addEventListener('click',()=>$('settingsDialog').close());
$('settingsDialog').addEventListener('click',e=>{if(e.target===$('settingsDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('dismissNotice').addEventListener('click',()=>$('notice').hidden=true);
for(const id of ['showSidebar','collapseSidebar'])$(id).addEventListener('click',()=>document.body.classList.toggle('sidebar-hidden'));
$('railChat').addEventListener('click',()=>{showSidebar();$('prompt').focus();});
$('railSearch').addEventListener('click',()=>{showSidebar();$('search').focus();});
$('panelClose').addEventListener('click',()=>setPanel(false));
$('panelToggle').addEventListener('click',()=>setPanel(true));
$('tabActivity').addEventListener('click',()=>setTab('activity'));
$('tabApprovals').addEventListener('click',()=>setTab('approvals'));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();showSidebar();$('search').focus();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();if(!$('newChat').disabled)$('newChat').click();}});
document.addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();safely(()=>call('openLink',a.href))();}});
if(window.innerWidth<=860)document.body.classList.add('sidebar-hidden');
setPanel(recall('museApp.panel')!=='closed'&&window.innerWidth>1180,false);
// Crossing a breakpoint closes the overlays the narrow layout cannot fit.
window.matchMedia('(max-width: 1180px)').addEventListener('change',e=>setPanel(!e.matches&&recall('museApp.panel')!=='closed',false));
window.matchMedia('(max-width: 860px)').addEventListener('change',e=>document.body.classList.toggle('sidebar-hidden',e.matches));
setThemeMode(recall('museApp.theme')||'dark',false);
$('themeMode').addEventListener('change',e=>setThemeMode(e.target.value));
renderApprovals();
safely(async()=>{const info=await call('info');$('dialogVersion').textContent='v'+info.version;setConnection(info.status);if(info.hasSession)await connect();else $('settingsDialog').showModal();})();
