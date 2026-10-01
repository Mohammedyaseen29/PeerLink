import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(frontendDir, '..');
const workerPath = path.join(repoDir, 'edge', 'signaling-server', 'src', 'index.ts');
const workerRequire = createRequire(path.join(repoDir, 'edge', 'signaling-server', 'worker-test.cjs'));
const source = await readFile(workerPath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

class DurableObject {
    constructor(ctx) { this.ctx = ctx; }
}
const module = { exports: {} };
const load = specifier => specifier === 'cloudflare:workers'
    ? { DurableObject }
    : workerRequire(specifier);
new Function('require', 'module', 'exports', compiled)(load, module, module.exports);
const { SignalingRoom } = module.exports;

let now = 1_000_000;
const nativeDateNow = Date.now;
Date.now = () => now;
try {
    let alarmAt = null;
    const sockets = [];
    const storage = {
        async getAlarm() { return alarmAt; },
        async setAlarm(at) { alarmAt = at; },
    };
    const room = new SignalingRoom({ getWebSockets: () => sockets, storage }, {});
    class FakeSocket {
        readyState = 1;
        attachment = null;
        messages = [];
        closed = null;
        send(raw) { this.messages.push(JSON.parse(raw)); }
        serializeAttachment(value) { this.attachment = value; }
        deserializeAttachment() { return this.attachment; }
        close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
    }
    const addSocket = () => { const socket = new FakeSocket(); sockets.push(socket); return socket; };
    const send = (socket, message) => room.webSocketMessage(socket, JSON.stringify(message));
    const join = (socket, roomId, username, flags = {}) => send(socket, {
        type: 'join', protocolVersion: 2, roomId, username, roomType: 'persistent', ...flags,
    });
    const optedStale = addSocket(), healthy1 = addSocket(), rejectedThird = addSocket();
    const v2NoHeartbeat = addSocket(), legacy = addSocket();
    await join(optedStale, 'heartbeats', 'Stale', { heartbeat: true, supportsReconnect: true });
    await join(healthy1, 'heartbeats', 'Healthy 1', { heartbeat: true, supportsReconnect: true });
    await join(rejectedThird, 'heartbeats', 'Rejected third', { heartbeat: true, supportsReconnect: true });
    await join(v2NoHeartbeat, 'v2-no-heartbeat', 'No heartbeat');
    await send(legacy, { type: 'join', roomId: 'legacy-room', username: 'Legacy', roomType: 'persistent' });
    const fullResponse = rejectedThird.messages.find(message => message.type === 'room_full');
    assert.equal(fullResponse?.maxPeers, 2, 'the third join is rejected with the two-member capacity');
    assert.equal(rejectedThird.closed?.code, 4001, 'the rejected third socket closes as room-full');
    assert.equal(optedStale.readyState, 1);
    assert.equal(healthy1.readyState, 1);
    assert.equal(alarmAt, null, 'membership alone does not arm a destructive heartbeat-expiry alarm');

    now += 240_000;
    await send(healthy1, { type: 'heartbeat', roomId: 'heartbeats' });
    await send(healthy1, { type: 'sync', roomId: 'heartbeats' });
    await room.alarm();
    assert.equal(optedStale.readyState, 1, 'an elapsed silent period does not invent a leave for an open socket');
    assert.equal(optedStale.closed, null);
    assert.equal(healthy1.readyState, 1);
    assert.equal(v2NoHeartbeat.readyState, 1, 'v2 clients that did not opt into heartbeat are preserved');
    assert.equal(legacy.readyState, 1, 'legacy clients are not subject to heartbeat expiry');

    const snapshot = healthy1.messages.at(-1);
    assert.equal(snapshot.type, 'room_state');
    assert.deepEqual(snapshot.peers.map(peer => peer.peerId), [optedStale.attachment.peerId],
        'room_state reports only authoritative live peers');
    assert.equal(snapshot.peers[0].supportsReconnect, true, 'the room snapshot carries reconnect support');

    const messagesBefore = optedStale.messages.length;
    await send(healthy1, { type: 'reconnect_request', roomId: 'heartbeats', targetPeerId: optedStale.attachment.peerId });
    assert.equal(optedStale.messages.length, messagesBefore + 1, 'reconnect messages reach a peer in the same room');
    assert.equal(optedStale.messages.at(-1).fromPeerId, healthy1.attachment.peerId);
    await send(healthy1, { type: 'reconnect_request', roomId: 'heartbeats', targetPeerId: v2NoHeartbeat.attachment.peerId });
    assert.equal(v2NoHeartbeat.messages.length, 1, 'reconnect requests cannot cross room boundaries');

    console.log('PASS: two-member capacity, third join rejection, open-socket retention across 240s, legacy/v2 preservation, roster snapshot, and reconnect routing');
} finally {
    Date.now = nativeDateNow;
}
