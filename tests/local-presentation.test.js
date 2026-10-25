'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {localMessageView}=require('../src/chat-model');
const {buildTaskMessage,formatToolResults}=require('../src/local-agent');

test('the displayed task is the user request without transport instructions',()=>{
  const content=buildTaskMessage({workspace:'C:/work',platform:'win32',task:'Read the project and fix the failure.'});
  assert.deepEqual(localMessageView({role:'user',content}),{content:'Read the project and fix the failure.',toolResults:false});
  const ordinary='Task from the user:\nLeave this ordinary message as typed.';
  assert.equal(localMessageView({role:'user',content:ordinary}).content,ordinary);
});
test('actual tool results are marked for an expandable result view',()=>{
  const v=localMessageView({role:'user',content:formatToolResults([{tool:'read',ok:true,output:'a < b'}])});
  assert.equal(v.toolResults,true);assert.match(v.content,/a < b/);
});
test('local tool requests show actions and done shows the final response',()=>{
  const v=localMessageView({role:'assistant',content:'```local-tool\n{"tool":"read","path":"a.js"}\n```\n```local-tool\n{"tool":"done","summary":"Verified."}\n```'});
  assert.match(v.content,/a.js/);assert.match(v.content,/Verified\./);assert.doesNotMatch(v.content,/local-tool|"tool"/);
  const invalid='```local-tool\n{invalid}\n```';
  assert.equal(localMessageView({role:'assistant',content:invalid}).content,invalid);
});
