'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeMessages,applyDelta}=require('../src/chat-model');
const {allowedGateway,unwrap}=require('../src/muse-client');
test('history updates replace a message and exclude private transcript events',()=>{
  const messages=mergeMessages([], [
    {event_name:'message.assistant',message_id:'answer',seq:2,role:'assistant',visibility:'public',display_text:'partial'},
    {event_name:'message.user',message_id:'question',seq:1,role:'user',visibility:'public',payload:{content:'question'}},
    {event_name:'delta.presentation',message_id:'answer',seq:3,role:'assistant',visibility:'public',display_text:'finished'},
    {message_id:'secret',seq:4,role:'assistant',visibility:'private',display_text:'internal'},
  ]);
  assert.deepEqual(messages.map(m=>[m.id,m.content]),[['question','question'],['answer','finished']]);
});
test('credentials may only be sent to the fixed Muse VM domain',()=>{
  for(const value of ['wss://hatch.metaaivm.com.evil.example/','ws://hatch.metaaivm.com/','wss://evil.example/','wss://user:pass@hatch.metaaivm.com/','wss://hatch.metaaivm.com:8443/'])assert.throws(()=>allowedGateway(value));
  assert.equal(allowedGateway('wss://hatch.metaaivm.com/').hostname,'hatch.metaaivm.com');
});
test('gateway errors never reflect raw request or response credentials',()=>{
  assert.throws(()=>unwrap({ok:false,error:{code:'expired',message:'sensitive-token'}}),e=>!e.message.includes('sensitive-token'));
  assert.deepEqual(unwrap({ok:true,result:{value:1}}),{value:1});
});
test('streaming text is assembled once when an event is repeated',()=>{
  let messages=[];
  for(const [name,seq,text]of [['delta.message_start',1],['delta.text_append',2,'hello'],['delta.text_append',2,'hello'],['delta.text_append',3,' world']])messages=applyDelta(messages,{event:name,payload:{message_id:'reply',message_seq:10,seq,text}});
  assert.equal(messages.length,1);assert.equal(messages[0].content,'hello world');assert.equal(messages[0].seq,10);
});
