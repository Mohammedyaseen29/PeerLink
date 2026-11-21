import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')
  .replace('export class SignalingRoom', 'class SignalingRoom')
  .replace('export default app;', 'globalThis.SignalingRoom = SignalingRoom;'));
const sandbox = {
  DurableObject: class { constructor(ctx) { this.ctx = ctx; } },
  Hono: class { get() {} all() {} }, crypto: webcrypto, TextEncoder,
};
vm.runInNewContext(executable, sandbox);
const { SignalingRoom } = sandbox;

function socket() {
  return {
    readyState: 1, attachment: null, messages: [], closes: [],
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
    send(value) { if (this.readyState !== 1) throw new Error('Closed'); this.messages.push(JSON.parse(value)); },
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; },
  };
}
async function fixture() {
  const sockets = [], stored = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: { async get(key) { return structuredClone(stored.get(key)); }, async put(key, value) { stored.set(key, structuredClone(value)); } },
    blockConcurrencyWhile(callback) { this.ready = callback(); },
  };
  let handler = new SignalingRoom(ctx, {}); await ctx.ready;
  return {
    add() { const ws = socket(); sockets.push(ws); return ws; },
    send(ws, value) { return handler.webSocketMessage(ws, JSON.stringify(value)); },
    close(ws) { handler.webSocketClose(ws, 1000, 'Synthetic interruption'); },
    async hibernate() { handler = new SignalingRoom(ctx, {}); await ctx.ready; },
  };
}
const tokenA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tokenB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const join = (f, ws, resumeToken, roomType = 'persistent', roomId = 'resume-room') =>
  f.send(ws, { type: 'join', protocolVersion: 2, roomId, username: 'Synthetic peer', supportsReconnect: true, roomType, resumeToken });

test('protocol2 identity, private tokens, room mode, and link routing remain compatible', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA, 'temporary'); await join(f, b, tokenB);
  assert.equal(a.messages[0].protocolVersion, 2);
  assert.equal(b.messages[0].roomType, 'temporary');
  assert.equal(b.messages[0].peers[0].peerId, a.attachment.peerId);
  assert.equal(JSON.stringify(b.messages).includes(tokenA), false);
  await f.send(a, { type: 'offer', targetPeerId: b.attachment.peerId, linkId: 'existing-link', payload: 'synthetic-sdp' });
  assert.equal(b.messages.at(-1).fromPeerId, a.attachment.peerId);
  assert.equal(b.messages.at(-1).linkId, 'existing-link');
});

test('transient close retains roster and reserved capacity instead of inventing peer_left', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenB); const peerId = a.attachment.peerId;
  b.messages.length = 0; f.close(a);
  assert.deepEqual(b.messages.map(m => m.type), ['peer_disconnected']);
  await f.send(b, { type: 'sync' });
  assert.equal(b.messages.at(-1).peers[0].peerId, peerId);
  const third = f.add(); await join(f, third, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert.equal(third.messages.at(-1).type, 'room_full');
});

test('resume survives hibernation, keeps identity and authoritative mode, and restores routing', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA, 'temporary'); await join(f, b, tokenB); const peerId = a.attachment.peerId;
  f.close(a); await f.hibernate(); b.messages.length = 0;
  const resumed = f.add(); await join(f, resumed, tokenA);
  assert.equal(resumed.messages[0].peerId, peerId);
  assert.equal(resumed.messages[0].roomType, 'temporary');
  assert.equal(resumed.messages[0].resumed, true);
  assert.deepEqual(b.messages.map(m => m.type), ['peer_joined']);
  await f.send(b, { type: 'ice_candidate', targetPeerId: peerId, linkId: 'retained-link', payload: 'candidate' });
  assert.equal(resumed.messages.at(-1).linkId, 'retained-link');
});

test('an open stale socket is replaced without a third slot or false departure', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenB); const peerId = a.attachment.peerId;
  b.messages.length = 0; const resumed = f.add(); await join(f, resumed, tokenA);
  assert.equal(resumed.messages[0].peerId, peerId);
  assert.equal(a.closes[0].code, 4000);
  f.close(a);
  assert.deepEqual(b.messages.map(m => m.type), ['peer_joined']);
});

test('explicit leave releases membership and never becomes a suspended peer', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenB); b.messages.length = 0;
  await f.send(a, { type: 'leave' }); f.close(a);
  assert.deepEqual(b.messages.map(m => m.type), ['peer_left']);
  await f.send(b, { type: 'sync' }); assert.deepEqual(b.messages.at(-1).peers, []);
  const replacement = f.add(); await join(f, replacement, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert.equal(replacement.messages[0].type, 'joined');
});

test('different private tokens and rooms have separate peer identities', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenA, 'persistent', 'different-room');
  assert.notEqual(a.attachment.peerId, b.attachment.peerId);
  await f.send(a, { type: 'offer', targetPeerId: b.attachment.peerId, payload: 'cross-room' });
  assert.equal(b.messages.length, 1);
});
