import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { PingRoom } from '@pingroom/sdk';
import { loadConfig, loadEnv } from './config.js';
import { openDeliveryStore } from './store.js';
import { createWebhookServer } from './server.js';

let store;
try {
  loadEnv();
  const config = await loadConfig();
  const client = new PingRoom({ token: config.token, timeoutMs: 5000 });
  store = await openDeliveryStore(fileURLToPath(new URL('../.pingroom/', import.meta.url)));
  const server = createWebhookServer({ ...config, client, store });
  server.listen(config.port, config.host);
  await once(server, 'listening');
  console.log(`Listening on http://${config.host}:${config.port}/webhooks/github`);
  console.log('Health: /health. Expose the webhook route through your HTTPS reverse proxy.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await once(server, 'close');
    await store.close();
  };
  process.once('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
} catch {
  console.error('Could not start. Check .env, the connection, port, and delivery-store lock. See README.');
  await store?.close();
  process.exitCode = 1;
}
