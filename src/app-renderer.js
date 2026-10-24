'use strict';
const $=id=>document.getElementById(id);
const state={connected:false,connecting:false,sessions:[],selected:'',messages:[],hasMore:false,loading:false,loadId:0,pending:null,busy:new Map(),drafts:new Map(),draftSessions:new Set(),approvals:[],autoApproved:new Set(),archived:[],showArchived:false,attachments:[],replyTo:null,renderId:0,activityText:'',identity:null,themes:null,tab:'activity'};
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
  $('send').disabled=!connected||state.loading||state.connecting||busy()||!!state.pending||(!$('prompt').value.trim()&&!state.attachments.length);
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
function sessionButton(id,title,unread,pinned=false){
  const button=document.createElement('button');button.className='session'+(state.selected===id?' active':'');button.title=title;button.setAttribute('aria-current',state.selected===id?'page':'false');
  if(pinned){const pin=icon('pin');pin.classList.add('session-pin');button.append(pin);}
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
  // Pinned side chats stay on top, like the web client.
  const visible=state.sessions.filter(s=>!s.is_primary&&!s.archived&&matches(sessionTitle(s)));
  for(const s of [...visible.filter(s=>s.pinned),...visible.filter(s=>!s.pinned)])host.append(sessionRow(s));
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent=search?'一致する会話がありません。':state.connected?'サイドチャットはまだありません。':'接続すると会話が表示されます。';host.append(p);}
  const archivedHost=$('archivedSessions');archivedHost.replaceChildren();
  for(const s of state.archived)if(matches(sessionTitle(s)))archivedHost.append(sessionRow(s,true));
  if(!archivedHost.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent='アーカイブ済みのチャットはありません。';archivedHost.append(p);}
  $('archivedSection').hidden=!state.showArchived;
}
function sessionRow(s,archived=false){
  const row=document.createElement('div');row.className='session-row';
  row.append(sessionButton(s.session_id,sessionTitle(s),!archived&&s.unread_count>0,!archived&&s.pinned));
  if(!state.draftSessions.has(s.session_id)){
    const more=document.createElement('button');more.className='icon-button session-more';more.title='その他のスレッドアクション';more.setAttribute('aria-label','その他のスレッドアクション');more.setAttribute('aria-haspopup','menu');more.append(icon('more'));
    more.addEventListener('click',e=>{e.stopPropagation();showMenu(more,sessionMenu(s,archived));});row.append(more);
  }
  return row;
}
function sessionMenu(s,archived){
  const id=s.session_id;
  const items=archived?[{icon:'archive',label:'アーカイブを解除',action:()=>sessionAction(id,'unarchive')}]:[
    {icon:'pin',label:s.pinned?'ピン留めを外す':'ピン留め',action:()=>sessionAction(id,s.pinned?'unpin':'pin')},
    {icon:'edit',label:'名前を変更',action:()=>renameSession(s)},
    {icon:'archive',label:'アーカイブ',action:()=>sessionAction(id,'archive')}];
  items.push({icon:'trash',label:'削除',danger:true,action:()=>deleteSession(s)});
  return items;
}
async function sessionAction(id,action){
  await call('sessionAction',id,action);
  if(['archive','delete'].includes(action)&&state.selected===id)await select('');
  await refreshSessions();
}
async function renameSession(s){
  const title=await ask({title:'名前を変更',value:sessionTitle(s),ok:'保存'});
  if(title===null||!title.trim()||title.trim()===s.title)return;
  await call('renameSession',s.session_id,title);await refreshSessions();
}
async function deleteSession(s){
  if(!await ask({title:'チャットを削除しますか？',text:'「'+sessionTitle(s)+'」を削除します。この操作は取り消せません。',ok:'削除',danger:true}))return;
  await sessionAction(s.session_id,'delete');
}
async function refreshSessions(){
  const [r,archived]=await Promise.all([call('sessions'),state.showArchived?call('archivedSessions').catch(()=>null):null]);
  state.sessions=r.sessions||[];if(archived)state.archived=archived.sessions||[];
  for(const id of state.draftSessions)if(!state.sessions.some(s=>s.session_id===id))state.sessions.unshift({session_id:id,is_primary:false,title:'新しいサイドチャット'});
  renderSessions();if(document.hasFocus())markSeen(state.selected);
}
// Same as the web client: opening a chat with unread messages marks it seen.
function markSeen(id){
  const s=id?state.sessions.find(x=>x.session_id===id):state.sessions.find(x=>x.is_primary);
  if(!s||!(s.unread_count>0)||state.draftSessions.has(s.session_id))return;
  s.unread_count=0;renderSessions();call('markSeen',s.session_id).catch(()=>{});
}

