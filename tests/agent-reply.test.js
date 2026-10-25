'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {waitForReply}=require('../src/agent-reply');
const {MuseClient}=require('../src/muse-client');

class Client extends EventEmitter {
  constructor(){super();this.events=[];this.turnStatus='running';this.reads=0;}
  async history(){this.reads++;return {chat_events:this.events};}
  async request(){return {session:{status:this.turnStatus}};}
  event(event,payload={}){this.emit('event',{event,payload:{session_id:'chat',...payload}});}
  reply(text,{ready=true,id='reply',replyTo='user'}={}){
    this.events=[{event_name:'message.assistant',message_id:id,reply_to_message_id:replyTo,display_text:text,display_text_ready:ready}];
  }
}
const tick=()=>new Promise(r=>setImmediate(r));
function waiting(t,client,options={}){
  const wait=waitForReply({client,sessionId:'chat',pollMs:60000,timeoutMs:3000,...options});
  t.after(()=>wait.cancel());return wait;
}

test('turn-completed before message-done does not expose a partial tool call',async t=>{
  const c=new Client(),w=waiting(t,c);let settled=false;
  w.promise.then(()=>{settled=true;});w.accept('user');
  c.reply('```local-tool\n{"tool":"write","path":"par',{ready:false});
  c.turnStatus='completed';c.event('task.status',{status:'completed'});await tick();
  assert.equal(settled,false);
  const complete='```local-tool\n{"tool":"write","path":"part.txt","content":"complete"}\n```';
  c.reply(complete);c.event('delta.message_done',{status:'completed',message_id:'reply'});
  assert.equal((await w.promise).text,complete);
  assert.equal(c.listenerCount('event'),0);assert.equal(c.listenerCount('status'),0);
});

test('message-done while the task is still running waits for the final task state',async t=>{
  const c=new Client(),w=waiting(t,c);let settled=false;
  w.promise.then(()=>{settled=true;});w.accept('user');
  c.reply('first');c.event('delta.message_done',{status:'completed',message_id:'reply'});await tick();
  assert.equal(settled,false);
  c.turnStatus='completed';c.event('task.status',{status:'completed'});
  assert.equal((await w.promise).text,'first');
});
test('distinct duplicated assistant messages produce only one final tool request',async t=>{
  const c=new Client(),w=waiting(t,c);w.accept('user');
  const content='```local-tool\n{"tool":"run","command":"hostname"}\n```';
  c.events=[
    {event_name:'message.assistant',message_id:'first',seq:10,display_text:content,display_text_ready:true},
    {event_name:'message.assistant',message_id:'final',seq:11,display_text:content,display_text_ready:true},
  ];
  c.turnStatus='completed';c.event('delta.message_done',{status:'completed',message_id:'final'});
  const result=await w.promise;assert.equal(result.text,content);assert.deepEqual(result.messageIds,['first','final']);
});
test('a later unready final reply prevents executing an earlier ready message',async t=>{
  const c=new Client(),w=waiting(t,c);let settled=false;w.promise.then(()=>{settled=true;});w.accept('user');
  c.events=[
    {event_name:'message.assistant',message_id:'first',seq:10,display_text:'earlier command',display_text_ready:true},
    {event_name:'message.assistant',message_id:'final',seq:11,display_text:'unfinished',display_text_ready:false},
  ];
  c.turnStatus='completed';c.event('delta.message_done',{status:'completed',message_id:'first'});await tick();assert.equal(settled,false);
  c.events[1]={...c.events[1],display_text:'actual final',display_text_ready:true};
  c.event('delta.message_done',{status:'completed',message_id:'final'});assert.equal((await w.promise).text,'actual final');
});

test('other chats, subagents, old messages, and replies to other user turns cannot execute',async t=>{
  const c=new Client(),w=waiting(t,c,{baseline:new Set(['old'])});w.accept('user');
  c.turnStatus='completed';c.reply('old command',{id:'old'});
  c.event('delta.message_done',{status:'completed',message_id:'old'});await tick();
  const reads=c.reads;
  c.event('delta.message_done',{session_id:'other',status:'completed',message_id:'bad'});
  c.event('delta.message_done',{parent_agent_id:'child',status:'completed',message_id:'bad'});
  await tick();assert.equal(c.reads,reads);
  c.reply('wrong turn',{replyTo:'someone-else'});c.event('delta.message_done',{status:'completed',message_id:'reply'});await tick();
  c.reply('right turn');c.event('delta.message_done',{status:'completed',message_id:'reply'});
  assert.equal((await w.promise).text,'right turn');
});

test('stop and disconnection reject the wait immediately and remove listeners',async t=>{
  for(const stop of ['abort','disconnect']){
    const c=new Client(),controller=new AbortController(),w=waiting(t,c,{signal:controller.signal});w.accept('user');
    if(stop==='abort')controller.abort();else c.emit('status',{status:'disconnected'});
    await assert.rejects(w.promise,stop==='abort'?{name:'AbortError'}:/接続が切れ/);
    assert.equal(c.listenerCount('event'),0);assert.equal(c.listenerCount('status'),0);
  }
});

test('a failed turn never returns its unfinished tool text',async t=>{
  const c=new Client(),w=waiting(t,c);c.reply('```local-tool\n{"tool":"run","command":"unsafe partial"}\n```');
  c.turnStatus='failed';w.accept('user');await assert.rejects(w.promise,/failed/);
});

test('a missing completion event recovers from a stable canonical transcript',async t=>{
  const c=new Client(),w=waiting(t,c,{settleMs:1});c.reply('completed reply');c.turnStatus='completed';w.accept('user');
  assert.equal((await w.promise).text,'completed reply');
});

test('changing the visible conversation preserves the PC agent subscription',async()=>{
  const c=new MuseClient({credentials:null});const cancelled=[];
  c.pending.set('view',{path:'/chat/subscribe'});c.pending.set('agent',{path:'/chat/subscribe',subscriptionScope:'run-1'});
  c.cancelRequest=id=>{cancelled.push(id);c.pending.delete(id);};
  c.request=async()=>({subscribed:true});
  await c.subscribe('another-chat');assert.deepEqual(cancelled,['view']);
  c.closeAgentSubscription('run-1');assert.deepEqual(cancelled,['view','agent']);
});
test('replacing a not-yet-acknowledged view subscription settles its original caller',async()=>{
  const c=new MuseClient({credentials:null});let resolve;
  const original=new Promise(r=>{resolve=r;});
  c.pending.set('view',{path:'/chat/subscribe',settled:false,resolve,timer:setTimeout(()=>{},10000)});
  c.request=async()=>({subscribed:true});await c.subscribe('another-chat');
  assert.deepEqual(await original,{subscribed:false,cancelled:true});assert.equal(c.pending.size,0);
});
test('subscription timeouts still reject instead of returning a cancelled success',async()=>{
  const c=new MuseClient({credentials:{appId:'test'}});c.status='connected';
  c.transport={request:()=>({id:1n,frames:[]})};c.ws={send(){}};
  await assert.rejects(c.request('POST','/chat/subscribe',{}, {stream:true,timeout:5}),/タイムアウト/);
  assert.equal(c.pending.size,0);
});
