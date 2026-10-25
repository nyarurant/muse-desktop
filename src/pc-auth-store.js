'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
function createPcAuthStore({directory,safeStorage}) {
  const file=path.join(directory,'muse-device.enc');
  function save(value) {
    if(!safeStorage.isEncryptionAvailable())throw new Error('Windows の暗号化ストレージを利用できません。');
    const temporary=file+'.tmp';fs.writeFileSync(temporary,safeStorage.encryptString(JSON.stringify(value)));fs.renameSync(temporary,file);
  }
  function load() {
    if(fs.existsSync(file)){
      try{return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));}catch{throw new Error('保存済みの PC 認証情報を読み取れません。自動で再発行はしません。');}
    }
    const bootstrap=path.join(directory,'muse-direct-bootstrap.dpapi');
    if(process.platform!=='win32'||!fs.existsSync(bootstrap))return {};
    // Import the previously issued SDK token without exposing it to a renderer or command line.
    const script='Add-Type -AssemblyName System.Security; $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))';
    try{
      const output=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{input:fs.readFileSync(bootstrap).toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
      const value=JSON.parse(Buffer.from(output.trim(),'base64').toString('utf8'));if(!value.sdkToken)throw new Error('No SDK token');save(value);return value;
    }catch{throw new Error('発行済みの PC 認証情報を引き継げません。自動で再発行はしません。');}
  }
  return {load,save};
}
module.exports={createPcAuthStore};
