'use strict';
// End-to-end check of the running app (start it with --remote-debugging-port=9337, then `npm run test:ui`).
// It sends one message from a new side chat and archives that chat at the end.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require('playwright-core');
const endpoint=process.argv.find(a=>a.startsWith('--cdp='))?.slice(6)||'http://127.0.0.1:9337';
(async()=>{
  const browser=await chromium.connectOverCDP(endpoint);
  let page,testChat=null;
  try{
    const context=browser.contexts()[0];
    page=context.pages().find(p=>p.url().endsWith('/app.html'));assert(page,'Local application page missing');
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const result={};
    await page.waitForFunction(()=>state.connected&&!document.getElementById('refresh').disabled&&document.querySelectorAll('.message').length>0,null,{timeout:60000});
    assert(page.url().startsWith('file:'),'Conversation UI must be local');
    assert(await page.evaluate(()=>document.getElementById('connect').hidden),'The connection pill hides while connected');
    result.liveHistory=true;

    // Chat: send from a new side chat, reply arrives, draft survives a refresh.
    await page.locator('#newChat').click();
    await page.waitForFunction(()=>!document.getElementById('welcome').hidden);
    assert(await page.locator('#mic').isVisible(),'Microphone button in the composer');
    const marker='MUSE_UI_CHECK_'+crypto.randomBytes(4).toString('hex');
    await page.locator('#prompt').fill('Muse アプリの画面からの接続テストです。ツールや外部操作は行わず、次の文字列だけを返信してください: '+marker);
    await page.locator('#send').click();
    await page.waitForFunction(marker=>[...document.querySelectorAll('.assistant .message-body')].some(e=>e.textContent.includes(marker)),marker,{timeout:90000});
    testChat=await page.evaluate(()=>state.selected);
    await page.waitForFunction(()=>document.getElementById('thinking').hidden,null,{timeout:30000});
    assert(await page.locator('.time-sep').count()>0,'Time separator on the first message');
    await page.locator('#prompt').fill('下書きの保持を確認');
    assert(await page.locator('#send').isEnabled(),'Send must become usable after reply');
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
    assert.equal(await page.locator('#prompt').inputValue(),'下書きの保持を確認');
    assert(await page.locator('.assistant .message-body').filter({hasText:marker}).count()>0,'Reply must persist after refresh');
    await page.locator('#prompt').fill('');
    result.sendViaUI=result.replyPersisted=result.draftPreserved=true;

    // Settings: web-style sections with live data.
    await page.keyboard.press('Control+Comma');
    assert(await page.locator('#settingsDialog').isVisible(),'Ctrl+, opens settings');
    assert.equal(await page.locator('[data-settings-nav]').count(),8,'Settings sections');
    await page.waitForFunction(()=>document.querySelectorAll('#settingsUsage .settings-bar').length>0||/読み込めませんでした/.test(document.getElementById('settingsUsage').textContent),null,{timeout:30000});
    result.usage=await page.evaluate(()=>document.querySelectorAll('#settingsUsage .settings-bar').length>0);
    for(const section of ['connectors','permissions','channels','devices','data','app','web']){
      await page.locator(`[data-settings-nav="${section}"]`).click();
      assert(await page.locator(`[data-settings-section="${section}"]`).isVisible(),section+' section');
    }
    await page.locator('[data-settings-nav="permissions"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#settingsPermissions [role=radio]').length===4,null,{timeout:20000});
    assert.equal(await page.locator('#settingsApprovalModes [role=radio]').count(),4,'App auto-approval modes');
    assert(await page.locator('#pcGuardSwitch').isVisible(),'Guard switch for risky PC operations');
    await page.locator('[data-settings-nav="data"]').click();
    await page.waitForFunction(()=>!document.getElementById('trainingSwitch').disabled,null,{timeout:20000});
    await page.locator('#closeSettings').click();
    result.settings=true;

    // Search, library categories, local work page, activity detail.
    await page.locator('#search').fill('NO_SUCH_CONVERSATION_'+marker);assert.equal(await page.locator('#sessions .session').count(),0);await page.locator('#search').fill('');
    await page.locator('#railLibrary').click();
    assert(await page.locator('#libraryNav').isVisible(),'Library categories replace the chat list');
    await page.locator('#libraryNav [data-lib="web"]').click();
    await page.waitForFunction(()=>document.getElementById('pageTitle').textContent==='ウェブアーティファクト');
    const pageCount=context.pages().length;await page.locator('#tools').click();
    assert(await page.locator('#workspaceView').isVisible(),'Local work page opens inside the main window');
    assert.equal(context.pages().length,pageCount,'Local work must not open another window');
    await page.locator('#railChat').click();
    if(await page.locator('#activityList .activity-item').count()){
      await page.locator('#activityList .activity-item').first().click();
      assert(await page.locator('#activityDialog').isVisible(),'Activity detail opens');
      await page.keyboard.press('Escape');
      result.activity=true;
    }
    result.library=result.localWork=true;

    const artifacts=path.join(__dirname,'..','artifacts');fs.mkdirSync(artifacts,{recursive:true});
    await page.screenshot({path:path.join(artifacts,'muse-desktop.png')});
    await page.setViewportSize({width:600,height:800});
    if(!await page.evaluate(()=>document.body.classList.contains('sidebar-hidden')))await page.locator('#collapseSidebar').click();
    await page.waitForTimeout(250);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Narrow view overflows');
    await page.screenshot({path:path.join(artifacts,'muse-compact.png')});
    await page.setViewportSize({width:1250,height:850});await page.waitForTimeout(250);
    if(await page.evaluate(()=>document.body.classList.contains('sidebar-hidden')))await page.locator('#showSidebar').click();
    result.compactLayout=true;
    assert.deepEqual(errors,[],'Renderer errors');
    result.rendererErrors=errors.length;
    console.log(JSON.stringify(result));
  }finally{
    // Leave the conversation list as it was: archive the chat this check created.
    if(page&&testChat)await page.evaluate(async id=>{await window.muse.sessionAction(id,'archive');if(state.selected===id)await select('');await refreshSessions();},testChat).catch(()=>{});
    await browser.close();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
