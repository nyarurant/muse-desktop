'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { resolveToolPath } = require('./local-agent');
const { createPrefs, fitToDisplays, isMuseUrl } = require('./prefs');
const {
  app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, screen, shell,
} = require('electron');

app.setName('Muse App');
app.setPath('userData', path.join(app.getPath('appData'), 'Muse App'));
const { setupDesktop } = require('./desktop-api');
const MUSE_URL = 'https://muse.ai/';
const TOGGLE_SHORTCUT = 'Alt+Shift+Space';
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const toolsUrl = pathToFileURL(path.join(__dirname, 'tools.html')).href;
const iconPath = path.join(__dirname, 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');
let museWindow = null;
let toolsWindow = null;
let desktop = null;
let tray = null;
let prefs = null;
let quitting = false;
let shortcutRegistered = false;
let pendingMaximize = false;
let workspace = path.join(os.homedir(), 'MuseDesktopWorkspace');
let active = null;
let workflowRunning = false;
let stopWorkflow = false;

function assertToolsSender(event) {
  if (!toolsWindow || toolsWindow.isDestroyed() ||
      event.sender !== toolsWindow.webContents ||
      event.senderFrame !== toolsWindow.webContents.mainFrame ||
      event.senderFrame.url !== toolsUrl) {
    throw new Error('Trusted local tools window only');
  }
}
function sendTools(channel, data) {
  if (toolsWindow && !toolsWindow.isDestroyed()) {
    toolsWindow.webContents.send(channel, data);
  }
}

function showMuse() {
  if (!museWindow || museWindow.isDestroyed()) { openMuse(); return; }
  if (museWindow.isMinimized()) museWindow.restore();
  museWindow.show();
  // maximize() would also show a hidden window, so it is deferred to the first show.
  if (pendingMaximize) { pendingMaximize = false; museWindow.maximize(); }
  museWindow.focus();
}
function toggleMuse() {
  if (museWindow && !museWindow.isDestroyed() && museWindow.isVisible() && museWindow.isFocused()) museWindow.hide();
  else showMuse();
}
function rememberWindowState() {
  // A hidden window (tray / not yet shown) reports misleading geometry; keep the last saved state.
  if (!museWindow || museWindow.isDestroyed() || !museWindow.isVisible()) return;
  const maximized = museWindow.isMaximized();
  const patch = {maximized};
  if (!maximized && !museWindow.isMinimized() && !museWindow.isFullScreen()) patch.bounds = museWindow.getBounds();
  prefs.set(patch);
}
function openMuse({show = true} = {}) {
  if (museWindow && !museWindow.isDestroyed()) { if (show) showMuse(); return; }
  const saved = prefs.get();
  const bounds = fitToDisplays(saved.bounds, screen.getAllDisplays().map(d => d.workArea));
  museWindow = new BrowserWindow({
    title: 'Muse',
    width: 1250, height: 850, minWidth: 480, minHeight: 400,
    ...(bounds || {}),
    show: false,
    icon: iconPath,
    backgroundColor: '#181819',
    autoHideMenuBar: true, // Alt shows the menu.
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'app-preload.js'),
    },
  });
  museWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  museWindow.webContents.on('will-navigate', event => event.preventDefault());
  museWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  pendingMaximize = saved.maximized;
  museWindow.once('ready-to-show', () => { if (show) showMuse(); });
  const contents = museWindow.webContents;
  contents.on('did-finish-load', () => contents.setZoomFactor(prefs.get().zoomFactor));
  contents.on('zoom-changed', (_, direction) => {
    const next = Math.round((contents.getZoomFactor() + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10;
    contents.setZoomFactor(Math.min(3, Math.max(0.5, next)));
    prefs.set({zoomFactor: contents.getZoomFactor()});
  });
  const rememberUrl = (_, url) => { if (isMuseUrl(url)) prefs.set({lastUrl: url}); };
  contents.on('did-navigate', rememberUrl);
  contents.on('did-navigate-in-page', rememberUrl);
  contents.on('did-fail-load', (_, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
    museWindow?.setTitle(`Muse — 読み込みに失敗しました (${description}) — Ctrl+R で再読み込み`);
  });
  for (const name of ['resize', 'move', 'maximize', 'unmaximize']) museWindow.on(name, rememberWindowState);
  museWindow.on('close', (event) => {
    rememberWindowState();
    if (!quitting && prefs.get().closeToTray && tray) { event.preventDefault(); museWindow.hide(); }
  });
  museWindow.loadFile(path.join(__dirname, 'app.html'));
  museWindow.on('closed', () => { museWindow = null; });
}
function navigate(action) {
  const contents = museWindow && !museWindow.isDestroyed() ? museWindow.webContents : null;
  if (!contents) return;
  const history = contents.navigationHistory;
  if (action === 'back' && history.canGoBack()) history.goBack();
  if (action === 'forward' && history.canGoForward()) history.goForward();
  if (action === 'home') contents.send('muse:event', {type: 'home'});
}
function setZoom(delta) {
  if (!museWindow || museWindow.isDestroyed()) return;
  const contents = museWindow.webContents;
  const next = delta === 0 ? 1 : Math.round((contents.getZoomFactor() + delta) * 10) / 10;
  contents.setZoomFactor(Math.min(3, Math.max(0.5, next)));
  prefs.set({zoomFactor: contents.getZoomFactor()});
}
function openAtLogin() {
  return app.getLoginItemSettings({args: ['--hidden']}).openAtLogin;
}
function setOpenAtLogin(enabled) {
  app.setLoginItemSettings({openAtLogin: enabled, args: ['--hidden']});
}
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {label: 'Muse を開く', click: showMuse},
    {label: 'Local Workspace / Shell', click: openTools},
    {type: 'separator'},
    {label: '閉じるボタンでトレイに常駐', type: 'checkbox', checked: prefs.get().closeToTray,
      click: (item) => prefs.set({closeToTray: item.checked})},
    {label: 'Windows 起動時に開始', type: 'checkbox', checked: openAtLogin(),
      visible: process.platform !== 'linux', click: (item) => setOpenAtLogin(item.checked)},
    {type: 'separator'},
    {label: '終了', click: () => { quitting = true; app.quit(); }},
  ]);
}
function createTray() {
  const image = nativeImage.createFromPath(iconPath).resize({width: 16, height: 16, quality: 'best'});
  tray = new Tray(image);
  tray.setToolTip(shortcutRegistered ? `Muse（${TOGGLE_SHORTCUT} で表示/非表示）` : 'Muse');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleMuse);
}
function openTools() {
  if (toolsWindow && !toolsWindow.isDestroyed()) { toolsWindow.show(); toolsWindow.focus(); return; }
  toolsWindow = new BrowserWindow({
    title: 'Muse Desktop Community — Local Workspace',
    width: 940, height: 820, minWidth: 650, minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webviewTag: false,
    },
  });
  toolsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toolsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  toolsWindow.loadFile(path.join(__dirname, 'tools.html'));
  toolsWindow.on('closed', () => { toolsWindow = null; });
}
function setMenu() {
  const template = [
    {label: 'Muse', submenu: [
      {label: 'Muse を開く', click: showMuse},
      {label: 'ホーム', accelerator: 'Alt+Home', click: () => navigate('home')},
      {label: 'muse.ai をブラウザで開く', click: () => shell.openExternal(MUSE_URL)},
      {label: 'Local Workspace / Shell', accelerator: 'CmdOrCtrl+Shift+T', click: openTools},
      {type: 'separator'},
      {label: 'ウィンドウを閉じる', accelerator: 'CmdOrCtrl+W', role: 'close'},
      {label: '終了', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); }},
    ]},
    {label: 'Edit', submenu: [
      {role: 'undo'}, {role: 'redo'}, {type: 'separator'},
      {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'},
    ]},
    {label: 'View', submenu: [
      {label: '戻る', accelerator: 'Alt+Left', click: () => navigate('back')},
      {label: '進む', accelerator: 'Alt+Right', click: () => navigate('forward')},
      {role: 'reload'}, {role: 'forceReload'}, {type: 'separator'},
      {label: '実際のサイズ', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0)},
      {label: '拡大', accelerator: 'CmdOrCtrl+=', click: () => setZoom(0.1)},
      {label: '縮小', accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.1)},
      {type: 'separator'}, {role: 'togglefullscreen'}, {role: 'toggleDevTools'},
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function endProcess(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); }
    catch { try { proc.kill('SIGTERM'); } catch {} }
  }
}

