'use strict';

// Decides when to tell Muse to resume a chat that stopped unexpectedly
// (e.g. the VM restarted mid-task). A user-pressed stop is never resumed.
const RESUMABLE = new Set(['interrupted', 'failed', 'error', 'errored']);
// Marked as a system message so Muse does not take it as something the user said.
const MESSAGE = '[System] 作業が途中で止まったようです。止まったところから再開してください。（これはユーザー本人ではなく、Muse App が自動で送ったメッセージです）';
const RECENT_MS = 2 * 60 * 60 * 1000;   // ignore interruptions older than this
const WAIT_MS = 30 * 1000;              // give Muse a chance to recover by itself first
const CANCEL_GRACE_MS = 10 * 60 * 1000; // an interruption this close to a user stop is the user's
const LIMIT = 3;                        // auto-resumes per chat ...
const LIMIT_WINDOW_MS = 6 * 60 * 60 * 1000; // ... per this window

const keyOf = s => s.session_id + ':' + s.updated_at_ms;

// Returns {due: sessions to resume now, waitMs: when to check again (or null)}.
function plan(sessions, {now, cancels = {}, history = {}}) {
  const due = [];
  let waitMs = null;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.session_id !== 'string' || s.archived || s.can_send_messages === false) continue;
    if (!RESUMABLE.has(String(s.status || '').toLowerCase()) || !Number.isFinite(s.updated_at_ms)) continue;
    const age = now - s.updated_at_ms;
    if (age > RECENT_MS) continue;
    const cancelled = cancels[s.session_id];
    if (Number.isFinite(cancelled) && Math.abs(s.updated_at_ms - cancelled) <= CANCEL_GRACE_MS) continue;
    const past = (history[s.session_id] || []).filter(h => now - h.at < LIMIT_WINDOW_MS);
    if (past.some(h => h.key === keyOf(s)) || past.length >= LIMIT) continue;
    if (age < WAIT_MS) { waitMs = Math.min(waitMs ?? Infinity, WAIT_MS - age); continue; }
    due.push(s);
  }
  return {due, waitMs};
}

function record(history, s, now) {
  const next = {};
  for (const [id, list] of Object.entries(history || {})) {
    const kept = (Array.isArray(list) ? list : []).filter(h => now - h.at < LIMIT_WINDOW_MS);
    if (kept.length) next[id] = kept;
  }
  next[s.session_id] = [...(next[s.session_id] || []), {at: now, key: keyOf(s)}];
  return next;
}

module.exports = {MESSAGE, RESUMABLE, WAIT_MS, LIMIT, plan, record};
