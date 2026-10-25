'use strict';
const {messageFromEvent}=require('./chat-model');

const BUSY=new Set(['running','pending','queued','in_progress','started','waiting_for_approval']);
const FAILED=new Set(['failed','error','errored','cancelled','canceled','stopped','interrupted']);

// Only a completed turn with a canonical, ready transcript may reach the executor.
// Delta notifications trigger the read; polling is a recovery path for a lost subscription.
function waitForReply({client,sessionId,baseline=new Set(),signal,timeoutMs=600000,pollMs=5000,settleMs=500}) {
  let ended=false,checking=false,again=false,accepted=false,expectedReply=null;
  let doneIds=new Set(),last='',stableAt=0,retry=null,resolveReply,rejectReply;
  const promise=new Promise((resolve,reject)=>{resolveReply=resolve;rejectReply=reject;});
  // Sending can fail before the caller starts awaiting this promise.
  promise.catch(()=>{});
  const cleanup=()=>{
    clearTimeout(timeout);clearTimeout(retry);clearInterval(poll);
    client.off('event',onEvent);client.off('status',onStatus);signal?.removeEventListener('abort',onAbort);
  };
  const finish=(error,value)=>{if(ended)return;ended=true;cleanup();error?rejectReply(error):resolveReply(value);};
  const cancel=()=>finish(Object.assign(new Error('PC の操作を停止しました。'),{name:'AbortError'}));
  const check=async()=>{
    if(ended||!accepted)return;
    if(checking){again=true;return;}
    checking=true;
    try {
      const [history,detail]=await Promise.all([
        client.history(sessionId),client.request('GET','/api/session/list/'+encodeURIComponent(sessionId)),
      ]);
      if(ended)return;
      const status=String((detail?.session||detail)?.status||'').toLowerCase();
      if(FAILED.has(status)){finish(new Error('Muse の作業が終了しました ('+status+')。PC 操作は続行しません。'));return;}
      if(!status||BUSY.has(status))return;
      const byId=new Map();
      for(const event of history.chat_events||[]){
        const message=messageFromEvent(event);
        if(message?.role!=='assistant'||!message.content||baseline.has(message.id)||(expectedReply&&message.replyTo&&message.replyTo!==expectedReply))continue;
        byId.set(message.id,{...message,ready:event.display_text_ready!==false&&event.payload?.display_text_ready!==false});
      }
      const messages=[...byId.values()].sort((a,b)=>a.seq-b.seq||a.time-b.time);
      const latest=messages[messages.length-1];
      if(!latest?.ready)return;
      // A turn can publish several assistant messages, including identical copies
      // under different IDs. Only its final reply is a tool request, as in the
      // original protocol. Executing their concatenation can repeat side effects.
      const signature=JSON.stringify([latest.id,latest.content]);
      if(signature!==last){last=signature;stableAt=Date.now();}
      if(doneIds.has(latest.id)||Date.now()-stableAt>=settleMs){
        finish(null,{text:latest.content,messageIds:messages.map(m=>m.id)});
      }else{
        clearTimeout(retry);retry=setTimeout(()=>void check(),settleMs);
      }
    }catch{ /* A fresh thread or a reconnect may not be readable yet. Never re-send. */ }
    finally{
      checking=false;
      if(again&&!ended){again=false;queueMicrotask(()=>void check());}
    }
  };
  const onEvent=e=>{
    const p=e.payload||{};
    if((p.session_id||e.session_id)!==sessionId||p.parent_agent_id)return;
    if(e.event==='delta.message_done'&&p.status==='completed'&&!baseline.has(p.message_id)){
      doneIds.add(p.message_id);void check();
    }else if(e.event==='task.status'&&!BUSY.has(String(p.status||'').toLowerCase()))void check();
    else if(e.event==='sessions.updated'&&doneIds.size)void check();
  };
  const onStatus=({status})=>{if(status!=='connected')finish(new Error('Muse との接続が切れたため、PC 操作を停止しました。'));};
  const onAbort=()=>cancel();
  const timeout=setTimeout(()=>finish(new Error('Muse の応答がタイムアウトしました。')),timeoutMs);
  const poll=setInterval(()=>void check(),pollMs);
  client.on('event',onEvent);client.on('status',onStatus);signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)cancel();
  return {
    promise,cancel,
    accept(replyId){expectedReply=replyId||null;accepted=true;void check();},
    refresh:()=>void check(),
  };
}
module.exports={waitForReply};
