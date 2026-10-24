'use strict';
// Shared by the local renderer and tests; never execute markup from Muse.
function messageFromEvent(event) {
  const p=event.payload||event;
  const name=event.event_name||event.event||'';
  const role=event.role||p.role||(name==='message.user'?'user':name==='message.assistant'?'assistant':null);
  const visibility=event.visibility||p.visibility;
  if(visibility && visibility!=='public') return null;
  if(!['user','assistant'].includes(role)) return null;
  let content=event.display_text??p.display_text??p.content??p.text;
  if(typeof content!=='string')return null;
  const id=event.message_id||p.message_id||p.id;
  if(typeof id!=='string'||!id)return null;
  return {id,role,content,seq:Number(event.seq??p.chat_event_seq??p.seq??0),time:event.occurred_at_ms??p.created_at_ms??0,sessionId:p.session_id??event.session_id??'',resources:event.resources||p.resources||[]};
}
function mergeMessages(existing,events) {
  const map=new Map(existing.map(m=>[m.id,m]));
  for(const event of events) {const m=messageFromEvent(event);if(m)map.set(m.id,{...map.get(m.id),...m});}
  return [...map.values()].sort((a,b)=>a.seq-b.seq||a.time-b.time);
}
function applyDelta(existing,event) {
  const p=event.payload||{},name=event.event;
  if(!name?.startsWith('delta.')||typeof p.message_id!=='string')return existing;
  const prior=existing.find(m=>m.id===p.message_id);
  if(prior?.lastDeltaSeq&&Number(p.seq)<=prior.lastDeltaSeq)return existing;
  let content=prior?.content||'';
  if(name==='delta.text_append'&&typeof p.text==='string')content+=p.text;
  else if(name==='delta.presentation'&&typeof p.display_text==='string')content=p.display_text;
  else if(name==='delta.message_done'){
    const t=p.transcript;const text=t?.display_text??t?.content??t?.text;if(typeof text==='string')content=text;
  }else if(name!=='delta.message_start')return existing;
  const message={...prior,id:p.message_id,role:'assistant',content,seq:prior?.seq??Number(p.message_seq??p.seq??0),time:prior?.time??Date.now(),sessionId:p.session_id||'',lastDeltaSeq:Number(p.seq)||0};
  return [...existing.filter(m=>m.id!==message.id),message].sort((a,b)=>a.seq-b.seq||a.time-b.time);
}
if(typeof module!=='undefined')module.exports={messageFromEvent,mergeMessages,applyDelta};
