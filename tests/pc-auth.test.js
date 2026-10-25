'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {PcAuth}=require('../src/pc-auth');
function setup(request,saved={sdkToken:'mgst_synthetic',nodeId:'homelink-123456'}) {
  let stored=structuredClone(saved);const calls=[];
  const auth=new PcAuth({load:()=>stored,save:v=>{stored=structuredClone(v);},request:async(...args)=>{calls.push(args);return request(...args);},expectedVm:async()=>'expected-vm',listSdk:async()=>({tokens:[],maxActiveTokens:1}),issueSdk:async()=>({token:'mgst_created',sdkToken:{id:'sdk-id'}})});
  return {auth,calls,stored:()=>stored};
}
test('native OTP -> complete device pair -> same-account VM; snapshot never contains credentials',async()=>{
  const {auth,calls,stored}=setup(async(_scope,route,body)=>{
    if(route.endsWith('/start'))return {access_token:'temporary-secret'};
    if(route.endsWith('/login_options'))return {};
    if(route.endsWith('/send_otp')){assert.equal('region' in body,false);return {auth_state:'opaque-auth-state'};}
    if(route.endsWith('/confirm_otp'))return {abra_access_token:'user-secret',abra_user_id:'user-id'};
    if(route.endsWith('/mint'))return {payload:{access_token:'device-secret',refresh_token:'refresh-secret'}};
    if(route==='/fetch_vms')return {vm_list:[{vm_id:'expected-vm',vm_auth_token:'vm-secret'}]};
    throw new Error('Unexpected request');
  });
  await auth.start();assert.equal((await auth.send('test@example.invalid')).phase,'code');
  const state=await auth.confirm('123456');assert.equal(state.phase,'authenticated');
  assert.equal(calls.filter(c=>c[1].endsWith('/mint')).length,1);
  assert.equal(stored().device.access_token,'device-secret');
  for(const value of ['temporary-secret','user-secret','device-secret','refresh-secret','vm-secret','opaque-auth-state','123456','test@example.invalid'])assert.equal(JSON.stringify(state).includes(value),false);
  assert.equal('session' in stored(),false);assert.equal(auth.login,null);assert.equal(auth.pending,null);
});
test('account selection and two-factor challenges take precedence over returned tokens',async()=>{
  const {auth,calls}=setup(async(_scope,route)=>{
    if(route.endsWith('/start'))return {access_token:'temporary'};
    if(route.endsWith('/login_options'))return {};
    if(route.endsWith('/send_otp'))return {auth_state:'state'};
    if(route.endsWith('/confirm_otp'))return {account_selection_required:true,selection_state:'selection-secret',accounts:[{account_ref:'account-secret',display_name:'Chosen account'}],abra_access_token:'premature-token',abra_user_id:'user'};
    if(route.endsWith('/select_account'))return {two_factor_required:true,two_factor_state:'twofactor-secret',two_factor_methods:[{method_id:'method-secret',display_name:'Authenticator'}]};
    if(route.endsWith('/send_code'))return {};
    throw new Error('Unexpected request');
  });
  await auth.send('test@example.invalid');const selected=await auth.confirm('123456');
  assert.equal(selected.phase,'account');assert.deepEqual(selected.accounts,[{label:'Chosen account'}]);assert.equal(JSON.stringify(selected).includes('account-secret'),false);
  await assert.rejects(auth.select(2),/選択/);assert.equal((await auth.select(0)).phase,'two_factor');
  const second=await auth.twoFactor(0);assert.equal(second.phase,'two_factor');assert.equal(JSON.stringify(second).includes('twofactor-secret'),false);
  assert.equal(calls.some(c=>c[1].endsWith('/mint')),false);
});
test('SDK creation requires consent, preserves an issued token across cancellation, and never silently retries an uncertain issuance',async()=>{
  const {auth,stored}=setup(async()=>{throw new Error('No native calls expected');},{});
  await assert.rejects(auth.start(),/規約/);await auth.start(true);assert.equal(stored().sdkToken,'mgst_created');
  auth.cancel();await auth.start();assert.equal(stored().sdkToken,'mgst_created');
  const pending=setup(async()=>({}),{sdkIssuePending:true});await assert.rejects(pending.auth.start(true),/再発行/);
});
test('cancelled in-flight OTP cannot resurrect dialog or retain temporary credentials',async()=>{
  let resolve;
  const {auth}=setup(async(_s,route)=>{
    if(route.endsWith('/start'))return {access_token:'temp'};
    if(route.endsWith('/login_options'))return {};
    if(route.endsWith('/send_otp'))return new Promise(r=>{resolve=r;});
  });
  const pending=auth.send('test@example.invalid');while(!resolve)await new Promise(r=>setImmediate(r));
  auth.cancel();resolve({auth_state:'secret'});await assert.rejects(pending,/閉じ/);
  assert.equal(auth.phase,'contact');assert.equal(auth.login,null);
});
test('device token refresh uses refresh bearer once; incomplete pair preserves stored credentials',async()=>{
  const original={sdkToken:'mgst_synthetic',nodeId:'homelink-123456',device:{access_token:'old-access',refresh_token:'hatch_refresh:old-refresh'}};
  const {auth,stored}=setup(async(_scope,route,_body,bearer)=>{
    if(route==='/fetch_vms')throw Object.assign(new Error('Expired'),{status:401});
    if(route.endsWith('/refresh')){assert.equal(bearer,'hatch_refresh:old-refresh');return {access_token:'incomplete'};}
  },original);
  await assert.rejects(auth.vm(),/変更していません/);assert.deepEqual(stored(),original);
});
test('VM mismatch prevents claiming authentication ready',async()=>{
  const {auth}=setup(async()=>({vm_list:[{vm_id:'other-vm',vm_auth_token:'other-secret'}]}),{sdkToken:'mgst_synthetic',device:{access_token:'device-secret',refresh_token:'refresh-secret'}});
  await assert.rejects(auth.start(),/一致/);assert.notEqual(auth.snapshot().phase,'ready');
});
