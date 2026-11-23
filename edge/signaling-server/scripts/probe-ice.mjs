// Live ICE service check. Reports status codes only, never addresses or credentials.
// Run explicitly with: node scripts/probe-ice.mjs
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function attribute(type, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const result = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  result.writeUInt16BE(type); result.writeUInt16BE(data.length, 2); data.copy(result, 4);
  return result;
}
function message(type, attrs = [], auth) {
  const body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type); header.writeUInt16BE(body.length + (auth ? 24 : 0), 2);
  header.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(header, 8);
  const packet = Buffer.concat([header, body]);
  return auth ? Buffer.concat([packet, attribute(8, createHmac('sha1', auth).update(packet).digest())]) : packet;
}
function parse(packet) {
  const attrs = new Map();
  for (let offset = 20; offset + 4 <= packet.length;) {
    const type = packet.readUInt16BE(offset), size = packet.readUInt16BE(offset + 2);
    attrs.set(type, packet.subarray(offset + 4, offset + 4 + size));
    offset += 4 + Math.ceil(size / 4) * 4;
  }
  const error = attrs.get(9);
  return { attrs, type: packet.readUInt16BE(0), code: error ? error[2] * 100 + error[3] : null };
}
export async function probe(host, port, transport, turn = true, credentials = {}) {
  let socket;
  const pending = new Map();
  let input = Buffer.alloc(0);
  const received = packet => {
    if (packet.length < 20 || packet.readUInt32BE(4) !== 0x2112a442) return;
    const key = packet.subarray(8, 20).toString('hex');
    pending.get(key)?.resolve(packet);
  };
  const exchange = packet => new Promise((resolve, reject) => {
    const key = packet.subarray(8, 20).toString('hex');
    const fail = error => { clearTimeout(timeout); pending.delete(key); reject(error); };
    const timeout = setTimeout(() => fail(new Error('response_timeout')), 6000);
    pending.set(key, { resolve: response => { clearTimeout(timeout); pending.delete(key); resolve(parse(response)); }, fail });
    if (transport === 'udp') socket.send(packet, error => { if (error) fail(error); });
    else socket.write(packet);
  });
  try {
    if (transport === 'udp') {
      socket = dgram.createSocket('udp4');
      socket.on('message', received);
      socket.on('error', error => { for (const request of pending.values()) request.fail(error); });
      // Resolve once: per-packet DNS can send Allocate to a different regional
      // server than the one that issued its authentication nonce.
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('connect_timeout')), 6000);
        socket.once('error', error => { clearTimeout(timeout); reject(error); });
        socket.connect(port, host, () => { clearTimeout(timeout); resolve(); });
      });
    } else {
      socket = transport === 'tls' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      socket.on('data', data => {
        input = Buffer.concat([input, data]);
        while (input.length >= 20 && input.length >= 20 + input.readUInt16BE(2)) {
          const size = 20 + input.readUInt16BE(2); received(input.subarray(0, size)); input = input.subarray(size);
        }
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('connect_timeout')), 6000);
        socket.once(transport === 'tls' ? 'secureConnect' : 'connect', () => { clearTimeout(timeout); resolve(); });
        socket.on('error', error => { clearTimeout(timeout); reject(error); });
      });
      socket.on('close', () => { for (const request of pending.values()) request.fail(new Error('connection_closed')); });
    }
    if (!turn) {
      const result = await exchange(message(1));
      return { host, port, transport, binding: result.type === 0x0101, code: result.code };
    }
    const requestedTransport = attribute(0x19, Buffer.from([17, 0, 0, 0]));
    const challenge = await exchange(message(3, [requestedTransport]));
    const realm = challenge.attrs.get(0x14), nonce = challenge.attrs.get(0x15);
    if (challenge.code !== 401 || !realm || !nonce) return { host, port, transport, allocation: false, code: challenge.code };
    const username = credentials.username ?? 'openrelayproject';
    const password = credentials.credential ?? 'openrelayproject';
    const key = createHash('md5').update(`${username}:${realm.toString()}:${password}`).digest();
    const identity = [attribute(6, username), attribute(0x14, realm), attribute(0x15, nonce)];
    const result = await exchange(message(3, [requestedTransport, ...identity], key));
    if (result.type === 0x0103) {
      // Release the short-lived test allocation immediately.
      await exchange(message(4, [attribute(0x0d, Buffer.alloc(4)), ...identity], key)).catch(() => {});
    }
    return { host, port, transport, allocation: result.type === 0x0103, code: result.code };
  } catch (error) {
    return { host, port, transport, error: error.code ?? error.message };
  } finally {
    for (const request of pending.values()) request.fail(new Error('probe_finished'));
    if (transport === 'udp') { try { socket?.close(); } catch {} }
    else socket?.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await Promise.all([
    probe('stun.l.google.com', 19302, 'udp', false),
    probe('stun.cloudflare.com', 3478, 'udp', false),
    probe('openrelay.metered.ca', 80, 'udp'),
    probe('openrelay.metered.ca', 443, 'udp'),
    probe('openrelay.metered.ca', 443, 'tcp'),
    probe('openrelay.metered.ca', 443, 'tls'),
  ]);
  console.log(JSON.stringify(results, null, 2));
}
