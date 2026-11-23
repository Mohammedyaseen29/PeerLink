import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

function compile(source, require = () => { throw new Error('Unexpected import'); }) {
  const module = { exports: {} };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', js)(require, module, module.exports);
  return module.exports;
}
const client = compile(await readFile(new URL('../src/connection/iceConfiguration.ts', import.meta.url), 'utf8'));
const workerRequire = createRequire(new URL('../../edge/signaling-server/worker-test.cjs', import.meta.url));
class DurableObject { constructor(ctx) { this.ctx = ctx; } }
const worker = compile(await readFile(new URL('../../edge/signaling-server/src/index.ts', import.meta.url), 'utf8'),
  name => name === 'cloudflare:workers' ? { DurableObject } : workerRequire(name));
const valid = [{ urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443?transport=tcp'], username: 'synthetic', credential: 'synthetic-password' }];

test('both sides accept UDP, TCP and TLS browser credentials without changing them', () => {
  assert.deepEqual(client.parseIceServers(valid), valid);
  assert.deepEqual(worker.getIceConfiguration(JSON.stringify(valid)).iceServers, valid);
  assert.equal(client.hasRelayServer(valid), true);
});

test('invalid relay config safely falls back to independent STUN services', () => {
  for (const value of [null, [], [{}], [{ urls: 'https://relay.example' }], [{ urls: 'turn:relay.example' }],
    [{ urls: 'turn:relay.example', username: 'user' }], [{ urls: ['stun:bad host'] }],
    [{ urls: 'stun:relay.example', credential: 123 }], [{ urls: 'stun:relay.example:99999' }],
    [{ urls: 'stun:relay.example:0' }], [{ urls: 'stun:relay.example/path' }], Array(9).fill(valid[0])]) {
    assert.throws(() => client.parseIceServers(value));
    const result = worker.getIceConfiguration(JSON.stringify(value));
    assert.equal(result.configurationError, true);
    assert.equal(client.hasRelayServer(result.iceServers), false);
    assert.equal(result.iceServers.length, 2);
  }
  assert.equal(worker.getIceConfiguration().configurationError, false);
  assert.equal(worker.getIceConfiguration('{secret invalid').configurationError, true);
});

test('joined peers get deployment ICE config before exchanging SDP, without storing it in room identities', async () => {
  const sockets = [];
  const room = new worker.SignalingRoom({ getWebSockets: () => sockets,
    storage: { async get() {}, async put() {} }, blockConcurrencyWhile: fn => fn() }, { ICE_SERVERS: JSON.stringify(valid) });
  function socket() {
    const ws = { readyState: 1, messages: [], attachment: null, send(raw) { this.messages.push(JSON.parse(raw)); },
      serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; }, close() { this.readyState = 3; } };
    sockets.push(ws); return ws;
  }
  const a = socket(), b = socket();
  const send = (ws, message) => room.webSocketMessage(ws, JSON.stringify(message));
  const join = ws => send(ws, { type: 'join', protocolVersion: 2, roomId: 'ice-check', username: 'QA', roomType: 'persistent', supportsReconnect: true });
  await join(a); await join(b);
  for (const ws of [a, b]) {
    assert.deepEqual(ws.messages.find(message => message.type === 'joined').iceServers, valid);
    assert.ok(!JSON.stringify(ws.attachment).includes('synthetic-password'));
  }
  assert.ok(!JSON.stringify(a.messages.find(message => message.type === 'peer_joined')).includes('synthetic-password'));
  await send(b, { type: 'sync', roomId: 'ice-check' });
  assert.ok(!JSON.stringify(b.messages.at(-1)).includes('synthetic-password'));
  // Null/empty candidates are meaningful ICE completion signals, not a leave.
  await send(a, { type: 'ice_candidate', targetPeerId: b.attachment.peerId, payload: { candidate: '' } });
  assert.deepEqual(b.messages.at(-1).payload, { candidate: '' });
  assert.equal(b.messages.at(-1).type, 'ice_candidate');
});

test('failure guidance distinguishes unanswered SDP from unavailable relay paths', () => {
  const failure = { reason: 'ice_failed', connectionState: 'failed', iceConnectionState: 'failed', iceGatheringState: 'complete',
    signalingState: 'stable', relayConfigured: false, localCandidates: { host: 1 }, remoteCandidates: { host: 1 } };
  assert.match(client.connectionFailureMessage(failure), /backup connection is not configured/);
  assert.match(client.connectionFailureMessage({ ...failure, relayConfigured: true }), /backup connection could not be reached/);
  assert.match(client.connectionFailureMessage({ ...failure, signalingState: 'have-local-offer' }), /did not finish answering/);
  assert.match(client.connectionFailureMessage({ ...failure, relayConfigured: true, localCandidates: { relay: 1 } }), /could not establish/);
});
