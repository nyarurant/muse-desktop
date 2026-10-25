'use strict';
// Offline flow check: real renderer + real auth state machine, synthetic HTTPS responses.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright-core');const {PcAuth}=require('../src/pc-auth');
(async()=>{
  const browser=await chromium.launch({executablePath:path.join(process.env['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe'),headless:true});
  try{
    let saved={sdkToken:'mgst_SYNTHETIC_NOT_A_REAL_TOKEN',nodeId:'homelink-123456'},wrong=false,connects=0,unexpectedSends=0;
    const auth=new PcAuth({load:()=>saved,save:v=>{saved=v;},expectedVm:async()=>'test-vm',listSdk:async()=>{throw new Error('Must reuse SDK token');},issueSdk:async()=>{throw new Error('Must not issue another token');},request:async(_scope,route,body)=>{
      if(route.endsWith('/start'))return {access_token:'synthetic-temporary'};
      if(route.endsWith('/login_options'))return {};
      if(route.endsWith('/send_otp'))return {auth_state:'synthetic-auth-state'};
      if(route.endsWith('/confirm_otp')){if(body.otp_code==='000000'){wrong=true;throw new Error('コードが違います。再入力してください。');}return {account_selection_required:true,selection_state:'synthetic-selection',accounts:[{display_name:'Test account',account_ref:'synthetic-account'}]};}
      if(route.endsWith('/select_account'))return {two_factor_required:true,two_factor_state:'synthetic-2fa',two_factor_methods:[{method_id:'totp',method_type:'TOTP'}]};
      if(route.endsWith('/send_code')){unexpectedSends++;throw new Error('Authenticator must not send OTP');}
      if(route.endsWith('/two_factor'))return {abra_access_token:'synthetic-user',abra_user_id:'synthetic-user-id'};
      if(route.endsWith('/mint'))return {access_token:'synthetic-device',refresh_token:'synthetic-refresh'};
      if(route==='/fetch_vms')return {vm_list:[{vm_id:'test-vm',vm_auth_token:'synthetic-vm'}]};
      throw new Error('Unexpected synthetic request');
    }});
    const page=await browser.newPage({viewport:{width:560,height:820},bypassCSP:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.exposeFunction('__pcAuthCheck',async(name,args)=>{
      const map={pcAuthState:()=>auth.snapshot(),pcAuthStart:(...a)=>auth.start(...a),pcAuthSend:(...a)=>auth.send(...a),pcAuthConfirm:(...a)=>auth.confirm(...a),pcAuthSelect:(...a)=>auth.select(...a),pcAuthTwoFactorSend:i=>auth.twoFactor(i),pcAuthTwoFactorConfirm:(i,c)=>auth.twoFactor(i,c),pcAuthCancel:()=>auth.cancel(),pcConnect:()=>{connects++;return {...auth.snapshot(),phase:'ready'};}};
      if(!map[name])throw new Error('Unexpected renderer call');return map[name](...args);
    });
    const html=fs.readFileSync(path.join(__dirname,'../src/app.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
    await page.setContent(html);await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../src/app.css'),'utf8')});
    await page.evaluate(()=>{document.body.classList.add('sidebar-hidden','panel-hidden');window.$=id=>document.getElementById(id);window.call=(name,...args)=>window.__pcAuthCheck(name,args);window.muse=Object.fromEntries(['pcAuthState','pcAuthStart','pcAuthSend','pcAuthConfirm','pcAuthSelect','pcAuthTwoFactorSend','pcAuthTwoFactorConfirm','pcAuthCancel','pcConnect'].map(name=>[name,()=>{}]));});
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src/pc-setup-renderer.js'),'utf8')});
    await page.getByRole('button',{name:'PC接続の発行・設定',exact:true}).click();await page.locator('#pcSetupContact').waitFor();
    await page.locator('#pcSetupContact').fill('test@example.invalid');await page.getByRole('button',{name:'コードを送る',exact:true}).click();
    await page.locator('#pcSetupCode').fill('000000');await page.getByRole('button',{name:'確認する',exact:true}).click();
    await page.getByText('コードが違います。再入力してください。',{exact:true}).waitFor();assert(wrong);assert.equal(await page.locator('#pcSetupCode').inputValue(),'');
    await page.locator('#pcSetupCode').fill('123456');await page.getByRole('button',{name:'確認する',exact:true}).click();await page.getByRole('button',{name:'Test account',exact:true}).click();
    await page.getByRole('button',{name:'認証アプリ',exact:true}).click();await page.locator('#pcSetupTwoFactorCode').fill('654321');await page.getByRole('button',{name:'確認する',exact:true}).click();
    await page.getByRole('button',{name:'PCを接続',exact:true}).click();await page.getByText('このPCの認証が完了しました。',{exact:true}).first().waitFor();
    assert.equal(connects,1);assert.equal(unexpectedSends,0);assert.equal(await page.locator('#pcSetupDialog input').count(),0);
    const text=await page.locator('#pcSetupDialog').innerText();assert.equal(/synthetic-|mgst_|123456|654321|test@example/.test(text),false);
    await page.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await page.locator('#pcSetupDialog').evaluate(d=>d.open),false);
    await page.locator('#tools').click();await page.getByRole('button',{name:'PCを接続',exact:true}).waitFor();
    assert.equal(await page.locator('#pcSetupDialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({offline:true,embeddedDialog:true,otpRetry:true,accountSelection:true,totp:true,tokenReused:true,secretsExcluded:true,compactLayout:true,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
