'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const CHUNK=65536;
const COMMANDS={
  'system.run':{description:'Run a command on this Windows PC using cmd.exe. Use Windows commands and paths. Returns stdout, stderr and exit code.',required:{command:{type:'string',description:'Windows shell command.'}},optional:{cwd:{type:'string',description:'Working directory; defaults to the PC workspace.'},timeout_ms:{type:'integer',description:'Timeout in milliseconds, default 120000, max 600000.'}},timeout_ms:605000},
  'file.read':{description:'Read a local Windows file in chunks up to 64 KiB. Bytes are base64 encoded. Continue using next_offset until eof.',required:{path:{type:'string',description:'Windows file path.'}},optional:{offset:{type:'integer',description:'Byte offset, default 0.'},limit:{type:'integer',description:'Bytes to read, up to 65536.'}}},
  'file.write':{description:'Write a local file in base64 chunks up to 64 KiB. Start at offset 0, send chunks in order, set final=true on the last chunk. Replaces destination atomically.',required:{path:{type:'string',description:'Windows destination path.'},data_b64:{type:'string',description:'This chunk, base64 encoded.'}},optional:{offset:{type:'integer',description:'Byte offset, default 0.'},final:{type:'boolean',description:'Commit the final chunk; default false.'},sha256:{type:'string',description:'Expected SHA-256 of the complete file.'},create_parents:{type:'boolean',description:'Create missing parent directories.'},overwrite:{type:'boolean',description:'Replace existing file; default true.'}}},
  'device.health':{description:'Status of this Windows PC: hostname, platform, memory and uptime.',required:{},optional:{}},
};
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
