'use strict';

// Auto-decision policy for Muse platform approvals (approvals.snapshot).
// Separate from approval-policy.js, which only covers the LOCAL tools window.
//   manual    : never auto-approve
//   auto      : auto-approve low-risk requests (web/network access, browser view)
//   important : ask only for important ones (payments, warnings, outgoing media, devices)
//   bypass    : auto-approve everything, including payments
const MODES = Object.freeze(['manual', 'auto', 'important', 'bypass']);
const LOW = new Set(['network', 'browser']);
const HIGH = new Set(['warning', 'checkout', 'media', 'device', 'outgoing_media']);

const str = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function classify(approval) {
  const display = approval?.display && typeof approval.display === 'object' ? approval.display : {};
  const type = str(approval?.approval_type);
  const icon = str(display.icon_key);
  // The web client highlights icon_key "warning" as needing safety attention.
  if (HIGH.has(icon) || HIGH.has(type) || type.includes('checkout') || str(display.attention_label)) return 'high';
  if (approval?.payment_details || Object.keys(approval || {}).some(k => /checkout_approval$/.test(k) && approval[k])) return 'high';
  if (LOW.has(type) || (!type && LOW.has(icon))) return 'low';
  return 'medium';
}

// Returns 'allow_once' when the request should be approved without asking, otherwise null.
function decide(approval, mode) {
  if (!MODES.includes(mode)) throw new Error('Invalid approval mode');
  if (mode === 'manual' || !approval || typeof approval.approval_id !== 'string') return null;
  if (approval.status && str(approval.status) !== 'pending') return null;
  const options = approval.decision_options;
  if (Array.isArray(options) && !options.some(o => str(typeof o === 'string' ? o : o?.kind) === 'allow_once')) return null;
  const risk = classify(approval);
  if (mode === 'bypass' || (mode === 'important' && risk !== 'high') || (mode === 'auto' && risk === 'low')) return 'allow_once';
  return null;
}

module.exports = {MODES, classify, decide};