// Local commands run without confirmation, through the shell, starting in the workspace folder.
function executeLocal(command, capture = false) {
  if (active) throw new Error('Another command is already running');
  const options = {
    cwd: workspace,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const proc = spawn(command, options);
  active = { proc, total: 0, command };
  let captured = '';
  sendTools('tools:status', { state: 'running', command });
  const timeout = setTimeout(() => {
    if (active?.proc === proc) {
      sendTools('tools:output', '\n[10 minute execution limit reached; terminating]\n');
      endProcess(proc);
    }
  }, MAX_RUNTIME_MS);
  let errored = false;
  let completed = false;
  const done = new Promise((resolve) => {
    function finish(code, signal) {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (active?.proc === proc) active = null;
      sendTools('tools:status', {state: 'idle', exitCode: code, signal});
      resolve({ code, signal, errored, output: capture ? captured : undefined });
    }
    const output = (buf) => {
      if (!active || active.proc !== proc) return;
      if (capture && captured.length < 256 * 1024) captured += String(buf);
      active.total += buf.length;
      if (active.total <= MAX_OUTPUT) sendTools('tools:output', String(buf));
      else {
        sendTools('tools:output', '\n[2MB output limit reached; terminating]\n');
        endProcess(proc);
      }
    };
    proc.stdout?.on('data', output);
    proc.stderr?.on('data', output);
    proc.once('error', (error) => {
      errored = true;
      sendTools('tools:output', `\n[Process error: ${error.message}]\n`);
      // Electron/Node should emit close afterward. Cover a missing close event.
      if (!proc.pid) finish(null, 'error');
    });
    proc.once('close', finish);
  });
  return done;
}


// ---- Local agent bridge -------------------------------------------------
// The agent loop itself lives in desktop-api.js (it owns the gateway client); everything that
// touches this machine goes through here. There are no confirmations and no folder limits:
// commands run like the manual runner, and file paths may be absolute or workspace-relative.
// Only the single-run lock is shared with the tools window.
async function executeAgentCall(call) {
  try {
    if (active || workflowRunning) return {ok: false, output: 'Another local command or workflow is already running.'};
    const root = workspace;
    const target = call.path !== undefined || call.tool === 'list' ? resolveToolPath(root, call.path || '.') : null;
    if ((call.tool !== 'run') && !target) return {ok: false, output: `Invalid path: ${call.path}`};
    if (call.tool === 'run') {
      const result = await executeLocal(call.command, true);
      const out = (result.output || '').trim();
      return {
        ok: !result.errored && result.code === 0,
        output: `exit code: ${result.code ?? 'none'}${result.signal ? `, signal: ${result.signal}` : ''}${out ? `\n${out}` : ''}`,
      };
    }
    if (call.tool === 'read') {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return {ok: false, output: `Not a file: ${call.path}`};
      if (stat.size > 2 * 1024 * 1024) return {ok: false, output: `File is too large to read (${stat.size} bytes): ${call.path}`};
      const text = fs.readFileSync(target, 'utf8');
      if (text.includes('\0')) return {ok: false, output: `Not a UTF-8 text file: ${call.path}`};
      const lines = text.split(/\r?\n/);
      const start = call.start || 1;
      const end = Math.min(call.end || lines.length, lines.length);
      const body = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
      return {ok: true, output: `${call.path} (${lines.length} lines, showing ${start}-${end})\n${body}`};
    }
    if (call.tool === 'list') {
      const entries = fs.readdirSync(target, {withFileTypes: true});
      const shown = entries.slice(0, 200).map(e => `${e.isDirectory() ? '[dir] ' : '[file] '}${e.name}`);
      return {ok: true, output: `${call.path || '.'} (${entries.length} entries${entries.length > shown.length ? `, showing first ${shown.length}` : ''})\n${shown.join('\n')}`};
    }
    if (call.tool === 'write' || call.tool === 'edit') {
      let content;
      if (call.tool === 'write') content = call.content;
      else {
        const current = fs.readFileSync(target, 'utf8');
        const first = current.indexOf(call.old);
        if (first === -1) return {ok: false, output: `edit: the old text was not found in ${call.path}.`};
        if (current.indexOf(call.old, first + 1) !== -1) return {ok: false, output: `edit: the old text occurs more than once in ${call.path}; include more surrounding context.`};
        content = current.slice(0, first) + call.new + current.slice(first + call.old.length);
      }
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, content, 'utf8');
      sendTools('tools:output', `[${call.tool}] ${target}\n`);
      return {ok: true, output: `${call.tool === 'write' ? 'Wrote' : 'Edited'} ${call.path} (${content.length} characters).`};
    }
    return {ok: false, output: `Unsupported tool: ${call.tool}`};
  } catch (error) {
    return {ok: false, output: error.message};
  }
}
function createLocalBridge() {
  return {
    workspace: () => workspace,
    platform: () => process.platform,
    isBusy: () => Boolean(active) || workflowRunning,
    report: (text) => sendTools('tools:output', text),
    agentStatus: (state) => sendTools('tools:agent-status', state),
    executeCall: (call) => executeAgentCall(call),
  };
}

