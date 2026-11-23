import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { probe } from './probe-ice.mjs';

test('TURN probe authenticates custom credentials and releases its allocation on the same UDP socket', async () => {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  const seen = [], sourcePorts = new Set(), errors = [];
  const username = 'synthetic-account', credential = 'synthetic-password';
  function attribute(type, data) {
    const value = Buffer.from(data), bytes = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
    bytes.writeUInt16BE(type); bytes.writeUInt16BE(value.length, 2); value.copy(bytes, 4); return bytes;
  }
  socket.on('message', (request, remote) => {
    try {
      sourcePorts.add(remote.port);
      const type = request.readUInt16BE(0); seen.push(type);
      const attrs = new Map(); let integrityOffset;
      for (let offset = 20; offset < request.length;) {
        const tag = request.readUInt16BE(offset), size = request.readUInt16BE(offset + 2);
        attrs.set(tag, request.subarray(offset + 4, offset + 4 + size));
        if (tag === 8) integrityOffset = offset;
        offset += 4 + Math.ceil(size / 4) * 4;
      }
      let responseType, body;
      if (seen.length === 1) {
        assert.equal(type, 3); assert.ok(!attrs.has(6));
        responseType = 0x0113;
        body = Buffer.concat([attribute(9, [0, 0, 4, 1]), attribute(0x14, 'test-realm'), attribute(0x15, 'test-nonce')]);
      } else {
        assert.equal(attrs.get(6).toString(), username);
        assert.equal(attrs.get(0x14).toString(), 'test-realm');
        assert.equal(attrs.get(0x15).toString(), 'test-nonce');
        const key = createHash('md5').update(`${username}:test-realm:${credential}`).digest();
        assert.deepEqual(attrs.get(8), createHmac('sha1', key).update(request.subarray(0, integrityOffset)).digest());
        assert.equal(request.readUInt16BE(2), request.length - 20);
        if (type === 3) assert.equal(attrs.get(0x19)[0], 17);
        else { assert.equal(type, 4); assert.equal(attrs.get(0x0d).readUInt32BE(), 0); }
        responseType = type === 3 ? 0x0103 : 0x0104;
        body = Buffer.alloc(0);
      }
      const header = Buffer.from(request.subarray(0, 20));
      header.writeUInt16BE(responseType); header.writeUInt16BE(body.length, 2);
      socket.send(Buffer.concat([header, body]), remote.port, remote.address);
    } catch (error) { errors.push(error); }
  });
  try {
    const result = await probe('127.0.0.1', port, 'udp', true, { username, credential });
    if (errors.length) throw errors[0];
    assert.equal(result.allocation, true); assert.equal(result.code, null);
    assert.deepEqual(seen, [3, 3, 4]); assert.equal(sourcePorts.size, 1);
  } finally { socket.close(); }
});
