'use strict';
// Read-only by default. --send-test creates a separate thread and sends one
// harmless confirmation prompt; it never sends to the user's primary chat.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {MuseClient,captureCredentials}=require('../src/muse-client');
const {mergeMessages}=require('../src/chat-model');
const file=process.argv.find(a=>a.startsWith('--har='))?.slice(6);
if(!file)throw new Error('Pass --har=<capture path>');
const shape=v=>v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,Array.isArray(x)?'array('+x.length+')':typeof x])):typeof v;
(async()=>{
  const c=new MuseClient({credentials:captureCredentials(file)});
  try{
    await c.connect();
    const sessions=await c.sessions();assert(Array.isArray(sessions.sessions));
    const history=await c.history();assert(Array.isArray(history.chat_events));
    const messages=mergeMessages([],history.chat_events);assert(messages.every(m=>typeof m.content==='string'));
    const sub=await c.subscribe();assert.equal(sub.subscribed,true);
    console.log(JSON.stringify({connected:true,sessions:sessions.sessions.length,historyEvents:history.chat_events.length,visibleMessages:messages.length,subscribed:true}));
    if(process.argv.includes('--send-test')){
      const id=crypto.randomUUID();
      assert(id!==sub.session_id,'Test must not use primary chat');
      const marker='MUSE_APP_CHECK_'+crypto.randomBytes(4).toString('hex');
      const prompt='Muse デスクトップアプリの接続テストです。外部操作やツール実行はせず、次の文字列だけを返信してください: '+marker;
      const eventNames=new Set();c.on('event',e=>{if(!eventNames.has(e.event)){eventNames.add(e.event);console.log('event-schema',e.event,shape(e.payload));}});
      await c.send(prompt,id,'muse-app-verification');
      console.log('send acknowledged');
      const detail=await c.request('GET','/api/session/list/'+encodeURIComponent(id));
      const session=detail.session||detail;assert.equal(session.is_thread,true);assert.equal(session.is_primary,false);
      await c.subscribe(id);
      const deadline=Date.now()+90000;let received=false;
      while(Date.now()<deadline){await new Promise(r=>setTimeout(r,2000));const h=await c.history(id);const m=mergeMessages([],h.chat_events||[]);if(m.some(x=>x.role==='assistant'&&x.content.includes(marker))){received=true;console.log('dedicated thread: user message persisted and assistant reply verified');break;}}
      assert(received,'Assistant reply not observed in thread history');
    }
  }finally{c.disconnect(false);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
