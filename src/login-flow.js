'use strict';

// Login completion watching for the embedded muse.ai login window.
//
// Navigation events from the login window are not a reliable signal on
// their own: Meta sign-in can finish inside a popup window, muse.ai is a
// SPA whose transitions do not always fire the events we used to listen
// for, and a missed event used to leave the login hanging forever with
// no feedback at all. While the window is open we therefore poll a probe
// (MuseClient.probeLogin) that names the stage it reached, so a login
// that does not complete can say which stage it is stuck at instead of
// failing silently.

const STAGES = ['waiting', 'session', 'token', 'ready', 'error'];
const MESSAGES = {
  waiting: 'ログインウィンドウで Muse にログインしてください。完了すると自動で検出して接続します。',
  session: 'ログインを確認しました。Muse の VM 情報を取得しています…',
  token: 'VM 情報を取得しました。接続用トークンを取得しています…',
  ready: 'ログインが完了しました。接続しています…',
  error: 'ログイン状態を確認できませんでした。確認を続けます…',
};
const INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

function timeoutMessage(stage) {
  switch (stage) {
    case 'session': return 'ログインは確認できましたが、Muse の VM 情報を取得できないまま時間切れになりました。しばらく待ってからログインし直してください。';
    case 'token': return 'VM 情報は取得できましたが、接続用トークンの取得が完了しないまま時間切れになりました。しばらく待ってからログインし直してください。';
    case 'error': return 'ログイン状態を確認できないまま時間切れになりました。通信環境を確認してログインし直してください。';
    default: return 'ログインが完了する前に時間切れになりました。ログインウィンドウでログインを完了してください。';
  }
}

// probe: async () => stage string (see MuseClient.probeLogin). A probe
// that throws counts as the 'error' stage and polling continues; stages
// are reported to onStage only when they change.
function createWatcher({probe, onStage = () => {}, onReady = () => {}, onTimeout = () => {}, intervalMs = INTERVAL_MS, timeoutMs = TIMEOUT_MS, timers = {setInterval, clearInterval, setTimeout, clearTimeout}}) {
  let stopped = true, probing = false, stage = null, interval = null, deadline = null;
  async function poll() {
    if (stopped || probing) return;
    probing = true;
    let next;
    try { next = await probe(); } catch { next = 'error'; }
    probing = false;
    if (stopped) return;
    if (!STAGES.includes(next)) next = 'error';
    if (next !== stage) { stage = next; onStage(stage); }
    if (stage === 'ready') { stop(); onReady(); }
  }
  function start() {
    if (!stopped) return;
    stopped = false; stage = null;
    void poll();
    interval = timers.setInterval(() => { void poll(); }, intervalMs);
    interval?.unref?.();
    deadline = timers.setTimeout(() => { const last = stage; stop(); onTimeout(last); }, timeoutMs);
    deadline?.unref?.();
  }
  function stop() {
    stopped = true;
    if (interval !== null) { timers.clearInterval(interval); interval = null; }
    if (deadline !== null) { timers.clearTimeout(deadline); deadline = null; }
  }
  return {start, stop, poll, get stage() { return stage; }, get running() { return !stopped; }};
}

module.exports = {STAGES, MESSAGES, INTERVAL_MS, TIMEOUT_MS, timeoutMessage, createWatcher};
