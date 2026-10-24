'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const WebSocket = require('ws');
const {NoiseXX,Transport,fields,first} = require('./noise');

function allowedGateway(value) {
  const u = new URL(value);
  if (!['wss:','https:'].includes(u.protocol) || u.username || u.password || u.port ||
      !(u.hostname === 'hatch.metaaivm.com' || /^[a-z0-9-]+\.metaaivm\.com$/.test(u.hostname))) {
    throw new Error('Muse の接続先を確認できません。');
  }
  return u;
}
function captureCredentials(file) {
  if (fs.statSync(file).size > 150*1024*1024) throw new Error('通信記録が大きすぎます。');
  const entries = JSON.parse(fs.readFileSync(file,'utf8')).log?.entries;
  if (!Array.isArray(entries)) throw new Error('HAR 形式の通信記録を選んでください。');
  const candidate = entries.findLast(e=>{
    try { const u=new URL(e.request.url); return u.protocol==='wss:' && u.pathname==='/v1/noise' && e.response?.status===101 && u.searchParams.has('auth_token'); } catch {return false;}
  });
  if (!candidate) throw new Error('接続に成功した Muse の通信が記録されていません。');
  const u=allowedGateway(candidate.request.url), q=u.searchParams;
  let session=null;
  const s=entries.findLast(e=>{try{return new URL(e.request.url).hostname==='muse.ai' && new URL(e.request.url).pathname==='/api/session' && e.response.status===200;}catch{return false;}});
  if(s) try { session=JSON.parse(s.response.content.text); } catch {}
  const credentials={gateway:'https://'+u.hostname,vmId:q.get('vm_id'),appId:q.get('app_id'),token:q.get('auth_token'),notaryToken:q.get('notary_token'),vmName:session?.vm_name,endpoint:session?.endpoint_url,importedAt:new Date().toISOString()};
  if(!credentials.vmId||!credentials.appId||!credentials.token) throw new Error('Muse の接続情報が不足しています。');
  return credentials;
}
function unwrap(value) {
  if(value?.ok===false || value?.status==='err' || value?.error) {
    // Gateway error text can contain request data; expose only a short code.
    const code=value?.error?.code||value?.code;
    throw new Error('Muse が操作を受け付けませんでした'+(typeof code==='string'?' ('+code.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)+')':'')+'。');
  }
  if(value?.ok===true && 'result' in value) return value.result;
  if(value?.type==='res' && value.status==='ok') return value.payload;
  return value;
}
class MuseClient extends EventEmitter {
  constructor({credentials,fetchJson,checkPin}) {
    super(); this.credentials=credentials; this.fetchJson=fetchJson; this.checkPin=checkPin;
    this.pending=new Map(); this.ws=null; this.transport=null; this.connecting=null; this.status='disconnected';
  }
  state(status,message) { this.status=status; this.emit('status',{status,message}); }
  async refreshCredentials() {
    if(!this.fetchJson) return;
    try {
      const session=await this.fetchJson('/api/session?vm_state=true');
      if(!session?.endpoint_url||!session.vm_id) return;
      allowedGateway(session.endpoint_url);
      const result=await this.fetchJson('/api/hatch/token',{vmAddress:session.endpoint_url,vmName:session.vm_name,force_refresh:true});
      if(!result?.token) return;
      this.credentials={gateway:'https://hatch.metaaivm.com',vmId:session.vm_id,vmName:session.vm_name,endpoint:session.endpoint_url,appId:this.credentials?.appId||'hatch-web',token:result.token,notaryToken:result.notary_token};
      this.emit('credentials',this.credentials);
    } catch { /* An imported session may work without website cookies. */ }
  }
  async connect() {
    if(this.status==='connected') return;
    if(this.connecting) return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;}); return this.connecting;
  }
  async open() {
    this.disconnect(false); this.state('connecting','Muse に接続しています…');
    await this.refreshCredentials();
    const c=this.credentials;
    if(!c?.token) { this.state('auth_required','ログインまたは通信記録の読み込みが必要です。'); throw new Error('Muse にログインしてください。'); }
    const target=allowedGateway(c.gateway); target.protocol='wss:';target.pathname='/v1/noise';target.search='';
    for(const [k,v] of Object.entries({vm_id:c.vmId,auth_token:c.token,notary_token:c.notaryToken,app_id:c.appId,request_id:crypto.randomUUID()})) if(v) target.searchParams.set(k,v);
    const ws=new WebSocket(target,{origin:'https://muse.ai',handshakeTimeout:15000,maxPayload:1024*1024}); this.ws=ws;
    const noise=new NoiseXX(); let established=false;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>fail(new Error('Muse への接続がタイムアウトしました。')),20000);
      const fail=e=>{clearTimeout(timeout);if(this.ws===ws){this.disconnect(false);this.state('error',e.message);}reject(e);};
      ws.on('open',()=>{try{ws.send(noise.message1());}catch{fail(new Error('暗号化接続を開始できませんでした。'));}});
      ws.on('unexpected-response',(_,res)=>fail(new Error(res.statusCode===401||res.statusCode===403?'Muse の認証が切れています。ログインし直してください。':'Muse に接続できませんでした (HTTP '+res.statusCode+')。')));
      ws.on('error',()=>{if(!established)fail(new Error('Muse の通信に失敗しました。接続情報を更新してください。'));});
      ws.on('message',data=>{
        if(this.ws!==ws) return;
        try {
          if(!established) {
            const payload=noise.message2(data);
            let f;try{f=fields(payload);}catch{}
            // Confidential VMs need owner recovery credentials and attestation.
            // Never silently fall back to the standard-VM handshake.
            if(f && [1n,2n].includes(first(f,2)) && first(f,3)?.length===32) throw new Error('この機密 VM は所有者キーによる認証が必要です。現在は標準 VM に対応しています。');
            const fingerprint=crypto.createHash('sha256').update(noise.remoteStatic).digest('hex');
            this.checkPin?.(c.vmId,fingerprint);
            const keys=noise.message3();this.transport=new Transport(keys.tx,keys.rx);ws.send(keys.message);
            established=true;clearTimeout(timeout);this.state('connected','接続済み');resolve();
          }else this.onFrame(this.transport.decode(data));
        }catch(e){if(!established)fail(e);else{this.disconnect(false);this.state('error','Muse の暗号化通信が中断されました。再接続してください。');}}
      });
      ws.on('close',()=>{
        if(this.ws!==ws)return;
        if(!established)fail(new Error('Muse との接続が閉じられました。'));
        else {this.disconnect(false);this.state('disconnected','接続が切れました。再接続してください。');}
      });
    });
  }
  request(verb,path,params={},options={}) {
    if(this.status!=='connected'||!this.transport) return Promise.reject(new Error('Muse に接続してください。'));
    if(this.pending.size>=64) return Promise.reject(new Error('処理中の操作が多すぎます。'));
    let body=Buffer.alloc(0);
    if(verb==='GET') {const q=new URLSearchParams();for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null)q.set(k,String(v));if(q.size)path+='?'+q;}
    else body=Buffer.from(JSON.stringify(params));
    const r=this.transport.request(verb,path,body,[['x-app-id',this.credentials.appId],['Content-Type','application/json'],['Accept-Encoding','identity']],options.service||0);
    return new Promise((resolve,reject)=>{
      const pending={resolve,reject,path,status:0,chunks:[],size:0,text:'',decoder:new TextDecoder(),onEvent:options.onEvent,stream:!!options.stream,settled:false};
      pending.timer=setTimeout(()=>{this.cancelRequest(r.id);reject(new Error('Muse の応答がタイムアウトしました。送信済みの可能性があるため、自動再送はしません。'));},options.timeout||30000);
      this.pending.set(r.id.toString(),pending);
      try { for(const frame of r.frames)this.ws.send(frame); } catch {this.cancelRequest(r.id);reject(new Error('送信中に通信が切れました。'));}
    });
  }
  cancelRequest(id) {
    const p=this.pending.get(String(id));if(p){clearTimeout(p.timer);this.pending.delete(String(id));}
    if(this.transport&&this.ws?.readyState===WebSocket.OPEN)for(const f of this.transport.reset(BigInt(id)))this.ws.send(f);
  }
  record(p,value) {
    if(value?.type==='event'||(typeof value?.event==='string'&&value.payload)) {
      if(!p.settled){p.settled=true;clearTimeout(p.timer);p.resolve({});}
      p.onEvent?.(value); this.emit('event',value);return;
    }
    const result=unwrap(value);
    if(!p.settled){p.settled=true;clearTimeout(p.timer);p.resolve(result);}
  }
  onFrame(f) {
    if(!f)return;const key=f.id.toString(),p=this.pending.get(key);if(!p)return;
    try {
      if(f.type==='reset')throw new Error('Muse がこの操作の通信を終了しました。');
      if(f.type==='response') {
        p.status=f.status;
        const type=f.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1]||'';
        p.ndjson=p.stream||type.includes('ndjson');
        if(f.headers.some(([k,v])=>k.toLowerCase()==='content-encoding'&&!['identity',''].includes(v)))throw new Error('Muse が未対応の圧縮形式を返しました。');
      }
      if(f.body?.length) {
        p.size+=f.body.length;
        if(p.size>16*1024*1024)throw new Error('Muse の応答が大きすぎます。');
        if(p.ndjson&&p.status>=200&&p.status<300) {
          p.text+=p.decoder.decode(f.body,{stream:true});
          const lines=p.text.split('\n');p.text=lines.pop();for(const line of lines)if(line.trim())this.record(p,JSON.parse(line));
          // A streaming subscription can live indefinitely; bound each record.
          if(p.text.length>2*1024*1024)throw new Error('Muse の通知が大きすぎます。');p.size=0;
        }else p.chunks.push(f.body);
      }
      if(f.end) {
        if(p.ndjson&&p.status>=200&&p.status<300){p.text+=p.decoder.decode();if(p.text.trim())this.record(p,JSON.parse(p.text));if(!p.settled){p.settled=true;p.resolve({});}}
        else {
          if(p.status<200||p.status>=300)throw new Error('Muse API がエラーを返しました (HTTP '+p.status+')。');
          const text=Buffer.concat(p.chunks).toString('utf8');const value=text?unwrap(JSON.parse(text)):{};p.settled=true;p.resolve(value);
        }
        clearTimeout(p.timer);this.pending.delete(key);
        if(p.stream)this.emit('stream-end');
      }
    }catch(e){clearTimeout(p.timer);this.pending.delete(key);p.reject(e);if(p.settled)this.emit('stream-error',e.message);}
  }
  disconnect(announce=true) {
    const ws=this.ws;this.ws=null;if(ws){ws.on('error',()=>{});if(ws.readyState===WebSocket.CONNECTING)ws.terminate();else ws.close();}
    this.transport?.destroy();this.transport=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Muse の接続が終了しました。'));}this.pending.clear();
    this.status='disconnected';if(announce)this.state('disconnected','未接続');
  }
  sessions() {return this.request('GET','/api/session/list',{limit:100});}
  history(sessionId='',before) {return this.request('GET','/chat/history',{limit:50,session_id:sessionId,...before!==undefined?{before_seq:before}:{}});}
  subscribe(sessionId='') {
    for(const [id,p]of this.pending)if(p.path==='/chat/subscribe')this.cancelRequest(id);
    return this.request('POST','/chat/subscribe',{...(sessionId?{session_id:sessionId}:{}),capabilities:['chat_cancel','delta_stream']},{stream:true});
  }
  send(text,sessionId,nodeId) {return this.request('POST','/chat/stream',{message:text,node_id:nodeId,...sessionId?{session_id:sessionId}:{},capabilities:['chat_cancel','delta_stream']},{stream:true});}
  cancel(sessionId) {return this.request('POST','/chat/cancel',{...(sessionId?{session_id:sessionId}:{})});}
}
module.exports={MuseClient,captureCredentials,allowedGateway,unwrap};
