'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createWatcher, timeoutMessage} = require('../src/login-flow');
const {MuseClient} = require('../src/muse-client');

// Manual timers so watcher tests never wait on real time.
function fakeTimers() {
  const intervals = new Map(), timeouts = new Map();
  let next = 1;
  return {
    timers: {
      setInterval: fn => { const id = next++; intervals.set(id, fn); return id; },
      clearInterval: id => intervals.delete(id),
      setTimeout: fn => { const id = next++; timeouts.set(id, fn); return id; },
      clearTimeout: id => timeouts.delete(id),
    },
    tick: async () => { for (const fn of [...intervals.values()]) await fn(); },
    fireTimeouts: () => { for (const fn of [...timeouts.values()]) fn(); },
  };
}
const scripted = stages => { let i = 0; return async () => stages[Math.min(i++, stages.length - 1)]; };

test('stages are reported once per change and ready finishes the watch', async () => {
  const t = fakeTimers();
  const seen = [];
  let ready = 0;
  const w = createWatcher({probe: scripted(['waiting', 'waiting', 'session', 'token', 'ready']), onStage: s => seen.push(s), onReady: () => ready++, timers: t.timers});
  w.start();
  await new Promise(r => setImmediate(r)); // initial poll
  for (let i = 0; i < 5; i++) await t.tick();
  assert.deepEqual(seen, ['waiting', 'session', 'token', 'ready']);
  assert.equal(ready, 1);
  assert.equal(w.running, false);
});

test('a timeout reports the stage the login is stuck at', async () => {
  const t = fakeTimers();
  let stuck = null, probes = 0;
  const w = createWatcher({probe: async () => { probes++; return 'session'; }, onTimeout: s => { stuck = s; }, timers: t.timers});
  w.start();
  await new Promise(r => setImmediate(r));
  t.fireTimeouts();
  assert.equal(stuck, 'session');
  assert.equal(w.running, false);
  const before = probes;
  await t.tick();
  assert.equal(probes, before); // polling stopped with the watch
  assert.match(timeoutMessage('session'), /VM 情報/);
  assert.match(timeoutMessage('token'), /トークン/);
  assert.match(timeoutMessage(null), /時間切れ/);
});

test('a throwing probe becomes the error stage and polling continues', async () => {
  const t = fakeTimers();
  const seen = [];
  let calls = 0, ready = 0;
  const w = createWatcher({
    probe: async () => { calls++; if (calls < 3) throw new Error('network'); return 'ready'; },
    onStage: s => seen.push(s), onReady: () => ready++, timers: t.timers,
  });
  w.start();
  await new Promise(r => setImmediate(r));
  for (let i = 0; i < 3; i++) await t.tick();
  assert.deepEqual(seen, ['error', 'ready']);
  assert.equal(ready, 1);
});

test('an unknown stage from the probe is treated as an error', async () => {
  const t = fakeTimers();
  const seen = [];
  const w = createWatcher({probe: async () => 'surprise', onStage: s => seen.push(s), timers: t.timers});
  w.start();
  await new Promise(r => setImmediate(r));
  w.stop();
  assert.deepEqual(seen, ['error']);
});

// probeLogin stage outcomes, with the website session stubbed out.
const SESSION = {endpoint_url: 'https://vm-1.metaaivm.com', vm_id: 'vm1', vm_name: 'vm-one'};
function clientWith(fetchJson) {
  return new MuseClient({credentials: null, fetchJson, checkPin: () => {}});
}
test('probeLogin waits while there is no signed-in website session', async () => {
  const c = clientWith(async () => { throw new Error('login required'); });
  assert.equal(await c.probeLogin(), 'waiting');
});
test('probeLogin names an unusable VM session', async () => {
  assert.equal(await clientWith(async () => ({})).probeLogin(), 'session');
  assert.equal(await clientWith(async () => ({...SESSION, endpoint_url: 'https://example.com'})).probeLogin(), 'session');
});
test('probeLogin names a failing or empty hatch token response', async () => {
  const fetchJson = async route => {
    if (route.startsWith('/api/session')) return SESSION;
    throw new Error('nope');
  };
  assert.equal(await clientWith(fetchJson).probeLogin(), 'token');
  const empty = async route => route.startsWith('/api/session') ? SESSION : {};
  assert.equal(await clientWith(empty).probeLogin(), 'token');
});
test('probeLogin stores fresh credentials and reports ready', async () => {
  const fetchJson = async route => route.startsWith('/api/session') ? SESSION : {token: 'tok', notary_token: 'not'};
  const c = clientWith(fetchJson);
  let emitted = null;
  c.on('credentials', v => { emitted = v; });
  assert.equal(await c.probeLogin(), 'ready');
  assert.equal(c.credentials.token, 'tok');
  assert.equal(c.credentials.vmId, 'vm1');
  assert.equal(emitted, c.credentials);
});
test('refreshCredentials still swallows probe failures', async () => {
  const c = clientWith(async () => { throw new Error('offline'); });
  await c.refreshCredentials(); // must not throw; stored credentials stay usable
  assert.equal(c.credentials, null);
});
