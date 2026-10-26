'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const CHUNK=65536;
const COMMANDS={
  'system.run':{description:'Run a command on this Windows PC using cmd.exe. Use Windows commands and paths. Returns stdout, stderr and exit code.',required:{command:{type:'string',description:'Windows shell command.'}},optional:{cwd:{type:'string',description:'Working directory; defaults to the PC workspace.'},timeout_ms:{type:'integer',description:'Timeout in milliseconds, default 120000, max 600000.'}},timeout_ms:605000},
  'file.read':{description:'Read a local Windows file in chunks up to 64 KiB. Bytes are base64 encoded. Continue using next_offset until eof.',required:{path:{type:'string',description:'Windows file path.'}},optional:{offset:{type:'integer',description:'Byte offset, default 0.'},limit:{type:'integer',description:'Bytes to read, up to 65536.'}}},
  'file.write':{description:'Write a local file in base64 chunks up to 64 KiB. Start at offset 0, send chunks in order, set final=true on the last chunk. Replaces destination atomically.',required:{path:{type:'string',description:'Windows destination path.'},data_b64:{type:'string',description:'This chunk, base64 encoded.'}},optional:{offset:{type:'integer',description:'Byte offset, default 0.'},final:{type:'boolean',description:'Commit the final chunk; default false.'},sha256:{type:'string',description:'Expected SHA-256 of the complete file.'},create_parents:{type:'boolean',description:'Create missing parent directories.'},overwrite:{type:'boolean',description:'Replace existing file; default true.'}}},
  'device.health':{description:'Status of this Windows PC: hostname, platform, memory and uptime.',required:{},optional:{}},
  // kaguya's 3D desktop body (kaguya-companion, local control API on 127.0.0.1:38741).
  'companion.act':{description:"Move your 3D desktop body (the companion window on this PC). action and its JSON: emote {name: happy|shy|sleepy|surprised|wave|laugh|giggle|love (heart eyes)|sparkle (star eyes)|pout|angry|sad|cry|smug|stare|flustered|blush|wink|tehe (tongue out)|shock|confused|thinking|exhausted|yawn|relieved|nod|shake}; say {text} (speech bubble, mouth moves); point {x,y (desktop pixels), say?, move? (walk next to it), hold? (s), returnHome?}; face {preset: smile|happy|shy|surprised|sleepy, or the face of any emote above but wave/shake (held)|null (clean expressions; prefer these), morphs:{blendshape:0..1}, look:{x,y}|'cursor', mouth:'a'|'i'|'u'|'e'|'o'|null, duration} (eye-closing blendshapes like smile/joy look half-closed below 1: use 0 or 1); pose {bones:{head|neck|chest|spine|left/right+Shoulder|UpperArm|LowerArm|Hand:{x,y,z degrees}}, duration}; sequence {steps:[{face?,pose?,emote?,wait}]}; menu {path} (your VRChat expression menu); params {values:{name:value}} (e.g. GestureRight 0-7); clips {play|add|stop:[clip names]} or {clear:true}, or {pose: name, hold?: seconds} for a whole-body pose of your own (nyan, gau, heart, ehe, bisi, yubisasi, piece1..., see companion.info kind poses; your big cardigan sleeves can cover your face in hand-near-face poses); move {x,y}|{near:{x,y}}|{home:true}; autonomy {enabled?, chatter?}; reset {}. Use companion.info to look up names.",required:{action:{type:'string',description:'emote, say, point, face, pose, sequence, menu, params, clips, move, autonomy or reset.'}},optional:{json:{type:'string',description:'The action\'s JSON object, e.g. {"text":"おかえり"}.'}},timeout_ms:15000},
  'companion.info':{description:'Look at your 3D desktop body: kind summary (bones, mouths, emotes, counts, screen and window bounds), morphs, menu, clips, parameters, poses or screen; query filters names (substring), limit caps the list (default 80).',required:{},optional:{kind:{type:'string',description:'summary, morphs, menu, clips, parameters, poses or screen; default summary.'},query:{type:'string',description:'Substring to filter names.'},limit:{type:'integer',description:'Max names, default 80, max 500.'}},timeout_ms:15000},
};
const COMPANION='http://127.0.0.1:38741';
const COMPANION_ACTIONS=new Set(['emote','say','point','face','pose','sequence','menu','params','clips','move','autonomy','reset']);
async function companionRequest(route,body){
  const r=await fetch(COMPANION+route,body===undefined?{signal:AbortSignal.timeout(10000)}:{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
    .catch(()=>{throw new Error('The companion (3D body) is not running on this PC.');});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.ok===false)throw new Error(data.error||'companion error '+r.status);
  return data;
}
async function companionCommand(command,params){
  if(command==='companion.act'){
    const action=String(params.action||'');
    if(!COMPANION_ACTIONS.has(action))throw new Error('Unknown companion action: '+action);
    let body={};
    if(params.json!==undefined){if(typeof params.json!=='string'||params.json.length>64000)throw new Error('json must be a JSON object string');try{body=JSON.parse(params.json||'{}');}catch{throw new Error('json is not valid JSON');}}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('json must be a JSON object');
    const result=action==='emote'?await companionRequest('/emote/'+encodeURIComponent(String(body.name||'happy'))):await companionRequest('/'+action,body);
    return {ok:true,payload:result};
  }
  const kind=String(params.kind||'summary'),query=String(params.query||'').toLowerCase();
  const limit=Math.max(1,Math.min(500,Number.isSafeInteger(params.limit)?params.limit:80));
  if(kind==='screen')return {ok:true,payload:await companionRequest('/screen')};
  const info=await companionRequest('/avatar');
  if(kind==='summary'){const screen=await companionRequest('/screen').catch(()=>null);return {ok:true,payload:{bones:info.bones,mouths:info.mouths,emotes:info.emotes,poses:info.poses,counts:{morphs:info.morphs?.length||0,menu:info.menu?.length||0,clips:info.clips?.length||0,parameters:info.parameters?.length||0},screen}};}
  const lists={morphs:info.morphs,clips:info.clips,parameters:info.parameters,poses:info.poses,menu:(info.menu||[]).map(m=>m.path)};
  if(!lists[kind])throw new Error('kind must be summary, morphs, menu, clips, parameters, poses or screen');
  const all=(lists[kind]||[]).filter(n=>!query||String(n).toLowerCase().includes(query));
  return {ok:true,payload:{kind,total:all.length,names:all.slice(0,limit)}};
}
function createNativeExecutor({workspace,run}) {
  const writes=new Map();
  const target=value=>{if(typeof value!=='string'||!value||value.length>4096||value.includes('\0'))throw new Error('Invalid Windows path');return path.resolve(workspace(),value);};
  const integer=(value,fallback,min,max)=>{const result=value===undefined?fallback:value;if(!Number.isSafeInteger(result)||result<min||result>max)throw new Error('Invalid byte offset, size or timeout');return result;};
  function discard(destination) {const write=writes.get(destination);if(!write)return;writes.delete(destination);try{fs.unlinkSync(write.temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
  function dispose() {for(const destination of [...writes.keys()])discard(destination);}
  async function execute(command,params={},timeoutMs,id) {
    try{
      if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('Invalid command parameters');
      if(command==='system.run'){
        if(typeof params.command!=='string'||!params.command.trim()||params.command.length>32000)throw new Error('A Windows command is required');
        const timeout=integer(params.timeout_ms??timeoutMs,120000,1,600000);
        return await run({command:params.command,cwd:params.cwd?target(params.cwd):workspace(),timeout_ms:timeout},id);
      }
      if(command==='companion.act'||command==='companion.info')return await companionCommand(command,params);
      if(command==='device.health')return {ok:true,payload:{hostname:os.hostname(),platform:process.platform,uptime_s:os.uptime(),memory_total:os.totalmem(),memory_free:os.freemem(),workspace:workspace()}};
      if(command==='file.read'){
        const file=target(params.path),offset=integer(params.offset,0,0,Number.MAX_SAFE_INTEGER),limit=integer(params.limit,CHUNK,1,CHUNK);
        const fd=fs.openSync(file,'r');try{const stat=fs.fstatSync(fd);if(!stat.isFile())throw new Error('Not a regular file');const buffer=Buffer.alloc(limit);const size=fs.readSync(fd,buffer,0,limit,offset);return {ok:true,payload:{path:file,data_b64:buffer.subarray(0,size).toString('base64'),offset,next_offset:offset+size,eof:offset+size>=stat.size,size:stat.size}};}finally{fs.closeSync(fd);}
      }
      if(command==='file.write'){
        const file=target(params.path),offset=integer(params.offset,0,0,Number.MAX_SAFE_INTEGER);
        if(typeof params.data_b64!=='string'||params.data_b64.length>4*Math.ceil(CHUNK/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.data_b64))throw new Error('Invalid base64 chunk');
        const data=Buffer.from(params.data_b64,'base64');if(data.length>CHUNK)throw new Error('Chunk exceeds 65536 bytes');
        for(const key of ['final','create_parents','overwrite'])if(params[key]!==undefined&&typeof params[key]!=='boolean')throw new Error('Invalid '+key);
        if(params.sha256!==undefined&&(typeof params.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(params.sha256)))throw new Error('Invalid SHA-256');
        if(offset===0){
          if(writes.has(file))throw new Error('A write to this destination is already pending');
          if(writes.size>=4)throw new Error('Too many pending file writes');
          if(params.overwrite===false&&fs.existsSync(file))throw new Error('Destination already exists');
          if(params.create_parents)fs.mkdirSync(path.dirname(file),{recursive:true});
          const temporary=path.join(path.dirname(file),'.muse-write-'+crypto.randomUUID()+'.tmp');const fd=fs.openSync(temporary,'wx');fs.closeSync(fd);
          writes.set(file,{temporary,offset:0,overwrite:params.overwrite!==false,hash:crypto.createHash('sha256')});
        }
        const write=writes.get(file);if(!write||write.offset!==offset)throw new Error('Chunks must be written in order, starting at offset 0');
        try{
          fs.appendFileSync(write.temporary,data);write.hash.update(data);write.offset+=data.length;
          if(params.final){
            const digest=write.hash.digest('hex');if(params.sha256&&params.sha256.toLowerCase()!==digest)throw new Error('SHA-256 mismatch; original file preserved');
            if(write.overwrite)fs.renameSync(write.temporary,file);else {fs.linkSync(write.temporary,file);fs.unlinkSync(write.temporary);}
            writes.delete(file);return {ok:true,payload:{path:file,next_offset:write.offset,bytes_written:write.offset,complete:true,sha256:digest}};
          }
          return {ok:true,payload:{path:file,next_offset:write.offset,bytes_written:data.length,complete:false}};
        }catch(e){discard(file);throw e;}
      }
      throw new Error('Unsupported PC command');
    }catch(e){return {ok:false,error:e.message};}
  }
  return {execute,dispose,commands:COMMANDS};
}
module.exports={createNativeExecutor,COMMANDS};
