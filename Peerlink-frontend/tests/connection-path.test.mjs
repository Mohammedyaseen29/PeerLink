import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/connection/connectionPath.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load() {
  const timers = new Map(); let id = 0;
  const window = { setInterval(fn) { timers.set(++id, fn); return id; }, clearInterval(key) { timers.delete(key); } };
  const module = { exports: {} };
  new Function('module', 'exports', 'window', code)(module, module.exports, window);
  return { ...module.exports, timers, tick: () => { for (const fn of timers.values()) fn(); } };
}
const api = load();
function stats(localType = 'host', remoteType = 'host', extra = []) {
  const reports = [
    { id: 'local', type: 'local-candidate', candidateType: localType, address: '192.168.1.4', protocol: 'udp' },
    { id: 'remote', type: 'remote-candidate', candidateType: remoteType, address: 'peer.local', protocol: 'udp' },
    { id: 'selected', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }, ...extra,
  ];
  return new Map(reports.map(report => [report.id, report]));
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the active transport wins over other successful pairs; gathering relay candidates alone does not mean relay use', () => {
  const direct = stats('host', 'host', [{ id: 'unused-relay', type: 'local-candidate', candidateType: 'relay' }]);
  assert.equal(api.connectionTypeFromStats(direct), 'local');
  const relay = stats('relay', 'host', [{ id: 'other', type: 'candidate-pair', state: 'succeeded', nominated: true,
    localCandidateId: 'other-local', remoteCandidateId: 'remote' }, { id: 'other-local', type: 'local-candidate', candidateType: 'host', address: '10.0.0.4' }]);
  assert.equal(api.connectionTypeFromStats(relay), 'relay');
  relay.delete('transport'); relay.get('selected').nominated = false;
  assert.equal(api.connectionTypeFromStats(relay), 'local');
  direct.get('transport').selectedCandidatePairId = 'missing'; direct.get('selected').nominated = false;
  assert.equal(api.connectionTypeFromStats(direct), null);
});

test('local aggregation stays local; public host addresses and hidden addresses do not claim a local network', () => {
  assert.equal(api.aggregateConnectionType(['local']), 'local');
  assert.equal(api.aggregateConnectionType(['local', 'local']), 'local');
  assert.equal(api.aggregateConnectionType(['local', 'relay']), 'relay');
  assert.equal(api.aggregateConnectionType(['local', 'p2p']), 'p2p');
  assert.equal(api.aggregateConnectionType([]), 'disconnected');
  const publicPair = stats(); publicPair.get('local').address = '203.0.113.8';
  assert.equal(api.connectionTypeFromStats(publicPair), 'p2p');
  delete publicPair.get('local').address;
  assert.equal(api.connectionTypeFromStats(publicPair), 'p2p');
  const ipv6 = stats(); ipv6.get('local').address = 'fd00::1'; ipv6.get('remote').address = 'fe80::1234';
  assert.equal(api.connectionTypeFromStats(ipv6), 'local');
  assert.equal(api.connectionTypeFromStats(stats('srflx', 'prflx')), 'p2p');
});

test('diagnostics separate local and remote checks without exposing addresses, URLs or credentials, and stay bounded', () => {
  const reports = stats('relay', 'relay', [{ id: 'direct-local', type: 'local-candidate', candidateType: 'host', address: 'PRIVATE_ADDRESS', url: 'SECRET_CREDENTIAL' },
    { id: 'direct-remote', type: 'remote-candidate', candidateType: 'host', address: 'PRIVATE_ADDRESS' },
    { id: 'direct-check', type: 'candidate-pair', localCandidateId: 'direct-local', remoteCandidateId: 'direct-remote',
      state: 'failed', requestsSent: 7, responsesReceived: 0 }]);
  const paths = api.summarizeIcePaths(reports);
  assert.deepEqual(paths.localCandidateTypes, { relay: 1, host: 1 });
  assert.deepEqual(paths.remoteCandidateTypes, { relay: 1, host: 1 });
  assert.deepEqual(paths.candidatePairs.find(pair => !pair.selected), { selected: false, localType: 'host', remoteType: 'host',
    state: 'failed', nominated: false, requestsSent: 7, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 });
  assert.ok(!JSON.stringify(paths).includes('PRIVATE_ADDRESS')); assert.ok(!JSON.stringify(paths).includes('SECRET_CREDENTIAL'));
  for (let i = 0; i < 200; i++) reports.set(`extra-${i}`, { id: `extra-${i}`, type: 'candidate-pair' });
  assert.equal(api.summarizeIcePaths(reports).candidatePairs.length, 64);
});

test('path monitor follows relay-to-direct changes and cleans up timers and event listeners', async () => {
  const f = load(), ice = new EventTarget(), peer = new EventTarget();
  let current = stats('relay', 'relay'), reads = 0; const observed = [];
  peer.sctp = { transport: { iceTransport: ice } };
  peer.getStats = async () => { reads++; return current; };
  const stop = f.watchConnectionPath(peer, path => observed.push(path), () => true);
  await flush(); assert.equal(observed.at(-1), 'relay');
  current = stats(); ice.dispatchEvent(new Event('selectedcandidatepairchange'));
  await flush(); assert.equal(observed.at(-1), 'local');
  current = stats('srflx', 'host'); f.tick(); await flush(); assert.equal(observed.at(-1), 'p2p');
  stop(); assert.equal(f.timers.size, 0); const before = reads;
  ice.dispatchEvent(new Event('selectedcandidatepairchange')); peer.dispatchEvent(new Event('iceconnectionstatechange')); f.tick();
  await flush(); assert.equal(reads, before);
});

test('overlapping and stale stats reads cannot update a closed/replaced session; errors recover on later polls', async () => {
  const f = load(), peer = new EventTarget(); let finish, reads = 0, active = true; const observed = [];
  peer.sctp = null;
  peer.getStats = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const stop = f.watchConnectionPath(peer, path => observed.push(path), () => active);
  f.tick(); f.tick(); assert.equal(reads, 1);
  active = false; finish(stats()); await flush(); assert.deepEqual(observed, []); stop();
  active = true; peer.getStats = async () => { throw new Error('Synthetic unavailable stats'); };
  const stopRetry = f.watchConnectionPath(peer, path => observed.push(path), () => active);
  await flush(); peer.getStats = async () => stats(); f.tick(); await flush(); assert.equal(observed.at(-1), 'local');
  stopRetry(); assert.equal(f.timers.size, 0);
});