// ---- Menus and dialogs ----
let openMenuEl=null;
function closeMenu(){if(!openMenuEl)return;openMenuEl.anchor.setAttribute('aria-expanded','false');openMenuEl.remove();openMenuEl=null;}
function showMenu(anchor,items,className='menu'){
  if(openMenuEl?.anchor===anchor){closeMenu();return;}
  closeMenu();
  const menu=document.createElement('div');menu.className=className;menu.setAttribute('role','menu');
  for(const item of items){
    const b=document.createElement('button');b.setAttribute('role','menuitem');
    if(item.danger)b.classList.add('danger');if(item.active)b.classList.add('active');if(item.title)b.title=item.title;
    if(item.icon)b.append(icon(item.icon));
    const label=document.createElement('span');label.textContent=item.label;b.append(label);
    b.addEventListener('click',e=>{e.stopPropagation();closeMenu();safely(item.action)();});menu.append(b);
  }
  document.body.append(menu);
  const r=anchor.getBoundingClientRect(),w=menu.offsetWidth,h=menu.offsetHeight;
  menu.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  menu.style.top=(r.bottom+4+h>innerHeight-8?Math.max(8,r.top-4-h):r.bottom+4)+'px';
  anchor.setAttribute('aria-expanded','true');menu.anchor=anchor;openMenuEl=menu;menu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown',e=>{if(openMenuEl&&!openMenuEl.contains(e.target)&&!openMenuEl.anchor.contains(e.target))closeMenu();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&openMenuEl){e.preventDefault();const a=openMenuEl.anchor;closeMenu();a.focus();}});
window.addEventListener('resize',closeMenu);
// Resolves true / the entered text on OK, null on cancel (Electron has no window.prompt).
function ask({title,text='',value=null,ok='OK',danger=false}){
  return new Promise(resolve=>{
    const d=$('askDialog'),input=$('askInput');
    $('askTitle').textContent=title;$('askText').textContent=text;$('askText').hidden=!text;
    input.hidden=value===null;input.value=value??'';
    $('askOk').textContent=ok;$('askOk').className='primary-button'+(danger?' danger':'');
    d.returnValue='';
    d.addEventListener('close',()=>resolve(d.returnValue==='ok'?(value===null?true:input.value):null),{once:true});
    d.showModal();if(value!==null){input.focus();input.select();}else $('askOk').focus();
  });
}
$('askInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();$('askDialog').close('ok');}});

// ---- Message search (chat.search over all chats) ----
let searchTimer=null,searchToken=0;
function scheduleSearch(){
  clearTimeout(searchTimer);const q=$('search').value.trim();
  if(q.length<2||!state.connected){searchToken++;$('searchSection').hidden=true;$('searchResults').replaceChildren();return;}
  searchTimer=setTimeout(()=>runSearch(q).catch(e=>notice(e.message)),350);
}
async function runSearch(q){
  const token=++searchToken,r=await call('search',q);
  if(token!==searchToken||$('search').value.trim()!==q)return;
  const host=$('searchResults');host.replaceChildren();
  for(const h of Array.isArray(r?.hits)?r.hits:[]){
    const ev=h.chat_event||{},sid=h.session?.session_id||ev.chat_context?.chat_id||'';
    const known=state.sessions.find(s=>s.session_id===sid)||h.session;const primary=known?.is_primary===true;
    const text=typeof h.snippet==='string'?h.snippet:typeof h.snippet?.text==='string'?h.snippet.text:ev.display_text;
    if(typeof text!=='string')continue;
    const b=document.createElement('button');b.className='search-hit';
    const where=document.createElement('strong');where.textContent=(primary?'メインチャット':sessionTitle(known))+' · '+(ev.event_name==='message.user'?'あなた':state.identity?.name||'Muse');
    const body=document.createElement('span');body.textContent=text;b.append(where,body);
    b.addEventListener('click',safely(()=>jumpTo(primary?'':sid,ev.message_id)));host.append(b);
  }
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent='一致するメッセージがありません。';host.append(p);}
  $('searchSection').hidden=false;
}
async function jumpTo(id,messageId){
  await select(id);
  const find=()=>[...$('messages').children].find(n=>n.dataset.messageId===messageId);
  for(let i=0;i<10&&messageId&&!find()&&state.hasMore&&state.selected===id;i++)await loadHistory(true);
  const node=find();if(!node)return;
  node.scrollIntoView({block:'center'});node.classList.add('flash');setTimeout(()=>node.classList.remove('flash'),1600);
}

// ---- Messages ----
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function messageNode(m){
  const article=document.createElement('article');article.dataset.messageId=m.id;
  const wrap=document.createElement('div');wrap.className='bubble-wrap';
  const bubble=document.createElement('div');bubble.className='bubble';
  const body=document.createElement('div');body.className='message-body';bubble.append(body);
  const reaction=document.createElement('span');reaction.className='reaction';reaction.hidden=true;
  if(m.role==='assistant'){reaction.title='リアクションを外す';reaction.addEventListener('click',safely(()=>react(article,article.message.reaction)));}
  const quote=document.createElement('button');quote.className='reply-quote';quote.hidden=true;quote.append(icon('reply'),document.createElement('span'));
  quote.addEventListener('click',()=>{const id=article.message?.replyTo;const node=[...$('messages').children].find(n=>n.dataset.messageId===id);if(node){node.scrollIntoView({block:'center'});node.classList.add('flash');setTimeout(()=>node.classList.remove('flash'),1600);}});
  const files=document.createElement('div');files.className='message-files';files.hidden=true;
  const sources=document.createElement('div');sources.className='sources';sources.hidden=true;
  wrap.append(quote,bubble,files,reaction,sources);article.append(wrap);
  if(!m.pending){
    const actions=document.createElement('div');actions.className='message-actions';
    const button=(name,label,handler)=>{const b=document.createElement('button');b.className='icon-button';b.title=label;b.setAttribute('aria-label',label);b.append(icon(name));b.addEventListener('click',handler);actions.append(b);return b;};
    if(m.role==='assistant'){
      const smile=button('smile','リアクションする',()=>showMenu(smile,REACTIONS.map(emoji=>({label:emoji,active:article.message.reaction===emoji,action:()=>react(article,emoji)})),'menu emoji-menu'));
      smile.setAttribute('aria-haspopup','menu');
    }
    button('reply','返信',()=>startReply(article.message));
    const copy=button('copy',m.role==='assistant'?'回答をコピー':'メッセージをコピー',safely(async()=>{await navigator.clipboard.writeText(article.message.content);copy.title='コピーしました';copy.setAttribute('aria-label','コピーしました');}));
    const more=button('more','その他のオプション',()=>showMenu(more,[{icon:'trash',label:'削除',danger:true,action:()=>deleteMessage(article.message)}]));
    more.setAttribute('aria-haspopup','menu');
    article.append(actions);
  }
  return article;
}
const REACTIONS=['👍','❤️','😂','😮','😢','🙏'];
async function react(article,emoji){
  const m=article.message;if(!emoji)return;
  const r=await call('react',m.id,emoji);
  const next=Array.isArray(r?.reactions)?r.reactions[0]?.emoji??null:m.reaction===emoji?null:emoji;
  state.messages=state.messages.map(x=>x.id===m.id?{...x,reaction:next}:x);await renderMessages();
}
async function deleteMessage(m){
  if(!await ask({title:'メッセージを削除しますか？',text:'このメッセージを会話から削除します。この操作は取り消せません。',ok:'削除',danger:true}))return;
  await call('deleteMessage',m.id);
  state.messages=state.messages.filter(x=>x.id!==m.id);await renderMessages();scheduleHistory();
}
async function renderMessages({forceBottom=false}={}){
  const version=++state.renderId,transcript=$('transcript'),nearBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<140;
  const messages=state.messages.slice();
  if(state.pending&&state.pending.sessionId===state.selected&&!messages.some(pendingDelivered))messages.push({id:'pending',role:'user',content:state.pending.text,time:state.pending.time,pending:true,resources:state.pending.resources});
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
    if(article.message?.reaction!==m.reaction){const rx=article.querySelector('.reaction');rx.textContent=m.reaction||'';rx.hidden=!m.reaction;}
    renderQuote(article,m,messages);
    const filesKey=m.pending?'pending:'+(state.pending?.files?.length||0):JSON.stringify([m.resources,m.attachments]);
    if(article.filesKey!==filesKey){article.filesKey=filesKey;renderResources(article,m);}
    article.querySelector('.bubble').hidden=!m.content&&!!m.attachments?.length;
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
    if(state.pending?.sessionId===id&&state.messages.some(pendingDelivered))state.pending=null;
    state.loading=false;await renderMessages({forceBottom:!append});
    if(append)$('transcript').scrollTop=oldTop+$('transcript').scrollHeight-oldHeight;
  }finally{if(token===state.loadId){state.loading=false;controls();}}
}
// ---- Feed / ideas / goals / library pages ----
const PAGES={feed:'フィード',ideas:'アイデア',goals:'目標',library:'ライブラリ'};
let pageToken=0;
function showPage(name,tab){
  state.page=name||null;document.body.classList.toggle('page-mode',!!name);$('pageView').hidden=!name;
  for(const b of document.querySelectorAll('.rail-button')){const on=name?b.dataset.page===name:b.id==='railChat';b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  if(!name)return;
  $('pageTitle').textContent=PAGES[name];$('pageTabs').replaceChildren();
  const body=$('pageBody');body.replaceChildren(hint('読み込んでいます…'));$('pageView').scrollTop=0;
  if(!state.connected){body.replaceChildren(hint('Muse に接続すると表示されます。'));return;}
  const token=++pageToken,render={feed:renderFeed,ideas:renderIdeas,goals:renderGoals,library:renderLibrary}[name];
  render(body,token,tab).catch(e=>{if(token===pageToken)body.replaceChildren(hint(e.message));});
}
function hint(text){const p=document.createElement('p');p.className='list-hint';p.textContent=text;return p;}
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function lazyImage(ref,alt=''){const img=el('img');img.alt=alt;img.loading='lazy';call('image',ref).then(url=>{if(url)img.src=url;else img.remove();}).catch(()=>img.remove());return img;}
async function renderFeed(body,token){
  const data=await call('feed');if(token!==pageToken)return;
  body.replaceChildren();
  for(const day of Array.isArray(data?.days)?data.days:[])for(const edition of Array.isArray(day.editions)?day.editions:[]){
    const d=new Date(day.local_date+'T00:00:00');
    body.append(el('h2','page-section',[edition.title,Number.isNaN(d.getTime())?'':dayLabel(d)].filter(Boolean).join(' · ')));
    for(const u of Array.isArray(edition.units)?edition.units:[]){
      const card=el('article','card');
      const kicker=el('div','card-kicker');kicker.append(el('span','',[u.emoji,u.kicker||u.category].filter(Boolean).join(' ')));card.append(kicker,el('h3','',u.title||''));
      const text=el('div','card-body message-body');card.append(text);
      if(typeof u.body_md==='string')call('renderMarkdown',u.body_md).then(html=>{text.innerHTML=html;}).catch(()=>{text.textContent=u.body_md;});
      const media=[...(u.attachment?.media_items||[]).filter(m=>m.kind==='image'&&typeof m.url==='string').map(m=>m.url),...typeof u.attachment?.hero_image_url==='string'?[u.attachment.hero_image_url]:[]].slice(0,3);
      if(media.length){const box=el('div','card-media');for(const url of media)box.append(lazyImage(url,u.title||''));card.append(box);}
      if(u.why_did_i_see_this)card.append(el('div','card-note','表示理由: '+u.why_did_i_see_this));
      body.append(card);
    }
  }
  if(!body.childElementCount)body.append(hint('フィードはまだありません。'));
}
async function renderIdeas(body,token){
  const data=await call('ideas');if(token!==pageToken)return;
  body.replaceChildren();
  for(const idea of Array.isArray(data?.ideas)?data.ideas:[]){
    const card=el('article','card');card.append(el('h3','',idea.title||''));
    if(idea.summary)card.append(el('div','card-body',idea.summary));
    const actions=el('div','card-actions'),start=el('button','pill-button','チャットで話す');
    start.addEventListener('click',safely(async()=>{showPage(null);if(state.selected!=='')await select('');const input=$('prompt');input.value=idea.title||'';resizeInput();input.focus();}));
    actions.append(start);card.append(actions);body.append(card);
  }
  if(!body.childElementCount)body.append(hint('アイデアはまだありません。'));
}
const GOAL_STATUS={active:'進行中',completed:'完了',paused:'一時停止',archived:'アーカイブ'};
const MOMENTUM={on_track:'順調',at_risk:'要注意',off_track:'遅れ',stalled:'停滞'};
async function renderGoals(body,token){
  const data=await call('goals');if(token!==pageToken)return;
  body.replaceChildren();
  const goals=Array.isArray(data?.goals)?data.goals.slice().sort((a,b)=>(a.sort_order??0)-(b.sort_order??0)):[];
  for(const [status,label] of [['active','進行中'],['other','そのほか'],['completed','完了']]){
    const list=goals.filter(g=>status==='other'?!['active','completed'].includes(g.status):g.status===status);if(!list.length)continue;
    body.append(el('h2','page-section',label));
    for(const g of list){
      const card=el('article','card');
      const kicker=el('div','card-kicker');kicker.append(el('span','chip '+(g.status||''),GOAL_STATUS[g.status]||g.status||''));
      if(MOMENTUM[g.momentum_status])kicker.append(el('span','chip '+g.momentum_status.replace(/_/g,'-'),MOMENTUM[g.momentum_status]));
      card.append(kicker,el('h3','',[g.emoji,g.title].filter(Boolean).join(' ')));
      if(g.summary)card.append(el('div','card-body',g.summary));
      if(g.description&&g.description!==g.summary)card.append(el('div','card-note',g.description));
      const updated=new Date(g.last_activity_at||g.updated_at);if(!Number.isNaN(updated.getTime()))card.append(el('div','card-note','最終更新 '+updated.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));
      body.append(card);
    }
  }
  if(!body.childElementCount)body.append(hint('目標はまだありません。'));
}
async function renderLibrary(body,token,tab='artifacts'){
  const tabs=$('pageTabs');
  for(const [key,label] of [['artifacts','ファイル'],['media','メディア']]){const b=el('button',tab===key?'active':'',label);b.addEventListener('click',()=>showPage('library',key));tabs.append(b);}
  const data=await call('library',tab,0);if(token!==pageToken)return;
  body.replaceChildren();
  const entries=Array.isArray(data?.entries)?data.entries:[];
  const save=e=>safely(async()=>{const r=await call('saveFile',e.path);if(r?.saved)notice(e.name+' を保存しました: '+r.path);});
  if(tab==='media'){
    const grid=el('div','media-grid');
    for(const e of entries){const b=el('button');b.title=e.name+'（クリックで保存）';b.append(lazyImage(e.path,e.name));b.addEventListener('click',save(e));grid.append(b);}
    body.append(grid);
  }else for(const e of entries){
    const row=el('div','file-row'),box=el('span','activity-icon');box.append(icon('file'));
    const text=el('div','file-text');text.append(el('div','file-name',e.name),el('div','file-meta',[formatSize(e.size||0),new Date(e.modified_ms).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})].join(' · ')));
    const dl=el('button','icon-button muted');dl.title='保存';dl.setAttribute('aria-label',e.name+' を保存');dl.append(icon('download'));dl.addEventListener('click',save(e));
    row.append(box,text,dl);body.append(row);
  }
  if(!entries.length)body.append(hint(tab==='media'?'画像はまだありません。':'ファイルはまだありません。'));
  else if(data.has_more)body.append(hint('ほかに '+(data.total-entries.length)+' 件あります。'));
}
async function select(id){
  if(state.page)showPage(null);
  if(id===state.selected&&state.messages.length)return;
  state.drafts.set(state.selected,$('prompt').value);state.selected=id;state.messages=[];state.hasMore=false;state.renderId++;$('messages').replaceChildren();
  $('prompt').value=state.drafts.get(id)||'';state.replyTo=null;renderComposerExtras();resizeInput();renderSessions();renderApprovals();
  if(window.innerWidth<=860)document.body.classList.add('sidebar-hidden');
  await call('subscribe',id);await loadHistory();markSeen(id);$('prompt').focus();
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
  for(const [id,name] of [['tabActivity','activity'],['tabApprovals','approvals'],['tabUpcoming','upcoming']]){$(id).classList.toggle('active',tab===name);$(id).setAttribute('aria-selected',String(tab===name));}
  $('activityList').hidden=tab!=='activity';$('panelApprovals').hidden=tab!=='approvals';$('upcomingList').hidden=tab!=='upcoming';
  if(tab==='upcoming'&&state.connected)loadUpcoming().catch(e=>notice(e.message));
}
// ---- Upcoming scheduled tasks (right panel, /tasks) ----
function cadenceText(c){
  if(!c||typeof c!=='object')return '';
  if(c.kind==='daily')return '毎日 '+(c.time||'');
  if(c.kind==='weekly')return '毎週'+(c.weekday||c.day?' '+(c.weekday||c.day):'')+(c.time?' '+c.time:'');
  if(c.kind==='interval'){const s=Number(c.interval_seconds)||0;return s>=3600&&s%3600===0?s/3600+'時間ごと':Math.max(1,Math.round(s/60))+'分ごと';}
  if(c.kind==='once')return '1回のみ';
  return typeof c.kind==='string'?c.kind:'';
}
async function loadUpcoming(){
  const data=await call('tasks');
  const items=(Array.isArray(data?.schedules)?data.schedules:[]).filter(s=>!s.is_heartbeat).sort((a,b)=>(a.next_run_at_utc||Infinity)-(b.next_run_at_utc||Infinity));
  const host=$('upcomingList');host.replaceChildren();
  for(const s of items){
    const item=document.createElement('div');item.className='activity-item';
    const iconBox=document.createElement('span');iconBox.className='activity-icon';iconBox.append(icon('clock'));
    const text=document.createElement('div');text.className='activity-text';
    const title=document.createElement('div');title.className='activity-title';title.textContent=s.title||String(s.id||'').replace(/[-_]+/g,' ');
    const sub=document.createElement('div');sub.className='activity-sub';sub.textContent=[cadenceText(s.cadence),s.enabled===false?'停止中':''].filter(Boolean).join(' · ');
    text.append(title,sub);
    const next=new Date(Number(s.next_run_at_utc)*1000);
    if(s.next_run_at_utc&&!Number.isNaN(next.getTime())){const t=document.createElement('div');t.className='activity-time';t.textContent='次回 '+next.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});text.append(t);}
    item.append(iconBox,text);host.append(item);
  }
  if(!host.childElementCount){const p=document.createElement('p');p.className='list-hint';p.textContent='予定されているタスクはありません。';host.append(p);}
}
function setPanel(open,persist=true){document.body.classList.toggle('panel-hidden',!open);$('panelToggle').hidden=open;if(persist)remember('museApp.panel',open?'open':'closed');}

