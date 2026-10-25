'use strict';
// Lets Muse live in her 3D desktop body (kaguya-companion) by her own choice: things that happen to the
// body or around the PC are told to her in a dedicated side chat, and she moves the body herself with the
// PC commands companion.act / companion.info. Nothing here moves the body.
//
// Told: clicks on her, the cursor resting on her, dozing off and being woken (from the companion), the
// user coming back after 10+ minutes away (system idle time, so games and keyboards count), and a check-in
// every 5 minutes while the user is around. Several events within a minute go out as one message.
const fs = require('node:fs');
const path = require('node:path');

const COMPANION = 'http://127.0.0.1:38741';
const POLL_MS = 3000;
const MIN_GAP_S = 60; // between messages
const CHECKIN_S = 300; // check-in while the user is around
const AWAY_S = 600; // idle this long = away

function describe(e) {
  switch (e.type) {
    case 'click': return e.part === 'head' ? 'ユーザーに頭をクリックされた' : 'ユーザーに身体をクリックされた';
    case 'hover': return 'ユーザーのカーソルがしばらく身体の上に乗っている';
    case 'doze': return '放っておかれて、うとうとし始めた';
    case 'woke': return 'ユーザーがマウスを動かして、居眠りから起こされた';
    case 'returned': return `ユーザーが ${e.minutes} 分ぶりに PC に戻ってきた`;
    case 'checkin': return e.idle < 60 ? '（定期）ユーザーは PC を操作中' : `（定期）ユーザーは ${Math.round(e.idle / 60)} 分ほど PC を触っていない`;
    default: return null;
  }
}

function createCompanionLink({ dataDir, send, rename, sessions, title = async () => 'Muse の身体', idleSeconds, log = () => {} }) {
  const file = path.join(dataDir, 'companion-link.json');
  let state = { enabled: true, sessionId: '' };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(state)); } catch (e) { log('companion-link save', e.message); } };

  let timer = null, lastEventId = null, pending = [], lastSentAt = 0, lastCheckinAt = Date.now() / 1000;
  let away = false, awaySince = 0, sending = false, companionUp = false, backoffUntil = 0;

  async function poll() {
    const now = Date.now() / 1000;
    if (now < backoffUntil) return;
    // Events from the companion (the first poll only learns where the queue is).
    try {
      const r = await fetch(`${COMPANION}/events?after=${lastEventId ?? -1}`, { signal: AbortSignal.timeout(2000) });
      const data = await r.json();
      companionUp = true;
      if (lastEventId !== null) for (const e of data.events || []) pending.push(e);
      lastEventId = data.last ?? lastEventId ?? 0;
    } catch {
      companionUp = false; backoffUntil = now + 30; return;
    }
    // Coming back after being away, and check-ins while the user is around.
    const idle = idleSeconds();
    if (!away && idle >= AWAY_S) { away = true; awaySince = now - idle; }
    if (away && idle < 5) { away = false; pending.push({ type: 'returned', minutes: Math.round((now - awaySince) / 60) }); }
    if (!away && now - lastCheckinAt >= CHECKIN_S) {
      lastCheckinAt = now;
      if (!pending.length && now - lastSentAt >= CHECKIN_S / 2) pending.push({ type: 'checkin', idle });
    }
    if (pending.length && !sending && now - lastSentAt >= MIN_GAP_S) await flush(now);
  }

  async function flush(now) {
    const lines = [...new Set(pending.map(describe).filter(Boolean))];
    pending = [];
    if (!lines.length) return;
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const text = [
      `[からだ ${time}]`,
      ...lines.map((l) => `- ${l}`),
      '身体は companion.act で動かせる（名前の一覧は companion.info）。反応したいときだけ、好きなように。返事の文章は短くていいよ。',
    ].join('\n');
    sending = true;
    try {
      // One side chat for good: the remembered one, else an existing chat with the title, else a new one.
      const name = !state.sessionId ? await title().catch(() => 'Muse の身体') : '';
      if (!state.sessionId && sessions) {
        const list = await sessions().catch(() => null);
        const rows = Array.isArray(list) ? list : list?.sessions || [];
        const found = rows.find((row) => row && !row.is_primary && String(row.title || '').trim() === name);
        const foundId = found?.session_id || found?.id;
        if (foundId) { state.sessionId = foundId; save(); }
      }
      const fresh = !state.sessionId;
      const id = state.sessionId || require('node:crypto').randomUUID();
      const result = await send(text, id);
      if (fresh) {
        state.sessionId = result?.session_id || id; save();
        rename(state.sessionId, name).catch(() => {});
      }
      lastSentAt = now;
      if (lines.some((l) => !l.startsWith('（定期）'))) lastCheckinAt = now;
    } catch (e) {
      log('companion-link send', e.message);
      lastSentAt = now; // try again after the gap, not in a tight loop
    } finally { sending = false; }
  }

  function start() { if (!timer && state.enabled) timer = setInterval(() => { poll().catch(() => {}); }, POLL_MS); }
  function stop() { clearInterval(timer); timer = null; pending = []; }
  return {
    start,
    stop,
    status: () => ({ enabled: state.enabled, companionUp, sessionId: state.sessionId || null }),
    setEnabled(on) { state.enabled = Boolean(on); save(); if (state.enabled) start(); else stop(); return state.enabled; },
  };
}

module.exports = { createCompanionLink, describe };
