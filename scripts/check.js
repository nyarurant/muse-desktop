'use strict';
const {spawnSync}=require('node:child_process');
const {readdirSync}=require('node:fs');
for(const dir of ['src','scripts','tests'])for(const f of readdirSync(dir))if(f.endsWith('.js')){
  const r=spawnSync(process.execPath,['--check',dir+'/'+f],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
}
console.log('JavaScript syntax OK');
