'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Cipher,NoiseXX,fields,first,bytes,uint}=require('../src/noise');
test('AES-GCM rejects tampering and poisons the cipher after failure',()=>{
  const key=Buffer.alloc(32,1),tx=new Cipher(key),rx=new Cipher(key);
  const encrypted=tx.encrypt(Buffer.alloc(0),Buffer.from('message'));encrypted[0]^=1;
  assert.throws(()=>rx.decrypt(Buffer.alloc(0),encrypted));assert.throws(()=>rx.decrypt(Buffer.alloc(0),encrypted));
});
test('protobuf parser rejects truncation and illegal wire fields',()=>{
  for(const b of [Buffer.from([10,5,1]),Buffer.from([0]),Buffer.from([15]),Buffer.from([8,128])])assert.throws(()=>fields(b));
  assert.equal(first(fields(uint(4,1)),4),1n);
});
test('handshake phases prevent accidental nonce or key reuse',()=>{
  const n=new NoiseXX();const m=n.message1();assert.equal(m.length,66);assert.throws(()=>n.message1());assert.throws(()=>n.message3());assert.throws(()=>n.message2(Buffer.alloc(95)));
  assert.equal(first(fields(m.subarray(32)),1).length,32);
});
