'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, classify, decide } = require('../src/muse-approval-policy');

const web = {approval_id: 'a1', status: 'pending', approval_type: 'network', display: {summary_title: 'Web access', icon_key: 'network'}};
const connector = {approval_id: 'c1', status: 'pending', approval_type: 'connector', display: {icon_key: 'connector'}};
const unknown = {approval_id: 'u1', display: {summary_title: 'Something new'}};
const checkout = {approval_id: 'p1', status: 'pending', approval_type: 'stripe_link_checkout_approval', decision_options: ['allow_once', 'deny']};
const warning = {approval_id: 'w1', approval_type: 'network', display: {icon_key: 'warning'}};
const media = {approval_id: 'm1', outgoing_media_approval: {count: 1}, approval_type: 'outgoing_media'};

test('modes', () => {
  assert.deepEqual(MODES, ['manual', 'auto', 'important', 'bypass']);
  assert.throws(() => decide(web, 'yolo'));
});
test('classification', () => {
  assert.equal(classify(web), 'low');
  assert.equal(classify(connector), 'medium');
  assert.equal(classify(unknown), 'medium');
  assert.equal(classify(checkout), 'high');
  assert.equal(classify(warning), 'high');
  assert.equal(classify(media), 'high');
  assert.equal(classify({approval_id: 'x', shopify_checkout_approval: {total: 1}}), 'high');
  assert.equal(classify({approval_id: 'x', display: {icon_key: 'network', attention_label: 'Review'}}), 'high');
});
test('manual never approves', () => {
  for (const a of [web, connector, checkout]) assert.equal(decide(a, 'manual'), null);
});
test('auto approves only low-risk requests', () => {
  assert.equal(decide(web, 'auto'), 'allow_once');
  assert.equal(decide(connector, 'auto'), null);
  assert.equal(decide(unknown, 'auto'), null);
  assert.equal(decide(checkout, 'auto'), null);
});
test('important asks only for important requests', () => {
  assert.equal(decide(web, 'important'), 'allow_once');
  assert.equal(decide(connector, 'important'), 'allow_once');
  assert.equal(decide(unknown, 'important'), 'allow_once');
  assert.equal(decide(checkout, 'important'), null);
  assert.equal(decide(warning, 'important'), null);
  assert.equal(decide(media, 'important'), null);
});
test('bypass approves everything that offers allow_once', () => {
  for (const a of [web, connector, unknown, checkout, warning, media]) assert.equal(decide(a, 'bypass'), 'allow_once');
});
test('never decides non-pending, malformed, or allow_once-less requests', () => {
  assert.equal(decide({...web, status: 'approved'}, 'bypass'), null);
  assert.equal(decide({...web, approval_id: 42}, 'bypass'), null);
  assert.equal(decide({...web, decision_options: ['allow_always', 'deny']}, 'bypass'), null);
  assert.equal(decide({...web, decision_options: [{kind: 'allow_once'}]}, 'auto'), 'allow_once');
  assert.equal(decide(null, 'bypass'), null);
});
