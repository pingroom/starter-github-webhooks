import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createOfflineClient, demoSecret, postExample } from './offline.js';
import { openDeliveryStore } from './store.js';
import { createWebhookServer } from './server.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-github-demo-'));
const { client, pings } = createOfflineClient();
const store = await openDeliveryStore(directory);
const server = createWebhookServer({ client, room: 'DEMO', secret: demoSecret, repositories: new Set(['example/project']), store });
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log('Offline demo: local HTTP requests, synthetic signatures, and the real SDK with an in-memory transport.');
  console.log('New issue:', await (await postExample(url)).json());
  console.log('Same body with a new delivery ID:', await (await postExample(url)).json());
  console.log('New release:', await (await postExample(url, { event: 'release', payload: {
    action: 'published', repository: { full_name: 'example/project' }, release: { tag_name: 'v1.0.0', name: 'Version 1.0' },
  } })).json());
  console.log(`Created ${pings.length} simulated PingRoom pings.`);
  for (const ping of pings) console.log(`${ping.message} → ${ping.data.url}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
