// Read the git-ignored dashboard credentials, validate a live TURN allocation,
// then update the existing Worker secret. No credential is printed or put in argv.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from './probe-ice.mjs';

try {
  const config = JSON.parse(await readFile(new URL('../.turn-credentials.local.json', import.meta.url), 'utf8'));
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim().replace(/^turns?:/i, '') : '';
  if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(endpoint) || !config.username || !config.credential ||
      typeof config.username !== 'string' || config.username.length > 512 ||
      typeof config.credential !== 'string' || config.credential.length > 2048 ||
      [endpoint, config.username, config.credential].some(value => value.includes('COPY_'))) {
    throw new Error('Fill endpoint, username and credential in .turn-credentials.local.json using the free TURN dashboard.');
  }
  const [host, portText] = endpoint.split(':');
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error('The TURN port must be between 1 and 65535.');
  const results = await Promise.all(['udp', 'tcp'].map(transport => probe(host, port, transport, true, config)));
  const working = results.filter(result => result.allocation);
  console.log(JSON.stringify(results.map(({ transport, allocation, code, error }) => ({ transport, allocation, code, error })), null, 2));
  if (!working.length) throw new Error('The relay did not allocate on UDP or TCP. Credentials were not deployed.');
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: working.map(result => `turn:${endpoint}?transport=${result.transport}`), username: config.username, credential: config.credential },
  ];
  const workerDir = fileURLToPath(new URL('../', import.meta.url));
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const child = spawn(process.execPath, [wrangler, 'secret', 'bulk'], { cwd: workerDir, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ ICE_SERVERS: JSON.stringify(iceServers) }));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Wrangler did not update the relay secret.')));
  });
  console.log('Relay configured. Rejoin the room on both devices to use the new connection settings.');
} catch (error) {
  // Only our fixed validation messages are printed; parser/provider data can
  // contain credentials and must not be echoed.
  const safeMessage = error instanceof Error && /^(Fill |The TURN port |The relay |Wrangler )/.test(error.message)
    ? error.message : 'Unable to configure TURN. Check the local credential file and Cloudflare authorization.';
  console.error(safeMessage); process.exitCode = 1;
}
