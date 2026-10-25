'use strict';
// Microphone button in the composer, like muse.ai web: 16 kHz mono PCM goes to the main process,
// which streams it to Meta's speech recognition; partial and final text land in the message box.
(function(){
  const byId=id=>document.getElementById(id);
  const button=byId('mic'),prompt=byId('prompt');
  let active=null;
  function setPressed(on){button.setAttribute('aria-pressed',String(on));button.title=on?'音声入力を止める':'音声入力';button.setAttribute('aria-label',button.title);}
  function render(s){
    const spoken=s.finals+s.partial;
    const gap=s.base&&spoken&&!/\s$/.test(s.base)?' ':'';
    prompt.value=s.base+gap+spoken;
    prompt.dispatchEvent(new Event('input',{bubbles:true}));
    if(typeof controls==='function')controls();
  }
  async function start(){
    let stream;
    try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});}
    catch{notice('マイクを使えませんでした。Windows のマイクの設定（プライバシー）を確認してください。');return;}
    const r=await window.muse.dictationStart();
    if(!r.ok){stream.getTracks().forEach(t=>t.stop());notice(r.error);return;}
    const ctx=new AudioContext({sampleRate:16000}),source=ctx.createMediaStreamSource(stream),proc=ctx.createScriptProcessor(4096,1,1),mute=ctx.createGain();
    mute.gain.value=0;
    const s={id:r.value.id,base:prompt.value,finals:'',partial:'',stopping:false};
    proc.onaudioprocess=e=>{
      if(s.stopping)return;
      const f=e.inputBuffer.getChannelData(0),pcm=new Int16Array(f.length);
      for(let i=0;i<f.length;i++){const v=Math.max(-1,Math.min(1,f[i]));pcm[i]=v<0?v*32768:v*32767;}
      window.muse.dictationAudio(s.id,pcm.buffer).catch(()=>{});
    };
    source.connect(proc);proc.connect(mute);mute.connect(ctx.destination);
    s.release=()=>{proc.onaudioprocess=null;try{proc.disconnect();source.disconnect();mute.disconnect();}catch{}ctx.close().catch(()=>{});stream.getTracks().forEach(t=>t.stop());};
    s.limit=setTimeout(stop,120000);
    active=s;setPressed(true);prompt.focus();
  }
  // Stop listening; the last words may still arrive until the server closes the stream.
  function stop(){
    const s=active;if(!s||s.stopping)return;
    s.stopping=true;clearTimeout(s.limit);s.release();setPressed(false);
    window.muse.dictationStop(s.id).catch(()=>{});
  }
  window.muse.onEvent(v=>{
    if(v.type!=='dictation'||!active||v.id!==active.id)return;
    const s=active;
    if(v.kind==='partial'){s.partial=v.text;render(s);}
    else if(v.kind==='final'){s.finals+=v.text;s.partial='';render(s);}
    else if(v.kind==='error'){notice(v.message);stop();}
    else if(v.kind==='closed'){if(!s.stopping){s.stopping=true;clearTimeout(s.limit);s.release();setPressed(false);}s.partial='';render(s);active=null;}
  });
  button.addEventListener('click',()=>{if(active&&!active.stopping)stop();else if(!active)start().catch(e=>notice(e.message));});
  window.addEventListener('beforeunload',stop);
})();
