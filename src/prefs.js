'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Small persisted UI preferences for the app shell (window placement, tray, zoom).
// Approval mode is intentionally NOT stored here; see main.js.
const DEFAULTS = Object.freeze({
  bounds: null,          // {x, y, width, height}
  maximized: false,
  zoomFactor: 1,
  closeToTray: true,
  lastUrl: null,
});
const MIN_W = 480;
const MIN_H = 400;

function sanitize(raw) {
  const out = {...DEFAULTS};
  if (!raw || typeof raw !== 'object') return out;
  const b = raw.bounds;
  if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= MIN_W && b.height >= MIN_H) {
    out.bounds = {x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height)};
  }
  out.maximized = raw.maximized === true;
  if (Number.isFinite(raw.zoomFactor)) out.zoomFactor = Math.min(3, Math.max(0.5, raw.zoomFactor));
  if (typeof raw.closeToTray === 'boolean') out.closeToTray = raw.closeToTray;
  out.lastUrl = isMuseUrl(raw.lastUrl) ? raw.lastUrl : null;
  return out;
}

// Only remember pages on muse.ai itself; never restore a third-party (e.g. login) page.
function isMuseUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'muse.ai' || u.hostname.endsWith('.muse.ai'));
  } catch { return false; }
}

// Keeps a saved window rectangle only if it is still mostly on a connected display.
function fitToDisplays(bounds, workAreas) {
  if (!bounds) return null;
  const visible = workAreas.some(a => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= 200 && h >= 120;
  });
  return visible ? bounds : null;
}

function createPrefs(dir) {
  const file = path.join(dir, 'window-prefs.json');
  let data;
  try { data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { data = sanitize(null); }
  let timer = null;
  function flush() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(dir, {recursive: true});
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch { /* preferences are best effort */ }
  }
  return {
    get: () => ({...data}),
    set(patch) {
      data = sanitize({...data, ...patch});
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
    },
    flush,
  };
}

module.exports = {DEFAULTS, sanitize, isMuseUrl, fitToDisplays, createPrefs};
