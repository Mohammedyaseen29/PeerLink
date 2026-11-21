import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/hooks/useP2P.ts', import.meta.url), 'utf8');
const start = source.indexOf('class RoomSignalingSocket');
const end = source.indexOf('const RECONNECT_DELAYS_MS', start);
const executable = stripTypeScriptTypes(source.slice(start, end)) + '\nglobalThis.RoomSignalingSocket = RoomSignalingSocket;';

function fixture() {
  let time = 0, nextId = 0, recoveries = 0, errors = 0;
  const sockets = [], timers = new Map(), closes = [];
  const schedule = (callback, delay, interval = false) => { const id = ++nextId; timers.set(id, { callback, at: time + delay, delay, interval }); return id; };
  class FakeSocket {
    static OPEN = 1; static CLOSED = 3; static CONNECTING = 0;
    readyState = 0; sent = [];
    constructor() { sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(new Event('open')); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    send(value) { if (this.readyState !== 1) throw new Error('Closed'); this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    lose(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const sandbox = { Event, WebSocket: FakeSocket, Date: { now: () => time }, window: {
    setTimeout: (cb, delay) => schedule(cb, delay), clearTimeout: id => timers.delete(id),
    setInterval: (cb, delay) => schedule(cb, delay, true), clearInterval: id => timers.delete(id),
  } };
  vm.runInNewContext(executable, sandbox);
  const socket = new sandbox.RoomSignalingSocket('wss://synthetic', () => recoveries++);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'join', resumeToken: 'stable-private-token' }));
  socket.onclose = event => closes.push(event.code); socket.onerror = () => errors++;
  const advance = duration => {
    const target = time + duration;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; time = timer.at;
      if (timer.interval) timer.at += timer.delay; else timers.delete(id);
      timer.callback();
    }
    time = target;
  };
  const join = () => { sockets.at(-1).open(); sockets.at(-1).receive({ type: 'joined', protocolVersion: 2 }); };
  return { socket, sockets, timers, closes, advance, join, get recoveries() { return recoveries; }, get errors() { return errors; } };
}

test('native socket loss reconnects the same signaling handle without a room-close callback', () => {
  const f = fixture(); f.join(); const original = f.socket;
  f.sockets[0].lose(); assert.deepEqual(f.closes, []); assert.equal(f.recoveries, 1);
  f.advance(1000); f.join();
  assert.equal(f.socket, original);
  assert.deepEqual(f.sockets[1].sent[0], f.sockets[0].sent[0]);
  f.socket.close(); assert.equal(f.timers.size, 0);
});

test('joined sessions retry through a long outage with bounded backoff', () => {
  const f = fixture(); f.join();
  for (let index = 0; index < 12; index++) {
    f.sockets.at(-1).lose(); f.advance([1000, 2000, 4000, 8000][index] ?? 15000);
  }
  assert.equal(f.sockets.length, 13); assert.equal(f.errors, 0); assert.deepEqual(f.closes, []);
  f.socket.close();
});

test('heartbeat responses preserve an idle handle and missing responses recover a half-open socket', () => {
  const f = fixture(); f.join();
  for (let index = 0; index < 24; index++) { f.sockets[0].receive({ type: 'heartbeat_ack' }); f.advance(25000); }
  assert.equal(f.sockets.length, 1);
  f.sockets[0].receive({ type: 'heartbeat_ack' });
  f.advance(100000); f.advance(1000);
  assert.equal(f.sockets.length, 2); assert.deepEqual(f.closes, []);
  f.socket.close();
});

test('stale callbacks cannot duplicate recovery and terminal room errors stop timers', () => {
  const f = fixture(); f.join(); const old = f.sockets[0], lateClose = old.onclose;
  old.onerror(new Event('error')); lateClose({ code: 1006 }); f.advance(1000);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open(); f.sockets[1].lose(4001);
  assert.deepEqual(f.closes, [4001]); assert.equal(f.timers.size, 0);
});

test('leaving stops retries and initial failures eventually release the join form', () => {
  const stopped = fixture(); stopped.join(); stopped.sockets[0].lose(); stopped.socket.close(); stopped.advance(600000);
  assert.equal(stopped.sockets.length, 1); assert.equal(stopped.timers.size, 0);
  const unavailable = fixture(); unavailable.advance(100000);
  assert.equal(unavailable.errors, 1); assert.equal(unavailable.timers.size, 0);
});
