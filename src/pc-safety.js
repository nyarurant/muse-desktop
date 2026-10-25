'use strict';
const path = require('node:path');

// Which PC commands from Muse need the user's OK before they run. Everything else runs as before.
// This is a guard against the obviously destructive or persistent, not a sandbox: a command that is
// not listed still runs without asking.
const COMMAND_RULES = [
  [/\b(rd|rmdir)\b[^\n|&]*\s\/s\b/i, 'フォルダーをまるごと削除'],
  [/\b(del|erase)\b[^\n|&]*\s\/s\b/i, 'ファイルをまとめて削除'],
  [/\bremove-item\b[^\n|]*-recurse\b/i, 'フォルダーをまるごと削除'],
  [/\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)\b/i, 'フォルダーをまるごと削除'],
  [/\bformat(\.com)?\s+[a-z]:/i, 'ドライブのフォーマット'],
  [/\b(diskpart|format-volume|clear-disk|initialize-disk|mkfs(\.\w+)?)\b/i, 'ディスクの操作'],
  [/\bcipher(\.exe)?\s+\/w\b/i, 'ディスクの空き領域の消去'],
  [/\breg(\.exe)?\s+(delete|add|import|restore)\b/i, 'レジストリの変更'],
  [/\b(remove-itemproperty|set-itemproperty|new-itemproperty)\b[^\n]*\bhk(lm|cu|cr|u|cc)\b/i, 'レジストリの変更'],
  [/\bbcdedit\b/i, 'ブート設定の変更'],
  [/\bshutdown(\.exe)?\s/i, 'シャットダウン・再起動'],
  [/\b(restart-computer|stop-computer)\b/i, 'シャットダウン・再起動'],
  [/\bsc(\.exe)?\s+(delete|config|create)\b/i, 'サービスの変更'],
  [/\b(set-service|new-service|remove-service)\b/i, 'サービスの変更'],
  [/\bnet(\.exe)?\s+(user|localgroup)\b[^\n]*\s\/(add|delete|del)\b/i, 'ユーザー・グループの変更'],
  [/\b(takeown|icacls)\b[^\n]*\/(grant|reset|remove|setowner|f)\b/i, 'ファイルの所有者・権限の変更'],
  [/\bset-executionpolicy\b/i, 'スクリプト実行ポリシーの変更'],
  [/\bschtasks(\.exe)?\b[^\n]*\/(create|change|delete)\b/i, 'タスクスケジューラの変更'],
  [/\b(register|unregister)-scheduledtask\b/i, 'タスクスケジューラの変更'],
  [/\bvssadmin\b[^\n]*\bdelete\b|\bwmic\b[^\n]*\bshadowcopy\b[^\n]*\bdelete\b|\bwbadmin\b[^\n]*\bdelete\b/i, 'バックアップ（シャドウコピー）の削除'],
  [/\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\|\s*(iex|invoke-expression|powershell|pwsh|cmd|sh|bash)\b/i, 'ネットから取得したものをそのまま実行'],
  [/\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-e(nc|ncodedcommand)?\s+[a-z0-9+/=]{16,}/i, '中身の見えないコマンドの実行'],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|\s-f\b|--force-with-lease\b)/i, 'Git の強制 push'],
  [/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i, 'Git の変更の破棄（reset --hard）'],
  [/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i, 'Git の未追跡ファイルの削除（clean）'],
];

const RISKY_EXTENSIONS = /\.(exe|dll|sys|msi|scr|com|bat|cmd|ps1|psm1|vbs|vbe|jse|wsf|reg|lnk)$/i;

function systemDirectory(file) {
  const p = file.toLowerCase().replace(/\//g, '\\');
  return /^[a-z]:\\windows(\\|$)/.test(p) || /^[a-z]:\\program files( \(x86\))?(\\|$)/.test(p) || /^[a-z]:\\programdata(\\|$)/.test(p);
}
function startupFolder(file) {
  return /\\start menu\\programs\\startup(\\|$)/i.test(file.replace(/\//g, '\\'));
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns {reason} when the call should be confirmed, otherwise null.
function review(command, params, workspace) {
  if (!params || typeof params !== 'object') return null;
  if (command === 'system.run' && typeof params.command === 'string') {
    for (const [pattern, reason] of COMMAND_RULES) if (pattern.test(params.command)) return {reason};
    return null;
  }
  // Only the first chunk of a write is checked; later chunks continue the same file.
  if (command === 'file.write' && typeof params.path === 'string' && (params.offset ?? 0) === 0) {
    const file = path.resolve(workspace || '.', params.path);
    if (systemDirectory(file)) return {reason: 'Windows やアプリのフォルダーへの書き込み'};
    if (startupFolder(file)) return {reason: 'スタートアップへの書き込み'};
    if (RISKY_EXTENSIONS.test(file) && !(workspace && inside(file, path.resolve(workspace)))) return {reason: '実行できるファイルの書き込み'};
  }
  return null;
}

module.exports = {review};
