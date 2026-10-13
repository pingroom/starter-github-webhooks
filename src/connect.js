import { mkdir, chmod, open, rename, rm } from 'node:fs/promises';
import { PingRoom } from '@pingroom/sdk';
import { credentialsPath } from './config.js';

console.log('PingRoom lets this bridge send GitHub issue and release updates to your phone.');
console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const client = new PingRoom({ timeoutMs: 5000 });
  const pairing = await client.auth.startPairing({ agent_label: 'GitHub webhook bridge' });
  console.log(`Approve this connection: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: controller.signal });
  const room = (active.home_room ?? active.room)?.invite_code;
  if (!room) throw new Error('missing_delivery_room');
  const directory = new URL('../.pingroom/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = new URL(`credentials-${process.pid}.tmp`, directory);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify({ token: active.credential, room })}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, credentialsPath);
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
  console.log('Connected. Saved ignored .pingroom/credentials.json (0600 on POSIX).');
  console.log('Configure .env, then run npm start.');
} catch {
  console.error('Connection did not complete. Check your network, approve the connection, and select an eligible private room.');
  process.exitCode = 1;
}
