'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Preload exists only in the app-owned local tools window, never muse.ai.
contextBridge.exposeInMainWorld('workspaceAPI', Object.freeze({
  info: () => ipcRenderer.invoke('tools:get-info'),
  chooseFolder: () => ipcRenderer.invoke('tools:select-workspace'),
  run: (command) => ipcRenderer.invoke('tools:run', command),
  runWorkflow: () => ipcRenderer.invoke('tools:run-workflow'),
  stop: () => ipcRenderer.invoke('tools:stop'),
  agentStart: (task) => ipcRenderer.invoke('tools:agent-start', task),
  agentStop: () => ipcRenderer.invoke('tools:agent-stop'),
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
  onAgentStatus: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on('tools:agent-status', listener);
    return () => ipcRenderer.removeListener('tools:agent-status', listener);
  },
  onWorkflowStatus: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on('tools:workflow-status', listener);
    return () => ipcRenderer.removeListener('tools:workflow-status', listener);
  },
}));
