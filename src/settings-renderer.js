'use strict';
// Settings dialog laid out like muse.ai web. Sections backed by the same gateway routes as the web
// (theme color, permission defaults, devices, connectors, channels) read and write shared state;
// payment, passwords and data deletion stay on the web.
(function(){
  const byId=id=>document.getElementById(id);
  const dialog=byId('settingsDialog');
  const TITLES={general:'一般',connectors:'コネクター',permissions:'アクセス許可',channels:'メッセージチャネル',devices:'デバイス',app:'このアプリ',web:'Web 版で管理'};
  let current='general',overview=null,loading=null;

  function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
  function icon(name,className){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');use.setAttribute('href','#'+name);svg.append(use);if(className)svg.setAttribute('class',className);return svg;}
  function hintText(text){return el('p','settings-intro',text);}
  function rowText(title,description){const t=el('div','settings-row-text');t.append(el('strong','',title));if(description)t.append(el('span','',description));return t;}
  function group(rows){const g=el('div','settings-group');g.append(...rows);return g;}
  // Web-style selection mark: a check on the chosen row, nothing on the others.
  function check(){return icon('i-tick','settings-check');}
  // Letter tile for connectors/channels (their icons are remote images the page cannot load).
  function tile(name){const t=el('span','settings-tile',String(name||'?').trim().slice(0,1).toUpperCase());t.setAttribute('aria-hidden','true');return t;}
  function deviceTile(){const t=el('span','settings-tile');t.append(icon('i-device'));t.setAttribute('aria-hidden','true');return t;}
  // Swap the letter tile for the real connector icon once it arrives.
  function connectorIcon(tileEl,id){
    window.muse.connectorIcon(id).then(r=>{if(!r?.ok||!r.value)return;const img=el('img');img.alt='';img.src=r.value;tileEl.replaceChildren(img);tileEl.classList.add('has-icon');}).catch(()=>{});
  }
  function placeholder(){
    if(!state.connected)return hintText('Muse に接続すると表示されます。');
    const g=el('div','settings-group settings-loading');g.setAttribute('aria-label','読み込んでいます');
    for(let i=0;i<3;i++)g.append(el('div','settings-skeleton'));return g;
  }
  async function busy(groupEl,task){groupEl?.setAttribute('aria-busy','true');try{return await task();}finally{groupEl?.removeAttribute('aria-busy');}}
  function label(text){return el('h3','settings-label',text);}
  function openUrl(url){window.muse.openLink(url).catch(()=>{});}
  function relative(iso){
    const t=Date.parse(iso);if(!Number.isFinite(t))return '';
    const m=Math.round((Date.now()-t)/60000);
    if(m<1)return 'たった今';if(m<60)return m+'分前';if(m<1440)return Math.round(m/60)+'時間前';return Math.round(m/1440)+'日前';
  }

  function show(section){
    if(!TITLES[section])section='general';current=section;
    byId('settingsSectionTitle').textContent=TITLES[section];
    for(const s of dialog.querySelectorAll('[data-settings-section]'))s.hidden=s.dataset.settingsSection!==section;
    for(const b of dialog.querySelectorAll('[data-settings-nav]')){const on=b.dataset.settingsNav===section;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
    dialog.querySelector('.settings-body').scrollTop=0;
  }

  // ---- 一般: mode and theme color ----
  function renderModes(){
    const mode=document.documentElement.dataset.theme||'dark';
    for(const b of dialog.querySelectorAll('[data-theme-mode]'))b.setAttribute('aria-pressed',String(b.dataset.themeMode===mode));
  }
  function renderSwatches(){
    const host=byId('themeSwatches');host.replaceChildren();
    const themes=state.themes;if(!themes?.options){host.append(el('span','settings-value','接続すると表示されます'));return;}
    const mode=effectiveMode();
    // The web lists the avatar color first, then the server's order; options missing from order still show.
    const listed=Array.isArray(themes.order)?themes.order.filter(id=>themes.options[id]):[];
    const order=[...new Set(['avatar',...listed,...Object.keys(themes.options)])].filter(id=>themes.options[id]);
    for(const id of order){
      const option=themes.options[id],b=el('button','theme-swatch');
      b.type='button';b.setAttribute('role','radio');b.setAttribute('aria-checked',String(themes.selected_theme_id===id));b.title=id;b.setAttribute('aria-label','テーマカラー '+id);
      const avatar=id==='avatar'&&byId('avatarImage')?.src;
      if(avatar){const img=el('img');img.src=avatar;img.alt='';b.append(img);}
      else b.style.background=option.userBubble?.[mode]||option.background?.[mode]||'';
      b.addEventListener('click',()=>setTheme(id));
      host.append(b);
    }
  }
  async function setTheme(id){
    const themes=state.themes;if(!themes||themes.selected_theme_id===id)return;
    const previous=themes.selected_theme_id;
    themes.selected_theme_id=id;applyTheme();renderSwatches();
    try{const r=await window.muse.setTheme(id);if(!r.ok)throw new Error(r.error);}
    catch(e){themes.selected_theme_id=previous;applyTheme();renderSwatches();notice('テーマカラーを変更できませんでした: '+e.message);}
  }

  // ---- shared sections ----
  function renderConnectors(){
    const host=byId('settingsConnectors');host.replaceChildren();
    const r=overview?.connectors;if(!r){host.append(placeholder());return;}
    if(!r.ok){host.append(hintText('読み込めませんでした: '+r.error));return;}
    const linked=r.value.filter(c=>c.state==='connected'),available=r.value.filter(c=>c.state!=='connected');
    const row=c=>{const b=el('button','settings-row settings-link');b.type='button';const t=tile(c.name||c.id);connectorIcon(t,c.id);b.append(t,rowText(c.name||c.id,c.description),el('span','settings-value',c.state==='connected'?'連携済み':'連携する'),icon('i-external','settings-chevron'));b.addEventListener('click',()=>openUrl('https://muse.ai/'));return b;};
    if(linked.length)host.append(label('連携済み'),group(linked.map(row)));
    if(available.length)host.append(label('利用可能'),group(available.map(row)));
    if(!linked.length&&!available.length)host.append(hintText('コネクターはありません。'));
  }
  function renderPermissions(){
    const host=byId('settingsPermissions');host.replaceChildren();
    const r=overview?.permissions;if(!r){host.append(placeholder());return;}
    if(!r.ok){host.append(hintText('読み込めませんでした: '+r.error));return;}
    const v=r.value,content=v.default_content||{};
    const fallback={
      connector:{heading:'コネクターのデフォルト',options:{auto_allow:{title:'一部のアクションの前のみ確認',description:'あなたの情報をシェアする可能性があるアクションや重要な変更を行う前に'},always_ask:{title:'常に確認',description:'すべてのアクションの前に'}}},
      network:{heading:'ウェブアクセスのデフォルト設定',options:{auto_allow:{title:'一部のアクションの前のみ確認',description:'情報が共有される可能性がある場合、またはウェブサイトが見慣れない場合'},always_ask:{title:'常に確認',description:'ウェブサイトにアクセスする前に確認する'}}},
    };
    for(const kind of ['connector','network']){
      const c=content[kind]?.options?.auto_allow&&content[kind]?.options?.always_ask?content[kind]:fallback[kind];
      const selected=v[kind+'_default']||'auto_allow';
      const rows=['auto_allow','always_ask'].map(value=>{
        const o=c.options[value],b=el('button','settings-row settings-choice');b.type='button';
        b.setAttribute('role','radio');b.setAttribute('aria-checked',String(selected===value));
        b.append(rowText(o.title,o.description),check());
        b.addEventListener('click',()=>setPermission(kind,value,b.parentElement));
        return b;
      });
      const g=group(rows);g.setAttribute('role','radiogroup');g.setAttribute('aria-label',c.heading);
      host.append(label(c.heading),g);
    }
  }
  // ---- このアプリでの自動許可 (app-only; muse-approval-policy.js decides) ----
  const APPROVAL_MODES=[
    ['manual','自動で許可しない','毎回自分で確認します。'],
    ['auto','安全なものだけ自動で許可','ウェブアクセスやブラウザ表示など、リスクの低い確認を許可します。'],
    ['important','重要なものだけ確認','支払い・購入、注意表示つきの操作、メディアの送信、デバイスの操作以外を許可します。'],
    ['bypass','すべて自動で許可（Bypass）','支払いや注意表示つきの操作も確認なしで許可します。'],
  ];
  function renderApprovalModes(){
    const host=byId('settingsApprovalModes'),selected=byId('approvalMode').value;host.replaceChildren();
    for(const [value,title,description] of APPROVAL_MODES){
      const b=el('button','settings-row settings-choice');b.type='button';
      b.setAttribute('role','radio');b.setAttribute('aria-checked',String(selected===value));
      b.append(rowText(title,description),check());
      b.addEventListener('click',()=>setApprovalMode(value,host));
      host.append(b);
    }
  }
  async function setApprovalMode(mode,groupEl){
    const select=byId('approvalMode');if(select.value===mode)return;
    try{const r=await busy(groupEl,()=>window.muse.setApprovalMode(mode));if(!r.ok)throw new Error(r.error);select.value=r.value;}
    catch(e){notice('自動許可を変更できませんでした: '+e.message);}
    renderApprovalModes();
  }
  async function setPermission(kind,value,groupEl){
    const v=overview?.permissions?.value;if(!v||v[kind+'_default']===value)return;
    const next={connector:v.connector_default||'auto_allow',network:v.network_default||'auto_allow'};next[kind]=value;
    const previous={...v};v[kind+'_default']=value;renderPermissions();
    try{const r=await busy(groupEl,()=>window.muse.setPermissionDefaults(next));if(!r.ok)throw new Error(r.error);if(r.value?.connector_default)Object.assign(v,r.value);renderPermissions();}
    catch(e){Object.assign(v,previous);renderPermissions();notice('アクセス許可を変更できませんでした: '+e.message);}
  }
  function renderChannels(){
    const host=byId('settingsChannels');host.replaceChildren();
    const r=overview?.channels;if(!r){host.append(placeholder());return;}
    if(!r.ok){host.append(hintText('読み込めませんでした: '+r.error));return;}
    const names={whatsapp:'WhatsApp',messenger:'Messenger',telegram:'Telegram',imessage:'iMessage'};
    const list=r.value.filter(c=>c.provider!=='peer');
    if(!list.length){host.append(hintText('利用できるチャネルはありません。'));return;}
    host.append(label('利用可能'),group(list.map(c=>{
      const b=el('button','settings-row settings-link');b.type='button';
      b.append(tile(names[c.provider]||c.provider),rowText(names[c.provider]||c.provider),el('span','settings-value',c.linked?'連携済み':c.status==='link_pending'?'連携中':'未連携'),icon('i-external','settings-chevron'));
      b.addEventListener('click',()=>openUrl('https://muse.ai/'));return b;
    })));
  }
  function renderDevices(){
    const host=byId('settingsDevices');host.replaceChildren();
    const r=overview?.devices;if(!r){host.append(placeholder());return;}
    if(!r.ok){host.append(hintText('読み込めませんでした: '+r.error));return;}
    if(!r.value.length){host.append(hintText('登録されたデバイスはありません。'));return;}
    host.append(group(r.value.map(d=>{
      const row=el('div','settings-row');
      const dot=el('span','status-dot'+(d.online?' connected':''));dot.setAttribute('aria-hidden','true');
      row.append(deviceTile(),rowText(d.display_name||d.node_id||'デバイス',d.online?'アクティブ':relative(d.last_seen_at)),dot,el('span','settings-value',d.platform==='windows'?'Windows':d.platform==='android'?'Android':d.platform==='ios'?'iOS':d.platform||''));
      return row;
    })));
  }
  // ---- 利用状況 (same numbers as the web's Settings > 一般) ----
  let usage=null,usageLoading=null;
  function bar(percent){const b=el('div','settings-bar');const fill=el('span');fill.style.width=Math.max(0,Math.min(100,percent||0))+'%';b.append(fill);return b;}
  function renderUsage(){
    const host=byId('settingsUsage');host.replaceChildren();
    if(!usage){host.append(placeholder());return;}
    if(usage.error){host.append(hintText('読み込めませんでした: '+usage.error));return;}
    const u=usage.value,rows=[];
    const main=el('div','settings-row settings-usage');const head=el('div','settings-usage-head');
    head.append(rowText(u.usageLabel||u.plan||'プラン',u.statusSubtitle),el('span','settings-value',u.usageValue||(u.percentUsed!=null?u.percentUsed+'%使用済み':'')));
    main.append(head,bar(u.percentUsed));rows.push(main);
    if(u.topupLabel){
      const used=u.topupTotal>0&&u.topupBalance!=null?100*(1-u.topupBalance/u.topupTotal):0;
      const top=el('div','settings-row settings-usage');const th=el('div','settings-usage-head');
      th.append(rowText(u.topupLabel),el('span','settings-value',u.topupValue||''));top.append(th,bar(used));rows.push(top);
    }
    if(u.upgradeLabel&&!u.paid){const b=el('button','settings-row settings-link settings-accent');b.type='button';b.append(rowText(u.upgradeLabel),icon('i-external','settings-chevron'));b.addEventListener('click',()=>openUrl('https://muse.ai/'));rows.push(b);}
    host.append(group(rows));
  }
  async function loadUsage(){
    if(!state.connected||usageLoading)return usageLoading;
    usageLoading=window.muse.subscription().then(r=>{usage=r.ok?{value:r.value}:{error:r.error};}).catch(e=>{usage={error:e.message};}).finally(()=>{usageLoading=null;renderUsage();});
    return usageLoading;
  }
  function renderPcState(){
    byId('settingsPcState').textContent=state.pcConnected?'接続中':'未接続';
  }
  function renderAll(){renderUsage();renderModes();renderSwatches();renderConnectors();renderPermissions();renderApprovalModes();renderChannels();renderDevices();renderPcState();}

  async function load(){
    if(!state.connected){overview=null;renderAll();return;}
    if(loading)return loading;
    loading=(async()=>{try{const r=await window.muse.settingsOverview();overview=r.ok?r.value:null;if(!r.ok)notice(r.error);}finally{loading=null;}renderAll();})();
    return loading;
  }
  window.openSettings=section=>{
    show(section||current);renderAll();
    if(!dialog.open){dialog.showModal();byId('settingsSectionTitle').focus();}
    load().catch(()=>{});loadUsage();
  };
  window.renderSettingsTheme=()=>{if(dialog.open){renderModes();renderSwatches();}};

  for(const b of dialog.querySelectorAll('[data-settings-nav]'))b.addEventListener('click',()=>show(b.dataset.settingsNav));
  for(const b of dialog.querySelectorAll('[data-theme-mode]'))b.addEventListener('click',()=>{setThemeMode(b.dataset.themeMode);renderModes();renderSwatches();});
  for(const b of dialog.querySelectorAll('[data-open-url]'))b.addEventListener('click',()=>openUrl(b.dataset.openUrl));
  window.muse.onEvent(value=>{if(value.type==='pc-connection'&&dialog.open)renderPcState();});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key===','&&!document.body.classList.contains('login-mode')){e.preventDefault();window.openSettings();}});
  show('general');
})();
