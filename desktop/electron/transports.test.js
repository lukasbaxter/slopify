'use strict';
// The speaker transports without speakers: a stand-in castv2-client, and the
// transport cache main.js keeps. Run: npm test (in desktop/).
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { EventEmitter } = require('events');

const clients = [];
let launchError = null;
class FakeClient extends EventEmitter {
  constructor() { super(); this.closed = false; clients.push(this); }
  connect(host, cb) { this.host = host; process.nextTick(cb); }
  launch(_app, cb) { process.nextTick(() => (launchError ? cb(launchError) : cb(null, new EventEmitter()))); }
  close() { this.closed = true; }
}
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'castv2-client') return { Client: FakeClient, DefaultMediaReceiver: {} };
  return load.call(this, request, ...rest);
};
const { CastTransport } = require('./transports/cast');
const { transportCache } = require('./transports/cache');

test('a failed cast launch closes its connection', async () => {
  clients.length = 0;
  const t = new CastTransport({ id: 'cast:1', host: '10.0.0.5', name: 'Kitchen' });
  launchError = new Error('launch refused');
  await assert.rejects(t._connect(), /launch refused/);
  launchError = null;
  await t._connect();
  assert.strictEqual(clients.length, 2);
  assert.strictEqual(clients[0].closed, true, 'the first connection was left open');
  assert.strictEqual(clients[1].closed, false);
});

test('a speaker that moved to a new address gets a transport for it', () => {
  const made = [];
  const cache = transportCache((device) => { const t = { device, closed: false, close() { this.closed = true; } }; made.push(t); return t; });
  const a = cache.get({ id: 'cast:1', kind: 'cast', host: '10.0.0.5', port: 8009 });
  assert.strictEqual(cache.get({ id: 'cast:1', kind: 'cast', host: '10.0.0.5', port: 8009 }), a, 'same address: same transport');
  const b = cache.get({ id: 'cast:1', kind: 'cast', host: '10.0.0.9', port: 8009 });
  assert.notStrictEqual(b, a);
  assert.strictEqual(b.device.host, '10.0.0.9');
  assert.strictEqual(a.closed, true, 'the old connection is closed');
  const c = cache.get({ id: 'cast:1', kind: 'cast', host: '10.0.0.9', port: 8010 });
  assert.notStrictEqual(c, b);
  assert.deepStrictEqual([...cache.values()], [c]);
});
