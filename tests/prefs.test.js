'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, sanitize, isMuseUrl, fitToDisplays, createPrefs } = require('../src/prefs');

test('sanitize falls back to defaults on garbage', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize({bounds: {x: 'a'}, zoomFactor: 'big', closeToTray: 'yes'}), DEFAULTS);
  assert.equal(sanitize({zoomFactor: 9}).zoomFactor, 3);
  assert.equal(sanitize({bounds: {x: 0, y: 0, width: 100, height: 100}}).bounds, null);
});
test('only muse.ai https pages are restored', () => {
  assert.equal(isMuseUrl('https://muse.ai/chat/123'), true);
  assert.equal(isMuseUrl('https://app.muse.ai/'), true);
  assert.equal(isMuseUrl('http://muse.ai/'), false);
  assert.equal(isMuseUrl('https://evilmuse.ai/'), false);
  assert.equal(isMuseUrl('https://accounts.meta.com/login'), false);
  assert.equal(sanitize({lastUrl: 'https://accounts.meta.com/'}).lastUrl, null);
});
test('saved bounds must still be on a display', () => {
  const area = [{x: 0, y: 0, width: 1920, height: 1040}];
  const onScreen = {x: 100, y: 100, width: 1200, height: 800};
  assert.deepEqual(fitToDisplays(onScreen, area), onScreen);
  assert.equal(fitToDisplays({x: 3000, y: 100, width: 1200, height: 800}, area), null);
  assert.equal(fitToDisplays(null, area), null);
});
test('prefs persist across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-prefs-'));
  try {
    const a = createPrefs(dir);
    a.set({maximized: true, zoomFactor: 1.2, closeToTray: false, bounds: {x: 1, y: 2, width: 800, height: 600}});
    a.flush();
    const b = createPrefs(dir).get();
    assert.equal(b.maximized, true);
    assert.equal(b.zoomFactor, 1.2);
    assert.equal(b.closeToTray, false);
    assert.deepEqual(b.bounds, {x: 1, y: 2, width: 800, height: 600});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
