'use strict';
// Activity detail, like muse.ai web: steps on the left (開始済み → each action → 完了), and on the
// right the status, title and summary, or the report of the step that was picked. Everything comes
// from the activity list item itself (details.goal_actions / finish_message / finish_status).
(function(){
  const byId=id=>document.getElementById(id);
  const dialog=byId('activityDialog');
  let current=null,renderToken=0;

  function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
  function svg(name){const ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg'),u=document.createElementNS(ns,'use');u.setAttribute('href','#'+name);s.append(u);return s;}
  function clock(iso){const t=new Date(iso);return Number.isNaN(t.getTime())?'':t.getHours()+':'+String(t.getMinutes()).padStart(2,'0');}
  function overall(a){
    const s=String(a.details?.finish_status?.status||a.status||'').toLowerCase();
    if(['success','completed','complete','done','succeeded'].includes(s))return {kind:'done',label:'完了'};
    if(['error','failed','failure','cancelled','canceled'].includes(s))return {kind:'failed',label:s.startsWith('cancel')?'中止':'失敗'};
    return {kind:'running',label:'実行中'};
  }
  async function markdown(host,text){
    const token=renderToken;
    try{const html=await window.muse.renderMarkdown(String(text||''));if(token!==renderToken)return;if(html.ok){host.innerHTML=html.value;return;}}catch{}
    host.textContent=String(text||'');host.style.whiteSpace='pre-wrap';
  }

  function showOverview(){
    const a=current,o=overall(a),host=byId('activityMain');renderToken++;host.replaceChildren();
    const badge=el('span','activity-badge '+o.kind,o.label);
    host.append(badge,el('h2','activity-detail-title',a.title||a.status_title||''));
    const sub=typeof a.subtitle==='string'?a.subtitle:a.status_title;
    if(sub&&sub!==a.title)host.append(el('p','activity-detail-sub',sub));
    const summary=a.details?.finish_message||a.details?.finish_status?.reason;
    if(summary){host.append(el('h3','activity-detail-heading','サマリー'));const body=el('div','message-body activity-detail-body');host.append(body);markdown(body,summary);}
    else if(o.kind==='running')host.append(el('p','activity-detail-sub','まだ作業中です。'));
    select('overview');
  }
  function showStep(step,index){
    const host=byId('activityMain');renderToken++;host.replaceChildren();
    const failed=String(step.status).toUpperCase()==='FAILED';
    host.append(el('span','activity-badge '+(failed?'failed':'done'),failed?'失敗':'完了'),el('h2','activity-detail-title',step.title||'ステップ'));
    if(step.subtitle)host.append(el('p','activity-detail-sub',step.subtitle));
    if(step.report){const body=el('div','message-body activity-detail-body');host.append(body);markdown(body,step.report);}
    select('step-'+index);
  }
  function select(key){for(const b of byId('activitySteps').querySelectorAll('[data-key]'))b.classList.toggle('active',b.dataset.key===key);}

  function stepButton(key,label,time,state,onClick){
    const b=el('button','activity-step '+state);b.type='button';b.dataset.key=key;
    const mark=el('span','activity-step-mark');if(state==='failed')mark.append(svg('i-close'));else if(state!=='pending')mark.append(svg('i-tick'));
    const text=el('span','activity-step-text');text.append(el('span','activity-step-label',label));if(time)text.append(el('span','activity-step-time',time));
    b.append(mark,text);b.addEventListener('click',onClick);return b;
  }
  window.openActivity=a=>{
    current=a;const steps=byId('activitySteps');steps.replaceChildren();
    const actions=Array.isArray(a.details?.goal_actions)?a.details.goal_actions.slice().sort((x,y)=>(x.action_index??0)-(y.action_index??0)):[];
    const o=overall(a);
    steps.append(stepButton('overview','開始済み',clock(actions[0]?.created_at||a.timestamp),'done',showOverview));
    actions.forEach((s,i)=>steps.append(stepButton('step-'+i,s.title||s.subtitle||'ステップ',clock(s.created_at),String(s.status).toUpperCase()==='FAILED'?'failed':'done',()=>showStep(s,i))));
    steps.append(stepButton('end',o.label,o.kind==='running'?'':clock(a.timestamp),o.kind==='running'?'pending':o.kind,showOverview));
    showOverview();
    if(!dialog.open)dialog.showModal();
    byId('activityMain').focus();
  };
  byId('closeActivity').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
})();