// ---- Gateway events ----
function gateway(event){
  const p=event.payload||{};
  if(event.event==='sessions.updated'){refreshSessions().catch(e=>notice(e.message));return;}
  if(event.event==='approvals.snapshot'){state.approvals=(p.pending_approvals||[]).filter(a=>!state.autoApproved.has(a.approval_id));renderApprovals();return;}
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
    if(m){state.messages=mergeMessages(state.messages,[event]);if(pendingDelivered(m))state.pending=null;scheduleRender();}
    else scheduleHistory();
  }
  if(/(?:message|delta|complete|cancel|error)/.test(event.event||'')&&!['message.user','message.assistant','delta.presentation'].includes(event.event))scheduleHistory();
}
window.muse.onEvent(value=>{
  if(value.type==='connection')setConnection(value.status,value.message);
  else if(value.type==='login-required')enterLogin(value.stage,value.message);
  else if(value.type==='login-stage'){if(document.body.classList.contains('login-mode'))setLoginStage(value.stage,value.message);else if(value.message)notice(value.message);}
  else if(value.type==='gateway')gateway(value.event);
  else if(value.type==='authenticated'){exitLogin();safely(connect)();}
  else if(value.type==='stream-error')notice(value.message);
  else if(value.type==='approval-auto'){state.autoApproved.add(value.id);state.approvals=state.approvals.filter(a=>a.approval_id!==value.id);renderApprovals();}
  else if(value.type==='auto-resume'){notice('止まっていた「'+(value.title||'会話')+'」に再開を指示しました。');refreshSessions().catch(()=>{});if(value.id===state.selected)scheduleHistory();}
  else if(value.type==='reconnected')safely(async()=>{notice(value.keyChanged?KEY_CHANGED:'Muse に再接続しました。');await afterConnect();})();
  else if(value.type==='home')safely(()=>select(''))();
});
// ---- Login screen (login is required; the main process places Meta's page over #loginFrame) ----
const LOGIN_STEPS=['waiting','session','token','ready'];
let loginObserver=null;
function sendLoginBounds(){
  if(!document.body.classList.contains('login-mode'))return;
  const r=$('loginFrame').getBoundingClientRect();call('loginBounds',{x:r.left,y:r.top,width:r.width,height:r.height}).catch(()=>{});
}
function enterLogin(stage,message){
  document.body.classList.add('login-mode');$('loginScreen').hidden=false;closeMenu();
  for(const d of document.querySelectorAll('dialog[open]'))d.close();
  setLoginStage(stage||'waiting',message||'右の Meta のページで Muse にログインしてください。完了すると自動でつながります。');
  if(!loginObserver){loginObserver=new ResizeObserver(sendLoginBounds);loginObserver.observe($('loginFrame'));}
  requestAnimationFrame(sendLoginBounds);
}
function exitLogin(){
  if(!document.body.classList.contains('login-mode'))return;
  document.body.classList.remove('login-mode');$('loginScreen').hidden=true;
  loginObserver?.disconnect();loginObserver=null;call('loginBounds',null).catch(()=>{});
}
function setLoginStage(stage,message){
  const at=LOGIN_STEPS.indexOf(stage);
  if(at>=0)for(const li of $('loginSteps').children){const i=LOGIN_STEPS.indexOf(li.dataset.stage);li.classList.toggle('done',i<at);li.classList.toggle('current',i===at);}
  if(message)$('loginStatus').textContent=message;
}
window.addEventListener('resize',sendLoginBounds);
$('loginReload').addEventListener('click',safely(()=>call('loginReload')));
async function connect(){
  if(state.connecting)return;
  $('notice').hidden=true;
  const result=await call('connect');setConnection('connected');
  if(result?.keyChanged)notice(KEY_CHANGED);
  await afterConnect();$('prompt').focus();
}
const KEY_CHANGED='Muse の VM が再起動したため、新しい暗号キーで接続しました。';
// Reload everything a (re)connection may have missed, and re-follow the chat on screen.
async function afterConnect(){
  loadIdentity().catch(()=>{});
  if(state.selected&&!state.draftSessions.has(state.selected))await call('subscribe',state.selected).catch(()=>{});
  await refreshSessions();await loadHistory();markSeen(state.selected);
  loadActivity().catch(()=>{});if(state.tab==='upcoming')loadUpcoming().catch(()=>{});
}
async function send(){
  const input=$('prompt'),text=input.value.trim(),id=state.selected;
  const attachments=state.attachments,replyTo=state.replyTo;
  if((!text&&!attachments.length)||$('send').disabled)return;
  const shown=text||attachments.map(a=>a.name).join(', ');
  state.pending={text:shown,sessionId:id,time:Date.now(),files:attachments,resources:[]};state.busy.set(id,true);controls();
  input.value='';state.drafts.set(id,'');state.attachments=[];state.replyTo=null;renderComposerExtras();resizeInput();await renderMessages({forceBottom:true});
  try{
    const result=await call('send',text,id,{replyTo:replyTo?.id,attachments:attachments.map(a=>({name:a.name,type:a.type,data:a.data}))});
    state.draftSessions.delete(id);if(state.selected===id){if(result.session_id&&result.session_id!==id)state.selected=result.session_id;await call('subscribe',state.selected);scheduleHistory();await refreshSessions();}
  }
  catch(e){
    state.pending=null;state.busy.set(id,false);
    if(state.selected===id){if(!input.value){input.value=text;resizeInput();}if(!state.attachments.length)state.attachments=attachments;if(!state.replyTo)state.replyTo=replyTo;renderComposerExtras();}
    notice(e.message);await renderMessages();
  }
  finally{controls();}
}
// ---- Reply target, attachments, sources ----
// The echoed user message replaces the local placeholder (attachment-only messages echo different text).
function pendingDelivered(m){const p=state.pending;return !!p&&m.role==='user'&&m.time>=p.time-5000&&(m.content===p.text||p.files?.length>0);}
function snippet(text,max=80){return String(text||'').replace(/\s+/g,' ').trim().slice(0,max);}
function startReply(m){state.replyTo={id:m.id,text:snippet(m.content),role:m.role};renderComposerExtras();$('prompt').focus();}
function renderQuote(article,m,messages){
  const quote=article.querySelector('.reply-quote'),target=m.replyTo&&messages.find(x=>x.id===m.replyTo);
  quote.hidden=!target;if(target)quote.lastChild.textContent=snippet(target.content,60);
}
function formatSize(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';}
function renderComposerExtras(){
  $('replyBar').hidden=!state.replyTo;
  if(state.replyTo)$('replyText').textContent=(state.replyTo.role==='assistant'?(state.identity?.name||'Muse'):'あなた')+' に返信: '+state.replyTo.text;
  const host=$('attachmentList');host.replaceChildren();host.hidden=!state.attachments.length;
  state.attachments.forEach((a,i)=>{
    const chip=document.createElement('div');chip.className='attachment';chip.title=a.name;
    if(a.type.startsWith('image/')){const img=document.createElement('img');img.alt='';img.src='data:'+a.type+';base64,'+a.data;chip.append(img);}
    else{const box=document.createElement('span');box.className='attachment-icon';box.append(icon('file'));chip.append(box);}
    const name=document.createElement('span');name.className='attachment-name';name.textContent=a.name;
    const size=document.createElement('span');size.className='attachment-size';size.textContent=formatSize(a.size);name.append(size);
    const remove=document.createElement('button');remove.type='button';remove.className='icon-button remove';remove.title='添付を外す';remove.setAttribute('aria-label',a.name+' を外す');remove.append(icon('close'));
    remove.addEventListener('click',()=>{state.attachments.splice(i,1);renderComposerExtras();controls();});
    chip.append(name,remove);host.append(chip);
  });
  controls();
}
function readAsBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.onerror=()=>reject(new Error(file.name+' を読み込めませんでした。'));r.readAsDataURL(file);});}
async function addFiles(files){
  for(const file of files){
    if(state.attachments.length>=10)throw new Error('添付できるのは 10 個までです。');
    if(file.size>10*1024*1024)throw new Error(file.name+' は 10 MB を超えているため添付できません。');
    if(state.attachments.reduce((n,a)=>n+a.size,0)+file.size>12*1024*1024)throw new Error('添付ファイルは合計 12 MB までです。');
    state.attachments.push({name:file.name||'image.png',type:file.type||'application/octet-stream',size:file.size,data:await readAsBase64(file)});
    renderComposerExtras();
  }
}
function renderResources(article,m){
  const list=Array.isArray(m.resources)?m.resources:[];
  const sources=article.querySelector('.sources');sources.replaceChildren();
  for(const r of list){
    if(r?.kind!=='citation'||typeof r.uri!=='string'||!/^https?:\/\//.test(r.uri))continue;
    let domain='';try{domain=new URL(r.uri).hostname.replace(/^www\./,'');}catch{continue;}
    const a=document.createElement('a');a.className='source';a.href=r.uri;a.textContent=domain;a.title=typeof r.label==='string'?r.label:r.uri;sources.append(a);
  }
  sources.hidden=!sources.childElementCount;
  const files=article.querySelector('.message-files');files.replaceChildren();
  const pendingFiles=m.pending&&state.pending?.files||[];
  for(const f of pendingFiles)if(f.type.startsWith('image/')){const img=document.createElement('img');img.alt=f.name;img.src='data:'+f.type+';base64,'+f.data;files.append(img);}
  for(const f of Array.isArray(m.attachments)?m.attachments:[]){
    if(f.kind==='image'){const img=document.createElement('img');img.alt='';files.append(img);call('image',f.path).then(url=>{if(url)img.src=url;else img.remove();}).catch(()=>img.remove());}
    else{const chip=document.createElement('span');chip.className='source';chip.textContent=f.path.split('/').pop();chip.title=f.mime;files.append(chip);}
  }
  for(const r of list){
    if(r?.kind==='citation')continue;
    const mime=typeof r?.mime_type==='string'?r.mime_type:'';const path=typeof r?.uri==='string'?r.uri:typeof r?.path==='string'?r.path:'';
    if(mime.startsWith('image/')&&path&&!/^[a-z]+:/i.test(path)){const img=document.createElement('img');img.alt=r.label||'';files.append(img);call('avatar',path).then(url=>{if(url)img.src=url;}).catch(()=>img.remove());}
    else if(r?.label||path){const chip=document.createElement('span');chip.className='source';chip.textContent=r.label||path.split('/').pop();files.append(chip);}
  }
  files.hidden=!files.childElementCount;
}
function resizeInput(){const input=$('prompt');input.style.height='24px';input.style.height=Math.min(200,input.scrollHeight-8)+'px';controls();}
function showSidebar(){document.body.classList.remove('sidebar-hidden');}

$('prompt').addEventListener('input',resizeInput);
$('attach').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',safely(async e=>{const files=[...e.target.files];e.target.value='';await addFiles(files);$('prompt').focus();}));
$('cancelReply').addEventListener('click',()=>{state.replyTo=null;renderComposerExtras();$('prompt').focus();});
$('prompt').addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();safely(addFiles)(files);}});
const mainEl=document.querySelector('.main');
mainEl.addEventListener('dragover',e=>{if([...(e.dataTransfer?.types||[])].includes('Files')){e.preventDefault();mainEl.classList.add('dragging');}});
mainEl.addEventListener('dragleave',e=>{if(!mainEl.contains(e.relatedTarget))mainEl.classList.remove('dragging');});
mainEl.addEventListener('drop',e=>{mainEl.classList.remove('dragging');const files=[...(e.dataTransfer?.files||[])];if(files.length){e.preventDefault();safely(addFiles)(files);}});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();safely(send)();}});
$('composerForm').addEventListener('submit',e=>{e.preventDefault();safely(send)();});
$('stop').addEventListener('click',safely(async()=>{await call('cancel',state.selected);notice('停止を要求しました。Muse の実行状態を確認しています。');scheduleHistory();}));
$('connect').addEventListener('click',safely(async()=>{if(state.connected)$('settingsDialog').showModal();else await connect();}));
$('welcomeConnect').addEventListener('click',safely(connect));
for(const id of ['login','welcomeLogin'])$(id).addEventListener('click',safely(()=>call('login')));
$('reconnect').addEventListener('click',safely(async()=>{$('settingsDialog').close();await connect();}));
$('refresh').addEventListener('click',safely(async()=>{await refreshSessions();await loadHistory();loadActivity().catch(()=>{});}));
$('loadMore').addEventListener('click',safely(()=>loadHistory(true)));
$('search').addEventListener('input',()=>{renderSessions();scheduleSearch();});
$('sidebarOptions').addEventListener('click',e=>{const b=e.currentTarget;showMenu(b,[{icon:'archive',label:state.showArchived?'アーカイブ済みのチャットを隠す':'アーカイブ済みのチャットを表示',action:async()=>{state.showArchived=!state.showArchived;renderSessions();if(state.showArchived&&state.connected)await refreshSessions();}}]);});
$('sidebarOptions').setAttribute('aria-haspopup','menu');
$('transcript').addEventListener('scroll',closeMenu,{passive:true});
$('newChat').addEventListener('click',safely(async()=>{const result=await call('startSession');const id=result.session_id;if(!id)throw new Error('新しい会話の ID を取得できませんでした。');state.draftSessions.add(id);await refreshSessions();await select(id);}));
$('tools').addEventListener('click',safely(()=>call('openTools')));
$('settings').addEventListener('click',()=>$('settingsDialog').showModal());
$('closeSettings').addEventListener('click',()=>$('settingsDialog').close());
$('settingsDialog').addEventListener('click',e=>{if(e.target===$('settingsDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('dismissNotice').addEventListener('click',()=>$('notice').hidden=true);
for(const id of ['showSidebar','collapseSidebar'])$(id).addEventListener('click',()=>document.body.classList.toggle('sidebar-hidden'));
$('railChat').addEventListener('click',()=>{showPage(null);showSidebar();$('prompt').focus();});
for(const b of document.querySelectorAll('.rail-button[data-page]'))b.addEventListener('click',()=>showPage(b.dataset.page));
$('railSearch').addEventListener('click',()=>{showPage(null);showSidebar();$('search').focus();});
$('panelClose').addEventListener('click',()=>setPanel(false));
$('panelToggle').addEventListener('click',()=>setPanel(true));
$('tabActivity').addEventListener('click',()=>setTab('activity'));
$('tabApprovals').addEventListener('click',()=>setTab('approvals'));
$('tabUpcoming').addEventListener('click',()=>setTab('upcoming'));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();showSidebar();$('search').focus();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();if(!$('newChat').disabled)$('newChat').click();}});
document.addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();safely(()=>call('openLink',a.href))();}});
if(window.innerWidth<=860)document.body.classList.add('sidebar-hidden');
setPanel(recall('museApp.panel')!=='closed'&&window.innerWidth>1180,false);
// Crossing a breakpoint closes the overlays the narrow layout cannot fit.
window.matchMedia('(max-width: 1180px)').addEventListener('change',e=>setPanel(!e.matches&&recall('museApp.panel')!=='closed',false));
window.matchMedia('(max-width: 860px)').addEventListener('change',e=>document.body.classList.toggle('sidebar-hidden',e.matches));
setThemeMode(recall('museApp.theme')||'dark',false);
$('themeMode').addEventListener('change',e=>setThemeMode(e.target.value));
$('approvalMode').addEventListener('change',safely(async e=>{const el=e.target;try{el.value=await call('setApprovalMode',el.value);}catch(err){el.value=await call('approvalMode');throw err;}}));
safely(async()=>{$('approvalMode').value=await call('approvalMode');})();
$('autoResume').addEventListener('change',safely(async e=>{const el=e.target;el.value=await call('setAutoResume',el.value==='on')?'on':'off';}));
safely(async()=>{$('autoResume').value=await call('autoResume')?'on':'off';})();
renderApprovals();
safely(async()=>{const info=await call('info');$('dialogVersion').textContent='v'+info.version;setConnection(info.status);const login=await call('loginState');if(login.active)enterLogin(login.stage,login.message);else if(info.hasSession)await connect();else await call('login');})();
