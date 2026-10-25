'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {
  NativeDevice,
  ControlMessageDecoder,
  encodeControlMessage,
  MAX_INBOUND_MESSAGE,
  MAX_OUTBOUND_MESSAGE,
  MAX_CHAT_MESSAGE,
} = require('../src/native-device');
const {fields, first} = require('../src/noise');

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closed = 0;
    this.terminated = 0;
    this.pings = 0;
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(frame) {
    this.emit('message', frame, true);
  }

  send(frame) {
    this.sent.push(Buffer.isBuffer(frame) ? Buffer.from(frame) : frame);
  }

  ping() {
    this.pings++;
  }

  close() {
    this.closed++;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.terminated++;
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeNoise {
  message1() {
    return Buffer.from('noise-1');
  }

  message2(data) {
    assert.equal(Buffer.from(data).toString(), 'noise-2');
    return Buffer.alloc(0);
  }

  message3() {
    return {message: Buffer.from('noise-3'), tx: {}, rx: {}};
  }
}

class FakeTransport {
  constructor() {
    this.next = 1n;
    this.encodeCalls = [];
    this.requests = [];
    this.destroyed = false;
  }

  encode(service, frame) {
    this.encodeCalls.push({service, frame: Buffer.from(frame)});
    return [Buffer.from('encrypted-frame')];
  }

  request(verb, path, body, headers, service) {
    const id = this.next++;
    this.requests.push({
      id,
      verb,
      path,
      body: Buffer.from(body),
      headers,
      service,
    });
    return {id, frames: [Buffer.from('chat-request') ]};
  }

  decode(frame) {
    const value = JSON.parse(Buffer.from(frame).toString('utf8'));
    if (value.body?.type === 'Buffer') value.body = Buffer.from(value.body.data);
    return value;
  }

  destroy() {
    this.destroyed = true;
  }
}

function serverFrame(frame) {
  return Buffer.from(JSON.stringify(frame));
}

function controlId(transport) {
  const outer = fields(transport.encodeCalls[0].frame);
  return first(outer, 1).toString();
}

function controlMessageFromCall(call) {
  const outer = fields(call.frame);
  const chunk = fields(first(outer, 4));
  const data = first(chunk, 1);
  const length = data.readUInt32LE(0);
  return JSON.parse(data.subarray(4, 4 + length).toString('utf8'));
}

function controlMessages(transport) {
  return transport.encodeCalls
    .filter(({frame}) => fields(frame).has(4))
    .map(controlMessageFromCall);
}

async function connectedDevice({execute} = {}) {
  let transport;
  const socket = new FakeSocket();
  const statuses = [];
  const invokes = [];
  const device = new NativeDevice({
    execute: execute || (async (command, params, timeoutMs, id) => ({
      ok: true,
      payload: {command, params, timeoutMs, id},
    })),
    commands: {demo: {type: 'object'}},
    displayName: 'Test Device',
    socketFactory: (url, options) => {
      assert.equal(url, 'wss://hatch.metaaivm.com/v1/noise?vm_id=vm%2Fone');
      assert.equal(options.headers.Authorization, 'Bearer vm-secret');
      assert.equal(options.handshakeTimeout, 25_000);
      return socket;
    },
    noiseFactory: () => new FakeNoise(),
    transportFactory: () => {
      transport = new FakeTransport();
      return transport;
    },
  });
  device.on('status', (value) => statuses.push(value));
  device.on('invoke', (value) => invokes.push(value));
  const connected = device.connect({
    vm: {vm_id: 'vm/one', vm_auth_token: 'vm-secret'},
    nodeId: 'node-1',
  });
  socket.open();
  socket.receive(Buffer.from('noise-2'));
  await flush();
  await flush();

  assert.equal(socket.sent.some((frame) => frame.equals(Buffer.from('noise-1'))), true);
  assert.equal(socket.sent.some((frame) => frame.equals(Buffer.from('noise-3'))), true);
  const request = fields(transport.encodeCalls[0].frame);
  const applicationRequest = fields(first(request, 2));
  assert.equal(first(applicationRequest, 1).toString(), 'POST');
  assert.equal(first(applicationRequest, 2).toString(), '/link-control');
  assert.equal(first(applicationRequest, 5), 0n);

  const register = controlMessageFromCall(transport.encodeCalls[1]);
  assert.equal(register.type, 'req');
  assert.equal(register.method, 'link.register');
  assert.deepEqual(register.params, {
    node_id: 'node-1',
    display_name: 'Test Device',
    platform: 'windows',
    version: '0.5.0',
    device_family: 'homehub',
    model_id: 'windows',
    is_wakeup_supported: false,
    commands_v2: {demo: {type: 'object'}},
  });
  const registerId = register.id;
  const stream = controlId(transport);
  socket.receive(serverFrame({
    type: 'response',
    id: stream,
    status: 200,
    body: encodeControlMessage({id: registerId,error:null}),
    end: false,
  }));
  await connected;
  assert.equal(device.connected, true);
  assert.equal(device.nodeId, 'node-1');
  assert.deepEqual(statuses.at(-1), {connected: true, message: 'connected'});
  return {device, socket, transport, stream, statuses, invokes};
}

test('control decoder handles fragmentation, multiple messages, malformed JSON, and length bounds', () => {
  const decoder = new ControlMessageDecoder();
  const firstMessage = encodeControlMessage({one: 1});
  const secondMessage = encodeControlMessage({two: 2});
  assert.deepEqual(decoder.feed(firstMessage.subarray(0, 3)), []);
  assert.deepEqual(
    decoder.feed(Buffer.concat([firstMessage.subarray(3), secondMessage])),
    [{one: 1}, {two: 2}],
  );
  const boundedMulti = new ControlMessageDecoder(20);
  assert.deepEqual(
    boundedMulti.feed(Buffer.concat([firstMessage, secondMessage])),
    [{one: 1}, {two: 2}],
  );
  const malformed = Buffer.from('{"broken"');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(malformed.length);
  assert.deepEqual(
    decoder.feed(Buffer.concat([prefix, malformed, encodeControlMessage({valid: true})])),
    [{valid: true}],
  );
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(MAX_INBOUND_MESSAGE + 1);
  assert.throws(() => decoder.feed(oversized), (error) => error.code === 'inbound_too_large');
});

test('connect registers a Windows node and send performs one native JSON chat request', async () => {
  const {device, socket, transport} = await connectedDevice();
  const reply = device.send('hello', 'session-1', {replyTo: 'turn-7'});
  await flush();
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0];
  assert.equal(request.path, '/chat/stream');
  assert.equal(request.verb, 'POST');
  assert.deepEqual(JSON.parse(request.body.toString('utf8')), {
    message: 'hello',
    output_modality: 'text',
    device_id: 'node-1',
    session_id: 'session-1',
    in_reply_to: 'turn-7',
  });
  assert.equal(socket.sent.includes('chat'), false);
  socket.receive(serverFrame({
    type: 'response',
    id: request.id.toString(),
    status: 200,
    body: Buffer.from(JSON.stringify({ok: true, ack: 'accepted'})),
    end: true,
  }));
  assert.deepEqual(await reply, {ok: true, ack: 'accepted'});
  device.disconnect();
  assert.equal(device.connected, false);
});

