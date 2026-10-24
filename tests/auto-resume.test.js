'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, record, LIMIT } = require('../src/auto-resume');

const now = 1_800_000_000_000;
const s = (over = {}) => ({session_id: 'main', is_primary: true, status: 'interrupted', updated_at_ms: now - 60_000, ...over});

test('an interrupted chat is resumed after the wait', () => {
  assert.deepEqual(plan([s()], {now}).due.map(x => x.session_id), ['main']);
});
test('running, completed, cancelled-state and old chats are left alone', () => {
  for (const status of ['running', 'completed', 'cancelled', 'out_of_credits']) assert.equal(plan([s({status})], {now}).due.length, 0, status);
  assert.equal(plan([s({updated_at_ms: now - 3 * 60 * 60 * 1000})], {now}).due.length, 0);
  assert.equal(plan([s({archived: true})], {now}).due.length, 0);
  assert.equal(plan([s({can_send_messages: false})], {now}).due.length, 0);
});
test('a fresh interruption waits, then becomes due', () => {
  const fresh = s({updated_at_ms: now - 5_000});
  const r = plan([fresh], {now});
  assert.equal(r.due.length, 0);
  assert.equal(r.waitMs, 25_000);
  assert.equal(plan([fresh], {now: now + 25_000}).due.length, 1);
});
test('a stop the user pressed is never resumed', () => {
  assert.equal(plan([s()], {now, cancels: {main: now - 61_000}}).due.length, 0);
  assert.equal(plan([s()], {now, cancels: {main: now - 60 * 60 * 1000}}).due.length, 1);
});
test('the same interruption is resumed once, and at most LIMIT times per window', () => {
  let history = record({}, s(), now);
  assert.equal(plan([s()], {now, history}).due.length, 0);
  for (let i = 1; i < LIMIT; i++) history = record(history, s({updated_at_ms: now - 60_000 + i}), now);
  assert.equal(plan([s({updated_at_ms: now - 10 * 60_000})], {now, history}).due.length, 0);
  assert.equal(plan([s({updated_at_ms: now + 7 * 60 * 60 * 1000 - 60_000})], {now: now + 7 * 60 * 60 * 1000, history}).due.length, 1);
});
