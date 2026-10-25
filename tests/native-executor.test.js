'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {createNativeExecutor}=require('../src/native-executor');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-native-test-'));const executor=createNativeExecutor({workspace:()=>dir,run:async()=>({ok:true,payload:{stdout:'test'}})});t.after(()=>{executor.dispose();fs.rmSync(dir,{recursive:true,force:true});});return {dir,executor};}
test('real chunked file transfer remains atomic and reads exact bytes back',async t=>{
 const {dir,executor}=fixture(t),file=path.join(dir,'marker.bin');fs.writeFileSync(file,'original');
 const content=crypto.randomBytes(70000),digest=crypto.createHash('sha256').update(content).digest('hex');
 assert.equal((await executor.execute('file.write',{path:file,data_b64:content.subarray(0,65536).toString('base64')})).ok,true);
 assert.equal(fs.readFileSync(file,'utf8'),'original');
 const committed=await executor.execute('file.write',{path:file,data_b64:content.subarray(65536).toString('base64'),offset:65536,final:true,sha256:digest});assert.equal(committed.ok,true);assert.deepEqual(fs.readFileSync(file),content);
 const a=await executor.execute('file.read',{path:file}),b=await executor.execute('file.read',{path:file,offset:a.payload.next_offset});
 assert.equal(a.payload.eof,false);assert.equal(b.payload.eof,true);assert.deepEqual(Buffer.concat([Buffer.from(a.payload.data_b64,'base64'),Buffer.from(b.payload.data_b64,'base64')]),content);
});
test('SHA mismatch and malformed or out-of-order chunks preserve original file',async t=>{
 const {dir,executor}=fixture(t),file=path.join(dir,'marker.txt');fs.writeFileSync(file,'original');
 assert.equal((await executor.execute('file.write',{path:file,data_b64:'bad base64',final:true})).ok,false);
 assert.equal((await executor.execute('file.write',{path:file,data_b64:'eA==',offset:3,final:true})).ok,false);
 assert.equal((await executor.execute('file.write',{path:file,data_b64:'eA==',final:true,sha256:'0'.repeat(64)})).ok,false);
 assert.equal(fs.readFileSync(file,'utf8'),'original');assert.deepEqual(fs.readdirSync(dir),['marker.txt']);
});
test('no-overwrite commit refuses a destination created while chunks were pending',async t=>{
 const {dir,executor}=fixture(t),file=path.join(dir,'marker.txt');
 await executor.execute('file.write',{path:file,data_b64:'eA==',overwrite:false});fs.writeFileSync(file,'external');
 const result=await executor.execute('file.write',{path:file,data_b64:'eQ==',offset:1,final:true});assert.equal(result.ok,false);assert.equal(fs.readFileSync(file,'utf8'),'external');
});
test('cancel discards only its staged file; original data and other files survive',async t=>{
 const {dir,executor}=fixture(t),file=path.join(dir,'marker.txt');fs.writeFileSync(file,'original');
 await executor.execute('file.write',{path:file,data_b64:'eA=='});executor.dispose();assert.deepEqual(fs.readdirSync(dir),['marker.txt']);assert.equal(fs.readFileSync(file,'utf8'),'original');
});
