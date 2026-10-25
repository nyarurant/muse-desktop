'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {localMessageView}=require('../src/chat-model');

// Old conversations still hold messages from the retired text-protocol agent; they keep a clean display.
const OLD_TASK='[Local agent task — sent by the Muse App on the user\'s PC, not typed by the user]\nYou can work in a local folder…\n\nWorkspace: C:/work\nPlatform: win32\n\nTask from the user:\nRead the project and fix the failure.';
const OLD_RESULTS='[Local tool results — sent by the Muse App, not typed by the user]\n\n## read: ok\na < b';

test('the displayed task is the user request without transport instructions',()=>{
  assert.deepEqual(localMessageView({role:'user',content:OLD_TASK}),{content:'Read the project and fix the failure.',toolResults:false});
  const ordinary='Task from the user:\nLeave this ordinary message as typed.';
  assert.equal(localMessageView({role:'user',content:ordinary}).content,ordinary);
});
test('actual tool results are marked for an expandable result view',()=>{
  const v=localMessageView({role:'user',content:OLD_RESULTS});
  assert.equal(v.toolResults,true);assert.match(v.content,/a < b/);
});
test('local tool requests show actions and done shows the final response',()=>{
  const v=localMessageView({role:'assistant',content:'```local-tool\n{"tool":"read","path":"a.js"}\n```\n```local-tool\n{"tool":"done","summary":"Verified."}\n```'});
  assert.match(v.content,/a.js/);assert.match(v.content,/Verified\./);assert.doesNotMatch(v.content,/local-tool|"tool"/);
  const invalid='```local-tool\n{invalid}\n```';
  assert.equal(localMessageView({role:'assistant',content:invalid}).content,invalid);
});
