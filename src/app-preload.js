'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('muse',Object.freeze({
  info:()=>ipcRenderer.invoke('muse:info'),
  connect:()=>ipcRenderer.invoke('muse:connect'),
  login:()=>ipcRenderer.invoke('muse:login'),
  importCapture:()=>ipcRenderer.invoke('muse:import'),
  sessions:()=>ipcRenderer.invoke('muse:sessions'),
  subscribe:id=>ipcRenderer.invoke('muse:subscribe',id),
  history:(id,before)=>ipcRenderer.invoke('muse:history',id,before),
  send:(text,id)=>ipcRenderer.invoke('muse:send',text,id),
  cancel:id=>ipcRenderer.invoke('muse:cancel',id),
  startSession:()=>ipcRenderer.invoke('muse:new-session'),
  approvals:()=>ipcRenderer.invoke('muse:approvals'),
  decide:(id,decision)=>ipcRenderer.invoke('muse:decide',id,decision),
  identity:()=>ipcRenderer.invoke('muse:identity'),
  avatar:imagePath=>ipcRenderer.invoke('muse:avatar',imagePath),
  themes:()=>ipcRenderer.invoke('muse:themes'),
  activity:()=>ipcRenderer.invoke('muse:activity'),
  openTools:()=>ipcRenderer.invoke('muse:tools'),
  openLink:url=>ipcRenderer.invoke('muse:open-link',url),
  renderMarkdown:text=>ipcRenderer.invoke('muse:markdown',text),
  onEvent:callback=>{const listener=(_,value)=>callback(value);ipcRenderer.on('muse:event',listener);return()=>ipcRenderer.removeListener('muse:event',listener);},
}));