test('invoke ids deduplicate while running and after completion, and a second command gets structured busy result', async () => {
  let calls = 0;
  let release;
  const execute = async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
    return {ok: true, payload: {done: true}};
  };
  const {device, socket, transport, stream, invokes} = await connectedDevice({execute});
  const invoke = (id, command = 'demo') => socket.receive(serverFrame({
    type: 'body',
    id: stream,
    body: encodeControlMessage({
      method: 'link.invoke',
      id,
      command,
      params: {x: 1},
      timeout_ms: 1234,
    }),
    end: false,
  }));
  invoke('same');
  await flush();
  invoke('same');
  invoke('other', 'other-command');
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(invokes[0], {
    phase: 'running',
    id: 'same',
    command: 'demo',
    params: {x: 1},
  });
  release();
  await flush();
  await flush();
  const beforeDuplicate = controlMessages(transport)
    .filter((message) => message.method === 'link.result');
  assert.equal(beforeDuplicate.some((message) => message.id === 'other' &&
    message.ok === false && message.error === 'busy'), true);
  assert.equal(beforeDuplicate.filter((message) => message.id === 'same').length >= 2, true);
  invoke('same');
  await flush();
  const afterDuplicate = controlMessages(transport)
    .filter((message) => message.method === 'link.result' && message.id === 'same');
  assert.equal(afterDuplicate.length >= 3, true);
  assert.equal(calls, 1);
  assert.deepEqual(invokes.at(-1).result, {ok: true, payload: {done: true}});
  device.disconnect();
});

test('timeouts and disconnect reject pending requests and clear state', async () => {
  const timeoutCase = await connectedDevice();
  const timedOut = timeoutCase.device.send('slow', '', {timeoutMs: 5});
  await assert.rejects(timedOut, (error) => error.code === 'request_timeout');
  assert.equal(timeoutCase.device._pending.size, 0);
  timeoutCase.device.disconnect();

  const disconnectCase = await connectedDevice();
  const pending = disconnectCase.device.send('pending');
  await flush();
  disconnectCase.device.disconnect();
  await assert.rejects(pending, (error) => error.code === 'connection_closed');
  assert.equal(disconnectCase.socket.closed, 1);
  assert.equal(disconnectCase.device.connected, false);
  assert.equal(disconnectCase.transport.destroyed, true);
});

test('outbound chat size is bounded before a request is created', async () => {
  const {device, transport} = await connectedDevice();
  await assert.rejects(
    device.send('x'.repeat(MAX_CHAT_MESSAGE)),
    (error) => error.code === 'message_too_large',
  );
  assert.equal(transport.requests.length, 0);
  device.disconnect();
});
