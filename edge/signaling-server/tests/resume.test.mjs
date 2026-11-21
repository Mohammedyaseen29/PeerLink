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
  let now = Date.now();
  const runtime = { ...sandbox, Date: class extends Date { static now() { return now; } } };
  vm.runInNewContext(executable, runtime);
  const { SignalingRoom } = runtime;
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
    advance(ms) { now += ms; },
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

test('transient close retains the roster until the same session resumes', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenB); const peerId = a.attachment.peerId;
  b.messages.length = 0; f.close(a);
  assert.deepEqual(b.messages.map(m => m.type), ['peer_disconnected']);
  await f.send(b, { type: 'sync' });
  assert.equal(b.messages.at(-1).peers[0].peerId, peerId);
  const resumed = f.add(); await join(f, resumed, tokenA);
  assert.equal(resumed.messages[0].type, 'joined');
  assert.equal(resumed.messages[0].peerId, peerId);
  assert.equal(b.messages.some(message => message.type === 'peer_left'), false);
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

test('a fresh join reclaims a disconnected guest slot immediately', async () => {
  const f = await fixture(); const creator = f.add(); const guest = f.add();
  await join(f, creator, tokenA); await join(f, guest, tokenB);
  const oldGuestId = guest.attachment.peerId;
  f.close(guest); await f.hibernate(); creator.messages.length = 0;
  const returningGuest = f.add();
  await join(f, returningGuest, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert.equal(returningGuest.messages[0].type, 'joined', 'a lost leave frame must not lock the guest out');
  assert.equal(returningGuest.messages[0].peers.length, 1);
  assert.equal(returningGuest.messages[0].peers[0].peerId, creator.attachment.peerId);
  assert.deepEqual(creator.messages.map(message => message.type), ['peer_left', 'peer_joined']);
  assert.equal(creator.messages[0].peerId, oldGuestId);
  await f.send(creator, { type: 'sync' });
  assert.deepEqual(creator.messages.at(-1).peers.map(peer => peer.peerId), [returningGuest.attachment.peerId]);
  const third = f.add(); await join(f, third, 'dddddddd-dddd-dddd-dddd-dddddddddddd');
  assert.equal(third.messages[0].type, 'room_full', 'two live participants still fill the room');
});

test('both users can immediately rejoin an abandoned room, in either order', async () => {
  for (const roomType of ['persistent', 'temporary']) {
    for (const order of [[0, 1], [1, 0]]) {
      const f = await fixture(); const oldPeers = [f.add(), f.add()];
      await join(f, oldPeers[0], tokenA, roomType); await join(f, oldPeers[1], tokenB, roomType);
      f.close(oldPeers[order[0]]); f.close(oldPeers[order[1]]); await f.hibernate();
      const returning = [f.add(), f.add()];
      const tokens = ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
      await join(f, returning[order[0]], tokens[order[0]], roomType);
      await join(f, returning[order[1]], tokens[order[1]], roomType);
      assert.equal(returning[order[0]].messages[0].type, 'joined');
      assert.equal(returning[order[0]].messages[0].peers.length, 0, 'no abandoned participant appears in the reopened room');
      assert.equal(returning[order[1]].messages[0].type, 'joined');
      assert.equal(returning[order[1]].messages[0].peers.length, 1);
      assert.equal(returning[order[1]].messages[0].roomType, roomType);
    }
  }
});

test('both interrupted sessions resume without retiring their RTC identities', async () => {
  const f = await fixture(); const original = [f.add(), f.add()];
  await join(f, original[0], tokenA, 'temporary'); await join(f, original[1], tokenB);
  const ids = original.map(peer => peer.attachment.peerId);
  original.forEach(peer => f.close(peer)); await f.hibernate();
  const resumed = [f.add(), f.add()];
  await join(f, resumed[0], tokenA); await join(f, resumed[1], tokenB);
  assert.deepEqual(resumed.map(peer => peer.attachment.peerId), ids);
  assert.equal(resumed[0].messages[0].peers[0].peerId, ids[1]);
  assert.equal(resumed.some(peer => peer.messages.some(message => message.type === 'peer_left')), false);
  assert.equal(resumed.every(peer => peer.messages[0].roomType === 'temporary'), true);
});

test('expired resume metadata cannot restore an abandoned room mode', async () => {
  const f = await fixture(); const old = f.add();
  await join(f, old, tokenA, 'temporary'); f.close(old);
  f.advance(5 * 60_000 + 1);
  const reopened = f.add(); await join(f, reopened, tokenA, 'persistent');
  assert.equal(reopened.messages[0].type, 'joined');
  assert.equal(reopened.messages[0].roomType, 'persistent');
  assert.equal(reopened.messages[0].resumed, false);
  assert.deepEqual(reopened.messages[0].peers, []);
});

test('claiming an abandoned slot does not clear a different room', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenB, 'temporary', 'another-room');
  const otherId = b.attachment.peerId; f.close(a); f.close(b);
  const replacement = f.add(); await join(f, replacement, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  await f.hibernate();
  const otherResume = f.add(); await join(f, otherResume, tokenB, 'persistent', 'another-room');
  assert.equal(otherResume.messages[0].peerId, otherId);
  assert.equal(otherResume.messages[0].resumed, true);
  assert.equal(otherResume.messages[0].roomType, 'temporary');
});

test('different private tokens and rooms have separate peer identities', async () => {
  const f = await fixture(); const a = f.add(); const b = f.add();
  await join(f, a, tokenA); await join(f, b, tokenA, 'persistent', 'different-room');
  assert.notEqual(a.attachment.peerId, b.attachment.peerId);
  await f.send(a, { type: 'offer', targetPeerId: b.attachment.peerId, payload: 'cross-room' });
  assert.equal(b.messages.length, 1);
});