// One running copy only: launching again just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showMuse);
}
app.setAppUserModelId('dev.community.muse-app');
// Present as a regular Chromium browser; some sign-in providers reject embedded "Electron" agents.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/i, '')
  .replace(new RegExp(`\\s?${app.getName().replace(/[^\w-]/g, '\\$&')}\\/\\S+`, 'i'), '');

app.whenReady().then(() => {
  fs.mkdirSync(workspace, { recursive: true });
  prefs = createPrefs(app.getPath('userData'));
  desktop = setupDesktop({getWindow: () => museWindow, openTools, localBridge: createLocalBridge()});
  setMenu();
  // The local tools window no longer opens automatically; use the menu or Ctrl+Shift+T.
  shortcutRegistered = globalShortcut.register(TOGGLE_SHORTCUT, toggleMuse);
  createTray();
  openMuse({show: !startHidden});

  ipcMain.handle('tools:get-info', (event) => {
    assertToolsSender(event);
    return {workspace, busy: Boolean(active) || workflowRunning,
      platform: process.platform};
  });
  ipcMain.handle('tools:select-workspace', async (event) => {
    assertToolsSender(event);
    if (active || workflowRunning) throw new Error('Stop running commands before changing workspace');
    const result = await dialog.showOpenDialog(toolsWindow, {
      title: 'Choose a trusted workspace', defaultPath: workspace,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0] && result.filePaths[0] !== workspace) {
      workspace = result.filePaths[0];
    }
    return workspace;
  });
  ipcMain.handle('tools:run', async (event, command) => {
    assertToolsSender(event);
    if (active || workflowRunning) throw new Error('Another command or workflow is running');
    if (typeof command !== 'string' || command.length > 1500 || !command.trim()) {
      throw new Error('Command must be nonempty and no longer than 1500 characters');
    }
    executeLocal(command);
    return {started: true};
  });
  ipcMain.handle('tools:run-workflow', async (event) => {
    assertToolsSender(event);
    if (active || workflowRunning) throw new Error('Another command or workflow is running');
    // Fixed, bounded steps. This is not an autonomous AI development loop.
    const steps = ['npm test', 'npm run build'];
    workflowRunning = true;
    stopWorkflow = false;
    sendTools('tools:workflow-status', {state: 'running'});
    let state = 'finished';
    try {
      for (const step of steps) {
        if (stopWorkflow) { state = 'stopped'; break; }
        const result = await executeLocal(step);
        if (stopWorkflow) { state = 'stopped'; break; }
        if (result.errored || result.code !== 0) { state = 'failed'; break; }
      }
    } finally {
      workflowRunning = false;
      sendTools('tools:workflow-status', {state});
    }
    return {state};
  });
  ipcMain.handle('tools:stop', (event) => {
    assertToolsSender(event);
    stopWorkflow = true;
    if (!active) return workflowRunning;
    endProcess(active.proc);
    return true;
  });
  ipcMain.handle('tools:agent-start', async (event, task) => {
    assertToolsSender(event);
    if (!desktop?.startAgent) throw new Error('The local agent is not available');
    return desktop.startAgent(task);
  });
  ipcMain.handle('tools:agent-stop', (event) => {
    assertToolsSender(event);
    return desktop?.stopAgent ? desktop.stopAgent() : false;
  });
  app.on('activate', () => {
    showMuse();
  });
});
app.on('before-quit', () => {
  quitting = true;
  rememberWindowState();
  prefs?.flush();
  if (active) endProcess(active.proc);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
