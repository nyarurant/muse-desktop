'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Preload exists only in the app-owned local tools window, never muse.ai.
contextBridge.exposeInMainWorld('workspaceAPI', Object.freeze({
  info: () => ipcRenderer.invoke('tools:get-info'),
  chooseFolder: () => ipcRenderer.invoke('tools:select-workspace'),
  setApprovalMode: (mode) => ipcRenderer.invoke('tools:set-approval-mode', mode),
  run: (command) => ipcRenderer.invoke('tools:run', command),
  runWorkflow: () => ipcRenderer.invoke('tools:run-workflow'),
  stop: () => ipcRenderer.invoke('tools:stop'),
  onOutput: (callback) => {
    const listener = (_, output) => callback(output);
    ipcRenderer.on('tools:output', listener);
    return () => ipcRenderer.removeListener('tools:output', listener);
  },
  onStatus: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('tools:status', listener);
    return () => ipcRenderer.removeListener('tools:status', listener);
  },
  onApprovalState: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on('tools:approval-state', listener);
    return () => ipcRenderer.removeListener('tools:approval-state', listener);
  },
  onWorkflowStatus: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on('tools:workflow-status', listener);
    return () => ipcRenderer.removeListener('tools:workflow-status', listener);
  },
}));
